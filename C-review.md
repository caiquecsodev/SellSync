# Code Review — PR "Reimportar estoque de um item a partir do app de delivery"

## Defeitos encontrados

### 1. Migration destrói dado existente — **bloqueia merge**

```sql
ALTER TABLE item_stock DROP COLUMN qty;
ALTER TABLE item_stock ADD COLUMN quantity integer NOT NULL DEFAULT 0;
```

**O que acontece em produção**: no momento em que essa migration roda, **todo item de todo restaurante
perde o valor de estoque que tinha** — a coluna antiga é apagada e a nova nasce com `0` para todas as
linhas já existentes. Não é uma renomeação, é um drop seguido de um create. Não existe SQL, rollback ou
"desfazer" que recupere o valor de `qty` depois disso — o dado já não existe mais no banco.

**Severidade**: bloqueia merge. Viola diretamente a convenção "Migrations... nunca destroem dado", e o
efeito é imediato e sobre 100% dos tenants, sem precisar de nenhuma condição especial ou ataque.

**Correção**: renomear a coluna preservando o valor:
```sql
ALTER TABLE item_stock RENAME COLUMN qty TO quantity;
```
Se a intenção for mudar o tipo/semântica (não é o caso aqui, ambos parecem representar a mesma coisa),
o caminho correto é um `UPDATE` de backfill a partir da coluna antiga antes de dropá-la, nunca um drop
direto.

---

### 2. Leitura sem escopo de tenant em `reimportStockAction` — **bloqueia merge**

```ts
const [row] = await db
  .select()
  .from(itemStock)
  .where(eq(itemStock.itemId, itemId));
```

**O que acontece em produção**: essa consulta não usa `scoped(accountId, ...)`. Um funcionário do
restaurante A pode chamar `reimportStockAction(itemId)` passando o `itemId` de um item que pertence ao
restaurante B (por exemplo, descoberto por tentativa, por um ID sequencial, ou vazado em outro lugar da
UI) — a consulta encontra a linha de B normalmente, porque nada filtra por `accountId`. Isso não é
hipotético: é exatamente o cenário de vazamento entre tenants que a convenção da Prato existe para
impedir ("Nenhum dado de um cliente pode vazar para outro").

**Severidade**: bloqueia merge. É uma leitura de tabela de cliente sem `scoped()`, violação direta e
explícita da convenção obrigatória.

**Correção**:
```ts
const [row] = await scoped(accountId, tx =>
  tx.select().from(itemStock).where(eq(itemStock.itemId, itemId))
);
if (!row) return { ok: false, error: 'not_found' };
```

---

### 3. `unscoped()` usado fora de job batch, sem WHERE de tenant — **bloqueia merge**

```ts
const channels = await step.run('load-channels', () =>
  unscoped(tx => tx.select().from(menuItems)
    .where(eq(menuItems.itemId, itemId))));
...
unscoped(tx => tx.update(itemStock)
  .set({ quantity: Number(remote.available) })
  .where(eq(itemStock.channelId, c.id)))
```

**O que acontece em produção**: este job processa **um item de um tenant específico** (disparado por uma
ação de um restaurante), não é um job batch que varre todos os tenants. A convenção é clara:
`unscoped()` só é permitido em job batch, e mesmo assim sempre com `WHERE` explícito de tenant. Aqui não é
batch, e o `WHERE` filtra só por `itemId`/`channelId`, sem `accountId`. Se o `itemId` do evento vier
manipulado, corrompido, ou colidir por qualquer motivo (bug em outro lugar, replay de evento antigo,
enum de teste), o job lê e **escreve** dado de estoque de um tenant que não é o dono da requisição —
pior que o defeito 2, porque aqui já é escrita, não só leitura.

**Severidade**: bloqueia merge. Escrita cross-tenant é o pior cenário de isolamento possível.

**Correção**: usar `scoped(accountId, tx => ...)` nas duas operações, já que `accountId` está disponível
em `event.data`.

---

### 4. `.catch(() => {})` ao enfileirar o job — **bloqueia merge**

```ts
queue
  .send({ name: 'stock/reimport.requested', data: { itemId, accountId } })
  .catch(() => {});

return { ok: true };
```

**O que acontece em produção**: se o envio para a fila falhar (fila indisponível, payload inválido,
timeout), o erro é engolido silenciosamente e a action **retorna `{ ok: true }` mesmo assim**. O usuário
vê "reimportação solicitada com sucesso" na tela, mas o job nunca roda e o estoque nunca é atualizado.
Isso é literalmente o mesmo padrão do incidente da Parte A (catch silencioso escondendo uma falha real) —
e a convenção proíbe explicitamente `.catch(() => {})`.

**Severidade**: bloqueia merge. Violação explícita e nomeada nas convenções da página 2.

**Correção**:
```ts
try {
  await queue.send({ name: 'stock/reimport.requested', data: { itemId, accountId } });
} catch (err) {
  logger.error('stock.reimport.enqueue_failed', { accountId, itemId, err: String(err) });
  return { ok: false, error: 'enqueue_failed' };
}
return { ok: true };
```

---

### 5. Chamadas externas fora de `step.run` — deve corrigir

```ts
const client = getDeliveryAppClient(channels[0].app);
const remote = await client.getStock(channels[0].remoteItemId);
...
await client.setStock(channels[0].remoteItemId, Number(remote.available));
```

**O que acontece em produção**: `client.getStock` e `client.setStock` são efeitos colaterais externos
(chamadas HTTP ao app de delivery) que **não estão dentro de `step.run`**. Se o job falhar depois dessas
linhas e o provedor reexecutar (o job tem `retries: 3`), essas chamadas externas são refeitas do zero a
cada tentativa — gerando chamadas repetidas e desnecessárias à API do parceiro, que é exatamente o
recurso escasso e compartilhado discutido na Parte B (rate limit por app parceiro). Em um cenário de
retry, isso consome cota do balde compartilhado sem necessidade e pode contribuir para o próprio problema
de rate limit relatado ali.

**Severidade**: deve corrigir. Não corrompe dado sozinho, mas viola a convenção de `step.run` para efeito
colateral externo e amplifica o risco de rate limit.

**Correção**: envolver ambas as chamadas em `step.run` próprios, memoizando o resultado.

---

### 6. Uso de `channels[0]` para representar todos os canais — deve corrigir

```ts
const client = getDeliveryAppClient(channels[0].app);
const remote = await client.getStock(channels[0].remoteItemId);
for (const c of channels) {
  await step.run(`update-${c.id}`, () =>
    unscoped(tx => tx.update(itemStock).set({ quantity: Number(remote.available) })...));
}
await client.setStock(channels[0].remoteItemId, Number(remote.available));
```

**O que acontece em produção**: o item pode estar cadastrado em mais de um app de delivery (mais de um
canal). O código busca o estoque **apenas do primeiro canal** (`channels[0]`) e grava esse mesmo valor
para **todos os canais** no loop — se o restaurante vende o mesmo item em dois apps diferentes com
estoques diferentes, o estoque do segundo canal é sobrescrito com o valor do primeiro, incorretamente.
Além disso, `client.setStock` no final escreve de volta **apenas no canal 0**, mas a função se chama
"reimportar" (trazer dado do app de delivery para dentro do sistema) — enviar dado de volta para o app
de delivery é uma direção de dado inesperada e não documentada na descrição da feature; se não for
intencional, é escrita indevida em sistema de terceiro.

**Severidade**: deve corrigir (bug de lógica) — a chamada `setStock` de volta ao parceiro merece
confirmação explícita do autor sobre a intenção, porque se for engano, é escrita não intencional em
sistema externo.

**Correção**: buscar e atualizar o estoque por canal individualmente (`client.getStock` dentro do loop,
usando `c.app`/`c.remoteItemId` de cada canal), e remover a chamada final `setStock` a menos que exista
uma razão de negócio explícita e documentada para escrever de volta no app de delivery.

---

### 7. `channels[0]` sem checagem de array vazio — deve corrigir

```ts
const client = getDeliveryAppClient(channels[0].app);
```

**O que acontece em produção**: se o item não tiver nenhum canal associado (`channels` vazio — por
exemplo, item recém-criado, ou canal desconectado), `channels[0]` é `undefined` e a linha seguinte
(`.app`) lança `TypeError: Cannot read properties of undefined`, sem tratamento — o job falha de forma
não descritiva.

**Severidade**: deve corrigir. Cenário plausível e fácil de disparar (item sem canal).

**Correção**: checar `channels.length === 0` logo após o `load-channels` e retornar/logar um resultado
claro (ex.: `{ updated: 0, reason: 'no_channels' }`) em vez de deixar estourar.

---

### 8. Audit log grava `accountId` como `userId` — deve corrigir

```ts
await db.insert(auditLog).values({
  userId: accountId,
  action: 'stock.reimport.requested',
  entityId: itemId,
});
```

**O que acontece em produção**: a convenção distingue claramente `currentAccountId()` (a conta dona, o
restaurante) de `currentUserId()` (a pessoa logada, que pode ser um funcionário). Aqui, `accountId` é
gravado no campo `userId` do log de auditoria — ou seja, o log nunca vai dizer **qual funcionário**
disparou a reimportação, só qual restaurante. Se um restaurante com múltiplos funcionários tiver uma
disputa sobre quem fez o quê, o log de auditoria é inútil para essa investigação.

**Severidade**: deve corrigir. Não vaza dado nem quebra isolamento, mas compromete a rastreabilidade que
o log de auditoria existe para garantir.

**Correção**:
```ts
const userId = await currentUserId();
await db.insert(auditLog).values({ userId, accountId, action: 'stock.reimport.requested', entityId: itemId });
```

---

### 9. `Number(remote.available)` sem validação — nit

Se a API do parceiro devolver `available` ausente, `null`, ou uma string não numérica, `Number(...)`
produz `NaN`, que seria gravado silenciosamente no banco como quantidade. Vale validar e, se inválido,
logar e não atualizar (mesmo espírito do módulo da Parte D, onde não se deve "inventar" um valor).

## Qual defeito, sozinho, já bloquearia o merge

**O defeito 1 (migration que destrói dado)**, isoladamente. Os outros defeitos de isolamento (2 e 3)
dependem de alguém passar um `itemId` de outro tenant para se manifestar — são gravíssimos, mas
condicionais a uma ação específica. A migration não depende de nenhuma condição: **basta fazer merge e
aplicar a migration** para que todo restaurante, sem exceção, perca o dado de estoque que já tinha,
imediatamente e sem possibilidade de rollback via SQL. É o único defeito da lista que causa dano
generalizado e irreversível apenas por existir, sem precisar de um usuário malicioso, um bug de outro
módulo, ou uma condição de corrida — e viola a regra mais absoluta da convenção da Prato ("migration
nunca perde dado").

## Teste que eu escreveria primeiro

**Cenário**: restaurante A (accountId `acc_A`) chama `reimportStockAction(itemId)` passando o ID de um
item que pertence ao restaurante B (`acc_B`), estando autenticado como A.

**Esperado**: a action deve retornar `{ ok: false, error: 'not_found' }` (ou equivalente), como se o item
não existisse para A — nunca deve encontrar ou processar dado de B.

**Por que esse primeiro**: é o teste mais barato de escrever, cobre o defeito mais perigoso do ponto de
vista de dado (vazamento/escrita cross-tenant, defeitos 2 e 3), e com o código atual ele **falha
imediatamente** (fica vermelho), provando o bug antes de qualquer fix — exatamente o padrão pedido nas
convenções ("teste vermelho antes do fix").

```ts
test('reimportStockAction não acessa item de outro tenant', async () => {
  const itemB = await createItemStock({ accountId: 'acc_B', itemId: 'item_1' });
  mockCurrentAccountId('acc_A');

  const result = await reimportStockAction('item_1');

  expect(result).toEqual({ ok: false, error: 'not_found' });
  expect(queueSendSpy).not.toHaveBeenCalled();
});
```

## Feedback direto ao autor

Esse PR não pode subir como está — não é questão de estilo, são três violações de isolamento de tenant
(migration, leitura, escrita no job) e um `.catch` silencioso, todos itens que a Prato já deixou
explícitos como obrigatórios no guia de convenções. Isso me diz que o PR foi escrito sem checar a lista
de convenções antes de abrir — próxima vez, passa por ela como checklist antes de pedir review, porque
esses quatro pontos (scoped/unscoped, catch proibido, migration reversível) são exatamente o que a Prato
mais precisa proteger, dado que é multi-tenant.

Pontualmente: a migration sozinha já é motivo de bloqueio automático — dropar uma coluna com dado ativo e
recriar com `DEFAULT 0` apaga estoque de todo mundo no primeiro deploy. Isso precisa virar reflexo: toda
migration que mexe em coluna existente, perguntar "e se essa coluna já tiver dado que importa?" antes de
escrever o SQL.

No job, `unscoped()` não é "a versão mais simples de escrever a query" — é uma ferramenta específica para
batch, com WHERE de tenant obrigatório. Usar por atalho aqui criou uma escrita cross-tenant possível. E o
`.catch(() => {})` no enqueue é o mesmo tipo de erro do incidente que vimos na Parte A: informar sucesso
pro usuário quando, na real, a operação pode nem ter sido enfileirada. Vale reforçar: se o catch não vai
fazer nada além de logar e seguir, questionar se deveria seguir mesmo.

Fora isso, a lógica de pegar o estoque de `channels[0]` e aplicar pra todos os canais (defeito 6) merece
uma segunda passada — pelo nome da feature, parece que o pull deveria ser por canal, não por "o primeiro
que aparecer".

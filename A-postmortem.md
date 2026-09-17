# Postmortem — Faturamento por item zerado (métricas diárias por item paradas desde 02/08)

## Resumo

Desde o dia 02/08, a tabela `order_item_metrics_daily` (métricas de faturamento **por item**) não recebe
nenhuma linha nova. O cron `orders-snapshot-daily` continua marcado como `Completed` todos os dias porque
o erro que impede a gravação é capturado e apenas registrado em log — o job nunca soube que falhou.
Isso afeta, muito provavelmente, **todos os tenants** que passam pelo mesmo caminho de código (o log
`item_batch_skipped` é emitido "uma linha por restaurante, todo dia", não só para `acc_7f2` — o restaurante
que abriu o chamado é apenas mais um caso do mesmo incidente).

PERGUNTARIA: confirmar com o time de suporte se outros restaurantes abriram chamado parecido no mesmo
período — a hipótese abaixo prevê que sim, para todos os tenants conectados a esse app parceiro específico.

## Causa raiz

O trecho relevante:

```ts
const rows = page.results.map(r => ({ accountId, storeId: r.store_id, itemId: r.item_id, snapshotDate: today, ... }));
try {
  await db.insert(orderItemMetricsDaily).values(rows)
    .onConflictDoUpdate({ target: [accountId, storeId, itemId, snapshotDate], set: {...} });
} catch (err) {
  logger.warn('orders.snapshot.item_batch_skipped', { accountId, rows: rows.length, err: String(err) });
}
```

O erro do Postgres — `ON CONFLICT DO UPDATE command cannot affect row a second time` — só acontece quando
**o mesmo comando `INSERT`** contém duas ou mais linhas que colidem na mesma chave de conflito
(`accountId + storeId + itemId + snapshotDate`). O Postgres proíbe atualizar a mesma linha-alvo duas vezes
dentro de uma única instrução.

Isso não é uma condição que existia antes — o item 6 da evidência mostra que o app de delivery publicou
"melhorias no relatório de pedidos" no dia 02, exatamente quando os warnings começaram. A hipótese mais
provável: a resposta paginada da API do parceiro passou a repetir o mesmo `item_id` em mais de uma
posição (paginação sobreposta, ou o item aparece por variação/combo mas mapeia para a mesma chave). O
resultado é que `page.results` chega com itens duplicados por chave, o `INSERT` inteiro do lote falha, cai
no `catch`, loga um `warn` — e o código **segue como se nada tivesse acontecido**: não há re-throw, não há
retry seletivo, o cron termina e é marcado `Completed`.

Por que só a tabela por item ficou zerada, e não a por loja (`order_store_metrics_daily`, que está
atualizada até ontem)? Porque é um caminho de código separado, que aparentemente não sofre da mesma
duplicação (agrega por loja, não por item, então duplicatas de item se anulam na agregação).

Por que o "filtro de 7 dias mostra R$ 0,00"? Porque toda consulta de faturamento por item nos últimos 7
dias não encontra nenhuma linha com `snapshot_date` recente — a última é do dia 01/08 e o filtro de 7 dias
não a alcança mais.

## Por que passou 10 dias sem ninguém ver

Três falhas empilhadas, não uma só:

1. **O erro é engolido no nível errado.** `catch` + `logger.warn` sem re-throw faz o job "ter sucesso" do
   ponto de vista do orquestrador. Um cron que sempre aparece `Completed` não é sinal de saúde — é
   ausência de sinal.
2. **Não existe alerta sobre staleness de dado**, só sobre falha de execução. Ninguém monitora "há quantos
   dias esta tabela não recebe uma linha nova por tenant" — que é exatamente o tipo de sintoma que este
   incidente produz.
3. **O `warn` não tem contexto suficiente para ação**: loga `accountId` e contagem de linhas, mas não loga
   *quais* chaves colidiram, nem dispara alerta de canal (Slack/PagerDuty). Um humano só encontra isso
   fazendo uma consulta manual proativa no banco — o que só aconteceu quando o cliente reclamou.

**O que faltava para gritar no dia 1**: um alerta automático de "0 linhas novas em `order_item_metrics_daily`
para tenant X nas últimas 24h após o cron rodar" (dado o cron roda diariamente, isso teria disparado no
dia 03/08, um dia depois do primeiro warning).

## Correção

Duas mudanças, uma imediata e uma estrutural:

**1. Deduplicar antes do insert (fix imediato).** Antes de montar `rows`, colapsar por chave de conflito,
mantendo a última ocorrência (ou somando, se fizer sentido de negócio — a decidir com o time de produto se
duplicatas representam o mesmo item reportado duas vezes ou item + variação que deveriam ser somados):

```ts
const dedup = new Map<string, RowType>();
for (const r of page.results) {
  const key = `${accountId}|${r.store_id}|${r.item_id}|${today}`;
  dedup.set(key, { accountId, storeId: r.store_id, itemId: r.item_id, snapshotDate: today, revenue: r.metrics.revenue, orders: r.metrics.orders });
}
const rows = [...dedup.values()];
```

**2. Parar de engolir o erro.** Se o insert falhar mesmo após dedup (schema mudou, tipo inválido, etc.), o
job deve **falhar de verdade** — sem `catch` silencioso — para que o orquestrador marque a execução como
`Failed` e o retry (com `step.run`) entre em ação. Logar continua sendo necessário, mas com `logger.error`
e sem suprimir a propagação:

```ts
try {
  await db.insert(orderItemMetricsDaily).values(rows).onConflictDoUpdate({...});
} catch (err) {
  logger.error('orders.snapshot.item_batch_failed', { accountId, rows: rows.length, err: String(err) });
  throw err; // deixa o job falhar e o retry/alerta do provedor agir
}
```

**Como provar que corrigiu:**
- Teste unitário que alimenta `page.results` com itens duplicados na mesma chave e verifica que o insert
  não lança mais o erro de conflito duplo (dedup funcionando).
- Teste que força um erro genuíno de insert (ex.: mock do `db.insert` rejeitando) e verifica que o erro
  **propaga** (não é engolido) — isto é, o `step.run` do job relança.
- Rodar o job manualmente contra o backfill do período de 02/08 a hoje e confirmar que
  `order_item_metrics_daily` volta a ter linha por dia, por tenant, por item.
- Consulta de sanidade pós-deploy: `select accountId, max(snapshot_date) from order_item_metrics_daily
  group by accountId` — nenhum tenant deve estar defasado mais de 1 dia.

## Gate anti-recorrência

- **Proibir `catch` que não propaga nem loga com `error` + contexto completo** — já é convenção da Prato
  (`.catch(() => {})` é proibido), mas este caso mostra que `logger.warn` + engolir também é um risco
  equivalente quando o efeito é "pular gravação de dado". Sugestão: adicionar linter/code review checklist
  para exigir que qualquer `catch` dentro de um `step.run` sempre re-lance, a menos que exista uma decisão
  de produto explícita documentada dizendo por que aquele erro é seguro de ignorar.
- **Alerta de staleness por tabela crítica**: monitorar `max(snapshot_date)` por tenant nas tabelas de
  métricas e disparar alerta se ultrapassar 1 dia do esperado. Isso é o gate mais importante — teria
  pegado o problema no dia seguinte ao início, não 10 dias depois.
- **Teste de contrato com a API do parceiro**: dado que o gatilho foi uma mudança do lado do app de
  delivery, vale um teste de integração/contrato que roda periodicamente contra um payload de exemplo
  atualizado da API do parceiro, para detectar mudanças de formato (chaves duplicadas, novos campos) antes
  que cheguem a produção silenciosamente.
- **Dedup defensivo em todo insert em lote vindo de API externa** — não confiar que uma API de terceiro
  nunca devolve duplicatas.

## Para o fundador

Desde o início de agosto, o app de delivery começou a mandar dados de pedidos com itens duplicados nas
respostas da API. Nosso sistema tentava salvar esses dados em lote, e quando encontrava a duplicata, a
gravação daquele dia falhava — mas o erro era só anotado em um log interno, sem avisar ninguém e sem
marcar a rotina como "falhou". Por isso o painel de faturamento por item ficou desatualizado para,
provavelmente, todos os restaurantes que usam esse app parceiro, mostrando números cada vez mais baixos
até zerar. O impacto é maior do que o de um cliente: qualquer decisão tomada com base em faturamento por
item ou na recomendação de cardápio (que também lê essa tabela) nas últimas duas semanas pode ter sido
baseada em dado incompleto. A correção é rápida (ajustar como lidamos com dados duplicados vindos do
parceiro e reprocessar o histórico perdido), mas o que muda de verdade é que vamos passar a monitorar
"esta tabela recebeu dado novo hoje?" para cada cliente — não só "o robô rodou sem travar" — para que um
problema como esse seja visto no dia seguinte, não dez dias depois.

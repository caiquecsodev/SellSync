# RFC — Rate limit compartilhado do app parceiro (cardápio de um restaurante derruba o de outro)

## Problema

Um dos apps de delivery limita chamadas de API **por aplicativo parceiro**, não por restaurante: todos os
restaurantes conectados pela Prato dividem um único balde de cota. Quando esse balde estoura, o app
devolve `partner_rate_limit_exceeded` para **qualquer** chamada seguinte — mesmo de um restaurante que não
tinha feito nada. É por isso que abrir o cardápio do restaurante A (que dispara 9 chamadas em paralelo)
pode fazer o restaurante B, sem relação nenhuma com A, começar a ver erro.

Hoje só existe uma proteção: o cron roda os restaurantes um de cada vez. Isso não protege a tela de
cardápio (9 chamadas paralelas, sem controle nenhum), nem o sincronizador de estoque, nem a importação —
todos batem na mesma API sem coordenação entre si.

## Onde o limitador deve morar

**No Redis, centralizado por app parceiro** (não por tenant, não em memória por instância).

Por quê ali e não em outro lugar:
- **Não pode ser em memória por instância**, porque rodamos serverless com várias instâncias simultâneas.
  Cada instância teria sua própria contagem, sem saber quantas chamadas as outras já fizeram — não
  resolveria o bug relatado, que é exatamente esse: chamadas de instâncias/fluxos diferentes competindo
  pelo mesmo balde sem coordenação.
- **Não pode ser por tenant**, porque o limite real é do app parceiro inteiro, compartilhado. Um limitador
  por tenant deixaria cada restaurante achar que tem sua própria cota, e a soma continuaria estourando o
  balde real do lado de fora.
- **Redis já está na stack**, é rápido o suficiente para não virar gargalo por chamada, e permite operações
  atômicas (`INCR` + `EXPIRE`, ou um script Lua para token bucket) que garantem contagem correta mesmo com
  concorrência entre processos.
- O limitador precisa ser **um só, por app parceiro**, e todo caminho que chama a API desse parceiro —
  tela de cardápio, cron, sincronizador de estoque, importação — passa pelo mesmo limitador antes de fazer
  a chamada. Se cada caminho tiver sua própria lógica de limite, a soma volta a estourar o balde real.

## O que estoura primeiro: cron ou tela?

**A tela.** O cron já é serial (um restaurante de cada vez, uma chamada por vez, efetivamente). A tela faz
**9 chamadas em paralelo por restaurante**, sem nada segurando, e pode ser aberta por qualquer usuário a
qualquer momento — inclusive vários donos/funcionários abrindo cardápios de restaurantes diferentes ao
mesmo tempo, cada abertura gerando um burst de 9 chamadas simultâneas contra o mesmo balde. Com 4
restaurantes isso já é arriscado; com "milhares" (meta declarada), a tela sozinha estoura o balde em
segundos se não for limitada. O cron continua sendo um risco secundário (soma ao consumo total), mas o
padrão de burst vem da tela.

## Quando o Redis cair, o limitador libera ou bloqueia?

**Bloqueia (fail-closed) para chamadas de escrita/batch (cron, sincronizador, importação); libera com
cautela (fail-open com fallback conservador) para leitura interativa da tela, com uma exceção importante
abaixo.**

Justificativa: se o Redis cair e o limitador simplesmente "liberar geral" (fail-open), qualquer coordenação
desaparece e o risco é estourar o balde do parceiro para todos os tenants ao mesmo tempo — o pior cenário
possível, pois derruba todo mundo, não só quem fez a chamada. Por isso, a política padrão é **fail-closed**:
sem Redis disponível, não fazemos a chamada e devolvemos erro tratável (a tela mostra "tente novamente em
instantes", o cron/sincronizador faz retry com backoff via o próprio mecanismo de `step.run`).

A única exceção é justificar caso a caso se o custo de bloquear uma leitura simples for muito alto para a
experiência do usuário (ex: cardápio não abre) — nesse caso, um fallback fail-open **com um limite fixo e
bem conservador aplicado localmente por instância** (ex: no máximo 1-2 chamadas simultâneas por instância)
é aceitável como degradação temporária, nunca como comportamento permanente. Isso é uma escolha de
produto/risco, não só técnica — vale confirmar com o fundador antes de decidir por fail-open em qualquer
caminho.

## Como escolher o número do limite sem ter o valor oficial

Não adivinhar um número e codificar como fixo. Abordagem:

1. **Medir o que já temos**: instrumentar todas as chamadas a esse app parceiro (hoje, mesmo sem
   limitador) contando taxa de sucesso vs. `partner_rate_limit_exceeded` ao longo do tempo, por minuto/
   segundo. Isso dá o teto real observado empiricamente, sem precisar confiar em "fontes secundárias".
2. **Começar conservador e ajustável em runtime**: implementar o limitador com um valor configurável (env
   var ou registro no Redis), não hardcoded — começando bem abaixo do que a observação sugerir (ex.: 50%
   do teto observado), e subir gradualmente enquanto monitoramos a taxa de erro do parceiro.
3. **Alarme de aproximação**: logar/alertar quando o consumo do balde (mesmo com o limitador ativo) passar
   de, por exemplo, 80% da cota configurada — isso permite ajustar antes de estourar de verdade, e também
   serve de sinal para renegociar/perguntar ao parceiro o número oficial.
4. Isso é iterativo por natureza: sem o número oficial, qualquer valor é uma hipótese a ser validada com
   dado real, não uma verdade fixa.

## O que eu não faria

- **Não faria um limitador em memória por instância** — não resolve o problema real (limite é
  compartilhado entre restaurantes/instâncias) e daria falsa sensação de segurança.
- **Não faria retry agressivo sem backoff** quando a API devolver `partner_rate_limit_exceeded` — isso
  pioraria o próprio estouro, criando um efeito cascata (mais retries = mais pressão no balde já
  estourado).
- **Não misturaria a lógica de limite com a lógica de negócio de cada caminho** (tela, cron, sync,
  importação implementando cada um sua própria checagem) — centralizar num único ponto/serviço de limite
  é o que garante que a soma real bate com o balde real do parceiro.
- **Não faria fail-open geral e permanente** em caso de queda do Redis — isso remove toda a proteção
  exatamente no momento em que ela é mais necessária (sem coordenação, tudo dispara ao mesmo tempo).
- **Não deixaria o número do limite hardcoded sem instrumentação** — sem medir, qualquer número escolhido
  é um chute que vai quebrar de novo quando a base crescer de 4 para milhares de restaurantes.

# PLAN — Parte D: a taxa que mente

**O que entendi**: o painel mostra taxa de entrega R$0,00 com selo ouro para pedidos cujo nível vem nos
formatos v2/v3 da API (`tier_id: '3_gold'` etc). Isso faz o lucro aparecer maior do que é de verdade.

**Hipótese do bug**: em `delivery-fee.ts`, `resolveTier` não reconhece os formatos v2/v3
(`tier_id: '1_bronze' | '2_silver' | '3_gold'`) e, quando não reconhece nada, sempre retorna `'ouro'` em
vez de admitir que não sabe. É essa a causa raiz: o sistema inventa um nível em vez de dizer "não sei".

**O que vai mudar**: só `resolveTier`.
- Passa a reconhecer os 3 formatos (v1, v2, v3) corretamente.
- Quando não reconhecer nada, retorna `'sem_nivel'` em vez de `'ouro'`.

**O que NÃO vai mudar**: `ProfitResult`, `getDeliveryFee`, `computeProfit`. O campo `tier: Tier | 'sem_nivel'`
já existia na definição original — o bug era só a função nunca produzir esse valor.

**Premissa**: com `tier: 'sem_nivel'`, `deliveryFee` continua saindo `0`, porque não existe taxa cadastrada
para um nível desconhecido — isso é comportamento correto de `getDeliveryFee`, não bug. Vou explicar no
README que, nesse caso, o lucro calculado não é confiável.

**Dúvida (PERGUNTARIA)**: se aparecer um formato totalmente novo e não previsto (ex.: uma versão v4 da API,
um objeto vazio, ou um valor corrompido), o certo é só marcar como `sem_nivel` (como estou fazendo) ou
bloquear o cálculo do pedido inteiro? Estou assumindo que marcar como `sem_nivel` e deixar visível é
suficiente por ora.

# Parte D — a taxa que mente

## O que estava errado

O painel financeiro calculava o lucro descontando a taxa de entrega do pedido, mas essa taxa
dependia do nível do restaurante no app (ouro, prata, bronze) — e o código que descobre esse
nível (`resolveTier`) tinha dois problemas:

1. Quando a informação do nível chegava em formatos mais novos da API do app de delivery
   (chamados aqui de v2 e v3), o código não sabia traduzir o código enviado (`3_gold`,
   `2_silver`, `1_bronze`) para o nome usado na tabela de taxas (`ouro`, `prata`, `bronze`).
   Resultado: a taxa nunca era encontrada e o sistema cobrava R$0,00 de taxa de entrega.
2. Quando o sistema não conseguia identificar o nível de jeito nenhum, ele assumia que o
   restaurante era `ouro` — o nível com a taxa mais barata — em vez de admitir que não sabia.

Os dois problemas juntos faziam o lucro exibido no painel ficar maior do que o lucro real,
porque a taxa de entrega (um custo do restaurante) estava sendo descontada a menos do que
deveria, ou não estava sendo descontada de jeito nenhum.

## Quanto isso mudava no lucro (os 3 pedidos de exemplo)

Os 3 pedidos de exemplo pertencem a um restaurante cujo nível chega no formato mais novo da
API (`{ tier_id: '3_gold' }`, que corresponde a `ouro`). Antes da correção, esse formato não
era reconhecido e a taxa saía sempre R$0,00:

| Pedido | Taxa antes (errada) | Taxa depois (correta) | Lucro antes (inflado) | Lucro depois (real) |
|---|---|---|---|---|
| P-1 | R$ 0,00 | R$ 11,20 | R$ 33,68 | R$ 22,48 |
| P-2 | R$ 0,00 | R$ 7,50 | R$ 23,71 | R$ 16,21 |
| P-3 | R$ 0,00 | R$ 4,90 | R$ 12,36 | R$ 7,46 |
| **Total** | | | **R$ 69,75** | **R$ 46,15** |

O lucro somado desses 3 pedidos estava **34% maior** do que o real — uma diferença de
R$ 23,60, que é exatamente a soma das taxas de entrega que deixaram de ser descontadas.

## O que acontece agora com um restaurante sem nível reconhecido

Se a API do app de delivery mandar um formato que o sistema não conhece (uma versão nova,
um dado corrompido, um valor vazio), o pedido passa a aparecer com `tier: sem_nivel` — de
forma visível — em vez de ser tratado silenciosamente como `ouro`. A taxa de entrega desse
pedido continua saindo R$0,00 (porque não existe taxa cadastrada para "sem nível"), mas agora
isso é um sinal explícito de que o lucro daquele pedido específico não deve ser tratado como
confiável, e não um número que parece certo mas não é.

## Prova de que a correção funciona

### Testes

```
npm install
npm test
```

Os 12 testes passam (`tsc --noEmit` também não acusa erro de tipo):

- 7 testes reproduzindo o sintoma original (taxa R$0,00 nos formatos v2/v3, fallback indevido
  para `ouro`) — todos ficaram vermelhos antes da correção e verdes depois.
- 1 teste validando o valor exato do lucro calculado (ver seção de mutantes abaixo).
- 3 testes cobrindo o aviso de drift (ver seção abaixo).
- 1 teste de fuzz com 500 cenários gerados.

### Mutantes

Três alterações pequenas e plausíveis foram aplicadas no código já corrigido, uma de cada
vez, para confirmar que a suíte de testes pega cada uma:

| # | Mutação | Resultado |
|---|---|---|
| 1 | `r.tier === tier` → `r.tier !== tier` em `getDeliveryFee` | Morto: 4 testes falharam |
| 2 | `return 'sem_nivel'` → `return 'ouro'` em `resolveTier` (o bug original) | Morto: 3 testes falharam |
| 3 | `- deliveryFee` → `+ deliveryFee` no cálculo do lucro em `computeProfit` | Sobreviveu na primeira tentativa: nenhum teste checava o valor de `profit`. Um teste novo foi adicionado para fechar essa lacuna, e agora esse mutante também é morto. |

### Fuzz test

`src/delivery-fee.fuzz.test.ts` gera 500 cenários com um gerador de números pseudoaleatórios
com seed fixa (`424242`, ajustável via variável de ambiente `FUZZ_SEED`), cobrindo formatos
v1/v2/v3 válidos e inválidos, valores não-string, `null`, `undefined`, `NaN`, números
negativos e objetos malformados. Cada cenário sabe de antemão qual nível é esperado, e o
teste falha se `resolveTier`/`computeProfit` divergirem disso, se algum valor não-finito for
produzido, ou se uma taxa for "inventada" para um nível desconhecido.

Quando o bug original foi reintroduzido de propósito para validar o próprio fuzz test, a
falha apareceu assim, incluindo seed e número do cenário:

```
[seed=424242 cenario=2] tierInput={"tier":""} expectedTier=sem_nivel order=P-1
resolveTier devolveu "ouro", esperado "sem_nivel"
```

### Aviso de drift

Quando a API manda um `tier_id` (direto ou dentro de `merchant`) que não está no mapa
conhecido (`1_bronze`/`2_silver`/`3_gold`), `resolveTier` emite um log estruturado antes de
cair em `sem_nivel`:

```
console.warn('{"event":"delivery_fee.tier_id_drift","source":"tier_id","tierId":"9_platinum"}')
```

Isso permite detectar em produção quando o app de delivery começa a mandar um código novo
(ex.: um nível "platina" que ainda não existe no sistema), sem esperar um restaurante abrir
chamado. Três testes cobrem isso: o log dispara para `tier_id` desconhecido, dispara para
`merchant.tier_id` desconhecido, e não dispara quando o código é reconhecido.

### Script `npm run profits`

Imprime a tabela de lucro dos 3 pedidos de exemplo:

```
npm run profits
```

```
┌─────────┬────────┬────────┬─────────────┬─────────┐
│ (index) │ pedido │ nivel  │ taxaEntrega │ lucro   │
├─────────┼────────┼────────┼─────────────┼─────────┤
│ 0       │ 'P-1'  │ 'ouro' │ '11.20'     │ '22.48' │
│ 1       │ 'P-2'  │ 'ouro' │ '7.50'      │ '16.21' │
│ 2       │ 'P-3'  │ 'ouro' │ '4.90'      │ '7.46'  │
└─────────┴────────┴────────┴─────────────┴─────────┘
```

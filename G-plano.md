# G-plano.md

## Onde mora o bug

Arquivo: `packages/features/bookings/lib/payment/processPaymentRefund.ts`
Função: `processPaymentRefund`
Linha específica: `processPaymentRefund.ts:29-30`

```ts
const successPayment = payment.find((p) => p.success);
if (!successPayment) return;
```

A função recebe `booking.payment: Payment[]` (linha 16 da assinatura) — ou seja, já espera um array com potencialmente vários pagamentos por reserva — mas usa `.find()`, que pega apenas o **primeiro** pagamento com `success: true` e ignora todos os demais. O reembolso final (linha 83) é acionado só para esse `successPayment.id`, via `handlePaymentRefund(successPayment.id, paymentAppCredential)`.

**Como cheguei lá:** comecei olhando a função `seatsPerTimeSlot` diretamente, mas percebi rápido que isso não ia me levar a lugar nenhum de forma eficiente — o termo aparece espalhado em vários arquivos (validação de cancelamento, cópia pra `CalendarEvent`, criação de assento, etc.), e ia consumir muito tempo ler tudo sem foco. Descartei essa rota e mudei a busca para arquivos com "cancel" no nome, o que me levou a `handleCancelBooking.ts` e, dentro dele, ao handler específico de assento `packages/features/bookings/lib/handleSeats/cancel/cancelAttendeeSeat.ts`. A partir daí, procurei arquivos de "payment" relacionados ao cancelamento e cheguei em `processPaymentRefund.ts`. Nesse ponto, pedi para a IA explicar o fluxo completo (como `handleCancelBooking`, `cancelAttendeeSeat` e `processPaymentRefund` se encaixam) para confirmar a hipótese antes de mexer em qualquer código.

## Raio de impacto

- **Quem chama:** `processPaymentRefund` é chamado a partir de `handleCancelBooking.ts` (linhas ~409-416), no branch de cancelamento total de uma reserva, quando existe pelo menos um pagamento com `paymentOption === "ON_BOOKING"`.
- **Dado de entrada:** `bookingToDelete.payment`, que vem de `getBookingToDelete.ts:50` com `payment: true` (sem filtro) — ou seja, a query já traz todos os pagamentos vinculados ao booking, incluindo os de eventos com `seatsPerTimeSlot > 1`, onde cada attendee gera seu próprio registro `Payment` (confirmado em `createNewSeat.ts:262`, via `handlePayment` → `PaymentService.create`).
- **O que pode quebrar se a correção for feita ali:** a função também é usada (indiretamente, pelo mesmo caminho) para reservas sem seats, onde só existe 1 pagamento — nesse caso o comportamento não muda. O risco de mudar a função é introduzir reembolso duplicado se não houver cuidado com idempotência (ver plano abaixo), ou quebrar o cálculo de `refundPolicy`/prazo de reembolso se ele for movido incorretamente para dentro de um loop sem preservar a leitura de `eventType.metadata` (que é a mesma para todos os pagamentos daquele evento).
- **A correção deveria ficar no mesmo lugar:** sim, dentro de `processPaymentRefund.ts`. É o ponto único onde o array de pagamentos da reserva chega e onde a decisão de reembolsar é tomada; não faz sentido duplicar essa lógica no chamador (`handleCancelBooking.ts`). Um ponto separado a avaliar (fora do escopo deste bug, mas relacionado) é que `cancelAttendeeSeat.ts` não aciona nenhum reembolso ao remover um único assento — isso é uma decisão de produto separada, não parte deste fix.

## Plano de correção (prosa)

A mudança troca `payment.find(p => p.success)` por uma iteração (`for...of` ou `.filter()` + loop) sobre **todos** os pagamentos com `success: true` do array `booking.payment`, chamando `handlePaymentRefund` uma vez para cada um. O cálculo de `appData`/`refundPolicy` que depende de `eventType.metadata` não muda de fonte (continua vindo do metadata do event type), mas passa a ser avaliado por pagamento dentro do loop, já que `currency`/`amount` podem variar entre os pagamentos dos diferentes attendees. A busca de credenciais (`prisma.credential.findMany`) pode ser feita uma única vez fora do loop, filtrando por `appId` dentro da iteração, para evitar repetir a mesma query N vezes. Para garantir que um pagamento já reembolsado não seja reembolsado de novo, a iteração processa cada `Payment` individualmente, mas a garantia de idempotência não vem do loop em si — ela já existe uma camada abaixo, dentro de cada `PaymentService.refund()` (confirmado em `stripepayment/lib/PaymentService.ts:346-367`): a função busca o `Payment` pelo `id`, checa `if (payment.refunded) return` antes de chamar a API do provedor, e só marca `refunded: true` no banco depois de um reembolso bem-sucedido. Como esse flag é persistido, ele protege contra reembolso duplicado mesmo entre execuções separadas de `processPaymentRefund` (ex.: a função for chamada de novo por um retry, ou o cancelamento for disparado duas vezes) — não só dentro de uma única execução. A mudança no loop só evita a chamada desnecessária a `handlePaymentRefund` para pagamentos que já sei que estão `refunded: true` (filtrando `p.success && !p.refunded` antes de iterar); a garantia de fato mora no `PaymentService`, que não muda.

## Testes

- **Arquivos existentes a tocar:** testes relacionados a `handleCancelBooking` (procurar por `handleCancelBooking.test.ts` ou equivalente em `packages/features/bookings/lib/__tests__` / diretório de testes do pacote) e, se existir, um teste dedicado a `processPaymentRefund`. Também vale checar testes de `handleSeats` para não quebrar o fluxo de assentos.
- **Cenário novo a escrever primeiro:** um teste com booking de evento pago, `seatsPerTimeSlot > 1`, dois ou mais `Payment` com `success: true` vinculados ao mesmo `bookingId`, cancelamento da reserva inteira, e asserção de que `handlePaymentRefund` foi chamado uma vez **para cada** `payment.id` (não apenas para o primeiro).

## Tempo gasto e o que faria diferente

Levei um tempo considerável de 2 horas na primeira tentativa porque comecei buscando literalmente pela string `seatsPerTimeSlot`, que aparece em muitos arquivos sem relação direta com pagamento/reembolso, então tive que abandonar essa busca no meio do caminho. Na próxima vez, começaria direto pela palavra-chave do sintoma (aqui, "cancel" + "payment"/"refund") em vez de partir de uma flag de configuração do evento, já que o sintoma (reembolso não acontece) está mais próximo do fluxo de pagamento do que do fluxo de configuração de assentos.

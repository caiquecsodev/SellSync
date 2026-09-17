import { computeProfit, fees, orders, tierFromApi } from './delivery-fee';

const rows = orders.map(order => {
  const result = computeProfit(order, tierFromApi, fees);
  return {
    pedido: result.orderId,
    nivel: result.tier,
    taxaEntrega: result.deliveryFee.toFixed(2),
    lucro: result.profit.toFixed(2),
  };
});

console.table(rows);

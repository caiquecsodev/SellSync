import { describe, expect, test } from 'vitest';
import { computeProfit, fees, orders, resolveTier, tierFromApi } from './delivery-fee';

describe('bug: taxa de entrega some quando o nível vem em formato v2/v3', () => {
  test('pedido P-1 (10km) com nível vindo em formato v2 (tier_id) não deveria ter taxa R$0,00', () => {
    const order = orders[0];
    const result = computeProfit(order, tierFromApi, fees);

    expect(result.deliveryFee).not.toBe(0);
    expect(result.deliveryFee).toBe(11.20);
  });

  test('pedido P-2 (5km) com nível vindo em formato v2 (tier_id) não deveria ter taxa R$0,00', () => {
    const order = orders[1];
    const result = computeProfit(order, tierFromApi, fees);

    expect(result.deliveryFee).not.toBe(0);
    expect(result.deliveryFee).toBe(7.50);
  });

  test('nível em formato v3 (merchant.tier_id) também deve resolver a taxa corretamente', () => {
    const order = orders[2];
    const result = computeProfit(order, { merchant: { tier_id: '2_silver' } }, fees);

    expect(result.tier).toBe('prata');
    expect(result.deliveryFee).toBe(6.90);
  });

  test('nível em formato v2 bronze (1_bronze) deve resolver para o tier "bronze"', () => {
    const order = orders[2];
    const result = computeProfit(order, { tier_id: '1_bronze' }, fees);

    expect(result.tier).toBe('bronze');
    expect(result.deliveryFee).toBe(8.90);
  });
});

describe('bug: nível desconhecido é tratado como "ouro" em vez de "sem_nivel"', () => {
  test('formato totalmente desconhecido não deve virar "ouro" por padrão', () => {
    const tier = resolveTier({ nivel_reportado: 'algo_novo' });

    expect(tier).not.toBe('ouro');
    expect(tier).toBe('sem_nivel');
  });

  test('entrada vazia/nula não deve virar "ouro" por padrão', () => {
    expect(resolveTier(null)).toBe('sem_nivel');
    expect(resolveTier(undefined)).toBe('sem_nivel');
    expect(resolveTier({})).toBe('sem_nivel');
  });

  test('computeProfit com nível desconhecido deve retornar tier "sem_nivel", nunca "ouro"', () => {
    const order = orders[0];
    const result = computeProfit(order, { formato_novo: true }, fees);

    expect(result.tier).toBe('sem_nivel');
  });
});

describe('cálculo de lucro', () => {
  test('lucro do pedido P-1 (nível ouro, 10km) desconta corretamente comissão e taxa de entrega', () => {
    const order = orders[0];
    const result = computeProfit(order, tierFromApi, fees);

    expect(result.profit).toBeCloseTo(22.48, 2);
  });
});

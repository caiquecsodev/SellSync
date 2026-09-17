export type Tier = 'ouro' | 'prata' | 'bronze';
export type DistanceBand = 'ate_2km' | 'ate_5km' | 'ate_10km';

export interface FeeRow { tier: Tier; band: DistanceBand; value: number }
export type FeeTable = FeeRow[];

export interface OrderRow {
  id: string;
  total: number; // valor do pedido
  cost: number; // custo dos insumos
  commissionPct: number; // comissão do app, ex.: 0.23
  band: DistanceBand;
}

export interface ProfitResult {
  orderId: string;
  deliveryFee: number;
  tier: Tier | 'sem_nivel';
  profit: number;
}

const VALID_TIERS: readonly Tier[] = ['ouro', 'prata', 'bronze'];

function isValidTier(value: string): value is Tier {
  return (VALID_TIERS as readonly string[]).includes(value);
}

const TIER_ID_MAP: Record<string, Tier> = {
  '1_bronze': 'bronze',
  '2_silver': 'prata',
  '3_gold': 'ouro',
};

// O app de delivery devolve o nível do restaurante em formatos diferentes conforme a versão da API:
// v1: { tier: 'ouro' }
// v2: { tier_id: '3_gold' } // 1_bronze | 2_silver | 3_gold
// v3: { merchant: { tier_id: '2_silver' } }
//
// Retorna 'sem_nivel' (em vez de assumir 'ouro') sempre que o formato não é reconhecido ou o
// nível informado não corresponde a um tier válido — nunca inventamos um nível.
export function resolveTier(input: unknown): Tier | 'sem_nivel' {
  const o = (input ?? {}) as Record<string, any>;

  if (typeof o.tier === 'string' && isValidTier(o.tier)) {
    return o.tier;
  }
  if (typeof o.tier_id === 'string' && TIER_ID_MAP[o.tier_id]) {
    return TIER_ID_MAP[o.tier_id];
  }
  if (o.merchant && typeof o.merchant.tier_id === 'string' && TIER_ID_MAP[o.merchant.tier_id]) {
    return TIER_ID_MAP[o.merchant.tier_id];
  }
  return 'sem_nivel';
}

export function getDeliveryFee(fees: FeeTable, tier: string, band: DistanceBand): number {
  const rows = fees.filter(r => r.tier === tier && r.band === band);
  return rows.length ? rows[0].value : 0;
}

export function computeProfit(order: OrderRow, tierInput: unknown, fees: FeeTable): ProfitResult {
  const tier = resolveTier(tierInput);
  const deliveryFee = getDeliveryFee(fees, tier, order.band);
  const commission = order.total * order.commissionPct;
  return {
    orderId: order.id,
    deliveryFee,
    tier,
    profit: order.total - order.cost - commission - deliveryFee,
  };
}

// dados de exemplo (um restaurante, 3 pedidos, nível vindo da API v2: { tier_id: '3_gold' })
export const fees: FeeTable = [
  { tier: 'ouro', band: 'ate_2km', value: 4.90 },
  { tier: 'ouro', band: 'ate_5km', value: 7.50 },
  { tier: 'ouro', band: 'ate_10km', value: 11.20 },
  { tier: 'prata', band: 'ate_2km', value: 6.90 },
  { tier: 'prata', band: 'ate_5km', value: 9.90 },
  { tier: 'prata', band: 'ate_10km', value: 14.50 },
  { tier: 'bronze', band: 'ate_2km', value: 8.90 },
  { tier: 'bronze', band: 'ate_5km', value: 12.90 },
  { tier: 'bronze', band: 'ate_10km', value: 18.90 },
];

export const orders: OrderRow[] = [
  { id: 'P-1', total: 84.00, cost: 31.00, commissionPct: 0.23, band: 'ate_10km' },
  { id: 'P-2', total: 56.50, cost: 19.80, commissionPct: 0.23, band: 'ate_5km' },
  { id: 'P-3', total: 32.00, cost: 11.00, commissionPct: 0.27, band: 'ate_2km' },
];

export const tierFromApi = { tier_id: '3_gold' };

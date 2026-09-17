import { describe, test, vi } from 'vitest';
import { computeProfit, fees, orders, resolveTier, type Tier } from './delivery-fee';

function mulberry32(seed: number) {
  let s = seed;
  return function rand(): number {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = Number(process.env.FUZZ_SEED ?? 424242);
const SCENARIOS = 500;

const KNOWN_TIERS = ['ouro', 'prata', 'bronze'] as const;
const TIER_ID_TO_TIER: Record<string, Tier> = {
  '1_bronze': 'bronze',
  '2_silver': 'prata',
  '3_gold': 'ouro',
};

type ExpectedTier = Tier | 'sem_nivel';
interface Scenario { tierInput: unknown; expectedTier: ExpectedTier }

function pick<T>(rand: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

function randomGarbageString(rand: () => number): string {
  const options = ['', ' ', 'ouro ', 'OURO', 'gold', '4_platinum', 'null', 'undefined', '0', '-1', 'NaN'];
  return pick(rand, options);
}

function randomGarbageValue(rand: () => number): unknown {
  const options: unknown[] = [null, undefined, NaN, -1, 0, Infinity, -Infinity, '', [], {}, true, false, 'texto_qualquer'];
  return pick(rand, options);
}

function generateScenario(rand: () => number): Scenario {
  const kind = Math.floor(rand() * 10);

  switch (kind) {
    case 0: {
      const tier = pick(rand, KNOWN_TIERS);
      return { tierInput: { tier }, expectedTier: tier };
    }
    case 1: {
      const tierId = pick(rand, Object.keys(TIER_ID_TO_TIER));
      return { tierInput: { tier_id: tierId }, expectedTier: TIER_ID_TO_TIER[tierId] };
    }
    case 2: {
      const tierId = pick(rand, Object.keys(TIER_ID_TO_TIER));
      return { tierInput: { merchant: { tier_id: tierId } }, expectedTier: TIER_ID_TO_TIER[tierId] };
    }
    case 3:
      return { tierInput: { tier: randomGarbageString(rand) }, expectedTier: 'sem_nivel' };
    case 4:
      return { tierInput: { tier_id: randomGarbageString(rand) }, expectedTier: 'sem_nivel' };
    case 5:
      return { tierInput: { merchant: { tier_id: randomGarbageValue(rand) } }, expectedTier: 'sem_nivel' };
    case 6:
      return rand() < 0.5
        ? { tierInput: { tier: randomGarbageValue(rand) }, expectedTier: 'sem_nivel' }
        : { tierInput: { tier_id: randomGarbageValue(rand) }, expectedTier: 'sem_nivel' };
    case 7:
      return { tierInput: {}, expectedTier: 'sem_nivel' };
    case 8:
      return { tierInput: randomGarbageValue(rand), expectedTier: 'sem_nivel' };
    default:
      return {
        tierInput: pick(rand, [
          { merchant: {} },
          { merchant: null },
          { merchant: 'texto' },
          { merchant: { tier_id: undefined } },
        ]),
        expectedTier: 'sem_nivel',
      };
  }
}

describe('fuzz: resolveTier/computeProfit nunca inventam nível nem quebram', () => {
  test(`gera ${SCENARIOS} cenários com seed=${SEED} e verifica invariantes`, () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rand = mulberry32(SEED);

    try {
      for (let i = 1; i <= SCENARIOS; i++) {
        const { tierInput, expectedTier } = generateScenario(rand);
        const order = pick(rand, orders);
        const ctx = `[seed=${SEED} cenario=${i}] tierInput=${JSON.stringify(tierInput)} expectedTier=${expectedTier} order=${order.id}`;

        let tier: ExpectedTier;
        try {
          tier = resolveTier(tierInput);
        } catch (err) {
          throw new Error(`${ctx} resolveTier lançou exceção inesperada: ${String(err)}`);
        }

        if (tier !== expectedTier) {
          throw new Error(`${ctx} resolveTier devolveu "${tier}", esperado "${expectedTier}"`);
        }

        const result = computeProfit(order, tierInput, fees);

        if (result.tier !== tier) {
          throw new Error(`${ctx} computeProfit.tier (${result.tier}) diverge de resolveTier (${tier})`);
        }

        if (!Number.isFinite(result.deliveryFee)) {
          throw new Error(`${ctx} deliveryFee não é um número finito: ${result.deliveryFee}`);
        }

        if (tier === 'sem_nivel' && result.deliveryFee !== 0) {
          throw new Error(`${ctx} nível desconhecido não pode gerar taxa inventada, mas deliveryFee=${result.deliveryFee}`);
        }

        const expectedRow = fees.find(f => f.tier === tier && f.band === order.band);
        const expectedFee = expectedRow ? expectedRow.value : 0;
        if (result.deliveryFee !== expectedFee) {
          throw new Error(`${ctx} deliveryFee (${result.deliveryFee}) diverge da tabela de taxas (esperado ${expectedFee})`);
        }

        const expectedCommission = order.total * order.commissionPct;
        const expectedProfit = order.total - order.cost - expectedCommission - result.deliveryFee;
        if (!Number.isFinite(result.profit) || Math.abs(result.profit - expectedProfit) > 1e-9) {
          throw new Error(`${ctx} profit (${result.profit}) diverge do esperado (${expectedProfit})`);
        }
      }
    } finally {
      warnSpy.mockRestore();
    }
  });
});

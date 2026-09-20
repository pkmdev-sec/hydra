import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCost, costEfficiency, findOptimal, paretoFrontier, estimateSpend, getPricing, listPricing } from '../lib/cost-optimizer.mjs';

describe('cost-optimizer', () => {
  describe('calculateCost', () => {
    it('calculates cost for known model', () => {
      const cost = calculateCost('claude-sonnet-4-6', 1000, 500);
      assert.ok(cost.totalCost > 0);
      assert.equal(cost.currency, 'USD');
      assert.equal(cost.error, null);
    });

    it('returns zero cost for unknown model', () => {
      const cost = calculateCost('unknown-model', 1000, 500);
      assert.equal(cost.totalCost, 0);
      assert.ok(cost.error);
    });

    it('calculates input and output separately', () => {
      const cost = calculateCost('gpt-4o-mini', 1_000_000, 1_000_000);
      assert.equal(cost.inputCost, 0.15);
      assert.equal(cost.outputCost, 0.6);
      assert.equal(cost.totalCost, 0.75);
    });

    it('handles zero tokens', () => {
      const cost = calculateCost('claude-sonnet-4-6', 0, 0);
      assert.equal(cost.totalCost, 0);
      assert.equal(cost.error, null);
    });

    it('haiku is cheaper than opus', () => {
      const haiku = calculateCost('claude-haiku-4-5-20251001', 1000, 1000);
      const opus = calculateCost('claude-opus-4-6', 1000, 1000);
      assert.ok(haiku.totalCost < opus.totalCost);
    });
  });

  describe('costEfficiency', () => {
    it('returns quality/cost ratio', () => {
      assert.equal(costEfficiency(80, 0.01), 8000);
    });

    it('returns Infinity for zero cost with quality', () => {
      assert.equal(costEfficiency(50, 0), Infinity);
    });

    it('returns 0 for zero quality and zero cost', () => {
      assert.equal(costEfficiency(0, 0), 0);
    });
  });

  describe('findOptimal', () => {
    const rankedResults = [
      { model: 'claude-opus-4-6', provider: 'anthropic', inputTokens: 500, outputTokens: 300, score: { composite: 90 }, error: null },
      { model: 'claude-sonnet-4-6', provider: 'anthropic', inputTokens: 500, outputTokens: 300, score: { composite: 75 }, error: null },
      { model: 'gpt-4o-mini', provider: 'openai', inputTokens: 500, outputTokens: 300, score: { composite: 60 }, error: null },
      { model: 'gemini-2.0-flash', provider: 'google', inputTokens: 500, outputTokens: 300, score: { composite: 55 }, error: null },
    ];

    it('finds the most cost-efficient model', () => {
      const result = findOptimal(rankedResults);
      assert.ok(result.recommended);
      assert.ok(result.recommended.efficiency > 0);
    });

    it('respects minimum quality constraint', () => {
      const result = findOptimal(rankedResults, { minQuality: 70 });
      for (const c of result.candidates) {
        assert.ok(c.quality >= 70);
      }
    });

    it('respects max budget constraint', () => {
      const result = findOptimal(rankedResults, { maxBudget: 0.001 });
      for (const c of result.candidates) {
        assert.ok(c.cost <= 0.001);
      }
    });

    it('returns null recommendation if no candidates qualify', () => {
      const result = findOptimal(rankedResults, { minQuality: 99, maxBudget: 0.000001 });
      assert.equal(result.recommended, null);
      assert.equal(result.candidates.length, 0);
    });

    it('provides analysis summary', () => {
      const result = findOptimal(rankedResults);
      assert.ok(result.analysis);
      assert.equal(result.analysis.totalEvaluated, 4);
    });
  });

  describe('paretoFrontier', () => {
    it('finds pareto-optimal candidates', () => {
      const candidates = [
        { model: 'a', quality: 90, cost: 0.10 },
        { model: 'b', quality: 70, cost: 0.05 },
        { model: 'c', quality: 60, cost: 0.08 },  // dominated by b
        { model: 'd', quality: 50, cost: 0.01 },
      ];
      const frontier = paretoFrontier(candidates);
      assert.ok(frontier.length >= 2);
      // c should not be on frontier (b is cheaper and higher quality)
      assert.ok(!frontier.some((f) => f.model === 'c'));
      assert.ok(frontier.some((f) => f.model === 'a'));
      assert.ok(frontier.some((f) => f.model === 'd'));
    });

    it('returns single item if one dominates all', () => {
      const candidates = [
        { model: 'a', quality: 90, cost: 0.01 },
        { model: 'b', quality: 70, cost: 0.10 },
        { model: 'c', quality: 60, cost: 0.20 },
      ];
      const frontier = paretoFrontier(candidates);
      assert.equal(frontier.length, 1);
      assert.equal(frontier[0].model, 'a');
    });
  });

  describe('estimateSpend', () => {
    it('estimates daily/monthly/yearly costs', () => {
      const est = estimateSpend('gpt-4o-mini', 100, 500, 200);
      assert.ok(est.perRequestCost >= 0);
      assert.ok(est.dailyCost >= 0);
      assert.ok(est.monthlyCost >= 0);
      assert.ok(est.yearlyCost >= 0);
      assert.ok(est.monthlyCost > est.dailyCost);
      assert.ok(est.yearlyCost > est.monthlyCost);
    });
  });

  describe('getPricing / listPricing', () => {
    it('returns pricing for known model', () => {
      const p = getPricing('claude-sonnet-4-6');
      assert.ok(p);
      assert.equal(p.input, 3.0);
      assert.equal(p.output, 15.0);
    });

    it('returns null for unknown model', () => {
      assert.equal(getPricing('unknown'), null);
    });

    it('lists all models with pricing', () => {
      const all = listPricing();
      assert.ok(all.length >= 8);
      for (const entry of all) {
        assert.ok(entry.model);
        assert.ok(entry.inputPer1M >= 0);
        assert.ok(entry.outputPer1M >= 0);
      }
    });
  });
});

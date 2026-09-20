import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { sendToModel, sendToMultiple, getCircuitBreaker, recordCircuitBreakerFailure, isCircuitBreakerOpen } from '../lib/multi-sender.mjs';
import { rankResults } from '../lib/quality-comparator.mjs';
import { calculateCost, calculateROI, applyVolumeDiscount, findOptimal } from '../lib/cost-optimizer.mjs';
import { LearningStore, learnFromResults } from '../lib/learning-engine.mjs';

describe('Integration Tests - P1 Features', () => {
  describe('Circuit Breaker Pattern', () => {
    it('opens circuit after consecutive failures', async () => {
      let callCount = 0;
      const mockFetch = mock.fn(async () => {
        callCount++;
        return {
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error'
        };
      });

      // Make 5 consecutive failing requests to trigger circuit breaker
      for (let i = 0; i < 5; i++) {
        await sendToModel('claude-sonnet-4-6', 'test', { fetchFn: mockFetch, maxRetries: 0 });
      }

      // Circuit should now be open
      assert.ok(isCircuitBreakerOpen('anthropic'));

      // Next request should be rejected immediately without calling fetch
      const beforeCount = callCount;
      const result = await sendToModel('claude-sonnet-4-6', 'test', { fetchFn: mockFetch, maxRetries: 0 });
      assert.equal(callCount, beforeCount); // No new fetch call
      assert.ok(result.error.includes('Circuit breaker open'));
    });

    it('allows requests in half-open state after cooldown', async () => {
      // Reset circuit breaker state by getting a fresh instance
      const breaker = getCircuitBreaker('testProvider');
      breaker.state = 'open';
      breaker.openedAt = Date.now() - 61_000; // 61 seconds ago

      // Should be in half-open state now
      assert.equal(isCircuitBreakerOpen('testProvider'), false);
    });
  });

  describe('Retry and Backoff for 429/503', () => {
    it('retries on 429 rate limit with exponential backoff', async () => {
      // Use a unique model to avoid circuit breaker interference
      let attemptCount = 0;
      const mockFetch = mock.fn(async () => {
        attemptCount++;
        if (attemptCount < 3) {
          return { ok: false, status: 429, text: async () => 'Rate limited' };
        }
        return {
          ok: true,
          json: async () => ({
            content: [{ text: 'Success after retries' }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: 'end_turn'
          })
        };
      });

      // Reset circuit breaker for anthropic
      const breaker = getCircuitBreaker('anthropic');
      breaker.failureCount = 0;
      breaker.state = 'closed';

      const result = await sendToModel('claude-sonnet-4-6', 'test', { fetchFn: mockFetch, maxRetries: 2 });
      assert.equal(result.text, 'Success after retries');
      assert.equal(attemptCount, 3); // Initial + 2 retries
    });

    it('retries on 503 service unavailable', async () => {
      let attemptCount = 0;
      const mockFetch = mock.fn(async () => {
        attemptCount++;
        if (attemptCount === 1) {
          return { ok: false, status: 503, text: async () => 'Service unavailable' };
        }
        return {
          ok: true,
          json: async () => ({
            content: [{ text: 'Success' }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: 'end_turn'
          })
        };
      });

      // Reset circuit breaker for anthropic
      const breaker = getCircuitBreaker('anthropic');
      breaker.failureCount = 0;
      breaker.state = 'closed';

      const result = await sendToModel('claude-sonnet-4-6', 'test', { fetchFn: mockFetch, maxRetries: 2 });
      assert.equal(result.text, 'Success');
      assert.equal(attemptCount, 2);
    });
  });

  describe('Multi-dimensional Quality Scoring', () => {
    it('includes correctness, style, and coherence scores', () => {
      const results = [
        {
          model: 'claude-sonnet-4-6',
          text: 'This is a comprehensive response with excellent vocabulary and well-structured sentences. It contains multiple points organized clearly.',
          latencyMs: 100,
          error: null
        },
        {
          model: 'gpt-4o',
          text: 'Short reply.',
          latencyMs: 50,
          error: null
        }
      ];

      const ranked = rankResults(results);
      assert.ok(ranked[0].score.correctness !== undefined);
      assert.ok(ranked[0].score.style !== undefined);
      assert.ok(ranked[0].score.coherence !== undefined);
      assert.ok(typeof ranked[0].score.correctness === 'number');
    });

    it('includes confidence intervals on scores', () => {
      const results = [
        { model: 'a', text: 'Good response with details.', latencyMs: 100, error: null },
        { model: 'b', text: 'Another good response.', latencyMs: 120, error: null }
      ];

      const ranked = rankResults(results);
      assert.ok(ranked[0].score.confidenceInterval);
      assert.ok(typeof ranked[0].score.confidenceInterval.lower === 'number');
      assert.ok(typeof ranked[0].score.confidenceInterval.upper === 'number');
      assert.ok(ranked[0].score.confidenceInterval.lower <= ranked[0].score.composite);
      assert.ok(ranked[0].score.confidenceInterval.upper >= ranked[0].score.composite);
    });
  });

  describe('ROI Tracking', () => {
    it('calculates quality improvement per dollar spent', () => {
      const roi = calculateROI(80, 0.05, 60, 0.01);
      assert.ok(typeof roi.roi === 'number');
      assert.equal(roi.qualityDelta, 20);
      assert.equal(roi.costDelta, 0.04);
      assert.ok(roi.roi > 0);
    });

    it('determines if upgrade is worth it', () => {
      // Good ROI: +30 quality for +0.04 cost = ROI of 750
      const goodROI = calculateROI(90, 0.05, 60, 0.01);
      assert.ok(goodROI.worthUpgrade);
      assert.ok(goodROI.roi > 50);

      // Bad ROI: +5 quality for +0.09 cost = ROI of ~55, but still worth it
      // Cost savings case: -1 quality for -0.05 cost
      const costSavings = calculateROI(59, 0.01, 60, 0.06);
      assert.ok(costSavings.worthUpgrade); // Cost savings with minimal quality loss
    });

    it('includes ROI comparisons in findOptimal', () => {
      const rankedResults = [
        { model: 'expensive', provider: 'a', inputTokens: 1000, outputTokens: 500, score: { composite: 90 }, error: null },
        { model: 'cheap', provider: 'b', inputTokens: 1000, outputTokens: 500, score: { composite: 60 }, error: null }
      ];

      const result = findOptimal(rankedResults);
      assert.ok(result.roiComparisons);
      assert.ok(Array.isArray(result.roiComparisons));
    });
  });

  describe('Batch API Pricing', () => {
    it('applies 50% discount for batch API usage', () => {
      const normalCost = calculateCost('claude-sonnet-4-6', 1_000_000, 1_000_000);
      const batchCost = calculateCost('claude-sonnet-4-6', 1_000_000, 1_000_000, { useBatch: true });

      assert.ok(batchCost.totalCost < normalCost.totalCost);
      assert.ok(batchCost.usedBatch); // Check boolean value
      // Should be approximately 50% discount
      assert.ok(batchCost.totalCost < normalCost.totalCost * 0.6);
    });
  });

  describe('Volume Discounts', () => {
    it('applies volume discount tiers correctly', () => {
      // No discount under $1k
      const discount1 = applyVolumeDiscount(500);
      assert.equal(discount1.discountPercent, 0);
      assert.equal(discount1.discountedCost, 500);

      // 5% discount at $1k
      const discount2 = applyVolumeDiscount(2000);
      assert.equal(discount2.discountPercent, 5);
      assert.ok(discount2.discountedCost < discount2.originalCost);

      // 10% discount at $10k
      const discount3 = applyVolumeDiscount(15000);
      assert.equal(discount3.discountPercent, 10);
      assert.equal(discount3.discountedCost, 13500);
    });
  });

  describe('A/B Comparison Framework', () => {
    it('starts and completes an A/B test', () => {
      const store = new LearningStore('/dev/null/test');

      // Start test
      store.startABTest('test1', 'code', 'model-a', 'model-b', 5);
      const test = store.getABTest('test1');
      assert.equal(test.status, 'running');

      // Record samples for both models
      for (let i = 0; i < 5; i++) {
        store.recordABTestSample('test1', 'model-a', { quality: 80 + i, cost: 0.01, latencyMs: 100 });
        store.recordABTestSample('test1', 'model-b', { quality: 70 + i, cost: 0.005, latencyMs: 120 });
      }

      // Test should be completed
      const completed = store.getABTest('test1');
      assert.equal(completed.status, 'completed');
      assert.ok(completed.result);
      assert.ok(completed.result.winner);
    });

    it('calculates statistical significance', () => {
      const store = new LearningStore('/dev/null/test');
      store.startABTest('test2', 'analysis', 'model-x', 'model-y', 30); // Increase sample size for significance

      // Clearly different results
      for (let i = 0; i < 30; i++) {
        store.recordABTestSample('test2', 'model-x', { quality: 90, cost: 0.02, latencyMs: 100 });
        store.recordABTestSample('test2', 'model-y', { quality: 50, cost: 0.01, latencyMs: 150 });
      }

      const result = store.getABTest('test2');
      assert.equal(result.result.isSignificant, true);
      assert.ok(result.result.tScore > 0);
    });
  });

  describe('Observation Windowing and Pruning', () => {
    it('limits observations to MAX_OBSERVATIONS', () => {
      const store = new LearningStore('/dev/null/test');

      // Record more than max observations
      for (let i = 0; i < 1100; i++) {
        store.record({
          taskType: 'general',
          model: 'test-model',
          quality: 75,
          cost: 0.01,
          latencyMs: 100
        });
      }

      assert.equal(store.getObservationCount(), 1000); // Should be capped
    });
  });

  describe('Batched/Debounced Saves', () => {
    it('debounces multiple save calls', async () => {
      const store = new LearningStore('/tmp/test-debounce.json');

      // Queue multiple saves
      store.saveDebounced();
      store.saveDebounced();
      store.saveDebounced();

      // Only one save timer should be active
      assert.ok(store._saveTimer !== null);
      assert.equal(store._pendingSave, true);
    });

    it('can force immediate save', async () => {
      const store = new LearningStore('/tmp/test-immediate.json');

      store.saveDebounced();
      await store.saveNow(); // Should cancel debounced and save immediately

      assert.equal(store._saveTimer, null);
      assert.equal(store._pendingSave, false);
    });
  });

  describe('Full Integration: Multi-Model Response with All Features', () => {
    it('tests complete workflow with all P1 features', async () => {
      // Mock fetch for multiple models
      const mockFetch = mock.fn(async (url) => {
        const modelMatch = url.match(/claude|gpt|gemini/);
        const model = modelMatch ? modelMatch[0] : 'unknown';

        return {
          ok: true,
          json: async () => {
            if (model === 'claude') {
              return {
                content: [{ text: 'Excellent detailed response from Claude with comprehensive analysis and examples.' }],
                usage: { input_tokens: 100, output_tokens: 50 },
                stop_reason: 'end_turn'
              };
            } else if (model === 'gemini') {
              return {
                candidates: [{ content: { parts: [{ text: 'Good response from Gemini.' }] }, finishReason: 'STOP' }],
                usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30 }
              };
            }
            return {
              choices: [{ message: { content: 'Response from GPT.' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 100, completion_tokens: 40 }
            };
          }
        };
      });

      // Send to multiple models
      const multiResult = await sendToMultiple(
        ['claude-sonnet-4-6', 'gpt-4o', 'gemini-2.0-flash'],
        'Analyze the performance characteristics of distributed systems',
        { fetchFn: mockFetch }
      );

      assert.equal(multiResult.results.length, 3);

      // Rank results with multi-dimensional scoring
      const ranked = rankResults(multiResult.results, 'analysis');

      // Verify multi-dimensional scores
      assert.ok(ranked[0].score.correctness);
      assert.ok(ranked[0].score.style);
      assert.ok(ranked[0].score.coherence);
      assert.ok(ranked[0].score.confidenceInterval);

      // Find optimal with ROI tracking
      const optimal = findOptimal(ranked, { minQuality: 40, useBatch: true });
      assert.ok(optimal.recommended);
      assert.ok(optimal.roiComparisons);

      // Volume discount calculation
      const discount = applyVolumeDiscount(5000);
      assert.ok(discount.discountPercent > 0);

      // Learning engine integration
      const store = new LearningStore('/dev/null/test-full');
      const learned = learnFromResults(store, multiResult.prompt, ranked);

      assert.equal(learned.taskType, 'analysis');
      assert.ok(store.getObservationCount() > 0);
    });
  });
});

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask, LearningStore, learnFromResults } from '../lib/learning-engine.mjs';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

describe('learning-engine', () => {
  describe('classifyTask', () => {
    it('classifies code tasks', () => {
      assert.equal(classifyTask('Write a function to sort an array'), 'code');
      assert.equal(classifyTask('Debug this API endpoint'), 'code');
      assert.equal(classifyTask('Implement a class for user auth'), 'code');
    });

    it('classifies creative tasks', () => {
      assert.equal(classifyTask('Write a short story about space'), 'creative');
      assert.equal(classifyTask('Compose a poem about nature'), 'creative');
    });

    it('classifies analysis tasks', () => {
      assert.equal(classifyTask('Analyze the performance of this system'), 'analysis');
      assert.equal(classifyTask('Compare React and Vue frameworks'), 'analysis');
      assert.equal(classifyTask('Summarize this research paper'), 'analysis');
    });

    it('classifies math tasks', () => {
      assert.equal(classifyTask('Calculate the derivative of x^2'), 'math');
      assert.equal(classifyTask('Solve this equation for x'), 'math');
    });

    it('classifies translation tasks', () => {
      assert.equal(classifyTask('Translate this text to French'), 'translation');
    });

    it('defaults to general for unclassified prompts', () => {
      assert.equal(classifyTask('Hello, how are you?'), 'general');
      assert.equal(classifyTask('What is the weather?'), 'general');
    });

    it('handles null/empty input', () => {
      assert.equal(classifyTask(''), 'general');
      assert.equal(classifyTask(null), 'general');
    });
  });

  describe('LearningStore', () => {
    let store;
    let tmpDir;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'hydra-test-'));
      store = new LearningStore(join(tmpDir, 'test-store.json'));
    });

    it('starts with empty data', () => {
      assert.equal(store.getObservationCount(), 0);
      assert.deepEqual(store.getAllPreferences(), {});
    });

    it('records observations', () => {
      store.record({ taskType: 'code', model: 'claude-sonnet-4-6', quality: 80, cost: 0.01, latencyMs: 200 });
      assert.equal(store.getObservationCount(), 1);
    });

    it('updates preferences after recording', () => {
      store.record({ taskType: 'code', model: 'claude-sonnet-4-6', quality: 80, cost: 0.01, latencyMs: 200 });
      store.record({ taskType: 'code', model: 'gpt-4o', quality: 70, cost: 0.02, latencyMs: 300 });

      const pref = store.getPreference('code');
      assert.ok(pref);
      assert.ok(pref.recommended);
      assert.ok(pref.ranking.length === 2);
    });

    it('recommends the most efficient model', () => {
      // Record many observations to build confidence
      for (let i = 0; i < 15; i++) {
        store.record({ taskType: 'code', model: 'model-cheap', quality: 70, cost: 0.001, latencyMs: 100 });
        store.record({ taskType: 'code', model: 'model-expensive', quality: 75, cost: 0.10, latencyMs: 100 });
      }

      const rec = store.getRecommendation('code');
      assert.equal(rec, 'model-cheap'); // Much better efficiency
    });

    it('returns null recommendation for unknown task types', () => {
      assert.equal(store.getRecommendation('nonexistent'), null);
    });

    it('returns model stats', () => {
      store.record({ taskType: 'analysis', model: 'claude-opus-4-6', quality: 90, cost: 0.05, latencyMs: 500 });
      store.record({ taskType: 'analysis', model: 'claude-opus-4-6', quality: 85, cost: 0.04, latencyMs: 400 });

      const stats = store.getModelStats('analysis', 'claude-opus-4-6');
      assert.ok(stats);
      assert.equal(stats.count, 2);
      assert.equal(stats.avgQuality, 87.5);
    });

    it('returns null for unknown model stats', () => {
      assert.equal(store.getModelStats('code', 'nonexistent'), null);
    });

    it('persists and loads from disk', async () => {
      store.record({ taskType: 'code', model: 'test-model', quality: 85, cost: 0.01, latencyMs: 150 });
      await store.save();

      const store2 = new LearningStore(join(tmpDir, 'test-store.json'));
      await store2.load();
      assert.equal(store2.getObservationCount(), 1);
      assert.ok(store2.getRecommendation('code'));
    });

    it('handles missing store file gracefully', async () => {
      const fresh = new LearningStore(join(tmpDir, 'nonexistent.json'));
      await fresh.load();
      assert.equal(fresh.getObservationCount(), 0);
    });

    it('resets all data', () => {
      store.record({ taskType: 'code', model: 'test', quality: 80, cost: 0.01, latencyMs: 100 });
      assert.equal(store.getObservationCount(), 1);
      store.reset();
      assert.equal(store.getObservationCount(), 0);
      assert.deepEqual(store.getAllPreferences(), {});
    });
  });

  describe('learnFromResults', () => {
    it('records results and returns recommendation', () => {
      const store = new LearningStore('/dev/null/never-written');
      const rankedResults = [
        { model: 'claude-sonnet-4-6', score: { composite: 80 }, cost: 0.01, latencyMs: 200, error: null },
        { model: 'gpt-4o', score: { composite: 70 }, cost: 0.02, latencyMs: 300, error: null },
      ];

      const outcome = learnFromResults(store, 'Write a function to sort numbers', rankedResults);
      assert.equal(outcome.taskType, 'code');
      assert.ok(outcome.recommendation);
    });

    it('skips error results', () => {
      const store = new LearningStore('/dev/null/never-written');
      const rankedResults = [
        { model: 'claude-sonnet-4-6', score: { composite: 80 }, cost: 0.01, latencyMs: 200, error: null },
        { model: 'gpt-4o', error: 'timeout', score: { error: true } },
      ];

      const outcome = learnFromResults(store, 'Analyze this data', rankedResults);
      assert.equal(store.getObservationCount(), 1);
    });

    it('classifies and routes to correct task type', () => {
      const store = new LearningStore('/dev/null/never-written');
      const results = [
        { model: 'test', score: { composite: 75 }, cost: 0.01, latencyMs: 100, error: null },
      ];

      const code = learnFromResults(store, 'Implement a REST API', results);
      assert.equal(code.taskType, 'code');

      const creative = learnFromResults(store, 'Write a poem about the ocean', results);
      assert.equal(creative.taskType, 'creative');
    });
  });
});

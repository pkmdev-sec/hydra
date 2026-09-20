/**
 * HYDRA Learning Engine — Learn and store task-type preferences over time.
 * Tracks which models perform best for which task types and adapts routing.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const DEFAULT_STORE_PATH = join(process.env.HOME || '/tmp', '.hydra', 'learning-store.json');
const MAX_OBSERVATIONS = 1000; // FIX: Limit observation growth
const OBSERVATION_EXPIRY_DAYS = 90; // Expire observations older than 90 days
const DEBOUNCE_SAVE_MS = 5000; // Debounce saves by 5 seconds

/** Classify a prompt into a task type using keyword heuristics */
export function classifyTask(prompt) {
  if (!prompt || typeof prompt !== 'string') return 'general';

  const lower = prompt.toLowerCase();

  // FIX: Check patterns in priority order and score by specificity
  // More specific patterns should be checked first to avoid overlap issues
  const patterns = {
    translation: /\b(translate|translation|convert.*language|in\s+(french|spanish|german|chinese|japanese))\b/,
    math: /\b(calculate|compute|solve|equation|formula|math|statistical|probability|derivative|integral)\b/,
    code: /\b(code|function|implement|debug|refactor|class|api|endpoint|bug|error|syntax|compile|script|program|algorithm)\b/,
    analysis: /\b(analyze|compare|evaluate|assess|review|summarize|explain|breakdown|investigate|research)\b/,
    creative: /\b(write|story|poem|creative|imagine|fiction|narrative|describe|compose|blog|essay)\b/,
  };

  // Score matches by counting keyword hits to find most specific match
  let bestMatch = 'general';
  let maxMatches = 0;

  for (const [taskType, pattern] of Object.entries(patterns)) {
    const matches = (lower.match(pattern) || []).length;
    if (matches > maxMatches) {
      maxMatches = matches;
      bestMatch = taskType;
    }
  }

  return bestMatch;
}

/**
 * In-memory learning store with persistence.
 */
export class LearningStore {
  constructor(storePath = DEFAULT_STORE_PATH) {
    this.storePath = storePath;
    this.data = {
      observations: [],
      preferences: {},
      modelStats: {},
      abTests: {}, // A/B test results
      version: 1,
    };
    this._loaded = false;
    this._saveTimer = null; // For debounced saves
    this._pendingSave = false;
  }

  /** Load store from disk */
  async load() {
    try {
      const raw = await readFile(this.storePath, 'utf-8');
      const parsed = JSON.parse(raw);
      // FIX: Validate parsed data structure and log warnings on corrupt data
      if (parsed && typeof parsed === 'object') {
        this.data = {
          observations: Array.isArray(parsed.observations) ? parsed.observations : [],
          preferences: typeof parsed.preferences === 'object' ? parsed.preferences : {},
          modelStats: typeof parsed.modelStats === 'object' ? parsed.modelStats : {},
          abTests: typeof parsed.abTests === 'object' ? parsed.abTests : {},
          version: parsed.version || 1,
        };

        // Prune expired observations on load
        this._pruneExpiredObservations();
      }
      this._loaded = true;
    } catch (err) {
      // FIX: Proper error handling - log warnings, reset on corrupt data (line 53)
      if (err.code !== 'ENOENT') {
        console.error(`Warning: Failed to load learning store from ${this.storePath}:`, err.message);
        console.error('Resetting to default state due to corrupt data.');
      }
      // Use defaults on error
      this.data = { observations: [], preferences: {}, modelStats: {}, abTests: {}, version: 1 };
      this._loaded = true;
    }
    return this;
  }

  /** Prune observations older than OBSERVATION_EXPIRY_DAYS */
  _pruneExpiredObservations() {
    const expiryTime = Date.now() - (OBSERVATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    const before = this.data.observations.length;
    this.data.observations = this.data.observations.filter(obs => {
      const obsTime = new Date(obs.timestamp).getTime();
      return obsTime > expiryTime;
    });
    const after = this.data.observations.length;
    if (before > after) {
      console.log(`Pruned ${before - after} expired observations (older than ${OBSERVATION_EXPIRY_DAYS} days)`);
    }
  }

  /** Persist store to disk */
  async save() {
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, JSON.stringify(this.data, null, 2), 'utf-8');
    this._pendingSave = false;
  }

  /** Debounced save - batches multiple save requests */
  async saveDebounced() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
    }

    this._pendingSave = true;
    this._saveTimer = setTimeout(async () => {
      if (this._pendingSave) {
        await this.save();
      }
    }, DEBOUNCE_SAVE_MS);
  }

  /** Force immediate save, canceling any pending debounced save */
  async saveNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    await this.save();
  }

  /**
   * Record an observation: which model performed how on a given task type.
   * @param {object} observation - { taskType, model, quality, cost, latencyMs, timestamp }
   */
  record(observation) {
    const entry = {
      taskType: observation.taskType || 'general',
      model: observation.model,
      quality: observation.quality || 0,
      cost: observation.cost || 0,
      latencyMs: observation.latencyMs || 0,
      timestamp: observation.timestamp || new Date().toISOString(),
    };

    this.data.observations.push(entry);

    // FIX: Prune old observations to prevent unbounded growth
    if (this.data.observations.length > MAX_OBSERVATIONS) {
      this.data.observations = this.data.observations.slice(-MAX_OBSERVATIONS);
    }

    // Update rolling model stats
    const key = `${entry.taskType}:${entry.model}`;
    if (!this.data.modelStats[key]) {
      this.data.modelStats[key] = { count: 0, totalQuality: 0, totalCost: 0, totalLatency: 0 };
    }
    const stats = this.data.modelStats[key];
    stats.count++;
    stats.totalQuality += entry.quality;
    stats.totalCost += entry.cost;
    stats.totalLatency += entry.latencyMs;

    // Recompute preference
    this._updatePreference(entry.taskType);

    return entry;
  }

  /** Recompute the preferred model for a task type based on accumulated stats */
  _updatePreference(taskType) {
    const relevant = Object.entries(this.data.modelStats)
      .filter(([key]) => key.startsWith(`${taskType}:`))
      .map(([key, stats]) => {
        const model = key.split(':').slice(1).join(':');
        const avgQuality = stats.totalQuality / stats.count;
        const avgCost = stats.totalCost / stats.count;
        // Efficiency: quality per cost, with bonus for sample size
        // FIX: Change confidence formula from /10 to /30 (less aggressive)
        const confidence = Math.min(1, stats.count / 30);
        const efficiency = avgCost > 0 ? (avgQuality / avgCost) * confidence : avgQuality * confidence;
        return { model, avgQuality, avgCost, efficiency, sampleCount: stats.count };
      });

    relevant.sort((a, b) => b.efficiency - a.efficiency);

    this.data.preferences[taskType] = {
      recommended: relevant[0]?.model || null,
      ranking: relevant,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Get the recommended model for a task type.
   * @param {string} taskType
   * @returns {string|null} - Model identifier or null if no data
   */
  getRecommendation(taskType) {
    return this.data.preferences[taskType]?.recommended || null;
  }

  /**
   * Get full preference data for a task type.
   * @param {string} taskType
   * @returns {object|null}
   */
  getPreference(taskType) {
    return this.data.preferences[taskType] || null;
  }

  /** Get stats for a specific model on a task type */
  getModelStats(taskType, model) {
    const key = `${taskType}:${model}`;
    const stats = this.data.modelStats[key];
    if (!stats) return null;
    return {
      model,
      taskType,
      count: stats.count,
      avgQuality: parseFloat((stats.totalQuality / stats.count).toFixed(2)),
      avgCost: parseFloat((stats.totalCost / stats.count).toFixed(6)),
      avgLatency: Math.round(stats.totalLatency / stats.count),
    };
  }

  /** Get all preferences */
  getAllPreferences() {
    return { ...this.data.preferences };
  }

  /** Get total observation count */
  getObservationCount() {
    return this.data.observations.length;
  }

  /** Clear all learned data */
  reset() {
    this.data = { observations: [], preferences: {}, modelStats: {}, abTests: {}, version: 1 };
  }

  /**
   * Start an A/B test comparing two models for a specific task type.
   * @param {string} testId - Unique identifier for this A/B test
   * @param {string} taskType - Task type to test on
   * @param {string} modelA - First model to compare
   * @param {string} modelB - Second model to compare
   * @param {number} [sampleSize=50] - Number of samples to collect
   */
  startABTest(testId, taskType, modelA, modelB, sampleSize = 50) {
    this.data.abTests[testId] = {
      testId,
      taskType,
      modelA,
      modelB,
      sampleSize,
      samplesA: [],
      samplesB: [],
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      result: null
    };
    return this.data.abTests[testId];
  }

  /**
   * Record an A/B test observation.
   * @param {string} testId - Test identifier
   * @param {string} model - Which model (should be modelA or modelB)
   * @param {object} observation - { quality, cost, latencyMs }
   */
  recordABTestSample(testId, model, observation) {
    const test = this.data.abTests[testId];
    if (!test || test.status !== 'running') {
      return { error: 'Test not found or not running' };
    }

    const sample = {
      quality: observation.quality || 0,
      cost: observation.cost || 0,
      latencyMs: observation.latencyMs || 0,
      timestamp: new Date().toISOString()
    };

    if (model === test.modelA) {
      test.samplesA.push(sample);
    } else if (model === test.modelB) {
      test.samplesB.push(sample);
    } else {
      return { error: 'Model not part of this test' };
    }

    // Check if test is complete
    if (test.samplesA.length >= test.sampleSize && test.samplesB.length >= test.sampleSize) {
      this._completeABTest(testId);
    }

    return { success: true, samplesCollected: { A: test.samplesA.length, B: test.samplesB.length } };
  }

  /**
   * Complete an A/B test and compute results.
   * @private
   */
  _completeABTest(testId) {
    const test = this.data.abTests[testId];
    if (!test) return;

    const avgA = {
      quality: test.samplesA.reduce((sum, s) => sum + s.quality, 0) / test.samplesA.length,
      cost: test.samplesA.reduce((sum, s) => sum + s.cost, 0) / test.samplesA.length,
      latencyMs: test.samplesA.reduce((sum, s) => sum + s.latencyMs, 0) / test.samplesA.length
    };

    const avgB = {
      quality: test.samplesB.reduce((sum, s) => sum + s.quality, 0) / test.samplesB.length,
      cost: test.samplesB.reduce((sum, s) => sum + s.cost, 0) / test.samplesB.length,
      latencyMs: test.samplesB.reduce((sum, s) => sum + s.latencyMs, 0) / test.samplesB.length
    };

    // Calculate statistical significance (simplified t-test approximation)
    const qualityDiff = avgA.quality - avgB.quality;
    const costDiff = avgA.cost - avgB.cost;

    // Calculate standard errors
    const seA = this._standardError(test.samplesA.map(s => s.quality));
    const seB = this._standardError(test.samplesB.map(s => s.quality));
    const combinedSE = Math.sqrt(seA * seA + seB * seB);
    const tScore = combinedSE > 0 ? Math.abs(qualityDiff) / combinedSE : 0;

    // Simple significance check (t > 2 is roughly p < 0.05 for large samples)
    const isSignificant = tScore > 2;

    // Determine winner
    let winner = null;
    if (isSignificant) {
      winner = avgA.quality > avgB.quality ? test.modelA : test.modelB;
    }

    test.result = {
      modelA: { model: test.modelA, ...avgA },
      modelB: { model: test.modelB, ...avgB },
      winner,
      qualityDiff: parseFloat(qualityDiff.toFixed(2)),
      costDiff: parseFloat(costDiff.toFixed(6)),
      isSignificant,
      tScore: parseFloat(tScore.toFixed(2)),
      recommendation: winner ? `Use ${winner} for ${test.taskType} tasks` : 'No significant difference detected'
    };

    test.status = 'completed';
    test.completedAt = new Date().toISOString();
  }

  /**
   * Calculate standard error for a sample.
   * @private
   */
  _standardError(values) {
    if (values.length === 0) return 0;
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    // For constant values (variance = 0), use a small epsilon to avoid division by zero
    return stdDev === 0 ? 0.0001 : Math.sqrt(variance / values.length);
  }

  /**
   * Get A/B test results.
   * @param {string} testId - Test identifier
   */
  getABTest(testId) {
    return this.data.abTests[testId] || null;
  }

  /**
   * List all A/B tests.
   */
  listABTests() {
    return Object.values(this.data.abTests);
  }
}

/**
 * High-level function: given a prompt and available ranked results,
 * record the outcome and return a recommendation for future similar tasks.
 * @param {LearningStore} store - The learning store instance
 * @param {string} prompt - The prompt that was executed
 * @param {object[]} rankedResults - Ranked results with scores
 * @param {object} [options] - { autoSave: boolean } - Auto-save after recording
 */
export function learnFromResults(store, prompt, rankedResults, options = {}) {
  const { autoSave = false } = options;
  const taskType = classifyTask(prompt);

  for (const result of rankedResults) {
    if (result.error || result.score?.error) continue;
    store.record({
      taskType,
      model: result.model,
      quality: result.score?.composite || 0,
      cost: result.cost || 0,
      latencyMs: result.latencyMs || 0,
    });
  }

  // Use debounced save if autoSave is enabled
  if (autoSave) {
    store.saveDebounced();
  }

  return {
    taskType,
    recommendation: store.getRecommendation(taskType),
    preference: store.getPreference(taskType),
  };
}

export default { classifyTask, LearningStore, learnFromResults };

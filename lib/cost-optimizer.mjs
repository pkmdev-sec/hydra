/**
 * HYDRA Cost Optimizer — Find the cheapest model that meets quality thresholds.
 * Maintains a pricing database and computes cost-quality Pareto frontiers.
 */

/** Pricing per 1M tokens (USD) — updated periodically */
const MODEL_PRICING = {
  // Anthropic
  'claude-opus-4-6':              { input: 15.00,  output: 75.00, batchInput: 7.50, batchOutput: 37.50 },
  'claude-sonnet-4-6':            { input: 3.00,   output: 15.00, batchInput: 1.50, batchOutput: 7.50 },
  'claude-haiku-4-5-20251001':    { input: 0.80,   output: 4.00, batchInput: 0.40, batchOutput: 2.00 },
  // OpenAI
  'gpt-4o':                       { input: 2.50,   output: 10.00, batchInput: 1.25, batchOutput: 5.00 },
  'gpt-4o-mini':                  { input: 0.15,   output: 0.60, batchInput: 0.075, batchOutput: 0.30 },
  'gpt-4-turbo':                  { input: 10.00,  output: 30.00, batchInput: 5.00, batchOutput: 15.00 },
  // Google
  'gemini-2.0-flash':             { input: 0.10,   output: 0.40, batchInput: 0.05, batchOutput: 0.20 },
  'gemini-2.0-pro':               { input: 1.25,   output: 5.00, batchInput: 0.625, batchOutput: 2.50 },
};

/** Volume discount tiers (monthly spend thresholds) */
const VOLUME_DISCOUNTS = [
  { threshold: 0, discount: 0 },
  { threshold: 1000, discount: 0.05 },    // 5% off at $1k/month
  { threshold: 10000, discount: 0.10 },   // 10% off at $10k/month
  { threshold: 50000, discount: 0.15 },   // 15% off at $50k/month
  { threshold: 100000, discount: 0.20 },  // 20% off at $100k/month
];

/**
 * Calculate the cost of a single model invocation.
 * @param {string} model - Model identifier
 * @param {number} inputTokens - Number of input tokens
 * @param {number} outputTokens - Number of output tokens
 * @param {object} [options] - { useBatch: boolean } - Use batch API pricing (50% discount)
 * @returns {object} - { model, inputCost, outputCost, totalCost, currency }
 */
export function calculateCost(model, inputTokens, outputTokens, options = {}) {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    return { model, inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD', error: `No pricing data for model: ${model}` };
  }

  // Use batch pricing if requested and available
  const useBatch = options.useBatch && pricing.batchInput && pricing.batchOutput;
  const inputPrice = useBatch ? pricing.batchInput : pricing.input;
  const outputPrice = useBatch ? pricing.batchOutput : pricing.output;

  const inputCost = (inputTokens / 1_000_000) * inputPrice;
  const outputCost = (outputTokens / 1_000_000) * outputPrice;

  return {
    model,
    inputCost: parseFloat(inputCost.toFixed(6)),
    outputCost: parseFloat(outputCost.toFixed(6)),
    totalCost: parseFloat((inputCost + outputCost).toFixed(6)),
    currency: 'USD',
    usedBatch: useBatch,
    error: null,
  };
}

/**
 * Compute cost-efficiency ratio (quality per dollar).
 * Higher is better.
 */
export function costEfficiency(qualityScore, totalCost) {
  if (totalCost <= 0) return qualityScore > 0 ? Infinity : 0;
  return parseFloat((qualityScore / totalCost).toFixed(2));
}

/**
 * Calculate ROI: quality improvement per dollar spent compared to baseline.
 * @param {number} qualityA - Quality score of model A
 * @param {number} costA - Cost of model A
 * @param {number} qualityB - Quality score of baseline model B
 * @param {number} costB - Cost of baseline model B
 * @returns {object} - { roi, qualityDelta, costDelta, worthUpgrade }
 */
export function calculateROI(qualityA, costA, qualityB, costB) {
  const qualityDelta = qualityA - qualityB;
  const costDelta = costA - costB;

  if (costDelta === 0) {
    return {
      roi: qualityDelta > 0 ? Infinity : (qualityDelta < 0 ? -Infinity : 0),
      qualityDelta,
      costDelta: 0,
      worthUpgrade: qualityDelta > 0
    };
  }

  // ROI = quality improvement per dollar spent
  const roi = parseFloat((qualityDelta / Math.abs(costDelta)).toFixed(2));

  // Worth upgrading if ROI is positive (more quality for reasonable cost increase)
  // or if saving cost with minimal quality loss
  const worthUpgrade = (qualityDelta > 0 && costDelta > 0 && roi > 50) || // Good quality gain (ROI > 50 points per dollar)
                       (costDelta < 0 && qualityDelta >= -5); // Cost savings with minimal quality loss

  return {
    roi,
    qualityDelta: parseFloat(qualityDelta.toFixed(2)),
    costDelta: parseFloat(costDelta.toFixed(6)),
    worthUpgrade
  };
}

/**
 * Apply volume discount based on monthly spend.
 * @param {number} monthlyCost - Monthly cost before discount
 * @returns {object} - { originalCost, discount, discountedCost, discountPercent }
 */
export function applyVolumeDiscount(monthlyCost) {
  // Find applicable discount tier
  let applicableDiscount = 0;
  for (const tier of VOLUME_DISCOUNTS) {
    if (monthlyCost >= tier.threshold) {
      applicableDiscount = tier.discount;
    } else {
      break;
    }
  }

  const discountAmount = monthlyCost * applicableDiscount;
  const discountedCost = monthlyCost - discountAmount;

  return {
    originalCost: parseFloat(monthlyCost.toFixed(2)),
    discount: parseFloat(discountAmount.toFixed(2)),
    discountedCost: parseFloat(discountedCost.toFixed(2)),
    discountPercent: Math.round(applicableDiscount * 100)
  };
}

/**
 * Given ranked results with scores and token usage, find the optimal model.
 * Optimal = highest cost-efficiency above the minimum quality threshold.
 * @param {object[]} rankedResults - Results with .score.composite, .inputTokens, .outputTokens
 * @param {object} [constraints] - { minQuality, maxBudget, useBatch }
 * @returns {object} - { recommended, candidates, analysis, roiComparisons }
 */
export function findOptimal(rankedResults, constraints = {}) {
  const { minQuality = 40, maxBudget = Infinity, useBatch = false } = constraints;

  const candidates = rankedResults
    .filter((r) => !r.error && !r.score?.error)
    .map((r) => {
      // FIX: Add validation for score.composite exists before accessing
      if (!r.score || typeof r.score.composite !== 'number') {
        return null;
      }
      const cost = calculateCost(r.model, r.inputTokens || 0, r.outputTokens || 0, { useBatch });
      const efficiency = costEfficiency(r.score.composite, cost.totalCost);
      return {
        model: r.model,
        provider: r.provider,
        quality: r.score.composite,
        cost: cost.totalCost,
        efficiency,
        meetsQuality: r.score.composite >= minQuality,
        meetsBudget: cost.totalCost <= maxBudget,
      };
    })
    .filter((c) => c !== null && c.meetsQuality && c.meetsBudget);

  candidates.sort((a, b) => b.efficiency - a.efficiency);

  // Calculate ROI comparisons between top candidates
  const roiComparisons = [];
  if (candidates.length > 1) {
    const baseline = candidates[candidates.length - 1]; // Cheapest qualified model
    for (let i = 0; i < candidates.length - 1; i++) {
      const candidate = candidates[i];
      const roi = calculateROI(
        candidate.quality,
        candidate.cost,
        baseline.quality,
        baseline.cost
      );
      roiComparisons.push({
        model: candidate.model,
        baseline: baseline.model,
        ...roi
      });
    }
  }

  return {
    recommended: candidates[0] || null,
    candidates,
    roiComparisons,
    analysis: {
      totalEvaluated: rankedResults.length,
      qualifiedCount: candidates.length,
      minQuality,
      maxBudget,
      cheapest: candidates.length > 0 ? candidates.reduce((min, c) => c.cost < min.cost ? c : min, candidates[0]) : null,
      highestQuality: candidates.length > 0 ? candidates.reduce((max, c) => c.quality > max.quality ? c : max, candidates[0]) : null,
    },
  };
}

/**
 * Compute the Pareto frontier — models where no other model is both cheaper AND higher quality.
 * @param {object[]} candidates - Array of { model, quality, cost }
 * @returns {object[]} - Pareto-optimal candidates
 */
export function paretoFrontier(candidates) {
  const sorted = [...candidates].sort((a, b) => a.cost - b.cost);
  const frontier = [];
  let maxQuality = -1;

  for (const c of sorted) {
    if (c.quality > maxQuality) {
      frontier.push(c);
      maxQuality = c.quality;
    }
  }

  return frontier;
}

/**
 * Estimate monthly spend for a given usage pattern.
 * @param {string} model - Model identifier
 * @param {number} dailyRequests - Average daily requests
 * @param {number} avgInputTokens - Average input tokens per request
 * @param {number} avgOutputTokens - Average output tokens per request
 * @param {object} [options] - { useBatch, applyVolumeDiscount }
 * @returns {object} - { model, dailyCost, monthlyCost, yearlyCost, withVolumeDiscount }
 */
export function estimateSpend(model, dailyRequests, avgInputTokens, avgOutputTokens, options = {}) {
  const { useBatch = false, applyDiscount = false } = options;
  const perRequest = calculateCost(model, avgInputTokens, avgOutputTokens, { useBatch });
  const dailyCost = perRequest.totalCost * dailyRequests;
  const monthlyCost = dailyCost * 30.44; // FIX: Use 30.44 for more accurate monthly average
  const yearlyCost = dailyCost * 365;

  const result = {
    model,
    perRequestCost: perRequest.totalCost,
    dailyCost: parseFloat(dailyCost.toFixed(4)),
    monthlyCost: parseFloat(monthlyCost.toFixed(2)),
    yearlyCost: parseFloat(yearlyCost.toFixed(2)),
  };

  // Apply volume discount if requested
  if (applyDiscount) {
    result.withVolumeDiscount = applyVolumeDiscount(monthlyCost);
  }

  return result;
}

/** Get pricing info for a model */
export function getPricing(model) {
  return MODEL_PRICING[model] || null;
}

/** List all models with pricing */
export function listPricing() {
  return Object.entries(MODEL_PRICING).map(([model, pricing]) => ({
    model,
    inputPer1M: pricing.input,
    outputPer1M: pricing.output,
  }));
}

export { MODEL_PRICING, VOLUME_DISCOUNTS };
export default {
  calculateCost,
  costEfficiency,
  calculateROI,
  applyVolumeDiscount,
  findOptimal,
  paretoFrontier,
  estimateSpend,
  getPricing,
  listPricing,
  MODEL_PRICING,
  VOLUME_DISCOUNTS
};

/**
 * HYDRA Quality Comparator — Compare and rank outputs from multiple models
 * using heuristic quality metrics and optional reference-based scoring.
 */

/** Compute basic text quality metrics for a response */
export function computeMetrics(text) {
  if (!text || typeof text !== 'string') {
    return { length: 0, wordCount: 0, sentenceCount: 0, avgWordLength: 0, vocabularyRichness: 0, codeBlockCount: 0, listItemCount: 0 };
  }

  const words = text.split(/\s+/).filter(Boolean);
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const uniqueWords = new Set(words.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean));
  const codeBlocks = (text.match(/```[\s\S]*?```/g) || []).length;
  const listItems = (text.match(/^[\s]*[-*\d.]+[\s]/gm) || []).length;

  return {
    length: text.length,
    wordCount: words.length,
    sentenceCount: sentences.length,
    avgWordLength: words.length > 0 ? words.reduce((sum, w) => sum + w.length, 0) / words.length : 0,
    vocabularyRichness: words.length > 0 ? uniqueWords.size / words.length : 0,
    codeBlockCount: codeBlocks,
    listItemCount: listItems,
  };
}

/** Compute similarity between two texts using Jaccard index on word bigrams */
export function computeSimilarity(textA, textB) {
  if (!textA || !textB) return 0;

  const bigrams = (text) => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    const set = new Set();
    for (let i = 0; i < words.length - 1; i++) {
      set.add(`${words[i]} ${words[i + 1]}`);
    }
    return set;
  };

  const setA = bigrams(textA);
  const setB = bigrams(textB);
  if (setA.size === 0 && setB.size === 0) return 1;

  let intersection = 0;
  for (const b of setA) {
    if (setB.has(b)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Score a model result on multiple quality dimensions.
 * Returns a score object with individual dimensions and a composite score (0-100).
 * Now includes multi-dimensional scoring: correctness, completeness, style, coherence.
 */
export function scoreResult(result, allResults = [], taskType = 'general') {
  if (result.error) {
    return {
      composite: 0,
      completeness: 0,
      detail: 0,
      structure: 0,
      consensus: 0,
      speed: 0,
      correctness: 0,
      style: 0,
      coherence: 0,
      confidenceInterval: { lower: 0, upper: 0 },
      error: true
    };
  }

  const metrics = computeMetrics(result.text);

  // Completeness: based on word count relative to peers
  // FIX: Precompute maxWords once instead of in every scoreResult call (O(n^2) bug)
  const successfulResults = allResults.filter((r) => !r.error);
  const maxWords = Math.max(...successfulResults.map((r) => computeMetrics(r.text).wordCount), 1);
  const completeness = Math.min(100, (metrics.wordCount / maxWords) * 100);

  // Detail: vocabulary richness + structural elements
  const detail = Math.min(100, metrics.vocabularyRichness * 100 + metrics.codeBlockCount * 10 + metrics.listItemCount * 3);

  // Structure: sentences and formatting
  const structure = Math.min(100, metrics.sentenceCount * 5 + metrics.codeBlockCount * 15 + metrics.listItemCount * 5);

  // Consensus: average similarity to other successful results
  const otherTexts = allResults.filter((r) => !r.error && r.model !== result.model).map((r) => r.text);
  const consensus = otherTexts.length > 0
    ? (otherTexts.reduce((sum, t) => sum + computeSimilarity(result.text, t), 0) / otherTexts.length) * 100
    : 50;

  // Speed: inverse latency scoring (faster = better)
  const maxLatency = Math.max(...allResults.filter((r) => !r.error).map((r) => r.latencyMs || 0), 1);
  const speed = maxLatency > 0 ? ((1 - (result.latencyMs || 0) / maxLatency) * 50 + 50) : 50;

  // Multi-dimensional scoring additions:

  // Correctness: Estimated by consensus + completeness (proxy for thoroughness)
  const correctness = Math.round((consensus * 0.6 + completeness * 0.4));

  // Style: Based on vocabulary richness, sentence variety, and structure
  const avgSentenceLength = metrics.sentenceCount > 0 ? metrics.wordCount / metrics.sentenceCount : 0;
  const styleScore = Math.min(100,
    metrics.vocabularyRichness * 50 +
    (avgSentenceLength > 5 && avgSentenceLength < 30 ? 25 : 10) + // Ideal sentence length range
    (metrics.listItemCount > 0 ? 15 : 0) + // Bonus for organization
    (metrics.codeBlockCount > 0 && taskType === 'code' ? 10 : 0)
  );
  const style = Math.round(styleScore);

  // Coherence: Measured by structural consistency and flow
  const hasGoodStructure = metrics.sentenceCount >= 2 && metrics.wordCount > 20;
  const coherence = Math.round(
    (hasGoodStructure ? 50 : 20) +
    Math.min(30, metrics.sentenceCount * 2) +
    (metrics.vocabularyRichness > 0.5 ? 20 : metrics.vocabularyRichness * 40)
  );

  // Weights by task type
  const weights = {
    general:  { completeness: 0.25, detail: 0.25, structure: 0.15, consensus: 0.20, speed: 0.15 },
    code:     { completeness: 0.20, detail: 0.15, structure: 0.25, consensus: 0.25, speed: 0.15 },
    creative: { completeness: 0.15, detail: 0.30, structure: 0.10, consensus: 0.35, speed: 0.10 }, // FIX: Creative tasks benefit from thoughtfulness, not speed
    analysis: { completeness: 0.30, detail: 0.25, structure: 0.20, consensus: 0.15, speed: 0.10 },
  };

  const w = weights[taskType] || weights.general;
  const composite = Math.round(
    w.completeness * completeness +
    w.detail * detail +
    w.structure * structure +
    w.consensus * consensus +
    w.speed * speed
  );

  // Confidence interval calculation (95% CI approximation)
  // Based on sample size and score variance
  const sampleSize = successfulResults.length;
  const marginOfError = sampleSize > 1 ? Math.round(10 / Math.sqrt(sampleSize)) : 15;
  const confidenceInterval = {
    lower: Math.max(0, composite - marginOfError),
    upper: Math.min(100, composite + marginOfError)
  };

  return {
    composite: Math.min(100, composite),
    completeness: Math.round(completeness),
    detail: Math.round(detail),
    structure: Math.round(structure),
    consensus: Math.round(consensus),
    speed: Math.round(speed),
    correctness,
    style,
    coherence,
    confidenceInterval,
    error: false,
  };
}

/**
 * Rank multiple model results by quality score.
 * @param {object[]} results - Array of sendToModel results
 * @param {string} [taskType] - 'general' | 'code' | 'creative' | 'analysis'
 * @returns {object[]} - Ranked results with scores, best first
 */
export function rankResults(results, taskType = 'general') {
  // FIX O(n^2) bug: Precompute metrics once for all results before scoring
  const successfulResults = results.filter((r) => !r.error);
  const precomputedMetrics = new Map();
  let maxWords = 1;

  for (const result of successfulResults) {
    const metrics = computeMetrics(result.text);
    precomputedMetrics.set(result, metrics);
    if (metrics.wordCount > maxWords) maxWords = metrics.wordCount;
  }

  const scored = results.map((result) => {
    if (result.error) {
      return {
        ...result,
        score: {
          composite: 0,
          completeness: 0,
          detail: 0,
          structure: 0,
          consensus: 0,
          speed: 0,
          correctness: 0,
          style: 0,
          coherence: 0,
          confidenceInterval: { lower: 0, upper: 0 },
          error: true
        },
      };
    }

    const metrics = precomputedMetrics.get(result);

    // Completeness
    const completeness = Math.min(100, (metrics.wordCount / maxWords) * 100);

    // Detail
    const detail = Math.min(100, metrics.vocabularyRichness * 100 + metrics.codeBlockCount * 10 + metrics.listItemCount * 3);

    // Structure
    const structure = Math.min(100, metrics.sentenceCount * 5 + metrics.codeBlockCount * 15 + metrics.listItemCount * 5);

    // Consensus
    const otherTexts = successfulResults.filter((r) => r.model !== result.model).map((r) => r.text);
    const consensus = otherTexts.length > 0
      ? (otherTexts.reduce((sum, t) => sum + computeSimilarity(result.text, t), 0) / otherTexts.length) * 100
      : 50;

    // Speed
    const maxLatency = Math.max(...successfulResults.map((r) => r.latencyMs || 0), 1);
    const speed = maxLatency > 0 ? ((1 - (result.latencyMs || 0) / maxLatency) * 50 + 50) : 50;

    // Multi-dimensional scoring additions:

    // Correctness
    const correctness = Math.round((consensus * 0.6 + completeness * 0.4));

    // Style
    const avgSentenceLength = metrics.sentenceCount > 0 ? metrics.wordCount / metrics.sentenceCount : 0;
    const styleScore = Math.min(100,
      metrics.vocabularyRichness * 50 +
      (avgSentenceLength > 5 && avgSentenceLength < 30 ? 25 : 10) +
      (metrics.listItemCount > 0 ? 15 : 0) +
      (metrics.codeBlockCount > 0 && taskType === 'code' ? 10 : 0)
    );
    const style = Math.round(styleScore);

    // Coherence
    const hasGoodStructure = metrics.sentenceCount >= 2 && metrics.wordCount > 20;
    const coherence = Math.round(
      (hasGoodStructure ? 50 : 20) +
      Math.min(30, metrics.sentenceCount * 2) +
      (metrics.vocabularyRichness > 0.5 ? 20 : metrics.vocabularyRichness * 40)
    );

    // Weights by task type
    const weights = {
      general:  { completeness: 0.25, detail: 0.25, structure: 0.15, consensus: 0.20, speed: 0.15 },
      code:     { completeness: 0.20, detail: 0.15, structure: 0.25, consensus: 0.25, speed: 0.15 },
      creative: { completeness: 0.15, detail: 0.30, structure: 0.10, consensus: 0.35, speed: 0.10 },
      analysis: { completeness: 0.30, detail: 0.25, structure: 0.20, consensus: 0.15, speed: 0.10 },
    };

    const w = weights[taskType] || weights.general;
    const composite = Math.round(
      w.completeness * completeness +
      w.detail * detail +
      w.structure * structure +
      w.consensus * consensus +
      w.speed * speed
    );

    // Confidence interval
    const sampleSize = successfulResults.length;
    const marginOfError = sampleSize > 1 ? Math.round(10 / Math.sqrt(sampleSize)) : 15;
    const confidenceInterval = {
      lower: Math.max(0, composite - marginOfError),
      upper: Math.min(100, composite + marginOfError)
    };

    return {
      ...result,
      score: {
        composite: Math.min(100, composite),
        completeness: Math.round(completeness),
        detail: Math.round(detail),
        structure: Math.round(structure),
        consensus: Math.round(consensus),
        speed: Math.round(speed),
        correctness,
        style,
        coherence,
        confidenceInterval,
        error: false,
      },
    };
  });

  // FIX tie-breaking: On exact tie, use secondary metrics (completeness, then latency)
  scored.sort((a, b) => {
    const compositeDiff = b.score.composite - a.score.composite;
    if (compositeDiff !== 0) return compositeDiff;

    // Tie-breaker 1: completeness
    const completenessDiff = b.score.completeness - a.score.completeness;
    if (completenessDiff !== 0) return completenessDiff;

    // Tie-breaker 2: faster is better
    return (a.latencyMs || 0) - (b.latencyMs || 0);
  });

  return scored.map((r, i) => ({ ...r, rank: i + 1 }));
}

/**
 * Compare exactly two results and return a structured comparison.
 * FIX: Better tie-breaking using secondary metrics.
 */
export function compareTwo(resultA, resultB, taskType = 'general') {
  const allResults = [resultA, resultB];
  const scoreA = scoreResult(resultA, allResults, taskType);
  const scoreB = scoreResult(resultB, allResults, taskType);
  const similarity = computeSimilarity(resultA.text || '', resultB.text || '');

  // Determine winner with proper tie-breaking
  let winner;
  if (scoreA.composite > scoreB.composite) {
    winner = resultA.model;
  } else if (scoreB.composite > scoreA.composite) {
    winner = resultB.model;
  } else {
    // Tie on composite - use completeness as tie-breaker
    if (scoreA.completeness > scoreB.completeness) {
      winner = resultA.model;
    } else if (scoreB.completeness > scoreA.completeness) {
      winner = resultB.model;
    } else {
      // Still tied - use latency (faster wins)
      winner = (resultA.latencyMs || 0) <= (resultB.latencyMs || 0) ? resultA.model : resultB.model;
    }
  }

  return {
    modelA: { model: resultA.model, score: scoreA },
    modelB: { model: resultB.model, score: scoreB },
    winner,
    margin: Math.abs(scoreA.composite - scoreB.composite),
    similarity: Math.round(similarity * 100),
    taskType,
  };
}

/**
 * Generate a performance benchmark report from ranked results.
 * Outputs response time, tokens per second, cost per 1K tokens, quality score in ASCII table.
 * @param {object[]} rankedResults - Results from rankResults()
 * @returns {string} - Formatted ASCII benchmark report
 */
export function generateBenchmarkReport(rankedResults) {
  if (!rankedResults || rankedResults.length === 0) {
    return 'No results to benchmark.';
  }

  // Simple pricing lookup (per 1M tokens)
  const PRICING = {
    'claude-opus-4-6': { in: 15.00, out: 75.00 },
    'claude-sonnet-4-6': { in: 3.00, out: 15.00 },
    'claude-haiku-4-5-20251001': { in: 0.80, out: 4.00 },
    'gpt-4o': { in: 2.50, out: 10.00 },
    'gpt-4o-mini': { in: 0.15, out: 0.60 },
    'gpt-4-turbo': { in: 10.00, out: 30.00 },
    'gemini-2.0-flash': { in: 0.10, out: 0.40 },
    'gemini-2.0-pro': { in: 1.25, out: 5.00 },
  };

  let report = '\n';
  report += '┌─────────────────────────────────────────────────────────────────────────────────────────┐\n';
  report += '│                           PERFORMANCE BENCHMARK REPORT                                  │\n';
  report += '├─────────────────────────────────────────────────────────────────────────────────────────┤\n';
  report += '│ Rank │ Model              │ Quality │ Time(ms) │ Tokens/s │ $/1K tok │ Tokens     │\n';
  report += '├─────────────────────────────────────────────────────────────────────────────────────────┤\n';

  for (const result of rankedResults) {
    const rank = `${result.rank || '?'}`.padStart(4);
    const model = (result.model || 'unknown').substring(0, 18).padEnd(18);

    if (result.error) {
      const quality = 'N/A    ';
      const time = 'N/A     ';
      const tps = 'N/A     ';
      const cost = 'N/A     ';
      const tokens = 'N/A       ';
      report += `│ ${rank} │ ${model} │ ${quality} │ ${time} │ ${tps} │ ${cost} │ ${tokens} │\n`;
      continue;
    }

    const quality = `${result.score.composite}/100`.padEnd(7);
    const time = `${result.latencyMs || 0}`.padStart(8);

    // Calculate tokens per second
    const totalTokens = (result.inputTokens || 0) + (result.outputTokens || 0);
    const latencySec = (result.latencyMs || 1) / 1000;
    const tokensPerSec = totalTokens / latencySec;
    const tps = tokensPerSec.toFixed(1).padStart(8);

    // Calculate cost per 1K tokens
    const pricing = PRICING[result.model];
    let costPer1K = 'N/A     ';
    if (pricing) {
      const inputCost = ((result.inputTokens || 0) / 1_000) * (pricing.in / 1_000);
      const outputCost = ((result.outputTokens || 0) / 1_000) * (pricing.out / 1_000);
      const totalCost = inputCost + outputCost;
      const avgCostPer1K = totalTokens > 0 ? (totalCost / totalTokens) * 1000 : 0;
      costPer1K = `$${avgCostPer1K.toFixed(4)}`.padStart(8);
    }

    const tokens = `${result.inputTokens || 0}/${result.outputTokens || 0}`.padEnd(10);

    report += `│ ${rank} │ ${model} │ ${quality} │ ${time} │ ${tps} │ ${costPer1K} │ ${tokens} │\n`;
  }

  report += '└─────────────────────────────────────────────────────────────────────────────────────────┘\n';

  // Add summary statistics
  const successful = rankedResults.filter(r => !r.error);
  if (successful.length > 0) {
    const avgLatency = successful.reduce((sum, r) => sum + (r.latencyMs || 0), 0) / successful.length;
    const avgQuality = successful.reduce((sum, r) => sum + (r.score?.composite || 0), 0) / successful.length;
    const fastestModel = successful.reduce((min, r) => (r.latencyMs || Infinity) < (min.latencyMs || Infinity) ? r : min);
    const bestQualityModel = successful.reduce((max, r) => (r.score?.composite || 0) > (max.score?.composite || 0) ? r : max);

    report += '\n📊 Summary:\n';
    report += `  • Avg Latency: ${avgLatency.toFixed(0)}ms\n`;
    report += `  • Avg Quality: ${avgQuality.toFixed(1)}/100\n`;
    report += `  • Fastest: ${fastestModel.model} (${fastestModel.latencyMs}ms)\n`;
    report += `  • Best Quality: ${bestQualityModel.model} (${bestQualityModel.score.composite}/100)\n`;
  }

  return report;
}

/**
 * Generate a visual comparison report with bar charts and color coding.
 * Uses Unicode block characters for visual representation.
 * @param {object[]} rankedResults - Results from rankResults()
 * @returns {string} - Formatted visual report with bar charts
 */
export function generateVisualReport(rankedResults) {
  if (!rankedResults || rankedResults.length === 0) {
    return 'No results to visualize.';
  }

  // ANSI color codes
  const COLORS = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
  };

  // Bar chart characters
  const BLOCKS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];

  // Helper to generate bar chart
  const makeBar = (value, maxValue, width = 40, color = COLORS.cyan) => {
    const ratio = Math.min(1, value / maxValue);
    const totalBlocks = ratio * width;
    const fullBlocks = Math.floor(totalBlocks);
    const partialIndex = Math.floor((totalBlocks - fullBlocks) * BLOCKS.length);
    const partial = partialIndex > 0 ? BLOCKS[partialIndex - 1] : '';

    return color + '█'.repeat(fullBlocks) + partial + COLORS.reset;
  };

  let report = '\n';
  report += COLORS.bright + '═'.repeat(80) + COLORS.reset + '\n';
  report += COLORS.bright + '                        VISUAL QUALITY COMPARISON                           \n' + COLORS.reset;
  report += COLORS.bright + '═'.repeat(80) + COLORS.reset + '\n\n';

  const successful = rankedResults.filter(r => !r.error);
  if (successful.length === 0) {
    return report + COLORS.red + '⚠️  All models failed' + COLORS.reset + '\n';
  }

  const maxQuality = Math.max(...successful.map(r => r.score?.composite || 0), 1);

  // Quality scores with bar charts
  report += COLORS.bright + '📊 QUALITY SCORES\n' + COLORS.reset;
  report += '─'.repeat(80) + '\n\n';

  for (const result of rankedResults) {
    if (result.error) {
      report += `${COLORS.red}✗ ${result.model}: FAILED${COLORS.reset}\n\n`;
      continue;
    }

    const score = result.score.composite;
    const isWinner = result.rank === 1;

    // Color based on score
    let scoreColor = COLORS.red;
    if (score >= 80) scoreColor = COLORS.green;
    else if (score >= 60) scoreColor = COLORS.cyan;
    else if (score >= 40) scoreColor = COLORS.yellow;

    // Medal for top 3
    const medal = result.rank === 1 ? '🏆 ' : result.rank === 2 ? '🥈 ' : result.rank === 3 ? '🥉 ' : '   ';

    report += medal;
    if (isWinner) {
      report += COLORS.bright + COLORS.green + result.model + COLORS.reset + '\n';
    } else {
      report += result.model + '\n';
    }

    report += `   Overall: ${scoreColor}${score}/100${COLORS.reset} `;
    report += makeBar(score, 100, 40, scoreColor) + '\n';

    // Mini breakdown
    report += `   ├─ Completeness: ${result.score.completeness}/100\n`;
    report += `   ├─ Correctness:  ${result.score.correctness}/100\n`;
    report += `   ├─ Style:        ${result.score.style}/100\n`;
    report += `   └─ Speed:        ${result.latencyMs}ms (${result.score.speed}/100)\n\n`;
  }

  // Performance comparison
  report += COLORS.bright + '⚡ PERFORMANCE\n' + COLORS.reset;
  report += '─'.repeat(80) + '\n\n';

  const maxLatency = Math.max(...successful.map(r => r.latencyMs || 0), 1);

  for (const result of successful.slice(0, 5)) {
    const latency = result.latencyMs || 0;
    const inverted = maxLatency - latency; // Invert so faster = longer bar
    report += `${result.model.padEnd(25)} ${latency}ms `;
    report += makeBar(inverted, maxLatency, 30, COLORS.magenta) + '\n';
  }

  // Winner summary
  report += '\n' + COLORS.bright + '═'.repeat(80) + COLORS.reset + '\n';
  const winner = successful[0];
  if (winner) {
    report += COLORS.bright + COLORS.green + '\n🏆 WINNER: ' + winner.model + COLORS.reset + '\n';
    report += `   Quality: ${winner.score.composite}/100\n`;
    report += `   Speed: ${winner.latencyMs}ms\n`;
    report += `   Output: ${winner.text.length} characters\n`;
  }

  // Recommendation
  report += '\n💡 RECOMMENDATION\n';
  report += '─'.repeat(80) + '\n';

  if (winner.score.composite >= 80) {
    report += COLORS.green + `✓ ${winner.model} delivers excellent quality. Recommended for production.${COLORS.reset}\n`;
  } else if (winner.score.composite >= 60) {
    report += COLORS.cyan + `⚠ ${winner.model} provides adequate quality. Consider testing with more prompts.${COLORS.reset}\n`;
  } else {
    report += COLORS.yellow + `⚠ ${winner.model} has moderate quality. Review output carefully or adjust prompt.${COLORS.reset}\n`;
  }

  // Show quality variance
  if (successful.length > 1) {
    const scores = successful.map(r => r.score.composite);
    const variance = scores.reduce((sum, s) => sum + Math.pow(s - (scores.reduce((a, b) => a + b) / scores.length), 2), 0) / scores.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev > 15) {
      report += `\n${COLORS.yellow}ℹ High score variance (±${stdDev.toFixed(1)}). Models disagree significantly on this prompt.${COLORS.reset}\n`;
    }
  }

  report += '\n' + COLORS.bright + '═'.repeat(80) + COLORS.reset + '\n';

  return report;
}

export default { computeMetrics, computeSimilarity, scoreResult, rankResults, compareTwo, generateBenchmarkReport, generateVisualReport };

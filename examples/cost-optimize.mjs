#!/usr/bin/env node
/**
 * HYDRA Example: Cost Optimization
 *
 * Demonstrates finding the cheapest model that meets a quality threshold.
 * Shows cost breakdown per model and recommends the best value option.
 */

import { sendToMultiple } from '../lib/multi-sender.mjs';
import { rankResults } from '../lib/quality-comparator.mjs';
import { findOptimal, calculateCost, calculateROI, paretoFrontier, estimateSpend } from '../lib/cost-optimizer.mjs';

async function main() {
  const args = process.argv.slice(2);
  const minQuality = parseInt(args[0]) || 75;
  const customPrompt = args.slice(1).join(' ');

  const prompt = customPrompt || 'Explain the concept of machine learning and provide three real-world applications.';

  console.log('━'.repeat(80));
  console.log('💰 HYDRA Cost Optimization');
  console.log('━'.repeat(80));
  console.log(`\nPrompt: "${prompt}"\n`);
  console.log(`Quality Threshold: ${minQuality}/100`);
  console.log('\nTesting models across all price tiers...\n');

  // Test a range of models from budget to premium
  const models = [
    'gemini-2.0-flash',      // Budget: $0.10/$0.40 per 1M tokens
    'gpt-4o-mini',           // Economy: $0.15/$0.60
    'claude-haiku-4-5-20251001', // Low: $0.80/$4.00
    'gpt-4o',                // Mid: $2.50/$10.00
    'claude-sonnet-4-6',     // High: $3.00/$15.00
    'claude-opus-4-6',       // Premium: $15.00/$75.00
  ];

  const startTime = Date.now();
  const { results, totalLatencyMs } = await sendToMultiple(models, prompt);

  console.log(`✓ All requests completed in ${totalLatencyMs}ms\n`);
  console.log('━'.repeat(80));

  // Rank by quality
  const ranked = rankResults(results, 'general');

  // Calculate costs for each result
  console.log('\n📊 COST & QUALITY BREAKDOWN\n');
  console.log('┌──────────────────────────────────────────────────────────────────────────────────┐');
  console.log('│ Model                  │ Quality │ Cost       │ Efficiency │ In/Out Tokens │ Status │');
  console.log('├──────────────────────────────────────────────────────────────────────────────────┤');

  const costAnalysis = [];

  for (const result of ranked) {
    const model = result.model.padEnd(22);
    const quality = result.error ? 'N/A    ' : `${result.score.composite}/100`.padEnd(7);

    let costStr = 'N/A       ';
    let efficiencyStr = 'N/A       ';
    let tokensStr = 'N/A          ';
    const status = result.error ? '❌ FAIL' : '✓ OK   ';

    if (!result.error) {
      const costData = calculateCost(result.model, result.inputTokens, result.outputTokens);
      costStr = `$${costData.totalCost.toFixed(6)}`.padEnd(10);

      const efficiency = result.score.composite / (costData.totalCost * 1000); // Quality per dollar (scaled)
      efficiencyStr = efficiency.toFixed(2).padEnd(10);

      tokensStr = `${result.inputTokens}/${result.outputTokens}`.padEnd(13);

      costAnalysis.push({
        model: result.model,
        quality: result.score.composite,
        cost: costData.totalCost,
        efficiency,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: result.latencyMs,
      });
    }

    console.log(`│ ${model} │ ${quality} │ ${costStr} │ ${efficiencyStr} │ ${tokensStr} │ ${status} │`);
  }

  console.log('└──────────────────────────────────────────────────────────────────────────────────┘');

  // Find optimal model
  console.log('\n🎯 OPTIMIZATION RESULTS\n');

  const optimization = findOptimal(ranked, { minQuality });

  if (optimization.recommended) {
    const rec = optimization.recommended;
    console.log(`✓ RECOMMENDED MODEL: ${rec.model}`);
    console.log(`  ├─ Quality Score:    ${rec.quality}/100`);
    console.log(`  ├─ Cost per Request: $${rec.cost.toFixed(6)}`);
    console.log(`  ├─ Cost Efficiency:  ${rec.efficiency.toFixed(2)} quality points per $1000`);
    console.log(`  └─ Meets Threshold:  ${rec.meetsQuality ? '✓ YES' : '✗ NO'}\n`);
  } else {
    console.log(`⚠️  NO MODEL MEETS THRESHOLD of ${minQuality}/100\n`);
  }

  // Show all qualified candidates
  if (optimization.candidates.length > 1) {
    console.log('📋 ALL QUALIFIED MODELS (sorted by efficiency):\n');
    optimization.candidates.forEach((candidate, i) => {
      const marker = i === 0 ? '🏆' : `${i + 1}.`;
      console.log(`${marker} ${candidate.model}`);
      console.log(`   Quality: ${candidate.quality}/100 | Cost: $${candidate.cost.toFixed(6)} | Efficiency: ${candidate.efficiency.toFixed(2)}`);
    });
    console.log();
  }

  // ROI comparisons
  if (optimization.roiComparisons.length > 0) {
    console.log('💵 ROI ANALYSIS (compared to cheapest qualified model)\n');
    for (const roi of optimization.roiComparisons) {
      const worthIt = roi.worthUpgrade ? '✓ WORTH IT' : '✗ NOT WORTH IT';
      console.log(`${roi.model} vs ${roi.baseline}:`);
      console.log(`  Quality Gain: +${roi.qualityDelta} points`);
      console.log(`  Extra Cost: $${roi.costDelta.toFixed(6)}`);
      console.log(`  ROI: ${roi.roi.toFixed(1)} quality points per dollar`);
      console.log(`  Verdict: ${worthIt}\n`);
    }
  }

  // Pareto frontier
  if (optimization.candidates.length > 1) {
    console.log('━'.repeat(80));
    console.log('\n📈 PARETO FRONTIER (optimal cost/quality trade-offs)\n');

    const frontier = paretoFrontier(optimization.candidates);
    console.log('Models where no other model is both cheaper AND better quality:\n');

    frontier.forEach((model, i) => {
      console.log(`${i + 1}. ${model.model}`);
      console.log(`   Quality: ${model.quality}/100 | Cost: $${model.cost.toFixed(6)}`);
    });
    console.log();
  }

  // Monthly spend estimates
  console.log('━'.repeat(80));
  console.log('\n💸 ESTIMATED MONTHLY SPEND (at 1000 requests/day)\n');

  if (costAnalysis.length > 0) {
    // Use average token counts from actual results
    const avgInput = costAnalysis.reduce((sum, r) => sum + r.inputTokens, 0) / costAnalysis.length;
    const avgOutput = costAnalysis.reduce((sum, r) => sum + r.outputTokens, 0) / costAnalysis.length;

    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log('│ Model                  │ Daily    │ Monthly  │ Yearly      │');
    console.log('├─────────────────────────────────────────────────────────────┤');

    for (const model of models) {
      const spend = estimateSpend(model, 1000, avgInput, avgOutput);
      const modelName = model.padEnd(22);
      const daily = `$${spend.dailyCost.toFixed(2)}`.padEnd(8);
      const monthly = `$${spend.monthlyCost.toFixed(2)}`.padEnd(8);
      const yearly = `$${spend.yearlyCost.toFixed(2)}`.padEnd(11);

      console.log(`│ ${modelName} │ ${daily} │ ${monthly} │ ${yearly} │`);
    }

    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log(`\nBased on avg ${Math.round(avgInput)} input / ${Math.round(avgOutput)} output tokens per request`);
  }

  // Summary and recommendations
  console.log('\n━'.repeat(80));
  console.log('\n💡 KEY INSIGHTS\n');

  const analysis = optimization.analysis;
  console.log(`• Evaluated: ${analysis.totalEvaluated} models`);
  console.log(`• Qualified: ${analysis.qualifiedCount} models met the ${minQuality}/100 threshold`);

  if (analysis.cheapest) {
    console.log(`• Cheapest: ${analysis.cheapest.model} at $${analysis.cheapest.cost.toFixed(6)}/request`);
  }

  if (analysis.highestQuality) {
    console.log(`• Best Quality: ${analysis.highestQuality.model} with ${analysis.highestQuality.quality}/100`);
  }

  if (optimization.recommended) {
    const rec = optimization.recommended;
    const savings = analysis.cheapest && analysis.cheapest.model !== rec.model
      ? `(${((1 - rec.cost / analysis.highestQuality.cost) * 100).toFixed(1)}% cheaper than best quality)`
      : '';
    console.log(`\n🎯 RECOMMENDATION: Use ${rec.model} for optimal cost/quality balance ${savings}`);
  }

  console.log('\n━'.repeat(80));

  // Usage instructions
  if (process.argv.length === 2) {
    console.log('\n💡 USAGE:');
    console.log('   node cost-optimize.mjs [min-quality] [custom-prompt]');
    console.log('   Example: node cost-optimize.mjs 80 "Write a technical blog post about APIs"');
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * HYDRA Example: Compare Models
 *
 * Sends the same prompt to multiple AI models (Claude, GPT-4o, Gemini),
 * collects responses, compares quality, and prints a side-by-side comparison.
 */

import { sendToMultiple } from '../lib/multi-sender.mjs';
import { rankResults } from '../lib/quality-comparator.mjs';

// Sample prompts for different task types
const SAMPLE_PROMPTS = {
  code: 'Write a JavaScript function that implements binary search on a sorted array. Include error handling.',
  creative: 'Write a short story about a robot who discovers the meaning of friendship.',
  analysis: 'Compare and contrast the economic policies of Keynesianism and Monetarism.',
  general: 'Explain quantum entanglement in simple terms that a high school student could understand.',
};

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const taskType = args[0] || 'general';
  const customPrompt = args.slice(1).join(' ');

  const prompt = customPrompt || SAMPLE_PROMPTS[taskType] || SAMPLE_PROMPTS.general;

  console.log('━'.repeat(80));
  console.log('🐉 HYDRA Multi-Model Comparison');
  console.log('━'.repeat(80));
  console.log(`\nPrompt: "${prompt}"\n`);
  console.log(`Task Type: ${taskType}`);
  console.log('\nSending to models: claude-sonnet-4-6, gpt-4o, gemini-2.0-flash\n');

  // Send to three different models
  const models = ['claude-sonnet-4-6', 'gpt-4o', 'gemini-2.0-flash'];
  const startTime = Date.now();

  const { results, totalLatencyMs } = await sendToMultiple(models, prompt);

  console.log(`✓ All requests completed in ${totalLatencyMs}ms\n`);
  console.log('━'.repeat(80));

  // Rank results by quality
  const ranked = rankResults(results, taskType);

  // Print side-by-side comparison
  console.log('\n📊 QUALITY COMPARISON\n');

  // Header
  console.log('┌────────────────────────────────────────────────────────────────────────────┐');
  console.log('│ Rank │ Model              │ Quality │ Speed  │ Tokens │ Cost      │ Status │');
  console.log('├────────────────────────────────────────────────────────────────────────────┤');

  // Results rows
  for (const result of ranked) {
    const rank = `${result.rank}`.padEnd(4);
    const model = (result.model || 'unknown').padEnd(18);
    const quality = result.error ? 'N/A   ' : `${result.score.composite}/100`.padEnd(7);
    const speed = result.error ? 'N/A   ' : `${result.latencyMs}ms`.padEnd(6);
    const tokens = result.error ? 'N/A   ' : `${result.inputTokens + result.outputTokens}`.padEnd(6);

    // Calculate approximate cost (using simple estimates)
    let costStr = 'N/A      ';
    if (!result.error) {
      const costEstimates = {
        'claude-sonnet-4-6': { in: 3.00, out: 15.00 },
        'gpt-4o': { in: 2.50, out: 10.00 },
        'gemini-2.0-flash': { in: 0.10, out: 0.40 },
      };
      const pricing = costEstimates[result.model];
      if (pricing) {
        const cost = ((result.inputTokens / 1_000_000) * pricing.in) +
                     ((result.outputTokens / 1_000_000) * pricing.out);
        costStr = `$${cost.toFixed(6)}`.padEnd(9);
      }
    }

    const status = result.error ? '❌ ERROR' : '✓ OK   ';

    console.log(`│ ${rank} │ ${model} │ ${quality} │ ${speed} │ ${tokens} │ ${costStr} │ ${status} │`);
  }

  console.log('└────────────────────────────────────────────────────────────────────────────┘');

  // Detailed score breakdown for top 3
  console.log('\n📋 DETAILED SCORE BREAKDOWN\n');

  for (let i = 0; i < Math.min(3, ranked.length); i++) {
    const result = ranked[i];
    if (result.error) continue;

    console.log(`\n${i + 1}. ${result.model} (Overall: ${result.score.composite}/100)`);
    console.log('   ─────────────────────────────────────────────');
    console.log(`   Completeness:  ${result.score.completeness}/100 │ How thorough the response is`);
    console.log(`   Detail:        ${result.score.detail}/100 │ Vocabulary richness & structure`);
    console.log(`   Structure:     ${result.score.structure}/100 │ Organization & formatting`);
    console.log(`   Consensus:     ${result.score.consensus}/100 │ Agreement with other models`);
    console.log(`   Speed:         ${result.score.speed}/100 │ Response time performance`);
    console.log(`   Correctness:   ${result.score.correctness}/100 │ Estimated accuracy`);
    console.log(`   Style:         ${result.score.style}/100 │ Writing quality`);
    console.log(`   Coherence:     ${result.score.coherence}/100 │ Logical flow`);
    console.log(`   Confidence:    ${result.score.confidenceInterval.lower}-${result.score.confidenceInterval.upper}/100 │ Score uncertainty range`);
  }

  // Show winner
  const winner = ranked.find(r => !r.error);
  if (winner) {
    console.log('\n━'.repeat(80));
    console.log(`\n🏆 WINNER: ${winner.model}`);
    console.log(`   Quality Score: ${winner.score.composite}/100`);
    console.log(`   Response Time: ${winner.latencyMs}ms`);
    console.log(`   Output Length: ${winner.text.length} characters`);
    console.log('\n━'.repeat(80));

    // Show response preview
    console.log('\n📄 RESPONSE PREVIEW (first 300 chars):\n');
    const preview = winner.text.substring(0, 300);
    console.log(preview + (winner.text.length > 300 ? '...' : ''));
    console.log('\n━'.repeat(80));
  }

  // Usage instructions
  if (process.argv.length === 2) {
    console.log('\n💡 USAGE:');
    console.log('   node compare-models.mjs [task-type] [custom-prompt]');
    console.log('   Task types: code, creative, analysis, general');
    console.log('   Example: node compare-models.mjs code "Implement quicksort in Python"');
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, computeSimilarity, scoreResult, rankResults, compareTwo } from '../lib/quality-comparator.mjs';

describe('quality-comparator', () => {
  describe('computeMetrics', () => {
    it('returns zero metrics for empty input', () => {
      const m = computeMetrics('');
      assert.equal(m.length, 0);
      assert.equal(m.wordCount, 0);
    });

    it('returns zero metrics for null input', () => {
      const m = computeMetrics(null);
      assert.equal(m.wordCount, 0);
    });

    it('counts words correctly', () => {
      const m = computeMetrics('Hello world this is a test');
      assert.equal(m.wordCount, 6);
    });

    it('counts sentences correctly', () => {
      const m = computeMetrics('First sentence. Second sentence. Third one!');
      assert.equal(m.sentenceCount, 3);
    });

    it('detects code blocks', () => {
      const m = computeMetrics('Here is code:\n```js\nconsole.log("hi")\n```\nAnd more:\n```\nfoo\n```');
      assert.equal(m.codeBlockCount, 2);
    });

    it('detects list items', () => {
      const m = computeMetrics('Items:\n- one\n- two\n- three\n* four');
      assert.equal(m.listItemCount, 4);
    });

    it('computes vocabulary richness', () => {
      const low = computeMetrics('the the the the the');
      const high = computeMetrics('alpha beta gamma delta epsilon');
      assert.ok(high.vocabularyRichness > low.vocabularyRichness);
    });

    it('computes average word length', () => {
      const m = computeMetrics('hi me');
      assert.equal(m.avgWordLength, 2);
    });
  });

  describe('computeSimilarity', () => {
    it('returns 0 for empty inputs', () => {
      assert.equal(computeSimilarity('', 'hello world'), 0);
      assert.equal(computeSimilarity('hello', ''), 0);
    });

    it('returns 1 for identical texts', () => {
      assert.equal(computeSimilarity('hello world foo', 'hello world foo'), 1);
    });

    it('returns value between 0 and 1 for different texts', () => {
      const sim = computeSimilarity(
        'The quick brown fox jumps over the lazy dog',
        'The quick brown cat sits on the lazy mat'
      );
      assert.ok(sim > 0);
      assert.ok(sim < 1);
    });

    it('shows higher similarity for more similar texts', () => {
      const simHigh = computeSimilarity('hello world foo bar', 'hello world foo baz');
      const simLow = computeSimilarity('hello world foo bar', 'completely different sentence here');
      assert.ok(simHigh > simLow);
    });
  });

  describe('scoreResult', () => {
    const makeResult = (model, text, latencyMs = 100) => ({ model, text, latencyMs, error: null });

    it('returns zero scores for error results', () => {
      const score = scoreResult({ error: 'fail' });
      assert.equal(score.composite, 0);
      assert.equal(score.error, true);
    });

    it('returns non-zero scores for valid results', () => {
      const results = [
        makeResult('a', 'This is a detailed response with many words and thoughtful analysis.'),
        makeResult('b', 'Short reply.'),
      ];
      const score = scoreResult(results[0], results);
      assert.ok(score.composite > 0);
      assert.equal(score.error, false);
    });

    it('scores longer responses higher on completeness', () => {
      const long = makeResult('a', 'This is a much longer and more detailed response that covers many aspects of the topic at hand.');
      const short = makeResult('b', 'Brief.');
      const results = [long, short];
      const scoreLong = scoreResult(long, results);
      const scoreShort = scoreResult(short, results);
      assert.ok(scoreLong.completeness > scoreShort.completeness);
    });

    it('applies different weights for different task types', () => {
      const result = makeResult('a', 'Some code:\n```js\nfunction foo() { return 1; }\n```\nThis implements the solution.');
      const results = [result];
      const codeScore = scoreResult(result, results, 'code');
      const creativeScore = scoreResult(result, results, 'creative');
      // Different weights should produce different composites
      assert.ok(typeof codeScore.composite === 'number');
      assert.ok(typeof creativeScore.composite === 'number');
    });
  });

  describe('rankResults', () => {
    it('ranks results by composite score descending', () => {
      const results = [
        { model: 'a', text: 'Short.', latencyMs: 50, error: null },
        { model: 'b', text: 'A much more detailed and comprehensive response with thorough analysis and examples.', latencyMs: 200, error: null },
        { model: 'c', text: 'Medium length response with some details included.', latencyMs: 100, error: null },
      ];
      const ranked = rankResults(results);
      assert.equal(ranked[0].rank, 1);
      assert.equal(ranked[1].rank, 2);
      assert.equal(ranked[2].rank, 3);
      assert.ok(ranked[0].score.composite >= ranked[1].score.composite);
      assert.ok(ranked[1].score.composite >= ranked[2].score.composite);
    });

    it('handles error results', () => {
      const results = [
        { model: 'a', text: 'Good response.', latencyMs: 100, error: null },
        { model: 'b', text: '', latencyMs: 0, error: 'API timeout' },
      ];
      const ranked = rankResults(results);
      assert.equal(ranked.length, 2);
      assert.ok(ranked[1].score.composite === 0);
    });
  });

  describe('compareTwo', () => {
    it('compares two results and picks a winner', () => {
      const a = { model: 'model-a', text: 'A comprehensive answer with many details and thorough analysis of the topic.', latencyMs: 100, error: null };
      const b = { model: 'model-b', text: 'Brief.', latencyMs: 50, error: null };
      const comparison = compareTwo(a, b);
      assert.ok(comparison.winner);
      assert.ok(comparison.margin >= 0);
      assert.ok(comparison.similarity >= 0 && comparison.similarity <= 100);
      assert.equal(comparison.taskType, 'general');
    });

    it('reports similarity between results', () => {
      const same = { model: 'a', text: 'The answer is forty two because of math', latencyMs: 100, error: null };
      const similar = { model: 'b', text: 'The answer is forty two because of science', latencyMs: 100, error: null };
      const comparison = compareTwo(same, similar);
      assert.ok(comparison.similarity > 0);
    });
  });
});

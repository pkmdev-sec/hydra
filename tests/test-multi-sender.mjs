import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider, listModels, sendToModel, sendToMultiple, PROVIDERS } from '../lib/multi-sender.mjs';

describe('multi-sender', () => {
  describe('resolveProvider', () => {
    it('resolves anthropic models', () => {
      const result = resolveProvider('claude-sonnet-4-6');
      assert.equal(result.providerKey, 'anthropic');
      assert.equal(result.provider.name, 'Anthropic');
    });

    it('resolves openai models', () => {
      const result = resolveProvider('gpt-4o');
      assert.equal(result.providerKey, 'openai');
    });

    it('resolves google models', () => {
      const result = resolveProvider('gemini-2.0-flash');
      assert.equal(result.providerKey, 'google');
    });

    it('returns null for unknown models', () => {
      assert.equal(resolveProvider('unknown-model-xyz'), null);
    });
  });

  describe('listModels', () => {
    it('returns all registered models', () => {
      const models = listModels();
      assert.ok(models.length >= 8);
      assert.ok(models.some((m) => m.model === 'claude-sonnet-4-6'));
      assert.ok(models.some((m) => m.model === 'gpt-4o'));
      assert.ok(models.some((m) => m.model === 'gemini-2.0-flash'));
    });

    it('includes provider info for each model', () => {
      const models = listModels();
      for (const m of models) {
        assert.ok(m.provider);
        assert.ok(m.providerName);
        assert.ok(m.model);
      }
    });
  });

  describe('PROVIDERS', () => {
    it('each provider has buildRequest and parseResponse', () => {
      for (const [key, p] of Object.entries(PROVIDERS)) {
        assert.equal(typeof p.buildRequest, 'function', `${key} missing buildRequest`);
        assert.equal(typeof p.parseResponse, 'function', `${key} missing parseResponse`);
      }
    });

    it('anthropic buildRequest formats correctly', () => {
      const req = PROVIDERS.anthropic.buildRequest('claude-sonnet-4-6', 'test prompt', { apiKey: 'sk-test' });
      assert.equal(req.method, 'POST');
      assert.ok(req.url.includes('anthropic.com'));
      const body = JSON.parse(req.body);
      assert.equal(body.model, 'claude-sonnet-4-6');
      assert.equal(body.messages[0].content, 'test prompt');
    });

    it('openai buildRequest formats correctly', () => {
      const req = PROVIDERS.openai.buildRequest('gpt-4o', 'test', { apiKey: 'sk-test' });
      assert.ok(req.headers.Authorization.startsWith('Bearer '));
      const body = JSON.parse(req.body);
      assert.equal(body.model, 'gpt-4o');
    });

    it('google buildRequest formats correctly', () => {
      const req = PROVIDERS.google.buildRequest('gemini-2.0-flash', 'test', { apiKey: 'key123' });
      assert.ok(req.url.includes('gemini-2.0-flash'));
      assert.equal(req.headers['x-goog-api-key'], 'key123'); // FIX: API key is now in header, not URL
    });

    it('anthropic parseResponse extracts text and tokens', () => {
      const parsed = PROVIDERS.anthropic.parseResponse({
        content: [{ text: 'Hello world' }],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: 'end_turn',
      });
      assert.equal(parsed.text, 'Hello world');
      assert.equal(parsed.inputTokens, 10);
      assert.equal(parsed.outputTokens, 5);
    });

    it('openai parseResponse extracts text and tokens', () => {
      const parsed = PROVIDERS.openai.parseResponse({
        choices: [{ message: { content: 'Hi there' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 3 },
      });
      assert.equal(parsed.text, 'Hi there');
      assert.equal(parsed.inputTokens, 8);
      assert.equal(parsed.outputTokens, 3);
    });

    it('google parseResponse extracts text and tokens', () => {
      const parsed = PROVIDERS.google.parseResponse({
        candidates: [{ content: { parts: [{ text: 'Gemini says hi' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 },
      });
      assert.equal(parsed.text, 'Gemini says hi');
      assert.equal(parsed.inputTokens, 12);
    });
  });

  describe('sendToModel', () => {
    it('returns error for unknown model', async () => {
      const result = await sendToModel('unknown-model', 'test');
      assert.ok(result.error);
      assert.equal(result.provider, 'unknown');
    });

    it('handles successful API response', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          content: [{ text: 'Mocked response' }],
          usage: { input_tokens: 15, output_tokens: 10 },
          stop_reason: 'end_turn',
        }),
      }));

      const result = await sendToModel('claude-sonnet-4-6', 'Hello', { fetchFn: mockFetch });
      assert.equal(result.text, 'Mocked response');
      assert.equal(result.inputTokens, 15);
      assert.equal(result.outputTokens, 10);
      assert.equal(result.error, null);
      assert.ok(result.latencyMs >= 0);
      assert.equal(result.provider, 'anthropic');
    });

    it('handles HTTP error response', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
      }));

      const result = await sendToModel('claude-sonnet-4-6', 'Hello', { fetchFn: mockFetch });
      assert.ok(result.error.includes('429'));
    });

    it('handles network error', async () => {
      const mockFetch = mock.fn(async () => { throw new Error('Network failure'); });

      const result = await sendToModel('gpt-4o', 'Hello', { fetchFn: mockFetch });
      assert.ok(result.error.includes('Network failure'));
    });

    it('does not retry when maxRetries is zero', async () => {
      const mockFetch = mock.fn(async () => { throw new Error('network unavailable'); });

      await sendToModel('gpt-4o', 'Hello', {
        fetchFn: mockFetch,
        maxRetries: 0,
        timeoutMs: 20,
      });

      assert.equal(mockFetch.mock.callCount(), 1);
    });
  });

  describe('sendToMultiple', () => {
    it('sends to multiple models concurrently', async () => {
      let callCount = 0;
      const mockFetch = mock.fn(async (url) => {
        callCount++;
        return {
          ok: true,
          json: async () => ({
            content: [{ text: `Response ${callCount}` }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: 'end_turn',
          }),
        };
      });

      const result = await sendToMultiple(
        ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
        'Test prompt',
        { fetchFn: mockFetch }
      );

      assert.equal(result.prompt, 'Test prompt');
      assert.ok(result.timestamp);
      assert.equal(result.results.length, 2);
      assert.ok(result.totalLatencyMs >= 0);
    });

    it('handles mixed success and failure', async () => {
      let call = 0;
      const mockFetch = mock.fn(async () => {
        call++;
        if (call === 1) return { ok: true, json: async () => ({ content: [{ text: 'OK' }], usage: { input_tokens: 5, output_tokens: 3 }, stop_reason: 'end_turn' }) };
        throw new Error('Fail');
      });

      const result = await sendToMultiple(['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'], 'Test', { fetchFn: mockFetch });
      assert.equal(result.results.length, 2);
      const successes = result.results.filter((r) => !r.error);
      assert.ok(successes.length >= 1);
    });
  });
});

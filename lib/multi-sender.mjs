/**
 * HYDRA Multi-Sender — Send the same prompt to multiple AI models concurrently
 * and collect structured results for comparison and arbitrage.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const CIRCUIT_BREAKER_THRESHOLD = 5; // Open circuit after N consecutive failures
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000; // 60 seconds cooldown in half-open state

/** Circuit breaker state per provider */
const circuitBreakerState = new Map();

function getCircuitBreaker(providerKey) {
  if (!circuitBreakerState.has(providerKey)) {
    circuitBreakerState.set(providerKey, {
      failureCount: 0,
      state: 'closed', // 'closed' | 'open' | 'half-open'
      openedAt: null,
    });
  }
  return circuitBreakerState.get(providerKey);
}

function recordCircuitBreakerSuccess(providerKey) {
  const breaker = getCircuitBreaker(providerKey);
  breaker.failureCount = 0;
  breaker.state = 'closed';
  breaker.openedAt = null;
}

function recordCircuitBreakerFailure(providerKey) {
  const breaker = getCircuitBreaker(providerKey);
  breaker.failureCount++;
  if (breaker.failureCount >= CIRCUIT_BREAKER_THRESHOLD) {
    breaker.state = 'open';
    breaker.openedAt = Date.now();
  }
}

function isCircuitBreakerOpen(providerKey) {
  const breaker = getCircuitBreaker(providerKey);
  if (breaker.state === 'closed') return false;
  if (breaker.state === 'open') {
    // Check if cooldown period has elapsed
    if (Date.now() - breaker.openedAt >= CIRCUIT_BREAKER_COOLDOWN_MS) {
      breaker.state = 'half-open';
      return false; // Allow one test request
    }
    return true;
  }
  // half-open: allow request
  return false;
}

/** Model provider registry with endpoint templates */
const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    authHeader: 'x-api-key',
    authEnv: 'ANTHROPIC_API_KEY',
    timeoutMs: 45_000, // Per-provider timeout
    buildRequest(model, prompt, options) {
      return {
        url: this.endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': options.apiKey || process.env[this.authEnv] || '',
          'anthropic-version': '2024-10-22', // Updated from 2023-06-01
        },
        body: JSON.stringify({
          model,
          max_tokens: options.maxTokens || 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
      };
    },
    parseResponse(data) {
      return {
        text: data.content?.[0]?.text || '',
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
        stopReason: data.stop_reason || 'unknown',
      };
    },
  },
  openai: {
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    authHeader: 'Authorization',
    authEnv: 'OPENAI_API_KEY',
    timeoutMs: 30_000, // Per-provider timeout
    buildRequest(model, prompt, options) {
      return {
        url: this.endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey || process.env[this.authEnv] || ''}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: options.maxTokens || 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
      };
    },
    parseResponse(data) {
      const choice = data.choices?.[0] || {};
      return {
        text: choice.message?.content || '',
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
        stopReason: choice.finish_reason || 'unknown',
      };
    },
  },
  google: {
    name: 'Google',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    models: ['gemini-2.0-flash', 'gemini-2.0-pro'],
    authEnv: 'GOOGLE_API_KEY',
    authHeader: 'x-goog-api-key',
    timeoutMs: 30_000, // Per-provider timeout
    buildRequest(model, prompt, options) {
      // FIX: Move API key from URL query to header (line 80 issue)
      return {
        url: `${this.endpoint}/${model}:generateContent`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': options.apiKey || process.env[this.authEnv] || '',
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: options.maxTokens || 1024 },
        }),
      };
    },
    parseResponse(data) {
      const candidate = data.candidates?.[0] || {};
      return {
        text: candidate.content?.parts?.[0]?.text || '',
        inputTokens: data.usageMetadata?.promptTokenCount || 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
        stopReason: candidate.finishReason || 'unknown',
      };
    },
  },
};

/** Resolve provider from model identifier */
export function resolveProvider(model) {
  for (const [key, provider] of Object.entries(PROVIDERS)) {
    if (provider.models.includes(model)) return { providerKey: key, provider };
  }
  return null;
}

/** List all registered models */
export function listModels() {
  const models = [];
  for (const [providerKey, provider] of Object.entries(PROVIDERS)) {
    for (const model of provider.models) {
      models.push({ model, provider: providerKey, providerName: provider.name });
    }
  }
  return models;
}

/**
 * Send a prompt to a single model and return a structured result.
 * @param {string} model - Model identifier
 * @param {string} prompt - The prompt text
 * @param {object} [options] - { apiKey, maxTokens, timeoutMs, fetchFn, maxRetries }
 * @returns {Promise<object>} - { model, provider, text, inputTokens, outputTokens, latencyMs, error }
 */
export async function sendToModel(model, prompt, options = {}) {
  // Input validation
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { model, provider: 'unknown', text: '', inputTokens: 0, outputTokens: 0, latencyMs: 0, error: 'Invalid prompt: must be a non-empty string' };
  }

  const resolved = resolveProvider(model);
  if (!resolved) {
    return { model, provider: 'unknown', text: '', inputTokens: 0, outputTokens: 0, latencyMs: 0, error: `Unknown model: ${model}` };
  }

  const { providerKey, provider } = resolved;

  // Check circuit breaker
  if (isCircuitBreakerOpen(providerKey)) {
    return {
      model,
      provider: providerKey,
      text: '',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      error: `Circuit breaker open for provider ${providerKey}`
    };
  }

  // Use per-provider timeout if available, fallback to options or default
  const timeoutMs = options.timeoutMs ?? provider.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const maxRetries = options.maxRetries ?? 2;

  const start = Date.now();

  // Retry logic with exponential backoff
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let timer;
    try {
      const reqConfig = provider.buildRequest(model, prompt, options);
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetchFn(reqConfig.url, {
        method: reqConfig.method,
        headers: reqConfig.headers,
        body: reqConfig.body,
        signal: controller.signal,
      });
      const latencyMs = Date.now() - start;

      // Check for retryable errors (429 rate limit, 503 service unavailable)
      if (!response.ok) {
        const isRetryable = (response.status === 429 || response.status === 503) && attempt < maxRetries;
        if (isRetryable) {
          // Exponential backoff: 1s, 2s, 4s
          const backoffMs = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }
        // Non-retryable error or max retries reached
        recordCircuitBreakerFailure(providerKey);
        const errBody = await response.text().catch(() => '');
        return { model, provider: providerKey, text: '', inputTokens: 0, outputTokens: 0, latencyMs, error: `HTTP ${response.status}: ${errBody}` };
      }

      const data = await response.json();
      const parsed = provider.parseResponse(data);

      // Success - reset circuit breaker
      recordCircuitBreakerSuccess(providerKey);

      // FIX spread order bug (line 161): spread parsed first, then override with explicit values
      return { ...parsed, model, provider: providerKey, latencyMs, error: null };
    } catch (err) {
      const isRetryable = (err.name === 'AbortError' || err.message.includes('network')) && attempt < maxRetries;
      if (isRetryable) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
      // Max retries exceeded or non-retryable error
      recordCircuitBreakerFailure(providerKey);
      return { model, provider: providerKey, text: '', inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - start, error: err.message };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  recordCircuitBreakerFailure(providerKey);
  return { model, provider: providerKey, text: '', inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - start, error: 'Max retries exceeded' };
}

/**
 * Send a prompt to multiple models concurrently and collect all results.
 * @param {string[]} models - Array of model identifiers
 * @param {string} prompt - The prompt text
 * @param {object} [options] - Passed to each sendToModel call
 * @returns {Promise<object>} - { prompt, timestamp, results: [...], totalLatencyMs }
 */
export async function sendToMultiple(models, prompt, options = {}) {
  const start = Date.now();
  const results = await Promise.allSettled(
    models.map((model) => sendToModel(model, prompt, options))
  );

  return {
    prompt,
    timestamp: new Date().toISOString(),
    results: results.map((r) => (r.status === 'fulfilled' ? r.value : { error: r.reason?.message || 'Unknown error' })),
    totalLatencyMs: Date.now() - start,
  };
}

export { PROVIDERS, getCircuitBreaker, recordCircuitBreakerSuccess, recordCircuitBreakerFailure, isCircuitBreakerOpen };
export default { sendToModel, sendToMultiple, resolveProvider, listModels, PROVIDERS, getCircuitBreaker, isCircuitBreakerOpen };

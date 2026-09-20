# Hydra architecture

Hydra has two separate paths: a JavaScript comparison library and an optional Python recommendation hook.

## Comparison path

```text
prompt
  |
  v
sendToMultiple
  |
  +--> provider request --> structured result
  +--> provider request --> structured result
  +--> provider request --> structured result
  |
  v
rankResults --> findOptimal --> learnFromResults
```

### Multi-sender

[`lib/multi-sender.mjs`](../lib/multi-sender.mjs) owns provider request construction, response parsing, timeouts, retries, and per-provider circuit breaker state. `sendToMultiple` runs the selected model requests concurrently and returns every result.

### Quality comparator

[`lib/quality-comparator.mjs`](../lib/quality-comparator.mjs) computes deterministic text metrics and task-specific scores. These heuristics do not measure factual accuracy.

### Cost optimizer

[`lib/cost-optimizer.mjs`](../lib/cost-optimizer.mjs) combines configured model prices with token counts. It calculates cost, cost efficiency, and a Pareto frontier. Provider prices in source are snapshots and require review before billing decisions.

### Learning engine

[`lib/learning-engine.mjs`](../lib/learning-engine.mjs) classifies tasks and stores observed model rankings in `~/.hydra/learning-store.json`.

## Recommendation hook

```text
Claude Code PreToolUse input
  |
  v
extract prompt --> classify task --> read preferences --> log recommendation
```

[`hooks/hydra-router.py`](../hooks/hydra-router.py) handles only `Bash`, `Agent`, and `WebFetch` inputs with a supported prompt field. It writes recommendations to `~/.hydra/logs/routing.jsonl`. It does not call a provider or change Claude Code's model.

## Failure behavior

- A failed provider request returns a structured error.
- Retryable network, rate-limit, and service-unavailable failures use bounded retries.
- Every request timer is cleared when its attempt ends.
- Five consecutive provider failures open that provider's circuit for 60 seconds.
- The recommendation hook exits without blocking when its input is missing or invalid.

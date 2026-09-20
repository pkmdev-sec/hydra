# Configure the Hydra recommendation hook

The optional Claude Code hook classifies supported tool inputs and records a model recommendation. It does not send a model request or switch the active model.

## Add the hook

Add this entry to your Claude Code settings. Replace the command path with the absolute path to your clone.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Agent|WebFetch",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /absolute/path/to/hydra/hooks/hydra-router.py"
          }
        ]
      }
    ]
  }
}
```

Hydra does not install or enable this hook automatically.

## Behavior

For `Bash`, `Agent`, and `WebFetch` calls, the hook:

1. extracts a prompt-like field from the tool input;
2. classifies the input as code, creative, analysis, math, translation, or general;
3. reads learned preferences from `~/.hydra/learning-store.json`;
4. falls back to its default preference list when learned data is absent or weak;
5. appends the recommendation to `~/.hydra/logs/routing.jsonl`;
6. writes the same recommendation to stderr and lets the tool continue.

Inspect the log with:

```bash
jq . ~/.hydra/logs/routing.jsonl
```

The JavaScript learning API writes the preference store. The hook only reads it.

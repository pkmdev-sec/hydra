#!/usr/bin/env python3
"""
HYDRA Router Hook — PreToolUse hook for Claude Code
Recommends a model based on learned preferences and task classification.

Install in .claude/settings.json:
{
  "hooks": {
    "PreToolUse": [
      { "command": "python3 hooks/hydra-router.py" }
    ]
  }
}
"""

import json
import sys
import re
from pathlib import Path

STORE_PATH = Path.home() / ".hydra" / "learning-store.json"

# Model routing table: task_type -> ordered preference list
DEFAULT_ROUTES = {
    "code":        ["claude-sonnet-4-6", "gpt-4o", "claude-opus-4-6"],
    "creative":    ["claude-opus-4-6", "gpt-4o", "claude-sonnet-4-6"],
    "analysis":    ["claude-opus-4-6", "gpt-4o", "claude-sonnet-4-6"],
    "math":        ["claude-opus-4-6", "gpt-4o", "claude-sonnet-4-6"],
    "translation": ["gpt-4o", "claude-sonnet-4-6", "gemini-2.0-flash"],
    "general":     ["claude-sonnet-4-6", "gpt-4o", "gemini-2.0-flash"],
}

TASK_PATTERNS = {
    "code":        r"\b(code|function|implement|debug|refactor|class|api|endpoint|bug|error|syntax)\b",
    "creative":    r"\b(write|story|poem|creative|imagine|fiction|narrative|compose|blog|essay)\b",
    "analysis":    r"\b(analyze|compare|evaluate|assess|review|summarize|explain|breakdown)\b",
    "math":        r"\b(calculate|compute|solve|equation|formula|math|statistical|probability)\b",
    "translation": r"\b(translate|translation|convert.*language)\b",
}


def classify_task(prompt: str) -> str:
    """Classify a prompt into a task type using keyword heuristics."""
    if not prompt:
        return "general"
    lower = prompt.lower()
    for task_type, pattern in TASK_PATTERNS.items():
        if re.search(pattern, lower):
            return task_type
    return "general"


def load_learned_preferences() -> dict:
    """Load learned model preferences from the HYDRA learning store."""
    try:
        if STORE_PATH.exists():
            data = json.loads(STORE_PATH.read_text())
            return data.get("preferences", {})
    except (json.JSONDecodeError, OSError):
        pass
    return {}


def get_optimal_model(task_type: str) -> dict:
    """
    Recommend a model for a task type using learned or default preferences.
    """
    # Check learned preferences first
    preferences = load_learned_preferences()
    learned = preferences.get(task_type, {})
    learned_model = learned.get("recommended")

    # Fall back to default routing table
    default_route = DEFAULT_ROUTES.get(task_type, DEFAULT_ROUTES["general"])

    # Build recommendation
    if learned_model and learned.get("ranking", []):
        sample_count = learned["ranking"][0].get("sampleCount", 0) if learned["ranking"] else 0
        confidence = min(1.0, sample_count / 10)
        if confidence >= 0.5:
            recommended = learned_model
            source = "learned"
        else:
            recommended = default_route[0]
            source = "default (low confidence)"
    else:
        recommended = default_route[0]
        source = "default"

    return {
        "task_type": task_type,
        "recommended_model": recommended,
        "fallback_models": default_route,
        "source": source,
    }


def extract_prompt_from_hook_input(hook_input: dict) -> str:
    """Extract the user prompt from Claude Code hook input."""
    tool_input = hook_input.get("tool_input", {})
    # Try common field names
    for field in ("prompt", "message", "content", "text", "query", "command"):
        if field in tool_input and isinstance(tool_input[field], str):
            return tool_input[field]
    # Try nested messages
    messages = tool_input.get("messages", [])
    if messages and isinstance(messages, list):
        last = messages[-1]
        if isinstance(last, dict):
            return last.get("content", "")
    return ""


def main():
    """Main hook entry point — reads stdin, routes, outputs decision."""
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            # No input, pass through
            sys.exit(0)

        hook_input = json.loads(raw)
        tool_name = hook_input.get("tool_name", "")

        # Only intercept model-related tool calls
        if tool_name not in ("Bash", "Agent", "WebFetch"):
            sys.exit(0)

        prompt = extract_prompt_from_hook_input(hook_input)
        if not prompt:
            sys.exit(0)

        task_type = classify_task(prompt)
        routing = get_optimal_model(task_type)

        # Output routing decision as JSON for downstream consumption
        result = {
            "hook": "hydra-router",
            "decision": "recommend",
            "recommendation": routing,
            "prompt_preview": prompt[:100] + ("..." if len(prompt) > 100 else ""),
        }

        # Write to HYDRA log
        log_dir = Path.home() / ".hydra" / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / "routing.jsonl"
        with open(log_file, "a") as f:
            f.write(json.dumps(result) + "\n")

        # Print for hook pipeline
        print(json.dumps(result, indent=2), file=sys.stderr)

    except (json.JSONDecodeError, KeyError, TypeError):
        # Silently pass through on any error — don't block the tool
        sys.exit(0)
    except Exception:
        sys.exit(0)


if __name__ == "__main__":
    main()

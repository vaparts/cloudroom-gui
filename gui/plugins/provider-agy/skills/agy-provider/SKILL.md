---
name: agy-provider
description: "Using the Antigravity (agy) provider in Cloudroom. Use when starting or steering a thread on provider agy, choosing an Antigravity model or reasoning level, or when an agy thread fails, hangs, cannot start, reports 'not signed in', or returns a 503 capacity error."
---

# Antigravity (agy) provider

Threads on provider `agy` run Google's official Antigravity CLI in headless
stream-json mode, one process per thread.

## Starting a thread

```sh
room-cli provider models agy
room-cli thread spawn --project PROJECT --parent-self --provider agy \
  --model gemini-3.8-flash --reasoning-level medium \
  --permission-mode accept-edits --prompt "Task"
```

- Models are base ids (`gemini-3.8-flash`, `gemini-4-argon`,
  `claude-opus-5-5`, ...). The reasoning level becomes agy's `--effort`;
  each model accepts only the levels `room-cli provider models agy` lists.
- `--plan` runs the turn in agy's plan mode (no changes).
- `--permission-mode full` maps to `--dangerously-skip-permissions`; use it
  only when the task needs shell commands, because agy cannot ask for
  approval in headless mode.

## What differs from Claude Code threads

- No approval prompts: tools needing approval are denied unless the
  permission mode or agy's `permissions.allow` rules allow them.
- Messages sent while a turn runs are queued and run as the next turn.
- Text only: no image input.
- Local machines only.

## Troubleshooting

- **Cannot start / not signed in**: the error text comes from agy. Ask the
  user to run `agy` in a terminal and sign in; never handle their
  credentials.
- **503 "No capacity available for model"**: Google-side capacity. Retry
  later or pick another model.
- **Not in the picker**: check `room-cli plugin list` for `agy  running` and
  that `agy --version` works on the machine.

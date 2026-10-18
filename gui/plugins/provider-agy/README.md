# bb-plugin-agy - Antigravity provider for Cloudroom

Adds **Antigravity** to Cloudroom's provider picker: threads run on Google's
official Antigravity CLI (`agy`), the same way Claude Code threads run on the
official `claude` binary.

## How it works

The bridge drives `agy` in its documented headless mode
(`--input-format stream-json --output-format stream-json`), one long-lived
process per thread:

- `thread/start` spawns `agy`; its `init` event carries the conversation id,
  which becomes the provider thread id.
- `turn/start` writes `{"event":"user","message":{"content":"..."}}` to stdin;
  `step_update` and `result` events become Cloudroom timeline deltas
  (agent messages, tool calls, token usage).
- `thread/resume`, and any turn that needs different launch flags, restarts
  `agy` on the same conversation with `--conversation <id>`.
- Cloudroom's session instructions are sent once, as a
  `<cloudroom-instructions>` block ahead of the first message of a session;
  agy has no system-prompt flag. On resume they are re-sent only if they
  changed (a per-conversation hash lives in the plugin's data directory).

| Cloudroom                                   | agy                                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| model `gemini-3.8-flash` + reasoning `high` | `--model gemini-3.8-flash --effort high`                                                                                    |
| permission `accept-edits` / `auto`          | `--mode accept-edits` / `--mode auto`                                                                                       |
| permission `full`                           | `--dangerously-skip-permissions`                                                                                            |
| Plan action                                 | `--mode plan`                                                                                                               |
| interrupt                                   | the turn settles as interrupted before `thread/stop` is answered; agy is stopped and the next turn resumes the conversation |
| message sent mid-turn                       | queued, runs as the next turn (`steerMode: "queue"`)                                                                        |

Models come from `agy models`. agy lists one id per effort
(`gemini-3.8-flash-high`) and rejects a suffixed id combined with
`--effort`, so the picker shows base models and the reasoning level becomes
`--effort`. Older threads that stored a suffixed id keep working.

## Install and update

Cloudroom shows agy in Settings and in `room-cli updates` like its other
providers. The current version comes from `agy --version`; the latest from
Google's update manifest, the same one the official installer reads (cached
for an hour). Install runs the official script
(`https://antigravity.google/cli/install.sh`); Update runs `agy update`.
agy also updates itself in the background, so it is often already current.

## Usage limits

Cloudroom shows agy's limits next to Claude Code and Codex. The bridge runs
`agy -p=/usage`, a local command that calls no model and costs no quota, and
reports each line as a window: model group (Gemini, or Claude and GPT),
5-hour or weekly, percent used and reset time. Results are cached for two
minutes.

## Terms of use

The plugin only starts Google's own `agy` binary, which signs in with its own
cached credentials, in the headless mode Google documents for use "whenever
you need the agent's output in a program". The plugin never reads, copies or
forwards Antigravity credentials or OAuth tokens. Antigravity's terms forbid
third-party software accessing the service with Antigravity OAuth credentials;
review them before use: https://antigravity.google/terms

## Requirements

- `agy` installed: https://antigravity.google/docs/getting-started?tab=cli
  The bridge looks for `BB_AGY_EXECUTABLE`, then `~/.local/bin/agy`, then
  `PATH`.
- Signed in once: run `agy` in a terminal and complete the browser sign-in.
- Local machines only. Cloud threads need provider support in
  cloudroom-core.

## Known limitations

- No permission prompts: agy's headless mode has none. Tools that need
  approval follow agy's policy (`--mode`, `permissions.allow` in agy's
  settings) and are otherwise denied.
- No mid-turn steering: messages sent during a turn wait for it to end.
- `instructionMode: "replace"` is treated as append; agy's own system prompt
  cannot be replaced.
- Text input only; agy's stream-json input accepts text blocks.
- No fork or manual compaction.
- Health reports installation and version only: agy has no auth-status
  command, and `agy models` answers without a sign-in. A missing sign-in
  surfaces as agy's own error when a thread starts.

## Install (local path)

```
room-cli plugin build
room-cli plugin install . --yes
```

After editing, `room-cli plugin build && room-cli plugin reload provider-agy`.
Uninstall any other copy of this plugin first: a second registration of the
provider id `agy` is refused.

## Development

From `gui/`:

```
pnpm exec turbo run typecheck test --filter=bb-plugin-provider-agy
```

The tests need no network and no Google account. They run the bridge
in-process through the SDK's JSON-RPC harness, with
`test/fixtures/fake-agy.mjs` underneath: a scripted stand-in that speaks
agy's stream-json grammar (event shapes copied from agy 1.3.5). It picks a
behaviour from the user request: `tool...` runs one `view_file` step,
`slow...` streams the reply in five parts, `fail...` ends with an `ERROR`
result, anything else is echoed. Each launch appends its argv, and each
prompt its text, to `<cwd>/.fake-agy/`, so tests assert launch flags and
exactly what reached agy's stdin.

Covered: the SDK's canonical provider-bridge conformance suite (including
interrupt settlement and thread independence), the event stream (messages,
tool calls, errors, usage), launch flags, queueing, interruption,
instructions, maintenance requests, and a public-SDK-only import guard.

## Layout

| Path                     | What                                              |
| ------------------------ | ------------------------------------------------- |
| `server.ts`              | provider registration                             |
| `host.ts`                | exports the bridge from the host artifact         |
| `src/provider-bridge.ts` | the bridge                                        |
| `src/vocabulary.ts`      | ids, models and efforts                           |
| `src/instructions.ts`    | Cloudroom instructions block and sent-hash record |
| `src/agy-cli.ts`         | finds and runs the agy executable                 |
| `src/maintenance.ts`     | health, install and update status                 |
| `skills/agy-provider/`   | agent-facing notes on using this provider         |
| `test/`                  | harness and the fake agy                          |

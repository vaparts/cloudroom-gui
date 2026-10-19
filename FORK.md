# Fork notes

This is a fork of [davidondrej/cloudroom-gui](https://github.com/davidondrej/cloudroom-gui).
It tracks upstream and adds what we need on top. The same rules apply to the
forks of [cloudroom-core](https://github.com/vaparts/cloudroom-core) and
[skills](https://github.com/vaparts/skills); this file is the single place
they are written down.

## Rules

- Our changes are additive: new plugins, new files and new modules. Edit an
  upstream file only when there is no other way, and record it below.
- `main` changes only through pull requests. A person merges them.

## Upstream files we changed

| File | Change | On conflict |
|---|---|---|
| `gui/turbo.json` | `bb-plugin-provider-agy#typecheck` entry | re-add the entry |
| `gui/pnpm-lock.yaml` | `plugins/provider-agy` importer block | take upstream, re-add only that block, check with `pnpm install --frozen-lockfile` |

## Weekly upstream sync

Upstream publishes squashed source snapshots ("Publish GUI source for vN",
"Publish core 0.1.N: ..."), often daily. A snapshot is the unit of review.
Release tags are offset from the snapshot commits, so do not use tags to tell
what is synced.

Pending snapshots for a repo are `git log --oneline origin/main..upstream/main`
after `git fetch upstream`.

Clones: `~/projects/cloudroom-gui` and `~/projects/cloudroom-core`, each with
an `upstream` remote. Skills: read through `gh api`.

The installed provider-agy plugin is built from `~/projects/cloudroom-gui`, so
the sync never switches branches there. It works in the worktree
`~/projects/cloudroom-gui-sync` (`git worktree add --detach
~/projects/cloudroom-gui-sync origin/main` from the main clone, once), starting
each run with `git fetch origin upstream && git switch --detach origin/main`.

### 1. Triage

For every pending snapshot, read the commit title (core titles carry release
notes) and the diff (`git diff --stat`, then the parts that matter). Sort each
change into one bucket:

- **Affects us**: plugin SDK, provider bridge protocol, `room-cli`, host
  daemon protocol, `plugins/` conventions, or any file in the table above.
- **Useful**: local features and fixes we want.
- **Upstream cloud**: the author's hosted service, website and cloud
  sandboxes. Call out separately any new data flow to the author's servers.
- **Noise**: everything else.

For skills, list added or changed skills and say which could be useful to us.

Open one issue per week in this repo, titled `Upstream triage YYYY-MM-DD`,
labelled `upstream-triage`: one section per repo, one line per change, the
snapshot commit for each, and the sync PRs below.

### 2. Sync

For gui and core: branch `sync/<repo>-<YYYY-MM-DD>` from `main`, merge
`upstream/main`, resolve conflicts with the table above, run the checks,
push, and open a PR into `main` that links the triage issue. Never merge it.

Skip a core snapshot whose upstream CI failed
(`gh api repos/davidondrej/cloudroom-core/commits/<sha>/check-runs`); sync up
to the newest green one and say so in the issue.

Checks:

- gui, from `gui/`: `pnpm install --frozen-lockfile`, then
  `pnpm exec turbo run typecheck test --filter=bb-plugin-provider-agy`.
- core: `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`,
  then `umask 022; TMPDIR=/var/tmp cargo test --locked --all-targets`.
  With git older than 2.54, `harness_commits_drop_ai_co_authors_and_keep_human_ones`
  fails for environment reasons; skip it with `-- --skip` and say so.

If a check fails, open the PR anyway as a draft, with the failure in the
description.

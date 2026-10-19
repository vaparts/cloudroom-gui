# Fork notes

This is a fork of [davidondrej/cloudroom-gui](https://github.com/davidondrej/cloudroom-gui).
It tracks upstream and adds what we need on top. The same rules apply to the
forks of [cloudroom-core](https://github.com/vaparts/cloudroom-core) and
[skills](https://github.com/vaparts/skills); this file is the single place
they are written down.

## Rules

- Our changes are additive: new plugins, new files and new modules. Edit an
  upstream file only when there is no other way, and record it below.
- `main` changes only through pull requests. A person approves each merge:
  the sync agent merges only after an explicit yes in its thread.

## Upstream files we changed

| File | Change | On conflict |
|---|---|---|
| `gui/turbo.json` | `bb-plugin-provider-agy#typecheck` entry | re-add the entry |
| `gui/pnpm-lock.yaml` | `plugins/provider-agy` importer block | take upstream, re-add only that block, check with `pnpm install --frozen-lockfile` |

## Upstream sync

A script loop runs `fork/upstream-watch.sh` every two hours. It costs no
tokens: it fetches, and prints nothing unless gui or core has new snapshots
and no sync PR is open. Then it starts one sync thread with the pending list.
That thread triages, opens the sync PRs, asks the user, and on a yes merges
and rebuilds. Skills are triaged along with each run.

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
each run with `git fetch --multiple origin upstream && git switch --detach origin/main`.

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

Open one issue per sync run in this repo, titled `Upstream triage YYYY-MM-DD`,
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

If a sync PR for the repo is already open, merge the newer snapshots into its
branch instead of opening another one.

### 3. Ask

Tell the user in a few lines what matters, the check results, and a
recommendation. Then wait. Merge nothing without an explicit yes.

### 4. Merge and rebuild

On a yes:

1. Fetch upstream again. If newer snapshots arrived, merge them into the sync
   branch and rerun the checks; if they matter, report and ask again.
2. Merge each sync PR with
   `gh api -X PUT repos/vaparts/<repo>/pulls/<n>/merge -f merge_method=merge`
   and close the triage issue.
3. In `~/projects/cloudroom-gui`: if it is not on `main` or has uncommitted
   changes, stop and report. Otherwise `git pull --ff-only`.
4. Rebuild the plugin only if the merged range touches
   `gui/packages/plugin-sdk`, `gui/packages/provider-bridge-protocol`,
   `gui/plugins/provider-agy` or `gui/pnpm-lock.yaml`. From `gui/`:
   `pnpm install --frozen-lockfile`,
   `pnpm exec turbo run build:runtime --filter=@get-bb/plugin-sdk`, then in
   `plugins/provider-agy`: `room-cli plugin build && room-cli plugin reload provider-agy`.
   Confirm with `room-cli plugin list` that it is running.
5. Report in one line and archive the thread.

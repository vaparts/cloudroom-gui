#!/usr/bin/env bash
# Cheap upstream check for the Cloudroom forks, run by a Cloudroom script loop.
# Prints nothing when there is nothing new. Otherwise starts one sync thread
# that follows FORK.md and asks the user before merging.
set -euo pipefail

GUI=~/projects/cloudroom-gui-sync
CORE=~/projects/cloudroom-core
STATE=~/.local/state/cloudroom-upstream-watch
PROJECT=${ROOM_PROJECT_ID:-proj_yu69x6i2pq}
ENVIRONMENT=env_k882n6jve7
mkdir -p "$STATE"

# One decision at a time: while a sync PR is open, its thread waits for the user.
open=$(for r in cloudroom-gui cloudroom-core; do
  gh pr list -R "vaparts/$r" --state open --search "head:sync/" --json url -q '.[].url'
done)
[ -z "$open" ] || exit 0

git -C "$GUI" fetch -q --multiple origin upstream
git -C "$CORE" fetch -q --multiple origin upstream
gui=$(git -C "$GUI" log --oneline origin/main..upstream/main)
core=$(git -C "$CORE" log --oneline origin/main..upstream/main)
skills_up=$(gh api repos/davidondrej/skills/commits/main -q .sha)
skills_seen=$(cat "$STATE/skills" 2>/dev/null || true)

key=$(git -C "$GUI" rev-parse upstream/main)-$(git -C "$CORE" rev-parse upstream/main)
[ -n "$gui$core" ] || exit 0
[ "$key" != "$(cat "$STATE/last" 2>/dev/null || true)" ] || exit 0

pending="Pending snapshots:
gui:
${gui:-none}
core:
${core:-none}
skills: upstream main ${skills_up}, last triaged ${skills_seen:-never}"

prompt="Upstream sync for the Cloudroom forks. Follow FORK.md exactly:
git -C ~/projects/cloudroom-gui show origin/main:FORK.md

$pending

Do the triage and the sync PRs as FORK.md says (section \"Upstream sync\"),
then stop and ask the user, in Russian, in a few lines: what changed that
matters to us, the check results, and your recommendation (merge or not, and
why). Wait for the answer. On a clear yes, do \"Merge and rebuild\" from
FORK.md. On no, close nothing and say what would change your mind.
Never merge without that yes. Write issues and PRs in English.
When done, record ${skills_up} in ${STATE}/skills."

"${ROOM_CLI:-room-cli}" thread spawn --project "$PROJECT" --environment "$ENVIRONMENT" \
  --provider claude-code --model claude-sonnet-5-5 --reasoning-level medium \
  --permission-mode auto --title "Upstream sync $(date +%F)" --prompt "$prompt" >/dev/null
echo "$key" > "$STATE/last"
echo "$pending"

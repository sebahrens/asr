#!/usr/bin/env bash
#
# Fetch real, code-bearing agent skills from public GitHub repos into the
# scanner e2e fixtures directory. These exercise the security-scanning pipeline
# (Gitleaks / Trivy / Foxguard / Opengrep) against real code rather than the
# tiny hand-written fixtures.
#
# The destination is git-ignored (see .gitignore) so the corpus is never
# committed — re-run this script to (re)populate it. The scanner-real e2e test
# skips any skill that is not present on disk, so a partial fetch is fine.
#
# Usage:
#   scripts/fetch-real-skills.sh            # fetch all skills
#   scripts/fetch-real-skills.sh --clean    # wipe the corpus first
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/packages/submission/test/fixtures/scanning/real"

# name|repo|subpath-within-repo
SKILLS=(
  "webapp-testing|https://github.com/anthropics/skills.git|skills/webapp-testing"
  "slack-gif-creator|https://github.com/anthropics/skills.git|skills/slack-gif-creator"
  "pptx|https://github.com/anthropics/skills.git|skills/pptx"
  "firecrawl-research|https://github.com/glebis/claude-skills.git|firecrawl-research"
  "transcript-analyzer|https://github.com/glebis/claude-skills.git|transcript-analyzer"
  "transcript-fixer|https://github.com/daymade/claude-code-skills.git|daymade-audio/transcript-fixer"
)

if [[ "${1:-}" == "--clean" ]]; then
  echo "Removing existing corpus at $DEST"
  rm -rf "$DEST"
fi

mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Shallow-clone each distinct repo once (the clone dir doubling as the
# "already cloned" marker), then copy out the requested subpaths. Avoids
# bash 4 associative arrays so it runs on macOS's stock bash 3.2.
for entry in "${SKILLS[@]}"; do
  IFS='|' read -r name repo subpath <<<"$entry"

  if [[ -d "$DEST/$name" ]]; then
    echo "✓ $name already present — skipping (use --clean to refetch)"
    continue
  fi

  repo_dir="$TMP/$(echo "$repo" | sed 's#[^a-zA-Z0-9]#_#g')"
  if [[ ! -d "$repo_dir" ]]; then
    echo "→ cloning $repo"
    git clone --depth 1 --quiet "$repo" "$repo_dir"
  fi

  src="$repo_dir/$subpath"
  if [[ ! -d "$src" ]]; then
    echo "✗ $name: expected path '$subpath' not found in $repo" >&2
    continue
  fi

  echo "→ copying $name"
  mkdir -p "$DEST/$name"
  cp -R "$src/." "$DEST/$name/"
done

echo
echo "Corpus ready at: $DEST"
ls -1 "$DEST" 2>/dev/null | sed 's/^/  - /'

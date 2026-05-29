#!/bin/bash

# Agent Skills Registry (ASR) - Ralph Loop Runner
#
# This script and its PROMPT_*.md prompts live in <repo>/ralph-scripts/
# and operate on the asr repo at $PROJECT_DIR (default ~/projects/asr,
# override with PROJECT_DIR=/path/to/repo).
#
# Usage:
#   ./loop.sh                    - Run build loop (build only)
#   ./loop.sh plan               - Run planning loop
#   ./loop.sh N                  - Run build loop for max N iterations
#   ./loop.sh plan N             - Run planning loop for max N iterations
#   ./loop.sh include-tests      - Run build loop with e2e + visual web UI tests
#   ./loop.sh include-tests N    - Run build loop with tests for max N iterations
#   ./loop.sh codex              - Run the loop with OpenAI Codex instead of Claude
#   ./loop.sh codex plan N       - Flags compose: engine + mode + iteration cap
#
# Engine (claude default, or codex):
#   claude — uses `claude -p` (Anthropic subscription; ANTHROPIC_API_KEY unset).
#   codex  — uses `codex exec` (ChatGPT subscription; OPENAI_API_KEY unset so it
#            never falls through to API-key billing). Select with the `codex`
#            arg or RALPH_ENGINE=codex. We call the Codex CLI directly rather
#            than the codex-companion plugin runtime — see the note by
#            run_codex_with_completion_detection() for the rationale.
#
# Models:
#   claude — Build/plan use Opus 4.6 (--model opus); visual uses Haiku 4.5.
#   codex  — Uses the model from ~/.codex/config.toml by default. Override per
#            phase with CODEX_BUILD_MODEL / CODEX_VISUAL_MODEL env vars.
#
# By default, only the build phase runs. The Docker E2E test and visual web-UI
# inspection phases are opt-in via the "include-tests" flag.
#
# FIX for Claude Code hang bug (GitHub #19060, #25629, #31050):
# Claude completes work but never calls process.exit(). The process hangs
# indefinitely at 0% CPU with stdout open. Using --output-format stream-json
# lets us detect the {"type":"result"} event and kill the process ourselves.

set -e

# Safety: always unset ANTHROPIC_API_KEY so every claude invocation in this
# script (and any subprocess it spawns) uses the subscription, never API credits.
unset ANTHROPIC_API_KEY

MODE="build"
INCLUDE_TESTS=false
MAX_ITERATIONS=0
ITERATION=0
ENGINE="${RALPH_ENGINE:-claude}"              # claude (default) or codex
BUILD_MODEL="opus"                            # claude build/plan model
VISUAL_MODEL="haiku"                          # claude visual-inspection model
CODEX_BUILD_MODEL="${CODEX_BUILD_MODEL:-}"    # empty => codex config.toml default
CODEX_VISUAL_MODEL="${CODEX_VISUAL_MODEL:-}"  # empty => codex config.toml default
HARD_TIMEOUT=2700  # 45min safety net (should never hit with stream-json detection)

# --help / -h : print usage and exit (before any side effects).
print_help() {
    cat <<'EOF'
ASR Ralph Loop Runner — drives an agent (Claude or Codex) over the asr repo,
iterating on beads-tracked work until done or an iteration cap is hit.

USAGE:
  ./loop.sh [claude|codex] [plan] [include-tests] [N]
  ./loop.sh --help | -h

POSITIONAL ARGS (order-independent, all optional, compose freely):
  plan            Run the planning loop (decompose specs into beads) instead of
                  the default build loop. Uses PROMPT_plan.md.
  include-tests   After each build iteration, also run the Docker E2E test
                  (pnpm test:e2e) and a visual web-UI inspection pass. Opt-in;
                  off by default. Ignored in plan mode.
  claude          Use the Claude engine (`claude -p`). This is the default.
  codex           Use the OpenAI Codex engine (`codex exec`) instead of Claude.
                  Equivalent to RALPH_ENGINE=codex.
  N               A bare integer caps the run at N iterations. 0 / omitted means
                  run until an exit signal or no work remains.

  Examples:
    ./loop.sh                  Build loop, Claude, unlimited iterations
    ./loop.sh plan             Planning loop
    ./loop.sh 5                Build loop, stop after 5 iterations
    ./loop.sh plan 3           Planning loop, max 3 iterations
    ./loop.sh include-tests    Build loop + E2E + visual inspection each pass
    ./loop.sh codex plan 2     Codex engine, planning loop, max 2 iterations

ENGINES:
  claude  `claude -p` on the Anthropic subscription (ANTHROPIC_API_KEY is
          unset so it never bills the API account).
  codex   `codex exec` on the ChatGPT subscription (OPENAI_API_KEY is unset
          for the same reason). Called as the supported headless CLI directly.

MODELS:
  claude  Build/plan = Opus (--model opus); visual inspection = Haiku.
  codex   Uses ~/.codex/config.toml default unless overridden per phase via
          CODEX_BUILD_MODEL / CODEX_VISUAL_MODEL.

ENVIRONMENT VARIABLES:
  PROJECT_DIR         Repo to run against (default: ~/projects/asr). Must exist.
  RALPH_ENGINE        Default engine when no claude/codex arg is given
                      (claude | codex; default claude). A positional arg wins.
  CODEX_BUILD_MODEL   Override the codex model for the build/plan phase
                      (default: codex config.toml default).
  CODEX_VISUAL_MODEL  Override the codex model for the visual phase
                      (default: codex config.toml default).
  ANTHROPIC_API_KEY   Always unset by this script (forces subscription auth).
  OPENAI_API_KEY      Unset for codex runs (forces ChatGPT-subscription auth).

BEHAVIOUR NOTES:
  - In build mode, only tasks/stories are picked up; epics are skipped. If no
    buildable bead is ready, the iteration auto-pivots to plan mode to decompose.
  - Create a file named .ralph-exit in PROJECT_DIR to stop the loop after the
    current iteration (the file is consumed on exit).
  - HARD_TIMEOUT (2700s) is a per-phase watchdog safety net.
EOF
}
for arg in "$@"; do
    case "$arg" in
        -h|--help|help) print_help; exit 0 ;;
    esac
done

# Absolute paths
# - SCRIPT_DIR: where loop.sh + PROMPT_*.md live (this directory)
# - PROJECT_DIR: the asr repo to run against; override with PROJECT_DIR=...
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$HOME/projects/asr}"
if [ ! -d "$PROJECT_DIR" ]; then
    echo "Error: PROJECT_DIR does not exist: $PROJECT_DIR" >&2
    exit 1
fi
TEMP_OUTPUT=$(mktemp)
trap "rm -f $TEMP_OUTPUT" EXIT

# Kill any orphaned Claude processes from previous runs
cleanup_orphan_claude_processes() {
    local current_ppid=$$
    ps aux | grep -E "claude.*-p.*--dangerously-skip-permissions" | grep -v grep | while read -r line; do
        local pid=$(echo "$line" | awk '{print $2}')
        if [ "$pid" != "$current_ppid" ]; then
            kill "$pid" 2>/dev/null || true
        fi
    done
}

# Kill any orphaned Codex processes from previous runs (codex exec exits cleanly,
# so these are rare, but a watchdog-killed run can leave a stray child behind).
cleanup_orphan_codex_processes() {
    local current_ppid=$$
    ps aux | grep -E "codex exec.*--dangerously-bypass-approvals-and-sandbox" | grep -v grep | while read -r line; do
        local pid=$(echo "$line" | awk '{print $2}')
        if [ "$pid" != "$current_ppid" ]; then
            kill "$pid" 2>/dev/null || true
        fi
    done
}
cleanup_orphan_claude_processes
cleanup_orphan_codex_processes

# Run claude with stream-json and detect completion via result event.
# Returns 0 on successful result, 1 on timeout/no result.
run_claude_with_completion_detection() {
    local prompt_file="$1"
    local model="$2"
    local temp_out="$3"
    local err_log="${temp_out}.err"

    > "$temp_out"
    > "$err_log"

    # Start claude in background with stream-json output
    # Prompt piped via stdin to handle large prompts; stdout=json, stderr=separate log
    # Unset ANTHROPIC_API_KEY so claude uses the subscription, not the API billing account.
    cd "$PROJECT_DIR" && cat "$prompt_file" \
        | env -u ANTHROPIC_API_KEY claude -p --dangerously-skip-permissions --verbose \
            --output-format stream-json --model "$model" \
            > "$temp_out" 2>"$err_log" &
    local claude_pid=$!

    # Hard timeout watchdog (kills claude if stream-json detection fails)
    ( sleep $HARD_TIMEOUT; kill $claude_pid 2>/dev/null ) &
    local watchdog_pid=$!

    # Monitor stream-json output for the result event
    local result_received=false
    while kill -0 $claude_pid 2>/dev/null; do
        if grep -q '"type":"result"' "$temp_out" 2>/dev/null; then
            result_received=true
            # Give claude 3s to exit cleanly, then force kill
            ( sleep 3; kill $claude_pid 2>/dev/null ) &
            local killer_pid=$!
            wait $claude_pid 2>/dev/null
            kill $killer_pid 2>/dev/null
            break
        fi
        sleep 1
    done

    # Clean up watchdog
    kill $watchdog_pid 2>/dev/null
    wait $watchdog_pid 2>/dev/null
    wait $claude_pid 2>/dev/null

    # Final check: process may have exited (e.g. hook crash) after emitting the result
    # but before our polling loop caught it
    if [ "$result_received" = false ] && grep -q '"type":"result"' "$temp_out" 2>/dev/null; then
        result_received=true
    fi

    # Extract and display the result text
    local result_text
    result_text=$(grep '"type":"result"' "$temp_out" | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if line:
        try:
            obj = json.loads(line)
            if obj.get('result'):
                print(obj['result'][:500])
                break
        except: pass
" 2>/dev/null)
    [ -n "$result_text" ] && echo "$result_text"

    if [ "$result_received" = true ]; then
        echo "  (completed via stream-json result detection)"
        rm -f "$err_log"
        return 0
    else
        # Show stderr to help diagnose failures
        if [ -s "$err_log" ]; then
            echo "  stderr output:"
            head -5 "$err_log" | sed 's/^/    /'
        fi
        echo "  (no result event received)"
        rm -f "$err_log"
        return 1
    fi
}

# Run codex non-interactively via `codex exec`.
#
# Why the CLI directly, not the codex-companion plugin runtime:
#   The codex plugin ships scripts/codex-companion.mjs, but that helper is built
#   for *interactive, session-attached* use from Claude Code's rescue subagent —
#   it drives the Codex app-server protocol with background jobs, status/result
#   polling, cancel, and persistent resumable threads. It is declared an
#   "internal helper contract" (user-invocable: false) living at a versioned
#   plugin-cache path, so it is not a stable surface to script against. A Ralph
#   iteration is the opposite shape: one bounded, headless, fire-and-forget run.
#   `codex exec` is the supported headless entrypoint, it EXITS cleanly when the
#   turn completes (so the whole stream-json hang workaround the Claude path
#   needs does not apply here), and it has no plugin/Node dependency. We keep the
#   orchestration (iteration control, beads, exit signal) in this loop.
#
# Returns 0 on a clean exit, 1 on nonzero exit or hard-timeout kill.
run_codex_with_completion_detection() {
    local prompt_file="$1"
    local model="$2"
    local temp_out="$3"
    local err_log="${temp_out}.err"
    local last_msg="${temp_out}.last"

    > "$temp_out"
    > "$err_log"
    > "$last_msg"

    # Pass --model only when explicitly configured; otherwise codex uses its
    # config.toml default.
    local model_args=()
    [ -n "$model" ] && model_args=(--model "$model")

    # --dangerously-bypass-approvals-and-sandbox mirrors claude's
    #   --dangerously-skip-permissions (fully headless, no approval prompts).
    # env -u OPENAI_API_KEY forces ChatGPT-subscription auth (~/.codex/auth.json
    #   tokens) instead of API-key billing — the codex analogue of the
    #   ANTHROPIC_API_KEY unset above. (OPENAI_API_KEY is present in this env, so
    #   without this codex would silently bill the API account.)
    # -o writes the final agent message to a file so we can echo a short summary.
    # Prompt is piped via stdin (no PROMPT arg) to handle large prompts.
    cat "$prompt_file" \
        | env -u OPENAI_API_KEY codex exec \
            --cd "$PROJECT_DIR" \
            --skip-git-repo-check \
            --dangerously-bypass-approvals-and-sandbox \
            "${model_args[@]}" \
            -o "$last_msg" \
            > "$temp_out" 2>"$err_log" &
    local codex_pid=$!

    # Hard timeout watchdog (codex exec normally exits on its own; this only
    # fires on a network/stall hang).
    ( sleep $HARD_TIMEOUT; kill $codex_pid 2>/dev/null ) &
    local watchdog_pid=$!

    wait $codex_pid 2>/dev/null
    local codex_rc=$?

    # Clean up watchdog
    kill $watchdog_pid 2>/dev/null
    wait $watchdog_pid 2>/dev/null

    # Echo the final agent message (truncated), like the claude result text
    if [ -s "$last_msg" ]; then
        head -c 500 "$last_msg"
        echo ""
    fi

    if [ "$codex_rc" -eq 0 ]; then
        echo "  (completed — codex exec exited 0)"
        rm -f "$err_log" "$last_msg"
        return 0
    else
        if [ -s "$err_log" ]; then
            echo "  stderr output:"
            head -5 "$err_log" | sed 's/^/    /'
        fi
        echo "  (codex exec exited $codex_rc — nonzero or hard-timeout kill)"
        rm -f "$err_log" "$last_msg"
        return 1
    fi
}

# Engine dispatcher: route a phase to the configured agent.
#   $1 prompt file  $2 temp out  $3 claude model  $4 codex model
run_agent_with_completion_detection() {
    local prompt_file="$1"
    local temp_out="$2"
    local claude_model="$3"
    local codex_model="$4"
    if [ "$ENGINE" = "codex" ]; then
        run_codex_with_completion_detection "$prompt_file" "$codex_model" "$temp_out"
    else
        run_claude_with_completion_detection "$prompt_file" "$claude_model" "$temp_out"
    fi
}

# Parse arguments
for arg in "$@"; do
    if [ "$arg" = "plan" ]; then
        MODE="plan"
    elif [ "$arg" = "include-tests" ]; then
        INCLUDE_TESTS=true
    elif [ "$arg" = "codex" ]; then
        ENGINE="codex"
    elif [ "$arg" = "claude" ]; then
        ENGINE="claude"
    elif [ "$arg" -eq "$arg" ] 2>/dev/null; then
        MAX_ITERATIONS=$arg
    fi
done

# Validate engine and that its CLI is on PATH
case "$ENGINE" in
    claude|codex) ;;
    *) echo "Error: unknown ENGINE '$ENGINE' (expected 'claude' or 'codex')" >&2; exit 1 ;;
esac
if ! command -v "$ENGINE" >/dev/null 2>&1; then
    echo "Error: '$ENGINE' CLI not found on PATH" >&2
    exit 1
fi

# Human-readable model labels for the per-phase banners
if [ "$ENGINE" = "codex" ]; then
    ACTIVE_BUILD_MODEL="codex:${CODEX_BUILD_MODEL:-default}"
    ACTIVE_VISUAL_MODEL="codex:${CODEX_VISUAL_MODEL:-default}"
else
    ACTIVE_BUILD_MODEL="claude:$BUILD_MODEL"
    ACTIVE_VISUAL_MODEL="claude:$VISUAL_MODEL"
fi

echo "=== ASR Ralph Loop ==="
echo "Engine: $ENGINE"
echo "Mode: $MODE"
echo "Tests: $INCLUDE_TESTS"
echo "Project: $PROJECT_DIR"
if [ $MAX_ITERATIONS -gt 0 ]; then
    echo "Max iterations: $MAX_ITERATIONS"
fi
echo ""

# Select prompt file (prompts live alongside loop.sh in SCRIPT_DIR)
if [ "$MODE" = "plan" ]; then
    PROMPT_FILE="$SCRIPT_DIR/PROMPT_plan.md"
else
    PROMPT_FILE="$SCRIPT_DIR/PROMPT_build.md"
fi
VISUAL_PROMPT_FILE="$SCRIPT_DIR/PROMPT_visual_review.md"

# Check prompt file exists
if [ ! -f "$PROMPT_FILE" ]; then
    echo "Error: prompt file not found: $PROMPT_FILE"
    exit 1
fi

# Ensure beads is initialised; gracefully degrade if not available
HAS_BEADS=false
if command -v bd >/dev/null 2>&1; then
    if ( cd "$PROJECT_DIR" && bd list >/dev/null 2>&1 ); then
        HAS_BEADS=true
    else
        echo "  ⚠ beads (bd) installed but not initialised in $PROJECT_DIR — run 'bd init' to enable task tracking"
    fi
else
    echo "  ⚠ beads (bd) not on PATH — task tracking commands will be skipped"
fi

# Main loop
while true; do
    ITERATION=$((ITERATION + 1))
    START_EPOCH=$(date +%s)

    # Re-derive prompt file each iteration so a plan-pivot doesn't persist
    if [ "$MODE" = "plan" ]; then
        PROMPT_FILE="$SCRIPT_DIR/PROMPT_plan.md"
    else
        PROMPT_FILE="$SCRIPT_DIR/PROMPT_build.md"
    fi

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Iteration $ITERATION — $(date)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # Show next bead to work on. In build mode, refuse to pick non-task/non-story
    # beads (epics are aggregates — they have no implementable acceptance) and
    # auto-pivot to plan mode if nothing implementable is ready.
    if [ "$HAS_BEADS" = true ]; then
        echo ""
        IN_PROGRESS=$(cd "$PROJECT_DIR" && bd list --status=in_progress 2>/dev/null | grep -E '^[○◐●✓❄]' | head -1)
        if [ -n "$IN_PROGRESS" ]; then
            echo "Resuming in-progress bead:"
            echo "  $IN_PROGRESS"
        elif [ "$MODE" = "build" ]; then
            # Prefer tasks (atomic), then stories. Skip epics — they aren't buildable.
            NEXT_BUILDABLE=$(cd "$PROJECT_DIR" && {
                bd list --ready --label tier:task --limit 0 2>/dev/null | grep -E '^[○◐●]' | head -1
                bd list --ready --label tier:story --limit 0 2>/dev/null | grep -E '^[○◐●]' | head -1
            } | head -1)
            if [ -n "$NEXT_BUILDABLE" ]; then
                echo "Next ready buildable bead:"
                echo "  $NEXT_BUILDABLE"
            else
                READY_TOTAL=$(cd "$PROJECT_DIR" && bd ready --limit 0 2>/dev/null | grep -cE '^[○◐●]')
                READY_EPICS=$(cd "$PROJECT_DIR" && bd list --ready --label tier:epic --limit 0 2>/dev/null | grep -cE '^[○◐●]')
                echo "⚠ No buildable bead ready (ready=$READY_TOTAL of which epics=$READY_EPICS)."
                echo "  Pivoting this iteration to PLAN mode to decompose into tasks."
                PROMPT_FILE="$SCRIPT_DIR/PROMPT_plan.md"
                if [ ! -f "$PROMPT_FILE" ]; then
                    echo "  ⚠ Plan prompt missing; skipping iteration." ; continue
                fi
            fi
        else
            echo "Next ready bead:"
            cd "$PROJECT_DIR" && bd ready 2>/dev/null | head -1 || echo "  (could not fetch beads)"
        fi
        echo ""
    fi

    # Phase 1: Build/plan with Opus 4.6
    # Uses stream-json to detect completion and kill hung process (GitHub #19060 fix)
    echo "  Phase 1: Build ($ACTIVE_BUILD_MODEL)"
    set +e
    run_agent_with_completion_detection "$PROMPT_FILE" "$TEMP_OUTPUT" "$BUILD_MODEL" "$CODEX_BUILD_MODEL"
    BUILD_EXIT=$?
    set -e

    BUILD_ELAPSED=$(( $(date +%s) - START_EPOCH ))
    echo ""
    echo "  Build phase completed (exit $BUILD_EXIT, ${BUILD_ELAPSED}s)"

    # Fallback: create tracking bead if build phase crashed without creating its own beads
    if [ $BUILD_EXIT -ne 0 ] && [ "$HAS_BEADS" = true ]; then
        echo "  ⚠ Build phase exited $BUILD_EXIT — checking for untracked failures..."
        EXISTING=$(cd "$PROJECT_DIR" && bd list --status=open 2>/dev/null | grep -c "Loop iteration.*build.*crash" || echo "0")
        if [ "${EXISTING}" = "0" ]; then
            cd "$PROJECT_DIR" && bd create \
                --title="Loop iteration $ITERATION build phase crash (exit $BUILD_EXIT)" \
                --type=bug \
                --priority=1 \
                --labels="loop,build-crash" 2>/dev/null || true
            echo "  Created fallback bead for build phase failure"
        fi
    fi

    # Phase 1.5: Docker E2E test (only with include-tests)
    if [ "$INCLUDE_TESTS" = true ] && [ "$MODE" = "build" ]; then
        echo ""
        echo "  Phase 1.5: Docker E2E test (pnpm test:e2e)"
        E2E_LOG="$PROJECT_DIR/.ralph-e2e.log"
        set +e
        ( cd "$PROJECT_DIR" && pnpm test:e2e ) >"$E2E_LOG" 2>&1
        E2E_EXIT=$?
        set -e

        if [ $E2E_EXIT -ne 0 ]; then
            echo "  ⚠ E2E test FAILED (exit=$E2E_EXIT)"
            tail -10 "$E2E_LOG" | sed 's/^/    /'
            if [ "$HAS_BEADS" = true ]; then
                # Stable-defect dedup: every iteration's E2E failure points at the
                # same wording-independent bead, identified by label
                # `defect:e2e-failure`. Mirrors the visual-loop dedup pattern (see
                # PROMPT_visual_review.md §4). `tier:task` is set so the build
                # phase actually picks this bead up to fix instead of just
                # accumulating noise.
                E2E_TAIL=$(tail -25 "$E2E_LOG")
                EXISTING_ID=$(cd "$PROJECT_DIR" && bd list --status=open --label defect:e2e-failure --limit 0 2>/dev/null \
                    | grep -oE 'asr-[a-z0-9]+' | head -1)
                if [ -z "$EXISTING_ID" ]; then
                    CLOSED_ID=$(cd "$PROJECT_DIR" && bd list --status=closed --label defect:e2e-failure --limit 0 2>/dev/null \
                        | grep -oE 'asr-[a-z0-9]+' | head -1)
                    if [ -n "$CLOSED_ID" ]; then
                        cd "$PROJECT_DIR" && bd reopen "$CLOSED_ID" 2>/dev/null || true
                        cd "$PROJECT_DIR" && bd note "$CLOSED_ID" "Recurred in iteration $ITERATION. Exit $E2E_EXIT. Tail:
$E2E_TAIL" 2>/dev/null || true
                        echo "  Reopened bead $CLOSED_ID with new iteration context"
                    else
                        cd "$PROJECT_DIR" && bd create \
                            --title="E2E: pnpm test:e2e failing (defect:e2e-failure)" \
                            --type=bug \
                            --priority=1 \
                            --labels="e2e,docker,tier:task,defect:e2e-failure" \
                            --description="Exit $E2E_EXIT. Tail:
$E2E_TAIL" 2>/dev/null || true
                        echo "  Filed canonical bead for E2E failure"
                    fi
                else
                    cd "$PROJECT_DIR" && bd note "$EXISTING_ID" "Recurred in iteration $ITERATION. Exit $E2E_EXIT. Tail:
$E2E_TAIL" 2>/dev/null || true
                    echo "  Appended iteration $ITERATION context to existing bead $EXISTING_ID"
                fi
            fi
        else
            echo "  ✓ E2E test passed"
        fi
        rm -f "$E2E_LOG"
    fi

    # Phase 2: Visual inspection of the web UI with Haiku 4.5 (only with include-tests)
    if [ "$INCLUDE_TESTS" = true ] && [ "$MODE" = "build" ]; then
        echo ""
        echo "  Phase 2: Visual inspection of @asr/web ($ACTIVE_VISUAL_MODEL)"
        VISUAL_START=$(date +%s)
        set +e
        run_agent_with_completion_detection "$VISUAL_PROMPT_FILE" "$TEMP_OUTPUT" "$VISUAL_MODEL" "$CODEX_VISUAL_MODEL"
        VISUAL_EXIT=$?
        set -e
        VISUAL_ELAPSED=$(( $(date +%s) - VISUAL_START ))
        echo "  Visual inspection completed (exit $VISUAL_EXIT, ${VISUAL_ELAPSED}s)"

        # Fallback: create tracking bead if visual phase crashed without creating its own beads
        if [ $VISUAL_EXIT -ne 0 ] && [ "$HAS_BEADS" = true ]; then
            echo "  ⚠ Visual phase exited $VISUAL_EXIT — checking for untracked failures..."
            EXISTING=$(cd "$PROJECT_DIR" && bd list --status=open 2>/dev/null | grep -c "Loop iteration.*visual.*crash" || echo "0")
            if [ "${EXISTING}" = "0" ]; then
                cd "$PROJECT_DIR" && bd create \
                    --title="Loop iteration $ITERATION visual phase crash (exit $VISUAL_EXIT)" \
                    --type=bug \
                    --priority=2 \
                    --labels="loop,visual-crash" 2>/dev/null || true
                echo "  Created fallback bead for visual phase failure"
            fi
        fi

        # Clean up captured screenshots from .playwright-mcp/ to prevent spillover
        if [ -d "$PROJECT_DIR/.playwright-mcp" ]; then
            find "$PROJECT_DIR/.playwright-mcp" -maxdepth 1 -name "*.png" -o -name "*.jpg" 2>/dev/null | xargs rm -f 2>/dev/null || true
            echo "  Cleaned up .playwright-mcp/ screenshots"
        fi
    fi

    ELAPSED=$(( $(date +%s) - START_EPOCH ))
    echo ""
    echo "Iteration $ITERATION completed (total ${ELAPSED}s)"
    echo ""

    # Check for explicit exit signal (file-based)
    if [ -f "$PROJECT_DIR/.ralph-exit" ]; then
        echo "Exit signal detected (.ralph-exit file found)"
        rm -f "$PROJECT_DIR/.ralph-exit"
        break
    fi

    # Check iteration limit
    if [ $MAX_ITERATIONS -gt 0 ] && [ $ITERATION -ge $MAX_ITERATIONS ]; then
        echo "Reached maximum iterations ($MAX_ITERATIONS)"
        break
    fi

    # Small delay between iterations to avoid hammering
    sleep 2
done

echo "=== Loop completed ==="
echo "Total iterations: $ITERATION"

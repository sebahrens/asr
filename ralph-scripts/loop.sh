#!/bin/bash

# Agent Skills Registry (ASR) - Ralph Loop Runner
#
# This script and its PROMPT_*.md prompts live in <repo>/ralph-scripts/
# and operate on the asr repo at $PROJECT_DIR (default ~/projects/aks,
# override with PROJECT_DIR=/path/to/repo).
#
# Usage:
#   ./loop.sh                    - Run build loop (build only)
#   ./loop.sh plan               - Run planning loop
#   ./loop.sh N                  - Run build loop for max N iterations
#   ./loop.sh plan N             - Run planning loop for max N iterations
#   ./loop.sh include-tests      - Run build loop with e2e + visual web UI tests
#   ./loop.sh include-tests N    - Run build loop with tests for max N iterations
#
# Models:
#   Build/plan iterations use Opus 4.6 (--model opus) for complex reasoning.
#   Visual inspection uses Haiku 4.5 (--model haiku) for cost-effective image analysis.
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
BUILD_MODEL="opus"
VISUAL_MODEL="haiku"
HARD_TIMEOUT=2700  # 45min safety net (should never hit with stream-json detection)

# Absolute paths
# - SCRIPT_DIR: where loop.sh + PROMPT_*.md live (this directory)
# - PROJECT_DIR: the asr repo to run against; override with PROJECT_DIR=...
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$HOME/projects/aks}"
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
cleanup_orphan_claude_processes

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

# Parse arguments
for arg in "$@"; do
    if [ "$arg" = "plan" ]; then
        MODE="plan"
    elif [ "$arg" = "include-tests" ]; then
        INCLUDE_TESTS=true
    elif [ "$arg" -eq "$arg" ] 2>/dev/null; then
        MAX_ITERATIONS=$arg
    fi
done

echo "=== ASR Ralph Loop ==="
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

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Iteration $ITERATION — $(date)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # Show next bead to work on (mirrors PROMPT_build.md logic: in_progress first, then ready)
    if [ "$HAS_BEADS" = true ]; then
        echo ""
        IN_PROGRESS=$(cd "$PROJECT_DIR" && bd list --status=in_progress 2>/dev/null | grep -E '^[○◐●✓❄]' | head -1)
        if [ -n "$IN_PROGRESS" ]; then
            echo "Resuming in-progress bead:"
            echo "  $IN_PROGRESS"
        else
            echo "Next ready bead:"
            cd "$PROJECT_DIR" && bd ready 2>/dev/null | head -1 || echo "  (could not fetch beads)"
        fi
        echo ""
    fi

    # Phase 1: Build/plan with Opus 4.6
    # Uses stream-json to detect completion and kill hung process (GitHub #19060 fix)
    echo "  Phase 1: Build ($BUILD_MODEL)"
    set +e
    run_claude_with_completion_detection "$PROMPT_FILE" "$BUILD_MODEL" "$TEMP_OUTPUT"
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
                EXISTING_E2E=$(cd "$PROJECT_DIR" && bd list --status=open 2>/dev/null | grep -c "E2E:" || echo "0")
                if [ "${EXISTING_E2E}" -lt 5 ]; then
                    E2E_TAIL=$(tail -3 "$E2E_LOG")
                    cd "$PROJECT_DIR" && bd create \
                        --title="E2E: pnpm test:e2e failed in iteration $ITERATION" \
                        --type=bug \
                        --priority=1 \
                        --labels="e2e,docker" \
                        --description="Exit $E2E_EXIT. Tail:\n$E2E_TAIL" 2>/dev/null || true
                    echo "  Filed bead for E2E failure"
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
        echo "  Phase 2: Visual inspection of @asr/web ($VISUAL_MODEL)"
        VISUAL_START=$(date +%s)
        set +e
        run_claude_with_completion_detection "$VISUAL_PROMPT_FILE" "$VISUAL_MODEL" "$TEMP_OUTPUT"
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

#!/bin/bash
# =============================================================================
# Agent Test Harness CLI
#
# Diagnostic tool for testing agent behavior from the command line.
# Wraps vitest to run the agent harness with structured input/output.
#
# Usage:
#   ./scripts/agent-harness/cli.sh playbook <thought-json>
#   ./scripts/agent-harness/cli.sh tools [tool-name]
#   ./scripts/agent-harness/cli.sh tool-exec <tool-name> [args-json] [mock-ipc-json]
#   ./scripts/agent-harness/cli.sh scenarios
#   ./scripts/agent-harness/cli.sh scenario <pattern>
#
# Examples:
#   # Test which playbook matches a multi-modal analysis request
#   ./scripts/agent-harness/cli.sh playbook '{
#     "understanding": "Analyze lyrics from audio and video",
#     "requirements": ["transcription", "visual analysis", "OCR"],
#     "approach": "Speech-to-text and screen text detection"
#   }'
#
#   # List all registered tools
#   ./scripts/agent-harness/cli.sh tools
#
#   # Check a specific tool
#   ./scripts/agent-harness/cli.sh tools auto_transcribe
#
#   # Execute a tool with mock backend
#   ./scripts/agent-harness/cli.sh tool-exec auto_transcribe '{"assetId":"test123"}'
#
#   # Run all QA regression scenarios
#   ./scripts/agent-harness/cli.sh scenarios
#
#   # Run a specific QA scenario by pattern
#   ./scripts/agent-harness/cli.sh scenario "QA-001"
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$PROJECT_DIR"

MODE="${1:-help}"
shift || true

run_harness() {
  local mode="$1"
  local input="$2"
  local test_filter="${3:-}"

  local filter_args=""
  if [[ -n "$test_filter" ]]; then
    filter_args="-t $test_filter"
  fi

  HARNESS_MODE="$mode" \
  HARNESS_INPUT="$input" \
  npx vitest run scripts/agent-harness/harness.test.ts \
    $filter_args \
    --reporter=verbose \
    2>&1
}

case "$MODE" in
  playbook)
    THOUGHT_JSON="${1:-}"
    if [[ -z "$THOUGHT_JSON" ]]; then
      echo "Error: playbook mode requires a thought JSON argument"
      echo "Usage: $0 playbook '{\"understanding\":\"...\",\"requirements\":[...],\"approach\":\"...\"}'"
      exit 1
    fi

    INPUT=$(printf '{"thought":%s}' "$THOUGHT_JSON")
    run_harness "playbook" "$INPUT" "Playbook"
    ;;

  tools)
    TOOL_NAME="${1:-}"
    if [[ -n "$TOOL_NAME" ]]; then
      INPUT="{\"toolName\":\"${TOOL_NAME}\"}"
    else
      INPUT="{}"
    fi
    run_harness "tools" "$INPUT" "Tool Diagnostic"
    ;;

  tool-exec)
    TOOL_NAME="${1:-}"
    TOOL_ARGS="${2:-}"
    MOCK_IPC="${3:-}"

    if [[ -z "$TOOL_NAME" ]]; then
      echo "Error: tool-exec mode requires a tool name"
      echo "Usage: $0 tool-exec <tool-name> [args-json] [mock-ipc-json]"
      exit 1
    fi

    # Build JSON using node to avoid shell escaping issues with braces
    INPUT=$(node -p "JSON.stringify({
      toolName: '$TOOL_NAME',
      args: ${TOOL_ARGS:-'{}'},
      mockIpc: ${MOCK_IPC:-'{}'}
    })")
    run_harness "tool-exec" "$INPUT" "Tool Execution"
    ;;

  scenarios)
    run_harness "scenarios" "{}" "QA Scenarios"
    ;;

  scenario)
    PATTERN="${1:-}"
    if [[ -z "$PATTERN" ]]; then
      echo "Error: scenario mode requires a pattern"
      echo "Usage: $0 scenario <pattern>"
      echo "Examples: $0 scenario QA-001"
      exit 1
    fi
    run_harness "scenarios" "{}" "$PATTERN"
    ;;

  help|--help|-h)
    echo "Agent Test Harness - Diagnostic tool for agent behavior"
    echo ""
    echo "Usage: $0 <mode> [args...]"
    echo ""
    echo "Modes:"
    echo "  playbook <thought-json>    Test playbook matching against a Thought"
    echo "  tools [tool-name]          List tools or inspect a specific tool"
    echo "  tool-exec <name> [args]    Execute a tool with mock backend"
    echo "  scenarios                  Run all QA regression scenarios"
    echo "  scenario <pattern>         Run scenarios matching a pattern"
    echo ""
    echo "Quick examples:"
    echo "  $0 scenarios"
    echo "  $0 scenario QA-001"
    echo "  $0 tools auto_transcribe"
    echo "  $0 playbook '{\"understanding\":\"Add subtitles\",\"requirements\":[\"transcription\"],\"approach\":\"Auto-caption\"}'"
    ;;

  *)
    echo "Unknown mode: $MODE"
    echo "Run '$0 help' for usage information"
    exit 1
    ;;
esac

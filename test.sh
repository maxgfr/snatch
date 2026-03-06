#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# snatch test suite
# Run: ./test.sh
# ============================================================================

SCRIPT="./download.sh"
PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

assert_exit() {
  local desc="$1" expected="$2"
  shift 2
  local actual
  set +e
  "$@" &>/dev/null
  actual=$?
  set -e
  if [ "$actual" -eq "$expected" ]; then
    echo -e "${GREEN}PASS${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}FAIL${NC} $desc (expected exit $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

assert_output() {
  local desc="$1" pattern="$2"
  shift 2
  local output
  set +e
  output=$("$@" 2>&1)
  set -e
  if echo "$output" | grep -qE "$pattern"; then
    echo -e "${GREEN}PASS${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}FAIL${NC} $desc (pattern '$pattern' not found in output)"
    FAIL=$((FAIL + 1))
  fi
}

assert_stderr() {
  local desc="$1" pattern="$2"
  shift 2
  local output
  set +e
  output=$("$@" 2>&1 >/dev/null)
  set -e
  if echo "$output" | grep -qE "$pattern"; then
    echo -e "${GREEN}PASS${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}FAIL${NC} $desc (pattern '$pattern' not found in stderr)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== snatch CLI tests ==="
echo ""

# --- Version / Help --------------------------------------------------------

assert_output "--version prints version" "^snatch [0-9]+\.[0-9]+\.[0-9]+" \
  bash "$SCRIPT" --version

assert_output "-v prints version" "^snatch [0-9]+\.[0-9]+\.[0-9]+" \
  bash "$SCRIPT" -v

assert_exit "--help exits 0" 0 \
  bash "$SCRIPT" --help

assert_output "--help shows usage" "Usage:" \
  bash "$SCRIPT" --help

assert_output "--help shows all flags" "\-\-dry-run" \
  bash "$SCRIPT" --help

assert_output "--help shows --cookies" "\-\-cookies" \
  bash "$SCRIPT" --help

assert_output "--help shows --quality" "\-\-quality" \
  bash "$SCRIPT" --help

assert_output "--help shows --verbose" "\-\-verbose" \
  bash "$SCRIPT" --help

# --- Argument validation ---------------------------------------------------

assert_exit "no args exits non-zero" 1 \
  bash "$SCRIPT"

assert_output "no args shows error" "Missing URL" \
  bash "$SCRIPT"

assert_exit "unknown flag exits 1" 1 \
  bash "$SCRIPT" --bogus

assert_output "unknown flag shows error" "Unknown option" \
  bash "$SCRIPT" --bogus

assert_exit "-o without value exits 1" 1 \
  bash "$SCRIPT" -o

assert_output "-o without value shows error" "Missing value" \
  bash "$SCRIPT" -o

assert_exit "-q without value exits 1" 1 \
  bash "$SCRIPT" -q

assert_exit "-c without value exits 1" 1 \
  bash "$SCRIPT" -c

# --- Long-form flag aliases ------------------------------------------------

assert_exit "--output without value exits 1" 1 \
  bash "$SCRIPT" --output

assert_exit "--quality without value exits 1" 1 \
  bash "$SCRIPT" --quality

assert_exit "--cookies without value exits 1" 1 \
  bash "$SCRIPT" --cookies

assert_output "--dry-run without URL exits 1" "Missing URL" \
  bash "$SCRIPT" --dry-run

assert_output "--verbose without URL exits 1" "Missing URL" \
  bash "$SCRIPT" --verbose

# --- Node.js syntax check -------------------------------------------------

assert_exit "extract_video_url.mjs syntax valid" 0 \
  node --check extract_video_url.mjs

# --- Summary ---------------------------------------------------------------

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

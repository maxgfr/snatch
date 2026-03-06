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

# --- Helper: source only functions from download.sh (skip main) ------------

source_functions() {
  eval "$(sed 's/^main "\$@"//' "$SCRIPT")"
}

echo "=== snatch CLI tests ==="
echo ""

# --- Version / Help --------------------------------------------------------

echo "-- version & help --"

assert_output "--version prints version" "^snatch [0-9]+\.[0-9]+\.[0-9]+" \
  bash "$SCRIPT" --version

assert_output "-v prints version" "^snatch [0-9]+\.[0-9]+\.[0-9]+" \
  bash "$SCRIPT" -v

assert_exit "--help exits 0" 0 \
  bash "$SCRIPT" --help

assert_output "--help shows usage" "Usage:" \
  bash "$SCRIPT" --help

assert_output "--help shows --dry-run" "\-\-dry-run" \
  bash "$SCRIPT" --help

assert_output "--help shows --cookies" "\-\-cookies" \
  bash "$SCRIPT" --help

assert_output "--help shows --quality" "\-\-quality" \
  bash "$SCRIPT" --help

assert_output "--help shows --verbose" "\-\-verbose" \
  bash "$SCRIPT" --help

assert_output "--help shows --output" "\-\-output" \
  bash "$SCRIPT" --help

assert_output "--help shows examples" "Examples:" \
  bash "$SCRIPT" --help

# --- Argument validation ---------------------------------------------------

echo ""
echo "-- argument validation --"

assert_exit "no args exits 1" 1 \
  bash "$SCRIPT"

assert_output "no args shows error" "Missing URL" \
  bash "$SCRIPT"

assert_exit "unknown flag exits 1" 1 \
  bash "$SCRIPT" --bogus

assert_output "unknown flag shows error" "Unknown option" \
  bash "$SCRIPT" --bogus

assert_exit "multiple unknown flags exits 1" 1 \
  bash "$SCRIPT" --foo --bar

# --- Missing values for flags requiring arguments --------------------------

echo ""
echo "-- missing flag values --"

for flag in -o --output -q --quality -c --cookies; do
  assert_exit "$flag without value exits 1" 1 \
    bash "$SCRIPT" "$flag"
  assert_output "$flag without value shows error" "Missing value" \
    bash "$SCRIPT" "$flag"
done

# --- Flags without URL ----------------------------------------------------

echo ""
echo "-- flags without URL --"

assert_exit "--dry-run without URL exits 1" 1 \
  bash "$SCRIPT" --dry-run

assert_output "--dry-run without URL shows error" "Missing URL" \
  bash "$SCRIPT" --dry-run

assert_exit "--verbose without URL exits 1" 1 \
  bash "$SCRIPT" --verbose

assert_output "--verbose without URL shows error" "Missing URL" \
  bash "$SCRIPT" --verbose

assert_exit "-o val without URL exits 1" 1 \
  bash "$SCRIPT" -o myfile

assert_output "-o val without URL shows error" "Missing URL" \
  bash "$SCRIPT" -o myfile

assert_exit "-q val without URL exits 1" 1 \
  bash "$SCRIPT" -q best

assert_output "-q val without URL shows error" "Missing URL" \
  bash "$SCRIPT" -q best

# --- Version consistency --------------------------------------------------

echo ""
echo "-- version consistency --"

SCRIPT_VERSION=$(grep '^VERSION=' "$SCRIPT" | head -1 | cut -d'"' -f2)
assert_output "--version matches VERSION variable" "^snatch ${SCRIPT_VERSION}$" \
  bash "$SCRIPT" --version

# --- Syntax checks --------------------------------------------------------

echo ""
echo "-- syntax checks --"

assert_exit "download.sh syntax valid" 0 \
  bash -n "$SCRIPT"

assert_exit "extract_video_url.mjs syntax valid" 0 \
  node --check extract_video_url.mjs

# --- Function unit tests (sourced in subshell) -----------------------------

echo ""
echo "-- function unit tests --"

FUNC_RESULTS=$(mktemp)
trap "rm -f $FUNC_RESULTS" EXIT

(
  source_functions

  p=0; f=0

  run_test() {
    local desc="$1" result="$2"
    if [ "$result" = "true" ]; then
      echo -e "${GREEN}PASS${NC} $desc"
      p=$((p + 1))
    else
      echo -e "${RED}FAIL${NC} $desc"
      f=$((f + 1))
    fi
  }

  # --- parse_args ---

  parse_args "https://example.com/video"
  run_test "parse_args sets URL" "$([ "$URL" = "https://example.com/video" ] && echo true || echo false)"

  OUTPUT="" URL=""
  parse_args -o myfile "https://example.com/video"
  run_test "parse_args -o sets OUTPUT" "$([ "$OUTPUT" = "myfile" ] && [ "$URL" = "https://example.com/video" ] && echo true || echo false)"

  QUALITY="" URL=""
  parse_args -q 'bestvideo[height<=720]' "https://example.com/video"
  run_test "parse_args -q sets QUALITY" "$([ "$QUALITY" = 'bestvideo[height<=720]' ] && echo true || echo false)"

  COOKIES="" URL=""
  parse_args -c cookies.txt "https://example.com/video"
  run_test "parse_args -c sets COOKIES" "$([ "$COOKIES" = "cookies.txt" ] && echo true || echo false)"

  DRY_RUN=false URL=""
  parse_args -n "https://example.com/video"
  run_test "parse_args -n sets DRY_RUN" "$($DRY_RUN && echo true || echo false)"

  VERBOSE=false URL=""
  parse_args -d "https://example.com/video"
  run_test "parse_args -d sets VERBOSE" "$($VERBOSE && echo true || echo false)"

  OUTPUT="" QUALITY="" COOKIES="" DRY_RUN=false VERBOSE=false URL=""
  parse_args -o out -q best -c cook.txt -n -d "https://example.com/video"
  run_test "parse_args all flags combined" "$([ "$OUTPUT" = "out" ] && [ "$QUALITY" = "best" ] && [ "$COOKIES" = "cook.txt" ] && $DRY_RUN && $VERBOSE && [ "$URL" = "https://example.com/video" ] && echo true || echo false)"

  OUTPUT="" QUALITY="" COOKIES="" DRY_RUN=false VERBOSE=false URL=""
  parse_args --output out --quality best --cookies cook.txt --dry-run --verbose "https://example.com/video"
  run_test "parse_args long flags" "$([ "$OUTPUT" = "out" ] && [ "$QUALITY" = "best" ] && [ "$COOKIES" = "cook.txt" ] && $DRY_RUN && $VERBOSE && echo true || echo false)"

  # URL before flags
  OUTPUT="" URL=""
  parse_args "https://example.com/video" -o myfile
  run_test "parse_args URL before flags" "$([ "$OUTPUT" = "myfile" ] && [ "$URL" = "https://example.com/video" ] && echo true || echo false)"

  # --- build_ytdlp_args ---

  OUTPUT="" QUALITY="" COOKIES=""
  build_ytdlp_args _t
  args="${_t[*]}"
  run_test "build_ytdlp_args base args" "$(echo "$args" | grep -q "\-\-no-check-certificates" && echo "$args" | grep -q "\-\-concurrent-fragments" && echo true || echo false)"

  OUTPUT="myvid" QUALITY="" COOKIES=""
  build_ytdlp_args _t
  args="${_t[*]}"
  run_test "build_ytdlp_args includes -o with OUTPUT" "$(echo "$args" | grep -q "myvid.%(ext)s" && echo true || echo false)"

  OUTPUT="" QUALITY="best" COOKIES=""
  build_ytdlp_args _t
  args="${_t[*]}"
  run_test "build_ytdlp_args includes -f with QUALITY" "$(echo "$args" | grep -q "\-f best" && echo true || echo false)"

  OUTPUT="" QUALITY="" COOKIES="cookies.txt"
  build_ytdlp_args _t
  args="${_t[*]}"
  run_test "build_ytdlp_args includes --cookies with COOKIES" "$(echo "$args" | grep -q "\-\-cookies cookies.txt" && echo true || echo false)"

  OUTPUT="" QUALITY="" COOKIES=""
  build_ytdlp_args _t
  args="${_t[*]}"
  run_test "build_ytdlp_args omits optional flags when empty" "$( ! echo "$args" | grep -q "\-o " && ! echo "$args" | grep -q "\-f " && ! echo "$args" | grep -q "\-\-cookies" && echo true || echo false)"

  OUTPUT="v" QUALITY="q" COOKIES="c"
  build_ytdlp_args _t
  args="${_t[*]}"
  run_test "build_ytdlp_args all options" "$(echo "$args" | grep -q "v.%(ext)s" && echo "$args" | grep -q "\-f q" && echo "$args" | grep -q "\-\-cookies c" && echo true || echo false)"

  echo "$p $f" > "$FUNC_RESULTS"
) 2>/dev/null

if [ -f "$FUNC_RESULTS" ] && [ -s "$FUNC_RESULTS" ]; then
  read -r sp sf < "$FUNC_RESULTS"
  PASS=$((PASS + sp))
  FAIL=$((FAIL + sf))
fi

# --- Summary ---------------------------------------------------------------

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

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
  # download.sh skips its CLI entrypoint when this is set, so the functions
  # can be loaded as a library. Beats stripping `main "$@"` with sed, which
  # broke the moment that line was indented.
  SNATCH_SOURCE_ONLY=1 . "$SCRIPT"
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
# --- Extraction plan rendering ---------------------------------------------
# `--render` is a pure JSON→argv function with no browser, so it is fully
# testable here. It is the seam download.sh depends on for the Referer, UA and
# cookie jar that make a CDP-extracted URL downloadable.

echo ""
echo "-- extraction plan rendering --"

PLAN_FIXTURE=$(mktemp)
cat > "$PLAN_FIXTURE" <<'PLANEOF'
{
  "version": 1,
  "page_url": "https://site.test/watch/42",
  "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0.0.0 Safari/537.36",
  "cookie_jar": "/tmp/snatch-jar.txt",
  "internal_follow_exhausted": false,
  "candidates": [
    {
      "url": "https://cdn.test/hls/master.m3u8?token=abc",
      "kind": "video", "score": 250, "format": "hls", "manifest": "master",
      "qualities": ["1080p", "720p"], "drm": false,
      "referer": "https://embed.test/e/xyz", "origin": "https://embed.test",
      "frame_url": "https://embed.test/e/xyz", "http_status": 200,
      "content_type": "application/vnd.apple.mpegurl", "verified": "ok",
      "ytdlp_args": ["--referer", "https://embed.test/e/xyz",
                     "--user-agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0.0.0 Safari/537.36",
                     "--add-headers", "Origin:https://embed.test",
                     "--cookies", "/tmp/snatch-jar.txt"]
    },
    {
      "url": "https://cdn.test/hls/dead.m3u8?token=old",
      "kind": "video", "score": -50, "format": "hls", "manifest": null,
      "qualities": [], "drm": true,
      "referer": "https://embed.test/e/xyz", "origin": "https://embed.test",
      "frame_url": "https://embed.test/e/xyz", "http_status": 403,
      "content_type": "text/plain", "verified": "failed",
      "ytdlp_args": ["--referer", "https://embed.test/e/xyz"]
    },
    {
      "url": "IFRAME:https://embed.test/e/xyz",
      "kind": "iframe", "score": 70, "format": "other", "manifest": null,
      "qualities": [], "drm": false, "referer": "", "origin": "",
      "frame_url": "", "http_status": null, "content_type": "",
      "verified": "unverified", "ytdlp_args": []
    }
  ]
}
PLANEOF

RENDER=(node ./extract_video_url.mjs --render "$PLAN_FIXTURE")

assert_output "render list annotates format, manifest and status" \
  "hls master 1080p/720p ✓200" "${RENDER[@]}" list
assert_output "render list marks a failed candidate" \
  "✗403" "${RENDER[@]}" list
assert_output "render list marks an unverified iframe" \
  "\[iframe \?\]" "${RENDER[@]}" list

assert_output "render cmd emits a shell-quoted yt-dlp command" \
  "^yt-dlp .*'--referer' 'https://embed.test/e/xyz'" "${RENDER[@]}" cmd 0
assert_output "render cmd puts the URL last" \
  "'https://cdn.test/hls/master.m3u8\?token=abc'$" "${RENDER[@]}" cmd 0

assert_output "render get reads a candidate field" "^master$" "${RENDER[@]}" get 0 manifest
assert_output "render get joins array fields"      "^1080p 720p$" "${RENDER[@]}" get 0 qualities
assert_output "render get reports DRM"             "^true$" "${RENDER[@]}" get 1 drm
assert_output "render get falls back to plan-level fields" \
  "Chrome/131" "${RENDER[@]}" get 0 user_agent

assert_exit "render rejects a missing plan file" 1 \
  node ./extract_video_url.mjs --render /nonexistent/plan.json args 0
assert_exit "render rejects an out-of-range index" 1 "${RENDER[@]}" args 99
assert_exit "render rejects an unknown mode" 1 "${RENDER[@]}" bogus 0

# The command it prints must be syntactically valid shell, or the "copy this"
# promise of dry-run mode is a lie.
"${RENDER[@]}" cmd 0 > "$PLAN_FIXTURE.cmd"
assert_exit "the rendered command is valid shell" 0 bash -n "$PLAN_FIXTURE.cmd"

# args mode is NUL-separated: a UA full of spaces must survive as ONE argv
# entry. Counting the NULs is the direct check.
NARGS=$("${RENDER[@]}" args 0 | tr -dc '\0' | wc -c | tr -d ' ')
assert_output "render args emits 8 NUL-terminated arguments" "^8$" echo "$NARGS"

rm -f "$PLAN_FIXTURE" "$PLAN_FIXTURE.cmd"

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

  # --- plan helpers -------------------------------------------------------
  # These decide what identity the downloader presents to the CDN, so their
  # failure modes matter more than their happy path.

  PF=$(mktemp)
  cat > "$PF" <<'PLANEOF2'
{
  "version": 1,
  "page_url": "https://site.test/watch/42",
  "user_agent": "UA With Spaces/1.0",
  "cookie_jar": "/tmp/jar.txt",
  "candidates": [
    { "url": "https://cdn.test/master.m3u8", "kind": "video",
      "referer": "https://embed.test/e/xyz", "origin": "https://embed.test",
      "drm": false,
      "ytdlp_args": ["--referer", "https://embed.test/e/xyz",
                     "--user-agent", "UA With Spaces/1.0"] }
  ]
}
PLANEOF2

  URL="https://site.test/watch/42"
  VERBOSE=false
  PLAN_JSON="$PF"

  plan_ytdlp_args _pa 0
  run_test "plan_ytdlp_args uses the frame referer, not the page" \
    "$(echo "${_pa[*]}" | grep -q "https://embed.test/e/xyz" && echo true || echo false)"
  # The UA has spaces; if the NUL transport were broken it would arrive split.
  run_test "plan_ytdlp_args keeps a spaced value as one argument" \
    "$([ "${_pa[3]}" = "UA With Spaces/1.0" ] && echo true || echo false)"

  PLAN_JSON="/nonexistent/plan.json"
  plan_ytdlp_args _pb 0
  run_test "plan_ytdlp_args falls back to the page referer with no plan" \
    "$([ "${_pb[*]}" = "--referer https://site.test/watch/42" ] && echo true || echo false)"

  echo 'this is not json' > "$PF.bad"
  PLAN_JSON="$PF.bad"
  plan_ytdlp_args _pc 0
  run_test "plan_ytdlp_args survives a corrupt plan" \
    "$([ "${_pc[*]}" = "--referer https://site.test/watch/42" ] && echo true || echo false)"

  PLAN_JSON="$PF"
  plan_ytdlp_args _pd 99
  run_test "plan_ytdlp_args falls back on an out-of-range index" \
    "$([ "${_pd[*]}" = "--referer https://site.test/watch/42" ] && echo true || echo false)"

  run_test "plan_get reads a candidate field" \
    "$([ "$(plan_get 0 origin)" = "https://embed.test" ] && echo true || echo false)"

  # cookie_header_for: domain matching is the part that silently leaks or
  # drops cookies if it is wrong.
  JF=$(mktemp)
  printf '# Netscape HTTP Cookie File\n' > "$JF"
  printf 'exact.test\tFALSE\t/\tFALSE\t0\thost_only\tv1\n' >> "$JF"
  printf '.cdn.test\tTRUE\t/\tFALSE\t0\twildcard\tv2\n' >> "$JF"
  printf '#HttpOnly_.cdn.test\tTRUE\t/\tTRUE\t0\thidden\tv3\n' >> "$JF"
  printf 'evil.test\tFALSE\t/\tFALSE\t0\tleak\tv4\n' >> "$JF"
  COOKIE_JAR="$JF"

  H=$(cookie_header_for "https://media.cdn.test/x.m3u8")
  run_test "cookie_header_for matches a dotted parent domain" \
    "$(echo "$H" | grep -q "wildcard=v2" && echo true || echo false)"
  run_test "cookie_header_for includes HttpOnly cookies" \
    "$(echo "$H" | grep -q "hidden=v3" && echo true || echo false)"
  run_test "cookie_header_for excludes unrelated domains" \
    "$(echo "$H" | grep -q "leak=v4" && echo false || echo true)"
  run_test "cookie_header_for excludes a non-matching host-only cookie" \
    "$(echo "$H" | grep -q "host_only=v1" && echo false || echo true)"
  H2=$(cookie_header_for "https://exact.test:8443/x.m3u8")
  run_test "cookie_header_for matches a host-only cookie, ignoring the port" \
    "$(echo "$H2" | grep -q "host_only=v1" && echo true || echo false)"

  # Equal-length unrelated hosts: awk's index() returns 0 when the suffix is
  # absent, and for two names of the same length length(host)-length(d) is
  # also 0 — so a naive arithmetic match hands good.com's cookies to evil.com.
  JF2=$(mktemp)
  printf '# Netscape HTTP Cookie File\n' > "$JF2"
  printf '.good.com\tTRUE\t/\tFALSE\t0\tsid\tsecret\n' >> "$JF2"
  COOKIE_JAR="$JF2"
  run_test "cookie_header_for does not leak to an equal-length foreign domain" \
    "$([ -z "$(cookie_header_for "https://evil.com/video.mp4")" ] && echo true || echo false)"
  run_test "cookie_header_for still matches its own domain" \
    "$(cookie_header_for "https://www.good.com/video.mp4" | grep -q "sid=secret" && echo true || echo false)"

  # A host-only cookie (includeSubdomains FALSE) must not travel to subdomains.
  JF3=$(mktemp)
  printf '# Netscape HTTP Cookie File\n' > "$JF3"
  printf 'example.com\tFALSE\t/\tFALSE\t0\thostonly\tv\n' >> "$JF3"
  printf 'secure.test\tFALSE\t/\tTRUE\t0\tsec\tv\n' >> "$JF3"
  printf 'pathy.test\tFALSE\t/account\tFALSE\t0\tscoped\tv\n' >> "$JF3"
  COOKIE_JAR="$JF3"
  run_test "cookie_header_for honours includeSubdomains=FALSE" \
    "$([ -z "$(cookie_header_for "https://sub.example.com/v.mp4")" ] && echo true || echo false)"
  run_test "cookie_header_for withholds a Secure cookie over http" \
    "$([ -z "$(cookie_header_for "http://secure.test/v.mp4")" ] && echo true || echo false)"
  run_test "cookie_header_for sends a Secure cookie over https" \
    "$(cookie_header_for "https://secure.test/v.mp4" | grep -q "sec=v" && echo true || echo false)"
  run_test "cookie_header_for honours the cookie path" \
    "$([ -z "$(cookie_header_for "https://pathy.test/public/v.mp4")" ] && echo true || echo false)"
  run_test "cookie_header_for sends within the cookie path" \
    "$(cookie_header_for "https://pathy.test/account/v.mp4" | grep -q "scoped=v" && echo true || echo false)"

  COOKIE_JAR="/nonexistent/jar.txt"
  run_test "cookie_header_for is empty with no jar" \
    "$([ -z "$(cookie_header_for "https://cdn.test/x")" ] && echo true || echo false)"

  # A failed download must never be reported as a completed one. Port 1 on
  # loopback refuses instantly, so this stays offline and deterministic.
  DEADPLAN=$(mktemp)
  cat > "$DEADPLAN" <<'DEADEOF'
{
  "version": 1, "page_url": "https://site.test/w", "user_agent": "UA/1.0",
  "cookie_jar": "", "candidates": [
    { "url": "http://127.0.0.1:1/video.mp4", "kind": "video", "drm": false,
      "referer": "https://site.test/w", "origin": "https://site.test",
      "ytdlp_args": ["--referer", "https://site.test/w"] }
  ]
}
DEADEOF
  PLAN_JSON="$DEADPLAN"
  COOKIE_JAR="/nonexistent/jar.txt"
  OUTPUT="deadtest"
  DEAD_TMP=$(mktemp -d)
  # errexit is inherited from download.sh, and a non-zero return is exactly
  # what this asserts, so it has to be off for the call itself.
  set +e
  ( cd "$DEAD_TMP" && download_extracted_url "http://127.0.0.1:1/video.mp4" 0 ) >/dev/null 2>&1
  DEADRC=$?
  set -e
  run_test "a refused mp4 download reports failure, not success" \
    "$([ "$DEADRC" -ne 0 ] && echo true || echo false)"
  run_test "a refused mp4 download leaves no stub file behind" \
    "$([ -z "$(find "$DEAD_TMP" -type f -name 'deadtest.*' 2>/dev/null)" ] && echo true || echo false)"
  OUTPUT=""
  rm -rf "$DEAD_TMP" "$DEADPLAN" "$JF2" "$JF3"

  rm -f "$PF" "$PF.bad" "$JF"

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

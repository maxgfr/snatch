#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# snatch - Universal video downloader
# Tries yt-dlp first, falls back to CDP-based browser extraction
# Dependencies managed via brew (node, ffmpeg, yt-dlp)
# ============================================================================

VERSION="1.6.0"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTRACT_SCRIPT="$SCRIPT_DIR/extract_video_url.mjs"
NODE_PROJECT="$SCRIPT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

OUTPUT=""
DRY_RUN=false
VERBOSE=false
COOKIES=""
QUALITY=""
ALL_SERVERS=false
INTERACTIVE=false

# Extraction plan (JSON) + cookie jar produced by extract_video_url.mjs.
# We allocate both here rather than letting the extractor mktemp them, so the
# files live in paths this script owns and its EXIT trap cleans up — the
# extractor never leaves anything behind. Allocated in main(), because
# extract_with_cdp runs inside a command substitution (a subshell) and any
# assignment made there would be lost.
PLAN_JSON=""
COOKIE_JAR=""
CDP_STDERR=""

# --- Cleanup ---------------------------------------------------------------

TMPFILES=()
cleanup() {
  for f in "${TMPFILES[@]}"; do
    rm -f "$f"
  done
}
trap cleanup EXIT

# --- Logging ---------------------------------------------------------------

log()   { echo -e "${BLUE}[snatch]${NC} $*" >&2; }
ok()    { echo -e "${GREEN}[ok]${NC} $*" >&2; }
warn()  { echo -e "${YELLOW}[!!]${NC} $*" >&2; }
err()   { echo -e "${RED}[err]${NC} $*" >&2; }
debug() { $VERBOSE && echo -e "${BLUE}[debug]${NC} $*" >&2 || true; }

# --- Usage -----------------------------------------------------------------

usage() {
  cat >&2 <<EOF
snatch $VERSION - Universal video downloader

Usage: snatch [options] <URL>

Options:
  -o, --output <name>   Output filename (without extension)
  -q, --quality <fmt>   Quality/format selector (passed to yt-dlp -f)
  -c, --cookies <file>  Cookies file (Netscape format, passed to yt-dlp & CDP)
  -n, --dry-run         Extract video URLs without downloading
  -a, --all-servers     Try every server on streaming sites (slower, finds
                        fallbacks when the default server is dead)
  -i, --interactive     Try every server and prompt for which URL to use
                        (implies -a)
  -d, --verbose         Enable verbose/debug output
  -h, --help            Show this help
  -v, --version         Show version

Examples:
  snatch 'https://youtube.com/watch?v=dQw4w9WgXcQ'
  snatch -o my_video 'https://voe.sx/e/abc123'
  snatch -n 'https://example.com/video'
  snatch -q 'bestvideo[height<=720]+bestaudio' 'https://youtube.com/watch?v=...'
  snatch -c cookies.txt 'https://premium-site.com/video'
  snatch -i 'https://streamer.com/episode'   # pick a server interactively
EOF
  exit 0
}

usage_short() {
  err "Run 'snatch --help' for usage."
  exit 1
}

# --- Argument parsing ------------------------------------------------------

URL=""

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help) usage ;;
      -v|--version) echo "snatch $VERSION"; exit 0 ;;
      -o|--output)
        if [[ $# -lt 2 ]]; then err "Missing value for $1"; exit 1; fi
        OUTPUT="$2"; shift 2 ;;
      -q|--quality)
        if [[ $# -lt 2 ]]; then err "Missing value for $1"; exit 1; fi
        QUALITY="$2"; shift 2 ;;
      -c|--cookies)
        if [[ $# -lt 2 ]]; then err "Missing value for $1"; exit 1; fi
        COOKIES="$2"; shift 2 ;;
      -n|--dry-run) DRY_RUN=true; shift ;;
      -a|--all-servers) ALL_SERVERS=true; shift ;;
      -i|--interactive) INTERACTIVE=true; ALL_SERVERS=true; shift ;;
      -d|--verbose) VERBOSE=true; shift ;;
      -*) err "Unknown option: $1"; usage_short ;;
      *) URL="$1"; shift ;;
    esac
  done
  if [[ -z "$URL" ]]; then
    err "Missing URL. Run 'snatch --help' for usage."
    exit 1
  fi
}

# --- Dependency check & install -------------------------------------------

check_brew() {
  if ! command -v brew &>/dev/null; then
    err "Homebrew not found. Install it: https://brew.sh"
    exit 1
  fi
}

ensure_dep() {
  local cmd="$1" pkg="${2:-$1}"
  if ! command -v "$cmd" &>/dev/null; then
    warn "$cmd not found, installing via brew..."
    brew install "$pkg"
  fi
}

ensure_deps() {
  check_brew
  ensure_dep ffmpeg
  ensure_dep yt-dlp
  ensure_dep node

  if [ ! -d "$NODE_PROJECT/node_modules/ws" ]; then
    log "Installing ws dependency..."
    (cd "$NODE_PROJECT" && npm install --silent) 2>&1 | tail -1 >&2
  fi
}

# --- Common yt-dlp args ---------------------------------------------------

build_ytdlp_args() {
  local -n _arr=$1
  _arr=(
    --no-check-certificates
    --no-warnings
    --progress
    --concurrent-fragments 4
    --retries 20
    --fragment-retries 30
    --retry-sleep "linear=1:5:1"
    --retry-sleep "fragment:linear=1:5:1"
  )
  if [ -n "$OUTPUT" ]; then
    _arr+=(-o "${OUTPUT}.%(ext)s")
  fi
  if [ -n "$QUALITY" ]; then
    _arr+=(-f "$QUALITY")
  fi
  if [ -n "$COOKIES" ]; then
    _arr+=(--cookies "$COOKIES")
  fi
}

# --- Download logic --------------------------------------------------------

try_ytdlp() {
  local url="$1"
  log "Trying yt-dlp..."

  local ytdlp_args=()
  build_ytdlp_args ytdlp_args

  debug "yt-dlp ${ytdlp_args[*]} $url"

  # Peek at what yt-dlp would download before committing. If yt-dlp's
  # generic extractor is about to pull a YouTube trailer from a non-YouTube
  # page (common on streaming aggregators that embed a trailer iframe),
  # skip yt-dlp and fall through to CDP extraction instead.
  local peek
  peek=$(yt-dlp --no-check-certificates --no-warnings -g "$url" 2>/dev/null | head -5) || peek=""
  if [ -n "$peek" ]; then
    if ! echo "$url" | grep -qiE '(youtube\.com|youtu\.be)' \
       && echo "$peek" | grep -qi 'googlevideo\.com\|youtube\.com'; then
      warn "yt-dlp returned a YouTube URL for a non-YouTube page (likely a trailer) — skipping to CDP extraction"
      return 1
    fi
  fi

  if yt-dlp "${ytdlp_args[@]}" "$url"; then
    return 0
  fi
  return 1
}

extract_with_cdp() {
  local url="$1"
  log "yt-dlp failed, extracting video URL with CDP..."

  # Reuse the caller-owned scratch file. A mktemp here would be registered in
  # TMPFILES inside a command-substitution subshell, so the EXIT trap would
  # never see it and the file — which holds verbose signed URLs — would be
  # left in /tmp. Each `2>` redirection truncates, so one file serves every hop.
  local stderr_output="${CDP_STDERR:-}"
  if [ -z "$stderr_output" ]; then stderr_output=$(mktemp); fi

  local env_args=()
  if $VERBOSE; then env_args+=(SNATCH_VERBOSE=1); fi
  if [ -n "$COOKIES" ]; then env_args+=(SNATCH_COOKIES="$COOKIES"); fi
  if $ALL_SERVERS; then env_args+=(SNATCH_ALL_SERVERS=1); fi
  # Ask the extractor for the full plan: per-URL Referer/Origin of the frame
  # that actually fetched it, plus the browser's cookie jar. Each iframe hop
  # below reuses these same paths, so the last hop — the one that produced
  # the URLs we return — is the one whose context we keep.
  if [ -n "$PLAN_JSON" ]; then env_args+=(SNATCH_JSON_OUT="$PLAN_JSON"); fi
  if [ -n "$COOKIE_JAR" ]; then env_args+=(SNATCH_COOKIE_JAR="$COOKIE_JAR"); fi

  local result
  if [ ${#env_args[@]} -gt 0 ]; then
    result=$(env "${env_args[@]}" node "$EXTRACT_SCRIPT" "$url" 2>"$stderr_output") || true
  else
    result=$(node "$EXTRACT_SCRIPT" "$url" 2>"$stderr_output") || true
  fi

  if [ -f "$stderr_output" ]; then
    local errmsg
    errmsg=$(cat "$stderr_output")

    if $VERBOSE && [ -n "$errmsg" ]; then
      debug "CDP stderr output:"
      echo "$errmsg" >&2
    fi

    # Diagnostic error codes — only trust them when no URLs were extracted.
    # Site pages routinely include `401`/`403` as substrings in tokens, ASNs,
    # timestamps, and debug URLs; matching those as auth failures while real
    # URLs are being returned is a false positive.
    if [ -z "$result" ]; then
      if echo "$errmsg" | grep -qi "BRAVE_SHIELDS_BLOCK\|ERR_BLOCKED_BY_CLIENT"; then
        err "Brave Shields blocked this streaming-embed host"
        warn "Brave's built-in adblocker can't be disabled via CLI. Install Chromium and retry:"
        warn "  brew install --cask chromium"
        warn "Or set SNATCH_CHROME=/path/to/another/chromium-browser"
        return 1
      fi
      if echo "$errmsg" | grep -qi "CAPTCHA_REQUIRED"; then
        err "This site requires a captcha"
        warn "Export cookies from your browser and use: snatch -c cookies.txt '$url'"
        warn "Tip: use a browser extension like 'Get cookies.txt LOCALLY' to export cookies"
        return 1
      fi
      if echo "$errmsg" | grep -qi "unauthorized\|forbidden\|HTTP/[12][^0-9]*40[13]"; then
        err "This site requires authentication"
        return 1
      fi
      if echo "$errmsg" | grep -qi "paywall\|premium\|subscribe"; then
        err "Premium content, login required"
        return 1
      fi
      if echo "$errmsg" | grep -qi "widevine\|encrypted.*media"; then
        err "DRM-protected content cannot be downloaded"
        return 1
      fi
      if echo "$errmsg" | grep -qi "timeout\|timed.out"; then
        err "Page took too long to load"
        return 1
      fi
    fi
  fi

  if [ -z "$result" ]; then
    return 1
  fi

  # Handle iframe results (recursive extraction, up to 3 levels deep).
  # Embed hosts often chain (site → embed gateway → final player) so allow
  # several hops before giving up.
  local current_url="$url"
  local depth=0
  local max_depth=3
  local first_line
  first_line=$(echo "$result" | head -1)

  # If the extractor already followed the chain internally in its existing
  # Chrome session (cookies preserved) and still came back with only an
  # IFRAME: result, do not re-spawn a pristine Chrome to repeat the dead
  # chain. The token URLs would just fail again and the user gets a
  # confusing duplicate error.
  if grep -q "INTERNAL_FOLLOW_EXHAUSTED" "$stderr_output" 2>/dev/null; then
    if [[ "$first_line" == IFRAME:* ]]; then
      err "No video found (followed embed chain in same browser session)"
      return 1
    fi
  fi

  while [[ "$first_line" == IFRAME:* && $depth -lt $max_depth ]]; do
    local iframe_url="${first_line#IFRAME:}"
    if [[ "$iframe_url" == //* ]]; then
      iframe_url="https:$iframe_url"
    elif [[ "$iframe_url" == /* ]]; then
      local base
      base=$(echo "$current_url" | grep -oE 'https?://[^/]+')
      iframe_url="${base}${iframe_url}"
    fi
    warn "Following iframe (depth $((depth+1))): $iframe_url"
    # Same file, truncated per hop — see the note above about subshell TMPFILES.
    local next_stderr="$stderr_output"
    # Build a fresh env-arg array that also includes SNATCH_REFERER, so embed
    # hosts (cloudnestra, vidsrc, streamtape, …) that enforce referer checks
    # or Cloudflare challenges don't 403 the recursion.
    local iframe_env=("${env_args[@]}" "SNATCH_REFERER=$current_url")
    result=$(env "${iframe_env[@]}" node "$EXTRACT_SCRIPT" "$iframe_url" 2>"$next_stderr") || true
    if $VERBOSE && [ -s "$next_stderr" ]; then
      debug "CDP stderr (iframe depth $((depth+1))):"
      cat "$next_stderr" >&2
    fi
    if [ -z "$result" ]; then
      if grep -qi "BRAVE_SHIELDS_BLOCK\|ERR_BLOCKED_BY_CLIENT" "$next_stderr" 2>/dev/null; then
        err "Brave Shields blocked the embed host: $iframe_url"
        warn "Brave's built-in adblocker can't be disabled via CLI. Install Chromium:"
        warn "  brew install --cask chromium"
        warn "Or set SNATCH_CHROME=/path/to/another/chromium-browser"
      fi
      return 1
    fi
    current_url="$iframe_url"
    first_line=$(echo "$result" | head -1)
    depth=$((depth + 1))
  done

  if [[ "$first_line" == IFRAME:* ]]; then
    err "Iframe nesting exceeded max depth ($max_depth)"
    return 1
  fi

  echo "$result"
  return 0
}

# --- Extraction plan helpers ----------------------------------------------
# The plan is what makes a CDP-extracted URL actually downloadable: the
# Referer/Origin of the *frame that fetched it* (for a nested embed that is
# the embed host, not the page the user typed), the Chrome UA the token was
# issued to, and the session cookie jar. Reading it goes through the
# extractor's `--render` mode so bash never parses JSON and `jq` stays out of
# the dependency list.

have_plan() { [ -n "$PLAN_JSON" ] && [ -s "$PLAN_JSON" ]; }

# plan_get <index> <field> — prints the value, empty when unavailable.
plan_get() {
  have_plan || return 0
  node "$EXTRACT_SCRIPT" --render "$PLAN_JSON" get "$1" "$2" 2>/dev/null || true
}

# plan_ytdlp_args <array-name> <index> — fills the array with the yt-dlp args
# for that candidate. NUL-separated on the wire so URLs and header values
# survive any quoting. Falls back to the pre-plan behaviour (source page as
# Referer) whenever there's no usable plan — the extractor may have died
# before writing one.
plan_ytdlp_args() {
  local -n _pargs=$1
  local index="$2"
  _pargs=()
  if have_plan; then
    while IFS= read -r -d '' a; do
      _pargs+=("$a")
    done < <(node "$EXTRACT_SCRIPT" --render "$PLAN_JSON" args "$index" 2>/dev/null)
  fi
  if [ ${#_pargs[@]} -eq 0 ]; then
    debug "No plan args for candidate $index — falling back to page referer"
    _pargs=(--referer "$URL")
  fi
}

# Build a `Cookie: a=b; c=d` header for <url> out of the Netscape jar, so the
# curl and ffmpeg fallbacks present the same session as yt-dlp does via
# --cookies. Matches a cookie domain against the host, honouring the leading
# dot for subdomains.
cookie_header_for() {
  local target="$1" host scheme path
  [ -s "$COOKIE_JAR" ] || return 0
  scheme=$(printf '%s' "$target" | sed -E 's#^([a-zA-Z]+)://.*#\1#')
  host=$(printf '%s' "$target" | sed -E 's#^[a-zA-Z]+://([^/]+).*#\1#')
  host="${host%%:*}"
  path=$(printf '%s' "$target" | sed -E 's#^[a-zA-Z]+://[^/]*##; s#[?#].*##')
  [ -n "$path" ] || path="/"
  awk -v host="$host" -v scheme="$scheme" -v path="$path" '
    /^#HttpOnly_/ { sub(/^#HttpOnly_/, "") }
    /^#/ { next }
    NF < 7 { next }
    {
      d = $1; sub(/^\./, "", d)
      ok = 0
      if (host == d) {
        ok = 1
      } else if ($2 == "TRUE") {
        # Parent-domain match, and ONLY when the cookie opted into
        # subdomains. index() returns 0 when the suffix is absent, which for
        # two equal-length names also equals length(host)-length(d) — that
        # arithmetic alone would hand good.com cookies to evil.com.
        pos = index(host, "." d)
        if (pos > 0 && pos == length(host) - length(d)) ok = 1
      }
      if (!ok) next
      if ($4 == "TRUE" && scheme != "https") next   # Secure: https only
      p = $3; if (p == "") p = "/"
      if (substr(path, 1, length(p)) != p) next     # path prefix, RFC 6265
      printf "%s%s=%s", (n++ ? "; " : ""), $6, $7
    }
  ' FS='\t' "$COOKIE_JAR"
}

download_extracted_url() {
  local video_url="$1"
  local index="${2:-0}"

  # Refuse early on real DRM rather than letting yt-dlp grind through
  # fragments and fail with an opaque error.
  if [ "$(plan_get "$index" drm)" = "true" ]; then
    err "DRM-protected content cannot be downloaded"
    return 1
  fi

  local ytdlp_args=()
  build_ytdlp_args ytdlp_args

  local plan_args=()
  plan_ytdlp_args plan_args "$index"
  ytdlp_args+=("${plan_args[@]}")

  # Same identity for the curl / ffmpeg fallbacks: a CDN that checks Referer
  # usually checks Origin and User-Agent too, and a mismatch between our three
  # downloaders would make failures impossible to reason about.
  local referer origin user_agent
  referer=$(plan_get "$index" referer)
  [ -n "$referer" ] || referer="$URL"
  origin=$(plan_get "$index" origin)
  user_agent=$(plan_get "$index" user_agent)

  # When the user didn't pass -o, the generic extractor would use the raw m3u8
  # URL (with query string) as title — that blows past the 255-byte filename
  # limit. Force a sane template derived from the source page.
  if [ -z "$OUTPUT" ]; then
    ytdlp_args+=(-o "%(extractor)s-%(id).100B.%(ext)s")
  fi

  debug "Downloading extracted URL: $video_url (referer: $referer)"

  # Try yt-dlp on the extracted URL first (handles m3u8 well)
  if yt-dlp "${ytdlp_args[@]}" "$video_url"; then
    return 0
  fi

  local cookie_hdr
  cookie_hdr=$(cookie_header_for "$video_url")

  # Fallback: direct download with curl for mp4
  if [[ "$video_url" == *.mp4* ]]; then
    local fname="${OUTPUT:-video}.mp4"
    log "Falling back to curl..."
    local curl_args=(-L --progress-bar -o "$fname" -e "$referer")
    if [ -n "$user_agent" ]; then curl_args+=(-A "$user_agent"); fi
    if [ -n "$origin" ]; then curl_args+=(-H "Origin: $origin"); fi
    if [ -n "$cookie_hdr" ]; then curl_args+=(-H "Cookie: $cookie_hdr"); fi
    # `return $?` after the file-type check would return the *if statement's*
    # status, which is 0 when the check simply doesn't match — so a failed
    # curl used to be reported as a completed download.
    if ! curl "${curl_args[@]}" "$video_url"; then
      warn "curl failed to download the URL"
      rm -f "$fname"
      return 1
    fi
    # Verify the downloaded file is actually a video, not HTML
    if file "$fname" 2>/dev/null | grep -qi "html\|text"; then
      warn "Downloaded file is HTML, not a video — URL may be a player page"
      rm -f "$fname"
      return 1
    fi
    return 0
  fi

  # Fallback: ffmpeg for m3u8/mpd
  if [[ "$video_url" == *m3u8* ]] || [[ "$video_url" == *mpd* ]]; then
    local fname="${OUTPUT:-video}.mp4"
    log "Falling back to ffmpeg..."
    local hdrs="Referer: ${referer}"$'\r\n'
    if [ -n "$origin" ]; then hdrs+="Origin: ${origin}"$'\r\n'; fi
    if [ -n "$cookie_hdr" ]; then hdrs+="Cookie: ${cookie_hdr}"$'\r\n'; fi
    local ff_args=(-y -headers "$hdrs")
    if [ -n "$user_agent" ]; then ff_args+=(-user_agent "$user_agent"); fi
    ffmpeg "${ff_args[@]}" -i "$video_url" -c copy -bsf:a aac_adtstoasc "$fname" 2>&1 | tail -5
    return $?
  fi

  return 1
}

# --- Main ------------------------------------------------------------------

main() {
  parse_args "$@"
  local url="$URL"

  ensure_deps

  # Allocate the plan + cookie-jar paths here rather than inside
  # extract_with_cdp: that function runs in a command substitution, i.e. a
  # subshell, where both the assignments and the TMPFILES registration would
  # be discarded on return.
  PLAN_JSON=$(mktemp)
  COOKIE_JAR=$(mktemp)
  CDP_STDERR=$(mktemp)
  TMPFILES+=("$PLAN_JSON" "$CDP_STDERR")
  # In dry-run the whole point is a command the user can paste later, so the
  # jar it references has to outlive us. Everywhere else it is scratch.
  if ! $DRY_RUN; then
    TMPFILES+=("$COOKIE_JAR")
  fi

  # Dry-run mode: extract URLs without downloading
  if $DRY_RUN; then
    log "Dry-run mode: extracting URLs only"

    local ytdlp_urls=""
    ytdlp_urls=$(yt-dlp --no-check-certificates --no-warnings -g "$url" 2>/dev/null) || true

    # Reject yt-dlp output if it's a YouTube URL and the input page isn't
    # YouTube — that's the generic extractor pulling a trailer iframe.
    if [ -n "$ytdlp_urls" ]; then
      if ! echo "$url" | grep -qiE '(youtube\.com|youtu\.be)' \
         && echo "$ytdlp_urls" | grep -qi 'googlevideo\.com\|youtube\.com'; then
        warn "yt-dlp returned a YouTube URL for a non-YouTube page (likely a trailer) — ignoring"
        ytdlp_urls=""
      fi
    fi

    local extracted=""
    extracted=$(extract_with_cdp "$url") || true

    if [ -n "$ytdlp_urls" ]; then
      log "URLs from yt-dlp:"
      echo "$ytdlp_urls"
    fi
    if [ -n "$extracted" ]; then
      log "URLs from CDP extraction:"
      echo "$extracted"

      # A bare URL is rarely enough: the signed token is bound to the embed
      # host's Referer, the Chrome UA and the session cookies. Hand the user
      # the exact command that reproduces what snatch would run.
      if have_plan; then
        local cmd
        cmd=$(node "$EXTRACT_SCRIPT" --render "$PLAN_JSON" cmd 0 2>/dev/null) || cmd=""
        if [ -n "$cmd" ]; then
          log "Ready-to-run yt-dlp command:"
          echo "$cmd"
        fi
        log "Full extraction plan (JSON):"
        cat "$PLAN_JSON"
        if [ -s "$COOKIE_JAR" ]; then
          warn "Session cookies kept at $COOKIE_JAR so the command above still works."
          warn "It holds live session cookies — delete it when you're done."
        fi
      fi
    fi
    if [ -z "$ytdlp_urls" ] && [ -z "$extracted" ]; then
      err "No video URL found on this page"
      exit 1
    fi
    exit 0
  fi

  # Step 1: Try yt-dlp directly
  if try_ytdlp "$url"; then
    ok "Download complete!"
    exit 0
  fi

  # Step 2: Extract video URL with CDP
  local extracted
  extracted=$(extract_with_cdp "$url") || true

  if [ -z "$extracted" ]; then
    err "No video URL found on this page"
    exit 1
  fi

  # Interactive picker — list every extracted URL and let the user choose.
  # The index is what matters downstream: plan candidates are emitted in the
  # same order as these lines, so index N indexes both.
  local best_url
  local best_index=0
  if $INTERACTIVE; then
    local -a urls=()
    while IFS= read -r line; do
      if [ -n "$line" ]; then urls+=("$line"); fi
    done <<< "$extracted"

    if [ ${#urls[@]} -eq 0 ]; then
      err "No video URL found on this page"
      exit 1
    fi

    if [ ${#urls[@]} -eq 1 ]; then
      best_url="${urls[0]}"
      log "Only one URL found, using it: $best_url"
    else
      # Prefer the annotated listing from the plan — format, master/variant,
      # qualities, HTTP status. A bare URL tells the user nothing about which
      # server is actually alive.
      local -a labels=()
      if have_plan; then
        while IFS= read -r line; do
          if [ -n "$line" ]; then labels+=("$line"); fi
        done < <(node "$EXTRACT_SCRIPT" --render "$PLAN_JSON" list 2>/dev/null)
      fi
      log "Multiple sources found — pick one to download:"
      local i=1
      for u in "${urls[@]}"; do
        if [ "${#labels[@]}" -ge "$i" ]; then
          echo "  [$i] ${labels[$((i - 1))]}" >&2
        else
          echo "  [$i] $u" >&2
        fi
        i=$((i + 1))
      done
      local choice
      read -rp "Choice [1]: " choice </dev/tty
      choice="${choice:-1}"
      if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt ${#urls[@]} ]; then
        err "Invalid choice: $choice"
        exit 1
      fi
      best_url="${urls[$((choice - 1))]}"
      best_index=$((choice - 1))
    fi
  else
    # Take the best URL (first line = highest priority). Parameter expansion
    # rather than `echo | head -1`: under `set -o pipefail` head closing the
    # pipe early makes echo die of SIGPIPE and the assignment return 141.
    best_url="${extracted%%$'\n'*}"
    # Skip candidates the plan flagged as DRM. Failing on the top one would
    # hide a perfectly downloadable clear stream ranked just below it.
    if have_plan; then
      local n=0 chosen=""
      while IFS= read -r cand; do
        if [ -n "$cand" ] && [ "$(plan_get "$n" drm)" != "true" ]; then
          chosen="$cand"
          best_index="$n"
          break
        fi
        if [ -n "$cand" ]; then
          warn "Skipping DRM-protected candidate $((n + 1))"
        fi
        n=$((n + 1))
      done <<< "$extracted"
      if [ -n "$chosen" ]; then best_url="$chosen"; fi
    fi
  fi

  log "Found video: $best_url"

  # Step 3: Download the extracted URL
  if download_extracted_url "$best_url" "$best_index"; then
    ok "Download complete!"
    exit 0
  fi

  err "All download methods failed."
  warn "Extracted URLs for manual download:"
  echo "$extracted" >&2
  exit 1
}

# Sourcing with SNATCH_SOURCE_ONLY=1 loads the functions without running the
# CLI, so the plan/cookie/header helpers can be unit-tested directly.
if [ "${SNATCH_SOURCE_ONLY:-}" != "1" ]; then
  main "$@"
fi

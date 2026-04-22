#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# snatch - Universal video downloader
# Tries yt-dlp first, falls back to CDP-based browser extraction
# Dependencies managed via brew (node, ffmpeg, yt-dlp)
# ============================================================================

VERSION="1.3.4"

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
  -d, --verbose         Enable verbose/debug output
  -h, --help            Show this help
  -v, --version         Show version

Examples:
  snatch 'https://youtube.com/watch?v=dQw4w9WgXcQ'
  snatch -o my_video 'https://voe.sx/e/abc123'
  snatch -n 'https://example.com/video'
  snatch -q 'bestvideo[height<=720]+bestaudio' 'https://youtube.com/watch?v=...'
  snatch -c cookies.txt 'https://premium-site.com/video'
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

  local stderr_output
  stderr_output=$(mktemp)
  TMPFILES+=("$stderr_output")

  local env_args=()
  if $VERBOSE; then env_args+=(SNATCH_VERBOSE=1); fi
  if [ -n "$COOKIES" ]; then env_args+=(SNATCH_COOKIES="$COOKIES"); fi

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
    local next_stderr
    next_stderr=$(mktemp)
    TMPFILES+=("$next_stderr")
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

download_extracted_url() {
  local video_url="$1"
  local referer="$URL"

  local ytdlp_args=()
  build_ytdlp_args ytdlp_args
  ytdlp_args+=(--referer "$referer")

  debug "Downloading extracted URL: $video_url (referer: $referer)"

  # Try yt-dlp on the extracted URL first (handles m3u8 well)
  if yt-dlp "${ytdlp_args[@]}" "$video_url"; then
    return 0
  fi

  # Fallback: direct download with curl for mp4
  if [[ "$video_url" == *.mp4* ]]; then
    local fname="${OUTPUT:-video}.mp4"
    log "Falling back to curl..."
    curl -L --progress-bar -o "$fname" -e "$referer" "$video_url"
    # Verify the downloaded file is actually a video, not HTML
    if file "$fname" 2>/dev/null | grep -qi "html\|text"; then
      warn "Downloaded file is HTML, not a video — URL may be a player page"
      rm -f "$fname"
      return 1
    fi
    return $?
  fi

  # Fallback: ffmpeg for m3u8/mpd
  if [[ "$video_url" == *m3u8* ]] || [[ "$video_url" == *mpd* ]]; then
    local fname="${OUTPUT:-video}.mp4"
    log "Falling back to ffmpeg..."
    ffmpeg -y -headers "Referer: ${referer}"$'\r\n' -i "$video_url" -c copy -bsf:a aac_adtstoasc "$fname" 2>&1 | tail -5
    return $?
  fi

  return 1
}

# --- Main ------------------------------------------------------------------

main() {
  parse_args "$@"
  local url="$URL"

  ensure_deps

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

  # Take the best URL (first line = highest priority)
  local best_url
  best_url=$(echo "$extracted" | head -1)
  log "Found video: $best_url"

  # Step 3: Download the extracted URL
  if download_extracted_url "$best_url"; then
    ok "Download complete!"
    exit 0
  fi

  err "All download methods failed."
  warn "Extracted URLs for manual download:"
  echo "$extracted" >&2
  exit 1
}

main "$@"

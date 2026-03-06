#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# snatch - Universal video downloader
# Tries yt-dlp first, falls back to CDP-based browser extraction
# Dependencies managed via brew (fnm, uv, ffmpeg, yt-dlp)
# ============================================================================

VERSION="0.0.0"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTRACT_SCRIPT="$SCRIPT_DIR/extract_video_url.mjs"
NODE_PROJECT="$SCRIPT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[snatch]${NC} $*" >&2; }
ok()   { echo -e "${GREEN}[ok]${NC} $*" >&2; }
warn() { echo -e "${YELLOW}[!!]${NC} $*" >&2; }
err()  { echo -e "${RED}[err]${NC} $*" >&2; }

OUTPUT=""

# --- Usage -----------------------------------------------------------------

usage() {
  cat >&2 <<EOF
snatch $VERSION - Universal video downloader

Usage: snatch [options] <URL>

Options:
  -o, --output <name>   Output filename (without extension)
  -h, --help            Show this help
  -v, --version         Show version

Examples:
  snatch 'https://youtube.com/watch?v=dQw4w9WgXcQ'
  snatch -o my_video 'https://voe.sx/e/abc123'
  snatch 'https://absolutondemand.de/film/das-neue-babylon-1929/'
EOF
  exit 0
}

# --- Argument parsing ------------------------------------------------------

URL=""

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help) usage ;;
      -v|--version) echo "snatch $VERSION"; exit 0 ;;
      -o|--output) OUTPUT="$2"; shift 2 ;;
      -*) err "Unknown option: $1"; usage ;;
      *) URL="$1"; shift ;;
    esac
  done
  if [[ -z "$URL" ]]; then
    err "Missing URL"
    usage
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
  ensure_dep fnm
  ensure_dep uv
  ensure_dep ffmpeg
  ensure_dep yt-dlp

  eval "$(fnm env --shell bash 2>/dev/null)" || true
  if ! command -v node &>/dev/null; then
    log "Installing Node.js via fnm..."
    fnm install --lts
    eval "$(fnm env --shell bash)"
  fi

  # Ensure ws is installed for CDP extraction
  if [ ! -d "$NODE_PROJECT/node_modules/ws" ]; then
    log "Installing ws dependency..."
    (cd "$NODE_PROJECT" && npm install --silent) 2>&1 | tail -1 >&2
  fi
}

# --- Download logic --------------------------------------------------------

try_ytdlp() {
  local url="$1"
  log "Trying yt-dlp..."

  local ytdlp_args=(
    --no-check-certificates
    --no-warnings
    --progress
    --concurrent-fragments 4
  )

  if [ -n "$OUTPUT" ]; then
    ytdlp_args+=(-o "${OUTPUT}.%(ext)s")
  fi

  if yt-dlp "${ytdlp_args[@]}" "$url" 2>&1; then
    return 0
  fi
  return 1
}

extract_with_cdp() {
  local url="$1"
  log "yt-dlp failed, extracting video URL with CDP..."

  local result stderr_output
  stderr_output=$(mktemp)
  result=$(node "$EXTRACT_SCRIPT" "$url" 2>"$stderr_output") || true

  # Check stderr for specific errors
  if [ -f "$stderr_output" ]; then
    local errmsg
    errmsg=$(cat "$stderr_output")
    rm -f "$stderr_output"

    if echo "$errmsg" | grep -qi "401\|403\|unauthorized\|forbidden"; then
      err "This site requires authentication"
      return 1
    fi
    if echo "$errmsg" | grep -qi "paywall\|premium\|subscribe"; then
      err "Premium content, login required"
      return 1
    fi
    if echo "$errmsg" | grep -qi "drm\|widevine\|encrypted"; then
      err "DRM-protected content cannot be downloaded"
      return 1
    fi
    if echo "$errmsg" | grep -qi "timeout\|timed.out"; then
      err "Page took too long to load"
      return 1
    fi
  fi

  if [ -z "$result" ]; then
    return 1
  fi

  # Handle iframe results (recursive extraction)
  local first_line
  first_line=$(echo "$result" | head -1)

  if [[ "$first_line" == IFRAME:* ]]; then
    local iframe_url="${first_line#IFRAME:}"
    if [[ "$iframe_url" == //* ]]; then
      iframe_url="https:$iframe_url"
    elif [[ "$iframe_url" == /* ]]; then
      local base
      base=$(echo "$url" | grep -oE 'https?://[^/]+')
      iframe_url="${base}${iframe_url}"
    fi
    warn "Found embedded iframe, extracting from: $iframe_url"
    result=$(node "$EXTRACT_SCRIPT" "$iframe_url" 2>/dev/null) || true
    if [ -z "$result" ]; then
      return 1
    fi
    first_line=$(echo "$result" | head -1)
    if [[ "$first_line" == IFRAME:* ]]; then
      err "Nested iframes too deep"
      return 1
    fi
  fi

  echo "$result"
  return 0
}

download_extracted_url() {
  local video_url="$1"

  local ytdlp_args=(
    --no-check-certificates
    --no-warnings
    --progress
    --concurrent-fragments 4
  )
  if [ -n "$OUTPUT" ]; then
    ytdlp_args+=(-o "${OUTPUT}.%(ext)s")
  fi

  # Try yt-dlp on the extracted URL first (handles m3u8 well)
  if yt-dlp "${ytdlp_args[@]}" "$video_url" 2>&1; then
    return 0
  fi

  # Fallback: direct download with curl for mp4
  if [[ "$video_url" == *.mp4* ]]; then
    local fname="${OUTPUT:-video}.mp4"
    log "Falling back to curl..."
    curl -L --progress-bar -o "$fname" "$video_url"
    return $?
  fi

  # Fallback: ffmpeg for m3u8/mpd
  if [[ "$video_url" == *m3u8* ]] || [[ "$video_url" == *mpd* ]]; then
    local fname="${OUTPUT:-video}.mp4"
    log "Falling back to ffmpeg..."
    ffmpeg -y -i "$video_url" -c copy -bsf:a aac_adtstoasc "$fname" 2>&1 | tail -5
    return $?
  fi

  return 1
}

# --- Main ------------------------------------------------------------------

main() {
  parse_args "$@"
  local url="$URL"

  ensure_deps

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

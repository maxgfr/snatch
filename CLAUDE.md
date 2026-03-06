# Snatch - Universal Video Downloader

## Architecture

Two files: a bash orchestrator and a Node.js CDP extractor.

### `download.sh` — Main CLI
- `VERSION` at top (bumped by semantic-release via `.version-hook.sh`)
- Deps auto-installed via brew: `node`, `ffmpeg`, `yt-dlp`
- Flags: `-o/--output`, `-q/--quality`, `-c/--cookies`, `-n/--dry-run`, `-d/--verbose`, `-h/--help`, `-v/--version`
- All options requiring a value have safe `$# -lt 2` check
- Shared yt-dlp args built via `build_ytdlp_args()` (output, quality, cookies)
- Flow:
  1. Try `yt-dlp` directly
  2. If fails → CDP extraction via `extract_video_url.mjs`
  3. Download extracted URL via yt-dlp, curl (mp4), or ffmpeg (m3u8/mpd)
- Referer header passed to all download fallbacks (yt-dlp `--referer`, curl `-e`, ffmpeg `-headers`)
- Error detection from CDP stderr: 401/403, paywall, DRM, timeout
- Dry-run mode: `yt-dlp -g` + CDP extraction, prints URLs without downloading
- Cleanup trap for temp files on exit

### `extract_video_url.mjs` — CDP-based video URL extractor
- **No Playwright** — raw Chrome DevTools Protocol via `ws` WebSocket package
- Isolated Chrome profile per run via `mkdtempSync` (cleaned up on exit)
- CDPClient class with `send()`, `sendToSession()`, `evaluate()`, `on()`, `disconnect()`
- Chrome discovery: macOS paths + Linux paths (`/usr/bin/google-chrome`, `/snap/bin/chromium`, etc.) + `which` fallback
- Env vars: `SNATCH_VERBOSE=1`, `SNATCH_COOKIES=<path>`, `EXTRACT_TIMEOUT=<ms>`
- Cookie injection: parses Netscape-format cookie files, injects via `Network.setCookie`
- Network interception: `Network.responseReceived` + `Network.requestWillBeSent`
- Smart page load: waits for `Page.loadEventFired` (with TIMEOUT fallback) + 2s grace period
- Anti-bot: user-agent override, `navigator.webdriver` spoofing, ad domain blocking via `Network.setBlockedURLs`
- Auto-click: consent banners (14 selectors), play buttons (9 selectors), and server/source selection buttons
- Server button clicking: tries `startPlayer()`, onclick handlers matching streaming patterns, `[data-server]`/`[data-value*="server"]` elements
- Captcha detection: detects captcha forms after server click, outputs `CAPTCHA_REQUIRED` on stderr
- DOM extraction: JWPlayer, Video.js, Plyr, Flowplayer, Clappr, hls.js, dash.js, HTML5 video/audio, iframes
- If no URLs found: polls 6x every 1.5s (network + DOM re-extraction)
- URL filtering: extended `isVideoUrl` patterns (chunklist, media, /hls/, /dash/), junk filter (analytics, tracking pixels)
- Priority: m3u8 > mpd > mp4 > others
- Iframes: outputs `IFRAME:<url>` for bash script to handle recursively

### Project structure
```
download.sh              — Main CLI script
extract_video_url.mjs    — CDP video extractor
package.json             — Only dep: ws
test.sh                  — CLI tests
.github/workflows/release.yml — Semantic release on push to main
.releaserc               — semantic-release config
.version-hook.sh         — Updates VERSION in download.sh during release
LICENSE                   — MIT
README.md                — User-facing docs
```

### Release pipeline
- Push to `main` triggers `.github/workflows/release.yml`
- Uses `cycjimmy/semantic-release-action@v6` with `@semantic-release/exec` + `@semantic-release/git`
- `.version-hook.sh` patches `VERSION=` in `download.sh` via sed
- Commits `download.sh` back with new version, creates GitHub release
- Homebrew tap at `maxgfr/homebrew-tap` auto-updated on release via workflow in that repo

### Homebrew install path
When installed via `brew install maxgfr/tap/snatch`:
- `download.sh` installed as `snatch` in bin
- `extract_video_url.mjs` + `package.json` in libexec, `npm install` runs there
- `SCRIPT_DIR` patched to point to libexec
- Depends on `yt-dlp`, `ffmpeg`, `node` (brew formulae)

## Conventions
- All logs via stderr (`>&2`), only video URLs on stdout
- Color output: red=error, green=ok, yellow=warn, blue=info
- Debug output only when `VERBOSE=true` / `SNATCH_VERBOSE=1`
- No external deps except `ws` npm package
# Snatch - Universal Video Downloader

## Project Context (from previous session)

This project was started in ~/Downloads/download-any-video and is being rebuilt from scratch in ~/Downloads/snatch.

## PLAN - Execute all steps in order

### Step 1: Create the project files

#### 1a. `download.sh` - Main script
Single bash script, universal video downloader. Pattern based on https://github.com/maxgfr/copyable-pdf (check the script.sh for style reference).

Structure:
- `VERSION="0.0.0"` at the top (semantic-release will bump it)
- Deps check/install via `brew`: `fnm`, `uv`, `ffmpeg`, `yt-dlp`
- `fnm` for Node.js (rust-based), `uv` for Python tools (rust-based)
- `--help`, `--version`, `-o/--output` flags
- **Step 1**: Try `yt-dlp` directly (handles YouTube, Twitch, Twitter, 1800+ sites)
- **Step 2**: If yt-dlp fails, use CDP-based extraction (extract_video_url.mjs)
- **Step 3**: Download extracted URL via yt-dlp, fallback curl (mp4) or ffmpeg (m3u8/mpd)
- **Error handling**:
  - Detect 401/403 → "This site requires authentication"
  - Detect paywall/premium → "Premium content, login required"
  - Detect DRM → "DRM-protected content cannot be downloaded"
  - Timeout → "Page took too long to load"
  - No video found → "No video URL found on this page"
  - All logs via `>&2` (stderr), only extracted URLs on stdout

#### 1b. `extract_video_url.mjs` - CDP-based video URL extractor
**DO NOT use Playwright**. Use raw Chrome DevTools Protocol via WebSocket, pattern from https://github.com/maxgfr/leboncoin-cdp-scraper

Key approach:
- Launch Chrome/Chromium with `--headless --remote-debugging-port=0` (random port) and `--user-data-dir=/tmp/snatch-chrome-profile`
- Get CDP WebSocket URL from `http://127.0.0.1:PORT/json/version`
- Connect via `ws` (WebSocket npm package)
- Enable `Network.enable` to intercept all network requests
- Navigate to the URL via `Page.navigate`
- Collect all video URLs from network (m3u8, mp4, mpd, webm)
- Also `Runtime.evaluate` to extract from DOM (video elements, JWPlayer, Video.js, Plyr, Flowplayer APIs)
- Handle iframes (detect embed iframes, extract recursively)
- Priority: m3u8 > mpd > mp4 > others
- Output URLs to stdout, errors to stderr
- Clean up: close tab, kill Chrome process

CDP client (inline, no external dep except `ws`):
```javascript
class CDPClient {
  constructor(ws) { this.ws = ws; this.nextId = 0; this.pending = new Map(); this.events = new Map(); }
  static connect(wsUrl, timeout = 10000) { /* WebSocket connect */ }
  send(method, params = {}, timeout = 60000) { /* send CDP command, return promise */ }
  on(event, handler) { /* subscribe to CDP event */ }
  evaluate(expr) { /* Runtime.evaluate */ }
  disconnect() { /* close */ }
}
```

Dependencies: only `ws` npm package (lightweight WebSocket client).

#### 1c. `package.json`
Minimal: name "snatch", type "module", dependency on `ws` only.

### Step 2: Git init + GitHub repo

```bash
git init
git add -A
git commit -m "feat: initial release - universal video downloader with CDP extraction"
gh repo create maxgfr/snatch --public --source=. --push
gh repo edit maxgfr/snatch --description "Universal video downloader. Tries yt-dlp first, falls back to CDP-based browser extraction for stubborn sites." --homepage ""
gh api -X PUT repos/maxgfr/snatch/topics -f names='["video-downloader","yt-dlp","cdp","chrome-devtools-protocol","streaming","hls","m3u8","cli","bash","homebrew"]'
```

### Step 3: README.md
- Title: snatch
- One-liner description
- Install section (brew, manual)
- Usage examples
- How it works (2-step: yt-dlp → CDP fallback)
- Supported sites
- Badge: version from GitHub releases

### Step 4: Semantic Release (like copyable-pdf)

#### `.github/workflows/release.yml`
```yaml
name: Release
on:
  push:
    branches: [main]
permissions:
  contents: write
  issues: write
  pull-requests: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: cycjimmy/semantic-release-action@v6
        with:
          extra_plugins: |
            @semantic-release/exec
            @semantic-release/git
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

#### `.releaserc`
```json
{
  "branches": ["main"],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/exec", { "prepareCmd": "bash .version-hook.sh ${nextRelease.version}" }],
    ["@semantic-release/git", { "assets": ["download.sh"], "message": "chore(release): ${nextRelease.version}" }],
    "@semantic-release/github"
  ]
}
```

#### `.version-hook.sh`
Updates VERSION in download.sh via sed.

### Step 5: Homebrew Tap

The user has `../homebrew-tap` (i.e. `~/Downloads/homebrew-tap`).

Create `Formula/snatch.rb`:
```ruby
class Snatch < Formula
  desc "Universal video downloader - yt-dlp + CDP browser fallback"
  homepage "https://github.com/maxgfr/snatch"
  url "https://github.com/maxgfr/snatch/archive/refs/tags/v#{version}.tar.gz"
  license "MIT"
  depends_on "yt-dlp"
  depends_on "ffmpeg"
  depends_on "fnm"
  depends_on "node" # for CDP extraction fallback
  def install
    bin.install "download.sh" => "snatch"
    # Install the JS extractor alongside
    libexec.install "extract_video_url.mjs"
    libexec.install "package.json"
    system "npm", "install", "--prefix", libexec
    # Patch script to find extractor in libexec
    inreplace bin/"snatch", 'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"', "SCRIPT_DIR=\"#{libexec}\""
  end
  test do
    assert_match "snatch", shell_output("#{bin}/snatch --version")
  end
end
```

Also add a GitHub Action to auto-update the homebrew formula on new releases:

#### `.github/workflows/homebrew.yml`
Triggers on release published, updates the homebrew-tap repo with new version/sha.

### Step 6: Test

Test with: `./download.sh "https://absolutondemand.de/film/das-neue-babylon-1929/"`

### Step 7: Create LICENSE (MIT)

## Reference repos
- https://github.com/maxgfr/copyable-pdf - for release/CI pattern
- https://github.com/maxgfr/leboncoin-cdp-scraper - for CDP pattern (CDPClient class, browser launch, WebSocket)

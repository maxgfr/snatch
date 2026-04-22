# snatch

Universal video downloader. Tries yt-dlp first, falls back to CDP-based browser extraction for stubborn sites.

[![GitHub Release](https://img.shields.io/github/v/release/maxgfr/snatch)](https://github.com/maxgfr/snatch/releases)

## Install

```bash
brew install maxgfr/tap/snatch
snatch --help
```

Or manually:

```bash
git clone https://github.com/maxgfr/snatch.git
cd snatch
npm install
chmod +x download.sh
./download.sh --help
```

## Usage

```bash
snatch https://youtube.com/watch?v=dQw4w9WgXcQ
```

Options:

```
-o, --output <name>   Output filename (without extension)
-q, --quality <fmt>   Quality/format selector (passed to yt-dlp -f)
-c, --cookies <file>  Cookies file (Netscape format, passed to yt-dlp & CDP)
-n, --dry-run         Extract video URLs without downloading
-d, --verbose         Enable verbose/debug output
-h, --help            Show this help
-v, --version         Show version
```

### Examples

```bash
# Download in 720p max
snatch -q 'bestvideo[height<=720]+bestaudio' 'https://youtube.com/watch?v=dQw4w9WgXcQ'

# Just list found video URLs without downloading
snatch -n 'https://example.com/video-page'

# Use cookies for authenticated sites
snatch -c cookies.txt 'https://premium-site.com/video'

# Debug mode to see what's happening
snatch -d 'https://stubborn-site.com/video'
```

## How it works

1. **yt-dlp** - tries direct download first (supports YouTube, Twitch, Twitter, and 1800+ sites)
2. **CDP fallback** - if yt-dlp fails, launches headless Chrome via raw Chrome DevTools Protocol, intercepts network requests to find video URLs (m3u8, mp4, mpd), extracts from player APIs (JWPlayer, Video.js, Plyr, Flowplayer, Clappr, hls.js, dash.js), and auto-clicks consent/play buttons
3. **Download** - downloads the extracted URL via yt-dlp, curl (mp4), or ffmpeg (m3u8/mpd), with Referer header for CDN compatibility

## Captcha-protected sites

Some streaming sites (e.g. 123movies) require solving a captcha before serving video. Snatch detects this and tells you to use cookies:

```
[err] This site requires a captcha
[!!] Export cookies from your browser and use: snatch -c cookies.txt '<URL>'
```

**How to fix it:**

1. Install a cookie export extension in your browser (e.g. [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc))
2. Visit the site in your browser, solve the captcha, and start playing the video
3. Export cookies to a `cookies.txt` file (Netscape format)
4. Run snatch with the `-c` flag:

```bash
snatch -c cookies.txt 'https://example.com/video-page'
```

The cookies provide your authenticated session so snatch can bypass the captcha.

## Supported sites

Everything yt-dlp supports (1800+ sites), plus any site that loads video via standard HTML5 players or streaming protocols — even those that try to hide their video URLs.

## License

[MIT](LICENSE)

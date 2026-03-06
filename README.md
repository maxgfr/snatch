# snatch

Universal video downloader. Tries yt-dlp first, falls back to CDP-based browser extraction for stubborn sites.

[![GitHub Release](https://img.shields.io/github/v/release/maxgfr/snatch)](https://github.com/maxgfr/snatch/releases)

## Install

```bash
brew tap maxgfr/tap
brew install maxgfr/tap/snatch
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
snatch 'https://youtube.com/watch?v=dQw4w9WgXcQ'
snatch -o my_video 'https://voe.sx/e/abc123'
snatch 'https://absolutondemand.de/film/das-neue-babylon-1929/'
```

Options:

```
-o, --output <name>   Output filename (without extension)
-h, --help            Show help
-v, --version         Show version
```

## How it works

1. **yt-dlp** - tries direct download first (supports YouTube, Twitch, Twitter, and 1800+ sites)
2. **CDP fallback** - if yt-dlp fails, launches headless Chrome via raw Chrome DevTools Protocol, intercepts network requests to find video URLs (m3u8, mp4, mpd), and extracts from player APIs (JWPlayer, Video.js, Plyr, Flowplayer)
3. **Download** - downloads the extracted URL via yt-dlp, curl (mp4), or ffmpeg (m3u8/mpd)

## Supported sites

Everything yt-dlp supports (1800+ sites), plus any site that loads video via standard HTML5 players or streaming protocols — even those that try to hide their video URLs.

## Dependencies

Installed automatically via Homebrew:

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) - video downloader
- [ffmpeg](https://ffmpeg.org/) - media processing
- [fnm](https://github.com/Schniz/fnm) - fast Node.js manager (rust-based)
- [Node.js](https://nodejs.org/) - for CDP browser extraction

## License

MIT

// CDP-based video URL extractor using raw Chrome DevTools Protocol
// No Playwright - uses WebSocket directly via ws package

import { execSync, spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const url = process.argv[2];
if (!url) {
  console.error('Usage: node extract_video_url.mjs <URL>');
  process.exit(1);
}

const TIMEOUT = parseInt(process.env.EXTRACT_TIMEOUT || '30000', 10);
const VERBOSE = process.env.SNATCH_VERBOSE === '1';
const COOKIES_FILE = process.env.SNATCH_COOKIES || '';

const CHROME_PROFILE = mkdtempSync(join(tmpdir(), 'snatch-chrome-'));

const debug = (...args) => {
  if (VERBOSE) console.error('[debug]', ...args);
};

// --- CDP Client -----------------------------------------------------------

class CDPClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.events = new Map();
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        const handlers = this.events.get(msg.method) || [];
        for (const h of handlers) h(msg.params);
      }
    });
  }

  static connect(wsUrl, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('CDP connection timeout'));
      }, timeout);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve(new CDPClient(ws));
      });
      ws.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  send(method, params = {}, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  sendToSession(sessionId, method, params = {}, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(event, handler) {
    if (!this.events.has(event)) this.events.set(event, []);
    this.events.get(event).push(handler);
  }

  async evaluate(sessionId, expr) {
    const result = await this.sendToSession(sessionId, 'Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Evaluation failed');
    }
    return result.result?.value;
  }

  disconnect() {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.ws.close();
  }
}

// --- Find Chrome/Chromium -------------------------------------------------

function findChrome() {
  const paths = [
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
  for (const p of paths) {
    try {
      execSync(`test -f "${p}"`, { stdio: 'ignore' });
      return p;
    } catch {}
  }
  for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      return execSync(`which ${cmd}`, { stdio: 'pipe' }).toString().trim();
    } catch {}
  }
  throw new Error('Chrome/Chromium not found');
}

// --- Launch Chrome --------------------------------------------------------

function launchChrome() {
  const chromePath = findChrome();
  debug('Chrome path:', chromePath);
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-web-security',
    '--disable-features=VizDisplayCompositor',
    '--disable-blink-features=AutomationControlled',
    `--user-data-dir=${CHROME_PROFILE}`,
    '--remote-debugging-port=0',
    '--mute-audio',
    '--window-size=1920,1080',
    '--block-new-web-contents',
    '--disable-popup-blocking=false',
    'about:blank',
  ];

  const proc = spawn(chromePath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error('Chrome launch timeout'));
    }, 15000);

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ proc, wsUrl: match[1] });
      }
    });

    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code) reject(new Error(`Chrome exited with code ${code}`));
    });
  });
}

// --- URL helpers ----------------------------------------------------------

const isVideoUrl = (u) =>
  /\.(m3u8|mp4|webm|mkv|ts|mpd)(\?|$|&)/i.test(u) ||
  /master\.m3u8|index\.m3u8|playlist\.m3u8|chunklist.*\.m3u8|media.*\.m3u8/i.test(u) ||
  /manifest\.mpd|video.*\.mp4/i.test(u) ||
  /\/hls\/|\/dash\//i.test(u);

const isJunk = (u) =>
  /test-videos\.co\.uk|blob:/i.test(u) ||
  /\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ico|json|xml|html)(\?|$)/i.test(u) ||
  /google-analytics|googlesyndication|doubleclick|facebook\.com\/tr|analytics/i.test(u);

const isVideoContentType = (ct) =>
  ct.includes('mpegurl') ||
  ct.includes('video/') ||
  ct.includes('application/dash') ||
  ct.includes('application/x-mpegURL') ||
  ct.includes('application/vnd.apple.mpegurl');

// --- DOM extraction script ------------------------------------------------

const DOM_EXTRACT_SCRIPT = `(function() {
  const results = [];
  // THEOplayer
  try {
    document.querySelectorAll('.theoplayer-container, .video-js, [class*="theoplayer"]').forEach(el => {
      if (el.player && el.player.source && el.player.source.sources) {
        el.player.source.sources.forEach(s => { if (s.src) results.push(s.src); });
      }
    });
    if (typeof THEOplayer !== 'undefined') {
      document.querySelectorAll('div').forEach(el => {
        try {
          if (el.player && el.player.src) results.push(el.player.src);
        } catch(e) {}
      });
    }
  } catch(e) {}
  // Look for video source URLs in inline scripts (THEOplayer, generic player configs)
  try {
    document.querySelectorAll('script:not([src])').forEach(s => {
      const t = s.textContent || '';
      const m3u8s = t.match(/https?:\\/\\/[^'\"\\s]+\\.m3u8[^'\"\\s]*/g) || [];
      const mpds = t.match(/https?:\\/\\/[^'\"\\s]+\\.mpd[^'\"\\s]*/g) || [];
      const mp4s = t.match(/https?:\\/\\/[^'\"\\s]+\\.mp4[^'\"\\s]*/g) || [];
      [...m3u8s, ...mpds, ...mp4s].forEach(u => {
        if (!/tracking|analytics|pixel/i.test(u)) results.push(u);
      });
    });
  } catch(e) {}
  // JWPlayer
  if (typeof jwplayer !== 'undefined') {
    try {
      const pl = jwplayer().getPlaylist();
      if (pl) pl.forEach(i => {
        if (i.file) results.push(i.file);
        if (i.sources) i.sources.forEach(s => { if (s.file) results.push(s.file); });
      });
    } catch(e) {}
  }
  // Plyr
  if (typeof Plyr !== 'undefined') {
    try {
      document.querySelectorAll('.plyr').forEach(el => {
        if (el.plyr && el.plyr.source && el.plyr.source.sources)
          el.plyr.source.sources.forEach(s => results.push(s.src));
      });
    } catch(e) {}
  }
  // Video.js
  if (typeof videojs !== 'undefined') {
    try {
      document.querySelectorAll('.video-js').forEach(el => {
        const p = videojs(el.id);
        if (p && p.currentSrc()) results.push(p.currentSrc());
      });
    } catch(e) {}
  }
  // Flowplayer
  if (typeof flowplayer !== 'undefined') {
    try {
      const fp = flowplayer();
      if (fp && fp.video && fp.video.src) results.push(fp.video.src);
    } catch(e) {}
  }
  // Clappr
  try {
    document.querySelectorAll('[data-player]').forEach(el => {
      if (el.player && el.player.options && el.player.options.source)
        results.push(el.player.options.source);
    });
  } catch(e) {}
  // hls.js instances
  try {
    document.querySelectorAll('video').forEach(v => {
      if (v.hlsPlayer && v.hlsPlayer.url) results.push(v.hlsPlayer.url);
      if (v._hls && v._hls.url) results.push(v._hls.url);
    });
  } catch(e) {}
  // dash.js
  if (typeof dashjs !== 'undefined') {
    try {
      const p = dashjs.MediaPlayer();
      if (p && p.getSource) results.push(p.getSource());
    } catch(e) {}
  }
  // HTML5 video/audio and source elements
  document.querySelectorAll('video, video source, source, audio, audio source').forEach(el => {
    ['src', 'data-src', 'data-file', 'data-video-src', 'data-stream-url'].forEach(attr => {
      const v = el.getAttribute(attr);
      if (v && !v.startsWith('blob:') && !v.includes('test-videos')) results.push(v);
    });
  });
  // Iframes
  document.querySelectorAll('iframe').forEach(el => {
    const s = el.getAttribute('src') || el.getAttribute('data-src');
    if (s && /embed|player|video|stream/i.test(s)) results.push('IFRAME:' + s);
  });
  return JSON.stringify(results);
})()`;

// --- Consent / Play click script ------------------------------------------

const CLICK_CONSENT_AND_PLAY_SCRIPT = `(function() {
  const clicked = [];
  // Cookie consent buttons
  const consentSelectors = [
    '[id*="accept" i][id*="cookie" i]',
    '[class*="accept" i][class*="cookie" i]',
    '[id*="consent" i] button',
    '[class*="consent" i] button',
    'button[id*="accept" i]',
    'button[class*="accept" i]',
    '[aria-label*="accept" i]',
    '[aria-label*="agree" i]',
    '.cookie-banner button',
    '.cookie-notice button',
    '#onetrust-accept-btn-handler',
    '.cc-accept',
    '.cc-allow',
    '.gdpr-accept',
  ];
  for (const sel of consentSelectors) {
    try {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) {
        btn.click();
        clicked.push('consent:' + sel);
        break;
      }
    } catch(e) {}
  }
  // Play buttons
  const playSelectors = [
    '.vjs-big-play-button',
    '.ytp-large-play-button',
    '[class*="play-button" i]',
    '[class*="play_button" i]',
    '[aria-label*="play" i]',
    'button[class*="play" i]',
    '.jw-icon-display',
    '.plyr__control--overlaid',
    '.flowplayer .fp-ui',
  ];
  for (const sel of playSelectors) {
    try {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) {
        btn.click();
        clicked.push('play:' + sel);
        break;
      }
    } catch(e) {}
  }
  return JSON.stringify(clicked);
})()`;

// --- Cookie parsing (Netscape format) -------------------------------------

function parseCookiesFile(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, 'utf8');
    const cookies = [];
    for (const line of content.split('\n')) {
      if (line.startsWith('#') || !line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length >= 7) {
        cookies.push({
          name: parts[5],
          value: parts[6],
          domain: parts[0].replace(/^\./, ''),
          path: parts[2],
          secure: parts[3] === 'TRUE',
          httpOnly: false,
          expires: parseInt(parts[4]) || -1,
        });
      }
    }
    return cookies;
  } catch (e) {
    debug('Failed to parse cookies file:', e.message);
    return [];
  }
}

// --- Main extraction ------------------------------------------------------

let chromeProc = null;

async function extract() {
  const videoUrls = new Set();

  // Launch Chrome
  const { proc, wsUrl } = await launchChrome();
  chromeProc = proc;

  // Get browser WebSocket endpoint
  const port = new URL(wsUrl).port;
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  const { webSocketDebuggerUrl } = await res.json();

  // Connect to browser
  const browser = await CDPClient.connect(webSocketDebuggerUrl);

  // Create a new tab
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });

  const send = (method, params = {}) => browser.sendToSession(sessionId, method, params);

  // Enable network interception
  await send('Network.enable');
  await send('Page.enable');
  await send('Runtime.enable');

  // Block ad/tracking domains that cause redirects in headless mode
  await send('Network.setBlockedURLs', {
    urls: [
      '*protrafficinspector*',
      '*hotelkobalts*',
      '*clickdir*',
      '*runoperagx*',
      '*googlesyndication*',
      '*doubleclick*',
      '*ezexfzek*',
      '*addthis*',
      '*google-analytics*',
      '*facebook.com/tr*',
      '*nn125.com*',
    ],
  });

  // Hide headless Chrome signals to bypass bot detection
  await send('Network.setUserAgentOverride', {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
      // Block ad-driven window.open and popups
      window.open = () => null;
    `,
  });

  // Inject cookies if provided
  if (COOKIES_FILE) {
    const cookies = parseCookiesFile(COOKIES_FILE);
    if (cookies.length > 0) {
      debug(`Injecting ${cookies.length} cookies`);
      for (const cookie of cookies) {
        try {
          await send('Network.setCookie', cookie);
        } catch (e) {
          debug('Failed to set cookie:', cookie.name, e.message);
        }
      }
    }
  }

  // Track video-looking URLs that turned out to be HTML (player/preview pages)
  const htmlPlayerPages = new Set();

  // Collect video URLs from network
  browser.on('Network.responseReceived', (params) => {
    const u = params.response?.url || '';
    const ct = params.response?.headers?.['content-type'] || params.response?.mimeType || '';
    if (isJunk(u)) return;
    // Skip HTML responses even if URL looks like a video (e.g. preview pages)
    if (/text\/html/i.test(ct)) {
      debug('Skipping HTML response:', u);
      // Remove if requestWillBeSent already added it
      if (videoUrls.has(u)) {
        videoUrls.delete(u);
        debug('Removed fake video URL (HTML):', u);
      }
      // Track as potential player page to follow later
      if (isVideoUrl(u)) htmlPlayerPages.add(u);
      return;
    }
    if (isVideoUrl(u) || isVideoContentType(ct)) {
      debug('Network response:', u);
      videoUrls.add(u);
    }
  });

  browser.on('Network.requestWillBeSent', (params) => {
    const u = params.request?.url || '';
    if (!isJunk(u) && isVideoUrl(u)) {
      debug('Network request:', u);
      videoUrls.add(u);
    }
  });

  // Track page load
  let pageLoaded = false;
  const loadPromise = new Promise((resolve) => {
    browser.on('Page.loadEventFired', () => {
      debug('Page load event fired');
      pageLoaded = true;
      resolve();
    });
    // Fallback timeout in case loadEventFired never fires
    setTimeout(() => {
      if (!pageLoaded) debug('Page load timeout, proceeding anyway');
      resolve();
    }, TIMEOUT);
  });

  // Navigate to URL
  debug('Navigating to:', url);
  try {
    await send('Page.navigate', { url });
  } catch (e) {
    console.error('NAVIGATE_ERROR:' + e.message);
  }

  // Wait for page load event (or timeout)
  await loadPromise;

  // Grace period for dynamic content after load
  await new Promise((r) => setTimeout(r, 2000));

  // Extract from DOM and player APIs BEFORE clicking (in case click navigates away)
  try {
    const earlyResult = await browser.evaluate(sessionId, DOM_EXTRACT_SCRIPT);
    const earlyUrls = JSON.parse(earlyResult || '[]');
    debug('Early DOM extracted:', earlyUrls.length, 'URLs');
    for (const u of earlyUrls) {
      if (u && !isJunk(u)) videoUrls.add(u);
    }
  } catch (e) {
    debug('Early DOM extraction error:', e.message);
  }

  // Click consent banners and play buttons to trigger video loading
  try {
    // Remember current URL to detect unwanted navigation
    const beforeUrl = await browser.evaluate(sessionId, 'window.location.href');
    const clickResult = await browser.evaluate(sessionId, CLICK_CONSENT_AND_PLAY_SCRIPT);
    const clicked = JSON.parse(clickResult || '[]');
    if (clicked.length > 0) {
      debug('Clicked:', clicked);
      // Wait for video to start loading after click
      await new Promise((r) => setTimeout(r, 3000));
      // Check if click caused unwanted navigation
      try {
        const afterUrl = await browser.evaluate(sessionId, 'window.location.href');
        if (afterUrl !== beforeUrl) {
          debug('Click caused navigation to:', afterUrl, '- navigating back');
          await send('Page.navigate', { url: beforeUrl });
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch (e) {
        debug('Navigation check error:', e.message);
      }
    }
  } catch (e) {
    debug('Click script error:', e.message);
  }

  // Extract from DOM and player APIs
  try {
    const domResult = await browser.evaluate(sessionId, DOM_EXTRACT_SCRIPT);
    const extracted = JSON.parse(domResult || '[]');
    debug('DOM extracted:', extracted.length, 'URLs');
    for (const u of extracted) {
      if (u && !isJunk(u)) videoUrls.add(u);
    }
  } catch (e) {
    console.error('DOM_EXTRACT_ERROR:' + e.message);
  }

  // Try clicking server/source selection buttons that trigger video loading
  // Many streaming sites load video only after user clicks a server button
  if (videoUrls.size === 0 || [...videoUrls].every((u) => u.startsWith('IFRAME:'))) {
    debug('Trying to click server/source buttons...');
    try {
      const serverClickResult = await browser.evaluate(
        sessionId,
        `(function() {
          const clicked = [];
          // Try calling startPlayer() if it exists (common pattern)
          if (typeof startPlayer === 'function') {
            try { startPlayer(); clicked.push('startPlayer()'); } catch(e) {}
          }
          // Click elements with onclick handlers related to streaming/servers
          if (clicked.length === 0) {
            const allClickable = document.querySelectorAll('[onclick]');
            for (const el of allClickable) {
              const handler = el.getAttribute('onclick') || '';
              if (/getStream|getLink|loadServer|selectServer|playVideo|loadVideo/i.test(handler)) {
                try { el.click(); clicked.push('onclick:' + handler.substring(0, 60)); break; } catch(e) {}
              }
            }
          }
          // Click server list items (common pattern: list items in a server container)
          if (clicked.length === 0) {
            const serverItems = document.querySelectorAll(
              '[data-server], [data-value*="server"], [class*="server"] li, [data-box*="serv"] ~ * li'
            );
            for (const el of serverItems) {
              if (el.offsetParent !== null) {
                try { el.click(); clicked.push('server-item:' + el.textContent.trim().substring(0, 30)); break; } catch(e) {}
              }
            }
          }
          return JSON.stringify(clicked);
        })()`
      );
      const serverClicked = JSON.parse(serverClickResult || '[]');
      if (serverClicked.length > 0) {
        debug('Server buttons clicked:', serverClicked);
        // Wait for AJAX + player initialization
        await new Promise((r) => setTimeout(r, 5000));

        // Check if a captcha appeared (common on streaming sites)
        try {
          const hasCaptcha = await browser.evaluate(
            sessionId,
            `!!(document.querySelector('#player-captcha, [id*="captcha"], .g-recaptcha, .h-captcha, [class*="captcha"]'))`
          );
          if (hasCaptcha) {
            console.error('CAPTCHA_REQUIRED: site requires captcha, use -c/--cookies with exported browser cookies');
          }
        } catch {}

        // Re-extract from DOM (iframes, video elements, player APIs)
        try {
          const domResult = await browser.evaluate(sessionId, DOM_EXTRACT_SCRIPT);
          const extracted = JSON.parse(domResult || '[]');
          debug('Post-server-click DOM extracted:', extracted.length, 'URLs');
          for (const u of extracted) {
            if (u && !isJunk(u)) videoUrls.add(u);
          }
        } catch (e) {
          debug('Post-server-click DOM extraction error:', e.message);
        }
      }
    } catch (e) {
      debug('Server click error:', e.message);
    }
  }

  // If nothing found yet, poll with shorter intervals
  if (videoUrls.size === 0) {
    debug('No URLs found yet, polling...');
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 1500));

      // Check network captures
      if (videoUrls.size > 0) {
        debug('Network captured URLs on poll attempt', i + 1);
        break;
      }

      // Retry DOM extraction
      try {
        const retryResult = await browser.evaluate(sessionId, DOM_EXTRACT_SCRIPT);
        const retryUrls = JSON.parse(retryResult || '[]');
        for (const u of retryUrls) {
          if (u && !isJunk(u)) videoUrls.add(u);
        }
        if (videoUrls.size > 0) {
          debug('Found URLs on poll attempt', i + 1);
          break;
        }
      } catch {}
    }
  }

  // Check if we only have iframes but no real video URLs
  const realVideoUrls = [...videoUrls].filter((u) => !u.startsWith('IFRAME:'));
  if (realVideoUrls.length === 0 && htmlPlayerPages.size > 0) {
    const playerUrl = [...htmlPlayerPages][0];
    debug('No video found, following player page:', playerUrl);
    try {
      // Create a new tab for the player page
      const { targetId: playerTargetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId: playerSessionId } = await browser.send('Target.attachToTarget', { targetId: playerTargetId, flatten: true });
      const sendPlayer = (method, params = {}) => browser.sendToSession(playerSessionId, method, params);

      await sendPlayer('Network.enable');
      await sendPlayer('Page.enable');
      await sendPlayer('Runtime.enable');

      // Collect video URLs from the player page network
      browser.on('Network.responseReceived', (params) => {
        if (params.sessionId !== undefined && params.sessionId !== playerSessionId) return;
        const u = params.response?.url || '';
        const ct = params.response?.headers?.['content-type'] || params.response?.mimeType || '';
        if (isJunk(u) || /text\/html/i.test(ct)) return;
        if (isVideoUrl(u) || isVideoContentType(ct)) {
          debug('Player page network response:', u);
          videoUrls.add(u);
        }
      });

      browser.on('Network.requestWillBeSent', (params) => {
        if (params.sessionId !== undefined && params.sessionId !== playerSessionId) return;
        const u = params.request?.url || '';
        if (!isJunk(u) && isVideoUrl(u)) {
          debug('Player page network request:', u);
          videoUrls.add(u);
        }
      });

      await sendPlayer('Page.navigate', { url: playerUrl });

      // Wait for player page to load
      await new Promise((resolve) => {
        const onLoad = () => resolve();
        browser.on('Page.loadEventFired', onLoad);
        setTimeout(resolve, TIMEOUT);
      });
      await new Promise((r) => setTimeout(r, 2000));

      // Extract from player page DOM (inline scripts, THEOplayer, etc.)
      try {
        const domResult = await browser.evaluate(playerSessionId, DOM_EXTRACT_SCRIPT);
        const extracted = JSON.parse(domResult || '[]');
        debug('Player page DOM extracted:', extracted.length, 'URLs');
        for (const u of extracted) {
          if (u && !isJunk(u)) videoUrls.add(u);
        }
      } catch (e) {
        debug('Player page DOM extraction error:', e.message);
      }

      try {
        await browser.send('Target.closeTarget', { targetId: playerTargetId });
      } catch {}
    } catch (e) {
      debug('Failed to follow player page:', e.message);
    }
  }

  // Clean up
  try {
    await browser.send('Target.closeTarget', { targetId });
  } catch {}
  browser.disconnect();

  // Output results (sorted by priority: m3u8 > mpd > mp4 > others)
  const results = [...videoUrls].filter(Boolean);
  const iframes = results.filter((u) => u.startsWith('IFRAME:'));
  const videos = results.filter((u) => !u.startsWith('IFRAME:'));

  if (videos.length > 0) {
    const sorted = videos.sort((a, b) => {
      const score = (u) => (/m3u8/i.test(u) ? 3 : /\.mpd/i.test(u) ? 2 : /\.mp4/i.test(u) ? 1 : 0);
      return score(b) - score(a);
    });
    sorted.forEach((u) => console.log(u));
  } else if (iframes.length > 0) {
    iframes.forEach((u) => console.log(u));
  } else {
    process.exit(1);
  }
}

// --- Cleanup Chrome profile -----------------------------------------------

function cleanupProfile() {
  try {
    rmSync(CHROME_PROFILE, { recursive: true, force: true });
  } catch {}
}

// --- Run ------------------------------------------------------------------

try {
  await extract();
} catch (e) {
  console.error('EXTRACT_ERROR:' + e.message);
  process.exit(1);
} finally {
  if (chromeProc) {
    try {
      chromeProc.kill('SIGTERM');
    } catch {}
  }
  cleanupProfile();
}

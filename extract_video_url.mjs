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
// Referer passed in from the parent page during iframe recursion — some
// embed hosts (cloudnestra, streamtape, …) 403 without a matching Referer.
const REFERER = process.env.SNATCH_REFERER || '';

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
  if (process.env.SNATCH_CHROME && existsSync(process.env.SNATCH_CHROME)) {
    return process.env.SNATCH_CHROME;
  }
  // Browser priority: prefer browsers without built-in content blockers that
  // flag streaming-embed hosts. Brave's Shields can't be disabled via CLI,
  // so Brave is LAST — only picked if nothing cleaner is installed.
  const paths = [
    // macOS — pure Chromium / Chrome / Edge / Arc / Vivaldi / Opera / Thorium
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta',
    '/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev',
    '/Applications/Arc.app/Contents/MacOS/Arc',
    '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
    '/Applications/Opera.app/Contents/MacOS/Opera',
    '/Applications/Thorium.app/Contents/MacOS/Thorium',
    // macOS — Brave last (built-in Shields blocks many streaming-embed hosts)
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta',
    '/Applications/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/vivaldi',
    '/snap/bin/chromium',
    '/usr/bin/brave-browser',
    '/snap/bin/brave',
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  for (const cmd of [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
    'vivaldi',
    'brave-browser',
    'brave',
  ]) {
    try {
      const found = execSync(`which ${cmd}`, { stdio: 'pipe' }).toString().trim();
      if (found) return found;
    } catch {}
  }
  throw new Error(
    'No Chromium-based browser found. Install one of: Chrome, Chromium, Edge, Arc, Vivaldi, Brave. ' +
    'Note: Brave Shields blocks many streaming-embed hosts; prefer Chromium for streaming extraction. ' +
    'Override with SNATCH_CHROME=/path/to/browser'
  );
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

  // Ignore stdout (nothing useful, avoids buffer stalls). Keep stderr piped —
  // we need it to discover the DevTools WS URL.
  const proc = spawn(chromePath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: false,
  });

  // On any early rejection, kill the child so we don't orphan the browser.
  const killChild = () => {
    try { proc.kill('SIGKILL'); } catch {}
  };

  return new Promise((resolve, reject) => {
    let stderrBuf = '';
    let resolved = false;

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      killChild();
      reject(new Error('Chrome launch timeout'));
    }, 15000);

    const onData = (chunk) => {
      if (resolved) return;
      stderrBuf += chunk.toString();
      const match = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        resolved = true;
        clearTimeout(timer);
        // Stop collecting stderr to avoid unbounded growth.
        proc.stderr.removeListener('data', onData);
        proc.stderr.resume(); // let further chunks drain without buffering
        stderrBuf = '';
        resolve({ proc, wsUrl: match[1] });
      }
    };
    proc.stderr.on('data', onData);

    proc.on('error', (e) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      killChild();
      reject(e);
    });

    proc.on('exit', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(new Error(`Chrome exited before DevTools ready (code ${code})`));
    });
  });
}

// --- URL helpers ----------------------------------------------------------

const isVideoUrl = (u) =>
  /\.(m3u8|mp4|webm|mkv|ts|mpd)(\?|$|&)/i.test(u) ||
  /master\.m3u8|index\.m3u8|playlist\.m3u8|chunklist.*\.m3u8|media.*\.m3u8/i.test(u) ||
  /manifest\.mpd|video.*\.mp4/i.test(u) ||
  /\/hls\/|\/dash\//i.test(u);

// Generic ad/tracker filtering — no hardcoded vendor list to rot over time.
// Signals used: ad-ish URL path segments, ad-ish hostnames, and analytics pixels.

// Ad path segments — works across any CDN. Matches whole segment (bounded by /).
const AD_PATH_RE = /\/(ads?|adv|advert|advertising|advertisement|video[_-]?ads?|vast(ads?)?|preroll|midroll|postroll|sponsor(ed)?|promo|banner|affiliate|popunder|popup|interstitial|tracking|tracker|pixel|beacon|telemetry|impression|conversion|adserver|adcontent)(\/|$)/i;

// Ad-ish hostnames — subdomain literally is "ads", "adserver", etc., OR obvious ad-tech vendors
const AD_HOST_RE = /(^|\.)(ads?|adx|adserver|adservers?|adnetwork|adsystem|adtech|adroll|adnxs|adform|rubicon|pubmatic|openx|criteo|smartadserver|outbrain|taboola|mgid|adskeeper)\.[a-z0-9.-]+\.[a-z]{2,}/i;

// Analytics/privacy pixels — never content
const TRACKER_HOST_RE = /(^|\.)(googletagmanager|googlesyndication|googleadservices|doubleclick|adservice\.google|google-analytics|scorecardresearch|quantserve|hotjar|mixpanel|amplitude|segment\.io|segment\.com|yandex\.ru)(\/|$)|facebook\.com\/tr|bing\.com\/bat/i;

const isJunk = (u) =>
  /test-videos\.co\.uk|blob:|^data:|^about:|^javascript:/i.test(u) ||
  /\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ico|json|xml|html)(\?|$)/i.test(u) ||
  AD_PATH_RE.test(u) ||
  AD_HOST_RE.test(u) ||
  TRACKER_HOST_RE.test(u);

// Heuristic: URL looks like a video-embed host page (iframe target), not a direct media file.
const isEmbedPage = (u) =>
  /\/(embed|e|v|watch|player|stream|iframe)(\/|[?#])/i.test(u) ||
  /\/(embed|e|v)-[a-z0-9]+/i.test(u);

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
  // Iframes — capture any with an external http(s) src (filter junk later in host)
  document.querySelectorAll('iframe').forEach(el => {
    const s = el.getAttribute('src') || el.getAttribute('data-src') || el.src;
    if (!s) return;
    if (s.startsWith('about:') || s.startsWith('blob:') || s.startsWith('data:') || s.startsWith('javascript:')) return;
    // Accept protocol-relative, absolute http(s), and root-relative paths
    if (/^https?:\\/\\//i.test(s) || s.startsWith('//') || s.startsWith('/')) {
      results.push('IFRAME:' + s);
    }
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
    for (const rawLine of content.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
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

  // Get browser WebSocket endpoint (bounded; Chrome may have launched but
  // hung its DevTools HTTP server)
  const port = new URL(wsUrl).port;
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(5000),
  });
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

  // Network-layer blocklist — CDP only supports `*` wildcards so we use
  // generic ad/analytics patterns. Keeps ad scripts from triggering popup
  // redirects during headless extraction. Extraction-time filtering handles
  // whatever slips through.
  await send('Network.setBlockedURLs', {
    urls: [
      '*/ads/*',
      '*/adserver/*',
      '*/video_ads/*',
      '*/popunder*',
      '*/popup*',
      '*/tracking/*',
      '*/telemetry/*',
      '*/beacon/*',
      '*googletagmanager*',
      '*googlesyndication*',
      '*googleadservices*',
      '*google-analytics*',
      '*doubleclick*',
      '*facebook.com/tr*',
      '*bing.com/bat*',
      '*hotjar*',
      '*mixpanel*',
    ],
  });

  // Hide headless Chrome signals to bypass bot detection
  await send('Network.setUserAgentOverride', {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  // Referer handling moved into the Page.navigate call below — setting a
  // global extra header would leak the parent-page Referer onto every
  // sub-resource request, which trips anti-hotlink logic on some embed
  // hosts (e.g. vidcdn.co returns an interstitial).
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

  // Track initiator (loader) for every URL — lets us distinguish real player
  // requests (loaded by page-origin scripts) from ad requests (loaded by
  // third-party iframes/scripts).
  const urlInitiators = new Map(); // url → string[] of initiator URLs

  const recordInitiator = (u, init) => {
    if (!u || urlInitiators.has(u)) return;
    const stack = [];
    if (init?.url) stack.push(init.url);
    const frames = init?.stack?.callFrames || [];
    for (const f of frames) if (f.url) stack.push(f.url);
    urlInitiators.set(u, stack);
  };

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
      // Track as potential player page to follow later. Either the URL shape
      // looks video-ish, or the path looks like a video-embed host
      // (/embed/..., /e/..., /player/...).
      if (isVideoUrl(u) || isEmbedPage(u)) htmlPlayerPages.add(u);
      return;
    }
    if (isVideoUrl(u) || isVideoContentType(ct)) {
      debug('Network response:', u);
      videoUrls.add(u);
    }
  });

  browser.on('Network.requestWillBeSent', (params) => {
    const u = params.request?.url || '';
    recordInitiator(u, params.initiator);
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
  debug('Navigating to:', url, REFERER ? `(referrer: ${REFERER})` : '');
  try {
    // Pass referrer ONLY on the top-level navigation. Chrome/Chromium will
    // then let the document manage Referer for its own sub-resources
    // (which become same-origin vidcdn.co → vidcdn.co, as a real browser
    // would do when the iframe was loaded from its parent page).
    const navParams = { url };
    if (REFERER) navParams.referrer = REFERER;
    await send('Page.navigate', navParams);
  } catch (e) {
    console.error('NAVIGATE_ERROR:' + e.message);
  }

  // Wait for page load event (or timeout)
  await loadPromise;

  // Grace period for dynamic content after load
  await new Promise((r) => setTimeout(r, 2000));

  // Detect Brave Shields hard-block (ERR_BLOCKED_BY_CLIENT) — its built-in
  // adblock flags many streaming-embed hosts and CLI flags can't disable it.
  // Surface a clear error so the user installs a non-Brave Chromium.
  try {
    const blocked = await browser.evaluate(
      sessionId,
      `(document.getElementById('main-frame-error') && /ERR_BLOCKED_BY_CLIENT|bloqu[eé]|blocked/i.test(document.body.innerText || '')) ? document.title + '||' + (document.body.innerText||'').slice(0,200) : ''`
    );
    if (blocked) {
      console.error(
        'BRAVE_SHIELDS_BLOCK: Brave Shields is blocking this embed host. Install Chromium and retry: brew install --cask chromium'
      );
      throw new Error('Brave Shields blocked embed host — install Chromium');
    }
  } catch (e) {
    if (e.message?.includes('Brave Shields')) throw e;
  }

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

  // A URL is "high-confidence real" if it has cryptographic signing or classic
  // streaming-manifest shape. Unsigned random mp4s from unknown CDNs don't count
  // — those are usually ad decoys firing while the real player is still idle.
  const isHighConfidence = (u) =>
    !u.startsWith('IFRAME:') &&
    (/[?&](token|signature|hmac|expires|exp|acl|sig|sign|policy|hdnts|hdntl)=/i.test(u) ||
      /~hmac=|~st=|~exp=/i.test(u) ||
      /\.m3u8(\?|$|&)/i.test(u) ||
      /\.mpd(\?|$|&)/i.test(u) ||
      /\/(slice|chunklist|manifest|playlist|hls2?|dash)\//i.test(u));

  const hasHighConfidence = () => [...videoUrls].some(isHighConfidence);

  // Parent-page eTLD+1 — used to decide whether an iframe is "external"
  // (i.e. likely an embed host to follow) or just same-site structure.
  const pageHostForMatch = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  const pageDomainForMatch = (pageHostForMatch || '').split('.').slice(-2).join('.');
  // Known non-video iframe hosts (social/comment widgets). Presence of these
  // does NOT mean the real embed has loaded.
  const SOCIAL_IFRAME_RE = /(^|\.)(disqus|facebook|fb|twitter|x|platform\.twitter|widgets|linkedin|reddit|pinterest|vk|youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com)\.[a-z.]{2,}/i;
  const hasExternalIframe = () =>
    [...videoUrls].some((u) => {
      if (!u.startsWith('IFRAME:')) return false;
      const raw = u.slice('IFRAME:'.length);
      if (SOCIAL_IFRAME_RE.test(raw)) return false;
      try {
        const h = new URL(raw, `https://${pageHostForMatch}`).hostname;
        const d = h.split('.').slice(-2).join('.');
        return !!d && d !== pageDomainForMatch;
      } catch { return false; }
    });

  // Try clicking server/source selection buttons that trigger video loading.
  // Streaming sites often require a server click before the real player URL is
  // issued. We also click if what we have so far looks like ad decoys (no
  // signed tokens, no m3u8/mpd, no streaming path).
  if (
    videoUrls.size === 0 ||
    [...videoUrls].every((u) => u.startsWith('IFRAME:')) ||
    !hasHighConfidence()
  ) {
    debug('Enumerating server candidates...');
    try {
      // Enumerate all plausible server switches on the page. Each candidate
      // is either a global-function call (`type: 'fn'`) or a DOM element
      // click (`type: 'sel'` — we tag the element so we can re-find it).
      const enumResult = await browser.evaluate(
        sessionId,
        `(function() {
          const cands = [];
          const seen = new Set();

          // Well-known player-loader functions
          const loaderFns = [
            'startPlayer','playVideo','loadVideo','selectServer','switchServer',
            'load_film_iframe','load_movie_iframe','load_episode_iframe',
            'loadIframe','loadStream','loadSource','loadServer',
          ];
          for (const fn of loaderFns) {
            if (typeof window[fn] !== 'function') continue;
            // Sniff every onclick calling this fn to enumerate args
            const anchors = document.querySelectorAll('[onclick*="' + fn + '("]');
            for (const a of anchors) {
              const m = (a.getAttribute('onclick') || '').match(
                new RegExp(fn + '\\\\((?:["\\'])([^"\\']+)(?:["\\'])')
              );
              const label = (a.textContent || '').trim().slice(0, 30);
              const cls = (a.className || '').toString().toLowerCase();
              if (/trailer|preview|teaser/i.test(label + ' ' + cls)) continue;
              if (m) {
                const key = fn + ':' + m[1];
                if (!seen.has(key)) { seen.add(key); cands.push({type:'fn', fn, arg: m[1], label}); }
              }
            }
            // Fallback: bare fn call if no sniffable anchor
            if (![...seen].some((k) => k.startsWith(fn + ':')) && anchors.length === 0) {
              cands.push({type:'fn', fn, arg: null, label: fn + '()'});
            }
          }

          // Structural server anchors
          const structuralSel =
            '[data-server],[data-value*="server"],[class*="server"] li,' +
            '[data-box*="serv"] ~ * li,.player_nav a[href^="#tab"],' +
            '.idTabs a,[id^="Nav_"][href^="#"],[class*="server-item"],' +
            '[class*="serverItem"],[class*="srv"],[data-id*="server"]';
          let idx = 0;
          for (const el of document.querySelectorAll(structuralSel)) {
            if (el.offsetParent === null) continue;
            const label = (el.textContent || '').trim().toLowerCase();
            const cls = (el.className || '').toString().toLowerCase();
            if (/trailer|preview|teaser/.test(label + ' ' + cls)) continue;
            el.setAttribute('data-snatch-idx', String(idx));
            cands.push({type:'sel', sel: '[data-snatch-idx="' + idx + '"]', label: label.slice(0,30)});
            idx++;
          }
          return JSON.stringify(cands);
        })()`
      );
      const candidates = JSON.parse(enumResult || '[]');
      debug('Server candidates:', candidates.length);

      // Click candidates one at a time with a long polling window so the
      // first-clicked embed has time to emit its signed m3u8/mpd request.
      // Stop as soon as we have a high-confidence URL, so subsequent clicks
      // don't stomp the iframe src mid-load.
      const MAX_SERVERS = Math.min(candidates.length, 5);
      for (let i = 0; i < MAX_SERVERS; i++) {
        if (hasHighConfidence()) break;
        const c = candidates[i];
        const clickExpr =
          c.type === 'fn'
            ? `try { window[${JSON.stringify(c.fn)}](${c.arg !== null ? JSON.stringify(c.arg) : ''}); 'ok' } catch(e) { 'err:' + e.message }`
            : `(function(){ const el = document.querySelector(${JSON.stringify(c.sel)}); if (!el) return 'missing'; try { el.click(); return 'ok'; } catch(e) { return 'err:'+e.message; } })()`;
        try {
          const outcome = await browser.evaluate(sessionId, clickExpr);
          debug(`Tried server "${c.label}" (${c.type}) →`, outcome);
        } catch (e) {
          debug('Server click threw:', e.message);
          continue;
        }
        // Wait for the server to load its iframe / fire its requests —
        // polling for a high-confidence URL. Streaming sites typically need
        // 3-10 s for the embed to initialize and emit m3u8/mpd requests;
        // we poll every 500 ms and break as soon as a signed streaming URL
        // shows up, so we don't stomp on it with the next server click.
        // Inner wait: only break on a high-confidence real URL. We keep
        // waiting even if an iframe appears, because streaming embeds load
        // in two phases (iframe DOM swap → player init → signed m3u8) and
        // we want to catch the m3u8 in the top-level Network listener
        // before moving on.
        for (let w = 0; w < 16; w++) {
          await new Promise((r) => setTimeout(r, 500));
          if (hasHighConfidence()) break;
        }
        try {
          const domResult = await browser.evaluate(sessionId, DOM_EXTRACT_SCRIPT);
          const extracted = JSON.parse(domResult || '[]');
          for (const u of extracted) {
            if (u && !isJunk(u)) videoUrls.add(u);
          }
        } catch (e) {
          debug('Post-click DOM extract error:', e.message);
        }
      }
    } catch (e) {
      debug('Server enumeration error:', e.message);
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

      // The main-session network handlers already match by method, not by
      // session, so they capture events from this new player session too.
      // No extra listeners needed.

      // Forward parent-page URL as referrer on the navigation only.
      await sendPlayer('Page.navigate', { url: playerUrl, referrer: url });

      // Wait for player page to load
      await new Promise((resolve) => {
        const onLoad = () => resolve();
        browser.on('Page.loadEventFired', onLoad);
        setTimeout(resolve, TIMEOUT);
      });

      // Long polling window: the player page loads a chain of iframes
      // (embed gateway → final player) that emit the real m3u8 only after
      // their JS finishes initialising. CDP flat mode routes OOPIF Network
      // events to the parent session, so the main handlers will capture
      // them as they arrive. Poll ~20 s and re-extract DOM periodically.
      for (let poll = 0; poll < 20; poll++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (hasHighConfidence()) break;
        try {
          const domResult = await browser.evaluate(playerSessionId, DOM_EXTRACT_SCRIPT);
          const extracted = JSON.parse(domResult || '[]');
          for (const u of extracted) {
            if (u && !isJunk(u)) videoUrls.add(u);
          }
          if (hasHighConfidence()) break;
        } catch {}
      }

      try {
        await browser.send('Target.closeTarget', { targetId: playerTargetId });
      } catch {}
    } catch (e) {
      debug('Failed to follow player page:', e.message);
    }
  }

  // If we still have nothing, probe for a visible interactive captcha so the
  // shell wrapper can give the user a helpful message. Only emit the signal
  // when no URLs were extracted and the captcha is actually interactive
  // (visible element with an input, iframe, or image) — checking for "captcha"
  // in a class/id is otherwise a common false positive.
  if (videoUrls.size === 0) {
    try {
      const hasInteractiveCaptcha = await browser.evaluate(
        sessionId,
        `(function(){
          const els = document.querySelectorAll('#player-captcha,[id*="captcha" i],.g-recaptcha,.h-captcha,[class*="captcha" i]');
          for (const el of els) {
            if (el.offsetParent === null) continue;
            if (el.querySelector('input,iframe,textarea,img[src*="captcha" i]')) return true;
          }
          return false;
        })()`
      );
      if (hasInteractiveCaptcha) {
        console.error('CAPTCHA_REQUIRED: site requires captcha, export cookies from a browser session where captcha was solved and pass with -c');
      }
    } catch {}
  }

  // Clean up
  try {
    await browser.send('Target.closeTarget', { targetId });
  } catch {}
  browser.disconnect();

  // Output results — score everything together, emit the winner first.
  const results = [...videoUrls].filter(Boolean);
  const iframes = results.filter((u) => u.startsWith('IFRAME:'));
  const videos = results.filter((u) => !u.startsWith('IFRAME:'));

  if (results.length === 0) throw new Error('NO_VIDEO_URL_FOUND');

  // Page-origin registrable domain (eTLD+1 approximation, good enough for scoring).
  const pageHost = (() => {
    try { return new URL(url).hostname; } catch { return ''; }
  })();
  const etld1 = (h) => {
    const parts = (h || '').split('.');
    return parts.slice(-2).join('.');
  };
  const pageDomain = etld1(pageHost);

  // Score by format + auth-token presence + streaming-path signals + initiator.
  // Signed/tokenized stream URLs from page-origin-initiated requests are almost
  // always the real video; unsigned .mp4 loaded by third-party scripts = ad decoy.
  const scoreVideo = (u) => {
    let s = 0;
    if (/\.m3u8(\?|$|&)|mpegurl/i.test(u)) s += 100;
    else if (/\.mpd(\?|$|&)|dash/i.test(u)) s += 80;
    else if (/\.mp4(\?|$|&)/i.test(u)) s += 40;
    else s += 10;
    if (/[?&](token|signature|hmac|expires|exp|acl|sig|sign|policy|key|hdnts|hdntl)=/i.test(u)) s += 60;
    if (/~hmac=|~st=|~exp=|~acl=/i.test(u)) s += 30;
    if (/\/(slice|hls|dash|stream|manifest|playlist|chunklist|media|video|hls2|vod|live)\//i.test(u)) s += 30;
    const inits = urlInitiators.get(u) || [];
    if (inits.length > 0 && pageDomain) {
      const initDomains = inits
        .map((iu) => { try { return etld1(new URL(iu).hostname); } catch { return ''; } })
        .filter(Boolean);
      if (initDomains.some((d) => d === pageDomain)) s += 40;
      else if (initDomains.length > 0 && initDomains.every((d) => d !== pageDomain)) s -= 25;
    }
    if (/\/\d{6,}\.mp4(\?|$)/.test(u) && !/[?&]/.test(u.split('.mp4')[1] || '')) s -= 40;
    return s;
  };

  // Iframes get a baseline score that beats low-confidence ad-like videos
  // (~40) but loses to high-confidence real video URLs (>=100). An embed-host
  // iframe is a reliable path to the real video via recursive extraction.
  const scoreIframe = (u) => {
    let s = 70;
    const raw = u.slice('IFRAME:'.length);
    let host = '';
    try {
      host = new URL(raw, `https://${pageHost}`).hostname;
    } catch {}
    // Same-origin iframes are usually structural (menus, consent), not players.
    if (host && etld1(host) === pageDomain) s -= 30;
    // Known social/comment/share widgets — never video
    if (/(^|\.)(disqus|facebook|fb|twitter|x|platform\.twitter|widgets|linkedin|reddit|pinterest|vk)\.[a-z.]{2,}/i.test(raw)) s -= 80;
    // Mainstream video platforms embedded on an unrelated site → almost
    // always a trailer/preview, not the content the user asked for. Penalize
    // unless the parent page is on the same platform.
    const platformRe = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv|tiktok\.com|instagram\.com|facebook\.com\/watch)/i;
    if (platformRe.test(raw) && !platformRe.test(pageHost)) s -= 80;
    // Path hints for non-video embeds
    if (/\/(comments?|discuss|share|follow|like|tweet|reactions?|social)(\/|[?#]|$)/i.test(raw)) s -= 60;
    // Path hints for video embeds
    if (/\/(embed|e|v|watch|player|stream|iframe)(\/|[?#])|\/(embed|e|v)-[a-z0-9]+/i.test(raw)) s += 20;
    return s;
  };

  const score = (u) => (u.startsWith('IFRAME:') ? scoreIframe(u) : scoreVideo(u));
  const sorted = results.sort((a, b) => score(b) - score(a));
  if (VERBOSE) {
    for (const u of sorted) debug(`score=${score(u)}`, u.slice(0, 130));
  }
  sorted.forEach((u) => console.log(u));
}

// --- Cleanup Chrome profile -----------------------------------------------

function cleanupProfile() {
  try {
    rmSync(CHROME_PROFILE, { recursive: true, force: true });
  } catch {}
}

// --- Run ------------------------------------------------------------------

const terminate = (code = 0) => {
  if (chromeProc) {
    try { chromeProc.kill('SIGKILL'); } catch {}
  }
  cleanupProfile();
  process.exit(code);
};

// Handle Ctrl-C / SIGTERM so Chrome is never orphaned.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => terminate(130));
}

try {
  await extract();
} catch (e) {
  console.error('EXTRACT_ERROR:' + e.message);
  terminate(1);
} finally {
  if (chromeProc) {
    try { chromeProc.kill('SIGKILL'); } catch {}
    // Give the OS a tick to release Brave's file handles before rm'ing the
    // profile. Without this, Brave's write-on-exit can leave ghost files.
    await new Promise((r) => setTimeout(r, 150));
  }
  cleanupProfile();
}

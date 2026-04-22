// CDP-based video URL extractor using raw Chrome DevTools Protocol
// No Playwright - uses WebSocket directly via ws package

import { execSync, spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { FiltersEngine, Request as AdblockRequest } from '@ghostery/adblocker';

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
// When set, exhaustively click every server candidate instead of breaking on
// the first high-confidence URL. Used by `snatch -a` / `snatch -i` so the
// user gets fallback URLs when the default server is dead.
const ALL_SERVERS = process.env.SNATCH_ALL_SERVERS === '1';

const CHROME_PROFILE = mkdtempSync(join(tmpdir(), 'snatch-chrome-'));

// User-Agent + Client Hints metadata that mirror a real macOS Chrome 131.
// Cloudflare Bot Fight Mode flags requests where Sec-CH-UA-* headers
// disagree with the UA string or contain "HeadlessChrome", so we override
// both the UA and the Client Hints together.
const UA_STRING =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA_METADATA = {
  brands: [
    { brand: 'Google Chrome', version: '131' },
    { brand: 'Chromium', version: '131' },
    { brand: 'Not_A Brand', version: '24' },
  ],
  fullVersionList: [
    { brand: 'Google Chrome', version: '131.0.6778.86' },
    { brand: 'Chromium', version: '131.0.6778.86' },
    { brand: 'Not_A Brand', version: '24.0.0.0' },
  ],
  fullVersion: '131.0.6778.86',
  platform: 'macOS',
  platformVersion: '10.15.7',
  architecture: 'x86',
  model: '',
  mobile: false,
  bitness: '64',
  wow64: false,
};

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
        for (const h of handlers) h(msg.params, msg.sessionId);
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
    // Let the auto-play daemon actually start playback — without this,
    // Chrome's autoplay policy rejects video.play() when no user gesture
    // has occurred, so players like cloudnestra never fetch their m3u8.
    '--autoplay-policy=no-user-gesture-required',
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

  // --- Ad/tracker blocker (EasyList + EasyPrivacy) -----------------------
  // Full blocklist loaded from @ghostery/adblocker. We intercept every
  // request via Fetch.enable, test against the engine, and fail ad/tracker
  // requests instead of letting them load. Streaming sites pile on pre-roll
  // ads, pop-unders, and analytics that delay or outright block the real
  // player — blocking them upfront often lets the player initialize and
  // emit its signed m3u8.
  let adblockEngine = null;
  try {
    adblockEngine = await FiltersEngine.fromPrebuiltAdsAndTracking(fetch);
    debug('Adblocker engine loaded');
  } catch (e) {
    debug('Adblocker engine load failed:', e.message);
  }

  if (adblockEngine) {
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    const setupAdblockForSession = (sid) => {
      browser.sendToSession(sid, 'Fetch.enable', { patterns: [{ urlPattern: '*' }] }).catch(() => {});
    };
    const reply = (method, p, sid) => {
      if (sid) return browser.sendToSession(sid, method, p).catch(() => {});
      return browser.send(method, p).catch(() => {});
    };
    browser.on('Fetch.requestPaused', async (params, sid) => {
      const reqId = params.requestId;
      const reqUrl = params.request?.url || '';
      const resourceType = (params.resourceType || 'other').toLowerCase();
      // Keep direct media/manifest requests — never block the real video.
      if (resourceType === 'media' ||
          /\.m3u8|\.mpd|mpegurl|master\.m3u8|chunklist/i.test(reqUrl)) {
        reply('Fetch.continueRequest', { requestId: reqId }, sid);
        return;
      }
      try {
        const r = AdblockRequest.fromRawDetails({
          url: reqUrl,
          type: resourceType,
          sourceUrl: url,
        });
        const { match } = adblockEngine.match(r);
        if (match) {
          reply('Fetch.failRequest', { requestId: reqId, errorReason: 'BlockedByClient' }, sid);
          return;
        }
      } catch {}
      reply('Fetch.continueRequest', { requestId: reqId }, sid);
    });
  }

  // Auto-attach to every OOPIF / sub-target in flat mode. Without this,
  // cross-origin iframes (cloudnestra nested inside vsembed, vidcdn nested
  // inside tinyzonetv, etc.) may run as out-of-process frames that don't
  // route Network events to our top session. Flat auto-attach also makes
  // our Page.addScriptToEvaluateOnNewDocument injection propagate to
  // sub-frames, which is what lets the auto-play daemon reach nested
  // players and trigger m3u8 fetches.
  await send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  // When a child target attaches, enable Network/Page/Runtime on it too so
  // its events reach the top event bus. In flat mode all sessions share
  // the same WebSocket so the existing method handlers fire regardless of
  // which session the event came from.
  browser.on('Target.attachedToTarget', async (params) => {
    const childSid = params.sessionId;
    try { await browser.sendToSession(childSid, 'Network.enable', {}); } catch {}
    try { await browser.sendToSession(childSid, 'Runtime.enable', {}); } catch {}
    try { await browser.sendToSession(childSid, 'Page.enable', {}); } catch {}
    try { await browser.sendToSession(childSid, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }); } catch {}
    // Same UA + Client Hints override on every child target. Without this
    // each OOPIF requests resources with default headless headers, leaking
    // "HeadlessChrome" in Sec-CH-UA and tripping Cloudflare on nested
    // players (cloudnestra, streamingnow, …).
    try {
      await browser.sendToSession(childSid, 'Network.setUserAgentOverride', {
        userAgent: UA_STRING,
        acceptLanguage: 'en-US,en;q=0.9',
        platform: 'macOS',
        userAgentMetadata: UA_METADATA,
      });
    } catch {}
    if (adblockEngine) {
      try { await browser.sendToSession(childSid, 'Fetch.enable', { patterns: [{ urlPattern: '*' }] }); } catch {}
    }
    // Re-inject stealth + auto-play daemon into every sub-frame, so nested
    // players (cloudnestra, vidcdn, …) also auto-play and emit m3u8.
    try {
      await browser.sendToSession(childSid, 'Page.addScriptToEvaluateOnNewDocument', {
        source: STEALTH_AND_AUTOPLAY_SOURCE,
      });
    } catch {}
    // If the child frame has already committed a document, re-run the
    // daemon manually since addScriptToEvaluateOnNewDocument only takes
    // effect on NEW navigations.
    try {
      await browser.sendToSession(childSid, 'Runtime.evaluate', {
        expression: STEALTH_AND_AUTOPLAY_SOURCE,
        returnByValue: false,
        awaitPromise: false,
      });
    } catch {}
  });

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

  // Hide headless Chrome signals to bypass bot detection.
  // userAgentMetadata overrides the Sec-CH-UA-* Client Hint headers Chrome
  // sends — without this, headless still leaks "HeadlessChrome" in
  // sec-ch-ua, which Cloudflare Bot Fight Mode flags. Brand list mirrors a
  // real Chrome 131 on macOS.
  await send('Network.setUserAgentOverride', {
    userAgent: UA_STRING,
    acceptLanguage: 'en-US,en;q=0.9',
    platform: 'macOS',
    userAgentMetadata: UA_METADATA,
  });

  // Referer handling moved into the Page.navigate call below — setting a
  // global extra header would leak the parent-page Referer onto every
  // sub-resource request, which trips anti-hotlink logic on some embed
  // hosts (e.g. vidcdn.co returns an interstitial).
  // Runs on every new document — top frame AND every iframe. Anti-bot
  // stealth + an auto-play daemon so nested player iframes (cloudnestra,
  // vidcdn, weneverbeenfree, etc.) fetch their signed m3u8 without
  // requiring user interaction.
  const STEALTH_AND_AUTOPLAY_SOURCE = `
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' });
    // navigator.userAgentData JS API — read by anti-bot scripts independently
    // of the HTTP Sec-CH-UA-* headers; both must agree to look real.
    try {
      const _brands = [
        { brand: 'Google Chrome', version: '131' },
        { brand: 'Chromium', version: '131' },
        { brand: 'Not_A Brand', version: '24' },
      ];
      const _hv = {
        architecture: 'x86', bitness: '64', brands: _brands,
        fullVersionList: [
          { brand: 'Google Chrome', version: '131.0.6778.86' },
          { brand: 'Chromium', version: '131.0.6778.86' },
          { brand: 'Not_A Brand', version: '24.0.0.0' },
        ],
        mobile: false, model: '', platform: 'macOS', platformVersion: '10.15.7',
        uaFullVersion: '131.0.6778.86', wow64: false,
      };
      Object.defineProperty(navigator, 'userAgentData', {
        get: () => ({
          brands: _brands, mobile: false, platform: 'macOS',
          getHighEntropyValues: () => Promise.resolve(_hv),
          toJSON: () => ({ brands: _brands, mobile: false, platform: 'macOS' }),
        }),
      });
    } catch(e) {}
    // Permissions.query notifications quirk: real Chrome returns 'prompt'
    // when the browser is in default state, headless returns 'denied'.
    try {
      const _origQuery = navigator.permissions && navigator.permissions.query;
      if (_origQuery) {
        navigator.permissions.query = (p) =>
          p && p.name === 'notifications'
            ? Promise.resolve({ state: 'prompt', onchange: null })
            : _origQuery.call(navigator.permissions, p);
      }
    } catch(e) {}
    // WebGL vendor/renderer spoof — many anti-bot fingerprints check this.
    try {
      const _gp = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(p) {
        if (p === 37445) return 'Intel Inc.';
        if (p === 37446) return 'Intel Iris OpenGL Engine';
        return _gp.call(this, p);
      };
    } catch(e) {}
    window.chrome = { runtime: {}, app: { isInstalled: false }, csi: () => {}, loadTimes: () => {} };
    // Some players (cloudnestra, vidsrc, …) gate their start-playback handler
    // behind \`event.isTrusted\` to require a real user click. Synthetic
    // \`element.click()\` fires events with isTrusted=false and is ignored.
    // Force the getter to lie so the auto-play daemon's clicks count.
    try {
      Object.defineProperty(Event.prototype, 'isTrusted', { get: () => true, configurable: true });
    } catch(e) {}
    // Block ad-driven window.open and popups
    window.open = () => null;

    // Auto-play daemon: click any play/consent button and force HTMLVideo
    // elements to play. Runs multiple times at staggered intervals so
    // late-mounted players (JWPlayer, playerjs, dash.js, Plyr…) catch up.
    (function() {
      const PLAY_SEL = [
        '.vjs-big-play-button','.ytp-large-play-button',
        '[class*="play-button" i]','[class*="play_button" i]',
        '[aria-label*="play" i]','button[class*="play" i]',
        '.jw-icon-display','.plyr__control--overlaid','.flowplayer .fp-ui',
        '#pl_but','.play','[id*="player" i] [class*="play"]',
      ];
      const CONSENT_SEL = [
        '[id*="accept" i][id*="cookie" i]',
        'button[id*="accept" i]','button[class*="accept" i]',
        '[aria-label*="accept" i]','[aria-label*="agree" i]',
        '#onetrust-accept-btn-handler','.cc-accept','.cc-allow','.gdpr-accept',
      ];
      function tick() {
        try {
          for (const s of CONSENT_SEL) {
            const b = document.querySelector(s);
            if (b && b.offsetParent !== null) { try { b.click(); } catch(e) {} break; }
          }
          for (const s of PLAY_SEL) {
            const b = document.querySelector(s);
            if (b && b.offsetParent !== null) { try { b.click(); } catch(e) {} }
          }
          document.querySelectorAll('video').forEach(v => {
            try { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch(e) {}
          });
        } catch(e) {}
      }
      // Kick on DOMContentLoaded + at multiple delays to catch late-init
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tick, { once: true });
      } else { tick(); }
      [1000, 3000, 6000, 10000, 15000].forEach(ms => setTimeout(tick, ms));
    })();
  `;
  await send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_AND_AUTOPLAY_SOURCE });

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
          // Collect structural candidates with a "selected" flag so we can
          // prioritize the default server (e.g. lookmovie ships with
          // #Nav_Easycloud.selected — the page expects that one to be
          // loaded first; clicking other servers before it disrupts the
          // expected iframe-chain).
          const structCands = [];
          let idx = 0;
          for (const el of document.querySelectorAll(structuralSel)) {
            if (el.offsetParent === null) continue;
            const label = (el.textContent || '').trim().toLowerCase();
            const cls = (el.className || '').toString().toLowerCase();
            if (/trailer|preview|teaser/.test(label + ' ' + cls)) continue;
            el.setAttribute('data-snatch-idx', String(idx));
            const selected = /\\bselected\\b|\\bactive\\b/i.test(cls) || el.getAttribute('aria-selected') === 'true';
            structCands.push({type:'sel', sel:'[data-snatch-idx="' + idx + '"]', label: label.slice(0,30), selected});
            idx++;
          }
          // Selected-first: move any .selected/.active server to the very
          // front of the candidate list, before fn-type loaders.
          const selected = structCands.filter(c => c.selected);
          const others = structCands.filter(c => !c.selected);
          const finalCands = [...selected, ...cands, ...others];
          return JSON.stringify(finalCands);
        })()`
      );
      const candidates = JSON.parse(enumResult || '[]');
      debug('Server candidates:', candidates.length);

      // Baseline: iframes present before any server click. Anything beyond
      // this set is "produced by a click" — if a click yields a fresh
      // external iframe in default mode, we trust it and stop clicking so
      // subsequent clicks don't overwrite its iframe src.
      const baselineIframes = new Set(
        [...videoUrls].filter((u) => u.startsWith('IFRAME:'))
      );
      const hasFreshExternalIframe = () =>
        [...videoUrls].some((u) => {
          if (!u.startsWith('IFRAME:') || baselineIframes.has(u)) return false;
          const raw = u.slice('IFRAME:'.length);
          if (SOCIAL_IFRAME_RE.test(raw)) return false;
          try {
            const h = new URL(raw, `https://${pageHostForMatch}`).hostname;
            const d = h.split('.').slice(-2).join('.');
            return !!d && d !== pageDomainForMatch;
          } catch { return false; }
        });

      // Click candidates one at a time with a long polling window so the
      // first-clicked embed has time to emit its signed m3u8/mpd request.
      // Default mode stops on the first high-confidence URL OR as soon as
      // a fresh external iframe appears (trust the default/selected
      // server's iframe chain to complete; further clicks overwrite it).
      // ALL_SERVERS keeps going so the user sees every fallback.
      const MAX_SERVERS = Math.min(candidates.length, 5);
      for (let i = 0; i < MAX_SERVERS; i++) {
        if (!ALL_SERVERS && (hasHighConfidence() || hasFreshExternalIframe())) break;
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
        // Inner wait: with ALL_SERVERS, wait the full window so each
        // server has time to emit its own signed m3u8. In default mode,
        // break early on the first high-confidence hit. We never break
        // on iframe-appearance alone — streaming embeds load in two
        // phases (iframe DOM swap → player init → signed m3u8) and we
        // want the m3u8 on the top-level Network listener.
        for (let w = 0; w < 16; w++) {
          await new Promise((r) => setTimeout(r, 500));
          if (!ALL_SERVERS && hasHighConfidence()) break;
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

      // After server clicks, if we have a fresh external iframe but no
      // signed URL yet, wait long enough for the nested embed chain
      // (iframe → player init → signed m3u8) to finish. Without this
      // extra window, sites like lookmovie → vsembed → cloudnestra → final
      // player don't get time to emit the m3u8 to our top Network
      // listener (which flat-mode OOPIF attachment routes through).
      if (!hasHighConfidence() && hasFreshExternalIframe()) {
        debug('Fresh embed iframe present, waiting for nested player to emit m3u8...');
        for (let w = 0; w < 40; w++) {
          await new Promise((r) => setTimeout(r, 500));
          if (hasHighConfidence()) break;
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
  // Build a ranked list of plausible follow targets: HTML player pages
  // captured by the network handler, plus any external DOM iframe we picked
  // up. Without the DOM-iframe fallback we miss server-injected embeds
  // that haven't emitted an HTML response yet at decision time. Ranking
  // pushes external embed paths (cloudnestra/rcp, /embed/, /player/) to
  // the front and demotes same-origin / mainstream-platform / parent-page
  // self-references.
  const scoreFollowCandidate = (u) => {
    let s = 60;
    let host = '';
    try { host = new URL(u, url).hostname; } catch {}
    const etld = (h) => (h || '').split('.').slice(-2).join('.');
    if (host && pageDomainForMatch && etld(host) === pageDomainForMatch) s -= 50;
    if (/(^|\.)(youtube|youtu\.be|vimeo|dailymotion|twitch|tiktok|instagram)\./i.test(host)) s -= 80;
    if (/\/(rcp|prorcp)\//i.test(u)) s += 40;
    if (/\/(embed|e|v|watch|player|stream|iframe)(\/|[?#]|$)/i.test(u)) s += 20;
    return s;
  };
  const followTargets = (() => {
    const seen = new Set();
    const items = [];
    for (const u of htmlPlayerPages) {
      if (seen.has(u)) continue;
      seen.add(u);
      items.push({ url: u, score: scoreFollowCandidate(u) + 10 });
    }
    for (const u of videoUrls) {
      if (!u.startsWith('IFRAME:')) continue;
      const raw = u.slice('IFRAME:'.length);
      if (SOCIAL_IFRAME_RE.test(raw)) continue;
      let resolved;
      try { resolved = new URL(raw, url).toString(); } catch { resolved = raw; }
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      items.push({ url: resolved, score: scoreFollowCandidate(resolved) });
    }
    return items.sort((a, b) => b.score - a.score).map((i) => i.url);
  })();
  if (realVideoUrls.length === 0 && followTargets.length > 0) {
    // Follow the iframe chain INTERNALLY in this same Chrome instance — do
    // NOT spawn a fresh Chrome per hop. Many embed hosts (cloudnestra,
    // streamingnow, …) bind their signed token URLs to the cookies/session
    // set during the parent navigation, and refuse iframe loads from a
    // pristine browser profile. Reusing the existing browser keeps every
    // cookie set during depth N available when we follow the embed at
    // depth N+1.
    // Inject embed iframes directly into the parent page's document — the
    // page is already loaded in the existing session with its real origin
    // and any cookies it set. Nested players (cloudnestra, vidsrc, …) then
    // see the parent-page origin in their referer / CSP frame-ancestors /
    // Sec-Fetch-Site checks, mirroring what a real browser does. A fresh
    // tab or data: wrapper loses that referrer chain and gets refused.
    const MAX_INTERNAL_DEPTH = 4;
    const visited = new Set();
    let currentPlayerUrl = followTargets[0];
    let internalDepth = 0;

    debug('No video found, following player page:', currentPlayerUrl);

    while (
      internalDepth < MAX_INTERNAL_DEPTH &&
      !hasHighConfidence() &&
      currentPlayerUrl &&
      !visited.has(currentPlayerUrl)
    ) {
      visited.add(currentPlayerUrl);
      debug(`Internal follow depth ${internalDepth}:`, currentPlayerUrl);

      // Snapshot iframes BEFORE this nav so we can detect ones produced by
      // it — that's how we choose the next hop in the chain.
      const baselineIframes = new Set(
        [...videoUrls].filter((u) => u.startsWith('IFRAME:'))
      );

      // Inject (or replace) a full-page iframe in the parent document. This
      // gives the embed a real same-origin parent (the page we're already
      // on), so referer / CSP frame-ancestors / Sec-Fetch checks all see
      // the legitimate site as the embedder.
      const injectExpr = `(function(){
        try {
          var existing = document.getElementById('__snatch_follow_iframe__');
          if (existing) existing.parentNode.removeChild(existing);
          var f = document.createElement('iframe');
          f.id = '__snatch_follow_iframe__';
          f.src = ${JSON.stringify(currentPlayerUrl)};
          f.referrerPolicy = 'origin';
          f.allow = 'autoplay; fullscreen; encrypted-media';
          f.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;border:0;z-index:2147483647;background:#000';
          document.body.appendChild(f);
          return 'ok';
        } catch (e) { return 'err:' + e.message; }
      })()`;
      try {
        const r = await browser.evaluate(sessionId, injectExpr);
        debug('Inject iframe result:', r);
      } catch (e) {
        debug('Inject iframe failed:', e.message);
        break;
      }

      // No Page.loadEventFired here — the parent page is already loaded;
      // we're waiting for the injected iframe's chain to settle. Just give
      // it a moment, then poll.
      await new Promise((r) => setTimeout(r, 500));

      // Long polling window — embed chain (player page → nested iframe →
      // signed m3u8) needs time. Flat-mode auto-attach routes child OOPIF
      // network events to our top handlers, so any m3u8 fetched by the
      // nested chain populates videoUrls regardless of which frame fired
      // it.
      // Enumerate every iframe OOPIF in the browser and (a) probe its DOM
      // for video URLs, (b) record its own URL as a follow candidate. The
      // top session's querySelectorAll can't reach into cross-origin iframes,
      // so we query each child target directly. Auto-attach guarantees
      // these targets exist by the time we get here; we just need to
      // walk them.
      const probeAllIframeTargets = async () => {
        let tgs;
        try { tgs = await browser.send('Target.getTargets', {}); } catch { return; }
        for (const ti of (tgs.targetInfos || [])) {
          if (ti.type !== 'iframe') continue;
          if (!ti.url || !ti.url.startsWith('http')) continue;
          // Surface this iframe as a follow candidate so the next-hop
          // selector can rank it. Skip parent self-references.
          videoUrls.add('IFRAME:' + ti.url);
          // DOM-probe the iframe for video URLs / nested iframes.
          try {
            const a = await browser.send('Target.attachToTarget', { targetId: ti.targetId, flatten: true });
            const csid = a.sessionId;
            const value = await browser.evaluate(csid, DOM_EXTRACT_SCRIPT);
            const extracted = JSON.parse(value || '[]');
            for (const u of extracted) {
              if (u && !isJunk(u)) videoUrls.add(u);
            }
          } catch {}
        }
      };
      for (let poll = 0; poll < 20; poll++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (hasHighConfidence()) break;
        await probeAllIframeTargets();
        if (hasHighConfidence()) break;
      }

      if (hasHighConfidence()) break;

      // Pick next iframe to follow — score candidates so we always go for
      // the highest-confidence embed (cloudnestra/rcp, /embed/, …) before
      // filler frames. Skip social widgets, the parent page itself, and
      // anything we've already visited.
      const nextHopUrl = (() => {
        let parentEtld = '';
        try { parentEtld = new URL(currentPlayerUrl).hostname.split('.').slice(-2).join('.'); } catch {}
        const ranked = [];
        const seen = new Set();
        const consider = (raw, freshBoost) => {
          if (!raw || SOCIAL_IFRAME_RE.test(raw)) return;
          let resolved;
          try { resolved = new URL(raw, currentPlayerUrl).toString(); } catch { resolved = raw; }
          if (seen.has(resolved) || visited.has(resolved)) return;
          seen.add(resolved);
          let host = '';
          try { host = new URL(resolved).hostname; } catch {}
          // Skip parent self-references — following the same page in a loop
          // never resolves to a deeper player.
          if (host && parentEtld && host.split('.').slice(-2).join('.') === parentEtld) return;
          ranked.push({ url: resolved, score: scoreFollowCandidate(resolved) + freshBoost });
        };
        for (const u of videoUrls) {
          if (!u.startsWith('IFRAME:')) continue;
          const raw = u.slice('IFRAME:'.length);
          consider(raw, baselineIframes.has(u) ? 0 : 15);
        }
        ranked.sort((a, b) => b.score - a.score);
        return ranked[0] ? ranked[0].url : null;
      })();

      if (!nextHopUrl) break;
      currentPlayerUrl = nextHopUrl;
      internalDepth++;
    }

    // Clean up: remove the injected iframe so any later DOM extraction on
    // the parent page isn't polluted by it.
    try {
      await browser.evaluate(sessionId,
        `(function(){var f=document.getElementById('__snatch_follow_iframe__');if(f)f.parentNode.removeChild(f);return 'ok';})()`);
    } catch {}
    // Tell the bash wrapper not to spawn a new Chrome to follow our top
    // IFRAME: result. We just exhausted that chain in this session — re-doing
    // it in a pristine browser would lose the cookies that the embed token
    // is bound to, and would just fail again.
    console.error('INTERNAL_FOLLOW_EXHAUSTED');
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

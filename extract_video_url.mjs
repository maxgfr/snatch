// CDP-based video URL extractor using raw Chrome DevTools Protocol
// No Playwright - uses WebSocket directly via ws package

import { execSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const url = process.argv[2];
if (!url) {
  console.error('Usage: node extract_video_url.mjs <URL>');
  process.exit(1);
}

const TIMEOUT = parseInt(process.env.EXTRACT_TIMEOUT || '30000', 10);
const CHROME_PROFILE = '/tmp/snatch-chrome-profile';

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

  on(event, handler) {
    if (!this.events.has(event)) this.events.set(event, []);
    this.events.get(event).push(handler);
  }

  async evaluate(expr) {
    const result = await this.send('Runtime.evaluate', {
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
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ];
  for (const p of paths) {
    try {
      execSync(`test -f "${p}"`, { stdio: 'ignore' });
      return p;
    } catch {}
  }
  // Try which
  for (const cmd of ['google-chrome', 'chromium', 'chromium-browser']) {
    try {
      return execSync(`which ${cmd}`, { stdio: 'pipe' }).toString().trim();
    } catch {}
  }
  throw new Error('Chrome/Chromium not found');
}

// --- Launch Chrome --------------------------------------------------------

function launchChrome() {
  const chromePath = findChrome();
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-web-security',
    '--disable-features=VizDisplayCompositor',
    `--user-data-dir=${CHROME_PROFILE}`,
    '--remote-debugging-port=0',
    '--mute-audio',
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
  /\.(m3u8|mp4|webm|mkv|ts|mpd)(\?|$)/i.test(u) ||
  /master\.m3u8|index\.m3u8|playlist\.m3u8|manifest\.mpd/i.test(u);

const isJunk = (u) =>
  /test-videos\.co\.uk|blob:/i.test(u) ||
  /\.(js|css|png|jpg|gif|svg|woff|ico|json)(\?|$)/i.test(u);

const isVideoContentType = (ct) =>
  ct.includes('mpegurl') ||
  ct.includes('video/') ||
  ct.includes('application/dash') ||
  ct.includes('application/x-mpegURL');

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

  // Send commands to the tab session
  const send = (method, params = {}) =>
    browser.send(method, params);

  // For session-based messaging, we need to wrap
  const sendToTarget = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++browser.nextId;
      const timer = setTimeout(() => {
        browser.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 60000);

      // Listen for response via Target.receivedMessageFromTarget or flat session
      browser.pending.set(id, { resolve, reject, timer });
      browser.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  // Enable network interception
  await sendToTarget('Network.enable');
  await sendToTarget('Page.enable');
  await sendToTarget('Runtime.enable');

  // Collect video URLs from network
  browser.on('Network.responseReceived', (params) => {
    if (params.sessionId !== undefined && params.sessionId !== sessionId) return;
    const u = params.response?.url || '';
    const ct = params.response?.headers?.['content-type'] || params.response?.mimeType || '';
    if (isJunk(u)) return;
    if (isVideoUrl(u) || isVideoContentType(ct)) {
      videoUrls.add(u);
    }
  });

  browser.on('Network.requestWillBeSent', (params) => {
    const u = params.request?.url || '';
    if (!isJunk(u) && isVideoUrl(u)) {
      videoUrls.add(u);
    }
  });

  // Navigate to URL
  try {
    await sendToTarget('Page.navigate', { url });
  } catch (e) {
    console.error('NAVIGATE_ERROR:' + e.message);
  }

  // Wait for page to load and player to initialize
  await new Promise((r) => setTimeout(r, 5000));

  // Extract from DOM and player APIs
  try {
    const domUrls = await sendToTarget('Runtime.evaluate', {
      expression: `(function() {
        const results = [];
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
        // HTML5 video and source elements
        document.querySelectorAll('video, video source, source').forEach(el => {
          ['src', 'data-src', 'data-file'].forEach(attr => {
            const v = el.getAttribute(attr);
            if (v && !v.startsWith('blob:') && !v.includes('test-videos')) results.push(v);
          });
        });
        // Iframes
        document.querySelectorAll('iframe').forEach(el => {
          const s = el.getAttribute('src');
          if (s && /embed|player|video|stream/i.test(s)) results.push('IFRAME:' + s);
        });
        return JSON.stringify(results);
      })()`,
      returnByValue: true,
    });

    const extracted = JSON.parse(domUrls.result?.value || '[]');
    for (const u of extracted) {
      if (!isJunk(u)) videoUrls.add(u);
    }
  } catch (e) {
    console.error('DOM_EXTRACT_ERROR:' + e.message);
  }

  // If nothing found yet, wait longer and retry
  if (videoUrls.size === 0) {
    await new Promise((r) => setTimeout(r, 8000));
    try {
      const retry = await sendToTarget('Runtime.evaluate', {
        expression: `(function() {
          const r = [];
          if (typeof jwplayer !== 'undefined') {
            try { const pl = jwplayer().getPlaylist(); if (pl) pl.forEach(i => { if (i.file) r.push(i.file); }); } catch(e) {}
          }
          document.querySelectorAll('video, video source').forEach(el => {
            if (el.src && !el.src.startsWith('blob:') && !el.src.includes('test-videos')) r.push(el.src);
          });
          return JSON.stringify(r);
        })()`,
        returnByValue: true,
      });
      const retryUrls = JSON.parse(retry.result?.value || '[]');
      for (const u of retryUrls) {
        if (!isJunk(u)) videoUrls.add(u);
      }
    } catch {}
  }

  // Clean up
  try {
    await browser.send('Target.closeTarget', { targetId });
  } catch {}
  browser.disconnect();

  // Output results
  const results = [...videoUrls];
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
}

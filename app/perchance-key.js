const { BrowserWindow, session } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

// Chrome binary paths per platform
function findChromePath() {
  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ]
    : process.platform === 'win32'
    ? [
        path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
      ]
    : [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
      ];

  return candidates.find(p => {
    try { return fs.existsSync(p); } catch { return false; }
  });
}

// Fetch JSON from an HTTP URL (for CDP endpoint discovery)
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Wait for Chrome's debug port to become available
async function waitForDebugPort(port, maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      await fetchJSON(`http://127.0.0.1:${port}/json/version`);
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return false;
}

/**
 * Extract a Perchance userKey by launching the system's Chrome browser
 * with remote debugging, then intercepting network requests via CDP.
 * Uses browser-level auto-attach to monitor ALL targets (including
 * cross-origin iframes where the actual generation requests originate).
 */
async function extractPerchanceKeyViaChrome(store) {
  const chromePath = findChromePath();
  if (!chromePath) {
    console.log('[PerchanceKey] No system Chrome found, cannot use Chrome extraction');
    return null;
  }

  console.log(`[PerchanceKey] Using system Chrome: ${chromePath}`);

  const debugPort = 9222 + Math.floor(Math.random() * 700);
  const tmpDir = path.join(os.tmpdir(), `sv-chrome-extract-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const chromeArgs = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${tmpDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    'https://perchance.org/ai-text-to-image-generator',
  ];

  const chrome = spawn(chromePath, chromeArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  let chromeExited = false;
  chrome.on('exit', () => { chromeExited = true; });
  chrome.on('error', (err) => {
    console.error('[PerchanceKey] Chrome launch error:', err.message);
  });

  function cleanup() {
    if (!chromeExited) {
      try { chrome.kill(); } catch {}
    }
    // Clean up temp dir after a delay
    setTimeout(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }, 2000);
  }

  return new Promise(async (resolve) => {
    let resolved = false;

    function done(key) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      if (key) {
        store.set('perchanceUserKey', key);
        store.set('perchanceKeyAcquiredAt', Date.now());
        console.log(`[PerchanceKey] Key captured via Chrome: ${key.substring(0, 10)}...`);
      }
      try { ws?.close(); } catch {}
      cleanup();
      resolve(key || null);
    }

    // Timeout — 2 minutes for user to complete Cloudflare + click Generate
    const timeout = setTimeout(() => {
      console.log('[PerchanceKey] Chrome extraction timed out');
      done(null);
    }, 120000);

    let ws;

    try {
      // Wait for Chrome debug port
      console.log(`[PerchanceKey] Waiting for Chrome debug port ${debugPort}...`);
      const ready = await waitForDebugPort(debugPort);
      if (!ready) {
        console.log('[PerchanceKey] Chrome debug port did not become available');
        done(null);
        return;
      }

      // Connect to the BROWSER-level WebSocket (not a page target)
      // This lets us auto-attach to all targets including cross-origin iframes
      const version = await fetchJSON(`http://127.0.0.1:${debugPort}/json/version`);
      const browserWsUrl = version.webSocketDebuggerUrl;

      console.log(`[PerchanceKey] Connecting to browser CDP: ${browserWsUrl}`);
      ws = new WebSocket(browserWsUrl);

      let cmdId = 1;
      function cdpSend(method, params = {}, sessionId) {
        const msg = { id: cmdId++, method, params };
        if (sessionId) msg.sessionId = sessionId;
        ws.send(JSON.stringify(msg));
      }

      ws.on('open', () => {
        console.log('[PerchanceKey] CDP connected to browser, setting up auto-attach...');

        // Auto-attach to ALL targets (pages, iframes, workers, etc.)
        // flatten:true gives us sessionIds so we can send commands to each target
        cdpSend('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        });

        // Also enable network on existing targets
        // First get all existing targets and attach manually
        cdpSend('Target.getTargets');
      });

      // Track sessions we've enabled Network on
      const enabledSessions = new Set();

      function enableNetworkOnSession(sessionId) {
        if (enabledSessions.has(sessionId)) return;
        enabledSessions.add(sessionId);
        cdpSend('Network.enable', {}, sessionId);
        console.log(`[PerchanceKey] Network.enable on session ${sessionId.substring(0, 12)}...`);
      }

      function checkForKey(url) {
        try {
          if (!url.includes('image-generation.perchance.org')) return;
          const parsed = new URL(url);
          const userKey = parsed.searchParams.get('userKey');
          if (userKey && userKey.length === 64) {
            done(userKey);
          }
        } catch {}
      }

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          // When a new target is auto-attached, enable Network monitoring on it
          if (msg.method === 'Target.attachedToTarget') {
            const sessionId = msg.params.sessionId;
            const targetInfo = msg.params.targetInfo;
            console.log(`[PerchanceKey] Attached to target: ${targetInfo.type} - ${targetInfo.url?.substring(0, 60)}`);
            enableNetworkOnSession(sessionId);
          }

          // Network request from any session — check for userKey
          if (msg.method === 'Network.requestWillBeSent') {
            checkForKey(msg.params.request.url);
          }

          // Also handle the getTargets response to attach to existing targets
          if (msg.id && msg.result?.targetInfos) {
            for (const target of msg.result.targetInfos) {
              if (target.type === 'page' || target.type === 'iframe') {
                cdpSend('Target.attachToTarget', {
                  targetId: target.targetId,
                  flatten: true,
                });
              }
            }
          }
        } catch {}
      });

      ws.on('error', (err) => {
        console.error('[PerchanceKey] CDP WebSocket error:', err.message);
      });

      ws.on('close', () => {
        console.log('[PerchanceKey] CDP connection closed');
      });

      // If Chrome exits before we get the key (user closed it)
      chrome.on('exit', () => {
        done(null);
      });

    } catch (err) {
      console.error('[PerchanceKey] Chrome extraction error:', err);
      done(null);
    }
  });
}

/**
 * Fallback: Extract key using Electron's built-in BrowserWindow.
 * May fail if Perchance's anti-bot detection catches it.
 */
async function extractPerchanceKeyViaElectron(store) {
  const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  return new Promise((resolve) => {
    const partition = 'persist:perchance-api';
    const ses = session.fromPartition(partition);
    ses.setUserAgent(CHROME_UA);

    const win = new BrowserWindow({
      width: 900,
      height: 700,
      show: false,
      title: 'Perchance Key Extraction',
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: false,
        preload: path.join(__dirname, 'perchance-stealth.js'),
      }
    });

    let resolved = false;

    function finish(key) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutTimer);
      ses.webRequest.onBeforeSendHeaders(null);
      if (key) {
        store.set('perchanceUserKey', key);
        store.set('perchanceKeyAcquiredAt', Date.now());
        console.log(`[PerchanceKey] Key extracted via Electron: ${key.substring(0, 10)}...`);
      }
      win.destroy();
      resolve(key || null);
    }

    ses.webRequest.onBeforeSendHeaders(
      { urls: ['*://image-generation.perchance.org/*'] },
      (details, callback) => {
        try {
          const url = new URL(details.url);
          const userKey = url.searchParams.get('userKey');
          if (userKey && userKey.length === 64) {
            finish(userKey);
          }
        } catch {}
        callback({ cancel: false });
      }
    );

    const timeoutTimer = setTimeout(() => {
      if (!resolved) {
        console.log('[PerchanceKey] Electron extraction timed out');
        finish(null);
      }
    }, 90000);

    win.webContents.on('did-finish-load', () => {
      win.show();
      win.webContents.executeJavaScript(`
        (function() {
          if (document.getElementById('sv-extract-banner')) return;
          const banner = document.createElement('div');
          banner.id = 'sv-extract-banner';
          banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;background:#e94560;color:white;padding:12px 20px;font-family:sans-serif;font-size:15px;text-align:center;font-weight:bold;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
          banner.textContent = 'Click "Generate" below once, then this window will close automatically.';
          document.body.appendChild(banner);
          document.body.style.paddingTop = '48px';
        })()
      `).catch(() => {});
    });

    win.on('closed', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutTimer);
        ses.webRequest.onBeforeSendHeaders(null);
        resolve(null);
      }
    });

    win.loadURL('https://perchance.org/ai-text-to-image-generator', {
      userAgent: CHROME_UA
    });
  });
}

/**
 * Main extraction entry point. Tries Electron BrowserWindow first (simpler),
 * falls back to system Chrome if Electron fails (e.g. anti-bot blocks it).
 */
async function extractPerchanceKey(store) {
  // Try Electron BrowserWindow first
  console.log('[PerchanceKey] Attempting extraction via Electron...');
  const electronKey = await extractPerchanceKeyViaElectron(store);
  if (electronKey) return electronKey;

  // Fallback to system Chrome
  const chromePath = findChromePath();
  if (chromePath) {
    console.log('[PerchanceKey] Electron extraction failed, trying system Chrome...');
    return extractPerchanceKeyViaChrome(store);
  }

  return null;
}

/**
 * Check if a stored userKey is still valid.
 * Returns: 'valid', 'not_verified', or 'unknown' (if CF blocks / network error).
 * The image-generation.perchance.org domain is behind Cloudflare. Raw fetch()
 * from the main process has no CF clearance, so we must treat blocked responses
 * as "unknown" rather than "invalid" — the actual generation path uses browserFetch
 * which has CF cookies and will surface the real status.
 */
async function verifyPerchanceKey(userKey) {
  try {
    const url = `https://image-generation.perchance.org/api/checkVerificationStatus?userKey=${encodeURIComponent(userKey)}&__cacheBust=${Math.random()}`;
    const response = await fetch(url);
    const text = await response.text();

    // Cloudflare challenge page — can't verify, assume valid
    if (text.includes('Just a moment') || text.includes('cf_chl_opt') || text.includes('challenge-platform')) {
      console.log('[PerchanceKey] Verification blocked by Cloudflare, assuming key is valid');
      return 'unknown';
    }

    if (text.includes('not_verified')) {
      return 'not_verified';
    }

    return 'valid';
  } catch (e) {
    // Network error / Cloudflare redirect — can't verify
    console.log('[PerchanceKey] Verification request failed (likely CF):', e.message);
    return 'unknown';
  }
}

module.exports = { extractPerchanceKey, verifyPerchanceKey };

const { BrowserWindow, session } = require('electron');
const path = require('path');

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Extract a Perchance userKey by opening an Electron BrowserWindow
 * to the Perchance image generator. Intercepts the network request
 * containing the userKey when the user clicks "Generate".
 */
async function extractPerchanceKey(store) {
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
        console.log(`[PerchanceKey] Key extracted: ${key.substring(0, 10)}...`);
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
        console.log('[PerchanceKey] Extraction timed out');
        finish(null);
      }
    }, 120000);

    win.webContents.on('did-finish-load', () => {
      win.show();
      // Inject instruction banner and auto-fill the prompt field
      win.webContents.executeJavaScript(`
        (function() {
          if (document.getElementById('sv-extract-banner')) return;
          var banner = document.createElement('div');
          banner.id = 'sv-extract-banner';
          banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;background:#e94560;color:white;padding:14px 20px;font-family:sans-serif;font-size:15px;text-align:center;font-weight:bold;box-shadow:0 2px 8px rgba(0,0,0,0.3);line-height:1.5;';
          banner.innerHTML = 'Scene Visualizer — Key Extraction<br><span style="font-weight:normal;font-size:13px;">1. Wait for the page to fully load &nbsp; 2. Click <b>Generate</b> &nbsp; 3. This window closes automatically</span>';
          document.body.appendChild(banner);
          document.body.style.paddingTop = '64px';

          // Auto-fill the prompt textarea so the user just has to click Generate
          function tryFillPrompt() {
            var ta = document.querySelector('textarea[placeholder*="prompt"], textarea[placeholder*="Prompt"], textarea.prompt');
            if (!ta) ta = document.querySelector('textarea');
            if (ta) {
              var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
              nativeSetter.call(ta, 'a scenic mountain landscape');
              ta.dispatchEvent(new Event('input', { bubbles: true }));
            }
          }
          // Try immediately and again after a short delay (page may still be initializing)
          tryFillPrompt();
          setTimeout(tryFillPrompt, 2000);
          setTimeout(tryFillPrompt, 5000);
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

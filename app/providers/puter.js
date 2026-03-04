// Puter.js Image Generation Provider
// Browser-only SDK (puter.ai.txt2img) — runs in a hidden BrowserWindow
// No API keys needed — users authenticate via Puter account ("User-Pays" model)
//
// IMPORTANT: Puter.js v2 rejects file:// protocol. We serve the helper page
// from a local HTTP server so the SDK loads correctly.

const { BrowserWindow } = require('electron');
const http = require('http');

// Persistent hidden BrowserWindow for puter.js calls
let puterWindow = null;
let puterReady = false;
let localServer = null;
let localServerPort = null;

// Model definitions grouped by provider
const MODELS = [
  // OpenAI
  { id: 'gpt-image-1', name: 'GPT Image 1', group: 'OpenAI', hasQuality: true, qualityOptions: ['high', 'medium', 'low'] },
  { id: 'dall-e-3', name: 'DALL-E 3', group: 'OpenAI', hasQuality: true, qualityOptions: ['hd', 'standard'] },
  { id: 'dall-e-2', name: 'DALL-E 2', group: 'OpenAI', hasQuality: false },
  // FLUX
  { id: 'flux-pro/v1.1', name: 'FLUX 1.1 Pro', group: 'FLUX', hasQuality: false },
  { id: 'flux-pro', name: 'FLUX Pro', group: 'FLUX', hasQuality: false },
  { id: 'flux-dev', name: 'FLUX Dev', group: 'FLUX', hasQuality: false },
  { id: 'flux-schnell', name: 'FLUX Schnell', group: 'FLUX', hasQuality: false },
  // Stable Diffusion
  { id: 'stable-diffusion-3-medium', name: 'SD 3 Medium', group: 'Stable Diffusion', hasQuality: false },
  { id: 'stable-diffusion-xl-base-1.0', name: 'SDXL Base 1.0', group: 'Stable Diffusion', hasQuality: false },
  // Google
  { id: 'gemini-2.0-flash-preview-image-generation', name: 'Gemini 2.0 Flash', group: 'Google', hasQuality: false },
  // Other
  { id: 'Seedream-3.0', name: 'Seedream 3.0', group: 'Other', hasQuality: false },
  { id: 'DreamShaper', name: 'DreamShaper', group: 'Other', hasQuality: false },
  { id: 'HiDream-I1-Dev', name: 'HiDream I1 Dev', group: 'Other', hasQuality: false },
];

const MAX_DIMENSION = 1536;

const PUTER_HTML = `<!DOCTYPE html>
<html>
<head><title>Puter.js Image Gen</title></head>
<body>
  <p>Puter.js image generation helper window</p>
  <script src="https://js.puter.com/v2/"></script>
  <script>
    window.__puterLoaded = false;
    window.__puterError = null;
    function checkPuter() {
      try {
        if (typeof puter !== 'undefined') {
          window.__puterLoaded = true;
          return;
        }
      } catch(e) {
        window.__puterError = e.message;
      }
    }
    // Check immediately and retry periodically
    checkPuter();
    var checkInterval = setInterval(function() {
      checkPuter();
      if (window.__puterLoaded || window.__puterError) clearInterval(checkInterval);
    }, 500);
  </script>
</body>
</html>`;

/**
 * Start a local HTTP server to serve the Puter.js helper page.
 * Puter.js v2 rejects file:// protocol, so we must use http://.
 */
function ensureLocalServer() {
  if (localServer && localServerPort) return Promise.resolve(localServerPort);

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(PUTER_HTML);
    });
    server.listen(0, '127.0.0.1', () => {
      localServer = server;
      localServerPort = server.address().port;
      console.log(`[Puter] Local server started on port ${localServerPort}`);
      resolve(localServerPort);
    });
    server.on('error', reject);
  });
}

/**
 * Get or create the persistent BrowserWindow that loads puter.js SDK.
 * On first call, Puter.js may trigger a login popup — the window is shown
 * briefly for auth, then hidden for subsequent calls.
 */
async function getPuterWindow(showForAuth = false) {
  if (puterWindow && !puterWindow.isDestroyed()) {
    if (puterReady) return puterWindow;
  }

  puterWindow = new BrowserWindow({
    show: showForAuth,
    width: 600,
    height: 400,
    title: 'Puter.js — Image Generation',
    webPreferences: {
      partition: 'persist:puter',
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  puterWindow.on('closed', () => {
    puterWindow = null;
    puterReady = false;
  });

  // Load from local HTTP server — Puter.js v2 rejects file:// protocol
  const port = await ensureLocalServer();
  await puterWindow.loadURL(`http://127.0.0.1:${port}/`);

  // Wait for puter.js SDK to load
  const maxWait = 15000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const loaded = await puterWindow.webContents.executeJavaScript('window.__puterLoaded === true');
      if (loaded) {
        console.log('[Puter] SDK loaded successfully');
        puterReady = true;
        return puterWindow;
      }
      const error = await puterWindow.webContents.executeJavaScript('window.__puterError');
      if (error) {
        throw new Error(`Puter.js SDK failed to load: ${error}`);
      }
    } catch (e) {
      if (e.message.includes('SDK failed')) throw e;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  throw new Error('Puter.js SDK did not load within 15 seconds');
}

module.exports = {
  id: 'puter',
  name: 'Puter.js (35+ models)',

  checkReady() {
    // Puter requires no API key — always "ready" (auth happens on first generate)
    return true;
  },

  getModels() {
    return MODELS;
  },

  getArtStyles() {
    return [];
  },

  async generate(prompt, negativePrompt, store) {
    const model = store.get('puterModel') || 'dall-e-3';
    const quality = store.get('puterQuality') || 'standard';
    const settings = store.get('imageSettings');

    const width = Math.min(settings.width || 1024, MAX_DIMENSION);
    const height = Math.min(settings.height || 1024, MAX_DIMENSION);

    const modelDef = MODELS.find(m => m.id === model);
    const useQuality = modelDef && modelDef.hasQuality;

    console.log(`[Puter] Generating with model=${model}, ${width}x${height}${useQuality ? ', quality=' + quality : ''}`);

    // Show window on first use so Puter login popup can appear
    const win = await getPuterWindow(true);

    // Build the options object for puter.ai.txt2img
    const opts = { model, width, height };
    if (negativePrompt) {
      opts.negative_prompt = negativePrompt;
    }
    if (useQuality) {
      opts.quality = quality;
    }

    const optsJson = JSON.stringify(opts);
    const promptJson = JSON.stringify(prompt);

    // Execute txt2img in the browser context — returns data URL from img.src
    const timeoutMs = 120000;

    const genPromise = win.webContents.executeJavaScript(`
      (async () => {
        try {
          const img = await puter.ai.txt2img(${promptJson}, ${optsJson});
          if (img && img.src) {
            return { success: true, dataUrl: img.src };
          }
          return { success: false, error: 'No image returned from puter.ai.txt2img' };
        } catch(e) {
          return { success: false, error: e.message || String(e) };
        }
      })()
    `);

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Puter.js generation timed out after 120s')), timeoutMs)
    );

    const result = await Promise.race([genPromise, timeoutPromise]);

    if (!result.success) {
      throw new Error(`Puter.js generation failed: ${result.error}`);
    }

    // Hide window after successful generation (auth is done)
    if (win && !win.isDestroyed()) {
      win.hide();
    }

    console.log('[Puter] Image generated successfully');
    return result.dataUrl;
  }
};

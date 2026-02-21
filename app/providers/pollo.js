// Pollo AI Image Generation Provider
// Uses internal tRPC API via persistent BrowserWindow (Cloudflare-protected)
// User must log in via browser for session auth

const { BrowserWindow, session } = require('electron');
const path = require('path');

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TRPC_BASE = 'https://pollo.ai/api/trpc';

// Cache for models list
let modelsCache = null;
let modelsCacheTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Persistent hidden BrowserWindow for making API calls through Cloudflare
let apiWindow = null;
let cfReady = false;

// Login window reference
let loginWindow = null;

/**
 * Get or create a hidden BrowserWindow that has Cloudflare clearance
 * for pollo.ai. Uses stealth patches and persistent session so CF
 * clearance survives across requests.
 */
async function getApiWindow() {
  if (apiWindow && !apiWindow.isDestroyed()) {
    if (cfReady) return apiWindow;
  }

  const ses = session.fromPartition('persist:pollo-api');
  ses.setUserAgent(CHROME_UA);

  apiWindow = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      partition: 'persist:pollo-api',
      nodeIntegration: false,
      contextIsolation: false,
      preload: path.join(__dirname, '..', 'perchance-stealth.js'),
    }
  });

  apiWindow.on('closed', () => {
    apiWindow = null;
    cfReady = false;
  });

  console.log('[Pollo] Navigating hidden window to clear Cloudflare...');

  await apiWindow.loadURL('https://pollo.ai/', {
    userAgent: CHROME_UA,
  });

  const cleared = await waitForCfClearance(apiWindow, 30000);
  if (!cleared) {
    console.log('[Pollo] Cloudflare did not auto-clear, may need manual clearance');
  } else {
    console.log('[Pollo] Cloudflare cleared');
  }

  cfReady = true;
  return apiWindow;
}

/**
 * Wait for Cloudflare challenge to auto-solve by checking page title.
 */
async function waitForCfClearance(win, maxWait) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const title = await win.webContents.executeJavaScript('document.title');
      if (!title.includes('Just a moment')) {
        return true;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Execute a fetch request inside the hidden BrowserWindow.
 * Routes through the browser's session which has CF cookies + login session.
 */
async function browserFetch(url, options = {}) {
  const win = await getApiWindow();

  const fetchOptions = JSON.stringify({
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body || undefined,
  });

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const opts = ${fetchOptions};
      if (!opts.body) delete opts.body;
      const res = await fetch(${JSON.stringify(url)}, opts);
      const text = await res.text();
      return { ok: res.ok, status: res.status, body: text };
    })()
  `);

  if (!result.ok) {
    // If CF challenge again, reset and retry once
    if (result.body.includes('Just a moment') || result.body.includes('cf_chl_opt')) {
      console.log('[Pollo] CF challenge on API request, re-clearing...');
      cfReady = false;
      await getApiWindow();

      const retry = await win.webContents.executeJavaScript(`
        (async () => {
          const opts = ${fetchOptions};
          if (!opts.body) delete opts.body;
          const res = await fetch(${JSON.stringify(url)}, opts);
          const text = await res.text();
          return { ok: res.ok, status: res.status, body: text };
        })()
      `);
      return retry;
    }
  }

  return result;
}

/**
 * Fetch binary data (image) via the browser and return as base64.
 */
async function browserFetchBase64(url) {
  const win = await getApiWindow();

  const base64 = await win.webContents.executeJavaScript(`
    (async () => {
      const res = await fetch(${JSON.stringify(url)});
      if (!res.ok) throw new Error('Download failed: ' + res.status);
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode.apply(null, chunk);
      }
      return btoa(binary);
    })()
  `);

  return base64;
}

/**
 * Check if the user is logged in by checking for session cookies.
 */
async function checkLoginStatus() {
  try {
    const win = await getApiWindow();
    const loggedIn = await win.webContents.executeJavaScript(`
      (async () => {
        try {
          // Check if we can access the user-related tRPC endpoint
          const res = await fetch('https://pollo.ai/api/trpc/generationModel.list?input=' + encodeURIComponent(JSON.stringify({json:{modelTypes:["Text2Image"]}})));
          if (!res.ok) return false;
          const data = await res.json();
          // If we get model data, we're authenticated
          return !!(data && data.result && data.result.data);
        } catch {
          return false;
        }
      })()
    `);
    return loggedIn;
  } catch {
    return false;
  }
}

/**
 * Open a visible login window to pollo.ai/sign-in.
 * Returns a promise that resolves when the user navigates away from sign-in
 * (indicating successful login).
 */
async function openLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }

  const ses = session.fromPartition('persist:pollo-api');
  ses.setUserAgent(CHROME_UA);

  loginWindow = new BrowserWindow({
    width: 800,
    height: 700,
    title: 'Log in to Pollo AI',
    webPreferences: {
      partition: 'persist:pollo-api',
      nodeIntegration: false,
      contextIsolation: false,
      preload: path.join(__dirname, '..', 'perchance-stealth.js'),
    }
  });

  loginWindow.on('closed', () => {
    loginWindow = null;
    // Reset CF state so next API call re-initializes with login cookies
    cfReady = false;
    if (apiWindow && !apiWindow.isDestroyed()) {
      apiWindow.destroy();
    }
    apiWindow = null;
  });

  await loginWindow.loadURL('https://pollo.ai/sign-in', {
    userAgent: CHROME_UA,
  });

  // Wait for CF clearance on login page
  await waitForCfClearance(loginWindow, 30000);

  return new Promise((resolve) => {
    // Watch for navigation away from sign-in (user logged in)
    loginWindow.webContents.on('did-navigate', (event, url) => {
      console.log('[Pollo] Login window navigated to:', url);
      if (!url.includes('/sign-in')) {
        console.log('[Pollo] Login appears successful');
        // Close after a brief delay to let cookies settle
        setTimeout(() => {
          if (loginWindow && !loginWindow.isDestroyed()) {
            loginWindow.close();
          }
          resolve(true);
        }, 2000);
      }
    });

    // Also resolve if window is closed manually
    loginWindow.on('closed', () => {
      resolve(false);
    });
  });
}

/**
 * Fetch available text-to-image models from Pollo's tRPC API.
 */
async function fetchModels() {
  const now = Date.now();
  if (modelsCache && (now - modelsCacheTime) < CACHE_TTL_MS) {
    return modelsCache;
  }

  try {
    const input = JSON.stringify({ json: { modelTypes: ['Text2Image'] } });
    const url = `${TRPC_BASE}/generationModel.list?input=${encodeURIComponent(input)}`;
    const result = await browserFetch(url);

    if (!result.ok) {
      console.log(`[Pollo] Failed to fetch models: HTTP ${result.status}`);
      return modelsCache || [];
    }

    const data = JSON.parse(result.body);
    const models = data?.result?.data?.json || [];

    modelsCache = models.map(m => ({
      id: m.modelName,
      name: m.label || m.modelName,
      brand: m.brand || '',
    }));
    modelsCacheTime = now;
    console.log(`[Pollo] Fetched ${modelsCache.length} image models`);
    return modelsCache;
  } catch (e) {
    console.log('[Pollo] Error fetching models:', e.message);
    return modelsCache || [];
  }
}

/**
 * Poll for task completion. Discovers and uses the task status endpoint.
 * Returns the result data when complete, or throws on failure/timeout.
 */
async function pollTaskCompletion(taskId, maxWait = 120000) {
  const start = Date.now();
  const pollInterval = 3000;

  console.log(`[Pollo] Polling task ${taskId} for completion...`);

  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, pollInterval));

    try {
      // Try the generation detail endpoint via tRPC
      const input = JSON.stringify({ json: { id: taskId } });
      const url = `${TRPC_BASE}/generationModel.detail?input=${encodeURIComponent(input)}`;
      const result = await browserFetch(url);

      if (!result.ok) {
        console.log(`[Pollo] Poll request failed: HTTP ${result.status}`);
        continue;
      }

      const data = JSON.parse(result.body);
      const task = data?.result?.data?.json;

      if (!task) {
        console.log('[Pollo] Poll returned no task data');
        continue;
      }

      console.log(`[Pollo] Task status: ${task.status || task.state || 'unknown'}`);

      // Check for completion states
      const taskStatus = (task.status || task.state || '').toLowerCase();

      if (taskStatus === 'completed' || taskStatus === 'success' || taskStatus === 'done') {
        return task;
      }

      if (taskStatus === 'failed' || taskStatus === 'error') {
        throw new Error(`Pollo generation failed: ${task.error || task.message || 'unknown error'}`);
      }

      // Check if output URLs are available (some APIs skip status field)
      if (task.outputs && task.outputs.length > 0) {
        return task;
      }
      if (task.imageUrl || task.resultUrl || task.output) {
        return task;
      }
    } catch (e) {
      if (e.message.startsWith('Pollo generation failed')) throw e;
      console.log('[Pollo] Poll error:', e.message);
    }
  }

  throw new Error('Pollo generation timed out after ' + Math.round(maxWait / 1000) + 's');
}

/**
 * Extract image URL from completed task data.
 */
function extractImageUrl(task) {
  // Try various possible fields
  if (task.outputs && task.outputs.length > 0) {
    const output = task.outputs[0];
    return output.url || output.imageUrl || output;
  }
  if (task.imageUrl) return task.imageUrl;
  if (task.resultUrl) return task.resultUrl;
  if (task.output) {
    if (typeof task.output === 'string') return task.output;
    return task.output.url || task.output.imageUrl;
  }
  if (task.result) {
    if (typeof task.result === 'string') return task.result;
    if (task.result.url) return task.result.url;
    if (task.result.outputs && task.result.outputs.length > 0) {
      const out = task.result.outputs[0];
      return out.url || out.imageUrl || out;
    }
  }
  return null;
}

module.exports = {
  id: 'pollo',
  name: 'Pollo AI',

  checkReady() {
    // Pollo uses browser login, so we consider it "ready" if models have been fetched
    // (meaning the user has logged in at some point)
    return !!modelsCache && modelsCache.length > 0;
  },

  getModels() {
    return modelsCache || [];
  },

  getArtStyles() {
    // Pollo doesn't have separate art styles — styles are per-model
    return [];
  },

  /**
   * Fetch models list (called from IPC handler to populate UI dropdown).
   */
  async fetchModelsForUI() {
    return fetchModels();
  },

  /**
   * Check login status.
   */
  async checkLoginStatus() {
    return checkLoginStatus();
  },

  /**
   * Open login window.
   */
  async openLoginWindow() {
    return openLoginWindow();
  },

  async generate(prompt, negativePrompt, store) {
    const modelName = store.get('polloModel') || 'flux-schnell';
    const aspectRatio = store.get('polloAspectRatio') || '1:1';
    const numOutputs = store.get('polloNumOutputs') || 1;

    console.log(`[Pollo] Generating with model=${modelName}, aspect=${aspectRatio}`);

    // Step 1: Submit generation request via tRPC mutation
    const mutationBody = {
      json: {
        modelName,
        prompt,
        aspectRatio,
        numOutputs,
      }
    };

    const createResult = await browserFetch(`${TRPC_BASE}/generationModel.create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mutationBody),
    });

    if (!createResult.ok) {
      // Check for auth issue
      if (createResult.status === 401 || createResult.status === 403) {
        throw new Error('Pollo AI session expired. Please log in again in Settings.');
      }
      throw new Error(`Pollo API error ${createResult.status}: ${createResult.body.substring(0, 300)}`);
    }

    let createData;
    try {
      createData = JSON.parse(createResult.body);
    } catch {
      throw new Error('Pollo returned non-JSON response: ' + createResult.body.substring(0, 300));
    }

    console.log('[Pollo] Create response:', JSON.stringify(createData).substring(0, 500));

    // Extract task/generation ID from tRPC response
    const resultJson = createData?.result?.data?.json;
    if (!resultJson) {
      throw new Error('Unexpected Pollo response structure: ' + JSON.stringify(createData).substring(0, 300));
    }

    const taskId = resultJson.id || resultJson.taskId || resultJson.generationId;
    if (!taskId) {
      // Maybe the result already contains the image (synchronous generation)
      const immediateUrl = extractImageUrl(resultJson);
      if (immediateUrl) {
        console.log('[Pollo] Got immediate image URL');
        const base64 = await browserFetchBase64(immediateUrl);
        return `data:image/png;base64,${base64}`;
      }
      throw new Error('No task ID in Pollo response: ' + JSON.stringify(resultJson).substring(0, 300));
    }

    // Step 2: Poll for completion
    const completedTask = await pollTaskCompletion(taskId);

    // Step 3: Extract and download image
    const imageUrl = extractImageUrl(completedTask);
    if (!imageUrl) {
      throw new Error('No image URL in completed task: ' + JSON.stringify(completedTask).substring(0, 300));
    }

    console.log('[Pollo] Downloading result image...');
    const base64 = await browserFetchBase64(imageUrl);

    console.log('[Pollo] Image generated successfully');
    return `data:image/png;base64,${base64}`;
  }
};

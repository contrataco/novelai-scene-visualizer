const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

// Providers
const novelaiProvider = require('./providers/novelai');
const perchanceProvider = require('./providers/perchance');
const veniceProvider = require('./providers/venice');
const polloProvider = require('./providers/pollo');
const { extractPerchanceKey, verifyPerchanceKey } = require('./perchance-key');
const storyboard = require('./storyboard');

const PROVIDERS = {
  [novelaiProvider.id]: novelaiProvider,
  [perchanceProvider.id]: perchanceProvider,
  [veniceProvider.id]: veniceProvider,
  [polloProvider.id]: polloProvider,
};

// Secure storage for API token and settings
const store = new Store({
  encryptionKey: 'novelai-scene-visualizer-key',
  schema: {
    apiToken: { type: 'string', default: '' },
    novelaiEmail: { type: 'string', default: '' },
    novelaiPassword: { type: 'string', default: '' },
    provider: { type: 'string', default: 'novelai' },
    perchanceUserKey: { type: 'string', default: '' },
    novelaiArtStyle: { type: 'string', default: 'no-style' },
    perchanceArtStyle: { type: 'string', default: 'no-style' },
    perchanceGuidanceScale: { type: 'number', default: 7 },
    perchanceKeyAcquiredAt: { type: 'number', default: 0 },
    veniceApiKey: { type: 'string', default: '' },
    veniceModel: { type: 'string', default: 'flux-2-max' },
    veniceSteps: { type: 'number', default: 25 },
    veniceCfgScale: { type: 'number', default: 7 },
    veniceStylePreset: { type: 'string', default: '' },
    veniceSafeMode: { type: 'boolean', default: false },
    veniceHideWatermark: { type: 'boolean', default: true },
    polloModel: { type: 'string', default: 'flux-schnell' },
    polloAspectRatio: { type: 'string', default: '1:1' },
    polloNumOutputs: { type: 'number', default: 1 },
    imageSettings: {
      type: 'object',
      default: {
        // Model selection
        model: 'nai-diffusion-4-curated-preview',
        // Dimensions
        width: 832,
        height: 1216,
        // Generation params
        steps: 28,
        scale: 5,
        sampler: 'k_euler',
        noiseSchedule: 'karras',
        // SMEA (only for V3 models)
        smea: false,
        smeaDyn: false,
        // Quality
        cfgRescale: 0,
        qualityTags: true,
        // UC Preset
        ucPreset: 'heavy'
      }
    }
  }
});

function getActiveProvider() {
  const id = store.get('provider') || 'novelai';
  return PROVIDERS[id] || PROVIDERS.novelai;
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true
    },
    title: 'NovelAI Scene Visualizer'
  });

  // Load the wrapper HTML that contains the webview
  mainWindow.loadFile('renderer/index.html');

  // Inject webview preload for bridge communication
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    webPreferences.preload = path.join(__dirname, 'webview-preload.js');
  });

  // Open DevTools in development
  if (process.argv.includes('--enable-logging')) {
    mainWindow.webContents.openDevTools();
  }
}

// Token auto-extraction from NovelAI webview session
function setupTokenInterception() {
  const novelaiSession = session.fromPartition('persist:novelai');

  novelaiSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://api.novelai.net/*', '*://*.novelai.net/api/*'] },
    (details, callback) => {
      const authHeader = details.requestHeaders['Authorization'] ||
                          details.requestHeaders['authorization'];
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token !== store.get('apiToken')) {
          store.set('apiToken', token);
          console.log('[Main] NovelAI token auto-captured from webview session');
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('token-status-changed', { hasToken: true });
          }
        }
      }
      callback({ cancel: false, requestHeaders: details.requestHeaders });
    }
  );
}

// Track current story context in memory
let currentStoryContext = { storyId: null, storyTitle: null };

// Relay story context from webview to renderer
ipcMain.on('story-context-from-webview', (event, data) => {
  currentStoryContext = { storyId: data.storyId || null, storyTitle: data.storyTitle || null };
  console.log('[Main] Story context updated:', currentStoryContext.storyId, currentStoryContext.storyTitle);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('story-context-update', currentStoryContext);
  }
});

// Relay prompts from webview to renderer
ipcMain.on('prompt-from-webview', (event, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Include story context if present in data or from stored context
    if (!data.storyId && currentStoryContext.storyId) {
      data.storyId = currentStoryContext.storyId;
      data.storyTitle = currentStoryContext.storyTitle;
    }
    mainWindow.webContents.send('prompt-update', data);
  }
});

// Relay suggestions from webview to renderer
ipcMain.on('suggestions-from-webview', (event, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('suggestions-update', data);
  }
});

// Token status query
ipcMain.handle('get-token-status', () => ({ hasToken: !!store.get('apiToken') }));

// Clear webview cache (NovelAI partition)
ipcMain.handle('clear-webview-cache', async () => {
  const novelaiSession = session.fromPartition('persist:novelai');
  await novelaiSession.clearCache();
  await novelaiSession.clearStorageData({ storages: ['cachestorage', 'serviceworkers'] });
  console.log('[Main] Webview cache cleared');
  return { success: true };
});

// Load .env file (simple parser, no dependency)
function loadEnvCredentials() {
  const envPath = path.join(__dirname, '.env');
  try {
    if (!fs.existsSync(envPath)) return {};
    const content = fs.readFileSync(envPath, 'utf-8');
    const vars = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      const val = trimmed.substring(eqIdx + 1).trim();
      vars[key] = val;
    }
    return vars;
  } catch (e) {
    console.log('[Main] Could not read .env:', e.message);
    return {};
  }
}

// Seed Venice API key from .env if store is empty
(function seedVeniceKey() {
  if (!store.get('veniceApiKey')) {
    const env = loadEnvCredentials();
    if (env.VENICE_API_KEY) {
      store.set('veniceApiKey', env.VENICE_API_KEY);
      console.log('[Main] Venice API key loaded from .env');
    }
  }
})();

// Get NovelAI credentials (.env primary, store fallback)
ipcMain.handle('get-novelai-credentials', () => {
  const env = loadEnvCredentials();
  const email = env.NOVELAI_EMAIL || store.get('novelaiEmail') || '';
  const password = env.NOVELAI_PASSWORD || store.get('novelaiPassword') || '';
  return { email, password, hasCredentials: !!(email && password) };
});

// Save NovelAI credentials to store
ipcMain.handle('set-novelai-credentials', (event, { email, password }) => {
  if (email !== undefined) store.set('novelaiEmail', email);
  if (password !== undefined) store.set('novelaiPassword', password);
  return { success: true };
});

// ---------------------------------------------------------------------------
// Blank image detection
// ---------------------------------------------------------------------------

/**
 * Detect if a data URI represents a blank/black image (common when content is
 * silently filtered by providers). Uses two heuristics:
 * 1. Size — real images at 512px+ are typically 100KB+; all-black PNGs compress
 *    to ~2-5KB.
 * 2. Byte variance — sample ~200 bytes spread across the image data; if fewer
 *    than 4 distinct values appear, the image is likely uniform/blank.
 * Returns true only if both checks agree.
 */
function isBlankImage(dataUri) {
  try {
    const base64 = dataUri.replace(/^data:image\/[^;]+;base64,/, '');
    const buf = Buffer.from(base64, 'base64');

    // Size check: suspicious if < 15KB
    const isTiny = buf.length < 15 * 1024;

    // Byte variance check: sample ~200 bytes evenly, skip 100-byte header
    const sampleCount = 200;
    const start = Math.min(100, Math.floor(buf.length * 0.1));
    const range = buf.length - start;
    if (range <= 0) return isTiny; // degenerate case

    const step = Math.max(1, Math.floor(range / sampleCount));
    const seen = new Set();
    for (let i = start; i < buf.length && seen.size < 10; i += step) {
      seen.add(buf[i]);
    }
    const isUniform = seen.size < 4;

    return isTiny && isUniform;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Content restriction error detection
// ---------------------------------------------------------------------------

const CONTENT_RESTRICTION_KEYWORDS = [
  'content_policy', 'content policy', 'nsfw', 'restricted', 'safety',
  'moderation', 'blocked', 'inappropriate', 'not allowed', 'violat',
];

function isContentRestrictionError(errorMessage) {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return CONTENT_RESTRICTION_KEYWORDS.some(kw => lower.includes(kw));
}

// ---------------------------------------------------------------------------
// Model fallback helper (Venice / Pollo only)
// ---------------------------------------------------------------------------

async function tryModelFallback(provider, providerId, prompt, negativePrompt) {
  const modelStoreKey = { venice: 'veniceModel', pollo: 'polloModel' }[providerId];
  if (!modelStoreKey) return null;

  const currentModel = store.get(modelStoreKey);

  // Use cached models; if cache is empty, fetch fresh list
  let models = provider.getModels();
  if (!models || models.length === 0) {
    try {
      models = await provider.fetchModelsForUI(store);
    } catch {
      return null;
    }
  }
  if (!models || models.length < 2) return null;

  const fallback = models.find(m => m.id !== currentModel);
  if (!fallback) return null;

  console.log(`[Main] Trying fallback model: ${fallback.id} (was: ${currentModel})`);

  store.set(modelStoreKey, fallback.id);
  try {
    const imageData = await provider.generate(prompt, negativePrompt, store);
    if (!isBlankImage(imageData)) {
      return { imageData, fallbackModel: fallback.id };
    }
    console.log('[Main] Fallback model also returned blank image');
  } catch (e) {
    console.log(`[Main] Fallback model failed: ${e.message}`);
  } finally {
    store.set(modelStoreKey, currentModel);
  }

  return null;
}

// ---------------------------------------------------------------------------
// IPC Handlers — Image generation (with retry + model fallback)
// ---------------------------------------------------------------------------

ipcMain.handle('generate-image', async (event, { prompt, negativePrompt }) => {
  const provider = getActiveProvider();
  const providerId = store.get('provider') || 'novelai';
  const settings = store.get('imageSettings');

  const makeMeta = (extra = {}) => ({
    provider: providerId,
    model: settings.model || '',
    resolution: { width: settings.width || 832, height: settings.height || 1216 },
    ...extra,
  });

  let lastError = null;

  // --- Attempt 1: normal generation ---
  try {
    console.log(`[Main] Generating via ${provider.name}...`);
    const imageData = await provider.generate(prompt, negativePrompt, store);
    if (!isBlankImage(imageData)) {
      return { success: true, imageData, meta: makeMeta() };
    }
    console.log('[Main] Blank image detected, retrying with new seed...');
  } catch (e) {
    lastError = e;
    console.error('[Main] Generation attempt 1 failed:', e.message);
    if (isContentRestrictionError(e.message)) {
      const fb = await tryModelFallback(provider, providerId, prompt, negativePrompt);
      if (fb) {
        return {
          success: true,
          imageData: fb.imageData,
          meta: makeMeta({ retried: true, fallbackModel: fb.fallbackModel }),
        };
      }
      return { success: false, error: e.message, contentRestricted: true };
    }
  }

  // --- Attempt 2: retry (blank image or transient error) ---
  try {
    const imageData = await provider.generate(prompt, negativePrompt, store);
    if (!isBlankImage(imageData)) {
      return { success: true, imageData, meta: makeMeta({ retried: true }) };
    }
    console.log('[Main] Blank image on retry, trying model fallback...');
  } catch (e) {
    lastError = e;
    console.error('[Main] Generation attempt 2 failed:', e.message);
    if (isContentRestrictionError(e.message)) {
      const fb = await tryModelFallback(provider, providerId, prompt, negativePrompt);
      if (fb) {
        return {
          success: true,
          imageData: fb.imageData,
          meta: makeMeta({ retried: true, fallbackModel: fb.fallbackModel }),
        };
      }
      return { success: false, error: e.message, contentRestricted: true };
    }
  }

  // --- Attempt 3: model fallback ---
  const fb = await tryModelFallback(provider, providerId, prompt, negativePrompt);
  if (fb) {
    return {
      success: true,
      imageData: fb.imageData,
      meta: makeMeta({ retried: true, fallbackModel: fb.fallbackModel }),
    };
  }

  // --- All attempts exhausted ---
  return {
    success: false,
    error: lastError?.message || 'Image generation failed (blank image detected)',
    blankDetected: !lastError,
  };
});

// IPC Handlers — Models (delegates to active provider)
ipcMain.handle('get-models', () => {
  return getActiveProvider().getModels();
});

// IPC Handlers — Provider management
ipcMain.handle('get-provider', () => {
  return store.get('provider') || 'novelai';
});

ipcMain.handle('set-provider', (event, providerId) => {
  if (!PROVIDERS[providerId]) {
    return { success: false, error: `Unknown provider: ${providerId}` };
  }
  store.set('provider', providerId);
  return { success: true };
});

ipcMain.handle('get-providers', () => {
  return Object.values(PROVIDERS).map(p => ({ id: p.id, name: p.name }));
});

// IPC Handlers — Perchance key extraction
ipcMain.handle('extract-perchance-key', async () => {
  try {
    const key = await extractPerchanceKey(store);
    return { success: !!key, hasKey: !!key };
  } catch (error) {
    console.error('[Main] Perchance key extraction failed:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-perchance-key-status', async () => {
  const key = store.get('perchanceUserKey');
  if (!key) return { hasKey: false, preview: '' };
  const status = await verifyPerchanceKey(key);
  if (status === 'not_verified') {
    // Only clear on definitive "not_verified" from the API (not CF blocks)
    store.set('perchanceUserKey', '');
    store.set('perchanceKeyAcquiredAt', 0);
    return { hasKey: false, preview: '', expired: true };
  }
  // 'valid' or 'unknown' (CF blocked) — keep the key
  return { hasKey: true, preview: key.substring(0, 10) + '...' };
});

ipcMain.handle('set-perchance-key', (event, key) => {
  store.set('perchanceUserKey', key);
  store.set('perchanceKeyAcquiredAt', Date.now());
  console.log(`[Main] Perchance key set manually: ${key.substring(0, 10)}...`);
  return { success: true };
});

// IPC Handlers — Perchance settings
ipcMain.handle('get-perchance-art-styles', () => {
  return perchanceProvider.getArtStyles();
});

ipcMain.handle('get-perchance-settings', () => {
  return {
    artStyle: store.get('perchanceArtStyle') || 'no-style',
    guidanceScale: store.get('perchanceGuidanceScale') || 7,
  };
});

ipcMain.handle('set-perchance-settings', (event, settings) => {
  if (settings.artStyle !== undefined) store.set('perchanceArtStyle', settings.artStyle);
  if (settings.guidanceScale !== undefined) store.set('perchanceGuidanceScale', settings.guidanceScale);
  return { success: true };
});

// IPC Handlers — NovelAI art styles
ipcMain.handle('get-novelai-art-styles', () => {
  return novelaiProvider.getArtStyles();
});

ipcMain.handle('get-novelai-art-style', () => {
  return store.get('novelaiArtStyle') || 'no-style';
});

ipcMain.handle('set-novelai-art-style', (event, styleId) => {
  store.set('novelaiArtStyle', styleId);
  return { success: true };
});

// IPC Handlers — Venice AI
ipcMain.handle('get-venice-settings', () => {
  return {
    model: store.get('veniceModel') || 'flux-2-max',
    steps: store.get('veniceSteps') || 25,
    cfgScale: store.get('veniceCfgScale') || 7,
    stylePreset: store.get('veniceStylePreset') || '',
    safeMode: store.get('veniceSafeMode') || false,
    hideWatermark: store.get('veniceHideWatermark') !== false,
  };
});

ipcMain.handle('set-venice-settings', (event, settings) => {
  if (settings.model !== undefined) store.set('veniceModel', settings.model);
  if (settings.steps !== undefined) store.set('veniceSteps', settings.steps);
  if (settings.cfgScale !== undefined) store.set('veniceCfgScale', settings.cfgScale);
  if (settings.stylePreset !== undefined) store.set('veniceStylePreset', settings.stylePreset);
  if (settings.safeMode !== undefined) store.set('veniceSafeMode', settings.safeMode);
  if (settings.hideWatermark !== undefined) store.set('veniceHideWatermark', settings.hideWatermark);
  return { success: true };
});

ipcMain.handle('set-venice-api-key', (event, key) => {
  store.set('veniceApiKey', key);
  console.log('[Main] Venice API key set');
  return { success: true };
});

ipcMain.handle('get-venice-api-key-status', () => {
  return { hasKey: !!store.get('veniceApiKey') };
});

ipcMain.handle('get-venice-models', async () => {
  return veniceProvider.fetchModelsForUI(store);
});

ipcMain.handle('get-venice-styles', async () => {
  return veniceProvider.fetchStylesForUI(store);
});

// IPC Handlers — Pollo AI
ipcMain.handle('get-pollo-settings', () => {
  return {
    model: store.get('polloModel') || 'flux-schnell',
    aspectRatio: store.get('polloAspectRatio') || '1:1',
    numOutputs: store.get('polloNumOutputs') || 1,
  };
});

ipcMain.handle('set-pollo-settings', (event, settings) => {
  if (settings.model !== undefined) store.set('polloModel', settings.model);
  if (settings.aspectRatio !== undefined) store.set('polloAspectRatio', settings.aspectRatio);
  if (settings.numOutputs !== undefined) store.set('polloNumOutputs', settings.numOutputs);
  return { success: true };
});

ipcMain.handle('get-pollo-models', async () => {
  return polloProvider.fetchModelsForUI();
});

ipcMain.handle('get-pollo-login-status', async () => {
  return { loggedIn: await polloProvider.checkLoginStatus() };
});

ipcMain.handle('pollo-login', () => {
  polloProvider.openLoginInBrowser();
  return { success: true };
});

ipcMain.handle('pollo-extract-session', async () => {
  return polloProvider.extractAndImportSession();
});

// IPC Handlers — API token (unchanged)
ipcMain.handle('get-api-token', () => {
  return store.get('apiToken') ? '***configured***' : '';
});

ipcMain.handle('set-api-token', (event, token) => {
  store.set('apiToken', token);
  return { success: true };
});

// IPC Handlers — Image settings (unchanged)
ipcMain.handle('get-image-settings', () => {
  return store.get('imageSettings');
});

ipcMain.handle('set-image-settings', (event, settings) => {
  store.set('imageSettings', settings);
  return { success: true };
});

// IPC Handlers — Storyboard
ipcMain.handle('storyboard:list', () => storyboard.list());
ipcMain.handle('storyboard:create', (event, name) => storyboard.create(name));
ipcMain.handle('storyboard:delete', (event, id) => storyboard.delete(id));
ipcMain.handle('storyboard:rename', (event, { id, name }) => storyboard.rename(id, name));
ipcMain.handle('storyboard:set-active', (event, id) => storyboard.setActive(id));
ipcMain.handle('storyboard:get-scenes', (event, id) => storyboard.getScenes(id));
ipcMain.handle('storyboard:commit-scene', (event, { storyboardId, sceneData }) => storyboard.commitScene(storyboardId, sceneData));
ipcMain.handle('storyboard:delete-scene', (event, { storyboardId, sceneId }) => storyboard.deleteScene(storyboardId, sceneId));
ipcMain.handle('storyboard:reorder-scenes', (event, { storyboardId, sceneIds }) => storyboard.reorderScenes(storyboardId, sceneIds));
ipcMain.handle('storyboard:update-scene-note', (event, { storyboardId, sceneId, note }) => storyboard.updateSceneNote(storyboardId, sceneId, note));
ipcMain.handle('storyboard:get-scene-image', (event, { storyboardId, sceneId }) => storyboard.getSceneImage(storyboardId, sceneId));
ipcMain.handle('storyboard:get-or-create-for-story', (event, { storyId, storyTitle }) => storyboard.getOrCreateForStory(storyId, storyTitle));
ipcMain.handle('storyboard:associate-with-story', (event, { storyboardId, storyId, storyTitle }) => storyboard.associateWithStory(storyboardId, storyId, storyTitle));
ipcMain.handle('storyboard:dissociate-from-story', (event, { storyboardId }) => storyboard.dissociateFromStory(storyboardId));

app.whenReady().then(() => {
  setupTokenInterception();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

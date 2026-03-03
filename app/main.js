const { app, BrowserWindow, ipcMain, session, globalShortcut, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

// Suppress EPIPE errors on stdout/stderr (parent pipe may close in dev mode)
process.stdout?.on('error', () => {});
process.stderr?.on('error', () => {});

// Providers
const novelaiProvider = require('./providers/novelai');
const perchanceProvider = require('./providers/perchance');
const veniceProvider = require('./providers/venice');
const polloProvider = require('./providers/pollo');
const { extractPerchanceKey, verifyPerchanceKey } = require('./perchance-key');
const storyboard = require('./storyboard');
const loreCreator = require('./lore-creator');
const loreComprehension = require('./lore-comprehension');
const memoryManager = require('./memory-manager');
const litrpgTracker = require('./litrpg-tracker');
const portraitManager = require('./portrait-manager');
const db = require('./db');

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
        model: 'nai-diffusion-4-5-full',
        // Dimensions
        width: 832,
        height: 1216,
        // Generation params
        steps: 28,
        scale: 5,
        sampler: 'k_euler',
        noiseSchedule: 'native',
        // SMEA (only for V3 models)
        smea: false,
        smeaDyn: false,
        // Quality
        cfgRescale: 0,
        qualityTags: true,
        // UC Preset
        ucPreset: 'heavy'
      }
    },
    loreSettings: {
      type: 'object',
      default: loreCreator.DEFAULT_SETTINGS
    },
    loreState: {
      type: 'object',
      default: {}
    },
    loreLlmProvider: { type: 'string', default: 'novelai' },
    loreOllamaModel: { type: 'string', default: 'mistral:7b' },
    loreOllamaUrl: { type: 'string', default: 'http://localhost:11434' },
    loreComprehension: { type: 'object', default: {} },
    memorySettings: { type: 'object', default: {} },
    memoryState: { type: 'object', default: {} }
  }
});

function getActiveProvider() {
  const id = store.get('provider') || 'novelai';
  return PROVIDERS[id] || PROVIDERS.novelai;
}

// Enforce single instance — prevent data corruption from concurrent store access
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[Main] Another instance is already running — quitting');
  app.quit();
}

let mainWindow;

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

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

// Token status query
ipcMain.handle('get-token-status', () => ({ hasToken: !!store.get('apiToken') }));

// Open webview DevTools for DOM inspection
ipcMain.handle('open-webview-devtools', () => {
  const allContents = webContents.getAllWebContents();
  const wv = allContents.find(wc => wc.getURL().includes('novelai.net'));
  if (wv) {
    wv.openDevTools({ mode: 'detach' });
    console.log('[Main] Opened webview DevTools');
    return { success: true };
  }
  console.log('[Main] No NovelAI webview found');
  return { success: false, error: 'No NovelAI webview found' };
});

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
  // NovelAI model fallback via provider's fallback chain
  if (providerId === 'novelai' && typeof provider.getModelFallbackOrder === 'function') {
    const settings = store.get('imageSettings');
    const currentModel = settings.model || 'nai-diffusion-4-5-full';
    const fallbacks = provider.getModelFallbackOrder(currentModel);

    for (const fallbackModel of fallbacks) {
      console.log(`[Main] NovelAI fallback: trying ${fallbackModel} (was: ${currentModel})`);
      store.set('imageSettings', { ...settings, model: fallbackModel });
      try {
        const imageData = await provider.generate(prompt, negativePrompt, store);
        if (!isBlankImage(imageData)) {
          return { imageData, fallbackModel };
        }
        console.log(`[Main] Fallback ${fallbackModel} returned blank image`);
      } catch (e) {
        console.log(`[Main] Fallback ${fallbackModel} failed: ${e.message}`);
      } finally {
        store.set('imageSettings', settings);
      }
    }
    return null;
  }

  // Venice / Pollo model fallback
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

// IPC Handler — Electron-side suggestion generation (parallel with script's image prompt)
ipcMain.handle('generate-suggestions-direct', async (event, data) => {
  try {
    // Backward-compat: accept string or {storyText, storyId}
    const storyText = typeof data === 'string' ? data : data.storyText;
    const storyId = typeof data === 'string' ? null : data.storyId;

    // Build narrative context from comprehension + memory
    const narrativeContext = storyId
      ? buildUnifiedContext(storyId, { comprehension: true, memory: true, budget: 2000 })
      : '';
    if (narrativeContext) {
      console.log(`[Main] Suggestions: injecting narrative context (${narrativeContext.length} chars)`);
    }

    const provider = PROVIDERS.novelai;
    const narrativeBlock = narrativeContext
      ? `\nNARRATIVE CONTEXT:\n${narrativeContext}\n\nUse established characters, situations, and relationships.`
      : '';

    const messages = [
      {
        role: 'system',
        content: `You are a creative writing assistant helping with interactive fiction. Generate exactly 3 different, compelling story continuation suggestions.

Vary the format naturally based on what fits the story moment:
- For action scenes: Brief 1-2 sentence prompts
- For dialogue moments: A character line with brief context
- For dramatic beats: Longer 2-4 sentence continuations

Each suggestion should:
- Feel natural as something the user might type
- Offer a distinct direction (don't repeat the same idea)
- Match the tone and style of the existing story
- Be written from the perspective the story uses (first/second/third person)
${narrativeBlock}
Output ONLY valid JSON in this exact format:
{"suggestions":[{"type":"action","text":"suggestion 1"},{"type":"dialogue","text":"suggestion 2"},{"type":"narrative","text":"suggestion 3"}]}

Types: "action" for physical actions, "dialogue" for speech, "narrative" for description/thought, "mixed" for combinations.`
      },
      {
        role: 'user',
        content: `Based on this story so far, generate 3 distinct continuation suggestions:\n\n---\n${storyText}\n---\n\nRemember: Output ONLY the JSON object, nothing else.`
      }
    ];

    console.log('[Main] Generating suggestions via direct API call...');
    const response = await provider.generateText(messages, {
      model: 'glm-4-6',
      max_tokens: 300,
      temperature: 0.6,
    }, store);

    let content = '';
    if (response.output) {
      content = response.output;
    } else if (response.choices && response.choices.length > 0) {
      content = response.choices[0].text || response.choices[0].message?.content || '';
    }

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      let jsonStr = jsonMatch[0];
      try {
        JSON.parse(jsonStr);
      } catch {
        // Fix truncated JSON
        const quoteCount = (jsonStr.match(/"/g) || []).length;
        if (quoteCount % 2 !== 0) jsonStr += '"';
        const openBrackets = (jsonStr.match(/\[/g) || []).length;
        const closeBrackets = (jsonStr.match(/\]/g) || []).length;
        const openBraces = (jsonStr.match(/\{/g) || []).length;
        const closeBraces = (jsonStr.match(/\}/g) || []).length;
        for (let i = 0; i < openBrackets - closeBrackets; i++) jsonStr += ']';
        for (let i = 0; i < openBraces - closeBraces; i++) jsonStr += '}';
      }
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed.suggestions)) {
        const suggestions = parsed.suggestions
          .map(s => ({ type: s.type || 'mixed', text: typeof s.text === 'string' ? s.text : String(s.text || '') }))
          .filter(s => s.text.length > 0)
          .slice(0, 3);
        console.log(`[Main] Generated ${suggestions.length} suggestions via direct API`);
        return { success: true, suggestions };
      }
    }

    console.log('[Main] Could not parse suggestions from API response');
    return { success: false, error: 'Could not parse response' };
  } catch (e) {
    console.error('[Main] Direct suggestion generation failed:', e.message);
    return { success: false, error: e.message };
  }
});

// IPC Handler — Electron-side scene prompt generation (replaces script sandbox)
ipcMain.handle('generate-scene-prompt', async (event, { storyText, entries, artStyle, storyId }) => {
  try {
    const provider = PROVIDERS.novelai;

    // 1. Extract character appearances from lorebook entries
    const appearancePatterns = [
      /appearance[:\s]+([^.]+(?:\.[^.]+){0,3})/i,
      /physical(?:\s+description)?[:\s]+([^.]+(?:\.[^.]+){0,3})/i,
      /looks?\s+like[:\s]+([^.]+(?:\.[^.]+){0,2})/i,
      /(?:has|with)\s+([\w\s,]+(?:hair|eyes|skin|build|height)[^.]*)/i,
      /description[:\s]+([^.]+(?:\.[^.]+){0,3})/i,
    ];
    const visualKeywords = ['hair', 'eyes', 'tall', 'short', 'wears', 'wearing', 'dressed', 'skin', 'face', 'build'];
    const characters = [];

    for (const entry of (entries || [])) {
      if (entry.enabled === false) continue;
      const text = entry.text || '';
      const displayName = entry.displayName || '';
      const keys = entry.keys || [];
      let appearance = '';

      for (const pattern of appearancePatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
          appearance = match[1].trim();
          break;
        }
      }

      if (!appearance && text.length < 500) {
        const hasVisual = visualKeywords.some(kw => text.toLowerCase().includes(kw));
        if (hasVisual) appearance = text;
      }

      if (appearance) {
        const name = displayName || (keys.length > 0 ? keys[0] : '');
        if (name) characters.push({ name, appearance: appearance.slice(0, 300) });
      }
    }

    // 2. Detect which characters appear in recent text
    const recentText = storyText.slice(-3000).toLowerCase();
    const mentioned = characters.filter(c => recentText.includes(c.name.toLowerCase()));

    // 3. Build character reference string
    let characterRefs = '';
    if (mentioned.length > 0) {
      characterRefs = '\n\nCharacter References:\n' + mentioned.map(c => `[${c.name}: ${c.appearance}]`).join('\n');
      console.log(`[Main] Scene prompt: ${mentioned.length} characters in scene: ${mentioned.map(c => c.name).join(', ')}`);
    }

    // 4. Build system prompt
    const style = artStyle || 'anime style, detailed, high quality';
    let systemContent = `You are an expert at creating image generation prompts. Analyze story text and create a vivid visual prompt that captures the current scene.

Output ONLY a JSON object with this format:
{"prompt": "detailed visual description", "negativePrompt": "things to avoid"}

Guidelines:
- Focus on the CURRENT scene, not backstory
- Describe characters' appearance, poses, expressions
- Include setting details (location, lighting, atmosphere)
- Use comma-separated tags/descriptors
- Add style tags: ${style}
- Keep prompts under 200 words
- For negativePrompt: list common image generation issues to avoid`;

    if (characterRefs) {
      systemContent += '\n\nIMPORTANT: Use the provided Character References for accurate character appearances. Include their visual details (hair color, eye color, clothing, etc.) in the prompt when they appear in the scene.';
    }

    // Inject narrative context from comprehension + memory
    const narrativeContext = storyId
      ? buildUnifiedContext(storyId, { comprehension: true, memory: true, budget: 2000 })
      : '';
    if (narrativeContext) {
      systemContent += `\n\nNARRATIVE CONTEXT (use for scene understanding):\n${narrativeContext}`;
      console.log(`[Main] Scene prompt: injecting narrative context (${narrativeContext.length} chars)`);
    }

    let userContent = `Create an image prompt for this scene:\n\n${storyText.slice(-2000)}`;
    if (characterRefs) userContent += characterRefs;
    userContent += '\n\nRemember: Output ONLY valid JSON with "prompt" and "negativePrompt" keys.';

    const messages = [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent }
    ];

    // 5. Call GLM-4-6
    console.log('[Main] Generating scene prompt via direct API call...');
    const response = await provider.generateText(messages, {
      model: 'glm-4-6',
      max_tokens: 400,
      temperature: 0.7,
    }, store);

    let content = '';
    if (response.output) {
      content = response.output;
    } else if (response.choices && response.choices.length > 0) {
      content = response.choices[0].text || response.choices[0].message?.content || '';
    }

    // 6. Parse JSON with truncated-JSON recovery
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      let jsonStr = jsonMatch[0];
      try {
        JSON.parse(jsonStr);
      } catch {
        const quoteCount = (jsonStr.match(/"/g) || []).length;
        if (quoteCount % 2 !== 0) jsonStr += '"';
        const openBrackets = (jsonStr.match(/\[/g) || []).length;
        const closeBrackets = (jsonStr.match(/\]/g) || []).length;
        const openBraces = (jsonStr.match(/\{/g) || []).length;
        const closeBraces = (jsonStr.match(/\}/g) || []).length;
        for (let i = 0; i < openBrackets - closeBrackets; i++) jsonStr += ']';
        for (let i = 0; i < openBraces - closeBraces; i++) jsonStr += '}';
      }
      const parsed = JSON.parse(jsonStr);
      const prompt = parsed.prompt || '';
      const negativePrompt = parsed.negativePrompt || 'lowres, bad anatomy, bad hands, text, error, missing fingers';
      console.log(`[Main] Scene prompt generated (${prompt.length} chars)`);
      return { success: true, prompt, negativePrompt };
    }

    console.log('[Main] Could not parse scene prompt from API response');
    return { success: false, error: 'Could not parse response' };
  } catch (e) {
    console.error('[Main] Scene prompt generation failed:', e.message);
    return { success: false, error: e.message };
  }
});

// IPC Handlers — Per-story scene prompt state persistence
ipcMain.handle('scene:get-state', (event, storyId) => {
  return db.getSceneState(storyId) || {
    lastPrompt: '', lastNegativePrompt: '', lastStoryLength: 0,
    suggestions: [], artStyle: '',
  };
});

ipcMain.handle('scene:set-state', (event, { storyId, state }) => {
  db.setSceneState(storyId, state);
  return { success: true };
});

// ---------------------------------------------------------------------------
// Lore Comprehension — Progressive scan state (in-memory, not persisted)
// ---------------------------------------------------------------------------

const progressiveScans = new Map(); // storyId → {cancel: false, pause: false}

// ---------------------------------------------------------------------------
// Lore Creator — LLM provider factory
// ---------------------------------------------------------------------------

function makeNovelaiGenerateTextFn() {
  return async (messages, options) => {
    return novelaiProvider.generateText(messages, {
      model: 'glm-4-6',
      max_tokens: options.max_tokens || 300,
      temperature: options.temperature || 0.4,
    }, store);
  };
}

function makeOllamaGenerateTextFn() {
  const ollamaUrl = store.get('loreOllamaUrl') || 'http://localhost:11434';
  const ollamaModel = store.get('loreOllamaModel') || 'mistral:7b';

  return async (messages, options) => {
    const response = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        messages,
        stream: false,
        options: {
          num_predict: options.max_tokens || 300,
          temperature: options.temperature || 0.4,
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    return { output: data.message?.content || '' };
  };
}

function makeLoreGenerateTextFn() {
  const llmProvider = store.get('loreLlmProvider') || 'novelai';
  if (llmProvider === 'ollama') return makeOllamaGenerateTextFn();
  return makeNovelaiGenerateTextFn();
}

async function isOllamaAvailable() {
  try {
    const ollamaUrl = store.get('loreOllamaUrl') || 'http://localhost:11434';
    const response = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Unified Context Builder — combines comprehension + memory for subsystems
// ---------------------------------------------------------------------------

function buildUnifiedContext(storyId, options = {}) {
  if (!storyId) return '';
  const includeComp = options.comprehension !== false;
  const includeMem = options.memory === true;
  const totalBudget = options.budget || 3000;
  const sections = [];
  let remaining = totalBudget;

  if (includeComp) {
    const compState = db.getComprehension(storyId);
    if (compState && compState.masterSummary) {
      const ctx = loreComprehension.formatComprehensionContext(
        compState.masterSummary, compState.entityProfiles
      );
      if (ctx) {
        const capped = ctx.slice(0, Math.min(2500, Math.floor(remaining * 0.6)));
        sections.push(capped);
        remaining -= capped.length;
      }
    }
  }

  if (includeMem) {
    const memState = db.getMemoryState(storyId);
    if (memState) {
      const ctx = memoryManager.formatMemoryContext(memState, Math.min(1200, remaining));
      if (ctx) { sections.push(ctx); remaining -= ctx.length; }
    }
  }

  return sections.filter(s => s.length > 0).join('\n\n').slice(0, totalBudget);
}

// ---------------------------------------------------------------------------
// IPC Handlers — Lore Creator
// ---------------------------------------------------------------------------

ipcMain.handle('lore:scan', async (event, { storyText, existingEntries, storyId, scanOptions }) => {
  try {
    const settings = store.get('loreSettings') || loreCreator.DEFAULT_SETTINGS;
    const state = db.getLoreState(storyId) || {
      pendingEntries: [], pendingUpdates: [], pendingMerges: [],
      acceptedEntryIds: [], rejectedNames: [], dismissedUpdateNames: [],
      rejectedMergeNames: [], dismissedReformatNames: [], charsSinceLastScan: 0, loreCategoryIds: {},
      pendingCleanups: [], dismissedCleanupIds: [],
    };

    const generateTextFn = makeLoreGenerateTextFn();

    // Check if secondary provider is available for hybrid scanning
    let secondaryGenerateTextFn = null;
    if (settings.hybridEnabled !== false) {
      const primaryProvider = store.get('loreLlmProvider') || 'novelai';
      if (primaryProvider === 'novelai') {
        if (await isOllamaAvailable()) {
          secondaryGenerateTextFn = makeOllamaGenerateTextFn();
          console.log('[Main] Hybrid scan: NovelAI (primary) + Ollama (secondary)');
        }
      } else {
        secondaryGenerateTextFn = makeNovelaiGenerateTextFn();
        console.log('[Main] Hybrid scan: Ollama (primary) + NovelAI (secondary)');
      }
    }

    // Build comprehension context if available
    let comprehensionContext = '';
    const compState = db.getComprehension(storyId);
    if (compState && compState.masterSummary) {
      comprehensionContext = loreComprehension.formatComprehensionContext(
        compState.masterSummary, compState.entityProfiles
      );
      console.log(`[Main] Injecting comprehension context (${comprehensionContext.length} chars) into lore scan`);
    }

    // Inject memory state context into lore scan
    const memState = db.getMemoryState(storyId);
    if (memState && (memState.currentSituation || (memState.events && memState.events.length > 0))) {
      const memCtx = memoryManager.formatMemoryContext(memState, 500);
      if (memCtx) {
        comprehensionContext = comprehensionContext
          ? comprehensionContext + '\n\n' + memCtx
          : memCtx;
        console.log(`[Main] Injecting memory context (${memCtx.length} chars) into lore scan`);
      }
    }

    // Apply scan options (category filter, relationships-only)
    const effectiveSettings = { ...settings };
    if (scanOptions) {
      if (scanOptions.categoryFilter) {
        effectiveSettings.enabledCategories = {};
        for (const cat of loreCreator.ALL_CATEGORIES) {
          effectiveSettings.enabledCategories[cat] = (cat === scanOptions.categoryFilter);
        }
      }
      if (scanOptions.relationshipsOnly) {
        effectiveSettings._relationshipsOnly = true;
      }
    }

    const result = await loreCreator.scanForLore(
      storyText, effectiveSettings, existingEntries, state, generateTextFn,
      (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('lore:scan-progress', progress);
        }
      },
      comprehensionContext || undefined,
      secondaryGenerateTextFn
    );

    // Save updated state
    db.setLoreState(storyId, result.state);

    // Chain LitRPG scan if enabled
    const rpgState = db.getLitrpgState(storyId);
    if (rpgState && rpgState.enabled) {
      console.log('[Main] Chaining LitRPG scan after lore scan');
      try {
        const rpgResult = await litrpgTracker.scanForRPGData(
          storyText, rpgState, existingEntries || [], generateTextFn,
          (progress) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('litrpg:scan-progress', progress);
            }
          },
          comprehensionContext || undefined,
          secondaryGenerateTextFn
        );
        db.setLitrpgState(storyId, rpgResult.state);
        // Notify renderer that RPG state updated
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('litrpg:state-updated', rpgResult.state);
        }
      } catch (rpgErr) {
        console.error('[Main] Chained LitRPG scan failed:', rpgErr.message);
      }
    } else if (!rpgState || rpgState.detected === null) {
      // First scan for this story — run LitRPG detection
      try {
        const detection = await litrpgTracker.detectLitRPG(storyText, generateTextFn);
        const newRpgState = rpgState || { ...db.LITRPG_STATE_DEFAULTS };
        newRpgState.detected = detection.detected;
        newRpgState.systemType = detection.systemType;
        db.setLitrpgState(storyId, newRpgState);
        if (detection.detected && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('litrpg:detected', { systemType: detection.systemType });
        }
      } catch (detErr) {
        console.error('[Main] LitRPG detection failed:', detErr.message);
      }
    }

    return { success: true, ...result };
  } catch (e) {
    console.error('[Main] Lore scan failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('lore:organize', async (event, { entries, storyText, storyId, categoryMap }) => {
  try {
    const settings = store.get('loreSettings') || loreCreator.DEFAULT_SETTINGS;
    const generateTextFn = makeLoreGenerateTextFn();

    // Build comprehension context if available
    let comprehensionContext = '';
    const compState = db.getComprehension(storyId);
    if (compState && compState.masterSummary) {
      comprehensionContext = loreComprehension.formatComprehensionContext(
        compState.masterSummary, compState.entityProfiles
      );
    }

    // Get dismissed cleanup IDs
    const state = db.getLoreState(storyId) || {};
    const dismissedCleanupIds = state.dismissedCleanupIds || [];

    const result = await loreCreator.organizeLorebook(
      entries, storyText, settings, generateTextFn,
      (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('lore:organize-progress', progress);
        }
      },
      comprehensionContext || undefined,
      categoryMap,
      dismissedCleanupIds
    );

    return { success: true, ...result };
  } catch (e) {
    console.error('[Main] Lore organize failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('lore:identify-target', async (event, { prompt, entries }) => {
  try {
    const generateTextFn = makeLoreGenerateTextFn();
    const result = await loreCreator.identifyTargetEntry(prompt, entries, generateTextFn);
    return { success: true, result };
  } catch (e) {
    console.error('[Main] Lore identify-target failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('lore:generate-enriched', async (event, { prompt, currentText, displayName }) => {
  try {
    const generateTextFn = makeLoreGenerateTextFn();
    const result = await loreCreator.generateEnrichedText(prompt, currentText, displayName, generateTextFn);
    return { success: true, result };
  } catch (e) {
    console.error('[Main] Lore generate-enriched failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('lore:create-from-prompt', async (event, { prompt, category, storyText, storyId }) => {
  try {
    const settings = store.get('loreSettings') || loreCreator.DEFAULT_SETTINGS;
    const generateTextFn = makeLoreGenerateTextFn();

    // Build comprehension context if available
    let comprehensionContext = '';
    const compState2 = db.getComprehension(storyId);
    if (compState2 && compState2.masterSummary) {
      comprehensionContext = loreComprehension.formatComprehensionContext(
        compState2.masterSummary, compState2.entityProfiles
      );
    }

    // Get existing entry names to avoid duplicates
    const loreStateForPrompt = db.getLoreState(storyId) || { pendingEntries: [], rejectedNames: [] };
    const existingEntryNames = (loreStateForPrompt.pendingEntries || []).map(e => e.displayName).filter(Boolean);

    const entries = await loreCreator.generateEntriesFromPrompt(
      prompt, category, storyText, settings, existingEntryNames, generateTextFn,
      comprehensionContext || undefined
    );

    return { success: true, entries };
  } catch (e) {
    console.error('[Main] Lore create-from-prompt failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('lore:reformat-entry', async (event, { displayName, currentText, storyText, storyId }) => {
  try {
    const generateTextFn = makeLoreGenerateTextFn();

    // Build comprehension context if available
    let comprehensionContext = '';
    if (storyId) {
      const compState3 = db.getComprehension(storyId);
      if (compState3 && compState3.masterSummary) {
        comprehensionContext = loreComprehension.formatComprehensionContext(
          compState3.masterSummary, compState3.entityProfiles
        );
      }
    }

    const result = await loreCreator.enrichAndReformatEntry(
      displayName, currentText, generateTextFn,
      comprehensionContext || undefined, storyText || undefined
    );
    return { success: true, result };
  } catch (e) {
    console.error('[Main] Lore reformat-entry failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('lore:get-settings', () => {
  return store.get('loreSettings') || loreCreator.DEFAULT_SETTINGS;
});

ipcMain.handle('lore:set-settings', (event, settings) => {
  store.set('loreSettings', settings);
  return { success: true };
});

ipcMain.handle('lore:get-state', (event, storyId) => {
  return db.getLoreState(storyId) || {
    pendingEntries: [], pendingUpdates: [], pendingMerges: [],
    acceptedEntryIds: [], rejectedNames: [], dismissedUpdateNames: [],
    rejectedMergeNames: [], charsSinceLastScan: 0, loreCategoryIds: {},
    pendingCleanups: [], dismissedCleanupIds: [],
  };
});

ipcMain.handle('lore:set-state', (event, { storyId, state }) => {
  db.setLoreState(storyId, state);
  return { success: true };
});

ipcMain.handle('lore:get-llm-provider', () => {
  return {
    provider: store.get('loreLlmProvider') || 'novelai',
    ollamaModel: store.get('loreOllamaModel') || 'mistral:7b',
    ollamaUrl: store.get('loreOllamaUrl') || 'http://localhost:11434',
  };
});

ipcMain.handle('lore:set-llm-provider', (event, { provider, ollamaModel, ollamaUrl }) => {
  if (provider !== undefined) store.set('loreLlmProvider', provider);
  if (ollamaModel !== undefined) store.set('loreOllamaModel', ollamaModel);
  if (ollamaUrl !== undefined) store.set('loreOllamaUrl', ollamaUrl);
  return { success: true };
});

ipcMain.handle('lore:check-ollama', async () => {
  try {
    const url = store.get('loreOllamaUrl') || 'http://localhost:11434';
    const response = await fetch(`${url}/api/tags`);
    if (!response.ok) return { available: false };
    const data = await response.json();
    const models = (data.models || []).map(m => ({ name: m.name, size: m.size }));
    return { available: true, models };
  } catch {
    return { available: false };
  }
});

// ---------------------------------------------------------------------------
// IPC Handlers — Lore Comprehension (progressive scan)
// ---------------------------------------------------------------------------

ipcMain.handle('lore:start-progressive-scan', async (event, { storyId, storyText }) => {
  try {
    // Cancel any existing scan for this story
    if (progressiveScans.has(storyId)) {
      progressiveScans.get(storyId).cancel = true;
    }

    const scanControl = { cancel: false, pause: false };
    progressiveScans.set(storyId, scanControl);

    const generateTextFn = makeLoreGenerateTextFn();
    const existingState = db.getComprehension(storyId) || null;

    const updatedState = await loreComprehension.runProgressiveScan(
      storyText,
      existingState,
      generateTextFn,
      (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('lore:progressive-scan-progress', {
            storyId,
            ...progress,
          });
        }
      },
      () => {
        // Check cancel and pause
        const ctrl = progressiveScans.get(storyId);
        if (!ctrl) return true;
        if (ctrl.cancel) return true;
        // Spin-wait on pause (check every 500ms)
        // Actually, just return cancel status — pause is handled differently
        return ctrl.cancel;
      }
    );

    // Save state
    db.setComprehension(storyId, updatedState);

    progressiveScans.delete(storyId);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lore:progressive-scan-complete', { storyId });
    }

    return { success: true, state: updatedState };
  } catch (e) {
    console.error('[Main] Progressive scan failed:', e.message);
    progressiveScans.delete(storyId);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('lore:pause-progressive-scan', (event, { storyId }) => {
  const ctrl = progressiveScans.get(storyId);
  if (ctrl) ctrl.pause = true;
  return { success: !!ctrl };
});

ipcMain.handle('lore:resume-progressive-scan', (event, { storyId }) => {
  const ctrl = progressiveScans.get(storyId);
  if (ctrl) ctrl.pause = false;
  return { success: !!ctrl };
});

ipcMain.handle('lore:cancel-progressive-scan', (event, { storyId }) => {
  const ctrl = progressiveScans.get(storyId);
  if (ctrl) ctrl.cancel = true;
  return { success: !!ctrl };
});

ipcMain.handle('lore:get-comprehension', (event, storyId) => {
  const state = db.getComprehension(storyId);
  if (state) {
    console.log(`[Main] Found comprehension for ${storyId}: masterSummary=${!!state.masterSummary}, entities=${Object.keys(state.entityProfiles || {}).length}`);
  } else {
    console.log(`[Main] No comprehension data for story ${storyId}`);
  }
  return state;
});

ipcMain.handle('lore:incremental-update', async (event, { storyId, storyText }) => {
  try {
    const generateTextFn = makeLoreGenerateTextFn();
    const existingState = db.getComprehension(storyId) || null;

    const updatedState = await loreComprehension.incrementalUpdate(
      storyText, existingState, generateTextFn
    );

    db.setComprehension(storyId, updatedState);

    return { success: true, state: updatedState };
  } catch (e) {
    console.error('[Main] Incremental update failed:', e.message);
    return { success: false, error: e.message };
  }
});

// ---------------------------------------------------------------------------
// IPC Handlers — Memory Manager
// ---------------------------------------------------------------------------

const memoryProcessingLock = new Set();

ipcMain.handle('memory:process', async (event, { storyText, storyId }) => {
  if (memoryProcessingLock.has(storyId)) {
    return { success: false, error: 'Already processing' };
  }
  memoryProcessingLock.add(storyId);
  try {
    const settings = { ...memoryManager.DEFAULT_SETTINGS, ...store.get('memorySettings') };
    const state = db.getMemoryState(storyId) || memoryManager.createEmptyState();
    const generateTextFn = makeLoreGenerateTextFn();

    // Build comprehension context if available
    let comprehensionContext = '';
    const compState = db.getComprehension(storyId);
    if (compState && compState.masterSummary) {
      comprehensionContext = loreComprehension.formatComprehensionContext(
        compState.masterSummary, compState.entityProfiles
      );
    }

    const result = await memoryManager.processNewContent(
      storyText, state, settings, generateTextFn, comprehensionContext || undefined
    );

    db.setMemoryState(storyId, result.updatedState);

    return { success: true, memoryText: result.memoryText, state: result.updatedState };
  } catch (e) {
    console.error('[Main] Memory process failed:', e.message);
    return { success: false, error: e.message };
  } finally {
    memoryProcessingLock.delete(storyId);
  }
});

ipcMain.handle('memory:force-refresh', async (event, { storyText, storyId }) => {
  if (memoryProcessingLock.has(storyId)) {
    return { success: false, error: 'Already processing' };
  }
  memoryProcessingLock.add(storyId);
  try {
    const settings = { ...memoryManager.DEFAULT_SETTINGS, ...store.get('memorySettings') };
    const generateTextFn = makeLoreGenerateTextFn();

    // Check for secondary provider (hybrid) — respects lore settings toggle
    let secondaryGenerateTextFn = null;
    const loreSettings = store.get('loreSettings') || {};
    if (loreSettings.hybridEnabled !== false) {
      const primaryProvider = store.get('loreLlmProvider') || 'novelai';
      if (primaryProvider === 'novelai') {
        if (await isOllamaAvailable()) {
          secondaryGenerateTextFn = makeOllamaGenerateTextFn();
          console.log('[Main] Memory refresh: hybrid mode (NovelAI + Ollama)');
        }
      } else {
        secondaryGenerateTextFn = makeNovelaiGenerateTextFn();
        console.log('[Main] Memory refresh: hybrid mode (Ollama + NovelAI)');
      }
    }

    let comprehensionContext = '';
    const compState = db.getComprehension(storyId);
    if (compState && compState.masterSummary) {
      comprehensionContext = loreComprehension.formatComprehensionContext(
        compState.masterSummary, compState.entityProfiles
      );
    }

    const result = await memoryManager.forceRefresh(
      storyText, settings, generateTextFn,
      (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('memory:progress', progress);
        }
      },
      comprehensionContext || undefined,
      secondaryGenerateTextFn
    );

    db.setMemoryState(storyId, result.updatedState);

    return { success: true, memoryText: result.memoryText, state: result.updatedState };
  } catch (e) {
    console.error('[Main] Memory force-refresh failed:', e.message);
    return { success: false, error: e.message };
  } finally {
    memoryProcessingLock.delete(storyId);
  }
});

ipcMain.handle('memory:clear', (event, { storyId }) => {
  db.setMemoryState(storyId, memoryManager.createEmptyState());
  return { success: true };
});

ipcMain.handle('memory:get-state', (event, storyId) => {
  return db.getMemoryState(storyId) || memoryManager.createEmptyState();
});

ipcMain.handle('memory:set-state', (event, { storyId, state }) => {
  db.setMemoryState(storyId, state);
  return { success: true };
});

ipcMain.handle('memory:get-settings', () => {
  return { ...memoryManager.DEFAULT_SETTINGS, ...store.get('memorySettings') };
});

ipcMain.handle('memory:set-settings', (event, settings) => {
  store.set('memorySettings', settings);
  return { success: true };
});

// IPC Handlers — LitRPG

ipcMain.handle('litrpg:detect', async (event, { storyText, storyId }) => {
  try {
    const generateTextFn = makeLoreGenerateTextFn();
    const result = await litrpgTracker.detectLitRPG(storyText, generateTextFn);
    // Save detection result
    const rpgState = db.getLitrpgState(storyId) || { ...db.LITRPG_STATE_DEFAULTS };
    rpgState.detected = result.detected;
    rpgState.systemType = result.systemType;
    db.setLitrpgState(storyId, rpgState);
    return { success: true, ...result };
  } catch (e) {
    console.error('[Main] LitRPG detection failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('litrpg:scan', async (event, { storyText, storyId, loreEntries }) => {
  try {
    const rpgState = db.getLitrpgState(storyId) || { ...db.LITRPG_STATE_DEFAULTS };
    if (!rpgState.enabled) return { success: false, error: 'LitRPG mode not enabled' };

    const generateTextFn = makeLoreGenerateTextFn();

    // Check for secondary provider
    let secondaryGenerateTextFn = null;
    const loreSettings = store.get('loreSettings') || {};
    if (loreSettings.hybridEnabled !== false) {
      const primaryProvider = store.get('loreLlmProvider') || 'novelai';
      if (primaryProvider === 'novelai') {
        if (await isOllamaAvailable()) secondaryGenerateTextFn = makeOllamaGenerateTextFn();
      } else {
        secondaryGenerateTextFn = makeNovelaiGenerateTextFn();
      }
    }

    // Build comprehension context
    let comprehensionContext = '';
    const compState = db.getComprehension(storyId);
    if (compState && compState.masterSummary) {
      comprehensionContext = loreComprehension.formatComprehensionContext(
        compState.masterSummary, compState.entityProfiles
      );
    }

    const result = await litrpgTracker.scanForRPGData(
      storyText, rpgState, loreEntries || [], generateTextFn,
      (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('litrpg:scan-progress', progress);
        }
      },
      comprehensionContext || undefined,
      secondaryGenerateTextFn
    );

    db.setLitrpgState(storyId, result.state);
    return { success: true, state: result.state };
  } catch (e) {
    console.error('[Main] LitRPG scan failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('litrpg:get-state', (event, storyId) => {
  return db.getLitrpgState(storyId);
});

ipcMain.handle('litrpg:set-state', (event, { storyId, state }) => {
  db.setLitrpgState(storyId, state);
  return { success: true };
});

ipcMain.handle('litrpg:accept-update', (event, { storyId, updateId }) => {
  const rpgState = db.getLitrpgState(storyId);
  if (!rpgState) return { success: false, error: 'No LitRPG state' };
  const updated = litrpgTracker.acceptPendingUpdate(rpgState, updateId);
  db.setLitrpgState(storyId, updated);
  return { success: true, state: updated };
});

ipcMain.handle('litrpg:reject-update', (event, { storyId, updateId }) => {
  const rpgState = db.getLitrpgState(storyId);
  if (!rpgState) return { success: false, error: 'No LitRPG state' };
  const updated = litrpgTracker.rejectPendingUpdate(rpgState, updateId);
  db.setLitrpgState(storyId, updated);
  return { success: true, state: updated };
});

ipcMain.handle('litrpg:build-lorebook-text', (event, { entryText, rpgData }) => {
  return litrpgTracker.buildLitRPGCharacterText(entryText, rpgData);
});

ipcMain.handle('litrpg:generate-portrait-prompt', async (event, { characterEntryText, rpgData }) => {
  try {
    const generateTextFn = makeLoreGenerateTextFn();
    const prompt = await litrpgTracker.generatePortraitPrompt(characterEntryText, rpgData, generateTextFn);
    return { success: true, prompt };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// IPC Handlers — Portraits

ipcMain.handle('portrait:generate', async (event, { storyId, characterId, characterEntry, rpgData }) => {
  try {
    // Generate prompt from character data
    const generateTextFn = makeLoreGenerateTextFn();
    const prompt = await litrpgTracker.generatePortraitPrompt(
      typeof characterEntry === 'string' ? characterEntry : (characterEntry || ''),
      rpgData || {},
      generateTextFn
    );
    if (!prompt) return { success: false, error: 'Failed to generate portrait prompt' };

    // Generate image via active provider
    const providerId = store.get('provider') || 'novelai';
    const provider = PROVIDERS[providerId];
    if (!provider) return { success: false, error: 'No active image provider' };

    const imageData = await provider.generate(prompt, '', store);
    const buffer = Buffer.from(imageData, 'base64');

    portraitManager.savePortrait(storyId, characterId, buffer);

    return {
      success: true,
      imageData,
      thumbnailData: portraitManager.getPortraitAsBase64(storyId, characterId, true),
    };
  } catch (e) {
    console.error('[Main] Portrait generate failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('portrait:upload', async (event, { storyId, characterId }) => {
  const { dialog } = require('electron');
  const { canceled, filePaths } = await dialog.showOpenDialog({
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    properties: ['openFile'],
  });
  if (canceled || filePaths.length === 0) return { success: false };
  const buffer = fs.readFileSync(filePaths[0]);
  portraitManager.savePortrait(storyId, characterId, buffer);
  return {
    success: true,
    imageData: portraitManager.getPortraitAsBase64(storyId, characterId),
    thumbnailData: portraitManager.getPortraitAsBase64(storyId, characterId, true),
  };
});

ipcMain.handle('portrait:get', (event, { storyId, characterId, thumbnail }) => {
  return portraitManager.getPortraitAsBase64(storyId, characterId, !!thumbnail);
});

ipcMain.handle('portrait:delete', (event, { storyId, characterId }) => {
  portraitManager.deletePortrait(storyId, characterId);
  return { success: true };
});

// IPC Handlers — Story bulk load (SQLite)
ipcMain.handle('story:load-all', (event, { storyId, storyTitle }) => {
  db.upsertStory(storyId, storyTitle || '');
  return db.loadAllStoryData(storyId);
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
  // Initialize SQLite database
  db.init(app.getPath('userData'));

  // Initialize portrait manager
  portraitManager.init(app.getPath('userData'));

  // One-time migration from electron-store to SQLite
  if (!store.get('migratedToSqlite')) {
    console.log('[Main] Migrating per-story data from electron-store to SQLite...');
    db.migrateFromStore(store);
    store.set('migratedToSqlite', true);
    console.log('[Main] Migration complete');
  }

  setupTokenInterception();
  createWindow();

  // Register keyboard shortcut to open webview DevTools for DOM inspection
  globalShortcut.register('CommandOrControl+Shift+I', () => {
    const allContents = webContents.getAllWebContents();
    const wv = allContents.find(wc => wc.getURL().includes('novelai.net'));
    if (wv) {
      wv.openDevTools({ mode: 'detach' });
      console.log('[Main] Opened webview DevTools via shortcut');
    }
  });

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

app.on('will-quit', () => {
  db.close();
});

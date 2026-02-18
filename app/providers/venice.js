// Venice AI Image Generation Provider
// API Docs: https://docs.venice.ai/api-reference/image-generation

const MAX_DIMENSION = 1280;
const API_BASE = 'https://api.venice.ai/api/v1';

// Cache for models and styles lists
let modelsCache = null;
let modelsCacheTime = 0;
let stylesCache = null;
let stylesCacheTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Fetch the list of available image generation models from Venice API.
 */
async function fetchModels(apiKey) {
  const now = Date.now();
  if (modelsCache && (now - modelsCacheTime) < CACHE_TTL_MS) {
    return modelsCache;
  }

  try {
    const res = await fetch(`${API_BASE}/models?type=image`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.log(`[Venice] Failed to fetch models: HTTP ${res.status}`);
      return modelsCache || [];
    }
    const data = await res.json();
    modelsCache = (data.data || []).map(m => ({
      id: m.id,
      name: m.id,
    }));
    modelsCacheTime = now;
    console.log(`[Venice] Fetched ${modelsCache.length} image models`);
    return modelsCache;
  } catch (e) {
    console.log('[Venice] Error fetching models:', e.message);
    return modelsCache || [];
  }
}

/**
 * Fetch the list of available style presets from Venice API.
 */
async function fetchStyles(apiKey) {
  const now = Date.now();
  if (stylesCache && (now - stylesCacheTime) < CACHE_TTL_MS) {
    return stylesCache;
  }

  try {
    const res = await fetch(`${API_BASE}/image/styles`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.log(`[Venice] Failed to fetch styles: HTTP ${res.status}`);
      return stylesCache || [];
    }
    const data = await res.json();
    stylesCache = (data.data || data || []).map(s => ({
      id: s.id || s,
      name: s.name || s.id || s,
    }));
    stylesCacheTime = now;
    console.log(`[Venice] Fetched ${stylesCache.length} style presets`);
    return stylesCache;
  } catch (e) {
    console.log('[Venice] Error fetching styles:', e.message);
    return stylesCache || [];
  }
}

module.exports = {
  id: 'venice',
  name: 'Venice AI',

  checkReady(store) {
    return !!store.get('veniceApiKey');
  },

  getModels() {
    // Return cached models synchronously; they're fetched when settings open
    return modelsCache || [];
  },

  getArtStyles() {
    return stylesCache || [];
  },

  /**
   * Fetch models list (called from IPC handler to populate UI dropdown).
   */
  async fetchModelsForUI(store) {
    const apiKey = store.get('veniceApiKey');
    if (!apiKey) return [];
    return fetchModels(apiKey);
  },

  /**
   * Fetch styles list (called from IPC handler to populate UI dropdown).
   */
  async fetchStylesForUI(store) {
    const apiKey = store.get('veniceApiKey');
    if (!apiKey) return [];
    return fetchStyles(apiKey);
  },

  async generate(prompt, negativePrompt, store) {
    const apiKey = store.get('veniceApiKey');
    if (!apiKey) {
      throw new Error('No Venice AI API key configured. Add one in Settings.');
    }

    const settings = store.get('imageSettings');
    const model = store.get('veniceModel') || 'flux-2-max';
    const steps = store.get('veniceSteps') || 25;
    const cfgScale = store.get('veniceCfgScale') || 7;
    const stylePreset = store.get('veniceStylePreset') || '';
    const safeMode = store.get('veniceSafeMode') || false;
    const hideWatermark = store.get('veniceHideWatermark') !== false;

    const width = Math.min(settings.width || 1024, MAX_DIMENSION);
    const height = Math.min(settings.height || 1024, MAX_DIMENSION);

    console.log(`[Venice] Generating with model=${model}, ${width}x${height}, steps=${steps}, cfg=${cfgScale}`);

    const body = {
      model,
      prompt,
      width,
      height,
      steps,
      cfg_scale: cfgScale,
      safe_mode: safeMode,
      hide_watermark: hideWatermark,
      format: 'png',
    };

    if (negativePrompt) {
      body.negative_prompt = negativePrompt;
    }

    if (stylePreset) {
      body.style_preset = stylePreset;
    }

    const seed = Math.floor(Math.random() * 999999999);
    body.seed = seed;

    const res = await fetch(`${API_BASE}/image/generate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Venice API error ${res.status}: ${errorText.substring(0, 300)}`);
    }

    const data = await res.json();

    if (!data.images || data.images.length === 0) {
      throw new Error('Venice API returned no images: ' + JSON.stringify(data).substring(0, 300));
    }

    const base64 = data.images[0];
    console.log('[Venice] Image generated successfully');
    return `data:image/png;base64,${base64}`;
  }
};

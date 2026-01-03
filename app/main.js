const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const AdmZip = require('adm-zip');
const Store = require('electron-store');

// Secure storage for API token
const store = new Store({
  encryptionKey: 'novelai-scene-visualizer-key',
  schema: {
    apiToken: { type: 'string', default: '' },
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

// Model configurations
const MODEL_CONFIG = {
  // V3 Models (support SMEA)
  'nai-diffusion-3': { isV4: false, name: 'NAI Diffusion Anime V3' },
  'nai-diffusion-furry-3': { isV4: false, name: 'NAI Diffusion Furry V3' },
  // V4 Models
  'nai-diffusion-4-curated-preview': { isV4: true, name: 'NAI Diffusion V4 Curated' },
  'nai-diffusion-4-full': { isV4: true, name: 'NAI Diffusion V4 Full' },
  // V4.5 Models
  'nai-diffusion-4-5-curated': { isV4: true, name: 'NAI Diffusion V4.5 Curated' },
  'nai-diffusion-4-5-full': { isV4: true, name: 'NAI Diffusion V4.5 Full' },
};

// Quality presets per model
const QUALITY_PRESETS = {
  'nai-diffusion-3': ', best quality, amazing quality, very aesthetic, absurdres',
  'nai-diffusion-furry-3': ', {best quality}, {amazing quality}',
  'nai-diffusion-4-curated-preview': ', rating:general, best quality, very aesthetic, absurdres',
  'nai-diffusion-4-full': ', no text, best quality, very aesthetic, absurdres',
  'nai-diffusion-4-5-curated': ', very aesthetic, masterpiece, no text, rating:general',
  'nai-diffusion-4-5-full': ', very aesthetic, masterpiece, no text',
};

// Negative prompt presets
const UC_PRESETS = {
  'nai-diffusion-3': {
    heavy: 'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract],',
    light: 'lowres, jpeg artifacts, worst quality, watermark, blurry, very displeasing,',
  },
  'nai-diffusion-furry-3': {
    heavy: '{{worst quality}}, [displeasing], {unusual pupils}, guide lines, {{unfinished}}, {bad}, url, artist name, {{tall image}}, mosaic, {sketch page}, comic panel, impact (font), [dated], {logo}, ych,',
    light: '{worst quality}, guide lines, unfinished, bad, url, tall image, widescreen, compression artifacts,',
  },
  'nai-diffusion-4-curated-preview': {
    heavy: 'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts, white blank page, blank page,',
    light: 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, logo, dated, signature, white blank page, blank page,',
  },
  'nai-diffusion-4-full': {
    heavy: 'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, white blank page, blank page,',
    light: 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, white blank page, blank page,',
  },
  'nai-diffusion-4-5-curated': {
    heavy: 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page,',
    light: 'blurry, lowres, upscaled, artistic error, scan artifacts, jpeg artifacts, logo, too many watermarks, negative space, blank page,',
  },
  'nai-diffusion-4-5-full': {
    heavy: 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page,',
    light: 'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page,',
  },
};

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

  // Open DevTools in development
  if (process.argv.includes('--enable-logging')) {
    mainWindow.webContents.openDevTools();
  }
}

// Image generation API call
async function generateImage(prompt, negativePrompt = '') {
  const apiToken = store.get('apiToken');

  if (!apiToken) {
    throw new Error('No API token configured. Please set your NovelAI API token.');
  }

  const settings = store.get('imageSettings');
  const model = settings.model || 'nai-diffusion-4-curated-preview';
  const modelConfig = MODEL_CONFIG[model] || { isV4: true };
  const seed = Math.floor(Math.random() * 4294967295);

  // Get UC preset for model
  const ucPresets = UC_PRESETS[model] || UC_PRESETS['nai-diffusion-4-curated-preview'];
  const ucPreset = settings.ucPreset || 'heavy';
  const baseNegative = ucPresets[ucPreset] || ucPresets.heavy;
  const finalNegative = negativePrompt ? negativePrompt + ', ' + baseNegative : baseNegative;

  // Get quality tags for model
  const qualityTags = settings.qualityTags ? (QUALITY_PRESETS[model] || '') : '';
  const finalPrompt = prompt + qualityTags;

  console.log(`[Main] Using model: ${model}, isV4: ${modelConfig.isV4}`);

  // Build request body
  const requestBody = {
    model: model,
    action: 'generate',
    input: finalPrompt,
    parameters: {
      width: settings.width,
      height: settings.height,
      steps: settings.steps,
      scale: settings.scale,
      sampler: settings.sampler,
      n_samples: 1,
      seed: seed,
      negative_prompt: finalNegative,
      cfg_rescale: settings.cfgRescale || 0,
      noise_schedule: settings.noiseSchedule || 'karras',
    }
  };

  // Add model-specific parameters
  if (modelConfig.isV4) {
    // V4/V4.5 specific parameters
    Object.assign(requestBody.parameters, {
      params_version: 3,
      legacy: false,
      legacy_uc: false,
      legacy_v3_extend: false,
      controlnet_strength: 1,
      dynamic_thresholding: true,
      skip_cfg_above_sigma: null,
      qualityToggle: settings.qualityTags,
      sm: false,
      sm_dyn: false,
      autoSmea: false,
      use_coords: false,
      prefer_brownian: true,
      deliberate_euler_ancestral_bug: false,
      // V4 prompt structures (required)
      v4_prompt: {
        use_coords: false,
        use_order: true,
        caption: {
          base_caption: finalPrompt,
          char_captions: []
        }
      },
      v4_negative_prompt: {
        legacy_uc: false,
        caption: {
          base_caption: finalNegative,
          char_captions: []
        }
      }
    });
  } else {
    // V3 specific parameters (supports SMEA)
    Object.assign(requestBody.parameters, {
      legacy: false,
      qualityToggle: settings.qualityTags,
      sm: settings.smea || false,
      sm_dyn: settings.smeaDyn || false,
    });
  }

  console.log('[Main] Generating image with prompt:', prompt.substring(0, 100) + '...');

  try {
    const response = await fetch('https://image.novelai.net/ai/generate-image', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/zip'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API Error ${response.status}: ${errorText}`);
    }

    // Response is a ZIP file containing the image
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const zip = new AdmZip(buffer);
    const zipEntries = zip.getEntries();

    // Find the image file in the ZIP
    const imageEntry = zipEntries.find(entry =>
      entry.entryName.endsWith('.png') || entry.entryName.endsWith('.jpg')
    );

    if (!imageEntry) {
      throw new Error('No image found in response');
    }

    // Extract and convert to base64
    const imageBuffer = imageEntry.getData();
    const base64 = imageBuffer.toString('base64');
    const mimeType = imageEntry.entryName.endsWith('.png') ? 'image/png' : 'image/jpeg';

    console.log('[Main] Image generated successfully');
    return `data:${mimeType};base64,${base64}`;

  } catch (error) {
    console.error('[Main] Image generation failed:', error);
    throw error;
  }
}

// IPC Handlers
ipcMain.handle('generate-image', async (event, { prompt, negativePrompt }) => {
  try {
    const imageData = await generateImage(prompt, negativePrompt);
    return { success: true, imageData };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-api-token', () => {
  return store.get('apiToken') ? '***configured***' : '';
});

ipcMain.handle('set-api-token', (event, token) => {
  store.set('apiToken', token);
  return { success: true };
});

ipcMain.handle('get-image-settings', () => {
  return store.get('imageSettings');
});

ipcMain.handle('set-image-settings', (event, settings) => {
  store.set('imageSettings', settings);
  return { success: true };
});

ipcMain.handle('get-models', () => {
  return Object.entries(MODEL_CONFIG).map(([id, config]) => ({
    id,
    name: config.name,
    isV4: config.isV4
  }));
});

app.whenReady().then(() => {
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

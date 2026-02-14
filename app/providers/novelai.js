const AdmZip = require('adm-zip');

// Art style presets for NovelAI
const ART_STYLES = {
  'no-style': {
    name: 'No Style',
    prompt: '',
    negative: '',
  },
  'anime': {
    name: 'Anime',
    prompt: ', anime style, detailed, vibrant colors, clean lines',
    negative: '',
  },
  'cinematic': {
    name: 'Cinematic',
    prompt: ', cinematic lighting, dramatic atmosphere, film still, depth of field, 75mm',
    negative: 'flat lighting, boring composition',
  },
  'digital-painting': {
    name: 'Digital Painting',
    prompt: ', digital painting, highly detailed, artstation, sharp focus, illustration, concept art',
    negative: '',
  },
  'oil-painting': {
    name: 'Oil Painting',
    prompt: ', oil painting, painterly, canvas texture, brush strokes, rich colors, fine art',
    negative: '',
  },
  'watercolor': {
    name: 'Watercolor',
    prompt: ', watercolor painting, soft colors, textured paper, flowing paint, delicate details',
    negative: 'sharp edges, digital artifacts',
  },
  'fantasy-art': {
    name: 'Fantasy Art',
    prompt: ', fantasy art, epic, dramatic lighting, highly detailed, magical atmosphere',
    negative: '',
  },
  'manga': {
    name: 'Manga',
    prompt: ', manga style, black and white, ink drawing, detailed linework, dramatic shading, screentone',
    negative: 'color, painted',
  },
  'concept-art': {
    name: 'Concept Art',
    prompt: ', concept art, illustration, matte painting, cinematic composition, dynamic lighting',
    negative: '',
  },
  'painted-anime': {
    name: 'Painted Anime',
    prompt: ', painted anime, painterly anime style, soft shading, vibrant, detailed background',
    negative: 'sketch, lineart, flat colors',
  },
  'photorealistic': {
    name: 'Photorealistic',
    prompt: ', photorealistic, hyperrealistic, professional photography, sharp focus, DSLR, 85mm lens',
    negative: 'painting, drawn, illustration, cartoon',
  },
  'pixel-art': {
    name: 'Pixel Art',
    prompt: ', pixel art, retro game style, 16-bit, clean pixels, sprite art',
    negative: 'blurry, smooth, photorealistic',
  },
};

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

module.exports = {
  id: 'novelai',
  name: 'NovelAI',

  checkReady(store) {
    return !!store.get('apiToken');
  },

  getModels() {
    return Object.entries(MODEL_CONFIG).map(([id, config]) => ({
      id,
      name: config.name,
      isV4: config.isV4
    }));
  },

  getArtStyles() {
    return Object.entries(ART_STYLES).map(([id, style]) => ({
      id,
      name: style.name,
    }));
  },

  async generate(prompt, negativePrompt, store) {
    const apiToken = store.get('apiToken');
    if (!apiToken) {
      throw new Error('No API token configured. Please set your NovelAI API token.');
    }

    const settings = store.get('imageSettings');
    const model = settings.model || 'nai-diffusion-4-curated-preview';
    const modelConfig = MODEL_CONFIG[model] || { isV4: true };
    const seed = Math.floor(Math.random() * 4294967295);

    // Get art style
    const artStyleId = store.get('novelaiArtStyle') || 'no-style';
    const artStyle = ART_STYLES[artStyleId] || ART_STYLES['no-style'];

    // Get UC preset for model
    const ucPresets = UC_PRESETS[model] || UC_PRESETS['nai-diffusion-4-curated-preview'];
    const ucPreset = settings.ucPreset || 'heavy';
    const baseNegative = ucPresets[ucPreset] || ucPresets.heavy;
    const styleNegative = artStyle.negative;
    const negParts = [negativePrompt, styleNegative, baseNegative].filter(Boolean);
    const finalNegative = negParts.join(', ');

    // Get quality tags for model
    const qualityTags = settings.qualityTags ? (QUALITY_PRESETS[model] || '') : '';
    const finalPrompt = prompt + artStyle.prompt + qualityTags;

    console.log(`[NovelAI] Using model: ${model}, isV4: ${modelConfig.isV4}`);

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
      Object.assign(requestBody.parameters, {
        legacy: false,
        qualityToggle: settings.qualityTags,
        sm: settings.smea || false,
        sm_dyn: settings.smeaDyn || false,
      });
    }

    console.log('[NovelAI] Generating image with prompt:', prompt.substring(0, 100) + '...');

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

    const imageEntry = zipEntries.find(entry =>
      entry.entryName.endsWith('.png') || entry.entryName.endsWith('.jpg')
    );

    if (!imageEntry) {
      throw new Error('No image found in response');
    }

    const imageBuffer = imageEntry.getData();
    const base64 = imageBuffer.toString('base64');
    const mimeType = imageEntry.entryName.endsWith('.png') ? 'image/png' : 'image/jpeg';

    console.log('[NovelAI] Image generated successfully');
    return `data:${mimeType};base64,${base64}`;
  }
};

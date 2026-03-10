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
  'nai-diffusion-4-5-curated': ', location, very aesthetic, masterpiece, no text, rating:general',
  'nai-diffusion-4-5-full': ', location, very aesthetic, masterpiece, no text',
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

  // Resolve an art style ID to its prompt tags string (for LLM scene prompt injection)
  getArtStyleTags(styleId) {
    const style = ART_STYLES[styleId] || ART_STYLES['no-style'];
    // Return trimmed prompt (strip leading ", ")
    return style.prompt ? style.prompt.replace(/^,\s*/, '') : '';
  },

  // Compute the suffix tags that would be appended to a prompt (art style + quality tags).
  // Used by renderer to show the full final prompt in the textarea.
  getPromptSuffix(store) {
    const settings = store.get('imageSettings') || {};
    const model = settings.model || 'nai-diffusion-4-5-full';
    const artStyleId = store.get('novelaiArtStyle') || 'no-style';
    const artStyle = ART_STYLES[artStyleId] || ART_STYLES['no-style'];
    const qualityTags = settings.qualityTags !== false ? (QUALITY_PRESETS[model] || '') : '';
    return {
      artStyleSuffix: artStyle.prompt || '',
      qualitySuffix: qualityTags || '',
      combined: (artStyle.prompt || '') + (qualityTags || ''),
    };
  },

  // Compute the negative prompt suffix (art style negative + UC preset) for preview.
  getNegativeSuffix(store) {
    const settings = store.get('imageSettings') || {};
    const model = settings.model || 'nai-diffusion-4-5-full';
    const artStyleId = store.get('novelaiArtStyle') || 'no-style';
    const artStyle = ART_STYLES[artStyleId] || ART_STYLES['no-style'];
    const ucPresets = UC_PRESETS[model] || UC_PRESETS['nai-diffusion-4-curated-preview'];
    const ucPreset = settings.ucPreset || 'heavy';
    const baseNegative = ucPresets[ucPreset] || ucPresets.heavy;
    const styleNegative = artStyle.negative || '';
    return {
      styleNegative,
      ucPresetNegative: baseNegative || '',
      combined: [styleNegative, baseNegative].filter(Boolean).join(', '),
    };
  },

  async generate(prompt, negativePrompt, store, options = {}) {
    const apiToken = store.get('apiToken');
    if (!apiToken) {
      throw new Error('No API token configured. Please set your NovelAI API token.');
    }

    const settings = store.get('imageSettings');
    const model = settings.model || 'nai-diffusion-4-5-full';
    const modelConfig = MODEL_CONFIG[model] || { isV4: true };
    const seed = Math.floor(Math.random() * 4294967295);

    // Get art style
    const artStyleId = store.get('novelaiArtStyle') || 'no-style';
    const artStyle = ART_STYLES[artStyleId] || ART_STYLES['no-style'];

    // Build negative prompt — skip combining if rawNegativePrompt (already baked in)
    let finalNegative;
    if (options.rawNegativePrompt) {
      finalNegative = negativePrompt || '';
    } else {
      const ucPresets = UC_PRESETS[model] || UC_PRESETS['nai-diffusion-4-curated-preview'];
      const ucPreset = settings.ucPreset || 'heavy';
      const baseNegative = ucPresets[ucPreset] || ucPresets.heavy;
      const styleNegative = artStyle.negative;
      const negParts = [negativePrompt, styleNegative, baseNegative].filter(Boolean);
      finalNegative = negParts.join(', ');
    }

    // Get quality tags for model — skip if rawPrompt (tags already baked into prompt)
    let finalPrompt;
    if (options.rawPrompt) {
      finalPrompt = prompt;
    } else {
      const qualityTags = settings.qualityTags ? (QUALITY_PRESETS[model] || '') : '';
      finalPrompt = prompt + artStyle.prompt + qualityTags;
    }

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
        noise_schedule: settings.noiseSchedule || 'native',
      }
    };

    // Add model-specific parameters
    if (modelConfig.isV4) {
      const noiseSchedule = settings.noiseSchedule || 'native';
      const v4Params = {
        params_version: 1,
        legacy: false,
        legacy_uc: false,
        legacy_v3_extend: false,
        dynamic_thresholding: false,
        qualityToggle: settings.qualityTags,
        sm: false,
        sm_dyn: false,
        autoSmea: false,
        use_coords: false,
        uncond_scale: 1.0,
        extra_noise_seed: seed,
        v4_prompt: {
          use_coords: false,
          use_order: false,
          caption: {
            base_caption: finalPrompt,
            char_captions: []
          }
        },
        v4_negative_prompt: {
          use_coords: false,
          use_order: false,
          caption: {
            base_caption: finalNegative,
            char_captions: []
          }
        }
      };

      // Only add euler ancestral params when using that sampler with non-native schedule
      if (settings.sampler === 'k_euler_ancestral' && noiseSchedule !== 'native') {
        v4Params.deliberate_euler_ancestral_bug = false;
        v4Params.prefer_brownian = true;
      }

      Object.assign(requestBody.parameters, v4Params);
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
  },

  /**
   * Generate text via NovelAI's OpenAI-compatible chat API (GLM-4-6).
   * Endpoint streams SSE chunks; we accumulate delta.content text.
   */
  async generateText(messages, options, store) {
    const apiToken = store.get('apiToken');
    if (!apiToken) throw new Error('No API token available');

    const model = options.model || 'glm-4-6';
    const maxTokens = options.max_tokens || 300;
    const temperature = options.temperature || 0.6;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    let response;
    try {
      response = await fetch('https://text.novelai.net/oa/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature,
          stream: true,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') throw new Error('NovelAI text API timed out after 60s');
      throw err;
    }

    if (!response.ok) {
      clearTimeout(timeout);
      const text = await response.text();
      throw new Error(`NovelAI text API error ${response.status}: ${text}`);
    }

    // Read SSE stream and accumulate text from delta.content
    const rawText = await response.text();
    clearTimeout(timeout);
    let fullText = '';
    const lines = rawText.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ') || line.trim() === 'data: [DONE]') continue;
      try {
        const chunk = JSON.parse(line.slice(6));
        if (chunk.choices?.[0]?.delta?.content) {
          fullText += chunk.choices[0].delta.content;
        } else if (chunk.choices?.[0]?.text && chunk.choices[0].text.length > 0) {
          fullText += chunk.choices[0].text;
        }
      } catch (e) {
        // Skip unparseable chunks
      }
    }

    return { output: fullText };
  },

  // ---------------------------------------------------------------------------
  // Text-to-Speech
  // ---------------------------------------------------------------------------

  // V1 preset seeds (legacy TTS)
  V1_VOICES: ['Aini', 'Orea', 'Claea', 'Liedka', 'Aulon', 'Oyn', 'Naia', 'Aurae', 'Zaia', 'Zyre', 'Ligeia', 'Anthe'],
  // V2 preset seeds (newer TTS with style/intonation/cadence)
  V2_VOICES: ['Cyllene', 'Leucosia', 'Crina', 'Hespe', 'Ida', 'Alseid', 'Daphnis', 'Echo', 'Thel', 'Nomios'],
  // Set for fast lookup
  _v1Set: null,
  _v2Set: null,
  getV1Set() { if (!this._v1Set) this._v1Set = new Set(this.V1_VOICES); return this._v1Set; },
  getV2Set() { if (!this._v2Set) this._v2Set = new Set(this.V2_VOICES); return this._v2Set; },

  /**
   * Returns all voice presets grouped by version, plus a custom option.
   * Each voice: { id, name, version: 'v1'|'v2', category: 'novelai' }
   */
  getVoiceSeeds() {
    const voices = [];
    for (const s of this.V2_VOICES) {
      voices.push({ id: s, name: s, version: 'v2', category: 'novelai' });
    }
    for (const s of this.V1_VOICES) {
      voices.push({ id: s, name: s, version: 'v1', category: 'novelai' });
    }
    return voices;
  },

  /**
   * Determine the best TTS version for a voice value.
   * v2 objects always use v2. Known v2 presets use v2. Known v1 presets use v1.
   * Unknown seeds (custom) use the provided default or 'v2'.
   */
  detectVoiceVersion(voice, defaultVersion = 'v2') {
    if (voice && typeof voice === 'object' && voice.v === 2) return 'v2';
    if (typeof voice === 'string') {
      if (this.getV2Set().has(voice)) return 'v2';
      if (this.getV1Set().has(voice)) return 'v1';
    }
    return defaultVersion;
  },

  /**
   * Normalize a voice config (string preset or v2 object) into URL params.
   * If ttsVersion is 'auto' (default), auto-detects from the voice value.
   * @param {string|object} voice — preset name string or { v: 2, style, intonation, cadence }
   * @param {string} ttsVersion — 'v1', 'v2', or 'auto' (default 'auto')
   * @returns {object} key-value pairs for URLSearchParams
   */
  normalizeVoiceConfig(voice, ttsVersion = 'auto') {
    // v2 object voice: { v: 2, style, intonation, cadence }
    if (voice && typeof voice === 'object' && voice.v === 2) {
      return {
        voice: '-1',
        opus: 'false',
        version: 'v2',
        style: voice.style || 'Cyllene',
        intonation: voice.intonation || voice.style || 'Cyllene',
        cadence: voice.cadence || voice.style || 'Cyllene',
      };
    }
    // String preset — auto-detect or use explicit version
    const seed = voice || 'Cyllene';
    const resolvedVersion = ttsVersion === 'auto' ? this.detectVoiceVersion(seed) : ttsVersion;
    if (resolvedVersion === 'v2') {
      return {
        voice: '-1',
        opus: 'false',
        version: 'v2',
        style: seed,
        intonation: seed,
        cadence: seed,
      };
    }
    // v1
    return { seed, voice: '-1', opus: 'false', version: 'v1' };
  },

  async generateSpeech(text, voice, store, ttsVersion) {
    const token = store.get('apiToken');
    if (!token) throw new Error('No API token configured.');

    const voiceParams = this.normalizeVoiceConfig(voice, ttsVersion || 'auto');
    const params = new URLSearchParams({ text, ...voiceParams });
    const res = await fetch(`https://api.novelai.net/ai/generate-voice?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`NovelAI TTS error ${res.status}: ${errorText.substring(0, 300)}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    return { audioData: `data:audio/webm;base64,${buf.toString('base64')}`, format: 'webm' };
  },

  getModelFallbackOrder(currentModel) {
    const chain = [
      'nai-diffusion-4-5-full',
      'nai-diffusion-4-5-curated',
      'nai-diffusion-4-full',
      'nai-diffusion-4-curated-preview',
      'nai-diffusion-3',
    ];
    return chain.filter(m => m !== currentModel);
  }
};

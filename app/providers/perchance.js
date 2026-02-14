const { BrowserWindow, session } = require('electron');
const path = require('path');

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Art styles: prompt/negative prompt modifiers
const ART_STYLES = {
  'no-style': {
    name: 'No Style',
    prompt: '',
    negative: '',
  },
  'cinematic': {
    name: 'Cinematic',
    prompt: ', cinematic shot, dynamic lighting, 75mm, Technicolor, Panavision, cinemascope, sharp focus, fine details, 8k, HDR, realism, realistic, key visual, film still, superb cinematic color grading, depth of field',
    negative: 'bad lighting, low-quality, deformed, text, poorly drawn, bad art, bad angle, boring, low-resolution, worst quality, bad composition, disfigured',
  },
  'digital-painting': {
    name: 'Digital Painting',
    prompt: ', digital painting, highly detailed, artstation, sharp focus, illustration, concept art, 8k',
    negative: 'blurry, bad anatomy, extra limbs, poorly drawn face, poorly drawn hands, missing fingers, worst quality, low quality',
  },
  'concept-art': {
    name: 'Concept Art',
    prompt: ', concept art, illustration, matte painting, highly detailed, cinematic composition, dynamic lighting, artstation trending',
    negative: 'blurry, low-quality, text, watermark, bad anatomy, worst quality',
  },
  'oil-painting': {
    name: 'Oil Painting',
    prompt: ', oil painting, alla prima, painterly, canvas texture, brush strokes, rich colors, masterwork, fine art',
    negative: 'blurry, low resolution, worst quality, fuzzy, digital artifacts',
  },
  'fantasy-painting': {
    name: 'Fantasy Painting',
    prompt: ', fantasy art, D&D illustration style, epic, dramatic lighting, highly detailed, magical atmosphere, artstation',
    negative: 'blurry, low resolution, worst quality, bad anatomy, text, watermark',
  },
  'anime': {
    name: 'Anime',
    prompt: ', anime style, anime art, detailed, vibrant colors, clean lines, high quality anime illustration',
    negative: 'blurry, low resolution, worst quality, realistic, photo, 3d render',
  },
  'painted-anime': {
    name: 'Painted Anime',
    prompt: ', painted anime, pixiv, painterly anime style, soft shading, vibrant, detailed background, studio quality',
    negative: 'blurry, low resolution, worst quality, sketch, lineart, flat colors',
  },
  'watercolor': {
    name: 'Watercolor',
    prompt: ', watercolor painting, soft colors, textured paper, flowing paint, artistic, delicate details, traditional media',
    negative: 'blurry, low resolution, worst quality, digital artifacts, sharp edges',
  },
  'illustration': {
    name: 'Illustration',
    prompt: ', breathtaking illustration, detailed, masterwork, vivid colors, professional, trending on artstation',
    negative: 'blurry, low resolution, worst quality, amateur, bad composition',
  },
  'manga': {
    name: 'Manga',
    prompt: ', manga style, black and white, ink drawing, detailed linework, dramatic shading, screentone',
    negative: 'blurry, low resolution, worst quality, color, painted',
  },
  'casual-photo': {
    name: 'Casual Photo',
    prompt: ', casual photography, natural lighting, candid, authentic, high resolution photograph, bokeh',
    negative: 'blurry, low resolution, worst quality, painting, drawn, illustration, cartoon',
  },
  'professional-photo': {
    name: 'Professional Photo',
    prompt: ', professional photography, studio lighting, high resolution, sharp focus, DSLR, 85mm lens, detailed, award-winning photograph',
    negative: 'blurry, low resolution, worst quality, painting, drawn, illustration, amateur, grainy',
  },
  'vintage-comic': {
    name: 'Vintage Comic',
    prompt: ', vintage comic book style, 1950s comic art, halftone dots, bold outlines, retro colors, speech bubble aesthetic',
    negative: 'blurry, low resolution, worst quality, modern, realistic, photograph',
  },
  'fantasy-landscape': {
    name: 'Fantasy Landscape',
    prompt: ', fantasy landscape, epic vista, matte painting style, breathtaking scenery, magical environment, detailed worldbuilding, cinematic wide shot',
    negative: 'blurry, low resolution, worst quality, text, watermark, close-up, portrait',
  },
};

const MAX_DIMENSION = 768;

// Rate limiting: Perchance enforces ~15-20s cooldown between generations
const RATE_LIMIT_COOLDOWN_MS = 20000;
let lastGenerationTime = 0;

// Persistent hidden BrowserWindow for making API calls through Cloudflare
let apiWindow = null;
let cfReady = false;

/**
 * Get or create a hidden BrowserWindow that has Cloudflare clearance
 * for image-generation.perchance.org. Uses stealth patches and persistent
 * session so CF clearance survives across requests.
 */
async function getApiWindow() {
  if (apiWindow && !apiWindow.isDestroyed()) {
    if (cfReady) return apiWindow;
  }

  const ses = session.fromPartition('persist:perchance-api');
  ses.setUserAgent(CHROME_UA);

  apiWindow = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      partition: 'persist:perchance-api',
      nodeIntegration: false,
      contextIsolation: false,
      preload: path.join(__dirname, '..', 'perchance-stealth.js'),
    }
  });

  apiWindow.on('closed', () => {
    apiWindow = null;
    cfReady = false;
  });

  console.log('[Perchance] Navigating hidden window to clear Cloudflare...');

  // Navigate to the API domain to trigger CF challenge and clear it
  await apiWindow.loadURL('https://image-generation.perchance.org/', {
    userAgent: CHROME_UA,
  });

  // Wait for Cloudflare to auto-solve (managed challenge)
  const cleared = await waitForCfClearance(apiWindow, 30000);
  if (!cleared) {
    console.log('[Perchance] Cloudflare did not auto-clear, may need manual clearance');
  } else {
    console.log('[Perchance] Cloudflare cleared for API domain');
  }

  cfReady = true;
  return apiWindow;
}

/**
 * Wait for Cloudflare challenge to auto-solve by checking page title.
 * CF challenge pages have title "Just a moment..."
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
 * This routes through the browser's session which has CF cookies.
 * Supports GET (default) and POST with JSON body.
 */
async function browserFetch(url, options = {}) {
  const win = await getApiWindow();

  const fetchOptions = JSON.stringify({
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body || undefined,
  });

  // Use executeJavaScript to run fetch in the browser context (with CF cookies)
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
      console.log('[Perchance] CF challenge on API request, re-clearing...');
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
 * Ensure the userKey is verified on Perchance's server.
 * Checks status via the API BrowserWindow (which has CF clearance).
 * If not verified, opens a SEPARATE temporary window to trigger verification
 * (never navigates the API window away from the API domain).
 */
async function ensureKeyVerified(userKey) {
  const checkUrl = `https://image-generation.perchance.org/api/checkVerificationStatus?userKey=${encodeURIComponent(userKey)}&__cacheBust=${Math.random()}`;

  try {
    const result = await browserFetch(checkUrl);
    console.log(`[Perchance] Key verification check: ${result.body.substring(0, 200)}`);

    if (!result.body.includes('not_verified')) {
      console.log('[Perchance] Key is verified');
      return;
    }

    console.log('[Perchance] Key not verified — opening temporary window for verification...');

    // Use a separate window so we don't disrupt the API window
    const ses = session.fromPartition('persist:perchance-verify');
    ses.setUserAgent(CHROME_UA);

    const verifyWin = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        partition: 'persist:perchance-verify',
        nodeIntegration: false,
        contextIsolation: false,
        preload: path.join(__dirname, '..', 'perchance-stealth.js'),
      }
    });

    try {
      await verifyWin.webContents.loadURL('https://perchance.org/ai-text-to-image-generator', {
        userAgent: CHROME_UA,
      });

      await waitForCfClearance(verifyWin, 30000);

      // Inject the userKey so the page's verification flow uses our key
      await verifyWin.webContents.executeJavaScript(`
        try { localStorage.setItem('userKey', ${JSON.stringify(userKey)}); } catch(e) {}
      `);

      // Poll for verification via the API window (same-origin, no CORS issues)
      console.log('[Perchance] Waiting for key verification...');
      const maxWait = 25000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        await new Promise(r => setTimeout(r, 3000));
        try {
          const recheck = await browserFetch(`https://image-generation.perchance.org/api/checkVerificationStatus?userKey=${encodeURIComponent(userKey)}&__cacheBust=${Math.random()}`);
          console.log(`[Perchance] Re-check: ${recheck.body.substring(0, 100)}`);
          if (!recheck.body.includes('not_verified')) {
            console.log('[Perchance] Key verified successfully');
            return;
          }
        } catch (e) {
          console.log('[Perchance] Re-check fetch error:', e.message);
        }
      }

      console.log('[Perchance] Key verification timed out — proceeding with generation anyway');
    } finally {
      verifyWin.destroy();
    }
  } catch (e) {
    console.log('[Perchance] Key verification check failed:', e.message, '— proceeding with generation');
  }
}

module.exports = {
  id: 'perchance',
  name: 'Perchance (Free)',

  checkReady(store) {
    return !!store.get('perchanceUserKey');
  },

  getModels() {
    return [];
  },

  getArtStyles() {
    return Object.entries(ART_STYLES).map(([id, style]) => ({
      id,
      name: style.name
    }));
  },

  async generate(prompt, negativePrompt, store) {
    const userKey = store.get('perchanceUserKey');
    if (!userKey) {
      throw new Error('No Perchance user key. Please extract one in Settings.');
    }

    const settings = store.get('imageSettings');
    const artStyleId = store.get('perchanceArtStyle') || 'no-style';
    const artStyle = ART_STYLES[artStyleId] || ART_STYLES['no-style'];

    const finalPrompt = prompt + artStyle.prompt;
    const styleNegative = artStyle.negative;
    const finalNegative = [negativePrompt, styleNegative].filter(Boolean).join(', ');

    const width = Math.min(settings.width || 512, MAX_DIMENSION);
    const height = Math.min(settings.height || 768, MAX_DIMENSION);
    const resolution = `${width}x${height}`;

    const guidanceScale = store.get('perchanceGuidanceScale') || 7;
    const seed = Math.floor(Math.random() * 4294967295);

    console.log(`[Perchance] Generating with style: ${artStyleId}, resolution: ${resolution}`);

    // Enforce rate limit cooldown before sending request
    const timeSinceLast = Date.now() - lastGenerationTime;
    if (timeSinceLast < RATE_LIMIT_COOLDOWN_MS) {
      const waitMs = RATE_LIMIT_COOLDOWN_MS - timeSinceLast;
      console.log(`[Perchance] Rate limit cooldown: waiting ${Math.ceil(waitMs / 1000)}s...`);
      await new Promise(r => setTimeout(r, waitMs));
    }

    // Pre-check: verify key status via the API browser (which has CF clearance)
    await ensureKeyVerified(userKey);

    // Step 1: Generate image (via browser to bypass Cloudflare)
    // URL gets auth/cache params; body gets generation params (POST)
    const generateUrl = new URL('https://image-generation.perchance.org/api/generate');
    generateUrl.searchParams.set('userKey', userKey);
    generateUrl.searchParams.set('requestId', `aiImageCompletion${Math.floor(Math.random() * 1e9)}`);
    generateUrl.searchParams.set('__cacheBust', String(Math.random()));

    const generateBody = {
      generatorName: 'ai-image-generator',
      channel: 'ai-text-to-image-generator',
      subChannel: 'public',
      prompt: finalPrompt,
      negativePrompt: finalNegative,
      seed: seed,
      resolution: resolution,
      guidanceScale: guidanceScale,
    };

    // Retry loop: handles both HTTP 429 and JSON {"status":"too_many_requests"}
    let generateData;
    const maxRetries = 4;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Update cache-busting params on each attempt
      generateUrl.searchParams.set('requestId', `aiImageCompletion${Math.floor(Math.random() * 1e9)}`);
      generateUrl.searchParams.set('__cacheBust', String(Math.random()));
      generateBody.seed = Math.floor(Math.random() * 4294967295);

      const generateResult = await browserFetch(generateUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(generateBody),
      });

      // Check if rate limited (HTTP 429 or JSON too_many_requests)
      const isHttp429 = generateResult.status === 429;
      let isJsonRateLimit = false;

      console.log(`[Perchance] Raw response — HTTP ${generateResult.status}, ok=${generateResult.ok}, body length=${generateResult.body.length}`);

      if (generateResult.ok || isHttp429) {
        try {
          generateData = JSON.parse(generateResult.body);
          isJsonRateLimit = generateData.status === 'too_many_requests';
        } catch {
          if (!generateResult.ok) {
            throw new Error(`Perchance API Error ${generateResult.status}: ${generateResult.body.substring(0, 300)}`);
          }
          // ok response but not JSON — might be CF challenge HTML
          throw new Error(`Perchance returned non-JSON (HTTP ${generateResult.status}): ${generateResult.body.substring(0, 300)}`);
        }
      } else {
        throw new Error(`Perchance API Error ${generateResult.status}: ${generateResult.body.substring(0, 300)}`);
      }

      if (isHttp429 || isJsonRateLimit) {
        if (attempt < maxRetries - 1) {
          const waitSec = 15 + (attempt * 10); // 15s, 25s, 35s
          console.log(`[Perchance] Rate limited (attempt ${attempt + 1}/${maxRetries}), waiting ${waitSec}s...`);
          await new Promise(r => setTimeout(r, waitSec * 1000));
          continue;
        }
        throw new Error('Perchance rate limit — the service is busy. Wait ~30 seconds and try again.');
      }

      console.log(`[Perchance] Generate response (HTTP ${generateResult.status}): ${generateResult.body.substring(0, 300)}`);

      if (generateData.status === 'invalid_key') {
        store.set('perchanceUserKey', '');
        throw new Error(`Perchance key rejected by API. Response: ${JSON.stringify(generateData)}`);
      }


      break;
    }

    lastGenerationTime = Date.now();

    if (!generateData.imageId) {
      throw new Error('No image ID in Perchance response: ' + JSON.stringify(generateData));
    }

    // Step 2: Download the generated image (via browser)
    const downloadUrl = `https://image-generation.perchance.org/api/downloadTemporaryImage?imageId=${encodeURIComponent(generateData.imageId)}`;
    const base64 = await browserFetchBase64(downloadUrl);

    console.log('[Perchance] Image generated successfully');
    return `data:image/jpeg;base64,${base64}`;
  }
};

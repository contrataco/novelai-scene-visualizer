// Pollo AI Image Generation Provider
// Uses internal tRPC API via persistent BrowserWindow (Cloudflare-protected)
// Login via system browser (for passkey support), session auto-extracted from Chrome cookies

const { BrowserWindow, session, shell } = require('electron');
const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
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

// Cached auth cookies from last import — re-applied after CF navigation
let cachedAuthCookies = null;

// =========================================================================
// Chromium cookie extraction (macOS)
// =========================================================================

/**
 * Convert Chromium's microsecond timestamp (epoch 1601-01-01) to Unix seconds.
 */
function chromiumTimestampToUnix(chromiumTs) {
  // Chromium epoch offset: 11644473600 seconds between 1601-01-01 and 1970-01-01
  const ts = parseInt(chromiumTs, 10);
  if (!ts || ts === 0) return undefined;
  return Math.floor(ts / 1000000) - 11644473600;
}

// Chromium-based browsers and their cookie DB / Keychain entries on macOS
const CHROMIUM_BROWSERS = [
  {
    name: 'Chrome',
    cookiePath: path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Default/Cookies'),
    keychainService: 'Chrome Safe Storage',
  },
  {
    name: 'Arc',
    cookiePath: path.join(os.homedir(), 'Library/Application Support/Arc/User Data/Default/Cookies'),
    keychainService: 'Arc Safe Storage',
  },
  {
    name: 'Brave',
    cookiePath: path.join(os.homedir(), 'Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies'),
    keychainService: 'Brave Safe Storage',
  },
  {
    name: 'Edge',
    cookiePath: path.join(os.homedir(), 'Library/Application Support/Microsoft Edge/Default/Cookies'),
    keychainService: 'Microsoft Edge Safe Storage',
  },
  {
    name: 'Chromium',
    cookiePath: path.join(os.homedir(), 'Library/Application Support/Chromium/Default/Cookies'),
    keychainService: 'Chromium Safe Storage',
  },
];

/**
 * Decrypt a Chrome v10-encrypted cookie value.
 * Chrome on macOS uses PBKDF2 + AES-128-CBC with the key from the Keychain.
 */
function decryptChromeCookie(encryptedBuf, derivedKey) {
  // v10 prefix: 3 bytes (0x76 0x31 0x30)
  if (encryptedBuf.length < 4) return null;
  if (encryptedBuf[0] !== 0x76 || encryptedBuf[1] !== 0x31 || encryptedBuf[2] !== 0x30) {
    // Not v10-encrypted — might be plaintext
    return encryptedBuf.toString('utf8');
  }

  const iv = Buffer.alloc(16, 0x20); // 16 bytes of space (0x20)
  const ciphertext = encryptedBuf.slice(3);

  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', derivedKey, iv);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    // Remove PKCS7 padding
    const padLen = decrypted[decrypted.length - 1];
    const unpadded = (padLen > 0 && padLen <= 16)
      ? decrypted.slice(0, decrypted.length - padLen)
      : decrypted;
    // Chrome prepends 32 bytes of random data before the actual cookie value
    if (unpadded.length > 32) {
      return unpadded.slice(32).toString('utf8');
    }
    return unpadded.toString('utf8');
  } catch (e) {
    console.log('[Pollo] Cookie decryption failed:', e.message);
    return null;
  }
}

/**
 * Extract all pollo.ai cookies from the first available Chromium browser.
 * Reads the SQLite cookie DB on disk, decrypts using the macOS Keychain.
 * Returns array of { name, value } or null if no browser / no cookies found.
 */
function extractCookiesFromBrowser() {
  for (const browser of CHROMIUM_BROWSERS) {
    if (!fs.existsSync(browser.cookiePath)) continue;

    console.log(`[Pollo] Trying ${browser.name} cookie store...`);

    try {
      // Get decryption key from macOS Keychain
      const rawKey = execSync(
        `security find-generic-password -s "${browser.keychainService}" -w 2>/dev/null`
      ).toString().trim();

      if (!rawKey) {
        console.log(`[Pollo] No Keychain entry for ${browser.name}`);
        continue;
      }

      const derivedKey = crypto.pbkdf2Sync(rawKey, 'saltysalt', 1003, 16, 'sha1');

      // Copy cookie DB to temp (browser may have it locked)
      const tmpDir = os.tmpdir();
      const tmpDb = path.join(tmpDir, `pollo_cookies_${Date.now()}.db`);

      fs.copyFileSync(browser.cookiePath, tmpDb);
      // Also copy WAL/SHM files for consistency
      for (const ext of ['-wal', '-shm']) {
        const src = browser.cookiePath + ext;
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, tmpDb + ext);
        }
      }

      // Query for pollo.ai cookies with full metadata
      // Use TAB as separator to avoid conflicts with cookie values containing |
      const sqlResult = execSync(
        `sqlite3 -separator $'\\t' "${tmpDb}" "SELECT name, hex(encrypted_value), host_key, path, is_secure, is_httponly, samesite, has_expires, expires_utc FROM cookies WHERE host_key LIKE '%pollo.ai%'" 2>/dev/null`
      ).toString().trim();

      // Clean up temp files
      for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) {
        try { fs.unlinkSync(f); } catch {}
      }

      if (!sqlResult) {
        console.log(`[Pollo] No pollo.ai cookies in ${browser.name}`);
        continue;
      }

      // Parse: each line is "name\thexvalue\thost_key\tpath\tis_secure\tis_httponly\tsamesite\thas_expires\texpires_utc"
      const cookies = [];
      for (const line of sqlResult.split('\n')) {
        const parts = line.split('\t');
        if (parts.length < 2) continue;
        const [name, hexValue, hostKey, cookiePath, isSecure, isHttpOnly, sameSite, hasExpires, expiresUtc] = parts;
        if (!hexValue) continue;

        const encBuf = Buffer.from(hexValue, 'hex');
        const value = decryptChromeCookie(encBuf, derivedKey);

        if (value && value.length > 0) {
          cookies.push({
            name,
            value,
            domain: hostKey || '.pollo.ai',
            path: cookiePath || '/',
            secure: isSecure === '1',
            httpOnly: isHttpOnly === '1',
            sameSite: sameSite === '2' ? 'strict' : sameSite === '1' ? 'lax' : 'unspecified',
            expirationDate: hasExpires === '1' && expiresUtc ? chromiumTimestampToUnix(expiresUtc) : undefined,
          });
        }
      }

      if (cookies.length > 0) {
        console.log(`[Pollo] Extracted ${cookies.length} cookies from ${browser.name}`);
        return { browser: browser.name, cookies };
      }

      console.log(`[Pollo] Could not decrypt cookies from ${browser.name}`);
    } catch (e) {
      console.log(`[Pollo] Failed to read ${browser.name} cookies:`, e.message);
    }
  }

  return null;
}

/**
 * Import extracted cookies into Electron's session partition.
 */
async function importCookiesToSession(cookies) {
  const ses = session.fromPartition('persist:pollo-api');

  // Reset existing API window so it picks up new cookies
  cfReady = false;
  if (apiWindow && !apiWindow.isDestroyed()) {
    apiWindow.destroy();
  }
  apiWindow = null;

  // Clear ALL existing pollo.ai cookies first to prevent duplicates
  // (page navigation later will set its own cookies alongside our imported ones)
  const existingCookies = await ses.cookies.get({});
  for (const c of existingCookies) {
    if (c.domain && (c.domain.includes('pollo.ai'))) {
      const scheme = c.secure ? 'https' : 'http';
      const domain = c.domain.startsWith('.') ? c.domain.substring(1) : c.domain;
      try {
        await ses.cookies.remove(`${scheme}://${domain}${c.path}`, c.name);
      } catch {}
    }
  }
  console.log(`[Pollo] Cleared ${existingCookies.filter(c => c.domain && c.domain.includes('pollo.ai')).length} existing pollo.ai cookies`);

  let imported = 0;
  for (const cookie of cookies) {
    try {
      const cookieData = {
        url: 'https://pollo.ai',
        name: cookie.name,
        value: cookie.value,
        path: cookie.path || '/',
        secure: cookie.secure || false,
        httpOnly: cookie.httpOnly || false,
        sameSite: cookie.sameSite || 'lax',
      };

      // Electron normalizes domain with a leading dot, converting host-only
      // cookies into domain cookies. To preserve host-only semantics (host_key
      // without leading dot in Chrome DB), omit the domain field entirely and
      // let Electron derive it from the url — this creates a host-only cookie.
      const isHostOnly = cookie.domain && !cookie.domain.startsWith('.');

      if (cookie.name.startsWith('__Host-')) {
        cookieData.secure = true;
        // __Host- prefix forbids domain attribute
      } else if (isHostOnly) {
        // Host-only cookie: don't set domain, let url determine it
        if (cookie.name.startsWith('__Secure-')) cookieData.secure = true;
      } else {
        // Domain cookie: set domain normally
        cookieData.domain = cookie.domain || '.pollo.ai';
        if (cookie.name.startsWith('__Secure-')) cookieData.secure = true;
      }

      // Set expiration if available (future dates only)
      if (cookie.expirationDate && cookie.expirationDate > Date.now() / 1000) {
        cookieData.expirationDate = cookie.expirationDate;
      }

      await ses.cookies.set(cookieData);
      imported++;
    } catch (e) {
      console.log(`[Pollo] Failed to import cookie ${cookie.name}:`, e.message);
    }
  }

  console.log(`[Pollo] Imported ${imported}/${cookies.length} cookies into Electron session`);

  // Cache the auth cookies so we can re-apply after CF navigation
  cachedAuthCookies = cookies;

  return imported > 0;
}

// =========================================================================
// BrowserWindow + Cloudflare + API helpers (same pattern as Perchance)
// =========================================================================

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

  // After CF navigation, the page sets its own cookies which may conflict
  // with our imported auth cookies. Re-apply the auth cookies to ensure
  // the correct session token is used (removing duplicates first).
  if (cachedAuthCookies) {
    const authNames = ['__Secure-next-auth.session-token', '__Secure-next-auth.callback-url', '__Host-next-auth.csrf-token'];
    const existingCookies = await ses.cookies.get({});
    for (const c of existingCookies) {
      if (c.domain && c.domain.includes('pollo.ai') && authNames.includes(c.name)) {
        const scheme = c.secure ? 'https' : 'http';
        const domain = c.domain.startsWith('.') ? c.domain.substring(1) : c.domain;
        try {
          await ses.cookies.remove(`${scheme}://${domain}${c.path}`, c.name);
        } catch {}
      }
    }
    // Re-import only the auth cookies
    for (const cookie of cachedAuthCookies) {
      if (authNames.includes(cookie.name)) {
        const cookieData = {
          url: 'https://pollo.ai',
          name: cookie.name,
          value: cookie.value,
          path: cookie.path || '/',
          secure: cookie.secure || false,
          httpOnly: cookie.httpOnly || false,
          sameSite: cookie.sameSite || 'lax',
        };
        const isHostOnly = cookie.domain && !cookie.domain.startsWith('.');
        if (cookie.name.startsWith('__Host-')) {
          cookieData.secure = true;
        } else if (isHostOnly) {
          if (cookie.name.startsWith('__Secure-')) cookieData.secure = true;
        } else {
          cookieData.domain = cookie.domain || '.pollo.ai';
          if (cookie.name.startsWith('__Secure-')) cookieData.secure = true;
        }
        try {
          await ses.cookies.set(cookieData);
        } catch (e) {
          console.log(`[Pollo] Failed to re-apply auth cookie ${cookie.name}:`, e.message);
        }
      }
    }
    console.log('[Pollo] Re-applied auth cookies after CF navigation');
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

  console.log(`[Pollo] browserFetch ${url.substring(0, 100)}...`);

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
          const res = await fetch('https://pollo.ai/api/trpc/generationModel.list?input=' + encodeURIComponent(JSON.stringify({json:{modelTypes:["Text2Image"]}})));
          if (!res.ok) return false;
          const data = await res.json();
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

// =========================================================================
// Login flow: system browser + automatic cookie extraction
// =========================================================================

/**
 * Full automated login flow:
 * 1. Opens system browser to pollo.ai/sign-in (passkeys work there)
 * 2. Returns immediately — user logs in at their own pace
 */
function openLoginInBrowser() {
  console.log('[Pollo] Opening system browser for login...');
  shell.openExternal('https://pollo.ai/sign-in');
}

/**
 * Extract session from browser and import into Electron.
 * Called after the user has logged in via their system browser.
 * Reads cookies directly from the Chromium cookie store on disk.
 */
async function extractAndImportSession() {
  console.log('[Pollo] Extracting session from browser cookie store...');

  const result = extractCookiesFromBrowser();
  if (!result) {
    return {
      success: false,
      error: 'No pollo.ai cookies found. Make sure you are logged in at pollo.ai in Chrome/Arc/Brave/Edge, then try again.',
    };
  }

  // Look for the session token specifically
  const sessionCookie = result.cookies.find(
    c => c.name === '__Secure-next-auth.session-token' || c.name === 'next-auth.session-token'
  );

  if (!sessionCookie) {
    const cookieNames = result.cookies.map(c => c.name).join(', ');
    return {
      success: false,
      error: `Found ${result.cookies.length} pollo.ai cookies in ${result.browser} (${cookieNames}) but no session token. You may not be fully logged in.`,
    };
  }

  // Import all pollo.ai cookies into Electron session
  const imported = await importCookiesToSession(result.cookies);
  if (!imported) {
    return { success: false, error: 'Failed to import cookies into Electron session.' };
  }

  return {
    success: true,
    browser: result.browser,
    cookieCount: result.cookies.length,
  };
}

// =========================================================================
// Model fetching
// =========================================================================

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

// =========================================================================
// Task polling + image extraction
// =========================================================================

/**
 * Poll for task completion via generation.queryRecordDetail.
 * The taskId is the numeric ID returned by text2Image.create.
 */
async function pollTaskCompletion(taskId, maxWait = 120000) {
  const start = Date.now();
  const pollInterval = 3000;

  console.log(`[Pollo] Polling task ${taskId} for completion...`);

  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, pollInterval));

    try {
      const input = JSON.stringify({ '0': { json: { id: taskId } } });
      const url = `${TRPC_BASE}/generation.queryRecordDetail?batch=1&input=${encodeURIComponent(input)}`;
      const result = await browserFetch(url);

      if (!result.ok) {
        console.log(`[Pollo] Poll request failed: HTTP ${result.status}`);
        continue;
      }

      const data = JSON.parse(result.body);
      const record = Array.isArray(data) ? data[0]?.result?.data?.json : data?.result?.data?.json;

      if (!record) {
        console.log('[Pollo] Poll returned no record data');
        continue;
      }

      console.log(`[Pollo] Task status: ${record.status}`);

      if (record.status === 'succeed') {
        return record;
      }

      if (record.status === 'failed') {
        throw new Error(`Pollo generation failed: ${record.failMsg || 'unknown error'} (code: ${record.failCode})`);
      }

      // Still processing (status: "waiting", "processing", etc.)
    } catch (e) {
      if (e.message.startsWith('Pollo generation failed')) throw e;
      console.log('[Pollo] Poll error:', e.message);
    }
  }

  throw new Error('Pollo generation timed out after ' + Math.round(maxWait / 1000) + 's');
}

// =========================================================================
// Module exports
// =========================================================================

module.exports = {
  id: 'pollo',
  name: 'Pollo AI',

  checkReady() {
    return !!modelsCache && modelsCache.length > 0;
  },

  getModels() {
    return modelsCache || [];
  },

  getArtStyles() {
    return [];
  },

  async fetchModelsForUI() {
    return fetchModels();
  },

  async checkLoginStatus() {
    return checkLoginStatus();
  },

  openLoginInBrowser() {
    openLoginInBrowser();
  },

  async extractAndImportSession() {
    return extractAndImportSession();
  },

  async generate(prompt, negativePrompt, store) {
    const modelName = store.get('polloModel') || 'flux-schnell';
    const aspectRatio = store.get('polloAspectRatio') || '1:1';
    const numOutputs = store.get('polloNumOutputs') || 1;

    console.log(`[Pollo] Generating with model=${modelName}, aspect=${aspectRatio}`);

    // Submit generation via text2Image.create (batched tRPC mutation)
    const mutationInput = {
      taskType: 'Text2Image',
      prompt,
      modelName,
      aspectRatio,
      numOutputs,
      entryCode: 'web',
    };

    const createResult = await browserFetch(`${TRPC_BASE}/text2Image.create?batch=1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ '0': { json: mutationInput } }),
    });

    if (!createResult.ok) {
      console.log(`[Pollo] Create failed (${createResult.status}): ${createResult.body.substring(0, 300)}`);
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

    // Batched response: [{"result":{"data":{"json":{"id":12345,"status":"waiting",...}}}}]
    if (Array.isArray(createData)) {
      createData = createData[0];
    }

    const resultJson = createData?.result?.data?.json;
    if (!resultJson) {
      throw new Error('Unexpected Pollo response structure: ' + JSON.stringify(createData).substring(0, 300));
    }

    const taskId = resultJson.id;
    if (!taskId) {
      throw new Error('No task ID in Pollo response: ' + JSON.stringify(resultJson).substring(0, 300));
    }

    console.log(`[Pollo] Task created: id=${taskId}, status=${resultJson.status}`);

    // Poll for completion via generation.queryRecordDetail
    const completedRecord = await pollTaskCompletion(taskId);

    // Extract image URL from completed record
    const imageUrl = completedRecord.mediaUrl || completedRecord.videoUrl || completedRecord.cover;
    if (!imageUrl) {
      throw new Error('No image URL in completed record: ' + JSON.stringify(completedRecord).substring(0, 300));
    }

    console.log('[Pollo] Downloading result image...');
    const base64 = await browserFetchBase64(imageUrl);

    // Detect content type from URL
    const ext = imageUrl.match(/\.(png|jpg|jpeg|webp)(\?|$)/i);
    const mimeType = ext ? (ext[1] === 'jpg' ? 'image/jpeg' : `image/${ext[1].toLowerCase()}`) : 'image/png';

    console.log('[Pollo] Image generated successfully');
    return `data:${mimeType};base64,${base64}`;
  }
};

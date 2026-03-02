// Stealth patches to make Electron look like regular Chrome.
// Used as a preload with contextIsolation:false so patches apply to page context.

// Hide webdriver flag (primary automation detection signal)
Object.defineProperty(navigator, 'webdriver', {
  get: () => undefined,
  configurable: true,
});

// Add window.chrome object (missing or partial in Electron, present in real Chrome)
if (!window.chrome) window.chrome = {};
if (!window.chrome.runtime) {
  window.chrome.runtime = {
    connect: function() {},
    sendMessage: function() {},
    onMessage: { addListener: function() {}, removeListener: function() {} },
    onConnect: { addListener: function() {}, removeListener: function() {} },
  };
}
if (!window.chrome.loadTimes) window.chrome.loadTimes = function() { return {}; };
if (!window.chrome.csi) window.chrome.csi = function() { return {}; };
if (!window.chrome.app) {
  window.chrome.app = { isInstalled: false, getDetails: function() {}, getIsInstalled: function() {}, installState: function() {} };
}

// Detect platform from navigator (before patching)
const platformMap = {
  'MacIntel': 'macOS',
  'Win32': 'Windows',
  'Linux x86_64': 'Linux',
  'Linux aarch64': 'Linux',
};
const detectedPlatform = platformMap[navigator.platform] || 'macOS';

// NavigatorUAData API (Chrome 90+, missing in Electron)
if (!navigator.userAgentData) {
  Object.defineProperty(navigator, 'userAgentData', {
    get: () => ({
      brands: [
        { brand: 'Google Chrome', version: '120' },
        { brand: 'Chromium', version: '120' },
        { brand: 'Not_A Brand', version: '24' },
      ],
      mobile: false,
      platform: detectedPlatform,
      getHighEntropyValues: function(hints) {
        return Promise.resolve({
          brands: this.brands,
          mobile: false,
          platform: detectedPlatform,
          platformVersion: '15.0.0',
          architecture: 'arm',
          bitness: '64',
          model: '',
          uaFullVersion: '120.0.0.0',
          fullVersionList: this.brands,
        });
      },
      toJSON: function() {
        return { brands: this.brands, mobile: false, platform: detectedPlatform };
      },
    }),
    configurable: true,
  });
}

// Make navigator.plugins non-empty (Electron has empty plugins array)
Object.defineProperty(navigator, 'plugins', {
  get: () => {
    const arr = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 1 },
    ];
    arr.item = (i) => arr[i] || null;
    arr.namedItem = (n) => arr.find(p => p.name === n) || null;
    arr.refresh = () => {};
    return arr;
  },
  configurable: true,
});

// Make navigator.mimeTypes non-empty
Object.defineProperty(navigator, 'mimeTypes', {
  get: () => {
    const arr = [
      { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: { name: 'Chrome PDF Plugin' } },
    ];
    arr.item = (i) => arr[i] || null;
    arr.namedItem = (n) => arr.find(m => m.type === n) || null;
    return arr;
  },
  configurable: true,
});

// Realistic languages
Object.defineProperty(navigator, 'languages', {
  get: () => ['en-US', 'en'],
  configurable: true,
});

// Override permissions query to avoid "notification denied" fingerprint
const originalQuery = window.navigator.permissions?.query?.bind(navigator.permissions);
if (originalQuery) {
  navigator.permissions.query = (params) => {
    if (params.name === 'notifications') {
      return Promise.resolve({ state: 'prompt', onchange: null });
    }
    return originalQuery(params);
  };
}

// Patch toString on patched functions to return native code string
const origToString = Function.prototype.toString;
const patchedFns = new Set();
function patchToString(fn) {
  patchedFns.add(fn);
}

Function.prototype.toString = function() {
  if (patchedFns.has(this)) {
    return 'function ' + (this.name || '') + '() { [native code] }';
  }
  return origToString.call(this);
};

// Patch key functions
if (window.chrome && window.chrome.runtime) {
  if (typeof window.chrome.runtime.connect === 'function') patchToString(window.chrome.runtime.connect);
  if (typeof window.chrome.runtime.sendMessage === 'function') patchToString(window.chrome.runtime.sendMessage);
}

// Remove Electron/Node.js traces from window
delete window.process;
delete window.require;
delete window.module;
delete window.exports;
delete window.Buffer;
delete window.global;

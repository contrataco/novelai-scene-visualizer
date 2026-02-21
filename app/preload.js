const { contextBridge, ipcRenderer } = require('electron');

// Expose secure API to renderer
contextBridge.exposeInMainWorld('sceneVisualizer', {
  // Image generation
  generateImage: (prompt, negativePrompt) =>
    ipcRenderer.invoke('generate-image', { prompt, negativePrompt }),

  // Settings
  getApiToken: () => ipcRenderer.invoke('get-api-token'),
  setApiToken: (token) => ipcRenderer.invoke('set-api-token', token),
  getImageSettings: () => ipcRenderer.invoke('get-image-settings'),
  setImageSettings: (settings) => ipcRenderer.invoke('set-image-settings', settings),
  getModels: () => ipcRenderer.invoke('get-models'),

  // Provider management
  getProvider: () => ipcRenderer.invoke('get-provider'),
  setProvider: (providerId) => ipcRenderer.invoke('set-provider', providerId),
  getProviders: () => ipcRenderer.invoke('get-providers'),

  // NovelAI art styles
  getNovelaiArtStyles: () => ipcRenderer.invoke('get-novelai-art-styles'),
  getNovelaiArtStyle: () => ipcRenderer.invoke('get-novelai-art-style'),
  setNovelaiArtStyle: (styleId) => ipcRenderer.invoke('set-novelai-art-style', styleId),

  // Perchance
  extractPerchanceKey: () => ipcRenderer.invoke('extract-perchance-key'),
  setPerchanceKey: (key) => ipcRenderer.invoke('set-perchance-key', key),
  getPerchanceKeyStatus: () => ipcRenderer.invoke('get-perchance-key-status'),
  getPerchanceArtStyles: () => ipcRenderer.invoke('get-perchance-art-styles'),
  getPerchanceSettings: () => ipcRenderer.invoke('get-perchance-settings'),
  setPerchanceSettings: (settings) => ipcRenderer.invoke('set-perchance-settings', settings),

  // Venice AI
  getVeniceSettings: () => ipcRenderer.invoke('get-venice-settings'),
  setVeniceSettings: (settings) => ipcRenderer.invoke('set-venice-settings', settings),
  setVeniceApiKey: (key) => ipcRenderer.invoke('set-venice-api-key', key),
  getVeniceApiKeyStatus: () => ipcRenderer.invoke('get-venice-api-key-status'),
  getVeniceModels: () => ipcRenderer.invoke('get-venice-models'),
  getVeniceStyles: () => ipcRenderer.invoke('get-venice-styles'),

  // Pollo AI
  getPolloSettings: () => ipcRenderer.invoke('get-pollo-settings'),
  setPolloSettings: (settings) => ipcRenderer.invoke('set-pollo-settings', settings),
  getPolloModels: () => ipcRenderer.invoke('get-pollo-models'),
  getPolloLoginStatus: () => ipcRenderer.invoke('get-pollo-login-status'),
  polloLogin: () => ipcRenderer.invoke('pollo-login'),

  // Token status
  getTokenStatus: () => ipcRenderer.invoke('get-token-status'),

  // Cache management
  clearWebviewCache: () => ipcRenderer.invoke('clear-webview-cache'),

  // NovelAI credentials
  getNovelaiCredentials: () => ipcRenderer.invoke('get-novelai-credentials'),
  setNovelaiCredentials: (creds) => ipcRenderer.invoke('set-novelai-credentials', creds),

  // Storyboard
  storyboardList: () => ipcRenderer.invoke('storyboard:list'),
  storyboardCreate: (name) => ipcRenderer.invoke('storyboard:create', name),
  storyboardDelete: (id) => ipcRenderer.invoke('storyboard:delete', id),
  storyboardRename: (id, name) => ipcRenderer.invoke('storyboard:rename', { id, name }),
  storyboardSetActive: (id) => ipcRenderer.invoke('storyboard:set-active', id),
  storyboardGetScenes: (id) => ipcRenderer.invoke('storyboard:get-scenes', id),
  storyboardCommitScene: (storyboardId, sceneData) => ipcRenderer.invoke('storyboard:commit-scene', { storyboardId, sceneData }),
  storyboardDeleteScene: (storyboardId, sceneId) => ipcRenderer.invoke('storyboard:delete-scene', { storyboardId, sceneId }),
  storyboardReorderScenes: (storyboardId, sceneIds) => ipcRenderer.invoke('storyboard:reorder-scenes', { storyboardId, sceneIds }),
  storyboardUpdateSceneNote: (storyboardId, sceneId, note) => ipcRenderer.invoke('storyboard:update-scene-note', { storyboardId, sceneId, note }),
  storyboardGetSceneImage: (storyboardId, sceneId) => ipcRenderer.invoke('storyboard:get-scene-image', { storyboardId, sceneId }),

  // Event listeners
  onPromptUpdate: (callback) => {
    ipcRenderer.on('prompt-update', (event, data) => callback(data));
  },
  onTokenStatusChanged: (callback) => {
    ipcRenderer.on('token-status-changed', (event, data) => callback(data));
  },
  onImageReady: (callback) => {
    ipcRenderer.on('image-ready', (event, data) => callback(data));
  },
  onSuggestionsUpdate: (callback) => {
    ipcRenderer.on('suggestions-update', (event, data) => callback(data));
  },
});

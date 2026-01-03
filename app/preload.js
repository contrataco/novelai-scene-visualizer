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

  // Event listeners for receiving images
  onImageReady: (callback) => {
    ipcRenderer.on('image-ready', (event, data) => callback(data));
  }
});

// DOM Observer for NovelAI script communication
// This runs after the page loads and watches for prompt data from the NovelAI script
window.addEventListener('DOMContentLoaded', () => {
  console.log('[Preload] DOM Content Loaded');

  // Create a hidden element for communication with NovelAI script
  const bridge = document.createElement('div');
  bridge.id = 'scene-visualizer-bridge';
  bridge.style.display = 'none';
  bridge.dataset.prompt = '';
  bridge.dataset.status = 'ready';
  bridge.dataset.image = '';
  document.body.appendChild(bridge);

  // Watch for prompt changes from NovelAI script
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.attributeName === 'data-prompt') {
        const prompt = bridge.dataset.prompt;
        if (prompt && bridge.dataset.status === 'pending') {
          console.log('[Preload] Detected new prompt:', prompt.substring(0, 50) + '...');
          handlePromptRequest(prompt);
        }
      }
    }
  });

  observer.observe(bridge, {
    attributes: true,
    attributeFilter: ['data-prompt']
  });

  async function handlePromptRequest(prompt) {
    bridge.dataset.status = 'generating';

    try {
      // Parse prompt if it's JSON (may include negative prompt)
      let positivePrompt = prompt;
      let negativePrompt = '';

      try {
        const parsed = JSON.parse(prompt);
        positivePrompt = parsed.prompt || prompt;
        negativePrompt = parsed.negativePrompt || '';
      } catch (e) {
        // Not JSON, use as-is
      }

      const result = await ipcRenderer.invoke('generate-image', {
        prompt: positivePrompt,
        negativePrompt
      });

      if (result.success) {
        bridge.dataset.image = result.imageData;
        bridge.dataset.status = 'ready';
        console.log('[Preload] Image ready, injected into bridge');
      } else {
        bridge.dataset.error = result.error;
        bridge.dataset.status = 'error';
        console.error('[Preload] Image generation failed:', result.error);
      }
    } catch (error) {
      bridge.dataset.error = error.message;
      bridge.dataset.status = 'error';
      console.error('[Preload] Error:', error);
    }
  }
});

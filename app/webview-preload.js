/**
 * Webview Preload Script
 * This runs in the context of the NovelAI page and creates
 * a bridge for communication between the NovelAI user script
 * and the Electron main process.
 */

const { ipcRenderer } = require('electron');

// Wait for DOM to be ready
window.addEventListener('DOMContentLoaded', () => {
  console.log('[WebviewPreload] Initializing Scene Visualizer bridge...');

  // Create bridge element for communication with NovelAI scripts
  const bridge = document.createElement('div');
  bridge.id = 'scene-visualizer-bridge';
  bridge.style.cssText = 'display:none !important; position:absolute; pointer-events:none;';
  bridge.dataset.prompt = '';
  bridge.dataset.status = 'ready';
  bridge.dataset.image = '';
  bridge.dataset.error = '';
  document.body.appendChild(bridge);

  console.log('[WebviewPreload] Bridge element created');

  // Watch for prompt changes from NovelAI script
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        const attrName = mutation.attributeName;

        if (attrName === 'data-prompt' && bridge.dataset.status === 'pending') {
          const promptData = bridge.dataset.prompt;
          if (promptData) {
            console.log('[WebviewPreload] Detected prompt request');
            handlePromptRequest(promptData);
          }
        }
      }
    }
  });

  observer.observe(bridge, {
    attributes: true,
    attributeFilter: ['data-prompt', 'data-status']
  });

  async function handlePromptRequest(promptData) {
    bridge.dataset.status = 'generating';
    bridge.dataset.error = '';

    try {
      // Parse prompt data (may be JSON with prompt + negativePrompt)
      let prompt, negativePrompt = '';

      try {
        const parsed = JSON.parse(promptData);
        prompt = parsed.prompt;
        negativePrompt = parsed.negativePrompt || '';
      } catch (e) {
        // Plain string prompt
        prompt = promptData;
      }

      console.log('[WebviewPreload] Requesting image generation...');

      // Send to main process via IPC
      const result = await ipcRenderer.invoke('generate-image', {
        prompt,
        negativePrompt
      });

      if (result.success) {
        console.log('[WebviewPreload] Image generated successfully');
        bridge.dataset.image = result.imageData;
        bridge.dataset.status = 'ready';

        // Dispatch custom event for NovelAI script to detect
        bridge.dispatchEvent(new CustomEvent('image-ready', {
          detail: { imageData: result.imageData }
        }));
      } else {
        console.error('[WebviewPreload] Generation failed:', result.error);
        bridge.dataset.error = result.error;
        bridge.dataset.status = 'error';

        bridge.dispatchEvent(new CustomEvent('image-error', {
          detail: { error: result.error }
        }));
      }
    } catch (error) {
      console.error('[WebviewPreload] Error:', error);
      bridge.dataset.error = error.message;
      bridge.dataset.status = 'error';

      bridge.dispatchEvent(new CustomEvent('image-error', {
        detail: { error: error.message }
      }));
    }
  }

  // Expose a simple API to window for NovelAI scripts to use
  // Note: NovelAI scripts run in a Web Worker and can't access window directly,
  // but they CAN manipulate the DOM through their UI components
  window.__sceneVisualizerBridge = {
    requestImage: (prompt, negativePrompt = '') => {
      const data = JSON.stringify({ prompt, negativePrompt });
      bridge.dataset.prompt = data;
      bridge.dataset.status = 'pending';
      // Trigger mutation by toggling an attribute
      bridge.setAttribute('data-request-id', Date.now().toString());
    },
    getStatus: () => bridge.dataset.status,
    getImage: () => bridge.dataset.image,
    getError: () => bridge.dataset.error
  };

  console.log('[WebviewPreload] Scene Visualizer bridge ready');
});

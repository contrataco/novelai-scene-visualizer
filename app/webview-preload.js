/**
 * Webview Preload Script
 * Runs inside the NovelAI webview. Exposes a bridge API via contextBridge
 * so the companion script can send prompts directly to the Electron app.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__sceneVisualizerBridge', {
  // Send prompt to sidebar (no image generation)
  updatePrompt: (prompt, negativePrompt, storyExcerpt, storyId, storyTitle) => {
    console.log('[WebviewPreload] Sending prompt update via IPC');
    ipcRenderer.send('prompt-from-webview', {
      prompt,
      negativePrompt: negativePrompt || '',
      storyExcerpt: storyExcerpt || '',
      storyId: storyId || null,
      storyTitle: storyTitle || null,
    });
  },

  // Send prompt and request auto-generation
  requestImage: (prompt, negativePrompt, storyExcerpt, storyId, storyTitle) => {
    console.log('[WebviewPreload] Requesting image generation via IPC');
    ipcRenderer.send('prompt-from-webview', {
      prompt,
      negativePrompt: negativePrompt || '',
      storyExcerpt: storyExcerpt || '',
      autoGenerate: true,
      storyId: storyId || null,
      storyTitle: storyTitle || null,
    });
  },

  // Send story context update
  updateStoryContext: (storyId, storyTitle) => {
    console.log('[WebviewPreload] Sending story context via IPC:', storyId, storyTitle);
    ipcRenderer.send('story-context-from-webview', { storyId, storyTitle: storyTitle || '' });
  },

  // Send story suggestions to sidebar
  updateSuggestions: (data) => {
    console.log('[WebviewPreload] Sending suggestions update via IPC');
    ipcRenderer.send('suggestions-from-webview', data);
  },

  isConnected: () => true,
});

console.log('[WebviewPreload] Scene Visualizer bridge ready (IPC mode)');

// Auto-login: detect login page and fill credentials
async function attemptAutoLogin() {
  // Get credentials from main process
  const creds = await ipcRenderer.invoke('get-novelai-credentials');
  if (!creds.hasCredentials) {
    console.log('[WebviewPreload] No stored credentials, skipping auto-login');
    return;
  }
  console.log('[WebviewPreload] Credentials found, watching for login form...');

  // Wait for a login form to appear (NovelAI is an SPA — form may appear late)
  const waitForForm = (maxWait = 15000) => new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      // Try multiple selectors — NovelAI may use type="email", type="text", or no type
      const inputs = document.querySelectorAll('input');
      let emailInput = null;
      let passwordInput = null;

      for (const input of inputs) {
        const type = (input.type || '').toLowerCase();
        const placeholder = (input.placeholder || '').toLowerCase();
        const name = (input.name || '').toLowerCase();
        const autocomplete = (input.autocomplete || '').toLowerCase();

        if (type === 'password') {
          passwordInput = input;
        } else if (
          type === 'email' ||
          placeholder.includes('email') || placeholder.includes('mail') ||
          name.includes('email') || name.includes('mail') ||
          autocomplete === 'email' || autocomplete === 'username'
        ) {
          emailInput = input;
        }
      }

      if (emailInput && passwordInput) return resolve({ emailInput, passwordInput });
      if (Date.now() - start > maxWait) return resolve(null);
      setTimeout(check, 500);
    };
    check();
  });

  const form = await waitForForm();
  if (!form) {
    console.log('[WebviewPreload] No login form found within timeout — may already be logged in');
    return;
  }

  console.log('[WebviewPreload] Login form detected, auto-filling credentials');

  // Set values using native input setter to trigger React's change detection
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  ).set;

  nativeInputValueSetter.call(form.emailInput, creds.email);
  form.emailInput.dispatchEvent(new Event('input', { bubbles: true }));
  form.emailInput.dispatchEvent(new Event('change', { bubbles: true }));

  nativeInputValueSetter.call(form.passwordInput, creds.password);
  form.passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
  form.passwordInput.dispatchEvent(new Event('change', { bubbles: true }));

  // Wait briefly for React state to update, then click the login button
  setTimeout(() => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.textContent.trim().toLowerCase();
      if (text === 'login' || text === 'log in' || text === 'sign in' || text === 'submit') {
        console.log('[WebviewPreload] Clicking login button:', btn.textContent.trim());
        btn.click();
        return;
      }
    }
    // Fallback: look for a submit-type button or form submission
    const submitBtn = document.querySelector('button[type="submit"], input[type="submit"]');
    if (submitBtn) {
      console.log('[WebviewPreload] Clicking submit button (fallback)');
      submitBtn.click();
      return;
    }
    console.log('[WebviewPreload] Could not find login button');
  }, 500);
}

window.addEventListener('DOMContentLoaded', () => {
  // Check if this is the login page
  if (window.location.href.includes('novelai.net')) {
    // Small delay to let the page render
    setTimeout(attemptAutoLogin, 1500);
  }
});

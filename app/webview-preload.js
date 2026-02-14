/**
 * Webview Preload Script
 * Runs inside the NovelAI webview. Exposes a bridge API via contextBridge
 * so the companion script can send prompts directly to the Electron app.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__sceneVisualizerBridge', {
  // Send prompt to sidebar (no image generation)
  updatePrompt: (prompt, negativePrompt, storyExcerpt) => {
    console.log('[WebviewPreload] Sending prompt update via IPC');
    ipcRenderer.send('prompt-from-webview', { prompt, negativePrompt: negativePrompt || '', storyExcerpt: storyExcerpt || '' });
  },

  // Send prompt and request auto-generation
  requestImage: (prompt, negativePrompt, storyExcerpt) => {
    console.log('[WebviewPreload] Requesting image generation via IPC');
    ipcRenderer.send('prompt-from-webview', {
      prompt,
      negativePrompt: negativePrompt || '',
      storyExcerpt: storyExcerpt || '',
      autoGenerate: true,
    });
  },

  // Send story suggestions to sidebar
  updateSuggestions: (data) => {
    console.log('[WebviewPreload] Sending suggestions update via IPC');
    ipcRenderer.send('suggestions-from-webview', data);
  },

  isConnected: () => true,
});

console.log('[WebviewPreload] Scene Visualizer bridge ready (IPC mode)');

// ========================================================================
// SUGGESTION INSERTION — receives IPC from renderer, inserts into ProseMirror
// ========================================================================
ipcRenderer.on('insert-suggestion', (_event, data) => {
  const text = data && data.text;
  if (!text) {
    ipcRenderer.sendToHost('suggestion-inserted', { success: false, error: 'No text provided' });
    return;
  }

  console.log('[WebviewPreload] Received insert-suggestion request, text length:', text.length);

  function findEditor() {
    return document.querySelector('.ProseMirror[contenteditable="true"]');
  }

  function moveCursorToEnd(el) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Strategy 1: Synthetic ClipboardEvent paste (most reliable for ProseMirror)
  function tryPaste() {
    const editor = findEditor();
    if (!editor) return false;

    try {
      editor.focus();
      moveCursorToEnd(editor);

      const dt = new DataTransfer();
      dt.setData('text/plain', text);

      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      // Chromium workaround: clipboardData is read-only on the event, so override it
      Object.defineProperty(pasteEvent, 'clipboardData', { value: dt });

      const dispatched = editor.dispatchEvent(pasteEvent);
      // If ProseMirror handled it, it calls preventDefault() — so dispatched === false means success
      console.log('[WebviewPreload] Paste strategy dispatched, default prevented:', !dispatched);
      return !dispatched;
    } catch (e) {
      console.warn('[WebviewPreload] Paste strategy error:', e);
      return false;
    }
  }

  // Strategy 2: InputEvent beforeinput (modern ProseMirror v1.33+)
  function tryBeforeInput() {
    const editor = findEditor();
    if (!editor) return false;

    try {
      editor.focus();
      moveCursorToEnd(editor);

      const beforeInputEvent = new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: text,
        bubbles: true,
        cancelable: true,
        composed: true,
      });

      const dispatched = editor.dispatchEvent(beforeInputEvent);
      if (!dispatched) {
        // ProseMirror handled it
        editor.dispatchEvent(new InputEvent('input', {
          inputType: 'insertText',
          data: text,
          bubbles: true,
        }));
        console.log('[WebviewPreload] beforeinput strategy succeeded');
        return true;
      }
      return false;
    } catch (e) {
      console.warn('[WebviewPreload] beforeinput strategy error:', e);
      return false;
    }
  }

  // Strategy 3: Real clipboard write + execCommand paste (last resort — overwrites clipboard)
  function tryClipboardPaste() {
    const editor = findEditor();
    if (!editor) return false;

    try {
      // Write text to system clipboard via a temporary textarea
      const tmp = document.createElement('textarea');
      tmp.value = text;
      tmp.style.position = 'fixed';
      tmp.style.left = '-9999px';
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand('copy');
      document.body.removeChild(tmp);

      // Now focus editor and paste
      editor.focus();
      moveCursorToEnd(editor);
      const ok = document.execCommand('paste');
      console.log('[WebviewPreload] clipboard-paste strategy result:', ok);
      return ok;
    } catch (e) {
      console.warn('[WebviewPreload] clipboard-paste strategy error:', e);
      return false;
    }
  }

  // Try strategies in order
  const strategies = [
    { fn: tryPaste, name: 'paste-event' },
    { fn: tryBeforeInput, name: 'beforeinput' },
    { fn: tryClipboardPaste, name: 'clipboard-paste' },
  ];

  let result = { success: false, error: 'No suitable editor found' };

  for (const strategy of strategies) {
    try {
      if (strategy.fn()) {
        result = { success: true, method: strategy.name };
        console.log('[WebviewPreload] Insertion succeeded via:', strategy.name);
        break;
      }
    } catch (e) {
      console.warn(`[WebviewPreload] Strategy ${strategy.name} threw:`, e);
    }
  }

  if (!result.success && findEditor()) {
    result.error = 'Editor found but all insertion strategies failed';
  }

  ipcRenderer.sendToHost('suggestion-inserted', result);
});

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

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

  // Strategy 1: ProseMirror EditorView transaction (most reliable)
  // ProseMirror stores a ViewDesc on its DOM elements, giving direct access to the view.
  function tryProseMirrorTransaction() {
    const editor = findEditor();
    if (!editor) return false;

    try {
      const view = editor.pmViewDesc && editor.pmViewDesc.view;
      if (!view || !view.state) {
        console.log('[WebviewPreload] pmViewDesc not found on editor element');
        return false;
      }

      editor.focus();
      const { state } = view;
      // Insert text at end of document (before the closing node token)
      const insertPos = state.doc.content.size - 1;
      const tr = state.tr.insertText('\n' + text, insertPos);
      view.dispatch(tr);
      console.log('[WebviewPreload] ProseMirror transaction dispatched successfully');
      return true;
    } catch (e) {
      console.warn('[WebviewPreload] ProseMirror transaction error:', e);
      return false;
    }
  }

  // Strategy 2: Synthetic paste with textContent verification
  function tryPaste() {
    const editor = findEditor();
    if (!editor) return false;

    try {
      editor.focus();
      moveCursorToEnd(editor);

      const before = editor.textContent;

      const dt = new DataTransfer();
      dt.setData('text/plain', text);

      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      Object.defineProperty(pasteEvent, 'clipboardData', { value: dt });
      editor.dispatchEvent(pasteEvent);

      // Verify text was actually inserted by checking content change
      const after = editor.textContent;
      const success = after.length > before.length;
      console.log('[WebviewPreload] Paste strategy — content changed:', success,
        '(before:', before.length, 'after:', after.length, ')');
      return success;
    } catch (e) {
      console.warn('[WebviewPreload] Paste strategy error:', e);
      return false;
    }
  }

  // Strategy 3: execCommand insertText with textContent verification (last resort)
  function tryExecCommand() {
    const editor = findEditor();
    if (!editor) return false;

    try {
      editor.focus();
      moveCursorToEnd(editor);

      const before = editor.textContent;
      document.execCommand('insertText', false, text);

      const after = editor.textContent;
      const success = after.length > before.length;
      console.log('[WebviewPreload] execCommand insertText — content changed:', success,
        '(before:', before.length, 'after:', after.length, ')');
      return success;
    } catch (e) {
      console.warn('[WebviewPreload] execCommand insertText error:', e);
      return false;
    }
  }

  // Try strategies in order
  const strategies = [
    { fn: tryProseMirrorTransaction, name: 'prosemirror-transaction' },
    { fn: tryPaste, name: 'paste-event' },
    { fn: tryExecCommand, name: 'execCommand-insertText' },
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

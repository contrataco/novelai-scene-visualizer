/**
 * Webview Preload Script
 * Runs inside the NovelAI webview. Handles auto-login, fetch interceptors,
 * and suggestion insertion via IPC.
 */

const { ipcRenderer } = require('electron');

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
  // Inject TTS V1 fetch interceptor into the page context.
  // The naiscript runtime hardcodes version:"v2" for TTS requests,
  // ignoring the user's ttsModel setting. This patches fetch in the
  // main world to fix that by rewriting v2 → v1 on generate-voice calls.
  const ttsInterceptScript = document.createElement('script');
  ttsInterceptScript.textContent = `
    (function() {
      const _origFetch = window.fetch;
      window.fetch = function(url, options) {
        if (typeof url === 'string' && url.includes('/ai/generate-voice') && options && options.body) {
          try {
            const body = JSON.parse(options.body);
            if (body.version === 'v2') {
              body.version = 'v1';
              options = Object.assign({}, options, { body: JSON.stringify(body) });
              console.log('[TTS-V1-Patch] Rewrote generate-voice version: v2 → v1');
            }
          } catch(e) {}
        }
        return _origFetch.call(this, url, options);
      };
      console.log('[TTS-V1-Patch] Fetch interceptor installed');
    })();
  `;
  document.documentElement.appendChild(ttsInterceptScript);
  ttsInterceptScript.remove();

  // Inject fetch interceptor for NovelAI API discovery + state capture.
  // Logs all api.novelai.net calls and captures response structure for
  // storycontent endpoints to help discover the data format.
  const apiInterceptScript = document.createElement('script');
  apiInterceptScript.textContent = `
    (function() {
      window.__naiApiLog = [];
      var _origFetch = window.fetch;
      window.fetch = function(url, options) {
        if (typeof url === 'string' && url.includes('api.novelai.net')) {
          var method = (options && options.method) || 'GET';
          var shortUrl = url.replace('https://api.novelai.net', '');
          console.log('[NAI-API]', method, shortUrl);
          if (options && options.body) {
            try {
              var body = JSON.parse(options.body);
              console.log('[NAI-API] Body keys:', Object.keys(body));
            } catch(e) {}
          }
          return _origFetch.call(this, url, options).then(function(res) {
            var entry = { method: method, url: shortUrl, status: res.status, time: Date.now() };
            // Capture response structure for storycontent/stories endpoints
            if (shortUrl.includes('storycontent') || shortUrl.includes('/user/objects/stories')) {
              try {
                var cloned = res.clone();
                cloned.text().then(function(text) {
                  entry.bodyLength = text.length;
                  try {
                    var json = JSON.parse(text);
                    entry.bodyKeys = Object.keys(json);
                    if (json.objects) entry.objectCount = json.objects.length;
                  } catch(e) {}
                }).catch(function() {});
              } catch(e) {}
            }
            window.__naiApiLog.push(entry);
            console.log('[NAI-API] Response:', res.status, shortUrl);
            return res;
          });
        }
        return _origFetch.call(this, url, options);
      };
      console.log('[NAI-API] Fetch interceptor installed');
    })();
  `;
  document.documentElement.appendChild(apiInterceptScript);
  apiInterceptScript.remove();

  // Check if this is the login page
  if (window.location.href.includes('novelai.net')) {
    // Small delay to let the page render
    setTimeout(attemptAutoLogin, 1500);
  }

});

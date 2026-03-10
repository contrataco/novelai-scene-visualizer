// image-gen.js — Image generation flow, prompt handling, provider config loading, Venice balance + video

import { state, bus } from './state.js';
import {
  status, imagePanel, imageContainer, loadingIndicator,
  promptDisplay, negativePromptDisplay, generateBtn, sidebarGenerateBtn, autoGenerateToggle,
  commitBtn, novelaiArtStyleSelect,
  veniceBalance, veniceBalanceText,
} from './dom-refs.js';
import { showToast } from './utils.js';
import { loreCall } from './lore-creator.js';
import { readStoryTextFromDOM } from './webview-polling.js';
import { generateSuggestionsFromEditor } from './suggestions.js';

const promptEditedIndicator = document.getElementById('promptEditedIndicator');
const negPromptEditedIndicator = document.getElementById('negPromptEditedIndicator');
let promptWasEdited = false;
let negPromptWasEdited = false;

const LOW_BALANCE_THRESHOLD = 1.00;
const CRITICAL_BALANCE_THRESHOLD = 0.25;

// ---------------------------------------------------------------------------
// Venice balance display
// ---------------------------------------------------------------------------

function updateVeniceBalanceDisplay(balance) {
  if (!veniceBalance || !veniceBalanceText || !balance || balance.usd === null) return;
  const usd = balance.usd;
  veniceBalanceText.textContent = `$${usd.toFixed(2)}`;
  veniceBalance.classList.remove('low', 'critical');
  if (usd < CRITICAL_BALANCE_THRESHOLD) {
    veniceBalance.classList.add('critical');
  } else if (usd < LOW_BALANCE_THRESHOLD) {
    veniceBalance.classList.add('low');
  }
}

async function refreshVeniceBalanceVisibility() {
  try {
    const provider = await window.sceneVisualizer.getProvider();
    if (provider === 'venice' && veniceBalance) {
      veniceBalance.style.display = '';
      const balance = await window.sceneVisualizer.veniceGetBalance();
      if (balance) updateVeniceBalanceDisplay(balance);
    } else if (veniceBalance) {
      veniceBalance.style.display = 'none';
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Video generation
// ---------------------------------------------------------------------------

let videoPollingTimer = null;

async function handleGenerateVideo() {
  if (!state.currentImageData || !state.currentPrompt) return;

  const videoBtn = document.getElementById('sceneVideoBtn');
  if (!videoBtn) return;

  try {
    // Get quote first
    videoBtn.disabled = true;
    videoBtn.textContent = 'Quoting...';

    const quote = await window.sceneVisualizer.veniceQuoteVideo(state.currentPrompt);
    const cost = quote.quote;

    // Confirm with user
    const proceed = confirm(`Video will cost ~$${cost.toFixed(3)}. Generate?`);
    if (!proceed) {
      videoBtn.disabled = false;
      videoBtn.innerHTML = '&#9654; Video';
      return;
    }

    // Queue video
    videoBtn.textContent = 'Queuing...';
    videoBtn.classList.add('generating');

    const queueResult = await window.sceneVisualizer.veniceQueueVideo(
      state.currentPrompt, null,
      { negative_prompt: state.currentNegativePrompt || '' }
    );

    const queueId = queueResult.queue_id;
    const model = queueResult.model;

    // Show progress
    videoBtn.textContent = 'Processing...';
    let progressEl = document.getElementById('videoProgress');
    if (!progressEl) {
      progressEl = document.createElement('div');
      progressEl.id = 'videoProgress';
      progressEl.className = 'video-progress';
      videoBtn.parentNode.insertBefore(progressEl, videoBtn.nextSibling);
    }
    progressEl.innerHTML = '<div class="spinner"></div> <span>Generating video...</span>';

    // Poll for completion — resilient to DOM changes (image regeneration, tab switches)
    const videoPrompt = state.currentPrompt;
    const videoNegativePrompt = state.currentNegativePrompt;
    const pollStartTime = Date.now();
    const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max
    let pollCount = 0;

    const cleanupPoll = (errorMsg) => {
      clearInterval(videoPollingTimer);
      videoPollingTimer = null;
      const btn = document.getElementById('sceneVideoBtn');
      if (btn) { btn.disabled = false; btn.innerHTML = '&#9654; Video'; btn.classList.remove('generating'); }
      const prog = document.getElementById('videoProgress');
      if (prog) prog.innerHTML = '';
      if (errorMsg) showToast(errorMsg, 5000, 'error');
    };

    const pollVideo = async () => {
      pollCount++;
      try {
        // Timeout guard
        if (Date.now() - pollStartTime > POLL_TIMEOUT_MS) {
          console.error('[Video] Polling timed out after 5 minutes');
          cleanupPoll('Video generation timed out. The video may still be processing on Venice — check your Venice dashboard.');
          return;
        }

        const result = await window.sceneVisualizer.veniceRetrieveVideo(queueId, model);
        console.log(`[Video] Poll #${pollCount}: status=${result.status}`);

        if (result.status === 'completed') {
          clearInterval(videoPollingTimer);
          videoPollingTimer = null;

          // DOM elements may have been destroyed by image regeneration — re-query
          const btn = document.getElementById('sceneVideoBtn');
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = '&#9654; Video';
            btn.classList.remove('generating');
          }

          const prog = document.getElementById('videoProgress');
          if (prog) {
            prog.innerHTML = `<video controls autoplay muted style="width:100%;border-radius:8px;margin-top:4px;">
              <source src="${result.videoDataUrl}" type="video/mp4">
            </video>
            <a href="${result.videoDataUrl}" download="scene-video.mp4" style="font-size:11px;color:var(--accent);margin-top:4px;display:inline-block;">Download</a>`;
          }
          showToast('Video generated!', 3000);
          bus.emit('video:generated', {
            videoDataUrl: result.videoDataUrl,
            meta: { provider: 'venice', model, prompt: videoPrompt, negativePrompt: videoNegativePrompt }
          });
        } else {
          // Still processing — update ETA if element still exists
          const eta = result.averageExecutionTime ? Math.max(0, Math.round((result.averageExecutionTime - (result.executionDuration || 0)) / 1000)) : '?';
          const elapsed = Math.round((Date.now() - pollStartTime) / 1000);
          const prog = document.getElementById('videoProgress');
          const span = prog && prog.querySelector('span');
          if (span) span.textContent = `Generating video... (~${eta}s remaining, ${elapsed}s elapsed)`;
        }
      } catch (e) {
        console.error('[Video] Poll error:', e.message);
        cleanupPoll('Video generation failed: ' + e.message);
      }
    };

    videoPollingTimer = setInterval(pollVideo, 5000);
    // Initial check after 3s
    setTimeout(pollVideo, 3000);
  } catch (e) {
    videoBtn.disabled = false;
    videoBtn.innerHTML = '&#9654; Video';
    videoBtn.classList.remove('generating');
    showToast('Video error: ' + e.message, 4000, 'error');
  }
}

function appendVideoButton() {
  // Only show for Venice provider
  const provider = state.currentGenerationMeta?.provider;
  if (provider !== 'venice') return;

  const existing = document.getElementById('sceneVideoBtn');
  if (existing) existing.remove();

  const btn = document.createElement('button');
  btn.id = 'sceneVideoBtn';
  btn.className = 'scene-video-btn';
  btn.title = 'Generate scene video from this image';
  btn.innerHTML = '&#9654; Video';
  btn.addEventListener('click', handleGenerateVideo);
  imageContainer.appendChild(btn);
}

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

export async function generateImage(prompt, negativePrompt, opts = {}) {
  state.isGenerating = true;
  generateBtn.disabled = true;
  status.textContent = 'Generating...';
  status.className = 'status generating';
  loadingIndicator.style.display = 'flex';

  const startTime = Date.now();
  const timerInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    status.textContent = `Generating... (${elapsed}s)`;
  }, 1000);

  try {
    const result = await window.sceneVisualizer.generateImage(
      prompt, negativePrompt || state.currentNegativePrompt || '',
      {
        ...(opts.rawPrompt ? { rawPrompt: true } : {}),
        ...(opts.rawNegativePrompt ? { rawNegativePrompt: true } : {}),
        storyId: state.currentStoryId,
      }
    );

    if (result.success) {
      state.currentImageData = result.imageData;
      state.currentGenerationMeta = result.meta || null;
      imageContainer.innerHTML = `<img src="${result.imageData}" class="scene-image" alt="Generated scene">`;
      commitBtn.disabled = false;
      status.textContent = 'Image ready';
      status.className = 'status connected';

      // Notify user about retry/fallback
      if (result.meta?.fallbackModel) {
        showToast(`Generated with fallback model: ${result.meta.fallbackModel}`, 4000, 'warn');
      } else if (result.meta?.retried) {
        showToast('Image generated after retry', 2500);
      }

      // Append video button (Venice only)
      appendVideoButton();

      bus.emit('image:generated', { imageData: result.imageData, meta: result.meta });
    } else {
      if (result.blankDetected) {
        status.textContent = 'Image appears blank — generation may have been filtered';
      } else if (result.contentRestricted) {
        status.textContent = 'Content restricted — try a different prompt';
      } else {
        status.textContent = 'Generation failed: ' + result.error;
      }
      status.className = 'status error';
      console.error('Generation failed:', result.error || 'blank image');
    }
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
    status.className = 'status error';
    console.error('Error:', e);
  } finally {
    clearInterval(timerInterval);
    state.isGenerating = false;
    generateBtn.disabled = false;
    loadingIndicator.style.display = 'none';

    setTimeout(() => {
      if (status.textContent.startsWith('Image ready') || status.textContent.startsWith('Generation failed') || status.textContent.startsWith('Error')) {
        status.textContent = 'Connected';
        status.className = 'status connected';
      }
    }, 5000);
  }
}

// Electron-side scene prompt generation -- reads story text + lorebook entries,
// calls GLM-4-6 to produce an image prompt, then triggers image gen + suggestions.
export async function generateScenePromptFromEditor() {
  // Skip if any LLM operation is in progress (avoids NovelAI 429 concurrent lock)
  if (state.isGeneratingPrompt || state.isGenerating || state.loreIsScanning) return;
  if (state.memoryIsProcessing) return;
  if (state.comprehensionScanning) return;
  state.isGeneratingPrompt = true;

  try {
    const storyText = await readStoryTextFromDOM();
    if (!storyText || storyText.length < 100) {
      state.isGeneratingPrompt = false;
      return;
    }

    // Get lorebook entries (best-effort)
    let entries = [];
    try {
      entries = await loreCall('getEntries');
    } catch (e) {
      console.log('[Renderer] Could not read lorebook entries:', e.message);
    }

    // Get art style from settings
    const artStyle = novelaiArtStyleSelect ? novelaiArtStyleSelect.value : 'anime style, detailed, high quality';

    console.log('[Renderer] Generating scene prompt via Electron...');
    status.textContent = 'Analyzing scene...';
    status.className = 'status generating';

    const result = await window.sceneVisualizer.generateScenePrompt({
      storyText: storyText.slice(-3000),
      entries,
      artStyle: artStyle === 'no-style' ? 'anime style, detailed, high quality' : artStyle,
      storyId: state.currentStoryId,
    });

    if (result.success) {
      const llmNegative = result.negativePrompt || '';

      // Fetch provider suffixes so user sees the FULL final prompt+negative in the textareas
      let promptSuffix = '';
      let negSuffix = '';
      try {
        const [pData, nData] = await Promise.all([
          window.sceneVisualizer.getPromptSuffix(),
          window.sceneVisualizer.getNegativePromptSuffix(),
        ]);
        promptSuffix = pData.combined || '';
        negSuffix = nData.combined || '';
      } catch (e) {
        console.log('[Renderer] Could not fetch prompt/negative suffixes:', e.message);
      }

      const fullPrompt = result.prompt + promptSuffix;
      state.currentPrompt = fullPrompt;
      promptDisplay.value = fullPrompt;
      promptWasEdited = false;
      if (promptEditedIndicator) promptEditedIndicator.classList.remove('visible');

      // Build full negative prompt: LLM negative + style/UC preset negative
      const fullNegative = [llmNegative, negSuffix].filter(Boolean).join(', ');
      state.currentNegativePrompt = fullNegative;
      if (negativePromptDisplay) {
        negativePromptDisplay.value = fullNegative;
        negPromptWasEdited = false;
        if (negPromptEditedIndicator) negPromptEditedIndicator.classList.remove('visible');
      }

      status.textContent = 'Prompt ready';
      status.className = 'status connected';
      imagePanel.classList.remove('hidden');

      // Persist state for this story
      if (state.currentStoryId) {
        window.sceneVisualizer.sceneSetState(state.currentStoryId, {
          lastPrompt: state.currentPrompt,
          lastNegativePrompt: state.currentNegativePrompt,
          lastStoryLength: storyText.length,
          artStyle,
        });
      }

      bus.emit('prompt:updated', { prompt: state.currentPrompt, negativePrompt: state.currentNegativePrompt });

      // Auto-generate image if toggle is on — use raw flags since suffixes are already baked in
      if (autoGenerateToggle.checked && !state.isGenerating) {
        generateImage(state.currentPrompt, state.currentNegativePrompt, { rawPrompt: true, rawNegativePrompt: true });
      }

      // Generate suggestions in parallel
      generateSuggestionsFromEditor();
    } else {
      console.error('[Renderer] Scene prompt generation failed:', result.error);
      status.textContent = 'Prompt generation failed';
      status.className = 'status error';
      setTimeout(() => {
        if (status.textContent === 'Prompt generation failed') {
          status.textContent = 'Connected';
          status.className = 'status connected';
        }
      }, 4000);
    }
  } catch (e) {
    console.error('[Renderer] Scene prompt generation error:', e);
  } finally {
    state.isGeneratingPrompt = false;
  }
}

// Get the effective negative prompt from textarea (if edited) or state
function getEffectiveNegativePrompt() {
  if (negativePromptDisplay && negPromptWasEdited) {
    const edited = negativePromptDisplay.value.trim();
    state.currentNegativePrompt = edited;
    return edited;
  }
  if (negativePromptDisplay && negativePromptDisplay.value.trim()) {
    return negativePromptDisplay.value.trim();
  }
  return state.currentNegativePrompt || '';
}

export function init() {
  const regenPromptBtn = document.getElementById('regenPromptBtn');

  // Track manual edits to the prompt textarea
  promptDisplay.addEventListener('input', () => {
    promptWasEdited = true;
    if (promptEditedIndicator) promptEditedIndicator.classList.add('visible');
  });

  // Track manual edits to the negative prompt textarea
  if (negativePromptDisplay) {
    negativePromptDisplay.addEventListener('input', () => {
      negPromptWasEdited = true;
      if (negPromptEditedIndicator) negPromptEditedIndicator.classList.add('visible');
    });
  }

  // Regenerate prompt button -- forces a fresh prompt from current story text
  regenPromptBtn.addEventListener('click', async () => {
    if (state.isGeneratingPrompt || state.isGenerating) return;
    regenPromptBtn.disabled = true;
    try {
      // Clear cached length to force regeneration regardless of text change
      state.lastKnownStoryLength = 0;
      await generateScenePromptFromEditor();
    } finally {
      regenPromptBtn.disabled = false;
    }
  });

  // Generate Scene button
  generateBtn.addEventListener('click', async () => {
    if (state.isGenerating) return;

    // Textareas contain the full prompt (with style/UC already baked in) — always rawPrompt + rawNegativePrompt
    const editedPrompt = promptDisplay.value.trim();
    const negPrompt = getEffectiveNegativePrompt();

    if (editedPrompt && promptWasEdited) {
      state.currentPrompt = editedPrompt;
      await generateImage(editedPrompt, negPrompt, { rawPrompt: true, rawNegativePrompt: true });
      return;
    }

    // If we already have a prompt, use it directly (already includes suffix)
    if (state.currentPrompt) {
      await generateImage(state.currentPrompt, negPrompt, { rawPrompt: true, rawNegativePrompt: true });
      return;
    }

    // No prompt yet -- generate one via Electron-side analysis
    try {
      await generateScenePromptFromEditor();
      if (state.currentPrompt) {
        await generateImage(state.currentPrompt, getEffectiveNegativePrompt(), { rawPrompt: true, rawNegativePrompt: true });
      } else {
        status.textContent = 'No prompt generated — write more story content';
        status.className = 'status error';
        setTimeout(() => {
          if (status.textContent === 'No prompt generated — write more story content') {
            status.textContent = 'Connected';
            status.className = 'status connected';
          }
        }, 3000);
      }
    } catch (e) {
      console.error('Error generating prompt:', e);
      status.textContent = 'Error generating prompt';
      status.className = 'status error';
    }
  });

  // Sidebar generate button -- uses current prompt directly (or edited)
  sidebarGenerateBtn.addEventListener('click', () => {
    const editedPrompt = promptDisplay.value.trim();
    const prompt = editedPrompt || state.currentPrompt;
    if (state.isGenerating || !prompt) return;
    if (editedPrompt) state.currentPrompt = editedPrompt;
    const negPrompt = getEffectiveNegativePrompt();
    generateImage(state.currentPrompt, negPrompt, { rawPrompt: true, rawNegativePrompt: true });
  });

  // Venice balance — listen for updates from main process
  window.sceneVisualizer.onVeniceBalanceUpdate((balance) => {
    updateVeniceBalanceDisplay(balance);
    if (balance.usd !== null && balance.usd < LOW_BALANCE_THRESHOLD) {
      showToast(`Venice credits low: $${balance.usd.toFixed(2)} remaining`, 4000, 'warn');
    }
  });

  // Show/hide balance indicator based on provider (on init and after settings save)
  refreshVeniceBalanceVisibility();
  bus.on('settings:saved', refreshVeniceBalanceVisibility);

  // After settings change (art style, UC preset, etc.), refresh the neg prompt suffix
  // only if the user hasn't manually edited the neg prompt
  bus.on('settings:saved', async () => {
    if (negPromptWasEdited || !negativePromptDisplay) return;
    try {
      const nData = await window.sceneVisualizer.getNegativePromptSuffix();
      const negSuffix = nData.combined || '';
      // Rebuild: preserve any LLM-generated prefix, replace the suffix portion
      // Simplest approach: just set the full effective negative
      state.currentNegativePrompt = negSuffix;
      negativePromptDisplay.value = negSuffix;
    } catch { /* ignore */ }
  });
}

// tts.js — Text-to-Speech narration controls with per-character voice mapping

import {
  ttsNarrateBtn, ttsStopBtn, ttsProgress,
  ttsVoiceList, ttsVoiceCount, ttsAutoAssignBtn,
} from './dom-refs.js';
import { state, bus } from './state.js';
import { readStoryTextFromDOM } from './webview-polling.js';
import { showToast } from './utils.js';
import { loreCall } from './lore-creator.js';

let audioEl = null;
let aborted = false;
let isNarrating = false;
let cachedVoices = null;

async function getVoices() {
  if (!cachedVoices) {
    cachedVoices = await window.sceneVisualizer.ttsGetVoices();
  }
  return cachedVoices;
}

function buildVoiceSelect(voices, selectedVoice) {
  const sel = document.createElement('select');
  sel.className = 'tts-voice-select';
  for (const v of voices) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.name;
    if (v.id === selectedVoice) opt.selected = true;
    sel.appendChild(opt);
  }
  return sel;
}

function renderVoiceRow(container, charName, voiceId, voices, onVoiceChange, onRemove) {
  const row = document.createElement('div');
  row.className = 'tts-voice-row';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'tts-char-name';
  nameSpan.textContent = charName;

  const sel = buildVoiceSelect(voices, voiceId);
  sel.addEventListener('change', () => onVoiceChange(charName, sel.value));

  const removeBtn = document.createElement('button');
  removeBtn.className = 'tts-voice-remove';
  removeBtn.textContent = '\u00d7';
  removeBtn.title = 'Remove';
  removeBtn.addEventListener('click', () => onRemove(charName, row));

  row.appendChild(nameSpan);
  row.appendChild(sel);
  row.appendChild(removeBtn);
  container.appendChild(row);
}

export async function refreshVoiceMapUI() {
  if (!ttsVoiceList || !state.currentStoryId) return;

  const ttsState = state.ttsState || { characterVoices: {} };
  const characterVoices = ttsState.characterVoices || {};
  const entries = Object.entries(characterVoices);

  ttsVoiceList.innerHTML = '';
  ttsVoiceCount.textContent = `(${entries.length})`;

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:11px;color:var(--text-muted);padding:4px 0;';
    empty.textContent = 'No character voices assigned';
    ttsVoiceList.appendChild(empty);
    return;
  }

  const voices = await getVoices();

  for (const [charName, voiceId] of entries) {
    renderVoiceRow(
      ttsVoiceList, charName, voiceId, voices,
      async (name, newVoice) => {
        await window.sceneVisualizer.ttsSetCharacterVoice(state.currentStoryId, name, newVoice);
        state.ttsState.characterVoices[name] = newVoice;
      },
      async (name, row) => {
        await window.sceneVisualizer.ttsRemoveCharacterVoice(state.currentStoryId, name);
        delete state.ttsState.characterVoices[name];
        row.remove();
        ttsVoiceCount.textContent = `(${Object.keys(state.ttsState.characterVoices).length})`;
      }
    );
  }
}

async function autoAssignFromLore() {
  if (!state.currentStoryId) {
    showToast('No story loaded', 3000, 'warn');
    return;
  }

  try {
    let entries = [];
    try { entries = await loreCall('getEntries'); } catch { /* ignore */ }
    if (!entries || entries.length === 0) {
      showToast('No lore entries found', 3000, 'warn');
      return;
    }

    // Filter to character entries (has @type: character, or heuristic)
    const characters = entries.filter(e => {
      if (!e.text) return false;
      const typeMatch = e.text.match(/^@type:\s*(\S+)/m);
      if (typeMatch) return typeMatch[1] === 'character';
      // Heuristic: entries with common character fields
      return /\b(?:Class|Race|Level|Appearance|Personality)\b/i.test(e.text);
    });

    if (characters.length === 0) {
      showToast('No character entries found in lorebook', 3000, 'warn');
      return;
    }

    const voices = await getVoices();
    if (!voices || voices.length === 0) {
      showToast('No TTS voices available', 3000, 'warn');
      return;
    }

    const ttsState = state.ttsState || { characterVoices: {} };
    const existing = ttsState.characterVoices || {};
    let assigned = 0;

    // Cycle through voices to give each character a distinct voice
    const usedVoices = new Set(Object.values(existing));
    let voiceIdx = 0;

    for (const entry of characters) {
      const name = entry.displayName || entry.keys?.[0] || '';
      if (!name || existing[name]) continue;

      // Find next unused voice, cycling through
      let voice = null;
      for (let i = 0; i < voices.length; i++) {
        const candidate = voices[(voiceIdx + i) % voices.length].id;
        if (!usedVoices.has(candidate)) {
          voice = candidate;
          voiceIdx = (voiceIdx + i + 1) % voices.length;
          break;
        }
      }
      // If all voices used, just cycle
      if (!voice) {
        voice = voices[voiceIdx % voices.length].id;
        voiceIdx = (voiceIdx + 1) % voices.length;
      }

      existing[name] = voice;
      usedVoices.add(voice);
      assigned++;
    }

    ttsState.characterVoices = existing;
    state.ttsState = ttsState;
    await window.sceneVisualizer.ttsSetState(state.currentStoryId, ttsState);
    await refreshVoiceMapUI();
    showToast(`Assigned voices to ${assigned} character${assigned !== 1 ? 's' : ''}`, 3000);
  } catch (e) {
    console.error('[TTS] Auto-assign error:', e);
    showToast('Auto-assign failed: ' + e.message, 4000, 'error');
  }
}

async function narrateScene() {
  if (isNarrating) return;
  isNarrating = true;
  aborted = false;
  ttsNarrateBtn.disabled = true;
  ttsStopBtn.style.display = '';

  try {
    const storyText = await readStoryTextFromDOM();
    if (!storyText || storyText.length < 50) {
      showToast('Not enough text to narrate', 3000, 'warn');
      return;
    }

    let protagonistName = null;
    try {
      const entries = await loreCall('getEntries');
      const protag = entries?.find(e => e.text && /^@protagonist:\s*true/m.test(e.text));
      if (protag) protagonistName = protag.displayName;
    } catch { /* lorebook may not be available */ }

    ttsProgress.textContent = 'Generating audio...';
    const segments = await window.sceneVisualizer.ttsNarrateScene(
      storyText.slice(-3000),
      state.currentStoryId,
      protagonistName
    );

    if (!segments || segments.length === 0) {
      ttsProgress.textContent = 'No audio generated';
      return;
    }

    if (!audioEl) {
      audioEl = document.createElement('audio');
    }

    for (let i = 0; i < segments.length; i++) {
      if (aborted) break;
      const seg = segments[i];
      const label = seg.speaker ? `${seg.speaker}` : seg.type;
      ttsProgress.textContent = `Playing ${i + 1}/${segments.length} (${label})...`;
      audioEl.src = seg.audioData;
      await new Promise((resolve, reject) => {
        audioEl.onended = resolve;
        audioEl.onerror = reject;
        audioEl.play();
      });
    }
    ttsProgress.textContent = aborted ? 'Stopped' : 'Done';
  } catch (e) {
    console.error('[TTS] Error:', e);
    ttsProgress.textContent = 'Error: ' + e.message;
    showToast('TTS error: ' + e.message, 4000, 'error');
  } finally {
    isNarrating = false;
    ttsNarrateBtn.disabled = false;
    ttsStopBtn.style.display = 'none';
    setTimeout(() => { ttsProgress.textContent = ''; }, 3000);
  }
}

function stopNarration() {
  aborted = true;
  if (audioEl) { audioEl.pause(); audioEl.src = ''; }
}

export function init() {
  if (!ttsNarrateBtn) return;
  ttsNarrateBtn.addEventListener('click', narrateScene);
  ttsStopBtn.addEventListener('click', stopNarration);
  if (ttsAutoAssignBtn) {
    ttsAutoAssignBtn.addEventListener('click', autoAssignFromLore);
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isNarrating) stopNarration();
  });

  // Refresh voice map on story switch
  bus.on('story:changed', () => {
    cachedVoices = null; // clear cache in case provider changed
    refreshVoiceMapUI();
  });

  // Refresh voice map after settings save (provider/voices may have changed)
  bus.on('settings:saved', () => {
    cachedVoices = null;
    refreshVoiceMapUI();
  });
}

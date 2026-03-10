// settings-modal.js — Settings modal logic (open/close, provider sections, save/load, slider events)

import {
  settingsModal, status,
  providerSelect, modelSelect, resolutionPreset, imgWidth, imgHeight,
  samplerSelect, noiseScheduleSelect, stepsInput, scaleInput,
  cfgRescaleSlider, cfgRescaleValue, smeaCheckbox, smeaDynCheckbox,
  ucPresetSelect, qualityTagsCheckbox, v3Options,
  novelaiArtStyleSelect,
  extractKeyBtn, perchanceKeyDot, perchanceKeyText,
  perchanceArtStyleSelect, perchanceGuidanceSlider, perchanceGuidanceValue,
  veniceKeyDot, veniceKeyText, veniceApiKeyInput, saveVeniceKeyBtn,
  veniceModelSelect, veniceStepsInput, veniceCfgScaleInput,
  veniceStylePresetSelect, veniceSafeModeCheckbox, veniceHideWatermarkCheckbox,
  veniceVideoModelSelect, veniceVideoDurationSelect, veniceVideoResolutionSelect,
  veniceSettingsBalance, veniceSettingsBalanceText,
  puterModelSelect, puterQualitySelect, puterQualityGroup,
  novelaiTokenDot, novelaiTokenText,
  novelaiEmailInput, novelaiPasswordInput,
  settingsBtn, cancelBtn, saveBtn, reloadBtn,
  saveManualKeyBtn, perchanceManualKeyInput,
  sceneAutoGenerate, sceneUseCharacterLore, sceneArtStyleTags,
  sceneMinTextChange, sceneMinTextChangeValue,
  scenePromptTemperature, scenePromptTemperatureValue,
  sceneSuggestionStyle, sceneSuggestionTemperature, sceneSuggestionTemperatureValue,
  sceneEnableLitrpg,
  scenePipelineVersion, sceneSecondaryLlm,
  textLlmOpenaiKey, textLlmOpenaiModel, textLlmAnthropicKey, textLlmAnthropicModel,
  textLlmOllamaModelSelect,
  ttsProviderSelect, ttsVersionSelect, ttsVersionGroup,
  ttsNarratorVoiceSelect, ttsDialogueVoiceSelect,
  ttsSpeedSlider, ttsSpeedValue, ttsFirstPersonCheckbox,
  ttsSettingsVoiceList, ttsSettingsVoiceCount,
  ttsAddCharName, ttsAddCharVoice, ttsAddCharBtn,
  ttsV2NarratorGroup, ttsV2DialogueGroup,
  ttsNarratorStyle, ttsNarratorIntonation, ttsNarratorCadence,
  ttsDialogueStyle, ttsDialogueIntonation, ttsDialogueCadence,
  ttsNarratorCustomSeed, ttsDialogueCustomSeed, ttsAddCharCustomSeed,
  RESOLUTION_PRESETS, V4_MODELS,
} from './dom-refs.js';
import { state, bus } from './state.js';
import { refreshRpgUI } from './litrpg-panel.js';
import { refreshVoiceMapUI } from './tts.js';

// Update V3 options visibility based on model
function updateV3Options() {
  const isV4 = V4_MODELS.includes(modelSelect.value);
  v3Options.classList.toggle('disabled', isV4);
  if (isV4) {
    smeaCheckbox.checked = false;
    smeaDynCheckbox.checked = false;
  }
}

// Show/hide settings sections based on selected provider
function updateProviderSections() {
  const selected = providerSelect.value;
  document.querySelectorAll('.settings-section[data-provider]').forEach(section => {
    const match = section.dataset.provider === selected;
    section.classList.toggle('provider-visible', match);
  });
  // Clamp resolution max per provider
  const maxDimMap = { perchance: 768, venice: 1280, puter: 1536 };
  const maxDim = maxDimMap[selected] || 1536;
  imgWidth.max = maxDim;
  imgHeight.max = maxDim;
  if (maxDim < 1536) {
    if (parseInt(imgWidth.value) > maxDim) imgWidth.value = maxDim;
    if (parseInt(imgHeight.value) > maxDim) imgHeight.value = maxDim;
  }
}

// Load Venice models into dropdown
async function loadVeniceModels() {
  try {
    const models = await window.sceneVisualizer.getVeniceModels();
    veniceModelSelect.innerHTML = '';
    if (models.length === 0) {
      const opt = document.createElement('option');
      opt.value = 'flux-2-max';
      opt.textContent = 'flux-2-max (default)';
      veniceModelSelect.appendChild(opt);
      return;
    }
    for (const model of models) {
      const opt = document.createElement('option');
      opt.value = model.id;
      opt.textContent = model.name;
      veniceModelSelect.appendChild(opt);
    }
  } catch (e) {
    console.error('Failed to load Venice models:', e);
  }
}

// Load Venice video models into dropdown
async function loadVeniceVideoModels() {
  try {
    const models = await window.sceneVisualizer.veniceGetVideoModels();
    veniceVideoModelSelect.innerHTML = '<option value="">Select a model</option>';
    for (const model of models) {
      const opt = document.createElement('option');
      opt.value = model.id;
      opt.textContent = model.name;
      veniceVideoModelSelect.appendChild(opt);
    }
  } catch (e) {
    console.error('Failed to load Venice video models:', e);
  }
}

// Display Venice balance in settings
async function showVeniceSettingsBalance() {
  try {
    const balance = await window.sceneVisualizer.veniceGetBalance();
    if (balance && balance.usd !== null && veniceSettingsBalance && veniceSettingsBalanceText) {
      let text = `Balance: $${balance.usd.toFixed(2)}`;
      if (balance.remainingRequests !== null) {
        text += ` | ${balance.remainingRequests} requests remaining`;
      }
      veniceSettingsBalanceText.textContent = text;
      veniceSettingsBalance.style.display = '';
    } else if (veniceSettingsBalance) {
      veniceSettingsBalance.style.display = 'none';
    }
  } catch { /* ignore */ }
}

// Load Venice styles into dropdown
async function loadVeniceStyles() {
  try {
    const styles = await window.sceneVisualizer.getVeniceStyles();
    veniceStylePresetSelect.innerHTML = '<option value="">None</option>';
    for (const style of styles) {
      const opt = document.createElement('option');
      opt.value = style.id;
      opt.textContent = style.name;
      veniceStylePresetSelect.appendChild(opt);
    }
  } catch (e) {
    console.error('Failed to load Venice styles:', e);
  }
}

// Models that support quality setting and their allowed options
const PUTER_QUALITY_MODELS = {
  'gpt-image-1': ['high', 'medium', 'low'],
  'dall-e-3': ['hd', 'standard'],
};

// Load Puter models into dropdown (grouped by provider)
async function loadPuterModels() {
  try {
    const models = await window.sceneVisualizer.getPuterModels();
    puterModelSelect.innerHTML = '';
    // Group models by their group property
    const groups = {};
    for (const model of models) {
      const g = model.group || 'Other';
      if (!groups[g]) groups[g] = [];
      groups[g].push(model);
    }
    for (const [groupName, groupModels] of Object.entries(groups)) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = groupName;
      for (const model of groupModels) {
        const opt = document.createElement('option');
        opt.value = model.id;
        opt.textContent = model.name;
        optgroup.appendChild(opt);
      }
      puterModelSelect.appendChild(optgroup);
    }
  } catch (e) {
    console.error('Failed to load Puter models:', e);
  }
}

// Show/hide quality dropdown based on selected Puter model
function updatePuterQualityVisibility() {
  const model = puterModelSelect.value;
  const qualityOpts = PUTER_QUALITY_MODELS[model];
  if (qualityOpts) {
    puterQualityGroup.style.display = '';
    // Update quality options for this model
    const currentVal = puterQualitySelect.value;
    puterQualitySelect.innerHTML = '';
    for (const q of qualityOpts) {
      const opt = document.createElement('option');
      opt.value = q;
      opt.textContent = q.charAt(0).toUpperCase() + q.slice(1);
      puterQualitySelect.appendChild(opt);
    }
    // Restore selection if valid, otherwise use first option
    if (qualityOpts.includes(currentVal)) {
      puterQualitySelect.value = currentVal;
    }
  } else {
    puterQualityGroup.style.display = 'none';
  }
}

// Toggle v2 fields visibility based on TTS version and provider
function updateTtsV2Visibility() {
  const isNovelai = ttsProviderSelect.value !== 'venice';
  const ver = ttsVersionSelect.value;
  const showV2 = isNovelai && (ver === 'v2' || ver === 'auto');
  ttsVersionGroup.style.display = isNovelai ? '' : 'none';
  ttsV2NarratorGroup.style.display = showV2 ? '' : 'none';
  ttsV2DialogueGroup.style.display = showV2 ? '' : 'none';
  // Custom seed inputs
  if (ttsNarratorCustomSeed) ttsNarratorCustomSeed.style.display = ttsNarratorVoiceSelect.value === '__custom__' ? '' : 'none';
  if (ttsDialogueCustomSeed) ttsDialogueCustomSeed.style.display = ttsDialogueVoiceSelect.value === '__custom__' ? '' : 'none';
}

// Populate v2 fields from a voice value (string preset or v2 object)
function populateV2Fields(voice, styleEl, intonationEl, cadenceEl) {
  if (voice && typeof voice === 'object' && voice.v === 2) {
    styleEl.value = voice.style || '';
    intonationEl.value = voice.intonation || '';
    cadenceEl.value = voice.cadence || '';
  } else {
    const seed = voice || '';
    styleEl.value = seed;
    intonationEl.value = seed;
    cadenceEl.value = seed;
  }
}

// Build voice value from v2 fields, dropdown, and custom seed input.
// If all three v2 fields match, return string; if they diverge, return v2 object.
function buildVoiceValue(selectEl, styleEl, intonationEl, cadenceEl, ttsVersion, customSeedEl) {
  const preset = selectEl.value;
  // Custom seed mode — use the custom seed text input
  if (preset === '__custom__') {
    const customSeed = customSeedEl?.value?.trim();
    if (ttsVersion === 'v2' || ttsVersion === 'auto') {
      const s = styleEl.value.trim();
      const i = intonationEl.value.trim();
      const c = cadenceEl.value.trim();
      // If v2 fields are customized, use them
      if (s && (s !== i || s !== c)) return { v: 2, style: s, intonation: i || s, cadence: c || s };
      // Otherwise use the custom seed text
      if (customSeed) return customSeed;
      return s || 'Cyllene';
    }
    return customSeed || 'Cyllene';
  }
  // Preset selected — check if v2 fields diverge
  if (ttsVersion === 'v2' || ttsVersion === 'auto') {
    const s = styleEl.value.trim();
    const i = intonationEl.value.trim();
    const c = cadenceEl.value.trim();
    if (s && (s !== preset || i !== preset || c !== preset)) {
      return { v: 2, style: s, intonation: i || s, cadence: c || s };
    }
  }
  return preset || 'Cyllene';
}

// Populate a voice <select> with grouped voices (v2/v1/custom)
function populateVoiceSelect(sel, voices, addCustomOption) {
  const prev = sel.value;
  sel.innerHTML = '';
  // Group by version
  const v2 = voices.filter(v => v.version === 'v2');
  const v1 = voices.filter(v => v.version === 'v1');
  const other = voices.filter(v => !v.version);
  if (v2.length) {
    const grp = document.createElement('optgroup');
    grp.label = 'v2 Voices';
    for (const v of v2) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.name;
      grp.appendChild(opt);
    }
    sel.appendChild(grp);
  }
  if (v1.length) {
    const grp = document.createElement('optgroup');
    grp.label = 'v1 Voices (legacy)';
    for (const v of v1) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.name;
      grp.appendChild(opt);
    }
    sel.appendChild(grp);
  }
  for (const v of other) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.name;
    sel.appendChild(opt);
  }
  if (addCustomOption) {
    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = 'Custom seed...';
    sel.appendChild(customOpt);
  }
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}

// Load TTS voices into narrator and dialogue dropdowns
async function loadTtsVoices() {
  try {
    const voices = await window.sceneVisualizer.ttsGetVoices();
    for (const sel of [ttsNarratorVoiceSelect, ttsDialogueVoiceSelect, ttsAddCharVoice]) {
      if (!sel) continue;
      const addCustom = sel === ttsNarratorVoiceSelect || sel === ttsDialogueVoiceSelect || sel === ttsAddCharVoice;
      populateVoiceSelect(sel, voices, addCustom);
    }
    return voices;
  } catch (e) {
    console.error('Failed to load TTS voices:', e);
    return [];
  }
}

// Render character voice rows in settings modal
function renderSettingsVoiceList(voices) {
  if (!ttsSettingsVoiceList) return;
  const ttsState = state.ttsState || { characterVoices: {} };
  const charVoices = ttsState.characterVoices || {};
  const entries = Object.entries(charVoices);

  ttsSettingsVoiceList.innerHTML = '';
  if (ttsSettingsVoiceCount) ttsSettingsVoiceCount.textContent = `(${entries.length})`;

  for (const [charName, voiceId] of entries) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:4px;';

    const nameEl = document.createElement('span');
    nameEl.style.cssText = 'flex:1;font-size:11px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    nameEl.textContent = charName;

    const sel = document.createElement('select');
    sel.style.cssText = 'flex:1;font-size:11px;';
    populateVoiceSelect(sel, voices, true);
    if (voiceId) sel.value = voiceId;
    // If voiceId is a custom seed not in the presets, add it as an option
    if (voiceId && !sel.value) {
      const customOpt = document.createElement('option');
      customOpt.value = voiceId;
      customOpt.textContent = voiceId + ' (custom)';
      sel.insertBefore(customOpt, sel.firstChild);
      sel.value = voiceId;
    }
    sel.addEventListener('change', async () => {
      if (state.currentStoryId) {
        await window.sceneVisualizer.ttsSetCharacterVoice(state.currentStoryId, charName, sel.value);
        state.ttsState.characterVoices[charName] = sel.value;
      }
    });

    const rmBtn = document.createElement('button');
    rmBtn.textContent = '\u00d7';
    rmBtn.style.cssText = 'background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:13px;padding:0 2px;';
    rmBtn.addEventListener('click', async () => {
      if (state.currentStoryId) {
        await window.sceneVisualizer.ttsRemoveCharacterVoice(state.currentStoryId, charName);
        delete state.ttsState.characterVoices[charName];
        row.remove();
        if (ttsSettingsVoiceCount) ttsSettingsVoiceCount.textContent = `(${Object.keys(state.ttsState.characterVoices).length})`;
        refreshVoiceMapUI();
      }
    });

    row.appendChild(nameEl);
    row.appendChild(sel);
    row.appendChild(rmBtn);
    ttsSettingsVoiceList.appendChild(row);
  }
}

export function init() {
  providerSelect.addEventListener('change', updateProviderSections);

  // Puter model change — toggle quality dropdown
  puterModelSelect.addEventListener('change', updatePuterQualityVisibility);

  // TTS speed slider
  ttsSpeedSlider.addEventListener('input', () => {
    ttsSpeedValue.textContent = ttsSpeedSlider.value;
  });

  // TTS character voice add button
  if (ttsAddCharBtn) {
    ttsAddCharBtn.addEventListener('click', async () => {
      const name = ttsAddCharName.value.trim();
      let voice = ttsAddCharVoice.value;
      // Use custom seed text if "Custom seed..." is selected
      if (voice === '__custom__' && ttsAddCharCustomSeed) {
        const customSeed = ttsAddCharCustomSeed.value.trim();
        if (!customSeed) return;
        voice = customSeed;
      }
      if (!name) return;
      if (!state.currentStoryId) return;
      if (!state.ttsState) state.ttsState = { characterVoices: {} };
      state.ttsState.characterVoices[name] = voice;
      await window.sceneVisualizer.ttsSetCharacterVoice(state.currentStoryId, name, voice);
      ttsAddCharName.value = '';
      const voices = await loadTtsVoices();
      renderSettingsVoiceList(voices);
      refreshVoiceMapUI();
    });
  }

  // TTS provider change — refresh voice lists and toggle speed slider
  ttsProviderSelect.addEventListener('change', async () => {
    await loadTtsVoices();
    document.getElementById('ttsSpeedGroup').style.display =
      ttsProviderSelect.value === 'venice' ? '' : 'none';
    updateTtsV2Visibility();
  });

  // TTS version change — toggle v2 fields
  ttsVersionSelect.addEventListener('change', () => {
    updateTtsV2Visibility();
  });

  // Sync v2 fields when a preset is selected in narrator/dialogue dropdowns + toggle custom seed
  ttsNarratorVoiceSelect.addEventListener('change', () => {
    const val = ttsNarratorVoiceSelect.value;
    if (ttsNarratorCustomSeed) ttsNarratorCustomSeed.style.display = val === '__custom__' ? '' : 'none';
    if (val && val !== '__custom__') {
      populateV2Fields(val, ttsNarratorStyle, ttsNarratorIntonation, ttsNarratorCadence);
    }
  });
  ttsDialogueVoiceSelect.addEventListener('change', () => {
    const val = ttsDialogueVoiceSelect.value;
    if (ttsDialogueCustomSeed) ttsDialogueCustomSeed.style.display = val === '__custom__' ? '' : 'none';
    if (val && val !== '__custom__') {
      populateV2Fields(val, ttsDialogueStyle, ttsDialogueIntonation, ttsDialogueCadence);
    }
  });
  // Character voice add — toggle custom seed input
  if (ttsAddCharVoice && ttsAddCharCustomSeed) {
    ttsAddCharVoice.addEventListener('change', () => {
      ttsAddCharCustomSeed.style.display = ttsAddCharVoice.value === '__custom__' ? '' : 'none';
    });
  }

  // Scene settings sliders
  sceneMinTextChange.addEventListener('input', () => {
    sceneMinTextChangeValue.textContent = sceneMinTextChange.value;
  });
  scenePromptTemperature.addEventListener('input', () => {
    scenePromptTemperatureValue.textContent = scenePromptTemperature.value;
  });
  sceneSuggestionTemperature.addEventListener('input', () => {
    sceneSuggestionTemperatureValue.textContent = sceneSuggestionTemperature.value;
  });

  // Perchance guidance scale slider
  perchanceGuidanceSlider.addEventListener('input', () => {
    perchanceGuidanceValue.textContent = perchanceGuidanceSlider.value;
  });

  // Perchance key extraction
  extractKeyBtn.addEventListener('click', async () => {
    extractKeyBtn.disabled = true;
    extractKeyBtn.textContent = 'Extracting...';
    perchanceKeyText.textContent = 'Extracting key (a browser window may appear)...';
    try {
      const result = await window.sceneVisualizer.extractPerchanceKey();
      if (result.success) {
        perchanceKeyDot.className = 'dot active';
        perchanceKeyText.textContent = 'Key extracted successfully';
      } else {
        perchanceKeyDot.className = 'dot inactive';
        perchanceKeyText.textContent = result.error || 'Extraction failed or timed out';
      }
    } catch (e) {
      perchanceKeyDot.className = 'dot inactive';
      perchanceKeyText.textContent = 'Error: ' + e.message;
    } finally {
      extractKeyBtn.disabled = false;
      extractKeyBtn.textContent = 'Extract Key';
    }
  });

  // Manual key entry
  saveManualKeyBtn.addEventListener('click', async () => {
    const key = perchanceManualKeyInput.value.trim();
    if (!/^[a-f0-9]{64}$/i.test(key)) {
      perchanceKeyDot.className = 'dot inactive';
      perchanceKeyText.textContent = 'Invalid key — must be 64 hex characters';
      return;
    }
    try {
      const result = await window.sceneVisualizer.setPerchanceKey(key);
      if (result.success) {
        perchanceKeyDot.className = 'dot active';
        perchanceKeyText.textContent = 'Key saved: ' + key.substring(0, 10) + '...';
        perchanceManualKeyInput.value = '';
      }
    } catch (e) {
      perchanceKeyText.textContent = 'Error saving key: ' + e.message;
    }
  });

  // Venice AI key save
  saveVeniceKeyBtn.addEventListener('click', async () => {
    const key = veniceApiKeyInput.value.trim();
    if (!key) {
      veniceKeyDot.className = 'dot inactive';
      veniceKeyText.textContent = 'Please enter an API key';
      return;
    }
    try {
      const result = await window.sceneVisualizer.setVeniceApiKey(key);
      if (result.success) {
        veniceKeyDot.className = 'dot active';
        veniceKeyText.textContent = 'API key saved';
        veniceApiKeyInput.value = '';
        // Refresh models and styles after key is saved
        await loadVeniceModels();
        await loadVeniceStyles();
      }
    } catch (e) {
      veniceKeyText.textContent = 'Error saving key: ' + e.message;
    }
  });

  // Populate NovelAI art styles on load
  (async function loadNovelaiArtStyles() {
    try {
      const styles = await window.sceneVisualizer.getNovelaiArtStyles();
      novelaiArtStyleSelect.innerHTML = '';
      for (const style of styles) {
        const opt = document.createElement('option');
        opt.value = style.id;
        opt.textContent = style.name;
        novelaiArtStyleSelect.appendChild(opt);
      }
    } catch (e) {
      console.error('Failed to load NovelAI art styles:', e);
    }
  })();

  // Populate Perchance art styles on load
  (async function loadArtStyles() {
    try {
      const styles = await window.sceneVisualizer.getPerchanceArtStyles();
      perchanceArtStyleSelect.innerHTML = '';
      for (const style of styles) {
        const opt = document.createElement('option');
        opt.value = style.id;
        opt.textContent = style.name;
        perchanceArtStyleSelect.appendChild(opt);
      }
    } catch (e) {
      console.error('Failed to load art styles:', e);
    }
  })();

  // Handle resolution preset change
  resolutionPreset.addEventListener('change', () => {
    const preset = RESOLUTION_PRESETS[resolutionPreset.value];
    if (preset) {
      imgWidth.value = preset.width;
      imgHeight.value = preset.height;
    }
  });

  // Handle width/height manual change -> switch to custom
  imgWidth.addEventListener('change', () => {
    const matchingPreset = Object.entries(RESOLUTION_PRESETS).find(
      ([, p]) => p.width === parseInt(imgWidth.value) && p.height === parseInt(imgHeight.value)
    );
    resolutionPreset.value = matchingPreset ? matchingPreset[0] : 'custom';
  });

  imgHeight.addEventListener('change', () => {
    const matchingPreset = Object.entries(RESOLUTION_PRESETS).find(
      ([, p]) => p.width === parseInt(imgWidth.value) && p.height === parseInt(imgHeight.value)
    );
    resolutionPreset.value = matchingPreset ? matchingPreset[0] : 'custom';
  });

  // Handle CFG rescale slider
  cfgRescaleSlider.addEventListener('input', () => {
    cfgRescaleValue.textContent = cfgRescaleSlider.value;
  });

  // Handle model change
  modelSelect.addEventListener('change', updateV3Options);

  // Settings open
  settingsBtn.addEventListener('click', async () => {
    // Load per-story settings if a story is active (overrides globals for TTS/image/scene)
    const storySettings = state.currentStoryId
      ? await window.sceneVisualizer.storySettingsGet(state.currentStoryId)
      : null;

    const [token, settings, currentProvider, keyStatus, perchanceSettings, novelaiArtStyle, veniceSettings, veniceKeyStatus, puterSettings, sceneSettingsData] = await Promise.all([
      window.sceneVisualizer.getApiToken(),
      window.sceneVisualizer.getImageSettings(),
      window.sceneVisualizer.getProvider(),
      window.sceneVisualizer.getPerchanceKeyStatus(),
      window.sceneVisualizer.getPerchanceSettings(),
      window.sceneVisualizer.getNovelaiArtStyle(),
      window.sceneVisualizer.getVeniceSettings(),
      window.sceneVisualizer.getVeniceApiKeyStatus(),
      window.sceneVisualizer.getPuterSettings(),
      window.sceneVisualizer.getSceneSettings(),
    ]);

    // Use per-story overrides when available
    const effectiveSettings = storySettings?.imageSettings || settings;
    const effectiveProvider = storySettings?.imageProvider || currentProvider;
    const effectiveArtStyle = storySettings?.novelaiArtStyle || novelaiArtStyle;
    const effectiveSceneSettings = storySettings?.sceneSettings
      ? { ...sceneSettingsData, ...storySettings.sceneSettings }
      : sceneSettingsData;

    // TTS settings (wrapped — must not abort settings open on failure)
    try {
      const ttsSettings = storySettings || await window.sceneVisualizer.ttsGetSettings();
      ttsProviderSelect.value = ttsSettings.ttsProvider || 'novelai';
      ttsVersionSelect.value = ttsSettings.ttsVersion || 'auto';
      ttsSpeedSlider.value = ttsSettings.ttsSpeed || 1.0;
      ttsSpeedValue.textContent = ttsSettings.ttsSpeed || 1.0;
      ttsFirstPersonCheckbox.checked = !!ttsSettings.ttsFirstPerson;
      document.getElementById('ttsSpeedGroup').style.display =
        ttsProviderSelect.value === 'venice' ? '' : 'none';
      const voices = await loadTtsVoices();
      // Load narrator voice — handle object values (v2 custom) or custom seed strings
      const narVoice = ttsSettings.ttsNarratorVoice;
      if (narVoice && typeof narVoice === 'object' && narVoice.v === 2) {
        ttsNarratorVoiceSelect.value = '__custom__';
      } else if (narVoice && ![...ttsNarratorVoiceSelect.options].some(o => o.value === narVoice)) {
        // Custom seed string not in presets
        ttsNarratorVoiceSelect.value = '__custom__';
        if (ttsNarratorCustomSeed) ttsNarratorCustomSeed.value = narVoice;
      } else {
        ttsNarratorVoiceSelect.value = narVoice || '';
      }
      if (ttsNarratorCustomSeed) ttsNarratorCustomSeed.style.display = ttsNarratorVoiceSelect.value === '__custom__' ? '' : 'none';
      populateV2Fields(narVoice, ttsNarratorStyle, ttsNarratorIntonation, ttsNarratorCadence);
      // Load dialogue voice — handle object values (v2 custom) or custom seed strings
      const dlgVoice = ttsSettings.ttsDialogueVoice;
      if (dlgVoice && typeof dlgVoice === 'object' && dlgVoice.v === 2) {
        ttsDialogueVoiceSelect.value = '__custom__';
      } else if (dlgVoice && ![...ttsDialogueVoiceSelect.options].some(o => o.value === dlgVoice)) {
        ttsDialogueVoiceSelect.value = '__custom__';
        if (ttsDialogueCustomSeed) ttsDialogueCustomSeed.value = dlgVoice;
      } else {
        ttsDialogueVoiceSelect.value = dlgVoice || '';
      }
      if (ttsDialogueCustomSeed) ttsDialogueCustomSeed.style.display = ttsDialogueVoiceSelect.value === '__custom__' ? '' : 'none';
      populateV2Fields(dlgVoice, ttsDialogueStyle, ttsDialogueIntonation, ttsDialogueCadence);
      updateTtsV2Visibility();
      renderSettingsVoiceList(voices);
    } catch (e) {
      console.error('[Settings] TTS load error:', e);
    }

    // Text LLM / Pipeline settings (wrapped — must not abort settings open on failure)
    try {
      const textLlmSettings = await window.sceneVisualizer.textLlmGetSettings();
      scenePipelineVersion.value = String(textLlmSettings.pipelineVersion || 1);
      sceneSecondaryLlm.value = textLlmSettings.secondaryLlm || 'none';
      textLlmOpenaiKey.value = '';
      textLlmOpenaiKey.placeholder = textLlmSettings.openaiApiKey ? 'Key configured (enter new to replace)' : 'sk-...';
      textLlmOpenaiModel.value = textLlmSettings.openaiModel || 'gpt-4o-mini';
      textLlmAnthropicKey.value = '';
      textLlmAnthropicKey.placeholder = textLlmSettings.anthropicApiKey ? 'Key configured (enter new to replace)' : 'sk-ant-...';
      textLlmAnthropicModel.value = textLlmSettings.anthropicModel || 'claude-sonnet-4-20250514';
      // Load Ollama models
      const ollamaResult = await window.sceneVisualizer.textLlmListOllamaModels();
      textLlmOllamaModelSelect.innerHTML = '';
      if (ollamaResult.success && ollamaResult.models.length > 0) {
        for (const m of ollamaResult.models) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name;
          textLlmOllamaModelSelect.appendChild(opt);
        }
        // Select current model from lore LLM provider settings (authoritative source)
        const loreLlm = await window.sceneVisualizer.loreGetLlmProvider();
        if (loreLlm.ollamaModel) textLlmOllamaModelSelect.value = loreLlm.ollamaModel;
      } else {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = ollamaResult.success ? 'No models found' : 'Ollama not available';
        textLlmOllamaModelSelect.appendChild(opt);
      }
    } catch (e) {
      console.error('[Settings] Text LLM load error:', e);
    }

    // Scene settings
    sceneAutoGenerate.checked = effectiveSceneSettings.autoGeneratePrompts !== false;
    sceneUseCharacterLore.checked = effectiveSceneSettings.useCharacterLore !== false;
    sceneArtStyleTags.value = effectiveSceneSettings.artStyleTags || '';
    sceneMinTextChange.value = effectiveSceneSettings.minTextChange || 50;
    sceneMinTextChangeValue.textContent = effectiveSceneSettings.minTextChange || 50;
    scenePromptTemperature.value = effectiveSceneSettings.promptTemperature || 0.7;
    scenePromptTemperatureValue.textContent = effectiveSceneSettings.promptTemperature || 0.7;
    sceneSuggestionStyle.value = effectiveSceneSettings.suggestionStyle || 'mixed';
    sceneSuggestionTemperature.value = effectiveSceneSettings.suggestionTemperature || 0.6;
    sceneSuggestionTemperatureValue.textContent = effectiveSceneSettings.suggestionTemperature || 0.6;
    sceneEnableLitrpg.checked = !!(state.litrpgState && state.litrpgState.enabled);

    // Provider
    providerSelect.value = effectiveProvider || 'novelai';
    updateProviderSections();

    // Perchance key status
    if (keyStatus.hasKey) {
      perchanceKeyDot.className = 'dot active';
      perchanceKeyText.textContent = 'Key active: ' + keyStatus.preview;
    } else {
      perchanceKeyDot.className = 'dot inactive';
      perchanceKeyText.textContent = keyStatus.expired ? 'Key expired — extract a new one' : 'No key extracted';
    }

    // Perchance settings
    perchanceArtStyleSelect.value = perchanceSettings.artStyle || 'no-style';
    perchanceGuidanceSlider.value = perchanceSettings.guidanceScale || 7;
    perchanceGuidanceValue.textContent = perchanceSettings.guidanceScale || 7;

    // NovelAI art style
    novelaiArtStyleSelect.value = effectiveArtStyle || 'no-style';

    // Venice AI settings
    if (veniceKeyStatus.hasKey) {
      veniceKeyDot.className = 'dot active';
      veniceKeyText.textContent = 'API key configured';
    } else {
      veniceKeyDot.className = 'dot inactive';
      veniceKeyText.textContent = 'No API key';
    }
    veniceApiKeyInput.value = '';
    veniceApiKeyInput.placeholder = veniceKeyStatus.hasKey ? 'Key configured (enter new to replace)' : 'Venice AI API key';
    veniceStepsInput.value = veniceSettings.steps || 25;
    veniceCfgScaleInput.value = veniceSettings.cfgScale || 7;
    veniceSafeModeCheckbox.checked = veniceSettings.safeMode || false;
    veniceHideWatermarkCheckbox.checked = veniceSettings.hideWatermark !== false;
    // Load Venice models and styles (async, populates dropdowns)
    await loadVeniceModels();
    veniceModelSelect.value = veniceSettings.model || 'flux-2-max';
    await loadVeniceStyles();
    veniceStylePresetSelect.value = veniceSettings.stylePreset || '';
    // Video settings
    await loadVeniceVideoModels();
    veniceVideoModelSelect.value = veniceSettings.videoModel || '';
    veniceVideoDurationSelect.value = veniceSettings.videoDuration || '5s';
    veniceVideoResolutionSelect.value = veniceSettings.videoResolution || '720p';
    // Balance display in settings
    showVeniceSettingsBalance();

    // Puter.js settings
    await loadPuterModels();
    puterModelSelect.value = puterSettings.model || 'dall-e-3';
    puterQualitySelect.value = puterSettings.quality || 'standard';
    updatePuterQualityVisibility();

    // NovelAI token status
    const tokenStatus = await window.sceneVisualizer.getTokenStatus();
    if (tokenStatus.hasToken) {
      novelaiTokenDot.className = 'dot active';
      novelaiTokenText.textContent = 'Token active (auto-captured from login)';
    } else {
      novelaiTokenDot.className = 'dot inactive';
      novelaiTokenText.textContent = 'No token — log in to NovelAI';
    }

    // NovelAI credentials (show placeholder if .env has them)
    const creds = await window.sceneVisualizer.getNovelaiCredentials();
    novelaiEmailInput.value = '';
    novelaiPasswordInput.value = '';
    if (creds.hasCredentials) {
      novelaiEmailInput.placeholder = 'Configured (enter new to replace)';
      novelaiPasswordInput.placeholder = 'Configured (enter new to replace)';
    } else {
      novelaiEmailInput.placeholder = 'Email (or set NOVELAI_EMAIL in .env)';
      novelaiPasswordInput.placeholder = 'Password (or set NOVELAI_PASSWORD in .env)';
    }

    // API Token
    document.getElementById('apiToken').value = '';
    document.getElementById('apiToken').placeholder = token ? 'Token configured (enter new to replace)' : 'Enter your persistent API token';

    // Model
    modelSelect.value = effectiveSettings.model || 'nai-diffusion-4-curated-preview';

    // Resolution
    imgWidth.value = effectiveSettings.width || 832;
    imgHeight.value = effectiveSettings.height || 1216;

    // Find matching preset
    const matchingPreset = Object.entries(RESOLUTION_PRESETS).find(
      ([, p]) => p.width === effectiveSettings.width && p.height === effectiveSettings.height
    );
    resolutionPreset.value = matchingPreset ? matchingPreset[0] : 'custom';

    // Generation parameters
    samplerSelect.value = effectiveSettings.sampler || 'k_euler';
    noiseScheduleSelect.value = effectiveSettings.noiseSchedule || 'karras';
    stepsInput.value = effectiveSettings.steps || 28;
    scaleInput.value = effectiveSettings.scale || 5;
    cfgRescaleSlider.value = effectiveSettings.cfgRescale || 0;
    cfgRescaleValue.textContent = effectiveSettings.cfgRescale || 0;

    // V3 options (SMEA)
    smeaCheckbox.checked = effectiveSettings.smea || false;
    smeaDynCheckbox.checked = effectiveSettings.smeaDyn || false;

    // Quality options
    ucPresetSelect.value = effectiveSettings.ucPreset || 'heavy';
    qualityTagsCheckbox.checked = effectiveSettings.qualityTags !== false; // Default true

    // Update V3 options visibility
    updateV3Options();

    settingsModal.classList.add('active');
  });

  cancelBtn.addEventListener('click', () => {
    settingsModal.classList.remove('active');
  });

  saveBtn.addEventListener('click', async () => {
    // TTS settings (wrapped — must not abort settings save on failure)
    try {
      const curTtsVersion = ttsVersionSelect.value;
      await window.sceneVisualizer.ttsSetSettings({
        ttsProvider: ttsProviderSelect.value,
        ttsVersion: curTtsVersion,
        ttsNarratorVoice: buildVoiceValue(ttsNarratorVoiceSelect, ttsNarratorStyle, ttsNarratorIntonation, ttsNarratorCadence, curTtsVersion, ttsNarratorCustomSeed),
        ttsDialogueVoice: buildVoiceValue(ttsDialogueVoiceSelect, ttsDialogueStyle, ttsDialogueIntonation, ttsDialogueCadence, curTtsVersion, ttsDialogueCustomSeed),
        ttsSpeed: parseFloat(ttsSpeedSlider.value),
        ttsFirstPerson: ttsFirstPersonCheckbox.checked,
      });
    } catch (e) {
      console.error('[Settings] TTS save error:', e);
    }

    // Text LLM / Pipeline settings (wrapped — must not abort settings save on failure)
    try {
      const textLlmPayload = {
        pipelineVersion: parseInt(scenePipelineVersion.value),
        secondaryLlm: sceneSecondaryLlm.value,
        openaiModel: textLlmOpenaiModel.value.trim() || 'gpt-4o-mini',
        anthropicModel: textLlmAnthropicModel.value.trim() || 'claude-sonnet-4-20250514',
      };
      const openaiKey = textLlmOpenaiKey.value.trim();
      if (openaiKey) textLlmPayload.openaiApiKey = openaiKey;
      const anthropicKey = textLlmAnthropicKey.value.trim();
      if (anthropicKey) textLlmPayload.anthropicApiKey = anthropicKey;
      await window.sceneVisualizer.textLlmSetSettings(textLlmPayload);
      // Update Ollama model via lore LLM provider (authoritative store key)
      if (textLlmOllamaModelSelect.value) {
        await window.sceneVisualizer.loreSetLlmProvider({ ollamaModel: textLlmOllamaModelSelect.value });
      }
    } catch (e) {
      console.error('[Settings] Text LLM save error:', e);
    }

    // Scene settings
    await window.sceneVisualizer.setSceneSettings({
      autoGeneratePrompts: sceneAutoGenerate.checked,
      useCharacterLore: sceneUseCharacterLore.checked,
      artStyleTags: sceneArtStyleTags.value.trim(),
      minTextChange: parseInt(sceneMinTextChange.value),
      promptTemperature: parseFloat(scenePromptTemperature.value),
      suggestionStyle: sceneSuggestionStyle.value,
      suggestionTemperature: parseFloat(sceneSuggestionTemperature.value),
    });

    // LitRPG toggle
    if (state.currentStoryId) {
      const wantEnabled = sceneEnableLitrpg.checked;
      const wasEnabled = !!(state.litrpgState && state.litrpgState.enabled);
      if (wantEnabled !== wasEnabled) {
        if (!state.litrpgState) state.litrpgState = {};
        state.litrpgState.enabled = wantEnabled;
        if (wantEnabled) {
          state.litrpgState.detected = true;
          state.litrpgState.dismissedDetection = false;
        }
        state.litrpgEnabled = wantEnabled;
        await window.sceneVisualizer.litrpgSetState(state.currentStoryId, state.litrpgState);
        refreshRpgUI();
      }
    }

    // Provider
    await window.sceneVisualizer.setProvider(providerSelect.value);

    // NovelAI credentials
    const email = novelaiEmailInput.value.trim();
    const password = novelaiPasswordInput.value;
    if (email || password) {
      await window.sceneVisualizer.setNovelaiCredentials({
        ...(email && { email }),
        ...(password && { password }),
      });
    }

    // NovelAI token
    const token = document.getElementById('apiToken').value;
    if (token) {
      await window.sceneVisualizer.setApiToken(token);
    }

    // NovelAI art style
    await window.sceneVisualizer.setNovelaiArtStyle(novelaiArtStyleSelect.value);

    // Perchance settings
    await window.sceneVisualizer.setPerchanceSettings({
      artStyle: perchanceArtStyleSelect.value,
      guidanceScale: parseFloat(perchanceGuidanceSlider.value),
    });

    // Venice AI settings
    await window.sceneVisualizer.setVeniceSettings({
      model: veniceModelSelect.value,
      steps: parseInt(veniceStepsInput.value),
      cfgScale: parseFloat(veniceCfgScaleInput.value),
      stylePreset: veniceStylePresetSelect.value,
      safeMode: veniceSafeModeCheckbox.checked,
      hideWatermark: veniceHideWatermarkCheckbox.checked,
      videoModel: veniceVideoModelSelect.value,
      videoDuration: veniceVideoDurationSelect.value,
      videoResolution: veniceVideoResolutionSelect.value,
    });

    // Venice API key (only if entered)
    const veniceKey = veniceApiKeyInput.value.trim();
    if (veniceKey) {
      await window.sceneVisualizer.setVeniceApiKey(veniceKey);
      veniceApiKeyInput.value = '';
    }

    // Puter.js settings
    await window.sceneVisualizer.setPuterSettings({
      model: puterModelSelect.value,
      quality: puterQualitySelect.value,
    });

    await window.sceneVisualizer.setImageSettings({
      // Model
      model: modelSelect.value,
      // Resolution
      width: parseInt(imgWidth.value),
      height: parseInt(imgHeight.value),
      // Generation parameters
      sampler: samplerSelect.value,
      noiseSchedule: noiseScheduleSelect.value,
      steps: parseInt(stepsInput.value),
      scale: parseFloat(scaleInput.value),
      cfgRescale: parseFloat(cfgRescaleSlider.value),
      // V3 options
      smea: smeaCheckbox.checked,
      smeaDyn: smeaDynCheckbox.checked,
      // Quality options
      ucPreset: ucPresetSelect.value,
      qualityTags: qualityTagsCheckbox.checked
    });

    // Save per-story settings (TTS config, image, scene) when a story is active
    if (state.currentStoryId) {
      const perStoryTtsVersion = ttsVersionSelect.value;
      const perStory = {
        ttsProvider: ttsProviderSelect.value,
        ttsVersion: perStoryTtsVersion,
        ttsNarratorVoice: buildVoiceValue(ttsNarratorVoiceSelect, ttsNarratorStyle, ttsNarratorIntonation, ttsNarratorCadence, perStoryTtsVersion, ttsNarratorCustomSeed),
        ttsDialogueVoice: buildVoiceValue(ttsDialogueVoiceSelect, ttsDialogueStyle, ttsDialogueIntonation, ttsDialogueCadence, perStoryTtsVersion, ttsDialogueCustomSeed),
        ttsSpeed: parseFloat(ttsSpeedSlider.value),
        ttsFirstPerson: ttsFirstPersonCheckbox.checked,
        imageProvider: providerSelect.value,
        imageSettings: {
          model: modelSelect.value,
          width: parseInt(imgWidth.value),
          height: parseInt(imgHeight.value),
          sampler: samplerSelect.value,
          noiseSchedule: noiseScheduleSelect.value,
          steps: parseInt(stepsInput.value),
          scale: parseFloat(scaleInput.value),
          cfgRescale: parseFloat(cfgRescaleSlider.value),
          smea: smeaCheckbox.checked,
          smeaDyn: smeaDynCheckbox.checked,
          ucPreset: ucPresetSelect.value,
          qualityTags: qualityTagsCheckbox.checked,
        },
        novelaiArtStyle: novelaiArtStyleSelect.value,
        sceneSettings: {
          autoGeneratePrompts: sceneAutoGenerate.checked,
          useCharacterLore: sceneUseCharacterLore.checked,
          artStyleTags: sceneArtStyleTags.value.trim(),
          minTextChange: parseInt(sceneMinTextChange.value),
          promptTemperature: parseFloat(scenePromptTemperature.value),
          suggestionStyle: sceneSuggestionStyle.value,
          suggestionTemperature: parseFloat(sceneSuggestionTemperature.value),
        },
      };
      await window.sceneVisualizer.storySettingsSet(state.currentStoryId, perStory);
      state.storySettings = perStory;
    }

    settingsModal.classList.remove('active');
    status.textContent = 'Settings saved';
    status.className = 'status connected';
    bus.emit('settings:saved');
    setTimeout(() => {
      status.textContent = 'Connected';
      status.className = 'status connected';
    }, 2000);
  });

  reloadBtn.addEventListener('click', () => {
    webview.reload();
  });

  document.getElementById('hardReloadBtn').addEventListener('click', async () => {
    status.textContent = 'Clearing cache...';
    status.className = 'status generating';
    try {
      await window.sceneVisualizer.clearWebviewCache();
      webview.reloadIgnoringCache();
      status.textContent = 'Cache cleared, reloading...';
      status.className = 'status connected';
    } catch (e) {
      console.error('[Renderer] Hard reload error:', e);
      webview.reloadIgnoringCache();
    }
  });

  // Close modal on escape (also storyboard modal)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      settingsModal.classList.remove('active');
      document.getElementById('storyboardModal').classList.remove('active');
    }
  });

  // Listen for token status changes
  window.sceneVisualizer.onTokenStatusChanged((data) => {
    console.log('[Renderer] Token status changed:', data);
    status.textContent = 'Token captured';
    status.className = 'status connected';
    setTimeout(() => {
      if (status.textContent === 'Token captured') {
        status.textContent = 'Connected';
      }
    }, 3000);
  });

  // Toggle panel
  document.getElementById('togglePanelBtn').addEventListener('click', () => {
    document.getElementById('imagePanel').classList.toggle('hidden');
  });

  document.getElementById('closePanelBtn').addEventListener('click', () => {
    document.getElementById('imagePanel').classList.add('hidden');
  });
}

// litrpg-panel.js — LitRPG RPG tab: stat sheets, quest log, party view, NPC registry

import { state, bus } from './state.js';
import {
  rpgTab, rpgContent,
  rpgDetectionBanner, rpgEnableBtn, rpgDismissBtn,
  rpgSystemIndicator, rpgSystemType,
  rpgScanBtn, rpgSyncLorebookBtn,
  rpgScanStatus, rpgScanPhase,
  rpgPartyList, rpgPartyCount,
  rpgQuestListActive, rpgQuestListDone, rpgQuestCount,
  rpgNpcList, rpgNpcCount,
  rpgUpdatesList, rpgUpdatesSection, rpgUpdatesCount,
  rpgAutoScan, rpgAutoSync, rpgDisableBtn,
  webview,
} from './dom-refs.js';
import { escapeHtml, showToast } from './utils.js';

// =========================================================================
// STATE HELPERS
// =========================================================================

function getRpgState() {
  return state.litrpgState || {};
}

function saveLitrpgState() {
  if (!state.currentStoryId || !state.litrpgState) return;
  window.sceneVisualizer.litrpgSetState(state.currentStoryId, state.litrpgState);
}

// =========================================================================
// UI REFRESH
// =========================================================================

export function refreshRpgUI() {
  const rpg = getRpgState();

  // Tab visibility
  if (rpgTab) {
    rpgTab.style.display = (rpg.enabled || rpg.detected) ? '' : 'none';
  }

  // Detection banner
  if (rpgDetectionBanner) {
    rpgDetectionBanner.style.display = (rpg.detected && !rpg.enabled && !rpg.dismissedDetection) ? '' : 'none';
  }

  // System indicator
  if (rpgSystemIndicator && rpgSystemType) {
    if (rpg.enabled && rpg.systemType) {
      rpgSystemIndicator.style.display = '';
      const typeLabels = {
        generic: 'Generic RPG', dnd: 'D&D Style', cultivation: 'Cultivation',
        gamelit: 'GameLit', mmorpg: 'MMORPG', survival: 'Survival',
      };
      rpgSystemType.textContent = `System: ${typeLabels[rpg.systemType] || rpg.systemType}`;
    } else {
      rpgSystemIndicator.style.display = 'none';
    }
  }

  // Scan/sync buttons visibility
  if (rpgScanBtn) rpgScanBtn.disabled = !rpg.enabled || state.litrpgScanning;
  if (rpgSyncLorebookBtn) rpgSyncLorebookBtn.disabled = !rpg.enabled;

  // Party view
  renderParty(rpg);

  // Quest log
  renderQuests(rpg);

  // NPC registry
  renderNPCs(rpg);

  // Pending updates
  renderPendingUpdates(rpg);
}

// =========================================================================
// PARTY RENDERING
// =========================================================================

function renderParty(rpg) {
  if (!rpgPartyList) return;
  const partyMembers = (rpg.party?.members || [])
    .map(id => rpg.characters?.[id])
    .filter(Boolean);

  rpgPartyCount.textContent = `(${partyMembers.length})`;

  if (partyMembers.length === 0) {
    rpgPartyList.innerHTML = '<div style="font-size:11px;color:#666;padding:4px;">No party members detected yet.</div>';
    return;
  }

  rpgPartyList.innerHTML = partyMembers.map(char => `
    <div class="rpg-character-card" data-char-id="${escapeHtml(char.id)}">
      <div class="rpg-portrait">
        ${char.portraitPath
          ? `<img src="data:image/png;base64,${char._thumbnailData || ''}" alt="${escapeHtml(char.name)}">`
          : `<span class="rpg-portrait-placeholder">&#9876;</span>`}
      </div>
      <div class="rpg-char-info">
        <div class="rpg-char-name">${escapeHtml(char.name)}</div>
        <div class="rpg-char-class">${char.level ? `Lv.${char.level} ` : ''}${escapeHtml(char.class || 'Unknown Class')}</div>
      </div>
    </div>
  `).join('');

  // Click handlers for stat sheet expansion
  rpgPartyList.querySelectorAll('.rpg-character-card').forEach(card => {
    card.addEventListener('click', () => toggleStatSheet(card, rpg));
  });
}

function toggleStatSheet(card, rpg) {
  const charId = card.dataset.charId;
  const existing = card.querySelector('.rpg-stat-sheet');
  if (existing) {
    existing.remove();
    return;
  }

  const char = rpg.characters?.[charId];
  if (!char) return;

  const statSheet = document.createElement('div');
  statSheet.className = 'rpg-stat-sheet';
  statSheet.innerHTML = buildStatSheetHTML(char);
  card.appendChild(statSheet);

  // Portrait actions
  const genBtn = statSheet.querySelector('.rpg-portrait-generate');
  const uploadBtn = statSheet.querySelector('.rpg-portrait-upload');
  if (genBtn) genBtn.addEventListener('click', (e) => { e.stopPropagation(); generatePortrait(charId); });
  if (uploadBtn) uploadBtn.addEventListener('click', (e) => { e.stopPropagation(); uploadPortrait(charId); });
}

function buildStatSheetHTML(char) {
  const statsHTML = Object.entries(char.stats || {}).map(([name, s]) =>
    `<div class="rpg-stat"><span class="stat-name">${escapeHtml(name)}</span><span class="stat-value">${s.value}${s.modifier != null ? ` (${s.modifier >= 0 ? '+' : ''}${s.modifier})` : ''}</span></div>`
  ).join('');

  const abilitiesHTML = (char.abilities || []).map(a =>
    `<div class="rpg-ability">${escapeHtml(a.name)}${a.level ? ` (Lv.${a.level})` : ''} — ${escapeHtml(a.description || '')}${a.cost ? ` [${escapeHtml(a.cost)}]` : ''}</div>`
  ).join('');

  const equipmentHTML = (char.equipment || []).map(e =>
    `<div class="rpg-equip-item">${escapeHtml(e.name)} [${escapeHtml(e.slot || 'other')}] — ${escapeHtml(e.description || '')}</div>`
  ).join('');

  return `
    <div class="rpg-stat-header">
      <div class="rpg-portrait-large">
        ${char.portraitPath
          ? `<img src="data:image/png;base64,${char._portraitData || ''}" alt="${escapeHtml(char.name)}">`
          : `<span style="font-size:24px;color:#666;">&#9876;</span>`}
        <div class="rpg-portrait-actions">
          <button class="rpg-portrait-generate" title="Generate Portrait">Gen</button>
          <button class="rpg-portrait-upload" title="Upload Portrait">Up</button>
        </div>
      </div>
      <div>
        <h3>${escapeHtml(char.name)}</h3>
        <div style="font-size:11px;color:var(--cat-rpg);">${char.level ? `Level ${char.level} ` : ''}${escapeHtml(char.class || '')}${char.subclass ? ` / ${escapeHtml(char.subclass)}` : ''}${char.race ? ` (${escapeHtml(char.race)})` : ''}</div>
      </div>
    </div>
    ${statsHTML ? `<div class="rpg-stat-grid">${statsHTML}</div>` : ''}
    ${abilitiesHTML ? `<div class="rpg-abilities"><h4>Abilities</h4>${abilitiesHTML}</div>` : ''}
    ${equipmentHTML ? `<div class="rpg-equipment"><h4>Equipment</h4>${equipmentHTML}</div>` : ''}
  `;
}

// =========================================================================
// QUEST RENDERING
// =========================================================================

function renderQuests(rpg) {
  if (!rpgQuestListActive || !rpgQuestListDone) return;
  const quests = Object.values(rpg.quests || {});
  const active = quests.filter(q => q.status === 'active');
  const done = quests.filter(q => q.status !== 'active');

  rpgQuestCount.textContent = `(${active.length} active)`;

  if (active.length === 0) {
    rpgQuestListActive.innerHTML = '<div style="font-size:11px;color:#666;padding:4px;">No active quests.</div>';
  } else {
    rpgQuestListActive.innerHTML = active.map(q => buildQuestCardHTML(q)).join('');
  }

  rpgQuestListDone.innerHTML = done.length === 0
    ? '<div style="font-size:11px;color:#666;padding:4px;">None yet.</div>'
    : done.map(q => buildQuestCardHTML(q)).join('');
}

function buildQuestCardHTML(quest) {
  const objectives = (quest.objectives || []).map(o =>
    `<div class="rpg-objective${o.completed ? ' completed' : ''}">${escapeHtml(o.text)}</div>`
  ).join('');

  const meta = [
    quest.giver ? `Giver: ${escapeHtml(quest.giver)}` : null,
    quest.rewards ? `Reward: ${escapeHtml(quest.rewards)}` : null,
  ].filter(Boolean).join(' | ');

  return `
    <div class="rpg-quest-card ${quest.status}">
      <div class="rpg-quest-header">
        <span class="rpg-quest-type ${quest.type || 'side'}">${escapeHtml((quest.type || 'side').toUpperCase())}</span>
        <span class="rpg-quest-title">${escapeHtml(quest.title)}</span>
      </div>
      ${quest.description ? `<div class="rpg-quest-desc">${escapeHtml(quest.description)}</div>` : ''}
      ${objectives ? `<div class="rpg-quest-objectives">${objectives}</div>` : ''}
      ${meta ? `<div class="rpg-quest-meta">${meta}</div>` : ''}
    </div>
  `;
}

// =========================================================================
// NPC RENDERING
// =========================================================================

function renderNPCs(rpg) {
  if (!rpgNpcList) return;
  const npcs = Object.values(rpg.characters || {}).filter(c => c.isNPC);
  rpgNpcCount.textContent = `(${npcs.length})`;

  if (npcs.length === 0) {
    rpgNpcList.innerHTML = '<div style="font-size:11px;color:#666;padding:4px;">No NPCs tracked yet.</div>';
    return;
  }

  rpgNpcList.innerHTML = npcs.map(npc => `
    <div class="rpg-npc-card">
      <span class="rpg-npc-name">${escapeHtml(npc.name)}${npc.level ? ` (Lv.${npc.level})` : ''}${npc.class ? ` — ${escapeHtml(npc.class)}` : ''}</span>
      ${npc.faction ? `<span style="font-size:9px;color:var(--cat-faction);">${escapeHtml(npc.faction)}</span>` : ''}
      <span class="rpg-disposition ${npc.disposition || 'unknown'}">${escapeHtml((npc.disposition || 'unknown').toUpperCase())}</span>
    </div>
  `).join('');
}

// =========================================================================
// PENDING UPDATES RENDERING
// =========================================================================

function renderPendingUpdates(rpg) {
  if (!rpgUpdatesList || !rpgUpdatesSection) return;
  const updates = rpg.pendingUpdates || [];
  rpgUpdatesCount.textContent = `(${updates.length})`;
  rpgUpdatesSection.style.display = updates.length > 0 ? '' : 'none';

  if (updates.length === 0) return;

  rpgUpdatesList.innerHTML = updates.map(update => {
    let desc = '';
    if (update.type === 'character') {
      const changes = [];
      if (update.before.level !== update.after.level) changes.push(`Level ${update.before.level || '?'} → ${update.after.level}`);
      if (update.before.class !== update.after.class) changes.push(`Class: ${update.after.class}`);
      const newAbilities = (update.after.abilities || []).length - (update.before.abilities || []).length;
      if (newAbilities > 0) changes.push(`+${newAbilities} abilities`);
      desc = `${escapeHtml(update.characterName)}: ${changes.join(', ') || 'Stats changed'}`;
    } else if (update.type === 'quest_status') {
      desc = `Quest "${escapeHtml(update.questTitle)}": ${update.oldStatus} → ${update.newStatus}`;
    } else if (update.type === 'quest_objective') {
      desc = `Quest "${escapeHtml(update.questTitle)}": objective completed — ${escapeHtml(update.objectiveText)}`;
    }

    return `
      <div class="rpg-update-card" data-update-id="${escapeHtml(update.id)}">
        <div class="update-type">${escapeHtml(update.type.replace('_', ' '))}</div>
        <div class="update-desc">${desc}</div>
        <div class="update-actions">
          <button class="btn-accept rpg-accept-update" style="font-size:10px;padding:2px 8px;">Accept</button>
          <button class="btn-reject rpg-reject-update" style="font-size:10px;padding:2px 8px;">Reject</button>
        </div>
      </div>
    `;
  }).join('');

  // Wire accept/reject buttons
  rpgUpdatesList.querySelectorAll('.rpg-accept-update').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.rpg-update-card');
      const updateId = card.dataset.updateId;
      const result = await window.sceneVisualizer.litrpgAcceptUpdate(state.currentStoryId, updateId);
      if (result.success) {
        state.litrpgState = result.state;
        refreshRpgUI();
        showToast('Update accepted');
      }
    });
  });

  rpgUpdatesList.querySelectorAll('.rpg-reject-update').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.rpg-update-card');
      const updateId = card.dataset.updateId;
      const result = await window.sceneVisualizer.litrpgRejectUpdate(state.currentStoryId, updateId);
      if (result.success) {
        state.litrpgState = result.state;
        refreshRpgUI();
      }
    });
  });
}

// =========================================================================
// PORTRAIT ACTIONS
// =========================================================================

async function generatePortrait(charId) {
  if (!state.currentStoryId) return;
  const rpg = getRpgState();
  const char = rpg.characters?.[charId];
  if (!char) return;

  showToast('Generating portrait...');
  try {
    const result = await window.sceneVisualizer.portraitGenerate(
      state.currentStoryId, charId, char.loreEntryName, char
    );
    if (result.success) {
      char.portraitPath = true; // Mark as having a portrait
      char._portraitData = result.imageData;
      char._thumbnailData = result.thumbnailData;
      saveLitrpgState();
      refreshRpgUI();
      showToast('Portrait generated!');
    }
  } catch (err) {
    showToast('Portrait generation failed');
  }
}

async function uploadPortrait(charId) {
  if (!state.currentStoryId) return;
  try {
    const result = await window.sceneVisualizer.portraitUpload(state.currentStoryId, charId);
    if (result.success) {
      const rpg = getRpgState();
      const char = rpg.characters?.[charId];
      if (char) {
        char.portraitPath = true;
        char._portraitData = result.imageData;
        saveLitrpgState();
        refreshRpgUI();
        showToast('Portrait uploaded!');
      }
    }
  } catch (err) {
    showToast('Portrait upload failed');
  }
}

// =========================================================================
// ACTIONS
// =========================================================================

async function runRpgScan() {
  if (!state.currentStoryId || state.litrpgScanning) return;
  state.litrpgScanning = true;
  if (rpgScanStatus) rpgScanStatus.style.display = '';
  if (rpgScanPhase) rpgScanPhase.textContent = 'Starting RPG scan...';
  if (rpgScanBtn) rpgScanBtn.disabled = true;

  try {
    // Get story text from webview
    let storyText = '';
    try {
      storyText = await webview.executeJavaScript(`
        (function() {
          const el = document.querySelector('#scene-vis-story-text');
          return el ? el.textContent : '';
        })()
      `);
    } catch (_) { /* fallback empty */ }

    // Get lore entries
    let loreEntries = [];
    try {
      loreEntries = await webview.executeJavaScript(`
        (function() {
          if (window.__loreCreator && window.__loreCreator.getEntries) {
            return window.__loreCreator.getEntries();
          }
          return [];
        })()
      `);
    } catch (_) { /* fallback empty */ }

    const result = await window.sceneVisualizer.litrpgScan(storyText, state.currentStoryId, loreEntries);
    if (result.success) {
      state.litrpgState = result.state;
      refreshRpgUI();
      showToast('RPG scan complete');
    } else {
      showToast(`RPG scan failed: ${result.error}`);
    }
  } catch (err) {
    showToast('RPG scan error');
    console.error('[LitRPG] Scan error:', err);
  } finally {
    state.litrpgScanning = false;
    if (rpgScanStatus) rpgScanStatus.style.display = 'none';
    if (rpgScanBtn) rpgScanBtn.disabled = false;
  }
}

async function syncToLorebook() {
  const rpg = getRpgState();
  if (!rpg.enabled) return;

  const characters = Object.values(rpg.characters || {});
  let synced = 0;

  for (const char of characters) {
    if (!char.class && !char.level && Object.keys(char.stats || {}).length === 0) continue;

    try {
      // Get current lorebook entry text
      const entries = await webview.executeJavaScript(`
        (function() {
          if (window.__loreCreator && window.__loreCreator.getEntries) {
            return window.__loreCreator.getEntries().filter(e => e.displayName === ${JSON.stringify(char.loreEntryName)});
          }
          return [];
        })()
      `);

      if (entries.length === 0) continue;
      const entry = entries[0];

      const updatedText = await window.sceneVisualizer.litrpgBuildLorebookText(entry.text, char);

      await webview.executeJavaScript(`
        (function() {
          if (window.__loreCreator && window.__loreCreator.updateEntry) {
            window.__loreCreator.updateEntry({
              displayName: ${JSON.stringify(char.loreEntryName)},
              text: ${JSON.stringify(updatedText)}
            });
          }
        })()
      `);
      synced++;
    } catch (err) {
      console.error(`[LitRPG] Sync failed for ${char.name}:`, err);
    }
  }

  showToast(synced > 0 ? `Synced ${synced} character${synced > 1 ? 's' : ''} to lorebook` : 'No characters to sync');
}

async function enableLitRPG() {
  if (!state.litrpgState) state.litrpgState = {};
  state.litrpgState.enabled = true;
  state.litrpgState.dismissedDetection = false;
  state.litrpgEnabled = true;
  saveLitrpgState();
  refreshRpgUI();
  showToast('LitRPG tracking enabled!');
}

function dismissDetection() {
  if (!state.litrpgState) state.litrpgState = {};
  state.litrpgState.dismissedDetection = true;
  saveLitrpgState();
  refreshRpgUI();
}

function disableLitRPG() {
  if (!state.litrpgState) return;
  state.litrpgState.enabled = false;
  state.litrpgEnabled = false;
  saveLitrpgState();
  refreshRpgUI();
  showToast('LitRPG tracking disabled');
}

// =========================================================================
// IPC LISTENERS
// =========================================================================

function setupIPCListeners() {
  window.sceneVisualizer.onLitrpgScanProgress((progress) => {
    if (rpgScanPhase) {
      const phaseLabels = {
        characters: 'Extracting character RPG data',
        quests: 'Scanning for quests',
        party: 'Classifying party & NPCs',
        complete: 'Scan complete',
      };
      rpgScanPhase.textContent = phaseLabels[progress.phase] || progress.phase;
      if (progress.current != null && progress.total) {
        rpgScanPhase.textContent += ` (${progress.current}/${progress.total})`;
      }
    }
  });

  window.sceneVisualizer.onLitrpgStateUpdated((newState) => {
    state.litrpgState = newState;
    state.litrpgEnabled = newState.enabled;
    refreshRpgUI();
  });

  window.sceneVisualizer.onLitrpgDetected(({ systemType }) => {
    if (!state.litrpgState) state.litrpgState = {};
    state.litrpgState.detected = true;
    state.litrpgState.systemType = systemType;
    // Show the RPG tab and detection banner
    if (rpgTab) rpgTab.style.display = '';
    refreshRpgUI();
    showToast(`LitRPG story detected (${systemType})!`);
  });
}

// =========================================================================
// STORY SWITCH HANDLER
// =========================================================================

function onStorySwitch() {
  // Called when story data is loaded — update RPG state
  const rpg = state.litrpgState || {};
  state.litrpgEnabled = !!rpg.enabled;
  refreshRpgUI();
}

// =========================================================================
// INIT
// =========================================================================

export function init() {
  // Button handlers
  if (rpgEnableBtn) rpgEnableBtn.addEventListener('click', enableLitRPG);
  if (rpgDismissBtn) rpgDismissBtn.addEventListener('click', dismissDetection);
  if (rpgScanBtn) rpgScanBtn.addEventListener('click', runRpgScan);
  if (rpgSyncLorebookBtn) rpgSyncLorebookBtn.addEventListener('click', syncToLorebook);
  if (rpgDisableBtn) rpgDisableBtn.addEventListener('click', disableLitRPG);

  // IPC listeners
  setupIPCListeners();

  // Listen for story switch events
  bus.on('story:changed', onStorySwitch);
}

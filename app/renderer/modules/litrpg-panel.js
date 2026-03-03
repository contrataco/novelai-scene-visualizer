// litrpg-panel.js — LitRPG RPG tab: stat sheets, quest log, party view, NPC registry, inventory, currency, status effects

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
  rpgAcceptAllBtn, rpgRejectAllBtn,
  rpgNpcSearch,
  rpgInventoryList, rpgCurrencyList, rpgStatusEffectsList,
  rpgStatOverlay, rpgStatOverlayContent, rpgStatOverlayClose,
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

  // Settings persistence (Phase 5A)
  if (rpgAutoScan) rpgAutoScan.checked = rpg.autoScan !== false;
  if (rpgAutoSync) rpgAutoSync.checked = !!rpg.autoSync;

  // Party view
  renderParty(rpg);

  // Quest log
  renderQuests(rpg);

  // NPC registry
  renderNPCs(rpg);

  // Pending updates
  renderPendingUpdates(rpg);

  // New sections (Phase 5G)
  renderInventory(rpg);
  renderCurrency(rpg);
  renderStatusEffects(rpg);
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
        <div class="rpg-char-class">${char.level ? `Lv.${char.level} ` : ''}${escapeHtml(char.class || 'Unknown Class')}${char.role ? ` (${escapeHtml(char.role)})` : ''}</div>
      </div>
    </div>
  `).join('');

  // Click handlers for stat sheet overlay (Phase 5H)
  rpgPartyList.querySelectorAll('.rpg-character-card').forEach(card => {
    card.addEventListener('click', () => openStatOverlay(card.dataset.charId, rpg));
  });
}

// =========================================================================
// STAT SHEET OVERLAY (Phase 5H)
// =========================================================================

function openStatOverlay(charId, rpg) {
  const char = rpg?.characters?.[charId];
  if (!char || !rpgStatOverlay || !rpgStatOverlayContent) return;

  rpgStatOverlayContent.innerHTML = buildStatSheetHTML(char);
  rpgStatOverlay.style.display = 'flex';
  rpgStatOverlay.dataset.charId = charId;

  // Wire edit / portrait buttons inside overlay
  const editBtn = rpgStatOverlayContent.querySelector('.rpg-stat-edit-btn');
  const saveBtn = rpgStatOverlayContent.querySelector('.rpg-stat-save-btn');
  const cancelBtn = rpgStatOverlayContent.querySelector('.rpg-stat-cancel-btn');
  const genBtn = rpgStatOverlayContent.querySelector('.rpg-portrait-generate');
  const uploadBtn = rpgStatOverlayContent.querySelector('.rpg-portrait-upload');
  const deleteBtn = rpgStatOverlayContent.querySelector('.rpg-char-delete-btn');

  if (editBtn) editBtn.addEventListener('click', () => enterEditMode(charId));
  if (saveBtn) saveBtn.addEventListener('click', () => saveEdit(charId));
  if (cancelBtn) cancelBtn.addEventListener('click', () => openStatOverlay(charId, getRpgState()));
  if (genBtn) genBtn.addEventListener('click', () => generatePortrait(charId));
  if (uploadBtn) uploadBtn.addEventListener('click', () => uploadPortrait(charId));
  if (deleteBtn) deleteBtn.addEventListener('click', () => deleteCharacter(charId));
}

function closeStatOverlay() {
  if (rpgStatOverlay) rpgStatOverlay.style.display = 'none';
}

function buildStatSheetHTML(char) {
  const statsHTML = Object.entries(char.stats || {}).map(([name, s]) =>
    `<div class="rpg-stat"><span class="stat-name">${escapeHtml(name)}</span><span class="stat-value">${s.value}${s.modifier != null ? ` (${s.modifier >= 0 ? '+' : ''}${s.modifier})` : ''}</span></div>`
  ).join('');

  const abilitiesHTML = (char.abilities || []).map(a =>
    `<div class="rpg-ability">${escapeHtml(a.name)}${a.level ? ` (Lv.${a.level})` : ''} — ${escapeHtml(a.description || '')}${a.cost ? ` [${escapeHtml(a.cost)}]` : ''}</div>`
  ).join('');

  const equipmentHTML = (char.equipment || []).map(e =>
    `<div class="rpg-equip-item">${escapeHtml(e.name)} [${escapeHtml(e.slot || 'other')}]${e.rarity && e.rarity !== 'unknown' ? ` <span class="rpg-rarity rpg-rarity-${e.rarity}">${e.rarity}</span>` : ''} — ${escapeHtml(e.description || '')}</div>`
  ).join('');

  const inventoryHTML = (char.inventory || []).map(i =>
    `<div class="rpg-inv-item">${escapeHtml(i.name)} x${i.quantity || 1} <span style="color:#888;">(${i.type || 'other'})</span></div>`
  ).join('');

  const currencyHTML = Object.entries(char.currency || {}).length > 0
    ? Object.entries(char.currency).map(([unit, amount]) => `<span class="rpg-currency-tag">${amount} ${escapeHtml(unit)}</span>`).join(' ')
    : '';

  const statusHTML = (char.statusEffects || []).map(s =>
    `<span class="rpg-status-tag rpg-status-${s.type || 'buff'}">${escapeHtml(s.name)}${s.duration ? ` [${escapeHtml(s.duration)}]` : ''}</span>`
  ).join(' ');

  const xpHTML = char.xp && (char.xp.current != null || char.xp.needed != null)
    ? `<div class="rpg-xp-bar"><span style="font-size:10px;color:#aaa;">XP: ${char.xp.current ?? '?'} / ${char.xp.needed ?? '?'}</span>${char.xp.current != null && char.xp.needed ? `<div class="rpg-xp-fill" style="width:${Math.min(100, (char.xp.current / char.xp.needed) * 100)}%;"></div>` : ''}</div>`
    : '';

  const cultivationHTML = char.cultivationRealm
    ? `<div style="font-size:11px;color:#d4a574;margin-top:4px;">Cultivation: ${escapeHtml(char.cultivationRealm)}${char.cultivationStage ? ` (${escapeHtml(char.cultivationStage)})` : ''}</div>`
    : '';

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
      <div style="flex:1;">
        <h3>${escapeHtml(char.name)}</h3>
        <div style="font-size:11px;color:var(--cat-rpg);">${char.level ? `Level ${char.level} ` : ''}${escapeHtml(char.class || '')}${char.subclass ? ` / ${escapeHtml(char.subclass)}` : ''}${char.race ? ` (${escapeHtml(char.race)})` : ''}</div>
        ${cultivationHTML}
        ${xpHTML}
      </div>
      <div style="display:flex;gap:4px;">
        <button class="rpg-stat-edit-btn" title="Edit" style="font-size:10px;padding:2px 8px;background:var(--bg-input);color:#aaa;border:1px solid #444;border-radius:4px;cursor:pointer;">Edit</button>
        <button class="rpg-char-delete-btn" title="Delete" style="font-size:10px;padding:2px 8px;background:#3a1a1a;color:#ff6b6b;border:1px solid #ff6b6b;border-radius:4px;cursor:pointer;">Del</button>
      </div>
    </div>
    ${currencyHTML ? `<div style="margin:6px 0;">${currencyHTML}</div>` : ''}
    ${statusHTML ? `<div style="margin:6px 0;">${statusHTML}</div>` : ''}
    ${statsHTML ? `<div class="rpg-stat-grid">${statsHTML}</div>` : ''}
    ${abilitiesHTML ? `<div class="rpg-abilities"><h4>Abilities</h4>${abilitiesHTML}</div>` : ''}
    ${equipmentHTML ? `<div class="rpg-equipment"><h4>Equipment</h4>${equipmentHTML}</div>` : ''}
    ${inventoryHTML ? `<div class="rpg-equipment"><h4>Inventory</h4>${inventoryHTML}</div>` : ''}
  `;
}

// =========================================================================
// MANUAL STAT EDITING (Phase 5E)
// =========================================================================

function enterEditMode(charId) {
  const rpg = getRpgState();
  const char = rpg.characters?.[charId];
  if (!char || !rpgStatOverlayContent) return;

  const statsInputs = Object.entries(char.stats || {}).map(([name, s]) =>
    `<div class="rpg-stat"><span class="stat-name">${escapeHtml(name)}</span><input type="number" class="rpg-edit-stat" data-stat="${escapeHtml(name)}" value="${s.value}" style="width:50px;background:var(--bg-input);color:#fff;border:1px solid #555;border-radius:3px;padding:1px 4px;font-size:11px;"></div>`
  ).join('');

  rpgStatOverlayContent.innerHTML = `
    <div class="rpg-stat-header">
      <div style="flex:1;">
        <div style="margin-bottom:6px;">
          <label style="font-size:10px;color:#888;">Name</label>
          <input type="text" id="rpgEditName" value="${escapeHtml(char.name)}" style="width:100%;background:var(--bg-input);color:#fff;border:1px solid #555;border-radius:3px;padding:2px 6px;font-size:12px;">
        </div>
        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <div style="flex:1;">
            <label style="font-size:10px;color:#888;">Class</label>
            <input type="text" id="rpgEditClass" value="${escapeHtml(char.class || '')}" style="width:100%;background:var(--bg-input);color:#fff;border:1px solid #555;border-radius:3px;padding:2px 6px;font-size:11px;">
          </div>
          <div style="flex:1;">
            <label style="font-size:10px;color:#888;">Subclass</label>
            <input type="text" id="rpgEditSubclass" value="${escapeHtml(char.subclass || '')}" style="width:100%;background:var(--bg-input);color:#fff;border:1px solid #555;border-radius:3px;padding:2px 6px;font-size:11px;">
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <div style="flex:1;">
            <label style="font-size:10px;color:#888;">Level</label>
            <input type="number" id="rpgEditLevel" value="${char.level || ''}" style="width:100%;background:var(--bg-input);color:#fff;border:1px solid #555;border-radius:3px;padding:2px 6px;font-size:11px;">
          </div>
          <div style="flex:1;">
            <label style="font-size:10px;color:#888;">Race</label>
            <input type="text" id="rpgEditRace" value="${escapeHtml(char.race || '')}" style="width:100%;background:var(--bg-input);color:#fff;border:1px solid #555;border-radius:3px;padding:2px 6px;font-size:11px;">
          </div>
        </div>
      </div>
    </div>
    ${statsInputs ? `<div class="rpg-stat-grid">${statsInputs}</div>` : '<div style="font-size:10px;color:#666;">No stats to edit.</div>'}
    <div style="display:flex;gap:6px;margin-top:8px;">
      <button class="rpg-stat-save-btn btn-accept" style="font-size:11px;padding:4px 12px;">Save</button>
      <button class="rpg-stat-cancel-btn btn-reject" style="font-size:11px;padding:4px 12px;">Cancel</button>
    </div>
  `;

  const saveBtn = rpgStatOverlayContent.querySelector('.rpg-stat-save-btn');
  const cancelBtn = rpgStatOverlayContent.querySelector('.rpg-stat-cancel-btn');
  if (saveBtn) saveBtn.addEventListener('click', () => saveEdit(charId));
  if (cancelBtn) cancelBtn.addEventListener('click', () => openStatOverlay(charId, getRpgState()));
}

async function saveEdit(charId) {
  if (!rpgStatOverlayContent || !state.currentStoryId) return;

  const updates = {};
  const nameInput = rpgStatOverlayContent.querySelector('#rpgEditName');
  const classInput = rpgStatOverlayContent.querySelector('#rpgEditClass');
  const subclassInput = rpgStatOverlayContent.querySelector('#rpgEditSubclass');
  const levelInput = rpgStatOverlayContent.querySelector('#rpgEditLevel');
  const raceInput = rpgStatOverlayContent.querySelector('#rpgEditRace');

  if (nameInput) updates.name = nameInput.value.trim() || null;
  if (classInput) updates.class = classInput.value.trim() || null;
  if (subclassInput) updates.subclass = subclassInput.value.trim() || null;
  if (levelInput) updates.level = levelInput.value ? parseInt(levelInput.value, 10) : null;
  if (raceInput) updates.race = raceInput.value.trim() || null;

  // Collect stat edits
  const statInputs = rpgStatOverlayContent.querySelectorAll('.rpg-edit-stat');
  if (statInputs.length > 0) {
    const stats = {};
    statInputs.forEach(input => {
      const statName = input.dataset.stat;
      const val = parseInt(input.value, 10);
      if (!isNaN(val)) {
        stats[statName] = { value: val, modifier: null };
      }
    });
    updates.stats = stats;
  }

  const result = await window.sceneVisualizer.litrpgUpdateCharacter(state.currentStoryId, charId, updates);
  if (result.success) {
    state.litrpgState = result.state;
    refreshRpgUI();
    openStatOverlay(charId, getRpgState());
    showToast('Character updated');
  } else {
    showToast('Failed to save changes');
  }
}

async function deleteCharacter(charId) {
  if (!state.currentStoryId) return;
  const result = await window.sceneVisualizer.litrpgDeleteCharacter(state.currentStoryId, charId);
  if (result.success) {
    state.litrpgState = result.state;
    closeStatOverlay();
    refreshRpgUI();
    showToast('Character deleted');
  }
}

// =========================================================================
// QUEST RENDERING (Phase 5D — progress bars)
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

  // Quest progress bar (Phase 5D)
  const totalObj = (quest.objectives || []).length;
  const completedObj = (quest.objectives || []).filter(o => o.completed).length;
  const progressPct = totalObj > 0 ? Math.round((completedObj / totalObj) * 100) : 0;
  const progressBar = totalObj > 0
    ? `<div class="rpg-quest-progress"><div class="rpg-quest-progress-fill" style="width:${progressPct}%;"></div><span class="rpg-quest-progress-text">${completedObj}/${totalObj} (${progressPct}%)</span></div>`
    : '';

  return `
    <div class="rpg-quest-card ${quest.status}">
      <div class="rpg-quest-header">
        <span class="rpg-quest-type ${quest.type || 'side'}">${escapeHtml((quest.type || 'side').toUpperCase())}</span>
        <span class="rpg-quest-title">${escapeHtml(quest.title)}</span>
      </div>
      ${quest.description ? `<div class="rpg-quest-desc">${escapeHtml(quest.description)}</div>` : ''}
      ${progressBar}
      ${objectives ? `<div class="rpg-quest-objectives">${objectives}</div>` : ''}
      ${meta ? `<div class="rpg-quest-meta">${meta}</div>` : ''}
    </div>
  `;
}

// =========================================================================
// NPC RENDERING (Phase 5F — search/filter)
// =========================================================================

let npcSearchFilter = '';

function renderNPCs(rpg) {
  if (!rpgNpcList) return;
  let npcs = Object.values(rpg.characters || {}).filter(c => c.isNPC);

  // Apply search filter (Phase 5F)
  if (npcSearchFilter) {
    const q = npcSearchFilter.toLowerCase();
    npcs = npcs.filter(n =>
      n.name.toLowerCase().includes(q) ||
      (n.faction || '').toLowerCase().includes(q) ||
      (n.disposition || '').toLowerCase().includes(q) ||
      (n.npcRole || '').toLowerCase().includes(q)
    );
  }

  rpgNpcCount.textContent = `(${npcs.length})`;

  if (npcs.length === 0) {
    rpgNpcList.innerHTML = '<div style="font-size:11px;color:#666;padding:4px;">No NPCs tracked yet.</div>';
    return;
  }

  rpgNpcList.innerHTML = npcs.map(npc => `
    <div class="rpg-npc-card">
      <span class="rpg-npc-name">${escapeHtml(npc.name)}${npc.level ? ` (Lv.${npc.level})` : ''}${npc.class ? ` — ${escapeHtml(npc.class)}` : ''}</span>
      ${npc.npcRole ? `<span style="font-size:9px;color:#a0a0ff;">${escapeHtml(npc.npcRole)}</span>` : ''}
      ${npc.faction ? `<span style="font-size:9px;color:var(--cat-faction);">${escapeHtml(npc.faction)}</span>` : ''}
      <span class="rpg-disposition ${npc.disposition || 'unknown'}">${escapeHtml((npc.disposition || 'unknown').toUpperCase())}</span>
    </div>
  `).join('');
}

// =========================================================================
// PENDING UPDATES RENDERING (Phase 5B — bulk actions, Phase 5C — diff display)
// =========================================================================

function renderPendingUpdates(rpg) {
  if (!rpgUpdatesList || !rpgUpdatesSection) return;
  const updates = rpg.pendingUpdates || [];
  rpgUpdatesCount.textContent = `(${updates.length})`;
  rpgUpdatesSection.style.display = updates.length > 0 ? '' : 'none';

  // Show/hide bulk buttons
  if (rpgAcceptAllBtn) rpgAcceptAllBtn.style.display = updates.length > 1 ? '' : 'none';
  if (rpgRejectAllBtn) rpgRejectAllBtn.style.display = updates.length > 1 ? '' : 'none';

  if (updates.length === 0) return;

  rpgUpdatesList.innerHTML = updates.map(update => {
    let desc = '';
    let diffHTML = '';

    if (update.type === 'character') {
      // Phase 5C — use changes array for field-level diffs
      const changes = update.changes || [];
      if (changes.length > 0) {
        diffHTML = `<div class="rpg-update-diff">${changes.map(c =>
          `<div class="rpg-diff-line"><span class="rpg-diff-field">${escapeHtml(c.field)}:</span> <span class="rpg-diff-before">${escapeHtml(String(c.before))}</span> → <span class="rpg-diff-after">${escapeHtml(String(c.after))}</span></div>`
        ).join('')}</div>`;
      }
      desc = escapeHtml(update.characterName);
    } else if (update.type === 'quest_status') {
      desc = `Quest "${escapeHtml(update.questTitle)}": ${update.oldStatus} → ${update.newStatus}`;
    } else if (update.type === 'quest_objective') {
      desc = `Quest "${escapeHtml(update.questTitle)}": objective completed — ${escapeHtml(update.objectiveText)}`;
    }

    return `
      <div class="rpg-update-card" data-update-id="${escapeHtml(update.id)}">
        <div class="update-type">${escapeHtml(update.type.replace('_', ' '))}</div>
        <div class="update-desc">${desc}</div>
        ${diffHTML}
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
// NEW UI SECTIONS (Phase 5G)
// =========================================================================

function renderInventory(rpg) {
  if (!rpgInventoryList) return;
  const allChars = Object.values(rpg.characters || {});
  const globalInv = rpg.globalInventory || [];
  const charItems = allChars.flatMap(c => (c.inventory || []).map(i => ({ ...i, owner: c.name })));
  const allItems = [...globalInv.map(i => ({ ...i, owner: 'Shared' })), ...charItems];

  if (allItems.length === 0) {
    rpgInventoryList.innerHTML = '<div style="font-size:11px;color:#666;padding:4px;">No inventory tracked.</div>';
    return;
  }

  rpgInventoryList.innerHTML = allItems.map(i =>
    `<div class="rpg-inv-row"><span class="rpg-inv-name">${escapeHtml(i.name)} x${i.quantity || 1}</span><span class="rpg-inv-type">${escapeHtml(i.type || 'other')}</span><span class="rpg-inv-owner">${escapeHtml(i.owner)}</span></div>`
  ).join('');
}

function renderCurrency(rpg) {
  if (!rpgCurrencyList) return;
  const globalCurr = rpg.globalCurrency || {};
  const allChars = Object.values(rpg.characters || {});
  const entries = [];

  if (Object.keys(globalCurr).length > 0) {
    entries.push({ owner: 'Shared', currency: globalCurr });
  }
  for (const c of allChars) {
    if (c.currency && Object.keys(c.currency).length > 0) {
      entries.push({ owner: c.name, currency: c.currency });
    }
  }

  if (entries.length === 0) {
    rpgCurrencyList.innerHTML = '<div style="font-size:11px;color:#666;padding:4px;">No currency tracked.</div>';
    return;
  }

  rpgCurrencyList.innerHTML = entries.map(e =>
    `<div class="rpg-currency-row"><span class="rpg-inv-owner">${escapeHtml(e.owner)}</span>${Object.entries(e.currency).map(([unit, amount]) => `<span class="rpg-currency-tag">${amount} ${escapeHtml(unit)}</span>`).join(' ')}</div>`
  ).join('');
}

function renderStatusEffects(rpg) {
  if (!rpgStatusEffectsList) return;
  const allChars = Object.values(rpg.characters || {});
  const allEffects = allChars.flatMap(c => (c.statusEffects || []).map(s => ({ ...s, owner: c.name })));

  if (allEffects.length === 0) {
    rpgStatusEffectsList.innerHTML = '<div style="font-size:11px;color:#666;padding:4px;">No active effects.</div>';
    return;
  }

  rpgStatusEffectsList.innerHTML = allEffects.map(s =>
    `<div class="rpg-status-row"><span class="rpg-status-tag rpg-status-${s.type || 'buff'}">${escapeHtml(s.name)}</span><span class="rpg-inv-owner">${escapeHtml(s.owner)}</span>${s.duration ? `<span style="font-size:9px;color:#888;">${escapeHtml(s.duration)}</span>` : ''}</div>`
  ).join('');
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
      char.portraitPath = true;
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
    let storyText = '';
    try {
      storyText = await webview.executeJavaScript(`
        (function() {
          const el = document.querySelector('#scene-vis-story-text');
          return el ? el.textContent : '';
        })()
      `);
    } catch (_) { /* fallback empty */ }

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

// Bulk actions (Phase 5B)
async function acceptAll() {
  if (!state.currentStoryId) return;
  const result = await window.sceneVisualizer.litrpgAcceptAllUpdates(state.currentStoryId);
  if (result.success) {
    state.litrpgState = result.state;
    refreshRpgUI();
    showToast('All updates accepted');
  }
}

async function rejectAll() {
  if (!state.currentStoryId) return;
  const result = await window.sceneVisualizer.litrpgRejectAllUpdates(state.currentStoryId);
  if (result.success) {
    state.litrpgState = result.state;
    refreshRpgUI();
    showToast('All updates rejected');
  }
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
    if (rpgTab) rpgTab.style.display = '';
    refreshRpgUI();
    showToast(`LitRPG story detected (${systemType})!`);
  });
}

// =========================================================================
// STORY SWITCH HANDLER
// =========================================================================

function onStorySwitch() {
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

  // Bulk actions (Phase 5B)
  if (rpgAcceptAllBtn) rpgAcceptAllBtn.addEventListener('click', acceptAll);
  if (rpgRejectAllBtn) rpgRejectAllBtn.addEventListener('click', rejectAll);

  // Stat overlay close
  if (rpgStatOverlayClose) rpgStatOverlayClose.addEventListener('click', closeStatOverlay);
  if (rpgStatOverlay) rpgStatOverlay.addEventListener('click', (e) => {
    if (e.target === rpgStatOverlay) closeStatOverlay();
  });

  // NPC search (Phase 5F)
  if (rpgNpcSearch) {
    rpgNpcSearch.addEventListener('input', () => {
      npcSearchFilter = rpgNpcSearch.value;
      renderNPCs(getRpgState());
    });
  }

  // Settings persistence (Phase 5A)
  if (rpgAutoScan) {
    rpgAutoScan.addEventListener('change', () => {
      if (!state.litrpgState) state.litrpgState = {};
      state.litrpgState.autoScan = rpgAutoScan.checked;
      saveLitrpgState();
    });
  }
  if (rpgAutoSync) {
    rpgAutoSync.addEventListener('change', () => {
      if (!state.litrpgState) state.litrpgState = {};
      state.litrpgState.autoSync = rpgAutoSync.checked;
      saveLitrpgState();
    });
  }

  // IPC listeners
  setupIPCListeners();

  // Listen for story switch events
  bus.on('story:changed', onStorySwitch);
}

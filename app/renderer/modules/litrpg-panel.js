// litrpg-panel.js — LitRPG RPG tab: stat sheets, quest log, party view, NPC registry, inventory, currency, status effects

import { state, bus } from './state.js';
import { saveLoreState, refreshLoreUI } from './lore-creator.js';
import {
  rpgTab, rpgContent,
  rpgDetectionBanner, rpgEnableBtn, rpgDismissBtn,
  rpgSystemIndicator, rpgSystemType,
  rpgScanBtn, rpgSyncLorebookBtn, rpgReverseSyncBtn,
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
  rpgFactionList, rpgFactionCount,
  rpgClassList, rpgClassCount,
  rpgRaceList, rpgRaceCount,
  webview,
} from './dom-refs.js';
import { escapeHtml, showToast } from './utils.js';

// =========================================================================
// ROLE CONSTANTS
// =========================================================================

const ROLE_CYCLE = ['party-member', 'companion', 'summon', 'pet', 'mount', 'npc'];
const PARTY_SIDE_ROLES = new Set(['party-member', 'companion', 'summon', 'pet', 'mount']);
const ROLE_LABELS = {
  'party-member': 'Party Member',
  'companion': 'Companion',
  'summon': 'Summon',
  'pet': 'Pet',
  'mount': 'Mount',
  'npc': 'NPC',
};
const ROLE_COLORS = {
  'party-member': '#4fc3f7',
  'companion': '#81c784',
  'summon': '#ce93d8',
  'pet': '#ffb74d',
  'mount': '#a1887f',
  'npc': '#90a4ae',
};

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
  if (rpgReverseSyncBtn) rpgReverseSyncBtn.disabled = !rpg.enabled;

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

  // Entity collections
  renderFactions(rpg);
  renderClasses(rpg);
  renderRaces(rpg);
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
          : `<span class="rpg-portrait-placeholder"><svg width="28" height="28" viewBox="0 0 40 40" fill="#666" opacity="0.3"><ellipse cx="20" cy="14" rx="9" ry="10"/><ellipse cx="20" cy="42" rx="16" ry="14"/></svg></span>`}
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

  // Wire role cycle chip
  const roleChip = rpgStatOverlayContent.querySelector('.rpg-role-chip');
  if (roleChip) roleChip.addEventListener('click', () => cycleRole(charId));
}

function closeStatOverlay() {
  if (editDirty && !confirm('Discard unsaved changes?')) return;
  editDirty = false;
  if (rpgStatOverlay) rpgStatOverlay.style.display = 'none';
}

async function cycleRole(charId) {
  const rpg = getRpgState();
  const char = rpg.characters?.[charId];
  if (!char) return;

  // Determine current role and cycle to next
  const currentRole = char.partyRole || (char.isPartyMember ? 'party-member' : (char.isNPC ? 'npc' : null));
  const currentIdx = currentRole ? ROLE_CYCLE.indexOf(currentRole) : -1;
  const nextRole = ROLE_CYCLE[(currentIdx + 1) % ROLE_CYCLE.length];

  // Update character flags
  const isPartySide = PARTY_SIDE_ROLES.has(nextRole);
  char.isPartyMember = isPartySide;
  char.isNPC = !isPartySide;
  char.partyRole = nextRole;

  // Update party members list
  rpg.party.members = Object.entries(rpg.characters)
    .filter(([, c]) => c.isPartyMember)
    .map(([id]) => id);
  rpg.party.lastUpdated = Date.now();

  // Save state
  state.litrpgState = rpg;
  saveLitrpgState();

  // Write @role metadata to lorebook entry
  if (char.loreEntryName) {
    try {
      await applyRoleUpdatesToLorebook([{ charName: char.name, loreEntryName: char.loreEntryName, role: nextRole }]);
    } catch (err) {
      console.error(`[LitRPG] Failed to write @role for ${char.name}:`, err);
    }
  }

  // Re-render stat sheet and refresh UI
  openStatOverlay(charId, getRpgState());
  refreshRpgUI();
}

function buildStatSheetHTML(char) {
  const statsHTML = Object.entries(char.stats || {}).map(([name, s]) =>
    `<div class="rpg-stat"><span class="stat-name">${escapeHtml(name)}</span><span class="stat-value">${s.value}${s.modifier != null ? ` (${s.modifier >= 0 ? '+' : ''}${s.modifier})` : ''}</span></div>`
  ).join('');

  const abilitiesHTML = (char.abilities || []).map(a => {
    let tags = '';
    if (a.category) tags += ` <span class="rpg-ability-cat rpg-ability-cat-${a.category}">${escapeHtml(a.category)}</span>`;
    if (a.cooldown) tags += ` <span class="rpg-ability-cd">CD: ${escapeHtml(a.cooldown)}</span>`;
    if (a.proficiency) tags += ` <span class="rpg-ability-prof">${escapeHtml(a.proficiency)}</span>`;
    return `<div class="rpg-ability">${escapeHtml(a.name)}${a.level ? ` (Lv.${a.level})` : ''}${tags} — ${escapeHtml(a.description || '')}${a.cost ? ` [${escapeHtml(a.cost)}]` : ''}</div>`;
  }).join('');

  const equipmentHTML = (char.equipment || []).map(e => {
    let extras = '';
    if (e.bonuses) extras += ` <span class="rpg-equip-bonus">{${escapeHtml(e.bonuses)}}</span>`;
    if (e.setName) extras += ` <span class="rpg-equip-set">[${escapeHtml(e.setName)}]</span>`;
    return `<div class="rpg-equip-item">${escapeHtml(e.name)} [${escapeHtml(e.slot || 'other')}]${e.rarity && e.rarity !== 'unknown' ? ` <span class="rpg-rarity rpg-rarity-${e.rarity}">${e.rarity}</span>` : ''}${extras} — ${escapeHtml(e.description || '')}</div>`;
  }).join('');

  const inventoryHTML = (char.inventory || []).map(i =>
    `<div class="rpg-inv-item">${escapeHtml(i.name)} x${i.quantity || 1} <span style="color:#888;">(${i.type || 'other'})</span>${i.rarity ? ` <span class="rpg-rarity rpg-rarity-${i.rarity}">${i.rarity}</span>` : ''}</div>`
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

  // Role chip (party-member, companion, summon, pet, mount, npc)
  const currentRole = char.partyRole || (char.isPartyMember ? 'party-member' : (char.isNPC ? 'npc' : null));
  const roleLabel = currentRole ? (ROLE_LABELS[currentRole] || currentRole) : 'Unclassified';
  const roleColor = currentRole ? (ROLE_COLORS[currentRole] || '#666') : '#666';
  const roleChipHTML = `<button class="rpg-role-chip" data-role="${escapeHtml(currentRole || '')}" title="Click to cycle role" style="font-size:9px;padding:1px 8px;margin-top:3px;background:transparent;color:${roleColor};border:1px solid ${roleColor};border-radius:10px;cursor:pointer;display:inline-block;">${escapeHtml(roleLabel)}</button>`;

  return `
    <div class="rpg-stat-header">
      <div class="rpg-portrait-large">
        ${char.portraitPath
          ? `<img src="data:image/png;base64,${char._portraitData || ''}" alt="${escapeHtml(char.name)}">`
          : `<svg width="40" height="40" viewBox="0 0 40 40" fill="#666" opacity="0.3"><ellipse cx="20" cy="14" rx="9" ry="10"/><ellipse cx="20" cy="42" rx="16" ry="14"/></svg>`}
        <div class="rpg-portrait-actions">
          <button class="rpg-portrait-generate" title="Generate Portrait">Gen</button>
          <button class="rpg-portrait-upload" title="Upload Portrait">Up</button>
        </div>
      </div>
      <div style="flex:1;">
        <h3>${escapeHtml(char.name)}</h3>
        <div style="font-size:11px;color:var(--cat-rpg);">${char.level ? `Level ${char.level} ` : ''}${escapeHtml(char.class || '')}${char.subclass ? ` / ${escapeHtml(char.subclass)}` : ''}${char.race ? ` (${escapeHtml(char.race)})` : ''}</div>
        ${roleChipHTML}
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

let editDirty = false;

function markEditDirty() { editDirty = true; }

const INPUT_STYLE = 'background:var(--bg-input);color:#fff;border:1px solid #555;border-radius:3px;padding:2px 6px;font-size:11px;';
const SLOT_OPTIONS = ['weapon','off-hand','shield','helmet','armor','legs','boots','gloves','ring','amulet','cloak','belt','bracers','earring','trinket','accessory','other'];
const RARITY_OPTIONS = ['common','uncommon','rare','epic','legendary','unknown'];
const ABILITY_CATEGORY_OPTIONS = ['','combat','magic','crafting','social','utility','other'];
const STATUS_TYPE_OPTIONS = ['buff','debuff','condition'];

function buildSelectHTML(name, options, selected) {
  return `<select data-field="${name}" style="${INPUT_STYLE}">${options.map(o => `<option value="${o}"${o === selected ? ' selected' : ''}>${o}</option>`).join('')}</select>`;
}

function enterEditMode(charId) {
  const rpg = getRpgState();
  const char = rpg.characters?.[charId];
  if (!char || !rpgStatOverlayContent) return;

  const statsInputs = Object.entries(char.stats || {}).map(([name, s]) =>
    `<div class="rpg-stat"><span class="stat-name">${escapeHtml(name)}</span><input type="number" class="rpg-edit-stat" data-stat="${escapeHtml(name)}" value="${s.value}" style="width:50px;${INPUT_STYLE}"></div>`
  ).join('');

  // Abilities section (with category, cooldown, proficiency)
  const abilitiesRows = (char.abilities || []).map((a, idx) =>
    `<div class="rpg-edit-row" data-section="abilities" data-idx="${idx}" style="display:flex;gap:4px;align-items:center;margin-bottom:3px;flex-wrap:wrap;">
      <input type="text" data-field="name" value="${escapeHtml(a.name)}" placeholder="Name" style="flex:2;${INPUT_STYLE}">
      <input type="number" data-field="level" value="${a.level || ''}" placeholder="Lv" style="width:40px;${INPUT_STYLE}">
      ${buildSelectHTML('category', ABILITY_CATEGORY_OPTIONS, a.category || '')}
      <input type="text" data-field="description" value="${escapeHtml(a.description || '')}" placeholder="Description" style="flex:3;${INPUT_STYLE}">
      <input type="text" data-field="cooldown" value="${escapeHtml(a.cooldown || '')}" placeholder="Cooldown" style="width:70px;${INPUT_STYLE}">
      <input type="text" data-field="proficiency" value="${escapeHtml(a.proficiency || '')}" placeholder="Proficiency" style="width:80px;${INPUT_STYLE}">
      <button class="rpg-edit-remove" style="font-size:10px;color:#ff6b6b;background:none;border:none;cursor:pointer;" title="Remove">✕</button>
    </div>`
  ).join('');

  // Equipment section (with bonuses, setName)
  const equipmentRows = (char.equipment || []).map((e, idx) =>
    `<div class="rpg-edit-row" data-section="equipment" data-idx="${idx}" style="display:flex;gap:4px;align-items:center;margin-bottom:3px;flex-wrap:wrap;">
      <input type="text" data-field="name" value="${escapeHtml(e.name)}" placeholder="Name" style="flex:2;${INPUT_STYLE}">
      ${buildSelectHTML('slot', SLOT_OPTIONS, e.slot || 'other')}
      ${buildSelectHTML('rarity', RARITY_OPTIONS, e.rarity || 'unknown')}
      <input type="text" data-field="bonuses" value="${escapeHtml(e.bonuses || '')}" placeholder="Bonuses" style="width:80px;${INPUT_STYLE}">
      <input type="text" data-field="setName" value="${escapeHtml(e.setName || '')}" placeholder="Set Name" style="width:80px;${INPUT_STYLE}">
      <input type="text" data-field="description" value="${escapeHtml(e.description || '')}" placeholder="Description" style="flex:2;${INPUT_STYLE}">
      <button class="rpg-edit-remove" style="font-size:10px;color:#ff6b6b;background:none;border:none;cursor:pointer;" title="Remove">✕</button>
    </div>`
  ).join('');

  // Inventory section (with rarity)
  const inventoryRows = (char.inventory || []).map((i, idx) =>
    `<div class="rpg-edit-row" data-section="inventory" data-idx="${idx}" style="display:flex;gap:4px;align-items:center;margin-bottom:3px;">
      <input type="text" data-field="name" value="${escapeHtml(i.name)}" placeholder="Name" style="flex:2;${INPUT_STYLE}">
      <input type="number" data-field="quantity" value="${i.quantity || 1}" placeholder="Qty" style="width:45px;${INPUT_STYLE}">
      ${buildSelectHTML('type', ['consumable','material','quest_item','other'], i.type || 'other')}
      ${buildSelectHTML('rarity', ['','common','uncommon','rare','epic','legendary'], i.rarity || '')}
      <button class="rpg-edit-remove" style="font-size:10px;color:#ff6b6b;background:none;border:none;cursor:pointer;" title="Remove">✕</button>
    </div>`
  ).join('');

  // Currency section
  const currencyRows = Object.entries(char.currency || {}).map(([unit, amount], idx) =>
    `<div class="rpg-edit-row" data-section="currency" data-idx="${idx}" style="display:flex;gap:4px;align-items:center;margin-bottom:3px;">
      <input type="text" data-field="unit" value="${escapeHtml(unit)}" placeholder="Currency" style="flex:1;${INPUT_STYLE}">
      <input type="number" data-field="amount" value="${amount}" placeholder="Amount" style="width:80px;${INPUT_STYLE}">
      <button class="rpg-edit-remove" style="font-size:10px;color:#ff6b6b;background:none;border:none;cursor:pointer;" title="Remove">✕</button>
    </div>`
  ).join('');

  // Status effects section
  const statusRows = (char.statusEffects || []).map((s, idx) =>
    `<div class="rpg-edit-row" data-section="statusEffects" data-idx="${idx}" style="display:flex;gap:4px;align-items:center;margin-bottom:3px;">
      <input type="text" data-field="name" value="${escapeHtml(s.name)}" placeholder="Name" style="flex:2;${INPUT_STYLE}">
      ${buildSelectHTML('type', STATUS_TYPE_OPTIONS, s.type || 'buff')}
      <input type="text" data-field="duration" value="${escapeHtml(s.duration || '')}" placeholder="Duration" style="flex:1;${INPUT_STYLE}">
      <button class="rpg-edit-remove" style="font-size:10px;color:#ff6b6b;background:none;border:none;cursor:pointer;" title="Remove">✕</button>
    </div>`
  ).join('');

  rpgStatOverlayContent.innerHTML = `
    <div class="rpg-stat-header">
      <div style="flex:1;">
        <div style="margin-bottom:6px;">
          <label style="font-size:10px;color:#888;">Name</label>
          <input type="text" id="rpgEditName" value="${escapeHtml(char.name)}" style="width:100%;${INPUT_STYLE}font-size:12px;">
        </div>
        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <div style="flex:1;">
            <label style="font-size:10px;color:#888;">Class</label>
            <input type="text" id="rpgEditClass" value="${escapeHtml(char.class || '')}" style="width:100%;${INPUT_STYLE}">
          </div>
          <div style="flex:1;">
            <label style="font-size:10px;color:#888;">Subclass</label>
            <input type="text" id="rpgEditSubclass" value="${escapeHtml(char.subclass || '')}" style="width:100%;${INPUT_STYLE}">
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <div style="flex:1;">
            <label style="font-size:10px;color:#888;">Level</label>
            <input type="number" id="rpgEditLevel" value="${char.level || ''}" style="width:100%;${INPUT_STYLE}">
          </div>
          <div style="flex:1;">
            <label style="font-size:10px;color:#888;">Race</label>
            <input type="text" id="rpgEditRace" value="${escapeHtml(char.race || '')}" style="width:100%;${INPUT_STYLE}">
          </div>
        </div>
      </div>
    </div>
    ${statsInputs ? `<div class="rpg-stat-grid">${statsInputs}</div>` : '<div style="font-size:10px;color:#666;">No stats to edit.</div>'}

    <details class="lore-section" style="margin-top:8px;" open>
      <summary style="font-size:11px;color:#aaa;cursor:pointer;">Abilities (${(char.abilities || []).length})</summary>
      <div id="rpgEditAbilities">${abilitiesRows || '<div style="font-size:10px;color:#666;">None</div>'}</div>
      <button class="rpg-edit-add" data-section="abilities" style="font-size:10px;margin-top:3px;padding:2px 8px;${INPUT_STYLE}cursor:pointer;">+ Add Ability</button>
    </details>

    <details class="lore-section" style="margin-top:6px;">
      <summary style="font-size:11px;color:#aaa;cursor:pointer;">Equipment (${(char.equipment || []).length})</summary>
      <div id="rpgEditEquipment">${equipmentRows || '<div style="font-size:10px;color:#666;">None</div>'}</div>
      <button class="rpg-edit-add" data-section="equipment" style="font-size:10px;margin-top:3px;padding:2px 8px;${INPUT_STYLE}cursor:pointer;">+ Add Equipment</button>
    </details>

    <details class="lore-section" style="margin-top:6px;">
      <summary style="font-size:11px;color:#aaa;cursor:pointer;">Inventory (${(char.inventory || []).length})</summary>
      <div id="rpgEditInventory">${inventoryRows || '<div style="font-size:10px;color:#666;">None</div>'}</div>
      <button class="rpg-edit-add" data-section="inventory" style="font-size:10px;margin-top:3px;padding:2px 8px;${INPUT_STYLE}cursor:pointer;">+ Add Item</button>
    </details>

    <details class="lore-section" style="margin-top:6px;">
      <summary style="font-size:11px;color:#aaa;cursor:pointer;">Currency (${Object.keys(char.currency || {}).length})</summary>
      <div id="rpgEditCurrency">${currencyRows || '<div style="font-size:10px;color:#666;">None</div>'}</div>
      <button class="rpg-edit-add" data-section="currency" style="font-size:10px;margin-top:3px;padding:2px 8px;${INPUT_STYLE}cursor:pointer;">+ Add Currency</button>
    </details>

    <details class="lore-section" style="margin-top:6px;">
      <summary style="font-size:11px;color:#aaa;cursor:pointer;">Status Effects (${(char.statusEffects || []).length})</summary>
      <div id="rpgEditStatus">${statusRows || '<div style="font-size:10px;color:#666;">None</div>'}</div>
      <button class="rpg-edit-add" data-section="statusEffects" style="font-size:10px;margin-top:3px;padding:2px 8px;${INPUT_STYLE}cursor:pointer;">+ Add Effect</button>
    </details>

    <div style="display:flex;gap:6px;margin-top:8px;">
      <button class="rpg-stat-save-btn btn-accept" style="font-size:11px;padding:4px 12px;">Save</button>
      <button class="rpg-stat-cancel-btn btn-reject" style="font-size:11px;padding:4px 12px;">Cancel</button>
    </div>
  `;

  // Wire dirty tracking
  editDirty = false;
  rpgStatOverlayContent.querySelectorAll('input, select').forEach(el => {
    el.addEventListener('input', markEditDirty);
  });

  // Wire remove buttons
  rpgStatOverlayContent.querySelectorAll('.rpg-edit-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.rpg-edit-row').remove();
      markEditDirty();
    });
  });

  // Wire add buttons
  rpgStatOverlayContent.querySelectorAll('.rpg-edit-add').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = btn.dataset.section;
      const container = btn.previousElementSibling;
      // Clear "None" placeholder
      if (container.querySelector('div[style*="color:#666"]')) container.innerHTML = '';
      const newRow = document.createElement('div');
      newRow.className = 'rpg-edit-row';
      newRow.dataset.section = section;
      newRow.style.cssText = 'display:flex;gap:4px;align-items:center;margin-bottom:3px;';
      newRow.innerHTML = getEmptyRowHTML(section);
      container.appendChild(newRow);
      newRow.querySelector('.rpg-edit-remove')?.addEventListener('click', () => { newRow.remove(); markEditDirty(); });
      newRow.querySelectorAll('input, select').forEach(el => el.addEventListener('input', markEditDirty));
      markEditDirty();
    });
  });

  const saveBtn = rpgStatOverlayContent.querySelector('.rpg-stat-save-btn');
  const cancelBtn = rpgStatOverlayContent.querySelector('.rpg-stat-cancel-btn');
  if (saveBtn) saveBtn.addEventListener('click', () => saveEdit(charId));
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    if (editDirty && !confirm('Discard unsaved changes?')) return;
    editDirty = false;
    openStatOverlay(charId, getRpgState());
  });
}

function getEmptyRowHTML(section) {
  const rm = `<button class="rpg-edit-remove" style="font-size:10px;color:#ff6b6b;background:none;border:none;cursor:pointer;" title="Remove">✕</button>`;
  switch (section) {
    case 'abilities':
      return `<input type="text" data-field="name" placeholder="Name" style="flex:2;${INPUT_STYLE}"><input type="number" data-field="level" placeholder="Lv" style="width:40px;${INPUT_STYLE}">${buildSelectHTML('category', ABILITY_CATEGORY_OPTIONS, '')}<input type="text" data-field="description" placeholder="Description" style="flex:3;${INPUT_STYLE}"><input type="text" data-field="cooldown" placeholder="Cooldown" style="width:70px;${INPUT_STYLE}"><input type="text" data-field="proficiency" placeholder="Proficiency" style="width:80px;${INPUT_STYLE}">${rm}`;
    case 'equipment':
      return `<input type="text" data-field="name" placeholder="Name" style="flex:2;${INPUT_STYLE}">${buildSelectHTML('slot', SLOT_OPTIONS, 'other')}${buildSelectHTML('rarity', RARITY_OPTIONS, 'unknown')}<input type="text" data-field="bonuses" placeholder="Bonuses" style="width:80px;${INPUT_STYLE}"><input type="text" data-field="setName" placeholder="Set Name" style="width:80px;${INPUT_STYLE}"><input type="text" data-field="description" placeholder="Description" style="flex:2;${INPUT_STYLE}">${rm}`;
    case 'inventory':
      return `<input type="text" data-field="name" placeholder="Name" style="flex:2;${INPUT_STYLE}"><input type="number" data-field="quantity" value="1" placeholder="Qty" style="width:45px;${INPUT_STYLE}">${buildSelectHTML('type', ['consumable','material','quest_item','other'], 'other')}${buildSelectHTML('rarity', ['','common','uncommon','rare','epic','legendary'], '')}${rm}`;
    case 'currency':
      return `<input type="text" data-field="unit" placeholder="Currency" style="flex:1;${INPUT_STYLE}"><input type="number" data-field="amount" placeholder="Amount" style="width:80px;${INPUT_STYLE}">${rm}`;
    case 'statusEffects':
      return `<input type="text" data-field="name" placeholder="Name" style="flex:2;${INPUT_STYLE}">${buildSelectHTML('type', STATUS_TYPE_OPTIONS, 'buff')}<input type="text" data-field="duration" placeholder="Duration" style="flex:1;${INPUT_STYLE}">${rm}`;
    default: return '';
  }
}

function collectEditRows(containerId) {
  const container = rpgStatOverlayContent.querySelector(`#${containerId}`);
  if (!container) return [];
  const rows = [];
  container.querySelectorAll('.rpg-edit-row').forEach(row => {
    const data = {};
    row.querySelectorAll('input, select').forEach(el => {
      const field = el.dataset.field || el.dataset.stat;
      if (field) data[field] = el.type === 'number' ? (el.value ? parseFloat(el.value) : null) : el.value.trim();
    });
    if (data.name || data.unit) rows.push(data);
  });
  return rows;
}

async function saveEdit(charId) {
  if (!rpgStatOverlayContent || !state.currentStoryId) return;
  editDirty = false;

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

  // Collect expanded section edits
  const abilitiesData = collectEditRows('rpgEditAbilities');
  if (abilitiesData.length > 0 || rpgStatOverlayContent.querySelector('#rpgEditAbilities')) {
    updates.abilities = abilitiesData.map(a => ({
      name: a.name, level: a.level || null, description: a.description || '', type: 'active', cost: null,
      category: a.category || null, cooldown: a.cooldown || null, proficiency: a.proficiency || null,
    }));
  }

  const equipmentData = collectEditRows('rpgEditEquipment');
  if (equipmentData.length > 0 || rpgStatOverlayContent.querySelector('#rpgEditEquipment')) {
    updates.equipment = equipmentData.map(e => ({
      name: e.name, slot: e.slot || 'other', rarity: e.rarity || 'unknown', description: e.description || '',
      bonuses: e.bonuses || null, setName: e.setName || null,
    }));
  }

  const inventoryData = collectEditRows('rpgEditInventory');
  if (inventoryData.length > 0 || rpgStatOverlayContent.querySelector('#rpgEditInventory')) {
    updates.inventory = inventoryData.map(i => ({
      name: i.name, quantity: i.quantity || 1, type: i.type || 'other',
      rarity: i.rarity || null,
    }));
  }

  const currencyData = collectEditRows('rpgEditCurrency');
  if (currencyData.length > 0 || rpgStatOverlayContent.querySelector('#rpgEditCurrency')) {
    updates.currency = {};
    for (const c of currencyData) {
      if (c.unit) updates.currency[c.unit.toLowerCase()] = c.amount || 0;
    }
  }

  const statusData = collectEditRows('rpgEditStatus');
  if (statusData.length > 0 || rpgStatOverlayContent.querySelector('#rpgEditStatus')) {
    updates.statusEffects = statusData.map(s => ({
      name: s.name, type: s.type || 'buff', duration: s.duration || null,
    }));
  }

  const result = await window.sceneVisualizer.litrpgUpdateCharacter(state.currentStoryId, charId, updates);
  if (result.success) {
    state.litrpgState = result.state;
    refreshRpgUI();
    openStatOverlay(charId, getRpgState());
    showToast('Character updated', 2000, 'success');
  } else {
    showToast(`Failed to save: ${result.error || 'Unknown error'}`, 3000, 'error');
  }
}

async function deleteCharacter(charId) {
  if (!state.currentStoryId) return;
  const result = await window.sceneVisualizer.litrpgDeleteCharacter(state.currentStoryId, charId);
  if (result.success) {
    state.litrpgState = result.state;
    closeStatOverlay();
    refreshRpgUI();
    showToast('Character deleted', 2000, 'success');
  } else {
    showToast(`Failed to delete: ${result.error || 'Unknown error'}`, 3000, 'error');
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

function highlightMatch(text, query) {
  if (!query) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return escaped.replace(re, '<mark style="background:rgba(233,69,96,0.3);color:inherit;padding:0 1px;border-radius:2px;">$1</mark>');
}

function renderNPCs(rpg) {
  if (!rpgNpcList) return;
  const allNpcs = Object.values(rpg.characters || {}).filter(c => c.isNPC);
  let npcs = allNpcs;

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

  rpgNpcCount.textContent = npcSearchFilter
    ? `(${npcs.length} of ${allNpcs.length})`
    : `(${npcs.length})`;

  if (npcs.length === 0) {
    rpgNpcList.innerHTML = '<div style="font-size:11px;color:#666;padding:4px;">No NPCs tracked yet.</div>';
    return;
  }

  const q = npcSearchFilter;
  rpgNpcList.innerHTML = npcs.map(npc => `
    <div class="rpg-npc-card">
      <span class="rpg-npc-name">${highlightMatch(npc.name, q)}${npc.level ? ` (Lv.${npc.level})` : ''}${npc.class ? ` — ${highlightMatch(npc.class, q)}` : ''}</span>
      ${npc.npcRole ? `<span style="font-size:9px;color:#a0a0ff;">${highlightMatch(npc.npcRole, q)}</span>` : ''}
      ${npc.faction ? `<span style="font-size:9px;color:var(--cat-faction);">${highlightMatch(npc.faction, q)}</span>` : ''}
      <span class="rpg-disposition ${npc.disposition || 'unknown'}">${highlightMatch((npc.disposition || 'unknown').toUpperCase(), q)}</span>
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
        showToast('Update accepted', 2000, 'success');
      } else {
        showToast(`Failed to accept: ${result.error || 'Unknown error'}`, 3000, 'error');
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
    `<div class="rpg-inv-row"><span class="rpg-inv-name">${escapeHtml(i.name)} x${i.quantity || 1}</span>${i.rarity ? `<span class="rpg-rarity rpg-rarity-${i.rarity}">${i.rarity}</span>` : ''}<span class="rpg-inv-type">${escapeHtml(i.type || 'other')}</span><span class="rpg-inv-owner">${escapeHtml(i.owner)}</span></div>`
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
// ENTITY COLLECTION RENDERERS
// =========================================================================

function renderFactions(rpg) {
  if (!rpgFactionList) return;
  const factions = Object.values(rpg.factions || {});
  if (rpgFactionCount) rpgFactionCount.textContent = `(${factions.length})`;

  if (factions.length === 0) {
    rpgFactionList.innerHTML = '<div style="font-size:11px;color:#666;padding:4px;">No factions tracked yet.</div>';
    return;
  }

  rpgFactionList.innerHTML = factions.map(fac => {
    const dispClass = `rpg-disposition-${(fac.disposition || 'unknown').toLowerCase()}`;
    const members = (fac.members || []).map(m => escapeHtml(m)).join(', ');
    return `<div class="rpg-entity-card">
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="rpg-entity-name">${escapeHtml(fac.name)}</span>
        <span class="rpg-disposition ${dispClass}">${escapeHtml(fac.disposition || 'unknown')}</span>
        <span style="font-size:9px;color:#666;">${(fac.members || []).length} members</span>
      </div>
      ${fac.description ? `<div class="rpg-entity-desc">${escapeHtml(fac.description)}</div>` : ''}
      ${fac.territory ? `<div style="font-size:10px;color:#888;">Territory: ${escapeHtml(fac.territory)}</div>` : ''}
      ${members ? `<div class="rpg-entity-members">Members: ${members}</div>` : ''}
    </div>`;
  }).join('');
}

function renderClasses(rpg) {
  if (!rpgClassList) return;
  const classes = Object.values(rpg.classes || {});
  if (rpgClassCount) rpgClassCount.textContent = `(${classes.length})`;

  if (classes.length === 0) {
    rpgClassList.innerHTML = '<div style="font-size:11px;color:#666;padding:4px;">No classes tracked yet.</div>';
    return;
  }

  // Sort: classes first, then subclasses
  const sorted = [...classes].sort((a, b) => {
    if (a.type === 'class' && b.type === 'subclass') return -1;
    if (a.type === 'subclass' && b.type === 'class') return 1;
    return a.name.localeCompare(b.name);
  });

  rpgClassList.innerHTML = sorted.map(cls => {
    const practitioners = (cls.practitioners || []).map(p => escapeHtml(p)).join(', ');
    const typeLabel = cls.type === 'subclass' ? `<span style="font-size:9px;color:#ce93d8;">subclass</span>` : '';
    const parent = cls.parentClass ? `<span style="font-size:9px;color:#888;"> of ${escapeHtml(cls.parentClass)}</span>` : '';
    return `<div class="rpg-entity-card" style="${cls.type === 'subclass' ? 'margin-left:12px;' : ''}">
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="rpg-entity-name">${escapeHtml(cls.name)}</span>
        ${typeLabel}${parent}
        <span style="font-size:9px;color:#666;">${(cls.practitioners || []).length} practitioners</span>
      </div>
      ${cls.description ? `<div class="rpg-entity-desc">${escapeHtml(cls.description)}</div>` : ''}
      ${cls.requirements ? `<div style="font-size:10px;color:#888;">Requires: ${escapeHtml(cls.requirements)}</div>` : ''}
      ${practitioners ? `<div class="rpg-entity-members">${practitioners}</div>` : ''}
    </div>`;
  }).join('');
}

function renderRaces(rpg) {
  if (!rpgRaceList) return;
  const races = Object.values(rpg.races || {});
  if (rpgRaceCount) rpgRaceCount.textContent = `(${races.length})`;

  if (races.length === 0) {
    rpgRaceList.innerHTML = '<div style="font-size:11px;color:#666;padding:4px;">No races tracked yet.</div>';
    return;
  }

  rpgRaceList.innerHTML = races.map(race => {
    const members = (race.knownMembers || []).map(m => escapeHtml(m)).join(', ');
    return `<div class="rpg-entity-card">
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="rpg-entity-name">${escapeHtml(race.name)}</span>
        <span style="font-size:9px;color:#666;">${(race.knownMembers || []).length} known</span>
      </div>
      ${race.description ? `<div class="rpg-entity-desc">${escapeHtml(race.description)}</div>` : ''}
      ${race.traits ? `<div style="font-size:10px;color:#d4a574;">Traits: ${escapeHtml(race.traits)}</div>` : ''}
      ${members ? `<div class="rpg-entity-members">${members}</div>` : ''}
    </div>`;
  }).join('');
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

let scanElapsedTimer = null;

async function runRpgScan() {
  if (!state.currentStoryId || state.litrpgScanning) return;
  state.litrpgScanning = true;
  if (rpgScanStatus) rpgScanStatus.style.display = '';
  if (rpgScanPhase) {
    rpgScanPhase.textContent = 'Starting RPG scan...';
    rpgScanPhase.classList.add('rpg-scan-pulsing');
  }
  if (rpgScanBtn) rpgScanBtn.disabled = true;

  // Elapsed timer
  const scanStartTime = Date.now();
  if (scanElapsedTimer) clearInterval(scanElapsedTimer);
  scanElapsedTimer = setInterval(() => {
    if (!rpgScanPhase) return;
    const elapsed = Math.round((Date.now() - scanStartTime) / 1000);
    const base = rpgScanPhase.textContent.replace(/\s*\(\d+s\)$/, '');
    rpgScanPhase.textContent = `${base} (${elapsed}s)`;
  }, 1000);

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

      // Apply @role metadata updates to lorebook entries
      if (result.roleUpdates && result.roleUpdates.length > 0) {
        await applyRoleUpdatesToLorebook(result.roleUpdates);
      }

      // Push R4 lore entries into the Lore tab pending queue
      if (result.pendingLoreEntries && result.pendingLoreEntries.length > 0) {
        if (!state.loreState) state.loreState = { pendingEntries: [], rejectedNames: [] };
        if (!state.loreState.pendingEntries) state.loreState.pendingEntries = [];
        const existingNames = new Set((state.loreState.pendingEntries || []).map(e => e.displayName.toLowerCase()));
        const rejectedNames = new Set((state.loreState.rejectedNames || []).map(n => n.toLowerCase()));
        const newEntries = result.pendingLoreEntries.filter(e =>
          !existingNames.has(e.displayName.toLowerCase()) && !rejectedNames.has(e.displayName.toLowerCase())
        );
        if (newEntries.length > 0) {
          state.loreState.pendingEntries.push(...newEntries);
          await saveLoreState();
          refreshLoreUI();
          showToast(`Found ${newEntries.length} RPG lore entr${newEntries.length === 1 ? 'y' : 'ies'} — check Lore tab`);
        }
      }

      // R4 dedup transparency
      if (result.r4Skipped > 0) {
        showToast(`${result.r4Skipped} more RPG elements found but capped`, 3000);
      }

      showToast('RPG scan complete', 2000, 'success');
    } else {
      showToast(`RPG scan failed: ${result.error || 'Unknown error'}`, 3000, 'error');
    }
  } catch (err) {
    showToast(`RPG scan error: ${err.message || 'Unknown error'}`, 3000, 'error');
    console.error('[LitRPG] Scan error:', err);
  } finally {
    state.litrpgScanning = false;
    if (scanElapsedTimer) { clearInterval(scanElapsedTimer); scanElapsedTimer = null; }
    if (rpgScanPhase) rpgScanPhase.classList.remove('rpg-scan-pulsing');
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

async function applyRoleUpdatesToLorebook(roleUpdates) {
  if (!roleUpdates || roleUpdates.length === 0) return;
  let updated = 0;

  for (const { loreEntryName, role } of roleUpdates) {
    try {
      const entries = await webview.executeJavaScript(`
        (function() {
          if (window.__loreCreator && window.__loreCreator.getEntries) {
            return window.__loreCreator.getEntries().filter(e => e.displayName === ${JSON.stringify(loreEntryName)});
          }
          return [];
        })()
      `);

      if (entries.length === 0) continue;
      const entry = entries[0];

      const updatedText = await window.sceneVisualizer.litrpgBuildRoleUpdate(entry.text, role);
      if (!updatedText) continue; // already correct

      await webview.executeJavaScript(`
        (function() {
          if (window.__loreCreator && window.__loreCreator.updateEntry) {
            window.__loreCreator.updateEntry({
              displayName: ${JSON.stringify(loreEntryName)},
              text: ${JSON.stringify(updatedText)}
            });
          }
        })()
      `);
      updated++;
    } catch (err) {
      console.error(`[LitRPG] Role update failed for ${loreEntryName}:`, err);
    }
  }

  if (updated > 0) {
    console.log(`[LitRPG] Updated @role metadata for ${updated} lorebook entries`);
  }
}

async function reverseSyncFromLorebook() {
  const rpg = getRpgState();
  if (!rpg.enabled) return;

  if (rpgReverseSyncBtn) { rpgReverseSyncBtn.disabled = true; rpgReverseSyncBtn.textContent = '...'; }

  try {
    // Read lorebook entries via proxy
    const entries = await webview.executeJavaScript(`
      (function() {
        if (window.__loreCreator && window.__loreCreator.getEntries) {
          return window.__loreCreator.getEntries();
        }
        return [];
      })()
    `);

    // Filter to character entries (check @type metadata or category)
    const characterEntries = entries.filter(e => {
      if (e.text && /^@type:\s*character/m.test(e.text)) return true;
      // Fallback: check if it's in a characters category
      return e.category === 'character' || (e.text && /^Name:/m.test(e.text) && /^(Age|Gender|Physical Appearance):/m.test(e.text));
    });

    if (characterEntries.length === 0) {
      showToast('No character entries found in lorebook');
      return;
    }

    const result = await window.sceneVisualizer.litrpgReverseSyncAll(characterEntries, state.currentStoryId);
    if (result.success) {
      if (result.updatedCount > 0) {
        state.litrpgState = result.state;
        refreshRpgUI();
      }
      showToast(result.updatedCount > 0
        ? `Updated ${result.updatedCount} character${result.updatedCount > 1 ? 's' : ''} from lorebook`
        : 'No RPG changes found in lorebook');
    } else {
      showToast('Reverse sync failed');
    }
  } catch (err) {
    console.error('[LitRPG] Reverse sync error:', err);
    showToast('Reverse sync failed: ' + (err.message || 'Unknown error'));
  } finally {
    if (rpgReverseSyncBtn) { rpgReverseSyncBtn.disabled = false; rpgReverseSyncBtn.textContent = 'Sync from Lorebook'; }
  }
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
        'lore-elements': 'Generating RPG lore entries',
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
  if (rpgReverseSyncBtn) rpgReverseSyncBtn.addEventListener('click', reverseSyncFromLorebook);
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

/**
 * LitRPG Tracker — detection, RPG data extraction, scan orchestration, lorebook sync.
 *
 * Detects LitRPG stories via regex + LLM, then extracts structured RPG data
 * (classes, levels, stats, abilities, quests, party, NPCs) from story text.
 * Data stored as structured JSON in SQLite, synced to lorebook text entries.
 */

const { fuzzyNameScore, recoverJSON } = require('./lore-creator');

const LOG_PREFIX = '[LitRPG]';

// --- Constants ---

const INTER_CALL_DELAY = 1000;
const MAX_STORY_CONTEXT = 4000;
const DETECTION_THRESHOLD = 8;
const CONFIDENCE_GATE = 2;
const MIN_INCREMENTAL_CHARS = 500;

const VALID_EQUIPMENT_SLOTS = new Set([
  'weapon', 'off-hand', 'shield', 'helmet', 'head', 'armor', 'chest',
  'legs', 'leggings', 'boots', 'feet', 'gloves', 'hands', 'gauntlets',
  'ring', 'ring1', 'ring2', 'amulet', 'necklace', 'cloak', 'cape',
  'belt', 'waist', 'bracers', 'wrists', 'earring', 'trinket', 'back',
  'accessory', 'other',
]);

const VALID_ABILITY_TYPES = new Set(['active', 'passive']);
const VALID_STATUS_TYPES = new Set(['buff', 'debuff', 'condition']);
const VALID_RARITY = new Set(['common', 'uncommon', 'rare', 'epic', 'legendary', 'unknown']);
const VALID_DISPOSITIONS = new Set(['friendly', 'neutral', 'hostile', 'unknown']);

const LITRPG_STATE_DEFAULTS = {
  enabled: false,
  detected: null,
  systemType: 'generic',
  dismissedDetection: false,
  characters: {},
  quests: {},
  party: { members: [], lastUpdated: null },
  pendingUpdates: [],
  lastProcessedLength: 0,
  lastScanAt: null,
  charsSinceLastScan: 0,
  autoScan: true,
  autoSync: false,
  globalInventory: [],
  globalCurrency: {},
};

// --- System-Type Prompt Config (Phase 3A) ---

const SYSTEM_TYPE_PROMPTS = {
  generic: {
    expectedStats: 'HP, MP, STR, DEX, CON, INT, WIS, CHA, VIT, AGI, LCK, ATK, DEF',
    equipmentSlots: 'weapon, off-hand, helmet, armor, legs, boots, gloves, ring, amulet, cloak, belt, accessory',
    classExamples: 'Warrior, Mage, Rogue, Cleric, Ranger, Paladin, Necromancer',
    contextHint: 'Track levels, stats, classes, and equipment. Use standard RPG conventions.',
    questHint: 'Standard RPG quests — main storyline, side quests, personal objectives.',
  },
  dnd: {
    expectedStats: 'STR, DEX, CON, INT, WIS, CHA (core six D&D ability scores)',
    equipmentSlots: 'weapon, off-hand, shield, helmet, armor, legs, boots, gloves, ring, ring2, amulet, cloak, belt, bracers',
    classExamples: 'Fighter, Wizard, Rogue, Cleric, Ranger, Paladin, Barbarian, Bard, Druid, Monk, Sorcerer, Warlock',
    contextHint: 'D&D-style system. Track the six ability scores (STR/DEX/CON/INT/WIS/CHA) and modifiers. Track spell slots if applicable.',
    questHint: 'D&D-style quests — dungeon delves, monster hunts, patron missions, guild contracts.',
  },
  cultivation: {
    expectedStats: 'Qi, Body, Spirit, Soul, Perception, Willpower',
    equipmentSlots: 'weapon, artifact, talisman, ring, storage_ring, armor, accessory',
    classExamples: 'Sword Cultivator, Body Cultivator, Pill Master, Formation Master, Beast Tamer',
    contextHint: 'Cultivation/Xianxia system. Track cultivation realm (e.g. Qi Condensation, Foundation Establishment, Core Formation, Nascent Soul) and stage as the level equivalent. Track spirit stones as currency. Track qi techniques as abilities.',
    questHint: 'Cultivation-style objectives — tribulations, sect missions, resource gathering, breakthrough challenges, tournament arcs.',
  },
  gamelit: {
    expectedStats: 'HP, MP, STR, DEX, CON, INT, WIS, CHA, LCK, plus any game-specific stats',
    equipmentSlots: 'weapon, off-hand, helmet, armor, legs, boots, gloves, ring, amulet, cloak, belt, trinket',
    classExamples: 'Any class the system presents. GameLit often has unique or hybrid classes.',
    contextHint: 'GameLit system — game-like mechanics in a fantasy world. Track system messages, notifications, and UI windows as data sources.',
    questHint: 'System-assigned quests, hidden quests, chain quests, daily/weekly objectives.',
  },
  mmorpg: {
    expectedStats: 'HP, MP, STR, DEX, CON, INT, WIS, CHA, plus MMO-specific (Aggro, DPS, Crit Rate)',
    equipmentSlots: 'weapon, off-hand, shield, helmet, armor, legs, boots, gloves, ring, ring2, amulet, cloak, belt, trinket, earring',
    classExamples: 'Tank, Healer, DPS, Support, plus specific classes like Berserker, Priest, Assassin, Summoner',
    contextHint: 'MMORPG system. Track party roles (tank/healer/DPS/support), raid mechanics, guild affiliations. Equipment may have rarity tiers.',
    questHint: 'MMO quests — raid objectives, dungeon clears, PvP rankings, guild missions, world events.',
  },
  survival: {
    expectedStats: 'HP, Stamina, Hunger, Thirst, Sanity, plus survival-specific stats',
    equipmentSlots: 'weapon, off-hand, helmet, armor, legs, boots, gloves, backpack, belt, accessory',
    classExamples: 'Survivor, Scout, Builder, Hunter, Medic, Engineer',
    contextHint: 'Survival system. Track hunger, thirst, sanity, and crafting materials alongside combat stats. Inventory management is important.',
    questHint: 'Survival objectives — base defense, resource runs, exploration milestones, rescue missions.',
  },
};

// --- Utility ---

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateRpgId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// --- Fuzzy Matching Helpers (Phase 1A) ---

function fuzzyMatchCharacter(name, characters) {
  let bestId = null;
  let bestScore = 0;
  for (const [id, char] of Object.entries(characters)) {
    const nameScore = fuzzyNameScore(name, char.name);
    if (nameScore > bestScore) { bestScore = nameScore; bestId = id; }
    const loreScore = char.loreEntryName ? fuzzyNameScore(name, char.loreEntryName) : 0;
    if (loreScore > bestScore) { bestScore = loreScore; bestId = id; }
    for (const alias of (char.aliases || [])) {
      const aliasScore = fuzzyNameScore(name, alias);
      if (aliasScore > bestScore) { bestScore = aliasScore; bestId = id; }
    }
  }
  return bestScore >= 0.7 ? bestId : null;
}

function fuzzyMatchQuest(title, quests, threshold = 0.8) {
  let bestQuest = null;
  let bestScore = 0;
  for (const q of quests) {
    const score = fuzzyNameScore(title, q.title);
    if (score > bestScore) { bestScore = score; bestQuest = q; }
  }
  return bestScore >= threshold ? bestQuest : null;
}

function fuzzyMatchInSet(name, nameSet, threshold = 0.7) {
  for (const existing of nameSet) {
    if (fuzzyNameScore(name, existing) >= threshold) return true;
  }
  return false;
}

// --- Schema Validation (Phase 1B) ---

function normalizeStatName(name) {
  return String(name).toUpperCase().trim();
}

function normalizeSlot(slot) {
  if (!slot) return 'other';
  const lower = String(slot).toLowerCase().trim();
  if (VALID_EQUIPMENT_SLOTS.has(lower)) return lower;
  // Common aliases
  const aliases = {
    'main hand': 'weapon', 'mainhand': 'weapon', 'main-hand': 'weapon',
    'offhand': 'off-hand', 'off hand': 'off-hand',
    'head': 'helmet', 'headgear': 'helmet', 'hat': 'helmet', 'crown': 'helmet',
    'chest': 'armor', 'body': 'armor', 'chestpiece': 'armor', 'torso': 'armor',
    'pants': 'legs', 'leg': 'legs', 'greaves': 'legs',
    'shoes': 'boots', 'foot': 'boots', 'footwear': 'boots',
    'hand': 'gloves', 'glove': 'gloves',
    'gauntlet': 'gauntlets', 'bracer': 'bracers', 'wrist': 'wrists',
    'neck': 'amulet', 'pendant': 'amulet',
    'cape': 'cloak', 'mantle': 'cloak',
    'finger': 'ring', 'band': 'ring',
    'ear': 'earring', 'storage_ring': 'ring',
    'bag': 'accessory', 'backpack': 'accessory', 'talisman': 'accessory', 'artifact': 'accessory',
  };
  return aliases[lower] || 'other';
}

function clampConfidence(val) {
  const n = Number(val);
  if (isNaN(n)) return 1;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function validateCharacterRPG(data) {
  if (!data || typeof data !== 'object') return null;
  const cleaned = {
    class: typeof data.class === 'string' ? data.class : null,
    subclass: typeof data.subclass === 'string' ? data.subclass : null,
    level: typeof data.level === 'number' ? data.level : null,
    race: typeof data.race === 'string' ? data.race : null,
    stats: {},
    abilities: [],
    equipment: [],
    xp: null,
    currency: {},
    statusEffects: [],
    inventory: [],
    cultivationRealm: typeof data.cultivationRealm === 'string' ? data.cultivationRealm : null,
    cultivationStage: typeof data.cultivationStage === 'string' ? data.cultivationStage : null,
    role: typeof data.role === 'string' ? data.role : null,
    confidence: clampConfidence(data.confidence),
  };

  // Validate stats
  if (data.stats && typeof data.stats === 'object') {
    for (const [key, val] of Object.entries(data.stats)) {
      const normKey = normalizeStatName(key);
      if (val && typeof val === 'object' && typeof val.value === 'number') {
        cleaned.stats[normKey] = {
          value: val.value,
          modifier: typeof val.modifier === 'number' ? val.modifier : null,
        };
      } else if (typeof val === 'number') {
        cleaned.stats[normKey] = { value: val, modifier: null };
      }
    }
  }

  // Validate abilities
  if (Array.isArray(data.abilities)) {
    for (const a of data.abilities) {
      if (!a || typeof a !== 'object' || !a.name) continue;
      cleaned.abilities.push({
        name: String(a.name),
        description: typeof a.description === 'string' ? a.description : '',
        level: typeof a.level === 'number' ? a.level : null,
        type: VALID_ABILITY_TYPES.has(a.type) ? a.type : 'active',
        cost: typeof a.cost === 'string' ? a.cost : null,
      });
    }
  }

  // Validate equipment
  if (Array.isArray(data.equipment)) {
    for (const e of data.equipment) {
      if (!e || typeof e !== 'object' || !e.name) continue;
      cleaned.equipment.push({
        name: String(e.name),
        slot: normalizeSlot(e.slot),
        description: typeof e.description === 'string' ? e.description : '',
        rarity: VALID_RARITY.has(e.rarity) ? e.rarity : 'unknown',
      });
    }
  }

  // Validate XP
  if (data.xp && typeof data.xp === 'object') {
    cleaned.xp = {
      current: typeof data.xp.current === 'number' ? data.xp.current : null,
      needed: typeof data.xp.needed === 'number' ? data.xp.needed : null,
    };
  }

  // Validate currency
  if (data.currency && typeof data.currency === 'object') {
    for (const [unit, amount] of Object.entries(data.currency)) {
      if (typeof amount === 'number') cleaned.currency[unit.toLowerCase()] = amount;
    }
  }

  // Validate status effects
  if (Array.isArray(data.statusEffects)) {
    for (const s of data.statusEffects) {
      if (!s || typeof s !== 'object' || !s.name) continue;
      cleaned.statusEffects.push({
        name: String(s.name),
        type: VALID_STATUS_TYPES.has(s.type) ? s.type : 'buff',
        duration: typeof s.duration === 'string' ? s.duration : null,
      });
    }
  }

  // Validate inventory
  if (Array.isArray(data.inventory)) {
    for (const item of data.inventory) {
      if (!item || typeof item !== 'object' || !item.name) continue;
      cleaned.inventory.push({
        name: String(item.name),
        quantity: typeof item.quantity === 'number' ? item.quantity : 1,
        type: ['consumable', 'material', 'quest_item', 'other'].includes(item.type) ? item.type : 'other',
      });
    }
  }

  return cleaned;
}

function validateQuestResult(data) {
  if (!data || typeof data !== 'object') return null;
  const cleaned = { newQuests: [], questUpdates: [] };

  if (Array.isArray(data.newQuests)) {
    for (const q of data.newQuests) {
      if (!q || !q.title) continue;
      cleaned.newQuests.push({
        title: String(q.title),
        description: typeof q.description === 'string' ? q.description : '',
        type: ['main', 'side', 'personal'].includes(q.type) ? q.type : 'side',
        objectives: Array.isArray(q.objectives)
          ? q.objectives.filter(o => o && o.text).map(o => ({ text: String(o.text), completed: !!o.completed }))
          : [],
        rewards: typeof q.rewards === 'string' ? q.rewards : null,
        giver: typeof q.giver === 'string' ? q.giver : null,
      });
    }
  }

  if (Array.isArray(data.questUpdates)) {
    for (const u of data.questUpdates) {
      if (!u || !u.title) continue;
      cleaned.questUpdates.push({
        title: String(u.title),
        statusChange: ['completed', 'failed', 'abandoned'].includes(u.statusChange) ? u.statusChange : null,
        objectiveUpdates: Array.isArray(u.objectiveUpdates)
          ? u.objectiveUpdates.filter(o => o && o.text).map(o => ({ text: String(o.text), completed: !!o.completed }))
          : [],
      });
    }
  }

  return cleaned;
}

function validateClassification(data) {
  if (!data || typeof data !== 'object') return null;
  const cleaned = { partyMembers: [], npcs: [] };

  if (Array.isArray(data.partyMembers)) {
    cleaned.partyMembers = data.partyMembers.filter(n => typeof n === 'string');
  }

  if (Array.isArray(data.npcs)) {
    for (const npc of data.npcs) {
      if (!npc || !npc.name) continue;
      cleaned.npcs.push({
        name: String(npc.name),
        faction: typeof npc.faction === 'string' ? npc.faction : null,
        disposition: VALID_DISPOSITIONS.has(npc.disposition) ? npc.disposition : 'unknown',
        role: typeof npc.role === 'string' ? npc.role : null,
        relationship: typeof npc.relationship === 'string' ? npc.relationship : null,
        isRealPerson: typeof npc.isRealPerson === 'boolean' ? npc.isRealPerson : true,
      });
    }
  }

  return cleaned;
}

// --- Retry Logic (Phase 1C) ---

async function retryLLM(fn, maxRetries = 1) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      if (result !== null && result !== undefined) return result;
      console.log(`${LOG_PREFIX} retryLLM: null result on attempt ${attempt + 1}`);
    } catch (err) {
      lastError = err;
      console.warn(`${LOG_PREFIX} retryLLM: error on attempt ${attempt + 1}: ${err.message}`);
    }
    if (attempt < maxRetries) await delay(INTER_CALL_DELAY);
  }
  if (lastError) console.error(`${LOG_PREFIX} retryLLM: all attempts failed:`, lastError.message);
  return null;
}

// --- Regex Pre-Extraction Pipeline (Phase 1D) ---

function regexPreExtract(storyText) {
  const result = {
    stats: {},
    levels: [],
    xp: [],
    currency: [],
    quests: [],
    statusEffects: [],
    inventory: [],
    skills: [],
    cultivation: [],
  };

  // Stat blocks: STR: 18, HP = 500, DEX 14
  const statRe = /\b(HP|MP|SP|STR|DEX|CON|INT|WIS|CHA|VIT|AGI|LCK|END|PER|ATK|DEF|MAG|RES|QI|BODY|SPIRIT|SOUL)\s*[:=]\s*(\d+)/gi;
  for (const m of storyText.matchAll(statRe)) {
    result.stats[m[1].toUpperCase()] = parseInt(m[2], 10);
  }

  // Level mentions: Level 42 Warrior, Lv.15
  const levelRe = /\b(?:level|lv|lvl)\.?\s*(\d+)\s*(\w+)?/gi;
  for (const m of storyText.matchAll(levelRe)) {
    result.levels.push({ level: parseInt(m[1], 10), classHint: m[2] || null });
  }

  // XP: +500 XP, gained 1200 EXP, XP: 500/1000
  const xpRe = /(?:\+\s*(\d[\d,]*)\s*(?:XP|EXP|experience\s+points?))|(?:(?:gained?|earned?|received?)\s+(\d[\d,]*)\s*(?:XP|EXP))|(?:(?:XP|EXP)\s*[:=]\s*(\d[\d,]*)(?:\s*\/\s*(\d[\d,]*))?)/gi;
  for (const m of storyText.matchAll(xpRe)) {
    const amount = parseInt((m[1] || m[2] || m[3] || '0').replace(/,/g, ''), 10);
    const needed = m[4] ? parseInt(m[4].replace(/,/g, ''), 10) : null;
    if (amount > 0) result.xp.push({ amount, needed });
  }

  // Currency: 1,500 gold, 200 silver coins, 50 spirit stones
  const currencyRe = /(\d[\d,]*)\s+(gold|silver|copper|platinum|credits?|coins?|spirit\s+stones?|gems?|rubies|emeralds?|diamonds?|tokens?|marks?|crowns?|bits?|bells?)/gi;
  for (const m of storyText.matchAll(currencyRe)) {
    result.currency.push({ amount: parseInt(m[1].replace(/,/g, ''), 10), unit: m[2].toLowerCase().replace(/\s+/g, '_') });
  }

  // System quest messages: [Quest Received: The Dragon's Hoard], [New Quest: ...]
  const questRe = /\[(?:Quest\s+(?:Received|Accepted|Completed|Failed|Updated)|New\s+Quest|Mission):\s*([^\]]+)\]/gi;
  for (const m of storyText.matchAll(questRe)) {
    result.quests.push(m[1].trim());
  }

  // Status effects: [Buff: Iron Skin], [Debuff: Poisoned], Status Effect: ...
  const statusRe = /\[(?:Buff|Debuff|Status\s*Effect|Condition):\s*([^\]]+)\]|(?:gained|applied|inflicted)\s+(?:the\s+)?(?:buff|debuff|status)\s*(?:effect)?\s*[:—]\s*([^\n.!]+)/gi;
  for (const m of storyText.matchAll(statusRe)) {
    const name = (m[1] || m[2] || '').trim();
    if (name) result.statusEffects.push(name);
  }

  // Inventory gains: obtained Steel Sword, received Healing Potion, looted Dragon Scale
  const inventoryRe = /(?:obtained|received|looted|found|picked\s+up|acquired)\s+(?:a\s+|an\s+|the\s+)?(\d+\s+)?([A-Z][A-Za-z'\-\s]{2,30}?)(?:\s*[.!,\n]|$)/gm;
  for (const m of storyText.matchAll(inventoryRe)) {
    const qty = m[1] ? parseInt(m[1].trim(), 10) : 1;
    const name = m[2].trim();
    if (name.length > 2) result.inventory.push({ name, quantity: qty });
  }

  // Skill unlocks: Skill acquired: Fireball, [Skill Learned: ...], New Skill: ...
  const skillRe = /\[?(?:Skill|Ability)\s+(?:Acquired|Learned|Unlocked|Gained):\s*([^\]\n]+)\]?|(?:learned|unlocked|acquired)\s+(?:the\s+)?(?:skill|ability)\s*[:—]\s*([^\n.!]+)/gi;
  for (const m of storyText.matchAll(skillRe)) {
    const name = (m[1] || m[2] || '').trim();
    if (name) result.skills.push(name);
  }

  // Cultivation: broke through to Core Formation, advanced to Foundation Establishment
  const cultRe = /(?:broke\s+through|advanced|ascended|promoted|reached|entered|stepped\s+into)\s+(?:to\s+|into\s+)?(?:the\s+)?([A-Z][A-Za-z\s]+?(?:Realm|Stage|Layer|Level|Formation|Establishment|Condensation|Soul|Core))/g;
  for (const m of storyText.matchAll(cultRe)) {
    result.cultivation.push(m[1].trim());
  }

  return result;
}

function formatPreExtractedHints(preExtracted) {
  const parts = [];

  if (Object.keys(preExtracted.stats).length > 0) {
    parts.push('Stats: ' + Object.entries(preExtracted.stats).map(([k, v]) => `${k}=${v}`).join(', '));
  }
  if (preExtracted.levels.length > 0) {
    parts.push('Levels: ' + preExtracted.levels.map(l => `Lv.${l.level}${l.classHint ? ' ' + l.classHint : ''}`).join(', '));
  }
  if (preExtracted.xp.length > 0) {
    parts.push('XP: ' + preExtracted.xp.map(x => `${x.amount}${x.needed ? '/' + x.needed : ''}`).join(', '));
  }
  if (preExtracted.currency.length > 0) {
    parts.push('Currency: ' + preExtracted.currency.map(c => `${c.amount} ${c.unit}`).join(', '));
  }
  if (preExtracted.statusEffects.length > 0) {
    parts.push('Status Effects: ' + preExtracted.statusEffects.join(', '));
  }
  if (preExtracted.skills.length > 0) {
    parts.push('Skills Unlocked: ' + preExtracted.skills.join(', '));
  }
  if (preExtracted.cultivation.length > 0) {
    parts.push('Cultivation: ' + preExtracted.cultivation.join(', '));
  }
  if (preExtracted.inventory.length > 0) {
    parts.push('Items obtained: ' + preExtracted.inventory.map(i => i.quantity > 1 ? `${i.quantity}x ${i.name}` : i.name).join(', '));
  }

  if (parts.length === 0) return '';
  return `PRE-EXTRACTED DATA (verified from regex):\n${parts.join('\n')}`;
}

// ============================================================================
// DETECTION
// ============================================================================

function detectLitRPGSignals(storyText) {
  const text = storyText.slice(-MAX_STORY_CONTEXT);
  const patterns = [
    { name: 'stat_blocks', re: /\b(HP|MP|SP|STR|DEX|CON|INT|WIS|CHA|VIT|AGI|LCK|END|PER|ATK|DEF|MAG|RES)\s*[:=]\s*\d+/gi, weight: 3 },
    { name: 'level_mentions', re: /\b(level|lv|lvl)\.?\s*\d+/gi, weight: 3 },
    { name: 'system_messages', re: /\[(System|Notification|Quest|Achievement|Level Up|Skill|Class|Status|Warning|Alert)\]/gi, weight: 4 },
    { name: 'class_references', re: /\b(Level\s+\d+\s+\w+|[Cc]lass:\s*\w+|advanced to\s+\w+|evolved into\s+\w+)/gi, weight: 3 },
    { name: 'xp_mentions', re: /\b(experience\s+points?|XP|EXP)\s*[+:=]/gi, weight: 2 },
    { name: 'skill_mechanics', re: /\b(cooldown|mana\s+cost|skill\s+level|passive\s+skill|active\s+skill|skill\s+tree|ability\s+unlocked)\b/gi, weight: 2 },
    { name: 'rpg_vocabulary', re: /\b(buff|debuff|dungeon\s+boss|party\s+member|inventory|quest\s+log|hit\s+points|mana\s+pool|stamina|aggro)\b/gi, weight: 1 },
    { name: 'status_window', re: /\b(status\s+window|status\s+screen|character\s+sheet|stat\s+screen|skill\s+list)\b/gi, weight: 3 },
    { name: 'cultivation', re: /\b(qi|cultivation|realm|foundation\s+establishment|core\s+formation|nascent\s+soul|spirit\s+stones?)\b/gi, weight: 3 },
  ];

  let score = 0;
  const signals = [];
  for (const { name, re, weight } of patterns) {
    const matches = text.match(re);
    if (matches && matches.length > 0) {
      const contribution = Math.min(matches.length, 3) * weight;
      score += contribution;
      signals.push({ name, count: matches.length, contribution });
    }
  }

  return { score, signals, meetsThreshold: score >= DETECTION_THRESHOLD };
}

async function confirmLitRPG(storyText, generateTextFn) {
  const text = storyText.slice(-MAX_STORY_CONTEXT);
  const messages = [
    {
      role: 'system',
      content: 'You classify story genres. Answer with ONLY valid JSON, no other text.'
    },
    {
      role: 'user',
      content: `Does this story contain LitRPG or GameLit game mechanics (stat systems, level progression, skills, quests, etc.)?

STORY TEXT:
${text}

Output: {"isLitRPG": true/false, "systemType": "generic|dnd|cultivation|gamelit|mmorpg|survival", "confidence": 1-5}`
    }
  ];

  try {
    const result = await generateTextFn(messages, { max_tokens: 100, temperature: 0.2 });
    const parsed = recoverJSON(result.output);
    if (!parsed) return null;
    return {
      isLitRPG: !!parsed.isLitRPG,
      systemType: parsed.systemType || 'generic',
      confidence: parsed.confidence || 1,
    };
  } catch (err) {
    console.error(`${LOG_PREFIX} confirmLitRPG error:`, err.message);
    return null;
  }
}

async function detectLitRPG(storyText, generateTextFn) {
  const signals = detectLitRPGSignals(storyText);
  console.log(`${LOG_PREFIX} Detection score: ${signals.score} (threshold: ${DETECTION_THRESHOLD})`);

  if (!signals.meetsThreshold) {
    return { detected: false, systemType: null, signals };
  }

  const confirmation = await confirmLitRPG(storyText, generateTextFn);
  if (!confirmation) {
    return { detected: false, systemType: null, signals };
  }

  console.log(`${LOG_PREFIX} LLM confirmation: isLitRPG=${confirmation.isLitRPG}, type=${confirmation.systemType}, confidence=${confirmation.confidence}`);
  return {
    detected: confirmation.isLitRPG && confirmation.confidence >= CONFIDENCE_GATE,
    systemType: confirmation.systemType,
    signals,
  };
}

// ============================================================================
// RPG SCAN PASSES (Phase 3B — System-Type-Aware Prompts)
// ============================================================================

async function extractCharacterRPG(characterName, characterEntryText, storyText, generateTextFn, comprehensionContext, systemType, preExtractedHints) {
  const typeConfig = SYSTEM_TYPE_PROMPTS[systemType] || SYSTEM_TYPE_PROMPTS.generic;
  const recentText = storyText.slice(-MAX_STORY_CONTEXT);
  const contextBlock = comprehensionContext ? `${comprehensionContext}\n` : '';
  const hintsBlock = preExtractedHints ? `\n${preExtractedHints}\n` : '';

  const messages = [
    {
      role: 'system',
      content: `You extract RPG game mechanics data from LitRPG story text. ${typeConfig.contextHint} Output ONLY valid JSON. Only include data explicitly stated in the text — do not infer or guess.`
    },
    {
      role: 'user',
      content: `Extract RPG statistics for the character "${characterName}" from this story.
${contextBlock}CHARACTER ENTRY:
${characterEntryText}
${hintsBlock}
EXPECTED STATS: ${typeConfig.expectedStats}
VALID EQUIPMENT SLOTS: ${typeConfig.equipmentSlots}
COMMON CLASSES: ${typeConfig.classExamples}

RECENT STORY TEXT:
${recentText}

Extract ONLY information explicitly stated. Use null for unknown fields. Output this JSON format:
{"class":"class name or null","subclass":"subclass or null","level":number or null,"race":"race or null","stats":{"STAT_NAME":{"value":number,"modifier":number or null}},"abilities":[{"name":"...","description":"...","level":number or null,"type":"active|passive","cost":"cost string or null"}],"equipment":[{"name":"...","slot":"slot name","description":"...","rarity":"common|uncommon|rare|epic|legendary|unknown"}],"xp":{"current":number or null,"needed":number or null},"currency":{"unit_name":amount},"statusEffects":[{"name":"...","type":"buff|debuff|condition","duration":"duration or null"}],"inventory":[{"name":"...","quantity":number,"type":"consumable|material|quest_item|other"}],"cultivationRealm":"realm name or null","cultivationStage":"stage or null","role":"tank|healer|DPS|support|null","confidence":1-5}`
    }
  ];

  return retryLLM(async () => {
    const result = await generateTextFn(messages, { max_tokens: 800, temperature: 0.3 });
    const parsed = recoverJSON(result.output);
    const validated = validateCharacterRPG(parsed);
    if (!validated || validated.confidence < CONFIDENCE_GATE) return null;
    return validated;
  });
}

async function extractQuests(storyText, existingQuests, generateTextFn, comprehensionContext, systemType, preExtractedHints) {
  const typeConfig = SYSTEM_TYPE_PROMPTS[systemType] || SYSTEM_TYPE_PROMPTS.generic;
  const recentText = storyText.slice(-MAX_STORY_CONTEXT);
  const contextBlock = comprehensionContext ? `${comprehensionContext}\n` : '';
  const hintsBlock = preExtractedHints ? `\n${preExtractedHints}\n` : '';

  const existingQuestSummary = existingQuests.length > 0
    ? `KNOWN QUESTS:\n${existingQuests.map(q => `- "${q.title}" (${q.status}): ${q.objectives.map(o => o.text).join(', ')}`).join('\n')}\n`
    : '';

  const messages = [
    {
      role: 'system',
      content: `You identify quests, missions, and objectives from LitRPG story text. ${typeConfig.questHint} Output ONLY valid JSON. Only include quests explicitly mentioned in the text.`
    },
    {
      role: 'user',
      content: `Identify quests, missions, or objectives in this story text.
${contextBlock}${existingQuestSummary}${hintsBlock}
RECENT STORY TEXT:
${recentText}

Example output format:
{"newQuests":[{"title":"The Dragon's Hoard","description":"Slay the dragon and claim its treasure","type":"main","objectives":[{"text":"Find the dragon's lair","completed":false},{"text":"Defeat the dragon","completed":false}],"rewards":"500 gold, Dragon Scale Armor","giver":"Village Elder"}],"questUpdates":[{"title":"Rat Problem","statusChange":"completed","objectiveUpdates":[{"text":"Kill 10 rats","completed":true}]}]}

Find new quests AND status changes to known quests. Output:
{"newQuests":[{"title":"...","description":"...","type":"main|side|personal","objectives":[{"text":"...","completed":false}],"rewards":"reward text or null","giver":"character name or null"}],"questUpdates":[{"title":"existing quest title matching known quests above","statusChange":"completed|failed|abandoned|null","objectiveUpdates":[{"text":"objective text","completed":true}]}]}`
    }
  ];

  return retryLLM(async () => {
    const result = await generateTextFn(messages, { max_tokens: 400, temperature: 0.3 });
    const parsed = recoverJSON(result.output);
    return validateQuestResult(parsed);
  });
}

async function classifyPartyAndNPCs(characterNames, storyText, generateTextFn, comprehensionContext, systemType) {
  if (characterNames.length === 0) return { partyMembers: [], npcs: [] };

  const typeConfig = SYSTEM_TYPE_PROMPTS[systemType] || SYSTEM_TYPE_PROMPTS.generic;
  const recentText = storyText.slice(-3000);
  const contextBlock = comprehensionContext ? `${comprehensionContext}\n` : '';

  const messages = [
    {
      role: 'system',
      content: `You classify characters in LitRPG stories. ${typeConfig.contextHint} Output ONLY valid JSON. Base classification on explicit story evidence only.`
    },
    {
      role: 'user',
      content: `Classify these characters based on the story context. "Party members" travel with or fight alongside the protagonist. "NPCs" are other characters encountered in the story world.
${contextBlock}CHARACTERS: ${characterNames.join(', ')}

RECENT STORY TEXT:
${recentText}

Output:
{"partyMembers":["Name1","Name2"],"npcs":[{"name":"Name3","faction":"faction name or null","disposition":"friendly|neutral|hostile|unknown","role":"mentor|rival|shopkeeper|quest_giver|boss|ally|other|null","relationship":"relationship description or null","isRealPerson":true/false}]}`
    }
  ];

  return retryLLM(async () => {
    const result = await generateTextFn(messages, { max_tokens: 300, temperature: 0.3 });
    const parsed = recoverJSON(result.output);
    return validateClassification(parsed);
  });
}

// ============================================================================
// MERGE HELPERS (Phase 4D)
// ============================================================================

function mergeEquipment(existing, incoming) {
  const merged = [...(existing || [])];
  for (const newItem of (incoming || [])) {
    const matchIdx = merged.findIndex(e => fuzzyNameScore(e.name, newItem.name) >= 0.8);
    if (matchIdx >= 0) {
      merged[matchIdx] = { ...merged[matchIdx], ...newItem };
    } else {
      merged.push(newItem);
    }
  }
  return merged;
}

function mergeAbilities(existing, incoming) {
  const merged = [...(existing || [])];
  for (const newAbility of (incoming || [])) {
    const matchIdx = merged.findIndex(a => fuzzyNameScore(a.name, newAbility.name) >= 0.8);
    if (matchIdx >= 0) {
      merged[matchIdx] = { ...merged[matchIdx], ...newAbility };
    } else {
      merged.push(newAbility);
    }
  }
  return merged;
}

function mergeInventory(existing, incoming) {
  const merged = [...(existing || [])];
  for (const newItem of (incoming || [])) {
    const matchIdx = merged.findIndex(i => fuzzyNameScore(i.name, newItem.name) >= 0.8);
    if (matchIdx >= 0) {
      merged[matchIdx].quantity = (merged[matchIdx].quantity || 1) + (newItem.quantity || 1);
    } else {
      merged.push(newItem);
    }
  }
  return merged;
}

function mergeCurrency(existing, incoming) {
  const merged = { ...(existing || {}) };
  for (const [unit, amount] of Object.entries(incoming || {})) {
    merged[unit] = (merged[unit] || 0) + amount;
  }
  return merged;
}

// ============================================================================
// CHANGE DETECTION (Phase 4E)
// ============================================================================

function hasCharacterChanged(before, after) {
  if (before.class !== after.class) return true;
  if (before.subclass !== after.subclass) return true;
  if (before.level !== after.level) return true;
  if (before.race !== after.race) return true;
  if (before.cultivationRealm !== after.cultivationRealm) return true;
  if (before.role !== after.role) return true;

  // Compare stat values (not just count)
  const beforeStats = before.stats || {};
  const afterStats = after.stats || {};
  const allStatKeys = new Set([...Object.keys(beforeStats), ...Object.keys(afterStats)]);
  for (const key of allStatKeys) {
    const bv = beforeStats[key]?.value;
    const av = afterStats[key]?.value;
    if (bv !== av) return true;
  }

  // Compare ability names (not just count)
  const beforeAbilityNames = (before.abilities || []).map(a => a.name).sort();
  const afterAbilityNames = (after.abilities || []).map(a => a.name).sort();
  if (beforeAbilityNames.length !== afterAbilityNames.length) return true;
  for (let i = 0; i < beforeAbilityNames.length; i++) {
    if (fuzzyNameScore(beforeAbilityNames[i], afterAbilityNames[i]) < 0.8) return true;
  }

  // Compare equipment names
  const beforeEquipNames = (before.equipment || []).map(e => e.name).sort();
  const afterEquipNames = (after.equipment || []).map(e => e.name).sort();
  if (beforeEquipNames.length !== afterEquipNames.length) return true;
  for (let i = 0; i < beforeEquipNames.length; i++) {
    if (fuzzyNameScore(beforeEquipNames[i], afterEquipNames[i]) < 0.8) return true;
  }

  // XP change
  const bxp = before.xp || {};
  const axp = after.xp || {};
  if (bxp.current !== axp.current || bxp.needed !== axp.needed) return true;

  // Currency change
  const allCurrKeys = new Set([...Object.keys(before.currency || {}), ...Object.keys(after.currency || {})]);
  for (const key of allCurrKeys) {
    if ((before.currency || {})[key] !== (after.currency || {})[key]) return true;
  }

  // Status effects
  if ((before.statusEffects || []).length !== (after.statusEffects || []).length) return true;

  // Inventory count
  if ((before.inventory || []).length !== (after.inventory || []).length) return true;

  return false;
}

function describeChanges(before, after) {
  const changes = [];

  if (before.class !== after.class) changes.push({ field: 'Class', before: before.class || 'none', after: after.class });
  if (before.subclass !== after.subclass) changes.push({ field: 'Subclass', before: before.subclass || 'none', after: after.subclass });
  if (before.level !== after.level) changes.push({ field: 'Level', before: before.level || '?', after: after.level });
  if (before.race !== after.race) changes.push({ field: 'Race', before: before.race || 'none', after: after.race });
  if (before.cultivationRealm !== after.cultivationRealm) changes.push({ field: 'Cultivation Realm', before: before.cultivationRealm || 'none', after: after.cultivationRealm });
  if (before.role !== after.role) changes.push({ field: 'Role', before: before.role || 'none', after: after.role });

  // Stat value changes
  const allStatKeys = new Set([...Object.keys(before.stats || {}), ...Object.keys(after.stats || {})]);
  for (const key of allStatKeys) {
    const bv = (before.stats || {})[key]?.value;
    const av = (after.stats || {})[key]?.value;
    if (bv !== av) {
      changes.push({ field: `${key}`, before: bv != null ? String(bv) : 'none', after: av != null ? String(av) : 'removed' });
    }
  }

  // New abilities
  const beforeAbilNames = new Set((before.abilities || []).map(a => a.name.toLowerCase()));
  const newAbilities = (after.abilities || []).filter(a => !beforeAbilNames.has(a.name.toLowerCase()));
  if (newAbilities.length > 0) {
    changes.push({ field: 'Abilities', before: `${(before.abilities || []).length}`, after: `+${newAbilities.length} new (${newAbilities.map(a => a.name).join(', ')})` });
  }

  // New equipment
  const beforeEquipNames = new Set((before.equipment || []).map(e => e.name.toLowerCase()));
  const newEquip = (after.equipment || []).filter(e => !beforeEquipNames.has(e.name.toLowerCase()));
  if (newEquip.length > 0) {
    changes.push({ field: 'Equipment', before: `${(before.equipment || []).length} items`, after: `+${newEquip.length} new (${newEquip.map(e => e.name).join(', ')})` });
  }

  // XP
  const bxp = before.xp || {};
  const axp = after.xp || {};
  if (bxp.current !== axp.current) {
    changes.push({ field: 'XP', before: bxp.current != null ? String(bxp.current) : 'none', after: axp.current != null ? String(axp.current) : 'none' });
  }

  // Currency
  const allCurrKeys = new Set([...Object.keys(before.currency || {}), ...Object.keys(after.currency || {})]);
  for (const key of allCurrKeys) {
    const bv = (before.currency || {})[key];
    const av = (after.currency || {})[key];
    if (bv !== av) changes.push({ field: `Currency (${key})`, before: bv != null ? String(bv) : '0', after: av != null ? String(av) : '0' });
  }

  return changes;
}

// ============================================================================
// SCAN ORCHESTRATOR (Phase 2 — Incremental Scanning)
// ============================================================================

async function scanForRPGData(storyText, rpgState, loreEntries, generateTextFn, onProgress, comprehensionContext, secondaryGenerateTextFn) {
  const state = { ...LITRPG_STATE_DEFAULTS, ...rpgState };
  const systemType = state.systemType || 'generic';

  // --- Incremental scanning (Phase 2) ---
  const newTextLength = storyText.length - (state.lastProcessedLength || 0);
  if (state.lastScanAt && newTextLength < MIN_INCREMENTAL_CHARS) {
    console.log(`${LOG_PREFIX} Skipping scan — only ${newTextLength} new chars (threshold: ${MIN_INCREMENTAL_CHARS})`);
    if (onProgress) onProgress({ phase: 'complete' });
    return { state };
  }

  // Dynamic context: overlap for continuity + new text
  const contextSize = Math.min(8000, Math.max(MAX_STORY_CONTEXT, newTextLength + 2000));
  const contextStart = state.lastProcessedLength > 0
    ? Math.max(0, state.lastProcessedLength - 2000)
    : Math.max(0, storyText.length - contextSize);
  const scanText = storyText.slice(contextStart);

  // --- Regex pre-extraction (Phase 1D) ---
  const preExtracted = regexPreExtract(scanText);
  const preExtractedHints = formatPreExtractedHints(preExtracted);
  if (preExtractedHints) {
    console.log(`${LOG_PREFIX} Pre-extracted:`, Object.entries(preExtracted).filter(([, v]) => Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0).map(([k]) => k).join(', '));
  }

  const characterEntries = loreEntries.filter(e => {
    const text = (e.text || '').toLowerCase();
    return text.includes('name:') || text.includes('appearance') || text.includes('class:');
  });

  const providers = secondaryGenerateTextFn
    ? [generateTextFn, secondaryGenerateTextFn]
    : [generateTextFn];

  // -------------------------------------------------------------------
  // Pass R1: Character RPG Extraction
  // -------------------------------------------------------------------
  if (onProgress) onProgress({ phase: 'characters', current: 0, total: characterEntries.length });
  console.log(`${LOG_PREFIX} R1: Extracting RPG data for ${characterEntries.length} characters`);

  for (let i = 0; i < characterEntries.length; i++) {
    const entry = characterEntries[i];
    const provider = providers[i % providers.length];

    if (i > 0 && (providers.length === 1 || i % providers.length === 0)) {
      await delay(INTER_CALL_DELAY);
    }

    const rpgData = await extractCharacterRPG(
      entry.displayName, entry.text, scanText, provider, comprehensionContext, systemType, preExtractedHints
    );

    if (rpgData) {
      // Fuzzy match existing character (Phase 1A)
      let charId = fuzzyMatchCharacter(entry.displayName, state.characters);

      const existingChar = charId ? state.characters[charId] : null;
      const updatedChar = {
        id: charId || generateRpgId('char'),
        name: entry.displayName,
        loreEntryName: entry.displayName,
        aliases: existingChar ? (existingChar.aliases || []) : [],
        class: rpgData.class || (existingChar && existingChar.class) || null,
        subclass: rpgData.subclass || (existingChar && existingChar.subclass) || null,
        level: rpgData.level || (existingChar && existingChar.level) || null,
        race: rpgData.race || (existingChar && existingChar.race) || null,
        stats: rpgData.stats && Object.keys(rpgData.stats).length > 0 ? rpgData.stats : (existingChar && existingChar.stats) || {},
        abilities: rpgData.abilities && rpgData.abilities.length > 0
          ? (existingChar ? mergeAbilities(existingChar.abilities, rpgData.abilities) : rpgData.abilities)
          : (existingChar && existingChar.abilities) || [],
        equipment: rpgData.equipment && rpgData.equipment.length > 0
          ? (existingChar ? mergeEquipment(existingChar.equipment, rpgData.equipment) : rpgData.equipment)
          : (existingChar && existingChar.equipment) || [],
        xp: rpgData.xp || (existingChar && existingChar.xp) || { current: null, needed: null },
        currency: rpgData.currency && Object.keys(rpgData.currency).length > 0
          ? (existingChar ? mergeCurrency(existingChar.currency, rpgData.currency) : rpgData.currency)
          : (existingChar && existingChar.currency) || {},
        statusEffects: rpgData.statusEffects && rpgData.statusEffects.length > 0 ? rpgData.statusEffects : (existingChar && existingChar.statusEffects) || [],
        inventory: rpgData.inventory && rpgData.inventory.length > 0
          ? (existingChar ? mergeInventory(existingChar.inventory, rpgData.inventory) : rpgData.inventory)
          : (existingChar && existingChar.inventory) || [],
        cultivationRealm: rpgData.cultivationRealm || (existingChar && existingChar.cultivationRealm) || null,
        cultivationStage: rpgData.cultivationStage || (existingChar && existingChar.cultivationStage) || null,
        role: rpgData.role || (existingChar && existingChar.role) || null,
        isPartyMember: existingChar ? existingChar.isPartyMember : false,
        isNPC: existingChar ? existingChar.isNPC : false,
        faction: existingChar ? existingChar.faction : null,
        disposition: existingChar ? existingChar.disposition : null,
        portraitPath: existingChar ? existingChar.portraitPath : null,
        levelHistory: existingChar ? existingChar.levelHistory : [],
        lastUpdated: Date.now(),
      };

      // Track level changes
      if (rpgData.level && existingChar && existingChar.level !== rpgData.level) {
        updatedChar.levelHistory = [...(existingChar.levelHistory || []), { level: rpgData.level, timestamp: Date.now() }];
      } else if (rpgData.level && !existingChar) {
        updatedChar.levelHistory = [{ level: rpgData.level, timestamp: Date.now() }];
      }

      // Generate pending update if character changed
      if (existingChar && hasCharacterChanged(existingChar, updatedChar)) {
        state.pendingUpdates.push({
          id: generateRpgId('rpg_update'),
          type: 'character',
          characterId: updatedChar.id,
          characterName: updatedChar.name,
          before: existingChar,
          after: updatedChar,
          changes: describeChanges(existingChar, updatedChar),
          createdAt: Date.now(),
        });
      } else if (!existingChar) {
        state.characters[updatedChar.id] = updatedChar;
      }
    }

    if (onProgress) onProgress({ phase: 'characters', current: i + 1, total: characterEntries.length });
  }

  await delay(INTER_CALL_DELAY);

  // -------------------------------------------------------------------
  // Pass R2: Quest Extraction
  // -------------------------------------------------------------------
  if (onProgress) onProgress({ phase: 'quests', current: 0, total: 1 });
  console.log(`${LOG_PREFIX} R2: Extracting quests`);

  const existingQuests = Object.values(state.quests);
  const questResult = await extractQuests(scanText, existingQuests, generateTextFn, comprehensionContext, systemType, preExtractedHints);

  if (questResult) {
    // Add new quests
    if (questResult.newQuests) {
      for (const q of questResult.newQuests) {
        if (!q.title) continue;
        // Fuzzy duplicate check (Phase 1A)
        const isDuplicate = fuzzyMatchQuest(q.title, existingQuests, 0.8);
        if (isDuplicate) continue;

        const questId = generateRpgId('quest');
        state.quests[questId] = {
          id: questId,
          title: q.title,
          description: q.description || '',
          status: 'active',
          type: q.type || 'side',
          objectives: (q.objectives || []).map(o => ({ text: o.text, completed: !!o.completed })),
          rewards: q.rewards || null,
          giver: q.giver || null,
          location: null,
          discoveredAt: Date.now(),
          completedAt: null,
          lastUpdated: Date.now(),
        };
      }
    }

    // Apply quest updates
    if (questResult.questUpdates) {
      for (const update of questResult.questUpdates) {
        if (!update.title) continue;
        // Fuzzy quest title matching (Phase 1A)
        const matchingQuest = fuzzyMatchQuest(update.title, existingQuests, 0.8);
        if (!matchingQuest) continue;

        if (update.statusChange && ['completed', 'failed', 'abandoned'].includes(update.statusChange)) {
          state.pendingUpdates.push({
            id: generateRpgId('rpg_update'),
            type: 'quest_status',
            questId: matchingQuest.id,
            questTitle: matchingQuest.title,
            oldStatus: matchingQuest.status,
            newStatus: update.statusChange,
            createdAt: Date.now(),
          });
        }

        if (update.objectiveUpdates) {
          for (const objUpdate of update.objectiveUpdates) {
            const matchingObj = matchingQuest.objectives.find(o =>
              fuzzyNameScore(o.text, objUpdate.text) >= 0.7
            );
            if (matchingObj && !matchingObj.completed && objUpdate.completed) {
              state.pendingUpdates.push({
                id: generateRpgId('rpg_update'),
                type: 'quest_objective',
                questId: matchingQuest.id,
                questTitle: matchingQuest.title,
                objectiveText: matchingObj.text,
                createdAt: Date.now(),
              });
            }
          }
        }
      }
    }
  }

  if (onProgress) onProgress({ phase: 'quests', current: 1, total: 1 });
  await delay(INTER_CALL_DELAY);

  // -------------------------------------------------------------------
  // Pass R3: Party & NPC Classification
  // -------------------------------------------------------------------
  const allCharNames = Object.values(state.characters).map(c => c.name);
  if (allCharNames.length > 0) {
    if (onProgress) onProgress({ phase: 'party', current: 0, total: 1 });
    console.log(`${LOG_PREFIX} R3: Classifying party/NPCs for ${allCharNames.length} characters`);

    const classification = await classifyPartyAndNPCs(allCharNames, scanText, generateTextFn, comprehensionContext, systemType);

    if (classification) {
      // Fuzzy match party members (Phase 1A)
      for (const partyName of (classification.partyMembers || [])) {
        const matchId = fuzzyMatchCharacter(partyName, state.characters);
        if (matchId) {
          state.characters[matchId].isPartyMember = true;
          state.characters[matchId].isNPC = false;
        }
      }

      // Fuzzy match NPCs (Phase 1A)
      for (const npc of (classification.npcs || [])) {
        if (!npc.name) continue;
        const matchId = fuzzyMatchCharacter(npc.name, state.characters);
        if (matchId) {
          const char = state.characters[matchId];
          char.isPartyMember = false;
          char.isNPC = true;
          char.faction = npc.faction || char.faction;
          char.disposition = npc.disposition || char.disposition;
          if (npc.role) char.npcRole = npc.role;
          if (npc.relationship) char.npcRelationship = npc.relationship;
        }
      }

      // Update party members list
      state.party.members = Object.entries(state.characters)
        .filter(([, c]) => c.isPartyMember)
        .map(([id]) => id);
      state.party.lastUpdated = Date.now();
    }

    if (onProgress) onProgress({ phase: 'party', current: 1, total: 1 });
  }

  state.lastProcessedLength = storyText.length;
  state.lastScanAt = Date.now();
  state.charsSinceLastScan = 0;

  if (onProgress) onProgress({ phase: 'complete' });
  console.log(`${LOG_PREFIX} Scan complete: ${Object.keys(state.characters).length} chars, ${Object.keys(state.quests).length} quests, ${state.pendingUpdates.length} pending updates`);

  return { state };
}

// ============================================================================
// PENDING UPDATE ACTIONS
// ============================================================================

function acceptPendingUpdate(rpgState, updateId) {
  const state = { ...rpgState };
  const updateIdx = state.pendingUpdates.findIndex(u => u.id === updateId);
  if (updateIdx < 0) return state;

  const update = state.pendingUpdates[updateIdx];

  if (update.type === 'character') {
    state.characters[update.characterId] = update.after;
  } else if (update.type === 'quest_status') {
    const quest = state.quests[update.questId];
    if (quest) {
      quest.status = update.newStatus;
      quest.lastUpdated = Date.now();
      if (update.newStatus === 'completed') quest.completedAt = Date.now();
    }
  } else if (update.type === 'quest_objective') {
    const quest = state.quests[update.questId];
    if (quest) {
      const obj = quest.objectives.find(o => o.text === update.objectiveText);
      if (obj) obj.completed = true;
      quest.lastUpdated = Date.now();
    }
  }

  state.pendingUpdates.splice(updateIdx, 1);
  return state;
}

function rejectPendingUpdate(rpgState, updateId) {
  const state = { ...rpgState };
  state.pendingUpdates = state.pendingUpdates.filter(u => u.id !== updateId);
  return state;
}

function acceptAllPendingUpdates(rpgState) {
  let state = { ...rpgState };
  const updates = [...(state.pendingUpdates || [])];
  for (const update of updates) {
    state = acceptPendingUpdate(state, update.id);
  }
  return state;
}

function rejectAllPendingUpdates(rpgState) {
  const state = { ...rpgState };
  state.pendingUpdates = [];
  return state;
}

// ============================================================================
// LOREBOOK TEXT BUILDER (Phase 6A)
// ============================================================================

const LITRPG_CHARACTER_TEMPLATE = `Name: [Full name, including last name]
Race: [Race, if applicable]
Class: [Class and subclass]
Level: [Current level]
XP: [Current XP / XP needed for next level]
Cultivation Realm: [Cultivation realm and stage, if applicable]
Age: [Age or approximate age]
Gender: [Gender identity]
Physical Appearance: [Detailed physical description]
Sexuality: [Sexual orientation and interests, if relevant]
Description: [Personality, role, and key traits]
Self-Image: [How they see themselves; self-perception vs reality]
Motivations/Goals: [What drives them; what they want]
Secrets: [Hidden knowledge, lies, concealed truths]
Stats: [Key stats, e.g. STR 18, DEX 14, INT 20]
Abilities:
- [Ability Name]: [Brief description]
Equipment:
- [Item Name]: [Slot, key properties]
Inventory:
- [Item Name]: [Quantity, type]
Currency: [Currency amounts, e.g. 1500 gold, 200 silver]
Status Effects: [Active buffs/debuffs]
Relationships:
- [Name]: [relationship type and dynamic]
Family:
- [Name]: [family role, e.g. sister, father]
Background: [History and backstory]
Additional notes: [Any other relevant details]`;

function spliceField(text, fieldName, value) {
  if (value === null || value === undefined || value === '') return text;
  const fieldPattern = new RegExp(`^${fieldName}:.*$`, 'm');
  const replacement = `${fieldName}: ${value}`;

  if (fieldPattern.test(text)) {
    return text.replace(fieldPattern, replacement);
  }

  const templateOrder = [
    'Name', 'Race', 'Class', 'Level', 'XP', 'Cultivation Realm',
    'Age', 'Gender', 'Physical Appearance', 'Sexuality', 'Description', 'Self-Image',
    'Motivations/Goals', 'Secrets', 'Stats', 'Abilities', 'Equipment',
    'Inventory', 'Currency', 'Status Effects',
    'Relationships', 'Family', 'Background', 'Additional notes',
  ];

  const targetIdx = templateOrder.indexOf(fieldName);
  if (targetIdx < 0) {
    return text.trimEnd() + `\n${replacement}`;
  }

  for (let i = targetIdx + 1; i < templateOrder.length; i++) {
    const nextField = templateOrder[i];
    const nextPattern = new RegExp(`^${nextField.replace('/', '\\/')}:`, 'm');
    const match = text.match(nextPattern);
    if (match) {
      const insertPos = text.indexOf(match[0]);
      return text.slice(0, insertPos) + replacement + '\n' + text.slice(insertPos);
    }
  }

  return text.trimEnd() + `\n${replacement}`;
}

function spliceSection(text, sectionName, content) {
  if (!content) return text;
  const sectionPattern = new RegExp(`^${sectionName}:.*(?:\\n(?:\\s*-\\s+.*|\\s*))*$`, 'm');

  if (sectionPattern.test(text)) {
    return text.replace(sectionPattern, `${sectionName}:\n${content}`);
  }

  const templateOrder = [
    'Name', 'Race', 'Class', 'Level', 'XP', 'Cultivation Realm',
    'Age', 'Gender', 'Physical Appearance', 'Sexuality', 'Description', 'Self-Image',
    'Motivations/Goals', 'Secrets', 'Stats', 'Abilities', 'Equipment',
    'Inventory', 'Currency', 'Status Effects',
    'Relationships', 'Family', 'Background', 'Additional notes',
  ];

  const targetIdx = templateOrder.indexOf(sectionName);
  for (let i = targetIdx + 1; i < templateOrder.length; i++) {
    const nextField = templateOrder[i];
    const nextPattern = new RegExp(`^${nextField.replace('/', '\\/')}:`, 'm');
    const match = text.match(nextPattern);
    if (match) {
      const insertPos = text.indexOf(match[0]);
      return text.slice(0, insertPos) + `${sectionName}:\n${content}\n` + text.slice(insertPos);
    }
  }

  return text.trimEnd() + `\n${sectionName}:\n${content}`;
}

function buildLitRPGCharacterText(entryText, rpgData) {
  let text = entryText;

  text = spliceField(text, 'Race', rpgData.race);
  text = spliceField(text, 'Class', [rpgData.class, rpgData.subclass].filter(Boolean).join(' / ') || null);
  text = spliceField(text, 'Level', rpgData.level != null ? String(rpgData.level) : null);

  // XP
  if (rpgData.xp && (rpgData.xp.current != null || rpgData.xp.needed != null)) {
    const xpStr = [
      rpgData.xp.current != null ? String(rpgData.xp.current) : '?',
      rpgData.xp.needed != null ? String(rpgData.xp.needed) : '?',
    ].join(' / ');
    text = spliceField(text, 'XP', xpStr);
  }

  // Cultivation
  if (rpgData.cultivationRealm) {
    const cultStr = [rpgData.cultivationRealm, rpgData.cultivationStage].filter(Boolean).join(', ');
    text = spliceField(text, 'Cultivation Realm', cultStr);
  }

  // Stats
  if (rpgData.stats && Object.keys(rpgData.stats).length > 0) {
    const statsStr = Object.entries(rpgData.stats)
      .map(([k, v]) => `${k} ${v.value}`)
      .join(', ');
    text = spliceField(text, 'Stats', statsStr);
  }

  // Abilities
  if (rpgData.abilities && rpgData.abilities.length > 0) {
    const abilitiesStr = rpgData.abilities
      .map(a => `- ${a.name}: ${a.description}${a.cost ? ` [${a.cost}]` : ''}`)
      .join('\n');
    text = spliceSection(text, 'Abilities', abilitiesStr);
  }

  // Equipment
  if (rpgData.equipment && rpgData.equipment.length > 0) {
    const equipStr = rpgData.equipment
      .map(e => `- ${e.name}: ${e.slot}${e.rarity && e.rarity !== 'unknown' ? ` (${e.rarity})` : ''}, ${e.description}`)
      .join('\n');
    text = spliceSection(text, 'Equipment', equipStr);
  }

  // Inventory
  if (rpgData.inventory && rpgData.inventory.length > 0) {
    const invStr = rpgData.inventory
      .map(i => `- ${i.name}: ${i.quantity}x (${i.type})`)
      .join('\n');
    text = spliceSection(text, 'Inventory', invStr);
  }

  // Currency
  if (rpgData.currency && Object.keys(rpgData.currency).length > 0) {
    const currStr = Object.entries(rpgData.currency)
      .map(([unit, amount]) => `${amount} ${unit}`)
      .join(', ');
    text = spliceField(text, 'Currency', currStr);
  }

  // Status Effects
  if (rpgData.statusEffects && rpgData.statusEffects.length > 0) {
    const statusStr = rpgData.statusEffects
      .map(s => `${s.name} (${s.type})${s.duration ? ` [${s.duration}]` : ''}`)
      .join(', ');
    text = spliceField(text, 'Status Effects', statusStr);
  }

  return text;
}

async function generatePortraitPrompt(characterEntryText, rpgData, generateTextFn) {
  const equipmentStr = (rpgData.equipment || []).map(e => e.name).join(', ') || 'none specified';
  const messages = [
    {
      role: 'system',
      content: 'You create concise character portrait descriptions for AI image generation. Output ONLY the prompt text, no JSON, no quotes.'
    },
    {
      role: 'user',
      content: `Create an AI image generation prompt for a character portrait.

CHARACTER:
${characterEntryText}

RPG DATA:
Class: ${rpgData.class || 'unknown'}
Race: ${rpgData.race || 'unknown'}
Equipment: ${equipmentStr}

Write a single-line prompt for a fantasy character portrait. Focus on: race, physical appearance, class-appropriate attire, notable equipment. Format: "portrait, upper body, [descriptors], fantasy art"`
    }
  ];

  try {
    const result = await generateTextFn(messages, { max_tokens: 100, temperature: 0.5 });
    return result.output.replace(/^["']|["']$/g, '').trim();
  } catch (err) {
    console.error(`${LOG_PREFIX} generatePortraitPrompt error:`, err.message);
    return null;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Detection
  detectLitRPGSignals,
  confirmLitRPG,
  detectLitRPG,

  // Scan
  scanForRPGData,
  extractCharacterRPG,
  extractQuests,
  classifyPartyAndNPCs,

  // Pending update actions
  acceptPendingUpdate,
  rejectPendingUpdate,
  acceptAllPendingUpdates,
  rejectAllPendingUpdates,

  // Lorebook sync
  buildLitRPGCharacterText,
  spliceField,
  spliceSection,
  generatePortraitPrompt,

  // Helpers
  fuzzyMatchCharacter,
  fuzzyMatchQuest,
  describeChanges,
  regexPreExtract,
  validateCharacterRPG,
  validateQuestResult,
  validateClassification,

  // Constants
  LITRPG_STATE_DEFAULTS,
  LITRPG_CHARACTER_TEMPLATE,
  DETECTION_THRESHOLD,
  VALID_EQUIPMENT_SLOTS,
  SYSTEM_TYPE_PROMPTS,
};

/**
 * LitRPG Tracker — detection, RPG data extraction, scan orchestration, lorebook sync.
 *
 * Detects LitRPG stories via regex + LLM, then extracts structured RPG data
 * (classes, levels, stats, abilities, quests, party, NPCs) from story text.
 * Data stored as structured JSON in SQLite, synced to lorebook text entries.
 */

const LOG_PREFIX = '[LitRPG]';

// --- Constants ---

const INTER_CALL_DELAY = 1000;
const MAX_STORY_CONTEXT = 4000;
const DETECTION_THRESHOLD = 8;
const CONFIDENCE_GATE = 2;

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
};

// --- Utility ---

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateRpgId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function recoverJSON(raw) {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let jsonStr = jsonMatch[0];
  try { return JSON.parse(jsonStr); } catch (_) { /* continue */ }

  const openBraces = (jsonStr.match(/\{/g) || []).length;
  const closeBraces = (jsonStr.match(/\}/g) || []).length;
  const openBrackets = (jsonStr.match(/\[/g) || []).length;
  const closeBrackets = (jsonStr.match(/\]/g) || []).length;
  const quoteCount = (jsonStr.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) jsonStr += '"';
  for (let i = 0; i < openBrackets - closeBrackets; i++) jsonStr += ']';
  for (let i = 0; i < openBraces - closeBraces; i++) jsonStr += '}';
  try { return JSON.parse(jsonStr); } catch (_) { return null; }
}

// ============================================================================
// DETECTION
// ============================================================================

/**
 * Stage 1: Regex-based LitRPG signal scoring.
 * Returns { score, signals } where signals is an array of matched pattern names.
 */
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

/**
 * Stage 2: LLM confirmation of LitRPG genre.
 * Returns { isLitRPG, systemType, confidence } or null on failure.
 */
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

/**
 * Full detection pipeline: regex screening -> LLM confirmation.
 */
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
// RPG SCAN PASSES
// ============================================================================

/**
 * Pass R1: Extract RPG attributes for a single character.
 * Returns structured RPG data or null.
 */
async function extractCharacterRPG(characterName, characterEntryText, storyText, generateTextFn, comprehensionContext) {
  const recentText = storyText.slice(-MAX_STORY_CONTEXT);
  const contextBlock = comprehensionContext ? `${comprehensionContext}\n` : '';

  const messages = [
    {
      role: 'system',
      content: 'You extract RPG game mechanics data from LitRPG story text. Output ONLY valid JSON. Only include data explicitly stated in the text — do not infer or guess.'
    },
    {
      role: 'user',
      content: `Extract RPG statistics for the character "${characterName}" from this story.
${contextBlock}CHARACTER ENTRY:
${characterEntryText}

RECENT STORY TEXT:
${recentText}

Extract ONLY information explicitly stated. Use null for unknown fields. Output this JSON format:
{"class":"class name or null","subclass":"subclass or null","level":number or null,"race":"race or null","stats":{"STAT_NAME":{"value":number,"modifier":number or null}},"abilities":[{"name":"...","description":"...","level":number or null,"type":"active|passive","cost":"cost string or null"}],"equipment":[{"name":"...","slot":"weapon|armor|accessory|other","description":"..."}],"confidence":1-5}`
    }
  ];

  try {
    const result = await generateTextFn(messages, { max_tokens: 500, temperature: 0.3 });
    const parsed = recoverJSON(result.output);
    if (!parsed || !parsed.confidence || parsed.confidence < CONFIDENCE_GATE) return null;
    return parsed;
  } catch (err) {
    console.error(`${LOG_PREFIX} extractCharacterRPG("${characterName}") error:`, err.message);
    return null;
  }
}

/**
 * Pass R2: Extract quests from story text.
 * Returns { newQuests, questUpdates } or null.
 */
async function extractQuests(storyText, existingQuests, generateTextFn, comprehensionContext) {
  const recentText = storyText.slice(-MAX_STORY_CONTEXT);
  const contextBlock = comprehensionContext ? `${comprehensionContext}\n` : '';

  const existingQuestSummary = existingQuests.length > 0
    ? `KNOWN QUESTS:\n${existingQuests.map(q => `- "${q.title}" (${q.status}): ${q.objectives.map(o => o.text).join(', ')}`).join('\n')}\n`
    : '';

  const messages = [
    {
      role: 'system',
      content: 'You identify quests, missions, and objectives from LitRPG story text. Output ONLY valid JSON. Only include quests explicitly mentioned in the text.'
    },
    {
      role: 'user',
      content: `Identify quests, missions, or objectives in this story text.
${contextBlock}${existingQuestSummary}
RECENT STORY TEXT:
${recentText}

Find new quests AND status changes to known quests. Output:
{"newQuests":[{"title":"...","description":"...","type":"main|side|personal","objectives":[{"text":"...","completed":false}],"rewards":"reward text or null","giver":"character name or null"}],"questUpdates":[{"title":"existing quest title exactly as shown above","statusChange":"completed|failed|abandoned|null","objectiveUpdates":[{"text":"objective text","completed":true}]}]}`
    }
  ];

  try {
    const result = await generateTextFn(messages, { max_tokens: 400, temperature: 0.3 });
    const parsed = recoverJSON(result.output);
    return parsed;
  } catch (err) {
    console.error(`${LOG_PREFIX} extractQuests error:`, err.message);
    return null;
  }
}

/**
 * Pass R3: Classify characters as party members or NPCs.
 * Returns { partyMembers, npcs } or null.
 */
async function classifyPartyAndNPCs(characterNames, storyText, generateTextFn, comprehensionContext) {
  if (characterNames.length === 0) return { partyMembers: [], npcs: [] };

  const recentText = storyText.slice(-3000);
  const contextBlock = comprehensionContext ? `${comprehensionContext}\n` : '';

  const messages = [
    {
      role: 'system',
      content: 'You classify characters in LitRPG stories. Output ONLY valid JSON. Base classification on explicit story evidence only.'
    },
    {
      role: 'user',
      content: `Classify these characters based on the story context. "Party members" travel with or fight alongside the protagonist. "NPCs" are other characters encountered in the story world.
${contextBlock}CHARACTERS: ${characterNames.join(', ')}

RECENT STORY TEXT:
${recentText}

Output:
{"partyMembers":["Name1","Name2"],"npcs":[{"name":"Name3","faction":"faction name or null","disposition":"friendly|neutral|hostile|unknown","isRealPerson":true/false}]}`
    }
  ];

  try {
    const result = await generateTextFn(messages, { max_tokens: 300, temperature: 0.3 });
    const parsed = recoverJSON(result.output);
    return parsed;
  } catch (err) {
    console.error(`${LOG_PREFIX} classifyPartyAndNPCs error:`, err.message);
    return null;
  }
}

// ============================================================================
// SCAN ORCHESTRATOR
// ============================================================================

/**
 * Main RPG scan function. Chained from lore:scan when LitRPG is enabled.
 *
 * @param {string} storyText - Full story text
 * @param {object} rpgState - Current litrpg_state from SQLite
 * @param {object[]} loreEntries - Lorebook entries (from proxy)
 * @param {function} generateTextFn - Primary LLM function
 * @param {function} onProgress - Progress callback
 * @param {string} comprehensionContext - Formatted comprehension context
 * @param {function} [secondaryGenerateTextFn] - Secondary LLM for hybrid parallel
 * @returns {{ state: object }} Updated rpgState
 */
async function scanForRPGData(storyText, rpgState, loreEntries, generateTextFn, onProgress, comprehensionContext, secondaryGenerateTextFn) {
  const state = { ...LITRPG_STATE_DEFAULTS, ...rpgState };
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
      entry.displayName, entry.text, storyText, provider, comprehensionContext
    );

    if (rpgData) {
      // Find existing character by loreEntryName or create new
      let charId = null;
      for (const [id, char] of Object.entries(state.characters)) {
        if (char.loreEntryName === entry.displayName || char.name === entry.displayName) {
          charId = id;
          break;
        }
      }

      const existingChar = charId ? state.characters[charId] : null;
      const updatedChar = {
        id: charId || generateRpgId('char'),
        name: entry.displayName,
        loreEntryName: entry.displayName,
        class: rpgData.class || (existingChar && existingChar.class) || null,
        subclass: rpgData.subclass || (existingChar && existingChar.subclass) || null,
        level: rpgData.level || (existingChar && existingChar.level) || null,
        race: rpgData.race || (existingChar && existingChar.race) || null,
        stats: rpgData.stats && Object.keys(rpgData.stats).length > 0 ? rpgData.stats : (existingChar && existingChar.stats) || {},
        abilities: rpgData.abilities && rpgData.abilities.length > 0 ? rpgData.abilities : (existingChar && existingChar.abilities) || [],
        equipment: rpgData.equipment && rpgData.equipment.length > 0 ? rpgData.equipment : (existingChar && existingChar.equipment) || [],
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
          createdAt: Date.now(),
        });
      } else if (!existingChar) {
        // New character — add directly
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
  const questResult = await extractQuests(storyText, existingQuests, generateTextFn, comprehensionContext);

  if (questResult) {
    // Add new quests
    if (questResult.newQuests) {
      for (const q of questResult.newQuests) {
        if (!q.title) continue;
        // Check for duplicate title
        const isDuplicate = existingQuests.some(eq => eq.title.toLowerCase() === q.title.toLowerCase());
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
        const matchingQuest = existingQuests.find(q => q.title.toLowerCase() === update.title.toLowerCase());
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
            const matchingObj = matchingQuest.objectives.find(o => o.text.toLowerCase() === objUpdate.text.toLowerCase());
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

    const classification = await classifyPartyAndNPCs(allCharNames, storyText, generateTextFn, comprehensionContext);

    if (classification) {
      const partySet = new Set((classification.partyMembers || []).map(n => n.toLowerCase()));
      const npcMap = new Map();
      for (const npc of (classification.npcs || [])) {
        if (npc.name) npcMap.set(npc.name.toLowerCase(), npc);
      }

      for (const char of Object.values(state.characters)) {
        const nameLower = char.name.toLowerCase();
        if (partySet.has(nameLower)) {
          char.isPartyMember = true;
          char.isNPC = false;
        } else if (npcMap.has(nameLower)) {
          const npcData = npcMap.get(nameLower);
          char.isPartyMember = false;
          char.isNPC = true;
          char.faction = npcData.faction || char.faction;
          char.disposition = npcData.disposition || char.disposition;
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

/**
 * Check if a character has meaningful changes worth surfacing.
 */
function hasCharacterChanged(before, after) {
  if (before.class !== after.class) return true;
  if (before.subclass !== after.subclass) return true;
  if (before.level !== after.level) return true;
  if (before.race !== after.race) return true;

  const beforeStatKeys = Object.keys(before.stats || {});
  const afterStatKeys = Object.keys(after.stats || {});
  if (beforeStatKeys.length !== afterStatKeys.length) return true;
  for (const key of afterStatKeys) {
    if (!before.stats[key] || before.stats[key].value !== after.stats[key].value) return true;
  }

  if ((before.abilities || []).length !== (after.abilities || []).length) return true;
  if ((before.equipment || []).length !== (after.equipment || []).length) return true;

  return false;
}

// ============================================================================
// PENDING UPDATE ACTIONS
// ============================================================================

/**
 * Accept a pending RPG update.
 */
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

/**
 * Reject a pending RPG update.
 */
function rejectPendingUpdate(rpgState, updateId) {
  const state = { ...rpgState };
  state.pendingUpdates = state.pendingUpdates.filter(u => u.id !== updateId);
  return state;
}

// ============================================================================
// LOREBOOK TEXT BUILDER
// ============================================================================

const LITRPG_CHARACTER_TEMPLATE = `Name: [Full name, including last name]
Race: [Race, if applicable]
Class: [Class and subclass]
Level: [Current level]
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
Relationships:
- [Name]: [relationship type and dynamic]
Family:
- [Name]: [family role, e.g. sister, father]
Background: [History and backstory]
Additional notes: [Any other relevant details]`;

/**
 * Splice a single-line field into template-formatted text.
 * If the field exists, replace its value. If not, insert at the right position.
 */
function spliceField(text, fieldName, value) {
  if (value === null || value === undefined || value === '') return text;
  const fieldPattern = new RegExp(`^${fieldName}:.*$`, 'm');
  const replacement = `${fieldName}: ${value}`;

  if (fieldPattern.test(text)) {
    return text.replace(fieldPattern, replacement);
  }

  // Insert in template order
  const templateOrder = [
    'Name', 'Race', 'Class', 'Level', 'Age', 'Gender',
    'Physical Appearance', 'Sexuality', 'Description', 'Self-Image',
    'Motivations/Goals', 'Secrets', 'Stats', 'Abilities', 'Equipment',
    'Relationships', 'Family', 'Background', 'Additional notes',
  ];

  const targetIdx = templateOrder.indexOf(fieldName);
  if (targetIdx < 0) {
    return text.trimEnd() + `\n${replacement}`;
  }

  // Find the first field after our target that exists in the text
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

/**
 * Splice a multi-line section (like Abilities, Equipment) into template-formatted text.
 */
function spliceSection(text, sectionName, content) {
  if (!content) return text;
  const sectionPattern = new RegExp(`^${sectionName}:.*(?:\\n(?:\\s*-\\s+.*|\\s*))*$`, 'm');

  if (sectionPattern.test(text)) {
    return text.replace(sectionPattern, `${sectionName}:\n${content}`);
  }

  // Insert before next template field
  const templateOrder = [
    'Name', 'Race', 'Class', 'Level', 'Age', 'Gender',
    'Physical Appearance', 'Sexuality', 'Description', 'Self-Image',
    'Motivations/Goals', 'Secrets', 'Stats', 'Abilities', 'Equipment',
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

/**
 * Build lorebook-compatible text for a character with RPG data spliced in.
 * Takes the existing lorebook entry text and the structured RPG data.
 */
function buildLitRPGCharacterText(entryText, rpgData) {
  let text = entryText;

  text = spliceField(text, 'Race', rpgData.race);
  text = spliceField(text, 'Class', [rpgData.class, rpgData.subclass].filter(Boolean).join(' / ') || null);
  text = spliceField(text, 'Level', rpgData.level != null ? String(rpgData.level) : null);

  // Build stats line
  if (rpgData.stats && Object.keys(rpgData.stats).length > 0) {
    const statsStr = Object.entries(rpgData.stats)
      .map(([k, v]) => `${k} ${v.value}`)
      .join(', ');
    text = spliceField(text, 'Stats', statsStr);
  }

  // Build abilities section
  if (rpgData.abilities && rpgData.abilities.length > 0) {
    const abilitiesStr = rpgData.abilities
      .map(a => `- ${a.name}: ${a.description}${a.cost ? ` [${a.cost}]` : ''}`)
      .join('\n');
    text = spliceSection(text, 'Abilities', abilitiesStr);
  }

  // Build equipment section
  if (rpgData.equipment && rpgData.equipment.length > 0) {
    const equipStr = rpgData.equipment
      .map(e => `- ${e.name}: ${e.slot}, ${e.description}`)
      .join('\n');
    text = spliceSection(text, 'Equipment', equipStr);
  }

  return text;
}

/**
 * Generate an image prompt for a character portrait from their RPG data.
 */
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

  // Lorebook sync
  buildLitRPGCharacterText,
  spliceField,
  spliceSection,
  generatePortraitPrompt,

  // Constants
  LITRPG_STATE_DEFAULTS,
  LITRPG_CHARACTER_TEMPLATE,
  DETECTION_THRESHOLD,
};

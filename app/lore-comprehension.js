/**
 * Lore Comprehension — Full-story understanding via hierarchical chunk
 * summaries, entity profile tracking, and master rolling summaries.
 *
 * Processes story text in ~2500-char chunks, summarizing each and extracting
 * entity profiles. Provides a comprehension context string that can be
 * injected into lore scan prompts for full-story awareness.
 */

const LOG_PREFIX = '[LoreComprehension]';

// ============================================================================
// CONSTANTS
// ============================================================================

const CHUNK_SIZE = 2500;
const CHUNK_OVERLAP = 200;
const CONSOLIDATION_INTERVAL = 5;
const MAX_SUMMARY_LENGTH = 800;
const MAX_MASTER_SUMMARY = 2000;
const MAX_ENTITY_PROFILE = 300;
const MAX_ENTITIES_IN_CONTEXT = 20;
const SCHEMA_VERSION = 1;

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Simple string hash for change detection.
 */
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return hash.toString(36);
}

/**
 * Attempt to recover valid JSON from potentially truncated LLM output.
 */
function recoverJSON(raw) {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let jsonStr = jsonMatch[0];

  try {
    return JSON.parse(jsonStr);
  } catch (_) {
    // Continue with recovery
  }

  const openBraces = (jsonStr.match(/\{/g) || []).length;
  const closeBraces = (jsonStr.match(/\}/g) || []).length;
  const openBrackets = (jsonStr.match(/\[/g) || []).length;
  const closeBrackets = (jsonStr.match(/\]/g) || []).length;

  const quoteCount = (jsonStr.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    jsonStr += '"';
  }

  for (let i = 0; i < openBrackets - closeBrackets; i++) {
    jsonStr += ']';
  }
  for (let i = 0; i < openBraces - closeBraces; i++) {
    jsonStr += '}';
  }

  try {
    return JSON.parse(jsonStr);
  } catch (_) {
    return null;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// CHUNKING
// ============================================================================

/**
 * Split story text into ~CHUNK_SIZE segments at paragraph boundaries.
 * Returns [{index, text, hash}].
 */
function chunkStory(storyText) {
  if (!storyText || storyText.length === 0) return [];

  const chunks = [];
  let pos = 0;
  let index = 0;

  while (pos < storyText.length) {
    let end = Math.min(pos + CHUNK_SIZE, storyText.length);

    // Try to break at paragraph boundary (double newline)
    if (end < storyText.length) {
      const searchStart = Math.max(end - 300, pos);
      const searchRegion = storyText.slice(searchStart, end + 200);
      const targetOffset = end - searchStart;

      // Look for nearest paragraph break to our target end point
      let bestBreak = -1;
      let bestDist = Infinity;

      const breakPattern = /\n\s*\n/g;
      let match;
      while ((match = breakPattern.exec(searchRegion)) !== null) {
        const breakPos = match.index + match[0].length;
        const dist = Math.abs(breakPos - targetOffset);
        if (dist < bestDist) {
          bestDist = dist;
          bestBreak = searchStart + breakPos;
        }
      }

      if (bestBreak > pos && bestBreak <= end + 200) {
        end = bestBreak;
      }
    }

    const text = storyText.slice(pos, end);
    chunks.push({
      index,
      text,
      hash: hashString(text),
    });

    // Advance with overlap
    pos = end - (end < storyText.length ? CHUNK_OVERLAP : 0);
    index++;
  }

  return chunks;
}

// ============================================================================
// LLM FUNCTIONS
// ============================================================================

/**
 * Process a single chunk: summarize and extract entity information.
 * Combined into one LLM call for efficiency.
 */
async function processChunk(chunkText, previousSummary, entityProfiles, generateTextFn, categories) {
  const entityContext = Object.keys(entityProfiles).length > 0
    ? `\nKNOWN ENTITIES: ${Object.keys(entityProfiles).slice(0, 15).join(', ')}`
    : '';

  const previousContext = previousSummary
    ? `\nSTORY SO FAR: ${previousSummary.slice(0, 500)}`
    : '';

  const messages = [
    {
      role: 'system',
      content: 'You analyze story segments. Summarize the segment AND extract entity information. Output ONLY valid JSON.',
    },
    {
      role: 'user',
      content: `Analyze this story segment:
${previousContext}${entityContext}

SEGMENT TEXT:
${chunkText}

Provide:
1. A concise summary of events/developments in this segment (2-4 sentences, max ${MAX_SUMMARY_LENGTH} chars)
2. A list of entities (${categories || 'characters, locations, factions, items, concepts'}) mentioned, with current traits/status

Output ONLY this JSON:
{"summary":"Segment summary here.","entities":[{"name":"Entity Name","category":"character","traits":"Brief traits/description","relationships":"Key relationships","status":"Current status/state"}]}`,
    },
  ];

  try {
    const response = await generateTextFn(messages, {
      max_tokens: 500,
      temperature: 0.3,
    });

    const content = response.output || '';
    const parsed = recoverJSON(content);

    if (parsed && typeof parsed.summary === 'string') {
      const summary = parsed.summary.slice(0, MAX_SUMMARY_LENGTH);
      const entities = Array.isArray(parsed.entities)
        ? parsed.entities
            .filter(e => typeof e.name === 'string' && e.name.length > 0)
            .map(e => ({
              name: e.name,
              category: e.category || 'concept',
              traits: typeof e.traits === 'string' ? e.traits : '',
              relationships: typeof e.relationships === 'string' ? e.relationships : '',
              status: typeof e.status === 'string' ? e.status : '',
            }))
        : [];
      return { summary, entities };
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} Error processing chunk:`, e.message || e);
  }

  return { summary: '', entities: [] };
}

/**
 * Consolidate multiple chunk summaries into a single master summary.
 */
async function consolidateSummaries(chunkSummaries, generateTextFn) {
  if (chunkSummaries.length === 0) return '';
  if (chunkSummaries.length === 1) return chunkSummaries[0];

  const combined = chunkSummaries
    .map((s, i) => `[Part ${i + 1}] ${s}`)
    .join('\n');

  const messages = [
    {
      role: 'system',
      content: 'You consolidate story summaries into a single cohesive overview. Output ONLY the consolidated summary text, no JSON.',
    },
    {
      role: 'user',
      content: `Combine these story segment summaries into one cohesive summary (max ${MAX_MASTER_SUMMARY} chars). Preserve key plot points, character developments, and important events. Write in present tense.

${combined}

Write ONLY the consolidated summary:`,
    },
  ];

  try {
    const response = await generateTextFn(messages, {
      max_tokens: 400,
      temperature: 0.2,
    });

    const text = (response.output || '').trim();
    if (text.length > 0) return text.slice(0, MAX_MASTER_SUMMARY);
  } catch (e) {
    console.error(`${LOG_PREFIX} Error consolidating summaries:`, e.message || e);
  }

  // Fallback: concatenate and truncate
  return chunkSummaries.join(' ').slice(0, MAX_MASTER_SUMMARY);
}

// ============================================================================
// ENTITY PROFILE MANAGEMENT
// ============================================================================

/**
 * Merge extracted entity data into existing profile. Pure function.
 */
function mergeEntityProfile(existing, extracted, chunkIndex) {
  if (!existing) {
    return {
      category: extracted.category || 'concept',
      traits: (extracted.traits || '').slice(0, MAX_ENTITY_PROFILE),
      relationships: (extracted.relationships || '').slice(0, MAX_ENTITY_PROFILE),
      status: (extracted.status || '').slice(0, MAX_ENTITY_PROFILE),
      lastChunkIndex: chunkIndex,
    };
  }

  return {
    category: extracted.category || existing.category,
    traits: extracted.traits
      ? mergeProfileField(existing.traits, extracted.traits)
      : existing.traits,
    relationships: extracted.relationships
      ? mergeProfileField(existing.relationships, extracted.relationships)
      : existing.relationships,
    status: extracted.status || existing.status,
    lastChunkIndex: chunkIndex,
  };
}

/**
 * Merge two profile field strings, preferring newer info but keeping unique older info.
 */
function mergeProfileField(oldVal, newVal) {
  if (!oldVal) return newVal.slice(0, MAX_ENTITY_PROFILE);
  if (!newVal) return oldVal;

  // If new value is substantially different, prefer it but append unique old info
  if (newVal.length > oldVal.length * 0.7) {
    return newVal.slice(0, MAX_ENTITY_PROFILE);
  }

  const combined = `${newVal}; ${oldVal}`;
  return combined.slice(0, MAX_ENTITY_PROFILE);
}

// ============================================================================
// CONTEXT FORMATTING
// ============================================================================

/**
 * Build the comprehension context string for injection into scan prompts.
 * Caps total output at ~2500 chars.
 */
function formatComprehensionContext(masterSummary, entityProfiles) {
  if (!masterSummary && (!entityProfiles || Object.keys(entityProfiles).length === 0)) {
    return '';
  }

  let context = '';

  if (masterSummary) {
    context += `STORY OVERVIEW (full story summary):\n${masterSummary}\n\n`;
  }

  if (entityProfiles && Object.keys(entityProfiles).length > 0) {
    context += 'KEY ENTITIES:\n';
    const entries = Object.entries(entityProfiles)
      .sort((a, b) => (b[1].lastChunkIndex || 0) - (a[1].lastChunkIndex || 0))
      .slice(0, MAX_ENTITIES_IN_CONTEXT);

    for (const [name, profile] of entries) {
      const parts = [profile.traits, profile.relationships, profile.status]
        .filter(p => p && p.length > 0);
      const detail = parts.join('; ').slice(0, 120);
      context += `- ${name} (${profile.category}): ${detail}\n`;
    }
    context += '\n';
  }

  return context.slice(0, 2500);
}

// ============================================================================
// PROGRESSIVE SCAN
// ============================================================================

/**
 * Create a fresh comprehension state object.
 */
function createEmptyState() {
  return {
    chunks: [],
    masterSummary: '',
    entityProfiles: {},
    lastProcessedLength: 0,
    totalStoryLength: 0,
    version: SCHEMA_VERSION,
  };
}

/**
 * Process unprocessed chunks one at a time with cancel/pause support.
 *
 * @param {string} storyText - Full story text
 * @param {object|null} existingState - Previous comprehension state (or null)
 * @param {function} generateTextFn - LLM call function
 * @param {function} [onProgress] - Progress callback
 * @param {function} [shouldCancel] - Return true to stop processing
 * @returns {object} Updated comprehension state
 */
async function runProgressiveScan(storyText, existingState, generateTextFn, onProgress, shouldCancel) {
  const state = existingState ? JSON.parse(JSON.stringify(existingState)) : createEmptyState();
  state.totalStoryLength = storyText.length;

  const allChunks = chunkStory(storyText);
  const totalChunks = allChunks.length;

  if (totalChunks === 0) return state;

  // Determine which chunks are already processed (by hash match)
  const processedHashes = new Set(state.chunks.map(c => c.hash));
  const unprocessed = allChunks.filter(c => !processedHashes.has(c.hash));

  console.log(`${LOG_PREFIX} Progressive scan: ${totalChunks} total chunks, ${unprocessed.length} to process`);

  if (unprocessed.length === 0) {
    if (onProgress) onProgress({ phase: 'complete', chunksProcessed: totalChunks, chunksTotal: totalChunks });
    return state;
  }

  let processed = totalChunks - unprocessed.length;
  let chunksThisRound = 0;

  for (const chunk of unprocessed) {
    // Check cancellation
    if (shouldCancel && shouldCancel()) {
      console.log(`${LOG_PREFIX} Progressive scan cancelled at chunk ${processed}/${totalChunks}`);
      break;
    }

    if (onProgress) {
      onProgress({
        phase: 'processing',
        chunksProcessed: processed,
        chunksTotal: totalChunks,
      });
    }

    // Get previous context for continuity
    const previousSummary = state.masterSummary || (state.chunks.length > 0
      ? state.chunks[state.chunks.length - 1].summary
      : '');

    const result = await processChunk(chunk.text, previousSummary, state.entityProfiles, generateTextFn);

    // Store chunk summary
    state.chunks.push({
      index: chunk.index,
      hash: chunk.hash,
      summary: result.summary,
    });

    // Update entity profiles
    for (const entity of result.entities) {
      const key = entity.name;
      state.entityProfiles[key] = mergeEntityProfile(
        state.entityProfiles[key],
        entity,
        chunk.index
      );
    }

    processed++;
    chunksThisRound++;

    // Consolidate summaries periodically
    if (chunksThisRound % CONSOLIDATION_INTERVAL === 0 || processed === totalChunks) {
      if (onProgress) {
        onProgress({
          phase: 'consolidating',
          chunksProcessed: processed,
          chunksTotal: totalChunks,
        });
      }

      const summaries = state.chunks.map(c => c.summary).filter(s => s.length > 0);
      state.masterSummary = await consolidateSummaries(summaries, generateTextFn);
    }

    // Brief delay between chunks to avoid rate limiting
    if (processed < totalChunks) {
      await delay(500);
    }
  }

  state.lastProcessedLength = storyText.length;

  if (onProgress) {
    onProgress({
      phase: 'complete',
      chunksProcessed: processed,
      chunksTotal: totalChunks,
      currentChunkSummary: state.masterSummary,
    });
  }

  console.log(`${LOG_PREFIX} Progressive scan complete: ${processed}/${totalChunks} chunks, ${Object.keys(state.entityProfiles).length} entities`);

  return state;
}

/**
 * Process only new text since lastProcessedLength.
 * Quick path for ongoing story writing (typically 1-2 new chunks).
 */
async function incrementalUpdate(storyText, existingState, generateTextFn) {
  if (!existingState || !existingState.lastProcessedLength) {
    return runProgressiveScan(storyText, null, generateTextFn);
  }

  const state = JSON.parse(JSON.stringify(existingState));
  const oldLength = state.lastProcessedLength;

  if (storyText.length <= oldLength) {
    return state; // No new text
  }

  const newText = storyText.slice(Math.max(0, oldLength - CHUNK_OVERLAP));
  const newChunks = chunkStory(newText);

  if (newChunks.length === 0) return state;

  console.log(`${LOG_PREFIX} Incremental update: ${newChunks.length} new chunks from ${storyText.length - oldLength} new chars`);

  const processedHashes = new Set(state.chunks.map(c => c.hash));

  for (const chunk of newChunks) {
    if (processedHashes.has(chunk.hash)) continue;

    const previousSummary = state.masterSummary || '';
    const result = await processChunk(chunk.text, previousSummary, state.entityProfiles, generateTextFn);

    const newIndex = state.chunks.length;
    state.chunks.push({
      index: newIndex,
      hash: chunk.hash,
      summary: result.summary,
    });

    for (const entity of result.entities) {
      state.entityProfiles[entity.name] = mergeEntityProfile(
        state.entityProfiles[entity.name],
        entity,
        newIndex
      );
    }

    await delay(500);
  }

  // Consolidate after incremental update
  const summaries = state.chunks.map(c => c.summary).filter(s => s.length > 0);
  state.masterSummary = await consolidateSummaries(summaries, generateTextFn);

  state.lastProcessedLength = storyText.length;
  state.totalStoryLength = storyText.length;

  console.log(`${LOG_PREFIX} Incremental update complete: ${state.chunks.length} total chunks`);

  return state;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Chunking
  chunkStory,
  hashString,

  // LLM functions
  processChunk,
  consolidateSummaries,

  // Entity management
  mergeEntityProfile,

  // Context
  formatComprehensionContext,

  // Scan operations
  runProgressiveScan,
  incrementalUpdate,
  createEmptyState,

  // Constants
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  CONSOLIDATION_INTERVAL,
  MAX_SUMMARY_LENGTH,
  MAX_MASTER_SUMMARY,
  MAX_ENTITY_PROFILE,
  MAX_ENTITIES_IN_CONTEXT,
  SCHEMA_VERSION,
};

const Database = require('better-sqlite3');
const path = require('path');

const LOG_PREFIX = '[DB]';

let db;

function getDb() { return db; }

function init(userDataPath) {
  const dbPath = path.join(userDataPath, 'stories.db');
  console.log(`${LOG_PREFIX} Opening database at ${dbPath}`);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createTables();
  return db;
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      first_seen_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scene_state (
      story_id TEXT PRIMARY KEY REFERENCES stories(id),
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lore_state (
      story_id TEXT PRIMARY KEY REFERENCES stories(id),
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lore_comprehension (
      story_id TEXT PRIMARY KEY REFERENCES stories(id),
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_state (
      story_id TEXT PRIMARY KEY REFERENCES stories(id),
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS litrpg_state (
      story_id TEXT PRIMARY KEY REFERENCES stories(id),
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  console.log(`${LOG_PREFIX} Tables verified`);
}

// --- Stories ---

function upsertStory(id, title) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO stories (id, title, first_seen_at, last_accessed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE stories.title END,
      last_accessed_at = excluded.last_accessed_at
  `).run(id, title || '', now, now);
}

function getStory(id) {
  return db.prepare('SELECT * FROM stories WHERE id = ?').get(id) || null;
}

function listStories() {
  return db.prepare('SELECT * FROM stories ORDER BY last_accessed_at DESC').all();
}

// --- Generic per-story CRUD ---

const VALID_TABLES = new Set(['scene_state', 'lore_state', 'lore_comprehension', 'memory_state', 'litrpg_state']);

function getData(table, storyId) {
  if (!VALID_TABLES.has(table)) throw new Error(`Invalid table: ${table}`);
  const row = db.prepare(`SELECT data FROM ${table} WHERE story_id = ?`).get(storyId);
  return row ? JSON.parse(row.data) : null;
}

function setData(table, storyId, data) {
  if (!VALID_TABLES.has(table)) throw new Error(`Invalid table: ${table}`);
  // Ensure story exists
  upsertStory(storyId, '');
  db.prepare(`INSERT OR REPLACE INTO ${table} (story_id, data, updated_at) VALUES (?, ?, ?)`)
    .run(storyId, JSON.stringify(data), Date.now());
}

// --- Convenience wrappers ---

const LORE_STATE_DEFAULTS = {
  pendingEntries: [], pendingUpdates: [], pendingMerges: [],
  acceptedEntryIds: [], rejectedNames: [], dismissedUpdateNames: [],
  rejectedMergeNames: [], dismissedReformatNames: [], charsSinceLastScan: 0, loreCategoryIds: {},
  pendingCleanups: [], dismissedCleanupIds: [],
};

function getSceneState(storyId) {
  return getData('scene_state', storyId);
}

function setSceneState(storyId, data) {
  setData('scene_state', storyId, data);
}

function getLoreState(storyId) {
  const data = getData('lore_state', storyId);
  if (!data) return null;
  // Merge with defaults so all keys exist
  return { ...LORE_STATE_DEFAULTS, ...data };
}

function setLoreState(storyId, data) {
  setData('lore_state', storyId, data);
}

function getComprehension(storyId) {
  return getData('lore_comprehension', storyId);
}

function setComprehension(storyId, data) {
  setData('lore_comprehension', storyId, data);
}

function getMemoryState(storyId) {
  return getData('memory_state', storyId);
}

function setMemoryState(storyId, data) {
  setData('memory_state', storyId, data);
}

const LITRPG_STATE_DEFAULTS = {
  enabled: false, detected: null, systemType: 'generic', dismissedDetection: false,
  characters: {}, quests: {}, party: { members: [], lastUpdated: null },
  pendingUpdates: [], lastProcessedLength: 0, lastScanAt: null, charsSinceLastScan: 0,
};

function getLitrpgState(storyId) {
  const data = getData('litrpg_state', storyId);
  if (!data) return null;
  return { ...LITRPG_STATE_DEFAULTS, ...data };
}

function setLitrpgState(storyId, data) {
  setData('litrpg_state', storyId, data);
}

// --- Bulk load (used on story switch) ---

function loadAllStoryData(storyId) {
  return {
    sceneState: getSceneState(storyId),
    loreState: getLoreState(storyId),
    comprehension: getComprehension(storyId),
    memoryState: getMemoryState(storyId),
    litrpgState: getLitrpgState(storyId),
  };
}

// --- Migration from electron-store ---

function migrateFromStore(store) {
  const tables = [
    { storeKey: 'sceneState', table: 'scene_state' },
    { storeKey: 'loreState', table: 'lore_state' },
    { storeKey: 'loreComprehension', table: 'lore_comprehension' },
    { storeKey: 'memoryState', table: 'memory_state' },
  ];

  const insertStory = db.prepare(
    'INSERT OR IGNORE INTO stories (id, title, first_seen_at, last_accessed_at) VALUES (?, ?, ?, ?)'
  );

  const migrate = db.transaction(() => {
    let totalMigrated = 0;
    for (const { storeKey, table } of tables) {
      const allData = store.get(storeKey) || {};
      const storyIds = Object.keys(allData);
      for (const storyId of storyIds) {
        const data = allData[storyId];
        if (!data || typeof data !== 'object') continue;
        const now = Date.now();
        insertStory.run(storyId, '', now, now);
        db.prepare(`INSERT OR IGNORE INTO ${table} (story_id, data, updated_at) VALUES (?, ?, ?)`)
          .run(storyId, JSON.stringify(data), now);
        totalMigrated++;
      }
    }
    console.log(`${LOG_PREFIX} Migrated ${totalMigrated} records from electron-store`);
  });

  migrate();
}

function close() {
  if (db) {
    console.log(`${LOG_PREFIX} Closing database`);
    db.close();
    db = null;
  }
}

module.exports = {
  init, close, getDb,
  upsertStory, getStory, listStories,
  getSceneState, setSceneState,
  getLoreState, setLoreState,
  getComprehension, setComprehension,
  getMemoryState, setMemoryState,
  getLitrpgState, setLitrpgState, LITRPG_STATE_DEFAULTS,
  loadAllStoryData, migrateFromStore,
};

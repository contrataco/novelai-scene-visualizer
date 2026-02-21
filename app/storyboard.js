/**
 * Storyboard Storage Module
 *
 * Filesystem-based persistence for storyboard scenes.
 * Images stored as individual PNGs, metadata in JSON files.
 *
 * Directory layout:
 *   {userData}/storyboards/
 *     index.json
 *     {storyboardId}/
 *       storyboard.json
 *       images/
 *         {sceneId}.png
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

function getStoryboardsDir() {
  return path.join(app.getPath('userData'), 'storyboards');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// --- Index ---

function getIndexPath() {
  return path.join(getStoryboardsDir(), 'index.json');
}

function migrateIndex(data) {
  // Migrate from v1 (no version field) to v2 (story associations)
  if (!data.version) {
    data.version = 2;
    data.storyAssociations = {};
    for (const entry of data.storyboards) {
      if (!entry.storyId) entry.storyId = null;
      if (!entry.storyTitle) entry.storyTitle = null;
    }
    console.log('[Storyboard] Migrated index to v2 (story associations)');
  }
  return data;
}

function readIndex() {
  const data = readJSON(getIndexPath());
  if (!data) return { version: 2, activeStoryboardId: null, storyAssociations: {}, storyboards: [] };
  const migrated = migrateIndex(data);
  if (!migrated.storyAssociations) migrated.storyAssociations = {};
  return migrated;
}

function writeIndex(index) {
  writeJSON(getIndexPath(), index);
}

// --- Storyboard CRUD ---

function list() {
  const index = readIndex();
  return { activeStoryboardId: index.activeStoryboardId, storyboards: index.storyboards };
}

function create(name, storyId = null, storyTitle = null) {
  const id = 'sb_' + Date.now();
  const sbDir = path.join(getStoryboardsDir(), id);
  ensureDir(path.join(sbDir, 'images'));

  const storyboard = { id, name, scenes: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  writeJSON(path.join(sbDir, 'storyboard.json'), storyboard);

  const index = readIndex();
  index.storyboards.push({ id, name, sceneCount: 0, updatedAt: storyboard.updatedAt, storyId, storyTitle });
  if (storyId) {
    index.storyAssociations[storyId] = id;
  }
  if (!index.activeStoryboardId) {
    index.activeStoryboardId = id;
  }
  writeIndex(index);

  return { id, name, storyId, storyTitle };
}

function deleteStoryboard(storyboardId) {
  const sbDir = path.join(getStoryboardsDir(), storyboardId);
  if (fs.existsSync(sbDir)) {
    fs.rmSync(sbDir, { recursive: true, force: true });
  }

  const index = readIndex();
  // Clean up story association
  for (const [sid, sbId] of Object.entries(index.storyAssociations)) {
    if (sbId === storyboardId) {
      delete index.storyAssociations[sid];
    }
  }
  index.storyboards = index.storyboards.filter(sb => sb.id !== storyboardId);
  if (index.activeStoryboardId === storyboardId) {
    index.activeStoryboardId = index.storyboards.length > 0 ? index.storyboards[0].id : null;
  }
  writeIndex(index);

  return { success: true, activeStoryboardId: index.activeStoryboardId };
}

function rename(storyboardId, newName) {
  const sbDir = path.join(getStoryboardsDir(), storyboardId);
  const sbPath = path.join(sbDir, 'storyboard.json');
  const sb = readJSON(sbPath);
  if (!sb) return { success: false, error: 'Storyboard not found' };

  sb.name = newName;
  sb.updatedAt = new Date().toISOString();
  writeJSON(sbPath, sb);

  const index = readIndex();
  const entry = index.storyboards.find(s => s.id === storyboardId);
  if (entry) {
    entry.name = newName;
    entry.updatedAt = sb.updatedAt;
  }
  writeIndex(index);

  return { success: true };
}

function setActive(storyboardId) {
  const index = readIndex();
  index.activeStoryboardId = storyboardId;
  writeIndex(index);
  return { success: true };
}

// --- Scene operations ---

function getStoryboard(storyboardId) {
  const sbPath = path.join(getStoryboardsDir(), storyboardId, 'storyboard.json');
  return readJSON(sbPath);
}

function saveStoryboard(storyboardId, sb) {
  sb.updatedAt = new Date().toISOString();
  const sbPath = path.join(getStoryboardsDir(), storyboardId, 'storyboard.json');
  writeJSON(sbPath, sb);

  // Update index scene count
  const index = readIndex();
  const entry = index.storyboards.find(s => s.id === storyboardId);
  if (entry) {
    entry.sceneCount = sb.scenes.length;
    entry.updatedAt = sb.updatedAt;
  }
  writeIndex(index);
}

function getScenes(storyboardId) {
  const sb = getStoryboard(storyboardId);
  if (!sb) return [];
  return sb.scenes;
}

function commitScene(storyboardId, sceneData) {
  // Auto-create "Default" storyboard if none exist
  if (!storyboardId) {
    const index = readIndex();
    if (index.storyboards.length === 0) {
      const created = create('Default');
      storyboardId = created.id;
    } else {
      storyboardId = index.activeStoryboardId || index.storyboards[0].id;
    }
  }

  const sb = getStoryboard(storyboardId);
  if (!sb) return { success: false, error: 'Storyboard not found' };

  const sceneId = 'sc_' + Date.now();
  const imageFile = sceneId + '.png';

  // Write image to disk (strip data URI prefix)
  const imageDir = path.join(getStoryboardsDir(), storyboardId, 'images');
  ensureDir(imageDir);

  let imageBase64 = sceneData.imageData;
  if (imageBase64.startsWith('data:')) {
    imageBase64 = imageBase64.split(',')[1];
  }
  fs.writeFileSync(path.join(imageDir, imageFile), Buffer.from(imageBase64, 'base64'));

  const scene = {
    id: sceneId,
    order: sb.scenes.length,
    imageFile,
    prompt: sceneData.prompt || '',
    negativePrompt: sceneData.negativePrompt || '',
    storyExcerpt: sceneData.storyExcerpt || '',
    characters: sceneData.characters || [],
    provider: sceneData.provider || '',
    model: sceneData.model || '',
    resolution: sceneData.resolution || {},
    committedAt: new Date().toISOString(),
    note: sceneData.note || '',
  };

  sb.scenes.push(scene);
  saveStoryboard(storyboardId, sb);

  return { success: true, sceneId, storyboardId };
}

function deleteScene(storyboardId, sceneId) {
  const sb = getStoryboard(storyboardId);
  if (!sb) return { success: false, error: 'Storyboard not found' };

  const scene = sb.scenes.find(s => s.id === sceneId);
  if (scene) {
    // Delete image file
    const imgPath = path.join(getStoryboardsDir(), storyboardId, 'images', scene.imageFile);
    if (fs.existsSync(imgPath)) {
      fs.unlinkSync(imgPath);
    }
  }

  sb.scenes = sb.scenes.filter(s => s.id !== sceneId);
  // Re-index order
  sb.scenes.forEach((s, i) => { s.order = i; });
  saveStoryboard(storyboardId, sb);

  return { success: true };
}

function reorderScenes(storyboardId, sceneIds) {
  const sb = getStoryboard(storyboardId);
  if (!sb) return { success: false, error: 'Storyboard not found' };

  if (sceneIds.length !== sb.scenes.length) {
    return { success: false, error: `Scene count mismatch: expected ${sb.scenes.length}, got ${sceneIds.length}` };
  }

  const sceneMap = {};
  for (const scene of sb.scenes) {
    sceneMap[scene.id] = scene;
  }

  const reordered = [];
  for (const id of sceneIds) {
    if (!sceneMap[id]) {
      return { success: false, error: `Unknown scene ID: ${id}` };
    }
    reordered.push(sceneMap[id]);
  }
  reordered.forEach((s, i) => { s.order = i; });
  sb.scenes = reordered;
  saveStoryboard(storyboardId, sb);

  return { success: true };
}

function updateSceneNote(storyboardId, sceneId, note) {
  const sb = getStoryboard(storyboardId);
  if (!sb) return { success: false, error: 'Storyboard not found' };

  const scene = sb.scenes.find(s => s.id === sceneId);
  if (!scene) return { success: false, error: 'Scene not found' };

  scene.note = note;
  saveStoryboard(storyboardId, sb);

  return { success: true };
}

function getSceneImage(storyboardId, sceneId) {
  const sb = getStoryboard(storyboardId);
  if (!sb) return null;

  const scene = sb.scenes.find(s => s.id === sceneId);
  if (!scene) return null;

  const imgPath = path.join(getStoryboardsDir(), storyboardId, 'images', scene.imageFile);
  if (!fs.existsSync(imgPath)) return null;

  const data = fs.readFileSync(imgPath);
  return 'data:image/png;base64,' + data.toString('base64');
}

// --- Story Association ---

function getOrCreateForStory(storyId, storyTitle) {
  const index = readIndex();

  // Check if this story already has an associated storyboard
  const existingId = index.storyAssociations[storyId];
  if (existingId) {
    const entry = index.storyboards.find(sb => sb.id === existingId);
    if (entry) {
      // Update title if changed
      if (storyTitle && entry.storyTitle !== storyTitle) {
        entry.storyTitle = storyTitle;
        entry.name = storyTitle;
        // Also update the storyboard.json name
        const sbPath = path.join(getStoryboardsDir(), existingId, 'storyboard.json');
        const sb = readJSON(sbPath);
        if (sb) {
          sb.name = storyTitle;
          writeJSON(sbPath, sb);
        }
        writeIndex(index);
      }
      return { id: entry.id, name: entry.name, storyId: entry.storyId, storyTitle: entry.storyTitle, created: false };
    }
    // Association exists but storyboard is missing — remove stale association
    delete index.storyAssociations[storyId];
    writeIndex(index);
  }

  // Create a new storyboard for this story
  const name = storyTitle || 'Story ' + storyId.slice(0, 8);
  const result = create(name, storyId, storyTitle);
  return { ...result, created: true };
}

function associateWithStory(storyboardId, storyId, storyTitle) {
  const index = readIndex();
  const entry = index.storyboards.find(sb => sb.id === storyboardId);
  if (!entry) return { success: false, error: 'Storyboard not found' };

  entry.storyId = storyId;
  entry.storyTitle = storyTitle || null;
  index.storyAssociations[storyId] = storyboardId;
  writeIndex(index);

  return { success: true };
}

function dissociateFromStory(storyboardId) {
  const index = readIndex();
  const entry = index.storyboards.find(sb => sb.id === storyboardId);
  if (!entry) return { success: false, error: 'Storyboard not found' };

  // Remove from associations map
  if (entry.storyId && index.storyAssociations[entry.storyId] === storyboardId) {
    delete index.storyAssociations[entry.storyId];
  }
  entry.storyId = null;
  entry.storyTitle = null;
  writeIndex(index);

  return { success: true };
}

module.exports = {
  list,
  create,
  delete: deleteStoryboard,
  rename,
  setActive,
  getScenes,
  commitScene,
  deleteScene,
  reorderScenes,
  updateSceneNote,
  getSceneImage,
  getOrCreateForStory,
  associateWithStory,
  dissociateFromStory,
};

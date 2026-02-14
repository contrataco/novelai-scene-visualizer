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

function readIndex() {
  const data = readJSON(getIndexPath());
  return data || { activeStoryboardId: null, storyboards: [] };
}

function writeIndex(index) {
  writeJSON(getIndexPath(), index);
}

// --- Storyboard CRUD ---

function list() {
  const index = readIndex();
  return { activeStoryboardId: index.activeStoryboardId, storyboards: index.storyboards };
}

function create(name) {
  const id = 'sb_' + Date.now();
  const sbDir = path.join(getStoryboardsDir(), id);
  ensureDir(path.join(sbDir, 'images'));

  const storyboard = { id, name, scenes: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  writeJSON(path.join(sbDir, 'storyboard.json'), storyboard);

  const index = readIndex();
  index.storyboards.push({ id, name, sceneCount: 0, updatedAt: storyboard.updatedAt });
  if (!index.activeStoryboardId) {
    index.activeStoryboardId = id;
  }
  writeIndex(index);

  return { id, name };
}

function deleteStoryboard(storyboardId) {
  const sbDir = path.join(getStoryboardsDir(), storyboardId);
  if (fs.existsSync(sbDir)) {
    fs.rmSync(sbDir, { recursive: true, force: true });
  }

  const index = readIndex();
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
};

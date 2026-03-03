/**
 * Portrait Manager — filesystem-based portrait storage with thumbnails.
 * Uses Electron nativeImage for thumbnail generation (no external deps).
 */

const { nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const LOG_PREFIX = '[Portrait]';
const THUMB_SIZE = 48;

let portraitsBaseDir = null;

function init(userDataPath) {
  portraitsBaseDir = path.join(userDataPath, 'portraits');
  if (!fs.existsSync(portraitsBaseDir)) {
    fs.mkdirSync(portraitsBaseDir, { recursive: true });
  }
  console.log(`${LOG_PREFIX} Portraits dir: ${portraitsBaseDir}`);
}

function getStoryDir(storyId) {
  const dir = path.join(portraitsBaseDir, storyId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getPortraitPath(storyId, characterId) {
  return path.join(getStoryDir(storyId), `${characterId}.png`);
}

function getThumbnailPath(storyId, characterId) {
  return path.join(getStoryDir(storyId), `${characterId}_thumb.png`);
}

function hasPortrait(storyId, characterId) {
  return fs.existsSync(getPortraitPath(storyId, characterId));
}

function savePortrait(storyId, characterId, imageBuffer) {
  const fullPath = getPortraitPath(storyId, characterId);
  fs.writeFileSync(fullPath, imageBuffer);

  // Generate thumbnail using Electron nativeImage
  try {
    const img = nativeImage.createFromBuffer(imageBuffer);
    const size = img.getSize();
    if (size.width > 0 && size.height > 0) {
      const thumb = img.resize({ width: THUMB_SIZE, height: THUMB_SIZE });
      fs.writeFileSync(getThumbnailPath(storyId, characterId), thumb.toPNG());
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Thumbnail generation failed:`, err.message);
  }

  console.log(`${LOG_PREFIX} Saved portrait for ${characterId} in story ${storyId}`);
}

function getPortraitAsBase64(storyId, characterId, thumbnail = false) {
  const filePath = thumbnail
    ? getThumbnailPath(storyId, characterId)
    : getPortraitPath(storyId, characterId);

  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath).toString('base64');
}

function deletePortrait(storyId, characterId) {
  const fullPath = getPortraitPath(storyId, characterId);
  const thumbPath = getThumbnailPath(storyId, characterId);
  if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  console.log(`${LOG_PREFIX} Deleted portrait for ${characterId}`);
}

module.exports = {
  init,
  getPortraitPath,
  getThumbnailPath,
  hasPortrait,
  savePortrait,
  getPortraitAsBase64,
  deletePortrait,
};

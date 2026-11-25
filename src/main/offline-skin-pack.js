'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { inspectSkinPng } = require('./skins');

const PACK_DIRECTORY = 'obsidian-offline-skin';
const PACK_ID = `file/${PACK_DIRECTORY}`;
const DEFAULT_SKIN_NAMES = ['alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'steve', 'sunny', 'zuri'];

function packMetadata(gameVersion) {
  const parsed = String(gameVersion || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  const major = Number(parsed?.[1]);
  const minor = Number(parsed?.[2]);
  const patch = Number(parsed?.[3] || 0);
  const description = 'Локальный офлайн-скин OBSIDIAN Launcher';

  if (major > 1 || (major === 1 && minor > 21) || (major === 1 && minor === 21 && patch >= 9)) {
    return { pack: { description, min_format: 1, max_format: 200 } };
  }

  let packFormat = 15;
  if (major === 1) {
    if (minor <= 8) packFormat = 1;
    else if (minor <= 10) packFormat = 2;
    else if (minor <= 12) packFormat = 3;
    else if (minor <= 14) packFormat = 4;
    else if (minor === 15) packFormat = 5;
    else if (minor === 16) packFormat = patch >= 2 ? 6 : 5;
    else if (minor === 17) packFormat = 7;
    else if (minor === 18) packFormat = patch >= 2 ? 9 : 8;
    else if (minor === 19) packFormat = patch >= 4 ? 13 : patch >= 3 ? 12 : 9;
    else if (minor === 20) packFormat = patch >= 5 ? 32 : patch >= 3 ? 22 : patch >= 2 ? 18 : 15;
    else if (minor === 21) packFormat = patch >= 6 ? 63 : patch >= 5 ? 55 : patch >= 4 ? 46 : patch >= 2 ? 42 : 34;
  }

  return {
    pack: {
      description,
      pack_format: packFormat,
      supported_formats: { min_inclusive: 1, max_inclusive: 200 }
    }
  };
}

async function atomicWrite(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, data, { flag: 'wx' });
    await fsp.rename(temporary, filePath);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function updateResourcePackSelection(gameDir, enabled) {
  const optionsPath = path.join(gameDir, 'options.txt');
  let optionsText = '';
  try {
    optionsText = await fsp.readFile(optionsPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const lines = optionsText ? optionsText.split(/\r?\n/) : [];
  const resourcePacksIndex = lines.findIndex((line) => line.startsWith('resourcePacks:'));
  let resourcePacks = ['vanilla'];
  if (resourcePacksIndex >= 0) {
    try {
      const value = JSON.parse(lines[resourcePacksIndex].slice('resourcePacks:'.length));
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new Error('ожидался список названий');
      }
      resourcePacks = value;
    } catch (error) {
      throw new Error(`Не удалось прочитать список ресурс-паков в ${optionsPath}: ${error.message}`);
    }
  }

  resourcePacks = resourcePacks.filter((entry) => entry !== PACK_ID);
  if (enabled) {
    if (!resourcePacks.includes('vanilla')) resourcePacks.unshift('vanilla');
    resourcePacks.push(PACK_ID);
  }
  const resourcePacksLine = `resourcePacks:${JSON.stringify(resourcePacks)}`;
  if (resourcePacksIndex >= 0) {
    lines[resourcePacksIndex] = resourcePacksLine;
  } else if (enabled) {
    lines.push(resourcePacksLine);
  }

  const incompatibleIndex = lines.findIndex((line) => line.startsWith('incompatibleResourcePacks:'));
  if (incompatibleIndex >= 0) {
    try {
      const value = JSON.parse(lines[incompatibleIndex].slice('incompatibleResourcePacks:'.length));
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new Error('ожидался список названий');
      }
      lines[incompatibleIndex] = `incompatibleResourcePacks:${JSON.stringify(value.filter((entry) => entry !== PACK_ID))}`;
    } catch (error) {
      throw new Error(`Не удалось прочитать список несовместимых ресурс-паков в ${optionsPath}: ${error.message}`);
    }
  }

  if (lines.length) await atomicWrite(optionsPath, `${lines.filter((line, index) => line || index < lines.length - 1).join('\n')}\n`);
}

function texturePaths() {
  return [
    'assets/minecraft/textures/entity/steve.png',
    'assets/minecraft/textures/entity/alex.png',
    ...DEFAULT_SKIN_NAMES.flatMap((name) => [
      `assets/minecraft/textures/entity/player/wide/${name}.png`,
      `assets/minecraft/textures/entity/player/slim/${name}.png`
    ])
  ];
}

async function applyOfflineSkinPack({ gameDir, gameVersion, skinBuffer }) {
  if (!gameDir) throw new Error('Не указана папка профиля для локального скина.');
  const dimensions = inspectSkinPng(skinBuffer);
  const packDir = path.join(gameDir, 'resourcepacks', PACK_DIRECTORY);
  const metadata = packMetadata(gameVersion);
  await atomicWrite(path.join(packDir, 'pack.mcmeta'), JSON.stringify(metadata, null, 2));
  for (const relativePath of texturePaths()) {
    await atomicWrite(path.join(packDir, relativePath), skinBuffer);
  }
  await updateResourcePackSelection(gameDir, true);
  return { ...dimensions, packDirectory: packDir };
}

async function removeOfflineSkinPack(gameDir) {
  if (!gameDir) return;
  await updateResourcePackSelection(gameDir, false);
  await fsp.rm(path.join(gameDir, 'resourcepacks', PACK_DIRECTORY), { recursive: true, force: true });
}

module.exports = {
  applyOfflineSkinPack,
  removeOfflineSkinPack,
  packMetadata,
  texturePaths,
  PACK_DIRECTORY,
  PACK_ID
};

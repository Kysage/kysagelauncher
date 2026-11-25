'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const JAVA_BIN = IS_WIN ? 'java.exe' : 'java';
const probeCache = new Map();
let runtimeCache = null;

function parseMajor(version) {
  if (!version) return 0;
  if (version.startsWith('1.')) {
    const major = parseInt(version.split('.')[1], 10);
    return Number.isFinite(major) ? major : 0;
  }
  const major = parseInt(version.split(/[.\-+_]/)[0], 10);
  return Number.isFinite(major) ? major : 0;
}

function requiredJavaMajorForMinecraft(version) {
  const parsed = String(version || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!parsed) return 21;

  const major = Number(parsed[1]);
  const minor = Number(parsed[2]);
  const patch = Number(parsed[3] || 0);
  if (major > 1) return 25;
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

function probeJava(exe) {
  if (!exe) return null;
  const key = path.resolve(exe).toLowerCase();
  if (probeCache.has(key)) return probeCache.get(key);

  let result = null;
  try {
    if (fs.existsSync(exe)) {
      const run = spawnSync(exe, ['-version'], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true
      });
      const text = `${run.stdout || ''}\n${run.stderr || ''}`;
      const match = text.match(/version\s+"?([\w.\-+]+)"?/i);
      const version = match ? match[1] : '';
      const major = parseMajor(version);
      if (major > 0) result = { path: path.resolve(exe), version, major };
    }
  } catch {
    result = null;
  }

  probeCache.set(key, result);
  return result;
}

function findOnPath() {
  try {
    const cmd = IS_WIN ? 'where.exe' : 'which';
    const run = spawnSync(cmd, ['java'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (run.status === 0 && run.stdout) {
      return run.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }
  } catch {
    /* ignore */
  }
  return [];
}

function walkForJava(dir, depth, found) {
  if (!dir || depth > 6 || found.length >= 6) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === JAVA_BIN.toLowerCase()) {
      found.push(path.join(dir, entry.name));
      if (found.length >= 6) return;
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'bin') continue;
    walkForJava(path.join(dir, entry.name), depth + 1, found);
  }
}

function runtimeRoots() {
  const roots = [];
  const local = process.env.LOCALAPPDATA;
  const roaming = process.env.APPDATA;
  const pf = process.env.ProgramFiles;
  const pf86 = process.env['ProgramFiles(x86)'];

  if (local) {
    roots.push(
      path.join(local, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime')
    );
    roots.push(path.join(local, 'Minecraft Launcher', 'runtime'));
  }
  if (roaming) roots.push(path.join(roaming, '.minecraft', 'runtime'));
  if (pf86) roots.push(path.join(pf86, 'Minecraft Launcher', 'runtime'));
  if (pf) roots.push(path.join(pf, 'Minecraft Launcher', 'runtime'));

  const seen = new Set();
  return roots.filter((dir) => {
    const key = dir.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

function scanManagedRuntimes() {
  if (runtimeCache) return runtimeCache;
  const found = [];
  for (const root of runtimeRoots()) walkForJava(root, 0, found);
  const probed = found.map(probeJava).filter(Boolean);
  runtimeCache = probed;
  return probed;
}

/**
 * Ищет лучшую доступную Java: точное совпадение мажорной версии важнее всего.
 */
function findJava({ customPath = '', requiredMajor = 8 } = {}) {
  const candidates = [];

  if (customPath && fs.existsSync(customPath)) candidates.push(customPath);

  if (process.env.JAVA_HOME) {
    candidates.push(path.join(process.env.JAVA_HOME, 'bin', JAVA_BIN));
  }

  candidates.push(...findOnPath());

  let probed = candidates.map(probeJava).filter(Boolean);
  let best = pickBest(probed, requiredMajor);

  if (!best || best.major !== requiredMajor) {
    const managed = scanManagedRuntimes();
    const combined = dedupeByPath([...probed, ...managed]);
    const managedBest = pickBest(combined, requiredMajor);
    if (managedBest && (!best || managedBest.major === requiredMajor)) {
      probed = combined;
      best = managedBest;
    }
  }

  if (!best) return null;

  return {
    ...best,
    required: requiredMajor,
    compatible: best.major >= requiredMajor,
    exact: best.major === requiredMajor
  };
}

function dedupeByPath(list) {
  const seen = new Set();
  return list.filter((item) => {
    const key = item.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pickBest(list, required) {
  if (!list.length) return null;
  const score = (java) => {
    if (java.major === required) return 10000;
    if (java.major > required) return 5000 - (java.major - required) * 10;
    return 1000 - (required - java.major) * 10;
  };
  return [...list].sort((a, b) => score(b) - score(a))[0];
}

module.exports = { findJava, probeJava, requiredJavaMajorForMinecraft };

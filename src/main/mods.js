'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const { DownloadManager, safeFilename } = require('./download-manager');

function modsDir(gameDir) {
  return path.join(gameDir, 'mods');
}

function downloadsDir() {
  return path.join(os.homedir(), 'Downloads');
}

async function findExistingDownloadedMod(fileName, file) {
  const candidate = path.join(downloadsDir(), safeFilename(fileName));
  try {
    const stat = await fsp.stat(candidate);
    if (!stat.isFile()) return '';
    const hasHashes = hasSupportedHash(file.hashes);
    if (!hasHashes && !file.fileLength) return '';
    if (file.fileLength && stat.size !== Number(file.fileLength)) return '';
    if (hasHashes && !hashMatches(candidate, file.hashes)) return '';
    return candidate;
  } catch {
    return '';
  }
}

function normalizeManualEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => entry && typeof entry === 'object' && entry.fileName)
    .slice(0, 300)
    .map((entry) => ({
      fileName: safeFilename(entry.fileName),
      pageUrl: typeof entry.pageUrl === 'string' ? entry.pageUrl : '',
      reason: typeof entry.reason === 'string' ? entry.reason : '',
      fileLength: Number(entry.fileLength) || 0,
      hashes: Array.isArray(entry.hashes) ? entry.hashes.filter((hash) => hash && typeof hash === 'object') : [],
      manualOptional: Boolean(entry.manualOptional)
    }));
}

async function inspectManualDownloads(entries, gameDir = '') {
  const normalized = normalizeManualEntries(entries);
  return Promise.all(normalized.map(async (entry) => {
    if (gameDir) {
      try {
        const installedPath = path.join(modsDir(gameDir), entry.fileName);
        const installedStat = await fsp.stat(installedPath);
        if (installedStat.isFile() && installedStat.size > 0) {
          return { fileName: entry.fileName, ready: true, optional: true, status: 'installed' };
        }
      } catch {}
    }
    if (entry.manualOptional) {
      return { fileName: entry.fileName, ready: true, optional: true, status: 'skipped' };
    }
    const target = path.join(downloadsDir(), entry.fileName);
    try {
      const stat = await fsp.stat(target);
      if (!stat.isFile() || stat.size === 0) {
        return { fileName: entry.fileName, ready: false, status: 'missing' };
      }
      if (entry.fileLength && stat.size !== entry.fileLength) {
        return { fileName: entry.fileName, ready: false, status: 'size' };
      }
      if (hasSupportedHash(entry.hashes) && !hashMatches(target, entry.hashes)) {
        return { fileName: entry.fileName, ready: false, status: 'hash' };
      }
      return { fileName: entry.fileName, ready: true, status: 'ready' };
    } catch {
      return { fileName: entry.fileName, ready: false, status: 'missing' };
    }
  }));
}

async function importManualDownloads(gameDir, entries) {
  const normalized = normalizeManualEntries(entries);
  const statuses = await inspectManualDownloads(normalized, gameDir);
  const imported = [];
  const pending = [];
  const modsPath = modsDir(gameDir);
  const resourcePacksPath = path.join(gameDir, 'resourcepacks');
  for (let index = 0; index < normalized.length; index += 1) {
    const entry = normalized[index];
    const status = statuses[index];
    if (!status.ready) {
      pending.push(status);
      continue;
    }
    if (status.optional) continue;
    const source = path.join(downloadsDir(), entry.fileName);
    if (/\.jar$/i.test(entry.fileName)) {
      await fsp.mkdir(modsPath, { recursive: true });
      await fsp.copyFile(source, path.join(modsPath, entry.fileName));
      imported.push(entry.fileName);
    } else if (/\.(zip|mcpack)$/i.test(entry.fileName)) {
      const resourcePackDir = path.join(resourcePacksPath, path.basename(entry.fileName, path.extname(entry.fileName)));
      await fsp.mkdir(resourcePackDir, { recursive: true });
      extractResourcePack(new AdmZip(source), resourcePackDir);
      imported.push(entry.fileName);
    } else {
      pending.push({ fileName: entry.fileName, ready: false, status: 'format' });
    }
  }
  return { imported, pending };
}

function hasSupportedHash(hashes) {
  return (Array.isArray(hashes) ? hashes : []).some((item) =>
    item && ['1', '2', 'sha1', 'md5'].includes(String(item.algo).toLowerCase())
  );
}

function hashMatches(file, hashes) {
  const expected = (Array.isArray(hashes) ? hashes : []).filter((item) =>
    item && ['1', '2', 'sha1', 'md5'].includes(String(item.algo).toLowerCase())
  );
  if (!expected.length) return false;
  const algorithms = new Set(expected.map((item) => String(item.algo).toLowerCase() === '1' || String(item.algo).toLowerCase() === 'sha1' ? 'sha1' : 'md5'));
  const values = new Map();
  for (const algorithm of algorithms) {
    const digest = crypto.createHash(algorithm).update(fs.readFileSync(file)).digest('hex');
    values.set(algorithm, digest);
  }
  return expected.some((item) => {
    const algorithm = String(item.algo).toLowerCase() === '1' || String(item.algo).toLowerCase() === 'sha1' ? 'sha1' : 'md5';
    return values.get(algorithm) === String(item.value).toLowerCase();
  });
}

async function waitForManualDownload({ file, signal, onProgress, onFallback }) {
  const directory = downloadsDir();
  const fileName = safeFilename(file.fileName || `curseforge-${file.id}.jar`);
  const destination = path.join(directory, fileName);
  await onFallback?.({ fileName, pageUrl: file.pageUrl });
  onProgress?.({
    phase: 'manual-download',
    message: `Скачайте ${fileName} с другого источника и положите файл в папку «Загрузки».`,
    fileName,
    pageUrl: file.pageUrl,
    percent: null
  });

  for (;;) {
    if (signal?.aborted) throw Object.assign(new Error('Установка отменена.'), { name: 'AbortError' });
    try {
      const stat = await fsp.stat(destination);
      if (stat.isFile() && stat.size > 0 && (!file.fileLength || stat.size === Number(file.fileLength))) {
        if (hasSupportedHash(file.hashes) && !hashMatches(destination, file.hashes)) {
          throw new Error(`Файл ${fileName} найден в «Загрузки», но его хеш не совпадает.`);
        }
        return destination;
      }
    } catch (error) {
      if (error.message.includes('хеш')) throw error;
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1000);
      const abort = () => { clearTimeout(timer); reject(Object.assign(new Error('Установка отменена.'), { name: 'AbortError' })); };
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

const ICON_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp']
]);
const MAX_ICON_BYTES = 512 * 1024;
const iconCache = new Map();

function pickIconValue(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  for (const key of ['128', '64', '256', '32', '16']) {
    if (typeof value[key] === 'string') return value[key];
  }
  return Object.values(value).find((item) => typeof item === 'string') || '';
}

function normalizeIconPath(value) {
  const clean = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').includes('..')) return '';
  return clean;
}

function iconPathFromArchive(zip) {
  const readJson = (name) => {
    try {
      const entry = zip.getEntry(name);
      return entry ? JSON.parse(entry.getData().toString('utf8')) : null;
    } catch {
      return null;
    }
  };

  const fabric = readJson('fabric.mod.json');
  if (fabric) {
    const icon = normalizeIconPath(pickIconValue(fabric.icon));
    if (icon) return icon;
  }

  const quilt = readJson('quilt.mod.json');
  if (quilt) {
    const icon = normalizeIconPath(pickIconValue(quilt.quilt_loader?.metadata?.icon));
    if (icon) return icon;
  }

  for (const name of ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']) {
    try {
      const entry = zip.getEntry(name);
      if (!entry) continue;
      const match = entry.getData().toString('utf8').match(/^\s*logoFile\s*=\s*["']([^"']+)["']/m);
      const icon = normalizeIconPath(match?.[1]);
      if (icon) return icon;
    } catch {
      /* повреждённый toml — пробуем следующий вариант */
    }
  }

  const legacy = readJson('mcmod.info');
  const first = Array.isArray(legacy) ? legacy[0] : legacy;
  if (first) {
    const icon = normalizeIconPath(first.logoFile || first.logo || '');
    if (icon) return icon;
  }

  return '';
}

function readJarIcon(file, stat) {
  const key = `${file}:${stat.mtimeMs}:${stat.size}`;
  if (iconCache.has(key)) return iconCache.get(key);

  let icon = '';
  try {
    const zip = new AdmZip(file);
    const iconPath = iconPathFromArchive(zip);
    const mime = ICON_MIME.get(path.extname(iconPath).toLowerCase());
    if (iconPath && mime) {
      const entry = zip.getEntry(iconPath);
      if (entry) {
        const data = entry.getData();
        if (data.length > 0 && data.length <= MAX_ICON_BYTES) {
          icon = `data:${mime};base64,${data.toString('base64')}`;
        }
      }
    }
  } catch {
    icon = '';
  }

  if (iconCache.size > 400) iconCache.clear();
  iconCache.set(key, icon);
  return icon;
}

async function listMods(gameDir) {
  const dir = modsDir(gameDir);
  await fsp.mkdir(dir, { recursive: true });
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && /\.jar$/i.test(entry.name))
      .map(async (entry) => {
        const file = path.join(dir, entry.name);
        const stat = await fsp.stat(file);
        return { name: entry.name, enabled: true, size: stat.size, icon: readJarIcon(file, stat) };
      })
  );
}

async function addLocalMod(gameDir, sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('Файл мода не найден');
  if (!/\.jar$/i.test(sourcePath)) throw new Error('Файл мода должен иметь расширение .jar');
  validateArchive(sourcePath, 'JAR-файл мода');
  const dir = modsDir(gameDir);
  await fsp.mkdir(dir, { recursive: true });
  const name = safeFilename(path.basename(sourcePath));
  const dest = path.join(dir, name);
  await fsp.copyFile(sourcePath, dest);
  return { name };
}

async function removeMod(gameDir, name) {
  if (!name || path.basename(name) !== name || !/\.jar$/i.test(name)) {
    throw new Error('Некорректное имя мода.');
  }
  await fsp.rm(path.join(modsDir(gameDir), name), { force: true });
}

function validateArchive(file, label) {
  try {
    if (new AdmZip(file).getEntries().length === 0) throw new Error('Архив не содержит файлов.');
  } catch (error) {
    throw new Error(`Повреждённый ${label}: ${error.message}`);
  }
}

function requiredDependencies(file) {
  return (file.dependencies || []).filter((dependency) => Number(dependency.relationType) === 3);
}

function compatibleFile(file, gameVersion) {
  if (!file || file.isAvailable === false) return false;
  const versions = file.gameVersions || [];
  return !gameVersion || versions.length === 0 || versions.includes(gameVersion);
}

function latestCompatibleFile(files, gameVersion) {
  return files
    .filter((file) => compatibleFile(file, gameVersion))
    .sort((left, right) => {
      const leftDate = Date.parse(left.fileDate || '');
      const rightDate = Date.parse(right.fileDate || '');
      return (Number.isFinite(rightDate) ? rightDate : 0) - (Number.isFinite(leftDate) ? leftDate : 0);
    })[0];
}

function requireCurseForgeHash(file) {
  if (!hasSupportedHash(file.hashes)) {
    throw new Error(`CurseForge не предоставил SHA-1 или MD5 для ${file.fileName || file.id}.`);
  }
}

function curseforgeLoaderType(loader) {
  return { forge: 1, fabric: 4, quilt: 5, neoforge: 6 }[loader];
}

async function findModrinthMirror(file, gameVersion, loader, signal, onProgress) {
  const { ModrinthService } = require('./modrinth');
  const service = new ModrinthService();
  const fileName = safeFilename(file.fileName || '');
  const query = fileName.replace(/\.(jar|zip|mcpack)$/i, '').replace(/[-_+.]+/g, ' ').slice(0, 100);
  if (!query) return null;
  try {
    const search = await service.search({ query, projectType: 'mod', gameVersion, loader, limit: 8, signal });
    for (const project of search.hits || []) {
      const versions = await service.listVersions(project.project_id, { gameVersion, loader, signal });
      const version = versions.find((item) => (item.files || []).some((candidate) =>
        candidate.filename === fileName || (file.fileLength && candidate.size === Number(file.fileLength))
      ));
      const mirror = version?.files?.find((candidate) =>
        candidate.filename === fileName || (file.fileLength && candidate.size === Number(file.fileLength))
      );
      if (mirror?.url) {
        onProgress?.({ phase: 'mirror-download', message: `Используем резервный источник Modrinth: ${mirror.filename}`, percent: null, fileName });
        return {
          url: mirror.url,
          hashes: mirror.hashes?.sha1 ? [{ algo: 'sha1', value: mirror.hashes.sha1 }] : [],
          fileLength: mirror.size || file.fileLength,
          fileName: mirror.filename
        };
      }
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
  }
  return null;
}

async function findDownloadUrl(service, file, signal) {
  if (file.downloadUrl) return file.downloadUrl;
  const modId = file.modId || file.projectID;
  if (!modId) throw new Error(`У файла ${file.fileName || file.id} отсутствует projectID.`);
  try {
    return await service.getDownloadUrl(modId, file.id, signal);
  } catch (error) {
    const detail = `${error.detail || ''} ${error.message || ''}`.toLowerCase();
    const credentialError = /api[\s_-]*key|credential|authentication|invalid key|unauthori[sz]ed/.test(detail);
    if (error.status !== 404 && !(error.status === 403 && !credentialError)) throw error;
    return null;
  }
}

async function filePage(service, file, signal) {
  const projectId = file.modId || file.projectID;
  if (!projectId) throw new Error(`Не удалось определить страницу файла ${file.id}.`);
  return service.filePageUrl(projectId, file.id, signal, file.websiteUrl);
}

async function installSelectedFile({
  service,
  apiKey,
  gameDir,
  fileId,
  gameVersion,
  modLoaderType,
  signal,
  onProgress,
  onFallback,
  waitForManual = false
}) {
  const files = await service.getFilesByIds([fileId], signal);
  if (!files.length) throw new Error('CurseForge не вернул выбранную версию файла.');
  const file = files[0];
  if (!compatibleFile(file, gameVersion)) throw new Error('Выбранный файл не совместим с версией Minecraft.');

  const root = path.join(gameDir, 'mods');
  await fsp.mkdir(root, { recursive: true });
  const manager = new DownloadManager(apiKey);
  const mirrorManager = new DownloadManager('', {
    allowedHosts: ['cdn.modrinth.com'],
    requireApiKey: false,
    providerLabel: 'Modrinth'
  });
  const completedProjects = new Set();
  const completedFiles = new Set();
  const blocked = [];
  let downloadedCount = 0;
  let totalCount = 1;

  const installGraph = async (target, depth = 0) => {
    if (depth > 32) throw new Error('Слишком много уровней обязательных зависимостей.');
    const projectId = Number(target.modId || target.projectID);
    const id = Number(target.id);
    if (!Number.isSafeInteger(projectId) || !Number.isSafeInteger(id)) {
      throw new Error('CurseForge вернул некорректные идентификаторы файла или проекта.');
    }
    if (completedProjects.has(projectId) || completedFiles.has(id)) return;
    completedProjects.add(projectId);

    for (const dependency of requiredDependencies(target)) {
      const dependencyId = Number(dependency.modId);
      if (!Number.isSafeInteger(dependencyId) || dependencyId <= 0 || completedProjects.has(dependencyId)) continue;
      const candidates = await service.listFiles(
        dependencyId,
        { gameVersion, modLoaderType, index: 0, pageSize: 50 },
        signal
      );
      const latest = latestCompatibleFile(candidates.data, gameVersion);
      if (!latest) {
        throw new Error(`Для обязательной зависимости ${dependencyId} не найдена версия, совместимая с Minecraft ${gameVersion}.`);
      }
      totalCount += 1;
      await installGraph(latest, depth + 1);
    }

    const url = await findDownloadUrl(service, target, signal);
    const fileName = safeFilename(target.fileName || `curseforge-${target.id}.jar`);
    if (!url) {
      const mirror = await findModrinthMirror(
        target,
        gameVersion,
        { 1: 'forge', 4: 'fabric', 5: 'quilt', 6: 'neoforge' }[Number(modLoaderType)],
        signal,
        onProgress
      );
      if (mirror) {
        const result = await mirrorManager.download({
          url: mirror.url,
          destination: path.join(root, fileName),
          fileName: mirror.fileName || fileName,
          hashes: mirror.hashes,
          fileLength: mirror.fileLength,
          signal,
          onProgress: (progress) => onProgress?.({ ...progress, completedFiles: downloadedCount, totalFiles: totalCount })
        });
        completedFiles.add(id);
        downloadedCount += 1;
        onProgress?.({ phase: 'file-complete', fileName, bytesReceived: result.bytesReceived, totalBytes: result.bytesReceived, percent: 100, completedFiles: downloadedCount, totalFiles: totalCount });
        return;
      }
      const pageUrl = await filePage(service, target, signal);
      if (!waitForManual) {
        const reason = 'CurseForge не выдал прямую ссылку. Скачайте файл вручную.';
        blocked.push({
          fileName: target.fileName,
          pageUrl,
          projectId,
          fileId: id,
          fileLength: Number(target.fileLength) || 0,
          hashes: Array.isArray(target.hashes) ? target.hashes : [],
          reason
        });
        await onFallback?.({
          fileName: target.fileName,
          pageUrl,
          reason,
          fileLength: Number(target.fileLength) || 0,
          hashes: Array.isArray(target.hashes) ? target.hashes : []
        });
        return;
      }
      const manualFile = await waitForManualDownload({
        file: { ...target, fileName, pageUrl },
        signal,
        onProgress,
        onFallback
      });
      await fsp.copyFile(manualFile, path.join(root, fileName));
      completedFiles.add(id);
      downloadedCount += 1;
      onProgress?.({ phase: 'file-complete', fileName, percent: 100, completedFiles: downloadedCount, totalFiles: totalCount });
      return;
    }
    if (!/\.jar$/i.test(fileName)) throw new Error(`${fileName} не является JAR-модом.`);
    requireCurseForgeHash(target);
    const result = await manager.download({
      url,
      destination: path.join(root, fileName),
      fileName,
      hashes: target.hashes,
      fileLength: target.fileLength,
      signal,
      onProgress: (progress) =>
        onProgress?.({ ...progress, completedFiles: downloadedCount, totalFiles: totalCount })
    });
    completedFiles.add(id);
    downloadedCount += 1;
    onProgress?.({
      phase: 'file-complete',
      fileName,
      bytesReceived: result.bytesReceived,
      totalBytes: result.bytesReceived,
      percent: 100,
      completedFiles: downloadedCount,
      totalFiles: totalCount
    });
  };

  await installGraph(file);
  return { installed: downloadedCount, blocked, mods: await listMods(gameDir) };
}

function compatibleModrinthVersion(version, gameVersion, loader) {
  const gameVersions = version.game_versions || [];
  const loaders = version.loaders || [];
  return (!gameVersion || gameVersions.includes(gameVersion)) && (!loader || loaders.includes(loader));
}

function modrinthHashes(file) {
  return Object.entries(file.hashes || {})
    .filter(([algorithm]) => ['sha1', 'sha512'].includes(algorithm.toLowerCase()))
    .map(([algo, value]) => ({ algo: algo.toLowerCase(), value }));
}

async function installModrinthVersion({
  service,
  gameDir,
  versionId,
  gameVersion,
  loader,
  signal,
  onProgress
}) {
  const selected = await service.getVersion(versionId, signal);
  if (!compatibleModrinthVersion(selected, gameVersion, loader)) {
    throw new Error('Выбранная версия мода несовместима с этой сборкой.');
  }

  const manager = new DownloadManager('', {
    allowedHosts: ['cdn.modrinth.com'],
    requireApiKey: false,
    providerLabel: 'Modrinth'
  });
  const destinationDir = modsDir(gameDir);
  await fsp.mkdir(destinationDir, { recursive: true });
  const completedVersions = new Set();
  const completedProjects = new Set();
  let downloadedCount = 0;
  let totalCount = 1;

  const installGraph = async (version, depth = 0) => {
    if (depth > 32) throw new Error('Слишком много уровней обязательных зависимостей.');
    if (completedVersions.has(version.id)) return;
    if (version.project_id && completedProjects.has(version.project_id)) return;
    completedVersions.add(version.id);
    if (version.project_id) completedProjects.add(version.project_id);

    for (const dependency of version.dependencies || []) {
      if (dependency.dependency_type !== 'required') continue;
      let required;
      if (dependency.version_id) {
        required = await service.getVersion(dependency.version_id, signal);
      } else if (dependency.project_id) {
        const versions = await service.listVersions(dependency.project_id, { gameVersion, loader, signal });
        required = versions[0];
      }
      if (!required) {
        throw new Error(`Для обязательной зависимости ${dependency.project_id || dependency.version_id} не найдена совместимая версия.`);
      }
      if (!compatibleModrinthVersion(required, gameVersion, loader)) {
        throw new Error(`Обязательная зависимость ${required.name || required.id} несовместима с этой сборкой.`);
      }
      totalCount += 1;
      await installGraph(required, depth + 1);
    }

    const file = (version.files || [])
      .filter((candidate) => /\.jar$/i.test(candidate.filename || ''))
      .sort((left, right) => Number(Boolean(right.primary)) - Number(Boolean(left.primary)))[0];
    if (!file?.url) throw new Error(`В версии ${version.name || version.id} не найден JAR-файл.`);
    const fileName = safeFilename(file.filename);
    const hashes = modrinthHashes(file);
    if (!hashes.length) throw new Error(`Modrinth не предоставил SHA-1/SHA-512 для ${fileName}.`);
    const result = await manager.download({
      url: file.url,
      destination: path.join(destinationDir, fileName),
      fileName,
      hashes,
      fileLength: file.size,
      signal,
      onProgress: (progress) =>
        onProgress?.({ ...progress, completedFiles: downloadedCount, totalFiles: totalCount })
    });
    downloadedCount += 1;
    onProgress?.({
      phase: 'file-complete',
      fileName,
      bytesReceived: result.bytesReceived,
      totalBytes: result.bytesReceived,
      percent: 100,
      completedFiles: downloadedCount,
      totalFiles: totalCount
    });
  };

  await installGraph(selected);
  return { installed: downloadedCount, mods: await listMods(gameDir) };
}

function loaderFromManifest(manifest) {
  const entries = manifest.minecraft?.modLoaders || [];
  if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry !== 'object')) {
    throw new Error('В manifest.json указан некорректный список загрузчиков.');
  }
  const selected = entries.find((item) => item.primary) || entries[0];
  if (!selected?.id) return { loader: 'vanilla', loaderVersion: '' };
  const id = String(selected.id);
  const prefixes = [
    ['fabric-loader-', 'fabric'],
    ['fabric-', 'fabric'],
    ['forge-', 'forge'],
    ['quilt-loader-', 'quilt'],
    ['quilt-', 'quilt'],
    ['neoforge-', 'neoforge']
  ];
  for (const [prefix, loader] of prefixes) {
    if (id.startsWith(prefix)) return { loader, loaderVersion: id.slice(prefix.length) };
  }
  throw new Error(`Загрузчик «${id}» из модпака не поддерживается.`);
}

function safeArchiveRelativePath(value, message) {
  const normalized = path.normalize(String(value || '').replace(/\\/g, '/'));
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error(message);
  }
  return normalized;
}

function extractArchiveEntries(zip, gameDir, prefix = '', errorMessage = 'Архив содержит недопустимый путь.') {
  const root = path.resolve(gameDir);
  for (const entry of zip.getEntries()) {
    const archivePath = entry.entryName.replace(/\\/g, '/');
    if (entry.isDirectory || (prefix && !archivePath.startsWith(prefix))) continue;
    const rawRelative = prefix ? archivePath.slice(prefix.length) : archivePath;
    const relative = safeArchiveRelativePath(rawRelative, errorMessage);
    const destination = path.resolve(root, relative);
    const relativeCheck = path.relative(root, destination);
    if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
      throw new Error(errorMessage);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, entry.getData());
  }
}

function extractOverrides(zip, gameDir) {
  extractArchiveEntries(
    zip,
    gameDir,
    'overrides/',
    'Модпак содержит недопустимый путь в overrides.'
  );
}

async function unpackResourcePackArchives(gameDir) {
  const resourcePacksPath = path.join(gameDir, 'resourcepacks');
  let entries;
  try {
    entries = await fsp.readdir(resourcePacksPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(zip|mcpack)$/i.test(entry.name)) continue;
    const archivePath = path.join(resourcePacksPath, entry.name);
    const destination = path.join(resourcePacksPath, path.basename(entry.name, path.extname(entry.name)));
    await fsp.mkdir(destination, { recursive: true });
    try {
      extractResourcePack(new AdmZip(archivePath), destination);
      await fsp.rm(archivePath, { force: true });
    } catch (error) {
      throw new Error(`Не удалось распаковать ресурсный пакет ${entry.name}: ${error.message}`);
    }
  }
}

function extractResourcePack(zip, gameDir) {
  extractArchiveEntries(
    zip,
    gameDir,
    '',
    'Архив дополнительного файла содержит недопустимый путь.'
  );
}

async function runLimited(items, limit, worker) {
  const queue = [...items];
  let failure = null;
  const runners = Array.from(
    { length: Math.min(Math.max(1, Number(limit) || 1), queue.length) },
    async () => {
      while (queue.length && !failure) {
        const item = queue.shift();
        try {
          await worker(item);
        } catch (error) {
          if (!failure) failure = error;
        }
      }
    }
  );
  await Promise.all(runners);
  if (failure) throw failure;
}

async function installModpack({
  service,
  apiKey,
  gameDir,
  fileId,
  packName = '',
  signal,
  onProgress,
  onFallback,
  installLoader,
  createTarget,
  waitForManual = false
}) {
  const files = await service.getFilesByIds([fileId], signal);
  if (!files.length) throw new Error('CurseForge не вернул выбранную версию модпака.');
  const packFile = files[0];
  const url = await findDownloadUrl(service, packFile, signal);
  const temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'obsidian-modpack-'));
  const archiveName = safeFilename(packFile.fileName || `curseforge-${packFile.id}.zip`);
  const archivePath = path.join(temporaryDirectory, archiveName);
  const blocked = [];
  let downloadedCount = 0;
  let totalCount = 1;
  const manager = new DownloadManager(apiKey);
  const mirrorManager = new DownloadManager('', {
    allowedHosts: ['cdn.modrinth.com'],
    requireApiKey: false,
    providerLabel: 'Modrinth'
  });

  try {
    let archiveDownload;
    if (!url) {
      const pageUrl = await filePage(service, packFile, signal);
      if (!waitForManual) {
        throw new Error(
          `Архив сборки ${packFile.fileName || ''} нельзя скачать автоматически. ` +
          `Откройте страницу файла на CurseForge (${pageUrl || 'страница проекта'}) и установите сборку заново.`
        );
      }
      const manualFile = await waitForManualDownload({
        file: { ...packFile, fileName: archiveName, pageUrl },
        signal,
        onProgress,
        onFallback
      });
      await fsp.copyFile(manualFile, archivePath);
      archiveDownload = { bytesReceived: packFile.fileLength || 0 };
    } else {
      archiveDownload = await manager.download({
        url,
        destination: archivePath,
        fileName: archiveName,
        hashes: packFile.hashes,
        fileLength: packFile.fileLength,
        signal,
        onProgress: (progress) => onProgress?.({ ...progress, phase: 'pack-download' })
      });
    }

    onProgress?.({
      phase: 'pack-extract',
      message: 'Распаковываем архив модпака…',
      percent: null,
      bytesReceived: archiveDownload.bytesReceived,
      totalBytes: archiveDownload.bytesReceived
    });
    const zip = new AdmZip(archivePath);
    const manifestEntry = zip.getEntry('manifest.json');
    if (!manifestEntry) throw new Error('В архиве CurseForge не найден manifest.json.');
    let manifest;
    try {
      manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
    } catch (error) {
      throw new Error(`Не удалось прочитать manifest.json модпака: ${error.message}`);
    }

    const gameVersion = manifest.minecraft?.version;
    if (!gameVersion || !/^[\w.-]{1,64}$/.test(gameVersion)) {
      throw new Error('В manifest.json не указана корректная версия Minecraft.');
    }
    const loader = loaderFromManifest(manifest);

    let targetDir = gameDir;
    let instance = null;
    if (createTarget) {
      const target = await createTarget({ gameVersion, loader, packFile, manifest, packName });
      if (target?.gameDir) {
        targetDir = target.gameDir;
        instance = target.instance || null;
      }
    }

    onProgress?.({
      phase: 'loader-install',
      message: loader.loader === 'vanilla'
        ? 'Подготавливаем профиль Vanilla…'
        : `Устанавливаем загрузчик ${loader.loader}…`,
      percent: null
    });
    const installedLoader = await installLoader({ ...loader, gameVersion, gameDir: targetDir, signal });
    if (installedLoader?.loaderVersion && loader.loader === 'fabric') {
      instance = instance ? { ...instance, loaderVersion: installedLoader.loaderVersion } : instance;
    }

    if (!Array.isArray(manifest.files) || manifest.files.some((entry) => !entry || typeof entry !== 'object')) {
      throw new Error('В manifest.json отсутствует корректный список файлов модпака.');
    }
    const packEntries = manifest.files.filter((entry) => entry.required !== false);
    for (const entry of packEntries) {
      if (!Number.isSafeInteger(Number(entry.projectID)) || Number(entry.projectID) <= 0 ||
          !Number.isSafeInteger(Number(entry.fileID)) || Number(entry.fileID) <= 0) {
        throw new Error('В manifest.json обнаружен некорректный projectID или fileID.');
      }
    }
    onProgress?.({
      phase: 'metadata',
      message: `Получаем метаданные ${packEntries.length} файлов модпака…`,
      percent: null
    });
    const metadata = await service.getFilesByIds(packEntries.map((entry) => entry.fileID), signal);
    const filesById = new Map(metadata.map((file) => [Number(file.id), file]));
    const completedProjects = new Set();
    const completedFiles = new Set();
    const modsPath = modsDir(targetDir);
    const resourcePacksPath = path.join(targetDir, 'resourcepacks');
    const activeDownloads = new Map();
    const downloadBytes = new Map();
    const downloadTotals = new Map();
    await fsp.mkdir(modsPath, { recursive: true });
    await fsp.mkdir(resourcePacksPath, { recursive: true });
    totalCount += packEntries.length;

    const reportFileProgress = (progress) => {
      const name = safeFilename(progress.fileName || 'download');
      if (Number.isFinite(progress.bytesReceived)) {
        downloadBytes.set(name, Math.max(downloadBytes.get(name) || 0, progress.bytesReceived));
      }
      if (Number.isFinite(progress.totalBytes) && progress.totalBytes > 0) {
        downloadTotals.set(name, progress.totalBytes);
      }
      if (progress.percent === 100) {
        activeDownloads.delete(name);
      } else {
        activeDownloads.set(name, {
          fileName: name,
          percent: progress.percent,
          totalBytes: progress.totalBytes || 0
        });
      }
      onProgress?.({
        ...progress,
        phase: progress.percent === 100 ? 'file-complete' : 'mod-download',
        completedFiles: downloadedCount,
        totalFiles: totalCount,
        bytesReceived: [...downloadBytes.values()].reduce((sum, value) => sum + value, 0),
        totalBytes: [...downloadTotals.values()].reduce((sum, value) => sum + value, 0) || undefined,
        activeDownloads: [...activeDownloads.values()].slice(0, 5)
      });
    };

    const installGraph = async (target, depth = 0) => {
      if (depth > 32) throw new Error('Слишком много уровней обязательных зависимостей.');
      const projectId = Number(target.modId || target.projectID);
      const id = Number(target.id);
      if (!Number.isSafeInteger(projectId) || !Number.isSafeInteger(id)) {
        throw new Error('CurseForge вернул некорректные идентификаторы файла или проекта.');
      }
      if (completedProjects.has(projectId) || completedFiles.has(id)) return;
      completedProjects.add(projectId);

      for (const dependency of requiredDependencies(target)) {
        const dependencyId = Number(dependency.modId);
        if (!Number.isSafeInteger(dependencyId) || dependencyId <= 0 || completedProjects.has(dependencyId)) continue;
        const candidates = await service.listFiles(
          dependencyId,
          {
            gameVersion,
            modLoaderType: curseforgeLoaderType(loader.loader),
            index: 0,
            pageSize: 50
          },
          signal
        );
        const latest = latestCompatibleFile(candidates.data, gameVersion);
        if (!latest) {
          blocked.push({
            fileName: `Зависимость CurseForge ${dependencyId}`,
            projectId: dependencyId,
            manualOptional: true,
            reason: `Совместимая версия для Minecraft ${gameVersion} не найдена.`
          });
          onProgress?.({
            phase: 'dependency-skip',
            message: `Пропущена устаревшая зависимость ${dependencyId}: совместимая версия не найдена.`,
            percent: null,
            completedFiles: downloadedCount,
            totalFiles: totalCount
          });
          continue;
        }
        totalCount += 1;
        await installGraph(latest, depth + 1);
      }

      if (completedProjects.has(projectId) && completedFiles.has(id)) return;
      const downloadUrl = await findDownloadUrl(service, target, signal);
      const fileName = safeFilename(target.fileName || `curseforge-${target.id}.jar`);
      if (/\.jar$/i.test(fileName)) {
        const existing = await findExistingDownloadedMod(fileName, target);
        if (existing) {
          await fsp.copyFile(existing, path.join(modsPath, fileName));
          completedFiles.add(id);
          downloadedCount += 1;
          onProgress?.({ phase: 'file-complete', message: `Уже готов: ${fileName}`, fileName, percent: 100, completedFiles: downloadedCount, totalFiles: totalCount });
          return;
        }
      }
      if (!downloadUrl) {
        const mirror = await findModrinthMirror(
          target,
          gameVersion,
          loader.loader,
          signal,
          onProgress
        );
        if (mirror) {
          const mirrorFileName = safeFilename(mirror.fileName || fileName);
          const mirrorDestination = path.join(temporaryDirectory, `${id}-${mirrorFileName}`);
          const mirrorResult = await mirrorManager.download({
            url: mirror.url,
            destination: mirrorDestination,
            fileName: mirrorFileName,
            hashes: mirror.hashes,
            fileLength: mirror.fileLength,
            signal,
            onProgress: reportFileProgress
          });
          completedFiles.add(id);
          if (/\.jar$/i.test(mirrorFileName)) {
            await fsp.copyFile(mirrorDestination, path.join(modsPath, mirrorFileName));
          } else if (/\.(zip|mcpack)$/i.test(mirrorFileName)) {
            const resourcePackDir = path.join(resourcePacksPath, path.basename(mirrorFileName, path.extname(mirrorFileName)));
            await fsp.mkdir(resourcePackDir, { recursive: true });
            extractResourcePack(new AdmZip(mirrorDestination), resourcePackDir);
          }
          onProgress?.({ phase: 'file-complete', fileName: mirrorFileName, bytesReceived: mirrorResult.bytesReceived, totalBytes: mirrorResult.bytesReceived, percent: 100, completedFiles: downloadedCount, totalFiles: totalCount });
          return;
        }
        const pageUrl = await filePage(service, target, signal);
        if (!waitForManual) {
          const reason = 'CurseForge не выдал прямую ссылку. Скачайте файл вручную.';
          blocked.push({
            fileName: target.fileName,
            pageUrl,
            projectId,
            fileId: id,
            fileLength: Number(target.fileLength) || 0,
            hashes: target.hashes,
            reason
          });
          await onFallback?.({
            fileName: target.fileName,
            pageUrl,
            reason,
            fileLength: Number(target.fileLength) || 0,
            hashes: target.hashes
          });
          return;
        }
        const existing = await findExistingDownloadedMod(fileName, target);
        if (existing) {
          await fsp.copyFile(existing, path.join(modsPath, fileName));
          completedFiles.add(id);
          downloadedCount += 1;
          onProgress?.({ phase: 'file-complete', message: `Уже готов: ${fileName}`, fileName, percent: 100, completedFiles: downloadedCount, totalFiles: totalCount });
          return;
        }
        const manualFile = await waitForManualDownload({
          file: { ...target, fileName, pageUrl },
          signal,
          onProgress,
          onFallback
        });
        const manualDestination = path.join(temporaryDirectory, `${id}-${fileName}`);
        await fsp.copyFile(manualFile, manualDestination);
        completedFiles.add(id);
        downloadedCount += 1;
        if (/\.jar$/i.test(fileName)) {
          await fsp.copyFile(manualDestination, path.join(modsPath, fileName));
        } else if (/\.(zip|mcpack)$/i.test(fileName)) {
          const resourcePackDir = path.join(resourcePacksPath, path.basename(fileName, path.extname(fileName)));
          await fsp.mkdir(resourcePackDir, { recursive: true });
          extractResourcePack(new AdmZip(manualDestination), resourcePackDir);
        }
        onProgress?.({ phase: 'file-complete', fileName, percent: 100, completedFiles: downloadedCount, totalFiles: totalCount });
        return;
      }

      
      const isMod = /\.jar$/i.test(fileName);
      const isResourcePack = /\.(zip|mcpack)$/i.test(fileName);
      if (!isMod && !isResourcePack) {
        throw new Error(`Файл ${fileName} из модпака имеет неподдерживаемый формат.`);
      }
      requireCurseForgeHash(target);
      const temporaryFile = path.join(temporaryDirectory, `${id}-${fileName}`);
      const result = await manager.download({
        url: downloadUrl,
        destination: temporaryFile,
        fileName,
        hashes: target.hashes,
        fileLength: target.fileLength,
        signal,
        onProgress: reportFileProgress
      });

      if (isMod) {
        await fsp.copyFile(temporaryFile, path.join(modsPath, fileName));
      } else {
        const resourcePackDir = path.join(resourcePacksPath, path.basename(fileName, path.extname(fileName)));
        await fsp.mkdir(resourcePackDir, { recursive: true });
        try {
          const resourceZip = new AdmZip(temporaryFile);
          extractResourcePack(resourceZip, resourcePackDir);
        } catch (error) {
          throw new Error(`Не удалось распаковать ресурсный пакет ${fileName}: ${error.message}`);
        }
      }

      completedFiles.add(id);
      downloadedCount += 1;
      onProgress?.({
        phase: 'file-complete',
        fileName,
        bytesReceived: result.bytesReceived,
        totalBytes: result.bytesReceived,
        percent: 100,
        completedFiles: downloadedCount,
        totalFiles: totalCount,
        activeDownloads: [...activeDownloads.values()].slice(0, 5)
      });
    };

    const blockPackFile = async (file, error) => {
      const fileName = safeFilename(file.fileName || `curseforge-${file.id}.jar`);
      activeDownloads.delete(fileName);
      const fileId = Number(file.id) || undefined;
      const projectId = Number(file.modId || file.projectID) || undefined;
      if (blocked.some((entry) => entry.fileId && entry.fileId === fileId)) return;
      let pageUrl = '';
      try {
        pageUrl = await filePage(service, file, signal);
      } catch {
        pageUrl = '';
      }
      const reason = `Не удалось скачать автоматически: ${error?.message || 'неизвестная ошибка'}.`;
      blocked.push({
        fileName,
        pageUrl,
        projectId,
        fileId,
        fileLength: Number(file.fileLength) || 0,
        hashes: Array.isArray(file.hashes) ? file.hashes : [],
        reason
      });
      await onFallback?.({
        fileName,
        pageUrl,
        reason,
        fileLength: Number(file.fileLength) || 0,
        hashes: Array.isArray(file.hashes) ? file.hashes : []
      });
      onProgress?.({
        phase: 'file-blocked',
        message: `Файл ${fileName} добавлен в ручную загрузку.`,
        percent: null,
        completedFiles: downloadedCount,
        totalFiles: totalCount,
        activeDownloads: [...activeDownloads.values()].slice(0, 5)
      });
    };

    for (const packEntry of packEntries) {
      if (signal?.aborted) throw Object.assign(new Error('Установка отменена.'), { name: 'AbortError' });
    }
    let preparedCount = 0;
    await runLimited(packEntries, 5, async (packEntry) => {
      if (signal?.aborted) throw Object.assign(new Error('Установка отменена.'), { name: 'AbortError' });
      const file = filesById.get(Number(packEntry.fileID));
      if (!file) {
        blocked.push({
          fileName: `Файл CurseForge ${packEntry.fileID}`,
          projectId: Number(packEntry.projectID) || undefined,
          fileId: Number(packEntry.fileID) || undefined,
          manualOptional: true,
          reason: 'CurseForge не вернул метаданные этого файла.'
        });
        return;
      }
      preparedCount += 1;
      onProgress?.({
        phase: 'mod-prepare',
        message: `Скачиваем моды: ${preparedCount}/${packEntries.length}…`,
        percent: null,
        completedFiles: downloadedCount,
        totalFiles: totalCount
      });
      const graphFile = { ...file, modId: file.modId || packEntry.projectID };
      try {
        await installGraph(graphFile);
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        await blockPackFile(graphFile, error);
      }
    });

    onProgress?.({
      phase: 'overrides',
      message: 'Копируем настройки и файлы сборки…',
      percent: null,
      completedFiles: downloadedCount,
      totalFiles: totalCount
    });
    extractOverrides(zip, targetDir);
    await unpackResourcePackArchives(targetDir);
    onProgress?.({
      phase: 'install-complete',
      message: 'Сборка установлена',
      percent: 100,
      completedFiles: downloadedCount,
      totalFiles: totalCount
    });
    return {
      installed: downloadedCount,
      blocked,
      gameVersion,
      loader,
      instance,
      mods: await listMods(targetDir)
    };
  } finally {
    await fsp.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

module.exports = {
  modsDir,
  listMods,
  addLocalMod,
  removeMod,
  installSelectedFile,
  installModrinthVersion,
  installModpack,
  inspectManualDownloads,
  importManualDownloads,
  loaderFromManifest,
  extractOverrides,
  extractResourcePack
};

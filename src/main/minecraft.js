'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { app, net } = require('electron');
const { findJava } = require('./java');
const { offlineUuid } = require('./auth');
const {
  loadFabricProfile,
  loadForgeProfile,
  loadQuiltProfile,
  loadNeoForgeProfile
} = require('./loaders');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const RESOURCES_URL = 'https://resources.download.minecraft.net';
const OS_NAME = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
const LAUNCHER_NAME = 'obsidian-launcher';
const ASSET_CONCURRENCY = 6;

/* ─────────────────────────── сеть и файлы ─────────────────────────── */

async function fetchJson(url, { signal } = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await net.fetch(url, {
        signal,
        headers: { Accept: 'application/json', 'User-Agent': `${LAUNCHER_NAME}/${app.getVersion()}` }
      });
      if (!res.ok) throw new Error(`Сервер вернул ${res.status}`);
      return await res.json();
    } catch (error) {
      lastError = error;
      if (signal?.aborted || error.name === 'AbortError' || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function fileLooksValid(dest, job) {
  try {
    const stat = await fsp.stat(dest);
    if (!stat.isFile() || stat.size === 0) return false;
    if (job.size && stat.size !== job.size) return false;
    if (job.verify && job.sha1) {
      return (await sha1File(dest)) === job.sha1;
    }
    return true;
  } catch {
    return false;
  }
}

async function downloadJob(job, signal, onBytes) {
  let res;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      res = await net.fetch(job.url, {
        signal,
        headers: { 'User-Agent': `${LAUNCHER_NAME}/${app.getVersion()}`, Accept: '*/*' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      break;
    } catch (error) {
      lastError = error;
      if (signal?.aborted || error.name === 'AbortError' || attempt === 2) {
        throw new Error(`Не удалось скачать ${job.url}: ${error.message || error}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  if (!res) throw lastError || new Error(`Не удалось скачать ${job.url}`);
  await ensureDir(path.dirname(job.dest));
  const tmp = `${job.dest}.part`;
  const handle = await fsp.open(tmp, 'w');
  let received = 0;
  try {
    if (res.body) {
      for await (const chunk of res.body) {
        if (signal?.aborted) throw new Error('Загрузка отменена');
        received += chunk.length;
        await handle.write(chunk);
        onBytes?.(received);
      }
    }
  } catch (err) {
    await handle.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  await handle.close();
  if (job.sha1) {
    const got = await sha1File(tmp);
    if (got !== job.sha1) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw new Error('Файл повреждён (не сошлась контрольная сумма)');
    }
  }
  await fsp.rename(tmp, job.dest);
}

async function ensureFile(job, signal, onBytes) {
  if (await fileLooksValid(job.dest, job)) return false;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await downloadJob(job, signal, onBytes);
      return true;
    } catch (err) {
      lastError = err;
      if (signal?.aborted || err.name === 'AbortError') throw err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw lastError;
}

async function pool(items, limit, worker, signal) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      if (signal?.aborted) throw new Error('Загрузка отменена');
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/* ─────────────────────────── манифесты ─────────────────────────── */

async function getManifest(root, { force = false, signal } = {}) {
  const cachePath = path.join(root, 'version_manifest_v2.json');
  if (!force) {
    try {
      const stat = await fsp.stat(cachePath);
      if (Date.now() - stat.mtimeMs < 10 * 60 * 1000) {
        return JSON.parse(await fsp.readFile(cachePath, 'utf8'));
      }
    } catch {
      /* нет кэша */
    }
  }

  try {
    const manifest = await fetchJson(MANIFEST_URL, { signal });
    await ensureDir(root);
    await fsp.writeFile(cachePath, JSON.stringify(manifest), 'utf8');
    return manifest;
  } catch (err) {
    try {
      return JSON.parse(await fsp.readFile(cachePath, 'utf8'));
    } catch {
      throw new Error('Не удалось получить список версий Mojang. Проверьте подключение к интернету.');
    }
  }
}

async function getVersionMeta(root, entry, signal) {
  const dir = path.join(root, 'versions', entry.id);
  const file = path.join(dir, `${entry.id}.json`);
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    /* скачаем */
  }
  const meta = await fetchJson(entry.url, { signal });
  await ensureDir(dir);
  await fsp.writeFile(file, JSON.stringify(meta), 'utf8');
  return meta;
}

async function getAssetIndex(root, meta, signal) {
  if (!meta.assetIndex?.url) return null;
  const id = meta.assetIndex.id || meta.assets;
  const dir = path.join(root, 'assets', 'indexes');
  const file = path.join(dir, `${id}.json`);
  let data;
  try {
    data = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    data = await fetchJson(meta.assetIndex.url, { signal });
    await ensureDir(dir);
    await fsp.writeFile(file, JSON.stringify(data), 'utf8');
  }
  return { id, data };
}

/* ─────────────────────────── правила и аргументы ─────────────────────────── */

function rulesAllow(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return true;

  let allowed = false;
  for (const rule of rules) {
    if (rule.os) {
      if (rule.os.name && rule.os.name !== OS_NAME) continue;
      if (rule.os.arch) {
        const want64 = rule.os.arch === 'x86_64' || rule.os.arch === 'arm64';
        const is64 = process.arch === 'x64' || process.arch === 'arm64';
        if (rule.os.arch === 'x86' && is64) continue;
        if (want64 && !is64) continue;
        if (rule.os.arch === 'arm64' && process.arch !== 'arm64') continue;
        if (rule.os.arch === 'x86_64' && process.arch !== 'x64') continue;
      }
      // versionRange-правила (GC-флаги и т.п.) не применяем
      if (rule.os.versionRange) continue;
    }
    if (rule.features) continue; // демо, quickPlay и кастомное разрешение не поддерживаем
    allowed = rule.action === 'allow';
  }
  return allowed;
}

function flattenArgument(entry, out) {
  if (typeof entry === 'string') {
    out.push(entry);
    return;
  }
  if (Array.isArray(entry)) {
    for (const item of entry) flattenArgument(item, out);
    return;
  }
  if (entry && typeof entry === 'object' && rulesAllow(entry.rules)) {
    flattenArgument(entry.value, out);
  }
}

function libraryArtifact(lib) {
  const artifact = lib.downloads?.artifact;
  if (artifact?.path) {
    const base = (lib.url || 'https://libraries.minecraft.net/').replace(/\/?$/, '/');
    return {
      path: artifact.path,
      url: artifact.url || `${base}${artifact.path}`,
      size: artifact.size,
      sha1: artifact.sha1
    };
  }
  if (!lib.name) return null;
  const [coordinate, extension = 'jar'] = lib.name.split('@');
  const parts = coordinate.split(':');
  if (parts.length < 3) return null;
  const [group, artifactId, version, classifier] = parts;
  const relativePath = path.posix.join(
    group.replace(/\./g, '/'),
    artifactId,
    version,
    `${artifactId}-${version}${classifier ? `-${classifier}` : ''}.${extension}`
  );
  const base = (lib.url || 'https://libraries.minecraft.net/').replace(/\/?$/, '/');
  return { path: relativePath, url: `${base}${relativePath}`, size: lib.size, sha1: lib.sha1 };
}

function mergeLoaderMeta(vanillaMeta, loaderMeta) {
  const mergeLibraries = [...(vanillaMeta.libraries || []), ...(loaderMeta.libraries || [])];
  const seen = new Set();
  const libraries = mergeLibraries.filter((library) => {
    const name = library.name || library.downloads?.artifact?.path || JSON.stringify(library);
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  const vanillaGameArgs = vanillaMeta.arguments?.game || vanillaMeta.minecraftArguments?.split(/\s+/) || [];
  const loaderGameArgs = loaderMeta.arguments?.game;
  const gameArgs = loaderGameArgs
    ? [...vanillaGameArgs, ...loaderGameArgs]
    : loaderMeta.minecraftArguments
      ? loaderMeta.minecraftArguments.split(/\s+/)
      : vanillaGameArgs;
  return {
    ...vanillaMeta,
    ...loaderMeta,
    id: vanillaMeta.id,
    downloads: vanillaMeta.downloads,
    assetIndex: vanillaMeta.assetIndex,
    assets: vanillaMeta.assets,
    libraries,
    arguments: {
      game: gameArgs,
      jvm: [
        ...(vanillaMeta.arguments?.jvm || []),
        ...(loaderMeta.arguments?.jvm || [])
      ]
    }
  };
}

function buildSubstitutions(ctx) {
  return {
    auth_player_name: ctx.nickname,
    version_name: ctx.versionId,
    game_directory: ctx.gameDir,
    assets_root: ctx.assetsRoot,
    assets_index_name: ctx.assetIndexId,
    auth_uuid: ctx.uuid,
    auth_access_token: '0',
    auth_session: '0',
    clientid: '',
    auth_xuid: '0',
    user_type: 'legacy',
    version_type: ctx.versionType,
    user_properties: '{}',
    natives_directory: ctx.nativesDir,
    launcher_name: LAUNCHER_NAME,
    launcher_version: app.getVersion(),
    classpath: ctx.classpath,
    classpath_separator: path.delimiter,
    library_directory: ctx.librariesDir,
    resolution_width: '1280',
    resolution_height: '720',
    game_assets: ctx.assetsRoot
  };
}

function substitute(value, table) {
  return String(value).replace(/\$\{([^}]+)\}/g, (match, key) => {
    const replacement = table[key];
    if (replacement === undefined) return match;
    // В путях Windows обратные слэши безопасны, spawn не использует shell.
    return replacement;
  });
}

/* ─────────────────────────── подготовка файлов ─────────────────────────── */

function buildDownloadJobs(root, meta, assetIndex) {
  const jobs = [];
  const librariesDir = path.join(root, 'libraries');
  const versionDir = path.join(root, 'versions', meta.id);
  const natives = [];

  const client = meta.downloads?.client;
  if (client?.url) {
    jobs.push({
      stage: 'Клиент игры',
      url: client.url,
      dest: path.join(versionDir, `${meta.id}.jar`),
      size: client.size,
      sha1: client.sha1,
      verify: true
    });
  }

  for (const lib of meta.libraries || []) {
    if (!rulesAllow(lib.rules)) continue;
    const artifact = libraryArtifact(lib);
    if (artifact?.url && artifact.path) {
      jobs.push({
        stage: 'Библиотеки',
        url: artifact.url,
        dest: path.join(librariesDir, artifact.path),
        size: artifact.size,
        sha1: artifact.sha1
      });
    }
    const nativesKey = lib.natives?.[OS_NAME];
    if (nativesKey) {
      const classifier = lib.downloads?.classifiers?.[nativesKey];
      if (classifier?.url && classifier.path) {
        const job = {
          stage: 'Библиотеки',
          url: classifier.url,
          dest: path.join(librariesDir, classifier.path),
          size: classifier.size,
          sha1: classifier.sha1,
          native: true,
          exclude: lib.extract?.exclude || []
        };
        jobs.push(job);
        natives.push(job);
      }
    }
  }

  if (assetIndex?.data?.objects) {
    for (const object of Object.values(assetIndex.data.objects)) {
      if (!object?.hash) continue;
      const hash = object.hash;
      jobs.push({
        stage: 'Ресурсы игры',
        url: `${RESOURCES_URL}/${hash.slice(0, 2)}/${hash}`,
        dest: path.join(root, 'assets', 'objects', hash.slice(0, 2), hash),
        size: object.size,
        optional: true
      });
    }
  }

  // Один и тот же файл может встречаться в нескольких библиотеках.
  const seen = new Set();
  const unique = jobs.filter((job) => {
    const key = job.dest.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { jobs: unique, natives, librariesDir, versionDir };
}

function extractNatives(nativeJobs, targetDir) {
  for (const job of nativeJobs) {
    let zip;
    try {
      zip = new AdmZip(job.dest);
    } catch {
      continue;
    }
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const name = entry.entryName.replace(/\\/g, '/');
      if (name.startsWith('META-INF/')) continue;
      if ((job.exclude || []).some((prefix) => name.startsWith(prefix.replace(/\./g, '/')))) continue;
      const out = path.join(targetDir, name);
      if (!out.startsWith(targetDir + path.sep)) continue;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, entry.getData());
    }
  }
}

function classpathFromMeta(meta, librariesDir, versionDir, gameDir) {
  const entries = [];
  for (const lib of meta.libraries || []) {
    if (!rulesAllow(lib.rules)) continue;
    const artifact = libraryArtifact(lib);
    if (artifact?.path) {
      const gameLibrary = gameDir ? path.join(gameDir, 'libraries', artifact.path) : '';
      entries.push(gameLibrary && fs.existsSync(gameLibrary) ? gameLibrary : path.join(librariesDir, artifact.path));
    }
  }
  entries.push(path.join(versionDir, `${meta.id}.jar`));
  return entries.join(path.delimiter);
}

async function copyVirtualAssets(root, index, signal) {
  const objectsDir = path.join(root, 'assets', 'objects');
  const virtualDir = path.join(root, 'assets', 'virtual', index.id);
  for (const [name, object] of Object.entries(index.data.objects || {})) {
    if (signal?.aborted) return;
    const src = path.join(objectsDir, object.hash.slice(0, 2), object.hash);
    const dest = path.join(virtualDir, name);
    try {
      await fsp.access(dest);
    } catch {
      await ensureDir(path.dirname(dest));
      await fsp.copyFile(src, dest).catch(() => {});
    }
  }
  return virtualDir;
}

/* ─────────────────────────── запуск ─────────────────────────── */

async function launchGame({ root, gameDir, settings, versionId, signal, onStatus, onLog }) {
  const status = (payload) => onStatus?.({ phase: 'downloading', percent: 0, ...payload });
  const log = (line, stream = 'out') => onLog?.({ stream, line });

  status({ phase: 'preparing', message: 'Читаем манифест версий', detail: '' });

  const manifest = await getManifest(root, { signal });
  const entry = manifest.versions.find((item) => item.id === versionId);
  if (!entry) throw new Error(`Версия ${versionId} не найдена в манифесте Mojang.`);

  status({ message: 'Загружаем описание версии', detail: versionId });
  let meta = await getVersionMeta(root, entry, signal);

  if (settings.loader === 'fabric' && settings.loaderVersion) {
    const loaderMeta = await loadFabricProfile(root, versionId, settings.loaderVersion);
    if (!loaderMeta) throw new Error('Профиль Fabric не найден. Установите загрузчик заново.');
    meta = mergeLoaderMeta(meta, loaderMeta);
  } else if (settings.loader === 'forge' && settings.loaderVersion) {
    const loaderMeta = await loadForgeProfile(gameDir, versionId, settings.loaderVersion);
    if (!loaderMeta) throw new Error('Профиль Forge не найден. Установите загрузчик заново.');
    meta = mergeLoaderMeta(meta, loaderMeta);
  } else if (settings.loader === 'quilt' && settings.loaderVersion) {
    const loaderMeta = await loadQuiltProfile(root, versionId, settings.loaderVersion);
    if (!loaderMeta) throw new Error('Профиль Quilt не найден. Установите загрузчик заново.');
    meta = mergeLoaderMeta(meta, loaderMeta);
  } else if (settings.loader === 'neoforge' && settings.loaderVersion) {
    const loaderMeta = await loadNeoForgeProfile(gameDir, versionId, settings.loaderVersion);
    if (!loaderMeta) throw new Error('Профиль NeoForge не найден. Установите загрузчик заново.');
    meta = mergeLoaderMeta(meta, loaderMeta);
  }

  const requiredJava = meta.javaVersion?.majorVersion || 8;
  status({ message: `Ищем Java ${requiredJava}`, detail: '' });
  const java = findJava({ customPath: settings.javaPath, requiredMajor: requiredJava });
  if (!java) {
    const err = new Error(`Java ${requiredJava} не найдена на этом компьютере.`);
    err.hint = 'Установите Java с adoptium.net или укажите путь к java.exe в настройках лаунчера.';
    throw err;
  }

  log(`Java: ${java.version} (${java.path})`);
  if (java.major !== requiredJava) {
    log(`Внимание: версии ${versionId} нужна Java ${requiredJava}, найдена Java ${java.major}.`, 'warn');
  }

  const assetIndex = await getAssetIndex(root, meta, signal);
  status({ message: 'Проверяем целостность файлов', detail: '' });

  const { jobs, natives, librariesDir, versionDir } = buildDownloadJobs(root, meta, assetIndex);
  const nativesDir = path.join(versionDir, 'natives');
  for (const dir of ['', 'java', 'jna', 'lwjgl', 'netty']) {
    fs.mkdirSync(path.join(nativesDir, dir), { recursive: true });
  }

  const total = jobs.length;
  let done = 0;
  let failedOptional = 0;
  let lastEmit = 0;
  let stage = 'Клиент игры';

  const emitProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 120) return;
    lastEmit = now;
    const percent = Math.min(99, Math.round((done / Math.max(total, 1)) * 100));
    status({
      phase: 'downloading',
      message: `Скачиваем: ${stage}`,
      detail: `${done} из ${total} файлов`,
      percent
    });
  };

  // Сначала маленькие библиотеки, потом клиент, затем ресурсы — так прогресс ровнее.
  jobs.sort((a, b) => stageWeight(a.stage) - stageWeight(b.stage));

  status({ phase: 'downloading', message: 'Проверяем файлы игры', detail: `0 из ${total}`, percent: 0 });

  await pool(
    jobs,
    ASSET_CONCURRENCY,
    async (job) => {
      stage = job.stage;
      try {
        await ensureFile(job, signal);
      } catch (err) {
        if (!job.optional) throw err;
        failedOptional++;
        log(`Не удалось скачать ресурс: ${path.basename(job.dest)} — ${err.message}`, 'warn');
      }
      done++;
      emitProgress(done === total);
    },
    signal
  );

  if (failedOptional > 0) {
    log(`Пропущено ресурсов: ${failedOptional}. Игра запустится, но возможны проблемы со звуком и текстурами.`, 'warn');
  }

  if (natives.length) {
    status({ message: 'Распаковываем нативные библиотеки', detail: '', percent: 99 });
    extractNatives(natives, nativesDir);
  }

  let assetsRoot = path.join(root, 'assets');
  let assetIndexId = meta.assetIndex?.id || meta.assets || 'legacy';
  if (assetIndex?.data?.virtual) {
    assetsRoot = await copyVirtualAssets(root, assetIndex, signal);
  } else if (assetIndex?.data?.map_to_resources) {
    // Совсем старые версии ждут resources прямо в папке игры.
    await copyVirtualAssets(root, assetIndex, signal);
    assetsRoot = path.join(gameDir, 'resources');
    await fsp.cp(path.join(root, 'assets', 'virtual', assetIndex.id), assetsRoot, { recursive: true }).catch(() => {});
  }

  await ensureDir(gameDir);

  const classpath = classpathFromMeta(meta, librariesDir, versionDir, gameDir);
  const runtimeLibrariesDir = settings.loader === 'forge' || settings.loader === 'neoforge'
    ? path.join(gameDir, 'libraries')
    : librariesDir;
  const activeAuth = settings.auth || {};
  const activeNickname = activeAuth.nickname || settings.nickname || 'Steve';
  const substitutions = buildSubstitutions({
    nickname: activeNickname,
    versionId: meta.id,
    gameDir,
    assetsRoot,
    assetIndexId,
    uuid: offlineUuid(activeNickname).replace(/-/g, ''),
    versionType: meta.type || 'release',
    nativesDir,
    classpath,
    librariesDir: runtimeLibrariesDir
  });

  const memory = Math.max(1024, Number(settings.memory) || 2048);
  const jvmArgs = [];
  jvmArgs.push(
    `-Xms${Math.min(1024, memory)}M`,
    `-Xmx${memory}M`,
    '-Dfile.encoding=UTF-8',
    '-XX:+UseG1GC',
    '-XX:MaxGCPauseMillis=100'
  );

  if (meta.arguments?.jvm?.length) {
    const raw = [];
    for (const entryArg of meta.arguments.jvm) {
      if (entryArg && typeof entryArg === 'object' && !rulesAllow(entryArg.rules)) continue;
      flattenArgument(entryArg, raw);
    }
    for (const value of raw) jvmArgs.push(substitute(value, substitutions));
  } else {
    jvmArgs.push(`-Djava.library.path=${nativesDir}`, '-cp', classpath);
  }

  const gameArgs = [];
  if (meta.arguments?.game) {
    const raw = [];
    for (const entryArg of meta.arguments.game) {
      if (entryArg && typeof entryArg === 'object' && !rulesAllow(entryArg.rules)) continue;
      flattenArgument(entryArg, raw);
    }
    for (const value of raw) gameArgs.push(substitute(value, substitutions));
  } else if (meta.minecraftArguments) {
    for (const value of meta.minecraftArguments.split(/\s+/)) {
      gameArgs.push(substitute(value, substitutions));
    }
  }

  if (!meta.mainClass) throw new Error('В описании версии отсутствует mainClass — версия повреждена.');

  const args = [...jvmArgs, meta.mainClass, ...gameArgs];
  const env = { ...process.env };
  delete env._JAVA_OPTIONS;
  delete env.JAVA_TOOL_OPTIONS;

  status({ phase: 'launching', message: 'Запускаем Minecraft', detail: `Java ${java.major}`, percent: 100 });
  log(`Запуск ${meta.id} · ${memory} МБ памяти`);

  const child = spawn(java.path, args, {
    cwd: gameDir,
    env,
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (err) => {
      const error = new Error(`Не удалось запустить Java: ${err.message}`);
      error.hint = 'Проверьте путь к Java в настройках лаунчера.';
      reject(error);
    });
  });

  pipeLines(child.stdout, (line) => log(line, 'out'));
  pipeLines(child.stderr, (line) => log(line, 'error'));

  return { child, meta, java };
}

async function stageVanillaClientForLoader({ root, gameDir, versionId, signal }) {
  const manifest = await getManifest(root, { signal });
  const entry = manifest.versions.find((item) => item.id === versionId);
  if (!entry) throw new Error(`Версия ${versionId} не найдена в манифесте Mojang.`);
  const meta = await getVersionMeta(root, entry, signal);
  const client = meta.downloads?.client;
  if (!client?.url || !client.sha1) {
    throw new Error(`В манифесте Minecraft ${versionId} отсутствует проверяемый клиентский JAR.`);
  }

  const destination = path.join(gameDir, 'versions', versionId, `${versionId}.jar`);
  const downloaded = await ensureFile({
    stage: 'Клиент игры',
    url: client.url,
    dest: destination,
    size: client.size,
    sha1: client.sha1,
    verify: true
  }, signal);
  return { destination, downloaded };
}

function stageWeight(stage) {
  if (stage === 'Библиотеки') return 0;
  if (stage === 'Клиент игры') return 1;
  return 2;
}

function pipeLines(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) if (line.trim()) onLine(line.slice(0, 4000));
  });
  stream.on('end', () => {
    if (buffer.trim()) onLine(buffer.slice(0, 4000));
  });
}

async function listVersions(root, { force = false } = {}) {
  const manifest = await getManifest(root, { force });
  let installed = new Set();
  try {
    const entries = await fsp.readdir(path.join(root, 'versions'), { withFileTypes: true });
    installed = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  } catch {
    installed = new Set();
  }
  return {
    latest: manifest.latest,
    versions: (manifest.versions || []).map(({ id, type, releaseTime, url }) => ({
      id,
      type,
      releaseTime,
      url,
      installed: installed.has(id)
    }))
  };
}

module.exports = {
  launchGame,
  listVersions,
  getManifest,
  stageVanillaClientForLoader,
  OS_NAME
};

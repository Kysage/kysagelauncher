'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const { net } = require('electron');

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const QUILT_META = 'https://meta.quiltmc.org/v3';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
const VERSION_CACHE_TTL = 30 * 60 * 1000;
const TLS_FALLBACK_ARGS = [
  '-Dhttps.protocols=TLSv1.2',
  '-Djdk.tls.client.protocols=TLSv1.2',
  '-Djdk.tls.namedGroups=secp256r1,secp384r1'
];

function isTransientNetworkFailure(output) {
  return /SocketTimeoutException|ConnectException|UnknownHostException|NoRouteToHostException|Connection reset|Read timed out|connect timed out|timed out|ERR_TIMED_OUT|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i
    .test(String(output || ''));
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Установка отменена.'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Установка отменена.'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchWithNetworkRetry(url, options = {}) {
  const { signal } = options;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await net.fetch(url, options);
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error;
      if (!isTransientNetworkFailure(error.message) || attempt === 2) {
        if (isTransientNetworkFailure(error.message)) {
          throw new Error(`Не удалось подключиться к серверу загрузчика после 3 попыток: ${error.message}`);
        }
        throw error;
      }
      await wait(500 * (2 ** attempt), signal);
    }
  }
  throw new Error('Не удалось подключиться к серверу загрузчика.');
}

async function ensureLauncherProfile(gameDir) {
  await fsp.mkdir(gameDir, { recursive: true });
  const profilePath = path.join(gameDir, 'launcher_profiles.json');
  let data;
  let shouldWrite = false;
  try {
    data = JSON.parse(await fsp.readFile(profilePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`Не удалось прочитать ${profilePath}: ${error.message}`);
    }
    data = { profiles: {} };
    shouldWrite = true;
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Некорректный файл профилей Minecraft: ${profilePath}`);
  }
  if (data.profiles === undefined) {
    data.profiles = {};
    shouldWrite = true;
  } else if (!data.profiles || typeof data.profiles !== 'object' || Array.isArray(data.profiles)) {
    throw new Error(`В файле профилей Minecraft отсутствует корректный объект profiles: ${profilePath}`);
  }

  if (shouldWrite) {
    const temporary = `${profilePath}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(temporary, JSON.stringify(data, null, 2), { flag: 'wx' });
      await fsp.rename(temporary, profilePath);
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
  return profilePath;
}

async function fetchJson(url, signal) {
  const res = await fetchWithNetworkRetry(url, { signal, headers: { 'User-Agent': 'obsidian-launcher' } });
  if (!res.ok) throw new Error(`Сервер загрузчика вернул HTTP ${res.status}`);
  return res.json();
}

async function installNeoForge({ root, gameDir, gameVersion, neoForgeVersion, javaPath, signal }) {
  const installerName = `neoforge-${neoForgeVersion}-installer.jar`;
  const installerDir = path.join(root, 'loaders', 'neoforge', gameVersion);
  await fsp.mkdir(installerDir, { recursive: true });
  const installer = path.join(installerDir, installerName);
  if (!fs.existsSync(installer)) {
    await downloadInstaller(`${NEOFORGE_MAVEN}/${neoForgeVersion}/${installerName}`, installer, signal);
  }
  await fsp.mkdir(gameDir, { recursive: true });
  await ensureLauncherProfile(gameDir);
  const profileOptions = {
    gameVersion,
    loader: 'neoforge',
    loaderVersion: neoForgeVersion,
    expectedIds: [`${gameVersion}-neoforge-${neoForgeVersion}`, `neoforge-${neoForgeVersion}`]
  };
  const output = await runInstallerWithTlsFallback(
    javaPath,
    ['-jar', installer, '--installClient', gameDir],
    root,
    signal,
    async () => Boolean(await findInstalledProfile(gameDir, profileOptions))
  );
  const profile = await findInstalledProfile(gameDir, profileOptions);
  if (profile) return profile;
  throw profileNotFoundError('NeoForge', gameDir, output);
}

async function downloadInstaller(url, installer, signal) {
  const res = await fetchWithNetworkRetry(url, { signal, headers: { 'User-Agent': 'OBSIDIAN-Launcher' } });
  if (!res.ok) throw new Error(`Не удалось скачать установщик загрузчика: HTTP ${res.status}`);
  if (!res.body) throw new Error('Сервер загрузчика вернул пустой установщик.');
  const temporary = `${installer}.part`;
  const handle = await fsp.open(temporary, 'w');
  try {
    for await (const chunk of res.body) {
      if (signal?.aborted) throw Object.assign(new Error('Установка отменена.'), { name: 'AbortError' });
      await handle.write(chunk);
    }
    await handle.close();
    await fsp.rm(installer, { force: true });
    await fsp.rename(temporary, installer);
  } catch (error) {
    await handle.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function listFabricLoaders(gameVersion, signal) {
  return listProfileVersions(FABRIC_META, gameVersion, signal);
}

async function listQuiltLoaders(gameVersion, signal) {
  return listProfileVersions(QUILT_META, gameVersion, signal);
}

async function listProfileVersions(baseUrl, gameVersion, signal) {
  const data = await fetchJson(`${baseUrl}/versions/loader/${encodeURIComponent(gameVersion)}`, signal);
  return (Array.isArray(data) ? data : [])
    .map((item) => item.loader?.version)
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

async function installFabric(root, gameVersion, loaderVersion, signal) {
  return installProfile(root, 'fabric', FABRIC_META, gameVersion, loaderVersion, signal);
}

async function installQuilt(root, gameVersion, loaderVersion, signal) {
  return installProfile(root, 'quilt', QUILT_META, gameVersion, loaderVersion, signal);
}

async function installProfile(root, loader, baseUrl, gameVersion, loaderVersion, signal) {
  const profile = await fetchJson(
    `${baseUrl}/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`,
    signal
  );
  const dir = path.join(root, 'loaders', loader, gameVersion);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${loaderVersion}.json`);
  await fsp.writeFile(file, JSON.stringify(profile, null, 2), 'utf8');
  return { profile, file, loaderVersion };
}

async function loadFabricProfile(root, gameVersion, loaderVersion) {
  return loadProfile(root, 'fabric', gameVersion, loaderVersion);
}

async function loadQuiltProfile(root, gameVersion, loaderVersion) {
  return loadProfile(root, 'quilt', gameVersion, loaderVersion);
}

async function loadProfile(root, loader, gameVersion, loaderVersion) {
  const file = path.join(root, 'loaders', loader, gameVersion, `${loaderVersion}.json`);
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function listForgeVersions(gameVersion, signal) {
  return listMavenVersions(FORGE_MAVEN, `${gameVersion}-`, signal);
}

async function listNeoForgeVersions(gameVersion, signal) {
  const parts = gameVersion.split('.');
  const prefix = gameVersion === '1.20.1'
    ? '47.1.'
    : parts[0] === '1' && parts.length >= 2
    ? `${parts[1]}.${parts[2] || '0'}.`
    : `${gameVersion}.`;
  const versions = await listMavenVersions(NEOFORGE_MAVEN, prefix, signal);
  return versions.map((version) => `${prefix}${version}`);
}

async function listMavenVersions(baseUrl, prefix, signal) {
  const res = await fetchWithNetworkRetry(`${baseUrl}/maven-metadata.xml`, {
    signal,
    headers: { Accept: 'application/xml', 'User-Agent': 'obsidian-launcher' }
  });
  if (!res.ok) throw new Error(`Сервер загрузчика вернул HTTP ${res.status}`);
  const xml = await res.text();
  const versions = [];
  for (const match of xml.matchAll(/<version>([^<]+)<\/version>/g)) {
    const value = match[1].trim();
    if (value.startsWith(prefix)) versions.push(value.slice(prefix.length));
  }
  return [...new Set(versions)].reverse();
}

async function installForge({ root, gameDir, gameVersion, forgeVersion, javaPath, signal }) {
  const coordinate = `${gameVersion}-${forgeVersion}`;
  const installerName = `forge-${coordinate}-installer.jar`;
  const installerDir = path.join(root, 'loaders', 'forge', gameVersion);
  await fsp.mkdir(installerDir, { recursive: true });
  const installer = path.join(installerDir, installerName);

  if (!fs.existsSync(installer)) {
    const url = `${FORGE_MAVEN}/${coordinate}/${installerName}`;
    await downloadInstaller(url, installer, signal);
  }

  await fsp.mkdir(gameDir, { recursive: true });
  await ensureLauncherProfile(gameDir);
  const profileOptions = {
    gameVersion,
    loader: 'forge',
    loaderVersion: forgeVersion,
    expectedIds: [
      `${gameVersion}-forge-${forgeVersion}`,
      `${gameVersion}-forge`,
      `forge-${forgeVersion}`
    ]
  };
  const output = await runInstallerWithTlsFallback(
    javaPath,
    ['-jar', installer, '--installClient', gameDir],
    root,
    signal,
    async () => Boolean(await findInstalledProfile(gameDir, profileOptions))
  );
  const profile = await findInstalledProfile(gameDir, profileOptions);
  if (profile) return profile;
  throw profileNotFoundError('Forge', gameDir, output);
}

async function findInstalledProfile(gameDir, { gameVersion, loader, loaderVersion, expectedIds = [] }) {
  const versionsDir = path.join(gameDir, 'versions');
  let directories;
  try {
    directories = await fsp.readdir(versionsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  const expected = new Set(expectedIds.map((id) => id.toLowerCase()));
  const loaderPattern = loader === 'neoforge' ? /neoforge/i : /forge/i;
  let matchingProfile = null;
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const profileDir = path.join(versionsDir, directory.name);
    const entries = await fsp.readdir(profileDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
      const file = path.join(profileDir, entry.name);
      let profile;
      try {
        profile = JSON.parse(await fsp.readFile(file, 'utf8'));
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }

      const id = String(profile.id || path.basename(entry.name, '.json'));
      const libraryNames = (profile.libraries || []).map((library) => String(library.name || ''));
      const loaderLibrary = libraryNames.some((name) =>
        loader === 'neoforge' ? /net\.neoforged:/i.test(name) : /net\.minecraftforge:/i.test(name)
      );
      if (expected.has(id.toLowerCase())) {
        return { profile, file, profileId: id };
      }
      const versionMatches = !loaderVersion ||
        id.includes(loaderVersion) ||
        libraryNames.some((name) => name.includes(loaderVersion));
      if (
        !matchingProfile &&
        profile.inheritsFrom === gameVersion &&
        (loaderPattern.test(id) || loaderLibrary) &&
        versionMatches
      ) {
        matchingProfile = { profile, file, profileId: id };
      }
    }
  }
  return matchingProfile;
}

function profileNotFoundError(loader, gameDir, output = {}) {
  const details = [output.stdout, output.stderr].filter(Boolean).join('\n').trim().slice(-1200);
  const hasTlsFailure = isTlsHandshakeFailure(details);
  const hasNetworkFailure = isTransientNetworkFailure(details);
  const message = hasTlsFailure
    ? `${loader} не удалось установить: Java не подключилась к серверам загрузчика даже после повтора с TLS 1.2. ` +
      'Проверьте системную дату, VPN/прокси и проверку HTTPS антивирусом; не отключайте проверку сертификатов. '
    : hasNetworkFailure
      ? `${loader} не удалось установить из-за сетевого таймаута, повторная попытка тоже не помогла. ` +
        'Проверьте подключение, VPN/прокси и доступность серверов Forge/Mojang. '
      : `${loader} установщик завершился, но файл профиля не найден. `;
  const fullMessage = `${message}Профиль не найден в ${path.join(gameDir, 'versions')}.`;
  return new Error(details ? `${fullMessage}\n${details}` : fullMessage);
}

function isTlsHandshakeFailure(output) {
  return /handshake[_ ]failure|no sufficient ECDHE key agreement parameters negotiated|SSLHandshakeException/i
    .test(String(output || ''));
}

async function runInstallerWithTlsFallback(
  javaPath,
  args,
  cwd,
  signal,
  isComplete = async () => false,
  run = runInstaller
) {
  let firstOutput;
  try {
    firstOutput = await run(javaPath, args, cwd, signal);
  } catch (error) {
    if (signal?.aborted ||
        (!isTlsHandshakeFailure(error.message) && !isTransientNetworkFailure(error.message))) {
      throw error;
    }
    firstOutput = { stdout: '', stderr: error.message };
  }

  if (await isComplete()) return firstOutput;
  const firstDetails = `${firstOutput.stdout}\n${firstOutput.stderr}`;
  const tlsFailure = isTlsHandshakeFailure(firstDetails);
  const networkFailure = isTransientNetworkFailure(firstDetails);
  if (!tlsFailure && !networkFailure) return firstOutput;

  try {
    const retryArgs = tlsFailure ? [...TLS_FALLBACK_ARGS, ...args] : args;
    const retryOutput = await run(javaPath, retryArgs, cwd, signal);
    return {
      stdout: retryOutput.stdout,
      stderr: [
        firstDetails.slice(-500),
        tlsFailure
          ? 'Installation retried with TLS 1.2 and standard ECDHE groups.'
          : 'Installation retried after a network failure.',
        String(retryOutput.stdout || '').slice(-500),
        String(retryOutput.stderr || '').slice(-500)
      ].filter(Boolean).join('\n')
    };
  } catch (error) {
    if (signal?.aborted || error.name === 'AbortError') throw error;
    throw new Error(
      `Установщик загрузчика не прошёл повторный запуск после сетевого/TLS-сбоя.\n` +
      `${firstDetails.slice(-500)}\n${error.message}`
    );
  }
}

function runInstaller(javaPath, args, cwd, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Установка отменена.'), { name: 'AbortError' }));
      return;
    }
    const child = spawn(javaPath, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    let stdout = '';
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 10 * 60 * 1000);
    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-8000);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8000);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Не удалось запустить установщик загрузчика: ${error.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (aborted) {
        reject(Object.assign(new Error('Установка отменена.'), { name: 'AbortError' }));
      } else if (timedOut) {
        reject(new Error('Установка загрузчика превысила лимит в 10 минут'));
      } else if (code !== 0) {
        const output = [stdout, stderr].filter(Boolean).join('\n').slice(-4000);
        reject(new Error(`Установщик загрузчика завершился с кодом ${code}${output ? `: ${output}` : ''}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function loadNeoForgeProfile(gameDir, gameVersion, neoForgeVersion) {
  const result = await findInstalledProfile(gameDir, {
    gameVersion,
    loader: 'neoforge',
    loaderVersion: neoForgeVersion,
    expectedIds: [`${gameVersion}-neoforge-${neoForgeVersion}`, `neoforge-${neoForgeVersion}`]
  });
  return result?.profile || null;
}

async function listLoaderVersions(loader, gameVersion, root, signal) {
  const cacheFile = path.join(root, 'loaders', 'metadata', `${loader}-${gameVersion}.json`);
  let cached = null;
  try {
    cached = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
    if (!cached || !Array.isArray(cached.versions)) cached = null;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }

  if (cached?.versions?.length && Date.now() - cached.fetchedAt < VERSION_CACHE_TTL) {
    return { versions: cached.versions, stale: false };
  }

  let versions;
  try {
    if (loader === 'fabric') versions = await listFabricLoaders(gameVersion, signal);
    else if (loader === 'forge') versions = await listForgeVersions(gameVersion, signal);
    else if (loader === 'quilt') versions = await listQuiltLoaders(gameVersion, signal);
    else if (loader === 'neoforge') versions = await listNeoForgeVersions(gameVersion, signal);
    else versions = [];
    if (versions.length === 0) throw new Error(`Для Minecraft ${gameVersion} не найдены версии ${loader}.`);
  } catch (error) {
    if (cached?.versions?.length) return { versions: cached.versions, stale: true };
    const label = loader[0].toUpperCase() + loader.slice(1);
    throw new Error(
      `Не удалось получить версии ${label}. Проверьте подключение, системную прокси/VPN или фильтрацию TLS. ${error.message}`
    );
  }

  try {
    await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
    await fsp.writeFile(cacheFile, JSON.stringify({ fetchedAt: Date.now(), versions }), 'utf8');
  } catch (error) {
    console.error(`Не удалось сохранить кэш версий ${loader}:`, error.message);
  }
  return { versions, stale: false };
}

async function loadForgeProfile(gameDir, gameVersion, forgeVersion) {
  const result = await findInstalledProfile(gameDir, {
    gameVersion,
    loader: 'forge',
    loaderVersion: forgeVersion,
    expectedIds: [
      `${gameVersion}-forge-${forgeVersion}`,
      `${gameVersion}-forge`,
      `forge-${forgeVersion}`
    ]
  });
  return result?.profile || null;
}

module.exports = {
  listLoaderVersions,
  installFabric,
  loadFabricProfile,
  installQuilt,
  loadQuiltProfile,
  installForge,
  loadForgeProfile,
  installNeoForge,
  loadNeoForgeProfile,
  findInstalledProfile,
  runInstallerWithTlsFallback,
  isTlsHandshakeFailure,
  ensureLauncherProfile
};

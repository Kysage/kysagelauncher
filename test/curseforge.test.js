'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const electronPath = require.resolve('electron');
let appDataPath = '';
const electronMock = {
  app: { getPath: () => appDataPath, getVersion: () => '1.0.0' },
  net: { fetch: async () => { throw new Error('Unexpected network request'); } }
};
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: electronMock
};
const { CurseForgeService } = require('../src/main/curseforge');
const { DownloadManager } = require('../src/main/download-manager');
const { installModpack, installSelectedFile, installModrinthVersion, inspectManualDownloads, importManualDownloads, loaderFromManifest, extractOverrides } = require('../src/main/mods');
const {
  listLoaderVersions,
  findInstalledProfile,
  loadForgeProfile,
  runInstallerWithTlsFallback,
  isTlsHandshakeFailure,
  ensureLauncherProfile
} = require('../src/main/loaders');
const { requiredJavaMajorForMinecraft } = require('../src/main/java');
const { stageVanillaClientForLoader } = require('../src/main/minecraft');
const { Store } = require('../src/main/store');
const { ModrinthService } = require('../src/main/modrinth');
const { inspectSkinPng, skinDataUrl } = require('../src/main/skins');
const {
  applyOfflineSkinPack,
  removeOfflineSkinPack,
  packMetadata,
  PACK_DIRECTORY,
  PACK_ID
} = require('../src/main/offline-skin-pack');

test('Java runtime requirements follow the Minecraft version', () => {
  assert.equal(requiredJavaMajorForMinecraft('1.20.1'), 17);
  assert.equal(requiredJavaMajorForMinecraft('1.20.6'), 21);
  assert.equal(requiredJavaMajorForMinecraft('1.21.1'), 21);
  assert.equal(requiredJavaMajorForMinecraft('26.3'), 25);
  assert.equal(requiredJavaMajorForMinecraft('unknown'), 21);
});

test('Forge installer retries TLS handshake failures without disabling certificate checks', async () => {
  const calls = [];
  const output = await runInstallerWithTlsFallback(
    'java',
    ['-jar', 'forge-installer.jar', '--installClient', 'game'],
    'root',
    undefined,
    async () => false,
    async (...args) => {
      calls.push(args);
      if (calls.length === 1) {
        throw new Error('SSLHandshakeException: handshake_failure');
      }
      return { stdout: 'Installation complete', stderr: '' };
    }
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][1].slice(0, 3), [
    '-Dhttps.protocols=TLSv1.2',
    '-Djdk.tls.client.protocols=TLSv1.2',
    '-Djdk.tls.namedGroups=secp256r1,secp384r1'
  ]);
  assert.equal(calls[1][1].includes('-Dcom.sun.net.ssl.checkRevocation=false'), false);
  assert.match(output.stderr, /retried with TLS 1\.2/i);
  assert.equal(isTlsHandshakeFailure('No sufficient ECDHE key agreement parameters negotiated'), true);
});

test('isolated Forge installs create a minimal launcher profile and preserve existing settings', async (t) => {
  const gameDir = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-forge-profile-test-'));
  t.after(() => fs.rm(gameDir, { recursive: true, force: true }));
  const profilePath = await ensureLauncherProfile(gameDir);
  assert.deepEqual(JSON.parse(await fs.readFile(profilePath, 'utf8')), { profiles: {} });

  await fs.writeFile(profilePath, JSON.stringify({
    selectedProfile: 'custom',
    profiles: { custom: { name: 'Custom', lastVersionId: '1.20.1' } }
  }));
  await ensureLauncherProfile(gameDir);
  assert.deepEqual(JSON.parse(await fs.readFile(profilePath, 'utf8')), {
    selectedProfile: 'custom',
    profiles: { custom: { name: 'Custom', lastVersionId: '1.20.1' } }
  });
});

test('Forge installer retries network timeouts once without TLS overrides', async () => {
  const calls = [];
  await runInstallerWithTlsFallback(
    'java',
    ['-jar', 'forge-installer.jar', '--installClient', 'game'],
    'root',
    undefined,
    async () => false,
    async (...args) => {
      calls.push(args);
      if (calls.length === 1) throw new Error('java.net.SocketTimeoutException: connect timed out');
      return { stdout: 'Installation complete', stderr: '' };
    }
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][1], ['-jar', 'forge-installer.jar', '--installClient', 'game']);
});

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

function skinPng(width = 64, height = 64) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', Buffer.from([0])),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

test('Modrinth search filters by game version and loader without an API key', async () => {
  let requestUrl;
  let requestOptions;
  electronMock.net.fetch = async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return Response.json({ hits: [{ project_id: 'sodium' }], total_hits: 1 });
  };
  const service = new ModrinthService();

  const result = await service.search({
    query: 'Sodium',
    projectType: 'mod',
    gameVersion: '1.20.1',
    loader: 'fabric',
    offset: 24,
    limit: 24
  });
  const url = new URL(requestUrl);
  const facets = JSON.parse(url.searchParams.get('facets'));

  assert.equal(url.origin, 'https://api.modrinth.com');
  assert.equal(url.pathname, '/v2/search');
  assert.equal(url.searchParams.get('query'), 'Sodium');
  assert.equal(url.searchParams.get('offset'), '24');
  assert.ok(facets.flat().includes('versions:1.20.1'));
  assert.ok(facets.flat().includes('categories:fabric'));
  assert.equal(requestOptions.headers['User-Agent'], 'OBSIDIAN-Launcher/1.0.0');
  assert.equal(requestOptions.headers['x-api-key'], undefined);
  assert.equal(result.hits[0].project_id, 'sodium');
});

test('Forge setup stages the verified vanilla client in the isolated game directory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-forge-stage-root-'));
  const gameDir = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-forge-stage-game-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(gameDir, { recursive: true, force: true })
  ]));
  const client = Buffer.from('vanilla client jar');
  const sha1 = crypto.createHash('sha1').update(client).digest('hex');
  electronMock.net.fetch = async (url) => {
    if (url.endsWith('version_manifest_v2.json')) {
      return Response.json({
        versions: [{ id: '1.20.1', url: 'https://meta.example/1.20.1.json' }]
      });
    }
    if (url === 'https://meta.example/1.20.1.json') {
      return Response.json({
        id: '1.20.1',
        downloads: { client: { url: 'https://client.example/1.20.1.jar', sha1, size: client.length } }
      });
    }
    if (url === 'https://client.example/1.20.1.jar') return new Response(client);
    throw new Error(`Unexpected request: ${url}`);
  };

  const result = await stageVanillaClientForLoader({
    root,
    gameDir,
    versionId: '1.20.1'
  });

  assert.equal(result.downloaded, true);
  assert.deepEqual(await fs.readFile(result.destination), client);
});

test('Modrinth install verifies SHA-512 and downloads required dependencies without a key', async (t) => {
  const gameDir = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-modrinth-install-test-'));
  t.after(() => fs.rm(gameDir, { recursive: true, force: true }));
  const contents = new Map([
    ['sodium.jar', Buffer.from('sodium contents')],
    ['dependency.jar', Buffer.from('dependency contents')]
  ]);
  const createFile = (name) => {
    const data = contents.get(name);
    return {
      filename: name,
      url: `https://cdn.modrinth.com/data/test/${name}`,
      size: data.length,
      primary: true,
      hashes: { sha512: crypto.createHash('sha512').update(data).digest('hex') }
    };
  };
  const versions = {
    selected: {
      id: 'selected',
      project_id: 'sodium',
      name: 'Sodium',
      game_versions: ['1.20.1'],
      loaders: ['fabric'],
      dependencies: [{ project_id: 'dependency', version_id: 'required', dependency_type: 'required' }],
      files: [createFile('sodium.jar')]
    },
    required: {
      id: 'required',
      project_id: 'dependency',
      name: 'Required dependency',
      game_versions: ['1.20.1'],
      loaders: ['fabric'],
      files: [createFile('dependency.jar')]
    }
  };
  const requests = [];
  electronMock.net.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(contents.get(path.basename(new URL(url).pathname)));
  };
  const service = {
    getVersion: async (id) => versions[id],
    listVersions: async () => []
  };

  const result = await installModrinthVersion({
    service,
    gameDir,
    versionId: 'selected',
    gameVersion: '1.20.1',
    loader: 'fabric'
  });

  assert.equal(result.installed, 2);
  assert.equal(result.mods.length, 2);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ options }) => options.headers['x-api-key'] === undefined));
  assert.deepEqual(await fs.readFile(path.join(gameDir, 'mods', 'sodium.jar')), contents.get('sodium.jar'));
});

test('CurseForge search sends filters and required headers', async () => {
  let request;
  const service = new CurseForgeService('test-key', {
    fetch: async (url, options) => {
      request = { url: new URL(url), options };
      return Response.json({ data: [{ id: 21 }], pagination: { index: 0, pageSize: 24, totalCount: 1 } });
    }
  });

  const result = await service.search({
    query: 'Sodium',
    classId: 6,
    gameVersion: '1.20.1',
    modLoaderType: 4,
    sortField: 6,
    sortOrder: 'asc',
    index: 24,
    pageSize: 24
  });

  assert.equal(request.url.pathname, '/v1/mods/search');
  assert.equal(request.url.searchParams.get('gameId'), '432');
  assert.equal(request.url.searchParams.get('searchFilter'), 'Sodium');
  assert.equal(request.url.searchParams.get('classId'), '6');
  assert.equal(request.url.searchParams.get('gameVersion'), '1.20.1');
  assert.equal(request.url.searchParams.get('modLoaderType'), '4');
  assert.equal(request.url.searchParams.get('sortField'), '6');
  assert.equal(request.url.searchParams.get('sortOrder'), 'asc');
  assert.equal(request.url.searchParams.get('index'), '24');
  assert.equal(request.options.headers['x-api-key'], 'test-key');
  assert.equal(request.options.headers.Accept, 'application/json');
  assert.deepEqual(result.data, [{ id: 21 }]);
  assert.equal(result.pagination.totalCount, 1);
});

test('CurseForge retries transient network timeouts', async () => {
  let requests = 0;
  const service = new CurseForgeService('test-key', {
    fetch: async () => {
      requests += 1;
      if (requests === 1) throw Object.assign(new Error('net::ERR_TIMED_OUT'), { code: 'ERR_TIMED_OUT' });
      return Response.json({ data: [{ id: 21 }] });
    }
  });

  const result = await service.search({ query: 'Sodium' });

  assert.equal(requests, 2);
  assert.deepEqual(result.data, [{ id: 21 }]);
});

test('CurseForge file listing filters by game version and loader', async () => {
  let request;
  const service = new CurseForgeService('test-key', {
    fetch: async (url, options) => {
      request = { url: new URL(url), options };
      return Response.json({ data: [{ id: 21, displayName: '1.20.1 Fabric' }] });
    }
  });

  const result = await service.listFiles(12, {
    gameVersion: '1.20.1',
    modLoaderType: 4,
    pageSize: 50
  });

  assert.equal(request.url.pathname, '/v1/mods/12/files');
  assert.equal(request.url.searchParams.get('gameVersion'), '1.20.1');
  assert.equal(request.url.searchParams.get('modLoaderType'), '4');
  assert.equal(request.url.searchParams.get('pageSize'), '50');
  assert.equal(request.options.headers['x-api-key'], 'test-key');
  assert.equal(result.data[0].displayName, '1.20.1 Fabric');
});

test('CurseForge API errors retain HTTP status for browser fallback', async () => {
  const service = new CurseForgeService('test-key', {
    fetch: async () => new Response('', { status: 403 })
  });

  await assert.rejects(service.getDownloadUrl(4, 8), (error) => error.status === 403);
});

test('CurseForge search explains rejected API credentials', async () => {
  const service = new CurseForgeService('invalid-key', {
    fetch: async () => new Response('', { status: 403 })
  });

  await assert.rejects(
    service.search(),
    (error) => error.status === 403 && /доступ к Minecraft \(gameId=432\)/.test(error.message)
  );
});

test('CurseForge requires the environment-provided API key', async () => {
  let requests = 0;
  const service = new CurseForgeService('', {
    fetch: async () => {
      requests += 1;
      return Response.json({ data: [] });
    }
  });

  await assert.rejects(service.search(), /CURSEFORGE_API_KEY/);
  assert.equal(requests, 0);
});

test('CurseForge download URL endpoint sends API headers', async () => {
  let request;
  const service = new CurseForgeService('test-key', {
    fetch: async (url, options) => {
      request = { url: new URL(url), options };
      return Response.json({ data: 'https://edge.forgecdn.net/files/1/mod.jar' });
    }
  });

  assert.equal(await service.getDownloadUrl(4, 8), 'https://edge.forgecdn.net/files/1/mod.jar');
  assert.equal(request.url.pathname, '/v1/mods/4/files/8/download-url');
  assert.equal(request.options.headers['x-api-key'], 'test-key');
  assert.equal(request.options.headers.Accept, 'application/json');
});

test('CurseForge batch file lookup posts file IDs and retries rate limits', async () => {
  const requests = [];
  const service = new CurseForgeService('test-key', {
    fetch: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (requests.length === 1) return new Response('', { status: 429, headers: { 'retry-after': '0' } });
      return Response.json({ data: [{ id: 21 }, { id: 22 }] });
    }
  });

  const files = await service.getFilesByIds([21, 22, 21]);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.pathname, '/v1/mods/files');
  assert.equal(requests[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[1].options.body), { fileIds: [21, 22] });
  assert.equal(requests[1].options.headers.Accept, 'application/json');
  assert.deepEqual(files.map((file) => file.id), [21, 22]);
});

test('CDN download verifies hash and sends CurseForge headers', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-download-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const content = Buffer.from('verified mod contents');
  const hash = crypto.createHash('sha1').update(content).digest('hex');
  const md5 = crypto.createHash('md5').update(content).digest('hex');
  let headers;
  let requestOptions;
  const manager = new DownloadManager('test-key', {
    fetch: async (_url, options) => {
      requestOptions = options;
      headers = options.headers;
      return new Response(content, { headers: { 'content-length': String(content.length) } });
    }
  });
  const destination = path.join(directory, 'test-mod.jar');

  await manager.download({
    url: 'https://edge.forgecdn.net/files/1/test-mod.jar',
    destination,
    fileName: 'test-mod.jar',
    hashes: [{ algo: 1, value: hash }, { algo: 2, value: md5 }],
    fileLength: content.length
  });

  assert.equal(headers['x-api-key'], 'test-key');
  assert.equal(headers.Accept, 'application/json');
  // Electron net.fetch падает на redirect: 'manual' для forgecdn, поэтому
  // загрузчик должен следовать редиректам автоматически.
  assert.equal(requestOptions.redirect, 'follow');
  assert.deepEqual(await fs.readFile(destination), content);
});

test('CDN downloads retry transient network timeouts', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-download-retry-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const content = Buffer.from('retryable CDN response');
  let requests = 0;
  const manager = new DownloadManager('test-key', {
    fetch: async () => {
      requests += 1;
      if (requests === 1) throw Object.assign(new Error('net::ERR_TIMED_OUT'), { code: 'ERR_TIMED_OUT' });
      return new Response(content);
    }
  });
  const destination = path.join(directory, 'retry.jar');

  await manager.download({
    url: 'https://edge.forgecdn.net/files/1/retry.jar',
    destination,
    fileName: 'retry.jar'
  });

  assert.equal(requests, 2);
  assert.deepEqual(await fs.readFile(destination), content);
});

test('CDN download removes partial file when integrity verification fails', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-download-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manager = new DownloadManager('test-key', {
    fetch: async () => new Response('bad contents')
  });
  const destination = path.join(directory, 'test-mod.jar');

  await assert.rejects(manager.download({
    url: 'https://edge.forgecdn.net/files/1/test-mod.jar',
    destination,
    fileName: 'test-mod.jar',
    hashes: [{ algo: 1, value: '00'.repeat(20) }]
  }), /контрольная сумма SHA1/);
  await assert.rejects(fs.access(destination));
  await assert.rejects(fs.access(`${destination}.part`));
});

test('cancelled CDN downloads stop and clean up their partial files', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-download-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let requests = 0;
  const manager = new DownloadManager('test-key', {
    fetch: async () => {
      requests += 1;
      return new Response('unexpected');
    }
  });
  const controller = new AbortController();
  controller.abort();
  const destination = path.join(directory, 'cancelled.jar');

  await assert.rejects(manager.download({
    url: 'https://edge.forgecdn.net/files/1/cancelled.jar',
    destination,
    fileName: 'cancelled.jar',
    signal: controller.signal
  }), { name: 'AbortError' });
  assert.equal(requests, 0);
  await assert.rejects(fs.access(`${destination}.part`));
});

test('required CurseForge dependencies are installed with the selected mod', async (t) => {
  const gameDir = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-mod-install-test-'));
  t.after(() => fs.rm(gameDir, { recursive: true, force: true }));
  const contents = new Map([
    ['top.jar', Buffer.from('top mod')],
    ['dependency.jar', Buffer.from('required dependency')]
  ]);
  electronMock.net.fetch = async (url) => new Response(contents.get(path.basename(new URL(url).pathname)));

  const dependency = {
    id: 21,
    modId: 2,
    fileName: 'dependency.jar',
    fileLength: contents.get('dependency.jar').length,
    hashes: [{ algo: 1, value: crypto.createHash('sha1').update(contents.get('dependency.jar')).digest('hex') }],
    downloadUrl: 'https://edge.forgecdn.net/files/2/dependency.jar',
    gameVersions: ['1.20.1']
  };
  const selected = {
    id: 11,
    modId: 1,
    fileName: 'top.jar',
    fileLength: contents.get('top.jar').length,
    hashes: [{ algo: 1, value: crypto.createHash('sha1').update(contents.get('top.jar')).digest('hex') }],
    downloadUrl: 'https://edge.forgecdn.net/files/1/top.jar',
    gameVersions: ['1.20.1'],
    dependencies: [{ modId: 2, relationType: 3 }]
  };
  const service = {
    getFilesByIds: async () => [selected],
    listFiles: async () => ({ data: [dependency] })
  };

  const result = await installSelectedFile({
    service,
    apiKey: 'test-key',
    gameDir,
    fileId: selected.id,
    gameVersion: '1.20.1',
    modLoaderType: 4
  });

  assert.equal(result.installed, 2);
  assert.deepEqual((await fs.readdir(path.join(gameDir, 'mods'))).sort(), ['dependency.jar', 'top.jar']);
});

test('invalid API credentials are not mistaken for author-blocked downloads', async (t) => {
  const gameDir = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-mod-install-test-'));
  t.after(() => fs.rm(gameDir, { recursive: true, force: true }));
  const file = { id: 11, modId: 1, fileName: 'top.jar', gameVersions: ['1.20.1'] };
  let openedFallback = false;
  const service = {
    getFilesByIds: async () => [file],
    getDownloadUrl: async () => { throw Object.assign(new Error('Invalid API key'), { status: 403 }); },
    filePageUrl: async () => { openedFallback = true; return 'https://curseforge.com'; }
  };

  await assert.rejects(installSelectedFile({
    service,
    apiKey: 'invalid-key',
    gameDir,
    fileId: file.id,
    gameVersion: '1.20.1'
  }), /Invalid API key/);
  assert.equal(openedFallback, false);
});

test('download access denial falls back to the CurseForge file page', async (t) => {
  const gameDir = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-mod-install-test-'));
  t.after(() => fs.rm(gameDir, { recursive: true, force: true }));
  const file = { id: 11, modId: 1, fileName: 'top.jar', gameVersions: ['1.20.1'] };
  let fallback;
  const service = {
    getFilesByIds: async () => [file],
    getDownloadUrl: async () => {
      throw Object.assign(new Error('Forbidden'), { status: 403, detail: 'Download forbidden for this file' });
    },
    filePageUrl: async () => 'https://www.curseforge.com/minecraft/mc-mods/example/files/11'
  };

  const result = await installSelectedFile({
    service,
    apiKey: 'test-key',
    gameDir,
    fileId: file.id,
    gameVersion: '1.20.1',
    onFallback: async (details) => { fallback = details; }
  });

  assert.equal(result.installed, 0);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].fileName, 'top.jar');
  assert.equal(result.blocked[0].pageUrl, 'https://www.curseforge.com/minecraft/mc-mods/example/files/11');
  assert.match(result.blocked[0].reason, /вручную/);
  assert.equal(fallback.pageUrl, result.blocked[0].pageUrl);
});

test('CurseForge downloads without SHA-1 or MD5 are rejected', async (t) => {
  const gameDir = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-mod-install-test-'));
  t.after(() => fs.rm(gameDir, { recursive: true, force: true }));
  const file = {
    id: 11,
    modId: 1,
    fileName: 'top.jar',
    gameVersions: ['1.20.1'],
    downloadUrl: 'https://edge.forgecdn.net/files/1/top.jar',
    hashes: []
  };
  const service = { getFilesByIds: async () => [file] };

  await assert.rejects(installSelectedFile({
    service,
    apiKey: 'test-key',
    gameDir,
    fileId: file.id,
    gameVersion: '1.20.1'
  }), /не предоставил SHA-1 или MD5/);
});

test('custom profile skin accepts Minecraft PNG dimensions and rejects unrelated images', () => {
  const modernSkin = skinPng(64, 64);
  const legacySkin = skinPng(64, 32);

  assert.deepEqual(inspectSkinPng(modernSkin), { width: 64, height: 64 });
  assert.deepEqual(inspectSkinPng(legacySkin), { width: 64, height: 32 });
  assert.match(skinDataUrl(modernSkin), /^data:image\/png;base64,/);
  assert.throws(() => inspectSkinPng(skinPng(128, 128)), /должен быть 64×64 или 64×32/);
  assert.throws(() => inspectSkinPng(Buffer.from('not a png')), /повреждён или слишком короткий/);
});

test('offline skin pack replaces local default skins and preserves other resource packs', async (t) => {
  const gameDir = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-offline-skin-test-'));
  t.after(() => fs.rm(gameDir, { recursive: true, force: true }));
  const optionsPath = path.join(gameDir, 'options.txt');
  await fs.writeFile(optionsPath, [
    'resourcePacks:["vanilla","file/custom-pack"]',
    `incompatibleResourcePacks:["${PACK_ID}"]`,
    'language:en_us'
  ].join('\n'));
  const texture = skinPng();

  await applyOfflineSkinPack({ gameDir, gameVersion: '1.20.1', skinBuffer: texture });
  const options = await fs.readFile(optionsPath, 'utf8');
  const selectedPacks = JSON.parse(options.match(/^resourcePacks:(.+)$/m)[1]);
  const incompatiblePacks = JSON.parse(options.match(/^incompatibleResourcePacks:(.+)$/m)[1]);
  const packDir = path.join(gameDir, 'resourcepacks', PACK_DIRECTORY);

  assert.deepEqual(selectedPacks, ['vanilla', 'file/custom-pack', PACK_ID]);
  assert.deepEqual(incompatiblePacks, []);
  assert.equal(options.includes('language:en_us'), true);
  assert.deepEqual(await fs.readFile(path.join(packDir, 'assets', 'minecraft', 'textures', 'entity', 'player', 'wide', 'steve.png')), texture);
  assert.deepEqual(await fs.readFile(path.join(packDir, 'assets', 'minecraft', 'textures', 'entity', 'alex.png')), texture);

  await applyOfflineSkinPack({ gameDir, gameVersion: '26.3', skinBuffer: texture });
  assert.equal(JSON.parse((await fs.readFile(optionsPath, 'utf8')).match(/^resourcePacks:(.+)$/m)[1]).filter((entry) => entry === PACK_ID).length, 1);
  assert.deepEqual(packMetadata('26.3').pack, {
    description: 'Локальный офлайн-скин OBSIDIAN Launcher',
    min_format: 1,
    max_format: 200
  });

  await removeOfflineSkinPack(gameDir);
  assert.deepEqual(JSON.parse((await fs.readFile(optionsPath, 'utf8')).match(/^resourcePacks:(.+)$/m)[1]), [
    'vanilla',
    'file/custom-pack'
  ]);
  await assert.rejects(fs.access(packDir));
});

test('modpack import installs manifest files and copies overrides', async (t) => {
  const gameDir = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-pack-test-'));
  t.after(() => fs.rm(gameDir, { recursive: true, force: true }));
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    minecraft: { version: '1.20.1', modLoaders: [{ id: 'fabric-loader-0.15.11', primary: true }] },
    files: [{ projectID: 2, fileID: 21 }]
  })));
  zip.addFile('overrides/config/example.txt', Buffer.from('override'));
  const archive = zip.toBuffer();
  const modBytes = Buffer.from('pack mod');
  const packFile = {
    id: 500,
    modId: 50,
    fileName: 'pack.zip',
    fileLength: archive.length,
    hashes: [{ algo: 1, value: crypto.createHash('sha1').update(archive).digest('hex') }],
    downloadUrl: 'https://edge.forgecdn.net/files/500/pack.zip'
  };
  const modFile = {
    id: 21,
    modId: 2,
    fileName: 'pack-mod.jar',
    fileLength: modBytes.length,
    hashes: [{ algo: 1, value: crypto.createHash('sha1').update(modBytes).digest('hex') }],
    downloadUrl: 'https://edge.forgecdn.net/files/21/pack-mod.jar',
    gameVersions: ['1.20.1']
  };
  electronMock.net.fetch = async (url) => {
    const bytes = url.endsWith('pack.zip') ? archive : modBytes;
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  };
  const installedLoaders = [];
  const progressPhases = [];
  const instance = {
    id: 'imported-pack',
    name: 'Test Pack',
    versionId: '1.20.1',
    loader: 'fabric',
    loaderVersion: '0.15.11'
  };
  const instanceDir = path.join(gameDir, 'imported-instance');
  const service = {
    getFilesByIds: async (fileIds) => fileIds.includes(packFile.id) ? [packFile] : [modFile],
    listFiles: async () => ({ data: [] })
  };

  const result = await installModpack({
    service,
    apiKey: 'test-key',
    gameDir,
    fileId: packFile.id,
    createTarget: async () => ({ gameDir: instanceDir, instance }),
    installLoader: async (loader) => installedLoaders.push(loader),
    onProgress: (progress) => progressPhases.push(progress.phase)
  });

  assert.equal(result.installed, 1);
  assert.deepEqual(result.instance, instance);
  assert.deepEqual(result.loader, { loader: 'fabric', loaderVersion: '0.15.11' });
  assert.equal(installedLoaders[0].gameVersion, '1.20.1');
  assert.equal(installedLoaders[0].gameDir, instanceDir);
  assert.equal(await fs.readFile(path.join(instanceDir, 'mods', 'pack-mod.jar'), 'utf8'), 'pack mod');
  assert.equal(await fs.readFile(path.join(instanceDir, 'config', 'example.txt'), 'utf8'), 'override');
  const postDownloadPhases = ['pack-extract', 'loader-install', 'metadata', 'mod-prepare', 'overrides', 'install-complete'];
  assert.ok(progressPhases.includes('pack-download'));
  const phasePositions = postDownloadPhases.map((phase) => progressPhases.indexOf(phase));
  assert.ok(phasePositions.every((position, index) =>
    position >= 0 && (index === 0 || position > phasePositions[index - 1])
  ));
});

test('modpack downloads up to five files at the same time', async (t) => {
  const gameDir = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-pack-parallel-test-'));
  t.after(() => fs.rm(gameDir, { recursive: true, force: true }));
  const files = Array.from({ length: 6 }, (_, index) => {
    const bytes = Buffer.from(`parallel mod ${index}`);
    return {
      id: 100 + index,
      modId: 200 + index,
      fileName: `parallel-${index}.jar`,
      fileLength: bytes.length,
      bytes,
      hashes: [{ algo: 1, value: crypto.createHash('sha1').update(bytes).digest('hex') }],
      downloadUrl: `https://edge.forgecdn.net/files/${100 + index}/parallel-${index}.jar`,
      gameVersions: ['1.20.1']
    };
  });
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    minecraft: { version: '1.20.1', modLoaders: [{ id: 'fabric-loader-0.15.11', primary: true }] },
    files: files.map((file) => ({ projectID: file.modId, fileID: file.id }))
  })));
  const archive = zip.toBuffer();
  const packFile = {
    id: 500,
    modId: 50,
    fileName: 'parallel-pack.zip',
    fileLength: archive.length,
    hashes: [{ algo: 1, value: crypto.createHash('sha1').update(archive).digest('hex') }],
    downloadUrl: 'https://edge.forgecdn.net/files/500/parallel-pack.zip'
  };
  let active = 0;
  let maxActive = 0;
  electronMock.net.fetch = async (url) => {
    if (url.endsWith('parallel-pack.zip')) {
      return new Response(archive, { headers: { 'content-length': String(archive.length) } });
    }
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active -= 1;
    const file = files.find((candidate) => url.endsWith(candidate.fileName));
    if (!file) throw new Error(`Unexpected request: ${url}`);
    return new Response(file.bytes, { headers: { 'content-length': String(file.bytes.length) } });
  };
  const service = {
    getFilesByIds: async (fileIds) => fileIds.includes(packFile.id)
      ? [packFile]
      : files.filter((file) => fileIds.includes(file.id)),
    listFiles: async () => ({ data: [] })
  };

  const result = await installModpack({
    service,
    apiKey: 'test-key',
    gameDir,
    fileId: packFile.id,
    installLoader: async () => ({})
  });

  assert.equal(result.installed, 6);
  assert.ok(maxActive > 1, 'files are downloaded sequentially');
  assert.ok(maxActive <= 5, `too many parallel downloads: ${maxActive}`);
});

test('modpack loader IDs are mapped and override traversal paths are rejected', () => {
  assert.deepEqual(loaderFromManifest({
    minecraft: { modLoaders: [{ id: 'neoforge-21.1.217', primary: true }] }
  }), { loader: 'neoforge', loaderVersion: '21.1.217' });
  assert.deepEqual(loaderFromManifest({
    minecraft: { modLoaders: [{ id: 'fabric-0.20', primary: true }] }
  }), { loader: 'fabric', loaderVersion: '0.20' });
  assert.deepEqual(loaderFromManifest({
    minecraft: { modLoaders: [{ id: 'fabric-0.20.1', primary: true }] }
  }), { loader: 'fabric', loaderVersion: '0.20.1' });

  const zip = {
    getEntries: () => [{
      entryName: 'overrides/../../outside.txt',
      isDirectory: false,
      getData: () => Buffer.from('invalid')
    }]
  };
  assert.throws(() => extractOverrides(zip, path.resolve(os.tmpdir(), 'launcher-pack-test')), /недопустимый путь/);
});

test('NeoForge versions are filtered by the matching Minecraft line', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-loader-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let requestUrl = '';
  electronMock.net.fetch = async (url) => {
    requestUrl = url;
    return new Response('<metadata><versioning><versions><version>20.4.10</version><version>21.1.80</version><version>21.1.81</version><version>20.1.9</version></versions></versioning></metadata>');
  };

  const result = await listLoaderVersions('neoforge', '1.21.1', root);

  assert.match(requestUrl, /maven-metadata\.xml$/);
  assert.deepEqual(result.versions, ['21.1.81', '21.1.80']);
});

test('Forge profile discovery handles installer-generated profile IDs', async (t) => {
  const gameDir = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-forge-profile-test-'));
  t.after(() => fs.rm(gameDir, { recursive: true, force: true }));
  const profileDir = path.join(gameDir, 'versions', 'custom-forge-profile');
  await fs.mkdir(profileDir, { recursive: true });
  const profile = {
    id: 'custom-forge-profile',
    inheritsFrom: '1.20.1',
    libraries: [{ name: 'net.minecraftforge:forge:1.20.1-47.4.0' }]
  };
  await fs.writeFile(path.join(profileDir, 'custom-forge-profile.json'), JSON.stringify(profile));

  const discovered = await findInstalledProfile(gameDir, { gameVersion: '1.20.1', loader: 'forge' });

  assert.equal(discovered.profileId, 'custom-forge-profile');
  assert.deepEqual(await loadForgeProfile(gameDir, '1.20.1', '47.4.0'), profile);
});

test('Forge profile discovery ignores profiles for a different Forge version', async (t) => {
  const gameDir = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-forge-version-test-'));
  t.after(() => fs.rm(gameDir, { recursive: true, force: true }));
  const profiles = [
    { id: '1.20.1-forge-47.3.0', inheritsFrom: '1.20.1', libraries: [{ name: 'net.minecraftforge:forge:1.20.1-47.3.0' }] },
    { id: '1.20.1-forge-47.4.0', inheritsFrom: '1.20.1', libraries: [{ name: 'net.minecraftforge:forge:1.20.1-47.4.0' }] }
  ];
  for (const profile of profiles) {
    const profileDir = path.join(gameDir, 'versions', profile.id);
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(path.join(profileDir, `${profile.id}.json`), JSON.stringify(profile));
  }

  const installed = await loadForgeProfile(gameDir, '1.20.1', '47.4.0');

  assert.equal(installed.id, '1.20.1-forge-47.4.0');
});

test('legacy settings migrate to an instance and preserve instance selection', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-store-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  appDataPath = root;
  const settingsDir = path.join(root, '.obsidian-launcher');
  await fs.mkdir(settingsDir, { recursive: true });
  await fs.writeFile(path.join(settingsDir, 'settings.json'), JSON.stringify({
    versionId: '1.20.1',
    loader: 'forge',
    loaderVersion: '47.4.0',
    gameDir: ''
  }));
  const store = new Store();

  assert.equal(store.getSelectedInstance().id, 'legacy');
  assert.equal(store.getSelectedInstance().versionId, '1.20.1');
  assert.equal(store.getSelectedInstance().gameDir, path.join(settingsDir, 'game'));

  store.createInstance({
    id: 'fabric-test',
    name: 'Fabric test',
    versionId: '1.21.1',
    loader: 'fabric',
    loaderVersion: '0.16.0',
    gameDir: path.join(settingsDir, 'instances', 'fabric-test')
  });
  const reopened = new Store();
  assert.equal(reopened.getSelectedInstance().id, 'fabric-test');
  assert.equal(reopened.get().loader, 'fabric');
  assert.equal(reopened.getInstances().length, 2);
  assert.equal(reopened.selectInstance('legacy').loader, 'forge');
  store.updateInstance('fabric-test', { name: 'Моды', memory: 8192 });
  assert.equal(store.getSelectedInstance().name, 'Моды');
  assert.equal(store.getSelectedInstance().memory, 8192);
  const updated = new Store();
  assert.equal(updated.getSelectedInstance().name, 'Моды');
  assert.equal(updated.getSelectedInstance().memory, 8192);
  assert.equal(store.selectInstance('legacy').memory, 4096);
  assert.equal(store.selectInstance('fabric-test').memory, 8192);
});

test('manual downloads are detected in the Downloads folder and imported', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-manual-test-'));
  const originalHomedir = os.homedir;
  t.after(async () => {
    os.homedir = originalHomedir;
    await fs.rm(root, { recursive: true, force: true });
  });
  os.homedir = () => root;

  const downloads = path.join(root, 'Downloads');
  const gameDir = path.join(root, 'game');
  await fs.mkdir(downloads, { recursive: true });
  const content = Buffer.from('manual mod bytes');
  const sha1 = crypto.createHash('sha1').update(content).digest('hex');
  await fs.writeFile(path.join(downloads, 'ready.jar'), content);
  await fs.writeFile(path.join(downloads, 'wrong-size.jar'), Buffer.from('x'));
  await fs.writeFile(path.join(downloads, 'wrong-hash.jar'), content);

  const entries = [
    { fileName: 'ready.jar', fileLength: content.length, hashes: [{ algo: 1, value: sha1.toUpperCase() }] },
    { fileName: 'wrong-size.jar', fileLength: content.length },
    { fileName: 'wrong-hash.jar', fileLength: content.length, hashes: [{ algo: 1, value: '0'.repeat(40) }] },
    { fileName: 'missing.jar', fileLength: 10 },
    { fileName: 'optional.jar', manualOptional: true }
  ];

  const statuses = await inspectManualDownloads(entries);
  assert.deepEqual(statuses.map((entry) => entry.status), ['ready', 'size', 'hash', 'missing', 'skipped']);
  assert.equal(statuses[0].ready, true);
  assert.equal(statuses[1].ready, false);
  assert.equal(statuses[4].optional, true);

  const result = await importManualDownloads(gameDir, entries);
  assert.deepEqual(result.imported, ['ready.jar']);
  assert.deepEqual(result.pending.map((entry) => entry.fileName), ['wrong-size.jar', 'wrong-hash.jar', 'missing.jar']);
  assert.deepEqual(await fs.readFile(path.join(gameDir, 'mods', 'ready.jar')), content);
});

test('modpack install blocks only the unavailable file instead of failing', async (t) => {
  const gameDir = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-pack-blocked-test-'));
  t.after(() => fs.rm(gameDir, { recursive: true, force: true }));
  const goodBytes = Buffer.from('good mod');
  const good = {
    id: 11,
    modId: 1,
    fileName: 'good.jar',
    fileLength: goodBytes.length,
    hashes: [{ algo: 1, value: crypto.createHash('sha1').update(goodBytes).digest('hex') }],
    downloadUrl: 'https://edge.forgecdn.net/files/11/good.jar',
    gameVersions: ['1.20.1']
  };
  const bad = {
    id: 12,
    modId: 2,
    fileName: 'bad.jar',
    fileLength: goodBytes.length,
    hashes: [{ algo: 1, value: crypto.createHash('sha1').update(goodBytes).digest('hex') }],
    downloadUrl: 'https://edge.forgecdn.net/files/12/bad.jar',
    gameVersions: ['1.20.1']
  };
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    minecraft: { version: '1.20.1', modLoaders: [{ id: 'fabric-loader-0.15.11', primary: true }] },
    files: [{ projectID: 1, fileID: 11 }, { projectID: 2, fileID: 12 }]
  })));
  const archive = zip.toBuffer();
  const packFile = {
    id: 501,
    modId: 51,
    fileName: 'blocked-pack.zip',
    fileLength: archive.length,
    hashes: [{ algo: 1, value: crypto.createHash('sha1').update(archive).digest('hex') }],
    downloadUrl: 'https://edge.forgecdn.net/files/501/blocked-pack.zip'
  };
  electronMock.net.fetch = async (url) => {
    if (url.endsWith('blocked-pack.zip')) {
      return new Response(archive, { headers: { 'content-length': String(archive.length) } });
    }
    if (url.endsWith('good.jar')) {
      return new Response(goodBytes, { headers: { 'content-length': String(goodBytes.length) } });
    }
    return new Response('forbidden', { status: 403, headers: { 'content-length': '9' } });
  };
  const instanceDir = path.join(gameDir, 'blocked-instance');
  const instance = { id: 'blocked-pack', name: 'Blocked Pack', versionId: '1.20.1', loader: 'fabric', loaderVersion: '0.15.11' };
  const service = {
    getFilesByIds: async (fileIds) => {
      if (fileIds.includes(packFile.id)) return [packFile];
      return [good, bad].filter((file) => fileIds.includes(file.id));
    },
    listFiles: async () => ({ data: [] }),
    filePageUrl: async (projectId, fileId) => `https://www.curseforge.com/minecraft/mc-mods/x/files/${fileId}`
  };

  const result = await installModpack({
    service,
    apiKey: 'test-key',
    gameDir,
    fileId: packFile.id,
    createTarget: async () => ({ gameDir: instanceDir, instance }),
    installLoader: async () => {}
  });

  assert.equal(result.installed, 1);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].fileName, 'bad.jar');
  assert.match(result.blocked[0].reason, /HTTP 403/);
  assert.equal(await fs.readFile(path.join(instanceDir, 'mods', 'good.jar'), 'utf8'), 'good mod');
  await assert.rejects(fs.access(path.join(instanceDir, 'mods', 'bad.jar')));
});

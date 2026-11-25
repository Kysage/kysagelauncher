'use strict';

const { net } = require('electron');

const API_BASE_URL = 'https://api.modrinth.com/v2';
const USER_AGENT = 'OBSIDIAN-Launcher/1.0.0';
const PROJECT_TYPES = new Set(['mod', 'modpack']);
const LOADERS = new Set(['forge', 'fabric', 'quilt', 'neoforge']);

function abortError() {
  const error = new Error('Операция отменена.');
  error.name = 'AbortError';
  return error;
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

class ModrinthService {
  constructor({ fetch = net.fetch } = {}) {
    this.fetch = fetch;
  }

  async request(url, signal) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (signal?.aborted) throw abortError();
      const response = await this.fetch(url, {
        signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT
        }
      });
      if (response.status === 429) {
        await response.body?.cancel();
        if (attempt === 3) throw new Error('Modrinth ограничил число запросов. Повторите попытку позже.');
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter)
          ? Math.max(250, Math.min(30000, retryAfter * 1000))
          : Math.min(8000, 1000 * 2 ** attempt);
        await wait(delay, signal);
        continue;
      }
      if (!response.ok) {
        let detail = '';
        try {
          const payload = await response.json();
          detail = payload.description || payload.error || '';
        } catch {
          detail = '';
        }
        throw new Error(`Modrinth вернул HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      return response.json();
    }
    throw new Error('Не удалось выполнить запрос к Modrinth.');
  }

  async search({ query = '', projectType = 'mod', gameVersion, loader, offset = 0, limit = 24, signal } = {}) {
    if (!PROJECT_TYPES.has(projectType)) throw new Error('Неподдерживаемый тип проекта Modrinth.');
    if (!gameVersion || !/^[\w.-]{1,64}$/.test(String(gameVersion))) {
      throw new Error('Сначала выберите корректную версию Minecraft.');
    }
    if (loader && !LOADERS.has(loader)) throw new Error('Неизвестный загрузчик Modrinth.');
    const pageSize = Math.min(50, Math.max(1, Number(limit) || 24));
    const pageOffset = Math.max(0, Number(offset) || 0);
    const facets = [[`project_type:${projectType}`], [`versions:${gameVersion}`]];
    if (loader) facets.push([`categories:${loader}`]);
    const url = new URL(`${API_BASE_URL}/search`);
    url.searchParams.set('query', String(query).slice(0, 200));
    url.searchParams.set('facets', JSON.stringify(facets));
    url.searchParams.set('offset', String(pageOffset));
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('index', 'relevance');
    return this.request(url.toString(), signal);
  }

  async listVersions(projectId, { gameVersion, loader, signal } = {}) {
    const id = String(projectId || '');
    if (!/^[\w-]{1,64}$/.test(id)) throw new Error('Некорректный идентификатор проекта Modrinth.');
    if (loader && !LOADERS.has(loader)) throw new Error('Неизвестный загрузчик Modrinth.');
    const url = new URL(`${API_BASE_URL}/project/${encodeURIComponent(id)}/version`);
    if (gameVersion) url.searchParams.set('game_versions', JSON.stringify([gameVersion]));
    if (loader) url.searchParams.set('loaders', JSON.stringify([loader]));
    const versions = await this.request(url.toString(), signal);
    if (!Array.isArray(versions)) throw new Error('Modrinth вернул некорректный список версий.');
    return versions;
  }

  async getVersion(versionId, signal) {
    const id = String(versionId || '');
    if (!/^[\w-]{1,64}$/.test(id)) throw new Error('Некорректный идентификатор версии Modrinth.');
    return this.request(`${API_BASE_URL}/version/${encodeURIComponent(id)}`, signal);
  }
}

module.exports = { ModrinthService, API_BASE_URL, LOADERS };

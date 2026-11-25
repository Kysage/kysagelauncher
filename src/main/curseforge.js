'use strict';

const { net } = require('electron');

const GAME_ID = 432;
const API_BASE_URL = 'https://api.curseforge.com/v1';
const WEBSITE_BASE_URL = 'https://curseforge.com';
const CLASS_IDS = new Set([6, 4471, 12, 6552]);
const LOADER_TYPES = new Set([1, 4, 5, 6]);
const SORT_FIELDS = new Set([1, 2, 3, 4, 6]);
const SORT_ORDERS = new Set(['asc', 'desc']);
function abortError() {
  const error = new Error('Операция отменена');
  error.name = 'AbortError';
  return error;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryDelay(response, attempt) {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(250, Math.min(30000, seconds * 1000));
    const dateDelay = Date.parse(header) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(250, Math.min(30000, dateDelay));
  }
  return Math.min(8000, 1000 * 2 ** attempt);
}

function isTransientNetworkError(error) {
  const messages = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    messages.push(current.code || '', current.message || '');
    current = current.cause;
  }
  return /timed out|ERR_TIMED_OUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|fetch failed/i
    .test(messages.join(' '));
}

class CurseForgeService {
  constructor(apiKey, { fetch = net.fetch } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.fetch = fetch;
  }

  async request(endpoint, { method = 'GET', body, signal } = {}) {
    if (!this.apiKey) {
      throw new Error('CURSEFORGE_API_KEY не найден. Задайте его в окружении или в .env (скопируйте .env.example); сам .env.example не загружается. Перезапустите лаунчер.');
    }

    const headers = {
      Accept: 'application/json',
      'x-api-key': this.apiKey,
      'User-Agent': 'OBSIDIAN-Launcher'
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (signal?.aborted) throw abortError();
      let response;
      try {
        response = await this.fetch(`${API_BASE_URL}${endpoint}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal
        });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw abortError();
        if (!isTransientNetworkError(error)) throw error;
        if (attempt === 3) {
          const detail = error?.message || String(error);
          const networkError = new Error(
            `CurseForge не отвечает после повторных попыток (${detail}). Проверьте подключение, VPN или прокси.`
          );
          networkError.cause = error;
          throw networkError;
        }
        await delay(Math.min(8000, 500 * (2 ** attempt)), signal);
        continue;
      }

      if (response.status === 429) {
        await response.body?.cancel();
        if (attempt === 3) {
          const error = new Error('CurseForge временно ограничил запросы. Подождите и повторите.');
          error.status = 429;
          throw error;
        }
        await delay(retryDelay(response, attempt), signal);
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        let detail = '';
        try {
          const payload = await response.json();
          const value = payload.message || payload.error?.message || payload.error || '';
          detail = typeof value === 'string' ? value : JSON.stringify(value);
        } catch {
          detail = '';
        }
        const isDownloadUrlRequest = /\/download-url(?:\?|$)/.test(endpoint);
        const error = new Error(
          response.status === 401
            ? `CurseForge отклонил API-ключ (HTTP 401). Проверьте его статус в developer console.${detail ? ` ${detail}` : ''}`
            : isDownloadUrlRequest
              ? `CurseForge запретил выдачу прямой ссылки (HTTP 403)${detail ? `: ${detail}` : '.'}`
              : `CurseForge отказал в доступе (HTTP 403). Проверьте, что API-ключу разрешён доступ к Minecraft (gameId=432) в developer console.${detail ? ` ${detail}` : ''}`
        );
        error.status = response.status;
        error.detail = detail;
        throw error;
      }
      if (!response.ok) {
        const error = new Error(
          response.status === 429
            ? 'CurseForge временно ограничил запросы. Подождите и повторите.'
            : `CurseForge API вернул HTTP ${response.status}`
        );
        error.status = response.status;
        throw error;
      }

      const result = await response.json();
      return { data: result.data, pagination: result.pagination || null };
    }

    throw new Error('Не удалось выполнить запрос CurseForge');
  }

  async search({
    query = '',
    classId = 6,
    gameVersion = '',
    modLoaderType,
    sortField = 2,
    sortOrder = 'desc',
    index = 0,
    pageSize = 24
  } = {}, signal) {
    if (typeof query !== 'string' || query.length > 100) throw new Error('Поисковый запрос должен быть не длиннее 100 символов.');
    if (!CLASS_IDS.has(Number(classId))) throw new Error('Неподдерживаемая категория CurseForge.');
    if (gameVersion && !/^[\w.-]{1,64}$/.test(gameVersion)) throw new Error('Некорректная версия Minecraft.');
    if (modLoaderType !== undefined && modLoaderType !== '' && !LOADER_TYPES.has(Number(modLoaderType))) {
      throw new Error('Некорректный фильтр загрузчика.');
    }
    if (!SORT_FIELDS.has(Number(sortField))) throw new Error('Некорректная сортировка CurseForge.');
    if (!SORT_ORDERS.has(String(sortOrder))) throw new Error('Некорректный порядок сортировки CurseForge.');

    const params = new URLSearchParams({
      gameId: String(GAME_ID),
      classId: String(classId),
      index: String(Math.max(0, Math.floor(Number(index) || 0))),
      pageSize: String(Math.min(50, Math.max(1, Math.floor(Number(pageSize) || 24)))),
      sortField: String(Number(sortField)),
      sortOrder: String(sortOrder)
    });
    if (query.trim()) params.set('searchFilter', query.trim());
    if (gameVersion) params.set('gameVersion', gameVersion);
    if (modLoaderType !== undefined && modLoaderType !== '') params.set('modLoaderType', String(modLoaderType));

    const result = await this.request(`/mods/search?${params}`, { signal });
    return { data: result.data || [], pagination: result.pagination };
  }

  async listFiles(modId, { gameVersion = '', modLoaderType, index = 0, pageSize = 50 } = {}, signal) {
    if (!/^\d+$/.test(String(modId))) throw new Error('Некорректный идентификатор CurseForge.');
    if (gameVersion && !/^[\w.-]{1,64}$/.test(gameVersion)) throw new Error('Некорректная версия Minecraft.');
    const params = new URLSearchParams({
      index: String(Math.max(0, Math.floor(Number(index) || 0))),
      pageSize: String(Math.min(50, Math.max(1, Math.floor(Number(pageSize) || 50))))
    });
    if (gameVersion) params.set('gameVersion', gameVersion);
    if (modLoaderType !== undefined && modLoaderType !== '') {
      if (!LOADER_TYPES.has(Number(modLoaderType))) throw new Error('Некорректный фильтр загрузчика.');
      params.set('modLoaderType', String(modLoaderType));
    }
    const result = await this.request(`/mods/${encodeURIComponent(modId)}/files?${params}`, { signal });
    return { data: result.data || [], pagination: result.pagination };
  }

  async getFilesByIds(fileIds, signal) {
    const ids = [...new Set((fileIds || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (!ids.length) return [];
    const result = [];
    for (let offset = 0; offset < ids.length; offset += 50) {
      const batch = ids.slice(offset, offset + 50);
      const response = await this.request('/mods/files', {
        method: 'POST',
        body: { fileIds: batch },
        signal
      });
      result.push(...(response.data || []));
    }
    return result;
  }

  async getMod(modId, signal) {
    if (!/^\d+$/.test(String(modId))) throw new Error('Некорректный идентификатор CurseForge.');
    const result = await this.request(`/mods/${encodeURIComponent(modId)}`, { signal });
    return result.data;
  }

  async getDownloadUrl(modId, fileId, signal) {
    if (!/^\d+$/.test(String(modId)) || !/^\d+$/.test(String(fileId))) {
      throw new Error('Некорректный идентификатор файла CurseForge.');
    }
    const result = await this.request(
      `/mods/${encodeURIComponent(modId)}/files/${encodeURIComponent(fileId)}/download-url`,
      { signal }
    );
    return result.data;
  }

  async filePageUrl(modId, fileId, signal, fileWebsiteUrl) {
    const mod = fileWebsiteUrl ? null : await this.getMod(modId, signal);
    const website = fileWebsiteUrl || mod?.links?.websiteUrl;
    if (!website) {
      const section = Number(mod?.classId) === 4471 ? 'minecraft/modpacks' : 'minecraft/mc-mods';
      const slug = mod?.slug ? `/${encodeURIComponent(mod.slug)}` : '';
      return `${WEBSITE_BASE_URL}/${section}${slug}/files/${encodeURIComponent(fileId)}`;
    }
    const parsed = new URL(website);
    if (!/(^|\.)curseforge\.com$/i.test(parsed.hostname)) {
      throw new Error('CurseForge вернул некорректную ссылку на страницу мода.');
    }
    const pagePath = parsed.pathname.replace(/\/+$/, '');
    if (/\/files\/\d+$/i.test(pagePath)) return `${WEBSITE_BASE_URL}${pagePath}`;
    return `${WEBSITE_BASE_URL}${pagePath}/files/${encodeURIComponent(fileId)}`;
  }
}

module.exports = {
  CurseForgeService,
  GAME_ID,
  CLASS_IDS,
  LOADER_TYPES
};

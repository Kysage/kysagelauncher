'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { net } = require('electron');

const MAX_FILE_SIZE = 1024 * 1024 * 1024;

function isAllowedCdn(url, allowedHosts = ['forgecdn.net']) {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  return parsed.protocol === 'https:' && allowedHosts.some((host) => {
    const allowed = String(host).toLowerCase();
    return hostname === allowed || hostname.endsWith(`.${allowed}`);
  });
}

function abortError() {
  const error = new Error('Загрузка отменена');
  error.name = 'AbortError';
  return error;
}

function retryAfter(response, attempt) {
  const value = response.headers.get('retry-after');
  const seconds = Number(value);
  if (value && Number.isFinite(seconds)) return Math.max(250, Math.min(30000, seconds * 1000));
  const dateDelay = value ? Date.parse(value) - Date.now() : NaN;
  if (Number.isFinite(dateDelay)) return Math.max(250, Math.min(30000, dateDelay));
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

function expectedHashes(hashes) {
  return (hashes || [])
    .map((hash) => {
      const algo = String(hash.algo).toLowerCase();
      const algorithm = algo === '1' ? 'sha1' : algo === '2' ? 'md5' : algo;
      return ['sha1', 'sha512', 'md5'].includes(algorithm) && hash.value
        ? { algorithm, value: String(hash.value).toLowerCase() }
        : null;
    })
    .filter(Boolean);
}

function safeFilename(value) {
  const name = path.basename(String(value || 'download.jar')).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
  if (!name || name === '.' || name === '..') throw new Error('Каталог вернул некорректное имя файла.');
  return name;
}

class DownloadManager {
  constructor(apiKey, {
    fetch = net.fetch,
    allowedHosts = ['forgecdn.net'],
    requireApiKey = true,
    providerLabel = 'CurseForge'
  } = {}) {
    this.apiKey = apiKey;
    this.fetch = fetch;
    this.allowedHosts = allowedHosts;
    this.requireApiKey = requireApiKey;
    this.providerLabel = providerLabel;
  }

  async request(url, signal) {
    if (this.requireApiKey && !this.apiKey) throw new Error(`API-ключ ${this.providerLabel} не настроен.`);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (signal?.aborted) throw abortError();
      if (!isAllowedCdn(url, this.allowedHosts)) throw new Error(`${this.providerLabel} вернул ссылку на недоверенный CDN.`);

      const headers = {
        Accept: this.apiKey ? 'application/json' : '*/*',
        'User-Agent': 'OBSIDIAN-Launcher'
      };
      if (this.apiKey) headers['x-api-key'] = this.apiKey;

      let response;
      try {
        // Electron net.fetch не поддерживает redirect: 'manual' для forgecdn
        // и падает с «Redirect was cancelled», поэтому следуем переадресации
        // автоматически и проверяем конечный адрес.
        response = await this.fetch(url, {
          signal,
          redirect: 'follow',
          headers
        });
      } catch (error) {
        if (signal?.aborted) throw abortError();
        throw error;
      }

      if (response.status === 429) {
        await response.body?.cancel();
        if (attempt >= 3) throw new Error(`CDN ${this.providerLabel} ограничил загрузки. Повторите попытку позже.`);
        await wait(retryAfter(response, attempt), signal);
        continue;
      }

      if (!response.ok) throw new Error(`CDN ${this.providerLabel} вернул HTTP ${response.status}`);

      const finalUrl = response.url || url;
      if (!isAllowedCdn(finalUrl, this.allowedHosts)) {
        await response.body?.cancel();
        throw new Error(`${this.providerLabel} перенаправил загрузку на недоверенный CDN.`);
      }
      return response;
    }

    throw new Error(`CDN ${this.providerLabel} ограничил загрузки. Повторите попытку позже.`);
  }

  async download(options) {
    const { signal } = options;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.downloadOnce(options);
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError' || !isTransientNetworkError(error)) throw error;
        if (attempt === 2) {
          const detail = error?.message || String(error);
          const networkError = new Error(
            `Не удалось скачать файл с CDN ${this.providerLabel} после 3 попыток: ${detail}`
          );
          networkError.cause = error;
          throw networkError;
        }
        await wait(500 * (2 ** attempt), signal);
      }
    }
    throw new Error(`Не удалось скачать файл с CDN ${this.providerLabel}.`);
  }

  async downloadOnce({ url, destination, fileName, hashes, fileLength, signal, onProgress }) {
    const name = safeFilename(fileName);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.part`;
    const handle = await fsp.open(temporary, 'w');
    const hashList = expectedHashes(hashes);
    const digesters = hashList.map((item) => ({
      ...item,
      hash: crypto.createHash(item.algorithm)
    }));
    let received = 0;

    try {
      const response = await this.request(url, signal);
      if (!response.body) throw new Error(`CDN ${this.providerLabel} вернул пустой файл.`);
      const responseLength = Number(response.headers.get('content-length')) || 0;
      const totalBytes = Number(fileLength) || responseLength || 0;

      for await (const rawChunk of response.body) {
        if (signal?.aborted) throw abortError();
        const chunk = Buffer.from(rawChunk);
        received += chunk.length;
        if (received > MAX_FILE_SIZE) throw new Error('Размер файла превышает 1 ГБ.');
        for (const digester of digesters) digester.hash.update(chunk);

        let offset = 0;
        while (offset < chunk.length) {
          const result = await handle.write(chunk, offset, chunk.length - offset);
          if (result.bytesWritten === 0) throw new Error('Не удалось записать скачиваемый файл.');
          offset += result.bytesWritten;
        }

        onProgress?.({
          fileName: name,
          bytesReceived: received,
          totalBytes,
          percent: totalBytes ? Math.min(100, Math.round((received / totalBytes) * 100)) : null,
          deltaBytes: chunk.length
        });
      }

      await handle.close();
      if (fileLength && received !== Number(fileLength)) {
        throw new Error(`Размер файла не совпал: ожидалось ${fileLength}, получено ${received}.`);
      }
      for (const digester of digesters) {
        const actual = digester.hash.digest('hex');
        if (actual !== digester.value) {
          throw new Error(`Не совпала контрольная сумма ${digester.algorithm.toUpperCase()} для ${name}.`);
        }
      }

      await fsp.rm(destination, { force: true });
      await fsp.rename(temporary, destination);
      onProgress?.({ fileName: name, bytesReceived: received, totalBytes: received, percent: 100 });
      return { fileName: name, destination, bytesReceived: received };
    } catch (error) {
      await handle.close().catch(() => {});
      await fsp.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}

module.exports = { DownloadManager, expectedHashes, isAllowedCdn, safeFilename };

'use strict';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_SKIN_SIZE = 2 * 1024 * 1024;
const ALLOWED_DIMENSIONS = new Set(['64x64', '64x32']);

function inspectSkinPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length + 25) {
    throw new Error('Файл скина повреждён или слишком короткий.');
  }
  if (buffer.length > MAX_SKIN_SIZE) throw new Error('Размер PNG-скина не должен превышать 2 МБ.');
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Скин должен быть изображением PNG.');
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let hasImageData = false;
  let hasEnd = false;
  let firstChunk = true;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > buffer.length) throw new Error('Файл скина повреждён.');

    const type = buffer.toString('ascii', typeStart, dataStart);
    if (firstChunk) {
      firstChunk = false;
      if (type !== 'IHDR' || length !== 13) throw new Error('PNG-скин содержит некорректный заголовок.');
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
    } else if (type === 'IHDR') {
      throw new Error('PNG-скин содержит повторный заголовок.');
    }

    if (type === 'IDAT') hasImageData = true;
    if (type === 'IEND') {
      if (length !== 0 || chunkEnd !== buffer.length) throw new Error('PNG-скин содержит некорректный конец файла.');
      hasEnd = true;
      break;
    }
    offset = chunkEnd;
  }

  if (!hasImageData || !hasEnd) throw new Error('PNG-скин не содержит полных данных изображения.');
  if (!ALLOWED_DIMENSIONS.has(`${width}x${height}`)) {
    throw new Error('Размер скина Minecraft должен быть 64×64 или 64×32 пикселя.');
  }
  return { width, height };
}

function skinDataUrl(buffer) {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

module.exports = { inspectSkinPng, skinDataUrl, MAX_SKIN_SIZE };

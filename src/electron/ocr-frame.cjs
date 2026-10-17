'use strict';
const fs = require('node:fs/promises');
const { createSupplementaryPng } = require('./image-preprocess.cjs');
const MAX_WIDTH = 2560, MAX_HEIGHT = 1600, MAX_FILE_BYTES = 64 * 1024 * 1024;

// Both entry points cross this encoded-image boundary. There is no screen-only
// resize, colour conversion or OCR parameter path.
function prepareImageFrame(bytes, nativeImage) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_FILE_BYTES) throw Error('图片为空或超过 64 MB');
  const decoded = nativeImage.createFromBuffer(bytes);
  if (decoded.isEmpty()) throw Error('无法读取这张图片，请选择 PNG、JPG、WebP 或 BMP');
  const original = decoded.getSize();
  if (original.width * original.height > 40000000) throw Error('图片超过 4000 万像素，请先裁剪或缩小');
  const scale = Math.min(1, MAX_WIDTH / original.width, MAX_HEIGHT / original.height);
  const image = scale < 1 ? decoded.resize({ width: Math.round(original.width * scale), height: Math.round(original.height * scale), quality: 'best' }) : decoded;
  const { width, height } = image.getSize();
  const buffer = image.toPNG();
  return { buffer, width, height, originalWidth: original.width, originalHeight: original.height,
    makeSupplement: () => createSupplementaryPng(image, nativeImage),
    makeCrop: word => {
      const box = word.textBox || word;
      const padding = word.textBox ? Math.max(3, Math.min(8, Math.round(box.height * .06)))
        : Math.max(4, Math.min(24, Math.round(box.height * .25)));
      const x = Math.max(0, Math.floor(box.x - padding)), y = Math.max(0, Math.floor(box.y - padding));
      const right = Math.min(width, Math.ceil(box.x + box.width + padding));
      const bottom = Math.min(height, Math.ceil(box.y + box.height + padding));
      if (right <= x || bottom <= y) throw Error('无效的局部识别区域');
      const rect = { x, y, width: right - x, height: bottom - y };
      return { ...rect, buffer: image.crop(rect).toPNG() };
    } };
}
function frameFromCapture(image, nativeImage) {
  return prepareImageFrame(image.toPNG(), nativeImage);
}
async function frameFromFile(file, nativeImage) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw Error('请选择不超过 64 MB 的图片文件');
  return prepareImageFrame(await fs.readFile(file), nativeImage);
}
module.exports = { prepareImageFrame, frameFromCapture, frameFromFile };

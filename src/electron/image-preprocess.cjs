'use strict';

const GAME_CAPTION_THRESHOLD = 185;

function makeHighContrastBitmap(bitmap, width, height, threshold = GAME_CAPTION_THRESHOLD) {
  if (!Buffer.isBuffer(bitmap)) throw new TypeError('bitmap must be a Buffer');
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new RangeError('width and height must be positive integers');
  }
  if (bitmap.length < width * height * 4) {
    throw new RangeError('bitmap is smaller than the declared dimensions');
  }

  const output = Buffer.allocUnsafe(width * height * 4);
  for (let offset = 0; offset < output.length; offset += 4) {
    const blue = bitmap[offset];
    const green = bitmap[offset + 1];
    const red = bitmap[offset + 2];
    const luminance = (blue * 29 + green * 150 + red * 77) >> 8;
    const value = luminance > threshold ? 255 : 0;
    output[offset] = value;
    output[offset + 1] = value;
    output[offset + 2] = value;
    output[offset + 3] = 255;
  }
  return output;
}

function createHighContrastPng(image, nativeImage, threshold = GAME_CAPTION_THRESHOLD) {
  const size = image.getSize();
  const bitmap = makeHighContrastBitmap(image.toBitmap(), size.width, size.height, threshold);
  return nativeImage.createFromBitmap(bitmap, {
    width: size.width,
    height: size.height,
    scaleFactor: 1,
  }).toPNG();
}

// Keep the proven caption pass at its original working scale. It is only a
// supplement now: grey/blue text is retained by the native-colour primary pass.
function createSupplementaryPng(image, nativeImage) {
  const { width, height } = image.getSize();
  const scale = Math.min(1, 2200 / width, 1400 / height);
  const small = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' }) : image;
  const size = small.getSize();
  return {
    buffer: createHighContrastPng(small, nativeImage),
    mode: 'bright-text', scaleX: width / size.width, scaleY: height / size.height,
  };
}

module.exports = { GAME_CAPTION_THRESHOLD, createHighContrastPng, makeHighContrastBitmap, createSupplementaryPng };

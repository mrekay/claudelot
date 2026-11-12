// The VoxStorm logo (see logo.js) as a nativeImage for the window, tray and notifications,
// drawn at the size asked for, so the app needs no image files.
const { nativeImage } = require('electron');
const { rasterize } = require('./logo');

const cache = new Map();

function appIcon(size, scaleFactor = 1) {
  const px = Math.round(size * scaleFactor);
  const key = size + ':' + scaleFactor;
  if (cache.has(key)) return cache.get(key);
  const rgba = rasterize(px);
  const bgra = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) { bgra[i] = rgba[i + 2]; bgra[i + 1] = rgba[i + 1]; bgra[i + 2] = rgba[i]; bgra[i + 3] = rgba[i + 3]; }
  const img = nativeImage.createFromBuffer(bgra, { width: px, height: px, scaleFactor });
  cache.set(key, img);
  return img;
}

module.exports = { appIcon };

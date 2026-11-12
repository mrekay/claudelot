// Draws the VoxStorm mark (three stacked bars) into a raw bitmap,
// so the app needs no image files for the window, tray and notifications.
const { nativeImage } = require('electron');

const cache = new Map();

function appIcon(size, scaleFactor = 1) {
  const key = size + ':' + scaleFactor;
  if (cache.has(key)) return cache.get(key);
  const s = size;
  const buf = Buffer.alloc(s * s * 4); // BGRA, transparent
  const bars = [
    { x0: 0.06, y0: 0.10, x1: 0.94, y1: 0.32, c: [167, 139, 250] },
    { x0: 0.06, y0: 0.40, x1: 0.72, y1: 0.62, c: [139, 116, 214] },
    { x0: 0.06, y0: 0.70, x1: 0.50, y1: 0.92, c: [242, 177, 85] },
  ];
  const r = Math.max(1, Math.round(s * 0.07));
  for (const b of bars) {
    const X0 = Math.round(b.x0 * s), X1 = Math.round(b.x1 * s), Y0 = Math.round(b.y0 * s), Y1 = Math.round(b.y1 * s);
    for (let y = Y0; y < Y1; y++) {
      for (let x = X0; x < X1; x++) {
        // rounded corners
        const cx = x < X0 + r ? X0 + r : x >= X1 - r ? X1 - r - 1 : x;
        const cy = y < Y0 + r ? Y0 + r : y >= Y1 - r ? Y1 - r - 1 : y;
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        const i = (y * s + x) * 4;
        buf[i] = b.c[2]; buf[i + 1] = b.c[1]; buf[i + 2] = b.c[0]; buf[i + 3] = 255;
      }
    }
  }
  const img = nativeImage.createFromBuffer(buf, { width: s, height: s, scaleFactor });
  cache.set(key, img);
  return img;
}

module.exports = { appIcon };

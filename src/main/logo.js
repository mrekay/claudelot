// VoxStorm logo: a robot head shaped like a speech bubble, a lightning bolt for an antenna,
// on a storm-violet tile. One geometry (0..100 units) feeds both the raster icon (window,
// tray, notifications, build/icon.png) and the SVG used in the title bar.

const C = {
  top: [124, 108, 246],    // tile gradient, top-left
  bottom: [58, 40, 176],   // tile gradient, bottom-right
  head: [255, 255, 255],
  visor: [27, 21, 66],
  eye: [255, 201, 60],
  bolt: [255, 201, 60],
};
const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');

// paint order matters: later shapes cover earlier ones
const SHAPES = [
  { kind: 'rrect', x: 0, y: 0, w: 100, h: 100, r: 23, fill: 'tile' },
  { kind: 'poly', pts: [[54, 5], [40.5, 21.5], [48.5, 21.5], [43.5, 33], [60, 15.5], [52, 15.5], [57.5, 5]], fill: 'bolt' },
  { kind: 'rrect', x: 18, y: 30, w: 64, h: 47, r: 15, fill: 'head' },
  { kind: 'poly', pts: [[26, 70], [21, 88], [42, 75]], fill: 'head' },
  { kind: 'rrect', x: 27, y: 40, w: 46, h: 26, r: 11, fill: 'visor' },
  { kind: 'rrect', x: 37, y: 46.5, w: 7.5, h: 13, r: 3.75, fill: 'eye' },
  { kind: 'rrect', x: 55.5, y: 46.5, w: 7.5, h: 13, r: 3.75, fill: 'eye' },
];

function inRRect(px, py, s) {
  if (px < s.x || py < s.y || px > s.x + s.w || py > s.y + s.h) return false;
  const cx = Math.min(Math.max(px, s.x + s.r), s.x + s.w - s.r);
  const cy = Math.min(Math.max(py, s.y + s.r), s.y + s.h - s.r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= s.r * s.r;
}
function inPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function colorAt(px, py) {
  let col = null;
  for (const s of SHAPES) {
    const hit = s.kind === 'rrect' ? inRRect(px, py, s) : inPoly(px, py, s.pts);
    if (!hit) continue;
    if (s.fill === 'tile') {
      const t = Math.min(1, Math.max(0, (px + py) / 200));
      col = C.top.map((v, i) => v + (C.bottom[i] - v) * t);
    } else col = C[s.fill];
  }
  return col;
}

/* RGBA pixels, size x size, 4x4 supersampled */
function rasterize(size) {
  const out = Buffer.alloc(size * size * 4);
  const N = 4, k = 100 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
        const c = colorAt((x + (sx + 0.5) / N) * k, (y + (sy + 0.5) / N) * k);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
      }
      const i = (y * size + x) * 4;
      if (a) { out[i] = Math.round(r / a); out[i + 1] = Math.round(g / a); out[i + 2] = Math.round(b / a); out[i + 3] = Math.round((255 * a) / (N * N)); }
    }
  }
  return out;
}

/* the same logo as SVG markup (for the title bar / welcome window) */
function svg(px, id = 'vs') {
  const parts = SHAPES.map(s => {
    const fill = s.fill === 'tile' ? `url(#${id}g)` : hex(C[s.fill]);
    return s.kind === 'rrect'
      ? `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.r}" fill="${fill}"/>`
      : `<path d="M${s.pts.map(p => p.join(' ')).join('L')}Z" fill="${fill}"/>`;
  });
  return `<svg width="${px}" height="${px}" viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hex(C.top)}"/><stop offset="1" stop-color="${hex(C.bottom)}"/></linearGradient></defs>${parts.join('')}</svg>`;
}

module.exports = { rasterize, svg };

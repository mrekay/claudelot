// Writes build/icon.png (256x256) — the same three-bar mark the app draws at runtime.
// electron-builder turns it into the Windows .ico.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 256;
const px = Buffer.alloc(S * S * 4); // RGBA, transparent
const bars = [
  { x0: 0.06, y0: 0.10, x1: 0.94, y1: 0.32, c: [167, 139, 250] },
  { x0: 0.06, y0: 0.40, x1: 0.72, y1: 0.62, c: [139, 116, 214] },
  { x0: 0.06, y0: 0.70, x1: 0.50, y1: 0.92, c: [242, 177, 85] },
];
const r = Math.round(S * 0.07);
for (const b of bars) {
  const X0 = Math.round(b.x0 * S), X1 = Math.round(b.x1 * S), Y0 = Math.round(b.y0 * S), Y1 = Math.round(b.y1 * S);
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
    const cx = x < X0 + r ? X0 + r : x >= X1 - r ? X1 - r - 1 : x;
    const cy = y < Y0 + r ? Y0 + r : y >= Y1 - r ? Y1 - r - 1 : y;
    const d = Math.hypot(x - cx, y - cy);
    if (d > r + 0.5) continue;
    const a = d > r - 0.5 ? Math.round(255 * (r + 0.5 - d)) : 255; // soft edge
    const i = (y * S + x) * 4;
    px[i] = b.c[0]; px[i + 1] = b.c[1]; px[i + 2] = b.c[2]; px[i + 3] = a;
  }
}

// minimal PNG encoder
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buf => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');

// After `electron-builder --win`: copy the packed app.asar next to the installers and write
// dist/claudelot-update.json, which the in-app updater uses to pick and verify a download.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const { version } = require(path.join(root, 'package.json'));
const electron = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;

const asarName = `claudelot-app-${version}.asar`;
fs.copyFileSync(path.join(dist, 'win-unpacked', 'resources', 'app.asar'), path.join(dist, asarName));

const files = {};
for (const [key, name] of [['setup', `Claudelot-Setup-${version}.exe`], ['portable', `Claudelot-Portable-${version}.exe`], ['asar', asarName]]) {
  const p = path.join(dist, name);
  if (!fs.existsSync(p)) { console.error('missing', name); process.exit(1); }
  const buf = fs.readFileSync(p);
  files[key] = { name, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}
const manifest = { version, electron, files };
fs.writeFileSync(path.join(dist, 'claudelot-update.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));

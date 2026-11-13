// VoxStorm — plugins, main-process side.
//
// A plugin is a folder under %APPDATA%\VoxStorm\plugins\<id>\ with a manifest.json. Its code never
// runs here: the window loads it into sandboxed iframes from the voxplugin://<id>/ scheme served
// below (opaque origin, no Node, no preload, CSP without network unless it was granted). Everything a
// plugin may do outside its frame goes through the window's plugin host and, for files, commands and
// storage, through the IPC handlers here, which check the permissions the user granted again.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { spawn, execFile } = require('child_process');

// Windows' own zip support; paths go in as environment variables so nothing needs quoting
function psZip(script, env) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; " + script],
      { windowsHide: true, timeout: 120000, env: Object.assign({}, process.env, env) },
      (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().split('\n')[0])) : resolve()));
  });
}

const SCHEME = 'voxplugin';
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PERMS = ['notify', 'storage', 'fs.read', 'fs.write', 'shell', 'claude', 'net'];
const MAX_FILE = 5 * 1024 * 1024;
const MAX_STORE = 1024 * 1024;
const MAX_OUT = 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

// must run before app 'ready'
function registerScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
}

module.exports = function plugins({ app, ipcMain, protocol, shell, dialog, getWin, DATA, insideProject, ensureProject, getProjects }) {
  const DIR = path.join(DATA, 'plugins');
  const STORE = path.join(DATA, 'plugin-data');
  const STATE_FILE = path.join(DATA, 'plugins.json');
  const LOG_DIR = path.join(DATA, 'plugin-logs');
  const SDK_DIR = path.join(__dirname, '..', 'plugin-sdk');
  const FA_DIR = path.join(__dirname, '..', '..', 'node_modules', '@fortawesome', 'fontawesome-free');
  fs.mkdirSync(DIR, { recursive: true });

  // { [id]: { enabled, granted: [perm] } }
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch (_) {}
  const saveState = () => fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2)).catch(() => {});

  /* ---------------- reading plugins ---------------- */
  let cache = new Map(); // id -> plugin info (from the last scan)
  function readManifest(dir) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const id = String(raw.id || '').toLowerCase();
    if (!ID_RE.test(id)) throw new Error('manifest.json: "id" küçük harf, rakam, nokta, tire ve alt çizgiden oluşmalı');
    if (path.basename(dir).toLowerCase() !== id) throw new Error(`Klasör adı eklenti kimliğiyle ("${id}") aynı olmalı`);
    const str = (v, n) => String(v == null ? '' : v).slice(0, n);
    const permissions = [...new Set((Array.isArray(raw.permissions) ? raw.permissions : []).map(String))];
    const unknown = permissions.filter(p => !PERMS.includes(p));
    if (unknown.length) throw new Error('Bilinmeyen izin: ' + unknown.join(', '));
    const rel = v => { const s = str(v, 200).replace(/\\/g, '/').replace(/^\/+/, ''); if (s.split('/').includes('..')) throw new Error('Yol eklenti klasörünün dışına çıkamaz: ' + s); return s; };
    return {
      id, name: str(raw.name || id, 60), version: str(raw.version || '0.0.0', 20), description: str(raw.description, 300),
      author: str(raw.author, 80), icon: str(raw.icon || 'fa-solid fa-puzzle-piece', 60), main: raw.main ? rel(raw.main) : '', permissions,
    };
  }
  function scan() {
    const out = new Map();
    let ents = [];
    try { ents = fs.readdirSync(DIR, { withFileTypes: true }); } catch (_) {}
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const dir = path.join(DIR, e.name);
      if (!fs.existsSync(path.join(dir, 'manifest.json'))) continue;
      let m, error = '';
      try { m = readManifest(dir); } catch (err) { error = err.message; m = { id: e.name.toLowerCase(), name: e.name, version: '', description: '', author: '', icon: 'fa-solid fa-puzzle-piece', main: '', permissions: [] }; }
      const st = state[m.id] || {};
      const missing = m.permissions.filter(p => !(st.granted || []).includes(p));
      out.set(m.id, { ...m, dir, error, enabled: !!st.enabled && !error && !missing.length, wantsEnabled: !!st.enabled, needsGrant: missing });
    }
    cache = out;
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  }
  scan();
  const plugin = id => cache.get(String(id || '').toLowerCase());
  const can = (id, perm) => { const p = plugin(id); return !!(p && p.enabled && p.permissions.includes(perm) && ((state[p.id] || {}).granted || []).includes(perm)); };
  const need = (id, perm) => { if (!can(id, perm)) throw new Error(`Bu eklentinin "${perm}" izni yok`); };

  /* ---------------- voxplugin:// ---------------- */
  // a file inside base, after following links; null when it escapes
  async function inside(base, rel) {
    const target = path.resolve(base, rel);
    if (target !== base && !target.startsWith(base + path.sep)) return null;
    try {
      const real = await fsp.realpath(target), realBase = await fsp.realpath(base);
      if (real !== realBase && !real.startsWith(realBase + path.sep)) return null;
      return real;
    } catch (_) { return null; }
  }
  const csp = id => {
    const netOk = can(id, 'net');
    return [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'" + (netOk ? ' https:' : ''),
      "img-src 'self' data: blob:" + (netOk ? ' https:' : ''),
      "font-src 'self' data:" + (netOk ? ' https:' : ''),
      "media-src 'self' data: blob:" + (netOk ? ' https:' : ''),
      'connect-src ' + (netOk ? "'self' https: wss:" : "'self'"),
      "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
    ].join('; ');
  };
  const reply = (status, body, type, id) => new Response(body, {
    status,
    headers: { 'Content-Type': type || 'text/plain; charset=utf-8', 'Content-Security-Policy': csp(id), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
  const SDK_TAGS = '<link rel="stylesheet" href="/__vox__/base.css"><script src="/__vox__/sdk.js"></script>';
  async function serve(req) {
    let u;
    try { u = new URL(req.url); } catch (_) { return reply(400, 'bad url'); }
    const id = u.hostname.toLowerCase(), p = plugin(id);
    if (!p || !p.enabled) return reply(404, 'Eklenti yok ya da kapalı', null, id);
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    // the plugin's background page: the SDK plus its main script
    if (rel === '__vox__/main.html') {
      if (!p.main) return reply(404, 'main yok', null, id);
      return reply(200, `<!doctype html><meta charset="utf-8">${SDK_TAGS}<script src="/${encodeURI(p.main)}"></script>`, MIME['.html'], id);
    }
    let file;
    if (rel.startsWith('__vox__/')) {
      const r = rel.slice(8);
      if (r.startsWith('css/') || r.startsWith('webfonts/')) file = await inside(FA_DIR, r);
      else file = await inside(SDK_DIR, r);
    } else file = await inside(p.dir, rel || 'index.html');
    if (!file) return reply(404, 'Bulunamadı', null, id);
    let st;
    try { st = await fsp.stat(file); } catch (_) { return reply(404, 'Bulunamadı', null, id); }
    if (!st.isFile() || st.size > 20 * 1024 * 1024) return reply(404, 'Bulunamadı', null, id);
    const ext = path.extname(file).toLowerCase(), type = MIME[ext] || 'application/octet-stream';
    if (ext === '.html' || ext === '.htm') {
      // every page gets the SDK and the app's look first, so `vox` exists before the page's own scripts
      let html = await fsp.readFile(file, 'utf8');
      const m = html.match(/<head[^>]*>/i);
      html = m ? html.replace(m[0], m[0] + SDK_TAGS) : SDK_TAGS + html;
      return reply(200, html, type, id);
    }
    return reply(200, await fsp.readFile(file), type, id);
  }
  protocol.handle(SCHEME, req => serve(req).catch(e => reply(500, String(e && e.message || e))));

  /* ---------------- settings: list, enable, add, remove ---------------- */
  // projects the user limited a plugin to (project ids); none means every project
  const projectsOf = id => { const l = (state[String(id || '').toLowerCase()] || {}).projects; return Array.isArray(l) && l.length ? l : null; };
  const pub = p => ({ id: p.id, name: p.name, version: p.version, description: p.description, author: p.author, icon: p.icon, main: p.main, permissions: p.permissions, error: p.error, enabled: p.enabled, wantsEnabled: p.wantsEnabled, needsGrant: p.needsGrant, dir: p.dir, projects: projectsOf(p.id) || [] });
  ipcMain.handle('plugins:list', () => ({ dir: DIR, list: scan().map(pub) }));
  ipcMain.handle('plugins:setProjects', (_e, id, ids) => {
    const p = plugin(id);
    if (!p) throw new Error('Eklenti bulunamadı');
    const known = new Set(getProjects().map(x => x.id));
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter(x => known.has(x));
    state[p.id] = Object.assign({}, state[p.id], { projects: list });
    saveState();
    return pub(p);
  });
  ipcMain.handle('plugins:setEnabled', (_e, id, on, granted) => {
    scan();
    const p = plugin(id);
    if (!p) throw new Error('Eklenti bulunamadı');
    if (on && p.error) throw new Error(p.error);
    // the window asked the user; grant exactly what the manifest lists, nothing else
    state[p.id] = Object.assign({}, state[p.id], { enabled: !!on, granted: on ? p.permissions.filter(x => (granted || []).includes(x)) : ((state[p.id] || {}).granted || []) });
    saveState();
    return pub(scan().find(x => x.id === p.id));
  });
  ipcMain.handle('plugins:openDir', (_e, id) => { const p = id ? plugin(id) : null; shell.openPath(p ? p.dir : DIR); });
  ipcMain.handle('plugins:remove', async (_e, id) => {
    const p = plugin(id);
    if (!p) return false;
    await shell.trashItem(p.dir);
    delete state[p.id]; saveState();
    await fsp.rm(path.join(STORE, p.id + '.json'), { force: true }).catch(() => {});
    scan();
    return true;
  });
  const skipJunk = src => s => !/[\\/](node_modules|\.git)([\\/]|$)/.test(s.slice(src.length));
  // copy a plugin folder into the plugins folder (named after its id)
  async function install(src) {
    if (!fs.existsSync(path.join(src, 'manifest.json'))) throw new Error('Seçilen yerde manifest.json yok.');
    const raw = JSON.parse(await fsp.readFile(path.join(src, 'manifest.json'), 'utf8'));
    const id = String(raw.id || '').toLowerCase();
    if (!ID_RE.test(id)) throw new Error('manifest.json içindeki "id" geçersiz.');
    const dest = path.join(DIR, id);
    if (path.resolve(src).toLowerCase() === dest.toLowerCase()) return { id };
    if (fs.existsSync(dest)) await shell.trashItem(dest); // updating: the old copy goes to the Recycle Bin
    await fsp.cp(src, dest, { recursive: true, filter: skipJunk(src) });
    if (state[id]) { state[id].enabled = false; saveState(); } // new code: ask again before running it
    scan();
    return { id };
  }
  ipcMain.handle('plugins:addFolder', async () => {
    const r = await dialog.showOpenDialog(getWin(), { title: 'Eklenti klasörü seç (içinde manifest.json olmalı)', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return install(r.filePaths[0]);
  });
  // a plugin exported from VoxStorm (or any zip whose root, or single folder, holds manifest.json)
  ipcMain.handle('plugins:addZip', async () => {
    const r = await dialog.showOpenDialog(getWin(), { title: 'Eklenti dosyası seç', filters: [{ name: 'VoxStorm eklentisi', extensions: ['zip'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'voxstorm-plugin-'));
    try {
      await psZip('Expand-Archive -LiteralPath $env:VOX_ZIP -DestinationPath $env:VOX_OUT -Force', { VOX_ZIP: r.filePaths[0], VOX_OUT: tmp });
      let src = tmp;
      if (!fs.existsSync(path.join(src, 'manifest.json'))) {
        const dirs = (await fsp.readdir(tmp, { withFileTypes: true })).filter(e => e.isDirectory());
        if (dirs.length === 1) src = path.join(tmp, dirs[0].name);
      }
      return await install(src);
    } finally { fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
  });
  // <id>-<version>.zip with the plugin's folder inside; its data and granted permissions stay here
  ipcMain.handle('plugins:export', async (_e, id) => {
    const p = plugin(id);
    if (!p) throw new Error('Eklenti bulunamadı');
    const r = await dialog.showSaveDialog(getWin(), {
      title: `${p.name} eklentisini dışa aktar`, defaultPath: path.join(app.getPath('downloads'), `${p.id}-${p.version || '0.0.0'}.zip`),
      filters: [{ name: 'VoxStorm eklentisi', extensions: ['zip'] }],
    });
    if (r.canceled || !r.filePath) return null;
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'voxstorm-export-'));
    try {
      const stage = path.join(tmp, p.id);
      await fsp.cp(p.dir, stage, { recursive: true, filter: skipJunk(p.dir) });
      await fsp.rm(r.filePath, { force: true });
      await psZip('Compress-Archive -LiteralPath $env:VOX_SRC -DestinationPath $env:VOX_ZIP -Force', { VOX_SRC: stage, VOX_ZIP: r.filePath });
      return { file: r.filePath };
    } finally { fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
  });
  // a working example to start from
  ipcMain.handle('plugins:createSample', async () => {
    const id = 'hizli-notlar';
    const dest = path.join(DIR, id);
    if (!fs.existsSync(dest)) await fsp.cp(path.join(SDK_DIR, 'sample'), dest, { recursive: true });
    scan();
    return { id, dir: dest };
  });

  /* ---------------- plugin API: storage ---------------- */
  const stores = new Map();
  async function store(id) {
    if (stores.has(id)) return stores.get(id);
    let o = {};
    try { o = JSON.parse(await fsp.readFile(path.join(STORE, id + '.json'), 'utf8')) || {}; } catch (_) {}
    stores.set(id, o);
    return o;
  }
  ipcMain.handle('plugin:storage', async (_e, id, op, key, value) => {
    need(id, 'storage');
    const o = await store(plugin(id).id);
    if (op === 'keys') return Object.keys(o);
    key = String(key).slice(0, 200);
    if (op === 'get') return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : null;
    if (op === 'set') {
      const next = { ...o, [key]: value };
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_STORE) throw new Error('Eklenti deposu 1 MB sınırını aşıyor');
      o[key] = value;
    } else if (op === 'remove') delete o[key];
    else throw new Error('Bilinmeyen işlem');
    await fsp.mkdir(STORE, { recursive: true });
    await fsp.writeFile(path.join(STORE, plugin(id).id + '.json'), JSON.stringify(o));
    return true;
  });

  /* ---------------- plugin API: project files ---------------- */
  // inside one of the projects the user allowed this plugin (all projects when none were chosen)
  function allowedFor(id, p) {
    const ids = projectsOf(id);
    if (!ids) return true;
    const n = path.resolve(p).toLowerCase();
    return getProjects().filter(x => ids.includes(x.id)).some(x => { const r = path.resolve(x.path).toLowerCase(); return n === r || n.startsWith(r + path.sep); });
  }
  async function guardPath(p, id) {
    if (typeof p !== 'string' || !p || p.includes('\0') || !path.isAbsolute(p) || !insideProject(p)) throw new Error('Yalnızca VoxStorm\'a ekli projelerin içindeki dosyalara erişilebilir');
    if (!allowedFor(id, p)) throw new Error('Bu eklenti yalnızca seçilen projelerde çalışabilir (Ayarlar → Eklentiler → Projeler)');
    const abs = path.resolve(p);
    // links inside a project must not lead out of it
    let probe = abs;
    while (probe && !fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
    const real = await fsp.realpath(probe).catch(() => probe);
    if (!insideProject(real) || !allowedFor(id, real)) throw new Error('Yalnızca VoxStorm\'a ekli projelerin içindeki dosyalara erişilebilir');
    // VoxStorm's own folder (other plugins' code, their data, settings) is never a plugin's to touch,
    // even when the plugins folder is added as a project for writing plugins
    const data = path.resolve(DATA).toLowerCase();
    for (const x of [abs, real]) {
      const l = path.resolve(x).toLowerCase();
      if (l === data || l.startsWith(data + path.sep)) throw new Error('Eklentiler VoxStorm\'un kendi klasörüne erişemez');
    }
    return abs;
  }
  ipcMain.handle('plugin:fs', async (_e, id, op, p, data) => {
    if (op === 'write' || op === 'mkdir') need(id, 'fs.write'); else need(id, 'fs.read');
    const abs = await guardPath(p, id);
    if (op === 'read') {
      const st = await fsp.stat(abs);
      if (st.size > MAX_FILE) throw new Error('Dosya 5 MB\'tan büyük');
      return fsp.readFile(abs, 'utf8');
    }
    if (op === 'list') return (await fsp.readdir(abs, { withFileTypes: true })).map(e => ({ name: e.name, dir: e.isDirectory() }));
    if (op === 'stat') { const st = await fsp.stat(abs); return { size: st.size, dir: st.isDirectory(), mtime: st.mtimeMs }; }
    if (op === 'write') {
      const s = String(data == null ? '' : data);
      if (Buffer.byteLength(s) > MAX_FILE) throw new Error('İçerik 5 MB\'tan büyük');
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, s, 'utf8');
      return true;
    }
    if (op === 'mkdir') { await fsp.mkdir(abs, { recursive: true }); return true; }
    throw new Error('Bilinmeyen işlem');
  });

  /* ---------------- plugin API: run a command ---------------- */
  const running = new Map(); // plugin id -> Set(child)
  // the whole tree: a command usually starts bash, ssh, node... under PowerShell
  const killTree = child => {
    child.stopped = true;
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch (_) { try { child.kill(); } catch (__) {} }
  };
  ipcMain.handle('plugin:shell', async (e, id, command, opts) => {
    need(id, 'shell');
    const cwd = await guardPath(String((opts && opts.cwd) || ''), id);
    const timeout = Math.min(Math.max(+((opts && opts.timeout) || 60000), 1000), 60 * 60000);
    const runId = opts && /^[\w-]{1,40}$/.test(String(opts.runId || '')) ? String(opts.runId) : '';
    const { StringDecoder } = require('string_decoder');
    return new Promise(resolve => {
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ' + String(command)], { cwd, windowsHide: true });
      const set = running.get(id) || new Set(); set.add(child); running.set(id, set);
      let out = '', err = '', done = false, timedOut = false;
      // live output for the page that asked (runId); the full text still comes back at the end
      const pipe = (stream, name, onText) => {
        const dec = new StringDecoder('utf8');
        stream.on('data', d => {
          const s = dec.write(d);
          if (!s) return;
          onText(s);
          if (runId && !e.sender.isDestroyed()) e.sender.send('plugin:shell-out', id, runId, name, s);
        });
      };
      pipe(child.stdout, 'stdout', s => { if (out.length < MAX_OUT) out += s; });
      pipe(child.stderr, 'stderr', s => { if (err.length < MAX_OUT) err += s; });
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
      const finish = (code, error) => {
        if (done) return; done = true;
        clearTimeout(timer); set.delete(child);
        resolve({ code, stdout: out.slice(0, MAX_OUT), stderr: err.slice(0, MAX_OUT), error: error || (timedOut ? 'Süre sınırı aşıldı' : child.stopped ? 'Durduruldu' : ''), stopped: !!child.stopped });
      };
      child.on('error', er => finish(-1, er.message));
      child.on('close', code => finish(code));
    });
  });
  // vox.shell.stop(), and turning a plugin off or reloading it, stops what it started
  ipcMain.handle('plugin:stop', (_e, id) => {
    for (const c of running.get(id) || []) killTree(c);
    running.delete(id);
  });

  // a plugin's frames may only ever show voxplugin:// pages
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-frame-navigate', ev => {
      if (ev.isMainFrame) return;
      if (!String(ev.url).startsWith(SCHEME + '://')) ev.preventDefault();
    });
  });

  /* ---------------- writing plugins: logs, hot reload, Claude setup ---------------- */
  // errors and vox.log() lines, so whoever writes the plugin (a person or Claude) can read them
  ipcMain.handle('plugins:log', async (_e, id, level, text) => {
    const p = plugin(id);
    if (!p) return false;
    await fsp.mkdir(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, p.id + '.log');
    try {
      const st = await fsp.stat(file);
      if (st.size > 256 * 1024) await fsp.writeFile(file, (await fsp.readFile(file, 'utf8')).slice(-128 * 1024));
    } catch (_) {}
    const body = String(text || '').split(/\r?\n/).join('\n    ');
    await fsp.appendFile(file, `[${new Date().toISOString()}] ${String(level || 'info').toUpperCase()} ${body}\n`, 'utf8');
    return true;
  });
  // any change inside a plugin's folder reloads that plugin in the window
  const timers = new Map();
  try {
    fs.watch(DIR, { recursive: true }, (_ev, file) => {
      if (!file) return;
      const parts = String(file).split(/[\\/]/);
      if (parts.some(x => x === 'node_modules' || x === '.git')) return;
      // loose files in the plugins folder itself (CLAUDE.md and the like) belong to no plugin
      if (parts.length < 2 && !fs.existsSync(path.join(DIR, parts[0], 'manifest.json'))) return;
      const id = parts[0].toLowerCase();
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        scan();
        const w = getWin();
        if (w && !w.isDestroyed()) w.webContents.send('plugins:changed', id);
      }, 350));
    });
  } catch (_) {}
  // a Claude session that writes plugins works in the plugins folder: give it the guide as CLAUDE.md
  // and make the folder a project so the session (and the IDE) can open it
  ipcMain.handle('plugins:devSetup', async () => {
    const guide = await fsp.readFile(path.join(SDK_DIR, 'REHBER.md'), 'utf8');
    const head = (await fsp.readFile(path.join(SDK_DIR, 'CLAUDE.template.md'), 'utf8'))
      .split('{{PLUGINS_DIR}}').join(DIR).split('{{LOG_DIR}}').join(LOG_DIR);
    await fsp.writeFile(path.join(DIR, 'CLAUDE.md'), head + '\n\n' + guide, 'utf8');
    const project = ensureProject(DIR, 'VoxStorm eklentileri');
    return { project, dir: DIR, logDir: LOG_DIR };
  });

  return { scan, PERMS };
};
module.exports.registerScheme = registerScheme;
module.exports.SCHEME = SCHEME;

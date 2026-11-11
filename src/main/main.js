// Claudelot — main process
// Window + tray, terminal processes (node-pty), Claude Code hook listener,
// session history / usage from ~/.claude, project file access for IDE mode.
const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const pty = require('@lydell/node-pty');
const { appIcon } = require('./icon');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
app.setAppUserModelId('Claudelot');

const DATA = app.getPath('userData');
const CONFIG_FILE = path.join(DATA, 'config.json');
const HOOK_SETTINGS = path.join(DATA, 'hooks-settings.json');
const APPEND_PROMPT = path.join(DATA, 'append-prompt.txt');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

let win = null;
let tray = null;
let isQuitting = false;
let hookPort = 0;
let trayStats = { running: 0, pending: 0 };
const ptys = new Map();
const liveNotifications = new Set();

/* ---------------- config ---------------- */
const DEFAULTS = {
  projects: [],
  lastTabs: [], // terminals that were open last time: {projectId, kind, shell, sessionId, title}
  settings: {
    name: 'Başkanım', tone: 'samimi', lang: 'tr', extra: '',
    closeToTray: true, autostart: false, sound: true, welcome: true,
    // defaults for every Claude session Claudelot starts ('' = leave it to Claude Code)
    claude: { model: '', effort: '', permissionMode: '', remoteControl: false },
    notif: { done: true, decision: true, subagent: true, workflow: true, quiet: false },
    skin: 'mono', mode: 'claude', termColors: 'windows',
    ui: { side: true, queue: true, usage: true }, // which side panels are open
  },
  ide: { state: {}, ui: { ex: true, panel: true, size: 13 } },
};
function merge(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const k of Object.keys(extra || {})) out[k] = k in base ? merge(base[k], extra[k]) : extra[k];
  return out;
}
let firstRun = !fs.existsSync(CONFIG_FILE);
let config = DEFAULTS;
try { config = merge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch (_) { config = merge(DEFAULTS, {}); }
let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  }, 300);
}
function saveConfigNow() {
  clearTimeout(saveTimer);
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (_) {}
}

/* ---------------- helpers ---------------- */
const send = (ch, ...args) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ...args); };
const encodeProjectDir = p => p.replace(/[^a-zA-Z0-9]/g, '-');
const norm = p => path.resolve(p).toLowerCase();

function insideProject(p) {
  const n = norm(p);
  return config.projects.some(pr => { const r = norm(pr.path); return n === r || n.startsWith(r + path.sep); });
}

function whereFirst(name) {
  try {
    const out = execFileSync('where', [name], { encoding: 'utf8', windowsHide: true });
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (_) { return []; }
}
let claudePath = null;
function findClaude() {
  if (claudePath && fs.existsSync(claudePath)) return claudePath;
  const found = whereFirst('claude');
  claudePath = found.find(f => f.toLowerCase().endsWith('.exe')) || found.find(f => f.toLowerCase().endsWith('.cmd')) || null;
  if (!claudePath) {
    const guess = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
    if (fs.existsSync(guess)) claudePath = guess;
  }
  return claudePath;
}
function findShell(kind) {
  if (kind === 'cmd') return { file: 'cmd.exe', args: [] };
  if (kind === 'bash') {
    const cands = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe', ...whereFirst('bash').filter(p => !/system32/i.test(p))];
    const f = cands.find(c => fs.existsSync(c));
    if (!f) throw new Error('Git Bash bulunamadı.');
    return { file: f, args: ['--login', '-i'] };
  }
  const pw = whereFirst('pwsh')[0];
  return { file: pw || 'powershell.exe', args: ['-NoLogo'] };
}

/* ---------------- read head of a file ---------------- */
async function readHead(file, bytes) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.slice(0, bytesRead).toString('utf8');
  } finally { await fh.close(); }
}
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(c => c && c.type === 'text').map(c => c.text).join(' ');
  return '';
}

/* ---------------- session history ---------------- */
const titleCache = new Map(); // file -> {mtime, title, cwd}
async function sessionMeta(file, mtimeMs) {
  const c = titleCache.get(file);
  if (c && c.mtime === mtimeMs) return c;
  let title = '', cwd = '', custom = '';
  try {
    const head = await readHead(file, 256 * 1024);
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      if (!cwd && o.cwd) cwd = o.cwd;
      if (o.type === 'custom-title' && o.customTitle) custom = o.customTitle;
      if (!title && o.type === 'user' && !o.isSidechain && !o.isMeta && o.message) {
        const t = textOf(o.message.content).trim();
        if (t && !t.startsWith('<') && !t.startsWith('Caveat:')) title = t;
      }
      if (title && cwd) break;
    }
  } catch (_) {}
  const meta = { mtime: mtimeMs, title: (custom || title || 'Adsız oturum').replace(/\s+/g, ' ').slice(0, 120), cwd };
  titleCache.set(file, meta);
  return meta;
}
async function listSessions(projectPath) {
  const dir = path.join(PROJECTS_DIR, encodeProjectDir(projectPath));
  let files;
  try { files = (await fsp.readdir(dir)).filter(f => f.endsWith('.jsonl')); } catch (_) { return []; }
  const stats = await Promise.all(files.map(async f => {
    const full = path.join(dir, f);
    try { const st = await fsp.stat(full); return { full, id: f.slice(0, -6), mtime: st.mtimeMs, size: st.size }; } catch (_) { return null; }
  }));
  const list = stats.filter(s => s && s.size > 0).sort((a, b) => b.mtime - a.mtime).slice(0, 40);
  const out = [];
  for (const s of list) {
    const m = await sessionMeta(s.full, s.mtime);
    out.push({ id: s.id, title: m.title, mtime: s.mtime });
  }
  return out;
}
async function discoverProjects() {
  let dirs;
  try { dirs = await fsp.readdir(PROJECTS_DIR); } catch (_) { return []; }
  const found = [];
  for (const d of dirs) {
    const full = path.join(PROJECTS_DIR, d);
    let files;
    try { files = (await fsp.readdir(full)).filter(f => f.endsWith('.jsonl')); } catch (_) { continue; }
    let newest = null;
    for (const f of files) {
      try { const st = await fsp.stat(path.join(full, f)); if (!newest || st.mtimeMs > newest.mtime) newest = { f, mtime: st.mtimeMs }; } catch (_) {}
    }
    if (!newest) continue;
    const meta = await sessionMeta(path.join(full, newest.f), newest.mtime);
    if (meta.cwd && fs.existsSync(meta.cwd) && encodeProjectDir(meta.cwd) === d) found.push({ path: meta.cwd, mtime: newest.mtime });
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

/* ---------------- weekly usage (tokens from transcripts) ---------------- */
/* API list prices, $ per million tokens (Anthropic first-party, Nov 2026).
   read = cache read price; cache writes cost 1.25x input (5 min) or 2x input (1 hour).
   A subscription plan is not billed this way — this is the API-equivalent value. */
const PRICES = [
  ['claude-fable-5-2', 8, 40, 0.20], ['claude-mythos-5-2', 8, 40, 0.20],
  ['claude-fable-5-1', 10, 50], ['claude-mythos-5-1', 10, 50], ['claude-fable-5', 10, 50], ['claude-mythos-5', 10, 50],
  ['claude-opus-5-5', 4, 20, 0.20], ['claude-opus-5', 5, 25], ['claude-opus-4-8', 5, 25], ['claude-opus-4-7', 5, 25], ['claude-opus-4-6', 5, 25],
  ['claude-sonnet-5-5', 2, 10, 0.10], ['claude-sonnet-5', 2, 10], ['claude-sonnet-4-6', 3, 15],
  ['claude-haiku-5-5', 0.10, 0.50], ['claude-haiku-4-5', 1, 5],
];
function priceOf(model) {
  if (!model) return null;
  // longest matching id wins, so "claude-opus-5-5" is not priced as "claude-opus-5"
  let best = null;
  for (const p of PRICES) if (model.startsWith(p[0]) && (!best || p[0].length > best[0].length)) best = p;
  if (!best) return null;
  const [, input, out, read] = best;
  return { input, out, read: read != null ? read : input * 0.1 };
}
function messageCost(model, u) {
  const p = priceOf(model);
  if (!p) return null;
  const cc = u.cache_creation || {};
  const w1h = cc.ephemeral_1h_input_tokens || 0;
  const w5m = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : Math.max(0, (u.cache_creation_input_tokens || 0) - w1h);
  const fast = u.speed === 'fast' ? 2 : 1;
  return fast * ((u.input_tokens || 0) * p.input + (u.output_tokens || 0) * p.out + w5m * p.input * 1.25 + w1h * p.input * 2 + (u.cache_read_input_tokens || 0) * p.read) / 1e6;
}

let usageCache = null, usageRun = null;
function computeUsage() {
  // share one in-flight scan between callers instead of returning a stale/empty result
  if (!usageRun) usageRun = scanUsage().finally(() => { usageRun = null; });
  return usageRun;
}
/* Usage = every assistant message in ~/.claude/projects, deduplicated by message id.
   Claude Code deletes transcripts after ~30 days, so daily totals are also kept in
   usage-history.json; days that no longer have transcripts come from there. */
const USAGE_HISTORY = path.join(DATA, 'usage-history.json');
const fileCache = new Map(); // transcript path -> { mtime, size, entries: [{id, ts, model, proj, t, o, c}] }
let usageHistory = null;     // 'YYYY-MM-DD' -> { t, c, rows: { 'proj|model': [tokens, output, usd] } }
const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function listTranscripts() {
  const out = [];
  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS_DIR); } catch (_) {}
  for (const d of dirs) {
    const walk = async (p, depth) => {
      let ents; try { ents = await fsp.readdir(p, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        const fp = path.join(p, e.name);
        if (e.isDirectory() && depth < 3) await walk(fp, depth + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ fp, proj: d });
      }
    };
    await walk(path.join(PROJECTS_DIR, d), 0);
  }
  return out;
}
async function parseTranscript(fp, proj) {
  const entries = [];
  let text; try { text = await fsp.readFile(fp, 'utf8'); } catch (_) { return entries; }
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    const m = o.message; if (!m || !m.usage || !o.timestamp) continue;
    const ts = Date.parse(o.timestamp); if (!ts) continue;
    const u = m.usage;
    entries.push({
      id: m.id || o.uuid, ts, model: m.model || '?', proj,
      t: (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0),
      o: u.output_tokens || 0, c: messageCost(m.model, u),
    });
  }
  return entries;
}
async function scanUsage() {
  if (!usageHistory) { try { usageHistory = JSON.parse(await fsp.readFile(USAGE_HISTORY, 'utf8')); } catch (_) { usageHistory = {}; } }
  const files = await listTranscripts();
  const seen = new Set();
  for (const { fp, proj } of files) {
    seen.add(fp);
    let st; try { st = await fsp.stat(fp); } catch (_) { continue; }
    const c = fileCache.get(fp);
    if (c && c.mtime === st.mtimeMs && c.size === st.size) continue;
    fileCache.set(fp, { mtime: st.mtimeMs, size: st.size, entries: await parseTranscript(fp, proj) });
  }
  for (const k of [...fileCache.keys()]) if (!seen.has(k)) fileCache.delete(k);

  // last line per message id wins (streaming writes the same message more than once)
  const msgs = new Map();
  for (const f of fileCache.values()) for (const e of f.entries) msgs.set(e.id, e);
  const fresh = {};
  for (const e of msgs.values()) {
    const k = dayKey(e.ts);
    const day = fresh[k] || (fresh[k] = { t: 0, c: 0, rows: {} });
    const rk = e.proj + '|' + e.model;
    const row = day.rows[rk] || (day.rows[rk] = [0, 0, 0]);
    row[0] += e.t; row[1] += e.o; row[2] += e.c || 0;
    day.t += e.t; day.c += e.c || 0;
  }
  // merge: keep whichever is larger, so a day partly cleaned up by Claude Code never shrinks
  for (const [k, day] of Object.entries(fresh)) {
    if (!usageHistory[k] || day.t >= usageHistory[k].t) usageHistory[k] = day;
  }
  try { await fsp.writeFile(USAGE_HISTORY, JSON.stringify(usageHistory)); } catch (_) {}

  const now = new Date();
  const monday = new Date(now); monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const days = [0, 0, 0, 0, 0, 0, 0], dayCost = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday); d.setDate(monday.getDate() + i);
    const rec = usageHistory[dayKey(d.getTime())];
    if (rec) { days[i] = rec.t; dayCost[i] = rec.c; }
  }
  const keys = Object.keys(usageHistory).sort();
  usageCache = {
    days, dayCost, total: days.reduce((a, b) => a + b, 0), cost: dayCost.reduce((a, b) => a + b, 0),
    today: (now.getDay() + 6) % 7, weekStart: monday.getTime(), at: Date.now(),
    firstDay: keys[0] || null,
  };
  return usageCache;
}
ipcMain.handle('usage:history', async () => { await computeUsage(); return usageHistory; });
ipcMain.handle('usage:exportCsv', async (_e, month) => {
  await computeUsage();
  const names = Object.fromEntries(config.projects.map(p => [encodeProjectDir(p.path), p.name]));
  const r = await dialog.showSaveDialog(win, {
    title: 'Kullanımı CSV olarak kaydet',
    defaultPath: path.join(app.getPath('documents'), `claude-kullanim-${month || 'tum'}.csv`),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const lines = ['tarih;proje;model;token;cikti_token;usd'];
  for (const k of Object.keys(usageHistory).sort()) {
    if (month && !k.startsWith(month)) continue;
    for (const [rk, [t, o, c]] of Object.entries(usageHistory[k].rows || {})) {
      const [proj, model] = rk.split('|');
      lines.push([k, names[proj] || proj, model, t, o, c.toFixed(4).replace('.', ',')].join(';'));
    }
  }
  await fsp.writeFile(r.filePath, '﻿' + lines.join('\r\n'), 'utf8'); // BOM so Excel reads Turkish characters
  return r.filePath;
});

/* ---------------- hooks ---------------- */
function writeHookSettings() {
  const url = `http://127.0.0.1:${hookPort}/hook`;
  const command = `curl.exe -s -m 3 -X POST -H "Content-Type: application/json" --data-binary @- ${url}`;
  const h = [{ type: 'command', command, timeout: 5 }];
  const settings = {
    hooks: {
      SessionStart: [{ hooks: h }],
      SessionEnd: [{ hooks: h }],
      UserPromptSubmit: [{ hooks: h }],
      Stop: [{ hooks: h }],
      SubagentStop: [{ hooks: h }],
      Notification: [{ hooks: h }],
      PreToolUse: [{ matcher: '*', hooks: h }],
      PostToolUse: [{ matcher: '*', hooks: h }],
    },
  };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(HOOK_SETTINGS, JSON.stringify(settings, null, 2));
}
function startHookServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') { res.end(''); return; }
      const chunks = []; let size = 0;
      req.on('data', c => { chunks.push(c); size += c.length; if (size > 5e6) req.destroy(); });
      req.on('end', () => {
        res.end('');
        let ev; try { ev = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { return; }
        send('hook', ev);
      });
    });
    server.listen(0, '127.0.0.1', () => { hookPort = server.address().port; writeHookSettings(); resolve(); });
  });
}

/* ---------------- "how to address me" prompt ---------------- */
const TONES = {
  samimi: 'Samimi, rahat bir dille konuş.',
  resmi: 'Resmi ve saygılı bir dille konuş.',
  kisa: 'Kısa ve öz cevap ver, gereksiz açıklama yapma.',
};
const LANGS = { tr: 'Türkçe', en: 'İngilizce' };
function buildAppendPrompt() {
  const s = config.settings;
  const lines = ['Kullanıcı tercihleri (Claudelot):'];
  if ((s.name || '').trim()) lines.push(`- Kullanıcıya "${s.name.trim()}" diye hitap et.`);
  if (TONES[s.tone]) lines.push('- ' + TONES[s.tone]);
  if (LANGS[s.lang]) lines.push(`- Yanıtlarını ${LANGS[s.lang]} ver.`);
  (s.extra || '').split('\n').map(x => x.trim()).filter(Boolean).forEach(x => lines.push('- ' + x));
  return lines.join('\n');
}
function writeAppendPrompt() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(APPEND_PROMPT, buildAppendPrompt());
}

/* ---------------- terminals ---------------- */
function spawnTerminal(opts) {
  const id = crypto.randomUUID();
  let file, args = [], sessionId = null;
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
  if (opts.kind === 'claude') {
    const exe = findClaude();
    if (!exe) throw new Error('claude komutu bulunamadı. Claude Code kurulu ve PATH içinde olmalı.');
    if (opts.resume) { args.push('--resume', opts.resume); sessionId = opts.resume; }
    else { sessionId = crypto.randomUUID(); args.push('--session-id', sessionId); }
    args.push('--settings', HOOK_SETTINGS);
    const cs = { ...(config.settings.claude || {}), ...(opts.overrides || {}) };
    if (cs.model) args.push('--model', cs.model);
    if (cs.effort) args.push('--effort', cs.effort);
    if (cs.permissionMode) args.push('--permission-mode', cs.permissionMode);
    if (cs.remoteControl) args.push('--remote-control', opts.rcName || 'Claudelot');
    writeAppendPrompt();
    args.push('--append-system-prompt-file', APPEND_PROMPT);
    if (exe.toLowerCase().endsWith('.cmd')) { file = 'cmd.exe'; args = ['/c', exe, ...args]; }
    else file = exe;
  } else {
    const sh = findShell(opts.shell);
    file = sh.file; args = sh.args;
  }
  // drop per-session markers in case Claudelot itself was started from inside a Claude Code session
  const env = { ...process.env, CLAUDELOT: '1', FORCE_COLOR: '1' };
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || /^CLAUDE_CODE_(CHILD_SESSION|ENTRYPOINT|SSE_PORT|SESSION_ID)/.test(k)) delete env[k];
  const p = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: Math.max(20, opts.cols || 120),
    rows: Math.max(5, opts.rows || 30),
    cwd,
    env,
  });
  p.onData(d => send('pty:data', id, d));
  p.onExit(({ exitCode }) => { ptys.delete(id); send('pty:exit', id, exitCode); });
  ptys.set(id, p);
  return { id, sessionId };
}
function killAll() {
  for (const p of ptys.values()) { try { p.kill(); } catch (_) {} }
  ptys.clear();
}

/* ---------------- window / tray ---------------- */
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
async function quitFlow() {
  const n = ptys.size;
  if (n > 0) {
    if (win && !win.isVisible()) showWindow();
    const r = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['Çık', 'Vazgeç'], defaultId: 1, cancelId: 1, noLink: true,
      title: 'Claudelot', message: `${n} terminal hâlâ açık. Çıkılsın mı?`,
      detail: 'Terminaller kapanır. Claude oturumları geçmişte kalır, sonra kaldığın yerden devam edebilirsin.',
    });
    if (r.response !== 0) return;
  }
  isQuitting = true;
  killAll();
  saveConfigNow();
  app.quit();
}
/* ---------------- welcome window ---------------- */
let welcome = null;
let pendingOpen = null; // what the welcome window asked the main window to do
function showWelcome() {
  if (welcome && !welcome.isDestroyed()) { welcome.show(); welcome.focus(); return; }
  welcome = new BrowserWindow({
    width: 880, height: 580, resizable: false, maximizable: false, minimizable: true,
    frame: false, backgroundColor: '#0b0a12', show: false, title: 'Claudelot', center: true,
    icon: appIcon(64, 1),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  welcome.loadFile(path.join(__dirname, '..', 'renderer', 'welcome.html'));
  welcome.once('ready-to-show', () => welcome.show());
  welcome.webContents.on('will-navigate', e => e.preventDefault());
  welcome.on('closed', () => { welcome = null; rebuildTrayMenu(); });
}
function closeWelcome() { if (welcome && !welcome.isDestroyed()) welcome.close(); }
async function welcomeData() {
  const projects = await Promise.all(config.projects.map(async p => {
    const list = fs.existsSync(p.path) ? await listSessions(p.path) : [];
    const restore = (config.lastTabs || []).filter(t => t.projectId === p.id).length;
    return { ...p, last: list[0] ? list[0].mtime : 0, lastTitle: list[0] ? list[0].title : '', count: list.length, restore, missing: !fs.existsSync(p.path) };
  }));
  projects.sort((a, b) => b.last - a.last);
  const ids = new Set(config.projects.map(p => p.id));
  const restoreAll = (config.lastTabs || []).filter(t => ids.has(t.projectId)).length;
  return { projects, restoreAll, name: config.settings.name || '', skin: config.settings.skin, usage: usageCache ? usageCache.total : null, cost: usageCache ? usageCache.cost : null, open: ptys.size };
}

function rebuildTrayMenu() {
  if (!tray) return;
  const { running, pending } = trayStats;
  tray.setToolTip(`Claudelot · ${running} çalışıyor · ${pending} karar bekliyor`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: win && win.isVisible() ? 'Pencereyi gizle' : 'Pencereyi göster', click: () => (win.isVisible() ? win.hide() : showWindow()) },
    { label: 'Karşılama ekranı', click: () => showWelcome() },
    { label: 'Ayarlar', click: () => { showWindow(); send('open-settings'); } },
    { label: 'Rahatsız etme', type: 'checkbox', checked: !!config.settings.notif.quiet, click: m => { config.settings.notif.quiet = m.checked; saveConfig(); send('config-changed', config); } },
    { type: 'separator' },
    { label: `${running} çalışıyor · ${pending} karar bekliyor`, enabled: false },
    { type: 'separator' },
    { label: 'Çık', click: () => quitFlow() },
  ]));
}
function createTray() {
  tray = new Tray(appIcon(32, 2));
  tray.on('click', () => { if (win.isVisible() && win.isFocused()) win.hide(); else showWindow(); rebuildTrayMenu(); });
  rebuildTrayMenu();
}
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 980, minHeight: 620,
    frame: false, backgroundColor: '#0b0a12', show: false, title: 'Claudelot',
    icon: appIcon(64, 1),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (process.argv.includes('--hidden')) return;
    if (config.settings.welcome !== false) showWelcome(); else win.show();
  });
  win.on('close', e => {
    if (isQuitting) return;
    e.preventDefault();
    if (config.settings.closeToTray) { win.hide(); rebuildTrayMenu(); }
    else quitFlow();
  });
  win.on('show', rebuildTrayMenu);
  win.on('hide', rebuildTrayMenu);
  win.on('maximize', () => send('win:state', { maximized: true }));
  win.on('unmaximize', () => send('win:state', { maximized: false }));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  // if the UI reloads it loses its terminals, so don't leave orphan processes behind
  win.webContents.on('did-start-loading', () => killAll());
}
function appMenu() {
  // keeps copy/paste shortcuts working, removes reload shortcuts that would wipe terminals
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    // registerAccelerator:false lets Chromium handle Ctrl+C/V itself (no double paste into terminals)
    { label: 'Düzen', submenu: ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].map(role => ({ role, registerAccelerator: false })) },
    { label: 'Görünüm', submenu: [{ role: 'toggleDevTools', accelerator: 'Ctrl+Shift+I' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ]));
}

/* ---------------- IPC ---------------- */
function registerIpc() {
  ipcMain.handle('config:get', () => ({ config, info: { claude: findClaude(), hookPort, hookSettings: HOOK_SETTINGS, appendPrompt: APPEND_PROMPT, home: os.homedir() } }));
  ipcMain.handle('config:set', (_e, patch) => {
    config = merge(config, patch);
    if (patch.settings && 'autostart' in patch.settings) {
      try { app.setLoginItemSettings({ openAtLogin: !!config.settings.autostart, args: ['--hidden'] }); } catch (_) {}
    }
    saveConfig();
    rebuildTrayMenu();
    return config;
  });
  ipcMain.handle('config:setIdeState', (_e, state) => { config.ide.state = state; saveConfig(); });
  ipcMain.handle('prompt:preview', () => buildAppendPrompt());

  ipcMain.handle('project:add', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Proje klasörü seç', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return addProject(r.filePaths[0]);
  });
  ipcMain.handle('project:remove', (_e, id) => { config.projects = config.projects.filter(p => p.id !== id); saveConfig(); return config.projects; });
  ipcMain.handle('project:discover', async () => {
    const known = new Set(config.projects.map(p => norm(p.path)));
    return (await discoverProjects()).filter(p => !known.has(norm(p.path)));
  });
  ipcMain.handle('project:addPath', (_e, p) => (fs.existsSync(p) ? addProject(p) : null));
  ipcMain.handle('project:open', (_e, p) => { if (insideProject(p)) shell.openPath(p); });

  ipcMain.handle('history:list', (_e, projectPath) => listSessions(projectPath));
  ipcMain.handle('usage:get', () => computeUsage());

  ipcMain.handle('pty:spawn', (_e, opts) => spawnTerminal(opts));
  ipcMain.on('pty:write', (_e, id, data) => { const p = ptys.get(id); if (p) p.write(data); });
  ipcMain.on('pty:resize', (_e, id, cols, rows) => { const p = ptys.get(id); if (p) { try { p.resize(Math.max(20, cols), Math.max(5, rows)); } catch (_) {} } });
  ipcMain.on('pty:kill', (_e, id) => { const p = ptys.get(id); if (p) { try { p.kill(); } catch (_) {} ptys.delete(id); } });

  ipcMain.on('notify', (_e, n) => {
    if (!Notification.isSupported()) return;
    const note = new Notification({ title: n.title, body: n.body || '', silent: !config.settings.sound, icon: appIcon(64, 1) });
    liveNotifications.add(note);
    note.on('click', () => { showWindow(); if (n.tabId) send('focus-tab', n.tabId); });
    note.on('close', () => liveNotifications.delete(note));
    setTimeout(() => liveNotifications.delete(note), 60000);
    note.show();
  });
  ipcMain.on('tray:update', (_e, stats) => { trayStats = stats; rebuildTrayMenu(); if (win) win.setTitle(stats.pending ? `(${stats.pending}) Claudelot` : 'Claudelot'); });

  ipcMain.handle('welcome:data', () => welcomeData());
  ipcMain.handle('welcome:addFolder', async () => {
    const r = await dialog.showOpenDialog(welcome || win, { title: 'Proje klasörü seç', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = addProject(r.filePaths[0]);
    send('projects-changed', config.projects);
    return p;
  });
  // action: 'select' | 'claude' | 'ide' | 'main'
  ipcMain.on('welcome:open', (_e, req) => {
    pendingOpen = req && (req.projectId || req.action === 'restoreAll') ? req : null;
    showWindow();
    if (pendingOpen) send('open-project', pendingOpen);
    closeWelcome();
  });
  ipcMain.handle('app:takePendingOpen', () => { const p = pendingOpen; pendingOpen = null; return p; });
  ipcMain.on('welcome:close', () => closeWelcome());
  ipcMain.on('app:welcome', () => showWelcome());
  ipcMain.on('welcome:min', () => welcome && welcome.minimize());

  ipcMain.on('win:min', () => win.minimize());
  ipcMain.on('win:max', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  ipcMain.on('win:close', () => win.close());
  ipcMain.on('app:quit', () => quitFlow());

  // IDE file access — limited to registered project folders
  const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache', '__pycache__', '.venv', 'venv', 'bin', 'obj', '.idea', '.vs']);
  ipcMain.handle('fs:list', async (_e, dir) => {
    if (!insideProject(dir)) throw new Error('Proje dışında');
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    return ents
      .filter(e => !IGNORE.has(e.name))
      .map(e => ({ name: e.name, dir: e.isDirectory(), path: path.join(dir, e.name) }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'tr') : a.dir ? -1 : 1));
  });
  ipcMain.handle('fs:read', async (_e, file) => {
    if (!insideProject(file)) throw new Error('Proje dışında');
    const st = await fsp.stat(file);
    if (st.size > 3 * 1024 * 1024) return { error: 'Dosya çok büyük (3 MB üstü).' };
    const buf = await fsp.readFile(file);
    if (buf.subarray(0, 8000).includes(0)) return { error: 'İkili (binary) dosya, metin olarak açılamaz.' };
    return { text: buf.toString('utf8'), mtime: st.mtimeMs };
  });
  ipcMain.handle('fs:write', async (_e, file, text) => {
    if (!insideProject(file)) throw new Error('Proje dışında');
    await fsp.writeFile(file, text, 'utf8');
    return true;
  });
  ipcMain.handle('fs:create', async (_e, file) => {
    if (!insideProject(file)) throw new Error('Proje dışında');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) await fsp.writeFile(file, '', 'utf8');
    return true;
  });
}
function addProject(p) {
  const full = path.resolve(p);
  const existing = config.projects.find(x => norm(x.path) === norm(full));
  if (existing) return existing;
  const proj = { id: crypto.randomUUID().slice(0, 8), name: path.basename(full) || full, path: full };
  config.projects.push(proj);
  saveConfig();
  return proj;
}

/* ---------------- start ---------------- */
app.on('second-instance', () => showWindow());
app.on('before-quit', () => { isQuitting = true; killAll(); saveConfigNow(); });
app.on('window-all-closed', e => e.preventDefault());

app.whenReady().then(async () => {
  // drop cached page files so an updated build never shows yesterday's styles
  try { await session.defaultSession.clearCache(); } catch (_) {}
  appMenu();
  await startHookServer();
  writeAppendPrompt();
  if (firstRun) {
    // first launch: bring in folders that already have Claude Code history
    const found = await discoverProjects();
    found.slice(0, 12).forEach(f => addProject(f.path));
    saveConfigNow();
  }
  registerIpc();
  computeUsage().catch(() => {});
  createWindow();
  createTray();
});

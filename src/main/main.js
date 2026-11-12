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
const { execFile, execFileSync, spawn } = require('child_process');
const pty = require('@lydell/node-pty');
const { appIcon } = require('./icon');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
app.setAppUserModelId('Claudelot');
// notification chimes play from the (often hidden) window without a click first
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

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
  removedProjects: [], // paths the user removed; discovery never brings them back
  lastTabs: [], // terminals that were open last time: {projectId, kind, shell, sessionId, title}
  settings: {
    name: '', tone: 'samimi', // name: filled from git / GitHub on first launch, else no form of address lang: 'tr', extra: '',
    closeToTray: true, autostart: false, sound: true, welcome: true,
    soundStyle: 'claudelot', // 'claudelot': the app plays its own chime · 'windows': the system notification sound
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
/* ~/.claude/projects/<name>: the name is the folder path with every non-alphanumeric
   character turned into '-'. Walk the disk to find the folder that encodes to it. */
async function decodeProjectDir(enc) {
  const m = enc.match(/^([A-Za-z])--(.+)$/);
  if (!m) return null;
  async function walk(dir, rest, depth) {
    if (depth > 24) return null;
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return null; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const k = encodeProjectDir(e.name);
      if (rest === k) return path.join(dir, e.name);
      if (rest.startsWith(k + '-')) { const r = await walk(path.join(dir, e.name), rest.slice(k.length + 1), depth + 1); if (r) return r; }
    }
    return null;
  }
  return walk(m[1].toUpperCase() + ':' + path.sep, m[2], 0);
}
/* add every folder with Claude Code history that is not in the list yet (unless the user removed it) */
async function syncDiscovered() {
  const removed = new Set((config.removedProjects || []).map(norm));
  const known = new Set(config.projects.map(x => norm(x.path)));
  const found = (await discoverProjects()).filter(f => !removed.has(norm(f.path)) && !known.has(norm(f.path)));
  found.forEach(f => addProject(f.path, true));
  if (found.length) { saveConfigNow(); send('projects-changed', config.projects); }
  return found.length;
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
    if (newest) {
      const meta = await sessionMeta(path.join(full, newest.f), newest.mtime);
      if (meta.cwd && fs.existsSync(meta.cwd) && encodeProjectDir(meta.cwd) === d) { found.push({ path: meta.cwd, mtime: newest.mtime }); continue; }
    }
    // no session file (or it names another folder): rebuild the path from the folder name
    const back = await decodeProjectDir(d);
    if (back) { let mtime = 0; try { mtime = (await fsp.stat(full)).mtimeMs; } catch (_) {} found.push({ path: back, mtime: newest ? newest.mtime : mtime }); }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

/* ---------------- live sessions ----------------
   Claude Code keeps ~/.claude/sessions/<pid>.json for every running session, with
   its session id, folder and status (busy / idle / waiting). Sessions opened in an
   outside terminal show up here, so Claudelot can follow them instead of starting
   a second copy with --resume. */
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
const ownPid = new Map(); // claude pid -> started by one of our terminals?
function classifyPids(pids) {
  // a terminal may run claude through cmd.exe, so check the parent process as well
  const todo = pids.filter(p => !ownPid.has(p));
  if (!todo.length) return;
  const roots = new Set([...ptys.values()].map(p => p.pid));
  const parents = {};
  try {
    const filter = todo.map(p => 'ProcessId=' + p).join(' or ');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }`],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    for (const line of out.split(/\r?\n/)) { const [a, b] = line.trim().split(/\s+/).map(Number); if (a) parents[a] = b; }
  } catch (_) {}
  for (const p of todo) ownPid.set(p, roots.has(p) || roots.has(parents[p]));
}
let liveList = [], liveSig = '', liveBusy = false;
async function scanLive() {
  if (liveBusy) return liveList;
  liveBusy = true;
  try {
    let files = [];
    try { files = (await fsp.readdir(SESSIONS_DIR)).filter(f => /^\d+\.json$/.test(f)); } catch (_) {}
    const raw = [];
    for (const f of files) {
      let o; try { o = JSON.parse(await fsp.readFile(path.join(SESSIONS_DIR, f), 'utf8')); } catch (_) { continue; }
      if (!o || !o.pid || !SID_RE.test(o.sessionId || '') || (o.kind && o.kind !== 'interactive')) continue;
      if (!pidAlive(o.pid)) continue;
      raw.push(o);
    }
    classifyPids(raw.map(o => o.pid));
    const list = [];
    for (const o of raw) {
      if (ownPid.get(o.pid)) continue;
      const file = path.join(PROJECTS_DIR, encodeProjectDir(o.cwd || ''), o.sessionId + '.jsonl');
      let title = o.name || 'Oturum';
      try { const st = await fsp.stat(file); title = (await sessionMeta(file, st.mtimeMs)).title; } catch (_) {}
      list.push({
        pid: o.pid, sessionId: o.sessionId, cwd: o.cwd || '', title,
        status: o.status || 'idle', waitingFor: o.waitingFor || '',
        startedAt: o.startedAt || 0, updatedAt: o.statusUpdatedAt || o.updatedAt || 0,
      });
    }
    list.sort((a, b) => b.startedAt - a.startedAt);
    for (const p of [...ownPid.keys()]) if (!raw.some(o => o.pid === p)) ownPid.delete(p);
    liveList = list;
    const sig = JSON.stringify(list);
    if (sig !== liveSig) { liveSig = sig; send('live-sessions', list); }
    return list;
  } finally { liveBusy = false; }
}
function watchLive() {
  let t = null;
  const kick = () => { clearTimeout(t); t = setTimeout(() => scanLive().catch(() => {}), 250); };
  try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); fs.watch(SESSIONS_DIR, kick); } catch (_) {}
  setInterval(kick, 4000); // also catches sessions whose process died without cleaning up
  kick();
}
function transcriptOf(sessionId) {
  const s = liveList.find(x => x.sessionId === sessionId);
  if (s) return path.join(PROJECTS_DIR, encodeProjectDir(s.cwd), sessionId + '.jsonl');
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR)) {
      const f = path.join(PROJECTS_DIR, d, sessionId + '.jsonl');
      if (fs.existsSync(f)) return f;
    }
  } catch (_) {}
  return null;
}
function liveEntries(o) {
  // turn one transcript line into what the watch view shows; most lines are bookkeeping
  if (o.isSidechain) return [];
  if (o.type === 'attachment' && o.attachment && o.attachment.type === 'queued_command' && typeof o.attachment.prompt === 'string') {
    return [{ k: 'user', text: o.attachment.prompt, ts: o.timestamp }];
  }
  if (!o.message) return [];
  const c = o.message.content;
  if (o.type === 'user' && !o.isMeta) {
    if (typeof c === 'string') return c.trim() && !c.startsWith('<') ? [{ k: 'user', text: c, ts: o.timestamp }] : [];
    if (Array.isArray(c)) {
      const text = c.filter(b => b.type === 'text' && !String(b.text).startsWith('<')).map(b => b.text).join('\n').trim();
      const imgs = c.filter(b => b.type === 'image').length;
      if (text || imgs) return [{ k: 'user', text: text + (imgs ? `${text ? '\n' : ''}[${imgs} görsel]` : ''), ts: o.timestamp }];
    }
    return [];
  }
  if (o.type === 'assistant' && Array.isArray(c)) {
    const out = [];
    for (const b of c) {
      if (b.type === 'text' && b.text.trim()) out.push({ k: 'ai', text: b.text, ts: o.timestamp });
      else if (b.type === 'tool_use') {
        const i = b.input || {};
        const what = i.description || i.command || i.file_path || i.pattern || i.url || i.query || i.prompt || '';
        out.push({ k: 'tool', name: b.name, text: String(what).replace(/\s+/g, ' ').slice(0, 300), ts: o.timestamp });
      }
    }
    return out;
  }
  return [];
}
const TAIL_FIRST = 3 * 1024 * 1024; // first read of a long transcript starts this far from the end
async function tailTranscript(sessionId, offset) {
  if (!SID_RE.test(sessionId || '')) return null;
  const file = transcriptOf(sessionId);
  if (!file) return { offset: 0, entries: [], missing: true };
  let st; try { st = await fsp.stat(file); } catch (_) { return { offset: 0, entries: [], missing: true }; }
  let from = offset || 0, trimmed = false;
  if (from > st.size) from = 0;
  if (!offset && st.size > TAIL_FIRST) { from = st.size - TAIL_FIRST; trimmed = true; }
  if (from === st.size) return { offset: from, entries: [] };
  const fh = await fsp.open(file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(st.size - from);
    const { bytesRead } = await fh.read(buf, 0, buf.length, from);
    buf = buf.slice(0, bytesRead);
  } finally { await fh.close(); }
  // only consume complete lines; a half-written last line is read again next time
  const end = buf.lastIndexOf(0x0a);
  if (end < 0) return { offset: from, entries: [] };
  const lines = buf.slice(0, end).toString('utf8').split('\n');
  if (trimmed) lines.shift(); // started mid-line
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    entries.push(...liveEntries(o));
  }
  if (offset) for (const e of entries) if (e.k === 'user') learnAddress(e.text);
  return { offset: from + end + 1, entries, trimmed };
}
async function takeOver(sessionId) {
  // close the outside copy so the conversation can continue in a Claudelot terminal
  const s = liveList.find(x => x.sessionId === sessionId);
  if (!s) return { ok: true };
  try { process.kill(s.pid); } catch (e) { return { ok: false, error: 'Dışarıdaki oturum kapatılamadı: ' + e.message }; }
  for (let i = 0; i < 50 && pidAlive(s.pid); i++) await new Promise(r => setTimeout(r, 100));
  if (pidAlive(s.pid)) return { ok: false, error: 'Dışarıdaki oturum kapanmadı.' };
  await scanLive().catch(() => {});
  return { ok: true, cwd: s.cwd };
}

/* ---------------- console mirror for outside sessions ----------------
   mirror.cs attaches to the console of an outside Claude session, streams its screen
   and types keys into it. It is compiled once with the csc.exe that ships with Windows
   and cached in the data folder (keyed by a hash of the source). */
const mirrors = new Map(); // id -> child process
let mirrorBuild = null;
function mirrorBinary() {
  if (mirrorBuild) return mirrorBuild;
  mirrorBuild = (async () => {
    const src = fs.readFileSync(path.join(__dirname, 'mirror.cs'), 'utf8');
    const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 10);
    const exe = path.join(DATA, `mirror-${hash}.exe`);
    if (fs.existsSync(exe)) return exe;
    const win = process.env.WINDIR || 'C:\\Windows';
    const csc = ['Framework64', 'Framework'].map(f => path.join(win, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find(f => fs.existsSync(f));
    if (!csc) throw new Error('Terminal bağlantısı için gereken .NET derleyicisi (csc.exe) bulunamadı.');
    fs.mkdirSync(DATA, { recursive: true });
    const cs = path.join(DATA, `mirror-${hash}.cs`);
    fs.writeFileSync(cs, src);
    await new Promise((resolve, reject) => execFile(csc, ['-nologo', '-target:winexe', '-optimize', '-out:' + exe, cs],
      { windowsHide: true, timeout: 60000 }, (err, out) => (err ? reject(new Error('Terminal bağlantı aracı derlenemedi. ' + String(out || err.message).trim())) : resolve())));
    try { fs.unlinkSync(cs); } catch (_) {}
    return exe;
  })();
  mirrorBuild.catch(() => { mirrorBuild = null; });
  return mirrorBuild;
}
async function startMirror(sessionId) {
  const s = liveList.find(x => x.sessionId === sessionId);
  if (!s) throw new Error('Oturum artık açık değil.');
  const exe = await mirrorBinary();
  const id = crypto.randomUUID();
  const child = spawn(exe, [String(s.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  mirrors.set(id, child);
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const p = line.split(' ');
      if (p[0] === 'F') send('mirror:frame', id, { cols: +p[1], rows: +p[2], cx: +p[3], cy: +p[4], vis: p[5] === '1', vt: Buffer.from(p[6] || '', 'base64').toString('utf8') });
      else if (p[0] === 'E') send('mirror:error', id, 'Terminale bağlanılamadı (Windows hata kodu ' + p[1] + ').');
    }
  });
  child.stdin.on('error', () => {});
  child.on('exit', () => { mirrors.delete(id); send('mirror:exit', id); });
  child.on('error', e => { mirrors.delete(id); send('mirror:error', id, e.message); });
  return { id, pid: s.pid };
}
/* xterm sends VT text; the console wants key events: [virtual key, char, control state] */
const CTRL = { SHIFT: 0x10, ALT: 0x02, CTRLK: 0x08 };
const SEQ_KEYS = { A: 38, B: 40, C: 39, D: 37, H: 36, F: 35 };
const TILDE_KEYS = { 2: 45, 3: 46, 5: 33, 6: 34 };
function keysOf(data) {
  const out = [];
  const modState = m => { m = (+m || 1) - 1; return (m & 1 ? CTRL.SHIFT : 0) | (m & 2 ? CTRL.ALT : 0) | (m & 4 ? CTRL.CTRLK : 0); };
  for (let i = 0; i < data.length;) {
    const rest = data.slice(i);
    let m;
    if ((m = rest.match(/^\x1b\[(?:1;(\d))?([ABCDHF])/)) || (m = rest.match(/^\x1bO()([ABCDHF])/))) { out.push([SEQ_KEYS[m[2]], 0, modState(m[1])]); i += m[0].length; continue; }
    if ((m = rest.match(/^\x1b\[(\d)(?:;(\d))?~/)) && TILDE_KEYS[m[1]]) { out.push([TILDE_KEYS[m[1]], 0, modState(m[2])]); i += m[0].length; continue; }
    if (rest.startsWith('\x1b[Z')) { out.push([9, 9, CTRL.SHIFT]); i += 3; continue; }
    const ch = data.charCodeAt(i);
    if (ch === 0x1b && i + 1 < data.length && data[i + 1] !== '\x1b' && data[i + 1] !== '[' && data[i + 1] !== 'O') {
      const c2 = data.charCodeAt(i + 1);
      out.push([c2 >= 97 && c2 <= 122 ? c2 - 32 : 0, c2, CTRL.ALT]); i += 2; continue; // Alt+key
    }
    if (ch === 13) out.push([13, 13, 0]);
    else if (ch === 0x7f || ch === 8) out.push([8, 8, 0]);
    else if (ch === 9) out.push([9, 9, 0]);
    else if (ch === 0x1b) out.push([27, 27, 0]);
    else if (ch === 10) out.push([13, 10, CTRL.CTRLK]);
    else if (ch > 0 && ch < 27) out.push([64 + ch, ch, CTRL.CTRLK]); // Ctrl+letter
    else out.push([ch >= 48 && ch <= 57 ? ch : ch >= 97 && ch <= 122 ? ch - 32 : ch >= 65 && ch <= 90 ? ch : 0, ch, ch >= 65 && ch <= 90 ? CTRL.SHIFT : 0]);
    i++;
  }
  return out;
}
function mirrorInput(id, data) {
  const child = mirrors.get(id);
  if (!child || typeof data !== 'string' || !data) return;
  const keys = keysOf(data.slice(0, 100000));
  for (let i = 0; i < keys.length; i += 400) child.stdin.write('I ' + keys.slice(i, i + 400).map(k => k.join(' ')).join(' ') + '\n');
}
function stopMirror(id) { const c = mirrors.get(id); if (c) { try { c.kill(); } catch (_) {} mirrors.delete(id); } }

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
  // rolling 5-hour window (Claude's session limits are counted over 5 hours)
  const since = Date.now() - 5 * 3600e3;
  const last5h = { t: 0, c: 0 };
  for (const e of msgs.values()) if (e.ts >= since) { last5h.t += e.t; last5h.c += e.c || 0; }
  usageCache = {
    last5h,
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
        if (ev.hook_event_name === 'UserPromptSubmit' && ev.prompt) learnAddress(ev.prompt);
        send('hook', ev);
      });
    });
    server.listen(0, '127.0.0.1', () => { hookPort = server.address().port; writeHookSettings(); resolve(); });
  });
}

/* ---------------- who the user is (git / GitHub) ----------------
   Read once on first launch so Claudelot can address the user by name; kept in
   config.identity as the starting point for the git / GitHub features. */
function runQuiet(cmd, args, timeout = 4000) {
  return new Promise(res => {
    try { execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout }, (err, out) => res(err ? '' : String(out).trim())); } catch (_) { res(''); }
  });
}
async function gitIdentity() {
  const [name, email] = await Promise.all([runQuiet('git', ['config', '--global', 'user.name']), runQuiet('git', ['config', '--global', 'user.email'])]);
  return { name, email };
}
async function githubIdentity() {
  if (!whereFirst('gh').length) return {};
  const out = await runQuiet('gh', ['api', 'user', '--jq', '[.login, (.name // "")] | @tsv'], 8000);
  const [login, name] = out.split('\t');
  return login ? { login, name: (name || '').trim() } : {};
}
const firstNameOf = n => String(n || '').trim().split(/\s+/)[0] || '';
async function detectIdentity({ firstLaunch }) {
  const g = await gitIdentity();
  const id = { name: g.name, email: g.email, github: '', source: g.name ? 'git' : '', at: Date.now() };
  // git is local and fast: on first launch, use it before the welcome screen opens
  if (firstLaunch && !config.settings.name && id.name) setAddress(firstNameOf(id.name), false);
  config.identity = id;
  saveConfig();
  // GitHub needs the network; fill in when it answers
  githubIdentity().then(h => {
    if (!h.login) return;
    id.github = h.login;
    if (!id.name && h.name) { id.name = h.name; id.source = 'github'; if (firstLaunch && !config.settings.name) setAddress(firstNameOf(h.name), true); }
    config.identity = id;
    saveConfig();
  }).catch(() => {});
}
function setAddress(name, notify) {
  config.settings.name = name;
  saveConfig();
  writeAppendPrompt();
  if (notify) send('config-changed', config);
}

/* "bana Ertuğrul diye hitap et" / "call me Ed" in a prompt updates the form of address */
const NOT_A_NAME = /^(şöyle|böyle|öyle|nasıl|ne|bu|şu|o|bir|başka|farklı|this|that|what)$/i;
function addressFromPrompt(text) {
  const s = String(text || '').slice(0, 2000);
  if (/bana\s+(?:artık\s+|bundan\s+sonra\s+)?(?:hiç\s+)?hitap\s+etme/i.test(s)) return '';
  const pats = [
    /bana\s+(?:bundan\s+sonra\s+|artık\s+)?["“'‘]?([^\n"”'’.,!?]{1,30}?)["”'’]?\s+(?:diye|olarak)\s+(?:hitap\s+et|seslen|çağır|de(?=[\s.,!?]|$)|söyle)/i,
    /bana\s+["“'‘]?([^\s"”'’.,!?]{2,20})["”'’]?\s+de\s*(?:[.!]|$)/i,
    /\bcall\s+me\s+["“']?([^\n"”'.,!?]{1,30}?)["”']?(?=[\s.,!?]|$)/i,
  ];
  for (const re of pats) {
    const m = s.match(re);
    if (!m) continue;
    const name = m[1].trim().split(/\s+/).slice(0, 3).join(' ');
    if (name && !NOT_A_NAME.test(name)) return name.charAt(0).toLocaleUpperCase('tr') + name.slice(1);
  }
  return null;
}
function learnAddress(text) {
  const name = addressFromPrompt(text);
  if (name === null || name === (config.settings.name || '')) return;
  setAddress(name, true);
  send('address-learned', name);
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
  for (const id of [...mirrors.keys()]) stopMirror(id);
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
  ipcMain.handle('project:remove', (_e, id) => {
    const gone = config.projects.find(p => p.id === id);
    if (gone && !config.removedProjects.some(r => norm(r) === norm(gone.path))) config.removedProjects.push(gone.path);
    config.projects = config.projects.filter(p => p.id !== id); saveConfig(); return config.projects;
  });
  ipcMain.handle('project:discover', async () => {
    const known = new Set(config.projects.map(p => norm(p.path)));
    return (await discoverProjects()).filter(p => !known.has(norm(p.path)));
  });
  ipcMain.handle('project:addPath', (_e, p) => (fs.existsSync(p) ? addProject(p) : null));
  ipcMain.handle('project:open', (_e, p) => { if (insideProject(p)) shell.openPath(p); });

  // files copied in Explorer: the clipboard holds a file list, not text. Read it the way
  // Windows Terminal pastes it (full paths). Electron has no API for CF_HDROP.
  ipcMain.handle('clipboard:files', () => new Promise(res => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }'],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 },
    (err, out) => res(err ? [] : String(out).split(/\r?\n/).map(s => s.trim()).filter(Boolean)));
  }));

  // Claude Code's own history retention (cleanupPeriodDays in ~/.claude/settings.json).
  // Only this key is touched; a file that does not parse is left alone.
  const USER_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
  const readUserSettings = () => {
    if (!fs.existsSync(USER_SETTINGS)) return {};
    const raw = fs.readFileSync(USER_SETTINGS, 'utf8').replace(/^﻿/, '');
    if (!raw.trim()) return {};
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('settings.json beklenen biçimde değil');
    return j;
  };
  ipcMain.handle('claude:getCleanup', () => { try { const v = readUserSettings().cleanupPeriodDays; return Number.isFinite(v) ? v : null; } catch (_) { return null; } });
  ipcMain.handle('claude:setCleanup', (_e, days) => {
    const n = Math.round(Number(days));
    if (!(n >= 1 && n <= 3650)) throw new Error('Geçersiz gün sayısı');
    let j;
    try { j = readUserSettings(); } catch (e) { throw new Error('~/.claude/settings.json okunamadı, dokunmadım: ' + e.message); }
    j.cleanupPeriodDays = n;
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(USER_SETTINGS + '.tmp', JSON.stringify(j, null, 2) + '\n');
    fs.renameSync(USER_SETTINGS + '.tmp', USER_SETTINGS);
    return n;
  });

  // git / GitHub (read-only), limited to registered project folders
  const G = require('./git')({
    isProject: p => config.projects.some(x => norm(x.path) === norm(p)),
    insideProject, whereFirst, identity: () => config.identity,
  });
  ipcMain.handle('git:head', (_e, p) => G.head(p));
  ipcMain.handle('git:connect', (_e, p, url) => G.connect(p, url));
  ipcMain.handle('git:sync', (_e, p, action) => G.sync(p, action));
  ipcMain.handle('git:overview', (_e, p) => G.overview(p));
  ipcMain.handle('git:log', (_e, p, skip, n) => G.log(p, skip, n));
  ipcMain.handle('git:show', (_e, p, h) => G.show(p, h));
  ipcMain.handle('git:diff', (_e, p, kind, f) => G.diff(p, kind, f));
  ipcMain.handle('git:stash', (_e, p, ref) => G.stash(p, ref));
  ipcMain.handle('github:info', (_e, p, force) => G.github(p, force));
  ipcMain.handle('shell:openGithub', (_e, url) => { if (/^https:\/\/github\.com\//i.test(String(url))) shell.openExternal(url); });

  ipcMain.handle('history:list', (_e, projectPath) => listSessions(projectPath));
  ipcMain.handle('usage:get', () => computeUsage());
  ipcMain.handle('live:list', () => scanLive());
  ipcMain.handle('live:tail', (_e, sid, offset) => tailTranscript(sid, offset));
  ipcMain.handle('live:takeover', (_e, sid) => takeOver(sid));
  ipcMain.handle('mirror:start', (_e, sid) => startMirror(sid));
  ipcMain.on('mirror:input', (_e, id, data) => mirrorInput(id, data));
  ipcMain.on('mirror:stop', (_e, id) => stopMirror(id));

  ipcMain.handle('pty:spawn', (_e, opts) => spawnTerminal(opts));
  ipcMain.on('pty:write', (_e, id, data) => { const p = ptys.get(id); if (p) p.write(data); });
  ipcMain.on('pty:resize', (_e, id, cols, rows) => { const p = ptys.get(id); if (p) { try { p.resize(Math.max(20, cols), Math.max(5, rows)); } catch (_) {} } });
  ipcMain.on('pty:kill', (_e, id) => { const p = ptys.get(id); if (p) { try { p.kill(); } catch (_) {} ptys.delete(id); } });

  ipcMain.on('notify', (_e, n) => {
    if (!Notification.isSupported()) return;
    const note = new Notification({ title: n.title, body: n.body || '', silent: !config.settings.sound || config.settings.soundStyle !== 'windows', icon: appIcon(64, 1) });
    liveNotifications.add(note);
    note.on('click', () => { showWindow(); if (n.tabId) send('focus-tab', n.tabId); });
    // blink the taskbar button until the window is looked at
    if (win && !win.isDestroyed() && !win.isFocused()) { win.flashFrame(true); win.once('focus', () => win.flashFrame(false)); }
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
  // action: 'select' | 'claude' | 'ide' | 'main' | 'settings'
  ipcMain.on('welcome:open', (_e, req) => {
    if (req && req.action === 'settings') { showWindow(); send('open-settings'); closeWelcome(); return; }
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
function addProject(p, auto) {
  const full = path.resolve(p);
  if (!auto) config.removedProjects = (config.removedProjects || []).filter(r => norm(r) !== norm(full));
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
  // bring in every folder that has Claude Code history (on first launch and whenever a new one appears)
  await syncDiscovered().catch(() => {});
  setInterval(() => syncDiscovered().catch(() => {}), 10 * 60 * 1000);
  registerIpc();
  if (firstRun || !config.identity) await detectIdentity({ firstLaunch: firstRun }).catch(() => {});
  computeUsage().catch(() => {});
  createWindow();
  createTray();
  watchLive();
});

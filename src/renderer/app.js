'use strict';
/* Claudelot renderer — talks to the main process only through window.api (see preload.js). */
/* global api, Terminal, FitAddon, CodeMirror */ // `api` comes from preload.js
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normPath = p => String(p || '').replace(/\//g, '\\').toLowerCase();
const cleanErr = e => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const shorten = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

let CFG = null, INFO = null;
const S = {
  projects: [], history: {}, tabs: [], active: null,
  pending: [], agents: [], notifs: [], unread: 0, usage: null,
  lastTool: {}, modified: {}, mode: 'claude', collapsed: {}, showAll: {}, live: [], extAttn: new Map(),
};
const early = new Map();
let seq = 1;

const SHELL_ICONS = {
  pwsh: '<svg class="shi" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 2.5h11.3c.5 0 .8.4.7.9l-2.1 9.3c-.1.5-.5.8-1 .8H.8c-.5 0-.8-.4-.7-.9L2.2 3.3c.1-.5.5-.8 1-.8z" fill="#2c7cd6"/><path d="M4.3 5.2l3.4 2.6-4.6 2.9" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.7 10.9h3.2" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/></svg>',
  cmd: '<svg class="shi" viewBox="0 0 16 16" aria-hidden="true"><rect x=".75" y="1.75" width="14.5" height="12.5" rx="1.5" fill="#1b1b1f" stroke="#8a8f98" stroke-width="1"/><path d="M.75 4.5h14.5" stroke="#8a8f98" stroke-width="1"/><path d="M3.5 7.2l2.3 1.6-2.3 1.6" fill="none" stroke="#e8e8e8" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.2 11.2h3.4" stroke="#e8e8e8" stroke-width="1.2" stroke-linecap="round"/></svg>',
  bash: '<i class="shi fa-brands fa-git-alt" style="color:#f05133" aria-hidden="true"></i>',
};
const SHELLS = { pwsh: { name: 'PowerShell', exe: 'powershell' }, cmd: { name: 'Komut İstemi', exe: 'cmd.exe' }, bash: { name: 'Git Bash', exe: 'bash.exe' } };
const STATUS_TEXT = { running: 'Çalışıyor', waiting: 'Kararını bekliyor', done: 'Bitti', idle: 'Hazır', exited: 'Kapandı', shell: 'Terminal' };
const STATUS_SHORT = { running: 'çalışıyor', waiting: 'bekliyor', done: 'bitti', idle: 'açık', exited: 'kapandı', shell: 'terminal' };
const ICONS = { done: '<i class="fa-solid fa-check"></i>', decision: '<i class="fa-solid fa-hand"></i>', subagent: '<i class="fa-solid fa-robot"></i>', workflow: '<i class="fa-solid fa-diagram-project"></i>', system: '<i class="fa-solid fa-circle-info"></i>' };
const SUB_TOOLS = new Set(['Task', 'Agent']);
const MODELS = [['', 'Claude Code varsayılanı'], ['opus', 'Opus (en güncel)'], ['sonnet', 'Sonnet (en güncel)'], ['haiku', 'Haiku (en güncel)'], ['fable', 'Fable (en güncel)'], ['__custom', 'Başka bir model…']];
const EFFORTS = [['', 'Varsayılan'], ['low', 'Düşük'], ['medium', 'Orta'], ['high', 'Yüksek'], ['xhigh', 'Çok yüksek'], ['max', 'Maksimum']];
const PERM_MODES = [
  ['', 'Claude Code varsayılanı', 'Claude Code ayarlarındaki mod kullanılır'],
  ['manual', 'Her şeyi sor', 'Dosya düzenleme ve komutlar için izin ister'],
  ['acceptEdits', 'Düzenlemeleri kabul et', 'Dosya düzenlemelerini sormadan yapar, komutları sorar'],
  ['plan', 'Plan modu', 'Önce plan çıkarır, onay vermeden değişiklik yapmaz'],
  ['auto', 'Otomatik (auto)', 'Güvenli işlemleri kendi yapar, riskli olanları sorar'],
  ['dontAsk', 'Sorma, reddet', 'İzin verilmemiş işlemleri sormadan reddeder'],
  ['bypassPermissions', 'İzinleri atla', 'Hiçbir şey sormaz; tüm izin kontrolleri kapalı'],
];
const QUICK_MODES = [['plan', 'Plan modu'], ['auto', 'Otomatik (auto)'], ['acceptEdits', 'Düzenlemeleri kabul et'], ['bypassPermissions', 'İzinleri atla']];
function claudeSummary() {
  const c = (CFG && CFG.settings.claude) || {};
  const parts = [];
  parts.push(c.model ? (MODELS.find(([k]) => k === c.model) || [0, c.model])[1].replace(' (en güncel)', '') : 'varsayılan model');
  if (c.effort) parts.push((EFFORTS.find(([k]) => k === c.effort) || [0, c.effort])[1].toLowerCase() + ' efor');
  if (c.permissionMode) parts.push(c.permissionMode);
  if (c.remoteControl) parts.push('RC açık');
  return parts.join(' · ');
}
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const proj = id => S.projects.find(p => p.id === id);
const tabById = id => S.tabs.find(t => t.id === id);
const tabBySession = sid => sid && S.tabs.find(t => t.sessionId === sid && t.kind !== 'watch');
const addr = () => ((CFG && CFG.settings.name) || '').trim();
const firstName = n => String(n || '').trim().split(/\s+/)[0] || '';
function rel(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return 'şimdi';
  if (m < 60) return m + ' dk';
  const h = Math.floor(m / 60); if (h < 24) return h + ' sa';
  const g = Math.floor(h / 24); if (g < 7) return g + ' gün';
  return new Date(ms).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}
const fmtUsd = n => '$' + n.toLocaleString('tr-TR', { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: n < 100 ? 2 : 0 });
const fmtTok = n => n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' M' : n >= 1e3 ? Math.round(n / 1e3) + ' B' : String(n);

/* ---------------- config ---------------- */
function mergeLocal(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const k of Object.keys(extra || {})) out[k] = k in base ? mergeLocal(base[k], extra[k]) : extra[k];
  return out;
}
function setCfg(patch) {
  CFG = mergeLocal(CFG, patch);
  return api.invoke('config:set', patch);
}

/* ---------------- toasts (in-app, small) ---------------- */
function toast(title, body) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<b>${esc(title)}</b>${body ? `<span>${esc(body)}</span>` : ''}`;
  $('#toasts').prepend(el);
  setTimeout(() => el.remove(), 3500);
}

/* ---------------- notifications ---------------- */
/* Claudelot's own chimes, made with Web Audio so no sound files are needed:
   done = two rising notes, decision = a brighter four-note call, others = one soft note */
let audioCtx = null;
const CHIMES = {
  done: [[659.25, 0], [987.77, 0.13]],
  decision: [[880, 0], [1174.66, 0.11], [880, 0.22], [1174.66, 0.33]],
  other: [[783.99, 0]],
};
function playChime(type) {
  try {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime + 0.03;
    for (const [freq, at] of CHIMES[type] || CHIMES.other) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0, t0 + at);
      g.gain.linearRampToValueAtTime(0.2, t0 + at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.5);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + at); o.stop(t0 + at + 0.55);
    }
  } catch (_) {}
}
function notify(type, title, body, tabId) {
  S.notifs.unshift({ type, title, body, tabId, t: Date.now() });
  S.notifs = S.notifs.slice(0, 80);
  if ($('#pop').hidden) S.unread++;
  const n = CFG.settings.notif;
  if (n.quiet || !n[type]) return;
  if (document.hasFocus() && S.active === tabId) return; // already looking at it
  if (CFG.settings.sound && (CFG.settings.soundStyle || 'claudelot') === 'claudelot') playChime(type);
  api.send('notify', { title, body, tabId });
}

/* ---------------- skins ---------------- */
const SKINS = [
  { k: 'violet', name: 'Gece moru', sub: 'Koyu · mor vurgu', c: ['#0b0a12', '#a78bfa', '#f2b155'] },
  { k: 'teal', name: 'Deniz', sub: 'Windows temasına göre açık / koyu', c: ['#e9eeef', '#0c7a71', '#3dc0b2'] },
  { k: 'mono', name: 'Grafit', sub: 'Siyah-beyaz · durumlar renkli', c: ['#0a0a0a', '#e8e8e8', '#f2b155'] },
];
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
/* Windows Terminal "Campbell" colours — what Claude Code looks like in a normal Windows terminal */
const CAMPBELL = {
  foreground: '#cccccc', black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00', blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
  brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
};
function termTheme() {
  const base = { background: cssVar('--term-bg'), foreground: cssVar('--term-fg'), cursor: cssVar('--term-cursor'), cursorAccent: cssVar('--term-bg'), selectionBackground: cssVar('--term-sel') };
  if (!CFG || (CFG.settings.termColors || 'windows') === 'windows') Object.assign(base, CAMPBELL, { cursor: '#cccccc', selectionBackground: '#3a3d41' });
  return base;
}
function applySkin(k) {
  if (k === 'violet') delete document.documentElement.dataset.skin; else document.documentElement.dataset.skin = k;
  const th = termTheme();
  S.tabs.forEach(t => { if (t.term) t.term.options.theme = th; });
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applySkin(CFG.settings.skin));
function renderSkinMenu() {
  $('#skinMenu').innerHTML = '<div class="h">Tema</div>' + skinOptions();
}
const skinOptions = () => SKINS.map(s => `<button class="skin-opt" data-skin="${s.k}"><span class="sw3">${s.c.map(c => `<i style="background:${c}"></i>`).join('')}</span><span class="nm">${s.name}<small>${s.sub}</small></span><span class="ck">${s.k === CFG.settings.skin ? '✓' : ''}</span></button>`).join('');

/* ---------------- history & usage ---------------- */
async function refreshHistory(pid) {
  const p = proj(pid); if (!p) return;
  try { S.history[pid] = await api.invoke('history:list', p.path); } catch (_) { S.history[pid] = []; }
}
async function refreshAllHistory() { await Promise.all(S.projects.map(p => refreshHistory(p.id))); }
async function refreshUsage() {
  try { S.usage = await api.invoke('usage:get'); } catch (_) {}
  renderUsage(); renderStatus(); renderPanelBadges();
}

/* ---------------- terminals ---------------- */
function tabIcon(t) { if (t.kind === 'watch') return `<span class="dot ${t.status}"></span><i class="fa-solid fa-eye watch-ic" title="Claudelot dışında açık, izleniyor"></i>`; return t.kind === 'shell' ? (SHELL_ICONS[t.shell] || '<i class="shi fa-solid fa-terminal"></i>') : `<span class="dot ${t.status}"></span>`; }

async function openTerminal({ kind = 'claude', shell, projectId, resume, title, overrides }) {
  // already running in an outside terminal: follow it instead of starting a second copy
  if (resume && isExtLive(resume)) return openWatch(resume);
  const p = proj(projectId); if (!p) return null;
  if (resume) { const ex = tabBySession(resume); if (ex) { activate(ex.id); return ex; } }
  const el = document.createElement('div');
  el.className = 'term-pane';
  $('#termHost').appendChild(el);
  const term = new Terminal({
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace', fontSize: 13, lineHeight: 1.15,
    cursorBlink: true, scrollback: 8000, allowProposedApi: true, theme: termTheme(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  $$('.term-pane').forEach(x => x.classList.remove('on'));
  el.classList.add('on');
  term.open(el);
  try { fit.fit(); } catch (_) {}
  const tab = {
    id: 'pending-' + (seq++), kind, shell, projectId, sessionId: null, term, fit, el, exited: false,
    title: title || (kind === 'claude' ? 'Yeni oturum' : SHELLS[shell].name + numberSuffix(projectId, shell)),
    status: kind === 'claude' ? 'idle' : 'shell',
    prompted: !!resume, // a brand-new session has nothing to resume until the first message
  };
  S.tabs.push(tab);
  S.active = tab.id;
  S.collapsed[projectId] = false; // show the project that just got a terminal
  renderAll();
  try {
    const res = await api.invoke('pty:spawn', { kind, shell, cwd: p.path, resume, overrides, rcName: `${p.name} · Claudelot`, cols: term.cols, rows: term.rows });
    tab.id = res.id; tab.sessionId = res.sessionId;
    S.active = tab.id;
    (early.get(res.id) || []).forEach(d => term.write(d));
    early.delete(res.id);
    saveOpenTabs();
  } catch (e) {
    tab.exited = true; tab.status = 'exited';
    term.write('\x1b[31m' + cleanErr(e) + '\x1b[0m\r\n');
  }
  term.onData(d => { if (!tab.exited) api.send('pty:write', tab.id, d); });
  term.onResize(({ cols, rows }) => { if (!tab.exited) api.send('pty:resize', tab.id, cols, rows); });
  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === 'c' && (e.shiftKey || term.hasSelection())) {
      if (term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()).catch(() => {}); term.clearSelection(); }
      return false;
    }
    if (e.ctrlKey && k === 'v') return false; // browser paste event delivers the text
    return true;
  });
  activate(tab.id);
  return tab;
}
function numberSuffix(pid, shell) {
  const n = S.tabs.filter(t => t.projectId === pid && t.shell === shell).length;
  return n ? ' ' + (n + 1) : '';
}
function fitActive() {
  const t = tabById(S.active);
  if (t && t.fit && t.el.offsetParent) { try { t.fit.fit(); } catch (_) {} }
}
function activate(id) {
  const t = tabById(id); if (!t) return;
  S.active = id;
  t.attn = null;
  if (t.kind === 'watch') S.extAttn.delete(t.sessionId);
  if (S.mode === 'ide' && t.projectId && t.projectId !== IDE.project) { IDE.project = t.projectId; showFile(); }
  $$('.term-pane').forEach(x => x.classList.toggle('on', x === t.el));
  renderAll();
  requestAnimationFrame(() => {
    fitActive();
    if (t.kind === 'watch') setWatchView(t, t.view);
    else if (t.term) t.term.focus();
  });
}
function closeTab(id) {
  const t = tabById(id); if (!t) return;
  if (t.kind !== 'watch' && !t.exited && (t.status === 'running' || t.status === 'waiting') && !confirm(`"${t.title}" hâlâ çalışıyor. Terminal kapatılsın mı?\nClaude oturumu geçmişte kalır, sonra devam ettirebilirsin.`)) return;
  if (t.kind === 'watch') { clearInterval(t.timer); if (t.mirror) api.send('mirror:stop', t.mirror); }
  else if (!t.exited) api.send('pty:kill', t.id);
  if (t.term) t.term.dispose();
  t.el.remove();
  const idx = S.tabs.indexOf(t);
  S.tabs.splice(idx, 1);
  saveOpenTabs();
  S.pending = S.pending.filter(p => p.tabId !== id);
  S.agents = S.agents.filter(a => a.tabId !== id);
  if (S.active === id) {
    const same = S.tabs.filter(x => x.projectId === t.projectId);
    const next = (S.mode === 'ide' ? same : S.tabs)[Math.max(0, Math.min(idx, S.tabs.length) - 1)] || same[0] || (S.mode === 'ide' ? null : S.tabs[0]);
    S.active = next ? next.id : null;
    if (next) activate(next.id);
  }
  if (t.kind === 'claude') refreshHistory(t.projectId).then(renderSide);
  renderAll();
}
api.on('pty:data', (id, d) => {
  const t = tabById(id);
  if (t) t.term.write(d);
  else { if (!early.has(id)) early.set(id, []); early.get(id).push(d); }
});
api.on('pty:exit', (id, code) => {
  const t = tabById(id); if (!t) return;
  t.exited = true; t.status = 'exited';
  t.term.write(`\r\n\x1b[90m[İşlem sona erdi${code ? ' · çıkış kodu ' + code : ''}. Sekmeyi kapatabilirsin.]\x1b[0m\r\n`);
  S.pending = S.pending.filter(p => p.tabId !== id);
  S.agents = S.agents.filter(a => a.tabId !== id);
  if (t.kind === 'claude') refreshHistory(t.projectId).then(renderSide);
  renderAll();
});
new ResizeObserver(() => fitActive()).observe($('#termHost'));

/* ---------------- Claude Code hook events ---------------- */
function toolSummary(input) {
  if (!input) return '';
  if (input.command) return input.command;
  if (input.file_path) return input.file_path;
  if (input.url) return input.url;
  if (input.pattern) return input.pattern;
  if (input.description) return input.description;
  try { return JSON.stringify(input).slice(0, 300); } catch (_) { return ''; }
}
function addPending(t, card) {
  S.pending = S.pending.filter(p => !(p.tabId === t.id && p.kind === card.kind));
  S.pending.push({ id: 'd' + (seq++), tabId: t.id, t: Date.now(), ...card });
  t.status = 'waiting';
}
function clearPending(t) { S.pending = S.pending.filter(p => p.tabId !== t.id); }
function addAgent(t, kind, name, toolUseId) { S.agents.push({ id: 'a' + (seq++), tabId: t.id, kind, name: shorten(name, 80), toolUseId, t: Date.now() }); }
function finishAgent(t, toolUseId, kind) {
  let a = toolUseId && S.agents.find(x => x.toolUseId === toolUseId);
  if (!a) a = S.agents.find(x => x.tabId === t.id && x.kind === kind);
  if (a) S.agents = S.agents.filter(x => x !== a);
  return a;
}
api.on('hook', ev => {
  S.lastHook = { name: ev.hook_event_name, session: ev.session_id, at: Date.now() };
  const t = tabBySession(ev.session_id);
  if (!t) return;
  const name = ev.hook_event_name, tool = ev.tool_name, input = ev.tool_input || {};
  if (name === 'UserPromptSubmit') {
    clearPending(t); t.status = 'running';
    if (t.title === 'Yeni oturum' && ev.prompt) t.title = shorten(ev.prompt, 48);
    if (!t.prompted) { t.prompted = true; saveOpenTabs(); }
  } else if (name === 'PreToolUse') {
    S.lastTool[t.id] = { tool, input };
    if (t.status !== 'waiting') t.status = 'running';
    if (SUB_TOOLS.has(tool)) {
      const n = input.description || input.subagent_type || 'Alt ajan';
      addAgent(t, 'subagent', n, ev.tool_use_id);
      notify('subagent', 'Alt ajan açıldı', `${shorten(n, 60)} · ${t.title}`, t.id);
    } else if (tool === 'Workflow') {
      const n = input.name || input.description || 'Workflow';
      addAgent(t, 'workflow', n, ev.tool_use_id);
      notify('workflow', 'Workflow açıldı', `${shorten(n, 60)} · ${t.title}`, t.id);
    } else if (tool === 'AskUserQuestion') {
      const q = (input.questions || [])[0] || {};
      addPending(t, { kind: 'question', q: q.question || 'Claude bir soru soruyor', options: (q.options || []).map(o => (o && o.label) || String(o)).slice(0, 6), multi: !!q.multiSelect, more: (input.questions || []).length > 1 });
      notify('decision', 'Claude soru soruyor', `${t.title}: ${q.question || ''}`, t.id);
    } else if (tool === 'ExitPlanMode') {
      addPending(t, { kind: 'plan', q: 'Plan onayını bekliyor', detail: String(input.plan || '').slice(0, 2000) });
      notify('decision', 'Plan onayı bekleniyor', t.title, t.id);
    }
  } else if (name === 'PostToolUse') {
    if (SUB_TOOLS.has(tool) || tool === 'Workflow') {
      const a = finishAgent(t, ev.tool_use_id, tool === 'Workflow' ? 'workflow' : 'subagent');
      if (a) notify(a.kind, a.kind === 'workflow' ? 'Workflow bitti' : 'Alt ajan bitti', `${shorten(a.name, 60)} · ${t.title}`, t.id);
    }
    if (EDIT_TOOLS.has(tool) && (input.file_path || input.notebook_path)) fileChangedByClaude(input.file_path || input.notebook_path, tool === 'Write');
    clearPending(t);
    if (t.status === 'waiting') t.status = 'running';
  } else if (name === 'Notification') {
    const msg = ev.message || '';
    const type = ev.notification_type || '';
    if (type === 'permission_prompt' || /permission/i.test(msg)) {
      if (!S.pending.some(p => p.tabId === t.id && (p.kind === 'question' || p.kind === 'plan'))) {
        const lt = S.lastTool[t.id] || {};
        addPending(t, { kind: 'permission', q: msg || 'İzin istiyor', detail: lt.tool ? `${lt.tool}: ${toolSummary(lt.input)}` : '' });
        notify('decision', 'Kararını bekliyor', `${t.title}: ${msg}`, t.id);
      }
    }
  } else if (name === 'Stop') {
    clearPending(t);
    const was = t.status;
    t.status = 'done';
    S.agents = S.agents.filter(a => a.tabId !== t.id);
    if (was === 'running' || was === 'waiting') notify('done', 'İş bitti' + (addr() ? ', ' + addr() : ''), `${t.title} · ${(proj(t.projectId) || {}).name || ''}`, t.id);
    refreshHistory(t.projectId).then(renderSide);
  } else if (name === 'SessionEnd') {
    refreshHistory(t.projectId).then(renderSide);
  }
  renderAll();
});

function decide(id, c) {
  const p = S.pending.find(x => x.id === id); if (!p) return;
  const t = tabById(p.tabId);
  if (c === 'goto') { if (S.mode !== 'claude') setMode('claude'); if (t) activate(t.id); return; }
  if (t && !t.exited) {
    const keys = { yes: '1', always: '2', no: '\x1b' };
    if (keys[c]) api.send('pty:write', t.id, keys[c]);
    else if (c.startsWith('opt')) api.send('pty:write', t.id, String(+c.slice(3) + 1));
    t.status = 'running';
  }
  S.pending = S.pending.filter(x => x !== p);
  renderAll();
}

/* ---------------- live sessions opened outside Claudelot ----------------
   The main process lists running Claude sessions that none of our terminals own.
   Clicking one opens a read-only "watch" tab that follows its transcript, so an
   outside session is never started a second time with --resume. */
const LIVE_ST = { busy: 'running', waiting: 'waiting', idle: 'idle' };
const waitText = w => !w ? 'Kararını bekliyor' : /permission|izin/i.test(w) ? 'İzin bekliyor' : /dialog/i.test(w) ? 'Bir soruya cevap bekliyor' : w;
const projOfCwd = cwd => cwd && S.projects.find(p => normPath(p.path) === normPath(cwd));
const outsideOf = pid => S.live.filter(s => { const p = projOfCwd(s.cwd); return p && p.id === pid; });
const isExtLive = sid => S.live.some(s => s.sessionId === sid);
const watchTab = sid => S.tabs.find(t => t.kind === 'watch' && t.sessionId === sid);
const extWaiting = () => S.live.filter(s => s.status === 'waiting');
const pendingCount = () => S.pending.length + extWaiting().length;

const liveWorked = new Set(); // outside sessions seen working since their last 'done'
function setLive(list) {
  const prev = new Map(S.live.map(s => [s.sessionId, s.status]));
  S.live = (list || []).filter(s => !S.tabs.some(t => t.kind !== 'watch' && t.sessionId === s.sessionId));
  for (const s of S.live) {
    const was = prev.get(s.sessionId);
    if (!was) continue;
    const w = watchTab(s.sessionId);
    const where = `${shorten(s.title, 60)} · ${(projOfCwd(s.cwd) || {}).name || baseName(s.cwd)} (dışarıda)`;
    // a turn can pass through 'waiting' (permission asked) before it finishes
    if (s.status === 'busy' || s.status === 'waiting') liveWorked.add(s.sessionId);
    const target = w ? w.id : 'watch:' + s.sessionId; // a click opens the session even if no tab is open yet
    if (!w && s.status === 'waiting' && was !== 'waiting') S.extAttn.set(s.sessionId, 'ask');
    if (s.status === 'idle' && was !== 'idle' && liveWorked.has(s.sessionId) && !w) S.extAttn.set(s.sessionId, 'done');
    if (s.status === 'busy') S.extAttn.delete(s.sessionId);
    if (s.status === 'idle' && was !== 'idle' && liveWorked.delete(s.sessionId)) notify('done', 'İş bitti' + (addr() ? ', ' + addr() : ''), where, target);
    if (was !== 'waiting' && s.status === 'waiting') notify('decision', 'Kararını bekliyor', `${where}: ${waitText(s.waitingFor)}`, target);
  }
  for (const t of S.tabs.filter(x => x.kind === 'watch')) {
    const s = S.live.find(x => x.sessionId === t.sessionId);
    t.ext = s || null;
    t.status = s ? LIVE_ST[s.status] || 'idle' : 'exited';
    if (s) t.title = shorten(s.title, 48);
    renderWatchBar(t);
  }
  renderAll();
}

function openWatch(sid) {
  const ex = watchTab(sid);
  if (ex) { if (S.mode === 'ide' && ex.projectId && ex.projectId !== IDE.project) switchIdeProject(ex.projectId); activate(ex.id); return ex; }
  const s = S.live.find(x => x.sessionId === sid);
  const p = s && projOfCwd(s.cwd);
  const el = document.createElement('div');
  el.className = 'term-pane watch-pane';
  el.innerHTML = '<div class="watch-bar"></div><div class="watch-term"><div class="watch-note">Terminale bağlanılıyor…</div></div><div class="watch-log" hidden><div class="watch-note">Konuşma okunuyor…</div></div>';
  $('#termHost').appendChild(el);
  const tab = {
    id: 'w' + (seq++), kind: 'watch', sessionId: sid, projectId: p ? p.id : null, cwd: s ? s.cwd : '',
    el, exited: false, prompted: false, ext: s || null, offset: 0, first: true, stick: true, view: 'term',
    title: shorten(s ? s.title : 'Oturum', 48), status: s ? LIVE_ST[s.status] || 'idle' : 'exited',
    mirror: null, mirrorState: 'connecting', fontSize: 13,
  };
  const log = el.querySelector('.watch-log');
  log.addEventListener('scroll', () => { tab.stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60; });
  log.addEventListener('click', e => {
    const a = e.target.closest('a[href]'); if (!a) return;
    e.preventDefault();
    if (/^https?:/i.test(a.getAttribute('href'))) window.open(a.getAttribute('href'));
  });
  el.querySelector('.watch-bar').addEventListener('click', e => {
    const b = e.target.closest('[data-wview]'); if (b) setWatchView(tab, b.dataset.wview);
  });
  S.tabs.push(tab);
  if (tab.projectId) S.collapsed[tab.projectId] = false;
  renderWatchBar(tab);
  pollWatch(tab);
  tab.timer = setInterval(() => pollWatch(tab), 1500);
  connectMirror(tab);
  if (S.mode === 'ide' && tab.projectId && tab.projectId !== IDE.project) switchIdeProject(tab.projectId);
  activate(tab.id);
  return tab;
}
/* the live terminal of the outside session, mirrored into an xterm */
async function connectMirror(t) {
  if (!t.ext) { t.mirrorState = 'off'; setWatchView(t, 'log'); return; }
  try {
    const r = await api.invoke('mirror:start', t.sessionId);
    if (!S.tabs.includes(t)) { api.send('mirror:stop', r.id); return; }
    t.mirror = r.id;
  } catch (e) { mirrorFailed(t, cleanErr(e)); }
}
function mirrorFailed(t, msg) {
  t.mirror = null; t.mirrorState = 'failed';
  const box = t.el.querySelector('.watch-term');
  if (!t.term) box.innerHTML = `<div class="watch-note">${esc(msg || 'Terminale bağlanılamadı.')}<br>Konuşma görünümüne geçildi.</div>`;
  renderWatchBar(t);
  if (!t.term) setWatchView(t, 'log');
}
function mirrorTerm(t) {
  if (t.term) return t.term;
  const box = t.el.querySelector('.watch-term');
  box.innerHTML = '';
  const term = new Terminal({
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace', fontSize: t.fontSize, lineHeight: 1.15,
    cursorBlink: true, scrollback: 0, allowProposedApi: true, theme: termTheme(),
  });
  term.open(box);
  term.onData(d => { if (t.mirror) api.send('mirror:input', t.mirror, d); });
  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === 'c' && (e.shiftKey || term.hasSelection())) {
      if (term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()).catch(() => {}); term.clearSelection(); }
      return false;
    }
    if (e.ctrlKey && k === 'v') return false; // the paste event delivers the text
    return true;
  });
  t.term = term;
  new ResizeObserver(() => fitMirrorFont(t)).observe(box);
  return term;
}
// The mirrored screen keeps the outside window's columns and rows, so scale the font
// both ways: down when it overflows the pane, up until it fills the pane.
const MIRROR_FONT = [8, 24];
function fitMirrorFont(t, again) {
  if (!t.term || !t.el.offsetParent) return;
  const box = t.el.querySelector('.watch-term'), scr = box.querySelector('.xterm-screen');
  if (!scr || !scr.offsetWidth) return;
  const ratio = Math.min((box.clientWidth - 16) / scr.offsetWidth, (box.clientHeight - 8) / scr.offsetHeight);
  const next = Math.max(MIRROR_FONT[0], Math.min(MIRROR_FONT[1], Math.floor(t.fontSize * ratio * 2) / 2));
  if (Math.abs(next - t.fontSize) >= 0.5) {
    t.fontSize = next; t.term.options.fontSize = next;
    // the cell size settles after the next paint; check once more
    if (!again) requestAnimationFrame(() => fitMirrorFont(t, true));
  }
}
function onMirrorFrame(t, f) {
  const first = t.mirrorState !== 'live';
  const term = mirrorTerm(t);
  if (term.cols !== f.cols || term.rows !== f.rows) { term.resize(f.cols, f.rows); requestAnimationFrame(() => fitMirrorFont(t)); }
  term.write('\x1b[?25l\x1b[H' + f.vt + '\x1b[0m\x1b[J' + `\x1b[${f.cy + 1};${f.cx + 1}H` + (f.vis ? '\x1b[?25h' : ''));
  if (first) {
    t.mirrorState = 'live';
    renderWatchBar(t);
    if (t.view === 'term' && S.active === t.id) requestAnimationFrame(() => { fitMirrorFont(t); term.focus(); });
  }
}
api.on('mirror:frame', (id, f) => { const t = S.tabs.find(x => x.mirror === id); if (t) onMirrorFrame(t, f); });
api.on('mirror:error', (id, msg) => { const t = S.tabs.find(x => x.mirror === id); if (t) mirrorFailed(t, msg); });
api.on('mirror:exit', id => {
  const t = S.tabs.find(x => x.mirror === id); if (!t) return;
  t.mirror = null;
  t.mirrorState = t.ext ? 'failed' : 'off';
  if (t.term) t.term.write('\x1b[0m\x1b[?25l');
  renderWatchBar(t);
});
function setWatchView(t, v) {
  t.view = v;
  t.el.querySelector('.watch-term').hidden = v !== 'term';
  t.el.querySelector('.watch-log').hidden = v !== 'log';
  renderWatchBar(t);
  requestAnimationFrame(() => {
    if (v === 'term') { fitMirrorFont(t); if (t.term) t.term.focus(); }
    else { const log = t.el.querySelector('.watch-log'); if (t.stick) log.scrollTop = log.scrollHeight; }
  });
}
function renderWatchBar(t) {
  const bar = t.el.querySelector('.watch-bar'); if (!bar) return;
  const s = t.ext;
  const st = s ? (s.status === 'waiting' ? waitText(s.waitingFor) : s.status === 'busy' ? 'Çalışıyor' : 'Hazır') : '';
  const conn = !s ? 'kapandı' : t.mirrorState === 'live' ? 'terminale bağlı, yazdıkların o pencereye gider' : t.mirrorState === 'connecting' ? 'terminale bağlanılıyor…' : 'terminale bağlanılamadı, sadece konuşma görünüyor';
  bar.innerHTML = `<span class="dot ${t.status}"></span>`
    + `<span class="wb-t"><b>${s ? 'Claudelot dışında açık' : 'Dışarıdaki oturum kapandı'}</b>${st ? ' · ' + esc(st) : ''}`
    + `<small>${esc(s ? s.cwd : t.cwd)}${s ? ' · PID ' + s.pid : ''} · ${conn}</small></span>`
    + `<span class="seg wb-seg"><button class="${t.view === 'term' ? 'on' : ''}" data-wview="term" ${t.term || t.mirrorState === 'connecting' ? '' : 'disabled'}><i class="fa-solid fa-terminal"></i> Terminal</button><button class="${t.view === 'log' ? 'on' : ''}" data-wview="log"><i class="fa-regular fa-comments"></i> Konuşma</button></span>`
    + (s
      ? `<button class="btn" data-takeover="${t.sessionId}" title="Dışarıdaki claude sürecini kapatır, konuşmaya bir Claudelot terminalinde kaldığı yerden devam eder"><i class="fa-solid fa-right-to-bracket"></i> Claudelot'a taşı</button>`
      : `<button class="btn primary" data-continue="${t.sessionId}" title="Konuşmaya bir Claudelot terminalinde kaldığı yerden devam eder"><i class="fa-solid fa-play"></i> Claudelot'ta devam et</button>`);
}
function watchEntryHTML(e) {
  const tm = e.ts ? new Date(e.ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : '';
  if (e.k === 'user') return `<div class="wm user"><div class="wm-h">Sen<span>${tm}</span></div><div class="wm-b">${esc(e.text)}</div></div>`;
  if (e.k === 'ai') return `<div class="wm ai"><div class="wm-h">Claude<span>${tm}</span></div><div class="wm-b md">${DOMPurify.sanitize(marked.parse(e.text, { gfm: true, breaks: false }))}</div></div>`;
  return `<div class="wm tool" title="${esc(e.name)}: ${esc(e.text)}"><i class="fa-solid fa-wrench"></i><b>${esc(e.name)}</b><span>${esc(e.text)}</span></div>`;
}
async function pollWatch(t) {
  if (t.busy || !S.tabs.includes(t)) return;
  t.busy = true;
  try {
    const r = await api.invoke('live:tail', t.sessionId, t.offset);
    if (!r) return;
    const log = t.el.querySelector('.watch-log');
    if (t.first || r.offset < t.offset) {
      log.innerHTML = r.missing ? '<div class="watch-note">Konuşma kaydı bulunamadı.</div>' : r.trimmed ? '<div class="watch-note">Uzun konuşma: son kısmı gösteriliyor.</div>' : '';
      t.first = false;
    }
    t.offset = r.offset;
    if (!r.entries.length) {
      if (!log.children.length) log.innerHTML = '<div class="watch-note empty">Henüz mesaj yok.</div>';
      return;
    }
    const empty = log.querySelector('.watch-note.empty'); if (empty) empty.remove();
    log.insertAdjacentHTML('beforeend', r.entries.map(watchEntryHTML).join(''));
    while (log.children.length > 1500) log.firstElementChild.remove();
    if (t.stick) log.scrollTop = log.scrollHeight;
  } catch (_) {
  } finally { t.busy = false; }
}
async function takeOverSession(sid) {
  const s = S.live.find(x => x.sessionId === sid);
  if (!s) return continueHere(sid);
  const warn = s.status === 'busy' ? '\n\nDİKKAT: Oturum şu an çalışıyor; yarım kalan iş kesilir.' : '';
  if (!confirm(`"${shorten(s.title, 60)}" şu an başka bir terminalde açık (PID ${s.pid}).\n\nClaudelot'a almak için oradaki claude süreci kapatılacak, konuşma burada kaldığı yerden devam edecek.${warn}\n\nDevam edilsin mi?`)) return;
  const r = await api.invoke('live:takeover', sid);
  if (!r || !r.ok) { toast('Devralınamadı', (r && r.error) || ''); return; }
  await continueHere(sid, s.cwd);
}
async function continueHere(sid, cwd) {
  const w = watchTab(sid);
  const title = w ? w.title : 'Oturum';
  cwd = cwd || (w && w.cwd);
  S.live = S.live.filter(x => x.sessionId !== sid);
  let p = (w && proj(w.projectId)) || projOfCwd(cwd);
  if (!p && cwd) { const np = await api.invoke('project:addPath', cwd); if (np) { await projectAdded(np); p = proj(np.id); } }
  if (!p) { toast('Proje bulunamadı', cwd || ''); return; }
  if (w) closeTab(w.id);
  await openTerminal({ kind: 'claude', projectId: p.id, resume: sid, title });
}

/* ---------------- rendering: claude mode ---------------- */
const chevron = '<i class="fa-solid fa-chevron-down chev" aria-hidden="true"></i>';
// projects start folded unless they have an open terminal; a click on the header overrides that
const isCollapsed = pid => (pid in S.collapsed ? S.collapsed[pid] : !S.tabs.some(t => t.projectId === pid) && !outsideOf(pid).length);
function renderSide() {
  const activeProjects = S.projects.filter(p => S.tabs.some(t => t.projectId === p.id) || outsideOf(p.id).length);
  const orphans = S.live.filter(s => !projOfCwd(s.cwd));
  const orphanTabs = S.tabs.filter(t => t.kind === 'watch' && !t.projectId && !t.ext);
  if (!activeProjects.length && !orphans.length && !orphanTabs.length) {
    $('#side').innerHTML = `<div class="side-empty"><i class="fa-solid fa-play"></i><b>Açık oturum yok</b><span>Üstteki <b>Proje Başlat</b> ile bir proje seç; geçmiş oturumlar da orada.</span></div>`;
    if (!$('#startPanel').hidden) renderStartList();
    return;
  }
  $('#side').innerHTML = activeProjects.map(p => {
    const live = S.tabs.filter(t => t.projectId === p.id && !(t.kind === 'watch' && t.ext));
    const ext = outsideOf(p.id);
    const liveIds = new Set([...live.map(t => t.sessionId), ...ext.map(s => s.sessionId)].filter(Boolean));
    const hist = (S.history[p.id] || []).filter(h => !liveIds.has(h.id));
    const limit = S.showAll[p.id] ? 40 : 5;
    const items = live.map(t => `<li><button class="sess live ${t.id === S.active ? 'active' : ''}${attnCls(t.attn)}" data-tab="${t.id}" title="${esc(t.title)} · ${STATUS_TEXT[t.status]}">${tabIcon(t)}<span class="sess-t">${esc(t.title)}</span><span class="sess-time">${STATUS_SHORT[t.status]}</span></button></li>`).join('')
      + ext.map(s => extRow(s)).join('')
      + hist.slice(0, limit).map(h => `<li><button class="sess" data-resume="${h.id}" data-pid="${p.id}" title="${esc(h.title)}&#10;Kaldığı yerden devam ettirmek için tıkla"><span class="dot idle"></span><span class="sess-t">${esc(h.title)}</span><span class="sess-time">${rel(h.mtime)}</span></button></li>`).join('')
      + (hist.length > limit ? `<li><button class="sess-more" data-more="${p.id}">+ ${hist.length - limit} oturum daha</button></li>` : '')
      + (!live.length && !ext.length && !hist.length ? '<li class="empty-side" style="padding:4px 8px">Henüz oturum yok</li>' : '');
    return `<div class="proj ${isCollapsed(p.id) ? 'collapsed' : ''}">
      <div class="proj-row">
        <button class="proj-toggle" data-toggle="${p.id}">${chevron}<span class="proj-name">${esc(p.name)}</span><span class="proj-path" title="${esc(p.path)}">${esc(p.path)}</span></button>
        <button class="proj-more" data-projmenu="${p.id}" title="Proje seçenekleri" aria-label="Proje seçenekleri"><i class="fa-solid fa-ellipsis"></i></button>
        <span class="split"><button class="new-btn" data-new="${p.id}" title="Bu projede yeni Claude oturumu başlat"><i class="fa-solid fa-plus"></i> Oturum</button><button class="new-btn caret" data-newmenu="${p.id}" title="Terminal ya da PowerShell aç" aria-label="Diğer terminal türleri"><i class="fa-solid fa-caret-down"></i></button></span>
      </div>
      <ul class="sess-list">${items}</ul>
    </div>`;
  }).join('');
  if (orphans.length || orphanTabs.length) {
    $('#side').insertAdjacentHTML('beforeend', `<div class="proj ext-group">
      <div class="proj-row"><span class="proj-toggle" title="Claudelot'taki projelerin dışındaki klasörlerde açık oturumlar"><i class="fa-solid fa-eye chev" aria-hidden="true"></i><span class="proj-name">Diğer klasörler</span></span></div>
      <ul class="sess-list">${orphans.map(s => extRow(s, true)).join('')}${orphanTabs.map(t => `<li><button class="sess live ${t.id === S.active ? 'active' : ''}" data-tab="${t.id}">${tabIcon(t)}<span class="sess-t">${esc(t.title)}</span><span class="sess-time">kapandı</span></button></li>`).join('')}</ul>
    </div>`);
  }
}
function extRow(s, showDir) {
  const w = watchTab(s.sessionId), st = LIVE_ST[s.status] || 'idle';
  const tip = `${s.title}\n${s.cwd}\nClaudelot dışında açık (PID ${s.pid}) · ${s.status === 'waiting' ? waitText(s.waitingFor) : STATUS_TEXT[st]}\nİzlemek için tıkla`;
  const at = w ? w.attn : S.extAttn.get(s.sessionId);
  return `<li><button class="sess live ext ${w && w.id === S.active ? 'active' : ''}${attnCls(at)}" data-watch="${s.sessionId}" title="${esc(tip)}"><span class="dot ${st}"></span><span class="sess-t">${showDir ? `<span class="sess-dir">${esc(baseName(s.cwd))}</span> ` : ''}${esc(s.title)}</span><span class="sess-time ext-tag">dışarıda</span></button></li>`;
}
function renderTabs() {
  const tabHTML = t => `<div class="tab ${t.id === S.active ? 'active' : ''}${attnCls(t.attn)}" role="tab"><button data-tab="${t.id}" title="${esc((proj(t.projectId) || {}).name)} · ${esc(t.title)} · ${STATUS_TEXT[t.status]}"><span class="tab-p">${esc((proj(t.projectId) || {}).name || '')}</span>${tabIcon(t)}<span class="tab-t">${esc(t.title)}</span></button><button class="tab-x" data-close="${t.id}" aria-label="Terminali kapat" title="Kapat">×</button></div>`;
  $('#tabs').innerHTML = S.tabs.length ? S.tabs.map(tabHTML).join('') : '<span class="tabs-empty">Açık terminal yok</span>';
  // IDE bottom panel: only the selected project's terminals
  const pt = S.tabs.filter(t => t.projectId === IDE.project);
  $('#ptabs').innerHTML = pt.map(t => `<button class="ptab ${t.id === S.active ? 'on' : ''}${attnCls(t.attn)}" data-tab="${t.id}" title="${esc(t.title)}">${tabIcon(t)}${esc(t.title)}</button>`).join('')
    + (IDE.project ? `<button class="ptab new" data-new="${IDE.project}"><i class="fa-solid fa-plus"></i> Oturum</button><button class="ptab new caret" data-newmenu="${IDE.project}" title="Terminal ya da PowerShell aç" aria-label="Diğer terminal türleri"><i class="fa-solid fa-caret-down"></i></button>` : '');
  // empty state over the terminal area
  let empty = $('#termEmpty');
  if (!empty) { empty = document.createElement('div'); empty.id = 'termEmpty'; empty.className = 'term-empty'; $('#termHost').appendChild(empty); }
  const visible = tabById(S.active) && (S.mode === 'claude' || tabById(S.active).projectId === IDE.project);
  empty.hidden = !!visible;
  if (!visible) {
    $$('.term-pane').forEach(x => x.classList.remove('on'));
    empty.innerHTML = `<div>${S.projects.length ? 'Açık terminal yok.<br>Sol üstteki <b>Proje Başlat</b> ile bir proje seç ya da <b>Ctrl+Shift+N</b> ile yeni oturum aç.' : 'Başlamak için soldan “+ Proje ekle”.'}</div>`;
  }
}
function renderQueue() {
  $('#qCount').textContent = pendingCount();
  const extCards = extWaiting().map(s => `<div class="card ext">
      <div class="card-top"><span class="chip">Dışarıda</span><button class="ghost who" data-watch="${s.sessionId}"><b>${esc(shorten(s.title, 60))}</b> · ${esc((projOfCwd(s.cwd) || {}).name || baseName(s.cwd))}</button></div>
      <div class="card-q">${esc(waitText(s.waitingFor))}</div>
      <div class="card-n">Bu oturum Claudelot dışında açık; cevabı kendi penceresinden ver ya da oturumu buraya al.</div>
      <div class="acts"><button class="btn" data-watch="${s.sessionId}">İzle</button><button class="btn" data-takeover="${s.sessionId}">Claudelot'a al</button></div></div>`).join('');
  $('#queue').innerHTML = pendingCount() ? extCards + S.pending.map(d => {
    const t = tabById(d.tabId) || { title: '?' }, p = proj(t.projectId) || {};
    const label = { permission: 'İzin', plan: 'Plan', question: 'Soru' }[d.kind];
    let acts;
    if (d.kind === 'permission') acts = `<button class="btn primary" data-dec="${d.id}" data-c="yes" title="Terminale 1 gönderir">Evet</button><button class="btn" data-dec="${d.id}" data-c="always" title="Terminale 2 gönderir">Bu oturumda hep</button><button class="btn deny" data-dec="${d.id}" data-c="no" title="Terminale Esc gönderir">Hayır</button>`;
    else if (d.kind === 'question' && !d.multi && !d.more && d.options.length) acts = d.options.map((o, i) => `<button class="btn ${i === 0 ? 'primary' : ''}" data-dec="${d.id}" data-c="opt${i}" title="Terminale ${i + 1} gönderir">${esc(o)}</button>`).join('');
    else acts = '';
    acts += `<button class="btn" data-dec="${d.id}" data-c="goto">Terminale git</button>`;
    return `<div class="card ${d.kind}">
      <div class="card-top"><span class="chip">${label}</span><button class="ghost who" data-tab="${t.id}"><b>${esc(t.title)}</b> · ${esc(p.name || '')}</button></div>
      <div class="card-q">${esc(d.q)}</div>
      ${d.detail ? `<div class="card-d">${esc(d.detail)}</div>` : ''}
      ${d.kind === 'question' && (d.multi || d.more) ? `<div class="card-d">${d.options.map(esc).join('\n')}</div>` : ''}
      <div class="acts">${acts}</div></div>`;
  }).join('') : '<div class="q-empty">Bekleyen karar yok. Bir oturum izin, plan onayı ya da cevap isteyince burada görünür.</div>';
  $('#agents').innerHTML = S.agents.length ? S.agents.map(a => { const t = tabById(a.tabId) || {}; return `<div class="agent-row"><span class="k ${a.kind}">${a.kind === 'subagent' ? 'Ajan' : 'Workflow'}</span><span class="n" title="${esc(a.name)}">${esc(a.name)}</span><span class="s" title="${esc(t.title)}">${esc(t.title || '')}</span></div>`; }).join('') : '<div class="none">Şu an çalışan alt ajan ya da workflow yok.</div>';
}
function renderUsage() {
  const u = S.usage;
  const head = `<div class="panel-h">Haftalık kullanım <span class="ph-acts"><button class="ghost" data-report="1" title="Aylık kullanım raporu ve CSV (Ctrl+Shift+R)"><i class="fa-solid fa-chart-column"></i> Aylık rapor</button><button class="ghost icon" data-panel="usage" title="Gizle; özet alt çubukta kalır (Ctrl+Shift+U)" aria-label="Kullanım panelini gizle"><i class="fa-solid fa-eye-slash"></i></button></span></div>`;
  if (!u) { $('#usage').innerHTML = head + '<div class="usage-note">Hesaplanıyor…</div>'; return; }
  const max = Math.max(...u.days, 1), names = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
  const dc = u.dayCost || [];
  $('#usage').innerHTML = head
    + `<div class="days">${u.days.map((v, i) => `<div class="day ${i > u.today ? 'future' : ''} ${i === u.today ? 'today' : ''}" title="${names[i]}: ${i > u.today ? 'henüz yok' : fmtTok(v) + ' token · ≈ ' + fmtUsd(dc[i] || 0)}"><i style="${i > u.today ? '' : `height:${Math.max(3, v / max * 42)}px`}"></i><span>${names[i]}</span></div>`).join('')}</div>`
    + `<div class="usage-stats">${[
      ['Son 5 saat', u.last5h ? u.last5h.t : 0, u.last5h ? u.last5h.c : null, 'Son 5 saatte harcanan token (Claude oturum limitleri 5 saatlik pencereyle sayılır)'],
      ['Bugün', u.days[u.today], dc[u.today] || 0, 'Bugün harcanan token'],
      ['Bu hafta', u.total, u.cost, 'Pazartesiden bu yana harcanan token'],
    ].map(([l, t, c, tip]) => `<div class="us" title="${tip}"><small>${l}</small><b>${fmtTok(t)}</b>${u.cost != null && c != null ? `<span>≈ ${fmtUsd(c)}</span>` : ''}</div>`).join('')}</div>`;
}
function renderStatus() {
  const running = S.tabs.filter(t => t.status === 'running' && t.kind !== 'watch').length;
  const claudeOk = INFO && INFO.claude;
  const u = S.usage;
  const usageChip = u ? `<button class="sb-chip" data-report="1" title="Bu hafta · aylık rapor için tıkla (Ctrl+Shift+R)"><i class="fa-solid fa-chart-column"></i> ${fmtTok(u.total)} token${u.cost != null ? ' · ≈ ' + fmtUsd(u.cost) : ''}</button>` : '';
  $('#statusbar').innerHTML = `<span><b>${running}</b> çalışıyor</span><span><b>${pendingCount()}</b> karar bekliyor</span>${S.live.length ? `<span title="Claudelot dışında açık Claude oturumları"><b>${S.live.length}</b> dışarıda</span>` : ''}<span><b>${S.agents.length}</b> ajan / workflow</span><span><b>${S.tabs.filter(t => !t.exited).length}</b> açık terminal</span>`
    + `<span style="margin-left:auto"></span>${usageChip}`
    + `<button class="sb-chip" data-settab="claude" title="Yeni Claude oturumlarının varsayılanları · değiştirmek için tıkla"><i class="fa-solid fa-sliders"></i> ${esc(claudeSummary())}</button>`
    + `<span class="${claudeOk ? '' : 'warn'}">${claudeOk ? 'Claude Code bağlı' : 'claude komutu bulunamadı'} · bildirim portu ${INFO ? INFO.hookPort : '-'}</span>`;
  const pb = $('#pillBadge'); pb.hidden = !pendingCount() || S.mode !== 'ide'; pb.textContent = pendingCount();
  const bb = $('#bellBadge'); bb.hidden = !S.unread; bb.textContent = S.unread > 9 ? '9+' : S.unread;
  api.send('tray:update', { running, pending: pendingCount() });
}
function renderPop() {
  $('#nlist').innerHTML = S.notifs.length ? S.notifs.map(n => `<button class="nitem" ${n.tabId ? `data-tab="${n.tabId}"` : ''}><span class="ic ${n.type}">${ICONS[n.type] || 'i'}</span><span class="tx"><b>${esc(n.title)}</b><span>${esc(n.body)}</span></span><span class="tm">${new Date(n.t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</span></button>`).join('') : '<div class="n-empty">Henüz bildirim yok.</div>';
}
/* A tab that finished or asks something blinks until it is looked at. */
const attnCls = a => (a ? ` attn attn-${a}` : '');
function trackAttention() {
  const looking = document.hasFocus();
  for (const t of S.tabs) {
    if (t.lastSt === t.status) continue;
    const finished = t.status === 'done' || (t.kind === 'watch' && t.status === 'idle' && (t.lastSt === 'running' || t.lastSt === 'waiting'));
    if (t.lastSt && (finished || t.status === 'waiting') && !(looking && t.id === S.active)) t.attn = t.status === 'waiting' ? 'ask' : 'done';
    else if (t.status === 'running') t.attn = null;
    t.lastSt = t.status;
  }
}
function renderAll() {
  trackAttention();
  renderSide(); renderTabs(); renderQueue(); renderStatus(); renderPanelBadges();
  if (S.mode === 'ide') renderIde();
  if (!$('#pop').hidden) renderPop();
}

/* ---------------- IDE mode ---------------- */
const IDE = { project: null, files: {}, dirCache: {}, expanded: {}, cm: null, state: {}, ui: { ex: true, panel: true, size: 13 }, mdView: new Set() };
const MODES = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'text/typescript', tsx: 'text/typescript-jsx', json: 'application/json',
  css: 'css', scss: 'text/x-scss', less: 'text/x-less', html: 'htmlmixed', htm: 'htmlmixed', xml: 'xml', svg: 'xml', vue: 'htmlmixed',
  md: 'markdown', markdown: 'markdown', py: 'python', go: 'go', rs: 'rust', c: 'text/x-csrc', h: 'text/x-csrc', cpp: 'text/x-c++src', hpp: 'text/x-c++src', cc: 'text/x-c++src',
  cs: 'text/x-csharp', java: 'text/x-java', kt: 'text/x-kotlin', dart: 'text/x-java', sh: 'shell', bash: 'shell', ps1: 'powershell', psm1: 'powershell',
  yml: 'yaml', yaml: 'yaml', sql: 'sql', toml: 'toml', dockerfile: 'dockerfile', gd: 'python',
};
const extOf = p => { const b = p.split(/[\\/]/).pop().toLowerCase(); return b === 'dockerfile' ? 'dockerfile' : (b.includes('.') ? b.split('.').pop() : ''); };
const baseName = p => p.split(/[\\/]/).pop();
/* file icons (Font Awesome): [icon class, colour] per extension */
const FILE_TYPES = {
  js: ['fa-brands fa-js', '#e5c04a'], mjs: ['fa-brands fa-js', '#e5c04a'], cjs: ['fa-brands fa-js', '#e5c04a'], jsx: ['fa-brands fa-react', '#38bdf8'],
  ts: ['fa-solid fa-file-code', '#4b8fe0'], tsx: ['fa-brands fa-react', '#4b8fe0'], json: ['fa-solid fa-file-code', '#f2b155'],
  md: ['fa-brands fa-markdown', '#a78bfa'], markdown: ['fa-brands fa-markdown', '#a78bfa'],
  css: ['fa-brands fa-css3-alt', '#38bdf8'], scss: ['fa-brands fa-sass', '#e070a8'], sass: ['fa-brands fa-sass', '#e070a8'], less: ['fa-brands fa-less', '#5b8fd0'],
  html: ['fa-brands fa-html5', '#f0884a'], htm: ['fa-brands fa-html5', '#f0884a'], xml: ['fa-solid fa-file-code', '#f0884a'], svg: ['fa-solid fa-file-image', '#f0b44a'],
  vue: ['fa-brands fa-vuejs', '#42b883'], py: ['fa-brands fa-python', '#5a9fd4'], java: ['fa-brands fa-java', '#e07a4f'], go: ['fa-brands fa-golang', '#29beb0'],
  rs: ['fa-brands fa-rust', '#e0855a'], php: ['fa-brands fa-php', '#8892d8'], swift: ['fa-brands fa-swift', '#f07a4a'], dart: ['fa-solid fa-file-code', '#3cb4e6'],
  cs: ['fa-solid fa-hashtag', '#9b7be6'], c: ['fa-solid fa-c', '#6b9be0'], h: ['fa-solid fa-c', '#8a9bb0'], cpp: ['fa-solid fa-file-code', '#6b9be0'],
  kt: ['fa-solid fa-file-code', '#a97bff'], rb: ['fa-solid fa-gem', '#e05555'], gd: ['fa-solid fa-gamepad', '#6aa0d8'],
  sh: ['fa-solid fa-terminal', '#7fc47f'], bash: ['fa-solid fa-terminal', '#7fc47f'], ps1: ['fa-solid fa-terminal', '#5a8fe6'], bat: ['fa-solid fa-terminal', '#9aa3ad'], cmd: ['fa-solid fa-terminal', '#9aa3ad'],
  yml: ['fa-solid fa-sliders', '#e07a8a'], yaml: ['fa-solid fa-sliders', '#e07a8a'], toml: ['fa-solid fa-sliders', '#c6a080'], ini: ['fa-solid fa-sliders', '#9aa3ad'],
  conf: ['fa-solid fa-sliders', '#9aa3ad'], config: ['fa-solid fa-sliders', '#9aa3ad'], env: ['fa-solid fa-key', '#e5c04a'], htaccess: ['fa-solid fa-shield-halved', '#9aa3ad'],
  sql: ['fa-solid fa-database', '#f0a640'], db: ['fa-solid fa-database', '#f0a640'], sqlite: ['fa-solid fa-database', '#f0a640'],
  xlsx: ['fa-solid fa-file-excel', '#3fae6a'], xls: ['fa-solid fa-file-excel', '#3fae6a'], csv: ['fa-solid fa-file-csv', '#3fae6a'],
  docx: ['fa-solid fa-file-word', '#4b84e0'], doc: ['fa-solid fa-file-word', '#4b84e0'], pptx: ['fa-solid fa-file-powerpoint', '#e0703f'], pdf: ['fa-solid fa-file-pdf', '#e05555'],
  png: ['fa-solid fa-file-image', '#3fbfa0'], jpg: ['fa-solid fa-file-image', '#3fbfa0'], jpeg: ['fa-solid fa-file-image', '#3fbfa0'], gif: ['fa-solid fa-file-image', '#3fbfa0'],
  webp: ['fa-solid fa-file-image', '#3fbfa0'], ico: ['fa-solid fa-file-image', '#3fbfa0'],
  txt: ['fa-solid fa-file-lines', '#9aa3ad'], log: ['fa-solid fa-file-lines', '#9aa3ad'], lock: ['fa-solid fa-lock', '#8a8f98'],
  zip: ['fa-solid fa-file-zipper', '#b8925a'], rar: ['fa-solid fa-file-zipper', '#b8925a'], '7z': ['fa-solid fa-file-zipper', '#b8925a'],
  exe: ['fa-brands fa-windows', '#9aa3ad'], dll: ['fa-solid fa-gears', '#9aa3ad'], dockerfile: ['fa-brands fa-docker', '#3b9ce6'],
  gitignore: ['fa-brands fa-git-alt', '#e0703f'], gitattributes: ['fa-brands fa-git-alt', '#e0703f'], npmrc: ['fa-brands fa-npm', '#e05555'],
};
const SPECIAL_FILES = { 'package.json': ['fa-brands fa-node-js', '#7fc47f'], 'package-lock.json': ['fa-brands fa-npm', '#e05555'], 'claude.md': ['fa-solid fa-robot', '#a78bfa'] };
function fileIcon(name) {
  const b = baseName(name).toLowerCase();
  const ext = b === 'dockerfile' ? 'dockerfile' : b.startsWith('.env') ? 'env' : b.startsWith('.') && !b.slice(1).includes('.') ? b.slice(1) : (b.includes('.') ? b.split('.').pop() : '');
  const [icon, color] = SPECIAL_FILES[b] || FILE_TYPES[ext] || ['fa-regular fa-file', '#8e95a0'];
  return `<i class="fic ${icon}" style="--c:${color}" aria-hidden="true"></i>`;
}
const FOLDER = '<i class="fold fa-solid fa-folder" aria-hidden="true"></i>';
const FOLDER_OPEN = '<i class="fold fa-solid fa-folder-open" aria-hidden="true"></i>';
/* ---------- markdown view ---------- */
const isMarkdown = fp => /\.(md|markdown|mdx)$/i.test(fp);
function resolveRel(fromFile, href) {
  const parts = fromFile.split(/[\\/]/); parts.pop();
  for (const seg of href.split(/[\\/]/)) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); }
  return parts.join('\\');
}
function renderMarkdown(fp) {
  const f = IDE.files[fp]; if (!f) return;
  const el = $('#mdView');
  el.innerHTML = DOMPurify.sanitize(marked.parse(f.doc.getValue(), { gfm: true, breaks: false }));
  // local images: make paths relative to the markdown file
  el.querySelectorAll('img[src]').forEach(img => {
    const src = img.getAttribute('src');
    if (!/^(https?:|data:|file:)/i.test(src)) img.src = 'file:///' + resolveRel(fp, decodeURI(src)).replace(/\\/g, '/');
  });
  el.dataset.file = fp;
}
const ist = () => IDE.state[IDE.project] || (IDE.state[IDE.project] = { tabs: [], file: null });
let ideSaveTimer = null;
function saveIdeState() { clearTimeout(ideSaveTimer); ideSaveTimer = setTimeout(() => api.invoke('config:setIdeState', IDE.state), 400); }
const isDirty = fp => { const f = IDE.files[fp]; return !!f && !f.doc.isClean(f.gen); };

function setupEditor() {
  IDE.cm = CodeMirror($('#code'), {
    theme: 'claudelot', lineNumbers: true, matchBrackets: true, autoCloseBrackets: true, styleActiveLine: true,
    indentUnit: 2, tabSize: 2, value: '',
    extraKeys: {
      'Ctrl-S': () => saveFile(),
      'Ctrl-F': () => { $('#findIn').focus(); $('#findIn').select(); },
      Tab: cm => (cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('  ')),
      'Shift-Tab': cm => cm.indentSelection('subtract'),
    },
  });
  IDE.cm.getWrapperElement().hidden = true;
  IDE.cm.on('changes', () => renderEdChrome());
}
async function ensureLoaded(fp) {
  if (IDE.files[fp]) return true;
  let r;
  try { r = await api.invoke('fs:read', fp); } catch (e) { r = { error: cleanErr(e) }; }
  if (r.error) { toast('Dosya açılamadı', `${baseName(fp)}: ${r.error}`); return false; }
  const eol = /\r\n/.test(r.text) ? '\r\n' : '\n';
  const doc = CodeMirror.Doc(r.text, MODES[extOf(fp)] || null);
  IDE.files[fp] = { doc, gen: doc.changeGeneration(true), eol };
  return true;
}
async function openFile(fp) {
  const pid = IDE.project;
  const ok = await ensureLoaded(fp);
  const s = IDE.state[pid] || (IDE.state[pid] = { tabs: [], file: null });
  if (!ok) {
    s.tabs = s.tabs.filter(x => x !== fp);
    if (s.file === fp) s.file = s.tabs[s.tabs.length - 1] || null;
  } else {
    if (!s.tabs.includes(fp)) s.tabs.push(fp);
    s.file = fp;
  }
  saveIdeState();
  if (pid === IDE.project) showFile();
}
function showFile() {
  const fp = ist().file;
  const f = fp && IDE.files[fp];
  if (fp && !f) { openFile(fp); return; }
  const w = IDE.cm.getWrapperElement();
  const md = !!fp && isMarkdown(fp);
  w.classList.toggle('is-md', md);
  if (!f) { w.hidden = true; $('#codeEmpty').hidden = false; $('#mdView').hidden = true; }
  else {
    $('#codeEmpty').hidden = true; w.hidden = false;
    if (IDE.cm.getDoc() !== f.doc) IDE.cm.swapDoc(f.doc);
    requestAnimationFrame(() => IDE.cm.refresh());
    const view = md && IDE.mdView.has(fp);
    $('#mdView').hidden = !view;
    if (view) renderMarkdown(fp);
  }
  renderEdChrome();
  renderTree();
}
function closeFile(fp) {
  if (isDirty(fp) && !confirm(`${baseName(fp)} dosyasında kaydedilmemiş değişiklikler var. Yine de kapatılsın mı?`)) return;
  const s = ist();
  s.tabs = s.tabs.filter(x => x !== fp);
  if (s.file === fp) s.file = s.tabs[s.tabs.length - 1] || null;
  if (!Object.values(IDE.state).some(st => st.tabs.includes(fp))) delete IDE.files[fp];
  saveIdeState(); showFile();
}
async function saveFile(fp) {
  fp = fp || ist().file;
  const f = fp && IDE.files[fp]; if (!f) return false;
  let text = f.doc.getValue();
  if (f.eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  try { await api.invoke('fs:write', fp, text); } catch (e) { toast('Kaydedilemedi', cleanErr(e)); return false; }
  f.gen = f.doc.changeGeneration(true);
  renderEdChrome();
  return true;
}
async function fileChangedByClaude(fp, created) {
  const key = normPath(fp);
  S.modified[key] = Date.now();
  if (created) { // a new file may live in a folder we have cached
    const dir = key.slice(0, key.lastIndexOf('\\'));
    Object.keys(IDE.dirCache).forEach(d => { if (normPath(d) === dir) delete IDE.dirCache[d]; });
  }
  const open = Object.keys(IDE.files).find(k => normPath(k) === key);
  if (open && !isDirty(open)) {
    try {
      const r = await api.invoke('fs:read', open);
      if (!r.error) {
        const f = IDE.files[open];
        const cur = f.doc.getCursor();
        f.doc.setValue(r.text); f.doc.setCursor(cur);
        f.gen = f.doc.changeGeneration(true);
        if (open === ist().file && !$('#mdView').hidden) renderMarkdown(open);
      }
    } catch (_) {}
  }
  if (S.mode === 'ide') { renderTree(); renderEdChrome(); }
}
function renderEdChrome() {
  if (!IDE.project) return;
  const s = ist(), key = s.file;
  $('#tbSave').disabled = !(key && isDirty(key));
  $('#tbSaveAll').disabled = !s.tabs.some(isDirty);
  $('#etabs').innerHTML = s.tabs.length ? s.tabs.map(k => `<div class="etab ${k === key ? 'on' : ''}"><button data-file="${esc(k)}" title="${esc(k)}">${fileIcon(k)}${esc(baseName(k))}${isDirty(k) ? ' <span class="dirty" title="Kaydedilmedi">●</span>' : ''}</button><button class="tab-x" data-fclose="${esc(k)}" aria-label="Dosyayı kapat">×</button></div>`).join('') : '<span class="etabs-empty">Açık dosya yok</span>';
  if (!key) { $('#crumb').innerHTML = ''; return; }
  const p = proj(IDE.project);
  const relp = p && key.toLowerCase().startsWith(p.path.toLowerCase()) ? key.slice(p.path.length).replace(/^[\\/]/, '') : key;
  const dirty = isDirty(key), mod = S.modified[normPath(key)];
  $('#crumb').innerHTML = `<span>${esc(p ? p.name : '')} › ${esc(relp.split(/[\\/]/).join(' › '))}</span>`
    + (mod ? `<span class="crumb-mod">● Claude değiştirdi · ${rel(mod)}</span>` : '')
    + (isMarkdown(key) ? `<span class="seg md-seg"><button class="${IDE.mdView.has(key) ? '' : 'on'}" data-mdmode="src" title="Markdown kaynağını düzenle"><i class="fa-solid fa-code"></i> Yazı</button><button class="${IDE.mdView.has(key) ? 'on' : ''}" data-mdmode="view" title="Biçimlendirilmiş görünüm"><i class="fa-solid fa-eye"></i> Görünüm</button></span>` : '')
    + `<span class="save-wrap"><span class="${dirty ? 'crumb-mod' : ''}">${dirty ? 'Kaydedilmedi' : 'Kaydedildi'}</span><button class="btn ${dirty ? 'primary' : ''}" id="saveBtn" ${dirty ? '' : 'disabled'}>Kaydet <kbd>Ctrl+S</kbd></button></span>`;
}
async function loadDir(dir) {
  if (IDE.dirCache[dir]) return IDE.dirCache[dir];
  try { IDE.dirCache[dir] = await api.invoke('fs:list', dir); } catch (_) { IDE.dirCache[dir] = []; }
  return IDE.dirCache[dir];
}
let treeToken = 0;
async function renderTree() {
  const p = proj(IDE.project);
  if (!p) { $('#tree').innerHTML = ''; return; }
  const my = ++treeToken;
  await loadDir(p.path);
  const loadOpen = async dir => { for (const e of IDE.dirCache[dir] || []) if (e.dir && IDE.expanded[e.path]) { await loadDir(e.path); await loadOpen(e.path); } };
  await loadOpen(p.path);
  if (my !== treeToken) return;
  const cur = ist().file;
  const walk = (dir, d) => (IDE.dirCache[dir] || []).map(e => e.dir
    ? `<button class="fx dir ${IDE.expanded[e.path] ? '' : 'closed'}" style="--d:${d}" data-dir="${esc(e.path)}"><i class="car fa-solid fa-chevron-down" aria-hidden="true"></i>${IDE.expanded[e.path] ? FOLDER_OPEN : FOLDER}<span class="fn">${esc(e.name)}</span></button>` + (IDE.expanded[e.path] ? walk(e.path, d + 1) : '')
    : `<button class="fx file ${e.path === cur ? 'on' : ''} ${/^(~\$|\.)/.test(e.name) ? 'dim' : ''}" style="--d:${d}" data-file="${esc(e.path)}" title="${esc(e.name)}">${fileIcon(e.name)}<span class="fn">${esc(e.name)}</span>${S.modified[normPath(e.path)] ? '<span class="mod" title="Claude değiştirdi">M</span>' : ''}</button>`).join('');
  const html = walk(p.path, 0);
  $('#tree').innerHTML = html || '<div class="empty-side">Klasör boş.</div>';
}
function renderIde() {
  if (!IDE.project || !proj(IDE.project)) IDE.project = S.projects[0] ? S.projects[0].id : null;
  // project picker (dropdown); rebuilt only when its contents change so an open list isn't closed
  const opts = S.projects.map(p => {
    const n = S.tabs.filter(t => t.projectId === p.id && (t.status === 'running' || t.status === 'waiting')).length;
    return `<option value="${p.id}">${esc(p.name)}${n ? ` · ${n} aktif` : ''}</option>`;
  }).join('') || '<option value="">Proje yok</option>';
  const sel = $('#ideProjSel');
  if (sel.dataset.sig !== opts) { sel.innerHTML = opts; sel.dataset.sig = opts; }
  sel.value = IDE.project || '';
  const cur = proj(IDE.project);
  $('#ideProjPath').textContent = cur ? cur.path : '';
  $('#ideProjPath').title = cur ? cur.path : '';
  renderEdChrome();
}
function switchIdeProject(pid) {
  if (pid === IDE.project) return;
  IDE.project = pid;
  const live = S.tabs.filter(t => t.projectId === pid);
  if (!live.some(t => t.id === S.active)) S.active = live.length ? live[live.length - 1].id : null;
  showFile();
  renderAll();
  const t = tabById(S.active);
  if (t) { $$('.term-pane').forEach(x => x.classList.toggle('on', x === t.el)); requestAnimationFrame(fitActive); }
}
function applyIdeUi() {
  $('#ideView').classList.toggle('no-ex', !IDE.ui.ex);
  $('#bpanel').hidden = !IDE.ui.panel;
  $('#code').style.setProperty('--ed-size', IDE.ui.size + 'px');
  $('#tbEx').setAttribute('aria-pressed', IDE.ui.ex);
  $('#tbPanel').setAttribute('aria-pressed', IDE.ui.panel);
  $('#tbSize').textContent = IDE.ui.size + 'px';
  requestAnimationFrame(() => { IDE.cm.refresh(); fitActive(); });
}
function saveIdeUi() { applyIdeUi(); setCfg({ ide: { ui: IDE.ui } }); }
function findNext(q) {
  const cm = IDE.cm;
  if (!q || cm.getWrapperElement().hidden) { $('#findN').textContent = ''; return; }
  let count = 0;
  const all = cm.getSearchCursor(q, CodeMirror.Pos(0, 0), { caseFold: true });
  while (all.findNext() && count < 9999) count++;
  $('#findN').textContent = count ? count + ' eşleşme' : 'Bulunamadı';
  if (!count) return;
  let cur = cm.getSearchCursor(q, cm.getCursor('to'), { caseFold: true });
  if (!cur.findNext()) { cur = cm.getSearchCursor(q, CodeMirror.Pos(0, 0), { caseFold: true }); cur.findNext(); }
  cm.setSelection(cur.from(), cur.to());
  cm.scrollIntoView({ from: cur.from(), to: cur.to() }, 80);
}
async function askClaude() {
  const fp = ist().file, p = proj(IDE.project);
  if (!fp || !p) { toast('Önce bir dosya aç'); return; }
  let ref = '@' + (fp.toLowerCase().startsWith(p.path.toLowerCase()) ? fp.slice(p.path.length).replace(/^[\\/]/, '') : fp).replace(/\\/g, '/');
  const cm = IDE.cm;
  if (cm.somethingSelected()) {
    const a = cm.getCursor('from').line + 1, b = cm.getCursor('to').line + 1;
    ref += a === b ? ` (satır ${a})` : ` (satır ${a}-${b})`;
  }
  IDE.ui.panel = true; saveIdeUi();
  let t = tabById(S.active);
  if (!t || t.kind !== 'claude' || t.exited || t.projectId !== p.id) t = [...S.tabs].reverse().find(x => x.kind === 'claude' && !x.exited && x.projectId === p.id);
  let delay = 0;
  if (!t) { t = await openTerminal({ kind: 'claude', projectId: p.id }); delay = 2500; }
  if (!t) return;
  activate(t.id);
  setTimeout(() => { if (!t.exited) api.send('pty:write', t.id, ref + ' '); t.term.focus(); }, delay);
}

/* ---------------- mode ---------------- */
function setMode(m, initial) {
  S.mode = m;
  $$('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  $('#claudeView').hidden = m !== 'claude';
  $('#ideView').hidden = m !== 'ide';
  const host = $('#termHost');
  (m === 'ide' ? $('#ideSlot') : $('#centerSlot')).appendChild(host);
  if (m === 'ide') {
    const t = tabById(S.active);
    if (t) IDE.project = t.projectId;
    if (!IDE.project || !proj(IDE.project)) IDE.project = S.projects[0] ? S.projects[0].id : null;
    if (!S.tabs.some(x => x.id === S.active && x.projectId === IDE.project)) {
      const live = S.tabs.filter(x => x.projectId === IDE.project);
      S.active = live.length ? live[live.length - 1].id : null;
    }
    applyIdeUi();
    showFile();
  } else if (!tabById(S.active) && S.tabs.length) S.active = S.tabs[S.tabs.length - 1].id;
  const t = tabById(S.active);
  $$('.term-pane').forEach(x => x.classList.toggle('on', !!t && x === t.el));
  if (!initial) setCfg({ settings: { mode: m } });
  renderAll();
  requestAnimationFrame(() => { fitActive(); if (m === 'ide') IDE.cm.refresh(); });
}

/* ---------------- menus ---------------- */
function placeMenu(m, btn) {
  const w = $('#win').getBoundingClientRect(), r = btn.getBoundingClientRect();
  m.hidden = false;
  const left = Math.max(8, Math.min(r.right - w.left - m.offsetWidth, w.width - m.offsetWidth - 8));
  let top = r.bottom - w.top + 4;
  if (top + m.offsetHeight > w.height - 8) top = r.top - w.top - m.offsetHeight - 4;
  m.style.left = left + 'px'; m.style.top = Math.max(44, top) + 'px';
}
function openNewMenu(btn, pid, withHistory) {
  const m = $('#newMenu');
  m.innerHTML = `<button data-newkind="claude" data-pid="${pid}"><span class="mi"><i class="mic fa-solid fa-terminal"></i>Claude oturumu</span><code>${esc(claudeSummary())}</code></button>`
    + `<div class="has-sub"><button class="sub-open" type="button"><span class="mi"><i class="mic fa-solid fa-user-shield"></i>İzin moduyla başlat</span><i class="fa-solid fa-chevron-right sub-ar"></i></button>`
    + `<div class="sub">${QUICK_MODES.map(([k, l]) => `<button data-newkind="claude" data-pm="${k}" data-pid="${pid}" class="${k === 'bypassPermissions' ? 'danger' : ''}"><span>${l}</span><code>${k}</code></button>`).join('')}</div></div>`
    + `<div class="sep"></div>`
    + Object.keys(SHELLS).map(k => `<button data-newkind="${k}" data-pid="${pid}"><span class="mi">${SHELL_ICONS[k]}${SHELLS[k].name}</span><code>${SHELLS[k].exe}</code></button>`).join('');
  if (withHistory) {
    const hist = (S.history[pid] || []).slice(0, 6);
    const nRestore = (CFG.lastTabs || []).filter(t => t.projectId === pid).length;
    m.innerHTML += `<div class="sep"></div><div class="lbl">Geçmiş</div>`
      + (nRestore ? `<button data-pact="restore" data-pid="${pid}"><span class="mi"><i class="mic fa-solid fa-clock-rotate-left"></i>Son oturumları geri yükle</span><code>${nRestore}</code></button>` : '')
      + (hist.length ? hist.map(h => `<button data-resume="${h.id}" data-pid="${pid}" title="${esc(h.title)}"><span class="mi hist"><i class="mic fa-regular fa-comment"></i><span>${esc(shorten(h.title, 34))}</span></span><code>${rel(h.mtime)}</code></button>`).join('') : '<div class="lbl" style="text-transform:none;letter-spacing:0;font-weight:400">Geçmiş oturum yok</div>');
  }
  m.querySelector('.sub-open').addEventListener('click', ev => { ev.stopPropagation(); m.querySelector('.has-sub').classList.toggle('open'); });
  placeMenu(m, btn);
}
function openProjMenu(btn, pid) {
  const m = $('#newMenu');
  const n = (CFG.lastTabs || []).filter(t => t.projectId === pid).length;
  m.innerHTML = `<button data-pact="restore" data-pid="${pid}">${n ? `Son oturumları geri yükle <code>${n}</code>` : 'Son oturuma devam et'}</button><div class="sep"></div><button data-pact="open" data-pid="${pid}">Klasörü Gezgin'de aç</button><button data-pact="refresh" data-pid="${pid}">Oturum listesini yenile</button><div class="sep"></div><button class="danger" data-pact="remove" data-pid="${pid}">Listeden kaldır</button>`;
  placeMenu(m, btn);
}

/* ---------------- add project ---------------- */
async function openDiscover() {
  $('#discover').hidden = false;
  $('#discBody').innerHTML = '<h4>Klasör seç</h4><div><button class="btn primary" id="pickFolder">Klasör seç…</button></div><h4>Claude geçmişinden</h4><div id="discList" class="set-note">Aranıyor…</div>';
  const list = await api.invoke('project:discover');
  const el = $('#discList'); if (!el) return;
  el.className = '';
  el.innerHTML = list.length ? list.map(x => `<div class="disc-row"><span class="p" title="${esc(x.path)}">${esc(x.path)}</span><span class="sess-time">${rel(x.mtime)}</span><button class="btn" data-addpath="${esc(x.path)}">Ekle</button></div>`).join('') : '<div class="set-note">Listede olmayan başka proje bulunamadı.</div>';
}
async function projectAdded(p) {
  if (!p) return;
  if (!S.projects.some(x => x.id === p.id)) S.projects.push(p);
  CFG.projects = S.projects;
  await refreshHistory(p.id);
  renderAll();
  toast('Proje eklendi', p.path);
}

/* ---------------- monthly usage report ---------------- */
const REP = { hist: null, month: null };
const encodeDir = p => p.replace(/[^a-zA-Z0-9]/g, '-');
const modelName = m => /^claude-/.test(m) ? m.replace(/^claude-/, '').replace(/^(\w)/, c => c.toUpperCase()).replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1') : m;
const monthLabel = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' }); };
async function openReport() {
  $('#report').hidden = false;
  $('#repBody').innerHTML = '<div class="rep-note">Kayıtlar okunuyor…</div>';
  REP.hist = await api.invoke('usage:history');
  const months = Object.keys(REP.hist).map(k => k.slice(0, 7)).filter((v, i, a) => a.indexOf(v) === i).sort();
  if (!REP.month || !months.includes(REP.month)) REP.month = months[months.length - 1] || null;
  renderReport();
}
function renderReport() {
  const h = REP.hist || {}, m = REP.month;
  if (!m) { $('#repBody').innerHTML = '<div class="rep-note">Henüz kullanım kaydı yok.</div>'; return; }
  const months = Object.keys(h).map(k => k.slice(0, 7)).filter((v, i, a) => a.indexOf(v) === i).sort();
  const sumMonth = ym => Object.entries(h).filter(([k]) => k.startsWith(ym)).reduce((a, [, d]) => ({ t: a.t + d.t, c: a.c + d.c, n: a.n + (d.t > 0 ? 1 : 0) }), { t: 0, c: 0, n: 0 });
  const [y, mo] = m.split('-').map(Number);
  const nDays = new Date(y, mo, 0).getDate();
  const todayKey = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const daily = Array.from({ length: nDays }, (_, i) => { const k = `${m}-${String(i + 1).padStart(2, '0')}`; return { k, d: i + 1, ...(h[k] || { t: 0, c: 0, rows: {} }) }; });
  const tot = sumMonth(m);
  const prevYm = months[months.indexOf(m) - 1];
  const prev = prevYm ? sumMonth(prevYm) : null;
  const peak = daily.reduce((a, b) => (b.c > a.c ? b : a), daily[0]);
  const delta = prev && prev.c > 0 ? Math.round((tot.c - prev.c) / prev.c * 100) : null;
  // breakdowns
  const names = Object.fromEntries(S.projects.map(p => [encodeDir(p.path), p.name]));
  const byProj = {}, byModel = {};
  for (const d of daily) for (const [rk, [t, , c]] of Object.entries(d.rows || {})) {
    const [proj, model] = rk.split('|');
    const pn = names[proj] || proj.replace(/^C--Users-[^-]+-/, '').replace(/-/g, ' ');
    (byProj[pn] = byProj[pn] || { t: 0, c: 0 }); byProj[pn].t += t; byProj[pn].c += c;
    const mn = modelName(model);
    (byModel[mn] = byModel[mn] || { t: 0, c: 0 }); byModel[mn].t += t; byModel[mn].c += c;
  }
  const table = (title, obj) => {
    const rows = Object.entries(obj).filter(([, v]) => v.t > 0).sort((a, b) => b[1].c - a[1].c);
    return `<table class="rep-t"><thead><tr><th>${title}</th><th class="n">Token</th><th class="n">≈ Dolar</th></tr></thead><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}<span class="share" style="width:${tot.c ? Math.max(2, v.c / tot.c * 100) : 0}%"></span></td><td class="n">${fmtTok(v.t)}</td><td class="n">${fmtUsd(v.c)}</td></tr>`).join('') || '<tr><td colspan="3">Kayıt yok</td></tr>'}</tbody></table>`;
  };
  const max = Math.max(...daily.map(d => d.c), 0.01);
  const firstAvail = months[0];
  $('#repBody').innerHTML = `
    <div class="rep-top">
      <button class="btn" data-repmonth="${months[months.indexOf(m) - 1] || ''}" ${months.indexOf(m) > 0 ? '' : 'disabled'} aria-label="Önceki ay">‹</button>
      <h3>${monthLabel(m)}</h3>
      <button class="btn" data-repmonth="${months[months.indexOf(m) + 1] || ''}" ${months.indexOf(m) < months.length - 1 ? '' : 'disabled'} aria-label="Sonraki ay">›</button>
      <span class="sp"></span>
      <button class="btn" data-csv="${m}">Bu ayı CSV kaydet</button>
      <button class="btn" data-csv="all">Tümünü CSV kaydet</button>
    </div>
    <div class="rep-tiles">
      <div class="rep-tile"><small>Toplam</small><b>${fmtTok(tot.t)}</b><span>token</span></div>
      <div class="rep-tile"><small>API karşılığı</small><b>${fmtUsd(tot.c)}</b><span>${delta == null ? 'önceki ay verisi yok' : `<span class="${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '▲' : '▼'} %${Math.abs(delta)}</span> önceki aya göre`}</span></div>
      <div class="rep-tile"><small>Günlük ortalama</small><b>${fmtUsd(tot.n ? tot.c / tot.n : 0)}</b><span>${tot.n} aktif gün</span></div>
      <div class="rep-tile"><small>En yoğun gün</small><b>${peak.c ? peak.d + ' ' + new Date(y, mo - 1, 1).toLocaleDateString('tr-TR', { month: 'short' }) : '–'}</b><span>${peak.c ? fmtUsd(peak.c) + ' · ' + fmtTok(peak.t) + ' token' : ''}</span></div>
    </div>
    <div>
      <div class="rep-chart">${daily.map(d => `<div class="rep-bar ${d.k === todayKey ? 'today' : ''}" title="${d.d} ${monthLabel(m)}: ${fmtTok(d.t)} token · ≈ ${fmtUsd(d.c)}"><i style="height:${d.c ? Math.max(2, d.c / max * 100) : 0}%"></i></div>`).join('')}</div>
      <div class="rep-axis">${daily.map(d => `<span>${d.d === 1 || d.d % 5 === 0 ? d.d : ''}</span>`).join('')}</div>
    </div>
    <div class="rep-cols">${table('Proje', byProj)}${table('Model', byModel)}</div>
    <table class="rep-t"><thead><tr><th>Ay</th><th class="n">Aktif gün</th><th class="n">Token</th><th class="n">≈ Dolar</th></tr></thead><tbody>
      ${[...months].reverse().map(ym => { const s = sumMonth(ym); return `<tr data-month="${ym}" class="${ym === m ? 'on' : ''}"><td>${monthLabel(ym)}</td><td class="n">${s.n}</td><td class="n">${fmtTok(s.t)}</td><td class="n">${fmtUsd(s.c)}</td></tr>`; }).join('')}
    </tbody></table>
    <div class="rep-note">Dolar tutarları API liste fiyatıyla karşılıktır; abonelikte ayrıca ödenmez. Claude Code oturum kayıtlarını yaklaşık 30 gün sonra siler. Claudelot günlük toplamları kendi dosyasına da kaydeder; böylece geçmiş aylar uygulama kullanıldıkça birikir. Elindeki en eski kayıt: <b>${firstAvail ? monthLabel(firstAvail) : '–'}</b>.</div>`;
}

/* ---------------- settings ---------------- */
let setTab = 'hitap';
const TONES = { samimi: 'Samimi', resmi: 'Resmi', kisa: 'Kısa ve öz' };
const LANGS = { tr: 'Türkçe', en: 'İngilizce' };
const NOTIF_LABELS = { done: 'İş bittiğinde', decision: 'Kararını beklediğinde (izin, plan, soru)', subagent: 'Alt ajan açılınca / bitince', workflow: 'Workflow açılınca / bitince', quiet: 'Rahatsız etme (hepsini sustur)' };
const sw = (attr, on, label) => `<button class="sw" role="switch" aria-checked="${!!on}" aria-label="${esc(label)}" ${attr}></button>`;
let CLEANUP = null; // ~/.claude/settings.json cleanupPeriodDays (null = Claude Code's default, 30)
function openSettings(tab) {
  if (tab) setTab = tab; $('#settings').hidden = false; closeMenus(); renderSettings();
  api.invoke('claude:getCleanup').then(v => { if (v !== CLEANUP) { CLEANUP = v; renderSettings(); } }).catch(() => {});
}
function renderSettings() {
  if ($('#settings').hidden) return;
  const st = CFG.settings;
  $('#setNav').innerHTML = [['claude', 'Claude oturumları'], ['hitap', 'Hitap ve dil'], ['tema', 'Tema'], ['bildirim', 'Bildirimler'], ['pencere', 'Pencere'], ['kisayol', 'Kısayollar'], ['hakkinda', 'Hakkında']].map(([k, l]) => `<button class="set-tab ${k === setTab ? 'on' : ''}" data-settab="${k}">${l}</button>`).join('');
  let h = '';
  if (setTab === 'hitap') {
    h = `<h4>Claude sana nasıl hitap etsin?</h4>
      <input type="text" id="fName" data-field="name" value="${esc(st.name)}" placeholder="Boş bırakırsan hitap kullanılmaz">
      <div class="chips">${[...new Set([firstName((CFG.identity || {}).name), 'Başkanım', 'Hocam', 'Şefim', 'Patron'].filter(Boolean))].map(c => `<button class="chip-btn ${st.name === c ? 'on' : ''}" data-hitap="${c}">${c}</button>`).join('')}<button class="chip-btn ${!addr() ? 'on' : ''}" data-hitap="">Hitapsız</button></div>
      <p class="set-note">${(CFG.identity || {}).name ? `Adın ${(CFG.identity || {}).source === 'github' ? 'GitHub' : 'git'} ayarlarından alındı: <b>${esc(CFG.identity.name)}</b>. ` : ''}Bir oturumda Claude'a “bana … diye hitap et” dersen burası da güncellenir.</p>
      <h4>Konuşma tonu</h4>
      <div class="seg">${Object.keys(TONES).map(k => `<button class="${st.tone === k ? 'on' : ''}" data-tone="${k}">${TONES[k]}</button>`).join('')}</div>
      <h4>Yanıt dili</h4>
      <select id="fLang" data-field="lang">${Object.keys(LANGS).map(k => `<option value="${k}" ${st.lang === k ? 'selected' : ''}>${LANGS[k]}</option>`).join('')}</select>
      <h4>Ek talimatlar</h4>
      <textarea id="fExtra" data-field="extra" rows="3" placeholder="Her satır bir talimat. Ör: Commit mesajlarını İngilizce yaz.">${esc(st.extra)}</textarea>
      <h4>Claude'a eklenecek metin</h4>
      <pre class="md" id="promptPrev">…</pre>
      <p class="set-note">Bu metin Claudelot'tan başlatılan Claude oturumlarına eklenir. CLAUDE.md dosyalarına dokunulmaz. Değişiklik yeni açılan oturumlarda geçerli olur.</p>`;
  } else if (setTab === 'claude') {
    const c = CFG.settings.claude || {};
    const custom = c.model && !MODELS.some(([k]) => k === c.model);
    h = `<h4>Varsayılan model</h4>
      <select id="cModel">${MODELS.map(([k, l]) => `<option value="${k}" ${(custom ? '__custom' : c.model || '') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input type="text" id="cModelCustom" placeholder="Tam model adı, ör. claude-opus-5-5" value="${custom ? esc(c.model) : ''}" ${custom ? '' : 'hidden'}>
      <h4>Efor seviyesi</h4>
      <div class="seg">${EFFORTS.map(([k, l]) => `<button class="${(c.effort || '') === k ? 'on' : ''}" data-ceffort="${k}">${l}</button>`).join('')}</div>
      <h4>İzin modu</h4>
      <div class="pm-list">${PERM_MODES.map(([k, l, d]) => `<button class="pm ${(c.permissionMode || '') === k ? 'on' : ''} ${k === 'bypassPermissions' ? 'danger' : ''}" data-cpm="${k}"><b>${l}</b><small>${d}</small></button>`).join('')}</div>
      ${c.permissionMode === 'bypassPermissions' ? '<p class="set-warn">Dikkat: Claude hiçbir şey sormadan komut çalıştırır, dosya yazar ve siler. Sadece güvendiğin projelerde kullan. İlk açılışta Claude bir onay isteyebilir.</p>' : ''}
      <h4>Remote Control</h4>
      <div class="set-row"><span>Oturumlar Remote Control açık başlasın<small>Oturumu claude.ai veya telefondaki Claude uygulamasından da sürdürebilirsin. Oturum adı: “proje · Claudelot”.</small></span>${sw('data-cset="remoteControl"', c.remoteControl, 'Remote Control')}</div>
      <p class="set-note">Bu ayarlar Claudelot'tan yeni açılan ve devam ettirilen oturumlara uygulanır; açık oturumlar etkilenmez. Boş bırakılanlarda Claude Code kendi ayarını kullanır. Tek bir oturum için izin modunu “+ Oturum ▾” menüsünden de seçebilirsin.</p>
      <h4>Oturum geçmişi ne kadar saklansın?</h4>
      <div class="seg">${[30, 90, 180, 365].map(n => `<button class="${(CLEANUP || 30) === n ? 'on' : ''}" data-cleanup="${n}">${n} gün${n === 30 ? ' (varsayılan)' : ''}</button>`).join('')}</div>
      ${CLEANUP && ![30, 90, 180, 365].includes(CLEANUP) ? `<p class="set-note">Şu anki değer: ${CLEANUP} gün.</p>` : ''}
      <p class="set-note">Claude Code, bu süreden eski oturum kayıtlarını siler; silinen oturumlar geçmişte ve proje listesinde görünmez. Bu, <code>~/.claude/settings.json</code> içindeki <code>cleanupPeriodDays</code> ayarıdır; Claudelot dışında açtığın oturumlar için de geçerlidir. Daha önce silinenleri geri getirmez.</p>`;
  } else if (setTab === 'tema') {
    const tc = st.termColors || 'windows';
    h = '<h4>Tema</h4>' + skinOptions()
      + `<h4>Terminal yazı renkleri</h4><div class="seg"><button class="${tc === 'windows' ? 'on' : ''}" data-termcolors="windows">Windows Terminal</button><button class="${tc === 'theme' ? 'on' : ''}" data-termcolors="theme">Temaya uyumlu</button></div><p class="set-note">Windows Terminal: Claude Code normal Windows terminalindeki renklerle görünür (beyaz yazı, mavi bağlantılar).</p>`;
  } else if (setTab === 'bildirim') {
    h = '<h4>Hangi durumlarda Windows bildirimi gelsin?</h4>' + Object.keys(NOTIF_LABELS).map(k => `<div class="set-row"><span>${NOTIF_LABELS[k]}</span>${sw(`data-notif="${k}"`, st.notif[k], NOTIF_LABELS[k])}</div>`).join('')
      + (() => { const cur = !st.sound ? 'off' : (st.soundStyle || 'claudelot'); return `<h4>Bildirim sesi</h4><div class="seg">${[['claudelot', 'Claudelot sesi'], ['windows', 'Windows sesi'], ['off', 'Sessiz']].map(([k, l]) => `<button class="${cur === k ? 'on' : ''}" data-soundstyle="${k}">${l}</button>`).join('')}</div>`
        + (cur === 'claudelot' ? `<div class="chips" style="margin-top:8px"><button class="chip-btn" data-chime="done"><i class="fa-solid fa-play"></i> İş bitti</button><button class="chip-btn" data-chime="decision"><i class="fa-solid fa-play"></i> Karar bekliyor</button><button class="chip-btn" data-chime="subagent"><i class="fa-solid fa-play"></i> Ajan / workflow</button></div>` : ''); })()
      + '<p class="set-note">O an baktığın terminal için bildirim gösterilmez.</p>';
  } else if (setTab === 'pencere') {
    h = '<h4>Pencere</h4>'
      + `<div class="set-row"><span>Kapat düğmesi tepsiye küçültsün<small>Kapalıysa × düğmesi çıkış onayı sorar</small></span>${sw('data-set="closeToTray"', st.closeToTray, 'Tepsiye küçült')}</div>`
      + `<div class="set-row"><span>Açılışta karşılama ekranını göster<small>Proje seçme ve arama penceresi</small></span>${sw('data-set="welcome"', st.welcome !== false, 'Karşılama ekranı')}</div>`
      + `<div class="set-row"><span>Windows açılınca başlat<small>Doğrudan sistem tepsisine başlar</small></span>${sw('data-set="autostart"', st.autostart, 'Windows ile başlat')}</div>`
      + '<p class="set-note">Uygulamadan tamamen çıkmak için: sistem tepsisindeki simgeye sağ tıkla → Çık.</p>';
  } else {
    h = setTab === 'kisayol' ? kisayolHTML() : `<h4>Bağlantı</h4><div class="kv">
      <span>Claude Code</span><span>${INFO.claude ? `<code>${esc(INFO.claude)}</code>` : '<b style="color:var(--warn)">Bulunamadı.</b> Claude Code kurulu ve PATH içinde olmalı.'}</span>
      <span>Bildirim portu</span><span><code>127.0.0.1:${INFO.hookPort}</code></span>
      <span>Hook ayarları</span><span><code>${esc(INFO.hookSettings)}</code></span>
      <span>Ek talimat dosyası</span><span><code>${esc(INFO.appendPrompt)}</code></span></div>
      <p class="set-note">Claudelot, başlattığı her Claude oturumuna kendi hook ayarlarını <code>--settings</code> ile verir. Senin <code>~/.claude/settings.json</code> dosyan değiştirilmez. Uygulama dışında açılan oturumlar burada görünmez ama geçmişleri listelenir.</p>`;
  }
  $('#setBody').innerHTML = h;
  if (setTab === 'hitap') updatePromptPreview();
}
let prevTimer = null;
function updatePromptPreview() {
  clearTimeout(prevTimer);
  prevTimer = setTimeout(async () => { const el = $('#promptPrev'); if (el) el.textContent = await api.invoke('prompt:preview'); }, 250);
}

/* ---------------- events ---------------- */
function closeMenus() { $('#newMenu').hidden = true; $('#skinMenu').hidden = true; $('#pop').hidden = true; }
function bindEvents() {
  document.addEventListener('click', async e => {
    const el = e.target.closest('button,[data-tab],tr[data-month]');
    if (!e.target.closest('#newMenu,[data-newmenu],[data-projmenu]')) $('#newMenu').hidden = true;
    if (!$('#startPanel').hidden && !e.target.closest('#startPanel,#startBtn,#newMenu')) closeStartPanel();
    if (e.target.closest('#newMenu [data-newkind],#newMenu [data-resume],#newMenu [data-pact]')) closeStartPanel();
    if (!e.target.closest('#skinMenu,#skinBtn')) $('#skinMenu').hidden = true;
    if (!e.target.closest('#pop,#bellBtn')) $('#pop').hidden = true;
    if (e.target.id === 'settings') { $('#settings').hidden = true; return; }
    if (e.target.id === 'discover') { $('#discover').hidden = true; return; }
    if (e.target.id === 'report') { $('#report').hidden = true; return; }
    if (!el) return;
    const d = el.dataset;
    if (d.panel) togglePanel(d.panel);
    else if (d.watch) { if (S.mode === 'claude' || S.mode === 'ide') openWatch(d.watch); }
    else if (d.takeover) takeOverSession(d.takeover);
    else if (d.continue) continueHere(d.continue);
    else if (d.mode) setMode(d.mode);
    else if (d.tab) { if (S.mode === 'ide' && tabById(d.tab) && tabById(d.tab).projectId !== IDE.project) switchIdeProject(tabById(d.tab).projectId); activate(d.tab); $('#pop').hidden = true; }
    else if (d.close) closeTab(d.close);
    else if (d.resume) {
      const h = (S.history[d.pid] || []).find(x => x.id === d.resume);
      openTerminal({ kind: 'claude', projectId: d.pid, resume: d.resume, title: h ? shorten(h.title, 48) : 'Oturum' });
    }
    else if (d.new) openTerminal({ kind: 'claude', projectId: d.new });
    else if (d.newmenu) { const m = $('#newMenu'); if (!m.hidden && m.dataset.for === d.newmenu + el.className) m.hidden = true; else { m.dataset.for = d.newmenu + el.className; openNewMenu(el, d.newmenu); } }
    else if (d.projmenu) { const m = $('#newMenu'); m.dataset.for = 'p' + d.projmenu; openProjMenu(el, d.projmenu); }
    else if (d.newkind) { $('#newMenu').hidden = true; openTerminal(d.newkind === 'claude' ? { kind: 'claude', projectId: d.pid, overrides: d.pm ? { permissionMode: d.pm } : undefined } : { kind: 'shell', shell: d.newkind, projectId: d.pid }); }
    else if (d.pact) {
      $('#newMenu').hidden = true;
      const p = proj(d.pid); if (!p) return;
      if (d.pact === 'restore') restoreTabs(p.id);
      else if (d.pact === 'open') api.invoke('project:open', p.path);
      else if (d.pact === 'refresh') { await refreshHistory(p.id); renderSide(); }
      else if (d.pact === 'remove' && confirm(`"${p.name}" listeden kaldırılsın mı?\nKlasör ve oturum geçmişi silinmez.`)) {
        S.projects = await api.invoke('project:remove', p.id); CFG.projects = S.projects;
        if (IDE.project === p.id) IDE.project = null;
        renderAll();
      }
    }
    else if (d.toggle) { S.collapsed[d.toggle] = !isCollapsed(d.toggle); renderSide(); }
    else if (d.more) { S.showAll[d.more] = true; renderSide(); }
    else if (d.dec) decide(d.dec, d.c);
    else if (d.skin) { await setCfg({ settings: { skin: d.skin } }); applySkin(d.skin); renderSkinMenu(); renderSettings(); $('#skinMenu').hidden = true; }
    else if (d.proj) switchIdeProject(d.proj);
    else if (d.dir) { IDE.expanded[d.dir] = !IDE.expanded[d.dir]; renderTree(); }
    else if (d.fclose) closeFile(d.fclose);
    else if (d.file) openFile(d.file);
    else if (d.settab) { setTab = d.settab; renderSettings(); }
    else if (d.hitap !== undefined) { await setCfg({ settings: { name: d.hitap } }); renderSettings(); }
    else if (d.tone) { await setCfg({ settings: { tone: d.tone } }); renderSettings(); }
    else if (d.termcolors) { await setCfg({ settings: { termColors: d.termcolors } }); applySkin(CFG.settings.skin); renderSettings(); }
    else if (d.soundstyle) { await setCfg({ settings: d.soundstyle === 'off' ? { sound: false } : { sound: true, soundStyle: d.soundstyle } }); renderSettings(); if (d.soundstyle === 'claudelot') playChime('done'); }
    else if (d.chime) playChime(d.chime);
    else if (d.set) { await setCfg({ settings: { [d.set]: !CFG.settings[d.set] } }); renderSettings(); }
    else if (d.notif) { await setCfg({ settings: { notif: { [d.notif]: !CFG.settings.notif[d.notif] } } }); renderSettings(); }
    else if (d.addpath) { const p = await api.invoke('project:addPath', d.addpath); await projectAdded(p); el.closest('.disc-row').remove(); }
    else if (d.mdmode) { const fp = ist().file; if (d.mdmode === 'view') IDE.mdView.add(fp); else IDE.mdView.delete(fp); showFile(); if (d.mdmode === 'src') IDE.cm.focus(); }
    else if (d.tb) toolbar(d.tb);
    else if (d.report) openReport();
    else if (d.repmonth) { REP.month = d.repmonth; renderReport(); }
    else if (el.closest('tr[data-month]')) { REP.month = el.closest('tr[data-month]').dataset.month; renderReport(); }
    else if (d.csv) { const f = await api.invoke('usage:exportCsv', d.csv === 'all' ? null : d.csv); if (f) toast('CSV kaydedildi', f); }
    else if (el.id === 'saveBtn') saveFile();
    else if (el.id === 'pickFolder') { const p = await api.invoke('project:add'); if (p) { $('#discover').hidden = true; await projectAdded(p); } }
  });
  $('#minBtn').onclick = () => api.send('win:min');
  $('#maxBtn').onclick = () => api.send('win:max');
  $('#closeBtn').onclick = () => api.send('win:close');
  $('#setBtn').onclick = () => openSettings();
  $('#setClose').onclick = () => { $('#settings').hidden = true; };
  $('#discClose').onclick = () => { $('#discover').hidden = true; };
  $('#repClose').onclick = () => { $('#report').hidden = true; };
  $('#repInfoBtn').onclick = () => { const n = $('#repInfo'); n.hidden = !n.hidden; $('#repInfoBtn').setAttribute('aria-expanded', !n.hidden); };
  $('#addProjBtn').onclick = () => { closeStartPanel(); openDiscover(); };
  $('#startBtn').onclick = () => ($('#startPanel').hidden ? openStartPanel() : closeStartPanel());
  $('#startQ').addEventListener('input', () => { START.sel = 0; renderStartList(); });
  $('#startQ').addEventListener('keydown', e => {
    const n = START.view.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); START.sel = Math.min(n - 1, START.sel + 1); renderStartList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); START.sel = Math.max(0, START.sel - 1); renderStartList(); }
    else if (e.key === 'Enter') { e.preventDefault(); const p = START.view[START.sel]; if (p) { closeStartPanel(); openTerminal({ kind: 'claude', projectId: p.id }); } }
    else if (e.key === 'Escape') { e.stopPropagation(); closeStartPanel(); }
  });
  $('#startList').addEventListener('click', e => {
    const more = e.target.closest('[data-startmore]');
    if (more) { e.stopPropagation(); const m = $('#newMenu'); m.dataset.for = 'start' + more.dataset.startmore; openNewMenu(more, more.dataset.startmore, true); return; }
    const row = e.target.closest('[data-start]');
    if (row) { closeStartPanel(); openTerminal({ kind: 'claude', projectId: row.dataset.start }); }
  });
  $('#skinBtn').onclick = () => { const m = $('#skinMenu'); renderSkinMenu(); m.hidden = !m.hidden; };
  $('#bellBtn').onclick = () => { const p = $('#pop'); p.hidden = !p.hidden; if (!p.hidden) { S.unread = 0; renderPop(); renderStatus(); } };
  $('#clearN').onclick = () => { S.notifs = []; renderPop(); };
  $('#notifSettings').onclick = () => openSettings('bildirim');
  $('#refreshTree').onclick = () => { IDE.dirCache = {}; renderTree(); };
  // links inside the markdown view: web links open in the browser, relative links open the file here
  $('#mdView').addEventListener('click', e => {
    const a = e.target.closest('a[href]'); if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (/^https?:/i.test(href)) { window.open(href); return; }
    if (href.startsWith('#')) { const t = $('#mdView').querySelector(`[id="${CSS.escape(href.slice(1))}"]`); if (t) t.scrollIntoView({ behavior: 'smooth' }); return; }
    openFile(resolveRel($('#mdView').dataset.file, decodeURI(href.split('#')[0])));
  });
  $('#ideProjSel').addEventListener('change', e => { if (e.target.value) switchIdeProject(e.target.value); });
  const setClaude = patch => setCfg({ settings: { claude: patch } }).then(() => { renderSettings(); renderStatus(); });
  document.addEventListener('change', e => {
    if (e.target.id !== 'cModel') return;
    if (e.target.value === '__custom') { $('#cModelCustom').hidden = false; $('#cModelCustom').focus(); return; }
    setClaude({ model: e.target.value });
  });
  document.addEventListener('input', e => {
    if (e.target.id === 'cModelCustom') setCfg({ settings: { claude: { model: e.target.value.trim() } } }).then(renderStatus);
  });
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-ceffort],[data-cpm],[data-cset],[data-cleanup]'); if (!b) return;
    const c = CFG.settings.claude || {};
    if (b.dataset.cleanup) {
      try { CLEANUP = await api.invoke('claude:setCleanup', Number(b.dataset.cleanup)); renderSettings(); toast('Oturum geçmişi', `Claude Code artık ${CLEANUP} günden eski oturumları siler.`); }
      catch (err) { toast('Ayar kaydedilemedi', cleanErr(err)); }
      return;
    }
    if (b.dataset.ceffort !== undefined) setClaude({ effort: b.dataset.ceffort });
    else if (b.dataset.cpm !== undefined) setClaude({ permissionMode: b.dataset.cpm });
    else setClaude({ [b.dataset.cset]: !c[b.dataset.cset] });
  });
  document.addEventListener('input', e => {
    const f = e.target.dataset && e.target.dataset.field; if (!f) return;
    setCfg({ settings: { [f]: e.target.value } }).then(updatePromptPreview);
    if (f === 'name') $$('[data-hitap]').forEach(b => b.classList.toggle('on', b.dataset.hitap === e.target.value.trim()));
  });
  $('#findIn').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); findNext(e.target.value); } if (e.key === 'Escape') IDE.cm.focus(); });
  $('#newFileForm').addEventListener('submit', async e => {
    e.preventDefault();
    const p = proj(IDE.project); const v = $('#newFileIn').value.trim().replace(/\//g, '\\').replace(/^\\+/, '');
    if (!p || !v) return;
    const full = p.path.replace(/[\\/]+$/, '') + '\\' + v;
    try { await api.invoke('fs:create', full); } catch (err) { toast('Dosya oluşturulamadı', cleanErr(err)); return; }
    IDE.dirCache = {};
    // open the folders on the way to the new file
    let dir = p.path.replace(/[\\/]+$/, '');
    v.split('\\').slice(0, -1).forEach(seg => { dir += '\\' + seg; IDE.expanded[dir] = true; });
    $('#newFileIn').value = ''; $('#newFileForm').hidden = true;
    openFile(full);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeMenus(); $('#settings').hidden = true; $('#discover').hidden = true; $('#report').hidden = true; }
  });
  // capture phase: app shortcuts win over the terminal and the code editor
  window.addEventListener('keydown', e => {
    const sc = SHORTCUTS.find(s => s.run && s.keys === comboOf(e));
    if (!sc) return;
    e.preventDefault(); e.stopPropagation();
    sc.run();
  }, true);
  api.on('focus-tab', id => { if (String(id).startsWith('watch:')) { const sid = id.slice(6); const w = watchTab(sid); if (w) id = w.id; else { if (isExtLive(sid)) openWatch(sid); return; } } const t = tabById(id); if (!t) return; if (S.mode === 'ide' && t.projectId !== IDE.project) switchIdeProject(t.projectId); activate(id); });
  api.on('open-settings', () => openSettings());
  window.addEventListener('focus', () => { const t = tabById(S.active); if (t && t.attn) { t.attn = null; renderAll(); } });
  // the welcome window picked a project; take it (only once) and act on it
  api.on('open-project', async () => handleOpen(await api.invoke('app:takePendingOpen')));
  api.on('projects-changed', async list => { S.projects = list; CFG.projects = list; await refreshAllHistory(); renderAll(); });
  api.on('config-changed', c => { CFG = c; renderSettings(); });
  api.on('address-learned', n => toast('Hitap güncellendi', n ? `Bundan sonra “${n}” diye hitap edilecek.` : 'Bundan sonra hitap kullanılmayacak.'));
  window.addEventListener('beforeunload', e => {
    if (Object.keys(IDE.files).some(isDirty)) { e.returnValue = false; }
  });
}
function toolbar(a) {
  const cm = IDE.cm;
  if (a === 'new') { const f = $('#newFileForm'); f.hidden = !f.hidden; if (!f.hidden) $('#newFileIn').focus(); }
  else if (a === 'save') saveFile();
  else if (a === 'saveall') {
    const list = ist().tabs.filter(isDirty);
    Promise.all(list.map(fp => saveFile(fp))).then(r => { const n = r.filter(Boolean).length; if (n) toast('Kaydedildi', n + ' dosya'); });
  }
  else if (a === 'undo') { cm.undo(); cm.focus(); }
  else if (a === 'redo') { cm.redo(); cm.focus(); }
  else if (a === 'smaller') { IDE.ui.size = Math.max(10, IDE.ui.size - 1); saveIdeUi(); }
  else if (a === 'bigger') { IDE.ui.size = Math.min(22, IDE.ui.size + 1); saveIdeUi(); }
  else if (a === 'ex') { IDE.ui.ex = !IDE.ui.ex; saveIdeUi(); }
  else if (a === 'panel') { IDE.ui.panel = !IDE.ui.panel; saveIdeUi(); }
  else if (a === 'ask') askClaude();
}

/* remember which terminals are open, so they can be restored next time */
function saveOpenTabs() {
  const list = S.tabs
    .filter(t => !t.exited && (t.kind === 'shell' || (t.sessionId && t.prompted)))
    .map(t => ({ projectId: t.projectId, kind: t.kind, shell: t.shell || null, sessionId: t.kind === 'claude' ? t.sessionId : null, title: t.title }));
  CFG.lastTabs = list;
  api.invoke('config:set', { lastTabs: list });
}
async function restoreTabs(pid) {
  const list = (CFG.lastTabs || []).filter(t => proj(t.projectId) && (!pid || t.projectId === pid));
  if (!list.length) {
    // nothing remembered: continue the most recent conversation of that project
    const h = pid && (S.history[pid] || [])[0];
    if (h) await openTerminal({ kind: 'claude', projectId: pid, resume: h.id, title: shorten(h.title, 48) });
    else toast('Geri yüklenecek oturum yok');
    return;
  }
  for (const t of list) {
    if (t.kind === 'shell') {
      if (S.tabs.some(x => x.projectId === t.projectId && x.shell === t.shell && !x.exited)) continue;
      await openTerminal({ kind: 'shell', shell: t.shell, projectId: t.projectId });
    } else await openTerminal({ kind: 'claude', projectId: t.projectId, resume: t.sessionId, title: t.title });
  }
  toast('Oturumlar geri yüklendi', list.length + ' terminal');
}

async function handleOpen(req) {
  if (req && req.action === 'restoreAll') { if (S.mode !== 'claude') setMode('claude'); await restoreTabs(null); return; }
  if (!req || !req.projectId) return;
  if (!proj(req.projectId)) {
    const r = await api.invoke('config:get');
    CFG = r.config; S.projects = CFG.projects;
    await refreshHistory(req.projectId);
  }
  const p = proj(req.projectId); if (!p) return;
  if (req.action === 'ide') {
    if (S.mode !== 'ide') setMode('ide');
    switchIdeProject(p.id);
    return;
  }
  if (S.mode !== 'claude') setMode('claude');
  S.collapsed[p.id] = false;
  renderSide();
  if (req.action === 'claude') { openTerminal({ kind: 'claude', projectId: p.id }); return; }
  if (req.action === 'restore') { await restoreTabs(p.id); return; }
  // project has no open terminal: offer it in the start panel
  if (!S.tabs.some(t => t.projectId === p.id)) { if (!panelUi().side) togglePanel('side'); openStartPanel(p.name); return; }
  const row = [...document.querySelectorAll('#side [data-toggle]')].find(b => b.dataset.toggle === p.id);
  if (row) {
    const box = row.closest('.proj');
    box.scrollIntoView({ block: 'start', behavior: 'smooth' });
    box.classList.add('flash');
    setTimeout(() => box.classList.remove('flash'), 1600);
  }
}

/* ---------------- "Proje Başlat" panel ---------------- */
const START = { sel: 0, view: [] };
const lowerTr = s => String(s || '').toLocaleLowerCase('tr');
function lastActivity(pid) { const h = (S.history[pid] || [])[0]; return h ? h.mtime : 0; }
function openStartPanel(query) {
  if (S.mode !== 'claude') setMode('claude');
  $('#startPanel').hidden = false;
  $('#startBtn').setAttribute('aria-expanded', 'true');
  $('#startQ').value = query || '';
  START.sel = 0;
  renderStartList();
  $('#startQ').focus();
}
function closeStartPanel() {
  $('#startPanel').hidden = true;
  $('#startBtn').setAttribute('aria-expanded', 'false');
}
function renderStartList() {
  const q = lowerTr($('#startQ').value.trim());
  START.view = S.projects
    .filter(p => !q || lowerTr(p.name).includes(q) || lowerTr(p.path).includes(q))
    .sort((a, b) => lastActivity(b.id) - lastActivity(a.id));
  START.sel = Math.min(START.sel, Math.max(0, START.view.length - 1));
  $('#startList').innerHTML = START.view.length ? START.view.map((p, i) => {
    const live = S.tabs.filter(t => t.projectId === p.id).length;
    const last = lastActivity(p.id);
    return `<div class="sp-row ${i === START.sel ? 'sel' : ''}" data-start="${p.id}" role="option" title="${esc(p.path)}&#10;Tıkla: yeni Claude oturumu">
      <div class="sp-info"><b>${esc(p.name)}${live ? ` <span class="sp-live">${live} açık</span>` : ''}</b><span>${esc(p.path)}</span></div>
      <span class="sp-time">${last ? rel(last) : ''}</span>
      <button class="sp-more" data-startmore="${p.id}" title="Diğer seçenekler: terminal, izin modu, geçmiş oturumlar" aria-label="${esc(p.name)} için seçenekler"><i class="fa-solid fa-chevron-right"></i></button>
    </div>`;
  }).join('') : `<div class="sp-empty">“${esc($('#startQ').value)}” ile eşleşen proje yok.</div>`;
  const el = $('#startList .sp-row.sel'); if (el) el.scrollIntoView({ block: 'nearest' });
}

/* ---------------- panels ---------------- */
const panelUi = () => Object.assign({ side: true, queue: true, usage: true, agents: true }, CFG.settings.ui || {});
/* Each column holds two sections that hide on their own; a hidden section leaves a
   one-line bar in its place, and a column with both hidden becomes a thin rail. */
function applyPanels() {
  const ui = panelUi();
  $('#sidePanel').hidden = !ui.side; $('#sideBar').hidden = ui.side;
  $('#usage').hidden = !ui.usage; $('#usageBar').hidden = ui.usage;
  $('#leftCol').hidden = !ui.side && !ui.usage; $('#leftRail').hidden = ui.side || ui.usage;
  $('#queuePanel').hidden = !ui.queue; $('#queueBar').hidden = ui.queue;
  $('#agentsPanel').hidden = !ui.agents; $('#agentsBar').hidden = ui.agents;
  $('#rightCol').hidden = !ui.queue && !ui.agents; $('#rightRail').hidden = ui.queue || ui.agents;
  renderPanelBadges();
  requestAnimationFrame(fitActive);
}
function renderPanelBadges() {
  const u = S.usage, n = pendingCount(), a = S.agents.length;
  $('#usageBarV').textContent = u ? fmtTok(u.total) + ' token' : '';
  $('#queueBarV').textContent = n || '';
  $('#agentsBarV').textContent = a || '';
  $('#railCount').hidden = !n; $('#railCount').textContent = n;
  $('#railAgents').hidden = !a; $('#railAgents').textContent = a;
}
function togglePanel(name) {
  if (S.mode === 'ide' && (name === 'side' || name === 'queue')) { toolbar(name === 'side' ? 'ex' : 'panel'); return; }
  const ui = panelUi();
  setCfg({ settings: { ui: { [name]: !ui[name] } } });
  applyPanels();
}

/* ---------------- keyboard shortcuts ---------------- */
function comboOf(e) {
  let k = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.code === 'Comma' ? ',' : e.key;
  return (e.ctrlKey ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.altKey ? 'Alt+' : '') + k;
}
function projectHere() {
  const t = tabById(S.active);
  return (t && t.projectId) || (S.mode === 'ide' && IDE.project) || (S.projects[0] && S.projects[0].id);
}
function cycleTabs(dir) {
  const list = S.mode === 'ide' ? S.tabs.filter(t => t.projectId === IDE.project) : S.tabs;
  if (!list.length) return;
  const i = list.findIndex(t => t.id === S.active);
  activate(list[(i + dir + list.length) % list.length].id);
}
const SHORTCUTS = [
  { group: 'Genel', keys: 'Ctrl+1', label: 'Claude modu', run: () => setMode('claude') },
  { group: 'Genel', keys: 'Ctrl+2', label: 'IDE modu', run: () => setMode('ide') },
  { group: 'Genel', keys: 'Ctrl+Shift+P', label: 'Proje Başlat paneli', run: () => { if (!panelUi().side) togglePanel('side'); openStartPanel(); } },
  { group: 'Genel', keys: 'Ctrl+Shift+O', label: 'Karşılama ekranı', run: () => api.send('app:welcome') },
  { group: 'Genel', keys: 'Ctrl+,', label: 'Ayarlar', run: () => openSettings() },
  { group: 'Genel', keys: 'Ctrl+Shift+R', label: 'Aylık kullanım raporu', run: () => openReport() },
  { group: 'Genel', keys: 'F1', label: 'Kısayol listesi', run: () => openSettings('kisayol') },
  { group: 'Paneller', keys: 'Ctrl+Shift+E', label: 'Projeler paneli (IDE: dosya gezgini)', run: () => togglePanel('side') },
  { group: 'Paneller', keys: 'Ctrl+Shift+D', label: 'Karar paneli (IDE: Claude paneli)', run: () => togglePanel('queue') },
  { group: 'Paneller', keys: 'Ctrl+Shift+U', label: 'Haftalık kullanım paneli', run: () => togglePanel('usage') },
  { group: 'Paneller', keys: 'Ctrl+Shift+J', label: 'Aktif ajanlar bölümü', run: () => togglePanel('agents') },
  { group: 'Terminaller', keys: 'Ctrl+Shift+N', label: 'Yeni Claude oturumu (seçili proje)', run: () => { const p = projectHere(); if (p) openTerminal({ kind: 'claude', projectId: p }); } },
  { group: 'Terminaller', keys: 'Ctrl+Shift+T', label: 'Yeni PowerShell (seçili proje)', run: () => { const p = projectHere(); if (p) openTerminal({ kind: 'shell', shell: 'pwsh', projectId: p }); } },
  { group: 'Terminaller', keys: 'Ctrl+Shift+W', label: 'Açık terminali kapat', run: () => { if (S.active) closeTab(S.active); } },
  { group: 'Terminaller', keys: 'Ctrl+Tab', label: 'Sonraki terminal', run: () => cycleTabs(1) },
  { group: 'Terminaller', keys: 'Ctrl+Shift+Tab', label: 'Önceki terminal', run: () => cycleTabs(-1) },
  { group: 'Terminaller', keys: 'Ctrl+C', label: 'Seçili metni kopyala (seçim yoksa işlemi durdurur)' },
  { group: 'Terminaller', keys: 'Ctrl+V', label: 'Yapıştır' },
  { group: 'IDE', keys: 'Ctrl+S', label: 'Dosyayı kaydet' },
  { group: 'IDE', keys: 'Ctrl+F', label: 'Dosyada ara' },
  { group: 'IDE', keys: 'Ctrl+Z / Ctrl+Y', label: 'Geri al / yinele' },
];

function kisayolHTML() {
  const groups = [...new Set(SHORTCUTS.map(s => s.group))];
  return groups.map(g => `<h4>${g}</h4><table class="kbd-t">${SHORTCUTS.filter(s => s.group === g).map(s => `<tr><td>${s.label}</td><td class="n">${s.keys.split(' / ').map(k => k.split('+').map(x => `<kbd>${x}</kbd>`).join('+')).join(' / ')}</td></tr>`).join('')}</table>`).join('')
    + '<p class="set-note">Uygulama kısayolları terminal ve kod düzenleyici açıkken de çalışır. Claude Code\'un kendi kısayolları (Ctrl+B, Ctrl+R, Shift+Tab vb.) terminale gitmeye devam eder.</p>';
}

/* ---------------- start ---------------- */
async function init() {
  const r = await api.invoke('config:get');
  CFG = r.config; INFO = r.info;
  S.projects = CFG.projects;
  IDE.state = CFG.ide.state || {};
  IDE.ui = Object.assign({ ex: true, panel: true, size: 13 }, CFG.ide.ui || {});
  applySkin(CFG.settings.skin);
  setupEditor();
  bindEvents();
  applyPanels();
  renderUsage();
  await refreshAllHistory();
  api.on('live-sessions', setLive);
  try { setLive(await api.invoke('live:list')); } catch (_) {}
  setMode(CFG.settings.mode === 'ide' ? 'ide' : 'claude', true);
  refreshUsage();
  setInterval(refreshUsage, 120000);
  setInterval(renderSide, 60000);
  setInterval(() => refreshAllHistory().then(renderSide), 180000);
  handleOpen(await api.invoke('app:takePendingOpen'));
}
init();

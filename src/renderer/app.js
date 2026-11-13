'use strict';
/* VoxStorm renderer — talks to the main process only through window.api (see preload.js). */
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
  if (c.permissionMode) parts.push((PERM_MODES.find(([k]) => k === c.permissionMode) || [0, c.permissionMode])[1].toLocaleLowerCase('tr'));
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
/* VoxStorm's own chimes, made with Web Audio so no sound files are needed:
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
function tabIcon(t) { if (t.kind === 'watch') return `<span class="dot ${t.status}"></span><i class="fa-solid fa-eye watch-ic" title="VoxStorm dışında açık, izleniyor"></i>`; return t.kind === 'shell' ? (SHELL_ICONS[t.shell] || '<i class="shi fa-solid fa-terminal"></i>') : `<span class="dot ${t.status}"></span>`; }

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
    const res = await api.invoke('pty:spawn', { kind, shell, cwd: p.path, resume, overrides, rcName: `${p.name} · VoxStorm`, cols: term.cols, rows: term.rows });
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
async function closeTab(id) {
  let t = tabById(id); if (!t) return;
  if (t.kind !== 'watch' && !t.exited && (t.status === 'running' || t.status === 'waiting')) {
    if (!(await uiConfirm({ title: 'Terminal kapatılsın mı?', message: `"${t.title}" hâlâ çalışıyor.`, detail: 'Claude oturumu geçmişte kalır, sonra devam ettirebilirsin.', ok: 'Kapat', danger: true }))) return;
    t = tabById(id); if (!t) return;
  }
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
  if (name === 'SessionStart' && t.pendingPrompt) sendPendingPrompt(t);
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

/* ---------------- live sessions opened outside VoxStorm ----------------
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
  term.onData(d => { if (t.mirror) { if (t.sReq) mirrorScroll(t, 0); api.send('mirror:input', t.mirror, d); } });
  // scrolling: the history sits in the outside console's buffer, so ask the mirror for an
  // older slice of it instead of scrolling the (scrollback-less) xterm
  const bar = document.createElement('div');
  bar.className = 'mscroll'; bar.hidden = true;
  bar.innerHTML = '<div class="mthumb"></div>';
  const live = document.createElement('button');
  live.className = 'mlive'; live.hidden = true;
  live.innerHTML = '<i class="fa-solid fa-arrow-down"></i> Canlıya dön';
  live.onclick = () => { mirrorScroll(t, 0); term.focus(); };
  box.append(bar, live);
  let acc = 0;
  box.addEventListener('wheel', e => {
    e.preventDefault(); e.stopPropagation();
    acc += e.deltaMode === 1 ? e.deltaY : e.deltaMode === 2 ? e.deltaY * term.rows : e.deltaY / 33;
    const n = Math.trunc(acc); if (!n) return;
    acc -= n;
    mirrorScroll(t, (t.sReq || 0) - n);
  }, { capture: true, passive: false });
  const fromY = y => {
    const r = bar.getBoundingClientRect(), total = t.sMax + term.rows;
    const topRow = (y - r.top) / r.height * total - term.rows / 2;
    mirrorScroll(t, t.sMax - topRow);
  };
  bar.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); bar.setPointerCapture(e.pointerId); bar.classList.add('drag');
    fromY(e.clientY);
    const move = ev => fromY(ev.clientY);
    const up = () => { bar.classList.remove('drag'); bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); bar.removeEventListener('pointercancel', up); };
    bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', up); bar.addEventListener('pointercancel', up);
  });
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
function mirrorScroll(t, n) {
  n = Math.max(0, Math.min(t.sMax || 0, Math.round(n)));
  if (n === (t.sReq || 0)) return;
  t.sReq = n;
  if (t.mirror) api.send('mirror:scroll', t.mirror, n);
}
function renderMirrorScroll(t) {
  const box = t.el.querySelector('.watch-term'), bar = box.querySelector('.mscroll'), live = box.querySelector('.mlive');
  if (!bar) return;
  const max = t.sMax || 0, off = t.sOff || 0, rows = t.term.rows, total = max + rows;
  bar.hidden = !max;
  live.hidden = !off;
  if (!max) return;
  const th = bar.firstChild;
  th.style.height = Math.max(6, rows / total * 100) + '%';
  th.style.top = Math.min(100 - rows / total * 100, (max - off) / total * 100) + '%';
}
function onMirrorFrame(t, f) {
  const first = t.mirrorState !== 'live';
  const term = mirrorTerm(t);
  t.sMax = f.max || 0; t.sOff = f.off || 0;
  if ((t.sReq || 0) > t.sMax) t.sReq = t.sMax;
  if (term.cols !== f.cols || term.rows !== f.rows) { term.resize(f.cols, f.rows); requestAnimationFrame(() => fitMirrorFont(t)); }
  term.write('\x1b[?25l\x1b[H' + f.vt + '\x1b[0m\x1b[J' + `\x1b[${f.cy + 1};${f.cx + 1}H` + (f.vis ? '\x1b[?25h' : ''));
  renderMirrorScroll(t);
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
    + `<span class="wb-t"><b>${s ? 'VoxStorm dışında açık' : 'Dışarıdaki oturum kapandı'}</b>${st ? ' · ' + esc(st) : ''}`
    + `<small>${esc(s ? s.cwd : t.cwd)}${s ? ' · PID ' + s.pid : ''} · ${conn}</small></span>`
    + `<span class="seg wb-seg"><button class="${t.view === 'term' ? 'on' : ''}" data-wview="term" ${t.term || t.mirrorState === 'connecting' ? '' : 'disabled'}><i class="fa-solid fa-terminal"></i> Terminal</button><button class="${t.view === 'log' ? 'on' : ''}" data-wview="log"><i class="fa-regular fa-comments"></i> Konuşma</button></span>`
    + (s
      ? `<button class="btn" data-takeover="${t.sessionId}" title="Dışarıdaki claude sürecini kapatır, konuşmaya bir VoxStorm terminalinde kaldığı yerden devam eder"><i class="fa-solid fa-right-to-bracket"></i> VoxStorm'a taşı</button>`
      : `<button class="btn primary" data-continue="${t.sessionId}" title="Konuşmaya bir VoxStorm terminalinde kaldığı yerden devam eder"><i class="fa-solid fa-play"></i> VoxStorm'ta devam et</button>`);
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
  if (!(await uiConfirm({
    title: "VoxStorm'a taşınsın mı?", ok: 'Taşı', danger: s.status === 'busy',
    message: `"${shorten(s.title, 60)}" şu an başka bir terminalde açık (PID ${s.pid}).`,
    detail: `VoxStorm'a almak için oradaki claude süreci kapatılacak, konuşma burada kaldığı yerden devam edecek.${warn}`,
  }))) return;
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
    const items = live.map(t => `<li><button class="sess live ${t.id === S.active ? 'active' : ''}${attnCls(t.attn)}" data-tab="${t.id}" title="${esc(t.title)} · ${STATUS_TEXT[t.status]}">${tabIcon(t)}<span class="sess-t">${esc(t.title)}</span><span class="sess-badge ${t.status}">${STATUS_SHORT[t.status]}</span></button></li>`).join('')
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
      ${syncLineHTML(p)}
      <ul class="sess-list">${items}</ul>
    </div>`;
  }).join('');
  if (orphans.length || orphanTabs.length) {
    $('#side').insertAdjacentHTML('beforeend', `<div class="proj ext-group">
      <div class="proj-row"><span class="proj-toggle" title="VoxStorm'taki projelerin dışındaki klasörlerde açık oturumlar"><i class="fa-solid fa-eye chev" aria-hidden="true"></i><span class="proj-name">Diğer klasörler</span></span></div>
      <ul class="sess-list">${orphans.map(s => extRow(s, true)).join('')}${orphanTabs.map(t => `<li><button class="sess live ${t.id === S.active ? 'active' : ''}" data-tab="${t.id}">${tabIcon(t)}<span class="sess-t">${esc(t.title)}</span><span class="sess-badge exited">kapandı</span></button></li>`).join('')}</ul>
    </div>`);
  }
}
function extRow(s, showDir) {
  const w = watchTab(s.sessionId), st = LIVE_ST[s.status] || 'idle';
  const tip = `${s.title}\n${s.cwd}\nVoxStorm dışında açık (PID ${s.pid}) · ${s.status === 'waiting' ? waitText(s.waitingFor) : STATUS_TEXT[st]}\nİzlemek için tıkla`;
  const at = w ? w.attn : S.extAttn.get(s.sessionId);
  return `<li><button class="sess live ext ${w && w.id === S.active ? 'active' : ''}${attnCls(at)}" data-watch="${s.sessionId}" title="${esc(tip)}"><span class="dot ${st}"></span><span class="sess-t">${showDir ? `<span class="sess-dir">${esc(baseName(s.cwd))}</span> ` : ''}${esc(s.title)}</span><span class="sess-time ext-tag">dışarıda</span></button></li>`;
}
function renderTabs() {
  const tabHTML = t => `<div class="tab ${t.id === S.active ? 'active' : ''}${attnCls(t.attn)}" role="tab"><button data-tab="${t.id}" title="${esc((proj(t.projectId) || {}).name)} · ${esc(t.title)} · ${STATUS_TEXT[t.status]}"><span class="tab-p">${esc((proj(t.projectId) || {}).name || '')}</span>${tabIcon(t)}<span class="tab-t">${esc(t.title)}</span></button><button class="tab-x" data-close="${t.id}" aria-label="Terminali kapat" title="Kapat">×</button></div>`;
  $('#tabs').innerHTML = S.tabs.length
    ? S.tabs.map(tabHTML).join('') + '<button class="tabs-add" data-startnew="1" title="Yeni oturum (Ctrl+Shift+P)" aria-label="Yeni oturum aç"><i class="fa-solid fa-plus"></i></button>'
    : '<span class="tabs-empty">Açık terminal yok</span><button class="tabs-add wide" data-startnew="1" title="Bir projede oturum başlat (Ctrl+Shift+P)"><i class="fa-solid fa-plus"></i> Oturum aç</button>';
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
      <div class="card-n">Bu oturum VoxStorm dışında açık; cevabı kendi penceresinden ver ya da oturumu buraya al.</div>
      <div class="acts"><button class="btn" data-watch="${s.sessionId}">İzle</button><button class="btn" data-takeover="${s.sessionId}">VoxStorm'a al</button></div></div>`).join('');
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
  $('#statusbar').innerHTML = `<span><b>${running}</b> çalışıyor</span><span><b>${pendingCount()}</b> karar bekliyor</span>${S.live.length ? `<span title="VoxStorm dışında açık Claude oturumları"><b>${S.live.length}</b> dışarıda</span>` : ''}<span><b>${S.agents.length}</b> ajan / workflow</span><span><b>${S.tabs.filter(t => !t.exited).length}</b> açık terminal</span>`
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
  if (typeof GIT !== 'undefined' && projectHere() !== GIT.btnPid) scheduleGitBtn(true);
  if (S.mode === 'ide') renderIde();
  if (!$('#pop').hidden) renderPop();
}

/* ---------------- IDE mode ---------------- */
const IDE = {
  project: null, files: {}, dirCache: {}, expanded: {}, cm: null, state: {}, ui: { ex: true, panel: true, size: 13, wrap: false }, mdView: new Set(),
  view: 'files', git: { repo: false, files: {}, dirs: new Set(), branch: '' }, index: {}, watched: null, reveal: null, menu: null,
  search: { q: '', case: false, word: false, regex: false, res: null, busy: false, closed: new Set(), token: 0 },
};
const MODES = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'text/typescript', tsx: 'text/typescript-jsx', json: 'application/json',
  css: 'css', scss: 'text/x-scss', less: 'text/x-less', html: 'htmlmixed', htm: 'htmlmixed', xml: 'xml', svg: 'xml', vue: 'htmlmixed',
  md: 'markdown', markdown: 'markdown', py: 'python', go: 'go', rs: 'rust', c: 'text/x-csrc', h: 'text/x-csrc', cpp: 'text/x-c++src', hpp: 'text/x-c++src', cc: 'text/x-c++src',
  cs: 'text/x-csharp', java: 'text/x-java', kt: 'text/x-kotlin', dart: 'text/x-java', sh: 'shell', bash: 'shell', ps1: 'powershell', psm1: 'powershell',
  yml: 'yaml', yaml: 'yaml', sql: 'sql', toml: 'toml', dockerfile: 'dockerfile', gd: 'python',
};
const LANG_NAMES = {
  javascript: 'JavaScript', jsx: 'JSX', 'text/typescript': 'TypeScript', 'text/typescript-jsx': 'TSX', 'application/json': 'JSON', css: 'CSS', 'text/x-scss': 'SCSS',
  'text/x-less': 'Less', htmlmixed: 'HTML', xml: 'XML', markdown: 'Markdown', python: 'Python', go: 'Go', rust: 'Rust', 'text/x-csrc': 'C', 'text/x-c++src': 'C++',
  'text/x-csharp': 'C#', 'text/x-java': 'Java', 'text/x-kotlin': 'Kotlin', shell: 'Shell', powershell: 'PowerShell', yaml: 'YAML', sql: 'SQL', toml: 'TOML', dockerfile: 'Dockerfile',
};
const extOf = p => { const b = p.split(/[\\/]/).pop().toLowerCase(); return b === 'dockerfile' ? 'dockerfile' : (b.includes('.') ? b.split('.').pop() : ''); };
const baseName = p => p.split(/[\\/]/).pop();
const langName = fp => ({ dart: 'Dart', gd: 'GDScript', svg: 'SVG', vue: 'Vue' })[extOf(fp)] || LANG_NAMES[MODES[extOf(fp)]] || 'Düz metin';
const isImage = fp => /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(fp);
const dirOf = fp => fp.slice(0, Math.max(fp.lastIndexOf('\\'), fp.lastIndexOf('/')));
const joinP = (dir, name) => dir.replace(/[\\/]+$/, '') + '\\' + name;
const projRoot = () => { const p = proj(IDE.project); return p ? p.path.replace(/[\\/]+$/, '') : ''; };
const relOf = fp => { const r = projRoot(); return r && normPath(fp).startsWith(normPath(r) + '\\') ? fp.slice(r.length + 1) : fp; };
const under = (fp, base) => { const a = normPath(fp), b = normPath(base); return a === b || a.startsWith(b + '\\'); };
const fileUrl = fp => 'file:///' + fp.replace(/\\/g, '/').split('/').map((s, i) => (i === 0 && /^[a-z]:$/i.test(s) ? s : encodeURIComponent(s))).join('/');
const fmtSize = n => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toLocaleString('tr-TR', { maximumFractionDigits: 1 }) + ' KB' : (n / 1048576).toLocaleString('tr-TR', { maximumFractionDigits: 1 }) + ' MB');
const BAD_NAME = /[<>:"|?*\x00-\x1f]/;
function nameError(v, allowSub) {
  const s = v.trim();
  if (!s) return 'Bir ad yaz.';
  if (BAD_NAME.test(s)) return 'Ad şu karakterleri içeremez: < > : " | ? *';
  if (!allowSub && /[\\/]/.test(s)) return 'Ad \\ ya da / içeremez.';
  if (s.split(/[\\/]/).some(x => x === '..' || x === '.')) return '"." ve ".." kullanılamaz.';
  if (/[. ]$/.test(s)) return 'Ad nokta ya da boşlukla bitemez.';
  return '';
}
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
  webp: ['fa-solid fa-file-image', '#3fbfa0'], ico: ['fa-solid fa-file-image', '#3fbfa0'], bmp: ['fa-solid fa-file-image', '#3fbfa0'], avif: ['fa-solid fa-file-image', '#3fbfa0'],
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
/* git status letters, as in most editors */
const GIT_TITLE = { M: 'Değiştirildi', A: 'Eklendi (stage)', U: 'Yeni, git izlemiyor', D: 'Silindi', R: 'Yeniden adlandırıldı', C: 'Çakışma var' };
const gitOf = fp => IDE.git.files[normPath(fp)] || '';

/* ---------- markdown view ---------- */
const isMarkdown = fp => /\.(md|markdown|mdx)$/i.test(fp);
function resolveRel(fromFile, href) {
  const parts = fromFile.split(/[\\/]/); parts.pop();
  for (const seg of href.split(/[\\/]/)) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); }
  return parts.join('\\');
}
function renderMarkdown(fp) {
  const f = IDE.files[fp]; if (!f || !f.doc) return;
  const el = $('#mdView');
  el.innerHTML = DOMPurify.sanitize(marked.parse(f.doc.getValue(), { gfm: true, breaks: false }));
  // local images: make paths relative to the markdown file
  el.querySelectorAll('img[src]').forEach(img => {
    const src = img.getAttribute('src');
    if (!/^(https?:|data:|file:)/i.test(src)) img.src = 'file:///' + resolveRel(fp, decodeURI(src)).replace(/\\/g, '/');
  });
  el.dataset.file = fp;
}
/* ---------- image preview ---------- */
function renderImage(fp) {
  const f = IDE.files[fp], el = $('#imgView');
  if (!f) return;
  const v = String(f.mtime || 0);
  if (el.dataset.file === fp && el.dataset.v === v) return;
  el.dataset.file = fp; el.dataset.v = v;
  el.innerHTML = `<div class="iv-stage"><img alt="${esc(baseName(fp))}" src="${esc(fileUrl(fp))}?v=${esc(v)}"></div>`
    + `<div class="iv-info"><b>${esc(baseName(fp))}</b><span class="iv-dim"></span><span>${fmtSize(f.size || 0)}</span></div>`;
  const img = el.querySelector('img');
  img.onload = () => { const d = el.querySelector('.iv-dim'); if (d) d.textContent = `${img.naturalWidth} × ${img.naturalHeight} piksel`; };
  img.onerror = () => { const s = el.querySelector('.iv-stage'); if (s) s.innerHTML = '<div class="iv-err"><i class="fa-regular fa-image"></i>Bu görsel gösterilemedi.</div>'; };
}

const ist = () => IDE.state[IDE.project] || (IDE.state[IDE.project] = { tabs: [], file: null });
let ideSaveTimer = null;
function saveIdeState() { clearTimeout(ideSaveTimer); ideSaveTimer = setTimeout(() => api.invoke('config:setIdeState', IDE.state), 400); }
const isDirty = fp => { const f = IDE.files[fp]; return !!f && !!f.doc && (!f.doc.isClean(f.gen) || f.eol !== f.eol0); };
const splitBom = text => (text.charCodeAt(0) === 0xFEFF ? { text: text.slice(1), bom: true } : { text, bom: false });

function setupEditor() {
  IDE.cm = CodeMirror($('#code'), {
    theme: 'claudelot', lineNumbers: true, matchBrackets: true, autoCloseBrackets: true, styleActiveLine: true,
    indentUnit: 2, tabSize: 2, value: '', lineWrapping: !!IDE.ui.wrap,
    extraKeys: {
      'Ctrl-S': () => saveFile(),
      'Ctrl-F': () => { const sel = IDE.cm.somethingSelected() && IDE.cm.getSelection(); if (sel && !sel.includes('\n')) $('#findIn').value = sel; $('#findIn').focus(); $('#findIn').select(); },
      Tab: cm => (cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('  ')),
      'Shift-Tab': cm => cm.indentSelection('subtract'),
    },
  });
  IDE.cm.getWrapperElement().hidden = true;
  IDE.cm.on('changes', () => renderEdChrome());
  IDE.cm.on('cursorActivity', () => renderEdStatus());
}
async function ensureLoaded(fp) {
  if (IDE.files[fp]) return true;
  if (isImage(fp)) {
    let st; try { st = await api.invoke('fs:stat', fp); } catch (e) { st = { exists: false }; }
    if (!st.exists) { toast('Dosya açılamadı', `${baseName(fp)}: bulunamadı`); return false; }
    IDE.files[fp] = { image: true, size: st.size, mtime: st.mtime };
    return true;
  }
  let r;
  try { r = await api.invoke('fs:read', fp); } catch (e) { r = { error: cleanErr(e) }; }
  if (r.error) { toast('Dosya açılamadı', `${baseName(fp)}: ${r.error}`); return false; }
  const { text, bom } = splitBom(r.text);
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const doc = CodeMirror.Doc(text, MODES[extOf(fp)] || null);
  IDE.files[fp] = { doc, gen: doc.changeGeneration(true), eol, eol0: eol, bom };
  return true;
}
/* at: { line (1-based), col, len } — jump there once the file is shown */
async function openFile(fp, at) {
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
  if (pid === IDE.project) { showFile(); if (ok && at) gotoPos(at); }
}
function gotoPos({ line, col = 0, len = 0 }) {
  const fp = ist().file, f = fp && IDE.files[fp];
  if (!f || !f.doc) return;
  if (IDE.mdView.has(fp)) { IDE.mdView.delete(fp); showFile(); }
  const cm = IDE.cm;
  const ln = Math.max(0, Math.min(cm.lineCount() - 1, (line | 0) - 1));
  const from = CodeMirror.Pos(ln, col), to = CodeMirror.Pos(ln, col + len);
  cm.setSelection(from, to);
  requestAnimationFrame(() => { cm.refresh(); cm.scrollIntoView({ from, to }, Math.round(cm.getScrollInfo().clientHeight / 3)); cm.focus(); });
}
function showFile() {
  const fp = ist().file;
  const f = fp && IDE.files[fp];
  if (fp && !f) { openFile(fp); return; }
  const w = IDE.cm.getWrapperElement();
  const md = !!fp && isMarkdown(fp);
  w.classList.toggle('is-md', md);
  $('#imgView').hidden = !(f && f.image);
  if (!f) { w.hidden = true; $('#codeEmpty').hidden = false; $('#mdView').hidden = true; }
  else if (f.image) { w.hidden = true; $('#codeEmpty').hidden = true; $('#mdView').hidden = true; renderImage(fp); }
  else {
    $('#codeEmpty').hidden = true; w.hidden = false;
    if (IDE.cm.getDoc() !== f.doc) IDE.cm.swapDoc(f.doc);
    const mode = MODES[extOf(fp)] || null; // the file may have been renamed to another type
    if (IDE.cm.getOption('mode') !== mode) IDE.cm.setOption('mode', mode);
    requestAnimationFrame(() => IDE.cm.refresh());
    const view = md && IDE.mdView.has(fp);
    $('#mdView').hidden = !view;
    if (view) renderMarkdown(fp);
  }
  renderEdChrome();
  renderTree();
}
/* close several editor tabs, asking once about unsaved work */
async function closeFiles(list) {
  list = list.filter(Boolean);
  if (!list.length) return false;
  const dirty = list.filter(isDirty);
  if (dirty.length && !(await uiConfirm({
    title: 'Kaydedilmemiş değişiklikler', ok: 'Kaydetmeden kapat', danger: true,
    message: dirty.length === 1 ? `${baseName(dirty[0])} dosyasında kaydedilmemiş değişiklikler var.` : `${dirty.length} dosyada kaydedilmemiş değişiklikler var:\n${dirty.map(baseName).join(', ')}`,
    detail: 'Yine de kapatılsın mı?',
  }))) return false;
  const s = ist(), drop = new Set(list);
  const idx = s.tabs.indexOf(s.file);
  s.tabs = s.tabs.filter(x => !drop.has(x));
  if (drop.has(s.file)) s.file = s.tabs[Math.min(Math.max(idx, 0), s.tabs.length - 1)] || null; // the neighbour, not the last tab
  for (const fp of list) if (!Object.values(IDE.state).some(st => st.tabs.includes(fp))) delete IDE.files[fp];
  saveIdeState(); showFile();
  return true;
}
const closeFile = fp => closeFiles([fp]);
async function saveFile(fp) {
  fp = fp || ist().file;
  const f = fp && IDE.files[fp]; if (!f || !f.doc) return false;
  let text = f.doc.getValue();
  if (f.eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  if (f.bom) text = '\uFEFF' + text;
  try { await api.invoke('fs:write', fp, text); } catch (e) { toast('Kaydedilemedi', cleanErr(e)); return false; }
  f.gen = f.doc.changeGeneration(true);
  f.eol0 = f.eol; f.conflict = false; f.missing = false;
  renderEdChrome();
  return true;
}
/* bring an open file up to date with the disk. Unsaved edits are never overwritten
   unless force is set: the file is marked as conflicting and a bar asks what to do. */
async function reloadFromDisk(fp, force) {
  const f = IDE.files[fp]; if (!f) return;
  let st; try { st = await api.invoke('fs:stat', fp); } catch (_) { return; }
  if (!st.exists) { if (!f.missing) { f.missing = true; renderEdChrome(); } return; }
  f.missing = false;
  if (f.image) { f.mtime = st.mtime; f.size = st.size; if (fp === ist().file && S.mode === 'ide') renderImage(fp); return; }
  let r; try { r = await api.invoke('fs:read', fp); } catch (_) { return; }
  if (r.error || !IDE.files[fp]) return;
  const { text, bom } = splitBom(r.text);
  const disk = text.replace(/\r\n/g, '\n');
  if (disk === f.doc.getValue()) { f.conflict = false; return; } // e.g. our own save
  if (isDirty(fp) && !force) { f.conflict = true; renderEdChrome(); return; }
  const cm = IDE.cm, active = cm.getDoc() === f.doc;
  const sels = f.doc.listSelections(), scroll = active ? cm.getScrollInfo() : null;
  f.doc.setValue(disk);
  try { f.doc.setSelections(sels); } catch (_) {}
  if (active) cm.scrollTo(scroll.left, scroll.top);
  f.eol = f.eol0 = /\r\n/.test(text) ? '\r\n' : '\n'; f.bom = bom;
  f.gen = f.doc.changeGeneration(true); f.conflict = false;
  if (fp === ist().file && IDE.mdView.has(fp)) renderMarkdown(fp);
  renderEdChrome();
}
async function fileChangedByClaude(fp, created) {
  const key = normPath(fp);
  S.modified[key] = Date.now();
  if (created) { // a new file may live in a folder we have cached
    const dir = key.slice(0, key.lastIndexOf('\\'));
    Object.keys(IDE.dirCache).forEach(d => { if (normPath(d) === dir) delete IDE.dirCache[d]; });
    delete IDE.index[IDE.project];
  }
  const open = Object.keys(IDE.files).find(k => normPath(k) === key);
  if (open) await reloadFromDisk(open);
  if (S.mode === 'ide') { renderTree(); renderEdChrome(); }
}
/* the folder watcher (main process) reports changes made outside the editor */
const FSQ = { paths: new Set(), git: false, many: false, timer: null };
function onFsChanged(ev) {
  const r = projRoot();
  if (!r || normPath(ev.root) !== normPath(r)) return;
  ev.paths.forEach(p => FSQ.paths.add(p));
  if (ev.git) FSQ.git = true;
  if (ev.many) FSQ.many = true;
  clearTimeout(FSQ.timer); FSQ.timer = setTimeout(applyFsChanges, 120);
}
async function applyFsChanges() {
  const paths = [...FSQ.paths], many = FSQ.many, git = FSQ.git;
  FSQ.paths.clear(); FSQ.many = FSQ.git = false;
  const structural = many || paths.length > 0;
  if (structural) delete IDE.index[IDE.project];
  if (many) IDE.dirCache = {};
  else if (paths.length) {
    const dirs = new Set();
    paths.forEach(p => { const n = normPath(p); dirs.add(n); dirs.add(n.slice(0, n.lastIndexOf('\\'))); });
    Object.keys(IDE.dirCache).forEach(d => { if (dirs.has(normPath(d))) delete IDE.dirCache[d]; });
  }
  const changed = new Set(paths.map(normPath));
  await Promise.all(Object.keys(IDE.files).filter(fp => many || changed.has(normPath(fp))).map(fp => reloadFromDisk(fp)));
  if (git) refreshGit();
  if (S.mode === 'ide' && structural) renderTree();
}
let gitTimer = null;
function refreshGit() {
  clearTimeout(gitTimer);
  gitTimer = setTimeout(async () => {
    const p = proj(IDE.project); if (!p) return;
    let g; try { g = await api.invoke('ide:git', p.path); } catch (_) { g = { repo: false, files: {} }; }
    if (!proj(IDE.project) || proj(IDE.project).path !== p.path) return;
    const root = normPath(p.path).replace(/\\+$/, ''), dirs = new Set();
    for (const [k, c] of Object.entries(g.files)) {
      if (c === 'D') continue;
      let d = k;
      while ((d = d.slice(0, d.lastIndexOf('\\'))).length > root.length) dirs.add(d);
    }
    IDE.git = { repo: g.repo, branch: g.branch || '', files: g.files, dirs };
    if (S.mode === 'ide') { renderTree(); renderEdChrome(); }
  }, 250);
}
function renderEdChrome() {
  if (!IDE.project) { renderEdStatus(); return; }
  const s = ist(), key = s.file;
  const cur = key && IDE.files[key];
  $('#tbSave').disabled = !(key && isDirty(key));
  $('#tbSaveAll').disabled = !s.tabs.some(isDirty);
  // two open files with the same name: show their folder too
  const names = {};
  s.tabs.forEach(k => { const b = baseName(k).toLowerCase(); names[b] = (names[b] || 0) + 1; });
  $('#etabs').innerHTML = s.tabs.length ? s.tabs.map(k => {
    const f = IDE.files[k], d = isDirty(k), g = gitOf(k);
    const dup = names[baseName(k).toLowerCase()] > 1 ? `<span class="et-dir">${esc(baseName(dirOf(k)))}</span>` : '';
    return `<div class="etab ${k === key ? 'on' : ''} ${d ? 'is-dirty' : ''} ${g ? 'g-' + g : ''} ${f && f.missing ? 'is-gone' : ''}" data-etab="${esc(k)}" title="${esc(relOf(k))}${g ? ' · ' + GIT_TITLE[g] : ''}${d ? ' · kaydedilmedi' : ''}">`
      + `<button data-file="${esc(k)}" role="tab" aria-selected="${k === key}">${fileIcon(k)}<span class="et-n">${esc(baseName(k))}</span>${dup}</button>`
      + `<button class="tab-x" data-fclose="${esc(k)}" aria-label="${esc(baseName(k))} dosyasını kapat" title="Kapat (orta tık)"><i class="fa-solid fa-xmark"></i><span class="et-dot" aria-hidden="true"></span></button></div>`;
  }).join('') : '<span class="etabs-empty">Açık dosya yok</span>';
  const on = $('#etabs .etab.on'); if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  renderDiskBar();
  renderEdStatus();
  if (!key) { $('#crumb').innerHTML = ''; $('#crumb').hidden = true; return; }
  $('#crumb').hidden = false;
  const p = proj(IDE.project);
  const relp = relOf(key);
  const dirty = isDirty(key), mod = S.modified[normPath(key)];
  const parts = relp.split(/[\\/]/);
  $('#crumb').innerHTML = `<span class="cr-path"><span class="cr-p">${esc(p ? p.name : '')}</span>${parts.map((x, i) => `<i class="fa-solid fa-chevron-right cr-sep" aria-hidden="true"></i><span class="${i === parts.length - 1 ? 'cr-f' : 'cr-p'}">${esc(x)}</span>`).join('')}</span>`
    + (mod ? `<span class="crumb-mod" title="Claude bu dosyayı düzenledi"><i class="fa-solid fa-robot"></i> Claude değiştirdi · ${rel(mod)}</span>` : '')
    + (isMarkdown(key) ? `<span class="seg md-seg"><button class="${IDE.mdView.has(key) ? '' : 'on'}" data-mdmode="src" title="Markdown kaynağını düzenle"><i class="fa-solid fa-code"></i> Yazı</button><button class="${IDE.mdView.has(key) ? 'on' : ''}" data-mdmode="view" title="Biçimlendirilmiş görünüm"><i class="fa-solid fa-eye"></i> Görünüm</button></span>` : '')
    + (cur && cur.image ? '' : `<span class="save-wrap"><span class="sv-st ${dirty ? 'is-dirty' : ''}">${dirty ? 'Kaydedilmedi' : 'Kaydedildi'}</span><button class="btn ${dirty ? 'primary' : ''}" id="saveBtn" ${dirty ? '' : 'disabled'}>Kaydet <kbd>Ctrl+S</kbd></button></span>`);
}
/* a bar above the editor when the file changed on disk under unsaved edits, or disappeared */
function renderDiskBar() {
  const fp = ist().file, f = fp && IDE.files[fp], el = $('#diskBar');
  if (!f || (!f.conflict && !f.missing)) { el.hidden = true; return; }
  el.hidden = false;
  el.className = 'disk-bar ' + (f.missing ? 'gone' : 'conflict');
  el.innerHTML = f.missing
    ? '<i class="fa-solid fa-triangle-exclamation"></i><span>Bu dosya diskte yok: silinmiş ya da taşınmış.</span>'
      + (f.doc ? '<button class="btn" data-ixdisk="save">Kaydet ve yeniden oluştur</button>' : '') + '<button class="btn" data-ixdisk="close">Sekmeyi kapat</button>'
    : '<i class="fa-solid fa-code-compare"></i><span>Dosya diskte değişti (ör. Claude düzenledi), ama sende kaydedilmemiş değişiklikler var.</span>'
      + '<button class="btn primary" data-ixdisk="load">Diskteki sürümü yükle</button><button class="btn" data-ixdisk="keep">Benimkini koru</button>';
}
/* editor status strip: cursor, indentation, encoding, line endings, language, wrap */
function renderEdStatus() {
  const el = $('#edStatus'); if (!el) return;
  const fp = IDE.project && ist().file, f = fp && IDE.files[fp];
  if (!f) { el.hidden = true; return; }
  el.hidden = false;
  const g = gitOf(fp);
  const left = (IDE.git.repo && IDE.git.branch ? `<span class="es-i" title="Git dalı"><i class="fa-solid fa-code-branch"></i>${esc(IDE.git.branch)}</span>` : '')
    + (g ? `<span class="es-i es-g g-${g}" title="Git durumu">${GIT_TITLE[g]}</span>` : '');
  if (f.image) { el.innerHTML = left + `<span class="es-sp"></span><span class="es-i">Görsel önizleme</span>`; return; }
  const cm = IDE.cm, c = cm.getCursor();
  const selLen = cm.getSelections().reduce((a, s) => a + s.length, 0);
  el.innerHTML = left + '<span class="es-sp"></span>'
    + `<button class="es-i" data-ixes="goto" title="Satıra git (Ctrl+G)">Satır ${c.line + 1}, Sütun ${c.ch + 1}${selLen ? ` <span class="es-m">(${selLen} seçili)</span>` : ''}</button>`
    + `<span class="es-i" title="Girinti">Boşluk: ${cm.getOption('indentUnit')}</span>`
    + `<span class="es-i" title="Karakter kodlaması">${f.bom ? 'UTF-8 BOM' : 'UTF-8'}</span>`
    + `<button class="es-i" data-ixes="eol" title="Satır sonu: tıklayınca ${f.eol === '\r\n' ? 'LF' : 'CRLF'} olur (kaydedince uygulanır)">${f.eol === '\r\n' ? 'CRLF' : 'LF'}</button>`
    + `<span class="es-i" title="Dil">${esc(langName(fp))}</span>`
    + `<button class="es-i" data-ixes="wrap" aria-pressed="${!!IDE.ui.wrap}" title="Satır sarmayı aç / kapat (Alt+Z)"><i class="fa-solid fa-arrow-turn-down"></i>Sarma ${IDE.ui.wrap ? 'açık' : 'kapalı'}</button>`;
}
async function loadDir(dir) {
  if (IDE.dirCache[dir]) return IDE.dirCache[dir];
  try { IDE.dirCache[dir] = await api.invoke('fs:list', dir); } catch (_) { IDE.dirCache[dir] = []; }
  return IDE.dirCache[dir];
}
let treeToken = 0;
async function renderTree() {
  const p = proj(IDE.project);
  if (!p) { $('#tree').innerHTML = '<div class="ex-empty"><i class="fa-regular fa-folder-open"></i><b>Proje yok</b><span>Claude modunda “Proje ekle” ile bir klasör ekle.</span></div>'; return; }
  if (IDE.watched !== p.path) { // follow the project shown in the IDE
    IDE.watched = p.path;
    api.invoke('ide:watch', p.path).catch(() => {});
    IDE.git = { repo: false, files: {}, dirs: new Set(), branch: '' };
    refreshGit();
  }
  const my = ++treeToken;
  await loadDir(p.path);
  const loadOpen = async dir => { for (const e of IDE.dirCache[dir] || []) if (e.dir && IDE.expanded[e.path]) { await loadDir(e.path); await loadOpen(e.path); } };
  await loadOpen(p.path);
  if (my !== treeToken) return;
  const cur = ist().file;
  const walk = (dir, d) => (IDE.dirCache[dir] || []).map(e => {
    if (e.dir) {
      const open = IDE.expanded[e.path], gd = IDE.git.dirs.has(normPath(e.path));
      return `<button class="fx dir ${open ? '' : 'closed'} ${gd ? 'g-dir' : ''}" style="--d:${d}" data-dir="${esc(e.path)}" aria-expanded="${!!open}" title="${esc(e.name)}${gd ? ' · içinde değişiklik var' : ''}"><i class="car fa-solid fa-chevron-down" aria-hidden="true"></i>${open ? FOLDER_OPEN : FOLDER}<span class="fn">${esc(e.name)}</span>${gd ? '<span class="gdot" aria-hidden="true"></span>' : ''}</button>` + (open ? walk(e.path, d + 1) : '');
    }
    const g = gitOf(e.path), m = S.modified[normPath(e.path)];
    return `<button class="fx file ${e.path === cur ? 'on' : ''} ${/^(~\$|\.)/.test(e.name) ? 'dim' : ''} ${g ? 'g-' + g : ''}" style="--d:${d}" data-file="${esc(e.path)}" title="${esc(e.name)}${g ? ' · ' + GIT_TITLE[g] : ''}${m ? ' · Claude değiştirdi' : ''}">${fileIcon(e.name)}<span class="fn">${esc(e.name)}</span>${m ? '<span class="mod" aria-label="Claude değiştirdi"><i class="fa-solid fa-robot"></i></span>' : ''}${g ? `<span class="gb">${g}</span>` : ''}</button>`;
  }).join('');
  const html = walk(p.path, 0);
  const tree = $('#tree');
  const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('#tree .fx');
  const keep = focused ? (focused.dataset.file || focused.dataset.dir) : null, top = tree.scrollTop;
  tree.innerHTML = html || '<div class="ex-empty"><i class="fa-regular fa-folder"></i><b>Klasör boş</b><span>Sağ tıkla ya da yukarıdaki düğmelerle dosya ekle.</span></div>';
  tree.scrollTop = top;
  const find = fp => $$('#tree .fx').find(b => (b.dataset.file || b.dataset.dir) === fp);
  if (keep) { const b = find(keep); if (b) b.focus({ preventScroll: true }); }
  if (IDE.reveal) { const b = find(IDE.reveal); IDE.reveal = null; if (b) b.scrollIntoView({ block: 'center' }); }
}
/* open the folders on the way to a file and scroll it into view */
function revealInTree(fp) {
  const r = projRoot(); if (!r || !under(fp, r)) return;
  let d = dirOf(fp);
  while (d.length > r.length) { IDE.expanded[d] = true; d = dirOf(d); }
  if (IDE.view !== 'files') setExView('files');
  IDE.reveal = fp;
  renderTree();
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
  IDE.search.res = null; renderSearch();
  const live = S.tabs.filter(t => t.projectId === pid);
  if (!live.some(t => t.id === S.active)) S.active = live.length ? live[live.length - 1].id : null;
  showFile();
  renderAll();
  const t = tabById(S.active);
  if (t) { $$('.term-pane').forEach(x => x.classList.toggle('on', x === t.el)); requestAnimationFrame(fitActive); }
}
function applyIdeUi() {
  $('#ideView').classList.toggle('no-ex', !IDE.ui.ex);
  const bp = $('#bpanel'), right = IDE.ui.dock === 'right';
  bp.hidden = !IDE.ui.panel;
  // docked right: the panel becomes its own grid column next to the editor
  if (right && bp.parentElement !== $('#ideView')) $('.editor').after(bp);
  else if (!right && bp.parentElement !== $('.editor')) $('.editor').appendChild(bp);
  $('#ideView').classList.toggle('dock-r', right && IDE.ui.panel);
  $('#ideView').style.setProperty('--pw', IDE.ui.pw + 'px');
  bp.style.setProperty('--ph', IDE.ui.ph + 'px');
  const dk = $('#bpDock'), tip = right ? 'Paneli alta al' : 'Paneli sağa al';
  dk.title = tip; dk.setAttribute('aria-label', tip);
  dk.innerHTML = right ? '<i class="fa-solid fa-table-columns fa-rotate-270"></i>' : '<i class="fa-solid fa-table-columns"></i>';
  $('#code').style.setProperty('--ed-size', IDE.ui.size + 'px');
  $('#tbEx').setAttribute('aria-pressed', IDE.ui.ex);
  $('#tbPanel').setAttribute('aria-pressed', IDE.ui.panel);
  $('#tbSize').textContent = IDE.ui.size + 'px';
  IDE.cm.setOption('lineWrapping', !!IDE.ui.wrap);
  renderEdStatus();
  requestAnimationFrame(() => { IDE.cm.refresh(); fitActive(); });
}
function saveIdeUi() { applyIdeUi(); setCfg({ ide: { ui: IDE.ui } }); }
function toggleWrap() { IDE.ui.wrap = !IDE.ui.wrap; saveIdeUi(); }
function findNext(q, back) {
  const cm = IDE.cm;
  if (!q || cm.getWrapperElement().hidden) { $('#findN').textContent = ''; return; }
  let count = 0;
  const all = cm.getSearchCursor(q, CodeMirror.Pos(0, 0), { caseFold: true });
  while (all.findNext() && count < 9999) count++;
  $('#findN').textContent = count ? count + ' eşleşme' : 'Bulunamadı';
  if (!count) return;
  let cur = cm.getSearchCursor(q, cm.getCursor(back ? 'from' : 'to'), { caseFold: true });
  if (!(back ? cur.findPrevious() : cur.findNext())) {
    cur = cm.getSearchCursor(q, back ? CodeMirror.Pos(cm.lastLine()) : CodeMirror.Pos(0, 0), { caseFold: true });
    if (back) cur.findPrevious(); else cur.findNext();
  }
  cm.setSelection(cur.from(), cur.to());
  cm.scrollIntoView({ from: cur.from(), to: cur.to() }, 80);
}
/* puts "@path" (and the selected lines) into the project's Claude session */
async function askClaude(target, targetIsDir) {
  const p = proj(IDE.project);
  const fp = target || ist().file;
  if (!fp || !p) { toast('Önce bir dosya aç'); return; }
  const isDir = !!targetIsDir;
  let ref = '@' + relOf(fp).replace(/\\/g, '/') + (isDir ? '/' : '');
  const cm = IDE.cm, f = IDE.files[fp];
  if (fp === ist().file && f && f.doc && cm.somethingSelected()) {
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

/* ---------- explorer: files / search views ---------- */
function setExView(v) {
  IDE.view = v;
  $$('[data-exview]').forEach(b => { b.classList.toggle('on', b.dataset.exview === v); b.setAttribute('aria-selected', b.dataset.exview === v); });
  $('#tree').hidden = v !== 'files';
  $('#psearch').hidden = v !== 'search';
  $('#exFileActs').hidden = v !== 'files';
  if (v === 'search') { renderSearch(); requestAnimationFrame(() => { $('#psIn').focus(); $('#psIn').select(); }); }
}
function openProjectSearch() {
  if (!IDE.ui.ex) { IDE.ui.ex = true; saveIdeUi(); }
  const cm = IDE.cm, f = IDE.files[ist().file];
  const sel = f && f.doc && !cm.getWrapperElement().hidden && cm.somethingSelected() ? cm.getSelection() : '';
  if (sel && !sel.includes('\n') && sel.length < 200) { $('#psIn').value = sel; IDE.search.q = ''; }
  setExView('search');
  if (sel) runSearch();
}
let searchTimer = null;
async function runSearch() {
  clearTimeout(searchTimer);
  const S2 = IDE.search, q = $('#psIn').value, p = proj(IDE.project);
  if (!p) return;
  if (!q.trim()) { S2.q = ''; S2.res = null; renderSearch(); return; }
  const sig = [q, S2.case, S2.word, S2.regex, p.id].join('\u0001');
  if (sig === S2.q && S2.res && !S2.res.stale) return;
  S2.q = sig; S2.busy = true; S2.closed = new Set();
  const my = ++S2.token;
  renderSearch();
  let r; try { r = await api.invoke('ide:search', p.path, q, { case: S2.case, word: S2.word, regex: S2.regex }); } catch (e) { r = { error: cleanErr(e) }; }
  if (my !== S2.token) return;
  S2.busy = false;
  S2.res = { ...r, pid: p.id, root: p.path.replace(/[\\/]+$/, ''), q };
  renderSearch();
}
function renderSearch() {
  const S2 = IDE.search, sum = $('#psSum'), box = $('#psRes');
  $$('[data-psopt]').forEach(b => b.setAttribute('aria-pressed', !!S2[b.dataset.psopt]));
  const res = S2.res && S2.res.pid === IDE.project ? S2.res : null;
  if (S2.busy) { sum.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Aranıyor…'; return; }
  if (!res) { sum.textContent = ''; box.innerHTML = '<div class="ex-empty"><i class="fa-solid fa-magnifying-glass"></i><b>Projede ara</b><span>Yaz ve Enter’a bas. Sonuca tıklayınca dosya o satırda açılır.</span></div>'; return; }
  if (res.error) { sum.innerHTML = `<span class="ps-err">${esc(res.error)}</span>`; box.innerHTML = ''; return; }
  if (!res.hits.length) { sum.textContent = 'Sonuç bulunamadı.'; box.innerHTML = ''; return; }
  sum.textContent = `${res.files} dosyada ${res.hits.length}${res.truncated ? '+' : ''} sonuç` + (res.truncated ? ' (ilk 2000 gösteriliyor)' : '');
  const groups = new Map();
  res.hits.forEach((h, i) => { if (!groups.has(h.file)) groups.set(h.file, []); groups.get(h.file).push(i); });
  let html = '';
  for (const [file, idx] of groups) {
    const shut = S2.closed.has(file), dir = dirOf(file);
    html += `<button class="ps-f ${shut ? 'closed' : ''}" data-psfile="${esc(file)}" aria-expanded="${!shut}" title="${esc(file)}"><i class="car fa-solid fa-chevron-down" aria-hidden="true"></i>${fileIcon(file)}<span class="fn">${esc(baseName(file))}</span><span class="ps-dir">${esc(dir)}</span><span class="ps-n">${idx.length}</span></button>`;
    if (shut) continue;
    html += idx.map(i => {
      const h = res.hits[i], a = h.col - h.pre, t = h.text;
      // the panel is narrow: keep only a little text before the match so the match stays visible
      let before = t.slice(0, a).replace(/^\s+/, '');
      const cut = h.pre > 0 || before.length > 18;
      if (before.length > 18) before = before.slice(-18);
      return `<button class="ps-h" data-pshit="${i}" title="Satır ${h.line}: ${esc(t.trim())}"><span class="ps-ln">${h.line}</span><span class="ps-t">${cut ? '…' : ''}${esc(before)}<mark>${esc(t.slice(a, a + h.len))}</mark>${esc(t.slice(a + h.len))}</span></button>`;
    }).join('');
  }
  box.innerHTML = html;
}

/* ---------- quick open (Ctrl+P), go to line (Ctrl+G) and name prompts ---------- */
const QO = { mode: 'file', items: [], sel: 0, resolve: null, validate: null };
async function fileIndex() {
  const p = proj(IDE.project); if (!p) return null;
  if (IDE.index[p.id]) return IDE.index[p.id];
  try { IDE.index[p.id] = await api.invoke('ide:files', p.path); } catch (_) { IDE.index[p.id] = { files: [], complete: true }; }
  return IDE.index[p.id];
}
/* subsequence match; rewards word starts, runs and hits in the file name */
function fuzzy(q, path) {
  const t = path.toLowerCase(), base = t.lastIndexOf('\\') + 1;
  const tryFrom = start => {
    let qi = 0, score = 0, last = -2;
    const pos = [];
    for (let i = start; i < t.length && qi < q.length; i++) {
      if (t[i] !== q[qi]) continue;
      let sc = 1;
      if (i === last + 1) sc += 4;
      if (i === base || /[\\/._\-\s]/.test(t[i - 1] || '\\')) sc += 3;
      if (i >= base) sc += 2;
      score += sc; pos.push(i); last = i; qi++;
    }
    return qi === q.length ? { score, pos } : null;
  };
  // prefer a match that stays inside the file name
  const r = tryFrom(base) || tryFrom(0);
  if (!r) return null;
  if (t.slice(base).startsWith(q)) r.score += 12;
  r.score -= t.length * 0.05;
  return r;
}
const markPos = (s, pos, off) => { let out = ''; for (let i = 0; i < s.length; i++) out += pos.has(i + off) ? `<b>${esc(s[i])}</b>` : esc(s[i]); return out; };
function openPalette(text) {
  if (S.mode !== 'ide') setMode('ide');
  if (!proj(IDE.project)) { toast('Önce bir proje ekle'); return; }
  QO.mode = 'file'; QO.resolve = null; QO.validate = null;
  $('#qoBg').hidden = false;
  $('#qoTitle').hidden = true;
  const inp = $('#qoIn');
  inp.value = text || ''; inp.placeholder = 'Dosya adı yaz · satıra gitmek için : yaz';
  inp.setAttribute('aria-label', 'Dosyaya git');
  inp.focus();
  if (text === ':') inp.setSelectionRange(1, 1);
  QO.sel = 0;
  renderPalette();
  fileIndex().then(() => { if (!$('#qoBg').hidden && QO.mode === 'file') renderPalette(); });
}
/* a small dialog for a name; resolves to the text, or null when cancelled */
function askName({ title, hint, value = '', select, placeholder = '', validate }) {
  if (QO.resolve) QO.resolve(null);
  return new Promise(resolve => {
    QO.mode = 'prompt'; QO.resolve = resolve; QO.validate = validate || null; QO.hint = hint || '';
    $('#qoBg').hidden = false;
    $('#qoTitle').hidden = false; $('#qoTitle').textContent = title;
    const inp = $('#qoIn');
    inp.value = value; inp.placeholder = placeholder; inp.setAttribute('aria-label', title);
    inp.focus();
    if (select) inp.setSelectionRange(select[0], select[1]); else inp.select();
    renderPalette();
  });
}
function closePalette(result) {
  if ($('#qoBg').hidden) return;
  $('#qoBg').hidden = true;
  const r = QO.resolve; QO.resolve = null;
  if (r) r(result == null ? null : result);
  if (!IDE.cm.getWrapperElement().hidden && result === undefined) IDE.cm.focus();
}
function renderPalette() {
  const v = $('#qoIn').value, list = $('#qoList'), foot = $('#qoFoot');
  if (QO.mode === 'prompt') {
    const err = QO.validate ? QO.validate(v) : '';
    QO.items = [];
    list.innerHTML = `<div class="qo-note ${err && v ? 'err' : ''}">${esc(err && v ? err : QO.hint)}</div>`;
    foot.innerHTML = '<span><kbd>Enter</kbd> onayla</span><span><kbd>Esc</kbd> vazgeç</span>';
    return;
  }
  foot.innerHTML = '<span><kbd>↑</kbd><kbd>↓</kbd> seç</span><span><kbd>Enter</kbd> aç</span><span><kbd>:</kbd>12 satıra git</span><span><kbd>Esc</kbd> kapat</span>';
  const m = v.match(/^(.*?):(\d*)$/);
  const q = (m ? m[1] : v).trim(), line = m ? +m[2] || 0 : 0;
  const cur = ist().file, f = cur && IDE.files[cur];
  if (m && !q) { // ":42" — a line in the open file
    QO.items = f && f.doc ? [{ line: line || 1 }] : [];
    list.innerHTML = f && f.doc
      ? `<button class="qo-row sel" data-qoi="0"><i class="fa-solid fa-arrow-right-to-bracket qo-ic"></i><span class="qo-n">${line ? `Satır ${line}’e git` : 'Bir satır numarası yaz'}</span><span class="qo-d">${esc(baseName(cur))} · 1–${IDE.cm.lineCount()}</span></button>`
      : '<div class="qo-note">Satıra gitmek için önce bir metin dosyası aç.</div>';
    QO.sel = 0;
    return;
  }
  const idx = IDE.index[IDE.project];
  if (!idx) { QO.items = []; list.innerHTML = '<div class="qo-note"><i class="fa-solid fa-spinner fa-spin"></i> Dosyalar taranıyor…</div>'; return; }
  const root = projRoot();
  let items;
  if (!q) {
    // nothing typed: open tabs first (most recent last → first), then the rest
    const open = [...ist().tabs].reverse().filter(x => x !== cur).map(x => relOf(x));
    const seen = new Set(open.map(x => x.toLowerCase()));
    items = [...open, ...idx.files.filter(x => !seen.has(x.toLowerCase()))].slice(0, 60).map(rel => ({ rel, pos: new Set(), open: seen.has(rel.toLowerCase()) }));
  } else {
    const ql = q.toLowerCase().replace(/\//g, '\\').replace(/\s+/g, '');
    const scored = [];
    for (const rel of idx.files) { const r = fuzzy(ql, rel); if (r) scored.push({ rel, score: r.score, pos: new Set(r.pos) }); }
    scored.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length);
    items = scored.slice(0, 60);
  }
  QO.items = items.map(it => ({ ...it, full: joinP(root, it.rel), line }));
  QO.sel = Math.min(QO.sel, Math.max(0, QO.items.length - 1));
  list.innerHTML = QO.items.length ? QO.items.map((it, i) => {
    const b = it.rel.lastIndexOf('\\') + 1, name = it.rel.slice(b), dir = it.rel.slice(0, Math.max(0, b - 1));
    const g = gitOf(it.full);
    return `<button class="qo-row ${i === QO.sel ? 'sel' : ''} ${g ? 'g-' + g : ''}" data-qoi="${i}" role="option" aria-selected="${i === QO.sel}">${fileIcon(name)}<span class="qo-n">${markPos(name, it.pos, b)}</span><span class="qo-d">${markPos(dir, it.pos, 0)}</span>${it.open ? '<span class="qo-tag">açık</span>' : ''}</button>`;
  }).join('') + (idx.complete ? '' : '<div class="qo-note">Proje çok büyük; yalnızca ilk 20.000 dosya tarandı.</div>')
    : `<div class="qo-note">“${esc(q)}” ile eşleşen dosya yok.</div>`;
  const s = list.querySelector('.qo-row.sel'); if (s) s.scrollIntoView({ block: 'nearest' });
}
function pickPalette(i) {
  if (QO.mode === 'prompt') {
    const v = $('#qoIn').value;
    if (QO.validate && QO.validate(v)) { renderPalette(); return; }
    closePalette(v.trim());
    return;
  }
  const it = QO.items[i == null ? QO.sel : i]; if (!it) return;
  closePalette(null);
  if (!it.rel) { gotoPos({ line: it.line }); return; }
  openFile(it.full, it.line ? { line: it.line } : null).then(() => { revealInTree(it.full); if (!it.line && !IDE.cm.getWrapperElement().hidden) IDE.cm.focus(); });
}

/* ---------- file operations from the tree ---------- */
async function newEntry(dir, isDir) {
  const r = projRoot(); if (!r) { toast('Önce bir proje ekle'); return; }
  dir = dir && under(dir, r) ? dir : r;
  const where = normPath(dir) === normPath(r) ? 'proje kökü' : relOf(dir);
  const name = await askName({
    title: isDir ? 'Yeni klasör' : 'Yeni dosya',
    hint: `Konum: ${where} · alt klasör için / kullanabilirsin`,
    placeholder: isDir ? 'klasör-adı' : 'dosya-adı.js',
    validate: v => nameError(v, true),
  });
  if (!name) return;
  const clean = name.replace(/\//g, '\\').replace(/^\\+|\\+$/g, '');
  const full = joinP(dir, clean);
  let st = { exists: false }; try { st = await api.invoke('fs:stat', full); } catch (_) {}
  if (st.exists && (isDir || st.dir)) { toast('Zaten var', `${clean} adında bir ${st.dir ? 'klasör' : 'dosya'} var.`); return; }
  if (!st.exists) {
    try { await api.invoke(isDir ? 'fs:mkdir' : 'fs:create', full); } catch (e) { toast(isDir ? 'Klasör oluşturulamadı' : 'Dosya oluşturulamadı', cleanErr(e)); return; }
  }
  IDE.dirCache = {}; delete IDE.index[IDE.project];
  IDE.expanded[dir] = true;
  if (isDir) { IDE.expanded[full] = true; revealInTree(full); }
  else { await openFile(full); revealInTree(full); }
}
function remapPaths(from, to) {
  const swap = k => (under(k, from) ? to + k.slice(from.length) : k);
  const files = {};
  for (const [k, f] of Object.entries(IDE.files)) files[swap(k)] = f;
  IDE.files = files;
  for (const st of Object.values(IDE.state)) { st.tabs = st.tabs.map(swap); if (st.file) st.file = swap(st.file); }
  IDE.mdView = new Set([...IDE.mdView].map(swap));
  const exp = {}; for (const [k, v] of Object.entries(IDE.expanded)) exp[swap(k)] = v; IDE.expanded = exp;
  const fromN = normPath(from), toN = normPath(to);
  for (const k of Object.keys(S.modified)) if (k === fromN || k.startsWith(fromN + '\\')) { S.modified[toN + k.slice(fromN.length)] = S.modified[k]; delete S.modified[k]; }
  saveIdeState();
}
async function renameEntry(fp, isDir) {
  if (normPath(fp) === normPath(projRoot())) return;
  const old = baseName(fp), dot = old.lastIndexOf('.');
  const name = await askName({
    title: isDir ? 'Klasörü yeniden adlandır' : 'Dosyayı yeniden adlandır',
    hint: `Şu anki ad: ${old}`, value: old, select: [0, !isDir && dot > 0 ? dot : old.length],
    validate: v => nameError(v, false),
  });
  if (!name || name === old) return;
  const to = joinP(dirOf(fp), name);
  try { await api.invoke('fs:rename', fp, to); } catch (e) { toast('Yeniden adlandırılamadı', cleanErr(e)); return; }
  remapPaths(fp, to);
  IDE.dirCache = {}; delete IDE.index[IDE.project];
  IDE.reveal = to;
  showFile();
}
async function deleteEntry(fp, isDir) {
  if (normPath(fp) === normPath(projRoot())) return;
  const open = Object.keys(IDE.files).filter(k => under(k, fp));
  const dirty = open.filter(isDirty);
  const msg = `“${baseName(fp)}” ${isDir ? 'klasörü ve içindekiler' : 'dosyası'} Geri Dönüşüm Kutusu’na taşınsın mı?`
    + (dirty.length ? `\n\nKaydedilmemiş değişiklikler kaybolacak: ${dirty.map(baseName).join(', ')}` : '');
  if (!(await uiConfirm({ title: 'Silinsin mi?', message: msg, ok: 'Geri Dönüşüm Kutusu’na taşı', danger: true, icon: 'fa-trash-can' }))) return;
  try { await api.invoke('fs:trash', fp); } catch (e) { toast('Silinemedi', cleanErr(e)); return; }
  for (const st of Object.values(IDE.state)) {
    const idx = st.tabs.indexOf(st.file);
    st.tabs = st.tabs.filter(k => !under(k, fp));
    if (st.file && under(st.file, fp)) st.file = st.tabs[Math.min(Math.max(idx, 0), st.tabs.length - 1)] || null;
  }
  open.forEach(k => { delete IDE.files[k]; IDE.mdView.delete(k); });
  IDE.dirCache = {}; delete IDE.index[IDE.project];
  saveIdeState(); showFile();
  toast('Geri Dönüşüm Kutusu’na taşındı', baseName(fp));
}
function copyText(text, what) {
  navigator.clipboard.writeText(text).then(() => toast(what, text), () => toast('Kopyalanamadı'));
}

/* ---------- context menus (tree and editor tabs) ---------- */
function openIdeMenu(e, ctx) {
  e.preventDefault();
  IDE.menu = ctx;
  const m = $('#ideMenu');
  const it = (act, icon, label, key, cls = '') => `<button data-ixm="${act}" class="${cls}" role="menuitem"><span class="mi"><i class="mic ${icon}"></i>${label}</span>${key ? `<code>${key}</code>` : ''}</button>`;
  const sep = '<div class="sep"></div>';
  let html = '';
  if (ctx.kind === 'tab') {
    const s = ist(), i = s.tabs.indexOf(ctx.path);
    html = it('close', 'fa-solid fa-xmark', 'Kapat', 'Ctrl+W')
      + (s.tabs.length > 1 ? it('closeothers', 'fa-solid fa-clone', 'Diğerlerini kapat') : '')
      + (i < s.tabs.length - 1 ? it('closeright', 'fa-solid fa-arrow-right-long', 'Sağdakileri kapat') : '')
      + (s.tabs.some(k => !isDirty(k)) ? it('closesaved', 'fa-solid fa-check-double', 'Kaydedilmişleri kapat') : '')
      + it('closeall', 'fa-solid fa-square-xmark', 'Tümünü kapat')
      + sep + it('revealtree', 'fa-solid fa-folder-tree', 'Dosya ağacında göster')
      + it('copy', 'fa-regular fa-copy', 'Yolu kopyala') + it('copyrel', 'fa-solid fa-link', 'Göreli yolu kopyala')
      + it('reveal', 'fa-regular fa-folder-open', 'Dosya Gezgini’nde göster');
  } else {
    const root = !ctx.path || normPath(ctx.path) === normPath(projRoot());
    html = it('newfile', 'fa-solid fa-file-circle-plus', 'Yeni dosya') + it('newdir', 'fa-solid fa-folder-plus', 'Yeni klasör')
      + (root ? sep + it('collapse', 'fa-solid fa-angles-up', 'Tümünü daralt') + it('refresh', 'fa-solid fa-arrows-rotate', 'Yenile')
        : sep + it('rename', 'fa-solid fa-i-cursor', 'Yeniden adlandır', 'F2') + it('delete', 'fa-regular fa-trash-can', 'Sil', 'Delete', 'danger'))
      + sep + it('copy', 'fa-regular fa-copy', 'Yolu kopyala') + (root ? '' : it('copyrel', 'fa-solid fa-link', 'Göreli yolu kopyala'))
      + it('reveal', 'fa-regular fa-folder-open', 'Dosya Gezgini’nde göster')
      + (root ? '' : sep + it('ask', 'fa-solid fa-comment-dots', 'Claude’a sor', '', 'accent'));
  }
  m.innerHTML = html;
  m.hidden = false;
  const w = $('#win').getBoundingClientRect();
  const left = Math.min(e.clientX - w.left, w.width - m.offsetWidth - 8), top = Math.min(e.clientY - w.top, w.height - m.offsetHeight - 8);
  m.style.left = Math.max(8, left) + 'px'; m.style.top = Math.max(44, top) + 'px';
  // keyboard users get the first item with Down; the menu itself takes focus so Esc works
  m.tabIndex = -1; m.focus();
}
function closeIdeMenu() { $('#ideMenu').hidden = true; }
function ideMenuAction(act) {
  const ctx = IDE.menu; closeIdeMenu();
  if (!ctx) return;
  const r = projRoot(), fp = ctx.path || r, isDir = ctx.kind === 'tree' && (!ctx.path || ctx.dir);
  const s = ist();
  if (act === 'close') closeFile(fp);
  else if (act === 'closeothers') closeFiles(s.tabs.filter(k => k !== fp));
  else if (act === 'closeright') closeFiles(s.tabs.slice(s.tabs.indexOf(fp) + 1));
  else if (act === 'closesaved') closeFiles(s.tabs.filter(k => !isDirty(k)));
  else if (act === 'closeall') closeFiles([...s.tabs]);
  else if (act === 'revealtree') { if (!IDE.ui.ex) { IDE.ui.ex = true; saveIdeUi(); } revealInTree(fp); }
  else if (act === 'copy') copyText(fp, 'Yol kopyalandı');
  else if (act === 'copyrel') copyText(relOf(fp), 'Göreli yol kopyalandı');
  else if (act === 'reveal') api.invoke('fs:reveal', fp).catch(e => toast('Açılamadı', cleanErr(e)));
  else if (act === 'newfile' || act === 'newdir') newEntry(isDir ? fp : dirOf(fp), act === 'newdir');
  else if (act === 'rename') renameEntry(fp, isDir);
  else if (act === 'delete') deleteEntry(fp, isDir);
  else if (act === 'collapse') { IDE.expanded = {}; renderTree(); }
  else if (act === 'refresh') { IDE.dirCache = {}; delete IDE.index[IDE.project]; renderTree(); refreshGit(); }
  else if (act === 'ask') askClaude(fp, isDir);
}
/* shortcuts that belong to the IDE: only in IDE mode and not while typing in a terminal */
const ideKeysOk = e => S.mode === 'ide' && !(e.target.closest && e.target.closest('.xterm')) && $('#settings').hidden && $('#report').hidden && $('#discover').hidden;

function bindIde() {
  api.on('ide:fs-changed', onFsChanged);
  // drag the panel edge: height when docked at the bottom, width when docked right
  const grip = $('#bpGrip');
  grip.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const right = IDE.ui.dock === 'right', bp = $('#bpanel'), view = $('#ideView');
    const start = right ? e.clientX : e.clientY, from = right ? bp.offsetWidth : bp.offsetHeight;
    const max = right ? view.clientWidth - 320 : $('.editor').clientHeight - 120;
    grip.setPointerCapture(e.pointerId); grip.classList.add('drag'); view.classList.add('dragging');
    const move = ev => {
      const v = Math.round(Math.max(right ? 260 : 120, Math.min(max, from + start - (right ? ev.clientX : ev.clientY))));
      if (right) { IDE.ui.pw = v; view.style.setProperty('--pw', v + 'px'); } else { IDE.ui.ph = v; bp.style.setProperty('--ph', v + 'px'); }
    };
    const up = () => {
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
      grip.classList.remove('drag'); view.classList.remove('dragging');
      saveIdeUi();
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('dblclick', () => { if (IDE.ui.dock === 'right') IDE.ui.pw = 440; else IDE.ui.ph = 260; saveIdeUi(); });
  $('#refreshTree').onclick = () => { IDE.dirCache = {}; delete IDE.index[IDE.project]; renderTree(); refreshGit(); };
  $('#exNewFile').onclick = () => newEntry(projRoot(), false);
  $('#exNewDir').onclick = () => newEntry(projRoot(), true);
  $('#exCollapse').onclick = () => { IDE.expanded = {}; renderTree(); };
  $$('[data-exview]').forEach(b => b.addEventListener('click', () => setExView(b.dataset.exview)));
  // tree: right click, F2, Delete, arrow keys
  $('#tree').addEventListener('contextmenu', e => {
    const b = e.target.closest('.fx');
    openIdeMenu(e, b ? { kind: 'tree', path: b.dataset.file || b.dataset.dir, dir: !!b.dataset.dir } : { kind: 'tree', path: null, dir: true });
  });
  $('#tree').addEventListener('keydown', e => {
    const b = e.target.closest('.fx'); if (!b) return;
    const p = b.dataset.file || b.dataset.dir, isDir = !!b.dataset.dir;
    const move = d => { const all = $$('#tree .fx'); const n = all[all.indexOf(b) + d]; if (n) n.focus(); };
    if (e.key === 'F2') { e.preventDefault(); renameEntry(p, isDir); }
    else if (e.key === 'Delete') { e.preventDefault(); deleteEntry(p, isDir); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'ArrowRight' && isDir) { e.preventDefault(); if (!IDE.expanded[p]) { IDE.expanded[p] = true; renderTree(); } else move(1); }
    else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (isDir && IDE.expanded[p]) { IDE.expanded[p] = false; renderTree(); }
      else { const parent = $$('#tree .fx.dir').find(x => x.dataset.dir === dirOf(p)); if (parent) parent.focus(); }
    }
  });
  // editor tabs: middle click closes, right click opens the tab menu
  // middle click closes a terminal tab, like a browser
  for (const id of ['#tabs', '#ptabs']) {
    $(id).addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); }); // no autoscroll cursor
    $(id).addEventListener('auxclick', e => {
      const b = e.target.closest('[data-tab]');
      if (b && e.button === 1) { e.preventDefault(); closeTab(b.dataset.tab); }
    });
  }
  $('#etabs').addEventListener('auxclick', e => { const t = e.target.closest('[data-etab]'); if (t && e.button === 1) { e.preventDefault(); closeFile(t.dataset.etab); } });
  $('#etabs').addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); }); // no autoscroll cursor
  $('#etabs').addEventListener('contextmenu', e => { const t = e.target.closest('[data-etab]'); if (t) openIdeMenu(e, { kind: 'tab', path: t.dataset.etab }); });
  $('#etabs').addEventListener('wheel', e => { if (e.deltaY && !e.deltaX) { $('#etabs').scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  $('#ideMenu').addEventListener('click', e => { const b = e.target.closest('[data-ixm]'); if (b) ideMenuAction(b.dataset.ixm); });
  $('#ideMenu').addEventListener('keydown', e => {
    const all = $$('#ideMenu button'), i = all.indexOf(document.activeElement); // -1 while the menu itself has focus
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = i < 0 ? all[e.key === 'ArrowDown' ? 0 : all.length - 1] : all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]; if (n) n.focus(); }
    else if (e.key === 'Escape') { e.stopPropagation(); closeIdeMenu(); }
  });
  document.addEventListener('mousedown', e => { if (!$('#ideMenu').hidden && !e.target.closest('#ideMenu')) closeIdeMenu(); }, true);
  window.addEventListener('blur', closeIdeMenu);
  // disk bar, status strip
  $('#diskBar').addEventListener('click', async e => {
    const b = e.target.closest('[data-ixdisk]'); if (!b) return;
    const fp = ist().file, f = IDE.files[fp]; if (!f) return;
    const a = b.dataset.ixdisk;
    if (a === 'load') await reloadFromDisk(fp, true);
    else if (a === 'keep') { f.conflict = false; renderEdChrome(); }
    else if (a === 'save') { if (await saveFile(fp)) { IDE.dirCache = {}; renderTree(); } }
    else if (a === 'close') closeFile(fp);
  });
  $('#edStatus').addEventListener('click', e => {
    const b = e.target.closest('[data-ixes]'); if (!b) return;
    const a = b.dataset.ixes, f = IDE.files[ist().file];
    if (a === 'goto') openPalette(':');
    else if (a === 'wrap') toggleWrap();
    else if (a === 'eol' && f && f.doc) { f.eol = f.eol === '\r\n' ? '\n' : '\r\n'; renderEdChrome(); }
  });
  // project search
  $('#psIn').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); IDE.search.q = ''; runSearch(); }
    else if (e.key === 'Escape') { e.stopPropagation(); if (!IDE.cm.getWrapperElement().hidden) IDE.cm.focus(); }
  });
  $('#psIn').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { if ($('#psIn').value.trim().length >= 2 || !$('#psIn').value.trim()) runSearch(); }, 450); });
  $$('[data-psopt]').forEach(b => b.addEventListener('click', () => { const k = b.dataset.psopt; IDE.search[k] = !IDE.search[k]; IDE.search.q = ''; renderSearch(); runSearch(); }));
  $('#psRes').addEventListener('click', e => {
    const f = e.target.closest('[data-psfile]');
    if (f) { const k = f.dataset.psfile; if (IDE.search.closed.has(k)) IDE.search.closed.delete(k); else IDE.search.closed.add(k); renderSearch(); return; }
    const h = e.target.closest('[data-pshit]'); if (!h) return;
    const res = IDE.search.res, hit = res && res.hits[+h.dataset.pshit]; if (!hit) return;
    $$('#psRes .ps-h.on').forEach(x => x.classList.remove('on')); h.classList.add('on');
    openFile(joinP(res.root, hit.file), { line: hit.line, col: hit.col, len: hit.len });
  });
  // quick open / prompt
  $('#qoIn').addEventListener('input', () => { QO.sel = 0; renderPalette(); });
  $('#qoIn').addEventListener('keydown', e => {
    const n = QO.items.length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); QO.sel = (QO.sel + 1) % n; renderPalette(); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); QO.sel = (QO.sel - 1 + n) % n; renderPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); pickPalette(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); }
  });
  $('#qoList').addEventListener('click', e => { const b = e.target.closest('[data-qoi]'); if (b) pickPalette(+b.dataset.qoi); });
  $('#qoBg').addEventListener('mousedown', e => { if (e.target.id === 'qoBg') closePalette(); });
  // find in file: Enter next, Shift+Enter previous
  $('#findIn').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); findNext(e.target.value, e.shiftKey); }
    if (e.key === 'Escape') { $('#findN').textContent = ''; if (!IDE.cm.getWrapperElement().hidden) IDE.cm.focus(); }
  });
  $('#findIn').addEventListener('input', () => { $('#findN').textContent = ''; });
}

/* ---------------- mode ---------------- */
function setMode(m, initial) {
  S.mode = m;
  $$('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  $('#claudeView').hidden = m !== 'claude';
  $('#ideView').hidden = m !== 'ide';
  $('#dbView').hidden = m !== 'db';
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
  // DB mode lives in db.js; it exposes window.dbMode = { show, hide }
  if (window.dbMode) { if (m === 'db') window.dbMode.show(); else window.dbMode.hide(); }
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
  m.innerHTML = `<button data-newkind="claude" data-pid="${pid}"><span class="mi"><i class="mic fa-solid fa-terminal"></i>Claude oturumu</span><code class="ell" title="${esc(claudeSummary())}">${esc(claudeSummary())}</code></button>`
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
    <div class="rep-note">Dolar tutarları API liste fiyatıyla karşılıktır; abonelikte ayrıca ödenmez. Claude Code oturum kayıtlarını yaklaşık 30 gün sonra siler. VoxStorm günlük toplamları kendi dosyasına da kaydeder; böylece geçmiş aylar uygulama kullanıldıkça birikir. Elindeki en eski kayıt: <b>${firstAvail ? monthLabel(firstAvail) : '–'}</b>.</div>`;
}

/* ---------------- settings ---------------- */
let setTab = 'hitap';
const TONES = { samimi: 'Samimi', resmi: 'Resmi', kisa: 'Kısa ve öz' };
const LANGS = { tr: 'Türkçe', en: 'İngilizce' };
const NOTIF_LABELS = { done: 'İş bittiğinde', decision: 'Kararını beklediğinde (izin, plan, soru)', subagent: 'Alt ajan açılınca / bitince', workflow: 'Workflow açılınca / bitince', quiet: 'Rahatsız etme (hepsini sustur)' };
const sw = (attr, on, label) => `<button class="sw" role="switch" aria-checked="${!!on}" aria-label="${esc(label)}" ${attr}></button>`;
/* ---------------- updates ---------------- */
let UPD = null;
const UPD_KIND = { nsis: 'Kurulum (Setup)', portable: 'Taşınabilir (Portable)', asar: 'Klasör (win-unpacked)', dev: 'Geliştirme modu' };
function updateHTML() {
  const u = UPD || { status: 'idle', current: '', kind: '' };
  const up = Object.assign({ check: true, auto: true }, CFG.settings.update || {});
  const pct = Math.round((u.progress || 0) * 100);
  const ago = ms => (rel(ms) === 'şimdi' ? 'az önce' : rel(ms) + ' önce');
  const line = {
    idle: u.reason ? esc(u.reason) : 'Henüz denetlenmedi.',
    checking: '<i class="fa-solid fa-circle-notch fa-spin"></i> Denetleniyor…',
    none: `<i class="fa-solid fa-circle-check" style="color:var(--ok)"></i> Güncel${u.checkedAt ? ` · son denetim ${ago(u.checkedAt)}` : ''}`,
    available: `<b>${esc(u.latest)}</b> sürümü var.`,
    downloading: `<b>${esc(u.latest)}</b> indiriliyor… %${pct}<span class="upd-bar"><i style="width:${pct}%"></i></span>`,
    ready: `<b>${esc(u.latest)}</b> indirildi ve doğrulandı. Yeniden başlatınca kurulur${up.auto ? '; çıkışta da kendiliğinden kurulur' : ''}.`,
    manual: `<b>${esc(u.latest)}</b> sürümü var. ${esc(u.reason)}`,
    error: `<i class="fa-solid fa-triangle-exclamation" style="color:var(--warn)"></i> ${esc(u.error)}`,
  }[u.status] || '';
  const btns = [];
  if (u.status === 'ready') btns.push('<button class="btn primary" data-updgo><i class="fa-solid fa-rotate"></i> Yeniden başlat ve güncelle</button>');
  if (u.status === 'available') btns.push('<button class="btn primary" data-upddl><i class="fa-solid fa-download"></i> İndir</button>');
  if (['manual', 'available', 'ready'].includes(u.status) && u.url) btns.push('<button class="btn" data-updpage><i class="fa-brands fa-github"></i> Sürüm sayfası</button>');
  if (u.kind && u.kind !== 'dev' && u.status !== 'checking' && u.status !== 'downloading') btns.push('<button class="btn" data-updcheck><i class="fa-solid fa-arrows-rotate"></i> Güncellemeleri denetle</button>');
  return `<h4>Sürüm</h4>
    <div class="upd"><div class="upd-top"><b>VoxStorm ${esc(u.current)}</b><span>${esc(UPD_KIND[u.kind] || '')}</span></div>
      <div class="upd-line">${line}</div>${btns.length ? `<div class="upd-btns">${btns.join('')}</div>` : ''}
      ${u.notes && u.status !== 'none' ? `<details class="upd-notes"><summary>${esc(u.latest)} sürümündeki yenilikler</summary><pre>${esc(u.notes)}</pre></details>` : ''}</div>
    <div class="set-row"><span>Güncellemeleri kendiliğinden denetle<small>Açılışta ve 6 saatte bir GitHub'daki sürümlere bakar</small></span>${sw('data-upd="check"', up.check, 'Güncellemeleri denetle')}</div>
    <div class="set-row"><span>Kendiliğinden indir ve çıkışta kur<small>Kapalıysa yalnızca haber verir</small></span>${sw('data-upd="auto"', up.auto, 'Kendiliğinden indir')}</div>`;
}
function renderUpdBtn() {
  const b = $('#updBtn'); if (!b || !UPD) return;
  b.hidden = !['ready', 'available', 'manual', 'downloading'].includes(UPD.status);
  b.classList.toggle('ready', UPD.status === 'ready');
  b.title = UPD.status === 'ready' ? `VoxStorm ${UPD.latest} hazır: yeniden başlatınca kurulur`
    : UPD.status === 'downloading' ? `VoxStorm ${UPD.latest} indiriliyor (%${Math.round(UPD.progress * 100)})` : `VoxStorm ${UPD.latest} çıktı`;
}
async function updateAction(d) {
  if (d.upd) { setCfg({ settings: { update: { [d.upd]: !Object.assign({ check: true, auto: true }, CFG.settings.update || {})[d.upd] } } }).then(renderSettings); return; }
  if (d.updcheck !== undefined) { UPD = await api.invoke('update:check'); }
  else if (d.upddl !== undefined) { api.invoke('update:download'); return; }
  else if (d.updpage !== undefined) { if (UPD && UPD.url) api.invoke('shell:openGithub', UPD.url); return; }
  else if (d.updgo !== undefined) {
    const open = S.tabs.filter(t => !t.exited && t.kind !== 'watch').length;
    if (open && !(await uiConfirm({ title: 'Güncellensin mi?', message: `${open} terminal kapanacak.`, detail: 'Claude oturumları yeni sürüm açılınca geri yüklenir.', ok: 'Yeniden başlat ve güncelle', icon: 'fa-rotate' }))) return;
    if (!(await api.invoke('update:restart'))) toast('Güncelleme başlatılamadı');
    return;
  }
  renderUpdBtn(); renderSettings();
}
api.on('update:state', st => { UPD = st; renderUpdBtn(); if (!$('#settings').hidden && setTab === 'hakkinda') renderSettings(); });

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
      <p class="set-note">Bu metin VoxStorm'tan başlatılan Claude oturumlarına eklenir. CLAUDE.md dosyalarına dokunulmaz. Değişiklik yeni açılan oturumlarda geçerli olur.</p>`;
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
      <div class="set-row"><span>Oturumlar Remote Control açık başlasın<small>Oturumu claude.ai veya telefondaki Claude uygulamasından da sürdürebilirsin. Oturum adı: “proje · VoxStorm”.</small></span>${sw('data-cset="remoteControl"', c.remoteControl, 'Remote Control')}</div>
      <p class="set-note">Bu ayarlar VoxStorm'tan yeni açılan ve devam ettirilen oturumlara uygulanır; açık oturumlar etkilenmez. Boş bırakılanlarda Claude Code kendi ayarını kullanır. Tek bir oturum için izin modunu “+ Oturum ▾” menüsünden de seçebilirsin.</p>
      <h4>Oturum geçmişi ne kadar saklansın?</h4>
      <div class="seg">${[30, 90, 180, 365].map(n => `<button class="${(CLEANUP || 30) === n ? 'on' : ''}" data-cleanup="${n}">${n} gün${n === 30 ? ' (varsayılan)' : ''}</button>`).join('')}</div>
      ${CLEANUP && ![30, 90, 180, 365].includes(CLEANUP) ? `<p class="set-note">Şu anki değer: ${CLEANUP} gün.</p>` : ''}
      <p class="set-note">Claude Code, bu süreden eski oturum kayıtlarını siler; silinen oturumlar geçmişte ve proje listesinde görünmez. Bu, <code>~/.claude/settings.json</code> içindeki <code>cleanupPeriodDays</code> ayarıdır; VoxStorm dışında açtığın oturumlar için de geçerlidir. Daha önce silinenleri geri getirmez.</p>`;
  } else if (setTab === 'tema') {
    const tc = st.termColors || 'windows';
    h = '<h4>Tema</h4>' + skinOptions()
      + `<h4>Terminal yazı renkleri</h4><div class="seg"><button class="${tc === 'windows' ? 'on' : ''}" data-termcolors="windows">Windows Terminal</button><button class="${tc === 'theme' ? 'on' : ''}" data-termcolors="theme">Temaya uyumlu</button></div><p class="set-note">Windows Terminal: Claude Code normal Windows terminalindeki renklerle görünür (beyaz yazı, mavi bağlantılar).</p>`;
  } else if (setTab === 'bildirim') {
    h = '<h4>Hangi durumlarda Windows bildirimi gelsin?</h4>' + Object.keys(NOTIF_LABELS).map(k => `<div class="set-row"><span>${NOTIF_LABELS[k]}</span>${sw(`data-notif="${k}"`, st.notif[k], NOTIF_LABELS[k])}</div>`).join('')
      + (() => { const cur = !st.sound ? 'off' : (st.soundStyle || 'claudelot'); return `<h4>Bildirim sesi</h4><div class="seg">${[['claudelot', 'VoxStorm sesi'], ['windows', 'Windows sesi'], ['off', 'Sessiz']].map(([k, l]) => `<button class="${cur === k ? 'on' : ''}" data-soundstyle="${k}">${l}</button>`).join('')}</div>`
        + (cur === 'claudelot' ? `<div class="chips" style="margin-top:8px"><button class="chip-btn" data-chime="done"><i class="fa-solid fa-play"></i> İş bitti</button><button class="chip-btn" data-chime="decision"><i class="fa-solid fa-play"></i> Karar bekliyor</button><button class="chip-btn" data-chime="subagent"><i class="fa-solid fa-play"></i> Ajan / workflow</button></div>` : ''); })()
      + '<p class="set-note">O an baktığın terminal için bildirim gösterilmez.</p>';
  } else if (setTab === 'pencere') {
    h = '<h4>Pencere</h4>'
      + `<div class="set-row"><span>Kapat düğmesi tepsiye küçültsün<small>Kapalıysa × düğmesi çıkış onayı sorar</small></span>${sw('data-set="closeToTray"', st.closeToTray, 'Tepsiye küçült')}</div>`
      + `<div class="set-row"><span>Açılışta karşılama ekranını göster<small>Proje seçme ve arama penceresi</small></span>${sw('data-set="welcome"', st.welcome !== false, 'Karşılama ekranı')}</div>`
      + `<div class="set-row"><span>Windows açılınca başlat<small>Doğrudan sistem tepsisine başlar</small></span>${sw('data-set="autostart"', st.autostart, 'Windows ile başlat')}</div>`
      + '<p class="set-note">Uygulamadan tamamen çıkmak için: sistem tepsisindeki simgeye sağ tıkla → Çık.</p>';
  } else {
    h = setTab === 'kisayol' ? kisayolHTML() : updateHTML() + `<h4>Bağlantı</h4><div class="kv">
      <span>Claude Code</span><span>${INFO.claude ? `<code>${esc(INFO.claude)}</code>` : '<b style="color:var(--warn)">Bulunamadı.</b> Claude Code kurulu ve PATH içinde olmalı.'}</span>
      <span>Bildirim portu</span><span><code>127.0.0.1:${INFO.hookPort}</code></span>
      <span>Hook ayarları</span><span><code>${esc(INFO.hookSettings)}</code></span>
      <span>Ek talimat dosyası</span><span><code>${esc(INFO.appendPrompt)}</code></span></div>
      <p class="set-note">VoxStorm, başlattığı her Claude oturumuna kendi hook ayarlarını <code>--settings</code> ile verir. Senin <code>~/.claude/settings.json</code> dosyan değiştirilmez. Uygulama dışında açılan oturumlar burada görünmez ama geçmişleri listelenir.</p>`;
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
function closeMenus() { $('#newMenu').hidden = true; $('#skinMenu').hidden = true; $('#pop').hidden = true; closeIdeMenu(); }
function bindEvents() {
  document.addEventListener('click', async e => {
    const el = e.target.closest('button,[data-tab],tr[data-month]');
    if (!e.target.closest('#newMenu,[data-newmenu],[data-projmenu]')) $('#newMenu').hidden = true;
    if (!$('#startPanel').hidden && !e.target.closest('#startPanel,#startBtn,#newMenu,[data-startnew]')) closeStartPanel();
    if (e.target.closest('#newMenu [data-newkind],#newMenu [data-resume],#newMenu [data-pact]')) closeStartPanel();
    if (!e.target.closest('#skinMenu,#skinBtn')) $('#skinMenu').hidden = true;
    if (!e.target.closest('#pop,#bellBtn')) $('#pop').hidden = true;
    if (e.target.id === 'settings') { $('#settings').hidden = true; return; }
    if (e.target.id === 'discover') { $('#discover').hidden = true; return; }
    if (e.target.id === 'report') { $('#report').hidden = true; return; }
    if (!el) return;
    const d = el.dataset;
    if (d.gsync) { runSync(d.gsync, d.act); return; }
    if (d.gitopen) { openGitFor(d.gitopen); return; }
    if (d.startnew) { if (!panelUi().side) { await setCfg({ settings: { ui: { side: true } } }); applyPanels(); } openStartPanel(); }
    else if (d.panel) togglePanel(d.panel);
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
      else if (d.pact === 'remove' && await uiConfirm({ title: 'Proje kaldırılsın mı?', message: `"${p.name}" listeden kaldırılsın mı?`, detail: 'Klasör ve oturum geçmişi silinmez.', ok: 'Kaldır', danger: true })) {
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
  // Ctrl+V in a terminal with files copied in Explorer: paste their paths (like Windows Terminal)
  document.addEventListener('paste', async e => {
    if (!e.target.closest || !e.target.closest('.xterm')) return;
    const dt = e.clipboardData;
    if (dt && dt.getData('text/plain')) return; // normal text: xterm handles it
    const t = S.tabs.find(x => x.el && x.el.contains(e.target));
    if (!t || !t.term) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const files = await api.invoke('clipboard:files').catch(() => []);
    if (files.length) t.term.paste(files.map(f => (/\s/.test(f) ? `"${f}"` : f)).join(' '));
  }, true);
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-ceffort],[data-cpm],[data-cset],[data-cleanup],[data-upd],[data-updcheck],[data-upddl],[data-updgo],[data-updpage]'); if (!b) return;
    if (b.closest('#setBody') && ('upd' in b.dataset || 'updcheck' in b.dataset || 'upddl' in b.dataset || 'updgo' in b.dataset || 'updpage' in b.dataset)) { updateAction(b.dataset); return; }
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
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeMenus(); $('#settings').hidden = true; $('#discover').hidden = true; $('#report').hidden = true; }
  });
  // capture phase: app shortcuts win over the terminal and the code editor
  window.addEventListener('keydown', e => {
    const combo = comboOf(e);
    const sc = SHORTCUTS.find(s => s.run && s.keys === combo && (!s.ide || ideKeysOk(e)));
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
  $('#updBtn').onclick = () => openSettings('hakkinda');
  api.invoke('update:state').then(st => { UPD = st; renderUpdBtn(); }).catch(() => {});
  api.on('address-learned', n => toast('Hitap güncellendi', n ? `Bundan sonra “${n}” diye hitap edilecek.` : 'Bundan sonra hitap kullanılmayacak.'));
  window.addEventListener('beforeunload', e => {
    if (Object.keys(IDE.files).some(isDirty)) { e.returnValue = false; }
  });
}
function toolbar(a) {
  const cm = IDE.cm;
  const f = IDE.files[ist().file], text = !!(f && f.doc);
  if (a === 'new') newEntry(projRoot(), false);
  else if (a === 'quick') openPalette('');
  else if (a === 'psearch') openProjectSearch();
  else if (a === 'save') saveFile();
  else if (a === 'saveall') {
    const list = ist().tabs.filter(isDirty);
    Promise.all(list.map(fp => saveFile(fp))).then(r => { const n = r.filter(Boolean).length; if (n) toast('Kaydedildi', n + ' dosya'); });
  }
  else if (a === 'undo') { if (text) { cm.undo(); cm.focus(); } }
  else if (a === 'redo') { if (text) { cm.redo(); cm.focus(); } }
  else if (a === 'smaller') { IDE.ui.size = Math.max(10, IDE.ui.size - 1); saveIdeUi(); }
  else if (a === 'bigger') { IDE.ui.size = Math.min(22, IDE.ui.size + 1); saveIdeUi(); }
  else if (a === 'ex') { IDE.ui.ex = !IDE.ui.ex; saveIdeUi(); }
  else if (a === 'panel') { IDE.ui.panel = !IDE.ui.panel; saveIdeUi(); }
  else if (a === 'dock') { IDE.ui.dock = IDE.ui.dock === 'right' ? 'bottom' : 'right'; IDE.ui.panel = true; saveIdeUi(); }
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
  { group: 'Genel', keys: 'Ctrl+1', label: 'AI modu (Claude oturumları)', run: () => setMode('claude') },
  { group: 'Genel', keys: 'Ctrl+2', label: 'IDE modu', run: () => setMode('ide') },
  { group: 'Genel', keys: 'Ctrl+3', label: 'Veritabanı (DB) modu', run: () => setMode('db') },
  { group: 'Genel', keys: 'Ctrl+Shift+P', label: 'Proje Başlat paneli', run: () => { if (!panelUi().side) togglePanel('side'); openStartPanel(); } },
  { group: 'Genel', keys: 'Ctrl+Shift+O', label: 'Karşılama ekranı', run: () => api.send('app:welcome') },
  { group: 'Genel', keys: 'Ctrl+,', label: 'Ayarlar', run: () => openSettings() },
  { group: 'Genel', keys: 'Ctrl+Shift+R', label: 'Aylık kullanım raporu', run: () => openReport() },
  { group: 'Genel', keys: 'Ctrl+Shift+G', label: 'Git / GitHub paneli', run: () => toggleGitPanel() },
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
  { group: 'IDE', keys: 'Ctrl+P', label: 'Dosyaya git (hızlı aç)', ide: true, run: () => openPalette('') },
  { group: 'IDE', keys: 'Ctrl+Shift+F', label: 'Projede ara', ide: true, run: () => openProjectSearch() },
  { group: 'IDE', keys: 'Ctrl+G', label: 'Satıra git', ide: true, run: () => openPalette(':') },
  { group: 'IDE', keys: 'Ctrl+W', label: 'Açık dosyayı kapat', ide: true, run: () => { const fp = ist().file; if (fp) closeFile(fp); } },
  { group: 'IDE', keys: 'Alt+Z', label: 'Satır sarmayı aç / kapat', ide: true, run: () => toggleWrap() },
  { group: 'IDE', keys: 'Ctrl+S', label: 'Dosyayı kaydet' },
  { group: 'IDE', keys: 'Ctrl+F', label: 'Dosyada ara (Enter: sonraki, Shift+Enter: önceki)' },
  { group: 'IDE', keys: 'Ctrl+Z / Ctrl+Y', label: 'Geri al / yinele' },
  { group: 'IDE', keys: 'F2', label: 'Gezginde seçili öğeyi yeniden adlandır' },
  { group: 'IDE', keys: 'Delete', label: 'Gezginde seçili öğeyi Geri Dönüşüm Kutusu’na taşı' },
];

function kisayolHTML() {
  const groups = [...new Set(SHORTCUTS.map(s => s.group))];
  return groups.map(g => `<h4>${g}</h4><table class="kbd-t">${SHORTCUTS.filter(s => s.group === g).map(s => `<tr><td>${s.label}</td><td class="n">${s.keys.split(' / ').map(k => k.split('+').map(x => `<kbd>${x}</kbd>`).join('+')).join(' / ')}</td></tr>`).join('')}</table>`).join('')
    + '<p class="set-note">Uygulama kısayolları terminal ve kod düzenleyici açıkken de çalışır. Claude Code\'un kendi kısayolları (Ctrl+B, Ctrl+R, Shift+Tab vb.) terminale gitmeye devam eder.</p>';
}

/* ---------------- git / GitHub ----------------
   Title-bar button → drop-down panel (GitHub | Git tabs, project picker, last commits)
   → "Detaylar" window (changes, history, stash, diffs). Read-only. */
const GIT = { tab: 'git', pid: null, ov: null, gh: null, err: '', loading: false, token: 0, drop: { sel: 0, view: [] }, head: {}, newRepo: {}, btnTimer: null, btnAt: 0, btnPid: null };
const GW = { pid: null, view: 'history', ov: null, commits: [], more: true, sel: null, ltok: 0, dtok: 0 };
const gitProj = () => proj(GIT.pid);
const me = c => { const id = (CFG && CFG.identity) || {}; return !!((id.email && c.email && c.email.toLowerCase() === id.email.toLowerCase()) || (id.name && c.author === id.name)); };
const initials = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toLocaleUpperCase('tr') || '?';
const isoMs = s => (s ? Date.parse(s) : 0);
function avatarHTML(c) {
  if (c.claude) return `<span class="av claude" title="Claude ile yapıldı (${esc(c.author)})"><i class="fa-solid fa-robot"></i></span>`;
  return `<span class="av ${me(c) ? 'me' : ''}" title="${esc(c.author)} &lt;${esc(c.email)}&gt;">${esc(initials(c.author))}</span>`;
}
const whoText = c => (c.claude ? 'Claude' : me(c) ? 'Sen' : c.author);
function pushIcon(c) {
  if (c.pushed === true) return '<i class="pst on fa-solid fa-cloud" title="Push edildi"></i>';
  if (c.pushed === false) return '<i class="pst off fa-solid fa-arrow-up-from-bracket" title="Henüz push edilmedi"></i>';
  return '<i class="pst na fa-solid fa-cloud" title="Bu dalın uzak karşılığı (upstream) yok"></i>';
}

/* ---- title-bar button: branch + unpushed count of the project in front ---- */
function scheduleGitBtn(now) {
  clearTimeout(GIT.btnTimer);
  const pid = projectHere();
  const wait = now || pid !== GIT.btnPid ? 120 : Math.max(800, 5000 - (Date.now() - GIT.btnAt));
  GIT.btnTimer = setTimeout(updateGitBtn, wait);
}
async function updateGitBtn() {
  const pid = projectHere(), p = proj(pid);
  GIT.btnPid = pid; GIT.btnAt = Date.now();
  let h = { repo: false };
  if (p) { try { h = await api.invoke('git:head', p.path); } catch (_) {} }
  if (pid !== projectHere()) return;
  GIT.head[pid] = h;
  $('#gitBtnLabel').textContent = h.repo ? (h.detached ? 'detached' : h.branch) : 'Git';
  $('#gitBtnN').hidden = !(h.repo && h.ahead);
  $('#gitBtnN').textContent = '↑' + (h.ahead || 0);
  $('#gitBtn').title = p ? `${p.name}${h.repo ? ` · ${h.branch}${h.ahead ? ` · ${h.ahead} commit push edilmedi` : ''}${h.dirty ? ` · ${h.dirty} değişiklik` : ''}` : ' · git deposu değil'}\nGit ve GitHub (Ctrl+Shift+G)` : 'Git ve GitHub (Ctrl+Shift+G)';
}

/* ---- panel ---- */
function openGitPanel() {
  closeMenus(); closeStartPanel();
  GIT.pid = projectHere();
  $('#gitPanel').hidden = false;
  $('#gitBtn').setAttribute('aria-expanded', 'true');
  renderGitPanel();
  loadGit();
}
function closeGitPanel() {
  $('#gitPanel').hidden = true; closeGitDrop();
  $('#gitBtn').setAttribute('aria-expanded', 'false');
}
const toggleGitPanel = () => ($('#gitPanel').hidden ? openGitPanel() : closeGitPanel());
function setGitTab(t) {
  GIT.tab = t;
  setCfg({ settings: { gitTab: t } });
  renderGitPanel();
  loadGit();
}
async function loadGit(force) {
  const p = gitProj(); if (!p) { renderGitBody(); return; }
  const tok = ++GIT.token, tab = GIT.tab;
  GIT.loading = true; GIT.err = '';
  if (tab === 'git' && (!GIT.ov || GIT.ov._pid !== p.id)) GIT.ov = null;
  if (tab === 'github' && (!GIT.gh || GIT.gh._pid !== p.id)) GIT.gh = null;
  renderGitBody();
  try {
    if (tab === 'git') { const ov = await api.invoke('git:overview', p.path); ov._pid = p.id; if (tok === GIT.token) GIT.ov = ov; }
    else { const gh = await api.invoke('github:info', p.path, !!force); gh._pid = p.id; if (tok === GIT.token) GIT.gh = gh; }
  } catch (e) { if (tok === GIT.token) GIT.err = cleanErr(e); }
  if (tok !== GIT.token) return;
  GIT.loading = false;
  renderGitBody();
  if (tab === 'git') scheduleGitBtn(true);
}
function renderGitPanel() {
  $$('#gitPanel [data-gtab]').forEach(b => { const on = b.dataset.gtab === GIT.tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  const p = gitProj();
  $('#gitProjName').textContent = p ? p.name : 'Proje seç';
  $('#gitProjPath').textContent = p ? p.path : (S.projects.length ? 'Listeden bir proje seç' : 'Henüz proje yok');
  renderGitBody();
}
function renderGitBody() {
  const p = gitProj(), b = $('#gitBody');
  if (!p) { b.innerHTML = '<div class="gp-note"><i class="fa-regular fa-folder-open"></i>Üstten bir proje seç.</div>'; return; }
  if (GIT.err) { b.innerHTML = `<div class="gp-note"><i class="fa-solid fa-triangle-exclamation"></i>${esc(GIT.err)}<br><button class="btn" data-gitreload>Tekrar dene</button></div>`; return; }
  const d = GIT.tab === 'git' ? GIT.ov : GIT.gh;
  if (!d) { b.innerHTML = '<div class="gp-note"><i class="fa-solid fa-circle-notch fa-spin"></i>Yükleniyor…</div>'; return; }
  b.innerHTML = GIT.tab === 'git' ? gitBodyHTML(d) : githubBodyHTML(d);
}
function branchLine(ov) {
  const n = ov.staged.length + ov.unstaged.length + ov.untracked.length + ov.conflicted.length;
  return `<div class="gp-branch"><i class="fa-solid fa-code-branch ic-mut"></i><b>${esc(ov.detached ? 'detached HEAD' : ov.branch)}</b>
    ${ov.upstream ? `<span class="gchip" title="Uzak dal">→ ${esc(ov.upstream)}</span>` : '<span class="gchip warn" title="Bu dal henüz bir uzak dala bağlı değil">upstream yok</span>'}
    ${ov.ahead ? `<span class="gchip warn" title="Push edilmemiş commit">↑ ${ov.ahead}</span>` : ''}
    ${ov.behind ? `<span class="gchip acc" title="Uzakta olup sende olmayan commit (son fetch'e göre)">↓ ${ov.behind}</span>` : ''}
    ${ov.conflicted.length ? `<span class="gchip bad">${ov.conflicted.length} çakışma</span>` : ''}
    ${n ? `<span class="gchip acc">${n} değişiklik</span>` : '<span class="gchip ok">temiz</span>'}
    ${ov.stashes.length ? `<span class="gchip">${ov.stashes.length} stash</span>` : ''}</div>`;
}
function gitBodyHTML(ov) {
  if (!ov.repo) return '<div class="gp-note"><i class="fa-brands fa-git-alt"></i>Bu proje bir git deposu değil.</div>';
  const rows = ov.commits.map(c => `<button class="gc" data-gitc="${c.hash}" title="${esc(c.subject)}&#10;${esc(c.author)} · ${new Date(c.at).toLocaleString('tr-TR')}">
      ${avatarHTML(c)}<span class="gc-tx"><b>${esc(c.subject)}</b><span>${esc(whoText(c))} · ${rel(c.at)} · <code>${c.short}</code></span></span>${pushIcon(c)}</button>`).join('');
  return branchLine(ov) +
    `<div class="gp-h">Son commitler <button class="ghost" data-gitreload title="Yenile"><i class="fa-solid fa-arrows-rotate"></i></button></div>` +
    (rows || '<div class="gp-note">Henüz commit yok.</div>') +
    `<button class="gp-detail-btn" data-gwopen="changes"><i class="fa-solid fa-up-right-from-square"></i>Detaylar <small>değişiklikler, stash, geçmiş</small></button>`;
}
function runIcon(r) {
  if (r.status !== 'completed') return '<i class="fa-solid fa-circle-notch fa-spin ic-run" title="Çalışıyor"></i>';
  if (r.conclusion === 'success') return '<i class="fa-solid fa-circle-check ic-ok" title="Başarılı"></i>';
  if (r.conclusion === 'failure' || r.conclusion === 'timed_out') return '<i class="fa-solid fa-circle-xmark ic-bad" title="Başarısız"></i>';
  return `<i class="fa-solid fa-ban ic-mut" title="${esc(r.conclusion || '')}"></i>`;
}
/* ---- no GitHub repo yet: create one with Claude, or on github.com and connect it here ---- */
const repoSlug = n => String(n || '').replace(/ı/g, 'i').replace(/İ/g, 'I').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'proje';
const newRepo = pid => GIT.newRepo[pid] || (GIT.newRepo[pid] = { name: repoSlug((proj(pid) || {}).name), vis: 'private', opened: false });
function newRepoHTML(g) {
  if (g.remote) return `<div class="gp-note"><i class="fa-brands fa-github"></i>Bu projenin uzak deposu GitHub'da değil.<br><code>${esc(g.remote)}</code></div>`;
  const r = newRepo(GIT.pid);
  return `<div class="nr">
    <div class="nr-h"><i class="fa-brands fa-github"></i><span>Bu projenin GitHub deposu yok.<small>Yeni bir depo oluşturup bu projeye bağlayabilirsin.</small></span></div>
    <label class="nr-l">Depo adı<input id="nrName" value="${esc(r.name)}" spellcheck="false" autocomplete="off"></label>
    <div class="nr-vis" role="radiogroup" aria-label="Görünürlük">
      <button class="${r.vis === 'private' ? 'on' : ''}" data-nrvis="private" role="radio" aria-checked="${r.vis === 'private'}"><i class="fa-solid fa-lock"></i>Özel</button>
      <button class="${r.vis === 'public' ? 'on' : ''}" data-nrvis="public" role="radio" aria-checked="${r.vis === 'public'}"><i class="fa-solid fa-globe"></i>Herkese açık</button>
    </div>
    <button class="nr-opt" data-nrclaude><i class="fa-solid fa-robot"></i><span><b>Claude ile GitHub'da oluştur</b><small>Yeni bir Claude oturumu git init, .gitignore, ilk commit, depo oluşturma ve push işlerini yapar.</small></span></button>
    <button class="nr-opt" data-nrweb><i class="fa-brands fa-github"></i><span><b>GitHub üzerinden oluştur</b><small>github.com/new bu bilgilerle açılır. Oluşturunca adresini aşağıya yapıştır.</small></span></button>
    <div class="nr-con ${r.opened ? 'hl' : ''}">
      <span>Depoyu oluşturduysan adresini yapıştır, bu projeye bağlayayım:</span>
      <div class="nr-row"><input id="nrUrl" placeholder="https://github.com/kullanici/${esc(r.name)}" spellcheck="false" autocomplete="off"><button class="btn primary" data-nrconnect>Bağla</button></div>
    </div>
  </div>`;
}
async function createWithClaude() {
  const p = gitProj(); if (!p) return;
  const r = newRepo(p.id);
  r.name = repoSlug(r.name);
  const prompt = `Bu projeyi GitHub'a yeni bir depo olarak yükle. Depo adı: "${r.name}", görünürlük: ${r.vis === 'private' ? 'özel (private)' : 'herkese açık (public)'}. `
    + `Adımlar: 1) Klasör git deposu değilse git init yap, dal adı main olsun. 2) Uygun bir .gitignore yoksa projeye göre oluştur; .env, anahtar ve parola gibi gizli dosyalar kesinlikle commit edilmesin. `
    + `3) Commit edilmemiş dosyalar varsa ilk commit'i at. 4) GitHub'da depoyu oluştur: gh CLI kurulu ve giriş yapılmışsa gh repo create kullan; değilse dur ve bana nasıl ilerleyeceğimizi sor. `
    + `5) Depoyu origin olarak ekle ve push et. Başlamadan önce yapacaklarını kısaca listele.`;
  closeGitPanel();
  const t = await openTerminal({ kind: 'claude', projectId: p.id, title: 'GitHub deposu oluştur' });
  if (!t) return;
  t.pendingPrompt = prompt;
  setTimeout(() => sendPendingPrompt(t), 12000); // in case the start event never arrives
}
// type the prompt once Claude Code is up (SessionStart hook), then press Enter
function sendPendingPrompt(t) {
  const text = t.pendingPrompt; if (!text) return;
  t.pendingPrompt = null;
  setTimeout(() => {
    if (t.exited) return;
    api.send('pty:write', t.id, text);
    setTimeout(() => { if (!t.exited) api.send('pty:write', t.id, '\r'); }, 400);
  }, 800);
}
function createOnWeb() {
  const p = gitProj(); if (!p) return;
  const r = newRepo(p.id);
  r.name = repoSlug(r.name);
  r.opened = true;
  api.invoke('shell:openGithub', `https://github.com/new?name=${encodeURIComponent(r.name)}&visibility=${r.vis}`);
  renderGitBody();
  const u = $('#nrUrl'); if (u) u.focus();
}
async function connectRepo() {
  const p = gitProj(), u = $('#nrUrl'); if (!p || !u) return;
  const url = u.value.trim();
  if (!url) { u.focus(); return; }
  const btn = $('[data-nrconnect]'); btn.disabled = true; btn.textContent = 'Bağlanıyor…';
  try {
    const r = await api.invoke('git:connect', p.path, url);
    toast(`${p.name} GitHub'a bağlandı`, (r.initialized ? 'Git deposu oluşturuldu. ' : '') + (r.pushed ? 'Commitler gönderildi.' : 'Henüz commit yok; ilk commit\'ten sonra Push ile gönderebilirsin.'));
    delete GIT.newRepo[p.id];
    GIT.gh = null; GIT.ov = null;
    loadGit(true);
    if (SYNC[p.id]) { SYNC[p.id].fetchedAt = 0; refreshSync(p.id); }
    scheduleGitBtn(true);
  } catch (e) {
    toast('Bağlanamadı', cleanErr(e));
    btn.disabled = false; btn.textContent = 'Bağla';
  }
}
function githubBodyHTML(g) {
  if (!g.github) return newRepoHTML(g);
  const open = `<button class="btn" data-ghurl="${esc(g.github.url)}"><i class="fa-brands fa-github"></i> GitHub'da aç</button>`;
  const foot = `<div class="gh-foot"><span>${g.via === 'gh' ? `<i class="fa-solid fa-key"></i> GitHub CLI${g.login ? ' · ' + esc(g.login) : ''}` : '<i class="fa-solid fa-globe"></i> Herkese açık API (özel depolar görünmez)'}</span><button class="ghost" data-gitreload="force"><i class="fa-solid fa-arrows-rotate"></i> Yenile</button></div>`;
  if (!g.repo) {
    const why = g.limited ? 'GitHub API sınırına ulaşıldı (saatte 60 istek). GitHub CLI (gh) ile giriş yaparsan sınır kalkar.'
      : g.repoStatus === 404 ? 'Depo bulunamadı ya da özel. Özel depoları görmek için GitHub CLI (gh) kurup <code>gh auth login</code> ile giriş yap.'
      : esc(g.repoError || 'GitHub\'a ulaşılamadı.');
    return `<div class="gp-note"><i class="fa-brands fa-github"></i><b>${esc(g.github.owner + '/' + g.github.repo)}</b><br>${why}<br>${open}</div>` + foot;
  }
  const r = g.repo;
  const list = (title, items, row, empty) => `<div class="gp-h">${title}</div>` + (items.length ? items.map(row).join('') : `<div class="gp-note" style="padding:6px">${empty}</div>`);
  return `<div class="gh-card">
      <button class="gh-link" data-ghurl="${esc(r.url)}">${r.private ? '<i class="fa-solid fa-lock ic-mut"></i> ' : ''}${esc(r.fullName)}</button>
      ${r.description ? `<p>${esc(r.description)}</p>` : '<p></p>'}
      <div class="gh-stats"><span><i class="fa-regular fa-star"></i>${r.stars}</span><span><i class="fa-solid fa-code-fork"></i>${r.forks}</span><span><i class="fa-solid fa-code-branch"></i>${esc(r.defaultBranch)}</span>${r.language ? `<span><i class="fa-solid fa-circle ic-acc" style="font-size:8px"></i>${esc(r.language)}</span>` : ''}${r.pushedAt ? `<span><i class="fa-regular fa-clock"></i>son push ${rel(isoMs(r.pushedAt))}</span>` : ''}</div>
    </div>` +
    list(`Açık pull request'ler${g.pulls.length ? ` (${g.pulls.length})` : ''}`, g.pulls, x => `<button class="gh-row" data-ghurl="${esc(x.url)}" title="${esc(x.title)}"><i class="fa-solid fa-code-pull-request ${x.draft ? 'ic-mut' : 'ic-ok'}"></i><span class="gc-tx"><b>${esc(x.title)}</b><span>#${x.n} · ${esc(x.user)}${x.branch ? ' · ' + esc(x.branch) : ''}${x.draft ? ' · taslak' : ''}</span></span><time>${rel(isoMs(x.at))}</time></button>`, 'Açık pull request yok.') +
    list('Açık issue\'lar', g.issues, x => `<button class="gh-row" data-ghurl="${esc(x.url)}" title="${esc(x.title)}"><i class="fa-regular fa-circle-dot ic-ok"></i><span class="gc-tx"><b>${esc(x.title)}</b><span>#${x.n} · ${esc(x.user)}${x.comments ? ` · ${x.comments} yorum` : ''}</span></span><time>${rel(isoMs(x.at))}</time></button>`, 'Açık issue yok.') +
    list('Actions', g.runs, x => `<button class="gh-row" data-ghurl="${esc(x.url)}" title="${esc(x.title)}">${runIcon(x)}<span class="gc-tx"><b>${esc(x.name)}</b><span>${esc(x.title)} · ${esc(x.branch || '')}</span></span><time>${rel(isoMs(x.at))}</time></button>`, 'Workflow çalışması yok.') +
    `<div style="margin-top:10px">${open}</div>` + foot;
}

/* ---- project picker ---- */
function openGitDrop() {
  $('#gitProjDrop').hidden = false; $('#gitProjBtn').setAttribute('aria-expanded', 'true');
  $('#gitProjQ').value = ''; GIT.drop.sel = Math.max(0, S.projects.findIndex(p => p.id === GIT.pid));
  renderGitDrop(true); $('#gitProjQ').focus();
}
function closeGitDrop() { $('#gitProjDrop').hidden = true; $('#gitProjBtn').setAttribute('aria-expanded', 'false'); }
function renderGitDrop(keepOrder) {
  const q = lowerTr($('#gitProjQ').value.trim());
  GIT.drop.view = S.projects.filter(p => !q || lowerTr(p.name).includes(q) || lowerTr(p.path).includes(q));
  if (!keepOrder) GIT.drop.sel = 0;
  GIT.drop.sel = Math.min(GIT.drop.sel, Math.max(0, GIT.drop.view.length - 1));
  $('#gitProjList').innerHTML = GIT.drop.view.length ? GIT.drop.view.map((p, i) => {
    const tabs = S.tabs.filter(t => t.projectId === p.id).length;
    return `<div class="sp-row ${i === GIT.drop.sel ? 'sel' : ''}" data-gitproj="${p.id}" role="option" aria-selected="${p.id === GIT.pid}" title="${esc(p.path)}">
      <div class="sp-info"><b>${esc(p.name)}${tabs ? ` <span class="sp-live">${tabs} açık</span>` : ''}</b><span>${esc(p.path)}</span></div>
      <span class="ck">${p.id === GIT.pid ? '<i class="fa-solid fa-check"></i>' : ''}</span></div>`;
  }).join('') : `<div class="sp-empty">“${esc($('#gitProjQ').value)}” ile eşleşen proje yok.</div>`;
  const el = $('#gitProjList .sp-row.sel'); if (el) el.scrollIntoView({ block: 'nearest' });
}
function pickGitProject(pid) {
  closeGitDrop();
  if (pid === GIT.pid) return;
  GIT.pid = pid; GIT.ov = null; GIT.gh = null;
  renderGitPanel(); loadGit();
}

/* ---- details window ---- */
async function openGitWin(view, hash) {
  const p = gitProj(); if (!p) return;
  const fresh = GW.pid !== p.id;
  Object.assign(GW, { pid: p.id, view: view || GW.view, sel: hash ? { type: 'commit', hash } : (fresh ? null : GW.sel) });
  if (fresh) { GW.commits = []; GW.more = true; GW.ov = GIT.ov && GIT.ov._pid === p.id ? GIT.ov : null; }
  closeGitPanel();
  $('#gitWin').hidden = false;
  renderGw();
  await reloadGw(!GW.ov || !fresh);
  if (GW.sel) showGwDetail();
}
async function reloadGw(withOverview) {
  const p = proj(GW.pid); if (!p) return;
  const tok = ++GW.ltok;
  try {
    const [ov, log] = await Promise.all([
      withOverview || !GW.ov ? api.invoke('git:overview', p.path) : Promise.resolve(GW.ov),
      api.invoke('git:log', p.path, 0, 60).catch(() => []),
    ]);
    if (tok !== GW.ltok) return;
    ov._pid = p.id; GW.ov = ov; GW.commits = log; GW.more = log.length === 60;
  } catch (e) { if (tok === GW.ltok) toast('Git okunamadı', cleanErr(e)); }
  renderGw();
}
async function moreGwHistory() {
  const p = proj(GW.pid); if (!p) return;
  const more = await api.invoke('git:log', p.path, GW.commits.length, 100).catch(() => []);
  GW.commits = GW.commits.concat(more); GW.more = more.length === 100;
  renderGwList();
}
function renderGw() {
  const p = proj(GW.pid), ov = GW.ov;
  $('#gwTitle').innerHTML = `<i class="fa-brands fa-git-alt" style="color:#f05133"></i>${esc(p ? p.name : '')}${ov && ov.repo ? ` <small><i class="fa-solid fa-code-branch"></i> ${esc(ov.branch)}</small>` : ''}`;
  const n = ov && ov.repo ? ov.staged.length + ov.unstaged.length + ov.untracked.length + ov.conflicted.length : 0;
  const tabs = [['changes', 'fa-solid fa-file-pen', 'Değişiklikler', n], ['history', 'fa-solid fa-clock-rotate-left', 'Geçmiş', ''], ['stash', 'fa-solid fa-box-archive', 'Stash', ov && ov.repo ? ov.stashes.length : '']];
  $('#gwNav').innerHTML = tabs.map(([k, ic, label, c]) => `<button class="set-tab ${GW.view === k ? 'on' : ''}" data-gwview="${k}"><i class="${ic}" style="width:18px"></i> ${label}${c !== '' ? `<span class="n">${c}</span>` : ''}</button>`).join('') +
    (ov && ov.repo ? `<div style="padding:12px 10px 0;font-size:11.5px;color:var(--muted);display:grid;gap:6px">${branchLine(ov).replace('gp-branch', 'gp-branch" style="flex-direction:column;align-items:flex-start')}</div>` : '');
  renderGwList();
  if (!GW.sel) $('#gwDetail').innerHTML = `<div class="gw-empty"><i class="fa-regular fa-hand-pointer"></i>Soldan bir ${GW.view === 'changes' ? 'dosya' : GW.view === 'stash' ? 'stash' : 'commit'} seç.</div>`;
}
const dayLabel = ms => new Date(ms).toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
function renderGwList() {
  const ov = GW.ov, el = $('#gwList');
  if (!ov) { el.innerHTML = '<div class="gw-empty"><i class="fa-solid fa-circle-notch fa-spin"></i>Yükleniyor…</div>'; return; }
  if (!ov.repo) { el.innerHTML = '<div class="gw-empty"><i class="fa-brands fa-git-alt"></i>Bu proje bir git deposu değil.</div>'; return; }
  const sel = GW.sel || {};
  if (GW.view === 'changes') {
    const grp = (title, kind, files) => files.length ? `<div class="gw-grp"><span>${title}</span><span>${files.length}</span></div>` + files.map(f => {
      const on = sel.type === 'file' && sel.kind === kind && sel.path === f.path;
      return `<button class="gf ${on ? 'on' : ''}" data-gwfile="${esc(f.path)}" data-kind="${kind}" title="${esc(f.from ? f.from + ' → ' + f.path : f.path)}"><span class="fcode ${f.code === '?' ? 'Q' : esc(f.code)}">${f.code === '?' ? 'U' : esc(f.code)}</span><span class="fp"><bdi>${esc(f.path)}</bdi></span><span></span></button>`;
    }).join('') : '';
    const html = grp('Çakışmalar', 'unstaged', ov.conflicted) + grp('Hazırlanan (staged)', 'staged', ov.staged) + grp('Hazırlanmayan', 'unstaged', ov.unstaged) + grp('Takip edilmeyen', 'untracked', ov.untracked);
    el.innerHTML = html || '<div class="gw-empty"><i class="fa-solid fa-check"></i>Çalışma ağacı temiz, bekleyen değişiklik yok.</div>';
  } else if (GW.view === 'stash') {
    el.innerHTML = ov.stashes.length ? ov.stashes.map(s => `<button class="gw-c ${sel.type === 'stash' && sel.ref === s.ref ? 'on' : ''}" data-gwstash="${esc(s.ref)}"><span class="av"><i class="fa-solid fa-box-archive"></i></span><span class="gc-tx"><b>${esc(s.msg)}</b><span>${esc(s.ref)} · ${rel(s.at)}</span></span><span></span></button>`).join('')
      : '<div class="gw-empty"><i class="fa-solid fa-box-open"></i>Stash yok.</div>';
  } else {
    let day = '', html = '';
    for (const c of GW.commits) {
      const d = dayLabel(c.at);
      if (d !== day) { day = d; html += `<div class="gw-day"><i class="fa-solid fa-code-commit"></i>${esc(d)}</div>`; }
      html += `<button class="gw-c ${sel.type === 'commit' && sel.hash === c.hash ? 'on' : ''}" data-gwc="${c.hash}" title="${esc(c.subject)}">${avatarHTML(c)}<span class="gc-tx"><b>${esc(c.subject)}</b><span>${esc(whoText(c))} · ${rel(c.at)} · <code>${c.short}</code></span></span>${pushIcon(c)}</button>`;
    }
    el.innerHTML = (html || '<div class="gw-empty"><i class="fa-solid fa-code-commit"></i>Henüz commit yok.</div>') + (GW.more && GW.commits.length ? '<button class="btn gw-more" data-gwmore>Daha eski commitler</button>' : '');
  }
}
async function showGwDetail() {
  const p = proj(GW.pid), s = GW.sel, box = $('#gwDetail'); if (!p || !s) return;
  const tok = ++GW.dtok;
  box.innerHTML = '<div class="gw-empty"><i class="fa-solid fa-circle-notch fa-spin"></i>Yükleniyor…</div>';
  try {
    if (s.type === 'commit') {
      const c = await api.invoke('git:show', p.path, s.hash);
      if (tok !== GW.dtok) return;
      const add = c.files.reduce((n, f) => n + (f.add || 0), 0), del = c.files.reduce((n, f) => n + (f.del || 0), 0);
      box.innerHTML = `<div class="gw-ch"><h3>${esc(c.subject)}</h3>${c.body ? `<pre>${esc(c.body)}</pre>` : ''}
        <div class="gw-meta"><span class="who">${avatarHTML(c)}${esc(c.author)}</span><span>${new Date(c.at).toLocaleString('tr-TR', { dateStyle: 'long', timeStyle: 'short' })}</span>
        <code title="Tam hash: ${c.hash}">${c.short}</code>${c.parents.length ? `<span>üst: ${c.parents.map(h => `<code>${h.slice(0, 7)}</code>`).join(' ')}</span>` : ''}
        ${c.claude ? '<span class="gchip acc"><i class="fa-solid fa-robot"></i> Claude ile</span>' : ''}
        ${c.pushed === true ? '<span class="gchip ok"><i class="fa-solid fa-cloud"></i> push edildi</span>' : c.pushed === false ? '<span class="gchip warn"><i class="fa-solid fa-arrow-up-from-bracket"></i> push edilmedi</span>' : ''}
        ${c.refs ? `<span class="gchip">${esc(c.refs)}</span>` : ''}</div></div>
        <div class="gw-files">${c.files.length} dosya değişti · <span class="nums"><span class="a">+${add}</span><span class="d">−${del}</span></span></div>` + diffHTML(c.patch);
    } else if (s.type === 'stash') {
      const r = await api.invoke('git:stash', p.path, s.ref);
      if (tok !== GW.dtok) return;
      const st = (GW.ov.stashes || []).find(x => x.ref === s.ref) || {};
      box.innerHTML = `<div class="gw-ch"><h3>${esc(st.msg || s.ref)}</h3><div class="gw-meta"><code>${esc(s.ref)}</code>${st.at ? `<span>${new Date(st.at).toLocaleString('tr-TR', { dateStyle: 'long', timeStyle: 'short' })}</span>` : ''}</div></div>
        <div class="gw-files">${r.files.length} dosya</div>` + diffHTML(r.patch);
    } else {
      const r = await api.invoke('git:diff', p.path, s.kind, s.path);
      if (tok !== GW.dtok) return;
      const head = `<div class="gw-ch"><h3 style="font:600 14px var(--f-mono)">${esc(s.path)}</h3><div class="gw-meta">${{ staged: 'Hazırlanan değişiklik (staged)', unstaged: 'Hazırlanmayan değişiklik', untracked: 'Yeni dosya, git takip etmiyor' }[s.kind]}</div></div>`;
      if (r.untracked) {
        box.innerHTML = head + (r.dir ? '<div class="diff-note">Klasör.</div>' : r.binary ? '<div class="diff-note">İkili (binary) dosya.</div>' : r.big ? '<div class="diff-note">Dosya çok büyük (2 MB üstü).</div>'
          : fileBlock({ path: s.path, lines: r.text.replace(/\r?\n$/, '').split(/\r?\n/).map((l, i) => ({ t: 'add', n: i + 1, text: l })), add: r.text.split(/\r?\n/).length, del: 0 }));
      } else box.innerHTML = head + (r.patch.text.trim() ? diffHTML(r.patch) : '<div class="diff-note">Fark yok (yalnızca izin ya da satır sonu değişmiş olabilir).</div>');
    }
  } catch (e) { if (tok === GW.dtok) box.innerHTML = `<div class="gw-empty"><i class="fa-solid fa-triangle-exclamation"></i>${esc(cleanErr(e))}</div>`; }
}

/* unified diff → per-file blocks with old/new line numbers */
function parseDiff(text) {
  const files = []; let f = null, o = 0, n = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      f = { path: m ? m[2] : line.slice(11), from: m ? m[1] : '', lines: [], add: 0, del: 0, note: '' };
      files.push(f); continue;
    }
    if (!f) continue;
    if (line.startsWith('@@')) { const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/); if (m) { o = +m[1]; n = +m[2]; } f.lines.push({ t: 'hunk', text: line }); continue; }
    if (!f.lines.length) {
      if (line.startsWith('Binary files')) f.note = 'İkili (binary) dosya değişti.';
      else if (line.startsWith('new file')) f.state = 'yeni';
      else if (line.startsWith('deleted file')) f.state = 'silindi';
      else if (line.startsWith('rename from')) f.state = 'yeniden adlandırıldı';
      continue;
    }
    if (line[0] === '+') { f.lines.push({ t: 'add', n: n++, text: line.slice(1) }); f.add++; }
    else if (line[0] === '-') { f.lines.push({ t: 'del', o: o++, text: line.slice(1) }); f.del++; }
    else if (line[0] === ' ') f.lines.push({ t: 'ctx', o: o++, n: n++, text: line.slice(1) });
    else if (line[0] === '\\') f.lines.push({ t: 'ctx', text: line });
  }
  return files;
}
const MAX_DIFF_LINES = 4000;
function fileBlock(f, fold) {
  const rows = f.lines.slice(0, MAX_DIFF_LINES).map(l => l.t === 'hunk'
    ? `<tr class="hunk"><td class="ln"></td><td class="ln"></td><td>${esc(l.text)}</td></tr>`
    : `<tr class="${l.t}"><td class="ln">${l.o || ''}</td><td class="ln">${l.n || ''}</td><td>${l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' '}${esc(l.text.replace(/\r$/, ''))}</td></tr>`).join('');
  const rest = f.lines.length > MAX_DIFF_LINES ? `<div class="diff-note">… ${f.lines.length - MAX_DIFF_LINES} satır daha gösterilmedi.</div>` : '';
  return `<div class="df ${fold ? 'fold' : ''}"><div class="df-h" data-dffold><i class="fa-solid fa-chevron-down"></i><span class="fp" title="${esc(f.from && f.from !== f.path ? f.from + ' → ' + f.path : f.path)}">${esc(f.from && f.from !== f.path ? f.from + ' → ' + f.path : f.path)}</span>${f.state ? `<span class="gchip">${f.state}</span>` : ''}<span class="nums"><span class="a">+${f.add}</span><span class="d">−${f.del}</span></span></div>` +
    (f.note ? `<div class="diff-note">${f.note}</div>` : f.lines.length ? `<table class="diff">${rows}</table>${rest}` : '<div class="diff-note">İçerik değişmedi.</div>') + '</div>';
}
function diffHTML(patch) {
  const files = parseDiff(patch.text);
  const big = files.length > 25;
  return files.map(f => fileBlock(f, big || f.lines.length > 800)).join('') + (patch.truncated ? '<div class="diff-note">Fark çok büyük, bir kısmı gösterilmedi.</div>' : '');
}

/* ---- git line under each open project in the side panel: behind / waiting / one-click pull, push ---- */
const SYNC = {}; // pid -> { h, at, fetchedAt, busy, err, loading }
const SYNC_TEXT = { fetch: 'Kontrol ediliyor', pull: 'Pull yapılıyor', push: 'Push yapılıyor' };
const sideProjects = () => S.projects.filter(p => S.tabs.some(t => t.projectId === p.id) || outsideOf(p.id).length);
const syncBtn = (pid, act, icon, label, title) => `<button class="pg-act" data-gsync="${pid}" data-act="${act}" title="${esc(title)}"><i class="fa-solid ${icon}"></i>${label}</button>`;
function syncLineHTML(p) {
  const s = SYNC[p.id];
  if (!s) { refreshSync(p.id); return ''; }
  const h = s.h;
  if (!h || !h.repo) return '';
  const remotes = h.remotes || [];
  const chips = [];
  if (!remotes.length) chips.push('<span class="gchip" title="Bu deponun uzak bağlantısı (remote) yok">yalnızca yerel</span>');
  else if (!h.upstream && !h.detached) chips.push('<span class="gchip warn" title="Bu dal henüz uzağa gönderilmedi">yayımlanmamış</span>');
  if (h.behind) chips.push(`<span class="gchip acc" title="Uzakta olup sende olmayan ${h.behind} commit var. Pull yapman lazım.">↓ ${h.behind} geride</span>`);
  if (h.ahead) chips.push(`<span class="gchip warn" title="${h.ahead} commit push edilmeyi bekliyor">↑ ${h.ahead} bekliyor</span>`);
  if (h.dirty) chips.push(`<span class="gchip" title="Commit edilmemiş ${h.dirty} değişiklik">${h.dirty} değişiklik</span>`);
  if (h.upstream && !h.behind && !h.ahead) chips.push('<span class="gchip ok" title="Uzak dalla aynı (son kontrole göre)">güncel</span>');
  let act = '';
  if (s.busy) act = `<span class="pg-busy"><i class="fa-solid fa-circle-notch fa-spin"></i>${SYNC_TEXT[s.busy]}</span>`;
  else if (h.ahead && h.behind) act = `<button class="pg-act warn" data-gitopen="${p.id}" title="Yerel ve uzak dal ayrışmış. Otomatik birleştirme yapmıyorum; birleştirme ya da rebase gerekiyor. Ayrıntılar için tıkla."><i class="fa-solid fa-code-merge"></i>Ayrışmış</button>`;
  else if (h.behind) act = syncBtn(p.id, 'pull', 'fa-arrow-down', 'Pull', `${h.behind} commit'i al (git pull --ff-only)`);
  else if (h.ahead) act = syncBtn(p.id, 'push', 'fa-arrow-up', 'Push', `${h.ahead} commit'i gönder (git push)`);
  else if (!h.upstream && remotes.length && !h.detached) act = syncBtn(p.id, 'push', 'fa-cloud-arrow-up', 'Yayımla', `${h.branch} dalını uzağa gönder (git push -u)`);
  const check = s.busy || !remotes.length ? '' : `<button class="pg-ref" data-gsync="${p.id}" data-act="fetch" title="Uzakta yeni commit var mı bak (git fetch)${s.fetchedAt ? '\nSon kontrol: ' + (rel(s.fetchedAt) === 'şimdi' ? 'az önce' : rel(s.fetchedAt) + ' önce') : ''}" aria-label="Uzak depoyu kontrol et"><i class="fa-solid fa-arrows-rotate"></i></button>`;
  const err = s.err && !s.busy ? `<i class="fa-solid fa-triangle-exclamation pg-err" title="${esc(s.err)}"></i>` : '';
  return `<div class="proj-git"><button class="pg-br" data-gitopen="${p.id}" title="${esc(h.branch)} · git ayrıntıları"><i class="fa-solid fa-code-branch"></i><span>${esc(h.detached ? 'detached' : h.branch)}</span></button>${chips.join('')}${err}<span class="pg-sp"></span>${act}${check}</div>`;
}
async function refreshSync(pid, doFetch) {
  const p = proj(pid); if (!p) return;
  const s = SYNC[pid] || (SYNC[pid] = { h: null, at: 0, fetchedAt: 0, busy: '', err: '', loading: false });
  if (s.loading || s.busy) return;
  s.loading = true;
  try {
    if (doFetch && s.h && s.h.repo && (s.h.remotes || []).length) {
      s.busy = 'fetch'; renderSide();
      const r = await api.invoke('git:sync', p.path, 'fetch');
      s.h = r.after; s.fetchedAt = Date.now(); s.err = '';
    } else s.h = await api.invoke('git:head', p.path);
  } catch (e) { s.err = cleanErr(e); }
  s.busy = ''; s.loading = false; s.at = Date.now();
  renderSide();
  // first time we see it: ask the remote too, so "behind" is real
  if (!doFetch && !s.fetchedAt && s.h && s.h.repo && (s.h.remotes || []).length) refreshSync(pid, true);
}
async function runSync(pid, act) {
  const p = proj(pid), s = SYNC[pid]; if (!p || !s || s.busy) return;
  if (act === 'fetch') { s.fetchedAt = 0; return refreshSync(pid, true); }
  s.busy = act; s.err = ''; renderSide();
  try {
    const r = await api.invoke('git:sync', p.path, act);
    s.h = r.after;
    const b = r.before;
    if (act === 'pull') toast(`${p.name}: pull tamam`, `${b.behind} commit alındı.`);
    else if (!b.upstream) toast(`${p.name}: dal yayımlandı`, `${b.branch} artık uzakta da var.`);
    else toast(`${p.name}: push tamam`, `${b.ahead} commit gönderildi.`);
  } catch (e) {
    s.err = cleanErr(e);
    toast(`${p.name}: ${act === 'pull' ? 'pull' : 'push'} yapılamadı`, s.err);
  }
  s.busy = '';
  renderSide();
  scheduleGitBtn(true);
  if (!$('#gitPanel').hidden && GIT.pid === pid) loadGit();
  if (!$('#gitWin').hidden && GW.pid === pid) reloadGw(true);
}
function openGitFor(pid) {
  openGitPanel();
  if (GIT.pid !== pid) pickGitProject(pid);
  if (GIT.tab !== 'git') setGitTab('git');
}

function initGit() {
  GIT.tab = (CFG.settings.gitTab === 'github') ? 'github' : 'git';
  $('#gitBtn').onclick = toggleGitPanel;
  $('#gitProjBtn').onclick = () => ($('#gitProjDrop').hidden ? openGitDrop() : closeGitDrop());
  $('#gitProjQ').addEventListener('input', () => renderGitDrop());
  $('#gitProjQ').addEventListener('keydown', e => {
    const n = GIT.drop.view.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); GIT.drop.sel = Math.min(n - 1, GIT.drop.sel + 1); renderGitDrop(true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); GIT.drop.sel = Math.max(0, GIT.drop.sel - 1); renderGitDrop(true); }
    else if (e.key === 'Enter') { e.preventDefault(); const p = GIT.drop.view[GIT.drop.sel]; if (p) pickGitProject(p.id); }
    else if (e.key === 'Escape') { e.stopPropagation(); closeGitDrop(); $('#gitProjBtn').focus(); }
  });
  $('#gitPanel').addEventListener('click', e => {
    const el = e.target.closest('[data-gtab],[data-gitproj],[data-gitc],[data-gwopen],[data-gitreload],[data-ghurl],[data-nrvis],[data-nrclaude],[data-nrweb],[data-nrconnect]'); if (!el) return;
    const d = el.dataset;
    if (d.nrvis) { newRepo(GIT.pid).vis = d.nrvis; renderGitBody(); return; }
    if (d.nrclaude !== undefined) { createWithClaude(); return; }
    if (d.nrweb !== undefined) { createOnWeb(); return; }
    if (d.nrconnect !== undefined) { connectRepo(); return; }
    if (d.gtab) { if (d.gtab !== GIT.tab) setGitTab(d.gtab); }
    else if (d.gitproj) pickGitProject(d.gitproj);
    else if (d.gitc) openGitWin('history', d.gitc);
    else if (d.gwopen) openGitWin(d.gwopen);
    else if (d.gitreload !== undefined) loadGit(d.gitreload === 'force');
    else if (d.ghurl) api.invoke('shell:openGithub', d.ghurl);
  });
  if (!$('#gitProjDrop').hidden) closeGitDrop();
  $('#gitBody').addEventListener('input', e => { if (e.target.id === 'nrName') newRepo(GIT.pid).name = e.target.value.trim(); });
  $('#gitBody').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'nrUrl') { e.preventDefault(); connectRepo(); } });
  document.addEventListener('mousedown', e => {
    if (!$('#gitProjDrop').hidden && !e.target.closest('.gp-proj')) closeGitDrop();
    if (!$('#gitPanel').hidden && !e.target.closest('#gitPanel,#gitBtn')) closeGitPanel();
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('#gitWin').hidden) { $('#gitWin').hidden = true; return; }
    if (!$('#gitPanel').hidden) closeGitPanel();
  });
  $('#gitWin').addEventListener('click', e => {
    if (e.target.id === 'gitWin') { $('#gitWin').hidden = true; return; }
    const el = e.target.closest('[data-gwview],[data-gwc],[data-gwfile],[data-gwstash],[data-gwmore],[data-dffold]'); if (!el) return;
    const d = el.dataset;
    if (d.gwview) { GW.view = d.gwview; GW.sel = null; renderGw(); }
    else if (d.gwc) { GW.sel = { type: 'commit', hash: d.gwc }; renderGwList(); showGwDetail(); }
    else if (d.gwfile) { GW.sel = { type: 'file', kind: d.kind, path: d.gwfile }; renderGwList(); showGwDetail(); }
    else if (d.gwstash) { GW.sel = { type: 'stash', ref: d.gwstash }; renderGwList(); showGwDetail(); }
    else if (d.gwmore !== undefined) moreGwHistory();
    else if (d.dffold !== undefined) el.parentElement.classList.toggle('fold');
  });
  $('#gwClose').onclick = () => { $('#gitWin').hidden = true; };
  $('#gwRefresh').onclick = async () => { await reloadGw(true); if (GW.sel) showGwDetail(); };
  scheduleGitBtn(true);
  setInterval(() => scheduleGitBtn(true), 30000);
  setInterval(() => sideProjects().forEach(p => refreshSync(p.id)), 30000);
  setInterval(() => sideProjects().forEach(p => refreshSync(p.id, true)), 5 * 60000);
}

/* ---------------- start ---------------- */
async function init() {
  const r = await api.invoke('config:get');
  CFG = r.config; INFO = r.info;
  S.projects = CFG.projects;
  IDE.state = CFG.ide.state || {};
  IDE.ui = Object.assign({ ex: true, panel: true, size: 13, wrap: false, dock: 'bottom', ph: 260, pw: 440 }, CFG.ide.ui || {});
  applySkin(CFG.settings.skin);
  setupEditor();
  bindEvents();
  initGit();
  bindIde();
  applyPanels();
  renderUsage();
  await refreshAllHistory();
  api.on('live-sessions', setLive);
  try { setLive(await api.invoke('live:list')); } catch (_) {}
  setMode(['ide', 'db'].includes(CFG.settings.mode) ? CFG.settings.mode : 'claude', true);
  refreshUsage();
  setInterval(refreshUsage, 120000);
  setInterval(renderSide, 60000);
  setInterval(() => refreshAllHistory().then(renderSide), 180000);
  handleOpen(await api.invoke('app:takePendingOpen'));
}
init();

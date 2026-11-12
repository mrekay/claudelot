/* VoxStorm DB mode: database client for MSSQL, PostgreSQL, MySQL and MariaDB.
   Everything that touches a server runs in the main process (src/main/db.js); this file is the UI:
   connection manager, object explorer, SQL editor tabs, result grid, history and saved queries.
   Uses globals from app.js: $, esc, toast, S, setMode, openTerminal, sendPendingPrompt, SHORTCUTS. */
/* global api, CodeMirror */
(() => {
  'use strict';
  const view = document.getElementById('dbView');
  const TYPES = [['mssql', 'MSSQL'], ['pg', 'PostgreSQL'], ['mysql', 'MySQL'], ['mariadb', 'MariaDB']];
  const TYPE_NAME = Object.fromEntries(TYPES);
  const DEF_PORT = { mssql: 1433, pg: 5432, mysql: 3306, mariadb: 3306 };
  const CM_MODE = { mssql: 'text/x-mssql', pg: 'text/x-pgsql', mysql: 'text/x-mysql', mariadb: 'text/x-mariadb' };
  const COLORS = [['', 'Yok'], ['red', 'Kırmızı'], ['orange', 'Turuncu'], ['yellow', 'Sarı'], ['green', 'Yeşil'], ['blue', 'Mavi'], ['purple', 'Mor'], ['gray', 'Gri']];
  const KINDS = [['tables', 'Tablolar', 'fa-table'], ['views', 'Görünümler', 'fa-eye'], ['procs', 'Saklı yordamlar', 'fa-gears'], ['funcs', 'Fonksiyonlar', 'fa-florin-sign']];
  const RH = 24; // grid row height
  const SHOW_STEP = 1000;
  const isMy = t => t === 'mysql' || t === 'mariadb';
  const fmtN = n => Number(n || 0).toLocaleString('tr-TR');
  const fmtMs = ms => (ms < 1000 ? ms + ' ms' : (ms / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 2 }) + ' sn');
  const errText = e => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const inv = async (ch, ...a) => { try { return await api.invoke(ch, ...a); } catch (e) { return { error: errText(e) }; } };
  const uid = () => 'q' + Math.random().toString(36).slice(2, 10);

  const D = {
    built: false, conns: [], canEncrypt: true,
    live: {}, // connId -> { status, version, dbs, error }
    kids: {}, // tree node key -> { loading, items, error }
    open: new Set(), filter: '',
    tabs: [], active: null,
    side: 'tree', ui: { sideW: 270, edH: 0.42 },
    hints: {}, // connId|db -> tables for autocomplete
    history: null, saved: null,
  };
  let cm = null;
  const conn = id => D.conns.find(c => c.id === id);
  const cur = () => D.tabs.find(t => t.id === D.active);

  /* ---------------- quoting & templates ---------------- */
  function qi(type, name) {
    name = String(name);
    if (type === 'mssql') return '[' + name.replace(/]/g, ']]') + ']';
    if (isMy(type)) return '`' + name.replace(/`/g, '``') + '`';
    return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : '"' + name.replace(/"/g, '""') + '"';
  }
  const full = (type, n) => (isMy(type) ? qi(type, n.name) : qi(type, n.schema) + '.' + qi(type, n.name));
  function topSql(type, n, limit = 100) {
    if (type === 'mssql') return `SELECT TOP (${limit}) *\nFROM ${full(type, n)};`;
    return `SELECT *\nFROM ${full(type, n)}\nLIMIT ${limit};`;
  }
  function pageSql(type, fullName, page, size) {
    if (type === 'mssql') return `SELECT *\nFROM ${fullName}\nORDER BY (SELECT NULL)\nOFFSET ${page * size} ROWS FETCH NEXT ${size} ROWS ONLY;`;
    return `SELECT *\nFROM ${fullName}\nLIMIT ${size} OFFSET ${page * size};`;
  }
  function selectSql(type, n, cols) {
    const list = cols && cols.length ? cols.map(c => '  ' + qi(type, c.name)).join(',\n') : '  *';
    return `SELECT\n${list}\nFROM ${full(type, n)}\nWHERE 1 = 1;`;
  }
  function insertSql(type, n, cols) {
    const use = (cols || []).filter(c => !c.ident);
    if (!use.length) return `INSERT INTO ${full(type, n)}\nVALUES ();`;
    return `INSERT INTO ${full(type, n)} (\n${use.map(c => '  ' + qi(type, c.name)).join(',\n')}\n) VALUES (\n${use.map(c => `  NULL -- ${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`).join(',\n').replace(/ -- ([^\n]*),\n/g, ', -- $1\n')}\n);`;
  }
  function execSql(type, n) {
    if (type === 'mssql') return n.kind === 'funcs' ? `SELECT ${full(type, n)}(/* parametreler */);` : `EXEC ${full(type, n)} /* @parametre = değer */;`;
    if (n.kind === 'procs') return `CALL ${full(type, n)}(/* parametreler */);`;
    return `SELECT ${full(type, n)}(/* parametreler */);`;
  }

  /* ---------------- persistence ---------------- */
  let stateTimer = null;
  function saveState() {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => {
      const tabs = D.tabs.map(t => ({ id: t.id, title: t.title, connId: t.connId, db: t.db, sql: t.doc ? t.doc.getValue() : t.sql, savedId: t.savedId || '', page: t.page || null }));
      api.invoke('db:setState', { tabs, active: D.active, side: D.side, ui: D.ui }).catch(() => {});
    }, 600);
  }

  /* ---------------- build ---------------- */
  function build() {
    view.innerHTML = `
      <aside class="db-side" id="dbSide" aria-label="Veritabanı gezgini">
        <div class="db-side-h">
          <div class="db-seg" role="tablist">
            <button data-side="tree" role="tab" title="Bağlantılar ve nesneler"><i class="fa-solid fa-sitemap"></i>Gezgin</button>
            <button data-side="history" role="tab" title="Çalıştırılan sorgular"><i class="fa-solid fa-clock-rotate-left"></i>Geçmiş</button>
            <button data-side="saved" role="tab" title="Kayıtlı sorgular"><i class="fa-regular fa-bookmark"></i>Kayıtlı</button>
          </div>
          <button class="db-ib" data-act="newConn" title="Yeni bağlantı" aria-label="Yeni bağlantı"><i class="fa-solid fa-plus"></i></button>
        </div>
        <div class="db-search"><i class="fa-solid fa-magnifying-glass"></i><input id="dbFilter" placeholder="Ara…" spellcheck="false" autocomplete="off" aria-label="Ara"><button class="db-ib sm" data-act="clearFilter" title="Temizle" hidden><i class="fa-solid fa-xmark"></i></button></div>
        <div class="db-list" id="dbTree" tabindex="0"></div>
        <div class="db-list" id="dbHist" hidden></div>
        <div class="db-list" id="dbSaved" hidden></div>
      </aside>
      <div class="db-split-v" data-drag="side" title="Sürükleyerek genişlet"></div>
      <main class="db-main">
        <div class="db-tabs" id="dbTabs" role="tablist"></div>
        <div class="db-bar" id="dbBar">
          <span class="db-cdot" id="dbBarDot"></span>
          <select id="dbConnSel" aria-label="Bağlantı" title="Bağlantı"></select>
          <select id="dbDbSel" aria-label="Veritabanı" title="Veritabanı"></select>
          <button class="db-run" data-act="run" title="Çalıştır: seçili kısım ya da tamamı (Ctrl+Enter / F5)"><i class="fa-solid fa-play"></i>Çalıştır</button>
          <button class="db-tb" data-act="runStmt" title="İmlecin bulunduğu deyimi çalıştır (Ctrl+Shift+Enter)"><i class="fa-solid fa-i-cursor"></i>Deyim</button>
          <button class="db-tb danger" data-act="cancel" title="Sorguyu iptal et (Shift+F5)" hidden><i class="fa-solid fa-stop"></i>İptal</button>
          <span class="db-ro" id="dbRo" hidden title="Bu bağlantıda yazma ifadeleri engellenir"><i class="fa-solid fa-lock"></i>Salt okunur</span>
          <span class="db-grow"></span>
          <button class="db-tb" data-act="saveQuery" title="Sorguyu kaydet (Ctrl+S)"><i class="fa-regular fa-bookmark"></i>Kaydet</button>
          <button class="db-tb" data-act="claude" title="Seçili sorguyu Claude'a sor (Ctrl+Shift+K)"><i class="fa-solid fa-robot"></i>Claude'a sor</button>
        </div>
        <div class="db-ed" id="dbEd"></div>
        <div class="db-split-h" data-drag="ed" title="Sürükleyerek boyutlandır"></div>
        <section class="db-res" id="dbRes" aria-label="Sonuçlar">
          <div class="db-rtabs" id="dbRTabs" role="tablist"></div>
          <div class="db-rbody" id="dbRBody"></div>
        </section>
        <div class="db-status" id="dbStatus"></div>
      </main>
      <div class="db-modal" id="dbModal" hidden></div>
      <div class="db-ctx" id="dbCtx" hidden role="menu"></div>`;
    cm = CodeMirror(document.getElementById('dbEd'), {
      theme: 'claudelot', mode: 'text/x-sql', lineNumbers: true, matchBrackets: true, autoCloseBrackets: true, styleActiveLine: true,
      indentUnit: 2, tabSize: 2, value: '',
      extraKeys: {
        'Ctrl-Enter': () => run('auto'),
        'Ctrl-Shift-Enter': () => run('stmt'),
        'Ctrl-Space': () => hint(),
        'Ctrl-S': () => saveQuery(),
        Tab: c => (c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('  ')),
        'Shift-Tab': c => c.indentSelection('subtract'),
        'Ctrl-/': c => toggleComment(c),
      },
    });
    cm.on('changes', () => { const t = cur(); if (t && t.page && !t.pageEdited) { t.pageEdited = true; } saveState(); });
    cm.on('cursorActivity', () => renderStatus());
    bind();
    loadHintAddon();
    D.built = true;
  }
  function toggleComment(c) {
    const from = c.getCursor('from').line, to = c.getCursor('to').line;
    const lines = []; for (let l = from; l <= to; l++) lines.push(c.getLine(l));
    const all = lines.filter(s => s.trim()).every(s => /^\s*--/.test(s));
    c.operation(() => lines.forEach((s, i) => {
      const l = from + i;
      if (all) { const m = /^(\s*)-- ?/.exec(s); if (m) c.replaceRange(m[1], { line: l, ch: 0 }, { line: l, ch: m[0].length }); } else if (s.trim()) c.replaceRange('-- ', { line: l, ch: 0 });
    }));
  }
  // CodeMirror's SQL autocomplete addon is loaded on demand, only for DB mode
  let hintReady = false;
  function loadHintAddon() {
    const base = '../../node_modules/codemirror/addon/hint/';
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = base + 'show-hint.css'; document.head.appendChild(css);
    const s1 = document.createElement('script'); s1.src = base + 'show-hint.js';
    s1.onload = () => { const s2 = document.createElement('script'); s2.src = base + 'sql-hint.js'; s2.onload = () => { hintReady = true; }; document.head.appendChild(s2); };
    document.head.appendChild(s1);
  }
  async function hint() {
    if (!hintReady || !cm.showHint) return;
    const t = cur(); const c = t && conn(t.connId);
    let tables = {};
    if (c && t.db && D.live[c.id] && D.live[c.id].status === 'ok') {
      const k = c.id + '|' + t.db;
      if (!D.hints[k]) { const r = await inv('db:explore', c.id, 'hint', { db: t.db }); D.hints[k] = r.items || {}; }
      tables = D.hints[k];
    }
    cm.showHint({ hint: CodeMirror.hint.sql, completeSingle: false, tables });
  }

  /* ---------------- data loading ---------------- */
  async function loadConns() {
    const r = await inv('db:list');
    D.conns = r.connections || [];
    D.canEncrypt = r.canEncrypt !== false;
  }
  async function loadState() {
    const r = await inv('db:getState');
    const st = r && r.state;
    if (st) {
      D.side = st.side || 'tree';
      Object.assign(D.ui, st.ui || {});
      for (const x of st.tabs || []) addTab({ ...x, silent: true });
      if (st.active && D.tabs.some(t => t.id === st.active)) D.active = st.active;
    }
    if (!D.tabs.length) addTab({ silent: true, connId: D.conns[0] ? D.conns[0].id : '' });
    if (!D.active) D.active = D.tabs[0].id;
  }

  /* ---------------- tabs ---------------- */
  function addTab(o = {}) {
    const c = conn(o.connId);
    const t = {
      id: o.id || uid(), title: o.title || 'Sorgu ' + (D.tabs.length + 1), connId: c ? c.id : '', db: o.db || (c && c.database) || '',
      sql: o.sql || '', savedId: o.savedId || '', page: o.page || null,
      results: [], messages: [], view: 0, running: false, ms: null,
    };
    t.doc = CodeMirror.Doc(t.sql, c ? CM_MODE[c.type] : 'text/x-sql');
    t.doc.on('change', () => { t.dirty = true; });
    D.tabs.push(t);
    if (!o.silent) { activateTab(t.id); saveState(); }
    return t;
  }
  function activateTab(id) {
    const t = D.tabs.find(x => x.id === id); if (!t) return;
    D.active = id;
    if (cm && cm.getDoc() !== t.doc) cm.swapDoc(t.doc);
    renderTabs(); renderBar(); renderResults(); renderStatus();
    saveState();
    requestAnimationFrame(() => { cm.refresh(); cm.focus(); });
  }
  async function closeTab(id) {
    const t = D.tabs.find(x => x.id === id); if (!t) return;
    if (t.running) await inv('db:cancel', t.id);
    inv('db:closeTab', t.id);
    const i = D.tabs.indexOf(t);
    D.tabs.splice(i, 1);
    if (!D.tabs.length) addTab({ silent: true, connId: t.connId, db: t.db });
    if (D.active === id) D.active = (D.tabs[Math.min(i, D.tabs.length - 1)] || D.tabs[0]).id;
    activateTab(D.active);
  }
  function cycleTab(d) {
    const i = D.tabs.findIndex(t => t.id === D.active);
    activateTab(D.tabs[(i + d + D.tabs.length) % D.tabs.length].id);
  }
  function setTabConn(t, connId, db) {
    const c = conn(connId);
    t.connId = c ? c.id : '';
    t.db = db != null ? db : (c && c.database) || '';
    // CodeMirror reads doc.modeOption when a document is swapped in
    if (cm.getDoc() === t.doc) cm.setOption('mode', c ? CM_MODE[c.type] : 'text/x-sql');
    else t.doc.modeOption = c ? CM_MODE[c.type] : 'text/x-sql';
    if (c && !D.live[c.id]) connect(c.id, true);
    renderTabs(); renderBar(); renderStatus(); saveState();
  }
  // a tab for a quick look: reuse the current one when it is empty and on the same connection
  function tabFor(connId, db, title) {
    const t = cur();
    if (t && !t.running && !t.doc.getValue().trim() && (!t.connId || t.connId === connId)) { t.title = title || t.title; setTabConn(t, connId, db); return t; }
    const n = addTab({ connId, db, title, silent: true });
    activateTab(n.id);
    return n;
  }

  /* ---------------- connections ---------------- */
  function renderConn() { renderTree(); renderBar(); renderStatus(); }
  async function connect(id, quiet, password) {
    const c = conn(id); if (!c) return false;
    D.live[id] = Object.assign(D.live[id] || {}, { status: 'connecting', error: '' });
    renderConn();
    const r = await inv('db:connect', id, password);
    if (r.needPassword) {
      if (quiet) { D.live[id] = { status: 'idle' }; renderConn(); return false; }
      const pw = await askPassword(c, r.loginFailed ? r.error : '');
      if (pw == null) { D.live[id] = { status: 'idle' }; renderConn(); return false; }
      return connect(id, quiet, pw);
    }
    if (r.error) {
      D.live[id] = { status: 'error', error: r.error };
      if (!quiet) toast('Bağlanılamadı: ' + (c.name || c.host), r.error);
      renderConn();
      return false;
    }
    D.live[id] = { status: 'ok', version: r.version, dbs: r.databases || [] };
    D.kids['c:' + id] = { items: r.databases || [] };
    if (!quiet) D.open.add('c:' + id);
    if (password !== undefined) await loadConns(); // "hasPassword" may have changed
    renderConn();
    return true;
  }
  async function disconnect(id) {
    for (const t of D.tabs) if (t.connId === id && t.running) await inv('db:cancel', t.id);
    await inv('db:disconnect', id);
    delete D.live[id];
    for (const k of Object.keys(D.kids)) if (k.split(':')[1] === id) delete D.kids[k];
    for (const k of [...D.open]) if (k.split(':')[1] === id) D.open.delete(k);
    for (const k of Object.keys(D.hints)) if (k.startsWith(id + '|')) delete D.hints[k];
    renderConn();
  }

  /* ---------------- object explorer ---------------- */
  // keys: c:id  d:id:db  s:id:db:schema  k:id:db:schema:kind  o:id:db:schema:kind:name
  const enc = s => encodeURIComponent(s == null ? '' : s);
  const dec = s => decodeURIComponent(s || '');
  function parseKey(key) {
    const p = key.split(':');
    return { t: p[0], id: p[1], db: dec(p[2]), schema: dec(p[3]), kind: p[4], name: dec(p[5]) };
  }
  function childrenOf(key) {
    const n = parseKey(key), c = conn(n.id); if (!c) return null;
    if (n.t === 'd') {
      if (isMy(c.type)) return { items: KINDS.map(([k, l]) => ({ key: `k:${n.id}:${enc(n.db)}::${k}`, label: l, kind: k })) };
      return D.kids[key];
    }
    if (n.t === 's') return { items: KINDS.map(([k, l]) => ({ key: `k:${n.id}:${enc(n.db)}:${enc(n.schema)}:${k}`, label: l, kind: k })) };
    return D.kids[key];
  }
  async function loadKids(key, force) {
    const n = parseKey(key), c = conn(n.id); if (!c) return;
    if (n.t === 'c') { if (force || !D.live[n.id] || D.live[n.id].status !== 'ok') { if (force) { const r = await inv('db:explore', n.id, 'databases'); if (!r.error && !r.needPassword) { D.kids[key] = { items: r.items }; D.live[n.id].dbs = r.items; } renderTree(); return; } await connect(n.id); } return; }
    if ((n.t === 'd' && isMy(c.type)) || n.t === 's') return;
    if (D.kids[key] && !force && !D.kids[key].error) return;
    D.kids[key] = { loading: true }; renderTree();
    let r;
    if (n.t === 'd') r = await inv('db:explore', n.id, 'schemas', { db: n.db });
    else if (n.t === 'k') r = await inv('db:explore', n.id, 'objects', { db: n.db, schema: n.schema, kind: n.kind });
    else if (n.t === 'o') r = await inv('db:explore', n.id, 'columns', { db: n.db, schema: n.schema, table: n.name });
    if (r && r.needPassword) { await connect(n.id); r = await inv('db:explore', n.id, n.t === 'd' ? 'schemas' : n.t === 'k' ? 'objects' : 'columns', { db: n.db, schema: n.schema, kind: n.kind, table: n.name }); }
    D.kids[key] = r && !r.error ? { items: r.items || [] } : { error: (r && r.error) || 'Yüklenemedi' };
    renderTree();
  }
  async function toggle(key, force) {
    if (D.open.has(key) && !force) { D.open.delete(key); renderTree(); return; }
    D.open.add(key);
    renderTree();
    await loadKids(key, force);
  }
  function nodeList(key, depth, out, f) {
    // returns true when this subtree has a match (for the filter)
    const k = childrenOf(key);
    if (!k || !k.items) return false;
    const n = parseKey(key), c = conn(n.id);
    let any = false;
    for (const it of k.items) {
      let ck, label = it.name || it.label, icon, meta = '', leaf = false, extra = '';
      if (n.t === 'c') { ck = `d:${n.id}:${enc(it.name)}`; icon = 'fa-database'; if (it.system) extra = ' sys'; }
      else if (n.t === 'd' && !isMy(c.type)) { ck = `s:${n.id}:${enc(n.db)}:${enc(it.name)}`; icon = 'fa-folder'; if (it.empty) extra = ' sys'; }
      else if (n.t === 'd' || n.t === 's') { ck = it.key; icon = KINDS.find(x => x[0] === it.kind)[2]; extra = ' cat'; }
      else if (n.t === 'k') { ck = `o:${n.id}:${enc(n.db)}:${enc(n.schema)}:${n.kind}:${enc(it.name)}`; icon = KINDS.find(x => x[0] === n.kind)[2]; leaf = n.kind === 'procs' || n.kind === 'funcs'; if (it.sub === 'materialized') meta = 'mat.'; }
      else if (n.t === 'o') { ck = key + ':' + enc(it.name); icon = it.pk ? 'fa-key' : 'fa-minus'; meta = it.type + (it.nullable ? '' : ' · NOT NULL'); leaf = true; extra = it.pk ? ' db-pk' : ' db-colnode'; }
      const opened = !leaf && D.open.has(ck);
      const sub = [];
      const kidsMatch = !leaf && (opened || f) ? nodeList(ck, depth + 1, sub, f) : false;
      const selfMatch = !f || String(label).toLowerCase().includes(f);
      if (!selfMatch && !kidsMatch) continue;
      any = true;
      const loading = D.kids[ck] && D.kids[ck].loading;
      const loaded = it.kind && D.kids[ck] && D.kids[ck].items;
      const count = loaded ? D.kids[ck].items.length : null; // objects in a loaded category
      out.push(`<div class="db-node${extra}" data-key="${esc(ck)}" role="treeitem" aria-expanded="${leaf ? '' : opened}" style="padding-left:${8 + depth * 14}px" title="${esc(label)}${meta ? ' — ' + esc(meta) : ''}">`
        + `<i class="db-car fa-solid ${leaf ? '' : (loading ? 'fa-spinner fa-spin' : opened || (f && kidsMatch) ? 'fa-chevron-down' : 'fa-chevron-right')}"></i>`
        + `<i class="db-ni fa-solid ${icon}"></i><span class="db-nm">${hl(label, f)}</span>${meta ? `<span class="db-meta">${esc(meta)}</span>` : ''}${count != null ? `<span class="db-cnt">${count}</span>` : ''}</div>`);
      if (opened || (f && kidsMatch)) {
        const kk = D.kids[ck];
        if (kk && kk.error) out.push(`<div class="db-node err" style="padding-left:${22 + (depth + 1) * 14}px" title="${esc(kk.error)}"><i class="fa-solid fa-triangle-exclamation"></i><span class="db-nm">${esc(kk.error)}</span></div>`);
        else if (kk && kk.items && !kk.items.length && !f) out.push(`<div class="db-node empty" style="padding-left:${22 + (depth + 1) * 14}px"><span class="db-nm">(boş)</span></div>`);
        out.push(...sub);
      }
    }
    return any;
  }
  function hl(s, f) {
    s = String(s);
    if (!f) return esc(s);
    const i = s.toLowerCase().indexOf(f);
    return i < 0 ? esc(s) : esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + f.length)) + '</mark>' + esc(s.slice(i + f.length));
  }
  function renderTree() {
    const el = document.getElementById('dbTree'); if (!el) return;
    if (!D.conns.length) {
      el.innerHTML = `<div class="db-hello"><i class="fa-solid fa-database"></i><b>Henüz bağlantı yok</b><span>MSSQL, PostgreSQL, MySQL ya da MariaDB sunucusu ekle.</span><button class="btn primary" data-act="newConn"><i class="fa-solid fa-plus"></i> Bağlantı ekle</button></div>`;
      return;
    }
    const f = D.filter.trim().toLowerCase();
    const out = [];
    for (const c of D.conns) {
      const key = 'c:' + c.id, live = D.live[c.id] || {};
      const sub = [];
      const opened = D.open.has(key);
      const kidsMatch = opened || f ? nodeList(key, 1, sub, f) : false;
      const selfMatch = !f || (c.name + ' ' + c.host).toLowerCase().includes(f);
      if (!selfMatch && !kidsMatch) continue;
      const st = live.status || 'idle';
      out.push(`<div class="db-node conn db-c-${c.color || 'none'}" data-key="${key}" role="treeitem" aria-expanded="${opened}" title="${esc(TYPE_NAME[c.type])} · ${esc(c.host)}${c.port ? ':' + c.port : ''}${live.version ? '\n' + esc(live.version) : ''}${live.error ? '\n' + esc(live.error) : ''}">`
        + `<i class="db-car fa-solid ${st === 'connecting' ? 'fa-spinner fa-spin' : opened ? 'fa-chevron-down' : 'fa-chevron-right'}"></i>`
        + `<span class="db-tico t-${c.type}">${esc(c.type === 'mssql' ? 'MS' : c.type === 'pg' ? 'PG' : c.type === 'mysql' ? 'My' : 'Ma')}</span>`
        + `<span class="db-nm">${hl(c.name || c.host, f)}</span>`
        + (c.readOnly ? '<i class="fa-solid fa-lock db-lock" title="Salt okunur"></i>' : '')
        + `<span class="db-st ${st}" title="${st === 'ok' ? 'Bağlı' : st === 'error' ? 'Hata' : st === 'connecting' ? 'Bağlanıyor' : 'Bağlı değil'}"></span></div>`);
      if (opened && live.status === 'error') out.push(`<div class="db-node err" style="padding-left:36px" title="${esc(live.error)}"><i class="fa-solid fa-triangle-exclamation"></i><span class="db-nm">${esc(live.error)}</span></div>`);
      out.push(...sub);
    }
    el.innerHTML = out.join('') || '<div class="db-none">Eşleşme yok. Arama yalnızca açılmış düğümlerin içine bakar.</div>';
  }

  /* ---------------- side views: history and saved queries ---------------- */
  function setSide(v) {
    D.side = v;
    view.querySelectorAll('[data-side]').forEach(b => { b.classList.toggle('on', b.dataset.side === v); b.setAttribute('aria-selected', b.dataset.side === v); });
    document.getElementById('dbTree').hidden = v !== 'tree';
    document.getElementById('dbHist').hidden = v !== 'history';
    document.getElementById('dbSaved').hidden = v !== 'saved';
    document.getElementById('dbFilter').placeholder = v === 'tree' ? 'Bağlantı, tablo, sütun ara…' : v === 'history' ? 'Geçmişte ara…' : 'Kayıtlı sorgularda ara…';
    if (v === 'history') loadHistory();
    if (v === 'saved') loadSaved();
    saveState();
  }
  async function loadHistory() { const r = await inv('db:history'); D.history = r.items || []; renderHistory(); }
  async function loadSaved() { const r = await inv('db:saved'); D.saved = r.items || []; renderSaved(); }
  const when = ms => { const d = new Date(ms); const today = new Date().toDateString() === d.toDateString(); return today ? d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }); };
  function renderHistory() {
    const el = document.getElementById('dbHist'); if (!el || !D.history) return;
    const f = D.filter.trim().toLowerCase();
    const items = D.history.filter(h => !f || (h.sql + ' ' + h.connName + ' ' + h.db).toLowerCase().includes(f));
    el.innerHTML = (D.history.length ? `<div class="db-lh"><span>${fmtN(items.length)} sorgu</span><button class="db-link" data-act="clearHistory">Geçmişi temizle</button></div>` : '')
      + (items.map(h => `<div class="db-item" data-hist="${esc(h.id)}" title="Çift tıkla: yeni sekmede aç">
          <div class="db-ih"><span class="db-dot ${h.ok ? 'ok' : 'bad'}"></span><span>${esc(when(h.at))}</span><span class="db-muted">${esc(h.connName)}${h.db ? ' · ' + esc(h.db) : ''}</span><span class="db-grow"></span><span class="db-muted">${esc(fmtMs(h.ms))}</span></div>
          <pre class="db-isql">${esc(h.sql.slice(0, 400))}</pre><div class="db-isum">${esc(h.summary || '')}</div></div>`).join('')
      || '<div class="db-none">Henüz çalıştırılmış sorgu yok.</div>');
  }
  function renderSaved() {
    const el = document.getElementById('dbSaved'); if (!el || !D.saved) return;
    const f = D.filter.trim().toLowerCase();
    const items = D.saved.filter(q => !f || (q.name + ' ' + q.sql).toLowerCase().includes(f));
    el.innerHTML = items.map(q => { const c = conn(q.connId); return `<div class="db-item" data-saved="${esc(q.id)}" title="Tıkla: aç">
        <div class="db-ih"><i class="fa-regular fa-bookmark"></i><b>${esc(q.name)}</b><span class="db-grow"></span><span class="db-muted">${c ? esc(c.name || c.host) : ''}</span></div>
        <pre class="db-isql">${esc(q.sql.slice(0, 300))}</pre></div>`; }).join('')
      || '<div class="db-none">Kayıtlı sorgu yok. Düzenleyicide Ctrl+S ile kaydedebilirsin.</div>';
  }
  function openSql(sql, connId, db, title, savedId) {
    const t = cur();
    if (t && !t.running && !t.doc.getValue().trim()) { t.title = title || t.title; t.savedId = savedId || ''; setTabConn(t, connId || t.connId, db); t.doc.setValue(sql); activateTab(t.id); return t; }
    const n = addTab({ connId: connId || (t && t.connId), db: db || (connId ? undefined : t && t.db), title, sql, savedId, silent: true });
    activateTab(n.id);
    return n;
  }
  async function saveQuery() {
    const t = cur(); if (!t) return;
    const sql = t.doc.getValue();
    if (!sql.trim()) { toast('Kaydedilecek sorgu yok'); return; }
    if (D.saved == null) await loadSaved();
    const old = t.savedId && D.saved.find(q => q.id === t.savedId);
    let name = old ? old.name : '';
    if (!old) {
      const r = await modal({ title: 'Sorguyu kaydet', body: `<label class="db-f"><span>Ad</span><input name="name" value="${esc(/^Sorgu \d+$/.test(t.title) ? '' : t.title)}" placeholder="Örn. Günlük satışlar" maxlength="120"></label>`, buttons: [['cancel', 'Vazgeç'], ['ok', 'Kaydet', 'primary']] });
      if (!r || r.value !== 'ok') return;
      name = r.form.name.trim() || 'Adsız sorgu';
    }
    const res = await inv('db:savedSave', { id: old ? old.id : '', name, sql, connId: t.connId, db: t.db });
    if (res.error) { toast('Kaydedilemedi', res.error); return; }
    t.savedId = res.item.id; t.title = res.item.name;
    toast(old ? 'Kayıtlı sorgu güncellendi' : 'Sorgu kaydedildi', res.item.name);
    renderTabs(); saveState(); loadSaved();
  }

  /* ---------------- toolbar, tabs, status ---------------- */
  function renderTabs() {
    const el = document.getElementById('dbTabs'); if (!el) return;
    el.innerHTML = D.tabs.map(t => {
      const c = conn(t.connId);
      return `<div class="db-tab${t.id === D.active ? ' on' : ''} db-c-${(c && c.color) || 'none'}" data-tab="${t.id}" role="tab" aria-selected="${t.id === D.active}" title="${esc(t.title)}${c ? ' — ' + esc(c.name || c.host) + (t.db ? ' / ' + esc(t.db) : '') : ''}">`
        + (t.running ? '<i class="fa-solid fa-spinner fa-spin db-tsp"></i>' : t.page ? '<i class="fa-solid fa-table db-tsp"></i>' : t.savedId ? '<i class="fa-regular fa-bookmark db-tsp"></i>' : '')
        + `<span>${esc(t.title)}</span><button class="db-tx" data-close="${t.id}" title="Kapat (Ctrl+W)" aria-label="Sekmeyi kapat"><i class="fa-solid fa-xmark"></i></button></div>`;
    }).join('') + '<button class="db-tnew" data-act="newTab" title="Yeni sorgu (Ctrl+T)" aria-label="Yeni sorgu"><i class="fa-solid fa-plus"></i></button>';
  }
  function renderBar() {
    const t = cur(); if (!t || !document.getElementById('dbBar')) return;
    const c = conn(t.connId);
    const cs = document.getElementById('dbConnSel');
    cs.innerHTML = '<option value="">Bağlantı seç…</option>' + D.conns.map(x => `<option value="${x.id}"${x.id === t.connId ? ' selected' : ''}>${esc(x.name || x.host)} (${esc(TYPE_NAME[x.type])})</option>`).join('');
    const ds = document.getElementById('dbDbSel');
    const live = c && D.live[c.id];
    const dbs = (live && live.dbs) || [];
    const names = dbs.map(d => d.name);
    if (t.db && !names.includes(t.db)) names.unshift(t.db);
    ds.innerHTML = (c ? `<option value="">${c.type === 'pg' ? 'postgres (varsayılan)' : 'Varsayılan veritabanı'}</option>` : '<option value="">—</option>') + names.map(n => `<option${n === t.db ? ' selected' : ''}>${esc(n)}</option>`).join('');
    ds.disabled = !c;
    document.getElementById('dbBarDot').className = 'db-cdot db-c-' + ((c && c.color) || 'none') + (live && live.status === 'ok' ? ' on' : '');
    document.getElementById('dbRo').hidden = !(c && c.readOnly);
    view.querySelector('[data-act="run"]').hidden = t.running;
    view.querySelector('[data-act="runStmt"]').hidden = t.running;
    view.querySelector('[data-act="cancel"]').hidden = !t.running;
    view.querySelector('.db-main').classList.toggle('ro', !!(c && c.readOnly));
  }
  let tick = null;
  function renderStatus() {
    const el = document.getElementById('dbStatus'); const t = cur(); if (!el || !t) return;
    const c = conn(t.connId), live = c && D.live[c.id];
    const pos = cm.getCursor();
    const left = c ? `<span class="db-st ${live ? live.status : 'idle'}"></span><b>${esc(c.name || c.host)}</b><span>${esc(TYPE_NAME[c.type])}</span>${t.db ? `<span>${esc(t.db)}</span>` : ''}${c.readOnly ? '<span class="db-warn"><i class="fa-solid fa-lock"></i> salt okunur</span>' : ''}` : '<span class="db-muted">Bağlantı seçilmedi</span>';
    let right = `<span>Satır ${pos.line + 1}, Sütun ${pos.ch + 1}</span>`;
    if (t.running) right = `<span class="db-run-t"><i class="fa-solid fa-spinner fa-spin"></i> Çalışıyor ${fmtMs(Date.now() - t.started)}</span>` + right;
    else if (t.ms != null) right = `<span>${fmtMs(t.ms)}</span>` + (t.results.length ? `<span>${t.results.map(r => fmtN(r.total)).join(' + ')} satır</span>` : '') + right;
    el.innerHTML = `<div class="db-sl">${left}</div><div class="db-sr">${right}</div>`;
  }

  /* ---------------- running queries ---------------- */
  // statement under the cursor: text between blank lines / semicolons around the cursor
  function statementAt() {
    const doc = cm.getDoc(), line = doc.getCursor().line, last = doc.lastLine();
    const blank = l => !doc.getLine(l).trim();
    if (blank(line)) {
      let up = line; while (up > 0 && blank(up)) up--;
      if (blank(up)) return null;
      return statementAtLine(up);
    }
    return statementAtLine(line);
    function statementAtLine(l) {
      let a = l, b = l;
      while (a > 0 && !blank(a - 1)) a--;
      while (b < last && !blank(b + 1)) b++;
      const text = doc.getRange({ line: a, ch: 0 }, { line: b, ch: doc.getLine(b).length });
      // inside the block, split on ";" at line ends
      const lines = text.split('\n'); const rel = l - a;
      let s = 0;
      for (let i = 0; i < rel; i++) if (/;\s*(--.*)?$/.test(lines[i])) s = i + 1;
      let e = lines.length - 1;
      for (let i = rel; i < lines.length; i++) if (/;\s*(--.*)?$/.test(lines[i])) { e = i; break; }
      if (s > rel) s = rel;
      return { sql: lines.slice(s, e + 1).join('\n'), from: a + s, to: a + e };
    }
  }
  async function run(mode) {
    const t = cur(); if (!t || t.running) return;
    if (t.page && mode !== 'page') t.page = null; // edited by hand: a normal query again
    let sql, offset = 0;
    if (mode === 'stmt') {
      const st = statementAt();
      if (!st || !st.sql.trim()) { toast('Çalıştırılacak deyim yok'); return; }
      sql = st.sql; offset = st.from;
      cm.setSelection({ line: st.from, ch: 0 }, { line: st.to, ch: cm.getLine(st.to).length });
    } else if (cm.somethingSelected()) { sql = cm.getSelection(); offset = cm.getCursor('from').line; } else sql = cm.getValue();
    if (!sql.trim()) { toast('Çalıştırılacak sorgu yok'); return; }
    if (!t.connId) { toast('Önce bir bağlantı seç', 'Araç çubuğundaki listeden ya da soldaki gezginden.'); document.getElementById('dbConnSel').focus(); return; }
    await execute(t, sql, offset, {});
  }
  async function execute(t, sql, offset, o) {
    const c = conn(t.connId); if (!c) return;
    t.running = true; t.started = Date.now(); t.offset = offset;
    clearErrLine(t);
    renderTabs(); renderBar(); renderStatus();
    clearInterval(tick); tick = setInterval(() => { const a = cur(); if (a && a.running) renderStatus(); }, 200);
    if (cur() === t) renderResults();
    const r = await inv('db:run', { tab: t.id, connId: t.connId, db: t.db, sql, confirmed: !!o.confirmed, password: o.password });
    t.running = false;
    if (!D.tabs.some(x => x.running)) clearInterval(tick);
    const settle = () => { renderTabs(); renderBar(); renderStatus(); if (cur() === t) renderResults(); };
    if (r.needPassword) {
      settle();
      const pw = await askPassword(c, r.loginFailed ? r.error : '');
      if (pw != null) return execute(t, sql, offset, { ...o, password: pw });
      return;
    }
    if (r.blocked) {
      settle();
      await modal({ title: 'Salt okunur bağlantı', icon: 'fa-lock', body: `<p><b>${esc(c.name || c.host)}</b> salt okunur olarak işaretli; şu ifadeler bu bağlantıda çalıştırılmaz:</p><p class="db-codes">${r.blocked.map(b => `<code>${esc(b)}</code>`).join(' ')}</p><p class="db-muted">Gerekirse bağlantı ayarlarından salt okunur işaretini kaldırabilirsin.</p>`, buttons: [['ok', 'Tamam', 'primary']] });
      return;
    }
    if (r.confirm) {
      settle();
      const ok = await modal({ title: 'Bu sorgu veri silebilir', icon: 'fa-triangle-exclamation', danger: true, body: `<p>Çalıştırmadan önce kontrol et:</p><ul class="db-risks">${r.confirm.map(x => `<li>${esc(x)}</li>`).join('')}</ul><p class="db-muted">Bağlantı: <b>${esc(c.name || c.host)}</b>${t.db ? ' · ' + esc(t.db) : ''}</p>`, buttons: [['cancel', 'Vazgeç'], ['ok', 'Yine de çalıştır', 'danger']], focus: 'cancel' });
      if (ok && ok.value === 'ok') return execute(t, sql, offset, { ...o, confirmed: true });
      return;
    }
    const old = t.results.map(x => x.id);
    if (old.length) inv('db:release', old);
    if (r.error) {
      t.results = []; t.messages = [{ type: 'error', text: r.error }]; t.ms = null; t.view = 'msg';
      if (r.loginFailed) { D.live[c.id] = { status: 'error', error: r.error }; renderTree(); }
    } else {
      t.results = (r.results || []).map(x => ({ ...x, shown: x.rows.length, sel: null, widths: null, scroll: 0 }));
      t.messages = r.messages || [];
      t.ms = r.ms;
      if (!D.live[c.id] || D.live[c.id].status !== 'ok') { D.live[c.id] = Object.assign(D.live[c.id] || {}, { status: 'ok' }); renderTree(); }
      if (r.currentDb && r.currentDb !== t.db) t.db = r.currentDb;
      const hasErr = t.messages.some(m => m.type === 'error');
      // errors and cancels are read in Messages; a clean run opens the first result set
      t.view = t.results.length && !hasErr && !r.cancelled ? 0 : 'msg';
      const em = t.messages.find(m => m.type === 'error' && m.line);
      if (em) markErrLine(t, em.line);
      if (D.history) loadHistory();
    }
    settle();
    saveState();
  }
  async function cancelRun() {
    const t = cur(); if (!t || !t.running) return;
    await inv('db:cancel', t.id);
    toast('İptal isteği gönderildi');
  }
  function markErrLine(t, line) {
    const l = Math.max(0, Math.min(t.doc.lastLine(), (t.offset || 0) + line - 1));
    t.errLine = t.doc.addLineClass(l, 'background', 'db-errline');
  }
  function clearErrLine(t) { if (t.errLine) { t.doc.removeLineClass(t.errLine, 'background', 'db-errline'); t.errLine = null; } }

  /* ---------------- results ---------------- */
  function renderResults() {
    const t = cur(), tabsEl = document.getElementById('dbRTabs'), body = document.getElementById('dbRBody');
    if (!t || !tabsEl) return;
    const errs = t.messages.filter(m => m.type === 'error').length;
    tabsEl.innerHTML = t.results.map((r, i) => `<button class="db-rtab${t.view === i ? ' on' : ''}" data-rview="${i}" role="tab"><i class="fa-solid fa-table-list"></i>Sonuç ${i + 1}<small>${fmtN(r.total)}</small></button>`).join('')
      + `<button class="db-rtab${t.view === 'msg' ? ' on' : ''}${errs ? ' err' : ''}" data-rview="msg" role="tab"><i class="fa-solid ${errs ? 'fa-circle-exclamation' : 'fa-message'}"></i>Mesajlar${t.messages.length ? `<small>${t.messages.length}</small>` : ''}</button>`
      + (t.page ? `<span class="db-pager"><button class="db-ib sm" data-page="-1" title="Önceki sayfa"${t.page.n ? '' : ' disabled'}><i class="fa-solid fa-chevron-left"></i></button><span>Sayfa ${t.page.n + 1}</span><button class="db-ib sm" data-page="1" title="Sonraki sayfa"${t.results[0] && t.results[0].total < t.page.size ? ' disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button><select data-pagesize title="Sayfa boyutu">${[50, 100, 500, 1000].map(n => `<option${n === t.page.size ? ' selected' : ''}>${n}</option>`).join('')}</select></span>` : '');
    if (t.running && !t.results.length) { body.innerHTML = '<div class="db-wait"><i class="fa-solid fa-spinner fa-spin"></i> Sorgu çalışıyor… <button class="btn" data-act="cancel">İptal et</button></div>'; return; }
    if (t.view === 'msg' || !t.results[t.view]) {
      if (!t.messages.length && t.ms == null) { body.innerHTML = `<div class="db-wait db-muted">Sorguyu yaz ve <kbd>Ctrl</kbd>+<kbd>Enter</kbd> ile çalıştır. Seçili bir kısım varsa yalnızca o çalışır.</div>`; return; }
      body.innerHTML = `<div class="db-msgs">${t.messages.map(m => `<div class="db-msg ${m.type}"${m.line ? ` data-line="${m.line}" title="Düzenleyicide satıra git"` : ''}><i class="fa-solid ${m.type === 'error' ? 'fa-circle-xmark' : m.type === 'rows' ? 'fa-check' : m.type === 'cancel' ? 'fa-ban' : m.type === 'ok' ? 'fa-check' : 'fa-circle-info'}"></i><span>${m.line ? `<b>Satır ${(t.offset || 0) + m.line}:</b> ` : ''}${esc(m.text)}</span></div>`).join('')}`
        + (t.ms != null ? `<div class="db-msg muted"><i class="fa-regular fa-clock"></i><span>Süre: ${fmtMs(t.ms)}${t.results.length ? ' · ' + t.results.length + ' sonuç kümesi' : ''}</span></div>` : '') + '</div>';
      return;
    }
    renderGrid(t, t.results[t.view], body);
  }

  /* virtual grid: only the visible rows are in the DOM */
  const NUMERIC = /int|dec|num|float|double|real|money|long|short|tiny|serial|oid|year/i;
  function colWidths(r) {
    const ctx = colWidths.c || (colWidths.c = document.createElement('canvas').getContext('2d'));
    ctx.font = '12px ' + (getComputedStyle(document.documentElement).getPropertyValue('--f-mono') || 'monospace');
    return r.columns.map((col, j) => {
      let w = ctx.measureText(col.name).width + 36;
      for (let i = 0; i < Math.min(r.rows.length, 150); i++) {
        const v = r.rows[i][j];
        const s = v === null ? 'NULL' : String(v).slice(0, 80);
        w = Math.max(w, ctx.measureText(s).width + 18);
      }
      return Math.round(Math.max(60, Math.min(420, w)));
    });
  }
  function cellHtml(v, num) {
    if (v === null || v === undefined) return '<span class="db-null">NULL</span>';
    if (typeof v === 'boolean') return `<span class="db-bool">${v ? 'true' : 'false'}</span>`;
    let s = String(v);
    if (s.length > 400) s = s.slice(0, 400) + '…';
    return esc(s.replace(/\r?\n/g, ' ↵ ').replace(/\t/g, ' '));
  }
  function renderGrid(t, r, body) {
    if (!r.widths) r.widths = colWidths(r);
    r.num = r.columns.map((c, j) => NUMERIC.test(c.type || '') || (r.rows[0] && typeof r.rows[0][j] === 'number'));
    const rnW = Math.max(44, String(r.shown).length * 8 + 22);
    const W = rnW + r.widths.reduce((a, b) => a + b, 0);
    const more = r.shown < r.fetched;
    body.innerHTML = `<div class="db-ginfo">
        <span><b>${fmtN(r.total)}</b> satır${r.shown < r.total ? ` · ilk <b>${fmtN(r.shown)}</b> gösteriliyor` : ''}${r.truncated ? ` · bellekte ${fmtN(r.fetched)} satır tutuldu (sınır)` : ''}</span>
        ${more ? `<button class="db-link" data-act="more">${fmtN(Math.min(SHOW_STEP, r.fetched - r.shown))} satır daha göster</button><button class="db-link" data-act="moreAll">Tümünü göster (${fmtN(r.fetched)})</button>` : ''}
        <span class="db-grow"></span>
        <span class="db-muted db-selinfo"></span>
        <button class="db-tb sm" data-act="copyAll" title="Görüntülenen tüm satırları başlıklarla kopyala (sekmeyle ayrılmış)"><i class="fa-regular fa-copy"></i>Kopyala</button>
        <button class="db-tb sm" data-act="csv" title="CSV olarak dışa aktar"><i class="fa-solid fa-file-csv"></i>CSV</button>
      </div>
      <div class="db-grid" tabindex="0" aria-label="Sonuç tablosu">
        <div class="db-gin" style="width:${W}px">
          <div class="db-gh"><div class="db-rn">#</div>${r.columns.map((c, j) => `<div class="db-hc${r.num[j] ? ' num' : ''}" data-col="${j}" style="width:${r.widths[j]}px" title="${esc(c.name)}${c.type ? ' (' + esc(c.type) + ')' : ''}"><span class="db-hn">${esc(c.name)}</span><span class="db-ht">${esc(c.type || '')}</span><i class="db-rz" data-rz="${j}"></i></div>`).join('')}</div>
          <div class="db-gb" style="height:${r.shown * RH}px"><div class="db-gw"></div></div>
        </div>
      </div>`;
    const grid = body.querySelector('.db-grid');
    grid.style.setProperty('--rn', rnW + 'px');
    grid._r = r; grid._t = t;
    grid.scrollTop = r.scroll || 0; grid.scrollLeft = r.scrollX || 0;
    paintRows(grid);
    grid.addEventListener('scroll', () => { r.scroll = grid.scrollTop; r.scrollX = grid.scrollLeft; if (!grid._raf) grid._raf = requestAnimationFrame(() => { grid._raf = 0; paintRows(grid); }); });
    updateSelInfo(grid);
  }
  function paintRows(grid) {
    const r = grid._r; if (!r) return;
    const top = Math.max(0, Math.floor(grid.scrollTop / RH) - 8);
    const n = Math.ceil((grid.clientHeight || 400) / RH) + 16;
    const end = Math.min(r.shown, top + n);
    const sel = r.sel;
    const out = [];
    for (let i = top; i < end; i++) {
      const row = r.rows[i]; if (!row) break;
      const rs = sel && i >= Math.min(sel.r0, sel.r1) && i <= Math.max(sel.r0, sel.r1);
      let cells = '';
      for (let j = 0; j < r.columns.length; j++) {
        const cs = rs && j >= Math.min(sel.c0, sel.c1) && j <= Math.max(sel.c0, sel.c1);
        cells += `<div class="db-c${r.num[j] ? ' num' : ''}${cs ? ' sel' : ''}" data-c="${j}" style="width:${r.widths[j]}px">${cellHtml(row[j])}</div>`;
      }
      out.push(`<div class="db-gr${rs ? ' rsel' : ''}${i % 2 ? ' odd' : ''}" data-r="${i}"><div class="db-rn">${i + 1}</div>${cells}</div>`);
    }
    const w = grid.querySelector('.db-gw');
    w.style.transform = `translateY(${top * RH}px)`;
    w.innerHTML = out.join('');
  }
  function updateSelInfo(grid) {
    const r = grid._r, el = grid.parentElement.querySelector('.db-selinfo'); if (!el) return;
    if (!r.sel) { el.textContent = ''; return; }
    const rows = Math.abs(r.sel.r1 - r.sel.r0) + 1, cols = Math.abs(r.sel.c1 - r.sel.c0) + 1;
    el.textContent = rows * cols > 1 ? `${fmtN(rows)} × ${fmtN(cols)} seçili` : `Satır ${r.sel.r0 + 1}, ${r.columns[r.sel.c0].name}`;
  }
  async function showMore(all) {
    const t = cur(), r = t && t.results[t.view]; if (!r) return;
    const want = all ? r.fetched : Math.min(r.fetched, r.shown + SHOW_STEP);
    while (r.rows.length < want) {
      const res = await inv('db:rows', r.id, r.rows.length, Math.min(20000, want - r.rows.length));
      if (res.error) { toast('Satırlar alınamadı', res.error); break; }
      if (!res.rows.length) break;
      for (const row of res.rows) r.rows.push(row);
    }
    r.shown = Math.min(want, r.rows.length);
    renderResults();
  }
  const cellText = v => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));
  const tsv = v => { const s = cellText(v); return /[\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function selRange(r) {
    const s = r.sel; if (!s) return null;
    return { r0: Math.min(s.r0, s.r1), r1: Math.max(s.r0, s.r1), c0: Math.min(s.c0, s.c1), c1: Math.max(s.c0, s.c1) };
  }
  function copyText(text, what) {
    navigator.clipboard.writeText(text).then(() => toast(what || 'Kopyalandı'), () => toast('Kopyalanamadı'));
  }
  function copySel(r, headers) {
    const s = selRange(r); if (!s) return;
    const lines = [];
    if (headers) lines.push(r.columns.slice(s.c0, s.c1 + 1).map(c => tsv(c.name)).join('\t'));
    for (let i = s.r0; i <= s.r1; i++) lines.push(r.rows[i].slice(s.c0, s.c1 + 1).map(tsv).join('\t'));
    const n = (s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1);
    copyText(n === 1 && !headers ? cellText(r.rows[s.r0][s.c0]) : lines.join('\r\n'), n === 1 ? 'Hücre kopyalandı' : `${fmtN(s.r1 - s.r0 + 1)} satır kopyalandı`);
  }
  function copyRowsJson(r) {
    const s = selRange(r); if (!s) return;
    const objs = [];
    for (let i = s.r0; i <= s.r1; i++) { const o = {}; r.columns.forEach((c, j) => { o[c.name] = r.rows[i][j]; }); objs.push(o); }
    copyText(JSON.stringify(objs.length === 1 ? objs[0] : objs, null, 2), 'JSON olarak kopyalandı');
  }
  function copyRowsInsert(r, t) {
    const s = selRange(r); if (!s) return;
    const c = conn(t.connId); const type = c ? c.type : 'pg';
    const lit = v => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (type === 'mssql' ? (v ? '1' : '0') : String(v).toUpperCase()) : `${type === 'mssql' ? 'N' : ''}'${String(v).replace(/'/g, "''")}'`);
    const cols = r.columns.map(x => qi(type, x.name)).join(', ');
    const out = [];
    for (let i = s.r0; i <= s.r1; i++) out.push(`INSERT INTO tablo (${cols}) VALUES (${r.rows[i].map(lit).join(', ')});`);
    copyText(out.join('\n'), 'INSERT olarak kopyalandı');
  }
  async function viewCell(r, i, j) {
    const v = r.rows[i][j];
    let s = cellText(v), pretty = '';
    if (typeof v === 'string' && /^\s*[[{]/.test(v)) { try { pretty = JSON.stringify(JSON.parse(v), null, 2); } catch (_) {} }
    const res = await modal({ title: r.columns[j].name, wide: true, body: `<div class="db-muted db-vmeta">${esc(r.columns[j].type || '')} · satır ${i + 1}${v === null ? ' · <b>NULL</b>' : ` · ${fmtN(s.length)} karakter`}</div><textarea class="db-val" readonly spellcheck="false">${esc(pretty || s)}</textarea>`, buttons: [['copy', 'Kopyala'], ['ok', 'Kapat', 'primary']] });
    if (res && res.value === 'copy') copyText(s, 'Değer kopyalandı');
  }
  async function exportCsv(sep) {
    const t = cur(), r = t && t.results[t.view]; if (!r) return;
    const res = await inv('db:exportCsv', r.id, { sep, name: t.title });
    if (res.canceled) return;
    if (res.error) { toast('Dışa aktarılamadı', res.error); return; }
    toast('CSV kaydedildi', `${fmtN(res.rows)} satır${res.truncated ? ` (toplam ${fmtN(res.total)}; bellek sınırı nedeniyle tamamı değil)` : ''} · ${res.file}`);
  }

  /* ---------------- modal dialogs ---------------- */
  let modalDone = null;
  function modal({ title, body, buttons, icon, danger, wide, focus, onOpen, onAction }) {
    const el = document.getElementById('dbModal');
    if (modalDone) modalDone(null);
    return new Promise(resolve => {
      el.innerHTML = `<form class="db-dlg${wide ? ' wide' : ''}${danger ? ' danger' : ''}" novalidate role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="db-dh">${icon ? `<i class="fa-solid ${icon}"></i>` : ''}<b>${esc(title)}</b><button type="button" class="db-ib" data-mb="cancel" aria-label="Kapat"><i class="fa-solid fa-xmark"></i></button></div>
        <div class="db-db">${body}</div>
        <div class="db-df">${(buttons || []).map(([v, l, k]) => `<button type="${k === 'primary' || k === 'danger' ? 'submit' : 'button'}" class="btn ${k === 'danger' ? 'db-bdanger' : k || ''}" data-mb="${v}">${esc(l)}</button>`).join('')}</div></form>`;
      el.hidden = false;
      const form = el.querySelector('form');
      const values = () => { const o = {}; form.querySelectorAll('[name]').forEach(x => { o[x.name] = x.type === 'checkbox' ? x.checked : x.value; }); return o; };
      const done = v => { if (modalDone !== done) return; modalDone = null; el.hidden = true; el.innerHTML = ''; resolve(v); };
      modalDone = done;
      form.addEventListener('submit', e => { e.preventDefault(); const b = form.querySelector('.db-df [type=submit]'); finish(b ? b.dataset.mb : 'ok'); });
      const finish = async v => {
        if (v === 'cancel') { done(null); return; }
        if (onAction) { const keep = await onAction(v, values(), form); if (keep) return; }
        done({ value: v, form: values() });
      };
      form.addEventListener('click', e => { const b = e.target.closest('[data-mb]'); if (b && b.type !== 'submit') { e.preventDefault(); finish(b.dataset.mb); } else if (b) { e.preventDefault(); finish(b.dataset.mb); } });
      form.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } });
      el.onmousedown = e => { if (e.target === el) done(null); };
      if (onOpen) onOpen(form);
      requestAnimationFrame(() => {
        const f = focus ? form.querySelector(`.db-df [data-mb="${focus}"]`) : form.querySelector('input:not([type=checkbox]):not([type=radio]),textarea,select') || form.querySelector('.db-df [type=submit]');
        if (f) { f.focus(); if (f.select && f.tagName === 'INPUT') f.select(); }
      });
    });
  }
  async function askPassword(c, err) {
    const r = await modal({
      title: 'Parola gerekli', icon: 'fa-key',
      body: `<p><b>${esc(c.name || c.host)}</b> (${esc(TYPE_NAME[c.type])}${c.user ? ' · ' + esc((c.domain ? c.domain + '\\' : '') + c.user) : ''})</p>${err ? `<p class="db-errbox">${esc(err)}</p>` : ''}<label class="db-f"><span>Parola</span><input type="password" name="pw" autocomplete="off"></label><p class="db-muted">Parola yalnızca bu oturum boyunca bellekte tutulur.</p>`,
      buttons: [['cancel', 'Vazgeç'], ['ok', 'Bağlan', 'primary']],
    });
    return r && r.value === 'ok' ? r.form.pw : null;
  }

  /* connection dialog: add / edit */
  async function editConn(id) {
    const c = id ? conn(id) : null;
    const v = c ? { ...c } : { type: 'mssql', host: 'localhost', port: '', auth: 'sql', ssl: true, trustCert: true, timeout: 15, color: '' };
    const sel = (a, b) => (a === b ? ' selected' : '');
    const chk = x => (x ? ' checked' : '');
    const body = `
      <div class="db-grid2">
        <label class="db-f full"><span>Ad</span><input name="name" value="${esc(v.name || '')}" placeholder="Örn. Üretim - Muhasebe" maxlength="80"></label>
        <div class="db-f full"><span>Tür</span><div class="db-typesel">${TYPES.map(([k, l]) => `<label><input type="radio" name="type" value="${k}"${chk(v.type === k)}><span>${l}</span></label>`).join('')}</div></div>
        <label class="db-f wide"><span>Sunucu</span><input name="host" value="${esc(v.host || '')}" placeholder="localhost, 10.0.0.5 ya da SUNUCU\\ÖRNEK" spellcheck="false"></label>
        <label class="db-f"><span>Port</span><input name="port" value="${esc(v.port || '')}" inputmode="numeric" placeholder="${DEF_PORT[v.type]}"></label>
        <label class="db-f full mssql-only"><span>Kimlik doğrulama</span><select name="auth"><option value="sql"${sel(v.auth, 'sql')}>SQL Server kimlik doğrulaması</option><option value="ntlm"${sel(v.auth, 'ntlm')}>Windows (NTLM: alan, kullanıcı ve parola)</option></select></label>
        <label class="db-f full ntlm-only"><span>Alan (domain)</span><input name="domain" value="${esc(v.domain || '')}" placeholder="ŞİRKET" spellcheck="false"></label>
        <label class="db-f"><span>Kullanıcı</span><input name="user" value="${esc(v.user || '')}" spellcheck="false" autocomplete="off"></label>
        <label class="db-f wide"><span>Parola</span><input type="password" name="pw" autocomplete="new-password" placeholder="${c && c.hasPassword ? 'Kayıtlı parola değişmez' : ''}"></label>
        <div class="db-f full db-row">
          <label class="db-ck"><input type="checkbox" name="askPassword"${chk(v.askPassword)}><span>Parolayı kaydetme, her bağlanışta sor</span></label>
          ${c && c.hasPassword ? '<button type="button" class="db-link" data-mb="clearPw">Kayıtlı parolayı sil</button>' : ''}
        </div>
        <label class="db-f full"><span>Varsayılan veritabanı</span><input name="database" value="${esc(v.database || '')}" placeholder="Boş bırakılırsa sunucunun varsayılanı" spellcheck="false"></label>
        <div class="db-f full"><span>Güvenlik</span>
          <label class="db-ck"><input type="checkbox" name="ssl"${chk(v.ssl)}><span class="mssql-only">Bağlantıyı şifrele (encrypt)</span><span class="other-only">SSL/TLS kullan</span></label>
          <label class="db-ck"><input type="checkbox" name="trustCert"${chk(v.trustCert)}><span class="mssql-only">Sunucu sertifikasına güven (trustServerCertificate)</span><span class="other-only">Sertifikayı doğrulama (kendinden imzalı sertifikalar için)</span></label>
          <label class="db-ck"><input type="checkbox" name="readOnly"${chk(v.readOnly)}><span><b>Salt okunur:</b> INSERT, UPDATE, DELETE, DROP gibi yazma ifadelerini engelle</span></label>
        </div>
        <label class="db-f"><span>Zaman aşımı (sn)</span><input name="timeout" value="${esc(v.timeout || 15)}" inputmode="numeric"></label>
        <div class="db-f wide"><span>Renk etiketi</span><div class="db-colors">${COLORS.map(([k, l]) => `<label title="${l}"><input type="radio" name="color" value="${k}"${chk((v.color || '') === k)}><i class="db-sw db-c-${k || 'none'}"></i></label>`).join('')}</div></div>
        <p class="db-note full mssql-only"><i class="fa-solid fa-circle-info"></i> Windows tümleşik kimlik doğrulaması (kullanıcı adı ve parola girmeden oturumdaki Windows kimliğiyle) yerel sürücü gerektirdiği için desteklenmiyor; alan hesabıyla bağlanmak için NTLM seçeneğini kullan.</p>
        ${D.canEncrypt ? '' : '<p class="db-note full warn"><i class="fa-solid fa-triangle-exclamation"></i> Windows şifreleme hizmeti kullanılamıyor; parolalar diske yazılmaz, her açılışta sorulur.</p>'}
        <div class="db-test full" id="dbTestOut" hidden></div>
      </div>`;
    let clearPw = false;
    const sync = form => {
      const type = form.querySelector('[name=type]:checked').value;
      form.classList.toggle('t-mssql', type === 'mssql');
      form.classList.toggle('a-ntlm', type === 'mssql' && form.querySelector('[name=auth]').value === 'ntlm');
      form.querySelector('[name=port]').placeholder = DEF_PORT[type];
    };
    const draft = f => ({ id: c ? c.id : undefined, name: f.name, type: f.type, host: f.host, port: f.port, user: f.user, database: f.database, auth: f.auth, domain: f.domain, ssl: f.ssl, trustCert: f.trustCert, readOnly: f.readOnly, color: f.color, askPassword: f.askPassword, timeout: f.timeout });
    const r = await modal({
      title: c ? 'Bağlantıyı düzenle' : 'Yeni bağlantı', icon: 'fa-plug', wide: true, body,
      buttons: [['test', 'Bağlantıyı test et'], ['cancel', 'Vazgeç'], ['ok', 'Kaydet', 'primary']],
      onOpen: form => { sync(form); form.addEventListener('change', () => sync(form)); },
      onAction: async (act, f, form) => {
        if (act === 'clearPw') { clearPw = true; form.querySelector('[name=pw]').placeholder = 'Kayıtlı parola kaydedilince silinecek'; return true; }
        if (act === 'test') {
          const out = form.querySelector('#dbTestOut');
          out.hidden = false; out.className = 'db-test full'; out.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Bağlanılıyor…';
          const res = await inv('db:test', draft(f), f.pw ? f.pw : clearPw ? '' : undefined);
          out.className = 'db-test full ' + (res.ok ? 'ok' : 'bad');
          out.innerHTML = res.ok ? `<i class="fa-solid fa-circle-check"></i> Bağlantı başarılı (${fmtMs(res.ms)})<small>${esc(res.version || '')}</small>` : `<i class="fa-solid fa-circle-xmark"></i> ${esc(res.error || 'Bağlanılamadı')}`;
          out.scrollIntoView({ block: 'nearest' });
          return true;
        }
        if (act === 'ok') {
          if (!f.host.trim()) { form.querySelector('[name=host]').focus(); return true; }
          const pw = f.pw ? f.pw : clearPw ? null : c ? undefined : '';
          const res = await inv('db:save', draft(f), pw);
          if (res.error) { toast('Kaydedilemedi', res.error); return true; }
          if (res.warning) toast('Parola kaydedilmedi', res.warning);
          f.savedId = res.connection.id;
          form.dataset.saved = res.connection.id;
          return false;
        }
        return false;
      },
    });
    if (!r || r.value !== 'ok') return;
    await loadConns();
    const id2 = c ? c.id : D.conns[D.conns.length - 1] && D.conns[D.conns.length - 1].id;
    if (c) await disconnect(c.id); // settings changed: reconnect fresh
    renderTree(); renderTabs(); renderBar(); renderStatus();
    const t = cur();
    if (!c && t && !t.connId && id2) setTabConn(t, id2);
    else if (id2) connect(id2, true);
  }
  async function deleteConn(id) {
    const c = conn(id); if (!c) return;
    const r = await modal({ title: 'Bağlantıyı sil', icon: 'fa-trash', danger: true, body: `<p><b>${esc(c.name || c.host)}</b> bağlantısı ve kayıtlı parolası silinsin mi? Sunucudaki verilere dokunulmaz.</p>`, buttons: [['cancel', 'Vazgeç'], ['ok', 'Sil', 'danger']], focus: 'cancel' });
    if (!r) return;
    await disconnect(id);
    await inv('db:delete', id);
    await loadConns();
    for (const t of D.tabs) if (t.connId === id) t.connId = '';
    renderTree(); renderTabs(); renderBar(); renderStatus();
  }
  async function duplicateConn(id) {
    const r = await inv('db:duplicate', id);
    if (r.error) { toast('Çoğaltılamadı', r.error); return; }
    await loadConns(); renderConn();
    editConn(r.connection.id);
  }

  /* ---------------- context menus ---------------- */
  function menu(x, y, items) {
    const el = document.getElementById('dbCtx');
    el.innerHTML = items.map(it => (it === '-' ? '<div class="db-sep"></div>' : `<button role="menuitem" data-mi="${it[0]}"${it[3] ? ' disabled' : ''}><i class="fa-solid ${it[2] || 'fa-blank'}"></i><span>${esc(it[1])}</span>${it[4] ? `<kbd>${esc(it[4])}</kbd>` : ''}</button>`)).join('');
    el.hidden = false;
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(4, Math.min(x, innerWidth - w - 6)) + 'px';
    el.style.top = Math.max(4, Math.min(y, innerHeight - h - 6)) + 'px';
    return new Promise(resolve => {
      const off = () => { el.hidden = true; document.removeEventListener('mousedown', out, true); document.removeEventListener('keydown', key, true); window.removeEventListener('blur', blur); };
      const out = e => { if (!el.contains(e.target)) { off(); resolve(null); } };
      const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); off(); resolve(null); } };
      const blur = () => { off(); resolve(null); };
      el.onclick = e => { const b = e.target.closest('[data-mi]'); if (!b || b.disabled) return; off(); resolve(b.dataset.mi); };
      setTimeout(() => { document.addEventListener('mousedown', out, true); document.addEventListener('keydown', key, true); window.addEventListener('blur', blur); });
      const first = el.querySelector('button:not([disabled])'); if (first) first.focus();
    });
  }
  async function columnsOf(n) {
    const key = `o:${n.id}:${enc(n.db)}:${enc(n.schema)}:${n.kind}:${enc(n.name)}`;
    if (!D.kids[key] || !D.kids[key].items) await loadKids(key);
    return (D.kids[key] && D.kids[key].items) || [];
  }
  async function nodeMenu(key, e) {
    const n = parseKey(key), c = conn(n.id); if (!c) return;
    const live = D.live[n.id];
    let items;
    if (n.t === 'c') {
      items = [
        live && live.status === 'ok' ? ['disconnect', 'Bağlantıyı kes', 'fa-plug-circle-xmark'] : ['connect', 'Bağlan', 'fa-plug'],
        ['newq', 'Yeni sorgu', 'fa-file-circle-plus'],
        ['refresh', 'Yenile', 'fa-rotate-right', !(live && live.status === 'ok')],
        '-',
        ['edit', 'Düzenle…', 'fa-pen'], ['dup', 'Çoğalt', 'fa-clone'], ['del', 'Sil…', 'fa-trash'],
      ];
    } else if (n.t === 'd') items = [['newq', 'Bu veritabanında yeni sorgu', 'fa-file-circle-plus'], ['refresh', 'Yenile', 'fa-rotate-right'], '-', ['copy', 'Adı kopyala', 'fa-copy']];
    else if (n.t === 's') items = [['newq', 'Yeni sorgu', 'fa-file-circle-plus'], ['copy', 'Adı kopyala', 'fa-copy']];
    else if (n.t === 'k') items = [['refresh', 'Yenile', 'fa-rotate-right']];
    else if (n.t === 'o' && key.split(':').length > 6) items = [['copycol', 'Sütun adını kopyala', 'fa-copy'], ['insertcol', 'Düzenleyiciye ekle', 'fa-i-cursor']];
    else if (n.kind === 'tables' || n.kind === 'views') {
      items = [
        ['top', 'İlk 100 satırı göster', 'fa-table-list'], ['pages', 'Verileri sayfa sayfa gez', 'fa-book-open'],
        '-', ['sel', 'SELECT şablonu', 'fa-magnifying-glass'], ...(n.kind === 'tables' ? [['ins', 'INSERT şablonu', 'fa-plus']] : []), ['count', 'Satırları say', 'fa-hashtag'],
        ...((n.kind === 'views' || isMy(c.type)) ? [['def', 'Tanımı göster', 'fa-code']] : []),
        '-', ['copy', 'Adı kopyala', 'fa-copy'], ['copyfull', 'Tam adı kopyala', 'fa-copy'], ['claude', "Claude'a sor (şemasıyla)", 'fa-robot'], ['refresh', 'Sütunları yenile', 'fa-rotate-right'],
      ];
    } else items = [['def', 'Tanımı göster', 'fa-code'], ['exec', n.kind === 'procs' ? 'Çalıştırma şablonu' : 'Çağırma şablonu', 'fa-play'], '-', ['copy', 'Adı kopyala', 'fa-copy'], ['copyfull', 'Tam adı kopyala', 'fa-copy']];
    const a = await menu(e.clientX, e.clientY, items);
    if (a) nodeAction(a, key);
  }
  async function nodeAction(a, key) {
    const n = parseKey(key), c = conn(n.id); if (!c) return;
    const db = n.db || '';
    const title = n.name || n.schema || n.db || c.name || c.host;
    const obj = { ...n };
    switch (a) {
      case 'connect': await connect(n.id); break;
      case 'disconnect': await disconnect(n.id); break;
      case 'refresh':
        if (n.t === 'c') await loadKids(key, true);
        else { delete D.kids[key]; for (const k of Object.keys(D.hints)) if (k.startsWith(n.id + '|')) delete D.hints[k]; D.open.add(key); await loadKids(key, true); }
        break;
      case 'edit': editConn(n.id); break;
      case 'dup': duplicateConn(n.id); break;
      case 'del': deleteConn(n.id); break;
      case 'newq': { const t = addTab({ connId: n.id, db: db || undefined, silent: true }); activateTab(t.id); break; }
      case 'copy': copyText(n.t === 'd' ? n.db : n.t === 's' ? n.schema : n.name, 'Ad kopyalandı'); break;
      case 'copyfull': copyText(full(c.type, obj), 'Tam ad kopyalandı'); break;
      case 'copycol': copyText(dec(key.split(':')[6]), 'Sütun adı kopyalandı'); break;
      case 'insertcol': cm.replaceSelection(qi(c.type, dec(key.split(':')[6]))); cm.focus(); break;
      case 'top': { const t = tabFor(n.id, db, n.name); t.doc.setValue(topSql(c.type, obj)); await execute(t, t.doc.getValue(), 0, {}); break; }
      case 'pages': {
        const t = tabFor(n.id, db, n.name);
        t.page = { full: full(c.type, obj), n: 0, size: 100 };
        await runPage(t);
        break;
      }
      case 'count': { const t = tabFor(n.id, db, n.name); t.doc.setValue(`SELECT COUNT(*) AS satir_sayisi\nFROM ${full(c.type, obj)};`); await execute(t, t.doc.getValue(), 0, {}); break; }
      case 'sel': { const cols = await columnsOf(obj); insertOrOpen(selectSql(c.type, obj, cols), n.id, db, n.name); break; }
      case 'ins': { const cols = await columnsOf(obj); insertOrOpen(insertSql(c.type, obj, cols), n.id, db, n.name); break; }
      case 'exec': insertOrOpen(execSql(c.type, obj), n.id, db, n.name); break;
      case 'def': {
        const r = await inv('db:explore', n.id, 'definition', { db, schema: n.schema, name: n.name, kind: n.kind });
        if (r.error) { toast('Tanım alınamadı', r.error); break; }
        if (!r.items) { toast('Tanım yok', 'Nesnenin tanımı okunamadı (şifrelenmiş ya da yetki yok).'); break; }
        openSql(String(r.items), n.id, db, n.name);
        break;
      }
      case 'claude': {
        const cols = await columnsOf(obj);
        const schema = `${n.kind === 'views' ? 'Görünüm' : 'Tablo'} ${full(c.type, obj)} sütunları:\n` + cols.map(x => `- ${x.name} ${x.type}${x.pk ? ' PRIMARY KEY' : ''}${x.nullable ? '' : ' NOT NULL'}${x.ident ? ' (otomatik artan)' : ''}`).join('\n');
        askClaude({ schema, connId: n.id, db, sql: '' });
        break;
      }
    }
  }
  // a template goes to the cursor when the editor is on the same connection, else to a new tab
  function insertOrOpen(sql, connId, db, title) {
    const t = cur();
    if (t && t.connId === connId && (!db || t.db === db || !t.db) && t.doc.getValue().trim()) {
      const p = cm.getCursor();
      const pre = cm.getLine(p.line).trim() ? '\n\n' : '';
      cm.replaceSelection(pre + sql);
      cm.focus();
      return;
    }
    openSql(sql, connId, db, title);
    cm.focus();
  }
  async function runPage(t) {
    const c = conn(t.connId); if (!c || !t.page) return;
    t.doc.setValue(pageSql(c.type, t.page.full, t.page.n, t.page.size));
    t.pageEdited = false;
    await execute(t, t.doc.getValue(), 0, {});
  }

  /* ---------------- Claude ---------------- */
  async function askClaude(o = {}) {
    const t = cur(); const c = conn(o.connId || (t && t.connId));
    const sql = o.sql != null ? o.sql : (cm.somethingSelected() ? cm.getSelection() : cm.getValue()).trim();
    const err = !o.schema && t ? (t.messages.find(m => m.type === 'error') || {}).text : '';
    if (!S.projects.length) { toast('Önce bir proje ekle', "Claude oturumları bir proje klasöründe açılır; AI modunda Proje Başlat'tan ekleyebilirsin."); return; }
    const activeTab = S.tabs.find(x => x.id === S.active);
    const defProj = (activeTab && activeTab.projectId) || S.projects[0].id;
    const presets = o.schema ? ['Bu tablo için sık kullanılacak örnek sorgular yaz', 'Bu tablonun yapısını değerlendir; indeks ve tip önerilerin neler?'] : err ? ['Bu hatayı açıkla ve sorguyu düzelt', 'Bu sorguyu açıkla'] : ['Bu sorguyu açıkla', 'Bu sorgunun performansını nasıl iyileştirebilirim?', 'Bu sorguda hata ya da risk var mı?'];
    const r = await modal({
      title: "Claude'a sor", icon: 'fa-robot', wide: true,
      body: `<div class="db-presets">${presets.map(p => `<button type="button" class="db-chipbtn" data-preset="${esc(p)}">${esc(p)}</button>`).join('')}</div>
        <label class="db-f"><span>Soru</span><textarea name="q" rows="3" placeholder="Claude'a ne sormak istersin?">${esc(presets[0])}</textarea></label>
        <label class="db-f"><span>Proje (Claude bu klasörde açılır)</span><select name="proj">${S.projects.map(p => `<option value="${esc(p.id)}"${p.id === defProj ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <p class="db-muted">${sql ? `Gönderilecek: ${o.schema ? 'tablo şeması' : `${fmtN(sql.split('\n').length)} satır SQL`}${err ? ' ve son hata mesajı' : ''}, veritabanı türü. Parola ve bağlantı bilgisi gönderilmez.` : o.schema ? 'Gönderilecek: tablo şeması ve veritabanı türü. Parola ve bağlantı bilgisi gönderilmez.' : 'Düzenleyici boş; yalnızca sorunu gönderirsin.'}</p>`,
      buttons: [['cancel', 'Vazgeç'], ['ok', 'Yeni Claude oturumunda sor', 'primary']],
      onOpen: form => form.addEventListener('click', e => { const b = e.target.closest('[data-preset]'); if (b) { const ta = form.querySelector('[name=q]'); ta.value = b.dataset.preset; ta.focus(); } }),
    });
    if (!r || r.value !== 'ok') return;
    const parts = [r.form.q.trim() || presets[0]];
    if (c) parts.push(`Veritabanı: ${TYPE_NAME[c.type]}${(o.db || (t && t.db)) ? ` (veritabanı: ${o.db || t.db})` : ''}${c.readOnly ? ', salt okunur bağlantı' : ''}.`);
    if (o.schema) parts.push(o.schema);
    if (sql) parts.push('SQL:\n```sql\n' + sql.slice(0, 20000) + '\n```');
    if (err) parts.push('Aldığım hata:\n' + err.slice(0, 2000));
    parts.push('Not: Veritabanına bağlanmaya ya da sorgu çalıştırmaya çalışma; yanıtını ve önerdiğin SQL\'i buraya yaz, ben VoxStorm\'un DB modunda çalıştıracağım.');
    const prompt = parts.join('\n\n');
    setMode('claude');
    const tt = await openTerminal({ kind: 'claude', projectId: r.form.proj, title: 'DB: ' + (o.schema ? 'şema' : 'sorgu') });
    if (!tt) return;
    // bracketed paste keeps the newlines inside Claude Code's input box instead of submitting early
    tt.pendingPrompt = '\x1b[200~' + prompt + '\x1b[201~';
    setTimeout(() => sendPendingPrompt(tt), 12000);
  }

  /* ---------------- splitters ---------------- */
  function applyUi() {
    const side = document.getElementById('dbSide');
    side.style.width = Math.max(180, Math.min(560, D.ui.sideW)) + 'px';
    const ed = document.getElementById('dbEd');
    ed.style.flexBasis = (Math.max(0.12, Math.min(0.85, D.ui.edH)) * 100) + '%';
  }
  function drag(kind, e) {
    e.preventDefault();
    const main = view.querySelector('.db-main');
    const mv = ev => {
      if (kind === 'side') D.ui.sideW = Math.max(180, Math.min(560, ev.clientX - view.getBoundingClientRect().left));
      else { const r = main.getBoundingClientRect(); const top = document.getElementById('dbEd').getBoundingClientRect().top; D.ui.edH = Math.max(0.12, Math.min(0.85, (ev.clientY - top) / (r.bottom - top))); }
      applyUi(); cm.refresh();
    };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); document.body.classList.remove('db-dragging'); saveState(); const g = view.querySelector('.db-grid'); if (g) paintRows(g); };
    document.body.classList.add('db-dragging');
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }
  function resizeCol(e, j) {
    e.preventDefault(); e.stopPropagation();
    const grid = e.target.closest('.db-grid'), r = grid._r;
    const x0 = e.clientX, w0 = r.widths[j];
    const mv = ev => { r.widths[j] = Math.max(40, Math.min(1600, w0 + ev.clientX - x0)); applyWidths(grid); };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); document.body.classList.remove('db-dragging-x'); };
    document.body.classList.add('db-dragging-x');
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  }
  function applyWidths(grid) {
    const r = grid._r;
    const rn = parseInt(grid.style.getPropertyValue('--rn'), 10) || 44;
    grid.querySelector('.db-gin').style.width = rn + r.widths.reduce((a, b) => a + b, 0) + 'px';
    grid.querySelectorAll('.db-hc').forEach(h => { h.style.width = r.widths[+h.dataset.col] + 'px'; });
    paintRows(grid);
  }
  function autoFit(grid, j) {
    const r = grid._r;
    const ctx = colWidths.c; ctx.font = '12px ' + (getComputedStyle(document.documentElement).getPropertyValue('--f-mono') || 'monospace');
    let w = ctx.measureText(r.columns[j].name).width + 36;
    for (let i = 0; i < Math.min(r.rows.length, 2000); i++) { const v = r.rows[i][j]; w = Math.max(w, ctx.measureText(v === null ? 'NULL' : String(v).slice(0, 200)).width + 18); }
    r.widths[j] = Math.round(Math.min(900, w));
    applyWidths(grid);
  }

  /* ---------------- events ---------------- */
  function bind() {
    view.addEventListener('click', async e => {
      const a = e.target.closest('[data-act]');
      if (a) {
        const act = a.dataset.act;
        if (act === 'newConn') editConn();
        else if (act === 'run') run('auto');
        else if (act === 'runStmt') run('stmt');
        else if (act === 'cancel') cancelRun();
        else if (act === 'newTab') { const t = cur(); addTab({ connId: t && t.connId, db: t && t.db }); }
        else if (act === 'saveQuery') saveQuery();
        else if (act === 'claude') askClaude();
        else if (act === 'more') showMore(false);
        else if (act === 'moreAll') showMore(true);
        else if (act === 'csv') { const m = await menu(e.clientX, e.clientY, [['c', 'CSV (virgülle ayrılmış)', 'fa-file-csv'], ['s', 'CSV (noktalı virgül, Türkçe Excel için)', 'fa-file-excel'], ['t', 'TSV (sekmeyle ayrılmış)', 'fa-file-lines']]); if (m) exportCsv(m === 's' ? ';' : m === 't' ? '\t' : ','); }
        else if (act === 'copyAll') { const t = cur(), r = t.results[t.view]; if (r) { const s = r.sel; r.sel = { r0: 0, r1: r.shown - 1, c0: 0, c1: r.columns.length - 1 }; copySel(r, true); r.sel = s; } }
        else if (act === 'clearHistory') { const ok = await modal({ title: 'Geçmişi temizle', body: '<p>Tüm sorgu geçmişi silinsin mi?</p>', buttons: [['cancel', 'Vazgeç'], ['ok', 'Temizle', 'danger']], focus: 'cancel' }); if (ok) { await inv('db:historyClear'); loadHistory(); } }
        else if (act === 'clearFilter') { const f = document.getElementById('dbFilter'); f.value = ''; f.dispatchEvent(new Event('input')); f.focus(); }
        return;
      }
      const sb = e.target.closest('[data-side]'); if (sb) { setSide(sb.dataset.side); return; }
      const cl = e.target.closest('[data-close]'); if (cl) { e.stopPropagation(); closeTab(cl.dataset.close); return; }
      const tb = e.target.closest('[data-tab]'); if (tb) { activateTab(tb.dataset.tab); return; }
      const rv = e.target.closest('[data-rview]'); if (rv) { const t = cur(); t.view = rv.dataset.rview === 'msg' ? 'msg' : +rv.dataset.rview; renderResults(); return; }
      const pg = e.target.closest('[data-page]'); if (pg) { const t = cur(); if (t.page) { t.page.n = Math.max(0, t.page.n + +pg.dataset.page); runPage(t); } return; }
      const ml = e.target.closest('.db-msg[data-line]'); if (ml) { const t = cur(); const l = (t.offset || 0) + +ml.dataset.line - 1; cm.setCursor({ line: l, ch: 0 }); cm.scrollIntoView({ line: l, ch: 0 }, 80); cm.focus(); return; }
      const node = e.target.closest('.db-node[data-key]');
      if (node && e.detail === 1) {
        const key = node.dataset.key, n = parseKey(key);
        selectNode(node);
        const leaf = (n.t === 'o' && (key.split(':').length > 6 || n.kind === 'procs' || n.kind === 'funcs'));
        if (!leaf) toggle(key);
        return;
      }
      const hi = e.target.closest('[data-hist]'); if (hi) { selectNode(hi); return; }
      const si = e.target.closest('[data-saved]'); if (si) { const q = D.saved.find(x => x.id === si.dataset.saved); if (q) { const ex = D.tabs.find(t => t.savedId === q.id); if (ex) activateTab(ex.id); else openSql(q.sql, conn(q.connId) ? q.connId : '', q.db, q.name, q.id); } return; }
    });
    view.addEventListener('dblclick', e => {
      const node = e.target.closest('.db-node[data-key]');
      if (node) {
        const key = node.dataset.key, n = parseKey(key);
        if (n.t === 'o' && key.split(':').length > 6) nodeAction('insertcol', key);
        else if (n.t === 'o' && (n.kind === 'tables' || n.kind === 'views')) { toggle(key); nodeAction('top', key); }
        else if (n.t === 'o') nodeAction('def', key);
        return;
      }
      const hi = e.target.closest('[data-hist]'); if (hi) { const h = D.history.find(x => x.id === hi.dataset.hist); if (h) openSql(h.sql, conn(h.connId) ? h.connId : '', h.db, 'Geçmişten'); return; }
      const tb = e.target.closest('[data-tab]');
      if (tb && !e.target.closest('[data-close]')) { renameTab(tb.dataset.tab); return; }
      const cell = e.target.closest('.db-c'); if (cell) { const grid = cell.closest('.db-grid'); viewCell(grid._r, +cell.parentElement.dataset.r, +cell.dataset.c); return; }
      const rz = e.target.closest('[data-rz]'); if (rz) { autoFit(rz.closest('.db-grid'), +rz.dataset.rz); }
    });
    view.addEventListener('auxclick', e => { if (e.button === 1) { const tb = e.target.closest('[data-tab]'); if (tb) closeTab(tb.dataset.tab); } });
    view.addEventListener('contextmenu', async e => {
      const node = e.target.closest('.db-node[data-key]');
      if (node) { e.preventDefault(); selectNode(node); nodeMenu(node.dataset.key, e); return; }
      const hi = e.target.closest('[data-hist]');
      if (hi) {
        e.preventDefault(); const h = D.history.find(x => x.id === hi.dataset.hist); if (!h) return;
        const a = await menu(e.clientX, e.clientY, [['open', 'Yeni sekmede aç', 'fa-file-circle-plus'], ['insert', 'Düzenleyiciye ekle', 'fa-i-cursor'], ['copy', 'Kopyala', 'fa-copy']]);
        if (a === 'open') openSql(h.sql, conn(h.connId) ? h.connId : '', h.db, 'Geçmişten');
        else if (a === 'insert') { cm.replaceSelection(h.sql); cm.focus(); } else if (a === 'copy') copyText(h.sql, 'Sorgu kopyalandı');
        return;
      }
      const si = e.target.closest('[data-saved]');
      if (si) {
        e.preventDefault(); const q = D.saved.find(x => x.id === si.dataset.saved); if (!q) return;
        const a = await menu(e.clientX, e.clientY, [['open', 'Aç', 'fa-folder-open'], ['rename', 'Yeniden adlandır…', 'fa-pen'], ['copy', 'Kopyala', 'fa-copy'], '-', ['del', 'Sil', 'fa-trash']]);
        if (a === 'open') openSql(q.sql, conn(q.connId) ? q.connId : '', q.db, q.name, q.id);
        else if (a === 'copy') copyText(q.sql, 'Sorgu kopyalandı');
        else if (a === 'rename') { const r = await modal({ title: 'Yeniden adlandır', body: `<label class="db-f"><span>Ad</span><input name="name" value="${esc(q.name)}" maxlength="120"></label>`, buttons: [['cancel', 'Vazgeç'], ['ok', 'Kaydet', 'primary']] }); if (r) { await inv('db:savedSave', { ...q, name: r.form.name }); D.tabs.forEach(t => { if (t.savedId === q.id) t.title = r.form.name.trim() || t.title; }); renderTabs(); loadSaved(); } }
        else if (a === 'del') { await inv('db:savedDelete', q.id); D.tabs.forEach(t => { if (t.savedId === q.id) t.savedId = ''; }); loadSaved(); renderTabs(); }
        return;
      }
      const tb = e.target.closest('[data-tab]');
      if (tb) {
        e.preventDefault();
        const id = tb.dataset.tab;
        const a = await menu(e.clientX, e.clientY, [['rename', 'Yeniden adlandır…', 'fa-pen'], ['dup', 'Sekmeyi çoğalt', 'fa-clone'], '-', ['close', 'Kapat', 'fa-xmark', false, 'Ctrl+W'], ['others', 'Diğerlerini kapat', 'fa-xmark']]);
        if (a === 'rename') renameTab(id);
        else if (a === 'dup') { const t = D.tabs.find(x => x.id === id); addTab({ connId: t.connId, db: t.db, sql: t.doc.getValue(), title: t.title + ' (kopya)' }); }
        else if (a === 'close') closeTab(id);
        else if (a === 'others') for (const t of [...D.tabs]) if (t.id !== id) await closeTab(t.id);
        return;
      }
      const cell = e.target.closest('.db-c');
      if (cell) {
        e.preventDefault();
        const grid = cell.closest('.db-grid'), r = grid._r, i = +cell.parentElement.dataset.r, j = +cell.dataset.c;
        const s = selRange(r);
        if (!s || i < s.r0 || i > s.r1 || j < s.c0 || j > s.c1) { r.sel = { r0: i, r1: i, c0: j, c1: j }; paintRows(grid); updateSelInfo(grid); }
        const a = await menu(e.clientX, e.clientY, [
          ['cell', 'Kopyala', 'fa-copy', false, 'Ctrl+C'], ['cellh', 'Başlıklarla kopyala', 'fa-copy'], ['row', 'Satırları kopyala', 'fa-grip-lines'], ['json', 'JSON olarak kopyala', 'fa-code'], ['ins', 'INSERT olarak kopyala', 'fa-plus'],
          '-', ['view', 'Değeri görüntüle', 'fa-expand'], ['col', 'Sütun adını kopyala', 'fa-heading'], ['fit', 'Sütunu sığdır', 'fa-arrows-left-right'],
        ]);
        if (a === 'cell') copySel(r, false);
        else if (a === 'cellh') copySel(r, true);
        else if (a === 'row') { const sv = r.sel, x = selRange(r); r.sel = { r0: x.r0, r1: x.r1, c0: 0, c1: r.columns.length - 1 }; copySel(r, false); r.sel = sv; }
        else if (a === 'json') { const sv = r.sel, x = selRange(r); r.sel = { r0: x.r0, r1: x.r1, c0: 0, c1: r.columns.length - 1 }; copyRowsJson(r); r.sel = sv; }
        else if (a === 'ins') { const sv = r.sel, x = selRange(r); r.sel = { r0: x.r0, r1: x.r1, c0: 0, c1: r.columns.length - 1 }; copyRowsInsert(r, grid._t); r.sel = sv; }
        else if (a === 'view') viewCell(r, i, j);
        else if (a === 'col') copyText(r.columns[j].name, 'Sütun adı kopyalandı');
        else if (a === 'fit') autoFit(grid, j);
      }
    });
    view.addEventListener('mousedown', e => {
      const d = e.target.closest('[data-drag]'); if (d) { drag(d.dataset.drag, e); return; }
      const rz = e.target.closest('[data-rz]'); if (rz && e.detail === 1) { resizeCol(e, +rz.dataset.rz); return; }
      if (e.button !== 0) return;
      const grid = e.target.closest('.db-grid'); if (!grid || !grid._r) return;
      const r = grid._r;
      const hc = e.target.closest('.db-hc');
      if (hc) { const j = +hc.dataset.col; r.sel = e.shiftKey && r.sel ? { ...r.sel, c1: j, r0: 0, r1: r.shown - 1 } : { r0: 0, r1: r.shown - 1, c0: j, c1: j }; paintRows(grid); updateSelInfo(grid); return; }
      const row = e.target.closest('.db-gr'); if (!row) return;
      const i = +row.dataset.r;
      const cellEl = e.target.closest('.db-c');
      if (!cellEl) { r.sel = e.shiftKey && r.sel ? { ...r.sel, r1: i, c0: 0, c1: r.columns.length - 1 } : { r0: i, r1: i, c0: 0, c1: r.columns.length - 1 }; }
      else { const j = +cellEl.dataset.c; r.sel = e.shiftKey && r.sel ? { ...r.sel, r1: i, c1: j } : { r0: i, r1: i, c0: j, c1: j }; }
      paintRows(grid); updateSelInfo(grid);
      grid.focus({ preventScroll: true });
    });
    view.addEventListener('keydown', e => {
      const grid = e.target.closest && e.target.closest('.db-grid');
      if (grid && grid._r) gridKey(grid, e);
      const tree = e.target.closest && e.target.closest('#dbTree');
      if (tree) treeKey(e);
    });
    view.addEventListener('change', e => {
      const t = cur(); if (!t) return;
      if (e.target.id === 'dbConnSel') { setTabConn(t, e.target.value); return; }
      if (e.target.id === 'dbDbSel') { t.db = e.target.value; renderTabs(); renderStatus(); saveState(); cm.focus(); return; }
      if (e.target.matches('[data-pagesize]')) { if (t.page) { t.page.size = +e.target.value; t.page.n = 0; runPage(t); } }
    });
    view.addEventListener('focusin', e => {
      if (e.target.id === 'dbDbSel') { const t = cur(), c = t && conn(t.connId); if (c && (!D.live[c.id] || D.live[c.id].status !== 'ok')) connect(c.id, false).then(() => renderBar()); }
    });
    const f = view.querySelector('#dbFilter');
    f.addEventListener('input', () => {
      D.filter = f.value;
      view.querySelector('[data-act="clearFilter"]').hidden = !f.value;
      if (D.side === 'tree') renderTree(); else if (D.side === 'history') renderHistory(); else renderSaved();
    });
    f.addEventListener('keydown', e => { if (e.key === 'Escape' && f.value) { e.stopPropagation(); f.value = ''; f.dispatchEvent(new Event('input')); } if (e.key === 'ArrowDown') { e.preventDefault(); const first = view.querySelector(`#${D.side === 'tree' ? 'dbTree' : D.side === 'history' ? 'dbHist' : 'dbSaved'} .db-node[data-key], #dbHist [data-hist], #dbSaved [data-saved]`); if (first) { selectNode(first); first.closest('.db-list').focus(); } } });
    // shortcuts while DB mode is on (capture: before CodeMirror and the grid)
    window.addEventListener('keydown', e => {
      if (S.mode !== 'db' || !D.built) return;
      if (!document.getElementById('dbModal').hidden) return;
      if (document.querySelector('#settings:not([hidden]),#report:not([hidden]),#discover:not([hidden])')) return;
      const k = (e.ctrlKey ? 'C' : '') + (e.shiftKey ? 'S' : '') + (e.altKey ? 'A' : '') + '+' + e.key;
      const map = {
        '+F5': () => run('auto'), 'S+F5': () => cancelRun(), 'C+Enter': () => run('auto'), 'CS+Enter': () => run('stmt'),
        'C+t': () => { const t = cur(); addTab({ connId: t && t.connId, db: t && t.db }); }, 'C+w': () => closeTab(D.active),
        'C+PageDown': () => cycleTab(1), 'C+PageUp': () => cycleTab(-1), 'C+s': () => saveQuery(), 'CS+K': () => askClaude(), 'CS+k': () => askClaude(),
        'CA+n': () => editConn(),
      };
      const fn = map[k];
      if (!fn) return;
      if (k === '+F5' && e.target.closest && e.target.closest('#dbTree')) return; // F5 in the explorer = refresh
      e.preventDefault(); e.stopPropagation();
      fn();
    }, true);
  }
  function selectNode(el) {
    view.querySelectorAll('.db-list .cur').forEach(x => x.classList.remove('cur'));
    el.classList.add('cur');
    el.scrollIntoView({ block: 'nearest' });
  }
  function treeKey(e) {
    const list = e.target.closest('.db-list'); if (!list) return;
    const items = [...list.querySelectorAll('.db-node[data-key], [data-hist], [data-saved]')];
    let i = items.findIndex(x => x.classList.contains('cur'));
    const curEl = items[i];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); i = Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))); if (items[i]) selectNode(items[i]); return; }
    if (!curEl) return;
    const key = curEl.dataset.key;
    if (e.key === 'Enter') { e.preventDefault(); curEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); }
    else if (e.key === 'ArrowRight' && key && !D.open.has(key)) { e.preventDefault(); toggle(key); }
    else if (e.key === 'ArrowLeft' && key && D.open.has(key)) { e.preventDefault(); toggle(key); }
    else if (e.key === 'F5' && key) { e.preventDefault(); e.stopPropagation(); nodeAction('refresh', key); }
    else if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && key) { e.preventDefault(); const b = curEl.getBoundingClientRect(); nodeMenu(key, { clientX: b.left + 40, clientY: b.bottom }); }
  }
  function gridKey(grid, e) {
    const r = grid._r;
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); copySel(r, e.shiftKey); return; }
    if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); r.sel = { r0: 0, r1: r.shown - 1, c0: 0, c1: r.columns.length - 1 }; paintRows(grid); updateSelInfo(grid); return; }
    const mv = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1], PageDown: [Math.floor(grid.clientHeight / RH) - 1, 0], PageUp: [-(Math.floor(grid.clientHeight / RH) - 1), 0] }[e.key];
    if (mv) {
      e.preventDefault();
      const s = r.sel || { r0: 0, r1: 0, c0: 0, c1: 0 };
      const ni = Math.max(0, Math.min(r.shown - 1, s.r1 + mv[0])), nj = Math.max(0, Math.min(r.columns.length - 1, s.c1 + mv[1]));
      r.sel = e.shiftKey ? { ...s, r1: ni, c1: nj } : { r0: ni, r1: ni, c0: nj, c1: nj };
      // keep the active cell in view
      const y = ni * RH;
      if (y < grid.scrollTop) grid.scrollTop = y; else if (y + RH * 2 > grid.scrollTop + grid.clientHeight) grid.scrollTop = y + RH * 2 - grid.clientHeight;
      const x = (parseInt(grid.style.getPropertyValue('--rn'), 10) || 44) + r.widths.slice(0, nj).reduce((a, b) => a + b, 0);
      if (x - (parseInt(grid.style.getPropertyValue('--rn'), 10) || 44) < grid.scrollLeft) grid.scrollLeft = x - (parseInt(grid.style.getPropertyValue('--rn'), 10) || 44);
      else if (x + r.widths[nj] > grid.scrollLeft + grid.clientWidth) grid.scrollLeft = x + r.widths[nj] - grid.clientWidth;
      paintRows(grid); updateSelInfo(grid);
    } else if (e.key === 'Enter' && r.sel) { e.preventDefault(); viewCell(r, r.sel.r1, r.sel.c1); }
  }
  async function renameTab(id) {
    const t = D.tabs.find(x => x.id === id); if (!t) return;
    const r = await modal({ title: 'Sekmeyi yeniden adlandır', body: `<label class="db-f"><span>Ad</span><input name="name" value="${esc(t.title)}" maxlength="80"></label>`, buttons: [['cancel', 'Vazgeç'], ['ok', 'Tamam', 'primary']] });
    if (r && r.form.name.trim()) { t.title = r.form.name.trim(); renderTabs(); saveState(); }
  }

  /* shortcut list in Settings > Kısayollar (display only; handled above) */
  try {
    SHORTCUTS.push(
      { group: 'DB', keys: 'Ctrl+Enter / F5', label: 'Sorguyu çalıştır (seçili kısım ya da tamamı)' },
      { group: 'DB', keys: 'Ctrl+Shift+Enter', label: 'İmlecin bulunduğu deyimi çalıştır' },
      { group: 'DB', keys: 'Shift+F5', label: 'Çalışan sorguyu iptal et' },
      { group: 'DB', keys: 'Ctrl+T', label: 'Yeni sorgu sekmesi' },
      { group: 'DB', keys: 'Ctrl+W', label: 'Sorgu sekmesini kapat' },
      { group: 'DB', keys: 'Ctrl+PageDown / Ctrl+PageUp', label: 'Sonraki / önceki sorgu sekmesi' },
      { group: 'DB', keys: 'Ctrl+S', label: 'Sorguyu kaydet (Kayıtlı sorgular)' },
      { group: 'DB', keys: 'Ctrl+Space', label: 'Tablo ve sütun tamamlama' },
      { group: 'DB', keys: 'Ctrl+/', label: 'Satırları yorum yap / aç' },
      { group: 'DB', keys: 'Ctrl+Shift+K', label: "Seçili sorguyu Claude'a sor" },
      { group: 'DB', keys: 'Ctrl+Alt+N', label: 'Yeni bağlantı' },
      { group: 'DB', keys: 'Ctrl+C / Ctrl+Shift+C', label: 'Sonuç tablosunda seçimi kopyala / başlıklarla kopyala' },
    );
  } catch (_) {}

  window.dbMode = {
    async show() {
      if (!D.built) {
        build();
        await loadConns();
        await loadState();
        applyUi();
        setSide(D.side);
        renderTree();
        activateTab(D.active);
        const t = cur(); const c = t && conn(t.connId);
        if (c) connect(c.id, true);
      } else {
        requestAnimationFrame(() => { cm.refresh(); const g = view.querySelector('.db-grid'); if (g) paintRows(g); });
        loadConns().then(() => { renderConn(); renderTabs(); });
      }
    },
    hide() {
      const m = document.getElementById('dbCtx'); if (m) m.hidden = true;
      saveState();
    },
  };
})();

// VoxStorm — database client (DB mode), main-process side.
// Saved connections (passwords encrypted with Electron safeStorage, never sent back to the
// window), object explorer queries, query execution with cancel, result cache with paging,
// CSV export, query history and saved queries. Drivers are pure JS: mssql (tedious), pg, mysql2.
// Every query runs here; the window only sees column names and cell values.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { safeStorage } = require('electron');

const TYPES = { mssql: 'MSSQL', pg: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' };
const DEFAULT_PORT = { mssql: 1433, pg: 5432, mysql: 3306, mariadb: 3306 };
const COLORS = new Set(['', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray']);
const PAGE = 1000; // rows sent with the first answer; the rest comes with db:rows
const MAX_FETCH = 100000; // rows kept per result set; more are counted, not kept
const MAX_CACHED_ROWS = 1500000; // over all cached result sets
const MAX_CELL = 1024 * 1024; // characters of one cell value
const MAX_HISTORY = 300;

let mssqlLib = null, pgLib = null, mysqlLib = null;
const mssql = () => mssqlLib || (mssqlLib = require('mssql'));
const pgm = () => pgLib || (pgLib = require('pg'));
const mysql = () => mysqlLib || (mysqlLib = require('mysql2'));
const isMy = t => t === 'mysql' || t === 'mariadb';

module.exports = function registerDb({ ipcMain, app, dialog, getWin, DATA }) {
  const FILES = {
    conns: path.join(DATA, 'db-connections.json'),
    history: path.join(DATA, 'db-history.json'),
    saved: path.join(DATA, 'db-saved.json'),
    state: path.join(DATA, 'db-state.json'),
  };
  const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return def; } };
  const timers = {};
  const data = {
    conns: readJson(FILES.conns, { connections: [] }),
    history: readJson(FILES.history, []),
    saved: readJson(FILES.saved, []),
    state: readJson(FILES.state, null),
  };
  if (!Array.isArray(data.conns.connections)) data.conns.connections = [];
  if (!Array.isArray(data.history)) data.history = [];
  if (!Array.isArray(data.saved)) data.saved = [];
  function writeNow(k) {
    clearTimeout(timers[k]); timers[k] = null;
    try {
      const tmp = FILES[k] + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data[k], null, 1), 'utf8');
      fs.renameSync(tmp, FILES[k]);
    } catch (_) {}
  }
  const write = (k, now) => { if (now) writeNow(k); else if (!timers[k]) timers[k] = setTimeout(() => writeNow(k), 500); };
  const conns = () => data.conns.connections;
  const connById = id => conns().find(c => c.id === id);
  const newId = () => crypto.randomUUID().slice(0, 12);

  /* ---------------- passwords ----------------
     stored: base64 of safeStorage.encryptString (DPAPI on Windows). Not saved ("ask every time")
     or no encryption available: kept only in memory for this run. */
  const memPw = new Map();
  const canEncrypt = () => { try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; } };
  const encrypt = s => safeStorage.encryptString(String(s)).toString('base64');
  const decrypt = b => { try { return safeStorage.decryptString(Buffer.from(b, 'base64')); } catch (_) { return null; } };
  function passwordOf(c, given) {
    if (typeof given === 'string') { if (c.id) memPw.set(c.id, given); return given; }
    if (c.id && memPw.has(c.id)) return memPw.get(c.id);
    if (c.askPassword) return null; // the window has to ask
    if (c.pwd) return decrypt(c.pwd); // null when it cannot be decrypted (another Windows user): ask
    return '';
  }
  const publicConn = c => {
    const { pwd, ...rest } = c; // eslint-disable-line no-unused-vars
    return { ...rest, hasPassword: !!pwd || memPw.has(c.id), typeName: TYPES[c.type] };
  };
  // driver messages should never carry the password, but make sure
  const scrub = (msg, pw) => { msg = String(msg || ''); return pw && pw.length > 2 ? msg.split(pw).join('•••') : msg; };

  function clean(d) {
    const type = TYPES[d.type] ? d.type : 'mssql';
    const s = v => (typeof v === 'string' ? v.trim() : '');
    const port = parseInt(d.port, 10);
    return {
      name: s(d.name).slice(0, 80),
      type,
      host: s(d.host).slice(0, 255) || 'localhost',
      port: port > 0 && port < 65536 ? port : null,
      user: s(d.user).slice(0, 128),
      database: s(d.database).slice(0, 128),
      auth: type === 'mssql' && d.auth === 'ntlm' ? 'ntlm' : 'sql',
      domain: type === 'mssql' ? s(d.domain).slice(0, 128) : '',
      ssl: !!d.ssl,
      trustCert: !!d.trustCert,
      readOnly: !!d.readOnly,
      color: COLORS.has(d.color) ? d.color : '',
      askPassword: !!d.askPassword,
      timeout: Math.max(3, Math.min(120, parseInt(d.timeout, 10) || 15)),
    };
  }
  const label = c => c.name || `${c.user ? c.user + '@' : ''}${c.host}${c.port ? ':' + c.port : ''}`;

  /* ---------------- drivers ---------------- */
  // pg: keep dates, json, numeric, arrays as the server's text; only small numbers and booleans are parsed
  const PG_PARSED = new Set([16, 21, 23, 26, 700, 701]);
  const pgTypes = { getTypeParser: (oid, fmt) => (PG_PARSED.has(oid) ? pgm().types.getTypeParser(oid, fmt) : (v => v)) };
  const PG_TYPE_NAMES = { 16: 'bool', 17: 'bytea', 18: 'char', 19: 'name', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 26: 'oid', 114: 'json', 142: 'xml', 700: 'float4', 701: 'float8', 1042: 'bpchar', 1043: 'varchar', 1082: 'date', 1083: 'time', 1114: 'timestamp', 1184: 'timestamptz', 1186: 'interval', 1266: 'timetz', 1560: 'bit', 1562: 'varbit', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb', 869: 'inet', 650: 'cidr', 829: 'macaddr', 1000: 'bool[]', 1005: 'int2[]', 1007: 'int4[]', 1016: 'int8[]', 1009: 'text[]', 1015: 'varchar[]' };
  const MY_NAMES = { long: 'int', longlong: 'bigint', tiny: 'tinyint', short: 'smallint', int24: 'mediumint', newdecimal: 'decimal', var_string: 'varchar', string: 'char', tiny_blob: 'blob', medium_blob: 'blob', long_blob: 'blob' };
  const myTypeName = (n, charset) => {
    let t = ''; try { t = String(mysql().Types[n] || '').toLowerCase(); } catch (_) {}
    t = MY_NAMES[t] || t;
    if (t === 'blob' && charset !== 63) t = 'text'; // 63 = binary
    if (t === 'varchar' && charset === 63) t = 'varbinary';
    return t;
  };

  function mssqlConfig(c, pw, db, purpose) {
    let server = c.host || 'localhost', instanceName;
    const m = server.match(/^([^\\]+)\\(.+)$/);
    if (m) { server = m[1]; instanceName = m[2]; }
    if (server === '.' || /^\(local\)$/i.test(server)) server = 'localhost';
    const cfg = {
      server, user: c.user || undefined, password: pw || undefined,
      database: db || c.database || undefined,
      port: instanceName ? undefined : (c.port || 1433),
      connectionTimeout: c.timeout * 1000,
      requestTimeout: purpose === 'session' ? 0 : 60000,
      pool: purpose === 'session' ? { max: 1, min: 0, idleTimeoutMillis: 12 * 3600e3 } : { max: 4, min: 0, idleTimeoutMillis: 60000 },
      options: { encrypt: !!c.ssl, trustServerCertificate: !!c.trustCert, instanceName, appName: 'VoxStorm', enableArithAbort: true, useUTC: true },
    };
    if (c.auth === 'ntlm') cfg.domain = c.domain || '';
    return cfg;
  }
  const pgConfig = (c, pw, db, purpose) => ({
    host: c.host || 'localhost', port: c.port || 5432, user: c.user || undefined, password: pw == null ? undefined : pw,
    database: db || c.database || 'postgres',
    ssl: c.ssl ? { rejectUnauthorized: !c.trustCert } : false,
    connectionTimeoutMillis: c.timeout * 1000, application_name: 'VoxStorm', types: pgTypes,
    options: c.readOnly ? '-c default_transaction_read_only=on' : undefined,
    statement_timeout: purpose === 'meta' ? 60000 : undefined,
  });
  const myConfig = (c, pw, db, purpose) => ({
    host: c.host || 'localhost', port: c.port || 3306, user: c.user || undefined, password: pw == null ? undefined : pw,
    database: db || c.database || undefined,
    ssl: c.ssl ? { rejectUnauthorized: !c.trustCert } : undefined,
    connectTimeout: c.timeout * 1000, multipleStatements: purpose === 'session',
    dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, charset: 'utf8mb4_unicode_ci',
  });

  /* one connection used by a single editor tab (keeps USE, temp tables, transactions) */
  async function openSession(c, pw, db) {
    if (c.type === 'mssql') {
      const pool = new (mssql().ConnectionPool)(mssqlConfig(c, pw, db, 'session'));
      pool.on('error', () => {});
      await pool.connect();
      let req = null;
      const s = {
        alive: () => pool.connected,
        close: () => pool.close().catch(() => {}),
        cancel: () => { if (req) try { req.cancel(); } catch (_) {} },
        currentDb: async () => { const r = await pool.request().query('SELECT DB_NAME() AS d'); return r.recordset[0].d; },
        async run(text, ctx) {
          for (const b of splitGo(text)) {
            for (let k = 0; k < b.count; k++) {
              if (ctx.cancelled) return;
              await new Promise(resolve => {
                let cur = null;
                req = pool.request(); req.stream = true; req.arrayRowMode = true;
                req.on('recordset', cols => { cur = ctx.newResult(cols.map(x => ({ name: x.name, type: mssqlType(x) }))); });
                req.on('row', row => { if (cur) ctx.addRow(cur, row); });
                req.on('rowsaffected', n => { if (cur && !cur.closed) cur.closed = true; else ctx.affected(n); });
                req.on('info', m => ctx.message('info', m.message, m.lineNumber ? b.line + m.lineNumber - 1 : 0));
                req.on('error', e => {
                  for (const x of [...(e.precedingErrors || []), e]) ctx.error(x.message, x.lineNumber ? b.line + x.lineNumber - 1 : 0, x.code === 'ECANCEL');
                });
                req.on('done', () => { req = null; resolve(); });
                req.query(b.sql);
              });
            }
          }
        },
      };
      return s;
    }
    if (c.type === 'pg') {
      const client = new (pgm().Client)(pgConfig(c, pw, db, 'session'));
      let dead = false, ctxNow = null;
      client.on('error', () => { dead = true; });
      client.on('end', () => { dead = true; });
      client.on('notice', m => { if (ctxNow) ctxNow.message('info', (m.severity ? m.severity + ': ' : '') + m.message); });
      await client.connect();
      const cfg = pgConfig(c, pw, db, 'session');
      return {
        alive: () => !dead,
        close: () => client.end().catch(() => {}),
        // protocol-level CancelRequest from a second socket (no extra permission needed)
        cancel: () => { if (client._activeQuery) { const cc = new (pgm().Client)(cfg); try { cc.cancel(client, client._activeQuery); } catch (_) {} } },
        currentDb: async () => (await client.query('SELECT current_database() AS d')).rows[0].d,
        async run(text, ctx) {
          ctxNow = ctx;
          try {
            let res = await client.query({ text, rowMode: 'array' });
            if (!Array.isArray(res)) res = [res];
            for (const r of res) {
              if (r.fields && r.fields.length) {
                const cur = ctx.newResult(r.fields.map(f => ({ name: f.name, type: PG_TYPE_NAMES[f.dataTypeID] || String(f.dataTypeID) })));
                for (const row of r.rows) ctx.addRow(cur, row);
                if (['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(r.command)) ctx.affected(r.rowCount || 0, r.command);
              } else if (r.command) {
                if (['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY'].includes(r.command)) ctx.affected(r.rowCount || 0, r.command);
                else ctx.message('ok', r.command + ' tamamlandı.');
              }
            }
          } catch (e) {
            let line = 0;
            if (e.position) line = text.slice(0, parseInt(e.position, 10) - 1).split('\n').length;
            ctx.error(pgMessage(e), line, e.code === '57014');
          } finally { ctxNow = null; }
        },
      };
    }
    // mysql / mariadb
    const conn = mysql().createConnection(myConfig(c, pw, db, 'session'));
    let dead = false;
    conn.on('error', () => { dead = true; });
    await new Promise((res, rej) => conn.connect(err => (err ? rej(err) : res())));
    const q = text => new Promise((res, rej) => conn.query(text, (err, rows) => (err ? rej(err) : res(rows))));
    if (c.readOnly) await q('SET SESSION TRANSACTION READ ONLY').catch(() => {});
    return {
      alive: () => !dead,
      close: () => new Promise(r => conn.end(() => r())),
      threadId: conn.threadId,
      cancel: null, // set by the caller: KILL QUERY from another connection
      currentDb: async () => (await q('SELECT DATABASE() AS d'))[0].d,
      run(text, ctx) {
        return new Promise(resolve => {
          let cur = null, done = 0; // statements finished so far, to find the failing one
          const query = conn.query({ sql: text, rowsAsArray: true });
          query.on('fields', fields => { if (!fields) { cur = null; return; } done++; cur = ctx.newResult(fields.map(f => ({ name: f.name, type: myTypeName(f.columnType, f.characterSet) }))); });
          query.on('result', r => {
            if (Array.isArray(r)) { if (cur) ctx.addRow(cur, r); return; }
            if (r && r.constructor && r.constructor.name === 'ResultSetHeader') {
              cur = null; done++;
              ctx.affected(r.affectedRows || 0);
              if (r.warningStatus) ctx.message('info', `${r.warningStatus} uyarı (ayrıntı için SHOW WARNINGS).`);
            } else if (cur) ctx.addRow(cur, Object.values(r));
          });
          query.on('error', e => {
            const m = /at line (\d+)/.exec(e.message || '');
            const starts = stmtLines(text, c.type);
            const base = starts[Math.min(done, starts.length - 1)] || 1;
            ctx.error(e.message, base + (m ? parseInt(m[1], 10) - 1 : 0), e.errno === 1317);
          });
          query.on('end', () => resolve());
        });
      },
    };
  }

  /* metadata: a small pool per connection (pg: per database, since catalogs are per database) */
  const metas = new Map();
  async function meta(c, pw, db) {
    const key = c.id + '|' + (c.type === 'pg' ? (db || c.database || 'postgres') : '');
    const have = metas.get(key);
    if (have) { try { return await have; } catch (_) { metas.delete(key); } }
    const p = (async () => {
      if (c.type === 'mssql') {
        const pool = new (mssql().ConnectionPool)(mssqlConfig(c, pw, null, 'meta'));
        pool.on('error', () => {});
        await pool.connect();
        return {
          q: async (text, params = {}) => { const r = pool.request(); for (const [k, v] of Object.entries(params)) r.input(k, mssql().NVarChar, v); return (await r.query(text)).recordset; },
          close: () => pool.close().catch(() => {}),
        };
      }
      if (c.type === 'pg') {
        const pool = new (pgm().Pool)({ ...pgConfig(c, pw, db, 'meta'), max: 3, idleTimeoutMillis: 60000 });
        pool.on('error', () => {});
        const cl = await pool.connect(); cl.release(); // fail early with a real error
        return { q: async (text, params = []) => (await pool.query(text, Array.isArray(params) ? params : Object.values(params))).rows, close: () => pool.end().catch(() => {}) };
      }
      const pool = mysql().createPool({ ...myConfig(c, pw, null, 'meta'), connectionLimit: 3 });
      pool.on('error', () => {});
      const pp = pool.promise();
      const cl = await pp.getConnection(); cl.release();
      return { q: async (text, params = []) => (await pp.query(text, Array.isArray(params) ? params : Object.values(params)))[0], close: () => pp.end().catch(() => {}) };
    })();
    metas.set(key, p);
    p.catch(() => metas.delete(key));
    return p;
  }
  async function closeConn(id) {
    const waits = [];
    for (const [k, p] of [...metas]) if (k.startsWith(id + '|')) { metas.delete(k); waits.push(p.then(m => m.close(), () => {})); }
    for (const [tab, s] of [...sessions]) if (s.connId === id) { sessions.delete(tab); waits.push(s.ready.then(x => x.close(), () => {})); }
    await Promise.all(waits);
  }

  /* ---------------- errors ---------------- */
  function friendly(e, c) {
    const code = (e && (e.code || (e.originalError && e.originalError.code))) || '';
    const msg = String((e && (e.message || e)) || 'Bilinmeyen hata');
    const where = c ? `${c.host}${c.port ? ':' + c.port : ''}` : '';
    if (/auth_gssapi_client/.test(msg)) return 'Kimlik doğrulama başarısız: Access denied for user (kullanıcı adı ya da parola hatalı; sunucu GSSAPI ile Windows kimliğine geçmek istedi, bu desteklenmiyor).';
    if (/ECONNREFUSED|Could not connect \(sequence\)/.test(code + msg)) return `Sunucuya bağlanılamadı (${where}): bağlantı reddedildi. Sunucu çalışıyor mu, port doğru mu?`;
    if (/ENOTFOUND|EAI_AGAIN/.test(code + msg)) return `Sunucu adı çözümlenemedi: ${c ? c.host : ''}`;
    if (/ETIMEOUT|ETIMEDOUT|timeout|timed out/i.test(code + msg) && !/statement timeout/i.test(msg)) return `Bağlantı zaman aşımına uğradı (${where}). ${msg}`;
    if (/self[- ]signed|unable to verify|certificate/i.test(msg)) return `TLS sertifikası doğrulanamadı. "Sunucu sertifikasına güven" seçeneğini deneyebilirsin. (${msg})`;
    if (/does not support SSL|server does not support secure/i.test(msg)) return 'Sunucu SSL/TLS desteklemiyor; bağlantıda SSL seçeneğini kapat.';
    return msg;
  }
  const pgMessage = e => [e.message, e.detail && 'Ayrıntı: ' + e.detail, e.hint && 'İpucu: ' + e.hint].filter(Boolean).join('\n');
  function mssqlType(x) {
    const t = x.type && (x.type.declaration || x.type.name);
    let n = String(t || '').toLowerCase();
    if (/char|binary/.test(n) && x.length) n += `(${x.length > 8000 || x.length === 65535 ? 'max' : (/^n/.test(n) ? x.length / 2 : x.length)})`;
    else if (/decimal|numeric/.test(n)) n += `(${x.precision},${x.scale})`;
    return n;
  }

  /* ---------------- cells and result cache ---------------- */
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  function cell(v) {
    if (v === null || v === undefined) return null;
    const t = typeof v;
    if (t === 'string') return v.length > MAX_CELL ? v.slice(0, MAX_CELL) + '…' : v;
    if (t === 'number') return Number.isFinite(v) ? v : String(v);
    if (t === 'boolean') return v;
    if (t === 'bigint') return String(v);
    if (v instanceof Date) {
      if (isNaN(v)) return 'Invalid Date';
      const ms = v.getUTCMilliseconds();
      return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())} ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}${ms ? '.' + pad(ms, 3) : ''}`;
    }
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
      const b = Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
      const max = 4096;
      return '0x' + b.subarray(0, max).toString('hex').toUpperCase() + (b.length > max ? `… (${b.length} bayt)` : '');
    }
    try { const s = JSON.stringify(v); return s && s.length > MAX_CELL ? s.slice(0, MAX_CELL) + '…' : s; } catch (_) { return String(v); }
  }
  const cache = new Map(); // id -> { columns, rows, total, tab, title }
  let cachedRows = 0;
  function remember(r) {
    cache.set(r.id, r); cachedRows += r.rows.length;
    for (const [id, x] of cache) { // oldest first
      if (cachedRows <= MAX_CACHED_ROWS) break;
      if (id === r.id) continue;
      cache.delete(id); cachedRows -= x.rows.length;
    }
  }
  function forget(ids) { for (const id of ids || []) { const x = cache.get(id); if (x) { cachedRows -= x.rows.length; cache.delete(id); } } }

  function makeCtx(tab) {
    const ctx = {
      results: [], messages: [], cancelled: false, failed: false, affectedTotal: 0,
      newResult(columns) {
        const r = { id: newId(), columns, rows: [], total: 0, tab, closed: false };
        ctx.results.push(r); return r;
      },
      addRow(r, row) { r.total++; if (r.rows.length < MAX_FETCH) r.rows.push(Array.from(row, cell)); },
      affected(n, cmd) { ctx.affectedTotal += n; ctx.messages.push({ type: 'rows', text: `${n.toLocaleString('tr-TR')} satır etkilendi${cmd ? ' (' + cmd + ')' : ''}.` }); },
      message(type, text, line) { ctx.messages.push({ type, text: String(text || ''), line: line || 0 }); },
      error(text, line, cancel) {
        if (cancel) { ctx.cancelled = true; ctx.messages.push({ type: 'cancel', text: 'Sorgu iptal edildi.' }); return; }
        ctx.failed = true; ctx.messages.push({ type: 'error', text: String(text || 'Hata'), line: line || 0 });
      },
    };
    return ctx;
  }

  /* ---------------- SQL safety ----------------
     A small tokenizer that understands comments, strings, quoted names, [brackets], `backticks`
     and $tag$ quoting, so that keywords inside them are not counted. */
  function tokenize(text, type) {
    const toks = []; const n = text.length; let i = 0, depth = 0, at = 0;
    const my = isMy(type);
    const push = o => { o.s = at; toks.push(o); }; // s = offset where the token starts
    while (i < n) {
      at = i;
      const ch = text[i], nx = text[i + 1];
      if (/\s/.test(ch)) { i++; continue; }
      if ((ch === '-' && nx === '-') || (my && ch === '#')) { while (i < n && text[i] !== '\n') i++; continue; }
      if (ch === '/' && nx === '*') {
        let d = 1; i += 2;
        while (i < n && d) { if (text[i] === '*' && text[i + 1] === '/') { d--; i += 2; } else if (type === 'pg' && text[i] === '/' && text[i + 1] === '*') { d++; i += 2; } else i++; }
        continue;
      }
      if (ch === '\'' || (my && ch === '"')) {
        const back = my || (type === 'pg' && /[eE]/.test(text[i - 1] || ''));
        i++;
        while (i < n) {
          if (back && text[i] === '\\') { i += 2; continue; }
          if (text[i] === ch) { if (text[i + 1] === ch) { i += 2; continue; } i++; break; }
          i++;
        }
        push({ t: 'STR', d: depth }); continue;
      }
      if (ch === '"' || (type === 'mssql' && ch === '[') || (my && ch === '`')) {
        const close = ch === '[' ? ']' : ch; i++;
        while (i < n) { if (text[i] === close) { if (text[i + 1] === close) { i += 2; continue; } i++; break; } i++; }
        push({ t: 'ID', d: depth }); continue;
      }
      if (ch === '$' && type === 'pg') {
        const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
        if (m) {
          const end = text.indexOf(m[0], i + m[0].length);
          i = end < 0 ? n : end + m[0].length;
          push({ t: 'STR', d: depth }); continue;
        }
      }
      if (ch === '(') { push({ t: '(', d: depth }); depth++; i++; continue; }
      if (ch === ')') { depth = Math.max(0, depth - 1); push({ t: ')', d: depth }); i++; continue; }
      if (ch === ';' || ch === ',') { push({ t: ch, d: depth }); i++; continue; }
      const w = /^[A-Za-z_@#][A-Za-z0-9_@#$]*/.exec(text.slice(i, i + 128));
      if (w) { push({ t: w[0].toUpperCase(), d: depth, w: true }); i += w[0].length; continue; }
      push({ t: '?', d: depth }); i++;
    }
    return toks;
  }
  const NOT_STMT_BEFORE = new Set(['ON', 'KEY', 'FOR', 'AFTER', 'BEFORE', 'OF', 'THEN', ',', 'GRANT', 'REVOKE', 'DENY', 'INSTEAD', '.']);
  // where an UPDATE / DELETE statement ends (T-SQL does not need semicolons)
  const BOUNDARY = new Set([';', 'GO', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'TRUNCATE', 'CREATE', 'ALTER', 'EXEC', 'EXECUTE', 'DECLARE', 'PRINT', 'BEGIN', 'USE', 'RETURN', 'GRANT', 'SELECT', 'ELSE', 'WHILE', 'COMMIT', 'ROLLBACK', 'RAISERROR', 'THROW']);
  // never allowed on a read-only connection, wherever they appear (outside strings and comments)
  const WRITE_ANY = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'TRUNCATE', 'ALTER', 'CREATE', 'GRANT', 'REVOKE', 'DENY', 'EXEC', 'EXECUTE', 'CALL', 'INTO', 'UPSERT', 'BACKUP', 'RESTORE', 'DBCC', 'SHUTDOWN', 'RECONFIGURE', 'BULK', 'VACUUM', 'REINDEX', 'SETUSER']);
  // words that are also common names (REPLACE(), a "comment" column): only at the start of a statement
  const WRITE_START = new Set(['REPLACE', 'RENAME', 'LOCK', 'COMMENT', 'COPY', 'CLUSTER', 'LOAD', 'HANDLER', 'INSTALL', 'UNINSTALL', 'OPTIMIZE', 'REPAIR', 'IMPORT', 'REFRESH', 'REASSIGN', 'SECURITY', 'KILL', 'FLUSH', 'RESET', 'PURGE', 'CHECKPOINT', 'DO', 'PREPARE', 'DEALLOCATE', 'DISCARD', 'NOTIFY', 'LISTEN', 'UNLISTEN']);
  function analyze(text, type) {
    const toks = tokenize(text, type);
    const blocked = new Set(), confirm = [];
    let start = true;
    for (let k = 0; k < toks.length; k++) {
      const tk = toks[k], t = tk.t;
      if (t === ';' || t === 'GO') { start = true; continue; }
      if (!tk.w) { start = false; continue; }
      const prev = toks[k - 1] ? toks[k - 1].t : '';
      if (WRITE_ANY.has(t) && !(t === 'UPDATE' && prev === 'FOR')) blocked.add(t);
      if (start && WRITE_START.has(t)) blocked.add(t);
      if (start && t === 'SET' && toks[k + 1] && ['GLOBAL', 'PERSIST', 'PERSIST_ONLY'].includes(toks[k + 1].t)) blocked.add('SET GLOBAL');
      start = false;
      if (t === 'DROP' && prev !== 'ON') confirm.push('DROP: nesne kalıcı olarak silinir.');
      else if (t === 'TRUNCATE') confirm.push('TRUNCATE: tablonun tüm satırları silinir.');
      else if ((t === 'UPDATE' || t === 'DELETE') && !NOT_STMT_BEFORE.has(prev)) {
        let where = false, target = '', cases = 0;
        for (let j = k + 1; j < toks.length; j++) {
          const x = toks[j];
          if (x.d < tk.d) break;
          if (x.t === 'CASE') cases++;
          if (x.t === 'END') { if (cases) { cases--; continue; } if (x.d === tk.d) break; }
          if (x.d === tk.d && x.t === 'IF' && !(toks[j + 1] && toks[j + 1].t === '(')) break;
          if (x.d === tk.d && BOUNDARY.has(x.t)) break;
          if (x.d === tk.d && x.t === 'WHERE') { where = true; break; }
          if (!target && x.w && x.t !== 'FROM' && x.t !== 'TOP' && x.t !== 'ONLY') target = x.t;
        }
        if (!where) confirm.push(`WHERE koşulu olmayan ${t}: ${target ? target.toLowerCase() + ' tablosundaki ' : ''}tüm satırlar etkilenir.`);
      }
    }
    return { blocked: [...blocked], confirm: [...new Set(confirm)] };
  }

  /* 1-based line where each ";"-separated statement starts (MySQL errors are per statement) */
  function stmtLines(text, type) {
    const out = []; let start = true;
    for (const tk of tokenize(text, type)) {
      if (tk.t === ';') { start = true; continue; }
      if (start) { out.push(text.slice(0, tk.s).split('\n').length); start = false; }
    }
    return out;
  }

  /* MSSQL batches: GO on its own line (optionally "GO 5") */
  function splitGo(text) {
    const lines = text.split('\n');
    const out = []; let buf = [], startLine = 1;
    lines.forEach((l, idx) => {
      const m = /^\s*GO(?:\s+(\d+))?\s*(?:--.*)?\r?$/i.exec(l);
      if (m) {
        if (buf.join('').trim()) out.push({ sql: buf.join('\n'), line: startLine, count: Math.min(1000, parseInt(m[1] || '1', 10) || 1) });
        buf = []; startLine = idx + 2;
      } else buf.push(l);
    });
    if (buf.join('').trim()) out.push({ sql: buf.join('\n'), line: startLine, count: 1 });
    return out;
  }

  /* ---------------- sessions ---------------- */
  const sessions = new Map(); // tab id -> { connId, db, ready: Promise<session>, busy }
  async function sessionFor(tab, c, pw, db) {
    let s = sessions.get(tab);
    if (s && (s.connId !== c.id || (db && s.db !== db))) { sessions.delete(tab); s.ready.then(x => x.close(), () => {}); s = null; }
    if (s) {
      try { const x = await s.ready; if (x.alive()) return { s, x }; } catch (_) {}
      sessions.delete(tab); s = null;
    }
    s = { connId: c.id, db: db || '', ready: openSession(c, pw, db), busy: false };
    sessions.set(tab, s);
    try { return { s, x: await s.ready }; } catch (e) { sessions.delete(tab); throw e; }
  }

  /* ---------------- explorer queries ---------------- */
  const br = s => '[' + String(s).replace(/]/g, ']]') + ']';
  async function explore(c, pw, what, a = {}) {
    const m = await meta(c, pw, a.db);
    const T = c.type;
    if (what === 'databases') {
      if (T === 'mssql') return (await m.q("SELECT name FROM sys.databases WHERE state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY CASE WHEN database_id <= 4 THEN 1 ELSE 0 END, name")).map(r => ({ name: r.name, system: ['master', 'model', 'msdb', 'tempdb'].includes(r.name) }));
      if (T === 'pg') return (await m.q("SELECT datname AS name FROM pg_database WHERE NOT datistemplate AND has_database_privilege(datname, 'CONNECT') ORDER BY datname")).map(r => ({ name: r.name }));
      return (await m.q('SHOW DATABASES')).map(r => { const name = r.Database || Object.values(r)[0]; return { name, system: ['information_schema', 'mysql', 'performance_schema', 'sys'].includes(name) }; });
    }
    if (what === 'schemas') {
      if (T === 'mssql') return (await m.q(`SELECT s.name, CASE WHEN s.name = 'dbo' OR EXISTS (SELECT 1 FROM ${br(a.db)}.sys.objects o WHERE o.schema_id = s.schema_id AND o.is_ms_shipped = 0) THEN 0 ELSE 1 END AS empty FROM ${br(a.db)}.sys.schemas s WHERE s.name NOT IN ('sys','INFORMATION_SCHEMA','guest') AND s.name NOT LIKE 'db[_]%' ORDER BY empty, s.name`)).map(r => ({ name: r.name, empty: !!r.empty }));
      if (T === 'pg') return (await m.q("SELECT nspname AS name FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY nspname = 'public' DESC, nspname")).map(r => ({ name: r.name }));
      return [];
    }
    if (what === 'objects') {
      const kind = a.kind; // tables | views | procs | funcs
      if (T === 'mssql') {
        const types = { tables: "('U')", views: "('V')", procs: "('P','PC')", funcs: "('FN','IF','TF','FS','FT')" }[kind];
        return (await m.q(`SELECT o.name, o.type FROM ${br(a.db)}.sys.objects o JOIN ${br(a.db)}.sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = @s AND o.type IN ${types} AND o.is_ms_shipped = 0 ORDER BY o.name`, { s: a.schema })).map(r => ({ name: r.name, sub: String(r.type).trim() }));
      }
      if (T === 'pg') {
        if (kind === 'tables') return (await m.q("SELECT c.relname AS name, c.relkind AS k FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p','f') ORDER BY c.relname", [a.schema])).map(r => ({ name: r.name, sub: r.k }));
        if (kind === 'views') return (await m.q("SELECT c.relname AS name, c.relkind AS k FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('v','m') ORDER BY c.relname", [a.schema])).map(r => ({ name: r.name, sub: r.k === 'm' ? 'materialized' : '' }));
        const rt = kind === 'procs' ? 'PROCEDURE' : 'FUNCTION';
        return (await m.q('SELECT routine_name AS name, specific_name AS spec FROM information_schema.routines WHERE routine_schema = $1 AND routine_type = $2 ORDER BY routine_name', [a.schema, rt])).map(r => ({ name: r.name, spec: r.spec }));
      }
      if (kind === 'tables' || kind === 'views') return (await m.q('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE ' + (kind === 'views' ? "= 'VIEW'" : "IN ('BASE TABLE','SYSTEM VERSIONED')") + ' ORDER BY TABLE_NAME', [a.db])).map(r => ({ name: r.name }));
      return (await m.q('SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = ? ORDER BY ROUTINE_NAME', [a.db, kind === 'procs' ? 'PROCEDURE' : 'FUNCTION'])).map(r => ({ name: r.name }));
    }
    if (what === 'columns') {
      if (T === 'mssql') {
        return (await m.q(`SELECT c.name, t.name AS type, c.max_length AS len, c.precision AS prec, c.scale, c.is_nullable AS nullable, c.is_identity AS ident,
            CASE WHEN EXISTS (SELECT 1 FROM ${br(a.db)}.sys.index_columns ic JOIN ${br(a.db)}.sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END AS pk
          FROM ${br(a.db)}.sys.columns c JOIN ${br(a.db)}.sys.types t ON t.user_type_id = c.user_type_id
          WHERE c.object_id = OBJECT_ID(@full) ORDER BY c.column_id`, { full: `${br(a.db)}.${br(a.schema)}.${br(a.table)}` })).map(r => {
          let type = r.type;
          if (/char|binary/.test(type)) type += `(${r.len === -1 ? 'max' : /^n/.test(type) ? r.len / 2 : r.len})`;
          else if (/decimal|numeric/.test(type)) type += `(${r.prec},${r.scale})`;
          return { name: r.name, type, nullable: !!r.nullable, pk: !!r.pk, ident: !!r.ident };
        });
      }
      if (T === 'pg') {
        return (await m.q(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
            EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk,
            (a.attidentity <> '' OR pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%') AS ident
          FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [a.schema, a.table])).map(r => ({ name: r.name, type: r.type, nullable: !!r.nullable, pk: !!r.pk, ident: !!r.ident }));
      }
      return (await m.q('SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nl, COLUMN_KEY AS ck, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [a.db, a.table])).map(r => ({ name: r.name, type: String(r.type), nullable: r.nl === 'YES', pk: r.ck === 'PRI', ident: /auto_increment/i.test(r.extra || '') }));
    }
    if (what === 'definition') {
      if (T === 'mssql') { const r = await m.q('SELECT OBJECT_DEFINITION(OBJECT_ID(@full)) AS d', { full: `${br(a.db)}.${br(a.schema)}.${br(a.name)}` }); return r[0] && r[0].d; }
      if (T === 'pg') {
        if (a.kind === 'views') { const r = await m.q("SELECT 'CREATE OR REPLACE VIEW ' || quote_ident($1) || '.' || quote_ident($2) || E' AS\\n' || pg_get_viewdef(format('%I.%I', $1::text, $2::text)::regclass, true) AS d", [a.schema, a.name]); return r[0] && r[0].d; }
        const r = await m.q('SELECT pg_get_functiondef(p.oid) AS d FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2', [a.schema, a.name]);
        return r.map(x => x.d).join('\n\n');
      }
      const kw = { views: 'VIEW', procs: 'PROCEDURE', funcs: 'FUNCTION', tables: 'TABLE' }[a.kind] || 'TABLE';
      const r = await m.q(`SHOW CREATE ${kw} \`${String(a.db).replace(/`/g, '``')}\`.\`${String(a.name).replace(/`/g, '``')}\``);
      const row = r[0] || {};
      return row['Create View'] || row['Create Procedure'] || row['Create Function'] || row['Create Table'] || '';
    }
    if (what === 'hint') { // table -> columns for autocomplete (current database)
      let rows;
      if (T === 'mssql') rows = await m.q(`SELECT TOP 20000 s.name AS sch, o.name AS tbl, c.name AS col FROM ${br(a.db)}.sys.columns c JOIN ${br(a.db)}.sys.objects o ON o.object_id = c.object_id JOIN ${br(a.db)}.sys.schemas s ON s.schema_id = o.schema_id WHERE o.type IN ('U','V') AND o.is_ms_shipped = 0 ORDER BY s.name, o.name, c.column_id`);
      else if (T === 'pg') rows = await m.q("SELECT table_schema AS sch, table_name AS tbl, column_name AS col FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name, ordinal_position LIMIT 20000");
      else rows = await m.q('SELECT TABLE_SCHEMA AS sch, TABLE_NAME AS tbl, COLUMN_NAME AS col FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION LIMIT 20000', [a.db]);
      const out = {};
      for (const r of rows) {
        const plain = (T === 'mssql' && r.sch === 'dbo') || (T === 'pg' && r.sch === 'public') || isMy(T);
        const k = plain ? r.tbl : r.sch + '.' + r.tbl;
        (out[k] || (out[k] = [])).push(r.col);
      }
      return out;
    }
    throw new Error('Bilinmeyen istek: ' + what);
  }
  async function version(c, pw) {
    const m = await meta(c, pw, null);
    const q = c.type === 'mssql' ? "SELECT @@VERSION AS v" : c.type === 'pg' ? 'SELECT version() AS v' : 'SELECT VERSION() AS v';
    const r = await m.q(q);
    return String((r[0] && r[0].v) || '').split('\n')[0].trim();
  }

  /* every handler answers { error } instead of throwing, so the window gets a clean Turkish message */
  const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => {
    try { return await fn(...args); } catch (e) { return { error: String(e && e.message || e) }; }
  });
  function need(id, given) {
    const c = connById(id);
    if (!c) throw new Error('Bağlantı bulunamadı.');
    const pw = passwordOf(c, given);
    return { c, pw };
  }
  // wraps calls that need a password; on a login failure an "ask every time" password is forgotten
  async function withConn(id, given, fn) {
    const { c, pw } = need(id, given);
    if (pw === null) return { needPassword: true, name: label(c) };
    try { return await fn(c, pw); } catch (e) {
      const msg = scrub(friendly(e, c), pw);
      if (/login failed|password authentication failed|Access denied for user|Oturum açma başarısız/i.test(msg)) { memPw.delete(c.id); await closeConn(c.id); return { error: msg, loginFailed: true, needPassword: c.askPassword || undefined, name: label(c) }; }
      return { error: msg };
    }
  }

  /* ---------------- connections ---------------- */
  handle('db:list', () => ({ connections: conns().map(publicConn), canEncrypt: canEncrypt() }));
  handle('db:save', (draft, pw) => {
    // pw: undefined = keep the stored password, '' or string = set, null = clear
    const base = clean(draft || {});
    let c = draft && draft.id ? connById(draft.id) : null;
    let warning = '';
    if (c) { Object.assign(c, base); closeConn(c.id); } else { c = { id: newId(), ...base, created: Date.now() }; conns().push(c); }
    delete c.hadPassword;
    if (pw === null) { delete c.pwd; memPw.delete(c.id); }
    else if (typeof pw === 'string') {
      memPw.delete(c.id);
      if (c.askPassword) { delete c.pwd; if (pw) memPw.set(c.id, pw); } // asked again after a restart
      else if (!pw) delete c.pwd; // an empty password needs no storage
      else if (canEncrypt()) c.pwd = encrypt(pw);
      else { delete c.pwd; c.askPassword = true; memPw.set(c.id, pw); warning = 'Windows şifreleme hizmeti kullanılamadığı için parola kaydedilmedi; bu oturum boyunca bellekte tutulacak.'; }
    }
    if (c.askPassword && c.pwd) delete c.pwd;
    write('conns', true);
    return { connection: publicConn(c), warning };
  });
  handle('db:delete', async id => {
    await closeConn(id);
    memPw.delete(id);
    data.conns.connections = conns().filter(c => c.id !== id);
    write('conns', true);
    return { ok: true };
  });
  handle('db:duplicate', id => {
    const c = connById(id); if (!c) throw new Error('Bağlantı bulunamadı.');
    const copy = { ...c, id: newId(), name: (c.name || label(c)) + ' (kopya)', created: Date.now() };
    conns().splice(conns().indexOf(c) + 1, 0, copy);
    if (memPw.has(id)) memPw.set(copy.id, memPw.get(id));
    write('conns', true);
    return { connection: publicConn(copy) };
  });
  handle('db:reorder', ids => {
    const pos = new Map((ids || []).map((id, i) => [id, i]));
    conns().sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e9) - (pos.has(b.id) ? pos.get(b.id) : 1e9));
    write('conns', true);
    return { ok: true };
  });
  // test a draft from the dialog: pw undefined = use the stored password of draft.id
  handle('db:test', async (draft, pw) => {
    const c = { ...clean(draft || {}), id: '__test_' + newId() };
    const saved = draft && draft.id ? connById(draft.id) : null;
    let password = typeof pw === 'string' ? pw : null;
    if (password === null && saved) password = passwordOf(saved);
    if (password === null) password = '';
    const t0 = Date.now();
    try {
      const v = await version(c, password);
      return { ok: true, version: v, ms: Date.now() - t0 };
    } catch (e) { return { error: scrub(friendly(e, c), password), ms: Date.now() - t0 }; } finally { await closeConn(c.id); }
  });
  handle('db:connect', (id, pw) => withConn(id, pw, async (c, p) => ({ ok: true, version: await version(c, p), databases: await explore(c, p, 'databases') })));
  handle('db:disconnect', async id => { await closeConn(id); return { ok: true }; });
  handle('db:explore', (id, what, args, pw) => withConn(id, pw, async (c, p) => ({ items: await explore(c, p, what, args || {}) })));

  /* ---------------- queries ---------------- */
  // req: { tab, connId, db, sql, confirmed, password, title }
  handle('db:run', async req => {
    const { tab, connId, db } = req || {};
    const text = String((req && req.sql) || '');
    if (!text.trim()) return { error: 'Çalıştırılacak sorgu yok.' };
    return withConn(connId, req.password, async (c, pw) => {
      const a = analyze(text, c.type);
      if (c.readOnly && a.blocked.length) return { blocked: a.blocked, readOnly: true };
      if (!req.confirmed && a.confirm.length) return { confirm: a.confirm };
      const { s, x } = await sessionFor(tab, c, pw, db);
      if (s.busy) return { error: 'Bu sekmede zaten çalışan bir sorgu var.' };
      s.busy = true;
      const ctx = makeCtx(tab);
      s.ctx = ctx;
      const t0 = Date.now();
      try {
        await x.run(text, ctx);
      } catch (e) {
        ctx.error(scrub(friendly(e, c), pw), 0);
        if (!x.alive()) sessions.delete(tab);
      } finally { s.busy = false; s.ctx = null; }
      const ms = Date.now() - t0;
      let currentDb = db || '';
      if (x.alive()) { try { currentDb = await x.currentDb(); s.db = currentDb; } catch (_) {} }
      const results = ctx.results.map(r => {
        remember(r);
        return { id: r.id, columns: r.columns, total: r.total, fetched: r.rows.length, truncated: r.total > r.rows.length, rows: r.rows.slice(0, PAGE) };
      });
      const summary = ctx.failed ? 'Hata' : ctx.cancelled ? 'İptal' : results.length ? results.map(r => r.total.toLocaleString('tr-TR') + ' satır').join(', ') : (ctx.affectedTotal ? ctx.affectedTotal.toLocaleString('tr-TR') + ' satır etkilendi' : 'Tamamlandı');
      data.history.unshift({ id: newId(), at: Date.now(), connId: c.id, connName: label(c), db: currentDb, sql: text.slice(0, 20000), ms, ok: !ctx.failed && !ctx.cancelled, summary });
      if (data.history.length > MAX_HISTORY) data.history.length = MAX_HISTORY;
      write('history');
      return { ok: !ctx.failed, cancelled: ctx.cancelled, results, messages: ctx.messages, ms, currentDb };
    });
  });
  handle('db:cancel', async tab => {
    const s = sessions.get(tab);
    if (!s || !s.busy) return { ok: false };
    const x = await s.ready;
    if (s.ctx) s.ctx.cancelled = true;
    const c = connById(s.connId);
    if (x.cancel) x.cancel();
    else if (c && isMy(c.type) && x.threadId) {
      const pw = passwordOf(c);
      try { const m = await meta(c, pw == null ? '' : pw, null); await m.q('KILL QUERY ' + Number(x.threadId)); } catch (_) {}
    }
    return { ok: true };
  });
  handle('db:closeTab', async tab => {
    const s = sessions.get(tab);
    sessions.delete(tab);
    if (s) s.ready.then(x => x.close(), () => {});
    for (const [id, r] of [...cache]) if (r.tab === tab) forget([id]);
    return { ok: true };
  });
  handle('db:rows', (id, offset, limit) => {
    const r = cache.get(id);
    if (!r) return { error: 'Sonuç artık bellekte değil; sorguyu yeniden çalıştır.' };
    const o = Math.max(0, offset | 0), l = Math.max(1, Math.min(20000, limit | 0 || PAGE));
    return { rows: r.rows.slice(o, o + l), fetched: r.rows.length };
  });
  handle('db:release', ids => { forget(ids); return { ok: true }; });
  handle('db:exportCsv', async (id, opts = {}) => {
    const r = cache.get(id);
    if (!r) return { error: 'Sonuç artık bellekte değil; sorguyu yeniden çalıştır.' };
    const sep = opts.sep === ';' ? ';' : opts.sep === '\t' ? '\t' : ',';
    const base = String(opts.name || 'sonuc').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'sonuc';
    const w = getWin(), dopts = { title: 'CSV olarak kaydet', defaultPath: base + '.csv', filters: [{ name: 'CSV', extensions: ['csv'] }, { name: 'Tüm dosyalar', extensions: ['*'] }] };
    const res = await (w ? dialog.showSaveDialog(w, dopts) : dialog.showSaveDialog(dopts));
    if (res.canceled || !res.filePath) return { canceled: true };
    const q = v => {
      if (v === null || v === undefined) return '';
      const s = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
      return /["\r\n]/.test(s) || s.includes(sep) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const out = fs.createWriteStream(res.filePath, { encoding: 'utf8' });
    out.write('﻿' + r.columns.map(c => q(c.name)).join(sep) + '\r\n');
    for (let i = 0; i < r.rows.length; i += 2000) {
      const chunk = r.rows.slice(i, i + 2000).map(row => row.map(q).join(sep)).join('\r\n') + '\r\n';
      if (!out.write(chunk)) await new Promise(ok => out.once('drain', ok));
    }
    await new Promise((ok, bad) => { out.end(ok); out.on('error', bad); });
    return { ok: true, file: res.filePath, rows: r.rows.length, truncated: r.total > r.rows.length, total: r.total };
  });
  handle('db:analyze', (sqlText, type) => analyze(String(sqlText || ''), TYPES[type] ? type : 'mssql'));

  /* ---------------- history, saved queries, editor state ---------------- */
  handle('db:history', () => ({ items: data.history }));
  handle('db:historyClear', () => { data.history = []; write('history', true); return { ok: true }; });
  handle('db:saved', () => ({ items: data.saved }));
  handle('db:savedSave', q => {
    const name = String((q && q.name) || '').trim().slice(0, 120) || 'Adsız sorgu';
    const sqlText = String((q && q.sql) || '').slice(0, 500000);
    let it = q && q.id ? data.saved.find(x => x.id === q.id) : null;
    if (it) Object.assign(it, { name, sql: sqlText, connId: q.connId || '', db: q.db || '', at: Date.now() });
    else { it = { id: newId(), name, sql: sqlText, connId: (q && q.connId) || '', db: (q && q.db) || '', at: Date.now() }; data.saved.unshift(it); }
    write('saved', true);
    return { item: it };
  });
  handle('db:savedDelete', id => { data.saved = data.saved.filter(x => x.id !== id); write('saved', true); return { ok: true }; });
  handle('db:getState', () => ({ state: data.state }));
  handle('db:setState', st => {
    if (st && typeof st === 'object') { data.state = JSON.parse(JSON.stringify(st)); write('state'); }
    return { ok: true };
  });

  /* close every connection when the app quits */
  let closed = false;
  function closeAll() {
    if (closed) return; closed = true;
    for (const k of Object.keys(timers)) if (timers[k]) writeNow(k);
    for (const p of metas.values()) p.then(m => m.close(), () => {});
    for (const s of sessions.values()) s.ready.then(x => x.close(), () => {});
    metas.clear(); sessions.clear(); cache.clear();
  }
  app.on('before-quit', closeAll);
  app.on('will-quit', closeAll);
  return { closeAll, analyze, splitGo };
};

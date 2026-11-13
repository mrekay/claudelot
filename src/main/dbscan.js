// VoxStorm — find database connection details in projects, for "İçe aktar" in DB mode.
// Reads .env files (DB_*, DATABASE_URL, MYSQL_*, PG*/POSTGRES_*) and VNL config_definitions.php
// (every `db_info = [...]` block, labelled by the testMode switch it sits in). Only literal values are
// taken; anything computed in PHP is skipped. Nothing here connects or writes anywhere.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const SKIP = new Set(['node_modules', 'vendor', '.git', 'dist', 'build', 'out', '.next', '.cache', 'storage', 'bin', 'obj', '.idea', '.vs', 'cache']);
const ENV_NAME = /^\.env(\.(local|dev|development|prod|production|staging|test|testing))?$/i;
const MAX_DEPTH = 4, MAX_FILES = 40, MAX_SIZE = 512 * 1024;

const TYPE = t => {
  t = String(t || '').toLowerCase();
  if (/maria/.test(t)) return 'mariadb';
  if (/mysql/.test(t)) return 'mysql';
  if (/pg|postgres/.test(t)) return 'pg';
  if (/sqlsrv|mssql|sqlserver|tedious/.test(t)) return 'mssql';
  return '';
};

async function findFiles(root) {
  const out = [];
  async function walk(dir, depth) {
    if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (out.length >= MAX_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name.toLowerCase())) await walk(full, depth + 1); }
      else if (e.isFile() && (ENV_NAME.test(e.name) || e.name.toLowerCase() === 'config_definitions.php')) out.push(full);
    }
  }
  await walk(root, 0);
  return out;
}

/* ---------------- .env ---------------- */
function parseEnv(text) {
  const v = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (/^"/.test(val)) val = (val.match(/^"((?:[^"\\]|\\.)*)"/) || [, ''])[1].replace(/\\(.)/g, '$1');
    else if (/^'/.test(val)) val = (val.match(/^'([^']*)'/) || [, ''])[1];
    else val = val.replace(/\s+#.*$/, '');
    v[m[1].toUpperCase()] = val;
  }
  return v;
}
function fromUrl(u) {
  try {
    const x = new URL(u);
    const type = TYPE(x.protocol);
    if (!type) return null;
    return { type, host: decodeURIComponent(x.hostname), port: x.port ? +x.port : null, user: decodeURIComponent(x.username), password: decodeURIComponent(x.password), database: decodeURIComponent(x.pathname.replace(/^\//, '')) };
  } catch (_) { return null; }
}
function envEntries(v) {
  const out = [];
  const pick = (...keys) => { for (const k of keys) if (v[k] !== undefined && v[k] !== '') return v[k]; return ''; };
  for (const k of ['DATABASE_URL', 'DB_URL', 'DB_DSN_URL']) { const e = v[k] && fromUrl(v[k]); if (e) out.push({ ...e, label: k }); }
  const host = pick('DB_HOST', 'DB_SERVER', 'DATABASE_HOST'), db = pick('DB_DATABASE', 'DB_NAME', 'DATABASE_NAME');
  if (host || db) {
    out.push({
      type: TYPE(pick('DB_CONNECTION', 'DB_DRIVER', 'DB_TYPE', 'DB_DIALECT', 'DB_CLIENT')) || (pick('DB_PORT') === '5432' ? 'pg' : pick('DB_PORT') === '1433' ? 'mssql' : 'mysql'),
      host, port: +pick('DB_PORT') || null, database: db,
      user: pick('DB_USERNAME', 'DB_USER', 'DATABASE_USER'), password: pick('DB_PASSWORD', 'DB_PASS', 'DATABASE_PASSWORD'), label: 'DB_*',
    });
  }
  if (v.MYSQL_HOST || v.MYSQL_DATABASE) out.push({ type: 'mysql', host: v.MYSQL_HOST || '', port: +v.MYSQL_PORT || null, database: v.MYSQL_DATABASE || '', user: v.MYSQL_USER || v.MYSQL_USERNAME || '', password: v.MYSQL_PASSWORD || '', label: 'MYSQL_*' });
  const pgHost = v.PGHOST || v.POSTGRES_HOST, pgDb = v.PGDATABASE || v.POSTGRES_DB;
  if (pgHost || pgDb) out.push({ type: 'pg', host: pgHost || '', port: +(v.PGPORT || v.POSTGRES_PORT) || null, database: pgDb || '', user: v.PGUSER || v.POSTGRES_USER || '', password: v.PGPASSWORD || v.POSTGRES_PASSWORD || '', label: 'PG' });
  return out;
}

/* ---------------- VNL config_definitions.php ---------------- */
function phpString(block, key) {
  const m = block.match(new RegExp(`['"]${key}['"]\\s*=>\\s*(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\$]|\\\\.)*)"|(\\d+))`));
  if (!m) return '';
  return (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] || '').replace(/\\(['"\\])/g, '$1');
}
function vnlEntries(text) {
  const out = [];
  const version = (text.match(/\$vnl_version\s*=\s*['"]([^'"]+)['"]/) || [])[1] || '';
  const re = /db_info\s*=\s*(?:\[|array\s*\()/g;
  let m;
  while ((m = re.exec(text))) {
    // the array runs to its matching bracket
    const open = text[m.index + m[0].length - 1], close = open === '[' ? ']' : ')';
    let depth = 1, i = m.index + m[0].length;
    for (; i < text.length && depth; i++) { if (text[i] === open) depth++; else if (text[i] === close) depth--; }
    const block = text.slice(m.index, i);
    // which environment: the nearest "case true/false:" (testMode switch) or "if (...testMode...)" before it
    const before = text.slice(Math.max(0, m.index - 1500), m.index);
    const cases = [...before.matchAll(/case\s+(true|false)\s*:/gi)];
    const env = cases.length ? (cases[cases.length - 1][1].toLowerCase() === 'true' ? 'test modu' : 'canlı') : '';
    out.push({
      type: TYPE(phpString(block, 'driver')) || 'mysql',
      host: phpString(block, 'host'), port: +phpString(block, 'port') || null,
      database: phpString(block, 'database'), user: phpString(block, 'username'), password: phpString(block, 'password'),
      label: env, version,
    });
  }
  return out;
}

// VNL 3.x keeps its version in vnl/VERSION next to the app's .env (2.x wrote it into config_definitions.php)
async function vnlVersionNear(dir) {
  for (const f of [path.join(dir, 'vnl', 'VERSION'), path.join(dir, 'VERSION')]) {
    try {
      const v = (await fsp.readFile(f, 'utf8')).trim().split(/\r?\n/)[0];
      if (/^\d+\.\d+(\.\d+)?/.test(v) && (f.includes(path.sep + 'vnl' + path.sep) || fs.existsSync(path.join(dir, 'vnl')))) return v;
    } catch (_) {}
  }
  return '';
}

// [{ project, file (relative), source, label, type, host, port, database, user, password }]
async function scanProject(project) {
  const found = [];
  for (const file of await findFiles(project.path)) {
    let text;
    try { const st = await fsp.stat(file); if (st.size > MAX_SIZE) continue; text = await fsp.readFile(file, 'utf8'); } catch (_) { continue; }
    const rel = path.relative(project.path, file).split(path.sep).join('/');
    const isEnv = ENV_NAME.test(path.basename(file));
    const entries = isEnv ? envEntries(parseEnv(text)) : vnlEntries(text);
    const vnl = isEnv ? await vnlVersionNear(path.dirname(file)) : '';
    for (const e of entries) {
      if (!e.type || (!e.host && !e.database)) continue;
      if (/^\$\{|^%|getenv|env\(/i.test(e.host + e.database + e.user)) continue; // not literal values
      const source = isEnv ? (vnl ? `VNL ${vnl} · .env` : '.env') : `VNL ${e.version || ''}`.trim();
      found.push({ ...e, project: project.name, projectId: project.id, file: rel, source });
    }
  }
  return found;
}

module.exports = { scanProject, parseEnv, envEntries, vnlEntries };

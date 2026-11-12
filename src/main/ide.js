// Claudelot — IDE helpers in the main process: project file index, text search,
// file operations (rename, new folder, move to Recycle Bin), git status colours and
// a folder watcher. Every path is checked with insideProject(), like fs:read / fs:write.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { execFile } = require('child_process');

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache', '__pycache__', '.venv', 'venv', 'bin', 'obj', '.idea', '.vs']);
const MAX_FILES = 20000;
const MAX_HITS = 2000;
const MAX_SEARCH_SIZE = 1024 * 1024;

module.exports = function registerIde({ ipcMain, shell, insideProject, isProjectRoot, send }) {
  const guard = p => {
    if (typeof p !== 'string' || !p || p.includes('\0') || !insideProject(p)) throw new Error('Proje dışında');
    return path.resolve(p);
  };

  /* every file under a project folder (relative paths), for quick open and search */
  async function walk(root, onFile) {
    const stack = [root];
    let n = 0;
    while (stack.length) {
      const dir = stack.pop();
      let ents;
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of ents) {
        if (IGNORE.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) { if (++n > MAX_FILES) return false; if (await onFile(full) === false) return false; }
      }
    }
    return true;
  }

  ipcMain.handle('ide:files', async (_e, root) => {
    root = guard(root);
    const files = [];
    const complete = await walk(root, f => { files.push(path.relative(root, f)); });
    return { files, complete };
  });

  /* plain-text search across the project; query is literal unless opts.regex */
  ipcMain.handle('ide:search', async (_e, root, query, opts = {}) => {
    root = guard(root);
    if (typeof query !== 'string' || !query) return { hits: [], files: 0, truncated: false };
    let re;
    try {
      const src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(opts.word ? `\\b(?:${src})\\b` : src, opts.case ? 'g' : 'gi');
    } catch (err) { return { error: 'Geçersiz düzenli ifade: ' + err.message }; }
    const hits = [];
    let files = 0, truncated = false;
    await walk(root, async f => {
      let st; try { st = await fsp.stat(f); } catch (_) { return; }
      if (st.size > MAX_SEARCH_SIZE || st.size === 0) return;
      let buf; try { buf = await fsp.readFile(f); } catch (_) { return; }
      if (buf.subarray(0, 8000).includes(0)) return;
      const lines = buf.toString('utf8').split(/\r?\n/);
      let any = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        re.lastIndex = 0;
        const m = re.exec(line);
        if (!m) continue;
        any = true;
        // keep the preview short but centred on the match
        const start = Math.max(0, m.index - 60);
        hits.push({ file: path.relative(root, f), line: i + 1, col: m.index, len: Math.max(1, m[0].length), pre: start, text: line.slice(start, start + 220) });
        if (hits.length >= MAX_HITS) { truncated = true; break; }
      }
      if (any) files++;
      if (truncated) return false;
    });
    return { hits, files, truncated };
  });

  ipcMain.handle('fs:stat', async (_e, p) => {
    p = guard(p);
    try { const st = await fsp.stat(p); return { exists: true, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }; } catch (_) { return { exists: false }; }
  });

  ipcMain.handle('fs:mkdir', async (_e, dir) => {
    dir = guard(dir);
    if (fs.existsSync(dir)) throw new Error('Bu adda bir dosya ya da klasör zaten var.');
    await fsp.mkdir(dir, { recursive: true });
    return true;
  });

  ipcMain.handle('fs:rename', async (_e, from, to) => {
    from = guard(from); to = guard(to);
    if (isProjectRoot(from)) throw new Error('Proje klasörünün kendisi yeniden adlandırılamaz.');
    // a case-only rename (a.js -> A.js) is the same file on Windows
    if (from.toLowerCase() !== to.toLowerCase() && fs.existsSync(to)) throw new Error('Bu adda bir dosya ya da klasör zaten var.');
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    return true;
  });

  /* "delete" moves to the Recycle Bin, so a mistake can be undone */
  ipcMain.handle('fs:trash', async (_e, p) => {
    p = guard(p);
    if (isProjectRoot(p)) throw new Error('Proje klasörünün kendisi silinemez.');
    await shell.trashItem(p);
    return true;
  });

  ipcMain.handle('fs:reveal', (_e, p) => { shell.showItemInFolder(guard(p)); return true; });

  /* git status per file, for colours in the tree and the tabs (read-only) */
  ipcMain.handle('ide:git', (_e, root) => {
    root = guard(root);
    return new Promise(resolve => {
      execFile('git', ['-C', root, '-c', 'core.quotepath=off', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no'],
        { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
          if (err) { resolve({ repo: false, files: {} }); return; }
          execFile('git', ['-C', root, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 4000 }, (e2, info) => {
            const [top = '', branch = ''] = e2 ? [] : String(info).trim().split(/\r?\n/);
            const files = {};
            const parts = out.split('\0');
            for (let i = 0; i < parts.length; i++) {
              const l = parts[i]; if (l.length < 4) continue;
              const x = l[0], y = l[1], rel = l.slice(3);
              if (x === 'R' || x === 'C') i++; // the next entry is the old name
              let code = 'M';
              if (x === '?' && y === '?') code = 'U';
              else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) code = 'C';
              else if (x === 'A') code = 'A';
              else if (x === 'D' || y === 'D') code = 'D';
              else if (x === 'R') code = 'R';
              files[path.resolve(top || root, rel).toLowerCase()] = code;
            }
            resolve({ repo: true, branch, files });
          });
        });
    });
  });

  /* one watcher for the project open in the IDE; changes are batched and sent to the window */
  let watcher = null, watchRoot = null, timer = null, pending = new Set(), gitDirty = false;
  function stopWatch() { if (watcher) { try { watcher.close(); } catch (_) {} } watcher = null; watchRoot = null; pending.clear(); }
  function flush() {
    timer = null;
    if (!watchRoot) return;
    send('ide:fs-changed', { root: watchRoot, paths: [...pending].slice(0, 500), many: pending.size > 500, git: gitDirty });
    pending.clear(); gitDirty = false;
  }
  ipcMain.handle('ide:watch', (_e, root) => {
    if (!root) { stopWatch(); return false; }
    root = guard(root);
    if (watchRoot && watchRoot.toLowerCase() === root.toLowerCase()) return true;
    stopWatch();
    try {
      watcher = fs.watch(root, { recursive: true }, (_type, name) => {
        if (!name) return;
        const segs = String(name).split(/[\\/]/);
        if (segs[0] === '.git') {
          // index / HEAD / refs change on commit, checkout, add: refresh git colours only
          if (/^(index|HEAD|refs)$/.test(segs[1] || '')) { gitDirty = true; if (!timer) timer = setTimeout(flush, 350); }
          return;
        }
        if (segs.some(s => IGNORE.has(s))) return;
        pending.add(path.join(root, name));
        gitDirty = true;
        if (!timer) timer = setTimeout(flush, 350);
      });
      watcher.on('error', () => stopWatch());
      watchRoot = root;
      return true;
    } catch (_) { stopWatch(); return false; }
  });
};

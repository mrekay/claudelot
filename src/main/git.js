// Claudelot — git / GitHub (read-only)
// Every git call runs as `git -C <project>` and only for a registered project folder.
// GitHub data comes from `gh api` when the GitHub CLI is installed and signed in
// (private repos too), otherwise from the public REST API without a token.
const path = require('path');
const fsp = require('fs').promises;
const { execFile } = require('child_process');
const { net } = require('electron');

const GIT_HASH = /^[0-9a-f]{4,40}$/i;
const STASH_REF = /^stash@\{\d{1,4}\}$/;
const PATCH_CAP = 2 * 1024 * 1024;
const LOG_FMT = '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%D%x1f%s%x1f%b%x1e';

module.exports = function gitApi({ isProject, insideProject, whereFirst, identity }) {
  function git(cwd, args, { maxBuffer = 32 * 1024 * 1024, timeout = 15000, env } = {}) {
    return new Promise((resolve, reject) => {
      execFile('git', ['-C', cwd, '-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args],
        { encoding: 'utf8', windowsHide: true, maxBuffer, timeout, env: env ? { ...process.env, ...env } : undefined },
        (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim().split('\n')[0])) : resolve(out)));
    });
  }
  const gitSafe = (cwd, args, o) => git(cwd, args, o).catch(() => '');
  function check(p) {
    if (!p || !isProject(p)) throw new Error('Kayıtlı bir proje değil');
    return p;
  }

  function parseLog(out) {
    return out.split('\x1e').map(s => s.replace(/^\s+/, '')).filter(Boolean).map(r => {
      const [hash, short, author, email, at, parents, refs, subject, body = ''] = r.split('\x1f');
      const b = body.trim();
      const claude = /co-authored-by:\s*claude\b|generated with \[?claude code/i.test(b) || /^claude\b/i.test(author);
      return { hash, short, author, email, at: Number(at) * 1000, parents: parents ? parents.split(' ') : [], refs, subject, body: b, claude };
    });
  }
  function parseStatus(out) {
    const st = { branch: '', upstream: '', ahead: 0, behind: 0, detached: false, staged: [], unstaged: [], untracked: [], conflicted: [] };
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const l = parts[i]; if (!l) continue;
      if (l.startsWith('# branch.head ')) { st.branch = l.slice(14); st.detached = st.branch === '(detached)'; }
      else if (l.startsWith('# branch.upstream ')) st.upstream = l.slice(18);
      else if (l.startsWith('# branch.ab ')) { const m = l.match(/\+(\d+) -(\d+)/); if (m) { st.ahead = +m[1]; st.behind = +m[2]; } }
      else if (l[0] === '1' || l[0] === '2') {
        const f = l.split(' '); const xy = f[1];
        const file = (l[0] === '1' ? f.slice(8) : f.slice(9)).join(' ');
        const from = l[0] === '2' ? parts[++i] : '';
        if (xy[0] !== '.') st.staged.push({ path: file, from, code: xy[0] });
        if (xy[1] !== '.') st.unstaged.push({ path: file, code: xy[1] });
      } else if (l[0] === 'u') st.conflicted.push({ path: l.split(' ').slice(10).join(' '), code: 'U' });
      else if (l[0] === '?') st.untracked.push({ path: l.slice(2), code: '?' });
    }
    return st;
  }
  const parseNumstat = out => out.split('\n').filter(Boolean).map(l => {
    const [a, d, ...f] = l.split('\t');
    return { path: f.join('\t'), add: a === '-' ? null : +a, del: d === '-' ? null : +d };
  });
  const cap = s => (s.length > PATCH_CAP ? { text: s.slice(0, PATCH_CAP), truncated: true } : { text: s, truncated: false });
  function githubOf(url) {
    const m = String(url || '').trim().match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
    return m ? { owner: m[1], repo: m[2], url: `https://github.com/${m[1]}/${m[2]}` } : null;
  }
  const unpushedSet = out => new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
  async function remoteUrl(p) {
    const origin = (await gitSafe(p, ['remote', 'get-url', 'origin'])).trim();
    if (origin) return origin;
    const m = (await gitSafe(p, ['remote', '-v'])).match(/^\S+\s+(\S+)/m);
    return m ? m[1] : '';
  }

  /* small, frequent: branch + ahead count for the title-bar button */
  async function head(p) {
    check(p);
    const out = await gitSafe(p, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no'], { timeout: 6000 });
    if (!out) return { repo: false };
    const st = parseStatus(out);
    const remotes = (await gitSafe(p, ['remote'])).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    return { repo: true, branch: st.branch, detached: st.detached, ahead: st.ahead, behind: st.behind, upstream: st.upstream,
      dirty: st.staged.length + st.unstaged.length + st.conflicted.length, conflicted: st.conflicted.length, remotes };
  }

  /* the one-click actions: fetch (check), pull (fast-forward only), push / publish.
     No merges, rebases or force pushes: anything that needs a decision is left to the user. */
  const NET = { timeout: 90000, env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'auto' } };
  async function sync(p, action) {
    check(p);
    const h = await head(p);
    if (!h.repo) throw new Error('Bu proje bir git deposu değil.');
    if (!h.remotes.length) throw new Error('Bu deponun uzak bağlantısı (remote) yok.');
    if (action === 'fetch') await git(p, ['fetch', '--prune', '--quiet'], NET);
    else if (action === 'pull') {
      if (h.detached) throw new Error('Bir dalda değilsin (detached HEAD).');
      if (!h.upstream) throw new Error('Bu dalın uzak karşılığı yok.');
      if (h.conflicted) throw new Error('Çözülmemiş çakışmalar var.');
      await git(p, ['pull', '--ff-only', '--quiet'], NET).catch(e => {
        if (/not possible to fast-forward|diverg|fast-forward/i.test(e.message)) throw new Error('Yerel ve uzak dal ayrışmış; otomatik birleştirmedim. Önce birleştirme ya da rebase gerekiyor.');
        if (/would be overwritten/i.test(e.message)) throw new Error('Gelen değişiklikler, commit edilmemiş dosyalarının üzerine yazacak. Önce commit ya da stash yap.');
        throw e;
      });
    } else if (action === 'push') {
      if (h.detached) throw new Error('Bir dalda değilsin (detached HEAD).');
      if (h.upstream) await git(p, ['push', '--quiet'], NET).catch(e => {
        if (/rejected|fetch first|non-fast-forward/i.test(e.message)) throw new Error('Uzakta sende olmayan commitler var. Önce pull yap.');
        throw e;
      });
      else await git(p, ['push', '--quiet', '-u', h.remotes.includes('origin') ? 'origin' : h.remotes[0], 'HEAD'], NET);
    } else throw new Error('Bilinmeyen işlem');
    return { before: h, after: await head(p) };
  }

  async function overview(p, n = 8) {
    check(p);
    const top = (await gitSafe(p, ['rev-parse', '--show-toplevel'])).trim();
    if (!top) return { repo: false };
    const [statusOut, logOut, unpushedOut, stashOut, remote] = await Promise.all([
      gitSafe(p, ['status', '--porcelain=v2', '--branch', '-z']),
      gitSafe(p, ['log', '-n', String(n), LOG_FMT]),
      gitSafe(p, ['rev-list', '@{u}..HEAD']),
      gitSafe(p, ['stash', 'list', '--format=%gd%x1f%s%x1f%at%x1e']),
      remoteUrl(p),
    ]);
    const st = parseStatus(statusOut);
    const unpushed = unpushedSet(unpushedOut);
    const commits = parseLog(logOut).map(c => ({ ...c, pushed: st.upstream ? !unpushed.has(c.hash) : null }));
    const stashes = stashOut.split('\x1e').map(s => s.trim()).filter(Boolean).map(r => {
      const [ref, msg, at] = r.split('\x1f');
      return { ref, msg, at: Number(at) * 1000 };
    });
    return { repo: true, top, ...st, unpushedCount: unpushed.size, commits, stashes, remote, github: githubOf(remote) };
  }

  async function log(p, skip = 0, n = 50) {
    check(p);
    const [logOut, unpushedOut, up] = await Promise.all([
      git(p, ['log', '-n', String(Math.min(200, Math.max(1, n | 0))), '--skip', String(Math.max(0, skip | 0)), LOG_FMT]),
      gitSafe(p, ['rev-list', '@{u}..HEAD']),
      gitSafe(p, ['rev-parse', '--abbrev-ref', '@{u}']),
    ]);
    const unpushed = unpushedSet(unpushedOut);
    return parseLog(logOut).map(c => ({ ...c, pushed: up.trim() ? !unpushed.has(c.hash) : null }));
  }

  async function show(p, hash) {
    check(p);
    if (!GIT_HASH.test(hash)) throw new Error('Geçersiz commit');
    const [meta, stat, patch, unpushedOut, up] = await Promise.all([
      git(p, ['log', '-1', LOG_FMT, hash]),
      git(p, ['show', '--format=', '--numstat', '-M', hash]),
      git(p, ['show', '--format=', '--patch', '-M', '--no-ext-diff', hash]),
      gitSafe(p, ['rev-list', '@{u}..HEAD']),
      gitSafe(p, ['rev-parse', '--abbrev-ref', '@{u}']),
    ]);
    const c = parseLog(meta)[0];
    return { ...c, pushed: up.trim() ? !unpushedSet(unpushedOut).has(c.hash) : null, files: parseNumstat(stat), patch: cap(patch) };
  }

  async function diff(p, kind, file) {
    check(p);
    if (typeof file !== 'string' || !file || file.includes('\0')) throw new Error('Geçersiz dosya');
    if (kind === 'untracked') {
      const full = path.join(p, file);
      if (!insideProject(full)) throw new Error('Proje dışında');
      const st = await fsp.stat(full);
      if (st.isDirectory()) return { untracked: true, dir: true };
      if (st.size > PATCH_CAP) return { untracked: true, big: true };
      const buf = await fsp.readFile(full);
      if (buf.subarray(0, 8000).includes(0)) return { untracked: true, binary: true };
      return { untracked: true, text: buf.toString('utf8') };
    }
    const args = ['diff', ...(kind === 'staged' ? ['--cached'] : []), '-M', '--no-ext-diff', '--', file];
    return { patch: cap(await git(p, args)) };
  }

  async function stash(p, ref) {
    check(p);
    if (!STASH_REF.test(ref)) throw new Error('Geçersiz stash');
    const [stat, patch] = await Promise.all([
      git(p, ['stash', 'show', '--numstat', ref]),
      git(p, ['stash', 'show', '--patch', '--no-ext-diff', ref]),
    ]);
    return { files: parseNumstat(stat), patch: cap(patch) };
  }

  /* ---------- GitHub ---------- */
  const ghCache = new Map();
  let ghCli = null;
  function ghRun(route) {
    return new Promise(res => execFile('gh', ['api', route], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      (err, o, e) => res(err ? { err: String(e || err.message) } : { o })));
  }
  async function ghApi(route) {
    if (ghCli === null) ghCli = whereFirst('gh').length > 0;
    if (ghCli) {
      const r = await ghRun(route);
      if (!r.err) { try { return { data: JSON.parse(r.o), via: 'gh' }; } catch (_) { return { error: 'GitHub yanıtı okunamadı', via: 'gh' }; } }
      if (/HTTP 404/.test(r.err)) return { status: 404, via: 'gh' };
      if (!/auth login|not logged|authentication/i.test(r.err)) return { error: r.err.split('\n')[0], via: 'gh' };
      // gh is installed but not signed in: fall back to the public API
    }
    const r = await net.fetch('https://api.github.com/' + route, { headers: { 'User-Agent': 'Claudelot', Accept: 'application/vnd.github+json' } });
    if (!r.ok) return { status: r.status, via: 'public', limited: r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0' };
    return { data: await r.json(), via: 'public' };
  }
  async function github(p, force) {
    check(p);
    const remote = await remoteUrl(p);
    const gh = githubOf(remote);
    if (!gh) return { github: null, remote };
    const key = (gh.owner + '/' + gh.repo).toLowerCase();
    const hit = ghCache.get(key);
    if (hit && !force && Date.now() - hit.at < 60000) return hit.v;
    const base = `repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}`;
    const safe = pr => pr.catch(e => ({ error: e.message }));
    const [repo, pulls, issues, runs] = await Promise.all([
      safe(ghApi(base)), safe(ghApi(base + '/pulls?state=open&per_page=6')),
      safe(ghApi(base + '/issues?state=open&per_page=12')), safe(ghApi(base + '/actions/runs?per_page=6')),
    ]);
    const d = repo.data;
    const v = {
      github: gh, remote, via: repo.via || '', login: (identity() || {}).github || '',
      repo: d ? {
        fullName: d.full_name, description: d.description, stars: d.stargazers_count, forks: d.forks_count, watchers: d.subscribers_count,
        openIssues: d.open_issues_count, private: d.private, defaultBranch: d.default_branch, pushedAt: d.pushed_at, url: d.html_url, language: d.language,
      } : null,
      repoStatus: repo.status || 0, repoError: repo.error || '', limited: !!repo.limited,
      pulls: Array.isArray(pulls.data) ? pulls.data.map(x => ({ n: x.number, title: x.title, user: x.user && x.user.login, at: x.created_at, draft: x.draft, url: x.html_url, branch: x.head && x.head.ref })) : [],
      issues: Array.isArray(issues.data) ? issues.data.filter(x => !x.pull_request).slice(0, 6).map(x => ({ n: x.number, title: x.title, user: x.user && x.user.login, at: x.created_at, url: x.html_url, comments: x.comments })) : [],
      runs: runs.data && Array.isArray(runs.data.workflow_runs) ? runs.data.workflow_runs.map(x => ({ name: x.name, title: x.display_title, status: x.status, conclusion: x.conclusion, branch: x.head_branch, at: x.created_at, url: x.html_url })) : [],
    };
    if (d) ghCache.set(key, { at: Date.now(), v });
    return v;
  }

  return { head, sync, overview, log, show, diff, stash, github };
};

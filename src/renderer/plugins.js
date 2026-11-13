/* VoxStorm — plugin host (window side).
   Each enabled plugin runs in sandboxed iframes served from voxplugin://<id>/: a hidden background
   frame for its "main" script, plus one frame per panel it adds. A frame talks to the app only by
   postMessage; every request is matched to its plugin by the frame it came from and checked against
   the permissions the user granted (main checks files, commands and storage once more). */
(() => {
  'use strict';
  const SCHEME = 'voxplugin';
  const PERM_TEXT = {
    notify: ['fa-regular fa-bell', 'Bildirim gösterme'],
    storage: ['fa-solid fa-box-archive', 'Kendi verilerini saklama'],
    'fs.read': ['fa-regular fa-file-lines', 'Projelerindeki dosyaları okuma'],
    'fs.write': ['fa-solid fa-pen-to-square', 'Projelerindeki dosyaları değiştirme'],
    shell: ['fa-solid fa-terminal', 'Projelerinde komut çalıştırma (bilgisayarında her şeyi yapabilir)'],
    claude: ['fa-solid fa-robot', 'Claude oturumu başlatma ve açık oturuma mesaj yazma'],
    net: ['fa-solid fa-globe', 'İnternete bağlanma'],
  };
  const RISKY = new Set(['shell', 'fs.write']);
  const THEME_VARS = ['--bg', '--surface', '--surface-2', '--hover', '--line', '--fg', '--muted', '--accent', '--accent-soft', '--on-accent', '--warn', '--warn-soft', '--ok', '--ok-soft', '--danger', '--violet', '--violet-soft', '--f-mono'];

  const P = new Map(); // id -> { info, frames: Set<iframe>, buttons: Map, panels: Map, commands: Map, log: [] }
  let LIST = { dir: '', list: [] };
  let drawer = null; // { id, panelId }
  let wantMode = '';
  let lastState = '';
  let stateTimer = 0;

  const escH = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = s => escH(String(s || 'fa-solid fa-puzzle-piece').replace(/[^\w\s-]/g, ''));
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  const okId = v => /^[\w.-]{1,64}$/.test(String(v || ''));

  /* ---------------- frames ---------------- */
  function makeFrame(st, src, cls) {
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts allow-forms');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute('allow', '');
    f.className = cls;
    f.title = st.info.name;
    f.src = src;
    st.frames.add(f);
    return f;
  }
  function pluginOf(win) {
    for (const st of P.values()) for (const f of st.frames) if (f.contentWindow === win) return { st, frame: f };
    return null;
  }
  function emit(st, event, data) {
    for (const f of st.frames) try { f.contentWindow && f.contentWindow.postMessage({ vox: 1, event, data }, '*'); } catch (_) {}
  }
  const emitAll = (event, data) => P.forEach(st => emit(st, event, data));

  /* ---------------- theme and app state for plugins ---------------- */
  function theme() {
    const cs = getComputedStyle(document.documentElement), vars = {};
    for (const v of THEME_VARS) vars[v] = cs.getPropertyValue(v).trim();
    vars['--font'] = getComputedStyle(document.body).fontFamily;
    const bg = vars['--bg'] || '#000';
    const m = bg.match(/^#([0-9a-f]{6})$/i);
    const dark = m ? (parseInt(m[1].slice(0, 2), 16) * 299 + parseInt(m[1].slice(2, 4), 16) * 587 + parseInt(m[1].slice(4, 6), 16) * 114) / 1000 < 128 : true;
    return { vars, dark, skin: document.documentElement.dataset.skin || 'violet' };
  }
  // the project the user is looking at: in AI mode the selected session's, in IDE mode the IDE's.
  // No fallback to "the first project": a panel tied to a project should hide when none is in view.
  function contextProject() {
    if (S.mode === 'ide') return IDE.project || null;
    if (S.mode === 'claude') { const t = tabById(S.active); return t ? t.projectId || null : null; }
    return null;
  }
  function appState() {
    const pr = id => { const p = S.projects.find(x => x.id === id); return p ? { id: p.id, name: p.name, path: p.path } : null; };
    return {
      mode: S.mode,
      project: pr(contextProject()),
      projects: S.projects.map(p => ({ id: p.id, name: p.name, path: p.path })),
      sessions: S.tabs.map(t => ({ id: t.id, kind: t.kind, title: t.title, status: t.status, projectId: t.projectId, sessionId: t.sessionId || null, active: t.id === S.active })),
      pending: typeof pendingCount === 'function' ? pendingCount() : 0,
    };
  }

  /* ---------------- requests from plugin frames ---------------- */
  function need(st, perm) {
    if (!st.info.permissions.includes(perm)) throw new Error(`Bu eklenti manifest.json'da "${perm}" iznini istemiyor`);
  }
  const API = {
    hello: (st, p, frame) => ({ id: st.info.id, name: st.info.name, version: st.info.version, permissions: st.info.permissions, theme: theme(), state: appState(), panel: frame.dataset.panel || null, place: frame.dataset.panel ? ((st.panels.get(frame.dataset.panel) || {}).place || null) : null }),
    'app.state': () => appState(),
    'app.setMode': (st, p) => { const m = String(p && p.mode || ''); if (['claude', 'ide', 'db'].includes(m)) setMode(m); return true; },
    'app.openUrl': (st, p) => { const u = String(p && p.url || ''); if (!/^https:\/\//i.test(u)) throw new Error('Yalnızca https:// adresleri açılabilir'); window.open(u, '_blank'); return true; },

    'ui.toast': (st, p) => { toast(str(p && p.title, 120), str(p && p.body, 300)); return true; },
    'ui.confirm': (st, p) => uiConfirm({ title: str(p && p.title || st.info.name, 120), message: str(p && p.message, 2000), detail: str(p && p.detail, 2000), ok: str(p && p.ok || 'Tamam', 40), cancel: str(p && p.cancel || 'Vazgeç', 40), danger: !!(p && p.danger), icon: 'fa-puzzle-piece' }),
    'ui.prompt': (st, p) => uiPrompt({ title: str(p && p.title || st.info.name, 120), message: str(p && p.message, 2000), input: str(p && p.value, 2000), placeholder: str(p && p.placeholder, 200), ok: str(p && p.ok || 'Tamam', 40), icon: 'fa-puzzle-piece' }),
    'ui.addButton': (st, p) => {
      if (!p || !okId(p.id)) throw new Error('Düğmenin geçerli bir id\'si olmalı');
      const place = p.place === 'statusbar' ? 'statusbar' : 'titlebar';
      st.buttons.set(p.id, { id: p.id, place, icon: str(p.icon, 60), label: str(p.label, 40), title: str(p.title, 200), badge: str(p.badge, 6), panel: p.panel && okId(p.panel) ? p.panel : '' });
      renderButtons(); return true;
    },
    'ui.updateButton': (st, p) => {
      const b = p && st.buttons.get(p.id); if (!b) throw new Error('Böyle bir düğme yok');
      for (const [k, n] of [['icon', 60], ['label', 40], ['title', 200], ['badge', 6]]) if (p[k] !== undefined) b[k] = str(p[k], n);
      renderButtons(); return true;
    },
    'ui.removeButton': (st, p) => { st.buttons.delete(p && p.id); renderButtons(); return true; },
    'ui.addPanel': (st, p) => {
      if (!p || !okId(p.id)) throw new Error('Panelin geçerli bir id\'si olmalı');
      const page = str(p.page, 200).replace(/\\/g, '/').replace(/^\/+/, '');
      if (!page || page.split('/').includes('..') || page.startsWith('__vox__')) throw new Error('page, eklenti klasöründeki bir .html dosyası olmalı');
      const old = st.panels.get(p.id);
      if (old) removePanel(st, old);
      const place = ['mode', 'side'].includes(p.place) ? p.place : 'drawer';
      // side panels can be limited to projects (by name or folder name): shown only while one is in view
      const projects = Array.isArray(p.projects) ? p.projects.map(x => str(x, 200).toLowerCase()).filter(Boolean).slice(0, 20) : [];
      st.panels.set(p.id, { id: p.id, title: str(p.title || st.info.name, 60), icon: str(p.icon || st.info.icon, 60), page, place, projects, height: Math.min(Math.max(+p.height || 300, 100), 1200), frame: null, secs: {} });
      renderModes(); renderButtons(); renderSideSecs();
      if (wantMode === modeKey(st.info.id, p.id) && S.mode === 'claude') { wantMode = ''; setMode(wantMode || modeKey(st.info.id, p.id), true); }
      return true;
    },
    'ui.openPanel': (st, p) => { openPanel(st, p && p.id); return true; },
    'ui.closePanel': (st, p) => { closePanel(st, p && p.id); return true; },

    'commands.register': (st, p) => {
      if (!p || !okId(p.id)) throw new Error('Komutun geçerli bir id\'si olmalı');
      const keys = normKeys(p.keys);
      if (keys && SHORTCUTS.some(s => s.keys === keys && s.plugin !== st.info.id + ':' + p.id)) throw new Error(`${keys} kısayolu zaten kullanılıyor`);
      unregisterCommand(st, p.id);
      const sc = { group: 'Eklenti · ' + st.info.name, keys: keys || '—', label: escH(str(p.title || p.id, 80)), plugin: st.info.id + ':' + p.id, run: keys ? () => emit(st, 'command', { id: p.id }) : null };
      SHORTCUTS.push(sc);
      st.commands.set(p.id, sc);
      return true;
    },
    'commands.unregister': (st, p) => { unregisterCommand(st, p && p.id); return true; },

    notify: (st, p) => {
      need(st, 'notify');
      const title = str(p && p.title, 120), body = str(p && p.body, 300);
      S.notifs.unshift({ type: 'plugin', title: `${st.info.name}: ${title}`, body, t: Date.now() });
      S.notifs = S.notifs.slice(0, 80);
      if ($('#pop').hidden) S.unread++;
      if (!(CFG.settings.notif || {}).quiet) api.send('notify', { title: `${st.info.name}: ${title}`, body });
      renderStatus(); if (!$('#pop').hidden) renderPop();
      return true;
    },
    'storage.get': (st, p) => (need(st, 'storage'), api.invoke('plugin:storage', st.info.id, 'get', p && p.key)),
    'storage.set': (st, p) => (need(st, 'storage'), api.invoke('plugin:storage', st.info.id, 'set', p && p.key, p && p.value)),
    'storage.remove': (st, p) => (need(st, 'storage'), api.invoke('plugin:storage', st.info.id, 'remove', p && p.key)),
    'storage.keys': st => (need(st, 'storage'), api.invoke('plugin:storage', st.info.id, 'keys')),
    'fs.read': (st, p) => (need(st, 'fs.read'), api.invoke('plugin:fs', st.info.id, 'read', p && p.path)),
    'fs.list': (st, p) => (need(st, 'fs.read'), api.invoke('plugin:fs', st.info.id, 'list', p && p.path)),
    'fs.stat': (st, p) => (need(st, 'fs.read'), api.invoke('plugin:fs', st.info.id, 'stat', p && p.path)),
    'fs.write': (st, p) => (need(st, 'fs.write'), api.invoke('plugin:fs', st.info.id, 'write', p && p.path, p && p.content)),
    'fs.mkdir': (st, p) => (need(st, 'fs.write'), api.invoke('plugin:fs', st.info.id, 'mkdir', p && p.path)),
    'shell.run': (st, p) => {
      need(st, 'shell');
      const here = S.projects.find(x => x.id === projectHere());
      return api.invoke('plugin:shell', st.info.id, str(p && p.command, 8000), { cwd: (p && p.cwd) || (here && here.path) || '', timeout: p && p.timeout, runId: p && p.runId });
    },
    'shell.stop': st => (need(st, 'shell'), api.invoke('plugin:stop', st.info.id).then(() => true)),
    'claude.newSession': async (st, p) => {
      need(st, 'claude');
      const pid = (p && p.projectId) || projectHere();
      if (!S.projects.some(x => x.id === pid)) throw new Error('Proje bulunamadı');
      const t = await openTerminal({ kind: 'claude', projectId: pid, title: str(p && p.title || 'Yeni oturum', 48) });
      if (!t) throw new Error('Oturum açılamadı');
      if (p && p.prompt) { t.pendingPrompt = str(p.prompt, 20000); setTimeout(() => sendPendingPrompt(t), 12000); }
      return { id: t.id };
    },
    'claude.send': (st, p) => {
      need(st, 'claude');
      const t = tabById((p && p.tabId) || S.active);
      if (!t || t.kind !== 'claude' || t.exited) throw new Error('Açık bir Claude oturumu seçili değil');
      const text = str(p && p.text, 20000).replace(/\r?\n/g, ' ');
      api.send('pty:write', t.id, text);
      if (!(p && p.submit === false)) setTimeout(() => { if (!t.exited) api.send('pty:write', t.id, '\r'); }, 300);
      return true;
    },
    // kept for the settings row, and written to plugin-logs\<id>.log for whoever writes the plugin
    log: (st, p) => {
      const level = str(p && p.level, 10), text = str(p && p.text, 2000);
      st.log.push({ t: Date.now(), level, text }); st.log = st.log.slice(-200);
      api.invoke('plugins:log', st.info.id, level, text).catch(() => {});
      return true;
    },
  };
  // live command output goes to every page of the plugin; the SDK hands it to the run that asked
  api.on('plugin:shell-out', (id, runId, stream, text) => { const st = P.get(id); if (st) emit(st, 'shell-output', { runId, stream, text }); });
  window.addEventListener('message', async e => {
    const m = e.data;
    if (!m || m.vox !== 1 || typeof m.method !== 'string') return;
    const who = pluginOf(e.source);
    if (!who) return;
    const fn = Object.prototype.hasOwnProperty.call(API, m.method) ? API[m.method] : null;
    let result, error;
    try {
      if (!fn) throw new Error('Bilinmeyen çağrı: ' + m.method);
      result = await fn(who.st, m.params && typeof m.params === 'object' ? m.params : {}, who.frame);
    } catch (err) { error = String(err && err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
    try { e.source.postMessage({ vox: 1, re: m.id, result, error }, '*'); } catch (_) {}
  });

  /* ---------------- buttons, modes, drawer ---------------- */
  const modeKey = (id, panelId) => `plugin:${id}:${panelId}`;
  function renderButtons() {
    const tb = document.getElementById('plugTb');
    if (tb) {
      let h = '';
      P.forEach(st => st.buttons.forEach(b => {
        if (b.place !== 'titlebar') return;
        const on = b.panel && drawer && drawer.id === st.info.id && drawer.panelId === b.panel;
        h += `<button class="tb-btn plug-btn${on ? ' on' : ''}${b.label ? ' wide' : ''}" data-plbtn="${escH(st.info.id)}" data-plb="${escH(b.id)}" title="${escH(b.title || b.label || st.info.name)}" aria-label="${escH(b.title || b.label || st.info.name)}"><i class="${icon(b.icon || st.info.icon)}"></i>${b.label ? `<span>${escH(b.label)}</span>` : ''}${b.badge ? `<b class="badge">${escH(b.badge)}</b>` : ''}</button>`;
      }));
      tb.innerHTML = h;
    }
    if (typeof renderStatus === 'function' && CFG) renderStatus();
  }
  function statusHtml() {
    let h = '';
    P.forEach(st => st.buttons.forEach(b => {
      if (b.place !== 'statusbar') return;
      h += `<button class="sb-chip plug-sb" data-plbtn="${escH(st.info.id)}" data-plb="${escH(b.id)}" title="${escH(b.title || st.info.name)}"><i class="${icon(b.icon || st.info.icon)}"></i> ${escH(b.label)}${b.badge ? ` <b class="sec-v">${escH(b.badge)}</b>` : ''}</button>`;
    }));
    return h;
  }
  function renderModes() {
    const pill = document.querySelector('.mode-pill');
    if (!pill) return;
    pill.querySelectorAll('[data-plmode]').forEach(b => b.remove());
    P.forEach(st => st.panels.forEach(pn => {
      if (pn.place !== 'mode') return;
      const k = modeKey(st.info.id, pn.id);
      const b = document.createElement('button');
      b.setAttribute('role', 'tab'); b.dataset.mode = k; b.dataset.plmode = '1';
      b.className = S.mode === k ? 'on' : '';
      b.title = `${pn.title} · ${st.info.name} eklentisi`;
      b.innerHTML = `<i class="${icon(pn.icon)}"></i>${escH(pn.title)}`;
      pill.appendChild(b);
    }));
  }
  function panelFrame(st, pn) {
    if (!pn.frame) {
      pn.frame = makeFrame(st, `${SCHEME}://${st.info.id}/${pn.page.split('/').map(encodeURIComponent).join('/')}`, 'plug-frame');
      pn.frame.dataset.panel = pn.id;
    }
    return pn.frame;
  }
  function onMode(m) {
    const view = document.getElementById('plugView');
    const [, id, panelId] = String(m).split(':');
    const st = m.startsWith('plugin:') ? P.get(id) : null, pn = st && st.panels.get(panelId);
    view.hidden = !pn;
    [...view.children].forEach(c => { c.hidden = true; });
    if (pn) {
      const f = panelFrame(st, pn);
      if (f.parentNode !== view) view.appendChild(f);
      f.hidden = false;
      emit(st, 'panel', { id: panelId, visible: true });
    }
    P.forEach(s => s.panels.forEach(p => { if (p.place === 'mode' && p.frame && !(s === st && p === pn) && p.frame.parentNode === view) emit(s, 'panel', { id: p.id, visible: false }); }));
  }
  const hasMode = m => { const [, id, panelId] = String(m).split(':'); const st = P.get(id); return !!(st && st.panels.get(panelId) && st.panels.get(panelId).place === 'mode'); };
  function openPanel(st, panelId) {
    const pn = st.panels.get(panelId);
    if (!pn) throw new Error('Böyle bir panel yok');
    if (pn.place === 'mode') { setMode(modeKey(st.info.id, pn.id)); return; }
    if (pn.place === 'side') { if (S.mode !== 'claude' && S.mode !== 'ide') setMode('claude'); setCollapsed(st, pn, false); return; }
    if (drawer) { const o = P.get(drawer.id); const op = o && o.panels.get(drawer.panelId); if (o && op) emit(o, 'panel', { id: op.id, visible: false }); }
    const d = document.getElementById('plugDrawer'), body = d.querySelector('.pd-body');
    [...body.children].forEach(c => { c.hidden = true; });
    const f = panelFrame(st, pn);
    if (f.parentNode !== body) body.appendChild(f);
    f.hidden = false;
    d.querySelector('.pd-t').innerHTML = `<i class="${icon(pn.icon)}"></i><b>${escH(pn.title)}</b><small>${escH(st.info.name)}</small>`;
    d.hidden = false;
    drawer = { id: st.info.id, panelId: pn.id };
    emit(st, 'panel', { id: pn.id, visible: true });
    renderButtons();
  }
  function closePanel(st, panelId) {
    const pn = st && st.panels.get(panelId);
    if (pn && pn.place === 'mode') { if (S.mode === modeKey(st.info.id, pn.id)) setMode('claude'); return; }
    if (pn && pn.place === 'side') { setCollapsed(st, pn, true); return; }
    if (!drawer || (st && (drawer.id !== st.info.id || (panelId && drawer.panelId !== panelId)))) return;
    const o = P.get(drawer.id);
    if (o) emit(o, 'panel', { id: drawer.panelId, visible: false });
    document.getElementById('plugDrawer').hidden = true;
    drawer = null;
    renderButtons();
  }
  /* Side panels: a section in the right column in AI mode (between the decisions and the agents) and
     under the file tree in IDE mode. An iframe reloads whenever it is moved in the DOM, which would cut
     off whatever the panel is doing (a running deploy, its log), so each side panel has ONE frame that
     lives in a fixed layer and is laid over whichever section is showing; the sections only hold the
     header and an empty slot of the right height. */
  const SIDE_HOSTS = { claude: 'plugSide', ide: 'plugSideIde' };
  const collapsedKey = (st, pn) => 'vox-plug-collapsed:' + st.info.id + ':' + pn.id;
  function isCollapsed(st, pn) { try { return localStorage.getItem(collapsedKey(st, pn)) === '1'; } catch (_) { return false; } }
  function setCollapsed(st, pn, on) {
    try { localStorage.setItem(collapsedKey(st, pn), on ? '1' : '0'); } catch (_) {}
    for (const sec of Object.values(pn.secs)) {
      sec.classList.toggle('collapsed', on);
      sec.querySelector('.psec-h').setAttribute('aria-expanded', String(!on));
    }
    syncSide();
  }
  function layer() {
    let l = document.getElementById('plugLayer');
    if (!l) { l = document.createElement('div'); l.id = 'plugLayer'; l.className = 'plug-layer'; document.body.appendChild(l); }
    return l;
  }
  // a project filter matches the project in view by its name or its folder name
  function inContext(pn) {
    if (!pn.projects.length) return true;
    const p = S.projects.find(x => x.id === contextProject());
    if (!p) return false;
    const folder = String(p.path).split(/[\\/]/).filter(Boolean).pop() || '';
    return pn.projects.includes(String(p.name).toLowerCase()) || pn.projects.includes(folder.toLowerCase());
  }
  function renderSideSecs() {
    P.forEach(st => st.panels.forEach(pn => {
      if (pn.place !== 'side') return;
      for (const [mode, hostId] of Object.entries(SIDE_HOSTS)) {
        const host = document.getElementById(hostId);
        if (!host || pn.secs[mode]) continue;
        const sec = document.createElement('section');
        sec.className = 'psec' + (isCollapsed(st, pn) ? ' collapsed' : '');
        sec.innerHTML = `<button class="psec-h panel-h" aria-expanded="${!isCollapsed(st, pn)}" title="${escH(st.info.name)} eklentisi · katlamak / açmak için tıkla"><span class="psec-t"><i class="${icon(pn.icon)}"></i>${escH(pn.title)}</span><i class="fa-solid fa-chevron-down psec-car"></i></button><div class="psec-b" style="height:${pn.height}px"></div>`;
        sec.querySelector('.psec-h').addEventListener('click', () => setCollapsed(st, pn, !sec.classList.contains('collapsed')));
        pn.secs[mode] = sec;
        host.appendChild(sec);
      }
      if (!pn.frame) { const f = panelFrame(st, pn); f.classList.add('plug-float'); f.style.visibility = 'hidden'; layer().appendChild(f); }
    }));
    syncSide();
  }
  function removePanel(st, pn) {
    if (pn.frame) { pn.frame.remove(); st.frames.delete(pn.frame); pn.frame = null; }
    for (const sec of Object.values(pn.secs || {})) sec.remove();
    pn.secs = {};
    syncSide();
  }
  // show the right sections and lay each frame over its visible slot; cheap enough to run every frame
  let sideLoop = 0;
  function syncSide() {
    let any = false;
    const used = new Set();
    P.forEach(st => st.panels.forEach(pn => {
      if (pn.place !== 'side') return;
      any = true;
      const show = inContext(pn);
      for (const [mode, sec] of Object.entries(pn.secs)) sec.hidden = !(show && S.mode === mode);
      const sec = show && pn.secs[S.mode];
      const slot = sec && !sec.classList.contains('collapsed') ? sec.querySelector('.psec-b') : null;
      const r = slot && slot.offsetParent ? slot.getBoundingClientRect() : null;
      const f = pn.frame;
      if (!f) return;
      // the section list scrolls: cut the frame to the part of the slot inside it
      const hr = r && sec.parentElement.getBoundingClientRect();
      const top = r ? Math.max(r.top, hr.top) : 0, bottom = r ? Math.min(r.bottom, hr.bottom) : 0;
      const vis = !!(r && r.width > 0 && bottom - top > 1);
      if (vis) {
        const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)},${Math.round(top)},${Math.round(bottom)}`;
        if (f.dataset.rect !== key) {
          f.dataset.rect = key;
          Object.assign(f.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', clipPath: `inset(${top - r.top}px 0 ${r.bottom - bottom}px 0)` });
        }
      }
      if ((f.style.visibility !== 'hidden') !== vis) {
        f.style.visibility = vis ? 'visible' : 'hidden';
        emit(st, 'panel', { id: pn.id, visible: vis });
      }
      used.add(f);
    }));
    for (const id of Object.values(SIDE_HOSTS)) {
      const host = document.getElementById(id);
      if (host) host.hidden = ![...host.children].some(c => !c.hidden);
    }
    // keep following the layout (panels resized, columns toggled) while there is a side panel at all
    if (any && !sideLoop) { const tick = () => { sideLoop = 0; syncSide(); }; sideLoop = requestAnimationFrame(tick); }
  }
  function unregisterCommand(st, id) {
    const sc = st.commands.get(id);
    if (!sc) return;
    const i = SHORTCUTS.indexOf(sc); if (i >= 0) SHORTCUTS.splice(i, 1);
    st.commands.delete(id);
  }
  // "ctrl+alt+n" -> "Ctrl+Alt+N", the form the app's shortcut table uses
  function normKeys(k) {
    if (!k) return '';
    const parts = String(k).split('+').map(x => x.trim()).filter(Boolean);
    const mods = [], order = ['Ctrl', 'Shift', 'Alt'];
    let key = '';
    for (const x of parts) {
      const l = x.toLowerCase();
      if (l === 'ctrl' || l === 'control') mods.push('Ctrl'); else if (l === 'alt') mods.push('Alt'); else if (l === 'shift') mods.push('Shift');
      else key = x.length === 1 ? x.toUpperCase() : x[0].toUpperCase() + x.slice(1);
    }
    if (!key || !mods.length && !/^F\d{1,2}$/.test(key)) throw new Error('Kısayol en az bir Ctrl / Alt tuşu içermeli (ya da F1–F12 olmalı)');
    return [...order.filter(o => mods.includes(o)), key].join('+');
  }

  /* ---------------- load / unload ---------------- */
  function start(info) {
    const st = { info, frames: new Set(), buttons: new Map(), panels: new Map(), commands: new Map(), log: [] };
    P.set(info.id, st);
    if (info.main) {
      const f = makeFrame(st, `${SCHEME}://${info.id}/__vox__/main.html`, 'plug-worker');
      f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
      document.body.appendChild(f);
    }
  }
  function stop(id) {
    const st = P.get(id);
    if (!st) return;
    if (drawer && drawer.id === id) closePanel(st);
    st.commands.forEach((_, k) => unregisterCommand(st, k));
    st.panels.forEach(pn => removePanel(st, pn));
    st.frames.forEach(f => f.remove());
    P.delete(id);
    api.invoke('plugin:stop', id).catch(() => {});
    if (String(S.mode).startsWith(`plugin:${id}:`)) setMode('claude');
  }
  async function loadAll() {
    try { LIST = await api.invoke('plugins:list'); } catch (e) { LIST = { dir: '', list: [], error: e.message }; }
    const on = new Map(LIST.list.filter(p => p.enabled).map(p => [p.id, p]));
    for (const id of [...P.keys()]) if (!on.has(id)) stop(id);
    for (const p of on.values()) if (!P.has(p.id)) start(p);
    renderModes(); renderButtons();
    if (!document.getElementById('settings').hidden && setTab === 'eklenti') renderSettings();
  }
  async function reload(id) {
    stop(id);
    await loadAll();
  }

  /* ---------------- hot reload and writing plugins with Claude ---------------- */
  let known = null; // plugin ids present when the app started; a new one is offered for turning on
  const offered = new Set();
  api.on('plugins:changed', async id => {
    const wasRunning = P.has(id);
    if (wasRunning) stop(id);
    await loadAll();
    const p = LIST.list.find(x => x.id === id);
    if (!p) return;
    if (P.has(id)) { toast(`${p.name} yeniden yüklendi`, 'Dosya değişikliği algılandı'); return; }
    if (wasRunning && p.needsGrant.length) { toast(`${p.name} yeni izin istiyor`, 'Ayarlar → Eklentiler'); return; }
    // a plugin that just appeared (usually written by Claude): ask once whether to turn it on
    if (known && !known.has(id) && !offered.has(id) && !p.error && !p.enabled && p.main) {
      offered.add(id);
      setEnabled(id, true);
    }
  });
  async function claudeWrite(id) {
    const p = id ? LIST.list.find(x => x.id === id) : null;
    const want = await uiPrompt({
      title: p ? `Claude ile düzenle: ${p.name}` : 'Claude ile eklenti yaz', icon: 'fa-robot', ok: 'Claude\'u başlat', maxLength: 1500,
      message: p ? 'Bu eklentide ne değişsin?' : 'Eklenti ne yapsın? Nerede görünsün?',
      placeholder: p ? 'ör. prod yayınından önce testleri çalıştır' : 'ör. AI modunda sağ sütunda açık oturumların özetini gösteren bir bölüm',
      detail: 'Claude, çalışan VoxStorm\'un eklenti klasöründe çalışır. Dosyaları kaydettikçe eklenti kendiliğinden yeniden yüklenir.',
    });
    const text = want == null ? '' : want.replace(/\s+/g, ' ').trim();
    if (!text) return;
    const r = await api.invoke('plugins:devSetup');
    if (!S.projects.some(x => x.id === r.project.id)) { S.projects.push(r.project); CFG.projects = S.projects; }
    document.getElementById('settings').hidden = true;
    if (S.mode !== 'claude' && S.mode !== 'ide') setMode('claude');
    const prompt = p
      ? `VoxStorm'daki "${p.id}" eklentisi üzerinde çalışacağız (klasör: ${p.id}). İstek: ${text}. Önce bu klasördeki CLAUDE.md'yi ve eklentinin dosyalarını oku. Kaydettiğin her değişiklik VoxStorm'da hemen yeniden yüklenir; hatalar için ${r.logDir}\\${p.id}.log dosyasına bak.`
      : `VoxStorm için yeni bir eklenti yaz. İstek: ${text}. Önce bu klasördeki CLAUDE.md'yi oku: eklenti sistemini ve API'yi anlatıyor. Eklentiyi bu klasörde yeni bir alt klasöre yaz. Klasör belirince VoxStorm kullanıcıdan eklentiyi açmak için onay ister; sonra her kayıtta eklenti hemen yeniden yüklenir. Hatalar ${r.logDir}\\<id>.log dosyasına düşer.`;
    const t = await openTerminal({ kind: 'claude', projectId: r.project.id, title: p ? `Eklenti: ${p.name}` : 'Yeni eklenti' });
    if (!t) return;
    t.pendingPrompt = prompt;
    setTimeout(() => sendPendingPrompt(t), 12000);
  }

  /* ---------------- settings tab ---------------- */
  function settingsHtml() {
    const rows = LIST.list.map(p => {
      const st = P.get(p.id);
      const perms = p.permissions.length
        ? p.permissions.map(k => `<span class="pl-perm${RISKY.has(k) ? ' risky' : ''}" title="${escH((PERM_TEXT[k] || [])[1] || k)}"><i class="${(PERM_TEXT[k] || ['fa-solid fa-key'])[0]}"></i>${escH(k)}</span>`).join('')
        : '<span class="pl-perm none">İzin istemiyor</span>';
      const warn = p.error ? `<div class="pl-warn"><i class="fa-solid fa-triangle-exclamation"></i>${escH(p.error)}</div>`
        : p.wantsEnabled && p.needsGrant.length ? `<div class="pl-warn"><i class="fa-solid fa-key"></i>Yeni izin istiyor: ${escH(p.needsGrant.join(', '))}. Açmak için onay ver.</div>` : '';
      const errs = st ? st.log.filter(l => l.level === 'error').slice(-1) : [];
      return `<div class="pl-row${p.enabled ? ' on' : ''}">
        <div class="pl-ic"><i class="${icon(p.icon)}"></i></div>
        <div class="pl-main">
          <div class="pl-top"><b>${escH(p.name)}</b><span class="pl-v">${escH(p.version)}${p.author ? ' · ' + escH(p.author) : ''}</span></div>
          ${p.description ? `<div class="pl-d">${escH(p.description)}</div>` : ''}
          <div class="pl-perms">${perms}</div>
          ${warn}${errs.length ? `<div class="pl-warn"><i class="fa-solid fa-bug"></i>${escH(errs[0].text)}</div>` : ''}
          <div class="pl-acts">
            <button class="btn" data-plact="claude" data-plid="${escH(p.id)}"><i class="fa-solid fa-robot"></i> Claude ile düzenle</button>
            <button class="btn" data-plact="reload" data-plid="${escH(p.id)}" ${p.enabled ? '' : 'disabled'}><i class="fa-solid fa-arrows-rotate"></i> Yeniden yükle</button>
            <button class="btn" data-plact="dir" data-plid="${escH(p.id)}"><i class="fa-regular fa-folder-open"></i> Klasörü aç</button>
            <button class="btn" data-plact="remove" data-plid="${escH(p.id)}"><i class="fa-regular fa-trash-can"></i> Kaldır</button>
          </div>
        </div>
        ${sw(`data-plon="${escH(p.id)}"${p.error ? ' disabled' : ''}`, p.enabled, p.name + ' eklentisi')}
      </div>`;
    }).join('');
    return `<h4>Eklentiler</h4>
      <div class="pl-bar">
        <button class="btn primary" data-plact="claude"><i class="fa-solid fa-robot"></i> Claude ile eklenti yaz</button>
        <button class="btn" data-plact="add"><i class="fa-solid fa-folder-plus"></i> Klasörden ekle</button>
        <button class="btn" data-plact="sample"><i class="fa-solid fa-wand-magic-sparkles"></i> Örnek eklenti oluştur</button>
        <button class="btn" data-plact="dir"><i class="fa-regular fa-folder-open"></i> Eklenti klasörü</button>
        <button class="btn" data-plact="reloadall"><i class="fa-solid fa-arrows-rotate"></i> Listeyi yenile</button>
      </div>
      ${rows || '<div class="pl-empty"><i class="fa-solid fa-puzzle-piece"></i><b>Henüz eklenti yok</b><span>“Örnek eklenti oluştur” ile çalışan bir örnekten başlayabilir ya da hazır bir eklenti klasörünü ekleyebilirsin.</span></div>'}
      <p class="set-note">Eklentiler yalıtılmış bir çerçevede çalışır; bilgisayarına ve dosyalarına yalnızca açarken onay verdiğin izinler kadar erişebilir. Klasör: <code>${escH(LIST.dir)}</code>. Eklenti yazmak için: <a href="https://github.com/mrekay/claudelot/blob/main/src/plugin-sdk/REHBER.md" target="_blank">eklenti rehberi</a>.</p>`;
  }
  async function setEnabled(id, on) {
    const p = LIST.list.find(x => x.id === id);
    if (!p) return;
    if (on) {
      const risky = p.permissions.some(k => RISKY.has(k));
      const lines = p.permissions.map(k => '• ' + ((PERM_TEXT[k] || [])[1] || k)).join('\n');
      const ok = await uiConfirm({
        title: `${p.name} açılsın mı?`, icon: 'fa-puzzle-piece', ok: 'Aç', danger: risky,
        message: p.permissions.length ? `Bu eklenti şunları yapmak istiyor:\n${lines}` : 'Bu eklenti özel bir izin istemiyor; yalnızca kendi düğme ve panellerini gösterebilir.',
        detail: risky ? 'Yalnızca güvendiğin kaynaklardan gelen eklentileri aç.' : '',
      });
      if (!ok) { renderSettings(); return; }
    }
    try { await api.invoke('plugins:setEnabled', id, on, on ? p.permissions : []); }
    catch (e) { uiAlert({ title: 'Eklenti açılamadı', message: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }); }
    await loadAll();
  }
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-plbtn],[data-plon],[data-plact],[data-plclose]');
    if (!b) return;
    const d = b.dataset;
    if (d.plclose != null) { if (drawer) closePanel(P.get(drawer.id)); return; }
    if (d.plbtn) {
      const st = P.get(d.plbtn), btn = st && st.buttons.get(d.plb);
      if (!btn) return;
      if (btn.panel) {
        const pn = st.panels.get(btn.panel);
        if (pn && pn.place === 'side' && !isCollapsed(st, pn)) closePanel(st, pn.id);
        else if (pn && pn.place === 'drawer' && drawer && drawer.id === st.info.id && drawer.panelId === pn.id) closePanel(st, pn.id);
        else if (pn) openPanel(st, pn.id);
      }
      emit(st, 'button', { id: btn.id });
      return;
    }
    if (d.plon) { if (!b.disabled) setEnabled(d.plon, b.getAttribute('aria-checked') !== 'true'); return; }
    const err = x => uiAlert({ title: 'Eklenti', message: String(x && x.message || x).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
    try {
      if (d.plact === 'claude') await claudeWrite(d.plid || '');
      else if (d.plact === 'reload') { await reload(d.plid); toast('Eklenti yeniden yüklendi', (LIST.list.find(x => x.id === d.plid) || {}).name || ''); }
      else if (d.plact === 'dir') await api.invoke('plugins:openDir', d.plid || '');
      else if (d.plact === 'reloadall') await loadAll();
      else if (d.plact === 'remove') {
        const p = LIST.list.find(x => x.id === d.plid);
        if (p && await uiConfirm({ title: 'Eklenti kaldırılsın mı?', message: `"${p.name}" kapatılıp klasörü Geri Dönüşüm Kutusu'na taşınır.`, ok: 'Kaldır', danger: true })) {
          stop(p.id); await api.invoke('plugins:remove', p.id); await loadAll();
        }
      } else if (d.plact === 'add') {
        const r = await api.invoke('plugins:addFolder');
        if (r) { stop(r.id); await loadAll(); toast('Eklenti eklendi', 'Kullanmak için listeden aç.'); }
      } else if (d.plact === 'sample') {
        await api.invoke('plugins:createSample');
        await loadAll();
        toast('Örnek eklenti hazır', '“Hızlı Notlar”ı açıp klasöründeki dosyalara göz at.');
      }
    } catch (x) { err(x); }
  });

  /* ---------------- hooks called by app.js ---------------- */
  window.pluginHost = {
    init() {
      wantMode = String(CFG.settings.mode || '');
      if (!wantMode.startsWith('plugin:')) wantMode = '';
      loadAll().then(() => { known = new Set(LIST.list.map(p => p.id)); });
    },
    hasMode,
    onMode(m) {
      if (!document.getElementById('plugView')) return;
      onMode(m);
      if (String(m).startsWith('plugin:')) wantMode = '';
      syncSide();
      emitState();
    },
    themeChanged() { const t = theme(); emitAll('theme', t); },
    onRender() { syncSide(); clearTimeout(stateTimer); stateTimer = setTimeout(emitState, 150); },
    statusHtml,
    settingsHtml,
  };
  function emitState() {
    if (!P.size) return;
    const s = appState(), j = JSON.stringify(s);
    if (j === lastState) return;
    lastState = j;
    emitAll('state', s);
  }
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && drawer && !document.querySelector('.ui-dlg-bg')) closePanel(P.get(drawer.id)); });
})();

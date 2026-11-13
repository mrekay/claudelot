/* VoxStorm plugin SDK: loaded into every plugin page before the page's own scripts.
   Gives the page a global `vox` object; every call is a message to VoxStorm and returns a Promise. */
(() => {
  'use strict';
  if (window.vox) return;
  const host = window.parent;
  const pending = new Map();
  const handlers = Object.create(null);
  const buttonFns = new Map(), commandFns = new Map(), outputFns = new Map();
  let seq = 0;

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      host.postMessage({ vox: 1, id, method, params: params || {} }, '*');
    });
  }
  function fire(event, data) {
    for (const fn of handlers[event] || []) {
      try { fn(data); } catch (err) { console.error(err); report(err); }
    }
  }
  function applyTheme(t) {
    if (!t || !t.vars) return;
    const s = document.documentElement.style;
    for (const k of Object.keys(t.vars)) if (t.vars[k]) s.setProperty(k, t.vars[k]);
    document.documentElement.dataset.theme = t.dark ? 'dark' : 'light';
    s.colorScheme = t.dark ? 'dark' : 'light';
  }
  window.addEventListener('message', e => {
    if (e.source !== host) return;
    const m = e.data;
    if (!m || m.vox !== 1) return;
    if (m.re) {
      const p = pending.get(m.re);
      if (!p) return;
      pending.delete(m.re);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
      return;
    }
    if (m.event === 'theme') applyTheme(m.data);
    if (m.event === 'state') vox.state = m.data;
    if (m.event === 'button') { const fn = buttonFns.get(m.data && m.data.id); if (fn) try { fn(); } catch (err) { report(err); } }
    if (m.event === 'shell-output') { const fn = outputFns.get(m.data && m.data.runId); if (fn) try { fn(m.data.text, m.data.stream); } catch (err) { report(err); } }
    if (m.event === 'command') { const fn = commandFns.get(m.data && m.data.id); if (fn) try { fn(); } catch (err) { report(err); } }
    fire(m.event, m.data);
  });
  function report(err) { call('log', { level: 'error', text: String(err && (err.stack || err.message) || err) }).catch(() => {}); }
  window.addEventListener('error', e => report(e.error || e.message));
  window.addEventListener('unhandledrejection', e => report(e.reason));

  const on = (event, fn) => {
    (handlers[event] = handlers[event] || []).push(fn);
    return () => { handlers[event] = (handlers[event] || []).filter(f => f !== fn); };
  };

  const vox = {
    /** resolves once VoxStorm answered: { id, name, version, permissions, theme, state, panel } */
    ready: null,
    info: null,
    state: null,
    on,
    log: (...a) => call('log', { level: 'info', text: a.map(String).join(' ') }),
    app: {
      state: () => call('app.state'),
      setMode: mode => call('app.setMode', { mode }),
      openUrl: url => call('app.openUrl', { url }),
    },
    ui: {
      toast: (title, body) => call('ui.toast', { title, body }),
      confirm: opts => call('ui.confirm', typeof opts === 'string' ? { message: opts } : opts),
      prompt: opts => call('ui.prompt', typeof opts === 'string' ? { message: opts } : opts),
      addButton: opts => { if (opts && typeof opts.onClick === 'function') buttonFns.set(opts.id, opts.onClick); const { onClick, ...o } = opts || {}; return call('ui.addButton', o); },
      updateButton: (id, changes) => call('ui.updateButton', Object.assign({}, changes, { id })),
      removeButton: id => { buttonFns.delete(id); return call('ui.removeButton', { id }); },
      addPanel: opts => call('ui.addPanel', opts),
      openPanel: id => call('ui.openPanel', { id }),
      closePanel: id => call('ui.closePanel', { id }),
    },
    commands: {
      register: opts => { if (opts && typeof opts.run === 'function') commandFns.set(opts.id, opts.run); const { run, ...o } = opts || {}; return call('commands.register', o); },
      unregister: id => { commandFns.delete(id); return call('commands.unregister', { id }); },
    },
    notify: (title, body) => call('notify', { title, body }),
    storage: {
      get: key => call('storage.get', { key }),
      set: (key, value) => call('storage.set', { key, value }),
      remove: key => call('storage.remove', { key }),
      keys: () => call('storage.keys'),
    },
    fs: {
      read: path => call('fs.read', { path }),
      list: path => call('fs.list', { path }),
      stat: path => call('fs.stat', { path }),
      write: (path, content) => call('fs.write', { path, content }),
      mkdir: path => call('fs.mkdir', { path }),
    },
    shell: {
      /** opts: { cwd, timeout (ms, max 1 hour), onOutput(text, 'stdout'|'stderr') } -> { code, stdout, stderr, error, stopped } */
      run: (command, opts) => {
        const o = Object.assign({}, opts, { command });
        const fn = o.onOutput; delete o.onOutput;
        if (typeof fn === 'function') { o.runId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); outputFns.set(o.runId, fn); }
        return call('shell.run', o).finally(() => { if (o.runId) outputFns.delete(o.runId); });
      },
      /** stops every command this plugin started */
      stop: () => call('shell.stop'),
    },
    claude: {
      newSession: opts => call('claude.newSession', opts || {}),
      send: (text, opts) => call('claude.send', Object.assign({}, opts, { text })),
    },
  };
  vox.ready = call('hello', { page: location.pathname }).then(info => {
    vox.info = info; vox.state = info.state;
    applyTheme(info.theme);
    if (info.place) document.documentElement.dataset.place = info.place;
    return info;
  });
  window.vox = vox;
})();

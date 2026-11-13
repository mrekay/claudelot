const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set(['welcome:data', 'welcome:addFolder', 'app:takePendingOpen', 'config:get','config:set', 'config:setIdeState', 'prompt:preview', 'project:add', 'project:remove', 'project:discover', 'project:addPath', 'project:open', 'history:list', 'session:rename','usage:get', 'live:list', 'live:tail', 'live:takeover', 'mirror:start', 'usage:history', 'usage:exportCsv','pty:spawn', 'fs:list', 'fs:read', 'fs:write', 'fs:create', 'claude:getCleanup', 'claude:setCleanup', 'clipboard:files', 'git:connect', 'update:state', 'update:check', 'update:download', 'update:restart', 'fs:stat', 'fs:mkdir', 'fs:rename', 'fs:trash', 'fs:reveal', 'ide:files', 'ide:search', 'ide:git', 'ide:watch', 'git:head', 'git:sync', 'git:overview', 'git:log', 'git:show', 'git:diff', 'git:stash', 'github:info', 'shell:openGithub',
  'db:list', 'db:save', 'db:delete', 'db:duplicate', 'db:reorder', 'db:test', 'db:connect', 'db:disconnect', 'db:explore', 'db:run', 'db:cancel', 'db:closeTab', 'db:rows', 'db:release', 'db:exportCsv', 'db:analyze', 'db:history', 'db:historyClear', 'db:saved', 'db:savedSave', 'db:savedDelete', 'db:getState', 'db:setState',
  'plugins:list', 'plugins:setEnabled', 'plugins:openDir', 'plugins:remove', 'plugins:addFolder', 'plugins:createSample', 'plugin:storage', 'plugin:fs', 'plugin:shell', 'plugin:stop', 'plugins:log', 'plugins:devSetup']);
const SEND = new Set(['app:welcome', 'welcome:open', 'welcome:close', 'welcome:min','pty:write', 'pty:resize', 'pty:kill', 'notify', 'tray:update', 'win:min', 'win:max', 'win:close', 'app:quit', 'mirror:input', 'mirror:stop', 'mirror:scroll']);
const ON = new Set(['open-project', 'projects-changed','pty:data', 'pty:exit', 'hook', 'focus-tab', 'open-settings', 'config-changed', 'win:state', 'live-sessions', 'address-learned', 'mirror:frame', 'mirror:error', 'mirror:exit', 'update:state', 'ide:fs-changed', 'plugin:shell-out', 'plugins:changed']);

contextBridge.exposeInMainWorld('api', {
  invoke: (ch, ...args) => (INVOKE.has(ch) ? ipcRenderer.invoke(ch, ...args) : Promise.reject(new Error('blocked: ' + ch))),
  send: (ch, ...args) => { if (SEND.has(ch)) ipcRenderer.send(ch, ...args); },
  on: (ch, fn) => {
    if (!ON.has(ch)) return () => {};
    const l = (_e, ...args) => fn(...args);
    ipcRenderer.on(ch, l);
    return () => ipcRenderer.removeListener(ch, l);
  },
});

// FILE: src/remote-bridge.js
// PURPOSE: A drop-in replacement for preload.js's `window.multicli`, for when this page
// is loaded in a plain browser (remote access, K22) instead of Electron. Speaks the
// wire protocol documented at the top of remote.js over one shared WebSocket instead of
// contextBridge/ipcRenderer. renderer.js itself doesn't know or care which one it's
// talking to — every call it makes goes through `window.multicli.*` either way.
//
// Loaded before renderer.js by remote.html (index.html, the real Electron page, never
// includes this file at all).
(function () {
  'use strict';

  window.__MULTICLI_REMOTE__ = true;
  // The <script> tags (this file included) sit at the end of <body> in remote.html, so
  // document.body already exists by the time this runs.
  document.body.classList.add('remote');

  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';

  let socket = null;
  let nextCallId = 1;
  const pending = new Map(); // callId -> {resolve, reject}
  const eventListeners = new Map(); // channel -> Set<fn>
  let sendQueue = []; // calls made while offline/reconnecting

  function emit(channel, payload) {
    for (const fn of eventListeners.get(channel) || []) {
      try { fn(payload); } catch (err) { console.error(err); }
    }
  }

  function on(channel, fn) {
    if (!eventListeners.has(channel)) eventListeners.set(channel, new Set());
    eventListeners.get(channel).add(fn);
  }

  function flushQueue() {
    const queued = sendQueue;
    sendQueue = [];
    for (const msg of queued) socket.send(JSON.stringify(msg));
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    socket.addEventListener('open', flushQueue);
    socket.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'result') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error));
      } else if (msg.type === 'event') {
        emit(msg.channel, msg.payload);
      }
    });
    // Reconnect on drop — a viewer losing wifi for a few seconds shouldn't need a
    // manual page reload, it should just pick back up (attachLivePanels() in
    // renderer.js re-syncs the panel list once the socket is back).
    socket.addEventListener('close', () => setTimeout(connect, 1500));
    socket.addEventListener('error', () => { try { socket.close(); } catch { /* noop */ } });
  }
  connect();

  // Every renderer->main call, invoke-style or fire-and-forget-style, goes out as the
  // same {type:'call', id, method, arg} shape — see remote.js's wire-protocol comment.
  // `call()` always returns a promise; ipcRenderer.send-style callers below just don't
  // await it.
  function call(method, arg) {
    const id = nextCallId++;
    const msg = { type: 'call', id, method, arg };
    const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    else sendQueue.push(msg);
    return promise;
  }

  window.multicli = {
    // No real OS window here — the browser chrome already has minimize/maximize/close.
    window: {
      minimize: () => {},
      maximize: () => {},
      close: () => {},
    },
    // Client-side on purpose: copy/paste should act on the *viewing* device's
    // clipboard, not round-trip to the host PC's.
    clipboard: {
      readText: async () => { try { return await navigator.clipboard.readText(); } catch { return ''; } },
      writeText: (text) => { try { navigator.clipboard.writeText(text); } catch { /* needs a user gesture/HTTPS in some browsers */ } },
    },
    settings: {
      getDefaultBaseDir: () => call('settings:getDefaultBaseDir'),
      setDefaultBaseDir: () => call('settings:setDefaultBaseDir'),
      getAgentColors: () => call('settings:getAgentColors'),
      setAgentColor: (agentId, colorKey) => call('settings:setAgentColor', { agentId, colorKey }),
    },
    projects: {
      add: () => call('projects:add'),
      browse: () => call('projects:browse'),
      list: () => call('projects:list'),
      remove: (dir) => call('projects:remove', dir),
      getOpen: () => call('projects:getOpen'),
      setOpen: (dir) => call('projects:setOpen', dir),
    },
    agents: {
      list: () => call('agents:list'),
    },
    quotas: {
      get: () => call('quotas:get'),
      getSession: (agentId, cwd, sessionId) => call('quotas:getSession', { agentId, cwd, sessionId }),
    },
    session: {
      claim: (agentId, cwd, sinceMs, taken, current) =>
        call('session:claim', { agentId, cwd, sinceMs, taken, current }),
    },
    workspace: {
      get: () => call('workspace:get'),
      save: (ws) => call('workspace:save', ws),
      // There's no Electron window-close flush to race on a browser tab — a
      // beforeunload handler can't reliably await a network round trip anyway, so this
      // is a no-op pair; the debounced save during normal use is what actually matters.
      onFlush: () => {},
      flushed: () => {},
    },
    scrollback: {
      save: (key, text) => call('scrollback:save', { key, text }),
      load: (key) => call('scrollback:load', key),
      clear: (key) => call('scrollback:clear', key),
    },
    notify: {
      // The host's OS notification already covers "needs you"; a remote tab doing it
      // too would double-notify for the same event on two devices.
      attention: () => {},
    },
    pty: {
      spawn: (id, cwd, cols, rows) => call('pty:spawn', { id, cwd, cols, rows }),
      write: (id, data) => call('pty:write', { id, data }),
      resize: (id, cols, rows) => call('pty:resize', { id, cols, rows }),
      kill: (id) => call('pty:kill', { id }),
      onData: (cb) => on('pty:data', cb),
      onExit: (cb) => on('pty:exit', cb),
    },
    // Remote access controls are host-only — a remote tab starting/stopping the very
    // server it's connected through makes no sense, so these aren't reachable from here
    // (renderer.js's menu wiring hides/no-ops the menu item when __MULTICLI_REMOTE__).
    remote: {
      start: async () => null,
      stop: async () => null,
      status: async () => ({ running: true, remote: true }),
    },
    panels: {
      listLive: () => call('panels:listLive'),
      announce: (meta) => call('panel:announce', meta),
      closed: (id) => call('panel:closed', id),
      onNew: (cb) => on('panel:new', cb),
      onClosed: (cb) => on('panel:closed', cb),
    },
  };
})();

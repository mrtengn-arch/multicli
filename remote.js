// Remote access server (K22, 30 Aug 2026) — see PROJECT.md §3.7.
//
// A plain HTTP + WebSocket server, started/stopped on demand from the View menu, meant
// to be reached over a Tailscale tailnet (or plain LAN) rather than the open internet —
// there is no TLS here on purpose (see PROJECT.md for why that's an acceptable
// tradeoff), just a random token checked on every request as defense-in-depth in case
// the LAN itself isn't trusted.
//
// Wire protocol, deliberately tiny: every renderer->main call (both the old
// ipcMain.handle "invoke" ones and the old ipcMain.on "fire and forget" ones) becomes
// the same shape over the socket — `{type:'call', id, method, arg}` — and always gets a
// `{type:'result', id, ok, value}` / `{type:'result', id, ok:false, error}` reply. Main
// process -> renderer pushes (pty:data, pty:exit, panel:new, panel:closed) go out as
// `{type:'event', channel, payload}`. remote-bridge.js speaks this same protocol from
// the browser side.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const ALLOWED_FILES = {
  '/': path.join(__dirname, 'src', 'remote.html'),
  '/remote.html': path.join(__dirname, 'src', 'remote.html'),
  '/styles.css': path.join(__dirname, 'src', 'styles.css'),
  '/renderer.js': path.join(__dirname, 'src', 'renderer.js'),
  '/remote-bridge.js': path.join(__dirname, 'src', 'remote-bridge.js'),
  '/vendor/xterm.css': path.join(__dirname, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
  '/vendor/xterm.js': path.join(__dirname, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'),
  '/vendor/addon-fit.js': path.join(__dirname, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'),
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

// Pages that hand out the cookie below. Everything else in ALLOWED_FILES is a
// subresource the browser fetches on their behalf.
const ENTRY_PATHS = new Set(['/', '/remote.html']);
const COOKIE_NAME = 'multicli_token';

let server = null;
let wss = null;
let currentToken = null;
let currentHandlers = null;
/** @type {Set<import('ws').WebSocket>} */
const sockets = new Set();

function queryToken(reqUrl) {
  try {
    return new URL(reqUrl, 'http://x').searchParams.get('token');
  } catch {
    return null;
  }
}

function cookieToken(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
  }
  return null;
}

// The token can arrive either way, and it has to: the user opens the page with
// `?token=...` in the URL, but the `<link>`/`<script>` requests that page then triggers
// are root-absolute paths (`/styles.css`, `/renderer.js`) with no query string at all —
// a query-only check 401s every one of them and the remote page comes up as bare
// unstyled HTML with no JS. Found on 31 Aug 2026; the original end-to-end check fetched
// remote.html directly and so never exercised a real browser's subresource requests.
function authorized(req) {
  return queryToken(req.url) === currentToken || cookieToken(req) === currentToken;
}

function handleHttp(req, res) {
  const urlPath = (req.url || '/').split('?')[0];
  const file = ALLOWED_FILES[urlPath];
  if (!file) {
    res.writeHead(404).end('Not found');
    return;
  }
  if (!authorized(req)) {
    res.writeHead(401).end('Bad token');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(500).end('Read error');
      return;
    }
    const ext = path.extname(file);
    const headers = { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' };
    // Set on the page request so the browser carries the token itself from then on —
    // for subresources and, since it's same-origin, for the /ws upgrade too. Not
    // Secure, deliberately: there's no TLS here (see the header comment), and marking
    // it Secure over plain HTTP means the browser silently drops it.
    if (ENTRY_PATHS.has(urlPath)) {
      headers['Set-Cookie'] = `${COOKIE_NAME}=${encodeURIComponent(currentToken)}; Path=/; SameSite=Strict; HttpOnly`;
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

async function dispatch(method, arg, socket) {
  const fn = currentHandlers[method];
  if (!fn) throw new Error(`Unknown remote method: ${method}`);
  // Handlers all have the ipcMain shape `(event, arg) => ...` — `event.sender` is what
  // main.js's `broadcast()` compares against to skip echoing an event back to whoever
  // caused it. Using the socket itself as the stand-in `sender` means that comparison
  // (`socket !== exceptSender`, see below) works identically whether the originating
  // caller was the local window's real IPC event or a remote socket like this one.
  const fakeEvent = { sender: socket };
  return fn(fakeEvent, arg);
}

function send(socket, msg) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

function handleConnection(socket) {
  sockets.add(socket);
  socket.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== 'call') return;
    try {
      const value = await dispatch(msg.method, msg.arg, socket);
      send(socket, { type: 'result', id: msg.id, ok: true, value });
    } catch (err) {
      send(socket, { type: 'result', id: msg.id, ok: false, error: String(err && err.message || err) });
    }
  });
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => sockets.delete(socket));
}

function candidateUrls(port) {
  const nets = os.networkInterfaces();
  const urls = [];
  let tailscaleUrl = null;
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const url = `http://${net.address}:${port}/`;
      if (/tailscale/i.test(name)) tailscaleUrl = url;
      else urls.push(url);
    }
  }
  // Tailscale first — it's the whole point of this feature (reachable from anywhere on
  // the tailnet, not just the LAN), so it should be the one that gets auto-opened/copied.
  return tailscaleUrl ? [tailscaleUrl, ...urls] : urls;
}

function start({ handlers, token, port = 4173 }) {
  return new Promise((resolve, reject) => {
    // `listening`, not just non-null: a failed listen (EADDRINUSE) leaves a server
    // object behind whose address() is null, and taking the early exit on that turned
    // every retry into "Cannot read properties of null" instead of a real error.
    if (server && server.listening) {
      resolve({ port: server.address().port, urls: candidateUrls(server.address().port) });
      return;
    }
    currentHandlers = handlers;
    currentToken = token;
    server = http.createServer(handleHttp);
    wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      if (req.url && req.url.startsWith('/ws') && authorized(req)) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });
    wss.on('connection', handleConnection);
    // Clear the module state before rejecting, so a second "Start Remote Access" click
    // after e.g. a port clash builds a fresh server instead of tripping over this dead
    // one. Nothing to close: a server that never bound holds no handle.
    server.on('error', (err) => {
      if (server && !server.listening) { server = null; wss = null; }
      reject(err);
    });
    server.listen(port, () => {
      const actualPort = server.address().port;
      resolve({ port: actualPort, urls: candidateUrls(actualPort) });
    });
  });
}

function stop() {
  return new Promise((resolve) => {
    for (const socket of sockets) { try { socket.close(); } catch { /* noop */ } }
    sockets.clear();
    if (wss) { wss.close(); wss = null; }
    if (server) {
      server.close(() => { server = null; resolve(); });
    } else {
      resolve();
    }
  });
}

function status() {
  return {
    running: !!server,
    port: server ? server.address().port : null,
    clients: sockets.size,
  };
}

// Fans a main-process event out to every connected remote socket, skipping
// `exceptSender` if it's one of ours (see the comment in `dispatch()` above — it's
// either a socket from this module or a local webContents object, and reference
// equality naturally only ever matches a socket here).
function broadcast(channel, payload, exceptSender) {
  for (const socket of sockets) {
    if (socket === exceptSender) continue;
    send(socket, { type: 'event', channel, payload });
  }
}

module.exports = { start, stop, status, broadcast };

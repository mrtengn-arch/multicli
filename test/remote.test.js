// FILE: test/remote.test.js
// PURPOSE: Smoke test for the remote-access server (K22) — plain Node `fetch`/`WebSocket`
// against remote.js directly, no Electron needed (unlike main.js, remote.js has no
// Electron dependency at all). Verifies the token gate on both HTTP and the WS upgrade,
// a static file fetch, an invoke-style round trip, and that broadcast() correctly
// excludes the originating socket.
// RUN: npm test  (from the repo root)
const assert = require('assert');
const net = require('net');
const remote = require('../remote');
const WsClient = require('ws'); // the global WebSocket can't set request headers

const TOKEN = 'test-token-123';
let fails = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok - ${name}`); }
  else { console.error(`  FAIL - ${name}`); fails++; }
}

async function main() {
  const handlers = {
    'agents:list': () => ([{ id: 'claude', name: 'Claude' }]),
    'echo': (_event, arg) => arg,
    'boom': () => { throw new Error('deliberate failure'); },
  };
  const { port } = await remote.start({ handlers, token: TOKEN, port: 0 });
  const base = `http://127.0.0.1:${port}`;

  try {
    // ---- HTTP: token gate ----
    const noToken = await fetch(`${base}/styles.css`);
    check('no token and no cookie -> 401', noToken.status === 401);

    const badToken = await fetch(`${base}/styles.css?token=wrong`);
    check('static file with wrong token -> 401', badToken.status === 401);

    const goodToken = await fetch(`${base}/styles.css?token=${TOKEN}`);
    check('static file with correct token -> 200', goodToken.status === 200);
    const body = await goodToken.text();
    check('served file has real CSS content', body.includes('{'));

    // ALLOWED_FILES is an exact-string map, not a directory root — main.js.js (or
    // anything else not explicitly listed) is simply not a key in it, regardless of
    // what path a client asks for.
    const missing = await fetch(`${base}/main.js?token=${TOKEN}`);
    check('a path outside the static allowlist -> 404', missing.status === 404);

    // ---- HTTP: what a real browser actually does (regression, 31 Aug 2026) ----
    // The bug this pins down: only the page URL carries `?token=`. Every `<link>` and
    // `<script>` in it is a root-absolute path with no query, so a query-only check
    // 401'd all of them and the remote page loaded as bare HTML with no CSS and no JS.
    // Fetching remote.html on its own — which is all the original verification did —
    // looks perfectly healthy, so the subresource step has to be tested explicitly.
    const page = await fetch(`${base}/?token=${TOKEN}`);
    check('entry page with token -> 200', page.status === 200);
    const setCookie = page.headers.get('set-cookie') || '';
    check('entry page hands out the token cookie', setCookie.includes('multicli_token='));
    check('cookie is scoped to the whole origin', setCookie.includes('Path=/'));
    // Node's fetch has no cookie jar, so replay what the browser would send next.
    const cookie = setCookie.split(';')[0];
    for (const asset of ['/styles.css', '/renderer.js', '/remote-bridge.js', '/vendor/xterm.js']) {
      const res = await fetch(`${base}${asset}`, { headers: { cookie } });
      check(`subresource ${asset} with only the cookie -> 200`, res.status === 200);
    }
    const wrongCookie = await fetch(`${base}/styles.css`, { headers: { cookie: 'multicli_token=wrong' } });
    check('a forged cookie is still rejected', wrongCookie.status === 401);

    // ---- WebSocket: token gate ----
    const rejected = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=wrong`);
      ws.addEventListener('error', () => resolve(true));
      ws.addEventListener('open', () => resolve(false));
      setTimeout(() => resolve('timeout'), 2000);
    });
    check('WS upgrade with wrong token is refused', rejected === true);

    // Same-origin WS upgrades carry cookies, so the bridge works even if the token
    // ever stops being in the URL. Uses the `ws` client rather than the global one
    // because only it can set request headers.
    const cookieUpgrade = await new Promise((resolve) => {
      const ws = new WsClient(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
      ws.on('open', () => { ws.close(); resolve(true); });
      ws.on('error', () => resolve(false));
      setTimeout(() => resolve('timeout'), 2000);
    });
    check('WS upgrade authorized by cookie alone is accepted', cookieUpgrade === true);

    // ---- WebSocket: call/result round trip ----
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', reject);
    });

    let nextId = 1;
    const pending = new Map();
    socket.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type !== 'result') return;
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    });
    function call(method, arg) {
      const id = nextId++;
      const promise = new Promise((resolve) => pending.set(id, resolve));
      socket.send(JSON.stringify({ type: 'call', id, method, arg }));
      return promise;
    }

    const echoed = await call('echo', { hello: 'world' });
    check('call round trip returns the handler\'s value', echoed.ok && echoed.value.hello === 'world');

    const listed = await call('agents:list');
    check('call with no arg works', listed.ok && listed.value[0].id === 'claude');

    const failed = await call('boom');
    check('a throwing handler comes back as ok:false with an error message',
      failed.ok === false && /deliberate failure/.test(failed.error));

    const unknown = await call('nope:not-a-real-method');
    check('an unregistered method comes back as ok:false instead of hanging',
      unknown.ok === false);

    // ---- broadcast() ----
    const socket2 = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    await new Promise((resolve, reject) => {
      socket2.addEventListener('open', resolve);
      socket2.addEventListener('error', reject);
    });
    const events1 = [];
    const events2 = [];
    socket.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'event') events1.push(msg);
    });
    socket2.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'event') events2.push(msg);
    });

    remote.broadcast('pty:data', { id: 'x', data: 'hi' });
    await new Promise((r) => setTimeout(r, 200));
    check('broadcast with no exceptSender reaches every connected socket',
      events1.some((e) => e.channel === 'pty:data') && events2.some((e) => e.channel === 'pty:data'));

    // A "call" handler's fake event.sender is the calling socket itself (see
    // dispatch() in remote.js) — main.js's own broadcast() helper uses exactly that to
    // skip echoing an announcement back to whoever made it. `announceSelf` here plays
    // the role of a handler that turns around and re-broadcasts using its own sender.
    handlers.announceSelf = (event, payload) => remote.broadcast('panel:new', payload, event.sender);
    events1.length = 0;
    events2.length = 0;
    socket.send(JSON.stringify({ type: 'call', id: nextId++, method: 'announceSelf', arg: { id: 'claude-1' } }));
    await new Promise((r) => setTimeout(r, 200));
    check('broadcast with exceptSender skips only the originating socket',
      events1.every((e) => e.channel !== 'panel:new') && events2.some((e) => e.channel === 'panel:new'));

    socket.close();
    socket2.close();
  } finally {
    await remote.stop();
  }

  // ---- Recovering from a busy port (regression, 31 Aug 2026) ----
  // A failed listen used to leave the module holding a dead server whose address() is
  // null, so the *next* click on "Start Remote Access" took the already-running early
  // exit and blew up with "Cannot read properties of null" — the feature stayed broken
  // until the app was restarted, even once the port was free again.
  // No host argument, matching remote.js's own `server.listen(port)` — both then bind
  // the dual-stack wildcard. Pinning the squatter to 0.0.0.0 instead leaves the IPv6
  // wildcard free on Windows and the clash never happens.
  const squatter = net.createServer();
  await new Promise((resolve) => squatter.listen(0, resolve));
  const busyPort = squatter.address().port;

  const first = await remote.start({ handlers: {}, token: TOKEN, port: busyPort }).then(
    () => 'resolved', (err) => err.code);
  check('starting on a busy port rejects with EADDRINUSE', first === 'EADDRINUSE');

  const second = await remote.start({ handlers: {}, token: TOKEN, port: busyPort }).then(
    () => 'resolved', (err) => err.code);
  check('retrying gives the same real error, not a null-deref', second === 'EADDRINUSE');

  await new Promise((resolve) => squatter.close(resolve));
  const afterFree = await remote.start({ handlers: {}, token: TOKEN, port: busyPort }).then(
    (r) => r.port, (err) => err.message);
  check('starting again once the port is free succeeds', afterFree === busyPort);
  await remote.stop();

  if (fails) {
    console.error(`${fails} remote-access check(s) failed`);
    process.exit(1);
  }
  console.log('all remote-access checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

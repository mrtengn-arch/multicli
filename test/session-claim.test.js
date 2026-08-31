// FILE: test/session-claim.test.js
// PURPOSE: Regression cases for session attribution (K19/K20) — which transcript file a
//          panel is allowed to call its own.
// RUN: npm test  (from the repo root)
//
// The case that motivated this: a panel adopted a long-running Claude session the user
// had open in an ordinary PowerShell window outside multicli. It lived in the same cwd
// and, being active, was always the most recently *modified* file — so the panel both
// billed itself for that session's tokens and, on the next restore, resumed straight into
// it. Attribution keys off creation time now, and this file exists so that can't quietly
// regress back to mtime.
//
// Fixing the claim rule turned out not to fix the bug, which is the second half of this
// file: ids claimed under the old rule were already saved, and nothing ever re-questioned
// a saved id, so every launch walked back into the same conversation. session:verify is
// the backward check added on 31 Aug 2026 — these cases pin down what it must reject.
//
// Fixtures are built on disk rather than mocked because birthtime is the whole point and
// it can't be faked through fs.utimes — the files have to genuinely be created in order.
const fs = require('fs');
const path = require('path');
const realOs = require('os');

const FIXTURE = fs.mkdtempSync(path.join(realOs.tmpdir(), 'multicli-claim-'));
// Shadows the `os` the extracted handlers close over, so claudeProjectDirFor() resolves
// into the fixture instead of the real home directory.
const os = { homedir: () => FIXTURE };

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const grab = (re) => src.match(re)[0];
const handlers = {};
const ipcMain = { handle: (name, fn) => { handlers[name] = fn; } };
// session:claim and quotas:getSession were pulled out into named top-level functions
// (30 Aug 2026, so the same code is reachable from the remote-access WebSocket dispatch
// table, not just ipcMain) — grab each function body plus its own one-line
// `ipcMain.handle(...)` registration, rather than assuming the handler body sits inline
// inside the registration call itself.
// resolveCwd consults the saved config for its fallback; the fixture never needs the
// fallback (its cwd is a directory that really exists), so an empty config is enough.
const loadConfig = () => ({});
eval([
  grab(/function readRecentJsonlLines[\s\S]*?\n\}/),
  grab(/function claudeProjectDirFor[\s\S]*?\n\}/),
  grab(/function resolveCwd[\s\S]*?\n\}/),
  grab(/function sessionDirFor[\s\S]*?\n\}/),
  grab(/function sessionFilesIn[\s\S]*?\n\}/),
  grab(/function sessionClaim[\s\S]*?\nipcMain\.handle\('session:claim', sessionClaim\);/),
  grab(/function sessionVerify[\s\S]*?\nipcMain\.handle\('session:verify', sessionVerify\);/),
  grab(/function readSessionUsage[\s\S]*?\n\}/),
  grab(/function quotasGetSession[\s\S]*?\nipcMain\.handle\('quotas:getSession', quotasGetSession\);/),
].join('\n'));

// A real directory, because session:verify resolves the cwd the way pty:spawn does and
// would otherwise fall through to the configured default.
const CWD = path.join(FIXTURE, 'project');
fs.mkdirSync(CWD, { recursive: true });
const dir = claudeProjectDirFor(CWD);
fs.mkdirSync(dir, { recursive: true });

// Two assistant turns, 1500 tokens in total.
const transcript = [
  { type: 'assistant', timestamp: '2026-08-29T10:00:00.000Z', message: { usage: { input_tokens: 900, output_tokens: 100 } } },
  { type: 'user', timestamp: '2026-08-29T10:00:01.000Z' },
  { type: 'assistant', timestamp: '2026-08-29T10:00:02.000Z', message: { usage: { input_tokens: 400, output_tokens: 100 } } },
].map((o) => JSON.stringify(o)).join('\n');

const write = (id) => fs.writeFileSync(path.join(dir, `${id}.jsonl`), transcript);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// SLACK_MS in the handler is 1000, so the fixture gaps have to clear it.
write('foreign');            // a session that was already running before the panel existed
sleep(1400);
const spawnedAt = Date.now();
sleep(1400);
write('mine');               // what the panel's own CLI creates after it launches

// The foreign session is still being written to — that's what used to fool the matcher.
const now = new Date();
fs.utimesSync(path.join(dir, 'foreign.jsonl'), now, now);

const claim = (o) => handlers['session:claim'](null, { agentId: 'claude', cwd: CWD, ...o });
const usage = (sessionId) => handlers['quotas:getSession'](null, { agentId: 'claude', cwd: CWD, sessionId });

let fails = 0;
let total = 0;
const check = (label, got, want) => {
  total++;
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) { fails++; console.log(`FAIL  ${label}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`); }
};

// The bug, directly: 'foreign' is the most recently modified file, but it predates the
// panel, so it must not be claimed.
check('fresh panel ignores a live foreign session, claims its own',
  claim({ sinceMs: spawnedAt, taken: [], current: null }), 'mine');
check('a panel that has started nothing claims nothing',
  claim({ sinceMs: Date.now() + 60000, taken: [], current: null }), null);
check('sibling already holds the only new session -> no claim',
  claim({ sinceMs: spawnedAt, taken: ['mine'], current: null }), null);

// Restored panels: birthtime is legitimately older than this run's spawn, so a held id
// survives on the strength of the file still being written to.
check('restored panel keeps its held session while it is live',
  claim({ sinceMs: Date.now() - 500, taken: [], current: 'foreign' }), 'foreign');
check('held session went quiet and the CLI forked -> adopt the new file',
  claim({ sinceMs: spawnedAt, taken: [], current: 'quiet-one' }), 'mine');
check('nothing on offer -> keep the id we already have',
  claim({ sinceMs: Date.now() + 60000, taken: [], current: 'quiet-one' }), 'quiet-one');
check('agent with no readable transcript store',
  claim({ agentId: 'qwen', sinceMs: spawnedAt, taken: [], current: null }), null);

// Usage only ever reports a claimed session — never a guess at the folder's newest file.
check('claimed session reports its own tokens', usage('mine'), { tokens: 1500, messages: 2 });
check('unclaimed panel reports nothing rather than a neighbour figure', usage(null), null);
check('bogus session id', usage('no-such-session'), null);

// ---- session:verify — is a *saved* id still safe to resume into? ----
// `since` is the panel start the id was originally claimed against, carried in the
// workspace record. 'mine' was created after spawnedAt, 'foreign' well before it.
const verify = (o) => handlers['session:verify'](null, { agentId: 'claude', cwd: CWD, ...o });

check('an id claimed by this panel survives a restart',
  verify({ sessionId: 'mine', since: spawnedAt }), 'mine');
// The actual bug: this record looks perfectly well-formed, and resuming it walks into
// a conversation the panel never started.
check('an id whose transcript predates the panel is dropped',
  verify({ sessionId: 'foreign', since: spawnedAt }), null);
check('a record from before provenance was tracked is dropped',
  verify({ sessionId: 'mine', since: null }), null);
check('an id whose transcript is gone is dropped',
  verify({ sessionId: 'no-such-session', since: spawnedAt }), null);
// Moving a session to another project is a plain file move, so this happens for real.
check('an id that has moved to another project folder is dropped',
  verify({ sessionId: 'mine', cwd: path.join(FIXTURE, 'elsewhere'), since: spawnedAt }), null);
check('no id to check',
  verify({ sessionId: null, since: spawnedAt }), null);
check('agent with no readable transcript store',
  verify({ agentId: 'qwen', sessionId: 'mine', since: spawnedAt }), null);

fs.rmSync(FIXTURE, { recursive: true, force: true });

if (fails === 0) {
  console.log(`all ${total} session-attribution cases passed`);
} else {
  console.log(`${fails} case(s) failed`);
  process.exit(1);
}

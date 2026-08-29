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
eval([
  grab(/function readRecentJsonlLines[\s\S]*?\n\}/),
  grab(/function claudeProjectDirFor[\s\S]*?\n\}/),
  grab(/function sessionDirFor[\s\S]*?\n\}/),
  grab(/function sessionFilesIn[\s\S]*?\n\}/),
  grab(/ipcMain\.handle\('session:claim'[\s\S]*?\n\}\);/),
  grab(/function readSessionUsage[\s\S]*?\n\}/),
  grab(/ipcMain\.handle\('quotas:getSession'[\s\S]*?\n\}\);/),
].join('\n'));

const CWD = 'C:\\fake\\project';
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
const check = (label, got, want) => {
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

fs.rmSync(FIXTURE, { recursive: true, force: true });

if (fails === 0) {
  console.log('all 10 session-attribution cases passed');
} else {
  console.log(`${fails} case(s) failed`);
  process.exit(1);
}

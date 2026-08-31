// FILE: main.js
// PURPOSE: Electron main process — frameless window, PTY lifecycle, project-folder picker,
//          local quota/usage scanning (see computeClaudeUsage/computeGeminiUsage below).
// STATUS: MVP scaffold (26 Aug 2026) — panels spawn plain shells (powershell/bash), NOT yet
//         bound to specific agent CLIs. Session resume is future work (see PROJECT.md §3.5).
//         Quota: claude/gemini read from real local transcripts (§3.5 partially solved);
//         qwen/codex have no source found yet, see computeQwenUsage/computeCodexUsage comments.
//         29 Aug 2026 (K15/K16/K17): workspace + scrollback persistence, attention
//         notifications; see the sections near the bottom of this file.

const { app, BrowserWindow, ipcMain, dialog, Menu, Notification, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const crypto = require('crypto');
const remote = require('./remote');

// Safety net: an uncaught exception in the main process otherwise crashes the whole
// app and shows Electron's native "A JavaScript error occurred in the main process"
// dialog (one per pty callback that fires after teardown, which is exactly what the
// missing `mainWindow = null` bug above used to do). Log and keep running instead.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

const isWin = process.platform === 'win32';
const DEFAULT_SHELL = isWin ? 'powershell.exe' : (process.env.SHELL || 'bash');

let mainWindow;
/** @type {Map<string, import('node-pty').IPty>} */
const ptyProcesses = new Map();

function configPath() {
  return path.join(app.getPath('userData'), 'multicli-config.json');
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    frame: false,
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  Menu.setApplicationMenu(null); // custom title bar draws its own menu
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Without this, `mainWindow` keeps pointing at a destroyed BrowserWindow after the
  // user closes it. Any pty still alive at that moment (one per open panel) fires its
  // onData/onExit asynchronously afterwards, and `mainWindow.webContents.send(...)`
  // throws "Object has been destroyed" — one uncaught main-process exception (and one
  // error dialog) per panel that was open. Nulling it out here makes the `mainWindow?.`
  // guards already in the pty handlers actually work.
  mainWindow.on('closed', () => { mainWindow = null; });
  // notify:attention starts the taskbar flash; without this it keeps flashing after
  // the user has already come back to the window.
  mainWindow.on('focus', () => { try { mainWindow?.flashFrame(false); } catch { /* noop */ } });

  // Give the renderer one last chance to write the workspace + scrollback to disk
  // before the window (and with it every xterm buffer) is gone — otherwise "restore
  // on next launch" (K15) would always miss whatever happened since the last
  // debounced save. The window is destroyed either when the renderer reports back or
  // after FLUSH_TIMEOUT_MS, so a hung renderer can never make the app unclosable.
  let flushing = false;
  mainWindow.on('close', (e) => {
    if (flushing || !mainWindow) return;
    e.preventDefault();
    flushing = true;
    let timer = null;
    const finish = () => {
      clearTimeout(timer);
      ipcMain.removeListener('workspace:flushed', finish);
      mainWindow?.destroy();
    };
    timer = setTimeout(finish, FLUSH_TIMEOUT_MS);
    ipcMain.on('workspace:flushed', finish);
    try { mainWindow.webContents.send('workspace:flush'); } catch { finish(); }
  });
}

const FLUSH_TIMEOUT_MS = 1500;

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  for (const proc of ptyProcesses.values()) {
    try { proc.kill(); } catch { /* already dead */ }
  }
  if (process.platform !== 'darwin') app.quit();
});

// ---- Window controls (frameless, so these are hand-wired) ----
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

// ---- Local quota/usage scanning (PROJECT.md §3.5) ----
// We never make any network requests (same spirit as ai-limit-hq's "passive listening")
// — we only read local session log/transcript files. We show a real but RAW token
// count rather than "% remaining", since we don't know the plan cap.
const QUOTA_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours — matches Claude's real rate-limit window

function walkFiles(dir, matchFn, maxDepth = 6, depth = 0, out = []) {
  if (depth > maxDepth) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, matchFn, maxDepth, depth + 1, out);
    else if (matchFn(e.name)) out.push(full);
  }
  return out;
}

function readRecentJsonlLines(file, cutoffMs) {
  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(obj.timestamp);
    if (!ts || ts < cutoffMs) continue;
    out.push(obj);
  }
  return out;
}

// Claude Code writes every message to `~/.claude/projects/**/*.jsonl` transcripts;
// assistant messages carry real `message.usage` token counts (input/output/cache) —
// the same "scan local logs" approach v1 used.
function computeClaudeUsage() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const cutoff = Date.now() - QUOTA_WINDOW_MS;
  let files;
  try { files = walkFiles(root, (name) => name.endsWith('.jsonl')); } catch { return null; }
  let tokens = 0, messages = 0;
  for (const file of files) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (stat.mtimeMs < cutoff) continue; // file hasn't changed in this window, skip it
    for (const obj of readRecentJsonlLines(file, cutoff)) {
      if (obj.type !== 'assistant' || !obj.message?.usage) continue;
      const u = obj.message.usage;
      // input+output ONLY — adding cache_read_input_tokens too makes the number
      // meaninglessly huge (with prompt caching the same large context gets
      // "re-read" every turn, we saw a single session hit 100M+ while testing).
      // cache_read is billed far cheaper and doesn't map onto rate-limit
      // consumption with the same weight, so here we show the "fresh" exchange
      // (real input+output) instead.
      tokens += (u.input_tokens || 0) + (u.output_tokens || 0);
      messages++;
    }
  }
  return { tokens, messages };
}

// Gemini CLI writes `tokens: {input, output, cached, total}` for every message into
// `~/.gemini/tmp/<project>/chats/session-*.jsonl`.
function computeGeminiUsage() {
  const root = path.join(os.homedir(), '.gemini', 'tmp');
  const cutoff = Date.now() - QUOTA_WINDOW_MS;
  let files;
  try { files = walkFiles(root, (name) => name.endsWith('.jsonl')); } catch { return null; }
  let tokens = 0, messages = 0;
  for (const file of files) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (stat.mtimeMs < cutoff) continue;
    for (const obj of readRecentJsonlLines(file, cutoff)) {
      if (!obj.tokens) continue;
      tokens += obj.tokens.total || 0;
      messages++;
    }
  }
  return { tokens, messages };
}

// Qwen (qwen-code, a gemini-cli fork): on this machine `~/.qwen/tmp/**/logs.json` was
// always empty, and `~/.qwen/projects/**/*.runtime.json` is just process metadata
// (pid/cwd), no token counts — no readable local source was found. Returns null, the
// UI shows "no local data". Add real logic here if a source turns up.
function computeQwenUsage() {
  return null;
}

// Codex CLI: `~/.codex/logs_2.sqlite` is mostly an HTTP/auth trace log, no token
// counts. BUT codex's own "app-server" JSON-RPC daemon has a REAL
// `account/rateLimits/read` method (used by codex-tui) — a future JSON-RPC client
// could connect to `codex app-server` and pull real % usage. Not implemented yet,
// returns null.
function computeCodexUsage() {
  return null;
}

// Named (rather than an inline arrow passed straight to ipcMain.handle) so the same
// function body can also be reached from a remote-access WebSocket call (see
// `remoteHandlers` near the bottom) — one implementation, two transports.
function quotasGet() {
  const safe = (fn) => { try { return fn(); } catch { return null; } };
  return {
    claude: safe(computeClaudeUsage),
    gemini: safe(computeGeminiUsage),
    qwen: safe(computeQwenUsage),
    codex: safe(computeCodexUsage),
    windowMs: QUOTA_WINDOW_MS,
  };
}
ipcMain.handle('quotas:get', quotasGet);

// ---- Per-panel ("this session") usage ----
// Different question from the dock above: that one is a 5-hour rolling total across
// everything, this is "what has THIS panel burned" — and, separately, "which session
// should this panel resume". Both need the same thing: the one transcript file that
// belongs to this panel. Both CLIs shard those by working directory:
//   Claude — ~/.claude/projects/<cwd, every non-alphanumeric char turned into '-'>/<sessionId>.jsonl
//   Gemini — ~/.gemini/tmp/<lowercased basename of cwd>/chats/session-*.jsonl
// The folder alone isn't enough (three panels can share one folder), so a panel claims
// a specific file shortly after it starts — see session:claim below. qwen/codex/opencode
// have no readable local source (§3.5) and get nothing.
function claudeProjectDirFor(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

// Where a panel asking for `cwd` will actually land. Shared by pty:spawn and
// session:verify so the "which folder holds my transcript" answer can be computed
// before the pty exists, which is exactly when a restore needs it.
function resolveCwd(cwd) {
  const cfg = loadConfig();
  const fallback = (cfg.defaultBaseDir && fs.existsSync(cfg.defaultBaseDir))
    ? cfg.defaultBaseDir
    : (process.env.USERPROFILE || process.cwd());
  return cwd && fs.existsSync(cwd) ? cwd : fallback;
}

function sessionDirFor(agentId, cwd) {
  if (agentId === 'claude') return claudeProjectDirFor(cwd);
  if (agentId === 'gemini') {
    return path.join(os.homedir(), '.gemini', 'tmp', path.basename(cwd).toLowerCase(), 'chats');
  }
  return null;
}

// All .jsonl files in a session dir as { id, birthtimeMs, mtimeMs }, newest-created first.
// Both timestamps matter and they answer different questions: birthtime is "was this
// session started by the panel that's asking", mtime is "is it still being written to".
function sessionFilesIn(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    let stat;
    try { stat = fs.statSync(path.join(dir, e.name)); } catch { continue; }
    out.push({
      id: e.name.slice(0, -'.jsonl'.length),
      birthtimeMs: stat.birthtimeMs,
      mtimeMs: stat.mtimeMs,
    });
  }
  return out.sort((a, b) => b.birthtimeMs - a.birthtimeMs);
}

// Which session file belongs to a panel that started at `sinceMs`? One that was *created*
// since then and that no other panel has already claimed. `taken` is how sibling panels on
// the same folder avoid all latching onto the same file.
//
// Created, emphatically not last-modified. The first version matched on mtime and a panel
// promptly claimed a long-running Claude session the user had open in an ordinary
// PowerShell window outside multicli — that transcript lives in the same cwd and, being
// active, was always the most recently written (Murat, 29 Aug 2026). Creation time is the
// thing that actually distinguishes "this panel started that session" from "something else
// is using this folder". Cost of the stricter rule: a panel restored via the `claude -c`
// fallback continues a pre-existing transcript, so it can never claim — it gets no pill and
// no id until it's opened fresh once. Correct-or-nothing is the right side to err on here,
// since a wrong id means restoring into someone else's conversation.
//
// `current` is for restored panels: `claude -r <id>` may append to that transcript or fork
// a new one, and only the file can tell us which happened. A held file still being written
// to stays ours (mtime, not birthtime — its birthtime is legitimately from an earlier run).
function sessionClaim(_event, { agentId, cwd, sinceMs, taken, current }) {
  const dir = sessionDirFor(agentId, cwd);
  if (!dir || !sinceMs) return current || null;
  // Clock jitter only. Deliberately small: the CLI always creates its file *after* we
  // spawn, so a generous slack buys nothing and reopens the original hole — a session
  // started in another window seconds before the panel would look like the panel's own.
  const SLACK_MS = 1000;
  const floor = sinceMs - SLACK_MS;
  const files = sessionFilesIn(dir);
  if (current) {
    const held = files.find((f) => f.id === current);
    if (held && held.mtimeMs >= floor) return current;
  }
  const claimed = new Set(Array.isArray(taken) ? taken : []);
  for (const f of files) {
    if (f.birthtimeMs < floor) break; // sorted newest-created first, so nothing older can match
    if (!claimed.has(f.id)) return f.id;
  }
  return current || null; // nothing better on offer — don't drop a known id
}
ipcMain.handle('session:claim', sessionClaim);

// Is a saved id still safe to hand to `claude -r` on the next launch? sessionClaim's rule
// is strict but it only ever runs *forward*: once an id is on a panel it is never dropped
// (see the line above, which is deliberate — a transient empty directory listing must not
// cost a panel its session). So a bad id, once saved, survives every restart. That is how
// panels ended up resuming into Murat's own PowerShell conversation for two days: those
// ids were claimed under the first, mtime-based rule, and no later run ever re-questioned
// them (31 Aug 2026).
//
// This is the missing backward check, run once per panel at restore. It re-asserts the
// claim rule against the file on disk instead of trusting the record:
//   - `since` is the panel-start time the claim was made against. A record without one was
//     written by a build that predates this check, so its provenance is unknown — dropped.
//   - the transcript must still live in this panel's folder. Moving a session to another
//     project is a plain file move (that's how Claude addresses them), so ids can go stale
//     without anything being deleted.
//   - the transcript must have been *created* at or after the run that claimed it. This is
//     what a hijacked id fails: a foreign session's file predates the panel entirely.
// Returns the id if it survives, null to start clean. Never throws — an unreadable
// directory means "can't vouch for it", which is the same answer as "no".
function sessionVerify(_event, { agentId, cwd, sessionId, since }) {
  if (!sessionId) return null;
  if (!since) return null;
  const dir = sessionDirFor(agentId, resolveCwd(cwd));
  if (!dir) return null;
  let stat;
  try { stat = fs.statSync(path.join(dir, `${sessionId}.jsonl`)); } catch { return null; }
  // Same 1s jitter allowance as the claim itself, for the same reason.
  return stat.birthtimeMs >= since - 1000 ? sessionId : null;
}
ipcMain.handle('session:verify', sessionVerify);

// cutoff 0 = no time window; a session total covers the whole transcript.
function readSessionUsage(agentId, file) {
  let tokens = 0, messages = 0;
  for (const obj of readRecentJsonlLines(file, 0)) {
    if (agentId === 'claude') {
      if (obj.type !== 'assistant' || !obj.message?.usage) continue;
      const u = obj.message.usage;
      // input+output only, same reasoning as computeClaudeUsage() above.
      tokens += (u.input_tokens || 0) + (u.output_tokens || 0);
    } else {
      if (!obj.tokens) continue;
      tokens += obj.tokens.total || 0;
    }
    messages++;
  }
  return { tokens, messages };
}

// Only ever reports a session the panel has actually claimed. There used to be a fallback
// to "newest file in the folder" for panels that hadn't claimed yet, which was the same
// mistake as the mtime claim above — it happily billed a panel for an unrelated session
// running in the same folder. A blank pill for a few seconds beats a confident wrong
// number, and matches the rule already applied to agents with no readable transcript.
function quotasGetSession(_event, { agentId, cwd, sessionId }) {
  const dir = sessionDirFor(agentId, cwd);
  if (!dir || !cwd || !sessionId) return null;
  try {
    const file = path.join(dir, `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) return null;
    return readSessionUsage(agentId, file);
  } catch { /* unreadable/half-written transcript — just show nothing */ }
  return null;
}
ipcMain.handle('quotas:getSession', quotasGetSession);

// ---- Agent list (config-driven, mirrors v1's agents.json pattern) ----
function agentsList() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'agents.json'), 'utf8'));
  } catch {
    return [];
  }
}
ipcMain.handle('agents:list', agentsList);

// ---- Projects (File menu) ----
// "Add Project": pick a folder + add it to the saved list + automatically make it the
// open project. "Browse": pick a folder once, does NOT save it to the list (used for
// one-off per-panel assignment).
async function browseDialog() {
  const cfg = loadConfig();
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: cfg.lastProjectDir || undefined,
  });
  if (result.canceled || !result.filePaths.length) return null;
  cfg.lastProjectDir = result.filePaths[0];
  saveConfig(cfg);
  return result.filePaths[0];
}

async function projectsAdd() {
  const dir = await browseDialog();
  if (!dir) return null;
  const cfg = loadConfig();
  cfg.projects = cfg.projects || [];
  const name = path.basename(dir);
  if (!cfg.projects.find((p) => p.path === dir)) cfg.projects.push({ name, path: dir });
  cfg.openProjectPath = dir;
  saveConfig(cfg);
  return { name, path: dir };
}
ipcMain.handle('projects:add', projectsAdd);

function projectsBrowse() { return browseDialog(); }
ipcMain.handle('projects:browse', projectsBrowse);

function projectsList() {
  const cfg = loadConfig();
  return cfg.projects || [];
}
ipcMain.handle('projects:list', projectsList);

function projectsRemove(_event, dir) {
  const cfg = loadConfig();
  cfg.projects = (cfg.projects || []).filter((p) => p.path !== dir);
  if (cfg.openProjectPath === dir) cfg.openProjectPath = null;
  saveConfig(cfg);
  return cfg.projects;
}
ipcMain.handle('projects:remove', projectsRemove);

// cwd fallback for panels with no assigned project (a folder the user picks instead of
// the default USERPROFILE). Asked once on first launch, changeable from the File menu.
function settingsGetDefaultBaseDir() {
  const cfg = loadConfig();
  return cfg.defaultBaseDir || null;
}
ipcMain.handle('settings:getDefaultBaseDir', settingsGetDefaultBaseDir);

async function settingsSetDefaultBaseDir() {
  const dir = await browseDialog();
  if (!dir) return null;
  const cfg = loadConfig();
  cfg.defaultBaseDir = dir;
  saveConfig(cfg);
  return dir;
}
ipcMain.handle('settings:setDefaultBaseDir', settingsSetDefaultBaseDir);

// Per-agent glow color (View menu) — e.g. "claude is always orange, qwen is always
// purple"; only {agentId: colorKey} is persisted, the hex values live in the
// renderer's palette dictionary.
function settingsGetAgentColors() {
  const cfg = loadConfig();
  return cfg.agentColors || {};
}
ipcMain.handle('settings:getAgentColors', settingsGetAgentColors);

function settingsSetAgentColor(_event, { agentId, colorKey }) {
  const cfg = loadConfig();
  cfg.agentColors = cfg.agentColors || {};
  cfg.agentColors[agentId] = colorKey;
  saveConfig(cfg);
}
ipcMain.handle('settings:setAgentColor', settingsSetAgentColor);

function projectsGetOpen() {
  const cfg = loadConfig();
  return cfg.openProjectPath || null;
}
ipcMain.handle('projects:getOpen', projectsGetOpen);

function projectsSetOpen(_event, dir) {
  const cfg = loadConfig();
  cfg.openProjectPath = dir || null;
  saveConfig(cfg);
}
ipcMain.handle('projects:setOpen', projectsSetOpen);

// ---- Workspace persistence (K15) ----
// What panels were open, which view mode was active, and where each panel sat on the
// canvas. Stored in the same config file as everything else; the renderer saves a
// debounced snapshot on every structural change and a final one on window close.
function workspaceGet() { return loadConfig().workspace || null; }
ipcMain.handle('workspace:get', workspaceGet);

function workspaceSave(_event, ws) {
  const cfg = loadConfig();
  cfg.workspace = ws;
  saveConfig(cfg);
}
ipcMain.on('workspace:save', workspaceSave);

// ---- Scrollback persistence (K16) ----
// Panels get their terminal history back on restart so a restored panel doesn't come
// up as a blank window. Plain text only (no ANSI colors): we deliberately avoid
// @xterm/addon-serialize to keep the dependency list at zero-new-packages, and the
// history is replayed dimmed anyway, so color fidelity buys nothing.
// Keyed by the panel's stable `key` (a random id minted at panel creation and stored
// in the workspace) rather than the runtime `id`, which is sequence-based and
// therefore different on every launch.
function scrollbackDir() {
  const dir = path.join(app.getPath('userData'), 'scrollback');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* already there */ }
  return dir;
}

// Keys come from the renderer, so they must never be able to escape the folder via
// `../` or an absolute path — restrict to the charset our own key generator uses.
function scrollbackFile(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(key)) return null;
  return path.join(scrollbackDir(), `${key}.log`);
}

// `on`, not `handle`: this is also called during the close flush, where waiting on an
// async round-trip would race the window teardown.
function scrollbackSave(_event, { key, text }) {
  const file = scrollbackFile(key);
  if (!file) return;
  try {
    if (text) fs.writeFileSync(file, text, 'utf8');
    else fs.rmSync(file, { force: true });
  } catch { /* disk full / permissions — history is a nicety, never fatal */ }
}
ipcMain.on('scrollback:save', scrollbackSave);

function scrollbackLoad(_event, key) {
  const file = scrollbackFile(key);
  if (!file) return null;
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
ipcMain.handle('scrollback:load', scrollbackLoad);

function scrollbackClear(_event, key) {
  const file = scrollbackFile(key);
  if (!file) return;
  try { fs.rmSync(file, { force: true }); } catch { /* noop */ }
}
ipcMain.on('scrollback:clear', scrollbackClear);

// ---- Attention notifications (K17) ----
// Fired when a panel's agent looks like it's waiting on the user. Suppressed while the
// window is focused — the glowing badge in the panel head is enough when you're
// already looking at it; the OS toast is for when multicli is in the background.
function notifyAttention(_event, { title, body }) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return;
  try {
    mainWindow.flashFrame(true);
    if (Notification.isSupported()) {
      const n = new Notification({ title, body });
      n.on('click', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      });
      n.show();
    }
  } catch { /* notifications are best-effort */ }
}
ipcMain.on('notify:attention', notifyAttention);

// ---- Live panel registry (remote access, 30 Aug 2026) ----
// main.js otherwise has no idea which agent/label/folder a pty id belongs to — that
// metadata lives only in the renderer's in-memory `panels` Map (K15's disk snapshot is
// too stale/wrong-shaped to double as this: it's what to *recreate* on a cold start,
// not what's *currently alive*). Any renderer — the local window or a remote browser
// tab — announces a panel right after spawning it and un-announces it on close, so a
// second viewer connecting later (or after) can ask "what's actually running right
// now" and attach to it instead of spawning a duplicate. See remote.js/remote-bridge.js.
/** @type {Map<string, object>} */
const panelMeta = new Map();

function panelAnnounce(_event, meta) {
  if (!meta || !meta.id) return;
  panelMeta.set(meta.id, meta);
  broadcast('panel:new', meta, _event?.sender);
}
ipcMain.on('panel:announce', panelAnnounce);

function panelClosed(_event, id) {
  panelMeta.delete(id);
  broadcast('panel:closed', id, _event?.sender);
}
ipcMain.on('panel:closed', panelClosed);

function panelsListLive() {
  return [...panelMeta.values()];
}
ipcMain.handle('panels:listLive', panelsListLive);

// Fans a main->renderer event out to the local window AND every connected remote
// socket, so every attached viewer (desktop + N browsers) converges on the same live
// panel set and the same terminal output. `exceptSender` skips the webContents that
// the event originated from (a remote tab announcing its own new panel doesn't need
// to hear its own announcement echoed back) — remote.js does the equivalent for its
// sockets.
function broadcast(channel, payload, exceptSender) {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents !== exceptSender) {
      mainWindow.webContents.send(channel, payload);
    }
  } catch { /* window gone */ }
  remote.broadcast(channel, payload, exceptSender);
}

// ---- PTY lifecycle ----
// NOTE: spawning is keyed purely by `id` and unconditionally kills+replaces whatever
// already holds that id — safe as long as every caller (local renderer, any number of
// remote tabs) mints ids that can't collide. See `mintPanelId()` in renderer.js: ids
// used to be a simple per-page-load counter (`claude-1`, `claude-2`, …), which meant a
// remote tab's very first panel and the desktop app's very first panel of the same
// agent generated the *identical* id — a remote page load would silently kill and
// respawn the live desktop session sharing that id. Fixed 30 Aug 2026 (K22) by making
// ids collision-resistant across independent JS contexts instead of guarding here;
// this handler's "kill whatever's already there" behavior is kept as-is because a
// genuine re-spawn of the *same* id (project reassignment, `pty:spawn` called twice
// for one panel) is supposed to replace it.
function ptySpawn(_event, { id, cwd, cols, rows }) {
  if (ptyProcesses.has(id)) {
    try { ptyProcesses.get(id).kill(); } catch { /* noop */ }
    ptyProcesses.delete(id);
  }

  // The renderer needs the cwd we actually used (not the one it asked for) to look up
  // this panel's session transcript — see quotas:getSession.
  const resolvedCwd = resolveCwd(cwd);

  const proc = pty.spawn(DEFAULT_SHELL, [], {
    name: 'xterm-color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: resolvedCwd,
    env: process.env,
  });

  // Broadcast (not a direct mainWindow.send) so any attached remote viewer's terminal
  // mirrors this panel's output too, not just the local window's.
  proc.onData((data) => broadcast('pty:data', { id, data }));
  proc.onExit(({ exitCode }) => {
    broadcast('pty:exit', { id, exitCode });
    ptyProcesses.delete(id);
    panelMeta.delete(id);
  });

  ptyProcesses.set(id, proc);
  return resolvedCwd;
}
ipcMain.handle('pty:spawn', ptySpawn);

function ptyWrite(_event, { id, data }) {
  ptyProcesses.get(id)?.write(data);
}
ipcMain.on('pty:write', ptyWrite);

function ptyResize(_event, { id, cols, rows }) {
  const proc = ptyProcesses.get(id);
  if (!proc) return;
  try { proc.resize(cols, rows); } catch { /* panel mid-teardown */ }
}
ipcMain.on('pty:resize', ptyResize);

function ptyKill(_event, { id }) {
  const proc = ptyProcesses.get(id);
  if (!proc) return;
  try { proc.kill(); } catch { /* noop */ }
  ptyProcesses.delete(id);
  panelMeta.delete(id);
}
ipcMain.on('pty:kill', ptyKill);

// ---- Remote access (30 Aug 2026, K22) ----
// Attach/control the *same* live panels above from another device on the Tailscale
// tailnet (or plain LAN) — see PROJECT.md §3.7 for the full design and why plain HTTP
// (no TLS) is fine here: nothing is embedded in another HTTPS page (that plan was
// dropped), so there's no mixed-content requirement, just the token check below.
//
// Every remote-reachable method is exposed here by name so remote.js's WS dispatcher
// can call the exact same code the local IPC handlers above use — one implementation,
// two transports. Deliberately NOT exposed remotely: settings:setDefaultBaseDir /
// projects:add / projects:browse still work (they're harmless, if surprising — a
// folder dialog pops up on the host's screen) but there is nothing here that reaches
// outside `app.getPath('userData')` or an explicitly chosen project folder.
const remoteHandlers = {
  'quotas:get': quotasGet,
  'quotas:getSession': quotasGetSession,
  'agents:list': agentsList,
  'projects:add': projectsAdd,
  'projects:browse': projectsBrowse,
  'projects:list': projectsList,
  'projects:remove': projectsRemove,
  'projects:getOpen': projectsGetOpen,
  'projects:setOpen': projectsSetOpen,
  'settings:getDefaultBaseDir': settingsGetDefaultBaseDir,
  'settings:setDefaultBaseDir': settingsSetDefaultBaseDir,
  'settings:getAgentColors': settingsGetAgentColors,
  'settings:setAgentColor': settingsSetAgentColor,
  'session:claim': sessionClaim,
  'session:verify': sessionVerify,
  'workspace:get': workspaceGet,
  'workspace:save': workspaceSave,
  'scrollback:save': scrollbackSave,
  'scrollback:load': scrollbackLoad,
  'scrollback:clear': scrollbackClear,
  'notify:attention': notifyAttention,
  'panels:listLive': panelsListLive,
  'panel:announce': panelAnnounce,
  'panel:closed': panelClosed,
  'pty:spawn': ptySpawn,
  'pty:write': ptyWrite,
  'pty:resize': ptyResize,
  'pty:kill': ptyKill,
};

ipcMain.handle('remote:start', async () => {
  const cfg = loadConfig();
  if (!cfg.remoteToken) {
    cfg.remoteToken = crypto.randomBytes(18).toString('base64url');
    saveConfig(cfg);
  }
  const { port, urls } = await remote.start({ handlers: remoteHandlers, token: cfg.remoteToken });
  const primary = urls[0] ? `${urls[0]}?token=${cfg.remoteToken}` : null;
  if (primary) {
    try { clipboard.writeText(primary); } catch { /* best-effort */ }
    try { shell.openExternal(primary); } catch { /* best-effort */ }
  }
  // A native dialog, not a renderer-side alert() — this app has no other blocking
  // browser dialogs anywhere, and shell.openExternal already popped a new window, so
  // this is purely "here's the link, in case the auto-opened tab isn't the device you
  // meant to use" (e.g. starting it to hand the LAN URL to a phone).
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Remote Access',
    message: primary
      ? `Started and opened in your browser:\n${primary}\n\n(Copied to clipboard.)`
      : 'Started, but no LAN/Tailscale address was found to open — check your network connection.',
    buttons: ['OK'],
  }).catch(() => { /* dialog is best-effort */ });
  return { port, urls, token: cfg.remoteToken };
});

ipcMain.handle('remote:stop', async () => remote.stop());
ipcMain.handle('remote:status', () => remote.status());

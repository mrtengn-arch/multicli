// FILE: main.js
// PURPOSE: Electron main process — frameless window, PTY lifecycle, project-folder picker,
//          local quota/usage scanning (see computeClaudeUsage/computeGeminiUsage below).
// STATUS: MVP scaffold (26 Aug 2026) — panels spawn plain shells (powershell/bash), NOT yet
//         bound to specific agent CLIs. Session resume is future work (see PROJECT.md §3.5).
//         Quota: claude/gemini read from real local transcripts (§3.5 partially solved);
//         qwen/codex have no source found yet, see computeQwenUsage/computeCodexUsage comments.
//         29 Aug 2026 (K15/K16/K17): workspace + scrollback persistence, attention
//         notifications; see the sections near the bottom of this file.

const { app, BrowserWindow, ipcMain, dialog, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');

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

ipcMain.handle('quotas:get', () => {
  const safe = (fn) => { try { return fn(); } catch { return null; } };
  return {
    claude: safe(computeClaudeUsage),
    gemini: safe(computeGeminiUsage),
    qwen: safe(computeQwenUsage),
    codex: safe(computeCodexUsage),
    windowMs: QUOTA_WINDOW_MS,
  };
});

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

function sessionDirFor(agentId, cwd) {
  if (agentId === 'claude') return claudeProjectDirFor(cwd);
  if (agentId === 'gemini') {
    return path.join(os.homedir(), '.gemini', 'tmp', path.basename(cwd).toLowerCase(), 'chats');
  }
  return null;
}

// All .jsonl files in a session dir as { id, mtimeMs }, newest first.
function sessionFilesIn(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    let stat;
    try { stat = fs.statSync(path.join(dir, e.name)); } catch { continue; }
    out.push({ id: e.name.slice(0, -'.jsonl'.length), mtimeMs: stat.mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Which session file belongs to a panel that started at `sinceMs`? The newest one
// touched since then that no other panel has already claimed. `taken` is how sibling
// panels on the same folder avoid all latching onto the same file — without it,
// "resume my session" degenerates into "everyone resume the most recent one".
// SLACK covers clock jitter and the CLI writing its first line a beat before we ask.
//
// `current` is for restored panels: `claude -r <id>` may either append to that same
// transcript or fork a new one, and only the file itself can tell us which happened.
// If the held file has been written to since the panel spawned, it's live and stays
// ours; otherwise the panel is free to adopt whatever its CLI actually created.
ipcMain.handle('session:claim', (_event, { agentId, cwd, sinceMs, taken, current }) => {
  const dir = sessionDirFor(agentId, cwd);
  if (!dir) return null;
  const SLACK_MS = 5000;
  const floor = (sinceMs || 0) - SLACK_MS;
  const files = sessionFilesIn(dir);
  if (current) {
    const held = files.find((f) => f.id === current);
    if (held && held.mtimeMs >= floor) return current;
  }
  const claimed = new Set(Array.isArray(taken) ? taken : []);
  for (const f of files) {
    if (f.mtimeMs < floor) break; // sorted newest first, so nothing older can match
    if (!claimed.has(f.id)) return f.id;
  }
  return current || null; // nothing better on offer — don't drop a known id
});

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

// With a sessionId this is exact per-panel accounting. Without one (the panel hasn't
// claimed a file yet) it falls back to the newest file in the folder, which is a decent
// guess for the common single-panel-per-folder case.
ipcMain.handle('quotas:getSession', (_event, { agentId, cwd, sessionId }) => {
  const dir = sessionDirFor(agentId, cwd);
  if (!dir || !cwd) return null;
  try {
    const id = sessionId || sessionFilesIn(dir)[0]?.id;
    if (!id) return null;
    const file = path.join(dir, `${id}.jsonl`);
    if (!fs.existsSync(file)) return null;
    return readSessionUsage(agentId, file);
  } catch { /* unreadable/half-written transcript — just show nothing */ }
  return null;
});

// ---- Agent list (config-driven, mirrors v1's agents.json pattern) ----
ipcMain.handle('agents:list', () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'agents.json'), 'utf8'));
  } catch {
    return [];
  }
});

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

ipcMain.handle('projects:add', async () => {
  const dir = await browseDialog();
  if (!dir) return null;
  const cfg = loadConfig();
  cfg.projects = cfg.projects || [];
  const name = path.basename(dir);
  if (!cfg.projects.find((p) => p.path === dir)) cfg.projects.push({ name, path: dir });
  cfg.openProjectPath = dir;
  saveConfig(cfg);
  return { name, path: dir };
});

ipcMain.handle('projects:browse', () => browseDialog());

ipcMain.handle('projects:list', () => {
  const cfg = loadConfig();
  return cfg.projects || [];
});

ipcMain.handle('projects:remove', (_event, dir) => {
  const cfg = loadConfig();
  cfg.projects = (cfg.projects || []).filter((p) => p.path !== dir);
  if (cfg.openProjectPath === dir) cfg.openProjectPath = null;
  saveConfig(cfg);
  return cfg.projects;
});

// cwd fallback for panels with no assigned project (a folder the user picks instead of
// the default USERPROFILE). Asked once on first launch, changeable from the File menu.
ipcMain.handle('settings:getDefaultBaseDir', () => {
  const cfg = loadConfig();
  return cfg.defaultBaseDir || null;
});

ipcMain.handle('settings:setDefaultBaseDir', async () => {
  const dir = await browseDialog();
  if (!dir) return null;
  const cfg = loadConfig();
  cfg.defaultBaseDir = dir;
  saveConfig(cfg);
  return dir;
});

// Per-agent glow color (View menu) — e.g. "claude is always orange, qwen is always
// purple"; only {agentId: colorKey} is persisted, the hex values live in the
// renderer's palette dictionary.
ipcMain.handle('settings:getAgentColors', () => {
  const cfg = loadConfig();
  return cfg.agentColors || {};
});

ipcMain.handle('settings:setAgentColor', (_event, { agentId, colorKey }) => {
  const cfg = loadConfig();
  cfg.agentColors = cfg.agentColors || {};
  cfg.agentColors[agentId] = colorKey;
  saveConfig(cfg);
});

ipcMain.handle('projects:getOpen', () => {
  const cfg = loadConfig();
  return cfg.openProjectPath || null;
});

ipcMain.handle('projects:setOpen', (_event, dir) => {
  const cfg = loadConfig();
  cfg.openProjectPath = dir || null;
  saveConfig(cfg);
});

// ---- Workspace persistence (K15) ----
// What panels were open, which view mode was active, and where each panel sat on the
// canvas. Stored in the same config file as everything else; the renderer saves a
// debounced snapshot on every structural change and a final one on window close.
ipcMain.handle('workspace:get', () => loadConfig().workspace || null);

ipcMain.on('workspace:save', (_event, ws) => {
  const cfg = loadConfig();
  cfg.workspace = ws;
  saveConfig(cfg);
});

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
ipcMain.on('scrollback:save', (_event, { key, text }) => {
  const file = scrollbackFile(key);
  if (!file) return;
  try {
    if (text) fs.writeFileSync(file, text, 'utf8');
    else fs.rmSync(file, { force: true });
  } catch { /* disk full / permissions — history is a nicety, never fatal */ }
});

ipcMain.handle('scrollback:load', (_event, key) => {
  const file = scrollbackFile(key);
  if (!file) return null;
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
});

ipcMain.on('scrollback:clear', (_event, key) => {
  const file = scrollbackFile(key);
  if (!file) return;
  try { fs.rmSync(file, { force: true }); } catch { /* noop */ }
});

// ---- Attention notifications (K17) ----
// Fired when a panel's agent looks like it's waiting on the user. Suppressed while the
// window is focused — the glowing badge in the panel head is enough when you're
// already looking at it; the OS toast is for when multicli is in the background.
ipcMain.on('notify:attention', (_event, { title, body }) => {
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
});

// ---- PTY lifecycle ----
ipcMain.handle('pty:spawn', (_event, { id, cwd, cols, rows }) => {
  if (ptyProcesses.has(id)) {
    try { ptyProcesses.get(id).kill(); } catch { /* noop */ }
    ptyProcesses.delete(id);
  }

  const cfg = loadConfig();
  const fallbackCwd = (cfg.defaultBaseDir && fs.existsSync(cfg.defaultBaseDir))
    ? cfg.defaultBaseDir
    : (process.env.USERPROFILE || process.cwd());

  // Named, because the renderer needs the cwd we actually used (not the one it asked
  // for) to look up this panel's session transcript — see quotas:getSession.
  const resolvedCwd = cwd && fs.existsSync(cwd) ? cwd : fallbackCwd;

  const proc = pty.spawn(DEFAULT_SHELL, [], {
    name: 'xterm-color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: resolvedCwd,
    env: process.env,
  });

  // try/catch is defense in depth on top of the `mainWindow?.` guard (see the
  // 'closed' handler above) — belt and suspenders against any other teardown timing
  // where webContents could already be gone.
  proc.onData((data) => {
    try { mainWindow?.webContents.send('pty:data', { id, data }); } catch { /* window is gone */ }
  });
  proc.onExit(({ exitCode }) => {
    try { mainWindow?.webContents.send('pty:exit', { id, exitCode }); } catch { /* window is gone */ }
    ptyProcesses.delete(id);
  });

  ptyProcesses.set(id, proc);
  return resolvedCwd;
});

ipcMain.on('pty:write', (_event, { id, data }) => {
  ptyProcesses.get(id)?.write(data);
});

ipcMain.on('pty:resize', (_event, { id, cols, rows }) => {
  const proc = ptyProcesses.get(id);
  if (!proc) return;
  try { proc.resize(cols, rows); } catch { /* panel mid-teardown */ }
});

ipcMain.on('pty:kill', (_event, { id }) => {
  const proc = ptyProcesses.get(id);
  if (!proc) return;
  try { proc.kill(); } catch { /* noop */ }
  ptyProcesses.delete(id);
});

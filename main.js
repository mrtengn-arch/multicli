// FILE: main.js
// PURPOSE: Electron main process — frameless window, PTY lifecycle, project-folder picker,
//          local quota/usage scanning (see computeClaudeUsage/computeGeminiUsage below).
// STATUS: MVP scaffold (26 Aug 2026) — panels spawn plain shells (powershell/bash), NOT yet
//         bound to specific agent CLIs. Session resume is future work (see PROJECT.md §3.5).
//         Quota: claude/gemini read from real local transcripts (§3.5 partially solved);
//         qwen/codex have no source found yet, see computeQwenUsage/computeCodexUsage comments.

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');

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
}

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

  const proc = pty.spawn(DEFAULT_SHELL, [], {
    name: 'xterm-color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd && fs.existsSync(cwd) ? cwd : fallbackCwd,
    env: process.env,
  });

  proc.onData((data) => {
    mainWindow?.webContents.send('pty:data', { id, data });
  });
  proc.onExit(({ exitCode }) => {
    mainWindow?.webContents.send('pty:exit', { id, exitCode });
    ptyProcesses.delete(id);
  });

  ptyProcesses.set(id, proc);
  return true;
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

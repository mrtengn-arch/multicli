// FILE: main.js
// PURPOSE: Electron main process — frameless window, PTY lifecycle, project-folder picker,
//          local quota/usage scanning (see computeClaudeUsage/computeGeminiUsage below).
// STATUS: MVP scaffold (26 Ağu 2026) — panels spawn plain shells (powershell/bash), NOT yet
//         bound to specific agent CLIs. Session resume is future work (bkz. PROJECT.md §3.5).
//         Quota: claude/gemini read from real local transcripts (§3.5 kısmen çözüldü);
//         qwen/codex henüz kaynak bulunamadı, bkz. computeQwenUsage/computeCodexUsage yorumları.

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
// Ağa hiç istek atmıyoruz (ai-limit-hq'daki "pasif dinleme" ruhuyla aynı) — sadece
// yerel oturum log/transkript dosyalarını okuyoruz. "%kalan" değil, gerçek ama HAM
// token sayısı gösteriyoruz; plan tavanını bilmediğimiz için % hesaplayamıyoruz.
const QUOTA_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 saat — Claude'un gerçek rate-limit penceresiyle aynı

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

// Claude Code, her mesajı `~/.claude/projects/**/*.jsonl` transkriptlerine yazıyor;
// assistant mesajlarında gerçek `message.usage` token sayıları var (input/output/
// cache) — v1'in "yerel log tarama" yaklaşımının aynısı.
function computeClaudeUsage() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const cutoff = Date.now() - QUOTA_WINDOW_MS;
  let files;
  try { files = walkFiles(root, (name) => name.endsWith('.jsonl')); } catch { return null; }
  let tokens = 0, messages = 0;
  for (const file of files) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (stat.mtimeMs < cutoff) continue; // dosya bu pencerede hiç değişmemiş, atla
    for (const obj of readRecentJsonlLines(file, cutoff)) {
      if (obj.type !== 'assistant' || !obj.message?.usage) continue;
      const u = obj.message.usage;
      // SADECE input+output — cache_read_input_tokens'ı da katarsak sayı anlamsızca
      // şişiyor (prompt caching'de aynı büyük context her turda yeniden "okunuyor",
      // tek bir oturumda 100M+'a çıkabiliyor — test ederken gördük). cache_read çok
      // daha ucuza faturalanıyor ve rate-limit'e aynı ağırlıkta yansımıyor, o yüzden
      // burada "taze" alışverişi (gerçek girdi+çıktı) gösteriyoruz.
      tokens += (u.input_tokens || 0) + (u.output_tokens || 0);
      messages++;
    }
  }
  return { tokens, messages };
}

// Gemini CLI, `~/.gemini/tmp/<proje>/chats/session-*.jsonl` içine her mesajda
// `tokens: {input, output, cached, total}` yazıyor.
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

// Qwen (qwen-code, gemini-cli fork'u): bu makinede `~/.qwen/tmp/**/logs.json` hep boş
// çıktı ve `~/.qwen/projects/**/*.runtime.json` sadece process metadata'sı (pid/cwd),
// token sayısı içermiyor — okunabilir bir yerel kaynak bulunamadı. null dönüyoruz,
// UI "yerel veri yok" gösteriyor. Kaynak bulunursa buraya eklenecek.
function computeQwenUsage() {
  return null;
}

// Codex CLI: `~/.codex/logs_2.sqlite` çoğunlukla HTTP/auth trace logu; token sayısı
// yok. AMA codex'in kendi "app-server" JSON-RPC daemon'ında GERÇEK bir
// `account/rateLimits/read` metodu var (codex-tui bunu kullanıyor) — ileride bir
// JSON-RPC istemcisiyle `codex app-server`'a bağlanıp gerçek %kullanım çekilebilir.
// Şimdilik o entegrasyon yapılmadı, null dönüyoruz.
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

// ---- Projects (Dosya menüsü) ----
// "Proje Ekle": klasör seç + kaydedilen listeye ekle + otomatik açık proje yap.
// "Gözat": tek seferlik klasör seç, listeye KAYDETMEZ (panel-başı geçici atama için).
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

// Proje atanmamış panellerin cwd fallback'i (varsayılan USERPROFILE yerine kullanıcının
// seçtiği bir klasör). İlk açılışta bir kerelik sorulur, Dosya menüsünden değiştirilebilir.
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

// Ajan başına glow rengi (Görünüm menüsü) — "claude her zaman turuncu, qwen her zaman
// mor" gibi; sadece {agentId: renkAdı} persist edilir, hex değerleri renderer'daki
// palette sözlüğünde yaşar.
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

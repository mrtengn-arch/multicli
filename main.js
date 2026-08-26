// FILE: main.js
// PURPOSE: Electron main process — frameless window, PTY lifecycle, project-folder picker.
// STATUS: MVP scaffold (26 Ağu 2026) — panels spawn plain shells (powershell/bash), NOT yet
//         bound to specific agent CLIs. Auto-launch + resume + real quota are future work
//         (bkz. PROJECT.md §3.5).

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
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

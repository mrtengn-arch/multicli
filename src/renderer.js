// FILE: renderer.js
// PURPOSE: Panel grid (spawn/resize/maximize, per-panel project folder). Each panel is
//          directly typable (K4's "single shared input bar" was tried and dropped —
//          user found it redundant once panels are independently focusable, same as
//          any normal terminal multiplexer). title-bar menu wiring ("Ajanlar" menu
//          starts new panels on demand).
// STATUS: MVP (26 Ağu 2026). term.onData() forwards keystrokes straight to that panel's
//         PTY (xterm's own encoding — no more hand-rolled key-to-escape-sequence code).
//         Ctrl+1..8 (panel switch) and PageUp/PageDown/Ctrl+Home/Ctrl+End (scrollback)
//         are intercepted per-panel via attachCustomKeyEventHandler before they'd
//         otherwise be sent to the shell.

// ---------------- i18n ----------------
// Sistem diline göre (Windows/Linux fark etmez, Chromium navigator.language OS'tan
// okur) tr/en seçilir. Şimdilik iki dil var; yeni bir string eklerken HER İKİ bloğa da
// eklenmeli, aksi halde o dilde "undefined" görünür.
const STRINGS = {
  tr: {
    menuFile: 'Dosya', menuAgents: 'Ajanlar', menuView: 'Görünüm',
    loading: 'Yükleniyor…',
    defaultLocationSet: 'Varsayılan Konum…',
    defaultLocationLabel: (name) => `Varsayılan Konum: ${name}`,
    addProject: 'Proje Ekle…',
    closeProject: 'Projeyi Kapat',
    toggleDock: 'Limit Panelini Göster/Gizle',
    panelColorsLabel: 'Panel Renkleri (ajan başına)',
    projectNone: 'Proje: (seçilmedi)',
    projectLabel: (name) => `Proje: ${name}`,
    dockTitle: 'Kota Takibi',
    dockHint: 'Gerçek veri bağlanmadı (PROJECT.md §3.5) — yer tutucu.',
    emptyHint: 'Üstteki "Ajanlar" menüsünden bir ajan başlatın.',
    startAgent: (label) => `${label} başlat`,
    colorBtnTitle: 'Panel rengini değiştir',
    folderBtnTitle: 'Bu pencere için proje klasörünü değiştir',
    closeBtnTitle: 'Paneli kapat',
    winMinimize: 'Küçült', winMaximize: 'Büyüt/Geri Al', winClose: 'Kapat',
    browseFolder: 'Klasör Seç (Gözat)…',
    noProject: 'Projesiz',
    projectChanged: (dir) => `[proje değiştirildi: ${dir} — kabuk yeniden başlatılıyor]`,
    projectRemoved: '[proje kaldırıldı — kabuk yeniden başlatılıyor]',
    processExited: (code) => `[process exited: ${code}]`,
    colors: { green: 'Yeşil', orange: 'Turuncu', yellow: 'Sarı', red: 'Kırmızı', turquoise: 'Turkuaz', purple: 'Mor', pink: 'Pembe', white: 'Beyaz', gray: 'Gri' },
    quotaNoData: 'yerel veri yok',
    quotaMeta: (shortNum, messages) => `${shortNum} token · ${messages} mesaj (son 5s)`,
  },
  en: {
    menuFile: 'File', menuAgents: 'Agents', menuView: 'View',
    loading: 'Loading…',
    defaultLocationSet: 'Default Location…',
    defaultLocationLabel: (name) => `Default Location: ${name}`,
    addProject: 'Add Project…',
    closeProject: 'Close Project',
    toggleDock: 'Show/Hide Limit Panel',
    panelColorsLabel: 'Panel Colors (per agent)',
    projectNone: 'Project: (none)',
    projectLabel: (name) => `Project: ${name}`,
    dockTitle: 'Quota Tracking',
    dockHint: 'Not connected to real data yet (PROJECT.md §3.5) — placeholder.',
    emptyHint: 'Start an agent from the "Agents" menu above.',
    startAgent: (label) => `Start ${label}`,
    colorBtnTitle: 'Change panel color',
    folderBtnTitle: 'Change the project folder for this panel',
    closeBtnTitle: 'Close panel',
    winMinimize: 'Minimize', winMaximize: 'Maximize/Restore', winClose: 'Close',
    browseFolder: 'Browse for Folder…',
    noProject: 'No Project',
    projectChanged: (dir) => `[project changed: ${dir} — restarting shell]`,
    projectRemoved: '[project cleared — restarting shell]',
    processExited: (code) => `[process exited: ${code}]`,
    colors: { green: 'Green', orange: 'Orange', yellow: 'Yellow', red: 'Red', turquoise: 'Turquoise', purple: 'Purple', pink: 'Pink', white: 'White', gray: 'Gray' },
    quotaNoData: 'no local data',
    quotaMeta: (shortNum, messages) => `${shortNum} tokens · ${messages} msgs (last 5h)`,
  },
};
const LOCALE = (navigator.language || 'en').toLowerCase().startsWith('tr') ? 'tr' : 'en';
const t = STRINGS[LOCALE];
document.documentElement.lang = LOCALE;

function applyStaticI18n() {
  document.getElementById('menu-file-btn').textContent = t.menuFile;
  document.getElementById('menu-agents-btn').textContent = t.menuAgents;
  document.getElementById('menu-view-btn').textContent = t.menuView;
  document.getElementById('agents-loading-item').textContent = t.loading;
  document.getElementById('add-project-item').textContent = t.addProject;
  document.getElementById('close-project-item').textContent = t.closeProject;
  document.getElementById('toggle-dock-item').textContent = t.toggleDock;
  document.getElementById('panel-colors-label').textContent = t.panelColorsLabel;
  document.getElementById('dock-title').textContent = t.dockTitle;
  document.getElementById('dock-hint').textContent = t.dockHint;
  document.querySelector('[data-action="minimize"]').title = t.winMinimize;
  document.querySelector('[data-action="maximize"]').title = t.winMaximize;
  document.querySelector('[data-action="close"]').title = t.winClose;
}

const panelGrid = document.getElementById('panel-grid');
const projectLabel = document.getElementById('project-label');
const limitDock = document.getElementById('limit-dock');
const agentsMenu = document.getElementById('agents-menu');
const savedProjectsList = document.getElementById('saved-projects-list');

/** @type {Map<string, {term:any, fit:any, el:HTMLElement, body:HTMLElement, label:string, agent:object, projectDir:string|null}>} */
const panels = new Map();
let activePanelId = null;
let openProject = null; // { name, path } | null — Dosya menüsünden "açılan" proje, yeni panellerin varsayılan cwd'si
let savedProjects = []; // [{ name, path }] — Dosya menüsündeki kayıtlı konumlar listesi
let availableAgents = [];
let bodyObservers = new Map(); // panelId -> ResizeObserver
let panelSeq = 0;

// Görünüm > Aktif Panel Rengi — glow paleti (isim -> hex). "green" varsayılan.
const GLOW_PALETTE = {
  green: '#39ff88',
  orange: '#ff9f40',
  yellow: '#ffe066',
  red: '#ff5f5f',
  turquoise: '#2dd4bf',
  purple: '#a78bfa',
  pink: '#f472b6',
  white: '#f5f5f5',
  gray: '#9ca3af',
};

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Ajan başına renk ataması. Bilinmeyen bir ajan gelirse yeşile düşer.
const DEFAULT_AGENT_COLORS = { claude: 'orange', gemini: 'turquoise', qwen: 'purple', codex: 'green' };
let agentColors = {}; // { agentId: colorKey } — settings'ten yüklenir, DEFAULT_AGENT_COLORS'ı ezer

function colorKeyForAgent(agentId) {
  return agentColors[agentId] || DEFAULT_AGENT_COLORS[agentId] || 'green';
}

// Rengi bir tek panele (globale değil, o panelin kendi DOM elementine) uygular —
// böylece Claude turuncu, Qwen mor aynı anda yan yana durabiliyor.
function applyPanelGlow(el, agentId) {
  const hex = GLOW_PALETTE[colorKeyForAgent(agentId)] || GLOW_PALETTE.green;
  el.style.setProperty('--glow', hex);
  el.style.setProperty('--glow-dim', hexToRgba(hex, 0.35));
  const btn = el.querySelector('.color-btn');
  if (btn) btn.style.background = hex;
}

function repaintOpenPanelsForAgent(agentId) {
  for (const p of panels.values()) {
    if (p.agent.id === agentId) applyPanelGlow(p.el, agentId);
  }
}

function showColorPicker(anchorEl, currentKey, onPick) {
  document.querySelectorAll('.project-picker').forEach((el) => el.remove());
  const picker = document.createElement('div');
  picker.className = 'project-picker';
  const rect = anchorEl.getBoundingClientRect();
  picker.style.top = `${rect.bottom + 4}px`;
  picker.style.left = `${Math.min(rect.left, window.innerWidth - 200)}px`;

  Object.keys(GLOW_PALETTE).forEach((key) => {
    const row = document.createElement('div');
    row.className = 'color-row';
    row.innerHTML = `<span class="check">${key === currentKey ? '✓' : ''}</span>` +
      `<span class="swatch" style="background:${GLOW_PALETTE[key]}"></span>` +
      `<span>${t.colors[key]}</span>`;
    row.addEventListener('click', () => {
      picker.remove();
      onPick(key);
    });
    picker.appendChild(row);
  });

  document.body.appendChild(picker);
  setTimeout(() => {
    window.addEventListener('click', function closeOnce() {
      picker.remove();
      window.removeEventListener('click', closeOnce);
    }, { once: true });
  }, 0);
}

// ---------------- Quota/usage (PROJECT.md §3.5 — gerçek yerel veri, % değil) ----------------

function formatTokenCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

// Keyfi görsel ölçek — gerçek bir plan tavanı değil, sadece dock'taki bar'ın dolu
// görünmesi için bir referans noktası. Gerçek "%kalan" hesaplamak için plan tavanını
// bilmemiz lazım, bu yerel dosya taramasıyla elde edilemiyor (bkz. main.js yorumları).
const QUOTA_VISUAL_CAP = 1000000;

async function refreshQuotas() {
  let data;
  try { data = await window.multicli.quotas.get(); } catch { return; }
  if (!data) return;
  for (const agentId of ['claude', 'gemini', 'qwen', 'codex']) {
    const usage = data[agentId];
    const miniDot = document.querySelector(`.mini-limit[data-agent="${agentId}"] .dot`);
    const miniVal = document.querySelector(`.mini-limit[data-agent="${agentId}"] b`);
    const dockDot = document.querySelector(`.dock-card[data-agent="${agentId}"] .dock-card-head .dot`);
    const dockFill = document.querySelector(`.dock-card[data-agent="${agentId}"] .dock-bar-fill`);
    const dockMeta = document.querySelector(`.dock-card[data-agent="${agentId}"] .dock-meta`);
    const hasData = !!usage;
    const dotColor = hasData ? '#39ff88' : '#4a4f5c';
    if (miniDot) miniDot.style.background = dotColor;
    if (dockDot) dockDot.style.background = dotColor;
    if (hasData) {
      const shortNum = formatTokenCount(usage.tokens);
      if (miniVal) miniVal.textContent = shortNum;
      if (dockFill) dockFill.style.width = `${Math.min(100, (usage.tokens / QUOTA_VISUAL_CAP) * 100)}%`;
      if (dockMeta) dockMeta.textContent = t.quotaMeta(shortNum, usage.messages);
    } else {
      if (miniVal) miniVal.textContent = '—';
      if (dockFill) dockFill.style.width = '0%';
      if (dockMeta) dockMeta.textContent = t.quotaNoData;
    }
  }
}

function buildAgentColorMenu(agents) {
  const list = document.getElementById('agent-color-list');
  list.innerHTML = '';
  agents.forEach((agent) => {
    const row = document.createElement('div');
    row.className = 'color-row';
    const key = colorKeyForAgent(agent.id);
    row.innerHTML = `<span class="swatch" style="background:${GLOW_PALETTE[key]}"></span>` +
      `<span style="flex:1">${agent.label}</span>` +
      `<span style="opacity:.6;font-size:11px">${t.colors[key]}</span>`;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      showColorPicker(row, key, async (newKey) => {
        agentColors[agent.id] = newKey;
        await window.multicli.settings.setAgentColor(agent.id, newKey);
        repaintOpenPanelsForAgent(agent.id);
        buildAgentColorMenu(agents);
      });
    });
    list.appendChild(row);
  });
}

function projectBaseName(dir) {
  if (!dir) return null;
  const norm = dir.replace(/[\\/]+$/, '');
  const parts = norm.split(/[\\/]/);
  return parts[parts.length - 1] || norm;
}

function labelFor(agent, dir) {
  return dir ? `${projectBaseName(dir)} - ${agent.label}` : agent.label;
}

// Arrange N panels into a roughly square row/column grid so panels are resizable
// both horizontally AND vertically (a single row only allows left/right resize).
function layoutIds(ids) {
  const n = ids.length;
  const rows = Math.max(1, Math.round(Math.sqrt(n)));
  const perRow = Math.ceil(n / rows);
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const slice = ids.slice(r * perRow, (r + 1) * perRow);
    if (slice.length) grid.push(slice);
  }
  return grid;
}

// ---------------- Panel construction ----------------

function buildPanel(id, agent, projectDir) {
  const el = document.createElement('div');
  el.className = 'agent-panel';
  el.dataset.id = id;
  el.style.flex = '1 1 0';
  applyPanelGlow(el, agent.id); // ajan başına renk (K: Claude turuncu, Qwen mor vb.)

  const head = document.createElement('div');
  head.className = 'agent-panel-head';
  const titleSpan = document.createElement('span');
  titleSpan.className = 'panel-title';
  titleSpan.textContent = labelFor(agent, projectDir);
  const colorBtn = document.createElement('span');
  colorBtn.className = 'color-btn';
  colorBtn.title = t.colorBtnTitle;
  colorBtn.style.background = GLOW_PALETTE[colorKeyForAgent(agent.id)] || GLOW_PALETTE.green;
  const folderBtn = document.createElement('span');
  folderBtn.className = 'folder-btn';
  folderBtn.title = t.folderBtnTitle;
  folderBtn.textContent = '📁';
  const closeBtn = document.createElement('span');
  closeBtn.className = 'close-btn';
  closeBtn.title = t.closeBtnTitle;
  closeBtn.textContent = '✕';
  head.appendChild(titleSpan);
  head.appendChild(colorBtn);
  head.appendChild(folderBtn);
  head.appendChild(closeBtn);

  colorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showColorPicker(colorBtn, colorKeyForAgent(agent.id), async (newKey) => {
      agentColors[agent.id] = newKey;
      await window.multicli.settings.setAgentColor(agent.id, newKey);
      repaintOpenPanelsForAgent(agent.id);
      buildAgentColorMenu(availableAgents);
    });
  });

  head.addEventListener('click', () => {
    setActive(id);
    panels.get(id)?.term.focus();
  });
  head.addEventListener('dblclick', (e) => {
    if (e.target === folderBtn || e.target === closeBtn) return;
    toggleMaximize(id);
  });
  folderBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    reassignPanelProject(id, folderBtn);
  });
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closePanel(id);
  });

  const body = document.createElement('div');
  body.className = 'agent-panel-body';

  el.appendChild(head);
  el.appendChild(body);
  el.addEventListener('mousedown', () => {
    setActive(id);
    term.focus();
  });

  const term = new Terminal({
    fontSize: 13,
    fontFamily: 'Cascadia Code, Consolas, monospace',
    theme: { background: '#101215', foreground: '#e6e8eb', cursor: '#39ff88' },
    cursorBlink: true,
    scrollback: 5000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(body);

  // Doğrudan yazılabilir panel: xterm kendi tuş->kaçış-dizisi kodlamasını yapıyor,
  // biz sadece pty'ye iletiyoruz (K4'teki tek-global-input fikri terk edildi —
  // kullanıcı her paneli normal bir terminal gibi tıklayıp yazabilmek istedi).
  term.onData((data) => window.multicli.pty.write(id, data));

  // Ctrl+1..8 (panel değiştir) ve PageUp/PageDown/Ctrl+Home/Ctrl+End (scrollback)
  // shell'e gitmeden burada yakalanıyor; başka her şey normal şekilde iletiliyor.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && /^[1-8]$/.test(e.key)) {
      cyclePanelByIndex(Number(e.key) - 1);
      return false;
    }
    if (!e.ctrlKey && !e.shiftKey && !e.altKey) {
      if (e.key === 'PageUp') { term.scrollPages(-1); return false; }
      if (e.key === 'PageDown') { term.scrollPages(1); return false; }
    }
    if (e.ctrlKey && e.key === 'Home') { term.scrollToTop(); return false; }
    if (e.ctrlKey && e.key === 'End') { term.scrollToBottom(); return false; }
    return true;
  });

  panels.set(id, { term, fit, el, body, label: labelFor(agent, projectDir), agent, projectDir: projectDir || null });

  const ro = new ResizeObserver(() => fitPanel(id));
  ro.observe(body);
  bodyObservers.set(id, ro);

  return el;
}

// orientation: 'col' = vertical bar, resizes width of left/right neighbors.
//              'row' = horizontal bar, resizes height of top/bottom neighbors.
function addResizer(orientation) {
  const r = document.createElement('div');
  r.className = orientation === 'row' ? 'resizer resizer-row' : 'resizer resizer-col';
  let dragging = false;
  let startPos = 0;
  let firstEl = null, secondEl = null;
  let firstStart = 0, secondStart = 0;

  r.addEventListener('mousedown', (e) => {
    dragging = true;
    r.classList.add('dragging');
    firstEl = r.previousElementSibling;
    secondEl = r.nextElementSibling;
    if (orientation === 'row') {
      startPos = e.clientY;
      firstStart = firstEl.getBoundingClientRect().height;
      secondStart = secondEl.getBoundingClientRect().height;
    } else {
      startPos = e.clientX;
      firstStart = firstEl.getBoundingClientRect().width;
      secondStart = secondEl.getBoundingClientRect().width;
    }
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    if (orientation === 'row') {
      const dy = e.clientY - startPos;
      firstEl.style.flex = `0 0 ${Math.max(80, firstStart + dy)}px`;
      secondEl.style.flex = `0 0 ${Math.max(80, secondStart - dy)}px`;
    } else {
      const dx = e.clientX - startPos;
      firstEl.style.flex = `0 0 ${Math.max(120, firstStart + dx)}px`;
      secondEl.style.flex = `0 0 ${Math.max(120, secondStart - dx)}px`;
    }
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    r.classList.remove('dragging');
  });
  return r;
}

// Re-arranges the grid wrapper (rows/resizers) using the EXISTING panel DOM nodes —
// never recreates an xterm instance for a panel that was already open, so running
// sessions/scrollback survive whenever a panel is added, closed, or maximized.
function rebuildGridLayout() {
  const ids = [...panels.keys()];
  panelGrid.innerHTML = '';

  if (ids.length === 0) {
    const hint = document.createElement('div');
    hint.id = 'empty-hint';
    hint.textContent = t.emptyHint;
    panelGrid.appendChild(hint);
    return;
  }

  const grid = layoutIds(ids);
  grid.forEach((rowIds, rIdx) => {
    if (rIdx > 0) panelGrid.appendChild(addResizer('row'));
    const rowEl = document.createElement('div');
    rowEl.className = 'panel-row';
    rowEl.style.flex = '1 1 0';
    rowIds.forEach((id, cIdx) => {
      if (cIdx > 0) rowEl.appendChild(addResizer('col'));
      rowEl.appendChild(panels.get(id).el);
    });
    panelGrid.appendChild(rowEl);
  });
  requestAnimationFrame(fitAllPanels);
}

function fitPanel(id) {
  const p = panels.get(id);
  if (!p) return;
  try {
    p.fit.fit();
    window.multicli.pty.resize(id, p.term.cols, p.term.rows);
  } catch { /* panel not laid out yet */ }
}

function fitAllPanels() {
  for (const id of panels.keys()) fitPanel(id);
}

// ---------------- Start / close / reassign ----------------

async function startAgentPanel(agent) {
  // Açık proje varsa yeni panel otomatik onun içinde başlar; farklı/başka bir konum
  // istenirse panel açıldıktan sonra 📁 butonuyla o panele özel değiştirilebilir.
  const dir = openProject?.path ?? null;
  const id = `${agent.id}-${++panelSeq}`;
  const el = buildPanel(id, agent, dir);

  // Yeni paneli mevcutların yanına ekleyip tüm grid'i yeniden düzenle (var olanlar korunur).
  rebuildGridLayout();

  await window.multicli.pty.spawn(id, dir);
  if (agent.command) {
    setTimeout(() => window.multicli.pty.write(id, `${agent.command}\r`), 200);
  }
  setActive(id);
  panels.get(id).term.focus();
}

function closePanel(id) {
  const p = panels.get(id);
  if (!p) return;
  window.multicli.pty.kill(id);
  bodyObservers.get(id)?.disconnect();
  bodyObservers.delete(id);
  p.term.dispose();
  panels.delete(id);
  if (activePanelId === id) activePanelId = null;
  rebuildGridLayout();
  if (!activePanelId) {
    const next = panels.keys().next().value;
    if (next) setActive(next);
  }
}

async function reassignPanelProject(id, anchorEl) {
  const p = panels.get(id);
  if (!p) return;
  showProjectPicker(anchorEl, async (dir) => {
    p.term.write(dir
      ? `\r\n\x1b[33m${t.projectChanged(dir)}\x1b[0m\r\n`
      : `\r\n\x1b[33m${t.projectRemoved}\x1b[0m\r\n`);
    window.multicli.pty.kill(id);
    await window.multicli.pty.spawn(id, dir);
    p.projectDir = dir;
    p.label = labelFor(p.agent, dir);
    p.el.querySelector('.panel-title').textContent = p.label;
    if (p.agent.command) {
      setTimeout(() => window.multicli.pty.write(id, `${p.agent.command}\r`), 200);
    }
  });
}

// Küçük, kayıtlı projeler + "Gözat" + "Projesiz" seçenekli açılır liste.
// anchorEl'in altında konumlanır; onPick(dirOrNull) seçim yapılınca çağrılır.
function showProjectPicker(anchorEl, onPick) {
  document.querySelectorAll('.project-picker').forEach((el) => el.remove());

  const picker = document.createElement('div');
  picker.className = 'project-picker';
  const rect = anchorEl.getBoundingClientRect();
  picker.style.top = `${rect.bottom + 4}px`;
  picker.style.left = `${Math.min(rect.left, window.innerWidth - 240)}px`;

  const addItem = (text, handler) => {
    const item = document.createElement('div');
    item.className = 'menu-item';
    item.textContent = text;
    item.addEventListener('click', async () => {
      picker.remove();
      await handler();
    });
    picker.appendChild(item);
  };

  savedProjects.forEach((proj) => addItem(proj.name, () => onPick(proj.path)));
  if (savedProjects.length) {
    const sep = document.createElement('div');
    sep.className = 'menu-sep';
    picker.appendChild(sep);
  }
  addItem(t.browseFolder, async () => {
    const dir = await window.multicli.projects.browse();
    if (dir) onPick(dir);
  });
  addItem(t.noProject, () => onPick(null));

  document.body.appendChild(picker);
  setTimeout(() => {
    window.addEventListener('click', function closeOnce() {
      picker.remove();
      window.removeEventListener('click', closeOnce);
    }, { once: true });
  }, 0);
}

// ---------------- Active panel / glow ----------------

function setActive(id) {
  if (!id || !panels.has(id)) return;
  activePanelId = id;
  for (const [pid, p] of panels) p.el.classList.toggle('active', pid === id);
}

function toggleMaximize(id) {
  const p = panels.get(id);
  if (!p) return;
  const nowMax = !p.el.classList.contains('maximized');
  for (const [, other] of panels) other.el.classList.remove('maximized');
  p.el.classList.toggle('maximized', nowMax);
  setActive(id);
  requestAnimationFrame(fitAllPanels);
}

function cyclePanelByIndex(idx) {
  const id = [...panels.keys()][idx];
  if (id) {
    setActive(id);
    panels.get(id).term.focus();
  }
}

// ---------------- PTY <-> xterm wiring ----------------

window.multicli.pty.onData(({ id, data }) => {
  panels.get(id)?.term.write(data);
});
window.multicli.pty.onExit(({ id, exitCode }) => {
  panels.get(id)?.term.write(`\r\n\x1b[31m${t.processExited(exitCode)}\x1b[0m\r\n`);
});

window.addEventListener('resize', () => requestAnimationFrame(fitAllPanels));

// ---------------- Title bar: window controls ----------------

document.querySelector('[data-action="minimize"]').addEventListener('click', () => window.multicli.window.minimize());
document.querySelector('[data-action="maximize"]').addEventListener('click', () => window.multicli.window.maximize());
document.querySelector('[data-action="close"]').addEventListener('click', () => window.multicli.window.close());

// ---------------- Title bar: menus ----------------

document.querySelectorAll('.menu-btn').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    const menu = btn.closest('.menu');
    const wasOpen = menu.classList.contains('open');
    document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
    if (!wasOpen) menu.classList.add('open');
    e.stopPropagation();
  });
});
window.addEventListener('click', () => {
  document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
});

function setOpenProject(proj) {
  openProject = proj; // { name, path } | null
  window.multicli.projects.setOpen(proj?.path ?? null);
  projectLabel.textContent = proj ? t.projectLabel(proj.name) : t.projectNone;
  projectLabel.title = proj?.path ?? '';
  renderFileMenu();
}

function renderFileMenu() {
  savedProjectsList.innerHTML = '';
  savedProjects.forEach((proj) => {
    const row = document.createElement('div');
    row.className = 'project-row';
    const isOpen = openProject?.path === proj.path;
    row.innerHTML = `<span class="check">${isOpen ? '✓' : ''}</span><span class="name">${proj.name}</span><span class="remove-x">✕</span>`;
    row.querySelector('.name').addEventListener('click', () => setOpenProject(proj));
    row.querySelector('.check').addEventListener('click', () => setOpenProject(proj));
    row.querySelector('.remove-x').addEventListener('click', async (e) => {
      e.stopPropagation();
      savedProjects = await window.multicli.projects.remove(proj.path);
      if (openProject?.path === proj.path) setOpenProject(null);
      else renderFileMenu();
    });
    savedProjectsList.appendChild(row);
  });
}

const defaultBaseItem = document.getElementById('default-base-item');
let defaultBaseDir = null;

function refreshDefaultBaseItem() {
  defaultBaseItem.textContent = defaultBaseDir ? t.defaultLocationLabel(projectBaseName(defaultBaseDir)) : t.defaultLocationSet;
  defaultBaseItem.title = defaultBaseDir || '';
}

document.querySelector('[data-action="set-default-base"]').addEventListener('click', async () => {
  const dir = await window.multicli.settings.setDefaultBaseDir();
  if (!dir) return;
  defaultBaseDir = dir;
  refreshDefaultBaseItem();
});

document.querySelector('[data-action="add-project"]').addEventListener('click', async () => {
  const added = await window.multicli.projects.add();
  if (!added) return;
  savedProjects = await window.multicli.projects.list();
  setOpenProject(added);
});

document.querySelector('[data-action="close-project"]').addEventListener('click', () => {
  setOpenProject(null);
});

document.querySelector('[data-action="toggle-dock"]').addEventListener('click', () => {
  limitDock.classList.toggle('hidden');
});

function buildAgentMenu(agents) {
  agentsMenu.innerHTML = '';
  agents.forEach((agent) => {
    const item = document.createElement('div');
    item.className = 'menu-item';
    item.textContent = t.startAgent(agent.label);
    item.addEventListener('click', () => startAgentPanel(agent));
    agentsMenu.appendChild(item);
  });
}

// ---------------- Boot ----------------

(async function init() {
  applyStaticI18n();
  agentColors = await window.multicli.settings.getAgentColors();

  defaultBaseDir = await window.multicli.settings.getDefaultBaseDir();
  if (!defaultBaseDir) {
    // İlk kurulum: proje atanmamış panellerin nereden başlayacağını bir kere sor.
    // İptal edilirse sessizce geçilir, main.js zaten USERPROFILE'a düşer.
    defaultBaseDir = await window.multicli.settings.setDefaultBaseDir();
  }
  refreshDefaultBaseItem();

  savedProjects = await window.multicli.projects.list();
  const openPath = await window.multicli.projects.getOpen();
  const openRecord = openPath ? savedProjects.find((p) => p.path === openPath) : null;
  openProject = openRecord || null;
  projectLabel.textContent = openProject ? t.projectLabel(openProject.name) : t.projectNone;
  projectLabel.title = openProject?.path ?? '';
  renderFileMenu();

  availableAgents = await window.multicli.agents.list();
  buildAgentMenu(availableAgents);
  buildAgentColorMenu(availableAgents);
  rebuildGridLayout(); // boş durum mesajı (panel yoksa) veya var olan panelleri döşer

  refreshQuotas();
  setInterval(refreshQuotas, 45000); // pasif tarama, ağa hiç istek atmıyor — sık olabilir
})();

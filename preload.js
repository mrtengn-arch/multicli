// FILE: preload.js
// PURPOSE: contextBridge surface exposed to the renderer (contextIsolation stays on —
//          renderer never gets raw Node/ipcRenderer access).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('multicli', {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
  },
  settings: {
    getDefaultBaseDir: () => ipcRenderer.invoke('settings:getDefaultBaseDir'),
    setDefaultBaseDir: () => ipcRenderer.invoke('settings:setDefaultBaseDir'),
    getAgentColors: () => ipcRenderer.invoke('settings:getAgentColors'),
    setAgentColor: (agentId, colorKey) => ipcRenderer.invoke('settings:setAgentColor', { agentId, colorKey }),
  },
  projects: {
    add: () => ipcRenderer.invoke('projects:add'),
    browse: () => ipcRenderer.invoke('projects:browse'),
    list: () => ipcRenderer.invoke('projects:list'),
    remove: (dir) => ipcRenderer.invoke('projects:remove', dir),
    getOpen: () => ipcRenderer.invoke('projects:getOpen'),
    setOpen: (dir) => ipcRenderer.invoke('projects:setOpen', dir),
  },
  agents: {
    list: () => ipcRenderer.invoke('agents:list'),
  },
  quotas: {
    get: () => ipcRenderer.invoke('quotas:get'),
  },
  pty: {
    spawn: (id, cwd, cols, rows) => ipcRenderer.invoke('pty:spawn', { id, cwd, cols, rows }),
    write: (id, data) => ipcRenderer.send('pty:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.send('pty:kill', { id }),
    onData: (cb) => ipcRenderer.on('pty:data', (_e, payload) => cb(payload)),
    onExit: (cb) => ipcRenderer.on('pty:exit', (_e, payload) => cb(payload)),
  },
});

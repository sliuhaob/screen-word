'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('screenCapture', Object.freeze({
  getState: () => ipcRenderer.invoke('monitor:get-state'),
  toggle: () => ipcRenderer.invoke('monitor:toggle'),
  saveBinding: (binding) => ipcRenderer.invoke('hotkey:save', binding),
  beginKeyCapture: () => ipcRenderer.invoke('hotkey:capture-start'),
  endKeyCapture: () => ipcRenderer.invoke('hotkey:capture-end'),
  search: (word) => ipcRenderer.invoke('dictionary:search', word),
  suggest: (prefix) => ipcRenderer.invoke('dictionary:suggest', prefix),
  fitContent: (height) => ipcRenderer.send('window:fit-content', height),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('monitor:state', listener);
    return () => ipcRenderer.removeListener('monitor:state', listener);
  },
}));

'use strict';
const { contextBridge, ipcRenderer } = require('electron');
function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld('wordOverlay', Object.freeze({
  onWords: (callback) => subscribe('overlay:words', callback),
  onClear: (callback) => subscribe('overlay:clear', callback),
  wordsReady: (requestId, revision, ok) => ipcRenderer.send('overlay:words-ready', requestId, revision, ok === true),
  onDefinition: (callback) => subscribe('overlay:definition', callback),
  lookup: (word) => ipcRenderer.send('overlay:lookup', word),
  setEditing: (editing) => ipcRenderer.send('overlay:set-editing', Boolean(editing)),
  cancel: () => ipcRenderer.send('overlay:cancel'),
}));

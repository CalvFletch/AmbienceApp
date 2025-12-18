const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getInitialState: () => ipcRenderer.invoke('get-initial-devices-state'),
  updateDuckDevices: (devices) => ipcRenderer.send('update-duck-devices', devices),
  closeWindow: () => ipcRenderer.send('close-devices-window')
});

window.addEventListener('blur', () => {
    ipcRenderer.send('close-devices-window');
});
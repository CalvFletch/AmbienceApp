const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getMusicFiles: () => ipcRenderer.invoke('get-music-files'),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  openMusicFolder: () => ipcRenderer.invoke('open-music-folder'),
  selectMusicFolder: () => ipcRenderer.invoke('select-music-folder'),
  getMusicFolderPath: () => ipcRenderer.invoke('get-music-folder-path'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  checkAudioActivity: (deviceName) => ipcRenderer.invoke('check-audio-activity', deviceName),
  openDevicesWindow: () => ipcRenderer.send('open-devices-window'),
  onDuckDevicesUpdated: (callback) => ipcRenderer.on('on-duck-devices-updated', (event, ...args) => callback(...args)),
  getStartOnBoot: () => ipcRenderer.invoke('get-start-on-boot'),
  setStartOnBoot: (enabled) => ipcRenderer.invoke('set-start-on-boot', enabled),
  // Exe-based ducking
  getAudioSessions: () => ipcRenderer.invoke('get-audio-sessions'),
  checkExeAudio: (exeNames) => ipcRenderer.invoke('check-exe-audio', exeNames),
  getRunningProcesses: () => ipcRenderer.invoke('get-running-processes')
});

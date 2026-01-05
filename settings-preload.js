const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  debugLog: (msg) => ipcRenderer.send('debug-log', msg),
  getInitialState: () => ipcRenderer.invoke('get-settings-state'),
  saveSettings: (settings) => ipcRenderer.send('save-settings-from-window', settings),
  closeWindow: () => ipcRenderer.send('close-settings-window'),
  openMusicFolder: () => ipcRenderer.invoke('open-music-folder'),
  selectMusicFolder: () => ipcRenderer.invoke('select-music-folder'),
  getStartOnBoot: () => ipcRenderer.invoke('get-start-on-boot'),
  setStartOnBoot: (enabled) => ipcRenderer.invoke('set-start-on-boot', enabled),
  getAudioDevices: () => ipcRenderer.invoke('get-audio-devices'),
  getRunningProcesses: () => ipcRenderer.invoke('get-running-processes'),
  browseForExe: () => ipcRenderer.invoke('browse-for-exe'),
  getExeIcon: (exeName) => ipcRenderer.invoke('get-exe-icon', exeName),
  onProcessListUpdated: (callback) => ipcRenderer.on('process-list-updated', (event, ...args) => callback(...args)),
  // Music library
  getMusicLibraryStatus: () => ipcRenderer.invoke('get-music-library-status'),
  downloadLibraryCategories: (options) => ipcRenderer.invoke('download-library-categories', options),
  onMusicDownloadProgress: (callback) => ipcRenderer.on('music-download-progress', (event, ...args) => callback(...args))
});

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
  openSettingsWindow: () => ipcRenderer.send('open-settings-window'),
  openSettingsLibrary: () => ipcRenderer.send('open-settings-library'),
  openDebugWindow: () => ipcRenderer.send('open-debug-window'),
  isDevMode: () => ipcRenderer.invoke('is-dev-mode'),
  onDuckDevicesUpdated: (callback) => ipcRenderer.on('on-duck-devices-updated', (event, ...args) => callback(...args)),
  onSettingsUpdated: (callback) => ipcRenderer.on('on-settings-updated', (event, ...args) => callback(...args)),
  getStartOnBoot: () => ipcRenderer.invoke('get-start-on-boot'),
  setStartOnBoot: (enabled) => ipcRenderer.invoke('set-start-on-boot', enabled),
  // Exe-based ducking
  getAudioSessions: () => ipcRenderer.invoke('get-audio-sessions'),
  checkExeAudio: (exeNames) => ipcRenderer.invoke('check-exe-audio', exeNames),
  getRunningProcesses: () => ipcRenderer.invoke('get-running-processes'),
  // Updates
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
  saveDismissedUpdate: (version) => ipcRenderer.invoke('save-dismissed-update', version),
  getDismissedUpdate: () => ipcRenderer.invoke('get-dismissed-update'),
  // Music library
  getMusicLibraryStatus: () => ipcRenderer.invoke('get-music-library-status'),
  onProcessListUpdated: (callback) => ipcRenderer.on('process-list-updated', (event, ...args) => callback(...args)),
  onMusicFilesUpdated: (callback) => ipcRenderer.on('music-files-updated', (event, ...args) => callback(...args)),
  onReleaseCategoryFiles: (callback) => ipcRenderer.on('release-category-files', (event, ...args) => callback(...args)),
  // Debug events from debug window
  onDebugShowUpdate: (callback) => ipcRenderer.on('debug-show-update', (event, ...args) => callback(...args)),
  onDebugShowLibrary: (callback) => ipcRenderer.on('debug-show-library', (event, ...args) => callback(...args)),
  onDebugHideUpdate: (callback) => ipcRenderer.on('debug-hide-update', (event, ...args) => callback(...args)),
  onDebugDuck: (callback) => ipcRenderer.on('debug-duck', (event, ...args) => callback(...args)),
  onDebugUnduck: (callback) => ipcRenderer.on('debug-unduck', (event, ...args) => callback(...args)),
  onDebugForcePlay: (callback) => ipcRenderer.on('debug-force-play', (event, ...args) => callback(...args)),
  onDebugForcePause: (callback) => ipcRenderer.on('debug-force-pause', (event, ...args) => callback(...args)),
  onDebugForceSkip: (callback) => ipcRenderer.on('debug-force-skip', (event, ...args) => callback(...args))
});

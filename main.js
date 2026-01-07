const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execFile } = require('child_process');
const https = require('https');
const os = require('os');
const AdmZip = require('adm-zip');

const GITHUB_REPO = 'CalvFletch/AmbienceApp';
const MUSIC_LIBRARY_REPO = 'CalvFletch/AmbienceApp-MusicLibrary';
const CURRENT_VERSION = require('./package.json').version;

// Dev mode check - only enable debug features when running unpackaged
const IS_DEV = !app.isPackaged;

let mainWindow;
let devicesWindow;
let settingsWindow;
let debugWindow;
let musicFolder = null;
let configPath = null;
let processListCache = { data: null, fetchedAt: 0, fetching: null };
let exeIconCache = new Map();
let folderIconCache = new Map();
let servicesIconCache = null;
let servicesIconPromise = null;
let iconScriptPath = null;
const ICON_CACHE_DIR = path.join(os.tmpdir(), 'ambience-icon-cache');
const ICON_MANIFEST_PATH = path.join(ICON_CACHE_DIR, 'manifest.json');
let iconManifest = null;

// Music library versioning
let libraryMetadataCache = null;
let libraryMetadataCacheTime = 0;
const LIBRARY_METADATA_CACHE_TTL = 3600000; // 1 hour
const LIBRARY_METADATA_FILENAME = 'library-metadata.json';

// GitHub releases cache (24 hours)
let releasesCache = null;
let releasesCacheTime = 0;
const RELEASES_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const RELEASES_CACHE_FILENAME = 'releases-cache.json';

function resetCaches() {
  exeIconCache = new Map();
  folderIconCache = new Map();
  servicesIconCache = null;
  servicesIconPromise = null;
  processListCache = { data: null, fetchedAt: 0, fetching: null };
  iconManifest = null; // keep disk cache; just drop in-memory copy
}

function ensureIconCacheDir() {
  try {
    fs.mkdirSync(ICON_CACHE_DIR, { recursive: true });
  } catch (e) {
    // best-effort
  }
  return ICON_CACHE_DIR;
}

function loadIconManifest() {
  if (iconManifest) return iconManifest;
  ensureIconCacheDir();
  try {
    if (fs.existsSync(ICON_MANIFEST_PATH)) {
      const raw = fs.readFileSync(ICON_MANIFEST_PATH, 'utf8');
      iconManifest = JSON.parse(raw || '{}');
      return iconManifest;
    }
  } catch (e) {}
  iconManifest = {};
  return iconManifest;
}

function writeIconManifest(manifest) {
  try {
    fs.writeFileSync(ICON_MANIFEST_PATH, JSON.stringify(manifest || {}, null, 2));
  } catch (e) {
    // best-effort
  }
}

function getIconCachePaths(name) {
  const safe = (name || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
  const dir = ensureIconCacheDir();
  return {
    pngPath: path.join(dir, `${safe}.png`),
    metaPath: path.join(dir, `${safe}.json`)
  };
}

function readIconCache(name) {
  if (!name) return null;
  const manifest = loadIconManifest();
  try {
    const { pngPath, metaPath } = getIconCachePaths(name);
    const hasPng = fs.existsSync(pngPath);
    let dataUrl = null;
    if (hasPng) {
      const b64 = fs.readFileSync(pngPath).toString('base64');
      dataUrl = `data:image/png;base64,${b64}`;
    }
    let meta = {};
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8') || '{}');
      } catch {}
    }
    if (!meta.path && manifest?.[name]?.path) {
      meta.path = manifest[name].path;
    }
    if (!meta.source && manifest?.[name]?.source) {
      meta.source = manifest[name].source;
    }
    if (!meta.reason && manifest?.[name]?.reason) {
      meta.reason = manifest[name].reason;
    }
    if (!dataUrl && !meta.path && !meta.source && !meta.reason && !manifest?.[name]) {
      return null; // nothing cached
    }
    return {
      dataUrl: dataUrl || null,
      path: meta.path || null,
      source: meta.source || (hasPng ? 'disk-cache' : 'disk-cache-meta'),
      reason: meta.reason || null
    };
  } catch (e) {
    return null;
  }
}

function writeIconCache(name, result) {
  try {
    const manifest = loadIconManifest();
    const { pngPath, metaPath } = getIconCachePaths(name);
    const hasIcon = !!result?.dataUrl;

    if (hasIcon) {
      const parts = result.dataUrl.split(',');
      const base64 = parts.length > 1 ? parts[1] : parts[0];
      if (base64) {
        fs.writeFileSync(pngPath, base64, 'base64');
      }
    } else {
      try {
        if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath);
      } catch {}
    }

    const meta = {
      path: result?.path || null,
      source: result?.source || null,
      reason: result?.reason || null
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    manifest[name] = { path: meta.path, source: meta.source, reason: meta.reason, hasIcon };
    writeIconManifest(manifest);
  } catch (e) {
    // best-effort
  }
}

function getAppPath(relPath) {
  return path.join(__dirname, relPath);
}

function ensureConfigPath() {
  if (!configPath) {
    const userDataPath = app.getPath('userData');
    configPath = path.join(userDataPath, 'config.json');
  }
  return configPath;
}

function loadConfigData() {
  ensureConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(raw || '{}');
    }
  } catch (e) {
    console.error('Failed to read config:', e);
  }
  return {};
}

function saveConfig(update = {}) {
  ensureConfigPath();
  const current = loadConfigData();
  const merged = { ...current, ...update };
  try {
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
  } catch (e) {
    console.error('Failed to write config:', e);
  }
  return merged;
}

function initPaths() {
  ensureConfigPath();
  const userMusicPath = app.getPath('music');
  const defaultMusicFolder = path.join(userMusicPath, 'Ambience');
  const config = loadConfigData();
  musicFolder = config.musicFolder || defaultMusicFolder;
  if (!config.musicFolder) {
    saveConfig({ musicFolder });
  }
}

function ensureIconScript() {
  if (iconScriptPath) return iconScriptPath;
  const tmpDir = os.tmpdir();
  iconScriptPath = path.join(tmpDir, 'ambience-get-icon.ps1');
  const script = `
param(
  [Parameter(Mandatory = $true)][string]$ExeName
)

Add-Type -AssemblyName System.Drawing
$exeFull = $ExeName.ToLower()
if (-not $exeFull.EndsWith('.exe')) { $obj = [PSCustomObject]@{ path = $null; source = $null; data = $null; reason = 'not-exe' }; $obj | ConvertTo-Json -Compress; exit 0 }
$exeBase = [System.IO.Path]::GetFileNameWithoutExtension($exeFull)

$candidates = @()
try {
  $proc = Get-Process -Name $exeBase -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($proc) {
    $p = $null
    try { $p = $proc.Path } catch {}
    if (-not $p) { try { $p = $proc.MainModule.FileName } catch {} }
    if ($p) { $candidates += @{ Path = $p; Source = 'Get-Process' } }
  }
} catch {}

try {
  $cim = Get-CimInstance Win32_Process -Filter "Name='$exeFull'" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cim -and $cim.ExecutablePath) { $candidates += @{ Path = $cim.ExecutablePath; Source = 'CIM' } }
} catch {}

$sysPath = Join-Path $env:WINDIR "System32\\$exeFull"
if (Test-Path $sysPath) { $candidates += @{ Path = $sysPath; Source = 'System32' } }

# Other well-known locations (non-recursive)
$wellKnownDirs = @(
  (Join-Path $env:WINDIR 'System32'),
  (Join-Path $env:WINDIR 'SysWOW64'),
  (Join-Path $env:WINDIR 'System32\\wbem'),
  (Join-Path $env:WINDIR 'System32\\drivers'),
  (Join-Path $env:WINDIR 'System32\\oobe'),
  'C:\\Program Files\\WSL'
)
foreach ($dir in $wellKnownDirs) {
  $candidatePath = Join-Path $dir $exeFull
  if (Test-Path $candidatePath) { $candidates += @{ Path = $candidatePath; Source = 'WellKnown' } }
}

# Windows Defender platform (versioned folder)
try {
  $defRoot = 'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform'
  if (Test-Path $defRoot) {
    $latestDef = Get-ChildItem -Directory -Path $defRoot -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    if ($latestDef) {
      $defPath = Join-Path $latestDef.FullName $exeFull
      if (Test-Path $defPath) { $candidates += @{ Path = $defPath; Source = 'Defender' } }
    }
  }
} catch {}

$seen = @{}
$chosen = $null
foreach ($c in $candidates) {
  if (-not $c.Path) { continue }
  $key = $c.Path.ToLower()
  if ($seen[$key]) { continue }
  $seen[$key] = $true
  if (Test-Path $c.Path) { $chosen = $c; break }
}

$reason = $null; $data = $null; $path = $null; $source = $null
if ($chosen) {
  $path = $chosen.Path; $source = $chosen.Source
  try {
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
    if ($icon) {
      $bitmap = $icon.ToBitmap()
      $ms = New-Object System.IO.MemoryStream
      $bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      $bytes = $ms.ToArray()
      $ms.Dispose(); $bitmap.Dispose(); $icon.Dispose()
      $data = [Convert]::ToBase64String($bytes)
    } else { $reason = 'extract-null-icon' }
  } catch { $reason = 'extract-error' }
} else {
  $reason = 'no-path-found'
}

$obj = [PSCustomObject]@{ path = $path; source = $source; data = $data; reason = $reason }
$obj | ConvertTo-Json -Compress
`;

  try {
    fs.writeFileSync(iconScriptPath, script, 'utf8');
  } catch (err) {
    console.error('Failed to write icon script:', err);
  }
  return iconScriptPath;
}

function rememberFolderIcon(filePath, result) {
  if (!filePath || !result?.dataUrl) return;
  const dir = path.dirname(filePath).toLowerCase();
  if (!folderIconCache.has(dir)) {
    folderIconCache.set(dir, { dataUrl: result.dataUrl, path: filePath, source: result.source || 'folder-cache', reason: result.reason || null });
  }
}

function getFolderIcon(filePath) {
  if (!filePath) return null;
  const dir = path.dirname(filePath).toLowerCase();
  return folderIconCache.get(dir) || null;
}

function runIconScriptForExe(name) {
  return new Promise((resolve) => {
    const start = Date.now();
    const scriptPath = ensureIconScript();
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ExeName', name],
      { timeout: 6000 },
      (error, stdout, stderr) => {
        const duration = Date.now() - start;
        if (error || !stdout || !stdout.trim()) {
          if (duration > 1000) {
            console.warn(`get-exe-icon miss for ${name} in ${duration}ms${error ? ' err:' + error.message : ''}`);
          }
          const stderrText = (stderr || '').trim();
          const reason = error?.killed ? 'timeout' : (error?.message || 'empty-output');
          const result = { dataUrl: null, path: null, source: null, reason: stderrText ? `${reason}; ${stderrText}` : reason };
          resolve(result);
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          const data = parsed?.data;
          const resolvedPath = parsed?.path;
          const reason = parsed?.reason;
          const source = parsed?.source;
          if (data) {
            const dataUrl = `data:image/png;base64,${data}`;
            const result = { dataUrl, path: resolvedPath, source: source || 'n/a', reason: null };
            resolve(result);
            return;
          }
          const result = { dataUrl: null, path: resolvedPath || null, source: source || null, reason: reason || 'unknown' };
          resolve(result);
        } catch (e) {
          const result = { dataUrl: null, path: null, source: null, reason: 'parse-error' };
          resolve(result);
        }
      }
    );
  });
}

async function getServicesIconFallback() {
  if (servicesIconCache) return servicesIconCache;
  if (servicesIconPromise) return servicesIconPromise;
  servicesIconPromise = runIconScriptForExe('services.exe').then((res) => {
    servicesIconCache = res;
    if (res?.dataUrl && res.path) {
      rememberFolderIcon(res.path, res);
    }
    return servicesIconCache;
  }).catch(() => {
    servicesIconCache = { dataUrl: null, path: null, source: null, reason: 'services-fallback-error' };
    return servicesIconCache;
  });
  return servicesIconPromise;
}

async function applyIconFallbacks(name, baseResult) {
  const hasIcon = !!baseResult?.dataUrl;
  const resolvedPath = baseResult?.path || null;

  if (hasIcon) {
    rememberFolderIcon(resolvedPath, baseResult);
    exeIconCache.set(name, baseResult);
    return baseResult;
  }

  // If we have no path at all (likely timeout/empty-output), skip sibling lookup and go straight to services fallback
  if (!resolvedPath) {
    const servicesIcon = await getServicesIconFallback();
    if (servicesIcon?.dataUrl) {
      const fallback = { dataUrl: servicesIcon.dataUrl, path: servicesIcon.path || null, source: 'services-fallback', reason: 'services-icon' };
      exeIconCache.set(name, fallback);
      return fallback;
    }
    const noIcon = { dataUrl: null, path: null, source: null, reason: baseResult?.reason || 'no-path' };
    exeIconCache.set(name, noIcon);
    return noIcon;
  }

  const sibling = getFolderIcon(resolvedPath);
  if (sibling?.dataUrl) {
    const fallback = { dataUrl: sibling.dataUrl, path: resolvedPath || sibling.path || null, source: sibling.source || 'sibling-fallback', reason: 'sibling-icon' };
    exeIconCache.set(name, fallback);
    return fallback;
  }

  const servicesIcon = await getServicesIconFallback();
  if (servicesIcon?.dataUrl) {
    const fallback = { dataUrl: servicesIcon.dataUrl, path: resolvedPath || servicesIcon.path || null, source: 'services-fallback', reason: 'services-icon' };
    exeIconCache.set(name, fallback);
    return fallback;
  }

  exeIconCache.set(name, baseResult);
  return baseResult;
}

function createDevicesWindow() {
  if (devicesWindow) {
    devicesWindow.show();
    devicesWindow.focus();
    return;
  }

  const width = 350;
  const height = 400;
  let x;
  let y;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getBounds();
    x = Math.round(bounds.x + (bounds.width - width) / 2);
    y = Math.round(bounds.y + (bounds.height - height) / 2);
  }

  devicesWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    parent: mainWindow,
    modal: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: getAppPath('devices-preload.js')
    }
  });

  devicesWindow.loadFile(getAppPath('devices.html'));

  devicesWindow.on('closed', () => {
    devicesWindow = null;
  });

  devicesWindow.on('blur', () => {
    if (devicesWindow) {
      devicesWindow.close();
    }
  });

  if (mainWindow) {
    mainWindow.on('moved', () => {
      if (devicesWindow) devicesWindow.close();
    });
  }
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  const { screen } = require('electron');
  const mainBounds = mainWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: mainBounds.x, y: mainBounds.y });

  const settingsWidth = 500;
  const settingsHeight = 450;
  const centerX = Math.round(display.bounds.x + (display.bounds.width - settingsWidth) / 2);
  const centerY = Math.round(display.bounds.y + (display.bounds.height - settingsHeight) / 2);

  settingsWindow = new BrowserWindow({
    width: settingsWidth,
    height: settingsHeight,
    x: centerX,
    y: centerY,
    parent: mainWindow,
    modal: false,
    frame: false,
    transparent: true,
    // Darken the acrylic backdrop further while keeping transparency
    backgroundColor: '#66000000',
    backgroundMaterial: process.platform === 'win32' ? 'acrylic' : undefined,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: getAppPath('settings-preload.js')
    }
  });

  if (settingsWindow.setBackgroundMaterial && process.platform === 'win32') {
    settingsWindow.setBackgroundMaterial('acrylic');
  }

  settingsWindow.loadFile(getAppPath('settings.html'));

  settingsWindow.on('close', (e) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      e.preventDefault();
      settingsWindow.hide();
    }
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function createDebugWindow() {
  if (debugWindow) {
    debugWindow.show();
    debugWindow.focus();
    return;
  }

  const { screen } = require('electron');
  const mainBounds = mainWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: mainBounds.x, y: mainBounds.y });

  const debugWidth = 650;
  const debugHeight = 500;
  const centerX = Math.round(display.bounds.x + (display.bounds.width - debugWidth) / 2);
  const centerY = Math.round(display.bounds.y + (display.bounds.height - debugHeight) / 2);

  debugWindow = new BrowserWindow({
    width: debugWidth,
    height: debugHeight,
    x: centerX,
    y: centerY,
    parent: mainWindow,
    modal: false,
    frame: false,
    transparent: true,
    backgroundColor: '#66000000',
    backgroundMaterial: process.platform === 'win32' ? 'acrylic' : undefined,
    resizable: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: getAppPath('debug-preload.js')
    }
  });

  if (debugWindow.setBackgroundMaterial && process.platform === 'win32') {
    debugWindow.setBackgroundMaterial('acrylic');
  }

  debugWindow.loadFile(getAppPath('debug.html'));

  debugWindow.on('closed', () => {
    debugWindow = null;
  });
}

function createWindow() {
  const config = loadConfigData();

  const defaultBounds = {
    width: 700,
    height: 300,
    x: undefined,
    y: undefined
  };

  const bounds = config.windowBounds || defaultBounds;

  mainWindow = new BrowserWindow({
    width: bounds.width || 700,
    height: bounds.height || 300,
    x: bounds.x,
    y: bounds.y,
    minWidth: 525,
    minHeight: 225,
    frame: false,
    transparent: true,
    resizable: true,
    icon: getAppPath('icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: getAppPath('preload.js')
    }
  });

  mainWindow.loadFile(getAppPath('index.html'));

  const saveBounds = () => {
    if (!mainWindow.isMinimized() && !mainWindow.isMaximized()) {
      const b = mainWindow.getBounds();
      saveConfig({ windowBounds: b });
    }
  };

  mainWindow.on('moved', saveBounds);
  mainWindow.on('resized', saveBounds);
}

app.whenReady().then(() => {
  resetCaches();
  initPaths();
  prewarmProcessList();

  const config = loadConfigData();
  if (config.startOnBoot !== undefined) {
    app.setLoginItemSettings({
      openAtLogin: config.startOnBoot,
      path: app.getPath('exe')
    });
  }

  ensureAudioCheck();

  createWindow();
  // Music library prompt is now handled by the renderer via in-app notification banner
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.on('debug-log', (event, msg) => {
  console.log('[settings]', msg);
});
ipcMain.on('open-devices-window', createDevicesWindow);
ipcMain.on('open-settings-window', createSettingsWindow);
ipcMain.on('open-settings-library', () => {
  createSettingsWindow();
  // Send message to settings window to open library modal after it loads
  if (settingsWindow) {
    settingsWindow.webContents.once('did-finish-load', () => {
      settingsWindow.webContents.send('open-library-modal');
    });
    // If already loaded, send immediately
    if (!settingsWindow.webContents.isLoading()) {
      settingsWindow.webContents.send('open-library-modal');
    }
  }
});

ipcMain.on('close-devices-window', () => {
  if (devicesWindow) {
    devicesWindow.close();
  }
});

ipcMain.on('close-settings-window', () => {
  if (settingsWindow) {
    settingsWindow.hide();
  }
});

// Debug window handlers (only available in dev mode)
ipcMain.on('open-debug-window', () => {
  if (IS_DEV) {
    createDebugWindow();
  }
});

// Expose dev mode check to renderer
ipcMain.handle('is-dev-mode', () => IS_DEV);

ipcMain.handle('close-debug-window', async () => {
  if (debugWindow) {
    debugWindow.close();
  }
});

ipcMain.handle('debug-trigger-update', async () => {
  // Send a fake update notification to main window
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('debug-show-update', {
      version: '99.99.99',
      releaseUrl: 'https://github.com/CalvFletch/AmbienceApp/releases/tag/v99.99.99'
    });
  }
  return { version: '99.99.99' };
});

ipcMain.handle('debug-trigger-library', async () => {
  // Send library notification to main window
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('debug-show-library');
  }
});

ipcMain.handle('debug-hide-update', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('debug-hide-update');
  }
});

ipcMain.handle('debug-simulate-duck', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('debug-duck');
  }
});

ipcMain.handle('debug-simulate-unduck', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('debug-unduck');
  }
});

ipcMain.handle('debug-force-play', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('debug-force-play');
  }
});

ipcMain.handle('debug-force-pause', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('debug-force-pause');
  }
});

ipcMain.handle('debug-force-skip', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('debug-force-skip');
  }
});

ipcMain.handle('debug-music-info', async () => {
  // Get music files inline (same logic as get-music-files handler)
  const folderToUse = previewMusicFolder || musicFolder;
  const audioExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.mp4', '.webm', '.mkv'];
  const allFiles = [];
  
  function findFiles(currentPath, categoryParts = []) {
    try {
      if (!fs.existsSync(currentPath)) return;
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules') {
          findFiles(fullPath, [...categoryParts, entry.name]);
        } else if (entry.isFile() && audioExtensions.includes(path.extname(entry.name).toLowerCase())) {
          allFiles.push({ category: categoryParts[0] || null });
        }
      }
    } catch (e) { /* ignore */ }
  }
  
  if (folderToUse) findFiles(folderToUse);
  
  const categories = [...new Set(allFiles.map(f => f.category).filter(Boolean))];
  return {
    folder: folderToUse,
    totalFiles: allFiles.length,
    categories: categories
  };
});

ipcMain.handle('debug-get-config', async () => {
  return loadConfigData();
});

ipcMain.handle('debug-clear-dismissed-update', async () => {
  saveConfig({ dismissedUpdateVersion: null });
});

ipcMain.handle('debug-clear-library-prompt', async () => {
  saveConfig({ dismissedLibraryPrompt: false });
});

// Function to send status updates to debug window
function sendDebugStatus(status) {
  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.webContents.send('debug-status-update', status);
  }
}

// Function to send log messages to debug window
function sendDebugLog(msg, type = 'info') {
  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.webContents.send('debug-log-message', msg, type);
  }
}

ipcMain.handle('get-settings-state', async () => {
  const config = loadConfigData();
  return {
    musicFolder: musicFolder,
    duckMode: config.duckMode || 'device',
    duckExes: config.duckExes || [],
    duckDevices: config.duckDevices || [],
    cachedDevices: config.cachedDevices || [],
    cachedProcesses: config.cachedProcesses || []
  };
});

ipcMain.handle('get-audio-devices', async () => {
  const config = loadConfigData();
  const cachedDevices = config.cachedDevices || [];

  const ready = await ensureAudioCheck();
  if (!ready) {
    return { devices: cachedDevices, fromCache: true };
  }

  const { exePath } = getAudioCheckPaths();

  const freshDevices = await new Promise((resolve) => {
    exec(`"${exePath}" --list`, { timeout: 5000 }, (error, stdout) => {
      if (error) {
        console.error('Error getting audio devices:', error);
        resolve([]);
        return;
      }
      const devices = stdout.trim().split('\n').filter(d => d.trim()).map(d => d.trim());
      resolve(devices);
    });
  });

  if (freshDevices.length > 0) {
    saveConfig({ cachedDevices: freshDevices });
  }

  return { devices: freshDevices, fromCache: false };
});

ipcMain.handle('open-external-url', async (event, url) => {
  if (url && typeof url === 'string') {
    shell.openExternal(url);
  }
});

ipcMain.handle('browse-for-exe', async () => {
  const result = await dialog.showOpenDialog(settingsWindow || mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Executables', extensions: ['exe'] }],
    title: 'Select Program'
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const fullPath = result.filePaths[0];
    const exeName = path.basename(fullPath).toLowerCase();
    return exeName;
  }
  return null;
});

ipcMain.handle('get-exe-icon', async (event, exeName) => {
  const name = (exeName || '').toLowerCase();
  if (!name.endsWith('.exe')) {
    return { dataUrl: null, path: null, source: null, reason: 'not-exe' };
  }

  if (exeIconCache.has(name)) {
    const cached = exeIconCache.get(name);
    if (!cached?.dataUrl) {
      const finalResult = await applyIconFallbacks(name, cached);
      writeIconCache(name, finalResult);
      return finalResult;
    }
    writeIconCache(name, cached);
    return cached;
  }

  const diskCached = readIconCache(name);
  if (diskCached) {
    exeIconCache.set(name, diskCached);
    return diskCached;
  }

  const rawResult = await runIconScriptForExe(name);
  const finalResult = await applyIconFallbacks(name, rawResult);
  writeIconCache(name, finalResult);
  return finalResult;
});

ipcMain.on('save-settings-from-window', (event, settings) => {
  saveConfig(settings);
  if (mainWindow) {
    mainWindow.webContents.send('on-settings-updated', settings);
  }
});

ipcMain.handle('get-initial-devices-state', async () => {
  const config = loadConfigData();
  const selectedDevices = config.duckDevices || [];

  const ready = await ensureAudioCheck();
  if (!ready) {
    return { allDevices: [], selectedDevices };
  }

  const { exePath } = getAudioCheckPaths();

  const allDevices = await new Promise((resolve) => {
    exec(`"${exePath}" --list`, { timeout: 5000 }, (error, stdout) => {
      if (error) {
        console.error('Error getting audio devices:', error);
        resolve([]);
        return;
      }
      const devices = stdout.trim().split('\n').filter(d => d.trim()).map(d => d.trim());
      resolve(devices);
    });
  });

  return { allDevices, selectedDevices };
});

ipcMain.on('update-duck-devices', (event, devices) => {
  if (mainWindow) {
    mainWindow.webContents.send('on-duck-devices-updated', devices);
  }
});
ipcMain.handle('get-music-files', async () => {
  try {
    // Use preview folder if set, otherwise use saved musicFolder
    const folderToUse = previewMusicFolder || musicFolder;
    
    if (!fs.existsSync(folderToUse)) {
      fs.mkdirSync(folderToUse, { recursive: true });
    }

    const audioExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.mp4', '.webm', '.mkv'];
    const allAudioFiles = [];

    function findMusicFiles(currentPath, categoryParts = []) {
      try {
        const entries = fs.readdirSync(currentPath, { withFileTypes: true });

        let topLevelIconPath = null;
        if (categoryParts.length > 0) {
          const topLevelCategoryDir = path.join(folderToUse, categoryParts[0]);
          const topLevelIcon = path.join(topLevelCategoryDir, 'icon.png');
          if (fs.existsSync(topLevelIcon)) {
            topLevelIconPath = topLevelIcon;
          }
        }

        for (const entry of entries) {
          const fullPath = path.join(currentPath, entry.name);
          if (entry.isDirectory()) {
            // Ignore node_modules or other special dirs if necessary
            if (entry.name === 'node_modules') continue;
            findMusicFiles(fullPath, [...categoryParts, entry.name]);
          } else if (entry.isFile() && audioExtensions.includes(path.extname(entry.name).toLowerCase())) {
            const category = categoryParts.length > 0 ? categoryParts.join(' / ') : null;
            
            // Exclude category icons from being added as tracks
            if (entry.name.toLowerCase() === 'icon.png') continue;

            allAudioFiles.push({
              name: path.basename(entry.name, path.extname(entry.name)),
              category: category,
              categoryIcon: topLevelIconPath,
              path: fullPath
            });
          }
        }
      } catch (e) {
        console.error(`Error reading directory ${currentPath}:`, e);
      }
    }

    findMusicFiles(folderToUse);
    return allAudioFiles;

  } catch (error) {
    console.error('Error reading music folder:', error);
    return [];
  }
});

ipcMain.handle('minimize-window', () => {
  mainWindow.minimize();
});

ipcMain.handle('close-window', () => {
  mainWindow.close();
});

ipcMain.handle('open-music-folder', () => {
  if (!fs.existsSync(musicFolder)) {
    fs.mkdirSync(musicFolder, { recursive: true });
  }
  shell.openPath(musicFolder);
});

ipcMain.handle('select-music-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Music Folder'
  });

  if (!result.canceled && result.filePaths.length > 0) {
    musicFolder = result.filePaths[0];
    saveConfig();
    return musicFolder;
  }
  return null;
});

ipcMain.handle('save-music-folder', async (event, folderPath) => {
  try {
    // Check if path looks like a valid path
    if (!folderPath || folderPath.trim() === '') {
      return { success: false, error: 'PLEASE ENTER A FOLDER PATH' };
    }
    
    const normalizedPath = path.resolve(folderPath);
    
    // Check if drive letter exists (Windows)
    if (process.platform === 'win32') {
      const driveLetter = normalizedPath.charAt(0).toUpperCase();
      if (/^[A-Z]$/.test(driveLetter)) {
        const driveRoot = driveLetter + ':\\';
        if (!fs.existsSync(driveRoot)) {
          return { success: false, error: `DRIVE ${driveLetter}: DOES NOT EXIST` };
        }
      }
    }
    
    // Try to create directory if it doesn't exist
    try {
      if (!fs.existsSync(normalizedPath)) {
        fs.mkdirSync(normalizedPath, { recursive: true });
      }
    } catch (mkdirErr) {
      console.error('mkdir error:', mkdirErr);
      return { success: false, error: 'CANNOT CREATE FOLDER - CHECK PERMISSIONS' };
    }
    
    // Test write access by creating a temp file
    const testFile = path.join(normalizedPath, '.ambience-test');
    try {
      fs.writeFileSync(testFile, '');
      fs.unlinkSync(testFile);
    } catch (accessErr) {
      console.error('access test error:', accessErr);
      return { success: false, error: 'ACCESS DENIED - CHECK FOLDER PERMISSIONS' };
    }
    
    // All good - save and update
    musicFolder = normalizedPath;
    saveConfig();
    
    // Notify main window to refresh music files
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('music-files-updated');
    }
    
    return { success: true };
  } catch (err) {
    console.error('save-music-folder error:', err);
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      return { success: false, error: 'ACCESS DENIED - CHECK FOLDER PERMISSIONS' };
    }
    if (err.code === 'ENOENT') {
      return { success: false, error: 'INVALID PATH - PARENT FOLDER DOES NOT EXIST' };
    }
    return { success: false, error: 'INVALID PATH OR PERMISSION ERROR' };
  }
});

// Preview music folder - validates and updates main window without saving to config
// This temporarily changes the music folder so the main window loads music from the new path
let previewMusicFolder = null;

ipcMain.handle('preview-music-folder', async (event, folderPath) => {
  try {
    if (!folderPath || folderPath.trim() === '') {
      return { success: false, error: '' };
    }
    
    const normalizedPath = path.resolve(folderPath);
    
    // Check if folder exists
    if (!fs.existsSync(normalizedPath)) {
      return { success: false, error: 'FOLDER DOES NOT EXIST' };
    }
    
    // Check if it's a directory
    const stats = fs.statSync(normalizedPath);
    if (!stats.isDirectory()) {
      return { success: false, error: 'PATH IS NOT A FOLDER' };
    }
    
    // Set preview folder - getMusicFiles will use this temporarily
    previewMusicFolder = normalizedPath;
    
    // Notify main window to refresh music files with new path
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('music-files-updated');
    }
    
    return { success: true };
  } catch (err) {
    console.error('preview-music-folder error:', err);
    return { success: false, error: 'ERROR CHECKING FOLDER' };
  }
});

ipcMain.handle('get-music-folder-path', () => {
  return musicFolder;
});

ipcMain.handle('save-settings', (event, settings) => {
  saveConfig(settings);
});

ipcMain.handle('load-settings', () => {
  return loadConfigData();
});

ipcMain.handle('get-start-on-boot', () => {
  const settings = app.getLoginItemSettings();
  return settings.openAtLogin;
});

ipcMain.handle('set-start-on-boot', (event, enabled) => {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: app.getPath('exe')
  });
  saveConfig({ startOnBoot: enabled });
  return enabled;
});

// Create a C# script file for audio peak detection at startup
// Store in userData folder (not __dirname which is inside asar in production)
let audioCheckCsPath = null;
let audioCheckExePath = null;

function getAudioCheckPaths() {
  if (!audioCheckCsPath) {
    const userDataPath = app.getPath('userData');
    audioCheckCsPath = path.join(userDataPath, 'AudioPeakCheck.cs');
    audioCheckExePath = path.join(userDataPath, 'AudioPeakCheck.exe');
  }
  return { csPath: audioCheckCsPath, exePath: audioCheckExePath };
}

const audioCheckCs = `
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Collections.Generic;

class Program {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
        int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IMMDeviceCollection ppDevices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
    }

    [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection {
        int GetCount(out int pcDevices);
        int Item(int nDevice, out IMMDevice ppDevice);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
        int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        int OpenPropertyStore(int stgmAccess, out IPropertyStore ppProperties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
        int GetState(out int pdwState);
    }

    [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
        int GetCount(out int cProps);
        int GetAt(int iProp, out PROPERTYKEY pkey);
        int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROPERTYKEY {
        public Guid fmtid;
        public int pid;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROPVARIANT {
        public short vt;
        public short r1, r2, r3;
        public IntPtr p1, p2;
    }

    [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioMeterInformation {
        int GetPeakValue(out float pfPeak);
    }

    // Audio Session interfaces for per-process audio
    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2 {
        int GetAudioSessionControl(IntPtr AudioSessionGuid, int StreamFlags, IntPtr SessionControl);
        int GetSimpleAudioVolume(IntPtr AudioSessionGuid, int StreamFlags, IntPtr AudioVolume);
        int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
    }

    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator {
        int GetCount(out int SessionCount);
        int GetSession(int SessionCount, out IAudioSessionControl Session);
    }

    [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl {
        int GetState(out int state);
        int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, [MarshalAs(UnmanagedType.LPStruct)] Guid EventContext);
        int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, [MarshalAs(UnmanagedType.LPStruct)] Guid EventContext);
        int GetGroupingParam(out Guid pRetVal);
        int SetGroupingParam([MarshalAs(UnmanagedType.LPStruct)] Guid Override, [MarshalAs(UnmanagedType.LPStruct)] Guid EventContext);
        int RegisterAudioSessionNotification(IntPtr NewNotifications);
        int UnregisterAudioSessionNotification(IntPtr NewNotifications);
    }

    [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2 : IAudioSessionControl {
        new int GetState(out int state);
        new int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        new int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, [MarshalAs(UnmanagedType.LPStruct)] Guid EventContext);
        new int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        new int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, [MarshalAs(UnmanagedType.LPStruct)] Guid EventContext);
        new int GetGroupingParam(out Guid pRetVal);
        new int SetGroupingParam([MarshalAs(UnmanagedType.LPStruct)] Guid Override, [MarshalAs(UnmanagedType.LPStruct)] Guid EventContext);
        new int RegisterAudioSessionNotification(IntPtr NewNotifications);
        new int UnregisterAudioSessionNotification(IntPtr NewNotifications);
        int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        int GetProcessId(out uint pRetVal);
        int IsSystemSoundsSession();
        int SetDuckingPreference(bool optOut);
    }

    static readonly Guid IID_IAudioMeterInformation = new Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064");
    static readonly Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    static readonly PROPERTYKEY PKEY_Device_FriendlyName = new PROPERTYKEY {
        fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14
    };

    static void Main(string[] args) {
        try {
            if (args.Length == 0) {
                Console.WriteLine("-1");
                return;
            }

            string mode = args[0];
            var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());

            // --list: List audio devices
            if (mode == "--list") {
                IMMDeviceCollection devices;
                enumerator.EnumAudioEndpoints(0, 1, out devices);
                int count; devices.GetCount(out count);
                for (int i = 0; i < count; i++) {
                    IMMDevice device; devices.Item(i, out device);
                    IPropertyStore props; device.OpenPropertyStore(0, out props);
                    PROPVARIANT name; var key = PKEY_Device_FriendlyName;
                    props.GetValue(ref key, out name);
                    Console.WriteLine(Marshal.PtrToStringUni(name.p1));
                }
                return;
            }

            // --list-sessions: List processes with active audio sessions
            if (mode == "--list-sessions") {
                var sessions = GetAudioSessions(enumerator);
                foreach (var s in sessions) {
                    Console.WriteLine(s);
                }
                return;
            }

            // --check-exe <exe1> <exe2> ...: Check if any of the specified exes are playing audio
            if (mode == "--check-exe" && args.Length > 1) {
                var targetExes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                for (int i = 1; i < args.Length; i++) {
                    targetExes.Add(args[i].ToLowerInvariant());
                }
                float maxPeak = CheckExeAudio(enumerator, targetExes);
                Console.WriteLine(maxPeak);
                return;
            }

            // Default: Check device by name (legacy mode)
            string targetDevice = args[0];
            IMMDeviceCollection devs;
            enumerator.EnumAudioEndpoints(0, 1, out devs);
            int cnt; devs.GetCount(out cnt);
            for (int i = 0; i < cnt; i++) {
                IMMDevice device; devs.Item(i, out device);
                IPropertyStore props; device.OpenPropertyStore(0, out props);
                PROPVARIANT name; var key = PKEY_Device_FriendlyName;
                props.GetValue(ref key, out name);
                string deviceName = Marshal.PtrToStringUni(name.p1);
                if (deviceName.Contains(targetDevice)) {
                    object meterObj; Guid iid = IID_IAudioMeterInformation;
                    device.Activate(ref iid, 1, IntPtr.Zero, out meterObj);
                    var meter = (IAudioMeterInformation)meterObj;
                    float peak; meter.GetPeakValue(out peak);
                    Console.WriteLine(peak);
                    return;
                }
            }
            Console.WriteLine("-1");
        } catch (Exception ex) {
            Console.WriteLine("-99");
        }
    }

    static List<string> GetAudioSessions(IMMDeviceEnumerator enumerator) {
        var result = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try {
            // Check ALL audio devices, not just default
            IMMDeviceCollection devices;
            enumerator.EnumAudioEndpoints(0, 1, out devices); // 0 = eRender, 1 = DEVICE_STATE_ACTIVE
            int deviceCount; devices.GetCount(out deviceCount);

            for (int d = 0; d < deviceCount; d++) {
                try {
                    IMMDevice device; devices.Item(d, out device);
                    object mgrObj; Guid iid = IID_IAudioSessionManager2;
                    device.Activate(ref iid, 1, IntPtr.Zero, out mgrObj);
                    var mgr = (IAudioSessionManager2)mgrObj;
                    IAudioSessionEnumerator sessionEnum;
                    mgr.GetSessionEnumerator(out sessionEnum);
                    int count; sessionEnum.GetCount(out count);
                    for (int i = 0; i < count; i++) {
                        try {
                            IAudioSessionControl ctrl; sessionEnum.GetSession(i, out ctrl);
                            var ctrl2 = (IAudioSessionControl2)ctrl;
                            uint pid; ctrl2.GetProcessId(out pid);
                            if (pid == 0) continue;
                            var proc = Process.GetProcessById((int)pid);
                            string exeName = proc.ProcessName.ToLowerInvariant() + ".exe";
                            if (!seen.Contains(exeName)) {
                                seen.Add(exeName);
                                result.Add(exeName);
                            }
                        } catch {}
                    }
                } catch {}
            }
        } catch {}
        return result;
    }

    static float CheckExeAudio(IMMDeviceEnumerator enumerator, HashSet<string> targetExes) {
        float maxPeak = 0;
        try {
            // Check all render endpoints, not just default
            IMMDeviceCollection devices;
            enumerator.EnumAudioEndpoints(0, 1, out devices); // 0 = eRender, 1 = DEVICE_STATE_ACTIVE
            int deviceCount; devices.GetCount(out deviceCount);

            for (int d = 0; d < deviceCount; d++) {
                try {
                    IMMDevice device; devices.Item(d, out device);
                    object mgrObj; Guid iid = IID_IAudioSessionManager2;
                    device.Activate(ref iid, 1, IntPtr.Zero, out mgrObj);
                    var mgr = (IAudioSessionManager2)mgrObj;
                    IAudioSessionEnumerator sessionEnum;
                    mgr.GetSessionEnumerator(out sessionEnum);
                    int count; sessionEnum.GetCount(out count);

                    for (int i = 0; i < count; i++) {
                        try {
                            IAudioSessionControl ctrl; sessionEnum.GetSession(i, out ctrl);
                            var ctrl2 = (IAudioSessionControl2)ctrl;
                            uint pid; ctrl2.GetProcessId(out pid);
                            if (pid == 0) continue;

                            string exeName;
                            try {
                                var proc = Process.GetProcessById((int)pid);
                                exeName = proc.ProcessName.ToLowerInvariant() + ".exe";
                            } catch { continue; }

                            if (targetExes.Contains(exeName)) {
                                // Try to get meter via QueryInterface
                                IntPtr pUnk = Marshal.GetIUnknownForObject(ctrl);
                                IntPtr pMeter = IntPtr.Zero;
                                Guid meterGuid = IID_IAudioMeterInformation;
                                int hr = Marshal.QueryInterface(pUnk, ref meterGuid, out pMeter);
                                Marshal.Release(pUnk);

                                if (hr == 0 && pMeter != IntPtr.Zero) {
                                    var meter = (IAudioMeterInformation)Marshal.GetObjectForIUnknown(pMeter);
                                    Marshal.Release(pMeter);
                                    float peak; meter.GetPeakValue(out peak);
                                    if (peak > maxPeak) maxPeak = peak;
                                }
                            }
                        } catch {}
                    }
                } catch {}
            }
        } catch {}
        return maxPeak;
    }
}
`;

// Write and compile the C# helper on first run
// Version is used to force recompile when source changes
const AUDIO_CHECK_VERSION = '7';
let audioCheckReady = false;

function ensureAudioCheck() {
  if (audioCheckReady) return Promise.resolve(true);

  const { csPath, exePath } = getAudioCheckPaths();
  const versionPath = path.join(app.getPath('userData'), 'AudioPeakCheck.version');

  return new Promise((resolve) => {
    // Check if exe already exists with correct version
    let needsCompile = true;
    if (fs.existsSync(exePath) && fs.existsSync(versionPath)) {
      try {
        const currentVersion = fs.readFileSync(versionPath, 'utf8').trim();
        if (currentVersion === AUDIO_CHECK_VERSION) {
          needsCompile = false;
        }
      } catch (e) {}
    }

    if (!needsCompile) {
      audioCheckReady = true;
      resolve(true);
      return;
    }

    // Write the C# source
    try {
      fs.writeFileSync(csPath, audioCheckCs);
    } catch (e) {
      console.error('Failed to write C# source:', e);
      resolve(false);
      return;
    }

    // Compile with csc
    const cscPaths = [
      'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
      'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'
    ];

    const cscPath = cscPaths.find(p => fs.existsSync(p));
    if (!cscPath) {
      console.error('C# compiler not found');
      resolve(false);
      return;
    }

    exec(`"${cscPath}" /nologo /optimize /out:"${exePath}" "${csPath}"`, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        console.error('Compile error:', stderr || error.message);
        resolve(false);
        return;
      }
      // Write version file on successful compile
      try {
        fs.writeFileSync(versionPath, AUDIO_CHECK_VERSION);
      } catch (e) {}
      audioCheckReady = true;
      resolve(true);
    });
  });
}

// Throttle audio checks to prevent overlapping process spawns
let audioCheckInProgress = false;
let lastAudioCheckResult = { peak: 0, playing: false };

ipcMain.handle('check-audio-activity', async (event, deviceName) => {
  if (!deviceName) {
    return { peak: 0, playing: false };
  }

  // If a check is already in progress, return the last known result
  if (audioCheckInProgress) {
    return lastAudioCheckResult;
  }

  // Make sure exe is ready
  const ready = await ensureAudioCheck();
  if (!ready) {
    return { peak: 0, playing: false, error: 'not ready' };
  }

  audioCheckInProgress = true;
  const { exePath } = getAudioCheckPaths();

  return new Promise((resolve) => {
    exec(`"${exePath}" "${deviceName}"`, { timeout: 1000 }, (error, stdout, stderr) => {
      audioCheckInProgress = false;

      if (error) {
        const result = { peak: 0, playing: false, error: error.message };
        lastAudioCheckResult = result;
        resolve(result);
        return;
      }

      const rawResult = stdout.trim();
      const peakValue = parseFloat(rawResult);

      if (!isNaN(peakValue) && peakValue >= 0) {
        const isPlaying = peakValue > 0.0001;
        const result = { peak: peakValue, playing: isPlaying };
        lastAudioCheckResult = result;
        resolve(result);
      } else {
        const result = { peak: 0, playing: false, raw: rawResult };
        lastAudioCheckResult = result;
        resolve(result);
      }
    });
  });
});

// Get list of processes with active audio sessions
ipcMain.handle('get-audio-sessions', async () => {
  const ready = await ensureAudioCheck();
  if (!ready) {
    return [];
  }

  const { exePath } = getAudioCheckPaths();

  return new Promise((resolve) => {
    exec(`"${exePath}" --list-sessions`, { timeout: 5000 }, (error, stdout) => {
      if (error) {
        console.error('Error getting audio sessions:', error);
        resolve([]);
        return;
      }
      const sessions = stdout.trim().split('\n').filter(s => s.trim()).map(s => s.trim());
      resolve(sessions);
    });
  });
});

// Check audio activity for specific exe names
let exeCheckInProgress = false;
let lastExeCheckResult = { peak: 0, playing: false };

ipcMain.handle('check-exe-audio', async (event, exeNames) => {
  if (!exeNames || exeNames.length === 0) {
    return { peak: 0, playing: false };
  }

  if (exeCheckInProgress) {
    return lastExeCheckResult;
  }

  const ready = await ensureAudioCheck();
  if (!ready) {
    return { peak: 0, playing: false, error: 'not ready' };
  }

  exeCheckInProgress = true;
  const { exePath } = getAudioCheckPaths();
  const exeArgs = exeNames.map(e => `"${e}"`).join(' ');

  return new Promise((resolve) => {
    exec(`"${exePath}" --check-exe ${exeArgs}`, { timeout: 1000 }, (error, stdout, stderr) => {
      exeCheckInProgress = false;

      if (error) {
        const result = { peak: 0, playing: false, error: error.message };
        lastExeCheckResult = result;
        resolve(result);
        return;
      }

      const rawResult = stdout.trim();
      const peakValue = parseFloat(rawResult);

      if (!isNaN(peakValue) && peakValue >= 0) {
        const isPlaying = peakValue > 0.0001;
        const result = { peak: peakValue, playing: isPlaying };
        lastExeCheckResult = result;
        resolve(result);
      } else {
        const result = { peak: 0, playing: false, raw: rawResult };
        lastExeCheckResult = result;
        resolve(result);
      }
    });
  });
});

// Get list of all running processes using tasklist (faster than PowerShell)
function fetchProcessList() {
  return new Promise((resolve) => {
    exec('tasklist /FO CSV /NH', { timeout: 5000 }, (error, stdout) => {
      if (error) {
        console.error('Error getting processes:', error);
        resolve([]);
        return;
      }
      const seen = new Set();
      const processes = [];
      const lines = stdout.split('\n');
      for (const line of lines) {
        const match = line.match(/^"([^"]+\.exe)"/i);
        if (match) {
          const name = match[1].toLowerCase();
          if (!seen.has(name)) {
            seen.add(name);
            processes.push(name);
          }
        }
      }
      processes.sort();
      resolve(processes);
    });
  });
}

// Warm the process list cache at startup
function prewarmProcessList() {
  if (processListCache.fetching) return;
  processListCache.fetching = fetchProcessList().then((processes) => {
    processListCache.data = processes;
    processListCache.fetchedAt = Date.now();
    processListCache.fetching = null;
    return processes;
  }).catch(() => {
    processListCache.fetching = null;
    return [];
  });
}

ipcMain.handle('get-running-processes', async () => {
  // If we have cached data, return it immediately
  if (processListCache.data && processListCache.data.length > 0) {
    return processListCache.data;
  }

  // If a fetch is in-flight (from prewarm), wait for it
  if (processListCache.fetching) {
    const processes = await processListCache.fetching;
    return processes || processListCache.data || [];
  }

  // No cache and no in-flight fetch - do a fresh fetch
  const processes = await fetchProcessList();
  processListCache.data = processes;
  processListCache.fetchedAt = Date.now();
  return processes;
});

// Check for updates from GitHub releases
ipcMain.handle('check-for-updates', async () => {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/releases/latest`,
      headers: {
        'User-Agent': 'AmbienceApp'
      }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const release = JSON.parse(data);
          const latestVersion = release.tag_name?.replace(/^v/, '') || '';
          const hasUpdate = compareVersions(latestVersion, CURRENT_VERSION) > 0;
          resolve({
            hasUpdate,
            currentVersion: CURRENT_VERSION,
            latestVersion,
            releaseUrl: release.html_url || `https://github.com/${GITHUB_REPO}/releases/tag/v${latestVersion}`
          });
        } catch (e) {
          resolve({ hasUpdate: false, error: 'Failed to parse response' });
        }
      });
    }).on('error', (e) => {
      resolve({ hasUpdate: false, error: e.message });
    });
  });
});

// Compare semantic versions: returns 1 if a > b, -1 if a < b, 0 if equal
function compareVersions(a, b) {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

// Save dismissed update version
ipcMain.handle('save-dismissed-update', async (event, version) => {
  saveConfig({ dismissedUpdateVersion: version });
});

// Get dismissed update version
ipcMain.handle('get-dismissed-update', async () => {
  const config = loadConfigData();
  return config.dismissedUpdateVersion || '';
});

// === Music Library Management ===

function getLibraryMetadataPath() {
  if (!musicFolder) return null;
  return path.join(musicFolder, LIBRARY_METADATA_FILENAME);
}

function readLibraryMetadata() {
  const metaPath = getLibraryMetadataPath();
  if (!metaPath || !fs.existsSync(metaPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(metaPath, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (e) {
    console.error('Failed to read library metadata:', e);
    return null;
  }
}

function writeLibraryMetadata(metadata) {
  const metaPath = getLibraryMetadataPath();
  if (!metaPath) return false;
  try {
    // Ensure music folder exists
    if (!fs.existsSync(musicFolder)) {
      fs.mkdirSync(musicFolder, { recursive: true });
    }
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to write library metadata:', e);
    return false;
  }
}

// Fetch all releases from music library repo (per-category releases)
// Load releases cache from disk
function loadReleasesCache() {
  try {
    const cachePath = path.join(musicFolder, RELEASES_CACHE_FILENAME);
    if (fs.existsSync(cachePath)) {
      const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cacheData.releases && cacheData.timestamp) {
        releasesCache = cacheData.releases;
        releasesCacheTime = cacheData.timestamp;
        return true;
      }
    }
  } catch (e) {
    console.error('Failed to load releases cache:', e);
  }
  return false;
}

// Save releases cache to disk
function saveReleasesCache(releases) {
  try {
    const cachePath = path.join(musicFolder, RELEASES_CACHE_FILENAME);
    fs.writeFileSync(cachePath, JSON.stringify({
      releases: releases,
      timestamp: Date.now()
    }, null, 2));
  } catch (e) {
    console.error('Failed to save releases cache:', e);
  }
}

// Fetch releases from GitHub API (no caching)
function fetchReleasesFromAPI() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${MUSIC_LIBRARY_REPO}/releases`,
      headers: {
        'User-Agent': 'AmbienceApp'
      }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const releases = JSON.parse(data);
          // Ensure we got an array (API might return error object on rate limit, etc.)
          if (!Array.isArray(releases)) {
            console.error('GitHub API returned non-array:', releases.message || releases);
            resolve(null);
            return;
          }
          resolve(releases);
        } catch (e) {
          console.error('Failed to parse releases:', e);
          resolve(null);
        }
      });
    }).on('error', (e) => {
      console.error('Failed to fetch releases:', e);
      resolve(null);
    });
  });
}

// Fetch library metadata from GitHub (raw file)
let libraryMetadataRemote = null;
let libraryMetadataRemoteTime = 0;

function fetchLibraryMetadataFromGitHub() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'raw.githubusercontent.com',
      path: `/${MUSIC_LIBRARY_REPO}/main/library-metadata.json`,
      headers: {
        'User-Agent': 'AmbienceApp'
      }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const metadata = JSON.parse(data);
          resolve(metadata);
        } catch (e) {
          console.error('Failed to parse library metadata:', e);
          resolve(null);
        }
      });
    }).on('error', (e) => {
      console.error('Failed to fetch library metadata:', e);
      resolve(null);
    });
  });
}

async function getLibraryMetadataRemote(forceRefresh = false) {
  const now = Date.now();
  
  // Cache for 1 hour
  if (!forceRefresh && libraryMetadataRemote && (now - libraryMetadataRemoteTime) < 3600000) {
    return libraryMetadataRemote;
  }
  
  const metadata = await fetchLibraryMetadataFromGitHub();
  if (metadata) {
    libraryMetadataRemote = metadata;
    libraryMetadataRemoteTime = now;
  }
  return metadata || libraryMetadataRemote;
}

// Fetch releases with 24-hour caching
async function fetchMusicLibraryReleases(forceRefresh = false) {
  const now = Date.now();
  
  // Try to load from disk cache if not in memory
  if (!releasesCache) {
    loadReleasesCache();
  }
  
  // Check if cache is still valid (24 hours)
  if (!forceRefresh && releasesCache && (now - releasesCacheTime) < RELEASES_CACHE_TTL) {
    console.log('Using cached releases (expires in', Math.round((RELEASES_CACHE_TTL - (now - releasesCacheTime)) / 3600000), 'hours)');
    return releasesCache;
  }
  
  // Fetch fresh data from API
  console.log('Fetching fresh releases from GitHub API...');
  const releases = await fetchReleasesFromAPI();
  
  if (releases) {
    // Update cache
    releasesCache = releases;
    releasesCacheTime = now;
    saveReleasesCache(releases);
    return releases;
  }
  
  // If API failed but we have stale cache, use it
  if (releasesCache) {
    console.log('API failed, using stale cache');
    return releasesCache;
  }
  
  return [];
}

// Debug: Force refresh music library releases (bypass cache)
ipcMain.handle('debug-force-refresh-library', async () => {
  console.log('Force refreshing music library releases...');
  releasesCache = null;
  releasesCacheTime = 0;
  
  // Delete disk cache file
  if (musicFolder) {
    const cacheFile = path.join(musicFolder, RELEASES_CACHE_FILENAME);
    try {
      if (fs.existsSync(cacheFile)) {
        fs.unlinkSync(cacheFile);
      }
    } catch (e) {
      console.error('Failed to delete cache file:', e);
    }
  }
  
  const releases = await fetchMusicLibraryReleases(true);
  return {
    success: true,
    releaseCount: releases?.length || 0,
    releases: releases?.map(r => r.tag_name) || []
  };
});

// Debug: Clear local library metadata (removes installed category info)
ipcMain.handle('debug-clear-library-metadata', async () => {
  if (!musicFolder) return { success: false, error: 'No music folder set' };
  
  const metadataPath = path.join(musicFolder, LIBRARY_METADATA_FILENAME);
  try {
    if (fs.existsSync(metadataPath)) {
      fs.unlinkSync(metadataPath);
    }
    // Also clear in-memory cache
    libraryMetadataCache = null;
    libraryMetadataCacheTime = 0;
    return { success: true, message: 'Library metadata cleared' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Parse category info from release (tag format: category-version, e.g., skyrim-1.0.0)
function parseCategoryFromRelease(release) {
  if (!release.tag_name) return null;
  
  // Tag format: category-name-version (e.g., skyrim-1.0.0, star-wars-1.0.0)
  const tagParts = release.tag_name.split('-');
  if (tagParts.length < 2) return null;
  
  // Version is always the last part
  const version = tagParts.pop();
  // Category name is everything before version (rejoined with spaces, title case)
  const categorySlug = tagParts.join('-');
  const categoryName = categorySlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  
  // Get archive names from release assets
  // Support both single .zip and split files (.zip.001, .zip.002, etc.)
  const archiveNames = (release.assets || [])
    .filter(a => a.name.endsWith('.zip') || /\.zip\.\d{3}$/.test(a.name))
    .map(a => a.name)
    .sort(); // Ensure parts are in order
  
  // Parse release notes for metadata (songCount and totalSize)
  let songCount = 0;
  let totalSize = 0;
  const body = release.body || '';
  
  // Match "Media files: 3" format
  const songMatch = body.match(/Media files:\s*(\d+)/i);
  if (songMatch) songCount = parseInt(songMatch[1], 10);
  
  // Match "Size: 245.2 MB" or "Size: 1.5 GB" format and convert to bytes
  const sizeMatch = body.match(/Size:\s*([\d.]+)\s*(MB|GB)/i);
  if (sizeMatch) {
    const sizeValue = parseFloat(sizeMatch[1]);
    const sizeUnit = sizeMatch[2].toUpperCase();
    if (sizeUnit === 'GB') {
      totalSize = Math.round(sizeValue * 1024 * 1024 * 1024);
    } else {
      totalSize = Math.round(sizeValue * 1024 * 1024);
    }
  }
  
  return {
    name: categoryName,
    slug: categorySlug,
    version: version,
    releaseTag: release.tag_name,
    releaseUrl: release.html_url,
    archiveNames: archiveNames,
    songCount: songCount,
    totalSize: totalSize
  };
}

// Build available categories from all releases (each release = one category)
async function buildAvailableCategoriesMap() {
  const releases = await fetchMusicLibraryReleases();
  const metadata = await getLibraryMetadataRemote();
  
  if (!Array.isArray(releases) || releases.length === 0) return {};

  const categoryMap = {};
  
  // Group releases by category, keep only the latest version of each
  for (const release of releases) {
    const catInfo = parseCategoryFromRelease(release);
    if (!catInfo) continue;
    
    // Only keep if this is the first (latest) release for this category
    // or if it has a higher version
    const existing = categoryMap[catInfo.name];
    if (!existing || compareVersions(catInfo.version, existing.version) > 0) {
      // Get metadata from the central metadata file if available
      const metaCat = metadata?.categories?.[catInfo.name];
      
      categoryMap[catInfo.name] = {
        name: catInfo.name,
        slug: catInfo.slug,
        version: catInfo.version,
        releaseTag: catInfo.releaseTag,
        releaseUrl: catInfo.releaseUrl,
        archiveNames: metaCat?.archives || catInfo.archiveNames,
        songCount: metaCat?.songCount || catInfo.songCount,
        totalSize: metaCat?.totalSize || catInfo.totalSize
      };
    }
  }

  return categoryMap;
}

// Get music library status
ipcMain.handle('get-music-library-status', async () => {
  const localMetadata = readLibraryMetadata();
  const availableCategories = await buildAvailableCategoriesMap();

  const status = {
    musicFolderPath: musicFolder,
    localMetadata: localMetadata || null,
    availableCategories: availableCategories,
    status: 'not-installed',
    aggregatedVersion: null,
    newOrUpdatedCategories: []
  };

  if (!localMetadata) {
    status.status = 'not-installed';
    return status;
  }

  // Check if any categories have updates or are missing
  const installedCats = localMetadata.installedCategories || {};
  const hasUpdates = Object.entries(installedCats).some(([catName, catData]) => {
    const available = availableCategories[catName];
    return available && available.version !== catData.version;
  });

  const missingNew = Object.keys(availableCategories).filter(catName => {
    const installed = installedCats[catName];
    return !installed || !installed.installed;
  });

  if (hasUpdates || missingNew.length > 0) {
    status.status = 'out-of-date';
    status.newOrUpdatedCategories = missingNew;
  } else {
    status.status = 'up-to-date';
  }

  // Calculate aggregated version (highest version of installed categories)
  let maxVersion = '0.0';
  Object.values(installedCats).forEach(catData => {
    if (catData.installed && catData.version) {
      if (compareVersions(catData.version, maxVersion) > 0) {
        maxVersion = catData.version;
      }
    }
  });

  status.aggregatedVersion = maxVersion !== '0.0' ? maxVersion : null;
  return status;
});

// Download and extract library categories
ipcMain.handle('download-library-categories', async (event, options) => {
  const { categories, targetFolder } = options;

  if (!categories || !Array.isArray(categories) || categories.length === 0) {
    return { success: false, error: 'No categories specified' };
  }

  if (!targetFolder) {
    return { success: false, error: 'No target folder specified' };
  }

  try {
    // Ensure target folder exists
    if (!fs.existsSync(targetFolder)) {
      fs.mkdirSync(targetFolder, { recursive: true });
    }

    // Fetch available categories
    const availableCategories = await buildAvailableCategoriesMap();

    // Read current metadata
    const currentMetadata = readLibraryMetadata() || {
      musicFolderPath: targetFolder,
      lastUpdated: new Date().toISOString(),
      installedCategories: {}
    };

    // Download and extract each category
    for (const categoryName of categories) {
      const categoryInfo = availableCategories[categoryName];
      if (!categoryInfo) {
        console.warn(`Category ${categoryName} not found in available releases`);
        continue;
      }

      event.sender.send('music-download-progress', {
        category: categoryName,
        status: 'downloading',
        percent: 0
      });

      // Download all archive parts for this category
      const archiveNames = categoryInfo.archiveNames || [];
      if (archiveNames.length === 0) {
        console.warn(`No archive names for category ${categoryName}`);
        continue;
      }

      // Prepare extraction path
      const extractPath = path.join(targetFolder, categoryName);
      if (!fs.existsSync(extractPath)) {
        fs.mkdirSync(extractPath, { recursive: true });
      }

      // Check if this is a split archive (.zip.001, .zip.002, etc.)
      const isSplitArchive = archiveNames.some(name => /\.zip\.\d{3}$/.test(name));
      const downloadedParts = [];

      // Download each part
      for (let i = 0; i < archiveNames.length; i++) {
        const archiveName = archiveNames[i];
        const tempPath = path.join(os.tmpdir(), `ambience-${categoryName}-part${i}${isSplitArchive ? '.part' : '.zip'}`);

        const downloadSuccess = await downloadGitHubAsset(
          categoryInfo.releaseTag,
          archiveName,
          tempPath,
          (percent) => {
            // Calculate overall progress across all parts
            const partProgress = (i + percent / 100) / archiveNames.length * 100;
            event.sender.send('music-download-progress', {
              category: categoryName,
              status: 'downloading',
              percent: Math.floor(partProgress)
            });
          }
        );

        if (!downloadSuccess) {
          // Clean up any downloaded parts
          downloadedParts.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
          return { success: false, error: `Failed to download ${archiveName}` };
        }

        downloadedParts.push(tempPath);
      }

      // Combine parts if split archive, then extract
      event.sender.send('music-download-progress', {
        category: categoryName,
        status: 'extracting',
        percent: 0
      });

      let finalZipPath;
      if (isSplitArchive && downloadedParts.length > 1) {
        // Combine split parts into single zip
        finalZipPath = path.join(os.tmpdir(), `ambience-${categoryName}-combined.zip`);
        const combineSuccess = await combineSplitArchive(downloadedParts, finalZipPath);
        
        // Clean up parts
        downloadedParts.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
        
        if (!combineSuccess) {
          return { success: false, error: `Failed to combine split archive for ${categoryName}` };
        }
      } else {
        // Single zip file
        finalZipPath = downloadedParts[0];
      }

      // Extract the archive
      const extractSuccess = await extractZip(finalZipPath, extractPath);
      
      // Clean up
      try { fs.unlinkSync(finalZipPath); } catch (e) {}
      
      if (!extractSuccess) {
        return { success: false, error: `Failed to extract ${categoryName}` };
      }

      // Update metadata for this category
      currentMetadata.installedCategories[categoryName] = {
        version: categoryInfo.version,
        releaseTag: categoryInfo.releaseTag,
        installed: true,
        optedOut: false
      };

      event.sender.send('music-download-progress', {
        category: categoryName,
        status: 'complete',
        percent: 100
      });
    }

    // Track all available categories - mark unselected ones as opted out
    for (const [catName, catInfo] of Object.entries(availableCategories)) {
      if (!currentMetadata.installedCategories[catName]) {
        // Category exists but wasn't selected - mark as opted out
        currentMetadata.installedCategories[catName] = {
          version: catInfo.version,
          releaseTag: catInfo.releaseTag,
          installed: false,
          optedOut: true
        };
      }
    }

    // Write updated metadata
    currentMetadata.lastUpdated = new Date().toISOString();
    currentMetadata.musicFolderPath = targetFolder;
    writeLibraryMetadata(currentMetadata);

    // Notify main window to refresh music files
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('music-files-updated');
    }

    return { success: true, metadata: currentMetadata };
  } catch (e) {
    console.error('Download failed:', e);
    return { success: false, error: e.message };
  }
});

// Remove a library category (delete folder and update metadata)
ipcMain.handle('remove-library-category', async (event, categoryName) => {
  try {
    if (!categoryName) {
      return { success: false, error: 'No category specified' };
    }

    // Get the category folder path
    const categoryFolder = path.join(musicFolder, categoryName);
    
    // Delete the folder if it exists
    if (fs.existsSync(categoryFolder)) {
      fs.rmSync(categoryFolder, { recursive: true, force: true });
    }

    // Update metadata
    const currentMetadata = readLibraryMetadata();
    if (currentMetadata && currentMetadata.installedCategories) {
      if (currentMetadata.installedCategories[categoryName]) {
        // Mark as not installed but keep the entry for optedOut tracking
        currentMetadata.installedCategories[categoryName].installed = false;
        currentMetadata.installedCategories[categoryName].optedOut = true;
        currentMetadata.lastUpdated = new Date().toISOString();
        writeLibraryMetadata(currentMetadata);
      }
    }

    // Notify main window to refresh music files
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('music-files-updated');
    }

    return { success: true };
  } catch (e) {
    console.error('Failed to remove category:', e);
    return { success: false, error: e.message };
  }
});

// Helper: download GitHub release asset
function downloadGitHubAsset(releaseTag, assetName, outputPath, progressCallback) {
  return new Promise((resolve) => {
    // Use direct download URL format for GitHub releases
    const url = `https://github.com/${MUSIC_LIBRARY_REPO}/releases/download/${releaseTag}/${assetName}`;
    
    https.get(url, (res) => {
      // Handle redirects (GitHub always redirects release downloads)
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, (redirectRes) => {
          handleDownloadResponse(redirectRes, outputPath, progressCallback, resolve);
        }).on('error', () => resolve(false));
      } else {
        handleDownloadResponse(res, outputPath, progressCallback, resolve);
      }
    }).on('error', () => resolve(false));
  });
}

function handleDownloadResponse(res, outputPath, progressCallback, resolve) {
  const file = fs.createWriteStream(outputPath);
  const totalSize = parseInt(res.headers['content-length'], 10);
  let downloadedSize = 0;

  res.on('data', (chunk) => {
    downloadedSize += chunk.length;
    if (progressCallback && totalSize) {
      progressCallback((downloadedSize / totalSize) * 100);
    }
  });

  res.pipe(file);
  file.on('finish', () => {
    file.close();
    resolve(true);
  });
  file.on('error', () => {
    fs.unlink(outputPath, () => {});
    resolve(false);
  });
}

// Helper: combine split archive parts (.zip.001, .zip.002, etc.) into single .zip
function combineSplitArchive(partPaths, outputPath) {
  return new Promise((resolve) => {
    try {
      const writeStream = fs.createWriteStream(outputPath);
      let currentIndex = 0;

      function appendNextPart() {
        if (currentIndex >= partPaths.length) {
          writeStream.end();
          resolve(true);
          return;
        }

        const partPath = partPaths[currentIndex];
        const readStream = fs.createReadStream(partPath);
        
        readStream.on('end', () => {
          currentIndex++;
          appendNextPart();
        });
        
        readStream.on('error', (err) => {
          console.error('Error reading part:', err);
          writeStream.end();
          resolve(false);
        });

        readStream.pipe(writeStream, { end: false });
      }

      writeStream.on('error', (err) => {
        console.error('Error writing combined archive:', err);
        resolve(false);
      });

      appendNextPart();
    } catch (error) {
      console.error('Combine failed:', error);
      resolve(false);
    }
  });
}

// Helper: extract zip file using adm-zip (pure JavaScript, cross-platform)
function extractZip(zipPath, outputPath) {
  return new Promise((resolve) => {
    try {
      if (!fs.existsSync(zipPath)) {
        console.error('Zip file not found:', zipPath);
        resolve(false);
        return;
      }

      // Ensure output directory exists
      if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, { recursive: true });
      }

      const zip = new AdmZip(zipPath);
      zip.extractAllTo(outputPath, true); // true = overwrite
      resolve(true);
    } catch (error) {
      console.error('Extract failed:', error);
      resolve(false);
    }
  });
}


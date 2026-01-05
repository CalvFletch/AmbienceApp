const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execFile } = require('child_process');
const https = require('https');
const os = require('os');

const GITHUB_REPO = 'CalvFletch/AmbienceApp';
const CURRENT_VERSION = require('./package.json').version;

let mainWindow;
let devicesWindow;
let settingsWindow;
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
  const userDataPath = app.getPath('userData');
  const defaultMusicFolder = path.join(userDataPath, 'music');
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
    if (!fs.existsSync(musicFolder)) {
      fs.mkdirSync(musicFolder, { recursive: true });
    }

    const audioExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.mp4', '.webm', '.mkv'];
    const allAudioFiles = [];

    function findMusicFiles(currentPath, categoryParts = []) {
      try {
        const entries = fs.readdirSync(currentPath, { withFileTypes: true });

        let topLevelIconPath = null;
        if (categoryParts.length > 0) {
          const topLevelCategoryDir = path.join(musicFolder, categoryParts[0]);
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

    findMusicFiles(musicFolder);
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
        int unk1(); int unk2(); int unk3(); int unk4(); int unk5(); int unk6(); int unk7(); int unk8();
    }

    [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2 : IAudioSessionControl {
        new int unk1(); new int unk2(); new int unk3(); new int unk4(); new int unk5(); new int unk6(); new int unk7(); new int unk8();
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
            IMMDevice defDevice;
            enumerator.GetDefaultAudioEndpoint(0, 1, out defDevice);
            object mgrObj; Guid iid = IID_IAudioSessionManager2;
            defDevice.Activate(ref iid, 1, IntPtr.Zero, out mgrObj);
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
        return result;
    }

    static float CheckExeAudio(IMMDeviceEnumerator enumerator, HashSet<string> targetExes) {
        float maxPeak = 0;
        try {
            IMMDevice defDevice;
            enumerator.GetDefaultAudioEndpoint(0, 1, out defDevice);
            object mgrObj; Guid iid = IID_IAudioSessionManager2;
            defDevice.Activate(ref iid, 1, IntPtr.Zero, out mgrObj);
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
                    if (targetExes.Contains(exeName)) {
                        // Get meter for this session
                        object meterObj; Guid meterId = IID_IAudioMeterInformation;
                        try {
                            ((IMMDevice)defDevice).Activate(ref meterId, 1, IntPtr.Zero, out meterObj);
                            // Note: This gets device peak, not per-session. For true per-session we need IAudioMeterInformation from session
                            // But sessions don't directly expose meter. We check if process is in audio session as proxy.
                            var meter = meterObj as IAudioMeterInformation;
                            if (meter != null) {
                                float peak; meter.GetPeakValue(out peak);
                                if (peak > maxPeak) maxPeak = peak;
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
const AUDIO_CHECK_VERSION = '3';
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
      headers: { 'User-Agent': 'AmbienceApp' }
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
            releaseUrl: release.html_url || `https://github.com/${GITHUB_REPO}/releases`
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

// Fetch all music-lib-* releases from GitHub
function fetchMusicLibraryReleases() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/releases`,
      headers: { 'User-Agent': 'AmbienceApp' }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const releases = JSON.parse(data);
          // Filter for music-lib-* releases and sort by creation date descending
          const musicReleases = releases
            .filter(r => r.tag_name && r.tag_name.startsWith('music-lib-'))
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
          resolve(musicReleases);
        } catch (e) {
          console.error('Failed to parse releases:', e);
          resolve([]);
        }
      });
    }).on('error', (e) => {
      console.error('Failed to fetch releases:', e);
      resolve([]);
    });
  });
}

// Parse metadata from a release's music-lib-metadata.json asset
function extractMetadataFromRelease(release) {
  const metadataAsset = release.assets?.find(a => a.name === 'music-lib-metadata.json');
  if (!metadataAsset) return null;

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/releases/assets/${metadataAsset.id}`,
      headers: { 
        'User-Agent': 'AmbienceApp',
        'Accept': 'application/octet-stream'
      }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const metadata = JSON.parse(data);
          metadata.releaseTag = release.tag_name;
          metadata.releaseUrl = release.html_url;
          resolve(metadata);
        } catch (e) {
          console.error('Failed to parse release metadata:', e);
          resolve(null);
        }
      });
    }).on('error', (e) => {
      console.error('Failed to fetch release metadata:', e);
      resolve(null);
    });
  });
}

// Build available categories from all releases
async function buildAvailableCategoriesMap() {
  const releases = await fetchMusicLibraryReleases();
  if (releases.length === 0) return {};

  const categoryMap = {};
  // Process releases in reverse order (oldest first) so newer ones override
  for (const release of releases.reverse()) {
    const metadata = await extractMetadataFromRelease(release);
    if (metadata && metadata.categories) {
      for (const category of metadata.categories) {
        categoryMap[category.name] = {
          name: category.name,
          description: category.description || '',
          libraryVersion: metadata.libraryVersion,
          releaseTag: metadata.releaseTag,
          releaseUrl: metadata.releaseUrl,
          archiveNames: category.archiveNames || []
        };
      }
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
    return available && available.libraryVersion !== catData.libraryVersion;
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
    if (catData.installed && catData.libraryVersion) {
      if (compareVersions(catData.libraryVersion, maxVersion) > 0) {
        maxVersion = catData.libraryVersion;
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

      // Download and combine archives
      const extractPath = path.join(targetFolder, categoryName);
      if (!fs.existsSync(extractPath)) {
        fs.mkdirSync(extractPath, { recursive: true });
      }

      // Download each part
      for (let i = 0; i < archiveNames.length; i++) {
        const archiveName = archiveNames[i];
        const tempPath = path.join(os.tmpdir(), `ambience-${categoryName}-${i}.zip`);

        const downloadSuccess = await downloadGitHubAsset(
          categoryInfo.releaseTag,
          archiveName,
          tempPath,
          (percent) => {
            event.sender.send('music-download-progress', {
              category: categoryName,
              status: 'downloading',
              percent: Math.floor(percent)
            });
          }
        );

        if (!downloadSuccess) {
          return { success: false, error: `Failed to download ${archiveName}` };
        }

        // Extract archive
        event.sender.send('music-download-progress', {
          category: categoryName,
          status: 'extracting',
          percent: 0
        });

        const extractSuccess = await extractZip(tempPath, extractPath);
        if (!extractSuccess) {
          return { success: false, error: `Failed to extract ${archiveName}` };
        }

        // Clean up temp file
        try {
          fs.unlinkSync(tempPath);
        } catch (e) {}
      }

      // Update metadata for this category
      currentMetadata.installedCategories[categoryName] = {
        libraryVersion: categoryInfo.libraryVersion,
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

    // Write updated metadata
    currentMetadata.lastUpdated = new Date().toISOString();
    currentMetadata.musicFolderPath = targetFolder;
    writeLibraryMetadata(currentMetadata);

    return { success: true, metadata: currentMetadata };
  } catch (e) {
    console.error('Download failed:', e);
    return { success: false, error: e.message };
  }
});

// Helper: download GitHub release asset
function downloadGitHubAsset(releaseTag, assetName, outputPath, progressCallback) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/releases/download/${releaseTag}/${assetName}`,
      headers: { 'User-Agent': 'AmbienceApp' }
    };

    const file = fs.createWriteStream(outputPath);
    https.get(options, (res) => {
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
    }).on('error', () => {
      fs.unlink(outputPath, () => {});
      resolve(false);
    });
  });
}

// Helper: extract zip file (using system utilities)
function extractZip(zipPath, outputPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(zipPath)) {
      resolve(false);
      return;
    }

    // Use PowerShell on Windows
    const command = `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath}', '${outputPath}', $true)`;
    exec(`powershell -NoProfile -Command "${command}"`, { timeout: 30000 }, (error) => {
      if (error) {
        console.error('Extract failed:', error);
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}


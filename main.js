const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

let mainWindow;
let devicesWindow;
let musicFolder = null;
let configPath = null;

function initPaths() {
  // Default music folder: User's Music folder / Ambience
  const defaultMusicFolder = path.join(app.getPath('music'), 'Ambience');
  musicFolder = defaultMusicFolder;

  // Config stored in app user data folder (persists across updates)
  configPath = path.join(app.getPath('userData'), 'config.json');

  // Load saved config
  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.musicFolder && fs.existsSync(config.musicFolder)) {
        musicFolder = config.musicFolder;
      }
    }
  } catch (e) {
    console.error('Error loading config:', e);
  }

  // Ensure the music folder exists
  if (!fs.existsSync(musicFolder)) {
    fs.mkdirSync(musicFolder, { recursive: true });
  }
}

function saveConfig(config = {}) {
  try {
    const currentConfig = loadConfigData();
    const newConfig = { ...currentConfig, ...config, musicFolder };
    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
  } catch (e) {
    console.error('Error saving config:', e);
  }
}

function loadConfigData() {
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading config data:', e);
  }
  return {};
}

function getAppPath(filename) {
  // In production, __dirname is inside asar, but loadFile and preload still work
  // However, we need to use app.getAppPath() for consistency
  if (app.isPackaged) {
    return path.join(app.getAppPath(), filename);
  }
  return path.join(__dirname, filename);
}

function createDevicesWindow() {
  if (devicesWindow) {
    devicesWindow.focus();
    return;
  }

  const [x, y] = mainWindow.getPosition();
  const [width, height] = mainWindow.getSize();

  devicesWindow = new BrowserWindow({
    width: 320,
    height: 400,
    x: x + width - 320 - 16,
    y: y - 100,
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

  // Close when main window moves or loses focus
  devicesWindow.on('blur', () => {
    if (devicesWindow) {
      devicesWindow.close();
    }
  });
}

function createWindow() {
  const config = loadConfigData();

  // Default window bounds
  const defaultBounds = {
    width: 700,
    height: 300,
    x: undefined,
    y: undefined
  };

  // Use saved bounds if available
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

  // Save window position/size on move or resize
  const saveBounds = () => {
    if (!mainWindow.isMinimized() && !mainWindow.isMaximized()) {
      const bounds = mainWindow.getBounds();
      saveConfig({ windowBounds: bounds });
    }
  };

  mainWindow.on('moved', saveBounds);
  mainWindow.on('resized', saveBounds);
}

app.whenReady().then(() => {
  initPaths();

  // Apply startup setting
  const config = loadConfigData();
  if (config.startOnBoot !== undefined) {
    app.setLoginItemSettings({
      openAtLogin: config.startOnBoot,
      path: app.getPath('exe')
    });
  }

  // Pre-compile audio check helper
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

// IPC Handlers
ipcMain.on('open-devices-window', createDevicesWindow);

ipcMain.on('close-devices-window', () => {
    if(devicesWindow) {
        devicesWindow.close();
    }
});

ipcMain.handle('get-initial-devices-state', async () => {
  const config = loadConfigData();
  const selectedDevices = config.duckDevices || [];

  // Use the same C# helper we already compile - run with --list flag
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
  // Forward the update to the main window
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

// Get list of all running processes
ipcMain.handle('get-running-processes', async () => {
  return new Promise((resolve) => {
    exec('wmic process get name /format:list', { timeout: 5000 }, (error, stdout) => {
      if (error) {
        console.error('Error getting processes:', error);
        resolve([]);
        return;
      }
      const seen = new Set();
      const processes = [];
      const lines = stdout.split('\n');
      for (const line of lines) {
        const match = line.match(/^Name=(.+\.exe)$/i);
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
});

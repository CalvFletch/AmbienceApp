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
      preload: path.join(__dirname, 'devices-preload.js')
    }
  });

  devicesWindow.loadFile('devices.html');

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
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('index.html');

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
  
  const allDevices = await new Promise((resolve) => {
    exec('powershell -Command "Get-AudioDevice -List | Where-Object { $_.Type -eq \'Playback\' } | Select-Object -ExpandProperty Name"', (error, stdout) => {
      if (error) {
        console.error('Error getting audio devices:', error);
        resolve([]);
        return;
      }
      const devices = stdout.trim().split('\n').filter(d => d.trim());
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
        int Unk();
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

    static readonly Guid IID_IAudioMeterInformation = new Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064");
    static readonly PROPERTYKEY PKEY_Device_FriendlyName = new PROPERTYKEY {
        fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14
    };

    static void Main(string[] args) {
        try {
            string targetDevice = args.Length > 0 ? args[0] : "";
            var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());

            IMMDeviceCollection devices;
            enumerator.EnumAudioEndpoints(0, 1, out devices); // eRender, DEVICE_STATE_ACTIVE

            int count;
            devices.GetCount(out count);

            for (int i = 0; i < count; i++) {
                IMMDevice device;
                devices.Item(i, out device);

                IPropertyStore props;
                device.OpenPropertyStore(0, out props);

                PROPVARIANT name;
                PROPERTYKEY key = PKEY_Device_FriendlyName;
                props.GetValue(ref key, out name);
                string deviceName = Marshal.PtrToStringUni(name.p1);

                if (string.IsNullOrEmpty(targetDevice) || deviceName.Contains(targetDevice)) {
                    object meterObj;
                    Guid iid = IID_IAudioMeterInformation;
                    device.Activate(ref iid, 1, IntPtr.Zero, out meterObj);
                    var meter = (IAudioMeterInformation)meterObj;

                    float peak;
                    meter.GetPeakValue(out peak);
                    Console.WriteLine(peak);
                    return;
                }
            }
            Console.WriteLine("-1");
        } catch (Exception ex) {
            Console.WriteLine("-99");
        }
    }
}
`;

// Write and compile the C# helper on first run
let audioCheckReady = false;

function ensureAudioCheck() {
  if (audioCheckReady) return Promise.resolve(true);

  const { csPath, exePath } = getAudioCheckPaths();

  return new Promise((resolve) => {
    // Check if exe already exists
    if (fs.existsSync(exePath)) {
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
      audioCheckReady = true;
      resolve(true);
    });
  });
}

ipcMain.handle('check-audio-activity', async (event, deviceName) => {
  if (!deviceName) {
    return false;
  }

  // Make sure exe is ready
  const ready = await ensureAudioCheck();
  if (!ready) {
    return false;
  }

  const { exePath } = getAudioCheckPaths();

  return new Promise((resolve) => {
    exec(`"${exePath}" "${deviceName}"`, { timeout: 2000 }, (error, stdout, stderr) => {
      if (error) {
        console.error('Audio check error:', error.message);
        resolve(false);
        return;
      }

      const result = stdout.trim();
      const peakValue = parseFloat(result);

      if (!isNaN(peakValue) && peakValue >= 0) {
        const isPlaying = peakValue > 0.0001;
        // console.log(`Peak: ${peakValue.toFixed(4)}, Playing: ${isPlaying}`);
        resolve(isPlaying);
      } else {
        // console.log(`Audio check result: "${result}"`);
        resolve(false);
      }
    });
  });
});

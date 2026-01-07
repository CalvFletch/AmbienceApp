// Settings Window Script
// DOM Elements - Main Page
const folderPathInput = document.getElementById('folderPathInput');
const openFolderBtn = document.getElementById('openFolderBtn');
const saveAllBtn = document.getElementById('saveAllBtn');
const folderError = document.getElementById('folderError');
const duckModeDeviceBtn = document.getElementById('duckModeDevice');
const duckModeExeBtn = document.getElementById('duckModeExe');
const deviceDuckSettings = document.getElementById('deviceDuckSettings');
const exeDuckSettings = document.getElementById('exeDuckSettings');
const selectDevicesBtn = document.getElementById('selectDevicesBtn');
const selectProgramsBtn = document.getElementById('selectProgramsBtn');
const deviceCount = document.getElementById('deviceCount');
const programCount = document.getElementById('programCount');
const startOnBootCheckbox = document.getElementById('startOnBootCheckbox');
const updateMusicBtn = document.getElementById('updateMusicBtn');
const musicBtnText = document.getElementById('musicBtnText');
const closeBtn = document.getElementById('closeBtn');
const backBtn = document.getElementById('backBtn');
const headerTitle = document.getElementById('headerTitle');

// Pages
const mainPage = document.getElementById('mainPage');
const devicesPage = document.getElementById('devicesPage');
const programsPage = document.getElementById('programsPage');
const libraryPage = document.getElementById('libraryPage');

// Device page elements
const deviceList = document.getElementById('deviceList');

// Program page elements
const availableSearch = document.getElementById('availableSearch');
const selectedSearch = document.getElementById('selectedSearch');
const availableList = document.getElementById('availableList');
const selectedList = document.getElementById('selectedList');
const browseExeBtn = document.getElementById('browseExeBtn');
const availableLoading = document.getElementById('availableLoading');

// Icon caching and fetch control
const iconCache = new Map();
const iconByPath = new Map();
const MAX_ICON_CONCURRENCY = 4;
let activeIconFetches = 0;
const iconFetchQueue = [];
const ENABLE_ICON_DEBUG = false;

// State
let duckMode = 'device';
let selectedDuckDevices = [];
let selectedDuckExes = [];
let cachedDevices = [];
let allDevices = [];
let allProcesses = [];
let currentPage = 'main';
let processListListenerRegistered = false;
let isFetchingProcesses = false;

// Music library state
let musicLibraryStatus = null;
let selectedMusicCategories = [];
let isDownloadingLibrary = false;
let skipDeleteWarning = false;
let isRemovingCategory = false;

// Music library modal DOM
const musicLibraryModal = document.getElementById('musicLibraryModal');
const musicLibraryModalClose = document.getElementById('musicLibraryModalClose');
const musicLibraryModalCancel = document.getElementById('musicLibraryModalCancel');
const musicLibraryModalDownload = document.getElementById('musicLibraryModalDownload');
const categoriesCheckboxes = document.getElementById('categoriesCheckboxes');
const downloadProgressSection = document.getElementById('downloadProgressSection');
const downloadProgressText = document.getElementById('downloadProgressText');
const downloadProgressBar = document.getElementById('downloadProgressBar');

// Library page DOM
const libraryList = document.getElementById('libraryList');
const libraryDownloadBtn = document.getElementById('libraryDownloadBtn');
const libraryFooter = document.getElementById('libraryFooter');

// Delete confirmation modal DOM
const deleteConfirmModal = document.getElementById('deleteConfirmModal');
const deleteConfirmClose = document.getElementById('deleteConfirmClose');
const deleteConfirmCancel = document.getElementById('deleteConfirmCancel');
const deleteConfirmYes = document.getElementById('deleteConfirmYes');
const deleteConfirmText = document.getElementById('deleteConfirmText');
const deleteConfirmDontAsk = document.getElementById('deleteConfirmDontAsk');

// Prevent initial slide animation on first paint; re-enable on next frame
document.body.classList.add('no-anim');
requestAnimationFrame(() => {
  document.body.classList.remove('no-anim');
});

// Attach event listeners immediately so buttons work while async init runs
setupEventListeners();

async function init() {
  const state = await window.electronAPI.getInitialState();

  folderPathInput.value = state.musicFolder || './music';
  duckMode = state.duckMode || 'device';
  selectedDuckDevices = state.duckDevices || [];
  selectedDuckExes = state.duckExes || [];
  cachedDevices = state.cachedDevices || [];
  skipDeleteWarning = state.skipDeleteWarning || false;

  updateDuckModeUI();
  updateCounts();

  // Load startup setting
  const startOnBoot = await window.electronAPI.getStartOnBoot();
  startOnBootCheckbox.checked = startOnBoot;

  // Load music library status
  loadMusicLibraryStatus();
}

function setupEventListeners() {
  // Close button
  closeBtn.addEventListener('click', () => {
    window.electronAPI.closeWindow();
  });

  // Back button
  backBtn.addEventListener('click', () => {
    navigateToPage('main');
  });

  // Folder icon button - browse to select folder, or CTRL+click to open in explorer
  openFolderBtn.addEventListener('click', async (e) => {
    if (e.ctrlKey) {
      // CTRL+click: open folder in file explorer
      window.electronAPI.openMusicFolder();
    } else {
      // Normal click: browse to select a new folder
      const result = await window.electronAPI.selectMusicFolder();
      if (result) {
        folderPathInput.value = result;
        folderError.textContent = '';
        // Immediately preview the selected folder
        await window.electronAPI.previewMusicFolder(result);
      }
    }
  });

  // Save All button - saves all settings including folder path and closes window
  saveAllBtn.addEventListener('click', async () => {
    const path = folderPathInput.value.trim();
    if (!path) {
      folderError.textContent = 'PLEASE ENTER A FOLDER PATH';
      return;
    }

    const result = await window.electronAPI.saveMusicFolder(path);
    if (result.success) {
      folderError.textContent = '';
      // Save other settings too
      saveSettings();
      // Close the window after saving
      window.electronAPI.closeWindow();
    } else {
      folderError.textContent = result.error;
    }
  });

  // Debounce timer for folder path changes
  let folderCheckTimeout = null;
  
  // Check folder and update music when path changes
  folderPathInput.addEventListener('input', async () => {
    folderError.textContent = '';
    
    // Debounce: wait 500ms after user stops typing
    if (folderCheckTimeout) {
      clearTimeout(folderCheckTimeout);
    }
    
    folderCheckTimeout = setTimeout(async () => {
      const path = folderPathInput.value.trim();
      if (path) {
        // Validate and update music immediately (without saving to config)
        const result = await window.electronAPI.previewMusicFolder(path);
        if (result.success) {
          folderError.textContent = '';
        } else {
          folderError.textContent = result.error;
        }
      }
    }, 500);
  });

  // Duck mode toggle
  duckModeDeviceBtn.addEventListener('click', () => {
    duckMode = 'device';
    updateDuckModeUI();
    saveSettings();
  });

  duckModeExeBtn.addEventListener('click', () => {
    duckMode = 'exe';
    updateDuckModeUI();
    saveSettings();
  });

  // Select Devices button
  selectDevicesBtn.addEventListener('click', () => {
    navigateToPage('devices');
    loadDevices();
  });

  // Select Programs button
  selectProgramsBtn.addEventListener('click', () => {
    iconCache.clear();
    iconByPath.clear();
    navigateToPage('programs');
    ensureProcessListListener();
    loadPrograms();
  });

  // Startup toggle
  startOnBootCheckbox.addEventListener('change', async (e) => {
    await window.electronAPI.setStartOnBoot(e.target.checked);
  });

  // Check for updates button
  const checkUpdatesBtn = document.getElementById('checkUpdatesBtn');
  let updateAvailable = false;
  let updateUrl = '';

  checkUpdatesBtn.addEventListener('click', async () => {
    const btnText = checkUpdatesBtn.querySelector('span');

    // If update already found, open releases page
    if (updateAvailable && updateUrl) {
      window.electronAPI.openExternalUrl(updateUrl);
      return;
    }

    const originalText = btnText.textContent;
    btnText.textContent = 'Checking...';
    checkUpdatesBtn.disabled = true;

    try {
      const result = await window.electronAPI.checkForUpdates();
      if (result.hasUpdate) {
        updateAvailable = true;
        updateUrl = result.releaseUrl || `https://github.com/CalvFletch/AmbienceApp/releases/tag/v${result.latestVersion}`;
        btnText.textContent = `Download v${result.latestVersion}`;
        checkUpdatesBtn.disabled = false;
        // Don't reset - keep showing download link
        return;
      } else {
        btnText.textContent = 'Up to date!';
      }
    } catch (e) {
      btnText.textContent = 'Check failed';
    }

    setTimeout(() => {
      btnText.textContent = originalText;
      checkUpdatesBtn.disabled = false;
    }, 3000);
  });

  // Browse for exe
  browseExeBtn.addEventListener('click', async () => {
    const exeName = await window.electronAPI.browseForExe();
    if (exeName && !selectedDuckExes.includes(exeName)) {
      selectedDuckExes.push(exeName);
      renderProgramLists();
      updateCounts();
      saveSettings();
    }
  });

  // Search filters
  availableSearch.addEventListener('input', () => renderProgramLists());
  selectedSearch.addEventListener('input', () => renderProgramLists());

  // Music library button - navigate to library page
  updateMusicBtn.addEventListener('click', async () => {
    await loadMusicLibraryStatus();
    renderLibraryPage();
    navigateToPage('library');
  });

  // Music library modal (keep for backwards compat, but prefer page)
  if (musicLibraryModalClose) {
    musicLibraryModalClose.addEventListener('click', () => {
      closeMusicLibraryModal();
    });
  }

  if (musicLibraryModalCancel) {
    musicLibraryModalCancel.addEventListener('click', () => {
      closeMusicLibraryModal();
    });
  }

  if (musicLibraryModalDownload) {
    musicLibraryModalDownload.addEventListener('click', async () => {
      await downloadSelectedCategories();
    });
  }

  // Library page download button
  if (libraryDownloadBtn) {
    libraryDownloadBtn.addEventListener('click', async () => {
      await downloadSelectedCategories();
    });
  }

  // Listen for music download progress
  window.electronAPI.onMusicDownloadProgress((progressData) => {
    handleMusicDownloadProgress(progressData);
  });

  // Listen for request to open library page directly
  window.electronAPI.onOpenLibraryModal(async () => {
    await loadMusicLibraryStatus();
    renderLibraryPage();
    navigateToPage('library');
  });
}


function navigateToPage(page) {
  currentPage = page;

  const settingsFooter = document.getElementById('settingsFooter');

  // Update header
  if (page === 'main') {
    headerTitle.textContent = 'Settings';
    backBtn.style.display = 'none';
    closeBtn.style.display = 'block';
    mainPage.classList.remove('slide-left');
    devicesPage.classList.add('hidden');
    programsPage.classList.add('hidden');
    if (libraryPage) libraryPage.classList.add('hidden');
    settingsFooter.style.display = 'flex';
  } else if (page === 'devices') {
    headerTitle.textContent = 'Select Devices';
    backBtn.style.display = 'block';
    closeBtn.style.display = 'none';
    mainPage.classList.add('slide-left');
    devicesPage.classList.remove('hidden');
    programsPage.classList.add('hidden');
    if (libraryPage) libraryPage.classList.add('hidden');
    settingsFooter.style.display = 'none';
  } else if (page === 'programs') {
    headerTitle.textContent = 'Select Programs';
    backBtn.style.display = 'block';
    closeBtn.style.display = 'none';
    mainPage.classList.add('slide-left');
    devicesPage.classList.add('hidden');
    programsPage.classList.remove('hidden');
    if (libraryPage) libraryPage.classList.add('hidden');
    settingsFooter.style.display = 'none';
  } else if (page === 'library') {
    headerTitle.textContent = 'Music Library';
    backBtn.style.display = 'block';
    closeBtn.style.display = 'none';
    mainPage.classList.add('slide-left');
    devicesPage.classList.add('hidden');
    programsPage.classList.add('hidden');
    if (libraryPage) libraryPage.classList.remove('hidden');
    settingsFooter.style.display = 'none';
  }
}

function updateDuckModeUI() {
  if (duckMode === 'device') {
    duckModeDeviceBtn.classList.add('active');
    duckModeExeBtn.classList.remove('active');
    deviceDuckSettings.classList.remove('hidden');
    exeDuckSettings.classList.add('hidden');
  } else {
    duckModeDeviceBtn.classList.remove('active');
    duckModeExeBtn.classList.add('active');
    deviceDuckSettings.classList.add('hidden');
    exeDuckSettings.classList.remove('hidden');
  }
}

function updateCounts() {
  deviceCount.textContent = `${selectedDuckDevices.length} selected`;
  programCount.textContent = `${selectedDuckExes.length} selected`;
}

// === Device Selection ===
async function loadDevices() {
  // Show cached devices immediately
  if (cachedDevices.length > 0) {
    allDevices = cachedDevices;
    renderDeviceList();
  } else {
    deviceList.innerHTML = '<div class="loading">Loading devices...</div>';
  }

  // Fetch fresh devices
  const result = await window.electronAPI.getAudioDevices();
  if (result.devices && result.devices.length > 0) {
    allDevices = result.devices;
    cachedDevices = result.devices;
    renderDeviceList();
  } else if (cachedDevices.length === 0) {
    deviceList.innerHTML = '<div class="empty-message">No audio devices found</div>';
  }
}

function renderDeviceList() {
  deviceList.innerHTML = '';

  allDevices.forEach(device => {
    const isSelected = selectedDuckDevices.includes(device);
    const item = document.createElement('div');
    item.className = 'device-item' + (isSelected ? ' selected' : '');
    item.innerHTML = `
      <div class="checkbox-icon">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
        </svg>
      </div>
      <span class="device-name">${device}</span>
    `;
    item.addEventListener('click', () => {
      toggleDevice(device);
    });
    deviceList.appendChild(item);
  });
}

function toggleDevice(device) {
  const index = selectedDuckDevices.indexOf(device);
  if (index >= 0) {
    selectedDuckDevices.splice(index, 1);
  } else {
    selectedDuckDevices.push(device);
  }
  renderDeviceList();
  updateCounts();
  saveSettings();
}

// === Program Selection ===
async function loadPrograms() {
  // If we already have processes loaded, just render (window persists)
  if (allProcesses.length > 0) {
    setAvailableLoading(false);
    renderProgramLists();
    return;
  }

  // Show loading in available list
  availableList.innerHTML = '<div class="loading">Loading processes...</div>';
  isFetchingProcesses = true;
  setAvailableLoading(true);

  // Fetch running processes (returns plain array)
  const processes = await window.electronAPI.getRunningProcesses();
  allProcesses = Array.isArray(processes) ? processes : [];
  isFetchingProcesses = false;
  setAvailableLoading(false);
  renderProgramLists();
}

function ensureProcessListListener() {
  if (processListListenerRegistered) return;
  processListListenerRegistered = true;
  window.electronAPI.onProcessListUpdated((processes) => {
    isFetchingProcesses = false;
    setAvailableLoading(false);
    allProcesses = processes || [];
    renderProgramLists();
  });
}

function renderProgramLists() {
  const availableFilter = availableSearch.value.toLowerCase();
  const selectedFilter = selectedSearch.value.toLowerCase();

  // Render available (left column) - processes not in selected list
  const available = allProcesses.filter(p => {
    if (selectedDuckExes.includes(p)) return false;
    if (availableFilter && !p.includes(availableFilter)) return false;
    return true;
  });

  availableList.innerHTML = '';
  if (allProcesses.length === 0) {
    setAvailableLoading(isFetchingProcesses);
    availableList.innerHTML = '<div class="loading">Loading...</div>';
  } else if (available.length === 0) {
    setAvailableLoading(false);
    availableList.innerHTML = '<div class="empty-message">No matching programs</div>';
  } else {
    setAvailableLoading(false);
    available.forEach(proc => {
      const item = createProgramItem(proc, 'add', true); // fetch icon for available list too
      availableList.appendChild(item);
    });
  }

  // Render selected (right column)
  const selected = selectedDuckExes.filter(p => {
    if (selectedFilter && !p.includes(selectedFilter)) return false;
    return true;
  });

  selectedList.innerHTML = '';
  if (selectedDuckExes.length === 0) {
    selectedList.innerHTML = '<div class="empty-message">No programs selected</div>';
  } else if (selected.length === 0) {
    selectedList.innerHTML = '<div class="empty-message">No matching programs</div>';
  } else {
    selected.forEach(proc => {
      const item = createProgramItem(proc, 'remove', true); // fetch icon only for selected items
      selectedList.appendChild(item);
    });
  }
}

function createProgramItem(proc, action, fetchIcon) {
  const item = document.createElement('div');
  item.className = 'program-item';

  // Create icon element
  const icon = document.createElement('img');
  icon.className = 'program-item-icon';
  icon.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'; // Fully transparent placeholder
  icon.alt = '';

  // Load actual icon async only when needed
  if (fetchIcon) {
    loadIconForProcess(proc, icon);
  }

  // Create name element
  const name = document.createElement('span');
  name.className = 'program-item-name';
  name.textContent = proc;

  // Create action icon
  const actionIcon = document.createElement('span');
  actionIcon.className = action === 'add' ? 'add-icon' : 'remove-icon';
  actionIcon.textContent = action === 'add' ? '+' : '×';

  item.appendChild(icon);
  item.appendChild(name);
  item.appendChild(actionIcon);

  item.addEventListener('click', () => {
    if (action === 'add') {
      addProgram(proc);
    } else {
      removeProgram(proc);
    }
  });

  return item;
}

async function loadIconForProcess(proc, imgElement) {
  logIcon('[icon] loadIconForProcess called for: ' + proc);
  
  // Check cache first
  if (iconCache.has(proc)) {
    const cached = iconCache.get(proc);
    if (cached?.path && cached?.dataUrl) {
      iconByPath.set(cached.path.toLowerCase(), cached);
    }
    logIcon('[icon] cache hit for ' + proc + ': ' + (cached?.dataUrl ? 'has data' : 'null'));
    if (cached?.dataUrl) {
      imgElement.src = cached.dataUrl;
    }
    return;
  }

  // Fetch icon
  logIcon('[icon] fetching icon for: ' + proc);
  try {
    const iconData = await scheduleIconFetch(() => window.electronAPI.getExeIcon(proc));
    logIcon('[icon] result for ' + proc + ': path=' + (iconData?.path || 'n/a') + ' source=' + (iconData?.source || 'n/a') + ' reason=' + (iconData?.reason || 'none') + ' hasData=' + (iconData?.dataUrl ? 'yes' : 'no'));

    const pathKey = iconData?.path ? iconData.path.toLowerCase() : null;
    if (iconData?.dataUrl && pathKey) {
      iconByPath.set(pathKey, iconData);
    } else if (!iconData?.dataUrl && pathKey && iconByPath.has(pathKey)) {
      const reused = iconByPath.get(pathKey);
      iconCache.set(proc, reused);
      imgElement.src = reused.dataUrl;
      return;
    }

    if (iconData?.dataUrl) {
      iconCache.set(proc, iconData);
      imgElement.src = iconData.dataUrl;
    }
  } catch (e) {
    logIcon('[icon] error for ' + proc + ': ' + e.message);
  }
}

function scheduleIconFetch(fn) {
  return new Promise((resolve, reject) => {
    iconFetchQueue.push({ fn, resolve, reject });
    runIconQueue();
  });
}

function runIconQueue() {
  if (activeIconFetches >= MAX_ICON_CONCURRENCY) return;
  const next = iconFetchQueue.shift();
  if (!next) return;
  activeIconFetches++;
  Promise.resolve()
    .then(next.fn)
    .then((res) => next.resolve(res))
    .catch((err) => next.reject(err))
    .finally(() => {
      activeIconFetches--;
      runIconQueue();
    });
}

function setAvailableLoading(isLoading) {
  if (!availableLoading) return;
  if (isLoading) {
    availableLoading.classList.remove('hidden');
  } else {
    availableLoading.classList.add('hidden');
  }
}

function logIcon(message) {
  if (ENABLE_ICON_DEBUG) {
    window.electronAPI.debugLog(message);
  }
}

function addProgram(proc) {
  if (!selectedDuckExes.includes(proc)) {
    selectedDuckExes.push(proc);
    renderProgramLists();
    updateCounts();
    saveSettings();
  }
}

function removeProgram(proc) {
  selectedDuckExes = selectedDuckExes.filter(p => p !== proc);
  renderProgramLists();
  updateCounts();
  saveSettings();
}

// === Settings Persistence ===
function saveSettings() {
  window.electronAPI.saveSettings({
    duckMode: duckMode,
    duckExes: selectedDuckExes,
    duckDevices: selectedDuckDevices
  });
}

// === Music Library Management ===

async function loadMusicLibraryStatus() {
  try {
    musicLibraryStatus = await window.electronAPI.getMusicLibraryStatus();
    updateMusicLibraryUI();
  } catch (e) {
    console.error('Failed to load music library status:', e);
  }
}

function updateMusicLibraryUI() {
  if (!musicLibraryStatus) return;

  // Update button text based on status
  let statusText = 'Library';
  
  // Count total new tracks available across all installed categories
  const libraryChanges = musicLibraryStatus.libraryChanges?.categories || {};
  let totalNewTracks = 0;
  
  for (const [catName, catInfo] of Object.entries(libraryChanges)) {
    if (catInfo.installed && catInfo.changes?.tracksToAdd > 0) {
      totalNewTracks += catInfo.changes.tracksToAdd;
    }
  }
  
  if (totalNewTracks > 0) {
    statusText = `Library (+${totalNewTracks} new)`;
  }
  // Removed "Library (New Available)" - user chose not to install those libs

  musicBtnText.textContent = statusText;
}

// Render the full-page library view
function renderLibraryPage() {
  if (!musicLibraryStatus || !libraryList) return;

  libraryList.innerHTML = '';
  selectedMusicCategories = [];

  // Use new libraryChanges format, fallback to old format
  const libraryChanges = musicLibraryStatus.libraryChanges?.categories || {};
  const installed = musicLibraryStatus.localMetadata?.installedCategories || {};

  // Helper to format size with sign
  const formatSizeDelta = (bytes) => {
    if (!bytes || bytes === 0) return '';
    const sign = bytes > 0 ? '+' : '';
    const absBytes = Math.abs(bytes);
    if (absBytes >= 1024 * 1024 * 1024) {
      return `${sign}${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
    } else {
      return `${sign}${Math.round(bytes / (1024 * 1024))}MB`;
    }
  };

  // Helper to format size (no sign)
  const formatSize = (bytes) => {
    if (!bytes) return '';
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
    } else {
      return `${Math.round(bytes / (1024 * 1024))}MB`;
    }
  };

  // Build change summary text like "+2 tracks -1 track (+50MB)"
  const formatChangeSummary = (changes) => {
    if (!changes) return '';
    const parts = [];
    if (changes.tracksToAdd > 0) {
      parts.push(`+${changes.tracksToAdd} track${changes.tracksToAdd !== 1 ? 's' : ''}`);
    }
    if (changes.tracksToRemove > 0) {
      parts.push(`-${changes.tracksToRemove} track${changes.tracksToRemove !== 1 ? 's' : ''}`);
    }
    if (changes.sizeDelta && changes.sizeDelta !== 0) {
      parts.push(`(${formatSizeDelta(changes.sizeDelta)})`);
    }
    return parts.join(' ');
  };

  if (Object.keys(libraryChanges).length === 0) {
    libraryList.innerHTML = '<div class="empty-message">No categories available</div>';
    updateLibraryDownloadButton();
    return;
  }

  // Check if there are any selectable items (need download)
  let hasSelectableItems = false;
  Object.entries(libraryChanges).forEach(([catName, catInfo]) => {
    const isInstalled = catInfo.installed;
    const hasNewTracks = catInfo.changes?.tracksToAdd > 0;
    if (!isInstalled || hasNewTracks) {
      hasSelectableItems = true;
    }
  });

  // Set up the Select All button in the HTML
  const librarySelectAll = document.getElementById('librarySelectAll');
  let selectAllElement = null;
  
  // Function to update Select All checkbox state based on individual selections
  const updateSelectAllState = () => {
    if (!selectAllElement) return;
    const allItems = libraryList.querySelectorAll('.library-item:not(.disabled)');
    const selectedItems = libraryList.querySelectorAll('.library-item:not(.disabled).selected');
    
    if (selectedItems.length === 0) {
      selectAllElement.classList.remove('selected');
    } else if (selectedItems.length === allItems.length) {
      selectAllElement.classList.add('selected');
    } else {
      selectAllElement.classList.remove('selected');
    }
  };

  if (librarySelectAll) {
    const newSelectAll = librarySelectAll.cloneNode(true);
    librarySelectAll.parentNode.replaceChild(newSelectAll, librarySelectAll);
    selectAllElement = newSelectAll;
    
    if (hasSelectableItems) {
      newSelectAll.classList.remove('disabled');
      newSelectAll.addEventListener('click', () => {
        const isSelected = newSelectAll.classList.toggle('selected');
        const allItems = libraryList.querySelectorAll('.library-item:not(.disabled)');
        allItems.forEach(item => {
          const catName = item.dataset.category;
          if (isSelected) {
            item.classList.add('selected');
            if (!selectedMusicCategories.includes(catName)) {
              selectedMusicCategories.push(catName);
            }
          } else {
            item.classList.remove('selected');
            selectedMusicCategories = selectedMusicCategories.filter(c => c !== catName);
          }
        });
        updateLibraryDownloadButton();
      });
    } else {
      newSelectAll.classList.add('disabled');
      newSelectAll.classList.remove('selected');
    }
  }

  // R2 URL base (icons are at {category}/icon.png)
  const r2BaseUrl = 'https://pub-8d3c3b52c11c464ba2e463fc91bbb7e7.r2.dev';

  Object.entries(libraryChanges).forEach(([catName, catInfo]) => {
    const isInstalled = catInfo.installed;
    const hasNewTracks = catInfo.changes?.tracksToAdd > 0;
    const hasRemovals = catInfo.changes?.tracksToRemove > 0;

    const item = document.createElement('div');
    item.className = 'library-item';
    item.dataset.category = catName;

    // If installed and no new tracks to download, mark as disabled (up to date)
    // Note: removals are handled silently, so only new tracks make it selectable
    if (isInstalled && !hasNewTracks) {
      item.classList.add('disabled');
      item.classList.add('selected');
    } else if (hasNewTracks && !catInfo.optedOut) {
      // Auto-select items with new tracks (unless user opted out / removed)
      item.classList.add('selected');
      selectedMusicCategories.push(catName);
    }

    // Checkbox icon
    const checkboxIcon = document.createElement('div');
    checkboxIcon.className = 'checkbox-icon';
    checkboxIcon.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;

    // Category icon from R2
    const categoryIcon = document.createElement('img');
    categoryIcon.className = 'library-item-icon';
    const iconUrl = catInfo.icon || `${r2BaseUrl}/${catInfo.slug}/icon.png`;
    categoryIcon.src = iconUrl;
    categoryIcon.alt = catName;
    categoryIcon.onerror = () => {
      console.warn('Icon failed to load:', iconUrl);
      categoryIcon.style.display = 'none';
    };

    // Info section
    const infoSection = document.createElement('div');
    infoSection.className = 'library-item-info';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'library-item-name';
    nameSpan.textContent = catName;

    // Add "Up to date" badge after name if installed with no changes
    if (isInstalled && !hasNewTracks && !hasRemovals) {
      const upToDateBadge = document.createElement('span');
      upToDateBadge.className = 'up-to-date-badge';
      upToDateBadge.textContent = 'Up to date';
      upToDateBadge.style.cssText = 'font-size: 9px; color: var(--text-dim); margin-left: 8px; font-weight: normal; letter-spacing: 0.5px;';
      nameSpan.appendChild(upToDateBadge);
    }

    infoSection.appendChild(nameSpan);

    // Track/size info (always shown)
    const changeSpan = document.createElement('span');
    changeSpan.className = 'library-item-version';
    
    if (!isInstalled) {
      // Not installed - show total size to download
      changeSpan.textContent = `${catInfo.trackCount} tracks (${formatSize(catInfo.totalSize)})`;
    } else if (hasNewTracks || hasRemovals) {
      // Has changes - show summary
      changeSpan.classList.add('update-available');
      changeSpan.textContent = formatChangeSummary(catInfo.changes);
    } else {
      // Up to date - still show track count and size
      changeSpan.textContent = `${catInfo.trackCount} tracks (${formatSize(catInfo.totalSize)})`;
      changeSpan.style.color = 'var(--text-dim)';
    }

    item.appendChild(checkboxIcon);
    item.appendChild(categoryIcon);
    item.appendChild(infoSection);
    item.appendChild(changeSpan);

    // Remove button for installed categories
    if (isInstalled) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-btn';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove this library';
      removeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await confirmAndRemoveCategory(catName, catInfo, item);
      });
      item.appendChild(removeBtn);
    }

    // Click handler for selection (only if not disabled - needs download)
    if (!isInstalled || hasNewTracks) {
      item.addEventListener('click', () => {
        const isSelected = item.classList.toggle('selected');
        if (isSelected) {
          if (!selectedMusicCategories.includes(catName)) {
            selectedMusicCategories.push(catName);
          }
        } else {
          selectedMusicCategories = selectedMusicCategories.filter(c => c !== catName);
        }
        updateSelectAllState();
        updateLibraryDownloadButton();
      });
    }

    libraryList.appendChild(item);
  });

  updateSelectAllState();
  updateLibraryDownloadButton();
  if (downloadProgressSection) downloadProgressSection.classList.add('hidden');
}

function updateLibraryDownloadButton() {
  if (!libraryDownloadBtn) return;
  libraryDownloadBtn.disabled = selectedMusicCategories.length === 0 || isDownloadingLibrary;
  libraryDownloadBtn.textContent = selectedMusicCategories.length > 0
    ? `Download (${selectedMusicCategories.length})`
    : 'Download Selected';
}

function showMusicLibraryModal() {
  if (!musicLibraryStatus) return;

  // Build category checkboxes with new format
  if (categoriesCheckboxes) categoriesCheckboxes.innerHTML = '';
  selectedMusicCategories = [];

  const categories = musicLibraryStatus.libraryChanges?.categories || {};

  // Helper to format size
  const formatSize = (bytes) => {
    if (!bytes) return '';
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
    } else {
      return `${Math.round(bytes / (1024 * 1024))}MB`;
    }
  };

  // Helper to format size with sign
  const formatSizeDelta = (bytes) => {
    if (!bytes || bytes === 0) return '';
    const sign = bytes > 0 ? '+' : '';
    const absBytes = Math.abs(bytes);
    if (absBytes >= 1024 * 1024 * 1024) {
      return `${sign}${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
    } else {
      return `${sign}${Math.round(bytes / (1024 * 1024))}MB`;
    }
  };

  // Build change summary text
  const formatChangeSummary = (changes) => {
    if (!changes) return '';
    const parts = [];
    if (changes.tracksToAdd > 0) {
      parts.push(`+${changes.tracksToAdd} track${changes.tracksToAdd !== 1 ? 's' : ''}`);
    }
    if (changes.tracksToRemove > 0) {
      parts.push(`-${changes.tracksToRemove} track${changes.tracksToRemove !== 1 ? 's' : ''}`);
    }
    if (changes.sizeDelta && changes.sizeDelta !== 0) {
      parts.push(`(${formatSizeDelta(changes.sizeDelta)})`);
    }
    return parts.join(' ');
  };

  // Check if all categories are up to date (no new tracks to download)
  let hasActionableItems = false;
  Object.entries(categories).forEach(([catName, catInfo]) => {
    const isInstalled = catInfo.installed;
    const hasNewTracks = catInfo.changes?.tracksToAdd > 0;
    if (!isInstalled || hasNewTracks) {
      hasActionableItems = true;
    }
  });

  // Select All area - show checkbox or "all up to date" message
  const selectAllCheckbox = document.getElementById('selectAllCategories');
  const selectAllLabel = document.querySelector('label[for="selectAllCategories"]');
  const selectAllText = selectAllLabel ? selectAllLabel.querySelector('span') : null;
  
  if (!hasActionableItems) {
    // All up to date - hide checkbox, show message
    if (selectAllCheckbox) selectAllCheckbox.style.display = 'none';
    if (selectAllText) selectAllText.textContent = 'ALL LIBRARIES UP TO DATE';
    if (selectAllLabel) {
      selectAllLabel.style.color = 'var(--text-dim)';
      selectAllLabel.style.cursor = 'default';
    }
  } else {
    // Has items to download - show checkbox
    if (selectAllCheckbox) {
      selectAllCheckbox.style.display = '';
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
    }
    if (selectAllText) selectAllText.textContent = 'SELECT ALL';
    if (selectAllLabel) {
      selectAllLabel.style.color = '';
      selectAllLabel.style.cursor = 'pointer';
    }
    
    if (selectAllCheckbox) {
      selectAllCheckbox.addEventListener('change', (e) => {
        const allCheckboxes = categoriesCheckboxes.querySelectorAll('input[type="checkbox"]:not(:disabled)');
        allCheckboxes.forEach(cb => {
          cb.checked = e.target.checked;
          const catName = cb.value;
          if (e.target.checked) {
            if (!selectedMusicCategories.includes(catName)) {
              selectedMusicCategories.push(catName);
            }
          } else {
            selectedMusicCategories = selectedMusicCategories.filter(c => c !== catName);
          }
        });
        updateDownloadButton();
      });
    }
  }

  Object.entries(categories).forEach(([catName, catInfo]) => {
    const isInstalled = catInfo.installed;
    const hasNewTracks = catInfo.changes?.tracksToAdd > 0;

    const row = document.createElement('div');
    row.dataset.category = catName;
    row.style.cssText = 'display: flex; align-items: center; gap: 10px; font-size: 11px;';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = catName;
    input.style.cssText = 'cursor: pointer; width: 14px; height: 14px; flex-shrink: 0;';

    // State: installed & up to date (greyed), has new tracks (blue), new (normal), opted out (unchecked)
    if (isInstalled && !hasNewTracks) {
      // Installed & up to date - checked and greyed out
      input.disabled = true;
      input.checked = true;
      input.style.opacity = '0.5';
      input.style.cursor = 'default';
      row.style.opacity = '0.7';
    } else if (hasNewTracks && !catInfo.optedOut) {
      // New tracks available (and not opted out) - blue/highlighted
      input.checked = true;
      selectedMusicCategories.push(catName);
      row.style.color = '#6cb2eb';
    } else {
      // New category or opted out - normal unchecked
      input.checked = false;
    }

    input.addEventListener('change', (e) => {
      if (e.target.checked) {
        if (!selectedMusicCategories.includes(catName)) {
          selectedMusicCategories.push(catName);
        }
      } else {
        selectedMusicCategories = selectedMusicCategories.filter(c => c !== catName);
      }
      updateSelectAllState();
      updateDownloadButton();
    });

    // Category name and info
    const label = document.createElement('span');
    label.style.cssText = 'flex: 1; letter-spacing: 1px;';
    
    const sizeStr = catInfo.totalSize ? formatSize(catInfo.totalSize) : '';
    
    // Add "Up to date" after name if installed with no changes
    if (isInstalled && !hasNewTracks) {
      label.innerHTML = `${catName} <span style="font-size: 9px; color: var(--text-dim); margin-left: 6px;">Up to date</span>`;
    } else {
      label.textContent = catName;
    }

    // Track/size info (always shown)
    const changeSpan = document.createElement('span');
    changeSpan.style.cssText = 'font-size: 10px; letter-spacing: 1px;';
    
    if (!isInstalled) {
      // New - show total size and track count
      changeSpan.textContent = `${catInfo.trackCount} tracks (${sizeStr})`;
      changeSpan.style.color = 'var(--text-secondary)';
    } else if (hasNewTracks) {
      // Has changes
      changeSpan.innerHTML = `<span style="color: #e57373;">${formatChangeSummary(catInfo.changes)}</span>`;
    } else {
      // Up to date - still show track count and size
      changeSpan.textContent = `${catInfo.trackCount} tracks (${sizeStr})`;
      changeSpan.style.color = 'var(--text-dim)';
    }

    row.appendChild(input);
    row.appendChild(label);
    row.appendChild(changeSpan);

    // Add remove button for installed categories
    if (isInstalled) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-category-btn';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove this library';
      removeBtn.style.cssText = 'background: transparent; border: 1px solid rgba(255,100,100,0.3); color: rgba(255,100,100,0.6); width: 18px; height: 18px; font-size: 14px; line-height: 1; cursor: pointer; padding: 0; margin-left: 6px; transition: all 0.15s ease;';
      removeBtn.addEventListener('mouseenter', () => {
        removeBtn.style.borderColor = 'rgba(255,100,100,0.7)';
        removeBtn.style.color = 'rgba(255,100,100,1)';
      });
      removeBtn.addEventListener('mouseleave', () => {
        removeBtn.style.borderColor = 'rgba(255,100,100,0.3)';
        removeBtn.style.color = 'rgba(255,100,100,0.6)';
      });
      removeBtn.addEventListener('click', async (e) => {
        const btnToRemove = e.currentTarget;
        await confirmAndRemoveCategory(catName, catInfo, row, input, versionSpan, btnToRemove);
      });
      row.appendChild(removeBtn);
    }

    categoriesCheckboxes.appendChild(row);
  });

  function updateSelectAllState() {
    const allCheckboxes = categoriesCheckboxes.querySelectorAll('input[type="checkbox"]:not(:disabled)');
    const checkedCount = Array.from(allCheckboxes).filter(cb => cb.checked).length;
    selectAllCheckbox.checked = checkedCount === allCheckboxes.length && allCheckboxes.length > 0;
    selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < allCheckboxes.length;
  }

  if (hasActionableItems) {
    updateSelectAllState();
  }
  updateDownloadButton();
  downloadProgressSection.classList.add('hidden');
  musicLibraryModal.classList.remove('hidden');
}

function closeMusicLibraryModal() {
  if (musicLibraryModal) musicLibraryModal.classList.add('hidden');
  if (downloadProgressSection) downloadProgressSection.classList.add('hidden');
}

// Delete confirmation with "don't ask again" support
async function confirmAndRemoveCategory(catName, catInfo, rowEl) {
  // Prevent double-clicks
  if (isRemovingCategory) {
    console.log('Already removing a category, ignoring click');
    return;
  }
  
  const doRemove = async () => {
    isRemovingCategory = true;
    try {
      const result = await window.electronAPI.removeLibraryCategory(catName);
      if (result.success) {
        // Refresh status and rebuild the library page
        await loadMusicLibraryStatus();
        renderLibraryPage();
      } else {
        alert('Failed to remove: ' + result.error);
      }
    } finally {
      isRemovingCategory = false;
    }
  };

  // If user chose "don't ask again", skip the modal
  if (skipDeleteWarning) {
    await doRemove();
    return;
  }

  // Show custom confirmation modal
  deleteConfirmText.textContent = `Remove ${catName} library? This will delete the music files.`;
  deleteConfirmDontAsk.checked = false;
  
  // Reset custom checkbox visual state
  const dontAskRow = document.getElementById('deleteConfirmDontAskRow');
  if (dontAskRow) {
    dontAskRow.classList.remove('selected');
    const checkIcon = dontAskRow.querySelector('.checkbox-icon svg');
    if (checkIcon) checkIcon.style.opacity = '0';
  }
  
  deleteConfirmModal.classList.remove('hidden');

  // Create a promise that resolves when user makes a choice
  return new Promise((resolve) => {
    const onDontAskClick = () => {
      const isSelected = dontAskRow.classList.toggle('selected');
      deleteConfirmDontAsk.checked = isSelected;
      const checkIcon = dontAskRow.querySelector('.checkbox-icon svg');
      if (checkIcon) checkIcon.style.opacity = isSelected ? '1' : '0';
    };

    const cleanup = () => {
      deleteConfirmYes.removeEventListener('click', onConfirm);
      deleteConfirmCancel.removeEventListener('click', onCancel);
      deleteConfirmClose.removeEventListener('click', onCancel);
      if (dontAskRow) dontAskRow.removeEventListener('click', onDontAskClick);
      deleteConfirmModal.classList.add('hidden');
    };

    const onConfirm = async () => {
      if (deleteConfirmDontAsk.checked) {
        skipDeleteWarning = true;
        // Save the preference
        window.electronAPI.saveSettings({ skipDeleteWarning: true });
      }
      cleanup();
      await doRemove();
      resolve(true);
    };

    const onCancel = () => {
      cleanup();
      resolve(false);
    };

    deleteConfirmYes.addEventListener('click', onConfirm);
    deleteConfirmCancel.addEventListener('click', onCancel);
    deleteConfirmClose.addEventListener('click', onCancel);
    if (dontAskRow) dontAskRow.addEventListener('click', onDontAskClick);
  });
}

function updateDownloadButton() {
  if (musicLibraryModalDownload) {
    musicLibraryModalDownload.disabled = selectedMusicCategories.length === 0 || isDownloadingLibrary;
    musicLibraryModalDownload.textContent = selectedMusicCategories.length > 0
      ? `Download (${selectedMusicCategories.length})`
      : 'Download';
  }
  updateLibraryDownloadButton();
}

async function downloadSelectedCategories() {
  if (selectedMusicCategories.length === 0 || isDownloadingLibrary) return;

  isDownloadingLibrary = true;
  if (musicLibraryModalDownload) musicLibraryModalDownload.disabled = true;
  if (libraryDownloadBtn) libraryDownloadBtn.disabled = true;
  if (downloadProgressSection) downloadProgressSection.classList.remove('hidden');

  try {
    const targetFolder = musicLibraryStatus.musicFolderPath;
    const result = await window.electronAPI.downloadLibraryCategories({
      categories: selectedMusicCategories,
      targetFolder: targetFolder
    });

    if (result.success) {
      if (downloadProgressText) downloadProgressText.textContent = 'Download complete!';
      await new Promise(resolve => setTimeout(resolve, 1500));
      // Refresh the library page
      await loadMusicLibraryStatus();
      renderLibraryPage();
      if (downloadProgressSection) downloadProgressSection.classList.add('hidden');
    } else {
      if (downloadProgressText) downloadProgressText.textContent = `Error: ${result.error}`;
    }
  } catch (e) {
    console.error('Download failed:', e);
    if (downloadProgressText) downloadProgressText.textContent = `Error: ${e.message}`;
  } finally {
    isDownloadingLibrary = false;
    if (musicLibraryModalDownload) musicLibraryModalDownload.disabled = false;
    if (libraryDownloadBtn) libraryDownloadBtn.disabled = false;
  }
}

function handleMusicDownloadProgress(progressData) {
  const { category, status, percent } = progressData;

  let statusStr = '';
  if (status === 'downloading') {
    statusStr = `Downloading ${category}...`;
  } else if (status === 'extracting') {
    statusStr = `Extracting ${category}...`;
  } else if (status === 'complete') {
    statusStr = `${category} complete`;
  }

  if (downloadProgressText) downloadProgressText.textContent = statusStr;
  if (downloadProgressBar) downloadProgressBar.style.width = `${percent || 0}%`;
}

init();


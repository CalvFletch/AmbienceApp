// Settings Window Script
// DOM Elements - Main Page
const folderPathText = document.getElementById('folderPathText');
const openFolderBtn = document.getElementById('openFolderBtn');
const selectFolderBtn = document.getElementById('selectFolderBtn');
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

// Music library modal DOM
const musicLibraryModal = document.getElementById('musicLibraryModal');
const musicLibraryModalClose = document.getElementById('musicLibraryModalClose');
const musicLibraryModalCancel = document.getElementById('musicLibraryModalCancel');
const musicLibraryModalDownload = document.getElementById('musicLibraryModalDownload');
const musicFolderPathText = document.getElementById('musicFolderPathText');
const musicFolderChangeBtn = document.getElementById('musicFolderChangeBtn');
const musicFolderOpenBtn = document.getElementById('musicFolderOpenBtn');
const categoriesCheckboxes = document.getElementById('categoriesCheckboxes');
const libraryStatusText = document.getElementById('libraryStatusText');
const downloadProgressSection = document.getElementById('downloadProgressSection');
const downloadProgressText = document.getElementById('downloadProgressText');
const downloadProgressBar = document.getElementById('downloadProgressBar');

// Prevent initial slide animation on first paint; re-enable on next frame
document.body.classList.add('no-anim');
requestAnimationFrame(() => {
  document.body.classList.remove('no-anim');
});

// Attach event listeners immediately so buttons work while async init runs
setupEventListeners();

async function init() {
  const state = await window.electronAPI.getInitialState();

  folderPathText.textContent = state.musicFolder || './music';
  duckMode = state.duckMode || 'device';
  selectedDuckDevices = state.duckDevices || [];
  selectedDuckExes = state.duckExes || [];
  cachedDevices = state.cachedDevices || [];

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

  // Folder buttons
  openFolderBtn.addEventListener('click', () => {
    window.electronAPI.openMusicFolder();
  });

  selectFolderBtn.addEventListener('click', async () => {
    const newPath = await window.electronAPI.selectMusicFolder();
    if (newPath) {
      folderPathText.textContent = newPath;
    }
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

  // Music library button
  updateMusicBtn.addEventListener('click', () => {
    showMusicLibraryModal();
  });

  // Music library modal
  musicLibraryModalClose.addEventListener('click', () => {
    closeMusicLibraryModal();
  });

  musicLibraryModalCancel.addEventListener('click', () => {
    closeMusicLibraryModal();
  });

  musicLibraryModalDownload.addEventListener('click', async () => {
    await downloadSelectedCategories();
  });

  musicFolderOpenBtn.addEventListener('click', () => {
    window.electronAPI.openMusicFolder();
  });

  musicFolderChangeBtn.addEventListener('click', async () => {
    const newPath = await window.electronAPI.selectMusicFolder();
    if (newPath) {
      musicFolderPathText.textContent = newPath;
      // Reload status after folder change
      loadMusicLibraryStatus();
    }
  });

  // Listen for music download progress
  window.electronAPI.onMusicDownloadProgress((progressData) => {
    handleMusicDownloadProgress(progressData);
  });
}


function navigateToPage(page) {
  currentPage = page;

  // Update header
  if (page === 'main') {
    headerTitle.textContent = 'Settings';
    backBtn.style.display = 'none';
    mainPage.classList.remove('slide-left');
    devicesPage.classList.add('hidden');
    programsPage.classList.add('hidden');
  } else if (page === 'devices') {
    headerTitle.textContent = 'Select Devices';
    backBtn.style.display = 'block';
    mainPage.classList.add('slide-left');
    devicesPage.classList.remove('hidden');
    programsPage.classList.add('hidden');
  } else if (page === 'programs') {
    headerTitle.textContent = 'Select Programs';
    backBtn.style.display = 'block';
    mainPage.classList.add('slide-left');
    devicesPage.classList.add('hidden');
    programsPage.classList.remove('hidden');
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
  const statusText = musicLibraryStatus.status === 'not-installed'
    ? 'Install Music Library'
    : musicLibraryStatus.status === 'out-of-date'
    ? 'Update Available'
    : 'Check for Updates';

  musicBtnText.textContent = statusText;

  // Show aggregated version if installed
  if (musicLibraryStatus.aggregatedVersion) {
    const versionBadge = document.createElement('span');
    versionBadge.style.fontSize = '9px';
    versionBadge.style.color = 'var(--text-dim)';
    versionBadge.textContent = ` v${musicLibraryStatus.aggregatedVersion}`;
  }
}

function showMusicLibraryModal() {
  if (!musicLibraryStatus) return;

  // Populate modal
  musicFolderPathText.textContent = musicLibraryStatus.musicFolderPath || './music';

  // Show library status
  let statusDisplay = '';
  if (musicLibraryStatus.status === 'not-installed') {
    statusDisplay = 'No music library installed. Select categories below to begin.';
  } else if (musicLibraryStatus.status === 'out-of-date') {
    const newCount = musicLibraryStatus.newOrUpdatedCategories?.length || 0;
    statusDisplay = `Update available. ${newCount} new or updated categories.`;
  } else {
    statusDisplay = `Up to date - Version ${musicLibraryStatus.aggregatedVersion}`;
  }
  libraryStatusText.textContent = statusDisplay;

  // Build category checkboxes
  categoriesCheckboxes.innerHTML = '';
  selectedMusicCategories = [];

  const categories = musicLibraryStatus.availableCategories || {};
  const installed = musicLibraryStatus.localMetadata?.installedCategories || {};

  Object.entries(categories).forEach(([catName, catInfo]) => {
    const isInstalled = installed[catName]?.installed;
    const isNew = !isInstalled;
    const isUpdated = isInstalled && installed[catName].libraryVersion !== catInfo.libraryVersion;

    const checkbox = document.createElement('div');
    checkbox.className = 'category-checkbox';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = catName;
    // Pre-check if missing or updated
    input.checked = isNew || isUpdated;

    if (input.checked) {
      selectedMusicCategories.push(catName);
    }

    input.addEventListener('change', (e) => {
      if (e.target.checked) {
        if (!selectedMusicCategories.includes(catName)) {
          selectedMusicCategories.push(catName);
        }
      } else {
        selectedMusicCategories = selectedMusicCategories.filter(c => c !== catName);
      }
      updateDownloadButton();
    });

    const label = document.createElement('label');
    let labelText = catName;
    if (isNew) {
      labelText += ' (NEW)';
    } else if (isUpdated) {
      labelText += ' (UPDATE)';
    } else if (isInstalled) {
      labelText += ' (installed)';
    }
    label.textContent = labelText;

    const version = document.createElement('span');
    version.className = 'category-version';
    version.textContent = `v${catInfo.libraryVersion}`;

    checkbox.appendChild(input);
    checkbox.appendChild(label);
    checkbox.appendChild(version);
    categoriesCheckboxes.appendChild(checkbox);
  });

  updateDownloadButton();
  downloadProgressSection.classList.add('hidden');
  musicLibraryModal.classList.remove('hidden');
}

function closeMusicLibraryModal() {
  musicLibraryModal.classList.add('hidden');
  downloadProgressSection.classList.add('hidden');
}

function updateDownloadButton() {
  musicLibraryModalDownload.disabled = selectedMusicCategories.length === 0 || isDownloadingLibrary;
  musicLibraryModalDownload.textContent = selectedMusicCategories.length > 0
    ? `Download (${selectedMusicCategories.length})`
    : 'Download';
}

async function downloadSelectedCategories() {
  if (selectedMusicCategories.length === 0 || isDownloadingLibrary) return;

  isDownloadingLibrary = true;
  musicLibraryModalDownload.disabled = true;
  downloadProgressSection.classList.remove('hidden');

  try {
    const targetFolder = musicLibraryStatus.musicFolderPath;
    const result = await window.electronAPI.downloadLibraryCategories({
      categories: selectedMusicCategories,
      targetFolder: targetFolder
    });

    if (result.success) {
      downloadProgressText.textContent = 'Download complete!';
      await new Promise(resolve => setTimeout(resolve, 1500));
      closeMusicLibraryModal();
      await loadMusicLibraryStatus();
    } else {
      downloadProgressText.textContent = `Error: ${result.error}`;
    }
  } catch (e) {
    console.error('Download failed:', e);
    downloadProgressText.textContent = `Error: ${e.message}`;
  } finally {
    isDownloadingLibrary = false;
    musicLibraryModalDownload.disabled = false;
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

  downloadProgressText.textContent = statusStr;
  downloadProgressBar.style.width = `${percent || 0}%`;
}

init();


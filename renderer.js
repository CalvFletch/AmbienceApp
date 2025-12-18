// DOM Elements
const audioPlayer = document.getElementById('audioPlayer');
const bgVideo = document.getElementById('bgVideo');
const trackName = document.getElementById('trackName');
const trackSection = document.getElementById('trackSection');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const currentTimeEl = document.getElementById('currentTime');
const durationEl = document.getElementById('duration');
const playPauseBtn = document.getElementById('playPauseBtn');
const playIcon = document.getElementById('playIcon');
const pauseIcon = document.getElementById('pauseIcon');
const skipBtn = document.getElementById('skipBtn');
const jumpBtn = document.getElementById('jumpBtn');
const volumeBtn = document.getElementById('volumeBtn');
const volumePopup = document.getElementById('volumePopup');
const volumeSlider = document.getElementById('volumeSlider');
const minimizeBtn = document.getElementById('minimizeBtn');
const closeBtn = document.getElementById('closeBtn');
const duckBtn = document.getElementById('duckBtn');
const duckIconOn = document.getElementById('duckIconOn');
const duckIconOff = document.getElementById('duckIconOff');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const openFolderBtn = document.getElementById('openFolderBtn');
const selectFolderBtn = document.getElementById('selectFolderBtn');
const folderPathText = document.getElementById('folderPathText');
const selectDevicesBtn = document.getElementById('selectDevicesBtn');
const musicListPanel = document.getElementById('musicListPanel');
const musicList = document.getElementById('musicList');
const musicListBackBtn = document.getElementById('musicListBackBtn');
const musicListTitle = document.getElementById('musicListTitle');
const clickOverlay = document.getElementById('clickOverlay');
const currentCategoryIcon = document.getElementById('currentCategoryIcon');
const startOnBootCheckbox = document.getElementById('startOnBootCheckbox');

// State
let musicFiles = [];
let currentIndex = -1;
let isDucking = false;
let isManuallyPaused = false;
let targetVolume = 0.7;
let currentVolume = 0.7;
let fadeInterval = null;
let isVideoFile = false;
let duckingEnabled = false;
let selectedDuckDevices = [];
let duckCheckInterval = null;
let lastAudioDetectedTime = 0;
let wasPausedByDucking = false;
const DUCK_VOLUME = 0;
const DUCK_CHECK_INTERVAL = 200;
const DUCK_HOLD_TIME = 1500;

let activePlayer = audioPlayer;
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mkv'];

function animateTextSwitch(element, newText) {
    const oldText = element.textContent;
    const duration = 300;
    const stepTime = 25;
    const steps = duration / stepTime;
    const maxLength = Math.max(oldText.length, newText.length);
    let currentStep = 0;

    const interval = setInterval(() => {
        currentStep++;
        const progress = currentStep / steps;
        const switchPoint = Math.floor(progress * maxLength);

        let displayText = '';
        for (let i = 0; i < maxLength; i++) {
            if (i < switchPoint) {
                displayText += newText[i] || ' ';
            } else {
                displayText += oldText[i] || ' ';
            }
        }
        element.textContent = displayText.trim();

        if (currentStep >= steps) {
            clearInterval(interval);
            element.textContent = newText;
        }
    }, stepTime);
}

function startDucking() {
  if (isDucking) return;
  console.log('Ducking: audio detected');
  isDucking = true;
  const trackLabel = document.getElementById('trackLabel');
  animateTextSwitch(trackLabel, 'ON HOLD');
  const duckingOverlay = document.getElementById('ducking-overlay');
  duckingOverlay.style.transition = 'opacity 0.3s ease';
  document.body.classList.add('ducking-active');
  fadeVolume(DUCK_VOLUME, 300, () => {
    if (isDucking) {
      activePlayer.pause();
      wasPausedByDucking = true;
    }
  });
}

function stopDucking(fadeDuration = 15000) {
  if (!isDucking) return;
  console.log('Ducking: audio stopped, restoring');
  isDucking = false;
  const trackLabel = document.getElementById('trackLabel');
  animateTextSwitch(trackLabel, 'NOW PLAYING');
  const duckingOverlay = document.getElementById('ducking-overlay');
  duckingOverlay.style.transition = `opacity ${fadeDuration / 1000}s ease`;
  document.body.classList.remove('ducking-active');
  if (wasPausedByDucking && !isManuallyPaused) {
    activePlayer.play().catch(console.error);
  }
  wasPausedByDucking = false;
  fadeVolume(targetVolume, fadeDuration);
}

async function init() {
  setupEventListeners();
  await loadSettings();
  await loadMusicFolderPath();
  await loadStartupSetting();
  await loadMusicFromFolder();
  if (musicFiles.length > 0) {
    playRandomTrack();
  }
  if (duckingEnabled && selectedDuckDevices.length > 0) {
    startDuckingCheck();
  }
}

async function loadStartupSetting() {
  const enabled = await window.electronAPI.getStartOnBoot();
  startOnBootCheckbox.checked = enabled;
}

function startDuckingCheck() {
  if (duckCheckInterval) {
    clearInterval(duckCheckInterval);
  }
  console.log(`Starting duck check for devices: "${selectedDuckDevices.join(', ')}"`);
  duckCheckInterval = setInterval(async () => {
    if (!duckingEnabled || selectedDuckDevices.length === 0) {
      return;
    }
    let isAnyDevicePlaying = false;
    for (const device of selectedDuckDevices) {
        const isPlaying = await window.electronAPI.checkAudioActivity(device);
        if (isPlaying) {
            isAnyDevicePlaying = true;
            break;
        }
    }
    const now = Date.now();
    if (isAnyDevicePlaying) {
      lastAudioDetectedTime = now;
      startDucking();
    } else if (isDucking) {
      const timeSinceLastAudio = now - lastAudioDetectedTime;
      if (timeSinceLastAudio >= DUCK_HOLD_TIME) {
        stopDucking();
      }
    }
  }, DUCK_CHECK_INTERVAL);
}

function stopDuckingCheck() {
  if (duckCheckInterval) {
    clearInterval(duckCheckInterval);
    duckCheckInterval = null;
  }
}

async function loadSettings() {
  const settings = await window.electronAPI.loadSettings();
  if (settings.duckDevices && Array.isArray(settings.duckDevices)) {
    selectedDuckDevices = settings.duckDevices;
  }
  if (settings.volume !== undefined) {
    targetVolume = settings.volume;
    currentVolume = settings.volume;
    volumeSlider.value = settings.volume * 100;
  }
  if (settings.duckingEnabled) {
    duckingEnabled = settings.duckingEnabled;
    if (duckingEnabled) {
      duckIconOn.classList.remove('hidden');
      duckIconOff.classList.add('hidden');
    }
  }
}

async function saveCurrentSettings() {
  await window.electronAPI.saveSettings({
    duckDevices: selectedDuckDevices,
    volume: targetVolume,
    duckingEnabled: duckingEnabled
  });
}

async function loadMusicFolderPath() {
  const path = await window.electronAPI.getMusicFolderPath();
  folderPathText.textContent = path;
}


let categoryTree = {};
let currentCategoryPath = [];

function buildCategoryTree() {
    const tree = {};
    musicFiles.forEach(track => {
        if (!track.category) {
            if (!tree['Uncategorized']) {
                tree['Uncategorized'] = { __tracks: [], __icon: null };
            }
            tree['Uncategorized'].__tracks.push(track);
            return;
        }
        const parts = track.category.split(' / ');
        let currentNode = tree;
        parts.forEach(part => {
            if (!currentNode[part]) {
                currentNode[part] = { __tracks: [], __icon: null };
            }
            currentNode = currentNode[part];
        });
        currentNode.__tracks.push(track);
        if (track.categoryIcon) {
            currentNode.__icon = track.categoryIcon;
        }
    });
    function assignParentIcons(node) {
      if (!node || typeof node !== 'object') return;
      Object.keys(node).forEach(key => {
          if (key.startsWith('__')) return;
          const child = node[key];
          assignParentIcons(child);
          if (child.__icon && !node.__icon) {
              node.__icon = child.__icon;
          }
      });
    }
    assignParentIcons(tree);
    categoryTree = tree;
}

function getNodeFromPath(pathParts) {
    let node = categoryTree;
    if (!node) return null;
    for (const part of pathParts) {
        if (!node[part]) return null;
        node = node[part];
    }
    return node;
}

function getAllTracksFromNode(node) {
    if (!node) return [];
    let tracks = node.__tracks ? [...node.__tracks] : [];
    Object.keys(node).forEach(key => {
        if (!key.startsWith('__')) {
            tracks = tracks.concat(getAllTracksFromNode(node[key]));
        }
    });
    return tracks;
}

function renderListView(pathParts = []) {
    currentCategoryPath = pathParts;
    const node = getNodeFromPath(pathParts);
    musicList.innerHTML = '';
    musicListTitle.textContent = pathParts.length > 0 ? pathParts.join(' / ').toUpperCase() : 'SELECT CATEGORY';
    const tracksForShuffle = getAllTracksFromNode(node);
    if (tracksForShuffle.length > 0) {
        const shuffleItem = document.createElement('div');
        shuffleItem.className = 'shuffle-item';
        const shuffleText = pathParts.length > 0 ? `SHUFFLE ${pathParts[pathParts.length - 1].toUpperCase()}` : 'SHUFFLE ALL';
        shuffleItem.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg><span>${shuffleText}</span>`;
        shuffleItem.addEventListener('click', () => {
            playRandomFromPath(pathParts);
            musicListPanel.classList.add('hidden');
        });
        musicList.appendChild(shuffleItem);
    }
    const subCategories = Object.keys(node || {}).filter(key => !key.startsWith('__'));
    const tracksInNode = node ? node.__tracks || [] : [];
    if (subCategories.length > 0) {
        subCategories.forEach(categoryName => {
            const subNode = node[categoryName];
            const item = document.createElement('div');
            item.className = 'category-item';
            const iconHtml = subNode.__icon ? `<img class="category-icon" src="file:///${subNode.__icon.replace(/\\/g, '/')}" alt="">` : '';
            const trackCount = getAllTracksFromNode(subNode).length;
            item.innerHTML = `
              <div class="category-info">
                ${iconHtml}
                <span class="category-name">${categoryName}</span>
              </div>
              <span class="category-count">${trackCount} tracks</span>
            `;
            item.addEventListener('click', () => {
                renderListView([...pathParts, categoryName]);
            });
            musicList.appendChild(item);
        });
    } else if (tracksInNode.length > 0) {
        tracksInNode.forEach(track => {
            const index = musicFiles.indexOf(track);
            const item = document.createElement('div');
            item.className = 'music-list-item' + (index === currentIndex ? ' active' : '');
            item.innerHTML = `<div class="item-name">${track.name}</div>`;
            item.addEventListener('click', () => {
                playTrack(index);
                musicListPanel.classList.add('hidden');
            });
            musicList.appendChild(item);
        });
    }
}

function playRandomFromPath(pathParts = []) {
    const node = getNodeFromPath(pathParts);
    const tracksToShuffle = getAllTracksFromNode(node);
    if (tracksToShuffle.length === 0) return;
    const randomTrack = tracksToShuffle[Math.floor(Math.random() * tracksToShuffle.length)];
    const index = musicFiles.indexOf(randomTrack);
    playTrack(index);
}

function renderMusicList() {
  renderListView();
}

function getTrackDisplayName(track) {
  if (track.category && !track.categoryIcon) {
    return `${track.category} - ${track.name}`;
  }
  return track.name;
}

function isVideo(filename) {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
  return VIDEO_EXTENSIONS.includes(ext);
}

function setupEventListeners() {
  // Window controls
  minimizeBtn.addEventListener('click', () => window.electronAPI.minimizeWindow());
  closeBtn.addEventListener('click', () => window.electronAPI.closeWindow());

  // ESC key to close panels
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!musicListPanel.classList.contains('hidden')) {
        musicListPanel.classList.add('hidden');
      } else if (!settingsPanel.classList.contains('hidden')) {
        settingsPanel.classList.add('hidden');
        clickOverlay.classList.add('hidden');
      }
    }
  });

  // Settings toggle
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = settingsPanel.classList.toggle('hidden');
    clickOverlay.classList.toggle('hidden', isHidden);
  });

  // Device select button - opens popup window
  selectDevicesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.electronAPI.openDevicesWindow();
  });

  // Click overlay closes settings panel
  clickOverlay.addEventListener('click', () => {
    settingsPanel.classList.add('hidden');
    clickOverlay.classList.add('hidden');
  });

  // Listen for device updates from popup window
  window.electronAPI.onDuckDevicesUpdated((devices) => {
    selectedDuckDevices = devices;
    saveCurrentSettings();
    if (duckingEnabled) {
      if (selectedDuckDevices.length > 0) {
        startDuckingCheck();
      } else {
        stopDuckingCheck();
      }
    }
  });

  // Prevent settings panel clicks from closing it
  settingsPanel.addEventListener('click', (e) => e.stopPropagation());

  // Track section click to show music list
  trackSection.addEventListener('click', (e) => {
    e.stopPropagation();
    renderMusicList();
    musicListPanel.classList.remove('hidden');
  });

  // Music list back button
  musicListBackBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentCategoryPath.length === 0) {
      musicListPanel.classList.add('hidden');
    } else {
      currentCategoryPath.pop();
      renderListView(currentCategoryPath);
    }
  });

  // Startup toggle
  startOnBootCheckbox.addEventListener('change', async (e) => {
    await window.electronAPI.setStartOnBoot(e.target.checked);
  });

  // Folder buttons
  openFolderBtn.addEventListener('click', () => window.electronAPI.openMusicFolder());
  selectFolderBtn.addEventListener('click', async () => {
    const newPath = await window.electronAPI.selectMusicFolder();
    if (newPath) {
      folderPathText.textContent = newPath;
      await loadMusicFromFolder();
      if (musicFiles.length > 0) playRandomTrack();
    }
  });

  // Playback controls
  playPauseBtn.addEventListener('click', () => togglePlayPause());
  skipBtn.addEventListener('click', () => playRandomTrack());
  jumpBtn.addEventListener('click', () => {
    if (activePlayer.duration) {
      activePlayer.currentTime = Math.min(activePlayer.currentTime + 300, activePlayer.duration - 1);
    }
  });

  // Duck toggle button
  duckBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    duckingEnabled = !duckingEnabled;
    if (duckingEnabled) {
      duckIconOn.classList.remove('hidden');
      duckIconOff.classList.add('hidden');
      if (selectedDuckDevices.length > 0) startDuckingCheck();
    } else {
      duckIconOn.classList.add('hidden');
      duckIconOff.classList.remove('hidden');
      stopDuckingCheck();
      if (isDucking) stopDucking(500);
    }
    saveCurrentSettings();
  });

  // Volume controls
  volumeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    volumePopup.classList.add('active');
  });
  const volumeContainer = document.querySelector('.volume-popup-container');
  volumeContainer.addEventListener('mouseleave', () => {
    volumePopup.classList.remove('active');
  });
  volumeSlider.addEventListener('input', (e) => {
    targetVolume = e.target.value / 100;
    if (!isDucking) {
      currentVolume = targetVolume;
      activePlayer.volume = currentVolume;
    }
    saveCurrentSettings();
  });

  // Progress bar
  progressBar.addEventListener('click', (e) => {
    if (activePlayer.duration) {
      const rect = progressBar.getBoundingClientRect();
      activePlayer.currentTime = ((e.clientX - rect.left) / rect.width) * activePlayer.duration;
    }
  });

  // Media player events
  setupMediaEvents(audioPlayer);
  setupMediaEvents(bgVideo);
}

// Setup media events for a player element
function setupMediaEvents(player) {
  player.addEventListener('timeupdate', () => {
    if (player === activePlayer) updateProgress();
  });

  player.addEventListener('loadedmetadata', () => {
    if (player === activePlayer) {
      durationEl.textContent = formatTime(player.duration);
    }
  });

  player.addEventListener('ended', () => {
    if (player === activePlayer) playRandomTrack();
  });

  player.addEventListener('play', () => {
    if (player === activePlayer) {
      playIcon.classList.add('hidden');
      pauseIcon.classList.remove('hidden');
    }
  });

  player.addEventListener('pause', () => {
    if (player === activePlayer) {
      pauseIcon.classList.add('hidden');
      playIcon.classList.remove('hidden');
    }
  });

  player.addEventListener('error', (e) => {
    if (player === activePlayer) {
      console.error('Media error:', e);
      trackName.textContent = 'Error loading track';
      setTimeout(playRandomTrack, 1000);
    }
  });
}

// Toggle play/pause
function togglePlayPause() {
  if (activePlayer.paused) {
    isManuallyPaused = false;
    activePlayer.play().catch(console.error);
  } else {
    isManuallyPaused = true;
    activePlayer.pause();
  }
}

// Load music files from local music folder
async function loadMusicFromFolder() {
  musicFiles = await window.electronAPI.getMusicFiles();
  console.log('Loaded music files:', musicFiles.length);
  buildCategoryTree();

  if (musicFiles.length === 0) {
    trackName.textContent = 'No tracks found';
  }
}

// Play a specific track by index
function playTrack(index) {
  if (index < 0 || index >= musicFiles.length) return;

  // Stop current playback
  audioPlayer.pause();
  bgVideo.pause();

  currentIndex = index;
  const track = musicFiles[currentIndex];
  const filePath = track.path.replace(/\\/g, '/');
  const fileUrl = `file:///${filePath}`;

  trackName.textContent = getTrackDisplayName(track);
  isVideoFile = isVideo(track.path);

  // Update category icon
  if (track.categoryIcon) {
    currentCategoryIcon.src = `file:///${track.categoryIcon.replace(/\\/g, '/')}`;
    currentCategoryIcon.classList.remove('hidden');
  } else {
    currentCategoryIcon.classList.add('hidden');
  }

  if (isVideoFile) {
    // Use video element for MP4 files
    activePlayer = bgVideo;
    bgVideo.src = fileUrl;
    bgVideo.volume = currentVolume;
    bgVideo.muted = false;
    bgVideo.loop = false;
    audioPlayer.src = '';

    bgVideo.play().catch(err => {
      console.error('Video play error:', err);
      trackName.textContent = 'Error: ' + track.name;
    });
  } else {
    // Use audio element for non-video files
    activePlayer = audioPlayer;
    audioPlayer.src = fileUrl;
    audioPlayer.volume = currentVolume;
    bgVideo.src = '';

    audioPlayer.play().catch(err => {
      console.error('Audio play error:', err);
      trackName.textContent = 'Error: ' + track.name;
    });
  }

  isManuallyPaused = false;
}

// Play a random track
function playRandomTrack() {
  if (musicFiles.length === 0) {
    trackName.textContent = 'No tracks found';
    return;
  }

  // Get a random index different from current if possible
  let newIndex;
  if (musicFiles.length === 1) {
    newIndex = 0;
  } else {
    do {
      newIndex = Math.floor(Math.random() * musicFiles.length);
    } while (newIndex === currentIndex);
  }

  playTrack(newIndex);
}

// Update progress bar
function updateProgress() {
  if (activePlayer.duration) {
    const percent = (activePlayer.currentTime / activePlayer.duration) * 100;
    progressFill.style.width = `${percent}%`;
    currentTimeEl.textContent = formatTime(activePlayer.currentTime);
  }
}

// Format time as M:SS or H:MM:SS
function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';

  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Fade volume smoothly with optional callback
function fadeVolume(target, duration, callback) {
  if (fadeInterval) {
    clearInterval(fadeInterval);
  }

  const startVolume = activePlayer.volume;
  const volumeDiff = target - startVolume;
  const steps = 30;
  const stepTime = duration / steps;
  let currentStep = 0;

  fadeInterval = setInterval(() => {
    currentStep++;
    const progress = currentStep / steps;
    const easeProgress = 1 - Math.pow(1 - progress, 3);
    const newVolume = Math.max(0, Math.min(1, startVolume + (volumeDiff * easeProgress)));
    activePlayer.volume = newVolume;
    currentVolume = newVolume;

    if (currentStep >= steps) {
      clearInterval(fadeInterval);
      fadeInterval = null;
      activePlayer.volume = target;
      currentVolume = target;
      if (callback) callback();
    }
  }, stepTime);
}

// Start the app
init();
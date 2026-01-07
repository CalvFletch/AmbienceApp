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
const musicListPanel = document.getElementById('musicListPanel');
const musicList = document.getElementById('musicList');
const musicListBackBtn = document.getElementById('musicListBackBtn');
const musicListTitle = document.getElementById('musicListTitle');
const currentCategoryIcon = document.getElementById('currentCategoryIcon');
const debugLog = document.getElementById('debugLog');

// Debug logging (toggle with Ctrl+D)
let debugEnabled = false;
function dlog(msg, type = '') {
  if (!debugEnabled) return;
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
  const entry = document.createElement('div');
  entry.className = 'log-entry' + (type ? ' ' + type : '');
  entry.textContent = `[${time}] ${msg}`;
  debugLog.appendChild(entry);
  // Keep only last 100 entries
  while (debugLog.children.length > 100) {
    debugLog.removeChild(debugLog.firstChild);
  }
  debugLog.scrollTop = debugLog.scrollHeight;
}

document.addEventListener('keydown', async (e) => {
  if (e.ctrlKey && e.key === 'd') {
    e.preventDefault();
    // Only open debug window in dev mode
    const isDev = await window.electronAPI.isDevMode();
    if (isDev) {
      window.electronAPI.openDebugWindow();
    }
  }
});

// Copy log button
const debugCopyBtn = document.getElementById('debugCopyBtn');
if (debugCopyBtn) {
  debugCopyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const entries = debugLog.querySelectorAll('.log-entry');
    const text = Array.from(entries).map(entry => entry.textContent).join('\n');
    if (text) {
      navigator.clipboard.writeText(text).then(() => {
        debugCopyBtn.textContent = 'Copied!';
        setTimeout(() => debugCopyBtn.textContent = 'Copy Log', 1500);
      }).catch(err => {
        console.error('Failed to copy:', err);
        debugCopyBtn.textContent = 'Error!';
        setTimeout(() => debugCopyBtn.textContent = 'Copy Log', 1500);
      });
    } else {
      debugCopyBtn.textContent = 'Empty!';
      setTimeout(() => debugCopyBtn.textContent = 'Copy Log', 1500);
    }
  });
}

// State
let musicFiles = [];
let currentIndex = -1;
let isDucking = false;
let isManuallyPaused = false;
let targetVolume = 0.7;
let currentVolume = 0.7;
let fadeInterval = null;
let isVideoFile = false;
let duckingEnabled = true;
let selectedDuckDevices = [];
let selectedDuckExes = []; // List of exe names for program-based ducking
let duckMode = 'device'; // 'device' or 'exe'
let duckCheckInterval = null;
let wasPausedByDucking = false;
let consecutiveSilenceCount = 0;
const DUCK_VOLUME = 0;
const DUCK_CHECK_INTERVAL = 400; // Check every 400ms (balance between responsiveness and CPU)
const SILENCE_CHECKS_REQUIRED = 8; // Require 8 consecutive silence checks (~3.2 seconds) before releasing

let activePlayer = audioPlayer;
let currentShufflePath = []; // Locked category path for shuffle mode
let shuffleMode = false; // false = sequential play, true = random play
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
  setupNotificationBanner();
  setupDebugEventHandlers();
  await loadSettings();
  await loadMusicFromFolder();
  if (musicFiles.length > 0) {
    // Start with shuffle mode since no specific track was chosen
    shuffleMode = true;
    playRandomTrack();
  }
  if (duckingEnabled) {
    if ((duckMode === 'device' && selectedDuckDevices.length > 0) ||
        (duckMode === 'exe' && selectedDuckExes.length > 0)) {
      startDuckingCheck();
    }
  }
  
  // Global function for main process to call directly via executeJavaScript
  window.refreshMusicFiles = async function() {
    const wasPlaying = !activePlayer.paused;
    const previousTrackPath = currentTrack?.path || null;
    
    await loadMusicFromFolder();
    
    // Re-render the music list if it's currently open
    if (!musicListPanel.classList.contains('hidden')) {
      renderListView(currentCategoryPath);
    }
    
    // Try to find the same track in the new file list
    if (previousTrackPath) {
      const sameTrackIndex = musicFiles.findIndex(f => f.path === previousTrackPath);
      if (sameTrackIndex >= 0) {
        currentIndex = sameTrackIndex;
        return;
      }
    }
    
    // Track was removed - play new random track if was playing
    if ((wasPlaying || !isManuallyPaused) && musicFiles.length > 0) {
      playRandomTrack();
    }
  };
  
  // Check for updates and music library after a short delay
  // Notifications will queue up and show one after another
  setTimeout(async () => {
    await checkForUpdates();
    await checkMusicLibrary();
  }, 2000);
}


function startDuckingCheck() {
  if (duckCheckInterval) {
    clearInterval(duckCheckInterval);
  }
  consecutiveSilenceCount = 0;

  if (duckMode === 'device') {
    dlog(`Duck check started (Device mode): ${selectedDuckDevices.join(', ')}`, 'info');
  } else {
    dlog(`Duck check started (Program mode): ${selectedDuckExes.join(', ')}`, 'info');
  }

  duckCheckInterval = setInterval(async () => {
    if (!duckingEnabled) return;

    let isPlaying = false;
    let peakValue = 0;

    if (duckMode === 'device') {
      if (selectedDuckDevices.length === 0) return;
      for (const device of selectedDuckDevices) {
        const result = await window.electronAPI.checkAudioActivity(device);
        if (result.error) {
          dlog(`Error: ${result.error}`, 'error');
        }
        if (result.playing) {
          isPlaying = true;
          peakValue = Math.max(peakValue, result.peak || 0);
          break;
        }
        peakValue = Math.max(peakValue, result.peak || 0);
      }
    } else {
      // Exe mode
      if (selectedDuckExes.length === 0) return;
      const result = await window.electronAPI.checkExeAudio(selectedDuckExes);
      if (result.error) {
        dlog(`Error: ${result.error}`, 'error');
      }
      isPlaying = result.playing || false;
      peakValue = result.peak || 0;
    }

    dlog(`Peak: ${peakValue.toFixed(6)} | Audio: ${isPlaying} | Silence#: ${consecutiveSilenceCount} | Ducking: ${isDucking}`);

    if (isPlaying) {
      consecutiveSilenceCount = 0;
      if (!isDucking) {
        dlog('>>> STARTING DUCK', 'warn');
      }
      startDucking();
    } else if (isDucking) {
      consecutiveSilenceCount++;
      if (consecutiveSilenceCount >= SILENCE_CHECKS_REQUIRED) {
        dlog(`>>> RELEASING DUCK (${consecutiveSilenceCount} silent checks)`, 'warn');
        stopDucking();
        consecutiveSilenceCount = 0;
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
  if (settings.duckExes && Array.isArray(settings.duckExes)) {
    selectedDuckExes = settings.duckExes;
  }
  if (settings.duckMode) {
    duckMode = settings.duckMode;
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

// Notification Queue System
const notificationQueue = [];
let currentNotification = null;

// Notification Banner Logic
const notificationBanner = document.getElementById('notificationBanner');
const notificationText = document.getElementById('notificationText');
const notificationCheckboxLabel = document.getElementById('notificationCheckboxLabel');
const notificationDontShow = document.getElementById('notificationDontShow');
const notificationIgnoreBtn = document.getElementById('notificationIgnoreBtn');
const notificationActionBtn = document.getElementById('notificationActionBtn');

function setupNotificationBanner() {
  const banner = document.getElementById('notificationBanner');
  const actionBtn = document.getElementById('notificationActionBtn');
  const ignoreBtn = document.getElementById('notificationIgnoreBtn');
  const dontShowCheckbox = document.getElementById('notificationDontShow');

  actionBtn.addEventListener('click', () => {
    if (currentNotification && currentNotification.onAction) {
      currentNotification.onAction();
    }
    hideCurrentNotification();
  });

  ignoreBtn.addEventListener('click', () => {
    if (currentNotification && currentNotification.onDismiss) {
      currentNotification.onDismiss();
    }
    if (dontShowCheckbox.checked && currentNotification && currentNotification.onDontShowAgain) {
      currentNotification.onDontShowAgain();
    }
    hideCurrentNotification();
  });
}

function queueNotification(notification) {
  // notification: { type, text, buttonText, onAction, onDismiss, onDontShowAgain }
  notificationQueue.push(notification);
  if (!currentNotification) {
    showNextNotification();
  }
}

function showNextNotification() {
  if (notificationQueue.length === 0) {
    currentNotification = null;
    return;
  }

  currentNotification = notificationQueue.shift();
  const banner = document.getElementById('notificationBanner');
  const textEl = document.getElementById('notificationText');
  const actionBtn = document.getElementById('notificationActionBtn');
  const dontShowCheckbox = document.getElementById('notificationDontShow');

  textEl.textContent = currentNotification.text;
  actionBtn.textContent = currentNotification.buttonText;
  dontShowCheckbox.checked = false; // Reset checkbox for each notification
  banner.classList.remove('hidden');
  dlog(`Notification shown: ${currentNotification.type}`, 'info');
}

function hideCurrentNotification() {
  const banner = document.getElementById('notificationBanner');
  banner.classList.add('hidden');
  currentNotification = null;
  // Show next notification after a short delay
  setTimeout(showNextNotification, 300);
}

// Update notification
let updateReleaseUrl = '';
let dismissedUpdateVersion = '';

async function checkForUpdates() {
  try {
    const result = await window.electronAPI.checkForUpdates();
    if (result.hasUpdate) {
      // Check if user already dismissed this version
      const dismissed = await window.electronAPI.getDismissedUpdate();
      if (dismissed === result.latestVersion) {
        dlog(`Update v${result.latestVersion} was dismissed by user`, 'info');
        return false;
      }
      dismissedUpdateVersion = result.latestVersion;
      updateReleaseUrl = result.releaseUrl;

      queueNotification({
        type: 'update',
        text: `Update available: v${result.latestVersion}`,
        buttonText: 'Download',
        onAction: () => {
          if (updateReleaseUrl) {
            window.electronAPI.openExternalUrl(updateReleaseUrl);
          }
        },
        onDismiss: () => {
          // Just dismiss, don't save
        },
        onDontShowAgain: async () => {
          if (dismissedUpdateVersion) {
            await window.electronAPI.saveDismissedUpdate(dismissedUpdateVersion);
          }
        }
      });

      dlog(`Update available: v${result.latestVersion} (current: v${result.currentVersion})`, 'info');
      return true;
    }
  } catch (e) {
    // Silently fail - update check is not critical
  }
  return false;
}

// Music library notification
async function checkMusicLibrary() {
  try {
    const settings = await window.electronAPI.loadSettings();
    if (settings.dismissedLibraryPrompt) {
      return;
    }

    // Check if user has downloaded any library categories
    const libraryStatus = await window.electronAPI.getMusicLibraryStatus();
    if (libraryStatus && libraryStatus.localMetadata && libraryStatus.localMetadata.installedCategories) {
      const installedCats = libraryStatus.localMetadata.installedCategories;
      const hasAnyInstalled = Object.values(installedCats).some(cat => cat.installed);
      if (hasAnyInstalled) {
        return; // User has at least one category downloaded
      }
    }

    // Check if user has any music
    if (musicFiles.length === 0) {
      queueNotification({
        type: 'music-library',
        text: 'Download the music library?',
        buttonText: 'Download',
        onAction: () => {
          window.electronAPI.openSettingsLibrary();
        },
        onDismiss: () => {
          // Just dismiss, don't save
        },
        onDontShowAgain: async () => {
          await window.electronAPI.saveSettings({ dismissedLibraryPrompt: true });
        }
      });
    }
  } catch (e) {
    // Silently fail
  }
}

// Debug event handlers - receive commands from debug window
function setupDebugEventHandlers() {
  // Show update notification (debug trigger)
  window.electronAPI.onDebugShowUpdate((data) => {
    dismissedUpdateVersion = data.version;
    updateReleaseUrl = data.releaseUrl;
    queueNotification({
      type: 'update',
      text: `Update available: v${data.version}`,
      buttonText: 'Download',
      onAction: () => {
        if (updateReleaseUrl) {
          window.electronAPI.openExternalUrl(updateReleaseUrl);
        }
      },
      onDismiss: () => {},
      onDontShowAgain: async () => {
        if (dismissedUpdateVersion) {
          await window.electronAPI.saveDismissedUpdate(dismissedUpdateVersion);
        }
      }
    });
    dlog(`[DEBUG] Update notification triggered: v${data.version}`, 'info');
  });

  // Show library notification (debug trigger)
  window.electronAPI.onDebugShowLibrary(() => {
    queueNotification({
      type: 'music-library',
      text: 'Download the music library?',
      buttonText: 'Download',
      onAction: () => {
        window.electronAPI.openSettingsLibrary();
      },
      onDismiss: () => {},
      onDontShowAgain: async () => {
        await window.electronAPI.saveSettings({ dismissedLibraryPrompt: true });
      }
    });
    dlog('[DEBUG] Library notification triggered', 'info');
  });

  // Hide update notification
  window.electronAPI.onDebugHideUpdate(() => {
    hideCurrentNotification();
    dlog('[DEBUG] Notification hidden', 'info');
  });

  // Simulate duck event
  window.electronAPI.onDebugDuck(() => {
    dlog('[DEBUG] Simulating duck event', 'warn');
    startDucking();
  });

  // Simulate unduck event
  window.electronAPI.onDebugUnduck(() => {
    dlog('[DEBUG] Simulating unduck event', 'warn');
    stopDucking(500);
  });

  // Force play
  window.electronAPI.onDebugForcePlay(() => {
    dlog('[DEBUG] Force play', 'info');
    isManuallyPaused = false;
    activePlayer.play().catch(console.error);
  });

  // Force pause
  window.electronAPI.onDebugForcePause(() => {
    dlog('[DEBUG] Force pause', 'info');
    isManuallyPaused = true;
    activePlayer.pause();
  });

  // Force skip
  window.electronAPI.onDebugForceSkip(() => {
    dlog('[DEBUG] Force skip track', 'info');
    playRandomTrack();
  });
}

async function saveCurrentSettings() {
  await window.electronAPI.saveSettings({
    duckDevices: selectedDuckDevices,
    duckExes: selectedDuckExes,
    duckMode: duckMode,
    volume: targetVolume,
    duckingEnabled: duckingEnabled
  });
}

function restartDuckingIfEnabled() {
  if (duckingEnabled) {
    stopDuckingCheck();
    if ((duckMode === 'device' && selectedDuckDevices.length > 0) ||
        (duckMode === 'exe' && selectedDuckExes.length > 0)) {
      startDuckingCheck();
    }
  }
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
                // Set to sequential play from this track onwards
                shuffleMode = false;
                // Lock to top-level category only (first element of path)
                currentShufflePath = currentCategoryPath.length > 0 ? [currentCategoryPath[0]] : [];
                playTrack(index);
                musicListPanel.classList.add('hidden');
            });
            musicList.appendChild(item);
        });
    }
}

function playRandomFromPath(pathParts = []) {
    // Lock to this category and enable shuffle mode
    shuffleMode = true;
    currentShufflePath = [...pathParts];
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
      }
    }
  });

  // Settings button - opens settings window
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.electronAPI.openSettingsWindow();
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

  // Listen for settings updates from settings window
  window.electronAPI.onSettingsUpdated((settings) => {
    if (settings.duckMode) {
      duckMode = settings.duckMode;
    }
    if (settings.duckExes) {
      selectedDuckExes = settings.duckExes;
    }
    restartDuckingIfEnabled();
  });

  // Listen for release-category-files (before category removal)
  window.electronAPI.onReleaseCategoryFiles((categoryName) => {
    // Convert to slug for comparison (category in track is slug format)
    const catSlug = categoryName.toLowerCase().replace(/\s+/g, '-');
    
    // Always release both players to be safe - they might have preloaded content
    audioPlayer.pause();
    audioPlayer.removeAttribute('src');
    audioPlayer.load(); // Force release file handle
    
    bgVideo.pause();
    bgVideo.removeAttribute('src');
    bgVideo.load(); // Force release file handle
    
    // Check if currently playing a track from this category
    if (currentTrack && currentTrack.category) {
      const trackCatSlug = currentTrack.category.toLowerCase().replace(/\s+/g, '-');
      if (trackCatSlug === catSlug || trackCatSlug.startsWith(catSlug + '-')) {
        currentTrack = null;
        currentIndex = -1;
        
        // Find a track from a different category to play
        const otherTracks = musicFiles.filter(f => {
          const fCatSlug = (f.category || '').toLowerCase().replace(/\s+/g, '-');
          return fCatSlug !== catSlug && !fCatSlug.startsWith(catSlug + '-');
        });
        
        if (otherTracks.length > 0) {
          // Play a random track from another category
          const randomTrack = otherTracks[Math.floor(Math.random() * otherTracks.length)];
          const newIndex = musicFiles.indexOf(randomTrack);
          currentIndex = newIndex;
          shuffleMode = false;
          currentShufflePath = [];
          loadCurrentTrack();
        } else {
          // No other tracks available - go to "no tracks" state
          trackName.textContent = 'No music found';
          currentCategoryIcon.style.display = 'none';
          playIcon.classList.remove('hidden');
          pauseIcon.classList.add('hidden');
        }
      }
    }
  });

  // Listen for music files updates (after library download/remove)
  window.electronAPI.onMusicFilesUpdated(async () => {
    const wasPlaying = !activePlayer.paused;
    const previousTrackPath = currentTrack?.path || null;
    
    await loadMusicFromFolder();
    
    // Re-render the music list if it's currently open
    if (!musicListPanel.classList.contains('hidden')) {
      renderListView(currentCategoryPath);
    }
    
    // Try to find the same track in the new file list
    if (previousTrackPath) {
      const sameTrackIndex = musicFiles.findIndex(f => f.path === previousTrackPath);
      if (sameTrackIndex >= 0) {
        currentIndex = sameTrackIndex;
        return;
      }
    }
    
    // Track was removed or didn't exist - play new random track if was playing
    if ((wasPlaying || !isManuallyPaused) && musicFiles.length > 0) {
      playRandomTrack();
    }
  });

  // Track section click to show music list
  trackSection.addEventListener('click', async (e) => {
    e.stopPropagation();
    // Refresh music files to ensure we have the latest
    await loadMusicFromFolder();
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

// Play next track (sequential or random based on shuffleMode)
async function playNextTrack() {
  // Refresh music files to catch any changes
  await loadMusicFromFolder();
  
  // Determine which tracks to use
  let tracksToUse = musicFiles;
  if (currentShufflePath.length > 0) {
    const node = getNodeFromPath(currentShufflePath);
    tracksToUse = getAllTracksFromNode(node);
  }
  
  if (tracksToUse.length === 0) {
    trackName.textContent = 'No tracks found';
    return;
  }
  
  if (shuffleMode) {
    // Random mode - pick a different track
    let nextTrack;
    if (tracksToUse.length === 1) {
      nextTrack = tracksToUse[0];
    } else {
      const currentTrackObj = musicFiles[currentIndex];
      do {
        nextTrack = tracksToUse[Math.floor(Math.random() * tracksToUse.length)];
      } while (nextTrack === currentTrackObj && tracksToUse.length > 1);
    }
    const index = musicFiles.indexOf(nextTrack);
    playTrack(index);
  } else {
    // Sequential mode - play next track in the list
    const currentTrackObj = musicFiles[currentIndex];
    const currentPosInCategory = tracksToUse.indexOf(currentTrackObj);
    const nextPosInCategory = (currentPosInCategory + 1) % tracksToUse.length;
    const nextTrack = tracksToUse[nextPosInCategory];
    const index = musicFiles.indexOf(nextTrack);
    playTrack(index);
  }
}

// Legacy function name for compatibility
async function playRandomTrack() {
  await playNextTrack();
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
  
  // Use fixed 16ms steps (~60fps) for smooth transitions
  const stepTime = 16;
  const steps = Math.max(1, Math.round(duration / stepTime));
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

// For debugging: show notification on Ctrl+Shift+N
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'n') {
    showNotification('Debug notification: update available!', 'Download');
  }
});

// Notification system
function showNotification(text, actionLabel = 'Download', onAction = null, onIgnore = null) {
  notificationText.textContent = text;
  notificationBanner.classList.remove('hidden');
  notificationActionBtn.textContent = actionLabel;
  notificationIgnoreBtn.textContent = 'Ignore';
  notificationActionBtn.onclick = () => {
    // Open music library page in settings
    window.electronAPI.openSettings('musicLibrary');
    notificationBanner.classList.add('hidden');
    if (onAction) onAction();
  };
  notificationIgnoreBtn.onclick = () => {
    notificationBanner.classList.add('hidden');
    if (onIgnore) onIgnore();
  };
}

// Start the app
init();
async function init() {
  const { allDevices, selectedDevices } = await window.electronAPI.getInitialState();
  const deviceList = document.getElementById('deviceList');
  const doneBtn = document.getElementById('doneBtn');
  deviceList.innerHTML = '';

  if (allDevices.length === 0) {
    deviceList.innerHTML = '<div class="no-devices">No audio devices found</div>';
    return;
  }

  let currentSelectedDevices = [...selectedDevices];

  // Checkmark SVG
  const checkmarkSvg = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;

  allDevices.forEach(device => {
    const item = document.createElement('div');
    item.className = 'device-item';
    if (currentSelectedDevices.includes(device)) {
      item.classList.add('selected');
    }

    const checkboxIcon = document.createElement('div');
    checkboxIcon.className = 'checkbox-icon';
    checkboxIcon.innerHTML = checkmarkSvg;

    const deviceName = document.createElement('span');
    deviceName.className = 'device-name';
    deviceName.textContent = device;

    item.appendChild(checkboxIcon);
    item.appendChild(deviceName);
    deviceList.appendChild(item);

    // Click anywhere on the row to toggle
    item.addEventListener('click', () => {
      const isSelected = item.classList.toggle('selected');
      if (isSelected) {
        if (!currentSelectedDevices.includes(device)) {
          currentSelectedDevices.push(device);
        }
      } else {
        currentSelectedDevices = currentSelectedDevices.filter(d => d !== device);
      }
      window.electronAPI.updateDuckDevices(currentSelectedDevices);
    });
  });

  // Done button closes the window
  doneBtn.addEventListener('click', () => {
    window.electronAPI.closeWindow();
  });
}

init();

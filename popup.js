const toggle = document.getElementById('toggle');

// Load saved state
chrome.storage.local.get('whipEnabled', res => {
  toggle.checked = res.whipEnabled !== false; // default on
});

// Save on change — content.js listens via storage.onChanged
toggle.addEventListener('change', () => {
  chrome.storage.local.set({ whipEnabled: toggle.checked });
});

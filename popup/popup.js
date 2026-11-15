const apiKeyInput = document.getElementById('api-key-input');
const keyStatusPill = document.getElementById('key-status-pill');
const groundingToggle = document.getElementById('grounding-toggle');
const autocheckToggle = document.getElementById('autocheck-toggle');
const modelSelect = document.getElementById('model-select');
const lingerSelect = document.getElementById('linger-select');
const saveBtn = document.getElementById('save-btn');
const saveToast = document.getElementById('save-toast');

async function loadSettings() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_CONFIG_AND_CACHE' });
  if (!resp || !resp.ok) return;

  const s = resp.settings;
  const versionPill = document.getElementById('version-pill');
  if (versionPill && s.version) {
    versionPill.textContent = `v${s.version}`;
  }
  if (s.hasApiKey) {
    keyStatusPill.textContent = `Active (${s.maskedKey})`;
    keyStatusPill.className = 'status-pill ok';
  } else {
    keyStatusPill.textContent = 'Missing Key';
    keyStatusPill.className = 'status-pill missing';
  }

  groundingToggle.checked = Boolean(s.enableSearchGrounding);
  autocheckToggle.checked = Boolean(s.autoCheck);
  modelSelect.value = s.geminiModel || 'gemini-2.5-flash';
  lingerSelect.value = String(s.lingerDurationSec || 10);
}

saveBtn.addEventListener('click', async () => {
  const payload = {
    enableSearchGrounding: groundingToggle.checked,
    autoCheck: autocheckToggle.checked,
    geminiModel: modelSelect.value,
    lingerDurationSec: parseInt(lingerSelect.value, 10) || 10
  };

  const trimmedKey = apiKeyInput.value.trim();
  if (trimmedKey) {
    payload.customApiKey = trimmedKey;
  }

  const resp = await chrome.runtime.sendMessage({
    type: 'SAVE_SETTINGS',
    settings: payload
  });

  if (resp?.ok) {
    apiKeyInput.value = '';
    await loadSettings();
    saveToast.classList.remove('hidden');
    setTimeout(() => {
      saveToast.classList.add('hidden');
    }, 2000);
  }
});

loadSettings();

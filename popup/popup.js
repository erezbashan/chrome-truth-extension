const apiKeyInput = document.getElementById('api-key-input');
const keyStatusPill = document.getElementById('key-status-pill');
const groundingToggle = document.getElementById('grounding-toggle');
const autocheckToggle = document.getElementById('autocheck-toggle');
const modelSelect = document.getElementById('model-select');
const lingerSelect = document.getElementById('linger-select');
const saveBtn = document.getElementById('save-btn');
const saveToast = document.getElementById('save-toast');
const feedbackType = document.getElementById('feedback-type');
const feedbackText = document.getElementById('feedback-text');
const fbGmailBtn = document.getElementById('fb-gmail-btn');
const fbMailtoBtn = document.getElementById('fb-mailto-btn');

let currentVersion = '1.0.17';

async function loadSettings() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_CONFIG_AND_CACHE' });
  if (!resp || !resp.ok) return;

  const s = resp.settings;
  if (s.version) {
    currentVersion = s.version;
    const versionPill = document.getElementById('version-pill');
    if (versionPill) versionPill.textContent = `v${s.version}`;
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
  modelSelect.value = s.geminiModel || 'gemini-3.8-flash';
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

function buildPopupFeedbackPayload() {
  const category = feedbackType?.value || 'General Feedback';
  const msg = (feedbackText?.value || '').trim() || '(Write your feedback here)';
  const subject = `[Truth Bar v${currentVersion}] ${category}`;
  const body = `${msg}\n\n---\nExtension Version: v${currentVersion}`;
  return {
    to: 'erez.bashan@gmail.com',
    subject,
    body
  };
}

fbGmailBtn?.addEventListener('click', () => {
  const { to, subject, body } = buildPopupFeedbackPayload();
  const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(
    to
  )}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
});

fbMailtoBtn?.addEventListener('click', () => {
  const { to, subject, body } = buildPopupFeedbackPayload();
  const url = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(
    body
  )}`;
  window.open(url, '_blank');
});

loadSettings();

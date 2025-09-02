// Register PWA service worker
if ('serviceWorker' in navigator) {
navigator.serviceWorker.register('/sw.js').catch(() => {});
}


const chat = document.getElementById('chat');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const installBtn = document.getElementById('installBtn');


// Handle PWA install prompt (Android/Chromium)
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; installBtn.style.display = 'inline-flex'; });
installBtn?.addEventListener('click', async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; installBtn.style.display = 'none'; });


function addMsg(role, text) {
const div = document.createElement('div');
div.className = `msg ${role}`;
div.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
chat.appendChild(div);
window.scrollTo({ top: document.body.scrollHeight });
}


form.addEventListener('submit', async (e) => {
e.preventDefault();
const text = (input.value || '').trim();
if (!text) return;
addMsg('user', text);
input.value = '';


addMsg('assistant', '…thinking');
try {
const res = await fetch('/.netlify/functions/agentChat', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ messages: [{ role: 'user', content: text }] })
});
const data = await res.json();


// replace the last assistant bubble
const last = chat.querySelector('.msg.assistant:last-child .bubble');
last.textContent = data.reply || '[empty reply]';
} catch (err) {
const last = chat.querySelector('.msg.assistant:last-child .bubble');
last.textContent = 'Error contacting Agent.';
}
});


function escapeHtml(s) { return s.replace(/[&<>"]+/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
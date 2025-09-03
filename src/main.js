// --- Optional SW registration (safe if sw.js is absent)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

const chat = document.getElementById("chat");
const runBtn = document.getElementById("runBtn");
const installBtn = document.getElementById("installBtn");
const btnSpinner = runBtn?.querySelector(".btn-spinner");
const btnLabel = runBtn?.querySelector(".btn-label");

// Minimal install experience (optional)
let deferredPrompt;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (installBtn) installBtn.style.display = "inline-flex";
});
installBtn?.addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBtn.style.display = "none";
});

// ---------- UI helpers ----------
function bubbleHTML(html, extraClass = "") {
  const div = document.createElement("div");
  div.className = `msg assistant`;
  div.innerHTML = `<div class="bubble ${extraClass}">${html}</div>`;
  chat.appendChild(div);
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
}
function bubbleText(text) {
  bubbleHTML(escapeBasic(text));
}
function setLoading(loading) {
  if (!runBtn) return;
  runBtn.disabled = loading;
  if (btnSpinner) btnSpinner.hidden = !loading;
  if (btnLabel) btnLabel.textContent = loading ? "Working…" : "Run Trade Agent";
}
// escape ampersand + < and " only, so '>' arrows render as desired
function escapeBasic(s) {
  return String(s).replace(/[&<"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", '"': "&quot;" }[c]));
}

// ---------- API calls ----------
async function fetchState() {
  const r = await fetch("/.netlify/functions/tradeState");
  const text = await r.text();
  console.debug("[tradeState]", r.status, text.slice(0, 160));
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`tradeState non-JSON (${r.status})`);
  }
  if (!r.ok || !json?.ok) throw new Error(json?.error || `tradeState HTTP ${r.status}`);
  return json.state;
}

async function callAgentWithState(state) {
  const r = await fetch("/.netlify/functions/agentChat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state })
  });
  const text = await r.text();
  console.debug("[agentChat raw]", r.status, text.slice(0, 160));
  try { return JSON.parse(text); }
  catch { return { ok:false, error:"Non-JSON reply", details: text }; }
}

// ---------- Markdown rendering ----------
function renderMarkdown(markdown) {
  // marked already escapes HTML appropriately
  const html = window.marked.parse(markdown);
  bubbleHTML(html, "markdown");
}



// ---------- Main action ----------
async function runTradeAgent() {
  setLoading(true);
  bubbleText("Loading state…");
  try {
    const state = await fetchState();

    bubbleText("Generating plan…");
    const data = await callAgentWithState(state);

if (data?.ok && data?.plan) {
  // Force clean line breaks in the Market Pulse block, then render
  const fixed = transformPlanForPulse(data.plan);
  const html = window.marked.parse(fixed);
  bubbleHTML(html, "markdown");
} else {
  const details = data?.details ? `\n\n${String(data.details).slice(0, 400)}` : "";
  bubbleText(`⚠️ ${data?.error || "Unknown error"}${details}`);
}
  } catch (e) {
    bubbleText(`⚠️ ${e.message || "Request failed"}`);
  } finally {
    setLoading(false);
  }
}

runBtn?.addEventListener("click", runTradeAgent);

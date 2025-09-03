// PWA SW (safe no-op if sw.js already registered)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

const chat = document.getElementById("chat");
const runBtn = document.getElementById("runBtn");
const installBtn = document.getElementById("installBtn");

// Optional install prompt
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

// ----- UI helpers -----
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  chat.appendChild(div);
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}
function setLastAssistantText(text) {
  const last = chat.querySelector(".msg.assistant:last-child .bubble");
  if (last) last.textContent = text;
}

// ----- API helpers -----
async function fetchState() {
  const r = await fetch("/.netlify/functions/tradeState");
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch (e) {
    throw new Error(`tradeState returned non-JSON (${r.status}): ${text.slice(0,200)}`);
  }
  console.debug("[tradeState]", r.status, json);
  if (!r.ok || !json?.ok) throw new Error(json?.error || `tradeState HTTP ${r.status}`);
  return json.state || {};
}

async function callAgentWithState(state) {
  const r = await fetch("/.netlify/functions/agentChat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state })
  });
  const text = await r.text();
  console.debug("[agentChat raw]", r.status, text.slice(0,200));
  let json;
  try { json = JSON.parse(text); } catch (e) {
    return { ok: false, error: "Non-JSON reply from agentChat", details: text };
  }
  return json;
}

// ----- Main action -----
async function runTradeAgent() {
  addMsg("assistant", "Loading state…");
  try {
    const state = await fetchState();
    setLastAssistantText("Generating plan…");

    const data = await callAgentWithState(state);

    if (data?.ok && data?.plan) {
      const safe = data.plan.replace(/[&<>]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c]));
      setLastAssistantText(""); // clear the "Generating..." bubble
      addMsg("assistant", safe.includes("\n") ? safe : `\n${safe}`);
    } else {
      const msg = `⚠️ ${data?.error || "Unknown error"}`
        + (data?.details ? `\n\n${String(data.details).slice(0,400)}` : "");
      setLastAssistantText(""); 
      addMsg("assistant", msg);
    }
  } catch (err) {
    setLastAssistantText(""); 
    addMsg("assistant", `⚠️ ${err?.message || "Error contacting Agent"}`);
  }
}

runBtn?.addEventListener("click", runTradeAgent);

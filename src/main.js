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

// === EXACT OUTPUT CONTRACT (matches your example) ===
const OUTPUT_CONTRACT = `
You are Brokerage Trade Agent. Use EXACTLY this structure and headings. Keep bullets concise. 
If you lack real-time prices/flows, write N/A (do not invent). Use the provided state JSON only.

📊 Market Pulse (Summary)

(Performance vs. relevant index — 🟢 outperform · 🟡 in line · 🔴 lagging)

<One line per ticker from positions + watchlist + research. Use benchmarks map to name the index/ETF.>

Summary: 🟢 <count> outperforming · 🟡 <count> in line · 🔴 <count> lagging

💵 Cash Deployment Tracker

Brokerage sleeve value: ~$<amount>
Cash available: ~$<amount> (~<%>)
Invested: ~$<amount> (~<%>)
Active triggers today (strict): <None or list>
Playbook: <one line rule of engagement>

1) Portfolio Snapshot — Owned Positions
<For each positions[] entry, render exactly like the example: 
TICKER — <🟢/🟡/🔴> $<price or N/A> | Sentiment: <Bullish/Neutral/Bearish or N/A> [⏸️ HOLD unless strong triggers]
• Position: <qty> @ <avg> | P/L <+x.x% or N/A>
• Flow: <brief or N/A>
• Resistance: <range or N/A>
• Breakout watch: ><level> → <targets or N/A>
• Idea: <short rule from notes if present>

2) Entry Radar — Watchlist (No positions yet)
<Same formatting for watchlist[]>

3) Research — Bullish Sector Picks
<Same formatting for research[]>

✅ Strict trigger logic applied.
👉 Today: <If nothing fires, say “No BUY/SELL triggers fired. All names remain [⏸️ HOLD].”>
`;

function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  chat.appendChild(div);
  window.scrollTo({ top: document.body.scrollHeight });
}

async function fetchState() {
  const r = await fetch("/.netlify/functions/tradeState");
  if (!r.ok) throw new Error(`tradeState HTTP ${r.status}`);
  const j = await r.json();
  // API returns { ok:true, state:{...} }
  return j.state || {};
}

async function runTradeAgent() {
  addMsg("assistant", "Loading state…");
  try {
    const state = await fetchState();
    const last = chat.querySelector(".msg.assistant:last-child .bubble");
    last.textContent = "Generating plan…";

    const messages = [
      { role: "system", content: OUTPUT_CONTRACT },
      {
        role: "user",
        content:
          "Here is my current trading state as JSON. Use ONLY this to populate the sections exactly as specified:\n\n" +
          JSON.stringify(state)
      }
    ];

    const res = await fetch("/.netlify/functions/agentChat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        temperature: 0.2,
        max_tokens: 2200
      })
    });

    const data = await res.json();
    last.textContent = data.reply || "[empty reply]";
  } catch (err) {
    const last = chat.querySelector(".msg.assistant:last-child .bubble");
    last.textContent = "Error: " + (err?.message || "contacting Agent");
  }
}

runBtn?.addEventListener("click", runTradeAgent);

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

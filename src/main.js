// PWA SW
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

const chat = document.getElementById("chat");
const runBtn = document.getElementById("runBtn");
const installBtn = document.getElementById("installBtn");

let deferredPrompt;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.style.display = "inline-flex";
});
installBtn?.addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBtn.style.display = "none";
});

// === STRICT OUTPUT CONTRACT (matches your example) ===
const TRADE_OUTPUT_SYSTEM = `
You are Brokerage Trade Agent. Produce output in EXACTLY this structure and order, using concise bullets.
If data is unknown, write N/A. Do not invent prices or flows.

📊 Market Pulse (Summary)

(Performance vs. relevant index — 🟢 outperform · 🟡 in line · 🔴 lagging)

<one bullet per ticker in this exact style>
AMZN (Nasdaq) 🟡 — in line with Nasdaq, modest gains.
NVDA (Nasdaq) 🟢 — outperforming Nasdaq, holding above $180.
MSFT (Nasdaq) 🔴 — lagging Nasdaq, slipping below $510.
KTOS (Defense / ITA) 🟢 — stronger than ITA ETF, above $68.
LRCX (Semis / SOX) 🟢 — outperforming SOX, trading >$103.
PLTR (Nasdaq) 🟡 — in line with Nasdaq, around $157–158.
CRWV (AI infra small-cap) 🔴 — lagging sector peers.
BMNR (Speculative / R2K) 🔴 — weaker vs Russell 2000.
AVAV (Defense / ITA) 🟡 — tracking ITA ETF, steady near $248.
AVGO (Semis / SOX) 🟢 — strong breakout tone near $310.
CRDO (Semis / SOX) 🟢 — outperforming SOX, >$122.

Summary: 🟢 <count> outperforming · 🟡 <count> in line · 🔴 <count> lagging

💵 Cash Deployment Tracker

Brokerage sleeve value: ~$<amount>
Cash available: ~$<amount> (~<%>)
Invested: ~$<amount> (~<%>)
Active triggers today (strict): <None or list>
Playbook: <one line rule of engagement>

1) Portfolio Snapshot — Owned Positions

<TICKER> — <🟢/🟡/🔴> $<price> | Sentiment: <Bullish/Neutral/Bearish> [⏸️ HOLD or ✅ BUY or ❌ SELL]
• Position: <qty> @ <avg> | P/L <+x.x% or −x.x%>
• Flow: <brief, N/A if unknown>
• Resistance: <range or N/A>
• Breakout watch: ><level> → <targets or N/A>
• Idea: <short rule>

(Repeat for each owned position.)

2) Entry Radar — Watchlist (No positions yet)

<TICKER> — <🟢/🟡/🔴> $<price> | Sentiment: <...> [⏸️ HOLD]
• Watch price: $<price> (<Month Day, Year>)
• Flow: <brief, N/A if unknown>
• Resistance: <range or N/A>
• Breakout watch: ><level> → <targets or N/A>
• Idea: <short rule>

(Repeat as needed.)

3) Research — Bullish Sector Picks

<TICKER> — <🟢/🟡/🔴> $<price> | Sentiment: <...> [⏸️ HOLD]
• Watch price: $<price> (<Month Day, Year>)
• Flow: <brief, N/A if unknown>
• Resistance: <range or N/A>
• Breakout watch: ><level> → <targets or N/A>
• Idea: <short rule>

(Repeat as needed.)

✅ Strict trigger logic applied.
👉 Today: <No BUY/SELL triggers fired. All names remain [⏸️ HOLD].>
`;

// helper
function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  chat.appendChild(div);
  window.scrollTo({ top: document.body.scrollHeight });
}

async function runTradeAgent() {
  addMsg("assistant", "Running Trade Agent…");
  try {
    const res = await fetch("/.netlify/functions/agentChat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system: TRADE_OUTPUT_SYSTEM,
        messages: [
          {
            role: "user",
            content:
              "Generate today’s plan using the exact structure above. If you lack real-time prices, use N/A for prices and flows. Keep all headings/emojis and the Summary line."
          }
        ],
        temperature: 0.2,
        max_tokens: 1800
      })
    });
    const data = await res.json();
    const last = chat.querySelector(".msg.assistant:last-child .bubble");
    last.textContent = data.reply || "[empty reply]";
  } catch (err) {
    const last = chat.querySelector(".msg.assistant:last-child .bubble");
    last.textContent = "Error contacting Agent.";
  }
}

runBtn.addEventListener("click", runTradeAgent);

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

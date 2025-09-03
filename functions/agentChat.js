// functions/agentChat.js
// Netlify Function: accepts { state } and returns { ok:true, plan } in your exact format.

const crypto = require("crypto");

exports.handler = async (event) => {
  const rid = (crypto.randomUUID?.() || Math.random().toString(36).slice(2));
  const t0 = Date.now();
  const T = () => Date.now() - t0;
  const log = (stage, extra = {}) =>
    console.log(JSON.stringify({ fn: "agentChat", rid, t: T(), stage, ...extra }));

  log("start", {
    method: event.httpMethod,
    hasOPENAI: !!process.env.OPENAI_API_KEY,
    contentType: event.headers?.["content-type"],
    bodyBytes: event.body ? event.body.length : 0
  });

  try {
    if (event.httpMethod !== "POST") {
      log("bad-method", { method: event.httpMethod });
      return resp(405, { ok: false, error: "Method Not Allowed. Use POST." }, rid);
    }

    let payload = {};
    try { payload = JSON.parse(event.body || "{}"); }
    catch (e) { log("json-parse-error", { message: e.message }); return resp(400, { ok:false, error:"Invalid JSON body" }, rid); }

    // Probe path used by curl ping
    if (payload.ping === "test") {
      log("probe-ok");
      return resp(200, { ok:true, echo: payload }, rid);
    }

    const state = payload.state;
    if (!state || typeof state !== "object") {
      log("no-state");
      return resp(400, { ok:false, error:"Missing 'state' in request body" }, rid);
    }

    const posCount = Array.isArray(state.positions) ? state.positions.length : 0;
    const wlCount  = Array.isArray(state.watchlist) ? state.watchlist.length : 0;
    const rsCount  = Array.isArray(state.research)  ? state.research.length  : 0;
    log("state", { posCount, wlCount, rsCount, hasCash: !!state.cash });

    if (!process.env.OPENAI_API_KEY) {
      log("no-openai");
      return resp(500, { ok:false, error:"Server not configured (missing OPENAI_API_KEY)" }, rid);
    }

    // ---------- Strict Format Prompt ----------
    const prompt = `
You are a Brokerage Trade Agent. Using the provided STATE JSON, generate TODAY’S PLAN **strictly in this exact format**. 
Use the same emojis, icons, section names, and line breaks. Do not add extra sections or headings. 
Do not emit Markdown tables. Use simple Markdown with bullets and paragraphs.

FORMAT (copy the structure exactly; replace sample numbers with values inferred from STATE):
📊 Market Pulse (Summary)

(Performance vs. relevant index — 🟢 outperform · 🟡 in line · 🔴 lagging)

<One line per ticker; do NOT combine multiple tickers on one line. 
After each ticker line, insert a hard Markdown line break (two spaces then newline).>
Ex:
AMZN (Nasdaq) 🟡 — in line with Nasdaq, modest gain.  
NVDA (Nasdaq) 🟢 — outperforming Nasdaq, steady above $180.  
MSFT (Nasdaq) 🔴 — lagging Nasdaq, stuck below $510.  
KTOS (Defense / ITA) 🟢 — outperforming ITA ETF, holding ~$68.  
LRCX (Semis / SOX) 🟢 — stronger than SOX, trading >$103.  
PLTR (Nasdaq) 🟡 — moving with Nasdaq around $157.  
CRWV (AI infra small-cap) 🔴 — lagging peers.  
BMNR (Speculative / R2K) 🔴 — underperforming Russell 2000.  
AVAV (Defense / ITA) 🟡 — in line with ITA ETF, stable ~$241.  
AVGO (Semis / SOX) 🟢 — outperforming SOX, climbing toward $300.  
CRDO (Semis / SOX) 🟢 — outperforming SOX, firm above $122.  

Summary: 🟢 5 outperforming · 🟡 3 in line · 🔴 3 lagging

💵 Cash Deployment Tracker

Brokerage sleeve total value: ≈ $115,000
Cash available: $43,647.89 (38%)
Invested (stocks): ≈ $71,350 (62%)
Active triggers today (strict): None
Playbook: Healthy 38% cash buffer. Deploy $5–10k per conviction setup on breakouts or dips; keep flexibility with high cash ratio.

1) Portfolio Snapshot — Owned Positions

<One block per STATE.positions ticker; keep the same bullet names/emojis.>
AMZN — 🟡 $231.7 | Sentiment: Bullish 🐂 [⏸️ HOLD]
• Position: 75 @ 212.22 | P/L +9.2%
• Flow: Balanced; no sweeps today.
• Resistance: 235–240
• Breakout watch: >240 → 245–250
• Idea: Hold—enter only on confirmed breakout.

…repeat for each owned ticker…

2) Entry Radar — Watchlist (No positions yet)

…one block per STATE.watchlist ticker, same style (watch price optional)…

3) Research — Bullish Sector Picks

…one block per STATE.research ticker, same style…

RULES:
- Keep tickers/benchmarks consistent with STATE (benchmarks map is provided).
- Use percentages like "(38%)" — do NOT use "~" which can render as strikethrough.
- For Market Pulse, ALWAYS put a hard line break after each ticker line ("two spaces + newline").
- Keep sections separated by a blank line. 
- No extra commentary before/after the format.

STATE JSON:
${JSON.stringify(state)}
`.trim();

    log("prompt-built", { promptLen: prompt.length });

    // Call OpenAI
    let upstream;
    try {
      upstream = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
        }),
      });
    } catch (e) {
      log("openai-network-error", { message: e.message });
      return resp(502, { ok:false, error:"Upstream network error to OpenAI" }, rid);
    }

    const raw = await upstream.text();
    log("openai-response", { status: upstream.status, bodyLen: raw.length });

    if (!upstream.ok) {
      return resp(502, { ok:false, error:`OpenAI error ${upstream.status}`, details: raw.slice(0, 500) }, rid);
    }

    let plan = "";
    let usage;
    try {
      const data = JSON.parse(raw);
      plan  = data?.choices?.[0]?.message?.content || "";
      usage = data?.usage;
    } catch { plan = raw; }

    if (!plan || !plan.trim()) {
      log("empty-plan");
      return resp(200, { ok:false, error:"Empty plan from model" }, rid);
    }

    log("done", { planLen: plan.length });
    return resp(200, { ok:true, plan, meta: { rid, usage } }, rid);

  } catch (err) {
    log("unhandled", { message: err.message });
    return resp(500, { ok:false, error:"Server error" }, rid);
  }
};

function resp(statusCode, body, rid) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "x-rid": rid },
    body: JSON.stringify(body),
  };
}

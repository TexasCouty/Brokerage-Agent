// functions/agentChat.js
const crypto = require('crypto');

exports.handler = async (event) => {
  const rid = (crypto.randomUUID?.() || Math.random().toString(36).slice(2));
  const t0 = Date.now();
  const T = () => Date.now() - t0;
  const log = (stage, extra = {}) => {
    console.log(JSON.stringify({ fn: "agentChat", rid, t: T(), stage, ...extra }));
  };

  log("start", {
    method: event.httpMethod,
    hasOPENAI: !!process.env.OPENAI_API_KEY,
    contentType: event.headers?.["content-type"],
    bodyBytes: event.body ? event.body.length : 0
  });

  try {
    if (event.httpMethod !== "POST") {
      log("bad-method", { method: event.httpMethod });
      return {
        statusCode: 405,
        headers: { "content-type": "application/json", "x-rid": rid },
        body: JSON.stringify({ ok: false, error: "Method Not Allowed. Use POST." })
      };
    }

    // Parse body
    let payload = {};
    try {
      payload = JSON.parse(event.body || "{}");
    } catch (e) {
      log("json-parse-error", { message: e.message });
      return {
        statusCode: 400,
        headers: { "content-type": "application/json", "x-rid": rid },
        body: JSON.stringify({ ok: false, error: "Invalid JSON body" })
      };
    }
    log("parsed", { keys: Object.keys(payload) });

    // Probe path (what your curl “ping” uses)
    if (payload.ping === "test") {
      log("probe-ok");
      return {
        statusCode: 200,
        headers: { "content-type": "application/json", "x-rid": rid },
        body: JSON.stringify({ ok: true, echo: payload })
      };
    }

    // Expect the UI to pass state from tradeState (per README’s flow)
    const state = payload.state;
    if (!state || typeof state !== "object") {
      log("no-state");
      return {
        statusCode: 400,
        headers: { "content-type": "application/json", "x-rid": rid },
        body: JSON.stringify({ ok: false, error: "Missing 'state' in request body" })
      };
    }

    // State stats (no secrets)
    const posCount = Array.isArray(state.positions) ? state.positions.length : 0;
    const wlCount  = Array.isArray(state.watchlist) ? state.watchlist.length : 0;
    const rsCount  = Array.isArray(state.research)  ? state.research.length  : 0;
    log("state", { posCount, wlCount, rsCount, hasCash: !!state.cash });

    if (!process.env.OPENAI_API_KEY) {
      log("no-openai");
      return {
        statusCode: 500,
        headers: { "content-type": "application/json", "x-rid": rid },
        body: JSON.stringify({ ok: false, error: "Server not configured (missing OPENAI_API_KEY)" })
      };
    }

    // Build prompt (concise, with strict sections the README lists)
const prompt = `
You are a Brokerage Trade Agent. Using the provided STATE JSON, generate today’s plan **strictly in the exact format below**. 
Do not include explanations or extra sections. Use the same emojis, icons, and section names exactly as shown.

FORMAT RULES:
- After each stock summary in 📊 Market Pulse, insert a hard line break (two spaces + newline in Markdown).
- Do not combine multiple tickers on one line.
- Use the exact emoji/icons as shown.
- Keep each section separated by blank lines for readability.

FORMAT (follow literally):

📊 Market Pulse (Summary)

(Performance vs. relevant index — 🟢 outperform · 🟡 in line · 🔴 lagging)

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
Cash available: $43,647.89 (~38%)
Invested (stocks): ≈ $71,350 (~62%)
Active triggers today (strict): None
Playbook: Healthy 38% cash buffer. Deploy $5–10k per conviction setup on breakouts or dips; keep flexibility with high cash ratio.

1) Portfolio Snapshot — Owned Positions

(Write one block per ticker in the same style:)

AMZN — 🟡 $231.7 | Sentiment: Bullish 🐂 [⏸️ HOLD]
• Position: 75 @ 212.22 | P/L +9.2%
• Flow: Balanced; no sweeps today.
• Resistance: 235–240
• Breakout watch: >240 → 245–250
• Idea: Hold—enter only on confirmed breakout.

… repeat for each ticker in STATE.positions …

2) Entry Radar — Watchlist (No positions yet)

… repeat in the same style for STATE.watchlist …

3) Research — Bullish Sector Picks

… repeat in the same style for STATE.research …

END FORMAT

STATE JSON:
${JSON.stringify(state)}
`;

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
      return {
        statusCode: 502,
        headers: { "content-type": "application/json", "x-rid": rid },
        body: JSON.stringify({ ok: false, error: "Upstream network error to OpenAI" })
      };
    }

    const raw = await upstream.text();
    log("openai-response", { status: upstream.status, bodyLen: raw.length });

    if (!upstream.ok) {
      return {
        statusCode: 502,
        headers: { "content-type": "application/json", "x-rid": rid },
        body: JSON.stringify({
          ok: false,
          error: `OpenAI error ${upstream.status}`,
          details: raw.slice(0, 500)
        })
      };
    }

    // Extract plan string
    let plan = "";
    let usage = undefined;
    try {
      const data = JSON.parse(raw);
      plan  = data?.choices?.[0]?.message?.content || "";
      usage = data?.usage;
    } catch {
      plan = raw; // fallback if upstream text is plain
    }

    if (!plan || !plan.trim()) {
      log("empty-plan");
      return {
        statusCode: 200,
        headers: { "content-type": "application/json", "x-rid": rid },
        body: JSON.stringify({ ok: false, error: "Empty plan from model" })
      };
    }

    log("done", { planLen: plan.length });
    return {
      statusCode: 200,
      headers: { "content-type": "application/json", "x-rid": rid },
      body: JSON.stringify({ ok: true, plan, meta: { rid, usage } })
    };
  } catch (err) {
    log("unhandled", { message: err.message });
    return {
      statusCode: 500,
      headers: { "content-type": "application/json", "x-rid": rid },
      body: JSON.stringify({ ok: false, error: "Server error" })
    };
  }
};

// functions/agentChat.js
// Netlify Function (v1). Pro plan friendly (25s).
// DATA-FIRST: returns structured JSON { ok, data } for OWNED positions only.
// Falls back to { plan } if present, but the client now renders from data.
// Uses response_format: "json_object" for deterministic JSON.

const crypto = require("crypto");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";
const REQ_TIMEOUT_MS = 25000; // Netlify Pro ~26s cap
const MAX_TOKENS = 1100;

exports.handler = async (event) => {
  const rid = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
  const log = (stage, extra = {}) =>
    console.log(JSON.stringify({ fn: "agentChat", rid, stage, ...extra }));

  try {
    if (event.httpMethod !== "POST") {
      return j(405, { ok: false, error: "Method Not Allowed. Use POST." }, rid);
    }

    let payload = {};
    try { payload = JSON.parse(event.body || "{}"); }
    catch (e) { return j(400, { ok:false, error:"Invalid JSON body" }, rid); }

    if (payload.ping === "test") return j(200, { ok:true, echo: payload }, rid);

    const state = payload.state;
    if (!state || typeof state !== "object") {
      return j(400, { ok:false, error:"Missing 'state' in request body" }, rid);
    }
    if (!process.env.OPENAI_API_KEY) {
      return j(500, { ok:false, error:"Missing OPENAI_API_KEY" }, rid);
    }

    // Keep only what's needed (owned-only path)
    const sanitized = {
      cash: state.cash ?? null,
      benchmarks: state.benchmarks ?? null,
      positions: Array.isArray(state.positions) ? state.positions : [],
    };

    // --- Ask for DATA (not prose) ---
    const schema = {
      version: 1,
      market_pulse: [
        // one per OWNED ticker
        // signal: "outperform" | "inline" | "lagging"
        // note: short sentence (no emojis)
        { ticker: "AMZN", benchmark: "QQQ", signal: "inline", note: "steady above $212" }
      ],
      cash_tracker: {
        sleeve_value: 115000,
        cash_available: 58000,
        invested: 57000,
        active_triggers: [], // array of short strings derived ONLY from owned tickers
        playbook: "1–2 concise sentences"
      },
      portfolio_snapshot: [
        {
          ticker: "AMZN",
          status: "HOLD",            // HOLD | BUY | TRIM
          sentiment: "Bullish",      // Bullish | Neutral | Bearish
          price: 212.22,             // number or null if unknown
          position: { qty: 75, avg: 212.22 },
          pl_pct: null,              // number or null ("P/L %", not required)
          flow: "Neutral",           // short string
          resistance: "235–240",     // string or null
          breakout_watch: { gt: 240, targets: [245, 250] }, // or null
          idea: "short actionable line"
        }
      ]
    };

    const system = `
You are a Brokerage Trade Agent that returns structured DATA ONLY (no prose).
CRITICAL RULES:
- Return ONLY a single JSON object adhering to the provided SCHEMA. No markdown, no code fences, no extra fields.
- Only include OWNED tickers (from STATE.positions). Ignore watchlist/research/not-owned.
- Keep strings concise. Use numbers where appropriate (price, percentages, etc.).
- If a field is unknown, use null (not "n/a").
`.trim();

    const user = `
STATE:
${JSON.stringify(sanitized)}

SCHEMA (shape + example values; follow keys and types, not the example content):
${JSON.stringify(schema, null, 2)}

Return ONLY one JSON object matching the SCHEMA. Do not add extra fields. Do not include commentary.
`.trim();

    const { ok, data, error } = await openAIJSON({ system, user, log });
    if (!ok) return j(502, { ok:false, error: error || "Upstream error", meta:{ rid } }, rid);

    // Minimal sanity check
    const d = data;
    if (!d || typeof d !== "object" || !Array.isArray(d.market_pulse) || !Array.isArray(d.portfolio_snapshot)) {
      return j(502, { ok:false, error:"Model returned unexpected shape", meta:{ rid } }, rid);
    }

    // Done — data-first
    return j(200, { ok:true, data: d, meta:{ rid } }, rid);

  } catch (err) {
    console.error("[agentChat] fatal", err);
    return j(500, { ok:false, error:"Server error" }, rid);
  }
};

function j(statusCode, body, rid) {
  return { statusCode, headers: { "content-type": "application/json", "x-rid": rid }, body: JSON.stringify(body) };
}

async function openAIJSON({ system, user, log }) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQ_TIMEOUT_MS);

    const resp = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: 0,
        top_p: 0.1,
        response_format: { type: "json_object" },
        max_tokens: MAX_TOKENS,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    const text = await resp.text();
    log?.("openai-response", { status: resp.status, bytes: text.length });

    if (!resp.ok) return { ok: false, error: `OpenAI error ${resp.status}`, text };

    // Outer OpenAI envelope
    let outer;
    try { outer = JSON.parse(text); } catch {
      return { ok: false, error: "Upstream envelope not JSON", text: text.slice(0, 400) };
    }

    let content = outer?.choices?.[0]?.message?.content;

    // Fast path: already an object
    if (content && typeof content === "object") {
      if (content.version == null) content.version = 1;
      return { ok: true, data: content };
    }

    // Common path: string that should be JSON
    if (typeof content === "string") {
      // 1) direct parse
      try {
        const obj = JSON.parse(content);
        if (obj && typeof obj === "object") {
          if (obj.version == null) obj.version = 1;
          return { ok: true, data: obj };
        }
      } catch (_) {}

      // 2) fenced ```json ... ```
      const fence = content.match(/```json\s*([\s\S]*?)```/i) || content.match(/```\s*([\s\S]*?)```/);
      if (fence) {
        try {
          const obj = JSON.parse(fence[1]);
          if (obj && typeof obj === "object") {
            if (obj.version == null) obj.version = 1;
            return { ok: true, data: obj };
          }
        } catch (_) {}
      }

      // 3) first { ... } blob (loose)
      const firstBrace = content.indexOf("{");
      if (firstBrace !== -1) {
        // naive scan to the last closing brace
        const lastBrace = content.lastIndexOf("}");
        if (lastBrace > firstBrace) {
          const maybe = content.slice(firstBrace, lastBrace + 1);
          try {
            const obj = JSON.parse(maybe);
            if (obj && typeof obj === "object") {
              if (obj.version == null) obj.version = 1;
              return { ok: true, data: obj };
            }
          } catch (_) {}
        }
      }

      // Couldn’t coerce — return error with preview so UI can show it
      return { ok: false, error: "Assistant content was not JSON object", text: content.slice(0, 400) };
    }

    // Unexpected shape
    return { ok: false, error: "Assistant content missing or invalid", text: String(content).slice(0, 400) };

  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "OpenAI request timed out" : e.message };
  }
}
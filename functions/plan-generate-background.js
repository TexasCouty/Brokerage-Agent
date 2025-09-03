// functions/plan-generate-background.js
const crypto = require("crypto");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";
const TIME_A_MS = 20000;   // more generous in background
const TIME_B_MS = 20000;
const MAX_TOKENS = 900;

exports.handler = async (event, context) => {
  const rid = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
  const log = (stage, extra={}) => console.log(JSON.stringify({ fn:"planGenerate", rid, stage, ...extra }));

  try {
    if (event.httpMethod !== "POST") {
      return j(405, { ok:false, error:"Use POST" }, rid);
    }
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {
      return j(400, { ok:false, error:"Invalid JSON body" }, rid);
    }
    const { hash, state } = body;
    if (!hash || !state) return j(400, { ok:false, error:"Missing hash/state" }, rid);
    const key = `plans:v1:${hash}`;

    const { getStore } = await import("@netlify/blobs");
    const store = getStore({ name: "brokerage-plans" });

    // idempotency: if ready, exit; if not present, set running
    const current = await store.get(key, { type: "json" });
    if (current?.status === "ready") {
      log("already-ready", { hash });
      return j(202, { ok:true, status:"ready", hash }, rid);
    }
    await store.set(key, JSON.stringify({ status:"running", ts: Date.now(), rid }));

    // sanitize state
    const sanitized = {
      cash: state.cash ?? null,
      benchmarks: state.benchmarks ?? null,
      positions: Array.isArray(state.positions) ? state.positions : [],
    };

    // ---- Stage A
    const a = await callOpenAI({
      timeoutMs: TIME_A_MS,
      system: systemMsg(),
      user: primaryPrompt(sanitized),
      log
    });

    let chosen = a;
    if (!a.ok) {
      log("stageA-fail", { error: a.error });
    } else {
      const normalizedA = coerceToSchema(a.data, sanitized);
      const validA = validateShape(normalizedA);
      if (validA) chosen = { ok:true, data: validA, usage: a.usage };
      else log("invalid-shape-A");
    }

    // ---- Stage B if needed
    if (!chosen.ok) {
      const critique = a.ok ? explainInvalid(a.data) : a.error || "timeout-or-parse-failure";
      const b = await callOpenAI({
        timeoutMs: TIME_B_MS,
        system: systemMsg(true),
        user: correctivePrompt(sanitized, critique),
        log
      });
      if (b.ok) {
        const normalizedB = coerceToSchema(b.data, sanitized);
        const validB = validateShape(normalizedB);
        if (validB) chosen = { ok:true, data: validB, usage: b.usage };
        else chosen = { ok:false, error:"Validation failed after retry", preview: b.preview };
      } else {
        chosen = b;
      }
    }

    if (chosen.ok) {
      await store.set(key, JSON.stringify({ status:"ready", data: chosen.data, ts: Date.now(), rid }));
      log("done", { hash });
      return j(202, { ok:true, status:"ready", hash }, rid);
    }

    await store.set(key, JSON.stringify({ status:"error", error: chosen.error || "Upstream error", preview: chosen.preview || "", ts: Date.now(), rid }));
    return j(202, { ok:false, error: chosen.error || "Upstream error", hash }, rid);

  } catch (e) {
    console.error("[planGenerate] fatal", e);
    return j(500, { ok:false, error:"Server error" }, rid);
  }
};

function j(statusCode, body, rid) {
  // Background functions return immediately; 202 recommended
  return { statusCode, headers: { "content-type":"application/json", "x-rid": rid }, body: JSON.stringify(body) };
}

/* ---------- prompts + LLM caller + coercion/validation ---------- */

function systemMsg(strictNoProse = false) {
  return `You are a Brokerage Trade Agent that returns structured DATA ONLY.

RULES:
- Return ONLY one JSON object (no prose, no code fences, no preface).
- Keys and types must match the schema. Unknown values: null.
- Include OWNED tickers ONLY (from STATE.positions).${strictNoProse ? " DO NOT include any text outside the JSON." : ""}`;
}

function primaryPrompt(state) {
  return `
STATE (owned only):
${JSON.stringify(state)}

SCHEMA (names + types):
{
  "version": number,
  "market_pulse": [
    { "ticker": string, "benchmark": string, "signal": "outperform"|"inline"|"lagging", "note": string }
  ],
  "cash_tracker": {
    "sleeve_value": number|null,
    "cash_available": number|null,
    "invested": number|null,
    "active_triggers": string[],
    "playbook": string
  },
  "portfolio_snapshot": [
    {
      "ticker": string,
      "status": "HOLD"|"BUY"|"TRIM",
      "sentiment": "Bullish"|"Neutral"|"Bearish",
      "price": number|null,
      "position": { "qty": number|null, "avg": number|null },
      "pl_pct": number|null,
      "flow": string,
      "resistance": string|null,
      "breakout_watch": { "gt": number|null, "targets": number[] }|null,
      "idea": string
    }
  ]
}

Return ONLY one JSON object matching the SCHEMA. version = 1.
`.trim();
}

function correctivePrompt(state, critique) {
  return `
Previous reply invalid: ${critique}
Fix it now. Return ONLY one JSON object matching the schema. No prose; unknowns are null. version = 1.

STATE:
${JSON.stringify(state)}

SCHEMA: (same as before)
`.trim();
}

async function callOpenAI({ timeoutMs, system, user, log }) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const resp = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type":"application/json",
        "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role:"system", content: system }, { role:"user", content: user }],
        temperature: 0,
        top_p: 0.1,
        response_format: { type: "json_object" },
        max_tokens: MAX_TOKENS,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    const envelope = await resp.text();
    log("openai-envelope", { status: resp.status, bytes: envelope.length, preview: envelope.slice(0, 300) });

    if (!resp.ok) return { ok:false, error:`OpenAI error ${resp.status}`, preview: envelope.slice(0, 300) };

    let outer; try { outer = JSON.parse(envelope); } catch { return { ok:false, error:"Envelope not JSON", preview: envelope.slice(0, 300) }; }
    let content = outer?.choices?.[0]?.message?.content;
    const usage = outer?.usage;
    const preview = typeof content === "string" ? content.slice(0, 300) : JSON.stringify(content||"").slice(0, 300);
    log("assistant-preview", { kind: typeof content, preview });

    if (content && typeof content === "object") return { ok:true, data: content, usage, preview };

    if (typeof content === "string") {
      try {
        const obj = JSON.parse(content);
        if (obj && typeof obj === "object") return { ok:true, data: obj, usage, preview };
      } catch {}
      const fence = content.match(/```json\s*([\s\S]*?)```/i) || content.match(/```\s*([\s\S]*?)```/);
      if (fence) {
        try { const obj = JSON.parse(fence[1]); if (obj && typeof obj === "object") return { ok:true, data: obj, usage, preview }; } catch {}
      }
      const first = content.indexOf("{"); const last = content.lastIndexOf("}");
      if (first !== -1 && last > first) {
        try { const obj = JSON.parse(content.slice(first, last + 1)); if (obj && typeof obj === "object") return { ok:true, data: obj, usage, preview }; } catch {}
      }
      return { ok:false, error:"Assistant content was not JSON object", preview };
    }
    return { ok:false, error:"Assistant content missing or invalid", preview };
  } catch (e) {
    return { ok:false, error: e.name === "AbortError" ? "OpenAI request timed out" : e.message };
  }
}

// ---- coercion/validation (smarter defaults from notes/sentiment) ----
function coerceToSchema(obj, state) {
  const out = (obj && typeof obj === "object") ? { ...obj } : {};
  const positionsIn = Array.isArray(out.positions) ? out.positions
                    : (Array.isArray(state.positions) ? state.positions : []);
  const benchmarks = state.benchmarks || {};
  const cash = state.cash || {};

  const numOrNull = v => Number.isFinite(Number(v)) ? Number(v) : null;
  const mapSentiment = s => {
    s = String(s || "").toLowerCase();
    if (s.startsWith("bull")) return "Bullish";
    if (s.startsWith("bear")) return "Bearish";
    return "Neutral";
  };
  const mapStatusFromText = tx => {
    tx = String(tx || "").toLowerCase();
    if (/\b(trim|reduce|sell|take\s*profit)\b/.test(tx)) return "TRIM";
    if (/\b(add|buy|enter|scale\s*in)\b/.test(tx)) return "BUY";
    return "HOLD";
  };
  const mapStatus = s => {
    s = String(s || "").toUpperCase();
    if (s.includes("BUY")) return "BUY";
    if (s.includes("TRIM") || s.includes("SELL")) return "TRIM";
    return "HOLD";
  };
  function parseLevels(notes) {
    const n = String(notes || "");
    let resistance = null;
    const range = n.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/);
    if (range) resistance = `${range[1]}–${range[2]}`;
    let gt = null;
    const m1 = n.match(/>\s*(\d+(?:\.\d+)?)/);
    const m2 = n.match(/(?:above|over|break(?:s)?\s*(?:above|over))\s*(\d+(?:\.\d+)?)/i);
    if (m1) gt = Number(m1[1]); else if (m2) gt = Number(m2[1]);
    const targets = [];
    const t1 = n.match(/(?:to|->|→)\s*(\d+(?:\.\d+)?)/);
    if (t1) targets.push(Number(t1[1]));
    return { resistance, breakout_watch: gt != null ? { gt, targets } : null };
  }
  function pulseSignalFromSentiment(sent) {
    if (sent === "Bullish") return { signal: "outperform", note: "bullish setup" };
    if (sent === "Bearish") return { signal: "lagging", note: "under pressure" };
    return { signal: "inline", note: "holding steady" };
  }

  out.version = (typeof out.version === "number") ? out.version : 1;

  if (!Array.isArray(out.portfolio_snapshot)) {
    out.portfolio_snapshot = positionsIn.map(p => {
      const ticker = String(p.ticker || "").toUpperCase();
      const sentiment = mapSentiment(p.sentiment);
      const levels = parseLevels(p.notes);
      const statusText = mapStatusFromText(p.notes);
      return {
        ticker,
        status: mapStatus(p.status || statusText),
        sentiment,
        price: p.price != null ? numOrNull(p.price) : null,
        position: { qty: numOrNull(p.qty), avg: numOrNull(p.avg) },
        pl_pct: numOrNull(p.pl_pct),
        flow: p.flow || (sentiment === "Bullish" ? "Positive tilt" :
                         sentiment === "Bearish" ? "Cautious" : "Neutral"),
        resistance: levels.resistance,
        breakout_watch: levels.breakout_watch,
        idea: p.notes ? p.notes.trim() : ""
      };
    });
  } else {
    out.portfolio_snapshot = out.portfolio_snapshot.map(p => {
      const ticker = String(p.ticker || "").toUpperCase();
      const sentiment = mapSentiment(p.sentiment);
      const fromNotes = parseLevels(p.notes || p.idea);
      return {
        ticker,
        status: mapStatus(p.status || mapStatusFromText(p.notes || p.idea)),
        sentiment,
        price: numOrNull(p.price),
        position: { qty: numOrNull(p.position?.qty), avg: numOrNull(p.position?.avg) },
        pl_pct: numOrNull(p.pl_pct),
        flow: p.flow || (sentiment === "Bullish" ? "Positive tilt" :
                         sentiment === "Bearish" ? "Cautious" : "Neutral"),
        resistance: p.resistance ?? fromNotes.resistance ?? null,
        breakout_watch: p.breakout_watch ?? fromNotes.breakout_watch ?? null,
        idea: (p.idea || p.notes || "").trim()
      };
    });
  }

  if (!Array.isArray(out.market_pulse)) {
    out.market_pulse = out.portfolio_snapshot.map(ps => {
      const bench = String(benchmarks[ps.ticker] || "QQQ");
      const { signal, note } = pulseSignalFromSentiment(ps.sentiment);
      return { ticker: ps.ticker, benchmark: bench, signal, note };
    });
  }

  if (!out.cash_tracker || typeof out.cash_tracker !== "object") {
    const sleeve = numOrNull(cash.sleeve_value);
    const avail  = numOrNull(cash.cash_available);
    const invested = cash.invested != null ? numOrNull(cash.invested)
                    : (sleeve != null && avail != null ? Number(sleeve - avail) : null);

    const buyables = out.portfolio_snapshot.filter(p => p.status === "BUY").map(p => p.ticker);
    const playbook = buyables.length
      ? `Watch breakouts on ${buyables.join(", ")}; deploy only on confirmation.`
      : "Maintain flexibility; deploy on high-conviction breakouts only.";

    out.cash_tracker = {
      sleeve_value: sleeve,
      cash_available: avail,
      invested,
      active_triggers: [],
      playbook
    };
  }

  return out;
}

function validateShape(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (!Array.isArray(obj.market_pulse)) return null;
  if (!obj.cash_tracker || typeof obj.cash_tracker !== "object") return null;
  if (!Array.isArray(obj.portfolio_snapshot)) return null;
  return obj;
}
function explainInvalid(obj) {
  if (!obj || typeof obj !== "object") return "no JSON object";
  const miss = [];
  if (!Array.isArray(obj.market_pulse)) miss.push("missing market_pulse[]");
  if (!obj.cash_tracker) miss.push("missing cash_tracker{}");
  if (!Array.isArray(obj.portfolio_snapshot)) miss.push("missing portfolio_snapshot[]");
  return miss.length ? miss.join("; ") : "unknown shape issue";
}

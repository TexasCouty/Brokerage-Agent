// functions/agentChat.js
// Data-first JSON with 2-stage retry (12s + 12s), tolerant parsing, deep logging,
// AND schema coercion: if the model returns partial JSON (e.g., {positions:[...]}),
// we upgrade it to the full schema using tradeState.

const crypto = require("crypto");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

// ~26s total under Netlify Pro
const TIME_A_MS = 12000;
const TIME_B_MS = 12000;
const MAX_TOKENS = 900;

exports.handler = async (event) => {
  const rid = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
  const t0 = Date.now();
  const T = () => Date.now() - t0;
  const log = (stage, extra = {}) => {
    try { console.log(JSON.stringify({ fn: "agentChat", rid, t: T(), stage, ...extra })); } catch {}
  };

  try {
    if (event.httpMethod !== "POST") {
      return j(405, { ok:false, error:"Method Not Allowed. Use POST." }, rid);
    }

    let payload = {};
    try { payload = JSON.parse(event.body || "{}"); }
    catch { return j(400, { ok:false, error:"Invalid JSON body" }, rid); }

    if (payload.ping === "test") return j(200, { ok:true, echo: payload }, rid);

    const state = payload.state;
    if (!state || typeof state !== "object") {
      return j(400, { ok:false, error:"Missing 'state' in request body" }, rid);
    }
    if (!process.env.OPENAI_API_KEY) {
      return j(500, { ok:false, error:"Missing OPENAI_API_KEY" }, rid);
    }

    const sanitized = {
      cash: state.cash ?? null,
      benchmarks: state.benchmarks ?? null,
      positions: Array.isArray(state.positions) ? state.positions : [],
    };

    // ---------- Stage A
    const a = await callOpenAI({
      timeoutMs: TIME_A_MS,
      system: systemMsg(),
      user: primaryPrompt(sanitized),
      log
    });

    if (a.ok) {
      const normalizedA = coerceToSchema(a.data, sanitized);
      const validA = validateShape(normalizedA);
      if (validA) {
        log("ok-stageA", { mp: validA.market_pulse.length, ps: validA.portfolio_snapshot.length });
        return j(200, { ok:true, data: validA, meta:{ rid, usage: a.usage, stage:"A" } }, rid);
      }
      log("invalid-shape-A", { preview: a.preview?.slice?.(0,200) || "" });
    } else {
      log("stageA-fail", { error: a.error, preview: a.preview?.slice?.(0,200) || "" });
    }

    // ---------- Stage B (corrective)
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
      if (validB) {
        log("ok-stageB", { mp: validB.market_pulse.length, ps: validB.portfolio_snapshot.length });
        return j(200, { ok:true, data: validB, meta:{ rid, usage: b.usage, stage:"B" } }, rid);
      }
      log("invalid-shape-B", { preview: b.preview?.slice?.(0,200) || "" });
      return j(502, { ok:false, error:"Validation failed after retry", meta:{ rid, bodyPreview: b.preview || "" } }, rid);
    }

    return j(502, { ok:false, error: b.error || "Upstream error", meta:{ rid, bodyPreview: b.preview || "" } }, rid);

  } catch (err) {
    console.error("[agentChat] fatal", err);
    return j(500, { ok:false, error:"Server error", meta:{ rid } }, rid);
  }
};

/* ---------------- helpers ---------------- */

function j(statusCode, body, rid) {
  return { statusCode, headers: { "content-type":"application/json", "x-rid": rid }, body: JSON.stringify(body) };
}

function systemMsg(strictNoProse = false) {
  return `You are a Brokerage Trade Agent that returns structured DATA ONLY.

RULES:
- Return ONLY one JSON object (no prose, no code fences, no preface).
- Keys and types must match the schema. Unknown values: null.
- Include OWNED tickers ONLY (from STATE.positions).${strictNoProse ? " DO NOT include any text outside the JSON under any circumstance." : ""}`;
}

function primaryPrompt(state) {
  return `
STATE (owned only):
${JSON.stringify(state)}

SCHEMA (names + types, no examples):
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

Return ONLY one JSON object matching the SCHEMA. No extra fields. version = 1.
`.trim();
}

function correctivePrompt(state, critique) {
  return `
Previous reply invalid because: ${critique}.
FIX IT NOW.

Return ONLY a single JSON object matching the SCHEMA. No prose, no markdown, no code fences.
Unknowns must be null. Owned tickers only. version = 1.

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
    log("openai-envelope", { status: resp.status, bytes: envelope.length, preview: envelope.slice(0, 350) });

    if (!resp.ok) return { ok:false, error:`OpenAI error ${resp.status}`, preview: envelope.slice(0, 350) };

    let outer;
    try { outer = JSON.parse(envelope); }
    catch { return { ok:false, error:"Upstream envelope not JSON", preview: envelope.slice(0, 350) }; }

    let content = outer?.choices?.[0]?.message?.content;
    const usage = outer?.usage;

    const preview = typeof content === "string" ? content.slice(0, 350) : JSON.stringify(content || "").slice(0, 350);
    log("assistant-preview", { kind: typeof content, preview });

    if (content && typeof content === "object") {
      if (content.version == null) content.version = 1;
      return { ok:true, data: content, usage, preview };
    }
    if (typeof content === "string") {
      try {
        const obj = JSON.parse(content);
        if (obj && typeof obj === "object") {
          if (obj.version == null) obj.version = 1;
          return { ok:true, data: obj, usage, preview };
        }
      } catch {}
      const fence = content.match(/```json\s*([\s\S]*?)```/i) || content.match(/```\s*([\s\S]*?)```/);
      if (fence) {
        try {
          const obj = JSON.parse(fence[1]);
          if (obj && typeof obj === "object") {
            if (obj.version == null) obj.version = 1;
            return { ok:true, data: obj, usage, preview };
          }
        } catch {}
      }
      const first = content.indexOf("{");
      const last  = content.lastIndexOf("}");
      if (first !== -1 && last > first) {
        try {
          const obj = JSON.parse(content.slice(first, last + 1));
          if (obj && typeof obj === "object") {
            if (obj.version == null) obj.version = 1;
            return { ok:true, data: obj, usage, preview };
          }
        } catch {}
      }
      return { ok:false, error:"Assistant content was not JSON object", preview };
    }
    return { ok:false, error:"Assistant content missing or invalid", preview };
  } catch (e) {
    return { ok:false, error: e.name === "AbortError" ? "OpenAI request timed out" : e.message };
  }
}

/* ---------------- coercion + validation ---------------- */

// If the model returns partial JSON (e.g., {positions:[...]}), upgrade it to the full schema.
function coerceToSchema(obj, state) {
  const safe = (v, d) => (v === undefined ? d : v);
  const out = typeof obj === "object" && obj ? { ...obj } : {};

  // version
  out.version = typeof out.version === "number" ? out.version : 1;

  // portfolio_snapshot
  if (!Array.isArray(out.portfolio_snapshot)) {
    // try to derive from positions-like shape
    const pos = Array.isArray(out.positions) ? out.positions : (Array.isArray(state.positions) ? state.positions : []);
    out.portfolio_snapshot = pos.map(p => ({
      ticker: String(p.ticker || "").toUpperCase(),
      status: mapStatus(p.status || p.action || "HOLD"),
      sentiment: mapSentiment(p.sentiment || "Neutral"),
      price: p.price != null ? Number(p.price) : null,
      position: { qty: numOrNull(p.qty), avg: numOrNull(p.avg) },
      pl_pct: numOrNull(p.pl_pct),
      flow: p.flow || "Neutral",
      resistance: p.resistance || null,
      breakout_watch: p.breakout_watch ? normalizeBreakout(p.breakout_watch) : null,
      idea: p.idea || p.notes || ""
    }));
  } else {
    // ensure shape inside
    out.portfolio_snapshot = out.portfolio_snapshot.map(p => ({
      ticker: String(p.ticker || "").toUpperCase(),
      status: mapStatus(p.status || "HOLD"),
      sentiment: mapSentiment(p.sentiment || "Neutral"),
      price: numOrNull(p.price),
      position: { qty: numOrNull(p.position?.qty), avg: numOrNull(p.position?.avg) },
      pl_pct: numOrNull(p.pl_pct),
      flow: p.flow || "Neutral",
      resistance: p.resistance ?? null,
      breakout_watch: normalizeBreakout(p.breakout_watch),
      idea: p.idea || ""
    }));
  }

  // market_pulse
  if (!Array.isArray(out.market_pulse)) {
    const bench = state.benchmarks || {};
    out.market_pulse = (out.portfolio_snapshot || []).map(p => ({
      ticker: p.ticker,
      benchmark: String(bench[p.ticker] || "QQQ"),
      signal: "inline",
      note: "holding steady"
    }));
  }

  // cash_tracker
  if (!out.cash_tracker || typeof out.cash_tracker !== "object") {
    const c = state.cash || {};
    const sleeve = numOrNull(c.sleeve_value);
    const cash = numOrNull(c.cash_available);
    const invested = c.invested != null ? numOrNull(c.invested) : (sleeve != null && cash != null ? Number(sleeve - cash) : null);
    out.cash_tracker = {
      sleeve_value: sleeve,
      cash_available: cash,
      invested: invested,
      active_triggers: Array.isArray(out.active_triggers) ? out.active_triggers : [],
      playbook: typeof out.playbook === "string" ? out.playbook : ""
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
  if (!obj || typeof obj !== "object") return "no JSON object returned";
  const miss = [];
  if (!Array.isArray(obj.market_pulse)) miss.push("missing market_pulse[]");
  if (!obj.cash_tracker) miss.push("missing cash_tracker{}");
  if (!Array.isArray(obj.portfolio_snapshot)) miss.push("missing portfolio_snapshot[]");
  return miss.length ? miss.join("; ") : "unknown shape issue";
}

// ---- mappers ----
function mapStatus(s) {
  s = String(s || "").toUpperCase();
  if (s.includes("BUY")) return "BUY";
  if (s.includes("TRIM") || s.includes("SELL")) return "TRIM";
  return "HOLD";
}
function mapSentiment(s) {
  s = String(s || "").toLowerCase();
  if (s.startsWith("bull")) return "Bullish";
  if (s.startsWith("bear")) return "Bearish";
  return "Neutral";
}
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function normalizeBreakout(bw) {
  if (!bw) return null;
  const gt = numOrNull(bw.gt ?? bw.level);
  const targets = Array.isArray(bw.targets) ? bw.targets.map(numOrNull).filter(v => v != null) : [];
  if (gt == null && targets.length === 0) return null;
  return { gt, targets };
}

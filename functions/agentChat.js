// functions/agentChat.js
// Data-first JSON with 2-stage retry under Netlify Pro (~26s total).
// Stage A (12s): primary JSON prompt
// Stage B (12s): corrective prompt if A fails/invalid
// Tolerant JSON parsing + logging + bodyPreview for UI

const crypto = require("crypto");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

// Split the ~26s budget into two chances
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

    // Keep only what we need (OWNED only)
    const sanitized = {
      cash: state.cash ?? null,
      benchmarks: state.benchmarks ?? null,
      positions: Array.isArray(state.positions) ? state.positions : [],
    };

    // ---------- Stage A: primary JSON prompt (12s)
    const a = await callOpenAI({
      timeoutMs: TIME_A_MS,
      system: systemMsg(),
      user: primaryPrompt(sanitized),
      log
    });

    if (a.ok) {
      const data = validateShape(a.data);
      if (data) {
        log("ok-stageA", { mp: data.market_pulse.length, ps: data.portfolio_snapshot.length });
        return j(200, { ok:true, data, meta:{ rid, usage: a.usage, stage:"A" } }, rid);
      }
      log("invalid-shape-A", { preview: a.preview?.slice?.(0,200) || "" });
    } else {
      log("stageA-fail", { error: a.error, preview: a.preview?.slice?.(0,200) || "" });
    }

    // ---------- Stage B: corrective fallback (12s)
    const critique = a.ok ? explainInvalid(a.data) : a.error || "timeout-or-parse-failure";
    const b = await callOpenAI({
      timeoutMs: TIME_B_MS,
      system: systemMsg(true), // even stricter on no-prose
      user: correctivePrompt(sanitized, critique),
      log
    });

    if (b.ok) {
      const data = validateShape(b.data);
      if (data) {
        log("ok-stageB", { mp: data.market_pulse.length, ps: data.portfolio_snapshot.length });
        return j(200, { ok:true, data, meta:{ rid, usage: b.usage, stage:"B" } }, rid);
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

// ultra-short system message for JSON determinism
function systemMsg(strictNoProse = false) {
  return `You are a Brokerage Trade Agent that returns structured DATA ONLY.

RULES:
- Return ONLY one JSON object (no prose, no code fences, no preface).
- Keys and types must match the schema. Unknown values: null.
- Include OWNED tickers ONLY (from STATE.positions).${strictNoProse ? " DO NOT include any text outside the JSON under any circumstance." : ""}`;
}

// compact schema description (field names + types — no big examples)
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

Return ONLY one JSON object matching the SCHEMA. Do not add extra fields. version = 1.
`.trim();
}

// corrective prompt—short and forceful
function correctivePrompt(state, critique) {
  return `
Your previous reply was invalid because: ${critique}.

FIX IT:
- Return ONLY a single JSON object matching the SCHEMA below.
- No prose, no markdown, no code fences. If you cannot fill a value, use null.
- Include OWNED tickers only. version = 1.

STATE:
${JSON.stringify(state)}

SCHEMA:
(identical to the one previously provided)
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

    // Log assistant preview
    const preview = typeof content === "string" ? content.slice(0, 350) : JSON.stringify(content || "").slice(0, 350);
    log("assistant-preview", { kind: typeof content, preview });

    // Accept object or JSON string; tolerate fences/extra text by extracting first {...}
    if (content && typeof content === "object") {
      if (content.version == null) content.version = 1;
      return { ok:true, data: content, usage, preview };
    }
    if (typeof content === "string") {
      // a) direct
      try {
        const obj = JSON.parse(content);
        if (obj && typeof obj === "object") {
          if (obj.version == null) obj.version = 1;
          return { ok:true, data: obj, usage, preview };
        }
      } catch {}
      // b) fenced
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
      // c) first { ... } blob
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

// minimal validator -> returns normalized object or null
function validateShape(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (!Array.isArray(obj.market_pulse) || !Array.isArray(obj.portfolio_snapshot)) return null;
  const out = { ...obj };
  if (typeof out.version !== "number") out.version = 1;
  if (!out.cash_tracker || typeof out.cash_tracker !== "object") {
    out.cash_tracker = { sleeve_value: null, cash_available: null, invested: null, active_triggers: [], playbook: "" };
  }
  return out;
}

function explainInvalid(obj) {
  if (!obj || typeof obj !== "object") return "no JSON object returned";
  const miss = [];
  if (!Array.isArray(obj.market_pulse)) miss.push("missing market_pulse[]");
  if (!Array.isArray(obj.portfolio_snapshot)) miss.push("missing portfolio_snapshot[]");
  if (!obj.cash_tracker) miss.push("missing cash_tracker{}");
  return miss.length ? miss.join("; ") : "unknown shape issue";
}

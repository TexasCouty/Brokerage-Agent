// functions/agentChat.js
// Data-first. Adds deep logging + tolerant JSON extraction with previews.

const crypto = require("crypto");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";
const REQ_TIMEOUT_MS = 25000;
const MAX_TOKENS = 1100;

exports.handler = async (event) => {
  const rid = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
  const t0 = Date.now();
  const T = () => Date.now() - t0;
  const log = (stage, extra = {}) => {
    try { console.log(JSON.stringify({ fn: "agentChat", rid, t: T(), stage, ...extra })); }
    catch { /* best-effort */ }
  };

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

    const sanitized = {
      cash: state.cash ?? null,
      benchmarks: state.benchmarks ?? null,
      positions: Array.isArray(state.positions) ? state.positions : [],
    };

    const schema = {
      version: 1,
      market_pulse: [{ ticker: "TICK", benchmark: "QQQ", signal: "inline", note: "short" }],
      cash_tracker: {
        sleeve_value: 0, cash_available: 0, invested: 0, active_triggers: [], playbook: "short"
      },
      portfolio_snapshot: [{
        ticker: "TICK",
        status: "HOLD", sentiment: "Neutral", price: null,
        position: { qty: 0, avg: 0 }, pl_pct: null,
        flow: "Neutral", resistance: null,
        breakout_watch: { gt: null, targets: [] }, idea: "short"
      }]
    };

    const system = `
You are a Brokerage Trade Agent that returns structured DATA ONLY (no prose).
Return ONLY a single JSON object matching the SCHEMA. No markdown, no code fences, no extra fields.
Only include OWNED tickers (STATE.positions). Keep strings concise. Use numbers where appropriate; unknowns as null.
`.trim();

    const user = `
STATE:
${JSON.stringify(sanitized)}

SCHEMA (shape + example values; follow keys and types, not example content):
${JSON.stringify(schema, null, 2)}

Return ONLY one JSON object matching the SCHEMA. Do not add extra fields. Do not include commentary.
`.trim();

    const upstream = await openAIJSON({ system, user, rid, log });
    if (!upstream.ok) {
      // Pass through preview if we have it
      return j(502, { ok:false, error: upstream.error || "Upstream error", meta: { rid, bodyPreview: upstream.preview || "" } }, rid);
    }

    const data = upstream.data;
    // Minimal shape sanity
    const bad =
      !data || typeof data !== "object" ||
      !Array.isArray(data.market_pulse) ||
      !Array.isArray(data.portfolio_snapshot);

    if (bad) {
      log("shape-invalid", { gotKeys: Object.keys(data || {}) });
      return j(502, { ok:false, error:"Model returned unexpected shape", meta:{ rid, bodyPreview: upstream.preview || "" } }, rid);
    }

    log("ok", { mp: data.market_pulse.length, ps: data.portfolio_snapshot.length });
    return j(200, { ok:true, data, meta:{ rid } }, rid);

  } catch (err) {
    console.error("[agentChat] fatal", err);
    return j(500, { ok:false, error:"Server error", meta:{ rid } }, rid);
  }
};

function j(statusCode, body, rid) {
  return { statusCode, headers: { "content-type": "application/json", "x-rid": rid }, body: JSON.stringify(body) };
}

// ---- tolerant OpenAI caller with logging & previews ----
async function openAIJSON({ system, user, rid, log }) {
  const t0 = Date.now();
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
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        top_p: 0.1,
        response_format: { type: "json_object" },
        max_tokens: MAX_TOKENS,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    const envelope = await resp.text();
    log("openai-envelope", { status: resp.status, ms: Date.now() - t0, bytes: envelope.length, preview: envelope.slice(0, 500) });

    if (!resp.ok) return { ok: false, error: `OpenAI error ${resp.status}`, preview: envelope.slice(0, 500) };

    let outer;
    try { outer = JSON.parse(envelope); }
    catch { return { ok:false, error:"Upstream envelope not JSON", preview: envelope.slice(0, 500) }; }

    let content = outer?.choices?.[0]?.message?.content;
    const usage = outer?.usage;

    // Log a tiny peek of assistant content (safe length)
    const contentPreview = typeof content === "string"
      ? content.slice(0, 500)
      : JSON.stringify(content || "").slice(0, 500);
    log("assistant-preview", { kind: typeof content, preview: contentPreview });

    // 1) Already an object
    if (content && typeof content === "object") {
      if (content.version == null) content.version = 1;
      return { ok: true, data: content, preview: contentPreview, usage };
    }

    // 2) String parse direct
    if (typeof content === "string") {
      // a) direct
      try {
        const obj = JSON.parse(content);
        if (obj && typeof obj === "object") {
          if (obj.version == null) obj.version = 1;
          return { ok: true, data: obj, preview: contentPreview, usage };
        }
      } catch {}

      // b) fenced ```json
      const fence = content.match(/```json\s*([\s\S]*?)```/i) || content.match(/```\s*([\s\S]*?)```/);
      if (fence) {
        try {
          const obj = JSON.parse(fence[1]);
          if (obj && typeof obj === "object") {
            if (obj.version == null) obj.version = 1;
            return { ok: true, data: obj, preview: contentPreview, usage };
          }
        } catch {}
      }

      // c) first {...} blob heuristic
      const first = content.indexOf("{");
      const last = content.lastIndexOf("}");
      if (first !== -1 && last > first) {
        const maybe = content.slice(first, last + 1);
        try {
          const obj = JSON.parse(maybe);
          if (obj && typeof obj === "object") {
            if (obj.version == null) obj.version = 1;
            return { ok: true, data: obj, preview: contentPreview, usage };
          }
        } catch {}
      }

      // d) fail — return preview so UI can show it
      return { ok: false, error: "Assistant content was not JSON object", preview: content.slice(0, 400) };
    }

    // unexpected
    return { ok: false, error: "Assistant content missing or invalid", preview: String(content).slice(0, 400) };

  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "OpenAI request timed out" : e.message };
  }
}

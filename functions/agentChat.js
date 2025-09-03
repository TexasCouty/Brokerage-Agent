// functions/agentChat.js
// Netlify Function (v1): always returns JSON; adds timeout + retry + detailed logs.

const crypto = require("crypto");
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";
const REQ_TIMEOUT_MS = 9000;   // fail fast before Netlify kills us
const RETRIES = 1;

exports.handler = async (event) => {
  const rid = (crypto.randomUUID?.() || Math.random().toString(36).slice(2));
  const t0 = Date.now();
  const T = () => Date.now() - t0;
  const log = (stage, extra = {}) =>
    console.log(JSON.stringify({ fn: "agentChat", rid, t: T(), stage, ...extra }));

  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed. Use POST." }, rid);
    }

    let payload = {};
    try { payload = JSON.parse(event.body || "{}"); }
    catch (e) {
      log("json-parse-error", { message: e.message });
      return json(400, { ok:false, error:"Invalid JSON body" }, rid);
    }

    if (payload.ping === "test") {
      return json(200, { ok:true, echo: payload }, rid);
    }

    const state = payload.state;
    if (!state || typeof state !== "object") {
      return json(400, { ok:false, error:"Missing 'state' in request body" }, rid);
    }

    if (!process.env.OPENAI_API_KEY) {
      log("no-openai");
      return json(500, { ok:false, error:"Server not configured (missing OPENAI_API_KEY)" }, rid);
    }

    // ---------- Strict Format Prompt ----------
    const prompt = buildPrompt(state);
    log("prompt-built", { promptLen: prompt.length });

    // ---- Call OpenAI with timeout + retry
    let lastErr, respBody = "", usage;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQ_TIMEOUT_MS);

        const upstream = await fetch(OPENAI_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: MODEL,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.2,
          }),
          signal: controller.signal,
        });

        clearTimeout(timer);
        respBody = await upstream.text();
        log("openai-response", { status: upstream.status, bodyLen: respBody.length, attempt });

        if (!upstream.ok) {
          lastErr = new Error(`OpenAI error ${upstream.status}`);
        } else {
          // Parse upstream JSON
          try {
            const data = JSON.parse(respBody);
            const plan = data?.choices?.[0]?.message?.content || "";
            usage = data?.usage;
            if (!plan.trim()) throw new Error("Empty plan from model");
            log("done", { planLen: plan.length });
            return json(200, { ok:true, plan, meta: { rid, usage } }, rid);
          } catch (e) {
            lastErr = new Error(`Upstream JSON parse error: ${e.message}`);
          }
        }
      } catch (e) {
        // AbortError or network
        lastErr = e.name === "AbortError" ? new Error("OpenAI request timed out") : e;
        log("openai-call-error", { message: lastErr.message, attempt });
      }
    }

    // If we’re here, all attempts failed — return JSON with context
    return json(502, {
      ok: false,
      error: lastErr?.message || "Upstream error",
      meta: { rid, hint: "Likely timeout or OpenAI upstream issue", bodyPreview: respBody?.slice?.(0, 400) || "" }
    }, rid);

  } catch (err) {
    log("unhandled", { message: err.message, stack: err.stack });
    return json(500, { ok:false, error:"Server error", meta:{ rid } }, rid);
  }
};

function json(statusCode, body, rid) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "x-rid": rid },
    body: JSON.stringify(body),
  };
}

function buildPrompt(state) {
  return `
You are a Brokerage Trade Agent. Using the provided STATE JSON, generate TODAY’S PLAN **strictly in this exact format**… (prompt unchanged for brevity)

STATE JSON:
${JSON.stringify(state)}
`.trim();
}

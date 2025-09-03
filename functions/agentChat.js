// functions/agentChat.js
// Netlify Function (v1). Pro plan friendly: 25s timeout, single retry, strict JSON { plan }.
// Sections: Market Pulse, Cash Deployment Tracker, and Portfolio Snapshot — Owned Positions ONLY.

const crypto = require("crypto");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";
const REQ_TIMEOUT_MS = 25000; // ~25s (under Netlify Pro 26s cap)
const RETRIES = 1;

exports.handler = async (event) => {
  const rid = (crypto.randomUUID?.() || Math.random().toString(36).slice(2));
  const t0 = Date.now();
  const T = () => Date.now() - t0;
  const log = (stage, extra = {}) =>
    console.log(JSON.stringify({ fn: "agentChat", rid, t: T(), stage, ...extra }));

  try {
    if (event.httpMethod !== "POST") {
      return j(405, { ok: false, error: "Method Not Allowed. Use POST." }, rid);
    }

    let payload = {};
    try { payload = JSON.parse(event.body || "{}"); }
    catch (e) {
      log("json-parse-error", { message: e.message });
      return j(400, { ok:false, error:"Invalid JSON body" }, rid);
    }

    if (payload.ping === "test") {
      log("probe-ok");
      return j(200, { ok:true, echo: payload }, rid);
    }

    const state = payload.state;
    if (!state || typeof state !== "object") {
      log("no-state");
      return j(400, { ok:false, error:"Missing 'state' in request body" }, rid);
    }

    if (!process.env.OPENAI_API_KEY) {
      log("no-openai");
      return j(500, { ok:false, error:"Server not configured (missing OPENAI_API_KEY)" }, rid);
    }

    const prompt = buildUserPromptOwnedOnly(state);
    log("prompt-built", { promptLen: prompt.length });

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
            messages: [
              {
                role: "system",
                content:
`You are a Brokerage Trade Agent.
CRITICAL RULES:
- ALWAYS output a single JSON object with this exact shape: { "plan": "<string>" }.
- The "plan" string must follow the provided TEMPLATE exactly (same section names, emojis, and blank lines).
- Only include information for OWNED POSITIONS (STATE.positions). Do NOT include watchlist or research tickers anywhere.
- Do NOT include Markdown code fences or any text outside the JSON object.
- No extra keys; only { "plan": "..." }.`,
              },
              { role: "user", content: prompt },
            ],
            temperature: 0.2,
            // Encourage valid JSON from the model:
            response_format: { type: "json_object" },
            max_tokens: 1200
          }),
          signal: controller.signal,
        });

        clearTimeout(timer);
        respBody = await upstream.text();
        log("openai-response", { status: upstream.status, bodyLen: respBody.length, attempt });

        if (!upstream.ok) {
          lastErr = new Error(`OpenAI error ${upstream.status}`);
        } else {
          // Parse upstream JSON strictly
          try {
            const data = JSON.parse(respBody);
            usage = data?.usage;

            // With response_format=json_object, assistant content is a JSON string or object.
            // Extract { plan: "<...>" } from message content.
            const content = data?.choices?.[0]?.message?.content;
            let packed = content;
            if (typeof content === "string") {
              try { packed = JSON.parse(content); } catch { /* keep string */ }
            }
            if (!packed || typeof packed.plan !== "string" || !packed.plan.trim()) {
              throw new Error("Missing or empty 'plan' field in assistant JSON");
            }

            log("done", { planLen: packed.plan.length });
            return j(200, { ok:true, plan: packed.plan, meta: { rid, usage } }, rid);
          } catch (e) {
            lastErr = new Error(`Upstream JSON validation failed: ${e.message}`);
          }
        }
      } catch (e) {
        lastErr = e.name === "AbortError" ? new Error("OpenAI request timed out") : e;
        log("openai-call-error", { message: lastErr.message, attempt });
      }
    }

    log("returning-error", { message: lastErr?.message, preview: respBody?.slice?.(0, 200) || "" });
    return j(502, {
      ok: false,
      error: lastErr?.message || "Upstream error",
      meta: { rid, hint: "Likely timeout/validation issue", bodyPreview: respBody?.slice?.(0, 400) || "" },
    }, rid);

  } catch (err) {
    log("unhandled", { message: err.message, stack: err.stack });
    return j(500, { ok:false, error:"Server error", meta:{ rid } }, rid);
  }
};

function j(statusCode, body, rid) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "x-rid": rid },
    body: JSON.stringify(body),
  };
}

// === Prompt builder: OWNED POSITIONS ONLY ======================================
function buildUserPromptOwnedOnly(state) {
  return `
TEMPLATE (copy this exact structure and emojis into the "plan" string):

📊 Market Pulse (Summary)

(Performance vs. relevant index — 🟢 outperform · 🟡 in line · 🔴 lagging)

<One line per OWNED TICKER from STATE.positions; after each line use a hard Markdown line break: two spaces + newline>  
Ex:
AMZN (Nasdaq) 🟡 — in line with Nasdaq, modest gain.  
NVDA (Nasdaq) 🟢 — outperforming Nasdaq, steady above $180.  
MSFT (Nasdaq) 🔴 — lagging Nasdaq, stuck below $510.  

Summary: 🟢 X outperforming · 🟡 Y in line · 🔴 Z lagging

💵 Cash Deployment Tracker

Brokerage sleeve total value: ≈ <from STATE.cash.sleeve_value if present, else estimate>
Cash available: <from STATE.cash.cash_available> (<percent of sleeve_value if available>)
Invested (stocks): <from STATE.cash.invested if present, else sleeve_value - cash_available> (<percent>)
Active triggers today (strict): <None or a short bullet list based ONLY on owned tickers>
Playbook: Brief guidance; keep to one or two sentences.

1) Portfolio Snapshot — Owned Positions

<One block per OWNED ticker from STATE.positions; keep exactly this bullet format>
TICKER — 🟢/🟡/🔴 $<price or “n/a”> | Sentiment: <Bullish/Neutral/Bearish> [⏸️ HOLD or ✅ BUY or ⚠️ TRIM]
• Position: <qty> @ <avg> | P/L <calc if possible or “n/a”>
• Flow: <one short line based on sentiment/assumptions; if unknown, keep neutral>
• Resistance: <range or “n/a”>
• Breakout watch: ><level> → <targets> (if applicable)
• Idea: Short one-liner, ONLY for the owned ticker.

IMPORTANT CONSTRAINTS:
- DO NOT include watchlist or research sections at all.
- DO NOT mention tickers that are not in STATE.positions in any section.
- For Market Pulse, only write lines for OWNED tickers and benchmarks inferred from STATE.benchmarks for those tickers.
- Use percentages like "(38%)" — do NOT use "~".
- Keep sections separated by a single blank line.
- Output only one top-level JSON object: { "plan": "<the full formatted plan>" }.

STATE JSON:
${JSON.stringify({
    cash: state.cash ?? null,
    benchmarks: state.benchmarks ?? null,
    positions: state.positions ?? [],
  })}
  `.trim();
}

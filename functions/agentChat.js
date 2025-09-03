// functions/agentChat.js
// Netlify Function (v1 runtime). Always returns JSON; enforces { plan: "<string>" }.
// Adds timeout + single retry; structured console logs with rid.

const crypto = require("crypto");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";
const REQ_TIMEOUT_MS = 9000; // abort before Netlify hard limit
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

    // Lightweight probe
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

    const prompt = buildUserPrompt(state);
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
- Do NOT include Markdown code fences or any text outside the JSON object.
- No extra keys; only { "plan": "..." }.`,
              },
              { role: "user", content: prompt },
            ],
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
          // Parse upstream JSON strictly
          try {
            const data = JSON.parse(respBody);
            const plan = data?.choices?.[0]?.message?.content || "";
            usage = data?.usage;

            // The model should already have produced a JSON string in message.content
            // Parse that again to extract { plan: "..." }
            let packed;
            try { packed = JSON.parse(plan); } catch (e) {
              throw new Error("Assistant message was not strict JSON {\"plan\": \"...\"}");
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
        // AbortError or network failure
        lastErr = e.name === "AbortError" ? new Error("OpenAI request timed out") : e;
        log("openai-call-error", { message: lastErr.message, attempt });
      }
    }

    // All attempts failed
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

function buildUserPrompt(state) {
  // The model must copy this structure into plan (as plain text), but return it wrapped as {"plan": "..."}.
  return `
TEMPLATE (copy this exact structure and emojis into the "plan" string):

📊 Market Pulse (Summary)

(Performance vs. relevant index — 🟢 outperform · 🟡 in line · 🔴 lagging)

<One line per ticker; after each line use a hard Markdown line break: two spaces + newline>  
Ex:
AMZN (Nasdaq) 🟡 — in line with Nasdaq, modest gain.  
NVDA (Nasdaq) 🟢 — outperforming Nasdaq, steady above $180.  
MSFT (Nasdaq) 🔴 — lagging Nasdaq, stuck below $510.  

Summary: 🟢 X outperforming · 🟡 Y in line · 🔴 Z lagging

💵 Cash Deployment Tracker

Brokerage sleeve total value: ≈ $115,000
Cash available: $43,647.89 (38%)
Invested (stocks): ≈ $71,350 (62%)
Active triggers today (strict): <None or short list>
Playbook: Brief guidance on how to deploy/hold.

1) Portfolio Snapshot — Owned Positions

<One block per STATE.positions ticker; keep exactly this bullet format>
AMZN — 🟡 $231.7 | Sentiment: Bullish 🐂 [⏸️ HOLD]
• Position: 75 @ 212.22 | P/L +9.2%
• Flow: Balanced; no sweeps today.
• Resistance: 235–240
• Breakout watch: >240 → 245–250
• Idea: Hold—enter only on confirmed breakout.

…repeat for each owned ticker…

2) Entry Radar — Watchlist (No positions yet)

…one block per STATE.watchlist ticker, similar style…

3) Research — Bullish Sector Picks

…one block per STATE.research ticker, similar style…

RULES:
- Stick to the tickers/benchmarks provided in STATE.
- Use percentages like "(38%)" — do NOT use "~".
- For Market Pulse, ALWAYS put a hard line break after each ticker line ("two spaces + newline").
- Separate sections by a single blank line.
- Output only one top-level JSON object: { "plan": "<the full formatted plan>" }.

STATE JSON:
${JSON.stringify(state)}
  `.trim();
}

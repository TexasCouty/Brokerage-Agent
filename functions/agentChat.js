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
    const prompt = [
      "You are a brokerage trade agent.",
      "Using the provided STATE JSON, produce a concise daily trade plan with these sections:",
      "📊 Market Pulse • 💵 Cash Deployment • 1) Portfolio Snapshot • 2) Entry Radar • 3) Research",
      "Be explicit on triggers (levels/volume/flow). Keep it actionable.",
      "",
      "STATE JSON:",
      JSON.stringify(state)
    ].join("\n");

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

// functions/planStart.js
const crypto = require("crypto");

exports.handler = async (event) => {
  const rid = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
  const log = (stage, extra={}) => console.log(JSON.stringify({fn:"planStart", rid, stage, ...extra}));

  try {
    if (event.httpMethod !== "POST") {
      return j(405, { ok:false, error:"Use POST" }, rid);
    }

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {
      return j(400, { ok:false, error:"Invalid JSON body" }, rid);
    }
    const state = body.state;
    if (!state || typeof state !== "object") {
      return j(400, { ok:false, error:"Missing 'state'" }, rid);
    }

    const minState = {
      cash: state.cash ?? null,
      benchmarks: state.benchmarks ?? null,
      positions: Array.isArray(state.positions) ? state.positions : [],
    };
    const hash = crypto.createHash("sha256")
      .update(JSON.stringify(minState))
      .digest("hex")
      .slice(0, 32);
    const key = `plans:v1:${hash}`;

    const { getStore } = await import("@netlify/blobs");
    const store = getStore({ name: "brokerage-plans" });

    const existing = await store.get(key, { type: "json" }); // {status, data, error?}
    if (existing && existing.status === "ready" && existing.data) {
      log("cache-hit", { hash });
      return j(200, { ok:true, status:"ready", hash, data: existing.data }, rid);
    }
    if (existing && existing.status === "running") {
      log("already-running", { hash });
      return j(200, { ok:true, status:"running", hash }, rid);
    }

    log("need-start", { hash });
    return j(200, { ok:true, status:"start", hash, rid }, rid);

  } catch (e) {
    console.error("[planStart] fatal", e);
    return j(500, { ok:false, error:"Server error" }, rid);
  }
};

function j(statusCode, body, rid) {
  return { statusCode, headers: { "content-type":"application/json", "x-rid": rid }, body: JSON.stringify(body) };
}

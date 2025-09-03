// functions/planStatus.js
exports.handler = async (event) => {
  const rid = Math.random().toString(36).slice(2);
  try {
    const hash = new URLSearchParams(event.rawQuery || event.queryStringParameters).get("hash");
    if (!hash) return j(400, { ok:false, error:"Missing hash" }, rid);
    const key = `plans:v1:${hash}`;

    const { getStore } = await import("@netlify/blobs");
    const store = getStore({ name: "brokerage-plans" });

    const rec = await store.get(key, { type: "json" });
    if (!rec) return j(200, { ok:true, status:"none" }, rid);
    return j(200, { ok:true, ...rec }, rid); // {status, data?, error?, preview?}
  } catch (e) {
    return j(500, { ok:false, error:"Server error" }, rid);
  }
};

function j(statusCode, body, rid) {
  return { statusCode, headers: { "content-type":"application/json", "x-rid": rid }, body: JSON.stringify(body) };
}

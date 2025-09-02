// functions/tradeState.js
// Works on Netlify Functions runtime that expects Web Response objects
import { MongoClient } from "mongodb";

const COLL = "trade_state";
const DOC_ID = "default";

// ---- Runtime adapter: V2 (Request) vs V1 (event) ---------------------------
export default async function handler(input) {
  const isV2 = typeof input?.method === "string"; // V2 passes a Request
  const req = isV2 ? input : null;
  const event = isV2 ? null : input;

  try {
    // Method + headers
    const method = isV2 ? req.method : event.httpMethod;
    const headers = isV2 ? Object.fromEntries(req.headers) : event.headers || {};

    if (method === "OPTIONS") return res(204, "", cors());

    if (method === "GET") {
      const db = await getDb();
      const doc = await db.collection(COLL).findOne({ _id: DOC_ID });
      return res(200, { ok: true, state: doc?.state || {} });
    }

    if (method === "POST") {
      const adminKey = headers["x-admin-key"] || headers["X-Admin-Key"];
      if (adminKey !== process.env.TRADE_ADMIN_KEY) {
        return res(401, { error: "Unauthorized" });
      }

      const body = await readJsonBody(isV2 ? req : event);
      if (!body || typeof body !== "object") {
        return res(400, { error: "Invalid JSON" });
      }

      const db = await getDb();
      await db.collection(COLL).updateOne(
        { _id: DOC_ID },
        { $set: { state: body, updated_at: new Date().toISOString() } },
        { upsert: true }
      );
      return res(200, { ok: true });
    }

    return res(405, { error: "Method Not Allowed" });
  } catch (err) {
    console.error("[tradeState] fatal", err);
    return res(500, { error: "Server error" });
  }
}

// ---- helpers ---------------------------------------------------------------
async function readJsonBody(src) {
  // V2: Request; V1: event with string body
  if (typeof src?.json === "function") {
    // Request
    try { return await src.json(); } catch { return null; }
  }
  try { return JSON.parse(src?.body || "{}"); } catch { return null; }
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-key"
  };
}

function res(status, body, extraHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...cors(),
    ...extraHeaders
  };
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(payload, { status, headers });
}

let _db;
async function getDb() {
  if (_db) return _db;
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MISSING MONGO_URI");
  const client = new MongoClient(uri);
  await client.connect();
  const dbName = process.env.MONGO_DB || "trade_agent";
  _db = client.db(dbName);
  return _db;
}

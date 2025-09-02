// functions/tradeState.js updated
import { MongoClient } from "mongodb";

const COLL = "trade_state";
const DOC_ID = "default";

export default async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") return resp(204, "", cors());
    if (event.httpMethod === "GET") return getState();
    if (event.httpMethod === "POST") return setState(event);
    return resp(405, JSON.stringify({ error: "Method Not Allowed" }), cors());
  } catch (err) {
    console.error("[tradeState] fatal", err);
    return resp(500, JSON.stringify({ error: "Server error" }), cors());
  }
}

async function getState() {
  const db = await getDb();
  const doc = await db.collection(COLL).findOne({ _id: DOC_ID });
  return resp(200, JSON.stringify({ ok: true, state: doc?.state || {} }), cors());
}

async function setState(event) {
  const adminKey = event.headers["x-admin-key"] || event.headers["X-Admin-Key"];
  if (adminKey !== process.env.TRADE_ADMIN_KEY) {
    return resp(401, JSON.stringify({ error: "Unauthorized" }), cors());
  }
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }

  const db = await getDb();
  await db.collection(COLL).updateOne(
    { _id: DOC_ID },
    { $set: { state: body, updated_at: new Date().toISOString() } },
    { upsert: true }
  );
  return resp(200, JSON.stringify({ ok: true }), cors());
}

// Helpers
let _db;
async function getDb() {
  if (_db) return _db;
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  _db = client.db(process.env.MONGO_DB || "trade_agent");
  return _db;
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,x-admin-key"
  };
}

function resp(statusCode, body, headers = {}) {
  return {
    statusCode,
    body,
    headers: { "Content-Type": "application/json", ...headers }
  };
}

# Brokerage Trade Agent (Mobile PWA)

## Overview
This project is a mobile-first **Progressive Web App (PWA)** deployed on **Netlify** that runs a **Brokerage Trade Agent**.  
It generates structured daily trade plans based on stored portfolio state (MongoDB Atlas) and OpenAI outputs.

---

## Project Structure
```
Brokerage Agent/
├── functions/
│   ├── agentChat.js       # Serverless function: forwards chat requests to OpenAI
│   └── tradeState.js      # Serverless function: stores/returns portfolio state in MongoDB
├── src/
│   ├── index.html         # UI with Run Trade Agent button
│   ├── main.js            # Frontend logic (fetch state + render formatted output)
│   ├── style.css          # App styles
│   ├── manifest.webmanifest
│   └── sw.js              # Service worker (PWA)
└── netlify.toml           # Netlify build/deploy configuration
```

---

## Netlify Configuration
### Build settings
- **Publish directory:** `src`  
- **Functions directory:** `functions`

`netlify.toml`:
```toml
[build]
  publish   = "src"
  functions = "functions"

[functions]
  node_bundler = "esbuild"
```

---

## Environment Variables (Netlify → Site settings → Env vars)
- `OPENAI_API_KEY` = your OpenAI key (secret ✅)  
- `MONGO_URI` = Atlas connection string, e.g.  
  ```
  mongodb+srv://tradeagent:<password>@patek-cluster.rchgesl.mongodb.net/trade_agent?retryWrites=true&w=majority&appName=patek-cluster
  ```
- `MONGO_DB` = `trade_agent`  
- (Optional now) `TRADE_ADMIN_KEY` (currently not enforced in code, can re-enable later)

---

## Database (MongoDB Atlas)
- Cluster: `patek-cluster`  
- Database: `trade_agent`  
- Collection: `trade_state`  
- User: `tradeagent` with readWrite on `trade_agent`  

---

## Functions
### `tradeState.js`
- `GET` → returns `{ ok:true, state:{...} }`  
- `POST` → upserts new state into Mongo (`state` doc)  
- Auth check removed for now (any POST works)

### `agentChat.js`
- Proxies chat requests to OpenAI API using `OPENAI_API_KEY`.

---

## Seeding Data
1. Prepare `seed.json` with:
   - `cash`
   - `benchmarks`
   - `positions[]` (ticker, qty, avg, notes, sentiment)
   - `watchlist[]`
   - `research[]`
2. Upload with:
   ```cmd
   curl -X POST "https://<yoursite>.netlify.app/.netlify/functions/tradeState" -H "Content-Type: application/json" --data-binary "@C:\Brokerage Agent\seed.json"
   ```
3. Verify with:
   ```
   https://<yoursite>.netlify.app/.netlify/functions/tradeState
   ```

---

## Frontend (`main.js`)
- Fetches `tradeState` → passes JSON to `agentChat` with strict **output contract**.  
- LLM generates plan with:
  - 📊 Market Pulse (Summary)
  - 💵 Cash Deployment Tracker
  - 1) Portfolio Snapshot
  - 2) Entry Radar
  - 3) Research  
  - ✅ Strict trigger logic note

---

## Usage
1. Open app: `https://<yoursite>.netlify.app/`  
2. Tap **Run Trade Agent**  
3. See structured daily plan with tickers, positions, notes, and cash.

---

## Next Steps
- Add admin page to edit state (no curl needed).  
- Add live price fetching for Market Pulse 🟢/🟡/🔴 logic.  
- Re-enable `TRADE_ADMIN_KEY` check for security.  

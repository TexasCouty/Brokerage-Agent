// functions/agentChat.js  (CommonJS; no top-level await)
exports.handler = async (event) => {
  // breadcrumbs for debugging (no secrets)
  console.log(JSON.stringify({
    fn: "agentChat",
    method: event.httpMethod,
    hasOPENAI: !!process.env.OPENAI_API_KEY,
    contentType: event.headers?.["content-type"],
    bodyBytes: event.body ? event.body.length : 0,
  }));

  try {
    if (event.httpMethod !== "POST") {
      console.warn("agentChat: non-POST");
      return { statusCode: 405, body: "Method Not Allowed. Use POST." };
    }

    // Parse JSON safely
    let payload = {};
    try { payload = JSON.parse(event.body || "{}"); }
    catch { return { statusCode: 400, body: "Invalid JSON body" }; }

    // Plumbing test path — lets you verify the function without OpenAI
    if (payload.ping === "test") {
      console.log("agentChat: plumbing test ok");
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true, echo: payload })
      };
    }

    // If no key yet, return a harmless 200 so the UI still works
    if (!process.env.OPENAI_API_KEY) {
      console.error("agentChat: OPENAI_API_KEY missing");
      return { statusCode: 500, body: "Server not configured (missing OPENAI_API_KEY)" };
    }

    // ----- Real OpenAI call (inside the async handler) -----
    const reqBody = {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Hello from Brokerage Trade Agent plumbing test." }],
      temperature: 0.2,
    };

    let upstream;
    try {
      upstream = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(reqBody),
      });
    } catch (e) {
      console.error("agentChat: network error to OpenAI", e.message);
      return { statusCode: 502, body: "Upstream call failed (network error to OpenAI)" };
    }

    const text = await upstream.text();
    if (!upstream.ok) {
      console.error("agentChat: OpenAI non-200", upstream.status, text.slice(0, 500));
      return { statusCode: 502, body: `OpenAI error ${upstream.status}: ${text}` };
    }

    // Pass OpenAI JSON straight through
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: text
    };
  } catch (err) {
    console.error("agentChat: unhandled", { message: err.message, stack: err.stack });
    return { statusCode: 500, body: "Server error" };
  }
};

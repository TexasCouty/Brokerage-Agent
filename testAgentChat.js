// testAgentChat.js
const { handler } = require('./functions/agentChat.js');

(async () => {
  const res = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run: true }), // <- use run:true (not ping)
    path: '/.netlify/functions/agentChat',
  });

  console.log('status:', res.statusCode);
  console.log('headers:', res.headers);
  console.log('body:', res.body);
})();

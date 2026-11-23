const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
});

const wss = new WebSocketServer({ server });

let waiting = null;

wss.on("connection", (ws) => {
  ws.partner = null;

  if (waiting && waiting.readyState === 1) {
    const p1 = waiting;
    waiting = null;
    p1.partner = ws;
    ws.partner = p1;

    p1.send(JSON.stringify({ type: "start", side: "T" }));
    ws.send(JSON.stringify({ type: "start", side: "CT" }));
  } else {
    waiting = ws;
    ws.send(JSON.stringify({ type: "wait" }));
  }

  ws.on("message", (msg) => {
    if (ws.partner && ws.partner.readyState === 1) {
      ws.partner.send(msg.toString());
    }
  });

  ws.on("close", () => {
    if (waiting === ws) waiting = null;
    if (ws.partner && ws.partner.readyState === 1) {
      ws.partner.send(JSON.stringify({ type: "left" }));
      ws.partner.partner = null;
    }
  });
});

server.listen(PORT, () => {
  console.log("Server started on port", PORT);
});

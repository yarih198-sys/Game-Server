const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;

const MODE_LIMITS = {
  "1v1": 2,
  "2v2": 4,
  "3v3": 6,
  "5v5": 10,
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".pck": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const BLOCKED_FILES = new Set([
  "server.js",
  "package.json",
  "package-lock.json",
]);

const lobbies = new Map();
const quickQueue = [];

const server = http.createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  if (urlPath === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("OK");
    return;
  }

  let relPath = decodeURIComponent(urlPath).replace(/^\/+/, "");
  if (relPath === "") {
    if (fs.existsSync(path.join(__dirname, "GodotShooter.html"))) {
      relPath = "GodotShooter.html";
    } else if (fs.existsSync(path.join(__dirname, "index.html"))) {
      relPath = "index.html";
    } else {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("OK");
      return;
    }
  }

  const baseName = path.basename(relPath).toLowerCase();
  if (
    relPath.includes("..") ||
    baseName.startsWith(".") ||
    BLOCKED_FILES.has(baseName)
  ) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  const filePath = path.join(__dirname, relPath);
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });

    const stream = fs.createReadStream(filePath);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
    stream.pipe(res);
  });
});

const wss = new WebSocketServer({ server });

function sendJson(ws, obj) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
  }
}

function removeFromQueue(ws) {
  const idx = quickQueue.indexOf(ws);
  if (idx !== -1) quickQueue.splice(idx, 1);
}

function broadcastLobby(code) {
  const room = lobbies.get(code);
  if (!room) return;
  room.members = room.members.filter((m) => m.readyState === 1);
  if (room.members.length === 0) {
    lobbies.delete(code);
    return;
  }
  if (!room.members.includes(room.host)) {
    room.host = room.members[0];
  }
  const players = room.members.map((m) => ({ nick: m.nick }));
  const payload = {
    type: "lobby_state",
    code: room.code,
    mode: room.mode,
    rounds: room.rounds,
    players,
  };
  for (const m of room.members) {
    sendJson(m, payload);
  }
}

function leaveLobby(ws) {
  if (!ws.lobbyCode) return;
  const code = ws.lobbyCode;
  ws.lobbyCode = null;
  const room = lobbies.get(code);
  if (!room) return;
  room.members = room.members.filter((m) => m !== ws);
  if (room.members.length === 0) {
    lobbies.delete(code);
  } else {
    broadcastLobby(code);
  }
}

function leaveMatch(ws) {
  if (!ws.partner) return;
  const other = ws.partner;
  ws.partner = null;
  if (other.partner === ws) {
    other.partner = null;
  }
  sendJson(other, { type: "left" });
}

function startPair(p1, p2, rounds = 5) {
  removeFromQueue(p1);
  removeFromQueue(p2);
  p1.partner = p2;
  p2.partner = p1;
  p1.weapon = 0;
  p2.weapon = 0;
  sendJson(p1, { type: "start", side: "T", rounds });
  sendJson(p2, { type: "start", side: "CT", rounds });
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.partner = null;
  ws.lobbyCode = null;
  ws.nick = "Player";
  ws.weapon = 0;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const type = String(data.type || "");

    if (type === "create_lobby") {
      leaveMatch(ws);
      removeFromQueue(ws);
      leaveLobby(ws);

      const code = String(data.code || "").trim().toUpperCase();
      if (code.length < 4) {
        sendJson(ws, { type: "lobby_error", msg: "Некорректный код лобби" });
        return;
      }

      const mode = MODE_LIMITS[data.mode] ? data.mode : "1v1";
      const maxPlayers = MODE_LIMITS[mode];
      const rounds = Number(data.rounds) || 5;

      ws.nick = String(data.nick || "Host").slice(0, 16);
      ws.lobbyCode = code;

      lobbies.set(code, {
        code,
        host: ws,
        mode,
        maxPlayers,
        rounds,
        started: false,
        members: [ws],
      });

      broadcastLobby(code);
      return;
    }

    if (type === "join_lobby") {
      leaveMatch(ws);
      removeFromQueue(ws);
      leaveLobby(ws);

      const code = String(data.code || "").trim().toUpperCase();
      const room = lobbies.get(code);
      if (!room) {
        sendJson(ws, { type: "lobby_error", msg: "Лобби с таким кодом не найдено" });
        return;
      }
      if (room.started) {
        sendJson(ws, { type: "lobby_error", msg: "Матч в этом лобби уже идёт" });
        return;
      }
      if (room.members.length >= room.maxPlayers) {
        sendJson(ws, { type: "lobby_error", msg: "Лобби заполнено" });
        return;
      }

      ws.nick = String(data.nick || "Player").slice(0, 16);
      ws.lobbyCode = code;
      if (!room.members.includes(ws)) {
        room.members.push(ws);
      }

      broadcastLobby(code);
      return;
    }

    if (type === "start_lobby") {
      const code = ws.lobbyCode || String(data.code || "").trim().toUpperCase();
      const room = lobbies.get(code);
      if (!room) {
        sendJson(ws, { type: "lobby_error", msg: "Лобби не найдено" });
        return;
      }
      if (room.host !== ws) {
        sendJson(ws, { type: "lobby_error", msg: "Запустить матч может только создатель лобби" });
        return;
      }

      room.members = room.members.filter((m) => m.readyState === 1);
      if (room.members.length < 2) {
        sendJson(ws, { type: "lobby_error", msg: "Нужен минимум 2-й игрок" });
        return;
      }

      room.started = true;
      for (let i = 0; i + 1 < room.members.length; i += 2) {
        startPair(room.members[i], room.members[i + 1], room.rounds);
      }
      lobbies.delete(code);
      for (const m of room.members) {
        m.lobbyCode = null;
      }
      return;
    }

    if (type === "quick_match") {
      leaveMatch(ws);
      leaveLobby(ws);
      removeFromQueue(ws);

      ws.nick = String(data.nick || "Player").slice(0, 16);

      while (quickQueue.length > 0 && quickQueue[0].readyState !== 1) {
        quickQueue.shift();
      }

      if (quickQueue.length > 0) {
        const opponent = quickQueue.shift();
        startPair(opponent, ws, 5);
      } else {
        quickQueue.push(ws);
        sendJson(ws, { type: "wait" });
      }
      return;
    }

    if (type === "weapon") {
      const slot = Number(data.slot) === 1 ? 1 : 0;
      ws.weapon = slot;
      if (ws.partner && ws.partner.readyState === 1) {
        sendJson(ws.partner, { type: "weapon", slot });
      }
      return;
    }

    if (type === "hello") {
      ws.nick = String(data.nick || ws.nick).slice(0, 16);
      ws.weapon = Number(data.weapon) === 1 ? 1 : 0;
      if (ws.partner && ws.partner.readyState === 1) {
        sendJson(ws.partner, { type: "hello", nick: ws.nick, weapon: ws.weapon });
      }
      return;
    }

    if (type === "state") {
      if (data.weapon !== undefined) {
        ws.weapon = Number(data.weapon) === 1 ? 1 : 0;
      }
      if (ws.partner && ws.partner.readyState === 1) {
        sendJson(ws.partner, {
          type: "state",
          x: Number(data.x || 0),
          y: Number(data.y || 0),
          z: Number(data.z || 0),
          yaw: Number(data.yaw || 0),
          weapon: ws.weapon,
          moving: Boolean(data.moving),
          air: Boolean(data.air),
          fall: Boolean(data.fall),
          crouch: Boolean(data.crouch),
        });
      }
      return;
    }

    if (type === "shoot") {
      const weapon = data.weapon !== undefined ? (Number(data.weapon) === 1 ? 1 : 0) : ws.weapon;
      ws.weapon = weapon;
      if (ws.partner && ws.partner.readyState === 1) {
        sendJson(ws.partner, {
          type: "shoot",
          weapon,
          ax: Number(data.ax || 0),
          ay: Number(data.ay || 0),
          az: Number(data.az || 0),
          bx: Number(data.bx || 0),
          by: Number(data.by || 0),
          bz: Number(data.bz || 0),
        });
      }
      return;
    }

    if (type === "hit") {
      if (ws.partner && ws.partner.readyState === 1) {
        sendJson(ws.partner, { type: "hit", dmg: Number(data.dmg || 0) });
      }
    }
  });

  ws.on("close", () => {
    removeFromQueue(ws);
    leaveLobby(ws);
    leaveMatch(ws);
  });

  ws.on("error", () => {
    removeFromQueue(ws);
    leaveLobby(ws);
    leaveMatch(ws);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on("close", () => {
  clearInterval(heartbeat);
});

server.listen(PORT, () => {
  console.log("Server started on port", PORT);
});

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

/**
 * Структура стану кімнати:
 * {
 *   source: { type: 'none' | 'youtube' | 'direct' | 'local', value: string, meta?: string },
 *   isPlaying: boolean,
 *   currentTime: number,
 *   updatedAt: number // timestamp у мс на момент останнього оновлення currentTime
 * }
 */
const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      source: { type: "none", value: "", meta: "" },
      isPlaying: false,
      currentTime: 0,
      updatedAt: Date.now()
    });
  }
  return rooms.get(roomId);
}

/**
 * Обчислює актуальну позицію відео на поточний момент з урахуванням часу,
 * що минув з моменту останньої події play/seek/heartbeat.
 */
function getEffectiveTime(room) {
  if (!room.isPlaying) {
    return room.currentTime;
  }
  const elapsedSec = (Date.now() - room.updatedAt) / 1000;
  return Math.max(0, room.currentTime + elapsedSec);
}

io.on("connection", (socket) => {
  const roomId = String(socket.handshake.query.room || "default").slice(0, 64);
  const nickname = String(socket.handshake.query.nick || "Гість").slice(0, 24);

  socket.join(roomId);
  const room = getOrCreateRoom(roomId);

  // Відправляємо поточний стан кімнати новому учаснику
  socket.emit("room:state", {
    roomId,
    source: room.source,
    isPlaying: room.isPlaying,
    currentTime: getEffectiveTime(room),
    serverNow: Date.now()
  });

  socket.to(roomId).emit("chat:system", {
    text: `${nickname} приєднався до кімнати`,
    time: Date.now()
  });

  // Зміна джерела відео
  socket.on("media:change", ({ source }) => {
    if (!source || !source.type) return;
    room.source = {
      type: source.type,
      value: source.value || "",
      meta: source.meta || ""
    };
    room.isPlaying = false;
    room.currentTime = 0;
    room.updatedAt = Date.now();

    io.to(roomId).emit("media:change", {
      source: room.source,
      isPlaying: room.isPlaying,
      currentTime: 0,
      by: nickname
    });
  });

  // Play
  socket.on("player:play", ({ currentTime }) => {
    room.isPlaying = true;
    room.currentTime = typeof currentTime === "number" ? currentTime : getEffectiveTime(room);
    room.updatedAt = Date.now();

    socket.to(roomId).emit("player:play", {
      currentTime: room.currentTime,
      updatedAt: room.updatedAt,
      by: nickname
    });
  });

  // Pause
  socket.on("player:pause", ({ currentTime }) => {
    room.isPlaying = false;
    room.currentTime = typeof currentTime === "number" ? currentTime : getEffectiveTime(room);
    room.updatedAt = Date.now();

    socket.to(roomId).emit("player:pause", {
      currentTime: room.currentTime,
      updatedAt: room.updatedAt,
      by: nickname
    });
  });

  // Seek (перемотування)
  socket.on("player:seek", ({ currentTime, isPlaying }) => {
    if (typeof currentTime !== "number") return;
    room.currentTime = Math.max(0, currentTime);
    if (typeof isPlaying === "boolean") {
      room.isPlaying = isPlaying;
    }
    room.updatedAt = Date.now();

    socket.to(roomId).emit("player:seek", {
      currentTime: room.currentTime,
      isPlaying: room.isPlaying,
      updatedAt: room.updatedAt,
      by: nickname
    });
  });

  // Періодичний heartbeat від активного гравця для м'якої корекції дрейфу
  socket.on("player:heartbeat", ({ currentTime, isPlaying }) => {
    if (typeof currentTime !== "number") return;
    room.currentTime = Math.max(0, currentTime);
    if (typeof isPlaying === "boolean") {
      room.isPlaying = isPlaying;
    }
    room.updatedAt = Date.now();

    socket.to(roomId).emit("player:sync_tick", {
      currentTime: room.currentTime,
      isPlaying: room.isPlaying,
      updatedAt: room.updatedAt
    });
  });

  // Чат
  socket.on("chat:message", ({ text }) => {
    const clean = String(text || "").trim().slice(0, 500);
    if (!clean) return;
    io.to(roomId).emit("chat:message", {
      author: nickname,
      text: clean,
      time: Date.now()
    });
  });

  // Літаючі реакції
  socket.on("reaction:send", ({ emoji }) => {
    const allowed = ["🔥", "😂", "❤️", "😮", "👏", "💀"];
    if (!allowed.includes(emoji)) return;
    io.to(roomId).emit("reaction:show", {
      emoji,
      author: nickname,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    });
  });

  socket.on("disconnect", () => {
    socket.to(roomId).emit("chat:system", {
      text: `${nickname} вийшов з кімнати`,
      time: Date.now()
    });
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
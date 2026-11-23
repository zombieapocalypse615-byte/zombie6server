const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const SKINS = 6;
const USERS_FILE = path.join(__dirname, "users.json");
const rooms = new Map();
const online = new Set();

// Accounts are kept in users.json. On Render's free plan this file is erased
// when the service restarts or redeploys, so accounts can reset.
let users = {};
try { users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch (e) { users = {}; }
function saveUsers() {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users)); } catch (e) {}
}
function hash(pass, salt) {
  return crypto.scryptSync(pass, salt, 32).toString("hex");
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("☣ ZOMBIE APOCALYPSE MULTIPLAYER ONLINE ☣");
});

const io = new Server(server, { cors: { origin: "*" } });

function cleanRoom(value) {
  return String(value || "public").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20) || "public";
}
function cleanSkin(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 && n < SKINS ? n : 0;
}

io.on("connection", socket => {
  let fails = 0;
  socket.emit("hello", { v: 2 });

  socket.on("auth", (data, cb) => {
    if (typeof cb !== "function") return;
    if (socket.data.user) return cb({ ok: false, error: "Already signed in." });
    if (fails >= 5) { cb({ ok: false, error: "Too many tries." }); return socket.disconnect(); }
    data = data || {};
    const name = String(data.user || "");
    const pass = String(data.pass || "");
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
      return cb({ ok: false, error: "Username: 3 to 16 letters, numbers or _." });
    }
    if (pass.length < 6 || pass.length > 64) {
      return cb({ ok: false, error: "Password: 6 to 64 characters." });
    }
    const key = name.toLowerCase();
    if (data.mode === "register") {
      if (users[key]) return cb({ ok: false, error: "That username is taken." });
      const salt = crypto.randomBytes(16).toString("hex");
      users[key] = { name, salt, hash: hash(pass, salt), skin: 0 };
      saveUsers();
    } else {
      const u = users[key];
      let good = false;
      if (u) {
        const a = Buffer.from(hash(pass, u.salt), "hex");
        const b = Buffer.from(u.hash, "hex");
        good = a.length === b.length && crypto.timingSafeEqual(a, b);
      }
      if (!good) { fails++; return cb({ ok: false, error: "Wrong username or password." }); }
    }
    if (online.has(key)) return cb({ ok: false, error: "That account is already online." });
    online.add(key);
    socket.data.user = key;
    socket.data.name = users[key].name;
    cb({ ok: true, name: users[key].name, skin: users[key].skin || 0 });
  });

  socket.on("skin:set", value => {
    const key = socket.data.user;
    if (!key || !users[key]) return;
    users[key].skin = cleanSkin(value);
    saveUsers();
    const room = socket.data.room;
    if (room && rooms.has(room)) {
      const p = rooms.get(room).get(socket.id);
      if (p) {
        p.skin = users[key].skin;
        socket.to(room).emit("player:skin", { id: socket.id, skin: p.skin });
      }
    }
  });

  socket.on("join", data => {
    if (!socket.data.user || socket.data.room) return;
    data = data || {};
    const room = cleanRoom(data.room);
    if (!rooms.has(room)) rooms.set(room, new Map());
    const players = rooms.get(room);
    if (players.size >= MAX_PLAYERS) {
      socket.emit("room:full");
      return;
    }
    socket.data.room = room;
    const skin = cleanSkin(data.skin);
    users[socket.data.user].skin = skin;
    saveUsers();
    const player = { id: socket.id, name: socket.data.name, skin, x: 0, z: 6, yaw: 0 };
    players.set(socket.id, player);
    socket.join(room);
    socket.emit("room:state", [...players.values()]);
    socket.to(room).emit("player:joined", player);
    io.to(room).emit("room:count", players.size);
  });

  socket.on("player:move", data => {
    const room = socket.data.room;
    if (!room || !rooms.has(room) || !data) return;
    const player = rooms.get(room).get(socket.id);
    if (!player) return;
    const x = Number(data.x), z = Number(data.z), yaw = Number(data.yaw);
    if (![x, z, yaw].every(Number.isFinite)) return;
    if (Math.abs(x) > 500 || Math.abs(z) > 500) return;
    player.x = x; player.z = z; player.yaw = yaw;
    socket.to(room).emit("player:moved", { id: socket.id, x, z, yaw });
  });

  socket.on("disconnect", () => {
    if (socket.data.user) online.delete(socket.data.user);
    const room = socket.data.room;
    if (!room || !rooms.has(room)) return;
    const players = rooms.get(room);
    players.delete(socket.id);
    socket.to(room).emit("player:left", socket.id);
    if (players.size === 0) rooms.delete(room);
    else io.to(room).emit("room:count", players.size);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("☣ MULTIPLAYER SERVER STARTED ☣");
  console.log("Port: " + PORT);
});

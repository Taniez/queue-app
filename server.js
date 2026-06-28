const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const mysql = require('mysql2');
const fs = require('fs'); 

const app = express();
const server = http.createServer(app);
const io = socketIO(server);
require('dotenv').config();

const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 4000,
  ssl: {
    ca: fs.readFileSync(__dirname + '/ca.pem')
  }
});

db.connect(err => {
  if (err) throw err;
  console.log("✅ Connected to TiDB via SSL");
});

app.use(express.static('public'));

const emitQueue = () => {
  db.query(`
      SELECT *
      FROM queue
      WHERE status IN ('waiting','checking')
      ORDER BY priority DESC,id ASC
  `, (err, rows) => {
    if (err) return;
    io.emit("queue-update", rows);
  });
};

function requireAdmin(socket) {
  return socket.admin != null;
}

let isCutoff = false;
io.on('connection', (socket) => {
  console.log("🔌 New client connected");
  socket.emit('cutoff-status', isCutoff);
  emitQueue();

  socket.on("priority-student", (id) => {
    if (!requireAdmin(socket)) return;
    db.query(
      `UPDATE queue SET priority=1 WHERE id=?`,
      [id],
      () => emitQueue()
    );
  });

  socket.on("set-cutoff", (newState) => {
    if (!requireAdmin(socket)) return;
    isCutoff = newState;
    io.emit("cutoff-status", isCutoff);
  });

  socket.on("next-queue", () => {
    if (!requireAdmin(socket)) return;
    db.query(`
        SELECT id FROM queue
        WHERE status='waiting'
        ORDER BY priority DESC,id ASC
        LIMIT 1
    `, (err, rows) => {
      if (!rows.length) return;
      db.query(
        `UPDATE queue SET status='checking', checker=? WHERE id=?`,
        [socket.admin.id, rows[0].id],
        () => emitQueue()
      );
    });
  });

  socket.on("finish-check", () => {
    if (!requireAdmin(socket)) return;
    db.query(
      `UPDATE queue SET status='done', checker=NULL, priority=0 WHERE checker=?`,
      [socket.admin.id],
      () => emitQueue()
    );
  });

  socket.on("logout-admin", () => {
    socket.admin = null;
  });

  socket.on("restore-queue", () => {
    if (!requireAdmin(socket)) return;
    db.query(
      `SELECT id FROM queue WHERE status='done' ORDER BY id DESC LIMIT 1`,
      (err, rows) => {
        if (err || rows.length == 0) return;
        db.query(
          `UPDATE queue SET status='waiting' WHERE id=?`,
          [rows[0].id],
          () => emitQueue()
        );
      }
    );
  });

  socket.on("finish-one", (id) => {
    if (!requireAdmin(socket)) return;
    db.query(
      `UPDATE queue SET status='done', checker=NULL, priority=0 WHERE id=? AND checker=?`,
      [id, socket.admin.id],
      () => emitQueue()
    );
  });

  socket.on("select-check", (id) => {
    if (!requireAdmin(socket)) return;
    db.query(
      `UPDATE queue SET status='checking', checker=? WHERE id=? AND status='waiting'`,
      [socket.admin.id, id],
      (err, result) => {
        if (err) { console.log(err); return; }
        if (result.affectedRows == 0) {
          socket.emit("queue-already-checking");
          return;
        }
        emitQueue();
      }
    );
  });

  socket.on("cancel-check", (id) => {
    if (!requireAdmin(socket)) return;
    db.query(
      `UPDATE queue SET status='waiting', checker=NULL WHERE id=? AND checker=?`,
      [id, socket.admin.id],
      () => emitQueue()
    );
  });

  socket.on("join-queue", (data) => {
    if (isCutoff) {
      socket.emit("join-denied");
      return;
    }
    const name = data.name;
    db.query(
      "INSERT INTO queue(name,cutoff) VALUES(?,?)",
      [name, isCutoff ? 1 : 0],
      () => emitQueue()
    );
  });

  socket.on("check-admin", (password) => {
    db.query(
      "SELECT id,name FROM admins WHERE password=? LIMIT 1",
      [password],
      (err, rows) => {
        if (err || rows.length === 0) {
          socket.emit("admin-status", false);
          return;
        }
        socket.admin = rows[0];
        socket.emit("admin-status", {
          success: true,
          id: rows[0].id,    // ✅ BUG FIX: ส่ง id กลับไปด้วย
          name: rows[0].name
        });
      }
    );
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Server ready on port " + PORT));
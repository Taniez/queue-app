const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const mysql = require('mysql2');
const app = express();
const server = http.createServer(app);
const io = socketIO(server);
require('dotenv').config();

const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
});

db.connect(err => {
  if (err) throw err;
  console.log("✅ Connected to MySQL");
});

app.use(express.static('public'));

const emitQueue = () => {
  db.query("SELECT * FROM queue WHERE status = 'waiting' ORDER BY id", (err, rows) => {
    if (!err) io.emit('queue-update', rows);
  });
};

io.on('connection', (socket) => {
  console.log("🔌 New client connected");

  emitQueue();

  socket.on('join-queue', (name) => {
    db.query("INSERT INTO queue (name) VALUES (?)", [name], (err) => {
      if (!err) emitQueue();
    });
  });

  socket.on('next-queue', (isAdmin) => {
    if (!isAdmin) return;
    db.query("UPDATE queue SET status = 'called' WHERE status = 'waiting' ORDER BY id LIMIT 1", (err) => {
      if (!err) emitQueue();
    });
  });

  socket.on('restore-queue', (isAdmin) => {
    if (!isAdmin) return;
    db.query("SELECT * FROM queue WHERE status = 'called' ORDER BY id DESC LIMIT 1", (err, rows) => {
      if (!err && rows.length > 0) {
        const lastCalled = rows[0];
        db.query("UPDATE queue SET status = 'waiting' WHERE id = ?", [lastCalled.id], (err2) => {
          if (!err2) emitQueue();
        });
      }
    });
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Server ready on port ${PORT}`));

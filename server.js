const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const mysql = require('mysql2');
const fs = require('fs'); 
const app = express();
const server = http.createServer(app);
const io = socketIO(server);
require('dotenv').config();

// ✅ สร้าง connection พร้อมใช้ SSL
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 4000,
  ssl: {
    ca: fs.readFileSync(__dirname + '/ca.pem') // ✅ ใช้ CA ที่คุณวางไว้
  }
});

// ✅ เชื่อมต่อฐานข้อมูล
db.connect(err => {
  if (err) throw err;
  console.log("✅ Connected to TiDB via SSL");
});

app.use(express.static('public'));

// 👉 ส่งข้อมูล queue ไปยัง client
const emitQueue = () => {
  db.query("SELECT * FROM queue WHERE status = 'waiting' ORDER BY id", (err, rows) => {
    if (!err) io.emit('queue-update', rows);
  });
};
let isCutoff = false;
io.on('connection', (socket) => {
  console.log("🔌 New client connected");
  socket.emit('cutoff-status', isCutoff);

  emitQueue();

  socket.on('join-queue', (name) => {
    db.query("INSERT INTO queue (name) VALUES (?)", [name], (err) => {
      if (!err) emitQueue();
    });
  });
  socket.on('set-cutoff', (newState) => {
    isCutoff = newState;
    io.emit('cutoff-status', isCutoff);
  });
    socket.on('join-queue', (data) => {
    const name = typeof data === 'string' ? data : data.name;
    const cutoffStatus = typeof data === 'object' && data.isCutoff ? 1 : 0;

    db.query("INSERT INTO queue (name, cutoff) VALUES (?, ?)", [name, cutoffStatus], (err) => {
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

  // ✅ แก้ตรงนี้ให้อยู่ใน scope เดียวกัน
  socket.on('check-admin', (password) => {
    if (password === process.env.ADMIN_PASSWORD) {
      socket.emit('admin-status', true);
    } else {
      socket.emit('admin-status', false);
    }
  });
});


// ✅ เริ่มต้น server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Server ready on port " + PORT));


const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const mysql = require('mysql2');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);
require('dotenv').config();

// ✅ #4: เปลี่ยนจาก createConnection → createPool (reconnect อัตโนมัติ)
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 4000,
  ssl: { ca: fs.readFileSync(__dirname + '/ca.pem') },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// ทดสอบ connection ตอนเริ่ม
db.query('SELECT 1', (err) => {
  if (err) { console.error('❌ DB connection failed:', err); process.exit(1); }
  console.log('✅ Connected to TiDB via SSL (pool)');
});

app.use(express.static('public'));

// ✅ #1: Rate limit — จำกัดการเข้าคิวต่อ IP (max 1 ครั้ง / 5 วิ)
const joinCooldown = new Map();
const JOIN_COOLDOWN_MS = 5000;

const emitQueue = () => {
  db.query(`
    SELECT q.*, a.name AS checker_name
    FROM queue q
    LEFT JOIN admins a ON q.checker = a.id
    WHERE q.status IN ('waiting','checking')
    ORDER BY q.priority DESC, q.id ASC
  `, (err, rows) => {
    if (err) return;
    io.emit('queue-update', rows);
  });
};

// ✅ #9: ส่งประวัติคิวที่เสร็จแล้ววันนี้
const emitHistory = () => {
  db.query(`
    SELECT q.*, a.name AS checker_name
    FROM queue q
    LEFT JOIN admins a ON q.checker_done = a.id
    WHERE q.status = 'done'
      AND DATE(q.created_at) = CURDATE()
    ORDER BY q.id DESC
    LIMIT 50
  `, (err, rows) => {
    if (err) return;
    io.emit('history-update', rows);
  });
};

function requireAdmin(socket) {
  return socket.admin != null;
}

// ✅ #2: Sanitize ชื่อ — ตัด HTML tag และ trim
function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  return name
    .replace(/<[^>]*>/g, '')   // ลบ HTML tag
    .replace(/[<>"'`]/g, '')   // ลบอักขระอันตราย
    .trim()
    .slice(0, 50);             // จำกัดความยาว 50 ตัวอักษร
}

let isCutoff = false;

io.on('connection', (socket) => {
  console.log('🔌 New client connected');
  socket.emit('cutoff-status', isCutoff);
  emitQueue();
  emitHistory();

  socket.on('priority-student', (id) => {
    if (!requireAdmin(socket)) return;
    db.query('UPDATE queue SET priority=1 WHERE id=?', [id], () => emitQueue());
  });

  socket.on('set-cutoff', (newState) => {
    if (!requireAdmin(socket)) return;
    isCutoff = newState;
    io.emit('cutoff-status', isCutoff);
  });

  socket.on('next-queue', () => {
    if (!requireAdmin(socket)) return;
    db.query(`
      SELECT id FROM queue
      WHERE status='waiting'
      ORDER BY priority DESC, id ASC
      LIMIT 1
    `, (err, rows) => {
      if (!rows || !rows.length) return;
      db.query(
        'UPDATE queue SET status=\'checking\', checker=? WHERE id=?',
        [socket.admin.id, rows[0].id],
        () => emitQueue()
      );
    });
  });

  socket.on('finish-check', () => {
    if (!requireAdmin(socket)) return;
    db.query(
      'UPDATE queue SET status=\'done\', checker_done=checker, checker=NULL, priority=0 WHERE checker=?',
      [socket.admin.id],
      () => { emitQueue(); emitHistory(); }
    );
  });

  socket.on('logout-admin', () => { socket.admin = null; });

  socket.on('restore-queue', () => {
    if (!requireAdmin(socket)) return;
    db.query(
      'SELECT id FROM queue WHERE status=\'done\' ORDER BY id DESC LIMIT 1',
      (err, rows) => {
        if (err || !rows.length) return;
        db.query(
          'UPDATE queue SET status=\'waiting\', checker_done=NULL WHERE id=?',
          [rows[0].id],
          () => { emitQueue(); emitHistory(); }
        );
      }
    );
  });

  socket.on('finish-one', (id) => {
    if (!requireAdmin(socket)) return;
    db.query(
      'UPDATE queue SET status=\'done\', checker_done=checker, checker=NULL, priority=0 WHERE id=? AND checker=?',
      [id, socket.admin.id],
      () => { emitQueue(); emitHistory(); }
    );
  });

  socket.on('select-check', (id) => {
    if (!requireAdmin(socket)) return;
    db.query(
      'UPDATE queue SET status=\'checking\', checker=? WHERE id=? AND status=\'waiting\'',
      [socket.admin.id, id],
      (err, result) => {
        if (err) { console.log(err); return; }
        if (result.affectedRows === 0) { socket.emit('queue-already-checking'); return; }
        emitQueue();
      }
    );
  });

  socket.on('cancel-check', (id) => {
    if (!requireAdmin(socket)) return;
    db.query(
      'UPDATE queue SET status=\'waiting\', checker=NULL WHERE id=? AND checker=?',
      [id, socket.admin.id],
      () => emitQueue()
    );
  });

  socket.on('join-queue', (data) => {
    if (isCutoff) { socket.emit('join-denied'); return; }

    // ✅ #1: Rate limit ต่อ socket
    const now = Date.now();
    const last = joinCooldown.get(socket.id) || 0;
    if (now - last < JOIN_COOLDOWN_MS) {
      socket.emit('join-denied-cooldown');
      return;
    }
    joinCooldown.set(socket.id, now);

    // ✅ #2: Sanitize ชื่อ
    const name = sanitizeName(data.name);
    if (!name) { socket.emit('join-error', 'ชื่อไม่ถูกต้อง'); return; }

    db.query(
      'INSERT INTO queue(name, cutoff) VALUES(?, ?)',
      [name, isCutoff ? 1 : 0],
      () => emitQueue()
    );
  });

  socket.on('check-admin', (password) => {
    if (typeof password !== 'string' || password.length > 100) {
      socket.emit('admin-status', false);
      return;
    }
    db.query(
      'SELECT id, name FROM admins WHERE password=? LIMIT 1',
      [password],
      (err, rows) => {
        if (err || rows.length === 0) { socket.emit('admin-status', false); return; }
        socket.admin = rows[0];

        // ✅ BUG FIX: ดึงคิวที่ค้าง checking ของ admin คนนี้กลับมา
        // เผื่อ admin refresh หน้า socket ใหม่จะรู้ว่าตัวเองมีคิวค้างอยู่
        db.query(
          'SELECT id FROM queue WHERE status=\'checking\' AND checker=?',
          [rows[0].id],
          (err2, checking) => {
            socket.emit('admin-status', {
              success: true,
              id: rows[0].id,
              name: rows[0].name,
              resumeIds: (checking || []).map(r => r.id)  // id คิวที่ค้างอยู่
            });
          }
        );
      }
    );
  });

  socket.on('disconnect', () => {
    joinCooldown.delete(socket.id);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('Server ready on port ' + PORT));
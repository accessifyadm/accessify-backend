const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();

// ПОПРАВКА 1: Изрично разрешаваме метода DELETE в CORS
app.use(cors({
  methods: ['GET', 'POST', 'DELETE', 'PUT']
}));
app.use(express.json({ limit: '10mb' }));

const dbPath = path.resolve(__dirname, 'accessify.db');
const db = new sqlite3.Database(dbPath);

const verificationCodes = {};

db.serialize(() => {
  // Потребители
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'user'
    )
  `);

  // Врати / Обекти
  db.run(`
    CREATE TABLE IF NOT EXISTS doors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      name TEXT NOT NULL,
      owner_id INTEGER,
      hardware_ip TEXT DEFAULT '',
      FOREIGN KEY(owner_id) REFERENCES users(id)
    )
  `);

  // Права и Достъп
  db.run(`
    CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      door_id INTEGER NOT NULL,
      role TEXT DEFAULT 'tenant',
      valid_until DATETIME NULL,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(door_id) REFERENCES doors(id)
    )
  `);

  // Журнал (Audit Logs)
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      door_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(door_id) REFERENCES doors(id)
    )
  `);

  // Първоначален админ
  db.get("SELECT COUNT(*) AS count FROM users", (err, row) => {
    if (row && row.count === 0) {
      db.run(
        "INSERT INTO users (email, phone, password, role) VALUES (?, ?, ?, 'admin')", 
        ["admin@test.com", "359888123456", "123456"],
        function(err) {
          if (!err) {
            const adminId = this.lastID;
            db.run("INSERT INTO doors (address, name, owner_id, hardware_ip) VALUES (?, ?, ?, ?)", 
              ["ул. България 15", "Главна Врата", adminId, "192.168.1.101"], function(err) {
              if (!err) {
                db.run("INSERT INTO permissions (user_id, door_id, role) VALUES (?, ?, 'owner')", [adminId, this.lastID]);
              }
            });
          }
        }
      );
    }
  });
});

// 1. Viber регистрационни заявки
app.post('/api/send-viber', (req, res) => {
  const { phone, email, password } = req.body;
  if (!phone || !email || !password) return res.status(400).json({ error: 'Попълнете всички полета' });

  const code = Math.floor(1000 + Math.random() * 9000).toString();
  verificationCodes[phone] = { code, email, password };

  console.log(`[VIBER GATEWAY] Код за ${phone}: ${code}`);
  res.json({ success: true, debugCode: code });
});

app.post('/api/verify-viber', (req, res) => {
  const { phone, code } = req.body;
  const record = verificationCodes[phone];

  if (!record || record.code !== code) return res.status(400).json({ error: 'Грешен код' });

  db.run("INSERT INTO users (email, phone, password) VALUES (?, ?, ?)", [record.email, phone, record.password], function (err) {
    if (err) return res.status(400).json({ error: 'Профилът вече съществува' });
    delete verificationCodes[phone];
    res.json({ success: true });
  });
});

// 2. Вход
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const cleanEmail = email ? email.trim().toLowerCase() : '';

  db.get("SELECT * FROM users WHERE LOWER(email) = ? AND password = ?", [cleanEmail, password], (err, user) => {
    if (user) {
      res.json({ token: `user-token-${user.id}`, userId: user.id, email: user.email, role: user.role });
    } else {
      res.status(400).json({ error: 'Грешен имейл или парола' });
    }
  });
});

// 3. Вземане на врати (С GROUP BY за премахване на дубликати)
app.get('/api/doors', (req, res) => {
  const userId = req.headers['user-id'];
  if (!userId) return res.status(401).json({ error: 'Неоторизиран достъп' });

  const query = `
    SELECT d.id, d.address, d.name, d.owner_id, d.hardware_ip, p.role, p.valid_until 
    FROM doors d
    JOIN permissions p ON d.id = p.door_id
    WHERE p.user_id = ? 
      AND (p.valid_until IS NULL OR p.valid_until >= DATE('now'))
    GROUP BY d.id
    ORDER BY d.id DESC
  `;

  db.all(query, [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// 4. Добавяне на Нов Обект
app.post('/api/doors', (req, res) => {
  const userId = req.headers['user-id'];
  const { address, name, hardwareIp } = req.body;

  if (!userId || !address || !name) return res.status(400).json({ error: 'Попълнете задължителните полета' });

  db.run("INSERT INTO doors (address, name, owner_id, hardware_ip) VALUES (?, ?, ?, ?)", [address, name, userId, hardwareIp || ''], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    const doorId = this.lastID;

    db.run("INSERT INTO permissions (user_id, door_id, role) VALUES (?, ?, 'owner')", [userId, doorId], () => {
      res.json({ success: true });
    });
  });
});

// 5. Сигнал за отваряне + Журналиране
app.post('/api/open-door', (req, res) => {
  const userId = req.headers['user-id'];
  const { doorId } = req.body;

  console.log(`[СЪРВЪР] Сигнал за отваряне от Потребител ID: ${userId} за Врата ID: ${doorId}`);

  db.run(
    "INSERT INTO audit_logs (user_id, door_id, action) VALUES (?, ?, ?)",
    [userId, doorId, 'ОТКЛЮЧВАНЕ'],
    (err) => {
      if (err) console.error("Грешка при запис в Журнала:", err);
      res.json({ success: true });
    }
  );
});

// 6. Журнал - Вземане на история
app.get('/api/doors/:doorId/logs', (req, res) => {
  const doorId = req.params.doorId;

  const query = `
    SELECT a.id, u.email, u.phone, a.action, a.timestamp 
    FROM audit_logs a
    JOIN users u ON a.user_id = u.id
    WHERE a.door_id = ?
    ORDER BY a.id DESC
    LIMIT 50
  `;

  db.all(query, [doorId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// 7. МАСОВО ДОБАВЯНЕ НА ПОТРЕБИТЕЛИ
app.post('/api/admin/bulk-add-users', (req, res) => {
  const { doorId, usersList } = req.body;

  if (!Array.isArray(usersList) || usersList.length === 0) {
    return res.status(400).json({ error: 'Празен или невалиден списък' });
  }

  usersList.forEach((u) => {
    const cleanEmail = u.email ? u.email.trim().toLowerCase() : '';
    const cleanPhone = u.phone ? u.phone.trim() : '';
    const cleanValidUntil = u.validUntil ? u.validUntil.trim() : null;

    if (!cleanEmail || !cleanPhone) return;

    db.run(
      "INSERT INTO users (email, phone, password) VALUES (?, ?, '123456') ON CONFLICT(email) DO UPDATE SET phone=excluded.phone",
      [cleanEmail, cleanPhone],
      function () {
        db.get("SELECT id FROM users WHERE email = ?", [cleanEmail], (err, user) => {
          if (user) {
            db.run(
              "INSERT OR REPLACE INTO permissions (user_id, door_id, role, valid_until) VALUES (?, ?, 'tenant', ?)",
              [user.id, doorId, cleanValidUntil || null]
            );
          }
        });
      }
    );
  });

  setTimeout(() => {
    res.json({ success: true, message: 'Потребителите са добавени успешно!' });
  }, 1200);
});

// ПОПРАВКА 2: НОВ МАРШРУТ ЗА ИЗТРИВАНЕ НА ОБЕКТ
// 8. Изтриване на обект
app.delete('/api/doors/:id', (req, res) => {
  const doorId = req.params.id;
  const userId = req.headers['user-id'];

  // 1. Изтриваме първо записите в журнала, за да няма конфликти
  db.run("DELETE FROM audit_logs WHERE door_id = ?", [doorId], (err) => {
    if (err) console.error("Грешка при изтриване на журнал:", err);
    
    // 2. Изтриваме правата за достъп на всички потребители до тази врата
    db.run("DELETE FROM permissions WHERE door_id = ?", [doorId], (err) => {
      if (err) console.error("Грешка при изтриване на права:", err);
      
      // 3. Накрая изтриваме самата врата
      db.run("DELETE FROM doors WHERE id = ?", [doorId], function(err) {
        if (err) {
          return res.status(500).json({ success: false, error: 'Възникна грешка при изтриване.' });
        }
        res.json({ success: true, message: 'Обектът е изтрит успешно.' });
      });
    });
  });
});

app.listen(3000, () => {
  console.log('БЕК-ЕНД С ЖУРНАЛ И АДМИН ПАНЕЛ РАБОТИ НА ПОРТ 3000');
});
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Разрешава заявки от мобилни устройства и React Native
app.use(cors());
app.use(express.json());

// Свързване с базата данни SQLite
const dbPath = path.join(__dirname, 'accessify.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Грешка при свързване с базата данни:', err.message);
  } else {
    console.log('Свързано с SQLite базата данни.');
  }
});

// 1. Начална страница (Оправя "Cannot GET /")
app.get('/', (req, res) => {
  res.send('Accessify API работи успешно в Render!');
});

// 2. Тестов API маршрут
app.get('/api', (req, res) => {
  res.json({ status: 'success', message: 'Accessify API е онлайн.' });
});

// ----------------------------------------------------
// ТВОИТЕ API МАРШРУТИ (Примерни заявки за вход и потребители)
// ----------------------------------------------------

// Пример: Вход в системата (Login)
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const sql = `SELECT * FROM users WHERE username = ? AND password = ?`;
  
  db.get(sql, [username, password], (err, user) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!user) {
      return res.status(401).json({ message: 'Невалидни данни за вход' });
    }
    res.json({ message: 'Успешен вход!', user });
  });
});

// Пример: Вземане на всички потребители
app.get('/api/users', (req, res) => {
  const sql = `SELECT id, username, role FROM users`;
  db.all(sql, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ users: rows });
  });
});

// Стартиране на сървъра
app.listen(PORT, () => {
  console.log(`Сървърът работи на порт ${PORT}`);
});
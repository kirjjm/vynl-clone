// server.js
// Это наш сервер. Он делает две вещи:
// 1. Отдаёт статические файлы (наш index.html, CSS, JS) браузеру.
// 2. Отдаёт список треков в формате JSON по адресу /api/tracks — теперь беря их из базы данных.

const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

// Открываем файл базы данных. Если его ещё нет — сначала запусти:
//   node setup-db.js
const db = new Database('vynl.db');

// Папка, куда будут физически сохраняться загруженные mp3-файлы.
// Создаём её, если она ещё не существует.
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Настройка multer: говорим, КУДА сохранять файлы и КАК их называть на диске.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Добавляем текущее время к имени файла, чтобы два файла с одинаковым
    // названием не затёрли друг друга на диске.
    const uniqueName = Date.now() + '-' + file.originalname;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// Небольшой набор цветов для обложек новых треков — выбираем по кругу.
const coverColors = ["#e8a33d", "#4f7873", "#8a6fd6", "#c76b6b", "#5c9ad6", "#e0b84f"];

// Middleware: раздаём всё содержимое папки /public как обычные файлы
// (это касается и папки /public/uploads — значит загруженные mp3 тоже станут доступны по ссылке).
app.use(express.static(path.join(__dirname, 'public')));

// Express сам не умеет читать данные из форм (кроме файлов) — эта строка это включает.
app.use(express.urlencoded({ extended: true }));
// А эта строка позволяет читать JSON, который пришлёт фронтенд (для логина/регистрации).
app.use(express.json());

// Настройка сессий: сервер выдаёт браузеру "пропуск" (cookie), по которому потом
// узнаёт, кто уже вошёл. secret — секретная строка сервера для подписи cookie,
// в реальном проекте её хранят отдельно и никому не показывают.
app.use(session({
  secret: 'vynl-учебный-секрет-поменяй-в-реальном-проекте',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // сессия живёт 7 дней
}));

// Теперь этот маршрут не берёт данные из списка в коде,
// а делает настоящий SQL-запрос к базе данных.
app.get('/api/tracks', (req, res) => {
  // SELECT * FROM tracks — "выбери все столбцы из таблицы tracks"
  const tracks = db.prepare('SELECT * FROM tracks').all();
  res.json(tracks);
});

// Новый маршрут: приём загруженного трека.
// upload.single('audioFile') — говорит multer'у: "жди ОДИН файл, который придёт
// в форме под именем audioFile", и сохрани его согласно настройкам storage выше.
app.post('/api/tracks', upload.single('audioFile'), (req, res) => {
  const { title, artist } = req.body; // текстовые поля формы (не файл)

  if (!req.file || !title || !artist) {
    return res.status(400).json({ error: 'Не хватает данных: файл, название или исполнитель.' });
  }

  // Ссылка, по которой браузер сможет обратиться к загруженному файлу.
  const src = '/uploads/' + req.file.filename;
  const color = coverColors[Math.floor(Math.random() * coverColors.length)];

  const insert = db.prepare(
    'INSERT INTO tracks (title, artist, color, src) VALUES (?, ?, ?, ?)'
  );
  const result = insert.run(title, artist, color, src);

  // Отправляем обратно только что созданный трек — фронтенду это пригодится.
  res.json({ id: result.lastInsertRowid, title, artist, color, src });
});

// --- Регистрация ---
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Укажи имя пользователя и пароль.' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'Пароль слишком короткий (минимум 4 символа).' });
  }

  // bcrypt.hash превращает пароль в необратимый хеш.
  // Число 10 — "сложность" хеширования: чем больше, тем дольше и надёжнее.
  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const insert = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
    const result = insert.run(username, passwordHash);

    // Сразу логиним только что зарегистрированного пользователя,
    // сохраняя его id в сессию.
    req.session.userId = result.lastInsertRowid;
    res.json({ id: result.lastInsertRowid, username });

  } catch (err) {
    // UNIQUE constraint failed — значит такое имя пользователя уже занято.
    res.status(400).json({ error: 'Такое имя пользователя уже занято.' });
  }
});

// --- Вход ---
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    return res.status(401).json({ error: 'Неверное имя пользователя или пароль.' });
  }

  // bcrypt.compare сравнивает введённый пароль с сохранённым хешем.
  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) {
    return res.status(401).json({ error: 'Неверное имя пользователя или пароль.' });
  }

  req.session.userId = user.id;
  res.json({ id: user.id, username: user.username });
});

// --- Выход ---
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// --- Кто сейчас вошёл (проверка при загрузке страницы) ---
app.get('/api/me', (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null });
  }
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.session.userId);
  res.json({ user: user || null });
});

// Запускаем сервер — он начинает "слушать" запросы на порту 3000.
app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});


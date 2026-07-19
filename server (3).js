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
// DATA_DIR — путь к постоянному хранилищу на хостинге (Railway Volume).
// Локально на твоём компьютере такой переменной нет, поэтому используется папка проекта.
const dataDir = process.env.DATA_DIR || __dirname;
const db = new Database(path.join(dataDir, 'vynl.db'));

// Создаём таблицы, если их ещё нет (важно при первом запуске на хостинге —
// там некому вручную выполнить setup-db.js, поэтому сервер делает это сам).
db.exec(`
  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    color TEXT NOT NULL,
    src TEXT NOT NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
  )
`);

// Сам плейлист — просто название и чей он (user_id).
db.exec(`
  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// Таблица-связка: какой трек лежит в каком плейлисте.
// Один трек может быть сразу в нескольких разных плейлистах — поэтому
// это отдельная таблица, а не просто список id внутри playlists.
db.exec(`
  CREATE TABLE IF NOT EXISTS playlist_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id),
    FOREIGN KEY (track_id) REFERENCES tracks(id)
  )
`);

// При самом первом запуске (пустая таблица) — наполняем демо-треками,
// точно так же, как это делал отдельный файл setup-db.js.
const trackCount = db.prepare('SELECT COUNT(*) AS count FROM tracks').get();
if (trackCount.count === 0) {
  const insertInitial = db.prepare(
    'INSERT INTO tracks (title, artist, color, src) VALUES (?, ?, ?, ?)'
  );
  const initialTracks = [
    ["Ночной эфир",     "Studio Loop",  "#e8a33d", "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"],
    ["Пустая комната",  "Aria North",   "#4f7873", "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3"],
    ["Сигнал",          "Vector Field", "#8a6fd6", "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3"],
    ["Медленный город", "Studio Loop",  "#c76b6b", "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3"],
    ["Стекло",          "Nine Rivers",  "#5c9ad6", "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3"],
    ["Между строк",     "Aria North",   "#e0b84f", "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3"],
  ];
  for (const t of initialTracks) insertInitial.run(...t);
  console.log(`Добавлено ${initialTracks.length} демо-треков при первом запуске.`);
}

// Папка, куда будут физически сохраняться загруженные mp3-файлы.
// Тоже кладём внутрь dataDir, чтобы они сохранялись на постоянном диске.
const uploadsDir = path.join(dataDir, 'uploads');
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
// Отдельно раздаём загруженные mp3-файлы — они теперь лежат в dataDir/uploads,
// а не внутри /public, потому что этой папке нужно постоянное хранилище.
app.use('/uploads', express.static(uploadsDir));

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

// --- Middleware: "охранник" для маршрутов, которые доступны только вошедшим ---
// Ставится ПЕРЕД обработчиком маршрута. Если пользователь не вошёл — сразу
// отвечает ошибкой и не пускает код дальше. Если вошёл — пропускает (next()).
function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Нужно войти в аккаунт.' });
  }
  next();
}

// --- Список плейлистов текущего пользователя ---
app.get('/api/playlists', requireLogin, (req, res) => {
  const playlists = db.prepare('SELECT * FROM playlists WHERE user_id = ?').all(req.session.userId);
  res.json(playlists);
});

// --- Создать новый плейлист ---
app.post('/api/playlists', requireLogin, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Укажи название плейлиста.' });

  const insert = db.prepare('INSERT INTO playlists (user_id, name) VALUES (?, ?)');
  const result = insert.run(req.session.userId, name);
  res.json({ id: result.lastInsertRowid, user_id: req.session.userId, name });
});

// --- Получить один плейлист вместе со всеми его треками ---
app.get('/api/playlists/:id', requireLogin, (req, res) => {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!playlist) return res.status(404).json({ error: 'Плейлист не найден.' });

  // JOIN — объединяем две таблицы: playlist_tracks (кто в каком плейлисте)
  // и tracks (сама информация о треке), чтобы получить полные данные треков.
  const tracks = db.prepare(`
    SELECT tracks.* FROM playlist_tracks
    JOIN tracks ON tracks.id = playlist_tracks.track_id
    WHERE playlist_tracks.playlist_id = ?
  `).all(req.params.id);

  res.json({ ...playlist, tracks });
});

// --- Добавить трек в плейлист ---
app.post('/api/playlists/:id/tracks', requireLogin, (req, res) => {
  const { trackId } = req.body;
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!playlist) return res.status(404).json({ error: 'Плейлист не найден.' });

  db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id) VALUES (?, ?)')
    .run(req.params.id, trackId);
  res.json({ ok: true });
});

// Запускаем сервер — он начинает "слушать" запросы на порту 3000.
app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});


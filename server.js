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

// Миграция: раньше у tracks не было владельца. Добавляем колонку, если её ещё нет —
// это выполняется и локально, и на хостинге при каждом старте сервера,
// поэтому безопасно и для чистой БД, и для уже наполненной данными (Railway Volume).
const trackColumns = db.prepare('PRAGMA table_info(tracks)').all();
if (!trackColumns.some(c => c.name === 'user_id')) {
  db.exec('ALTER TABLE tracks ADD COLUMN user_id INTEGER REFERENCES users(id)');
  console.log('Миграция: в tracks добавлена колонка user_id.');
}

// Миграция (Уровень 2): метаданные трека — жанр, описание, обложка,
// длительность, счётчик прослушиваний, дата создания. Тот же приём:
// проверяем список колонок и добавляем недостающие, безопасно для
// уже наполненной базы на Railway.
const trackColumnsV2 = db.prepare('PRAGMA table_info(tracks)').all().map(c => c.name);
const newTrackColumns = [
  ['genre', 'TEXT'],
  ['description', 'TEXT'],
  ['cover_path', 'TEXT'],
  ['duration', 'INTEGER'],
  ['play_count', 'INTEGER DEFAULT 0'],
  ['created_at', 'TEXT'],
  ['is_private', 'INTEGER DEFAULT 0']
];
for (const [name, type] of newTrackColumns) {
  if (!trackColumnsV2.includes(name)) {
    db.exec(`ALTER TABLE tracks ADD COLUMN ${name} ${type}`);
    console.log(`Миграция: в tracks добавлена колонка ${name}.`);
  }
}

// Лайки: кто каким трекам поставил лайк. UNIQUE(user_id, track_id) не даёт
// одному пользователю лайкнуть один и тот же трек дважды.
db.exec(`
  CREATE TABLE IF NOT EXISTS likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, track_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (track_id) REFERENCES tracks(id)
  )
`);

// Подписки: follower_id подписан на followee_id.
db.exec(`
  CREATE TABLE IF NOT EXISTS follows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    follower_id INTEGER NOT NULL,
    followee_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(follower_id, followee_id),
    FOREIGN KEY (follower_id) REFERENCES users(id),
    FOREIGN KEY (followee_id) REFERENCES users(id)
  )
`);

// Комментарии под треками.
db.exec(`
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (track_id) REFERENCES tracks(id)
  )
`);

// Репосты: user_id поделился чужим (или своим) треком у себя — трек попадает
// в ленту его подписчиков с пометкой "репостнул X". UNIQUE — нельзя
// репостнуть один и тот же трек дважды.
db.exec(`
  CREATE TABLE IF NOT EXISTS reposts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, track_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (track_id) REFERENCES tracks(id)
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

// Миграция: плейлист можно сделать публичным (доступным по ссылке без входа).
const playlistColumns = db.prepare('PRAGMA table_info(playlists)').all().map(c => c.name);
if (!playlistColumns.includes('is_public')) {
  db.exec('ALTER TABLE playlists ADD COLUMN is_public INTEGER DEFAULT 0');
  console.log('Миграция: в playlists добавлена колонка is_public.');
}

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

// Загрузка трека теперь принимает не один файл, а два поля: сам аудиофайл
// и (не обязательно) картинку обложки. upload.fields умеет сразу оба.
const uploadTrackFiles = upload.fields([
  { name: 'audioFile', maxCount: 1 },
  { name: 'cover', maxCount: 1 }
]);

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
  // 0 — заглушка вместо userId, если никто не вошёл: реальный id в базе
  // никогда не будет 0 (AUTOINCREMENT начинается с 1), так что liked_by_me
  // просто всегда окажется 0/false для гостя.
  const viewerId = req.session.userId || 0;

  // LEFT JOIN — у демо-треков user_id пустой (NULL), но они всё равно должны
  // попасть в список, поэтому не INNER JOIN, а именно LEFT.
  // like_count/comment_count — подзапросы, которые на лету считают,
  // сколько у трека лайков и комментариев. liked_by_me — лайкнул ли трек
  // именно тот, кто сейчас смотрит список.
  // Приватные треки — только на странице своего профиля у владельца,
  // в общей библиотеке (этот маршрут) их не показываем никому.
  const tracks = db.prepare(`
    SELECT tracks.*, users.username AS owner_username,
      (SELECT COUNT(*) FROM likes WHERE likes.track_id = tracks.id) AS like_count,
      (SELECT COUNT(*) FROM comments WHERE comments.track_id = tracks.id) AS comment_count,
      (SELECT COUNT(*) FROM likes WHERE likes.track_id = tracks.id AND likes.user_id = ?) AS liked_by_me,
      (SELECT COUNT(*) FROM reposts WHERE reposts.track_id = tracks.id) AS repost_count,
      (SELECT COUNT(*) FROM reposts WHERE reposts.track_id = tracks.id AND reposts.user_id = ?) AS reposted_by_me
    FROM tracks
    LEFT JOIN users ON users.id = tracks.user_id
    WHERE tracks.is_private IS NULL OR tracks.is_private = 0
  `).all(viewerId, viewerId);
  res.json(tracks);
});

// Новый маршрут: приём загруженного трека. Загружать может только вошедший
// пользователь (requireLogin определён ниже, но объявления function поднимаются
// наверх файла, так что ссылаться на него здесь можно).
// upload.single('audioFile') — говорит multer'у: "жди ОДИН файл, который придёт
// в форме под именем audioFile", и сохрани его согласно настройкам storage выше.
app.post('/api/tracks', requireLogin, uploadTrackFiles, async (req, res) => {
  const { title, artist, genre, description, isPrivate } = req.body; // текстовые поля формы (не файлы)
  const audioFile = req.files && req.files.audioFile && req.files.audioFile[0];
  const coverFile = req.files && req.files.cover && req.files.cover[0];

  if (!audioFile || !title || !artist) {
    return res.status(400).json({ error: 'Не хватает данных: файл, название или исполнитель.' });
  }

  // Ссылка, по которой браузер сможет обратиться к загруженному файлу.
  const src = '/uploads/' + audioFile.filename;
  const coverPath = coverFile ? '/uploads/' + coverFile.filename : null;
  const color = coverColors[Math.floor(Math.random() * coverColors.length)];

  // Пытаемся сами прочитать длительность из аудиофайла (сколько секунд он длится).
  // music-metadata — библиотека только под ESM (без require), поэтому подключаем
  // её динамическим import() прямо здесь. Если файл повреждён или формат странный —
  // просто оставляем длительность пустой, это не повод отказывать в загрузке.
  let duration = null;
  try {
    const mm = await import('music-metadata');
    const metadata = await mm.parseFile(audioFile.path);
    duration = Math.round(metadata.format.duration || 0);
  } catch (err) {
    console.log('Не удалось определить длительность трека:', err.message);
  }

  const insert = db.prepare(`
    INSERT INTO tracks (title, artist, color, src, user_id, genre, description, cover_path, duration, play_count, created_at, is_private)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), ?)
  `);
  const result = insert.run(
    title, artist, color, src, req.session.userId,
    genre || null, description || null, coverPath, duration,
    isPrivate === 'true' || isPrivate === '1' ? 1 : 0
  );

  // Отправляем обратно только что созданный трек — фронтенду это пригодится.
  res.json({ id: result.lastInsertRowid, title, artist, color, src, user_id: req.session.userId });
});

// --- Отметить прослушивание (для счётчика play_count) ---
app.post('/api/tracks/:id/play', (req, res) => {
  db.prepare('UPDATE tracks SET play_count = play_count + 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Репост: поделиться чужим (или своим) треком у себя ---
app.post('/api/tracks/:id/repost', requireLogin, (req, res) => {
  const track = db.prepare('SELECT id, user_id, is_private FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Трек не найден.' });
  // Приватный чужой трек нельзя репостнуть, даже зная его id напрямую —
  // иначе приватность можно было бы обойти, просто угадав номер трека.
  if (track.is_private && track.user_id !== req.session.userId) {
    return res.status(403).json({ error: 'Этот трек приватный.' });
  }

  db.prepare('INSERT OR IGNORE INTO reposts (user_id, track_id) VALUES (?, ?)')
    .run(req.session.userId, req.params.id);
  res.json({ ok: true });
});

// --- Отменить репост ---
app.delete('/api/tracks/:id/repost', requireLogin, (req, res) => {
  db.prepare('DELETE FROM reposts WHERE user_id = ? AND track_id = ?')
    .run(req.session.userId, req.params.id);
  res.json({ ok: true });
});

// --- Поиск по трекам: название, исполнитель, жанр ---
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ tracks: [] });

  const viewerId = req.session.userId || 0;
  const like = `%${q}%`;
  const tracks = db.prepare(`
    SELECT tracks.*, users.username AS owner_username,
      (SELECT COUNT(*) FROM likes WHERE likes.track_id = tracks.id) AS like_count,
      (SELECT COUNT(*) FROM comments WHERE comments.track_id = tracks.id) AS comment_count,
      (SELECT COUNT(*) FROM likes WHERE likes.track_id = tracks.id AND likes.user_id = ?) AS liked_by_me,
      (SELECT COUNT(*) FROM reposts WHERE reposts.track_id = tracks.id) AS repost_count,
      (SELECT COUNT(*) FROM reposts WHERE reposts.track_id = tracks.id AND reposts.user_id = ?) AS reposted_by_me
    FROM tracks
    LEFT JOIN users ON users.id = tracks.user_id
    WHERE (tracks.is_private IS NULL OR tracks.is_private = 0)
      AND (tracks.title LIKE ? OR tracks.artist LIKE ? OR tracks.genre LIKE ?)
    ORDER BY tracks.id DESC
    LIMIT 60
  `).all(viewerId, viewerId, like, like, like);

  res.json({ tracks });
});

// --- Удалить свой трек ---
app.delete('/api/tracks/:id', requireLogin, (req, res) => {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Трек не найден.' });
  if (track.user_id !== req.session.userId) {
    return res.status(403).json({ error: 'Можно удалять только свои треки.' });
  }

  // Сначала убираем все следы трека в других таблицах (иначе там останутся
  // "битые" строки, ссылающиеся на уже удалённый id), потом сам трек.
  db.prepare('DELETE FROM playlist_tracks WHERE track_id = ?').run(track.id);
  db.prepare('DELETE FROM likes WHERE track_id = ?').run(track.id);
  db.prepare('DELETE FROM comments WHERE track_id = ?').run(track.id);
  db.prepare('DELETE FROM reposts WHERE track_id = ?').run(track.id);
  db.prepare('DELETE FROM tracks WHERE id = ?').run(track.id);

  // Демо-треки ссылаются на внешний soundhelix.com, а не на файл на диске —
  // трогаем диск только для реально загруженных файлов (это касается и
  // аудиофайла, и обложки, если она была).
  for (const filePart of [track.src, track.cover_path]) {
    if (filePart && filePart.startsWith('/uploads/')) {
      const filePath = path.join(uploadsDir, filePart.replace('/uploads/', ''));
      fs.unlink(filePath, () => {}); // не страшно, если файла уже нет
    }
  }

  res.json({ ok: true });
});

// --- Публичный профиль пользователя: сам пользователь + его треки ---
app.get('/api/users/:username', (req, res) => {
  const user = db.prepare('SELECT id, username FROM users WHERE username = ?').get(req.params.username);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден.' });

  const viewerId = req.session.userId || 0;
  // Свои приватные треки видит только сам владелец профиля — все остальные
  // (включая гостей) видят только публичные.
  const isOwnProfile = viewerId === user.id;
  const tracks = db.prepare(`
    SELECT tracks.*, users.username AS owner_username,
      (SELECT COUNT(*) FROM likes WHERE likes.track_id = tracks.id) AS like_count,
      (SELECT COUNT(*) FROM comments WHERE comments.track_id = tracks.id) AS comment_count,
      (SELECT COUNT(*) FROM likes WHERE likes.track_id = tracks.id AND likes.user_id = ?) AS liked_by_me,
      (SELECT COUNT(*) FROM reposts WHERE reposts.track_id = tracks.id) AS repost_count,
      (SELECT COUNT(*) FROM reposts WHERE reposts.track_id = tracks.id AND reposts.user_id = ?) AS reposted_by_me
    FROM tracks
    LEFT JOIN users ON users.id = tracks.user_id
    WHERE tracks.user_id = ? ${isOwnProfile ? '' : 'AND (tracks.is_private IS NULL OR tracks.is_private = 0)'}
  `).all(viewerId, viewerId, user.id);

  const followersCount = db.prepare('SELECT COUNT(*) AS c FROM follows WHERE followee_id = ?').get(user.id).c;
  const followingCount = db.prepare('SELECT COUNT(*) AS c FROM follows WHERE follower_id = ?').get(user.id).c;
  const isFollowedByMe = viewerId
    ? !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(viewerId, user.id)
    : false;

  res.json({
    user: {
      ...user,
      followers_count: followersCount,
      following_count: followingCount,
      is_followed_by_me: isFollowedByMe
    },
    tracks
  });
});

// --- Похожие исполнители (как "Fans also like" в Spotify) ---
// Основной сигнал — "люди, которые лайкали треки этого артиста, ещё лайкали треки Y":
// находим всех, кто лайкал X, смотрим, что ЕЩЁ они лайкали (не считая самого X),
// и группируем по автору — чем больше общих лайков, тем выше похожесть.
// Если лайков мало и сигнала не набралось — подстраховываемся общим жанром.
app.get('/api/users/:username/similar', (req, res) => {
  const user = db.prepare('SELECT id, username FROM users WHERE username = ?').get(req.params.username);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден.' });

  let similar = db.prepare(`
    SELECT u2.username AS username, COUNT(*) AS score
    FROM likes l1
    JOIN tracks t1 ON t1.id = l1.track_id AND t1.user_id = ?
    JOIN likes l2 ON l2.user_id = l1.user_id
    JOIN tracks t2 ON t2.id = l2.track_id AND t2.user_id != ?
    JOIN users u2 ON u2.id = t2.user_id
    GROUP BY u2.id
    ORDER BY score DESC
    LIMIT 6
  `).all(user.id, user.id);

  if (similar.length === 0) {
    similar = db.prepare(`
      SELECT DISTINCT users.username AS username
      FROM tracks
      JOIN users ON users.id = tracks.user_id
      WHERE tracks.user_id != ?
        AND tracks.genre IS NOT NULL
        AND tracks.genre IN (SELECT DISTINCT genre FROM tracks WHERE user_id = ? AND genre IS NOT NULL)
      LIMIT 6
    `).all(user.id, user.id);
  }

  res.json({ artists: similar.map(s => s.username) });
});

// --- Подписаться на пользователя ---
app.post('/api/users/:id/follow', requireLogin, (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.session.userId) {
    return res.status(400).json({ error: 'Нельзя подписаться на самого себя.' });
  }
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден.' });

  // INSERT OR IGNORE — если подписка уже есть (UNIQUE), просто ничего не делать,
  // а не падать с ошибкой.
  db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)')
    .run(req.session.userId, targetId);
  res.json({ ok: true });
});

// --- Отписаться ---
app.delete('/api/users/:id/follow', requireLogin, (req, res) => {
  db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?')
    .run(req.session.userId, req.params.id);
  res.json({ ok: true });
});

// --- Поставить лайк треку ---
app.post('/api/tracks/:id/like', requireLogin, (req, res) => {
  const track = db.prepare('SELECT id FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Трек не найден.' });

  db.prepare('INSERT OR IGNORE INTO likes (user_id, track_id) VALUES (?, ?)')
    .run(req.session.userId, req.params.id);
  res.json({ ok: true });
});

// --- Убрать лайк ---
app.delete('/api/tracks/:id/like', requireLogin, (req, res) => {
  db.prepare('DELETE FROM likes WHERE user_id = ? AND track_id = ?')
    .run(req.session.userId, req.params.id);
  res.json({ ok: true });
});

// --- Комментарии под треком: список ---
app.get('/api/tracks/:id/comments', (req, res) => {
  const comments = db.prepare(`
    SELECT comments.*, users.username FROM comments
    JOIN users ON users.id = comments.user_id
    WHERE comments.track_id = ?
    ORDER BY comments.id ASC
  `).all(req.params.id);
  res.json(comments);
});

// --- Добавить комментарий ---
app.post('/api/tracks/:id/comments', requireLogin, (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Комментарий не может быть пустым.' });
  }

  const track = db.prepare('SELECT id FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Трек не найден.' });

  const insert = db.prepare('INSERT INTO comments (user_id, track_id, text) VALUES (?, ?, ?)');
  const result = insert.run(req.session.userId, req.params.id, text.trim());

  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.session.userId);
  res.json({
    id: result.lastInsertRowid,
    user_id: req.session.userId,
    track_id: Number(req.params.id),
    text: text.trim(),
    username: user.username
  });
});

// --- Лента: треки тех, на кого я подписан ---
// Лента — это объединение (UNION) двух источников: треки, которые сами
// загрузили те, на кого я подписан, И треки, которые они репостнули (даже
// если оригинального автора я не читаю). У обеих половин ОДИНАКОВЫЙ набор
// колонок (это требование SQL для UNION) — reposted_by у обычных загрузок
// всегда NULL, activity_at — единая колонка для сортировки по свежести
// (дата загрузки трека либо дата репоста, смотря что это за строка).
app.get('/api/feed', requireLogin, (req, res) => {
  const userId = req.session.userId;
  const tracks = db.prepare(`
    SELECT tracks.*, u1.username AS owner_username,
      (SELECT COUNT(*) FROM likes WHERE likes.track_id = tracks.id) AS like_count,
      (SELECT COUNT(*) FROM comments WHERE comments.track_id = tracks.id) AS comment_count,
      (SELECT COUNT(*) FROM likes WHERE likes.track_id = tracks.id AND likes.user_id = ?) AS liked_by_me,
      NULL AS reposted_by,
      tracks.created_at AS activity_at
    FROM tracks
    JOIN follows ON follows.followee_id = tracks.user_id
    JOIN users u1 ON u1.id = tracks.user_id
    WHERE follows.follower_id = ? AND (tracks.is_private IS NULL OR tracks.is_private = 0)

    UNION ALL

    SELECT tracks.*, u1.username AS owner_username,
      (SELECT COUNT(*) FROM likes WHERE likes.track_id = tracks.id) AS like_count,
      (SELECT COUNT(*) FROM comments WHERE comments.track_id = tracks.id) AS comment_count,
      (SELECT COUNT(*) FROM likes WHERE likes.track_id = tracks.id AND likes.user_id = ?) AS liked_by_me,
      u2.username AS reposted_by,
      reposts.created_at AS activity_at
    FROM reposts
    JOIN tracks ON tracks.id = reposts.track_id
    JOIN users u1 ON u1.id = tracks.user_id
    JOIN follows ON follows.followee_id = reposts.user_id
    JOIN users u2 ON u2.id = reposts.user_id
    WHERE follows.follower_id = ? AND (tracks.is_private IS NULL OR tracks.is_private = 0)

    ORDER BY activity_at DESC
    LIMIT 100
  `).all(userId, userId, userId, userId);
  res.json(tracks);
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
  const { name, isPublic } = req.body;
  if (!name) return res.status(400).json({ error: 'Укажи название плейлиста.' });

  const insert = db.prepare('INSERT INTO playlists (user_id, name, is_public) VALUES (?, ?, ?)');
  const result = insert.run(req.session.userId, name, isPublic ? 1 : 0);
  res.json({ id: result.lastInsertRowid, user_id: req.session.userId, name, is_public: isPublic ? 1 : 0 });
});

// --- Получить один плейлист вместе со всеми его треками ---
app.get('/api/playlists/:id', requireLogin, (req, res) => {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!playlist) return res.status(404).json({ error: 'Плейлист не найден.' });

  // JOIN — объединяем две таблицы: playlist_tracks (кто в каком плейлисте)
  // и tracks (сама информация о треке), чтобы получить полные данные треков.
  const tracks = db.prepare(`
    SELECT tracks.*, users.username AS owner_username,
      (SELECT COUNT(*) FROM likes WHERE likes.track_id = tracks.id) AS like_count,
      (SELECT COUNT(*) FROM comments WHERE comments.track_id = tracks.id) AS comment_count,
      (SELECT COUNT(*) FROM likes WHERE likes.track_id = tracks.id AND likes.user_id = ?) AS liked_by_me,
      (SELECT COUNT(*) FROM reposts WHERE reposts.track_id = tracks.id) AS repost_count,
      (SELECT COUNT(*) FROM reposts WHERE reposts.track_id = tracks.id AND reposts.user_id = ?) AS reposted_by_me
    FROM playlist_tracks
    JOIN tracks ON tracks.id = playlist_tracks.track_id
    LEFT JOIN users ON users.id = tracks.user_id
    WHERE playlist_tracks.playlist_id = ?
  `).all(req.session.userId, req.session.userId, req.params.id);

  res.json({ ...playlist, tracks });
});

// --- Публичный плейлист по ссылке — доступен всем, без входа ---
app.get('/api/playlists/:id/public', (req, res) => {
  const playlist = db.prepare('SELECT playlists.*, users.username AS owner_username FROM playlists JOIN users ON users.id = playlists.user_id WHERE playlists.id = ? AND playlists.is_public = 1')
    .get(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Плейлист не найден или не является публичным.' });

  const viewerId = req.session.userId || 0;
  const tracks = db.prepare(`
    SELECT tracks.*, users.username AS owner_username,
      (SELECT COUNT(*) FROM likes WHERE likes.track_id = tracks.id) AS like_count,
      (SELECT COUNT(*) FROM comments WHERE comments.track_id = tracks.id) AS comment_count,
      (SELECT COUNT(*) FROM likes WHERE likes.track_id = tracks.id AND likes.user_id = ?) AS liked_by_me,
      (SELECT COUNT(*) FROM reposts WHERE reposts.track_id = tracks.id) AS repost_count,
      (SELECT COUNT(*) FROM reposts WHERE reposts.track_id = tracks.id AND reposts.user_id = ?) AS reposted_by_me
    FROM playlist_tracks
    JOIN tracks ON tracks.id = playlist_tracks.track_id
    LEFT JOIN users ON users.id = tracks.user_id
    WHERE playlist_tracks.playlist_id = ? AND (tracks.is_private IS NULL OR tracks.is_private = 0)
  `).all(viewerId, viewerId, req.params.id);

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


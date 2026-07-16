// setup-db.js
// Этот файл запускается ОДИН РАЗ, чтобы создать базу данных и наполнить её треками.
// После первого запуска можно про него забыть — база уже будет сохранена в файле vynl.db

const Database = require('better-sqlite3');

// Эта строка создаёт (или открывает, если уже существует) файл базы данных vynl.db
// Всё содержимое базы будет физически храниться в этом одном файле.
const db = new Database('vynl.db');

// CREATE TABLE — команда SQL: "создай таблицу с такими столбцами".
// IF NOT EXISTS — чтобы не было ошибки, если таблица уже была создана раньше.
db.exec(`
  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    color TEXT NOT NULL,
    src TEXT NOT NULL
  )
`);

// Таблица пользователей.
// password_hash — сюда попадает НЕ сам пароль, а его хеш (см. объяснение в server.js).
// username должен быть уникальным — UNIQUE не даст создать двух пользователей с одним именем.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
  )
`);
// PRIMARY KEY AUTOINCREMENT — id будет присваиваться автоматически (1, 2, 3...), сами его не указываем.
// TEXT NOT NULL — текстовое поле, которое обязательно должно быть заполнено.

// Проверяем: если в таблице уже есть треки — ничего не добавляем повторно.
const count = db.prepare('SELECT COUNT(*) AS count FROM tracks').get();

if (count.count === 0) {
  // INSERT INTO — команда SQL "добавь строку в таблицу".
  // Знаки вопроса — это "заглушки", вместо них подставятся реальные значения ниже.
  const insert = db.prepare(
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

  for (const t of initialTracks) {
    insert.run(...t); // ...t "распаковывает" массив в 4 отдельных значения
  }

  console.log(`Добавлено ${initialTracks.length} треков в базу данных.`);
} else {
  console.log(`В базе уже есть ${count.count} треков — пропускаем заполнение.`);
}

db.close();
console.log('Готово. База данных: vynl.db');

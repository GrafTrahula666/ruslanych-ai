import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export function openDb(dataDir: string, file = 'ruslanych.sqlite'): Db {
  let target = file;
  if (file !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true });
    target = path.join(dataDir, file);
  }
  const db = new DatabaseSync(target);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      -- reserved for VK ID login later
      user_id TEXT
    );

    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      player_color TEXT NOT NULL CHECK (player_color IN ('w','b')),
      fen TEXT NOT NULL,
      moves TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK (status IN ('active','finished')),
      result TEXT CHECK (result IN ('player','ai','draw')),
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS games_session ON games(session_id, id);
    -- at most one unfinished game per session
    CREATE UNIQUE INDEX IF NOT EXISTS games_one_active ON games(session_id) WHERE status = 'active';
  `);
  return db;
}

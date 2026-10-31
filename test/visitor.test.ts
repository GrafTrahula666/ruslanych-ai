import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Chess } from 'chess.js';
import { GameError, GameService, GUEST_TIME_MS } from '../server/games.ts';
import { openDb } from '../server/db.ts';
import { ScriptedEngine, mv } from './helpers.ts';

const BASE = { total: 1089, ruslanych: 567, ai: 522, ruslanychWinPercent: 52 };

test('AI opens as white, guest name saved, only guest thinking time deducted', async () => {
  const db = openDb('', ':memory:');
  let time = 1_000_000;
  const engine = new ScriptedEngine();
  const games = new GameService(db, engine, 10, 'b', () => time);
  const sid = games.ensureSession(undefined);
  const initial = games.newGame(sid, '  Анна  ');
  assert.equal(initial.playerColor, 'b');
  assert.equal(initial.playerName, 'Анна');
  assert.equal(initial.playerRemainingMs, GUEST_TIME_MS);
  assert.equal(initial.playerTurnStartedAtMs, null);
  await games.idle();
  let current = games.get(sid, initial.id);
  assert.equal(current.moves.length, 1);
  assert.equal(current.moves[0].by, 'ai');
  assert.equal(current.turn, 'player');
  assert.equal(current.playerTurnStartedAtMs, time);
  time += 42_000;
  current = games.get(sid, initial.id);
  assert.equal(current.playerRemainingMs, GUEST_TIME_MS - 42_000);
  const black = new Chess(current.fen).moves({ verbose: true })[0];
  engine.delayMs = 5;
  const pending = games.playerMove(sid, current.id, mv(black.lan), 1);
  time += 10_000; // AI calculating must not consume guest clock
  await pending;
  current = games.get(sid, initial.id);
  assert.equal(current.playerRemainingMs, GUEST_TIME_MS - 42_000);
  assert.equal(current.turn, 'player');
  db.close();
});

test('server flags guest after seven minutes even if browser is closed', async () => {
  const db = openDb('', ':memory:');
  let time = 3_000_000;
  const games = new GameService(db, new ScriptedEngine(), 10, 'b', () => time);
  const sid = games.ensureSession(undefined);
  const initial = games.newGame(sid, 'Кирилл');
  await games.idle();
  time += GUEST_TIME_MS + 1;
  const expired = games.get(sid, initial.id);
  assert.equal(expired.result, 'ai');
  assert.equal(expired.reason, 'timeout');
  assert.equal(expired.playerRemainingMs, 0);
  const candidate = new Chess(expired.fen).moves({ verbose: true })[0];
  await assert.rejects(games.playerMove(sid, initial.id, mv(candidate.lan), 1),
    (e: unknown) => e instanceof GameError && e.status === 409);
  assert.equal(games.stats(BASE).players.aiWins, 1);
  assert.equal(games.stats(BASE).players.total, 1);
  const second = games.newGame(sid, 'Кирилл');
  assert.notEqual(second.id, initial.id);
  await games.idle();
  db.close();
});

test('SQLite migration preserves existing games without clock or name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsl-legacy-'));
  const file = path.join(dir, 'legacy.sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, user_id TEXT);
    CREATE TABLE games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      player_color TEXT NOT NULL CHECK (player_color IN ('w','b')),
      fen TEXT NOT NULL, moves TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK (status IN ('active','finished')),
      result TEXT, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      finished_at TEXT
    );`);
  legacy.prepare('INSERT INTO sessions (id,created_at) VALUES (?,?)').run('olduser', new Date().toISOString());
  legacy.prepare("INSERT INTO games (session_id,player_color,fen,moves,status,created_at,updated_at) VALUES (?, 'w', ?, '[]', 'active', ?, ?)")
    .run('olduser', new Chess().fen(), new Date().toISOString(), new Date().toISOString());
  legacy.close();
  const db = openDb(dir, 'legacy.sqlite');
  const svc = new GameService(db, new ScriptedEngine(), 10);
  const game = svc.current('olduser');
  assert.equal(game?.status, 'active');
  assert.equal(game?.playerColor, 'w');
  assert.equal(game?.playerRemainingMs, null);
  assert.equal(game?.playerName, 'Гость');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Chess } from 'chess.js';
import { GameError, GameService, endState } from '../server/games.ts';
import { openDb } from '../server/db.ts';
import { ScriptedEngine, mv, play, setup } from './helpers.ts';

const BASE = { total: 1089, ruslanych: 567, ai: 522, ruslanychWinPercent: 52 };

async function rejects(p: Promise<unknown> | (() => unknown), status: number, code: string) {
  await assert.rejects(async () => (typeof p === 'function' ? p() : p), (e: unknown) => {
    assert.ok(e instanceof GameError, String(e));
    assert.equal(e.status, status);
    assert.equal(e.code, code);
    return true;
  });
}

test('player checkmates the AI (scholar mate) and the win is counted once', async () => {
  const { games, engine } = setup();
  const sid = games.ensureSession(undefined);
  const g0 = games.newGame(sid);
  const g = await play(games, engine, sid, g0.id, ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7']);
  assert.equal(g.status, 'finished');
  assert.equal(g.result, 'player');
  assert.equal(g.reason, 'checkmate');
  assert.equal(engine.calls, 3, 'AI must not be asked to move after mate');
  games.resign(sid, g.id); // no effect on a finished game
  const s = games.stats(BASE);
  assert.deepEqual(s.players, { total: 1, playerWins: 1, aiWins: 0, draws: 0, aiWinPercent: 0 });
  assert.deepEqual(s.ruslanych, BASE);
});

test('AI checkmates the player (fool mate)', async () => {
  const { games, engine } = setup();
  const sid = games.ensureSession(undefined);
  const g0 = games.newGame(sid);
  const g = await play(games, engine, sid, g0.id, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
  assert.equal(g.result, 'ai');
  assert.equal(g.reason, 'checkmate');
  assert.equal(g.turn, 'player');
  await rejects(games.playerMove(sid, g.id, mv('a2a3'), g.moves.length), 409, 'finished');
});

test('stalemate is a draw', async () => {
  const { games, engine } = setup();
  const sid = games.ensureSession(undefined);
  const g0 = games.newGame(sid);
  const line = 'e2e3 a7a5 d1h5 a8a6 h5a5 h7h5 h2h4 a6h6 a5c7 f7f6 c7d7 e8f7 d7b7 d8d3 b7b8 d3h7 b8c8 f7g6 c8e6';
  const g = await play(games, engine, sid, g0.id, line.split(' '));
  assert.equal(g.result, 'draw');
  assert.equal(g.reason, 'stalemate');
});

test('threefold repetition is a draw', async () => {
  const { games, engine } = setup();
  const sid = games.ensureSession(undefined);
  const g0 = games.newGame(sid);
  const g = await play(games, engine, sid, g0.id, 'g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8'.split(' '));
  assert.equal(g.result, 'draw');
  assert.equal(g.reason, 'threefold');
});

test('fifty-move rule and insufficient material are detected', () => {
  assert.deepEqual(endState(new Chess('8/8/8/4k3/8/8/3K4/7R w - - 100 80'), 'w'), { result: 'draw', reason: 'fifty-moves' });
  assert.deepEqual(endState(new Chess('8/8/8/4k3/8/8/3K4/6N1 w - - 0 80'), 'w'), {
    result: 'draw',
    reason: 'insufficient-material',
  });
  assert.equal(endState(new Chess('8/8/8/4k3/8/8/3K4/7R w - - 99 80'), 'w'), null);
});

test('castling, en passant and under-promotion are legal and recorded', async () => {
  const { games, engine } = setup();
  const sid = games.ensureSession(undefined);
  let g = games.newGame(sid);
  g = await play(games, engine, sid, g.id, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'e1g1', 'a7a6']);
  assert.equal(g.moves[6].san, 'O-O');

  const s2 = games.ensureSession(undefined);
  let e = games.newGame(s2);
  e = await play(games, engine, s2, e.id, ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6', 'h7h6']);
  assert.equal(e.moves[4].san, 'exd6');
  assert.equal(new Chess(e.fen).get('d5'), undefined);

  const s3 = games.ensureSession(undefined);
  let p = games.newGame(s3);
  p = await play(games, engine, s3, p.id, 'a2a4 b7b5 a4b5 a7a6 b5a6 c8b7 a6b7 b8c6 b7a8n h7h6'.split(' '));
  assert.equal(p.moves[8].uci, 'b7a8n');
  assert.deepEqual(new Chess(p.fen).get('a8'), { type: 'n', color: 'w' });
});

test('promotion without a chosen piece defaults to a queen', async () => {
  const { games, engine } = setup();
  const sid = games.ensureSession(undefined);
  let p = games.newGame(sid);
  p = await play(games, engine, sid, p.id, 'a2a4 b7b5 a4b5 a7a6 b5a6 c8b7 a6b7 b8c6'.split(' '));
  p = await games.playerMove(sid, p.id, { from: 'b7', to: 'a8' }, p.moves.length);
  assert.equal(p.moves[8].uci, 'b7a8q');
});

test('illegal, malformed, replayed and out-of-turn moves are rejected', async () => {
  const { games, engine } = setup();
  const sid = games.ensureSession(undefined);
  const g = games.newGame(sid);
  await rejects(games.playerMove(sid, g.id, mv('e2e5'), 0), 422, 'illegal');
  await rejects(games.playerMove(sid, g.id, mv('e7e5'), 0), 422, 'illegal'); // opponent's piece
  await rejects(games.playerMove(sid, g.id, { from: 'z9', to: 'e4' }, 0), 400, 'bad_move');
  await rejects(games.playerMove(sid, g.id, { from: 'e2', to: 'e4', promotion: 'k' as 'q' }, 0), 400, 'bad_move');
  await rejects(games.playerMove(sid, g.id, mv('e2e4'), 5), 409, 'stale');
  const after = await games.playerMove(sid, g.id, mv('e2e4'), 0);
  assert.equal(after.moves.length, 2);
  // the same request sent again (double tap / network retry) is not applied twice
  await rejects(games.playerMove(sid, g.id, mv('e2e4'), 0), 409, 'stale');
  assert.equal(games.get(sid, g.id).moves.length, 2);
  // the engine is slow: the player may not move during the AI's turn
  engine.delayMs = 50;
  const pending = games.playerMove(sid, g.id, mv('d2d4'), 2);
  await new Promise((r) => setTimeout(r, 5));
  await rejects(games.playerMove(sid, g.id, mv('g1f3'), 3), 409, 'not_your_turn');
  await pending;
  assert.equal(games.get(sid, g.id).moves.length, 4);
});

test('concurrent identical requests apply the move once', async () => {
  const { games } = setup();
  const sid = games.ensureSession(undefined);
  const g = games.newGame(sid);
  const results = await Promise.allSettled([1, 2, 3].map(() => games.playerMove(sid, g.id, mv('e2e4'), 0)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(games.get(sid, g.id).moves.length, 2);
});

test('sessions are isolated', async () => {
  const { games } = setup();
  const a = games.ensureSession(undefined);
  const b = games.ensureSession(undefined);
  const ga = games.newGame(a);
  await rejects(() => games.get(b, ga.id), 404, 'not_found');
  await rejects(games.playerMove(b, ga.id, mv('e2e4'), 0), 404, 'not_found');
  await rejects(() => games.resign(b, ga.id), 404, 'not_found');
  assert.equal(games.current(b), null);
  assert.equal(games.ensureSession('forged-session-id-that-does-not-exist') === 'forged-session-id-that-does-not-exist', false);
});

test('resign, rematch and no dodging an unfinished game', async () => {
  const { games } = setup();
  const sid = games.ensureSession(undefined);
  const g1 = games.newGame(sid);
  await games.playerMove(sid, g1.id, mv('e2e4'), 0);
  assert.equal(games.newGame(sid).id, g1.id, 'new game must not replace an unfinished one');
  const r = games.resign(sid, g1.id);
  assert.equal(r.result, 'ai');
  assert.equal(r.reason, 'resign');
  games.resign(sid, g1.id);
  assert.equal(games.stats(BASE).players.aiWins, 1);
  const g2 = games.newGame(sid);
  assert.notEqual(g2.id, g1.id);
  assert.equal(g2.moves.length, 0);
  assert.equal(games.current(sid)!.id, g2.id);
  assert.equal(games.get(sid, g1.id).result, 'ai', 'previous result is kept');
  assert.equal(games.stats(BASE).players.total, 1);
});

test('resigning while the AI is thinking discards the AI move', async () => {
  const { games, engine } = setup();
  const sid = games.ensureSession(undefined);
  const g = games.newGame(sid);
  engine.delayMs = 50;
  const p = games.playerMove(sid, g.id, mv('e2e4'), 0);
  await new Promise((r) => setTimeout(r, 5));
  games.resign(sid, g.id);
  const v = await p;
  assert.equal(v.status, 'finished');
  assert.equal(v.moves.length, 1);
  assert.equal(games.stats(BASE).players.total, 1);
});

test('engine failure keeps the game; the AI move is resumed after a server restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsl-'));
  const db1 = openDb(dir, 'db.sqlite');
  const broken = new ScriptedEngine();
  broken.fail = true;
  const s1 = new GameService(db1, broken, 10);
  const sid = s1.ensureSession(undefined);
  const g = s1.newGame(sid);
  const v = await s1.playerMove(sid, g.id, mv('e2e4'), 0);
  assert.equal(v.moves.length, 1);
  assert.equal(v.aiThinking, true);
  assert.match(v.engineError ?? '', /недоступен/);
  await s1.idle();
  db1.close();

  // "restart": new process state, same database file
  const db2 = openDb(dir, 'db.sqlite');
  const s2 = new GameService(db2, new ScriptedEngine(), 10);
  s2.resumePending();
  await s2.idle();
  const after = s2.current(sid)!;
  assert.equal(after.id, g.id);
  assert.equal(after.moves.length, 2);
  assert.equal(after.turn, 'player');
  db2.close();
});

test('three simultaneous games do not mix positions', async () => {
  const { games, engine } = setup();
  engine.delayMs = 20;
  const openings = [
    ['e2e4', 'd2d4', 'g1f3'],
    ['c2c4', 'b1c3', 'g2g3'],
    ['d2d4', 'c2c4', 'b1c3'],
  ];
  const sessions = openings.map(() => games.ensureSession(undefined));
  const ids = sessions.map((s) => games.newGame(s).id);
  await Promise.all(
    sessions.map(async (sid, i) => {
      for (const m of openings[i]) {
        const g = games.get(sid, ids[i]);
        await games.playerMove(sid, ids[i], mv(m), g.moves.length);
      }
    }),
  );
  sessions.forEach((sid, i) => {
    const g = games.get(sid, ids[i]);
    assert.deepEqual(
      g.moves.filter((m) => m.by === 'player').map((m) => m.uci),
      openings[i],
    );
    assert.equal(g.moves.length, 6);
    // stored FEN equals replaying the stored moves
    const c = new Chess();
    for (const m of g.moves) c.move(m.san);
    assert.equal(c.fen(), g.fen);
  });
});

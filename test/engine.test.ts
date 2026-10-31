import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { EnginePool } from '../server/engine.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const base = { binary: process.env.STOCKFISH_PATH ?? '', threads: 1, hashMb: 32, watchdogMs: 1500 };

test('real Stockfish starts at full strength and finds mate in one', { timeout: 60000 }, async () => {
  const pool = new EnginePool({ ...base, size: 1 });
  await pool.start();
  try {
    const s = pool.status();
    assert.equal(s.ready, true);
    assert.match(s.name, /Stockfish/);
    // 1.f3 e5 2.g4 — black mates with Qh4#
    const best = await pool.bestMove({ moves: ['f2f3', 'e7e5', 'g2g4'], moveTimeMs: 300 });
    assert.equal(best, 'd8h4');
  } finally {
    pool.close();
  }
});

test('three simultaneous searches return legal moves for their own positions', { timeout: 60000 }, async () => {
  const pool = new EnginePool({ ...base, size: 3 });
  await pool.start();
  try {
    const lines = [['e2e4'], ['d2d4', 'g8f6'], ['c2c4', 'e7e5', 'b1c3']];
    const out = await Promise.all(lines.map((moves) => pool.bestMove({ moves, moveTimeMs: 300 })));
    lines.forEach((moves, i) => {
      const c = new Chess();
      for (const m of moves) c.move({ from: m.slice(0, 2), to: m.slice(2, 4) });
      assert.ok(c.moves({ verbose: true }).some((m) => m.lan === out[i]), `${out[i]} legal after ${moves}`);
    });
    // more requests than engines are queued, not dropped
    const many = await Promise.all(Array.from({ length: 5 }, () => pool.bestMove({ moves: ['e2e4'], moveTimeMs: 100 })));
    assert.equal(many.length, 5);
  } finally {
    pool.close();
  }
});

test('a hung engine is killed by the watchdog and the request fails instead of hanging', { timeout: 30000 }, async () => {
  const pool = new EnginePool({ ...base, binary: path.join(fixtures, 'hang-engine.mjs'), size: 1, watchdogMs: 300 });
  await pool.start();
  assert.equal(pool.status().ready, true);
  const t = Date.now();
  await assert.rejects(pool.bestMove({ moves: [], moveTimeMs: 100 }), /timeout/);
  assert.ok(Date.now() - t < 5000);
  assert.ok(pool.status().restarts >= 1);
  pool.close();
});

test('a crashing engine is restarted', { timeout: 30000 }, async () => {
  const pool = new EnginePool({ ...base, binary: path.join(fixtures, 'crash-engine.mjs'), size: 1 });
  await pool.start();
  await assert.rejects(pool.bestMove({ moves: [], moveTimeMs: 100 }), /exited/);
  assert.ok(pool.status().restarts >= 1);
  pool.close();
});

test('a missing engine binary is reported, not hung', { timeout: 30000 }, async () => {
  const pool = new EnginePool({ ...base, binary: '/nonexistent/stockfish', size: 1 });
  await pool.start();
  const s = pool.status();
  assert.equal(s.ready, false);
  assert.match(s.lastError, /spawn|exited|not running/);
  await assert.rejects(pool.bestMove({ moves: [], moveTimeMs: 100 }), /unavailable|not running|spawn/);
  pool.close();
});

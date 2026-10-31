// One-shot, isolated Railway benchmark. Never import from the production entrypoint.
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import readline from 'node:readline';
import { once } from 'node:events';
import { Chess } from 'chess.js';
import { EnginePool } from '../server/engine.ts';
import { openDb } from '../server/db.ts';
import { GameService } from '../server/games.ts';
import { createApp } from '../server/app.ts';

const require = createRequire(import.meta.url);
const wasmFile = require('stockfish/scripts/findEngine.js')('full');
const nativeFile = '/opt/sf/stockfish';
const SETTINGS = { threads: 8, hashMb: 256, moveTimeMs: 5000, poolSize: 3 };
const POSITIONS = [
  { id: 'start', fen: new Chess().fen() },
  { id: 'kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1' },
  { id: 'rook-ending', fen: '8/5pk1/4p1p1/3pP2p/3P3P/5PK1/8/4R2r w - - 0 1' },
];
const read = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };
const report = {
  startedAt: new Date().toISOString(), state: 'running', settings: SETTINGS,
  hardware: {
    cpuModel: os.cpus()[0]?.model, architecture: os.arch(), node: process.version,
    availableParallelism: os.availableParallelism(), cpuMax: read('/sys/fs/cgroup/cpu.max'),
    memoryMax: read('/sys/fs/cgroup/memory.max'), cpuSet: read('/sys/fs/cgroup/cpuset.cpus.effective'),
  },
  method: 'Same container/host, cold hash, 5s fixed time, 8 threads per engine, order WASM/native/native/WASM; nodes are search nodes, not unique positions.',
  samples: [], integration: [],
};
const statusServer = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url === '/api/health' ? { ok: report.state !== 'failed', benchmark: report.state } : report));
});
statusServer.listen(Number(process.env.PORT || 8080), '0.0.0.0');

class Uci {
  constructor(kind) {
    this.kind = kind; this.waiters = []; this.name = ''; this.infoStrings = new Set(); this.last = {};
    this.p = kind === 'native' ? spawn(nativeFile, [], { stdio: 'pipe' }) : spawn(process.execPath, [wasmFile], { stdio: 'pipe' });
    this.p.stdin.on('error', () => {});
    this.p.stderr.on('data', (b) => { this.stderr = (this.stderr || '') + b.toString(); });
    this.p.on('error', (e) => this.fail(e));
    this.p.on('exit', (code, signal) => this.fail(new Error(`${kind} exited ${code}/${signal}: ${this.stderr || ''}`)));
    readline.createInterface({ input: this.p.stdout }).on('line', (line) => {
      if (line.startsWith('id name ')) this.name = line.slice(8);
      if (line.startsWith('info string ')) this.infoStrings.add(line.slice(12));
      if (line.startsWith('info depth ')) {
        for (const k of ['nodes', 'nps', 'time', 'depth', 'hashfull']) {
          const m = line.match(new RegExp(`\\b${k} (\\d+)`));
          if (m) this.last[k] = Number(m[1]);
        }
      }
      for (const w of [...this.waiters]) if (w.match(line)) w.resolve(line);
    });
  }
  fail(e) { this.dead = e; for (const w of [...this.waiters]) w.reject(e); }
  send(line) { if (this.dead) throw this.dead; this.p.stdin.write(line + '\n'); }
  command(line, match, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(this.dead);
      let timer;
      const end = (fn, value) => {
        clearTimeout(timer); this.waiters = this.waiters.filter((x) => x !== w); fn(value);
      };
      const w = { match, resolve: (v) => end(resolve, v), reject: (e) => end(reject, e) };
      this.waiters.push(w);
      timer = setTimeout(() => w.reject(new Error(`${this.kind} timeout: ${line}`)), timeout);
      this.send(line);
    });
  }
  async start() {
    await this.command('uci', (l) => l === 'uciok');
    for (const opt of [`Threads value ${SETTINGS.threads}`, `Hash value ${SETTINGS.hashMb}`, 'MultiPV value 1', 'Skill Level value 20', 'UCI_LimitStrength value false']) this.send('setoption name ' + opt);
    await this.command('isready', (l) => l === 'readyok');
    assert.match(this.name, /Stockfish 19/);
  }
  async search(position, moveTimeMs) {
    this.send('ucinewgame'); this.send('setoption name Clear Hash');
    await this.command('isready', (l) => l === 'readyok');
    this.send('position fen ' + position.fen); this.last = {};
    const start = performance.now();
    const best = await this.command(`go movetime ${moveTimeMs}`, (l) => l.startsWith('bestmove '), moveTimeMs + 20000);
    const wallMs = Math.round(performance.now() - start);
    const move = best.split(/\s+/)[1];
    const chess = new Chess(position.fen);
    assert.ok(chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] }));
    assert.ok(this.last.nodes > 0 && this.last.time > 0);
    assert.ok(wallMs < moveTimeMs + 2000, `search overrun: ${wallMs}`);
    return { ...this.last, wallMs, bestmove: move, engine: this.name, info: [...this.infoStrings] };
  }
  async close() {
    if (this.p.exitCode !== null || this.p.signalCode !== null) return;
    const done = once(this.p, 'exit').catch(() => {});
    if (!this.dead) this.send('quit');
    const timer = setTimeout(() => this.p.kill('SIGKILL'), 2000);
    await done; clearTimeout(timer);
  }
}

async function enginePhase(kind, round) {
  const engines = Array.from({ length: 3 }, () => new Uci(kind));
  try {
    await Promise.all(engines.map((e) => e.start()));
    await Promise.all(engines.map((e) => e.search(POSITIONS[0], 250))); // unmeasured warmup
    for (const position of POSITIONS) {
      const sample = { kind, round, load: 'single', position: position.id, ...(await engines[0].search(position, 5000)) };
      report.samples.push(sample); console.log('BENCH_SAMPLE ' + JSON.stringify(sample));
    }
    const results = await Promise.all(engines.map((e, i) => e.search(POSITIONS[i], 5000)));
    results.forEach((r, i) => {
      const sample = { kind, round, load: 'three', position: POSITIONS[i].id, ...r };
      report.samples.push(sample); console.log('BENCH_SAMPLE ' + JSON.stringify(sample));
    });
  } finally { await Promise.all(engines.map((e) => e.close())); }
}

async function apiPhase(kind) {
  const pool = new EnginePool({ binary: kind === 'native' ? nativeFile : '', threads: 8, hashMb: 256, watchdogMs: 20000, size: 3 });
  const db = openDb('', ':memory:');
  let server;
  try {
    await pool.start();
    assert.equal(pool.status().engines, 3);
    const games = new GameService(db, { bestMove: (r) => pool.bestMove(r) }, 5000);
    const app = createApp({ games, engineStatus: () => pool.status(), ruslanychStats: { total: 0, ruslanych: 0, ai: 0, ruslanychWinPercent: 0 } });
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    const clients = Array.from({ length: 3 }, (_, i) => {
      let cookie = '';
      return async (method, path, body) => {
        const r = await fetch(url + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
        if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
        const json = await r.json(); assert.equal(r.status, 200, JSON.stringify(json)); return json;
      };
    });
    let maxBusy = 0;
    const sampleBusy = setInterval(() => { maxBusy = Math.max(maxBusy, pool.status().busy); }, 10);
    try {
      const start = performance.now();
      const initial = await Promise.all(clients.map((c, i) => c('POST', '/api/game', { name: `Isolated ${kind} ${i + 1}` })));
      assert.equal(new Set(initial.map((x) => x.game.id)).size, 3);
      await games.idle();
      const openingMs = Math.round(performance.now() - start);
      const opened = await Promise.all(clients.map((c) => c('GET', '/api/game')));
      for (const { game } of opened) { assert.equal(game.moves.length, 1); assert.equal(game.turn, 'player'); assert.equal(game.playerColor, 'b'); }
      const replyStart = performance.now();
      const replies = await Promise.all(clients.map(async (c, i) => {
        const g = opened[i].game; const m = new Chess(g.fen).moves({ verbose: true })[0];
        return c('POST', `/api/game/${g.id}/move`, { from: m.from, to: m.to, promotion: m.promotion, ply: 1 });
      }));
      await games.idle();
      const replyMs = Math.round(performance.now() - replyStart);
      const final = await Promise.all(clients.map((c) => c('GET', '/api/game')));
      for (const { game } of final) {
        assert.equal(game.moves.length, 3); assert.equal(game.turn, 'player'); assert.equal(game.status, 'active');
        assert.equal(game.engineError, null);
        const board = new Chess(); for (const m of game.moves) assert.ok(board.move(m.san));
        assert.equal(board.fen(), game.fen);
        assert.ok(game.playerRemainingMs > 400000);
      }
      assert.equal(maxBusy, 3); assert.equal(pool.status().searches, 6);
      assert.equal(pool.status().restarts, 0); assert.equal(pool.status().lastError, '');
      const result = { kind, passed: true, simultaneousGames: 3, maxBusy, openingMs, replyMs, state: pool.status(), persistence: 'in-memory test database; no production data used' };
      report.integration.push(result); console.log('BENCH_API ' + JSON.stringify(result));
    } finally { clearInterval(sampleBusy); }
  } finally {
    if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
    pool.close(); db.close();
  }
}

try {
  console.log('BENCH_HARDWARE ' + JSON.stringify(report.hardware));
  assert.ok(fs.existsSync(nativeFile), 'native binary missing; refusing WASM fallback');
  assert.equal(os.arch(), 'x64');
  const quota = report.hardware.cpuMax?.split(/\s+/);
  assert.ok(quota && quota[0] !== 'max' && Number(quota[0]) / Number(quota[1]) === 8, 'expected 8 vCPU quota');
  for (const [kind, round] of [['wasm', 0], ['native', 0], ['native', 1], ['wasm', 1]]) await enginePhase(kind, round);
  await apiPhase('native'); await apiPhase('wasm');
  report.summary = {};
  for (const load of ['single', 'three']) {
    const rows = report.samples.filter((s) => s.load === load);
    const native = rows.filter((s) => s.kind === 'native'); const wasm = rows.filter((s) => s.kind === 'wasm');
    const ratios = native.map((n) => n.nodes / wasm.find((w) => w.round === n.round && w.position === n.position).nodes);
    report.summary[load] = { nativeNodes: native.reduce((s, r) => s + r.nodes, 0), wasmNodes: wasm.reduce((s, r) => s + r.nodes, 0), geometricSpeedup: Math.exp(ratios.reduce((s, r) => s + Math.log(r), 0) / ratios.length), minPairedSpeedup: Math.min(...ratios), pairedRatios: ratios };
  }
  report.advantageConfirmed = Object.values(report.summary).every((s) => s.geometricSpeedup >= 1.2 && s.minPairedSpeedup > 1) && report.integration.length === 2;
  report.state = 'complete'; report.finishedAt = new Date().toISOString();
  fs.writeFileSync('/tmp/native-stockfish-benchmark.json', JSON.stringify(report, null, 2));
  console.log('BENCH_REPORT ' + JSON.stringify(report));
} catch (e) {
  report.state = 'failed'; report.error = e.stack; console.error('BENCH_FAILED ' + JSON.stringify(report));
  process.exit(1); // Railway test config disables automatic retries.
}

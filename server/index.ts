import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { openDb } from './db.ts';
import { EnginePool } from './engine.ts';
import { GameService } from './games.ts';
import { createApp } from './app.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const db = openDb(config.dataDir);
let pool = new EnginePool({ ...config.engine, size: config.engine.poolSize });
const games = new GameService(db, { bestMove: (req) => pool.bestMove(req) }, config.engine.moveTimeMs);
const app = createApp({
  games,
  ruslanychStats: config.ruslanychStats,
  engineStatus: () => pool.status(),
  staticDir: path.join(root, 'dist'),
});

const server = app.listen(config.port, () => {
  console.log(`RUSLANYCH AI on :${config.port}`);
});

async function startEngine() {
  await pool.start();
  if (!pool.status().ready && config.engine.binary) {
    // native binary unusable on this machine (e.g. CPU without AVX2): use the bundled WASM build
    console.error(`native Stockfish failed (${pool.status().lastError}), falling back to WASM`);
    pool.close();
    pool = new EnginePool({ ...config.engine, binary: '', size: config.engine.poolSize });
    await pool.start();
  }
}

startEngine().then(() => {
  const s = pool.status();
  console.log(`engine: ${s.name || 'unavailable'} x${s.engines}/${s.size}, threads=${s.threads}, hash=${s.hashMb}MB`);
  games.resumePending();
});

const shutdown = () => {
  server.close();
  pool.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

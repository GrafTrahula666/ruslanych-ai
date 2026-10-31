import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

// Containers often see all host cores; respect the cgroup CPU quota when there is one.
function cpuCount(): number {
  const host = os.availableParallelism?.() ?? os.cpus().length;
  try {
    const [quota, period] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (quota !== 'max') return Math.max(1, Math.min(host, Math.floor(Number(quota) / Number(period))));
  } catch {}
  return Math.max(1, host);
}

const cpus = num(process.env.CPU_COUNT, cpuCount());
const poolSize = num(process.env.ENGINE_POOL_SIZE, Math.min(3, cpus));

export const config = {
  port: num(process.env.PORT, 3000),
  dataDir: process.env.DATA_DIR || path.resolve('data'),
  engine: {
    // Native Stockfish binary if available; otherwise the bundled Stockfish WASM build.
    binary: process.env.STOCKFISH_PATH || '',
    poolSize,
    // Every engine may use all cores: a lone game gets full power, simultaneous games share the CPU.
    threads: num(process.env.ENGINE_THREADS, cpus),
    hashMb: num(process.env.ENGINE_HASH_MB, 256),
    moveTimeMs: num(process.env.ENGINE_MOVE_TIME_MS, 3000),
    // Hard limit for one search before the process is treated as hung and restarted.
    watchdogMs: num(process.env.ENGINE_WATCHDOG_MS, 20000),
  },
  // Fixed showcase stats, not affected by visitor games.
  ruslanychStats: {
    total: 1089,
    ruslanych: 567,
    ai: 522,
    ruslanychWinPercent: 52,
  },
};

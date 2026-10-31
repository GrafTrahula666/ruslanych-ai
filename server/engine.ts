import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import readline from 'node:readline';

export interface EngineOptions {
  binary: string; // native binary path; empty = bundled WASM build
  threads: number;
  hashMb: number;
  watchdogMs: number;
  initTimeoutMs?: number;
}

export interface SearchRequest {
  startFen?: string; // omitted = standard start position
  moves: string[]; // UCI moves from the start, so the engine knows the repetition history
  moveTimeMs: number;
}

function engineCommand(binary: string): [string, string[]] {
  if (binary) return [binary, []];
  const require = createRequire(import.meta.url);
  const findEngine = require('stockfish/scripts/findEngine.js') as (t?: string) => string;
  return [process.execPath, [findEngine('full')]];
}

/** One UCI process. Handles exactly one search at a time (the pool guarantees it). */
export class UciEngine {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private waiters: { match: (l: string) => boolean; resolve: (l: string) => void }[] = [];
  private onDead: ((err: Error) => void)[] = [];
  name = '';
  dead = false;

  constructor(private opts: EngineOptions) {}

  async start(): Promise<void> {
    const [cmd, args] = engineCommand(this.opts.binary);
    const proc = spawn(cmd, args, { stdio: 'pipe' });
    this.proc = proc;
    proc.on('error', (e) => this.die(new Error(`engine spawn failed: ${e.message}`)));
    proc.on('exit', (code, sig) => this.die(new Error(`engine exited (code=${code}, signal=${sig})`)));
    proc.stdin.on('error', () => {});
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      if (line.startsWith('id name ')) this.name = line.slice(8);
      const i = this.waiters.findIndex((w) => w.match(line));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(line);
    });
    const t = this.opts.initTimeoutMs ?? 30000;
    this.send('uci');
    await this.waitFor((l) => l === 'uciok', t, 'uciok');
    this.send(`setoption name Threads value ${this.opts.threads}`);
    this.send(`setoption name Hash value ${this.opts.hashMb}`);
    // Full strength: no skill limit, no Elo limit, single best line.
    this.send('setoption name Skill Level value 20');
    this.send('setoption name UCI_LimitStrength value false');
    this.send('setoption name MultiPV value 1');
    this.send('isready');
    await this.waitFor((l) => l === 'readyok', t, 'readyok');
  }

  async search(req: SearchRequest): Promise<string> {
    const pos = req.startFen ? `position fen ${req.startFen}` : 'position startpos';
    this.send(req.moves.length ? `${pos} moves ${req.moves.join(' ')}` : pos);
    this.send('isready');
    await this.waitFor((l) => l === 'readyok', this.opts.watchdogMs, 'readyok');
    this.send(`go movetime ${req.moveTimeMs}`);
    const line = await this.waitFor((l) => l.startsWith('bestmove'), req.moveTimeMs + this.opts.watchdogMs, 'bestmove');
    const move = line.split(/\s+/)[1];
    if (!move || move === '(none)') throw new Error('engine returned no move');
    return move;
  }

  private send(cmd: string) {
    if (this.dead || !this.proc) throw new Error('engine is not running');
    this.proc.stdin.write(cmd + '\n');
  }

  private waitFor(match: (l: string) => boolean, timeoutMs: number, what: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(new Error('engine is not running'));
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== waiter);
        this.onDead = this.onDead.filter((f) => f !== deadCb);
        fn();
      };
      const waiter = { match, resolve: (l: string) => finish(() => resolve(l)) };
      const deadCb = (e: Error) => finish(() => reject(e));
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`engine timeout waiting for ${what}`)));
        this.kill(); // hung engine is never reused
      }, timeoutMs);
      this.waiters.push(waiter);
      this.onDead.push(deadCb);
    });
  }

  private die(err: Error) {
    if (this.dead) return;
    this.dead = true;
    for (const f of [...this.onDead]) f(err);
  }

  kill() {
    if (this.proc && !this.dead) {
      this.die(new Error('engine killed'));
      this.proc.kill('SIGKILL');
    }
  }
}

type Job = { req: SearchRequest; resolve: (m: string) => void; reject: (e: Error) => void; attempts: number };

/** Fixed number of engine processes with a FIFO queue; each search gets one whole engine. */
export class EnginePool {
  private idle: UciEngine[] = [];
  private all = new Set<UciEngine>();
  private queue: Job[] = [];
  private alive = 0;
  private starting = 0;
  lastError = '';
  engineName = '';
  searches = 0;
  restarts = 0;
  private closed = false;

  constructor(private opts: EngineOptions & { size: number }) {}

  async start(): Promise<void> {
    await Promise.allSettled(Array.from({ length: this.opts.size }, () => this.spawnOne()));
  }

  status() {
    return {
      ready: this.alive > 0,
      engines: this.alive,
      size: this.opts.size,
      busy: this.alive - this.idle.length,
      queued: this.queue.length,
      name: this.engineName,
      threads: this.opts.threads,
      hashMb: this.opts.hashMb,
      searches: this.searches,
      restarts: this.restarts,
      lastError: this.lastError,
    };
  }

  bestMove(req: SearchRequest): Promise<string> {
    if (this.closed) return Promise.reject(new Error('engine pool closed'));
    return new Promise((resolve, reject) => {
      this.queue.push({ req, resolve, reject, attempts: 0 });
      this.pump();
      if (this.alive === 0 && this.starting === 0) this.spawnOne();
    });
  }

  private async spawnOne(): Promise<void> {
    if (this.closed) return;
    this.starting++;
    const e = new UciEngine(this.opts);
    this.all.add(e);
    try {
      await e.start();
      this.engineName = e.name;
      this.alive++;
      this.idle.push(e);
    } catch (err) {
      e.kill();
      this.all.delete(e);
      this.lastError = (err as Error).message;
      // If nothing is alive, fail queued jobs instead of letting them hang.
      if (this.alive === 0 && this.starting === 1) {
        for (const j of this.queue.splice(0)) j.reject(new Error(`engine unavailable: ${this.lastError}`));
      }
      // retry later in the background
      if (!this.closed) setTimeout(() => this.spawnOne(), 5000).unref();
    } finally {
      this.starting--;
      this.pump();
    }
  }

  private pump() {
    while (this.idle.length && this.queue.length) {
      const engine = this.idle.shift()!;
      const job = this.queue.shift()!;
      this.run(engine, job);
    }
  }

  private async run(engine: UciEngine, job: Job) {
    try {
      const move = await engine.search(job.req);
      this.searches++;
      job.resolve(move);
      this.idle.push(engine);
    } catch (err) {
      this.lastError = (err as Error).message;
      engine.kill();
      this.all.delete(engine);
      this.alive--;
      this.restarts++;
      if (job.attempts++ < 1) this.queue.unshift(job);
      else job.reject(err as Error);
      this.spawnOne();
    } finally {
      this.pump();
    }
  }

  close() {
    this.closed = true;
    for (const e of this.all) e.kill();
    for (const j of this.queue.splice(0)) j.reject(new Error('engine pool closed'));
  }
}

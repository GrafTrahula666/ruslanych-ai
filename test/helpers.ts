import { Chess } from 'chess.js';
import { openDb } from '../server/db.ts';
import { GameService, type MoveEngine } from '../server/games.ts';

/** Deterministic engine: plays scripted moves, then the first legal move. */
export class ScriptedEngine implements MoveEngine {
  script: string[] = [];
  fail = false;
  calls = 0;
  delayMs = 0;
  async bestMove(req: { moves: string[] }): Promise<string> {
    this.calls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.fail) throw new Error('engine down');
    const next = this.script.shift();
    if (next) return next;
    const c = new Chess();
    for (const m of req.moves) c.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
    return c.moves({ verbose: true })[0].lan;
  }
}

export function setup(file = ':memory:', dir = '') {
  const db = openDb(dir, file);
  const engine = new ScriptedEngine();
  const games = new GameService(db, engine, 10);
  return { db, engine, games };
}

export const mv = (uci: string) => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: (uci[4] as 'q') || undefined });

/** Plays alternating player/AI moves (player = white). */
export async function play(games: GameService, engine: ScriptedEngine, sid: string, id: number, ucis: string[]) {
  let g = games.get(sid, id);
  for (let i = 0; i < ucis.length; i += 2) {
    if (ucis[i + 1]) engine.script.push(ucis[i + 1]);
    g = await games.playerMove(sid, id, mv(ucis[i]), g.moves.length);
  }
  return g;
}

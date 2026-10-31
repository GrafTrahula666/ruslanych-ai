import crypto from 'node:crypto';
import { Chess } from 'chess.js';
import type { Db } from './db.ts';
import type { EndReason, GameResult, GameView, MoveInput, MoveRecord, StatsView } from '../shared/types.ts';

export interface MoveEngine {
  bestMove(req: { moves: string[]; moveTimeMs: number }): Promise<string>;
}

interface GameRow {
  id: number;
  session_id: string;
  player_color: 'w' | 'b';
  player_name: string | null;
  player_remaining_ms: number | null;
  player_turn_started_at_ms: number | null;
  fen: string;
  moves: string;
  status: 'active' | 'finished';
  result: GameResult | null;
  reason: EndReason | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export class GameError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const SQUARE = /^[a-h][1-8]$/;
const PROMO = new Set(['q', 'r', 'b', 'n']);
const now = () => new Date().toISOString();
export const GUEST_TIME_MS = 7 * 60 * 1000;

/** Rebuilds the position from the move list so repetition history is exact. */
function replay(moves: MoveRecord[]): Chess {
  const chess = new Chess();
  for (const m of moves) {
    chess.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] });
  }
  return chess;
}

export function endState(chess: Chess, playerColor: 'w' | 'b'): { result: GameResult; reason: EndReason } | null {
  if (chess.isCheckmate()) {
    // side to move is mated
    return { result: chess.turn() === playerColor ? 'ai' : 'player', reason: 'checkmate' };
  }
  if (chess.isStalemate()) return { result: 'draw', reason: 'stalemate' };
  if (chess.isInsufficientMaterial()) return { result: 'draw', reason: 'insufficient-material' };
  if (chess.isThreefoldRepetition()) return { result: 'draw', reason: 'threefold' };
  if (chess.isDrawByFiftyMoves()) return { result: 'draw', reason: 'fifty-moves' };
  return null;
}

export class GameService {
  private aiInFlight = new Map<number, Promise<void>>();
  private engineErrors = new Map<number, string>();

  constructor(
    private db: Db,
    private engine: MoveEngine,
    private moveTimeMs: number,
    private playerColor: 'w' | 'b' = 'b',
    private nowMs: () => number = Date.now,
  ) {}

  // ---------- sessions ----------

  ensureSession(id: string | undefined): string {
    if (id && /^[A-Za-z0-9_-]{20,64}$/.test(id)) {
      const row = this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
      if (row) return id;
    }
    const sid = crypto.randomBytes(24).toString('base64url');
    this.db.prepare('INSERT INTO sessions (id, created_at) VALUES (?, ?)').run(sid, now());
    return sid;
  }

  // ---------- reads ----------

  private row(id: number): GameRow | undefined {
    return this.db.prepare('SELECT * FROM games WHERE id = ?').get(id) as GameRow | undefined;
  }

  private owned(sessionId: string, gameId: number): GameRow {
    const g = Number.isInteger(gameId) ? this.row(gameId) : undefined;
    if (!g || g.session_id !== sessionId) throw new GameError(404, 'not_found', 'Партия не найдена');
    return g;
  }

  // Server clock survives refreshes and restarts. Legacy games have NULL clock fields.
  private remaining(g: GameRow): number | null {
    if (g.player_remaining_ms === null) return null;
    if (g.status !== 'active' || g.player_turn_started_at_ms === null) return g.player_remaining_ms;
    return Math.max(0, g.player_remaining_ms - Math.max(0, this.nowMs() - g.player_turn_started_at_ms));
  }

  private expireIfNeeded(gameId?: number): void {
    const deadline = this.nowMs();
    const where = gameId === undefined ? '' : ' AND id = ?';
    this.db.prepare(`UPDATE games SET status = 'finished', result = 'ai', reason = 'timeout',
      updated_at = ?, finished_at = ?, player_remaining_ms = 0, player_turn_started_at_ms = NULL
      WHERE status = 'active' AND player_turn_started_at_ms IS NOT NULL
      AND player_remaining_ms IS NOT NULL
      AND player_remaining_ms <= ? - player_turn_started_at_ms${where}`)
      .run(new Date(deadline).toISOString(), new Date(deadline).toISOString(), deadline, ...(gameId === undefined ? [] : [gameId]));
  }

  view(g: GameRow): GameView {
    const moves = JSON.parse(g.moves) as MoveRecord[];
    const chess = new Chess(g.fen);
    const last = moves.at(-1);
    const turn = chess.turn() === g.player_color ? 'player' : 'ai';
    return {
      id: g.id,
      playerColor: g.player_color,
      playerName: g.player_name ?? 'Гость',
      playerRemainingMs: this.remaining(g),
      playerTurnStartedAtMs: g.player_turn_started_at_ms,
      fen: g.fen,
      moves,
      status: g.status,
      result: g.result,
      reason: g.reason,
      turn,
      inCheck: chess.inCheck(),
      lastMove: last ? { from: last.uci.slice(0, 2), to: last.uci.slice(2, 4) } : null,
      aiThinking: g.status === 'active' && turn === 'ai',
      engineError: g.status === 'active' ? (this.engineErrors.get(g.id) ?? null) : null,
      createdAt: g.created_at,
      finishedAt: g.finished_at,
    };
  }

  /** Latest game of the session (active one if any). Resumes a pending AI move if needed. */
  current(sessionId: string): GameView | null {
    const g = this.db
      .prepare("SELECT * FROM games WHERE session_id = ? ORDER BY (status = 'active') DESC, id DESC LIMIT 1")
      .get(sessionId) as GameRow | undefined;
    if (!g) return null;
    this.expireIfNeeded(g.id);
    const fresh = this.row(g.id)!;
    this.kickAi(fresh);
    return this.view(fresh);
  }

  get(sessionId: string, gameId: number): GameView {
    const g = this.owned(sessionId, gameId);
    this.expireIfNeeded(g.id);
    const fresh = this.row(g.id)!;
    this.kickAi(fresh);
    return this.view(fresh);
  }

  stats(base: StatsView['ruslanych']): StatsView {
    this.expireIfNeeded();
    const rows = this.db
      .prepare("SELECT result, COUNT(*) AS n FROM games WHERE status = 'finished' GROUP BY result")
      .all() as { result: GameResult; n: number }[];
    const by = Object.fromEntries(rows.map((r) => [r.result, Number(r.n)])) as Partial<Record<GameResult, number>>;
    const playerWins = by.player ?? 0;
    const aiWins = by.ai ?? 0;
    const draws = by.draw ?? 0;
    const total = playerWins + aiWins + draws;
    return {
      ruslanych: base,
      players: { total, playerWins, aiWins, draws, aiWinPercent: total ? Math.round((aiWins / total) * 100) : 0 },
    };
  }

  // ---------- writes ----------

  /** Starts a new game. An unfinished game must be finished (or resigned) first. */
  newGame(sessionId: string, playerName = 'Гость', aiColor?: 'w' | 'b'): GameView {
    const active = this.db
      .prepare("SELECT * FROM games WHERE session_id = ? AND status = 'active'")
      .get(sessionId) as GameRow | undefined;
    if (active) return this.view(active);
    const name = playerName.trim();
    if (name.length < 1 || name.length > 32) throw new GameError(400, 'bad_name', 'Введите имя до 32 символов');
    // Choose the AI side per new game. Existing games retain their persisted player_color.
    const chosenPlayerColor = aiColor === undefined ? this.playerColor : aiColor === 'w' ? 'b' : 'w';
    const t = now();
    const clockStarted = chosenPlayerColor === 'w' ? this.nowMs() : null;
    const r = this.db
      .prepare(
        "INSERT INTO games (session_id, player_color, player_name, player_remaining_ms, player_turn_started_at_ms, fen, moves, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '[]', 'active', ?, ?)",
      )
      .run(sessionId, chosenPlayerColor, name, GUEST_TIME_MS, clockStarted, new Chess().fen(), t, t);
    const fresh = this.row(Number(r.lastInsertRowid))!;
    this.kickAi(fresh); // AI opens only when it has White.
    return this.view(fresh);
  }

  /**
   * Applies the player's move. `ply` is the number of half-moves the client saw;
   * a stale or repeated request is rejected so one move is never applied twice.
   */
  async playerMove(sessionId: string, gameId: number, input: MoveInput, ply: number): Promise<GameView> {
    const g = this.owned(sessionId, gameId);
    this.expireIfNeeded(g.id);
    if (this.row(g.id)!.status !== 'active') throw new GameError(409, 'finished', 'Партия уже завершена');
    const moves = JSON.parse(g.moves) as MoveRecord[];
    if (ply !== moves.length) throw new GameError(409, 'stale', 'Позиция изменилась, обновите партию');
    const chess = replay(moves);
    if (chess.turn() !== g.player_color) throw new GameError(409, 'not_your_turn', 'Сейчас ход ИИ');
    if (!input || !SQUARE.test(input.from) || !SQUARE.test(input.to) || (input.promotion && !PROMO.has(input.promotion))) {
      throw new GameError(400, 'bad_move', 'Некорректный ход');
    }
    let mv;
    try {
      mv = chess.move({ from: input.from, to: input.to, promotion: input.promotion ?? 'q' });
    } catch {
      throw new GameError(422, 'illegal', 'Недопустимый ход');
    }
    // A promotion piece on a non-promotion move is ignored by chess.js; record what was actually played.
    if (!this.commit(g, chess, moves, { san: mv.san, uci: mv.lan, by: 'player' })) {
      throw new GameError(409, 'stale', 'Позиция изменилась, обновите партию');
    }
    const after = this.row(g.id)!;
    if (after.status === 'active') await this.aiMove(after.id);
    return this.view(this.row(g.id)!);
  }

  resign(sessionId: string, gameId: number): GameView {
    const g = this.owned(sessionId, gameId);
    if (g.status === 'active') this.finish(g.id, 'ai', 'resign');
    return this.view(this.row(g.id)!);
  }

  /** Resume AI moves for games that were waiting when the server stopped. */
  resumePending() {
    const rows = this.db.prepare("SELECT * FROM games WHERE status = 'active'").all() as unknown as GameRow[];
    for (const g of rows) this.kickAi(g);
  }

  async idle(): Promise<void> {
    while (this.aiInFlight.size) await Promise.allSettled([...this.aiInFlight.values()]);
  }

  // ---------- internals ----------

  /** Appends one move with an optimistic check on the move count. Returns false if the game changed meanwhile. */
  private commit(g: GameRow, chess: Chess, moves: MoveRecord[], m: Omit<MoveRecord, 'ply' | 'at'>): boolean {
    const t = now();
    const remaining = this.remaining(g);
    const next = [...moves, { ...m, ply: moves.length + 1, at: t }];
    const end = endState(chess, g.player_color);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = this.db
        .prepare(
          `UPDATE games SET fen = ?, moves = ?, updated_at = ?,
             status = ?, result = ?, reason = ?, finished_at = ?,
             player_remaining_ms = ?, player_turn_started_at_ms = ?
           WHERE id = ? AND status = 'active' AND json_array_length(moves) = ?`,
        )
        .run(
          chess.fen(),
          JSON.stringify(next),
          t,
          end ? 'finished' : 'active',
          end?.result ?? null,
          end?.reason ?? null,
          end ? t : null,
          remaining,
          end || m.by === 'player' || remaining === null ? null : this.nowMs(),
          g.id,
          moves.length,
        );
      this.db.exec('COMMIT');
      return Number(r.changes) === 1;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** The only path to a finished state besides commit(); `status = 'active'` makes it count once. */
  private finish(id: number, result: GameResult, reason: EndReason) {
    const t = now();
    this.db
      .prepare(
        "UPDATE games SET status = 'finished', result = ?, reason = ?, finished_at = ?, updated_at = ?, player_turn_started_at_ms = NULL WHERE id = ? AND status = 'active'",
      )
      .run(result, reason, t, t, id);
  }

  private kickAi(g: GameRow) {
    if (g.status !== 'active') return;
    const chess = new Chess(g.fen);
    if (chess.turn() === g.player_color) return;
    this.aiMove(g.id).catch(() => {});
  }

  private aiMove(gameId: number): Promise<void> {
    const running = this.aiInFlight.get(gameId);
    if (running) return running;
    const p = this.computeAiMove(gameId).finally(() => this.aiInFlight.delete(gameId));
    this.aiInFlight.set(gameId, p);
    return p;
  }

  private async computeAiMove(gameId: number): Promise<void> {
    this.expireIfNeeded(gameId);
    const g = this.row(gameId);
    if (!g || g.status !== 'active') return;
    const moves = JSON.parse(g.moves) as MoveRecord[];
    const chess = replay(moves);
    if (chess.turn() === g.player_color) return;
    let uci: string;
    try {
      uci = await this.engine.bestMove({ moves: moves.map((m) => m.uci), moveTimeMs: this.moveTimeMs });
    } catch (e) {
      this.engineErrors.set(gameId, 'Движок временно недоступен, повторяем…');
      return;
    }
    this.engineErrors.delete(gameId);
    const fresh = this.row(gameId);
    // Resigned or otherwise changed while the engine was thinking.
    if (!fresh || fresh.status !== 'active' || fresh.moves !== g.moves) return;
    let mv;
    try {
      mv = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      this.engineErrors.set(gameId, 'Движок вернул некорректный ход, повторяем…');
      return;
    }
    this.commit(g, chess, moves, { san: mv.san, uci: mv.lan, by: 'ai' });
  }
}

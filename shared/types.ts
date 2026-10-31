export type Color = 'w' | 'b';
export type GameResult = 'player' | 'ai' | 'draw';
export type EndReason =
  | 'checkmate'
  | 'stalemate'
  | 'threefold'
  | 'fifty-moves'
  | 'insufficient-material'
  | 'resign';

export interface MoveRecord {
  ply: number;
  san: string;
  uci: string;
  by: 'player' | 'ai';
  at: string;
}

export interface GameView {
  id: number;
  playerColor: Color;
  fen: string;
  moves: MoveRecord[];
  status: 'active' | 'finished';
  result: GameResult | null;
  reason: EndReason | null;
  turn: 'player' | 'ai';
  inCheck: boolean;
  lastMove: { from: string; to: string } | null;
  aiThinking: boolean;
  engineError: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface StatsView {
  ruslanych: { total: number; ruslanych: number; ai: number; ruslanychWinPercent: number };
  players: { total: number; playerWins: number; aiWins: number; draws: number; aiWinPercent: number };
}

export interface MoveInput {
  from: string;
  to: string;
  promotion?: 'q' | 'r' | 'b' | 'n';
}

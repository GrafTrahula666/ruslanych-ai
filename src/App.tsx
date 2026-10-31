import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess, type Square } from 'chess.js';
import type { GameView, MoveInput, StatsView } from '../shared/types.ts';
import { api, ApiError } from './api.ts';

const START_FEN = new Chess().fen();

type Promo = NonNullable<MoveInput['promotion']>;

const REASONS: Record<string, string> = {
  checkmate: 'мат',
  stalemate: 'пат',
  threefold: 'троекратное повторение',
  'fifty-moves': 'правило 50 ходов',
  'insufficient-material': 'недостаточно материала',
  resign: 'сдача',
};

function statusText(g: GameView | null, offline: boolean): string {
  if (!g) return 'Нажмите «Новая партия»';
  if (g.status === 'finished') {
    const who = g.result === 'player' ? 'Вы победили' : g.result === 'ai' ? 'Победил Русланыч AI' : 'Ничья';
    return `${who} (${REASONS[g.reason ?? ''] ?? g.reason})`;
  }
  if (offline) return 'Нет связи с сервером, переподключаемся…';
  if (g.engineError) return g.engineError;
  if (g.turn === 'ai') return 'Ход Русланыч AI';
  return g.inCheck ? 'Ваш ход. Шах!' : 'Ваш ход';
}

export function App() {
  const [game, setGame] = useState<GameView | null>(null);
  const [stats, setStats] = useState<StatsView | null>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const [pending, setPending] = useState<{ fen: string; from: string; to: string } | null>(null);
  const [promotion, setPromotion] = useState<{ from: Square; to: Square } | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const gameRef = useRef<GameView | null>(null);
  gameRef.current = game;

  const refreshStats = useCallback(() => {
    api.stats().then(setStats).catch(() => {});
  }, []);

  const applyGame = useCallback(
    (g: GameView | null) => {
      const prev = gameRef.current;
      setGame(g);
      setPending(null);
      setOffline(false);
      if (g && g.status === 'finished' && prev?.id === g.id && prev.status !== 'finished') refreshStats();
    },
    [refreshStats],
  );

  // Initial load: restore the unfinished (or last) game of this browser.
  useEffect(() => {
    api
      .current()
      .then((r) => applyGame(r.game))
      .catch(() => setOffline(true))
      .finally(() => setLoaded(true));
    refreshStats();
  }, [applyGame, refreshStats]);

  // Poll while waiting for the AI or after a lost connection.
  const waiting = !!game && game.status === 'active' && game.turn === 'ai' && !busy;
  useEffect(() => {
    if (!(waiting || offline)) return;
    const t = setInterval(() => {
      const req = gameRef.current ? api.game(gameRef.current.id) : api.current();
      req.then((r) => applyGame(r.game)).catch(() => setOffline(true));
    }, 1500);
    return () => clearInterval(t);
  }, [waiting, offline, applyGame]);

  const chess = useMemo(() => new Chess(game?.fen), [game?.fen]);
  const myTurn = !!game && game.status === 'active' && game.turn === 'player' && !busy && !pending;

  const send = useCallback(
    async (m: MoveInput) => {
      const g = gameRef.current;
      if (!g) return;
      // show the move immediately; the server's answer replaces it
      const local = new Chess(g.fen);
      try {
        local.move(m);
      } catch {
        return;
      }
      setPending({ fen: local.fen(), from: m.from, to: m.to });
      setSelected(null);
      setBusy(true);
      setError('');
      try {
        const r = await api.move(g.id, m, g.moves.length);
        applyGame(r.game);
      } catch (e) {
        if (e instanceof ApiError) {
          setError(e.message);
          api.game(g.id).then((r) => applyGame(r.game)).catch(() => setOffline(true));
        } else {
          // lost connection: the server may still have the move; polling will resync
          setOffline(true);
        }
      } finally {
        setBusy(false);
      }
    },
    [applyGame],
  );

  const tryMove = useCallback(
    (from: Square, to: Square): boolean => {
      if (!myTurn) return false;
      const legal = chess.moves({ square: from, verbose: true }).filter((m) => m.to === to);
      if (!legal.length) return false;
      if (legal.some((m) => m.promotion)) {
        setPromotion({ from, to });
        setSelected(null);
        return false;
      }
      send({ from, to });
      return true;
    },
    [chess, myTurn, send],
  );

  const onSquareClick = useCallback(
    ({ square }: { square: string }) => {
      if (!myTurn) return;
      const sq = square as Square;
      const piece = chess.get(sq);
      if (selected && selected !== sq && tryMove(selected, sq)) return;
      if (selected && promotion) return;
      if (piece && piece.color === game!.playerColor) setSelected(sq === selected ? null : sq);
      else setSelected(null);
    },
    [chess, game, myTurn, promotion, selected, tryMove],
  );

  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }) => {
      if (!targetSquare) return false;
      return tryMove(sourceSquare as Square, targetSquare as Square);
    },
    [tryMove],
  );

  const squareStyles = useMemo(() => {
    const s: Record<string, CSSProperties> = {};
    const last = pending ?? game?.lastMove;
    if (last) {
      s[last.from] = { background: 'rgba(255, 213, 0, 0.45)' };
      s[last.to] = { background: 'rgba(255, 213, 0, 0.45)' };
    }
    if (game?.inCheck && !pending) {
      const king = chess
        .board()
        .flat()
        .find((p) => p && p.type === 'k' && p.color === chess.turn());
      if (king) s[king.square] = { background: 'radial-gradient(circle, rgba(255,0,0,.8) 0%, rgba(255,0,0,0) 75%)' };
    }
    if (selected && myTurn) {
      s[selected] = { background: 'rgba(20, 85, 255, 0.5)' };
      for (const m of chess.moves({ square: selected, verbose: true })) {
        s[m.to] = m.captured
          ? { background: 'radial-gradient(circle, transparent 58%, rgba(0,0,0,.35) 60%)' }
          : { background: 'radial-gradient(circle, rgba(0,0,0,.3) 22%, transparent 24%)' };
      }
    }
    return s;
  }, [chess, game, myTurn, pending, selected]);

  const startNew = async () => {
    setBusy(true);
    setError('');
    try {
      applyGame((await api.newGame()).game);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Нет связи с сервером');
    } finally {
      setBusy(false);
      setSelected(null);
    }
  };

  const resign = async () => {
    if (!game || !window.confirm('Сдаться?')) return;
    setBusy(true);
    try {
      applyGame((await api.resign(game.id)).game);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Нет связи с сервером');
    } finally {
      setBusy(false);
    }
  };

  const thinking = !offline && !!game && game.status === 'active' && (game.turn === 'ai' || !!pending);
  const history = game?.moves ?? [];
  const rows: [string, string?][] = [];
  for (let i = 0; i < history.length; i += 2) rows.push([history[i].san, history[i + 1]?.san]);

  return (
    <main>
      <h1>РУСЛАНЫЧ AI</h1>

      <section className="stats">
        <div className="card">
          <h2>РУСЛАНЫЧ VS РУСЛАНЫЧ AI</h2>
          {stats && (
            <ul>
              <li>Всего матчей: {stats.ruslanych.total}</li>
              <li>Русланыч: {stats.ruslanych.ruslanych}</li>
              <li>Русланыч AI: {stats.ruslanych.ai}</li>
              <li>Побед Русланыча: {stats.ruslanych.ruslanychWinPercent}%</li>
            </ul>
          )}
        </div>
        <div className="card">
          <h2>ИГРОКИ VS РУСЛАНЫЧ AI</h2>
          {stats && (
            <ul>
              <li>Всего партий: {stats.players.total}</li>
              <li>Побед игроков: {stats.players.playerWins}</li>
              <li>Побед Русланыч AI: {stats.players.aiWins}</li>
              <li>Ничьих: {stats.players.draws}</li>
              <li>Процент побед ИИ: {stats.players.aiWinPercent}%</li>
            </ul>
          )}
        </div>
      </section>

      <section className="board">
        <Chessboard
          options={{
            id: 'main',
            position: pending?.fen ?? game?.fen ?? START_FEN,
            boardOrientation: game?.playerColor === 'b' ? 'black' : 'white',
            allowDragging: myTurn,
            canDragPiece: ({ piece }) => myTurn && piece.pieceType[0] === game!.playerColor,
            onPieceDrop,
            onSquareClick,
            onPieceDrag: ({ square }) => square && setSelected(square as Square),
            squareStyles,
            animationDurationInMs: 150,
          }}
        />
        {promotion && (
          <div className="promotion" role="dialog">
            <span>Превращение:</span>
            {(['q', 'r', 'b', 'n'] as Promo[]).map((p) => (
              <button
                key={p}
                onClick={() => {
                  const { from, to } = promotion;
                  setPromotion(null);
                  send({ from, to, promotion: p });
                }}
              >
                {{ q: '♛ Ферзь', r: '♜ Ладья', b: '♝ Слон', n: '♞ Конь' }[p]}
              </button>
            ))}
            <button onClick={() => setPromotion(null)}>Отмена</button>
          </div>
        )}
      </section>

      <section className="status">
        <p className="thinking" aria-live="polite">{thinking ? 'ИИ думает…' : ' '}</p>
        <p aria-live="polite">{loaded ? statusText(game, offline) : 'Загрузка…'}</p>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="actions">
        {game?.status === 'active' ? (
          <button onClick={resign} disabled={busy}>
            Сдаться
          </button>
        ) : (
          <button onClick={startNew} disabled={busy || !loaded}>
            {game ? 'Реванш' : 'Новая партия'}
          </button>
        )}
      </section>

      {history.length > 0 && (
        <section className="history">
          <h2>Ходы{game ? ` · партия №${game.id}` : ''}</h2>
          <ol>
            {rows.map(([w, b], i) => (
              <li key={i}>
                {w} {b ?? ''}
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}

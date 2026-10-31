import type { GameView, MoveInput, StatsView } from '../shared/types.ts';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const ctrl = new AbortController();
  // the AI may think a few seconds; anything far beyond that is a lost connection
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? 'http', data.message ?? `Ошибка ${res.status}`);
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  stats: () => call<StatsView>('GET', '/api/stats'),
  current: () => call<{ game: GameView | null }>('GET', '/api/game'),
  game: (id: number) => call<{ game: GameView }>('GET', `/api/game/${id}`),
  newGame: (name: string) => call<{ game: GameView }>('POST', '/api/game', { name }),
  move: (id: number, move: MoveInput, ply: number) =>
    call<{ game: GameView }>('POST', `/api/game/${id}/move`, { ...move, ply }),
  resign: (id: number) => call<{ game: GameView }>('POST', `/api/game/${id}/resign`),
};

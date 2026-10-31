import path from 'node:path';
import fs from 'node:fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import { GameError, type GameService } from './games.ts';
import type { StatsView } from '../shared/types.ts';

const COOKIE = 'rsid';
const YEAR = 365 * 24 * 3600 * 1000;

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
}

export interface AppDeps {
  games: GameService;
  ruslanychStats: StatsView['ruslanych'];
  engineStatus: () => object;
  staticDir?: string;
}

export function createApp({ games, ruslanychStats, engineStatus, staticDir }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '4kb' }));

  // Anonymous play session; the id lives only in an httpOnly cookie.
  const session = (req: Request, res: Response) => {
    const prev = readCookie(req, COOKIE);
    const sid = games.ensureSession(prev);
    if (sid !== prev) {
      res.cookie(COOKIE, sid, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: YEAR, path: '/' });
    }
    return sid;
  };

  const api = express.Router();
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  api.get('/health', (_req, res) => {
    const engine = engineStatus() as { ready: boolean };
    res.status(engine.ready ? 200 : 503).json({ ok: engine.ready, engine });
  });

  api.get('/stats', (_req, res) => {
    res.json(games.stats(ruslanychStats));
  });

  api.get('/game', (req, res) => {
    const sid = session(req, res);
    res.json({ game: games.current(sid) });
  });

  api.get('/game/:id', (req, res) => {
    const sid = session(req, res);
    res.json({ game: games.get(sid, Number(req.params.id)) });
  });

  // New game / rematch. Returns the existing game if one is still unfinished.
  api.post('/game', (req, res) => {
    const sid = session(req, res);
    res.json({ game: games.newGame(sid) });
  });

  api.post('/game/:id/move', async (req, res) => {
    const sid = session(req, res);
    const { from, to, promotion, ply } = req.body ?? {};
    const game = await games.playerMove(sid, Number(req.params.id), { from, to, promotion }, Number(ply));
    res.json({ game });
  });

  api.post('/game/:id/resign', (req, res) => {
    const sid = session(req, res);
    res.json({ game: games.resign(sid, Number(req.params.id)) });
  });

  api.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Not found' });
  });

  app.use('/api', api);

  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.get(/.*/, (_req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof GameError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    const status = (err as { status?: number }).status;
    if (status && status < 500) {
      res.status(status).json({ error: 'bad_request', message: 'Некорректный запрос' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'internal', message: 'Ошибка сервера' });
  });

  return app;
}

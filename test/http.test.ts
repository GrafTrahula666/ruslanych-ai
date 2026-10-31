import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { setup } from './helpers.ts';

const BASE = { total: 1089, ruslanych: 567, ai: 522, ruslanychWinPercent: 52 };

async function server() {
  const { games, engine } = setup();
  const app = createApp({ games, ruslanychStats: BASE, engineStatus: () => ({ ready: true }) });
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { url, engine, close: () => srv.close() };
}

function client(url: string) {
  let cookie = '';
  return async (method: string, p: string, body?: unknown) => {
    const res = await fetch(url + p, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}

test('full game flow over HTTP with cookie sessions', async () => {
  const s = await server();
  try {
    const a = client(s.url);
    const b = client(s.url);
    assert.equal((await a('GET', '/api/game')).body.game, null);
    const g = (await a('POST', '/api/game')).body.game;
    assert.equal(g.moves.length, 0);

    // client cannot set the result, position or color: extra fields are ignored
    const r = await a('POST', `/api/game/${g.id}/move`, {
      from: 'e2', to: 'e4', ply: 0, result: 'player', status: 'finished', fen: '8/8/8/8/8/8/8/K6k w - - 0 1',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.game.status, 'active');
    assert.equal(r.body.game.moves.length, 2);

    // replay of the same request
    assert.equal((await a('POST', `/api/game/${g.id}/move`, { from: 'e2', to: 'e4', ply: 0 })).status, 409);
    // illegal move
    assert.equal((await a('POST', `/api/game/${g.id}/move`, { from: 'e1', to: 'e3', ply: 2 })).status, 422);
    // missing / malformed body
    assert.equal((await a('POST', `/api/game/${g.id}/move`, {})).status, 409);
    assert.equal((await a('POST', `/api/game/${g.id}/move`, '{bad json')).status, 400);

    // another browser cannot see or touch this game
    assert.equal((await b('GET', `/api/game/${g.id}`)).status, 404);
    assert.equal((await b('POST', `/api/game/${g.id}/resign`)).status, 404);
    assert.equal((await b('POST', `/api/game/${g.id}/move`, { from: 'd2', to: 'd4', ply: 2 })).status, 404);

    // no endpoint can write results or stats directly
    assert.equal((await a('POST', '/api/stats', { players: { total: 100 } })).status, 404);

    // reload restores the game
    assert.equal((await a('GET', '/api/game')).body.game.id, g.id);

    const res = await a('POST', `/api/game/${g.id}/resign`);
    assert.equal(res.body.game.result, 'ai');
    await a('POST', `/api/game/${g.id}/resign`);
    const st = (await a('GET', '/api/stats')).body;
    assert.deepEqual(st.players, { total: 1, playerWins: 0, aiWins: 1, draws: 0, aiWinPercent: 100 });
    assert.deepEqual(st.ruslanych, BASE);

    const g2 = (await a('POST', '/api/game')).body.game;
    assert.notEqual(g2.id, g.id);
  } finally {
    s.close();
  }
});

test('health reports engine state', async () => {
  const s = await server();
  try {
    const r = await fetch(s.url + '/api/health');
    assert.equal(r.status, 200);
  } finally {
    s.close();
  }
});

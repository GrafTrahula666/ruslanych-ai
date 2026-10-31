# РУСЛАНЫЧ AI

Шахматы против Stockfish 19 для хэллоуинского вечера бара «Пивник». Отдельный проект, с PIVNIK Bonus App не связан.

## Устройство

- `server/` — Node.js + TypeScript (Express, SQLite через встроенный `node:sqlite`).
  - `engine.ts` — пул UCI-процессов Stockfish: очередь запросов, сторожевой таймер, перезапуск зависшего/упавшего процесса.
  - `games.ts` — партии: проверка ходов `chess.js`, ход ИИ, завершение (мат, пат, троекратное повторение, 50 ходов, недостаток материала, сдача), статистика.
  - `app.ts` — HTTP API, анонимная сессия в httpOnly-cookie.
- `src/` — React + Vite, доска `react-chessboard`. Временный минимальный интерфейс.
- `shared/types.ts` — общие типы API.

Клиент только отправляет ход `{from, to, promotion, ply}`. Позицию, ход ИИ и результат считает сервер.
`ply` — сколько полуходов видел клиент: повторный или устаревший запрос отклоняется (409), так один ход не применится дважды.
Партия переходит в `finished` одним `UPDATE ... WHERE status = 'active'`, поэтому результат попадает в статистику ровно один раз.
Статистика посетителей считается из таблицы `games`, блок «Русланыч vs Русланыч AI» задаётся в `server/config.ts`.

## Сила движка

Без ограничений: `Skill Level 20`, `UCI_LimitStrength false`, `MultiPV 1`, полная история ходов передаётся движку (видит повторения).
По умолчанию используется Stockfish 19 (WASM, многопоточный) из npm-пакета `stockfish`. Если задан `STOCKFISH_PATH`, используется нативный бинарник (он примерно в 2–3 раза быстрее, Docker-образ ставит его сам).

## Переменные окружения

| Переменная | По умолчанию | |
|---|---|---|
| `PORT` | 3000 | |
| `DATA_DIR` | `./data` | папка SQLite; на хостинге должна быть постоянным томом |
| `STOCKFISH_PATH` | — | путь к нативному Stockfish |
| `ENGINE_POOL_SIZE` | min(3, ядра) | сколько партий ИИ считает одновременно |
| `ENGINE_THREADS` | все ядра | потоков на один процесс (одна партия получает всю мощность, одновременные делят CPU) |
| `ENGINE_HASH_MB` | 256 | хеш на процесс |
| `ENGINE_MOVE_TIME_MS` | 3000 | время на ход ИИ |
| `ENGINE_WATCHDOG_MS` | 20000 | сверх этого процесс считается зависшим и перезапускается |

## Команды

```
npm ci
npm run build      # клиент в dist/
npm start          # сервер + dist на :3000
npm test           # серверные тесты
npm run typecheck
```
Разработка: `npm run dev:server` и `npm run dev` (Vite проксирует `/api` на :3000).

## Публикация (Railway)

1. В Railway: **New Project → Deploy from GitHub repo → ruslanych-ai**. Сборка идёт по `Dockerfile` (`railway.json`), нативный Stockfish скачивается при сборке; если не вышло, работает WASM.
2. Добавить **Volume** с точкой монтирования `/data` — иначе партии и статистика пропадут при передеплое.
3. **Settings → Networking → Generate Domain** — получится HTTPS-адрес `*.up.railway.app`.
4. Проверить `https://<домен>/api/health` (`"ok": true`, в `engine.name` — Stockfish).
5. QR-код: `npm run qr -- https://<домен>` → `qr/ruslanych-ai-qr.png`.

Рекомендуемые переменные для сервиса с 8 vCPU: `ENGINE_POOL_SIZE=3`, `ENGINE_THREADS=8`, `ENGINE_HASH_MB=512`.

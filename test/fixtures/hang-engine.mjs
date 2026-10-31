#!/usr/bin/env node
// Fake UCI engine that starts normally but never answers "go" (simulates a hung Stockfish).
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (l) => {
  if (l === 'uci') console.log('id name HangFish\nuciok');
  if (l === 'isready') console.log('readyok');
  if (l === 'quit') process.exit(0);
});

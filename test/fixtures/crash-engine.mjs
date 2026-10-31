#!/usr/bin/env node
// Fake UCI engine that exits as soon as it is asked to search.
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (l) => {
  if (l === 'uci') console.log('id name CrashFish\nuciok');
  if (l === 'isready') console.log('readyok');
  if (l.startsWith('go')) process.exit(3);
});

// Usage: npm run qr -- https://example.com  → qr/ruslanych-ai-qr.png and .svg
import fs from 'node:fs';
import QRCode from 'qrcode';

const url = process.argv[2];
if (!url || !/^https:\/\//.test(url)) {
  console.error('usage: npm run qr -- https://<public url>');
  process.exit(1);
}
fs.mkdirSync('qr', { recursive: true });
const opts = { errorCorrectionLevel: 'M' as const, margin: 2 };
await QRCode.toFile('qr/ruslanych-ai-qr.png', url, { ...opts, width: 1024 });
fs.writeFileSync('qr/ruslanych-ai-qr.svg', await QRCode.toString(url, { ...opts, type: 'svg' }));
console.log(`QR for ${url} → qr/ruslanych-ai-qr.png, qr/ruslanych-ai-qr.svg`);

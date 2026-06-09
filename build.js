// Injects the backend WebSocket URL into app.js at build time.
// Set SOCKET_URL env var (e.g. https://my-game.fly.dev) when deploying the
// static frontend to Vercel separately from the Express+Socket.IO backend.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.join(__dirname, 'public', 'app.js');

const socketUrl = process.env.SOCKET_URL || '';
if (socketUrl) {
  let src = fs.readFileSync(appPath, 'utf8');
  src = src.replace(
    "window.__SOCKET_URL__ || undefined",
    JSON.stringify(socketUrl)
  );
  fs.writeFileSync(appPath, src);
  console.log(`Injected SOCKET_URL=${socketUrl} into app.js`);
} else {
  console.log('No SOCKET_URL set — using same-origin socket connection.');
}

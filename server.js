import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { newGame, revealedForRound, normalizeSettings, defaultSettings, assetClassInfo } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- In-memory game state (single shared room) ----------
// For a localhost party game we keep one global room. Extendable to many.

const ROOM = 'main';
const START_CASH = 1000;

let settings = defaultSettings();
let game = newGame(settings);
let trades = [];        // { round, trader, side, qty, price, ts }
let players = {};       // socketId -> { id, name, cash, position, connected }

function isClosed() {
  // Market closes when all configured trading rounds are done.
  return game.round >= game.contract.numRounds;
}

function publicGameState() {
  const revealedCount = revealedForRound(game);
  const closed = isClosed();
  return {
    contract: game.contract,
    revealedAssets: game.assets.slice(0, revealedCount),
    revealedCount,
    totalAssets: game.assets.length,
    round: game.round,
    numRounds: game.contract.numRounds,
    settled: closed,
    settlement: closed ? game.settlement : null,
  };
}

function playerList() {
  return Object.values(players).map((p) => ({
    id: p.id,
    name: p.name,
    cash: Math.round(p.cash * 100) / 100,
    position: p.position,
    connected: p.connected,
    pnl: pnlFor(p),
  }));
}

function lastPrice() {
  if (trades.length) return trades[trades.length - 1].price;
  return null;
}

// Mark-to-market PnL: cash change + position valued at last trade price
// (or settlement once the game is closed).
function pnlFor(p) {
  const mark = isClosed() ? game.settlement : (lastPrice() ?? 0);
  const equity = p.cash + p.position * mark;
  return Math.round((equity - START_CASH) * 100) / 100;
}

function broadcast() {
  io.to(ROOM).emit('state', {
    game: publicGameState(),
    players: playerList(),
    trades: trades.slice(-30),
    lastPrice: lastPrice(),
  });
}

// Start a brand-new game with the given settings and reset all players.
function startGame(rawSettings) {
  settings = normalizeSettings(rawSettings);
  game = newGame(settings);
  trades = [];
  for (const p of Object.values(players)) {
    p.cash = START_CASH;
    p.position = 0;
  }
  io.to(ROOM).emit('hints', game.hintCards);
  io.to(ROOM).emit('gameStarted');
  broadcast();
}

io.on('connection', (socket) => {
  socket.join(ROOM);

  // Give the client everything it needs to render the settings screen.
  socket.emit('config', {
    assetClasses: assetClassInfo(),
    current: settings,
    startCash: START_CASH,
  });

  socket.on('join', (name) => {
    const clean = String(name || '').trim().slice(0, 20) || `Trader-${socket.id.slice(0, 4)}`;
    players[socket.id] = {
      id: socket.id,
      name: clean,
      cash: START_CASH,
      position: 0,
      connected: true,
    };
    socket.emit('hints', game.hintCards);
    socket.emit('joined', { id: socket.id, startCash: START_CASH });
    broadcast();
  });

  // Apply settings = start a fresh game for everyone with this configuration.
  socket.on('applySettings', (incoming) => {
    startGame(incoming);
  });

  // A market order vs. "the house" at the stated price. Trades are logged.
  socket.on('trade', ({ side, qty, price }) => {
    const p = players[socket.id];
    if (!p) return;
    if (isClosed()) return; // market closed
    qty = Math.max(1, Math.min(100, parseInt(qty, 10) || 0));
    price = parseFloat(price);
    if (!isFinite(price) || price < 0) return;

    const cost = qty * price;
    if (side === 'buy') {
      if (p.cash < cost) return; // can't afford
      p.cash -= cost;
      p.position += qty;
    } else if (side === 'sell') {
      p.cash += cost;
      p.position -= qty;
    } else {
      return;
    }
    trades.push({
      round: game.round,
      trader: p.name,
      side,
      qty,
      price: Math.round(price * 100) / 100,
      ts: Date.now(),
    });
    broadcast();
  });

  // Advance to the next round. One asset is revealed per round (up to the
  // number drawn). When the final configured round completes, settle.
  socket.on('nextRound', () => {
    if (!isClosed()) {
      game.round += 1;
      if (isClosed()) settleAll();
    }
    broadcast();
  });

  // Restart no longer immediately starts a game — it asks every client to
  // open the settings screen so the host can reconfigure.
  socket.on('restart', () => {
    io.to(ROOM).emit('openSettings');
  });

  socket.on('rename', (name) => {
    const p = players[socket.id];
    if (p) {
      p.name = String(name || '').trim().slice(0, 20) || p.name;
      broadcast();
    }
  });

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      players[socket.id].connected = false; // keep positions in the book
      broadcast();
    }
  });
});

// When the market closes, settle every open position at the settlement price.
function settleAll() {
  const s = game.settlement;
  for (const p of Object.values(players)) {
    p.cash += p.position * s;
    p.position = 0;
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  Futures Trading Game running at http://localhost:${PORT}\n`);
});

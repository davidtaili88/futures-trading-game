import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { newGame, revealedForRound, normalizeSettings, defaultSettings, assetClassInfo, contractInfo } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
  },
});

app.use(express.static(path.join(__dirname, 'public')));

const START_CASH = 1000;

// rooms[roomId] = { settings, game, trades, players }
const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    const settings = defaultSettings();
    rooms[roomId] = {
      settings,
      game: newGame(settings),
      trades: [],
      players: {},  // socketId -> { id, name, cash, position, connected, hintKey }
    };
  }
  return rooms[roomId];
}

function isClosed(room) {
  return room.game.round >= room.game.contract.numRounds;
}

function lastPrice(room) {
  if (room.trades.length) return room.trades[room.trades.length - 1].price;
  return null;
}

function pnlFor(p, room) {
  const mark = isClosed(room) ? room.game.settlement : (lastPrice(room) ?? 0);
  const equity = p.cash + p.position * mark;
  return Math.round((equity - START_CASH) * 100) / 100;
}

function publicGameState(room) {
  const revealedCount = revealedForRound(room.game);
  const closed = isClosed(room);
  return {
    contract: room.game.contract,
    revealedAssets: room.game.assets.slice(0, revealedCount),
    revealedCount,
    totalAssets: room.game.assets.length,
    round: room.game.round,
    numRounds: room.game.contract.numRounds,
    settled: closed,
    settlement: closed ? room.game.settlement : null,
  };
}

function playerList(room) {
  return Object.values(room.players).map((p) => ({
    id: p.id,
    name: p.name,
    cash: Math.round(p.cash * 100) / 100,
    position: p.position,
    connected: p.connected,
    pnl: pnlFor(p, room),
  }));
}

function broadcast(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit('state', {
    game: publicGameState(room),
    players: playerList(room),
    trades: room.trades.slice(-30),
    lastPrice: lastPrice(room),
  });
}

function startGame(roomId, rawSettings) {
  const room = getRoom(roomId);
  room.settings = normalizeSettings(rawSettings);
  room.game = newGame(room.settings);
  room.trades = [];
  for (const p of Object.values(room.players)) {
    p.cash = START_CASH;
    p.position = 0;
  }
  // Assign each player a fresh random single hint card.
  for (const sid of Object.keys(room.players)) {
    const hint = pickHintFor(room, sid);
    io.to(sid).emit('hints', hint ? [hint] : []);
  }
  io.to(roomId).emit('gameStarted');
  broadcast(roomId);
}

// Pick one random hint card for a socket, store the key on the player.
function pickHintFor(room, socketId) {
  const cards = room.game.hintCards;
  if (!cards.length) return null;
  const card = cards[Math.floor(Math.random() * cards.length)];
  if (room.players[socketId]) room.players[socketId].hintKey = card.key;
  return card;
}

function settleAll(room) {
  const s = room.game.settlement;
  for (const p of Object.values(room.players)) {
    p.cash += p.position * s;
    p.position = 0;
  }
}

io.on('connection', (socket) => {
  // Room is determined by the URL hash sent from the client on connect.
  let roomId = null;

  socket.on('joinRoom', (rid) => {
    roomId = String(rid || 'main').trim().slice(0, 40) || 'main';
    socket.join(roomId);
    const room = getRoom(roomId);

    socket.emit('config', {
      assetClasses: assetClassInfo(),
      contracts: contractInfo(),
      current: room.settings,
      startCash: START_CASH,
    });
  });

  socket.on('join', (name) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    const clean = String(name || '').trim().slice(0, 20) || `Trader-${socket.id.slice(0, 4)}`;
    room.players[socket.id] = {
      id: socket.id,
      name: clean,
      cash: START_CASH,
      position: 0,
      connected: true,
      hintKey: null,
    };
    const hint = pickHintFor(room, socket.id);
    socket.emit('hints', hint ? [hint] : []);
    socket.emit('joined', { id: socket.id, startCash: START_CASH });
    broadcast(roomId);
  });

  socket.on('applySettings', (incoming) => {
    if (!roomId) return;
    startGame(roomId, incoming);
  });

  socket.on('trade', ({ side, qty, price }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    const p = room.players[socket.id];
    if (!p) return;
    if (isClosed(room)) return;
    qty = Math.max(1, Math.min(100, parseInt(qty, 10) || 0));
    price = parseFloat(price);
    if (!isFinite(price) || price < 0) return;

    const cost = qty * price;
    if (side === 'buy') {
      if (p.cash < cost) return;
      p.cash -= cost;
      p.position += qty;
    } else if (side === 'sell') {
      p.cash += cost;
      p.position -= qty;
    } else {
      return;
    }
    room.trades.push({
      round: room.game.round,
      trader: p.name,
      side,
      qty,
      price: Math.round(price * 100) / 100,
      ts: Date.now(),
    });
    broadcast(roomId);
  });

  socket.on('nextRound', () => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!isClosed(room)) {
      room.game.round += 1;
      if (isClosed(room)) settleAll(room);
    }
    broadcast(roomId);
  });

  socket.on('restart', () => {
    if (!roomId) return;
    io.to(roomId).emit('openSettings');
  });

  socket.on('rename', (name) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    const p = room.players[socket.id];
    if (p) {
      p.name = String(name || '').trim().slice(0, 20) || p.name;
      broadcast(roomId);
    }
  });

  socket.on('disconnect', () => {
    if (!roomId) return;
    const room = rooms[roomId];
    if (room && room.players[socket.id]) {
      room.players[socket.id].connected = false;
      broadcast(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  Futures Trading Game running at http://localhost:${PORT}\n`);
});

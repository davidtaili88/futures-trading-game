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

// rooms[roomId] = { settings, game, trades, players, mm, orderBook }
// mm = market making state for the current round:
//   { phase: 'bidding'|'trading'|null, bids: {socketId->margin},
//     makerId, bid, ask }
// orderBook = open-outcry resting orders (non-MM mode only):
//   { bids: {socketId -> {price,qty,name}}, asks: {socketId -> {price,qty,name}} }
const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    const settings = defaultSettings();
    rooms[roomId] = {
      settings,
      game: newGame(settings),
      trades: [],
      players: {},
      mm: null,
      orderBook: { bids: {}, asks: {} },
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

function connectedPlayerIds(room) {
  return Object.entries(room.players)
    .filter(([, p]) => p.connected)
    .map(([id]) => id);
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
    marketMaking: room.settings.marketMaking || false,
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
    isMarketMaker: room.mm ? p.id === room.mm.makerId : false,
  }));
}

function mmPublic(room) {
  if (!room.mm) return null;
  const { phase, makerId, bid, ask, bids } = room.mm;
  const makerName = room.players[makerId]?.name ?? '—';
  // Only expose which players have bid (not the amounts) during bidding phase.
  const bidderIds = Object.keys(bids);
  return { phase, makerId, makerName, bid, ask, bidderIds };
}

function broadcast(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit('state', {
    game: publicGameState(room),
    players: playerList(room),
    trades: room.trades.slice(-30),
    lastPrice: lastPrice(room),
    mm: mmPublic(room),
    orderBook: room.orderBook,
  });
}

function startGame(roomId, rawSettings) {
  const room = getRoom(roomId);
  room.settings = normalizeSettings(rawSettings);
  room.settings.marketMaking = !!rawSettings.marketMaking;
  room.game = newGame(room.settings);
  room.trades = [];
  room.mm = null;
  room.orderBook = { bids: {}, asks: {} };
  for (const p of Object.values(room.players)) {
    p.cash = START_CASH;
    p.position = 0;
  }
  for (const sid of Object.keys(room.players)) {
    const hint = pickHintFor(room, sid);
    io.to(sid).emit('hints', hint ? [hint] : []);
  }
  io.to(roomId).emit('gameStarted');
  broadcast(roomId);

  // In MM mode, immediately open bidding for round 1.
  if (room.settings.marketMaking) {
    room.game.round = 1;
    broadcast(roomId);
    openBidPhase(roomId);
  }
}

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

// Open a bidding phase for the upcoming round.
function openBidPhase(roomId) {
  const room = rooms[roomId];
  room.mm = { phase: 'bidding', bids: {}, makerId: null, bid: null, ask: null };
  broadcast(roomId);
  io.to(roomId).emit('bidPhaseOpen');
}

// Called when all connected players have submitted bids (or host forces close).
function resolveBids(roomId) {
  const room = rooms[roomId];
  if (!room.mm || room.mm.phase !== 'bidding') return;

  const entries = Object.entries(room.mm.bids); // [[socketId, margin], ...]
  if (!entries.length) {
    // No bids — skip MM, go straight to normal trading.
    room.mm = null;
    broadcast(roomId);
    return;
  }

  // Find minimum margin; break ties randomly.
  const minMargin = Math.min(...entries.map(([, m]) => m));
  const tied = entries.filter(([, m]) => m === minMargin);
  const [winnerId, winMargin] = tied[Math.floor(Math.random() * tied.length)];

  // Move to 'quoting' phase — winner must now set their own bid/ask.
  room.mm = {
    phase: 'quoting',
    bids: room.mm.bids,
    makerId: winnerId,
    margin: winMargin,
    bid: null,
    ask: null,
  };

  broadcast(roomId);
  // Tell everyone who won, tell the winner to enter their prices.
  io.to(roomId).emit('bidPhaseResolved', {
    makerName: room.players[winnerId]?.name ?? '—',
    margin: winMargin,
  });
  io.to(winnerId).emit('setMarketPrompt', { margin: winMargin });
}

io.on('connection', (socket) => {
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

  // MM mode: non-maker trades at the fixed bid/ask set by the maker.
  socket.on('trade', ({ side, qty, price }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    const p = room.players[socket.id];
    if (!p) return;
    if (isClosed(room)) return;
    if (!room.mm || room.mm.phase !== 'trading') return;
    if (socket.id === room.mm.makerId) return;

    qty = Math.max(1, Math.min(100, parseInt(qty, 10) || 0));
    if (side === 'buy') price = room.mm.ask;
    else if (side === 'sell') price = room.mm.bid;
    else return;

    const maker = room.players[room.mm.makerId];
    if (!maker) return;
    const cost = qty * price;
    if (side === 'buy') {
      if (p.cash < cost) return;
      p.cash -= cost;
      p.position += qty;
      maker.cash += cost;
      maker.position -= qty;
    } else {
      p.cash += cost;
      p.position -= qty;
      maker.cash -= cost;
      maker.position += qty;
    }
    room.trades.push({
      round: room.game.round,
      trader: p.name,
      side,
      qty,
      price: Math.round(price * 100) / 100,
      ts: Date.now(),
      mmRound: true,
    });
    broadcast(roomId);
  });

  // Open-outcry: post a resting bid or ask (replaces any previous one on that side).
  socket.on('postOrder', ({ side, qty, price }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    const p = room.players[socket.id];
    if (!p) return;
    if (isClosed(room)) return;
    if (room.settings.marketMaking) return;

    qty = Math.max(1, Math.min(100, parseInt(qty, 10) || 0));
    price = Math.round(parseFloat(price) * 100) / 100;
    if (!isFinite(price) || price < 0) return;
    if (side !== 'bid' && side !== 'ask') return;

    room.orderBook[side === 'bid' ? 'bids' : 'asks'][socket.id] = { price, qty, name: p.name };
    broadcast(roomId);
  });

  // Open-outcry: hit another player's resting order — executes immediately.
  socket.on('takeOrder', ({ side, targetId }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    const taker = room.players[socket.id];
    if (!taker) return;
    if (isClosed(room)) return;
    if (room.settings.marketMaking) return;
    if (targetId === socket.id) return;

    const book = side === 'bid' ? room.orderBook.bids : room.orderBook.asks;
    const order = book[targetId];
    if (!order) return;

    const maker = room.players[targetId];
    if (!maker) return;

    const { price, qty } = order;
    const cost = qty * price;

    if (side === 'bid') {
      // Taker is selling into a resting bid: taker goes short, maker goes long.
      taker.cash += cost;
      taker.position -= qty;
      maker.cash -= cost;
      maker.position += qty;
    } else {
      // Taker is buying a resting ask: taker goes long, maker goes short.
      if (taker.cash < cost) return;
      taker.cash -= cost;
      taker.position += qty;
      maker.cash += cost;
      maker.position -= qty;
    }

    delete book[targetId];

    room.trades.push({
      round: room.game.round,
      buyer: side === 'ask' ? taker.name : maker.name,
      seller: side === 'bid' ? taker.name : maker.name,
      qty,
      price: Math.round(price * 100) / 100,
      ts: Date.now(),
    });
    broadcast(roomId);
  });

  // Open-outcry: cancel your own resting order.
  socket.on('cancelOrder', ({ side }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room.players[socket.id]) return;
    if (room.settings.marketMaking) return;
    if (side !== 'bid' && side !== 'ask') return;

    const book = side === 'bid' ? room.orderBook.bids : room.orderBook.asks;
    delete book[socket.id];
    broadcast(roomId);
  });

  // Player submits their margin bid.
  socket.on('submitBid', (margin) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room.mm || room.mm.phase !== 'bidding') return;
    margin = parseFloat(margin);
    if (!isFinite(margin) || margin <= 0) return;
    room.mm.bids[socket.id] = Math.round(margin * 100) / 100;
    broadcast(roomId);

    // Auto-resolve once every connected player has bid.
    const connected = connectedPlayerIds(room);
    const allBid = connected.every((id) => room.mm.bids[id] !== undefined);
    if (allBid) resolveBids(roomId);
  });

  // Market maker submits their chosen bid and ask prices.
  socket.on('setMarket', ({ bid, ask }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room.mm || room.mm.phase !== 'quoting') return;
    if (socket.id !== room.mm.makerId) return;
    bid = Math.round(parseFloat(bid) * 100) / 100;
    ask = Math.round(parseFloat(ask) * 100) / 100;
    if (!isFinite(bid) || !isFinite(ask) || bid < 0 || ask <= bid) return;
    room.mm.bid = bid;
    room.mm.ask = ask;
    room.mm.phase = 'trading';
    broadcast(roomId);
    io.to(roomId).emit('marketSet', { makerName: room.players[socket.id]?.name ?? '—', bid, ask });
  });

  // Host can force-resolve bids early (not all players submitted).
  socket.on('resolveBids', () => {
    if (!roomId) return;
    resolveBids(roomId);
  });

  socket.on('nextRound', () => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (isClosed(room)) return;

    room.game.round += 1;
    room.mm = null;
    room.orderBook = { bids: {}, asks: {} };

    if (isClosed(room)) {
      settleAll(room);
      broadcast(roomId);
      return;
    }

    // Reveal the new asset first, then open bidding (or go straight to trading).
    broadcast(roomId);
    if (room.settings.marketMaking) {
      openBidPhase(roomId);
    }
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
    if (!room) return;
    if (room.players[socket.id]) {
      room.players[socket.id].connected = false;
      broadcast(roomId);
    }
    // If we're in bid phase and the disconnected player was the last one needed, resolve.
    if (room.mm?.phase === 'bidding') {
      const connected = connectedPlayerIds(room);
      const allBid = connected.length > 0 && connected.every((id) => room.mm.bids[id] !== undefined);
      if (allBid) resolveBids(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  Futures Trading Game running at http://localhost:${PORT}\n`);
});

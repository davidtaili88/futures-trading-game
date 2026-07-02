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

const START_CASH = 0;

// rooms[roomId] = { settings, game, trades, players, playersByName, mm, orderBook, roundTimer, roundEndsAt }
// players = { socketId -> playerObj } — active socket sessions
// playersByName = { name -> {cash, position, hintKey} } — persistent state across reconnects
// mm = market making state for the current round:
//   { phase: 'bidding'|'trading'|null, bids: {socketId->margin},
//     makerId, bid, ask }
// orderBook = open-outcry resting orders (non-MM mode only):
//   { bids: [{id, socketId, price, qty, name}], asks: [{id, socketId, price, qty, name}] }
// roundTimer = active setTimeout handle for auto-advancing the round (null if none)
// roundEndsAt = epoch ms when the current round timer expires (null if no timer)
const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    const settings = defaultSettings();
    rooms[roomId] = {
      settings,
      game: newGame(settings),
      trades: [],
      tradeCount: {},
      players: {},
      playersByName: {},
      hostId: null,
      mm: null,
      orderBook: { bids: [], asks: [] },
      roundTimer: null,
      roundEndsAt: null,
    };
  }
  return rooms[roomId];
}

function assignHost(room, preferredId) {
  if (preferredId && room.players[preferredId]?.connected) {
    room.hostId = preferredId;
    return;
  }
  // Fall back to first connected player.
  const connected = connectedPlayerIds(room);
  room.hostId = connected.length ? connected[0] : null;
}

function isHost(room, socketId) {
  return room.hostId === socketId;
}

function withinLimit(room, player, deltaPosition) {
  const limit = room.settings.positionLimit ?? 10;
  const newPos = player.position + deltaPosition;
  return newPos >= -limit && newPos <= limit;
}

function clearRoundTimer(room) {
  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }
  room.roundEndsAt = null;
}

function startRoundTimer(roomId) {
  const room = rooms[roomId];
  clearRoundTimer(room);
  const duration = room.settings.roundDuration;
  if (!duration || duration <= 0 || room.settings.marketMaking) return;
  room.roundEndsAt = Date.now() + duration * 1000;
  room.roundTimer = setTimeout(() => {
    room.roundTimer = null;
    advanceRound(roomId);
  }, duration * 1000);
}

function advanceRound(roomId) {
  const room = rooms[roomId];
  if (!room || isClosed(room)) return;
  clearRoundTimer(room);
  room.game.round += 1;
  room.mm = null;
  room.orderBook = { bids: [], asks: [] };
  if (isClosed(room)) {
    settleAll(room);
    broadcast(roomId);
    return;
  }
  broadcast(roomId);
  if (room.settings.marketMaking) {
    openBidPhase(roomId);
  } else {
    startRoundTimer(roomId);
  }
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
    positionLimit: room.settings.positionLimit ?? 10,
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
    isHost: p.id === room.hostId,
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
    roundEndsAt: room.roundEndsAt,
  });
}

function startGame(roomId, rawSettings) {
  const room = getRoom(roomId);
  room.settings = normalizeSettings(rawSettings);
  room.settings.marketMaking = !!rawSettings.marketMaking;
  const rd = parseInt(rawSettings.roundDuration, 10);
  room.settings.roundDuration = Number.isFinite(rd) && rd >= 0 ? Math.min(rd, 300) : 0;
  const pl = parseInt(rawSettings.positionLimit, 10);
  room.settings.positionLimit = Number.isFinite(pl) && pl > 0 ? Math.min(pl, 1000) : 10;
  room.game = newGame(room.settings);
  room.trades = [];
  room.tradeCount = {}; // playerName -> number of completed trades
  room.mm = null;
  room.orderBook = { bids: [], asks: [] };
  room.playersByName = {};
  clearRoundTimer(room);
  for (const p of Object.values(room.players)) {
    p.cash = START_CASH;
    p.position = 0;
    room.playersByName[p.name] = { cash: p.cash, position: p.position, hintKey: null };
  }
  // Assign hints without replacement: shuffle the hint cards and deal them out,
  // cycling back to the start if there are more players than hint types.
  const cards = room.game.hintCards;
  const shuffled = cards.slice().sort(() => Math.random() - 0.5);
  const playerIds = Object.keys(room.players);
  playerIds.forEach((sid, i) => {
    const card = shuffled[i % shuffled.length];
    if (room.players[sid]) room.players[sid].hintKey = card.key;
    io.to(sid).emit('hints', card ? [card] : []);
  });
  room.game.round = 1;
  io.to(roomId).emit('gameStarted');
  broadcast(roomId);

  if (room.settings.marketMaking) {
    openBidPhase(roomId);
  } else {
    startRoundTimer(roomId);
  }
}

function syncPlayerByName(room, socketId) {
  const p = room.players[socketId];
  if (p) room.playersByName[p.name] = { cash: p.cash, position: p.position, hintKey: p.hintKey };
}

function pickHintFor(room, socketId) {
  const cards = room.game.hintCards;
  if (!cards.length) return null;
  const card = cards[Math.floor(Math.random() * cards.length)];
  if (room.players[socketId]) room.players[socketId].hintKey = card.key;
  return card;
}

function recordTrade(room, ...playerNames) {
  for (const name of playerNames) {
    room.tradeCount[name] = (room.tradeCount[name] ?? 0) + 1;
  }
}

function settleAll(room) {
  const s = room.game.settlement;
  for (const p of Object.values(room.players)) {
    p.cash += p.position * s;
    p.position = 0;
    if ((room.tradeCount[p.name] ?? 0) < 2) p.cash -= 20;
  }
}

// Auto-match crossing orders in the open-outcry book.
// Runs after every postOrder. Loops until no cross remains.
function tryMatchOrders(room) {
  while (true) {
    if (!room.orderBook.bids.length || !room.orderBook.asks.length) break;

    // Best bid = highest price; best ask = lowest price.
    const bestBid = room.orderBook.bids.reduce((a, b) => b.price > a.price ? b : a);
    const bestAsk = room.orderBook.asks.reduce((a, b) => b.price < a.price ? b : a);

    if (bestBid.price < bestAsk.price) break; // no cross

    // Same player can't cross with themselves.
    if (bestBid.socketId === bestAsk.socketId) break;

    const buyer = room.players[bestBid.socketId];
    const seller = room.players[bestAsk.socketId];
    if (!buyer || !seller) break;

    const execPrice = Math.round(bestBid.price * 100) / 100;
    const execQty = Math.min(bestBid.qty, bestAsk.qty);

    if (!withinLimit(room, buyer, +execQty)) break;
    if (!withinLimit(room, seller, -execQty)) break;

    const cost = execQty * execPrice;
    buyer.cash -= cost;
    buyer.position += execQty;
    seller.cash += cost;
    seller.position -= execQty;

    room.trades.push({
      round: room.game.round,
      buyer: buyer.name,
      seller: seller.name,
      qty: execQty,
      price: execPrice,
      ts: Date.now(),
    });
    recordTrade(room, buyer.name, seller.name);
    syncPlayerByName(room, bestBid.socketId);
    syncPlayerByName(room, bestAsk.socketId);

    // Reduce or remove the matched orders.
    bestBid.qty -= execQty;
    bestAsk.qty -= execQty;
    if (bestBid.qty <= 0) room.orderBook.bids = room.orderBook.bids.filter(o => o.id !== bestBid.id);
    if (bestAsk.qty <= 0) room.orderBook.asks = room.orderBook.asks.filter(o => o.id !== bestAsk.id);
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
      gameInProgress: room.game.round > 0 && !isClosed(room),
    });
  });

  socket.on('join', (name) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    const clean = String(name || '').trim().slice(0, 20) || `Trader-${socket.id.slice(0, 4)}`;

    const saved = room.playersByName[clean];
    if (saved) {
      // Returning player with same name — restore their state.
      // Remove any old socket entry for this name so there's no duplicate.
      for (const [sid, p] of Object.entries(room.players)) {
        if (p.name === clean && sid !== socket.id) delete room.players[sid];
      }
      room.players[socket.id] = {
        id: socket.id,
        name: clean,
        cash: saved.cash,
        position: saved.position,
        connected: true,
        hintKey: saved.hintKey,
      };
      const hintCard = saved.hintKey
        ? room.game.hintCards.find((c) => c.key === saved.hintKey) ?? null
        : null;
      socket.emit('hints', hintCard ? [hintCard] : []);
    } else {
      // New player — fresh state.
      room.players[socket.id] = {
        id: socket.id,
        name: clean,
        cash: START_CASH,
        position: 0,
        connected: true,
        hintKey: null,
      };
      room.playersByName[clean] = { cash: START_CASH, position: 0, hintKey: null };
      const hint = pickHintFor(room, socket.id);
      socket.emit('hints', hint ? [hint] : []);
    }

    // First player to join becomes host.
    if (!room.hostId) room.hostId = socket.id;

    socket.emit('joined', { id: socket.id, startCash: START_CASH, isHost: room.hostId === socket.id });
    broadcast(roomId);
  });

  socket.on('claimHost', () => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room.players[socket.id]?.connected) return;
    room.hostId = socket.id;
    broadcast(roomId);
  });

  socket.on('applySettings', (incoming) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!isHost(room, socket.id)) return;
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
      if (!withinLimit(room, p, +qty)) return;
      if (!withinLimit(room, maker, -qty)) return;
      p.cash -= cost;
      p.position += qty;
      maker.cash += cost;
      maker.position -= qty;
    } else {
      if (!withinLimit(room, p, -qty)) return;
      if (!withinLimit(room, maker, +qty)) return;
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
    recordTrade(room, p.name, room.players[room.mm.makerId]?.name);
    syncPlayerByName(room, socket.id);
    syncPlayerByName(room, room.mm.makerId);
    broadcast(roomId);
  });

  // Open-outcry: post a resting bid or ask (replaces any previous one on that side),
  // then auto-match if a cross exists.
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

    // Clamp qty so even if all resting orders on this side fill, position stays within limits.
    const limit = room.settings.positionLimit ?? 10;
    const existingExposure = (side === 'bid' ? room.orderBook.bids : room.orderBook.asks)
      .filter(o => o.socketId === socket.id)
      .reduce((sum, o) => sum + o.qty, 0);
    const maxDelta = side === 'bid'
      ? limit - p.position - existingExposure
      : limit + p.position - existingExposure;
    qty = Math.min(qty, Math.max(0, maxDelta));
    if (qty <= 0) {
      socket.emit('tradeError', `Position limit ±${limit} reached — order rejected.`);
      return;
    }

    const orderId = `${socket.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    room.orderBook[side === 'bid' ? 'bids' : 'asks'].push({ id: orderId, socketId: socket.id, price, qty, name: p.name });
    tryMatchOrders(room);
    broadcast(roomId);
  });

  // Open-outcry: hit a specific resting order by its ID.
  socket.on('takeOrder', ({ side, orderId }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    const taker = room.players[socket.id];
    if (!taker) return;
    if (isClosed(room)) return;
    if (room.settings.marketMaking) return;

    const list = side === 'bid' ? room.orderBook.bids : room.orderBook.asks;
    const order = list.find(o => o.id === orderId);
    if (!order) return;
    if (order.socketId === socket.id) return; // can't take own order

    const maker = room.players[order.socketId];
    if (!maker) return;

    const { price, qty } = order;
    const cost = qty * price;

    const limit = room.settings.positionLimit ?? 10;
    if (side === 'bid') {
      if (!withinLimit(room, taker, -qty)) {
        socket.emit('tradeError', `Position limit ±${limit} reached — cannot hit this bid.`);
        return;
      }
      if (!withinLimit(room, maker, +qty)) return;
      taker.cash += cost;
      taker.position -= qty;
      maker.cash -= cost;
      maker.position += qty;
    } else {
      if (!withinLimit(room, taker, +qty)) {
        socket.emit('tradeError', `Position limit ±${limit} reached — cannot lift this ask.`);
        return;
      }
      if (!withinLimit(room, maker, -qty)) return;
      taker.cash -= cost;
      taker.position += qty;
      maker.cash += cost;
      maker.position -= qty;
    }

    room.orderBook[side === 'bid' ? 'bids' : 'asks'] =
      list.filter(o => o.id !== orderId);

    room.trades.push({
      round: room.game.round,
      buyer: side === 'ask' ? taker.name : maker.name,
      seller: side === 'bid' ? taker.name : maker.name,
      qty,
      price: Math.round(price * 100) / 100,
      ts: Date.now(),
    });
    recordTrade(room, taker.name, maker.name);
    syncPlayerByName(room, socket.id);
    syncPlayerByName(room, order.socketId);
    broadcast(roomId);
  });

  // Open-outcry: cancel one of your own resting orders by ID.
  socket.on('cancelOrder', ({ orderId }) => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room.players[socket.id]) return;
    if (room.settings.marketMaking) return;

    for (const side of ['bids', 'asks']) {
      const before = room.orderBook[side].length;
      room.orderBook[side] = room.orderBook[side].filter(
        o => !(o.id === orderId && o.socketId === socket.id)
      );
      if (room.orderBook[side].length !== before) break;
    }
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
    const spread = Math.round((ask - bid) * 100) / 100;
    if (!isFinite(bid) || !isFinite(ask) || bid < 0 || ask <= bid) return;
    if (spread !== room.mm.margin) return;
    room.mm.bid = bid;
    room.mm.ask = ask;
    room.mm.phase = 'trading';
    broadcast(roomId);
    io.to(roomId).emit('marketSet', { makerName: room.players[socket.id]?.name ?? '—', bid, ask });
  });

  // Host can force-resolve bids early (not all players submitted).
  socket.on('resolveBids', () => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!isHost(room, socket.id)) return;
    resolveBids(roomId);
  });

  socket.on('nextRound', () => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!isHost(room, socket.id)) return;
    advanceRound(roomId);
  });

  socket.on('restart', () => {
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!isHost(room, socket.id)) return;
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
      syncPlayerByName(room, socket.id);
      room.players[socket.id].connected = false;
    }
    // If host disconnected, pass host to next connected player.
    if (room.hostId === socket.id) assignHost(room, null);
    broadcast(roomId);
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

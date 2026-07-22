const SOCKET_URL = window.__SOCKET_URL__ || undefined;
const socket = SOCKET_URL ? io(SOCKET_URL) : io();

let myId = null;
let startCash = 1000;
let amHost = false;
let hasJoined = false;
let gameInProgress = false;
// Name we've joined under, remembered so a reconnect/reload can auto-rejoin the
// SAME player (restoring cash/position/hints) instead of appearing frozen.
let joinedName = localStorage.getItem('tg_name_' + (location.hash.slice(1) || 'main')) || null;

const $ = (id) => document.getElementById(id);

// ---------- Room ----------
const roomId = location.hash.slice(1) || 'main';

socket.on('connect', () => {
  socket.emit('joinRoom', roomId);
  $('start-btn').textContent = 'Start Game';
  $('start-btn').disabled = false;
  // If we were already in a game (reconnect/reload), rejoin under the same name
  // and pull fresh state so the UI resumes instead of freezing.
  if (joinedName) {
    socket.emit('join', joinedName);
    hasJoined = true;
    socket.emit('resync');
  }
});

socket.on('disconnect', () => {
  $('start-btn').textContent = 'Reconnecting…';
  $('start-btn').disabled = true;
});

socket.on('connect_error', () => {
  $('start-btn').textContent = 'Connecting to server…';
  $('start-btn').disabled = true;
});

// Show connecting state immediately on page load.
$('start-btn').textContent = 'Connecting to server…';
$('start-btn').disabled = true;

// ---------- Settings screen ----------
let assetClasses = [];
let contracts = [];
let chosenClass = 'cards';
let chosenContractId = null;

socket.on('config', ({ assetClasses: classes, contracts: ctrs, current, gameInProgress: inProgress }) => {
  assetClasses = classes;
  contracts = ctrs;
  chosenClass = current.assetClass;
  chosenContractId = current.contractId;
  gameInProgress = !!inProgress;
  $('mm-mode').checked = !!current.marketMaking;
  $('round-duration').value = current.roundDuration ?? 60;
  $('position-limit').value = current.positionLimit ?? 10;
  $('num-bots').value = current.numBots ?? 0;
  renderAssetClassButtons();
  renderContractButtons();
  $('num-assets').value = current.numAssets;
  $('num-rounds').value = current.numRounds;
  $('private-per-player').value = current.privatePerPlayer ?? 0;
  syncSettingsLabels();
  syncBotsVisibility();
  syncRoundDurationLabel();
  syncPositionLimitLabel();
  $('start-btn').textContent = gameInProgress ? 'Join Game' : 'Start Game';
});

function renderAssetClassButtons() {
  const group = $('asset-class-group');
  group.innerHTML = '';
  for (const c of assetClasses) {
    const b = document.createElement('button');
    b.className = 'seg-btn' + (c.key === chosenClass ? ' active' : '');
    b.dataset.key = c.key;
    b.textContent = c.label;
    b.addEventListener('click', () => {
      chosenClass = c.key;
      const slider = $('num-assets');
      slider.max = c.maxAssets;
      if (parseInt(slider.value, 10) > c.maxAssets) slider.value = c.maxAssets;
      renderAssetClassButtons();
      syncSettingsLabels();
    });
    group.appendChild(b);
  }
  const cls = assetClasses.find((c) => c.key === chosenClass);
  if (cls) $('num-assets').max = cls.maxAssets;
}

function renderContractButtons() {
  const group = $('contract-group');
  group.innerHTML = '';
  const randomBtn = document.createElement('div');
  randomBtn.className = 'contract-card' + (chosenContractId === null ? ' active' : '');
  randomBtn.innerHTML = `<div class="cc-name">🎲 Random</div><div class="cc-desc">Contract type is revealed when the game starts.</div>`;
  randomBtn.addEventListener('click', () => { chosenContractId = null; renderContractButtons(); });
  group.appendChild(randomBtn);
  for (const c of contracts) {
    const card = document.createElement('div');
    card.className = 'contract-card' + (chosenContractId === c.id ? ' active' : '');
    card.innerHTML = `<div class="cc-name">${escapeHtml(c.name)}</div><div class="cc-desc">${escapeHtml(c.description)}</div>`;
    card.addEventListener('click', () => { chosenContractId = c.id; renderContractButtons(); });
    group.appendChild(card);
  }
}

function syncSettingsLabels() {
  const numAssets = parseInt($('num-assets').value, 10);
  const numRounds = parseInt($('num-rounds').value, 10);
  const cls = assetClasses.find((c) => c.key === chosenClass);
  $('num-assets-val').textContent = numAssets;
  $('num-assets-unit').textContent = cls ? `(${cls.unit}${numAssets === 1 ? '' : 's'})` : '';
  $('num-rounds-val').textContent = numRounds;
  $('private-per-player-val').textContent = parseInt($('private-per-player').value, 10);
  let note = '';
  if (numRounds < numAssets) note = `Only ${numRounds} of ${numAssets} assets will be revealed before settlement.`;
  else if (numRounds > numAssets) note = `${numAssets} reveals, then ${numRounds - numAssets} extra trading round(s).`;
  else note = 'One asset revealed per round.';
  $('rounds-note').textContent = note;
}

function syncRoundDurationLabel() {
  const v = parseInt($('round-duration').value, 10);
  $('round-duration-val').textContent = v === 0 ? 'manual' : `${v}s`;
  $('round-duration-note').textContent = v === 0
    ? 'Round only advances when someone clicks Next Round.'
    : `Round advances automatically after ${v} seconds. Players can still click Next Round early.`;
}

function syncPositionLimitLabel() {
  const v = parseInt($('position-limit').value, 10);
  $('position-limit-val').textContent = `±${v}`;
}

// Bots are market-making-mode only — show the slider only when MM is on.
function syncBotsVisibility() {
  const on = $('mm-mode').checked;
  $('num-bots-row').classList.toggle('hidden', !on);
  $('num-bots-val').textContent = parseInt($('num-bots').value, 10);
}

$('num-assets').addEventListener('input', syncSettingsLabels);
$('num-rounds').addEventListener('input', syncSettingsLabels);
$('private-per-player').addEventListener('input', syncSettingsLabels);
$('round-duration').addEventListener('input', syncRoundDurationLabel);
$('position-limit').addEventListener('input', syncPositionLimitLabel);
$('num-bots').addEventListener('input', syncBotsVisibility);
$('mm-mode').addEventListener('change', syncBotsVisibility);
$('start-btn').addEventListener('click', startGame);
$('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') startGame(); });

function rememberName(name) {
  if (!name) return;
  joinedName = name;
  try { localStorage.setItem('tg_name_' + roomId, name); } catch {}
}

function startGame() {
  const name = $('name-input').value.trim();
  if (!hasJoined) {
    rememberName(name);
    socket.emit('join', name);
    hasJoined = true;
    if (gameInProgress) {
      // Join mid-game: don't apply settings, just close the overlay.
      socket.once('joined', () => { $('settings-overlay').classList.add('hidden'); });
    } else {
      socket.once('joined', () => applySettings());
    }
  } else {
    if (name) { rememberName(name); socket.emit('rename', name); }
    if (!gameInProgress) applySettings();
    else $('settings-overlay').classList.add('hidden');
  }
}

function applySettings() {
  socket.emit('applySettings', {
    assetClass: chosenClass,
    contractId: chosenContractId,
    numAssets: parseInt($('num-assets').value, 10),
    numRounds: parseInt($('num-rounds').value, 10),
    privatePerPlayer: parseInt($('private-per-player').value, 10),
    marketMaking: $('mm-mode').checked,
    numBots: $('mm-mode').checked ? parseInt($('num-bots').value, 10) : 0,
    roundDuration: parseInt($('round-duration').value, 10),
    positionLimit: parseInt($('position-limit').value, 10),
  });
  $('settings-overlay').classList.add('hidden');
}

socket.on('gameStarted', () => { $('settings-overlay').classList.add('hidden'); });
socket.on('openSettings', () => {
  $('settings-overlay').classList.remove('hidden');
  $('bid-overlay').classList.add('hidden');
  $('quote-overlay').classList.add('hidden');
  $('quote-wait-overlay').classList.add('hidden');
});
socket.on('joined', ({ id, startCash: sc, isHost: ih }) => {
  myId = id;
  startCash = sc;
  amHost = !!ih;
  $('lobby-section').classList.remove('hidden');
  // Auto-rejoin after a reconnect/reload: if a game is already running, drop
  // straight back into it instead of sitting on the settings overlay.
  if (gameInProgress) $('settings-overlay').classList.add('hidden');
});

// ---------- Hints ----------
let hintCards = [];
let myPrivateAssets = [];
socket.on('hints', (cards) => {
  hintCards = cards;
  renderHints();
});
socket.on('privateAssets', (assets) => {
  myPrivateAssets = Array.isArray(assets) ? assets : [];
  renderHints();
});

function renderHints() {
  const wrap = $('hints');
  wrap.innerHTML = '';
  for (const a of myPrivateAssets) {
    const div = document.createElement('div');
    div.className = 'hint-card revealed private-card';
    div.innerHTML = `<div class="hl">Your private ${escapeHtml(a.kind ?? 'card')}</div><div class="hv">${escapeHtml(a.label ?? a.value)}</div>`;
    wrap.appendChild(div);
  }
  for (const c of hintCards) {
    const div = document.createElement('div');
    div.className = 'hint-card revealed';
    div.innerHTML = `<div class="hl">${c.label}</div><div class="hv">${c.value}</div>`;
    wrap.appendChild(div);
  }
  // Hints describe only the shared community cards. Clarify this when the player
  // also holds a private card, since "assets"/"mean" then excludes that card.
  if (hintCards.length && myPrivateAssets.length) {
    const note = document.createElement('div');
    note.className = 'hint-scope-note';
    note.textContent = 'Hints describe the shared community cards only — your private card is extra and not counted in them.';
    wrap.appendChild(note);
  }
}

// ---------- Market making bid phase ----------
socket.on('bidPhaseOpen', () => {
  $('bid-status').textContent = '';
  $('bid-waiting').classList.add('hidden');
  $('bid-players').innerHTML = '';
  $('bid-force-btn').classList.add('hidden');
  $('bid-input').value = '';
  $('bid-submit-btn').disabled = false;
  $('bid-overlay').classList.remove('hidden');
});

socket.on('bidPhaseResolved', ({ makerName, margin }) => {
  $('bid-overlay').classList.add('hidden');
  // Show waiting screen for non-makers; maker gets setMarketPrompt separately.
  $('quote-wait-sub').textContent = `${makerName} won with margin ${margin} and is setting prices…`;
  $('quote-wait-overlay').classList.remove('hidden');
});

let myWinMargin = null;

socket.on('setMarketPrompt', ({ margin }) => {
  myWinMargin = margin;
  $('quote-wait-overlay').classList.add('hidden');
  $('quote-sub').textContent = `You won with margin ${margin}. Your spread must be exactly ${margin} — set any bid price and ask will be bid + ${margin}.`;
  $('quote-bid').value = '';
  $('quote-ask').value = '';
  $('quote-error').textContent = '';
  $('quote-submit-btn').disabled = false;
  $('quote-overlay').classList.remove('hidden');
});

socket.on('marketSet', ({ makerName, bid, ask }) => {
  $('quote-wait-overlay').classList.add('hidden');
  $('quote-overlay').classList.add('hidden');
  msg(`${makerName} set market — Bid ${bid} / Ask ${ask}`);
});

$('quote-bid').addEventListener('input', () => {
  const bid = parseFloat($('quote-bid').value);
  if (isFinite(bid) && myWinMargin != null) {
    $('quote-ask').value = Math.round((bid + myWinMargin) * 100) / 100;
  }
});

$('quote-submit-btn').addEventListener('click', () => {
  const bid = parseFloat($('quote-bid').value);
  const ask = parseFloat($('quote-ask').value);
  if (!isFinite(bid)) { $('quote-error').textContent = 'Enter a valid bid price.'; return; }
  if (!isFinite(ask)) { $('quote-error').textContent = 'Enter a valid ask price.'; return; }
  const spread = Math.round((ask - bid) * 100) / 100;
  if (spread !== myWinMargin) { $('quote-error').textContent = `Spread must be exactly ${myWinMargin} (your winning bid).`; return; }
  socket.emit('setMarket', { bid, ask });
  $('quote-submit-btn').disabled = true;
  $('quote-overlay').classList.add('hidden');
});

$('bid-submit-btn').addEventListener('click', () => {
  const margin = parseFloat($('bid-input').value);
  if (!isFinite(margin) || margin <= 0) { $('bid-status').textContent = 'Enter a positive margin.'; return; }
  socket.emit('submitBid', margin);
  $('bid-submit-btn').disabled = true;
  $('bid-waiting').classList.remove('hidden');
  $('bid-status').textContent = `Bid submitted: ±${(margin / 2).toFixed(2)}`;
});

$('bid-force-btn').addEventListener('click', () => {
  socket.emit('resolveBids');
  $('bid-force-btn').classList.add('hidden');
});

function updateBidOverlay(mm, players) {
  if (!mm || mm.phase !== 'bidding') return;
  const bidderSet = new Set(mm.bidderIds);
  const connected = players.filter((p) => p.connected);
  const remaining = connected.filter((p) => !bidderSet.has(p.id));

  $('bid-players').innerHTML = connected.map((p) => {
    const done = bidderSet.has(p.id);
    return `<div class="bid-player-row ${done ? 'bid-done' : 'bid-pending'}">
      ${done ? '✓' : '…'} ${escapeHtml(p.name)}${p.id === myId ? ' (you)' : ''}
    </div>`;
  }).join('');

  // Show force-resolve button once at least one bid is in and someone hasn't bid.
  if (mm.bidderIds.length > 0 && remaining.length > 0) {
    $('bid-force-btn').classList.remove('hidden');
  }
}

// ---------- Countdown ticker ----------
let countdownEndsAt = null;
let countdownInterval = null;

function startCountdown(endsAt) {
  countdownEndsAt = endsAt;
  if (countdownInterval) clearInterval(countdownInterval);
  if (!endsAt) {
    const el = $('round-countdown');
    el.textContent = '0s';
    el.className = 'round-countdown';
    el.classList.remove('hidden');
    return;
  }
  function tick() {
    const remaining = Math.max(0, Math.ceil((countdownEndsAt - Date.now()) / 1000));
    const el = $('round-countdown');
    el.textContent = `${remaining}s`;
    el.classList.remove('hidden');
    el.className = 'round-countdown' + (remaining <= 10 ? ' countdown-urgent' : '');
    if (remaining === 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }
  tick();
  countdownInterval = setInterval(tick, 250);
}

// ---------- Controls ----------
$('next-round-btn').addEventListener('click', () => socket.emit('nextRound'));
$('restart-btn').addEventListener('click', () => {
  // Restart wipes the current game (new draw, cash/positions reset). Confirm so
  // a host trying to recover a frozen game doesn't accidentally blow it away —
  // a reload auto-resumes the existing game without resetting.
  if (gameInProgress && !confirm('Start a NEW game? This resets all cash, positions, and deals fresh cards. To just recover a frozen game, reload the page instead.')) return;
  socket.emit('restart');
});
$('claim-host-btn').addEventListener('click', () => socket.emit('claimHost'));

// ---------- Trading ----------
$('buy-btn').addEventListener('click', () => sendTrade('buy'));
$('sell-btn').addEventListener('click', () => sendTrade('sell'));

// currentMM holds the active market for this round (null if none).
let currentMM = null;
let isMMMode = false;

function sendTrade(side) {
  const qty = parseInt($('qty').value, 10);
  if (!qty || qty < 1) { msg('Enter a valid quantity.'); return; }

  if (isMMMode && currentMM?.phase === 'trading' && myId !== currentMM.makerId) {
    // MM mode: trade at fixed bid/ask.
    const price = side === 'buy' ? currentMM.ask : currentMM.bid;
    socket.emit('trade', { side, qty, price });
    msg(`${side.toUpperCase()} ${qty} @ ${price} sent.`);
    return;
  }

  if (!isMMMode) {
    // Open-outcry: post a resting bid or ask.
    const price = parseFloat($('price').value);
    if (!isFinite(price)) { msg('Enter a valid price.'); return; }
    const orderSide = side === 'buy' ? 'bid' : 'ask';
    socket.emit('postOrder', { side: orderSide, qty, price });
    msg(`${orderSide.toUpperCase()} ${qty} @ ${price} posted.`);
  }
}

function msg(t) {
  $('trade-msg').textContent = t;
  clearTimeout(msg._t);
  msg._t = setTimeout(() => { $('trade-msg').textContent = ''; }, 3500);
}

socket.on('tradeError', (text) => {
  const el = $('trade-msg');
  el.textContent = text;
  el.style.color = 'var(--red)';
  clearTimeout(msg._t);
  msg._t = setTimeout(() => { el.textContent = ''; el.style.color = ''; }, 4000);
});

// ---------- State render ----------
socket.on('state', ({ game, players, trades, lastPrice, mm, orderBook, roundEndsAt, roundTradeCount, roundTradeLimit, roundNetPos, roundNetLimit }) => {
  currentMM = mm;
  isMMMode = game.marketMaking;
  startCountdown(roundEndsAt);
  const me = players.find(p => p.id === myId);
  const amMaker = mm?.phase === 'trading' && myId === mm.makerId;
  const myRoundTrades = (me && !amMaker) ? (roundTradeCount?.[me.name] ?? 0) : null;
  if (myRoundTrades !== null) {
    const net = roundNetPos?.[me.name] ?? 0;
    const lim = roundNetLimit ?? 10;
    $('pos-limit-display').textContent =
      `${roundTradeLimit - myRoundTrades}/${roundTradeLimit} trades · net ${net > 0 ? '+' : ''}${net} (±${lim})`;
  } else {
    $('pos-limit-display').textContent = '—';
  }

  // If market is already open and we're a taker, dismiss any blocking overlays
  // (handles late joiners who missed the bid/quote events).
  if (mm?.phase === 'trading' && myId !== mm.makerId) {
    $('bid-overlay').classList.add('hidden');
    $('quote-wait-overlay').classList.add('hidden');
  }

  // Sync host status from player list.
  amHost = players.some((p) => p.id === myId && p.isHost);

  // Once game is in progress, update the button label for anyone still on the settings screen.
  gameInProgress = game.round > 0 && !game.settled;
  $('start-btn').textContent = gameInProgress ? 'Join Game' : 'Start Game';

  renderContract(game);
  renderPlayers(players);
  renderTape(trades);
  renderMMBanner(mm);
  renderLobby(players);
  updateBidOverlay(mm, players);
  $('last-price').textContent = lastPrice != null ? lastPrice : '—';
  renderYou(players);

  const settled = game.settled;
  const isMaker = mm?.phase === 'trading' && myId === mm.makerId;
  const blocked = mm?.phase === 'bidding' || mm?.phase === 'quoting';

  // Host-only controls.
  $('next-round-btn').style.display = amHost ? '' : 'none';
  $('restart-btn').style.display = amHost ? '' : 'none';
  $('claim-host-btn').style.display = amHost ? 'none' : '';

  $('buy-btn').disabled = settled || blocked;
  $('sell-btn').disabled = settled || blocked;
  // Host can always advance the round — advanceRound works in any MM phase, so
  // this stays enabled even during bidding/quoting as a recovery escape hatch.
  $('next-round-btn').disabled = settled;
  $('next-round-btn').textContent = settled ? 'Settled' : 'Next Round ▶';

  if (isMMMode) {
    $('buy-btn').textContent = 'BUY';
    $('sell-btn').textContent = 'SELL';
    $('order-book').classList.add('hidden');
    // Show price input only for market maker.
    const priceLabel = $('price').closest('label');
    if (priceLabel) priceLabel.style.display = (mm?.phase === 'trading' && !isMaker) ? 'none' : '';

    // Reconnect recovery: a player who reloaded during the bidding phase missed
    // the bidPhaseOpen event. If we're still in bidding and haven't bid yet,
    // re-show the bid overlay so we can participate (and the round can resolve).
    if (mm?.phase === 'bidding') {
      const iHaveBid = (mm.bidderIds || []).includes(myId);
      if (!iHaveBid && $('bid-overlay').classList.contains('hidden')) {
        $('bid-status').textContent = '';
        $('bid-waiting').classList.add('hidden');
        $('bid-submit-btn').disabled = false;
        $('bid-overlay').classList.remove('hidden');
      }
    }
    // Once trading is live, make sure no stale bid/quote overlay is covering it.
    if (mm?.phase === 'trading') {
      $('bid-overlay').classList.add('hidden');
      $('quote-overlay').classList.add('hidden');
      $('quote-wait-overlay').classList.add('hidden');
    }
  } else {
    $('buy-btn').textContent = 'BID';
    $('sell-btn').textContent = 'ASK';
    $('order-book').classList.remove('hidden');
    const priceLabel = $('price').closest('label');
    if (priceLabel) priceLabel.style.display = '';
    renderOrderBook(orderBook || { bids: {}, asks: {} });
  }
});

function renderLobby(players) {
  const overlay = $('settings-overlay');
  if (overlay.classList.contains('hidden')) return;
  const list = $('lobby-list');
  const count = $('lobby-count');
  list.innerHTML = '';
  const connected = players.filter((p) => p.connected);
  count.textContent = `(${connected.length})`;
  for (const p of connected) {
    const div = document.createElement('div');
    div.className = 'lobby-player' + (p.id === myId ? ' you' : '');
    div.textContent = p.name + (p.id === myId ? ' (you)' : '');
    list.appendChild(div);
  }
}

function renderMMBanner(mm) {
  const banner = $('mm-banner');
  if (!mm || mm.phase === 'bidding' || mm.phase === 'quoting') {
    banner.classList.add('hidden');
    return;
  }
  if (mm.phase === 'trading') {
    const isMaker = myId === mm.makerId;
    if (isMaker) {
      banner.className = 'mm-banner mm-maker';
      banner.innerHTML = `<b>You are the Market Maker</b> — quoting Bid <b>${mm.bid}</b> / Ask <b>${mm.ask}</b>. You take the other side of every trade.`;
    } else {
      banner.className = 'mm-banner mm-taker';
      banner.innerHTML = `Market: <b class="bid-price">Bid ${mm.bid}</b> &nbsp;/&nbsp; <b class="ask-price">Ask ${mm.ask}</b> &nbsp;·&nbsp; maker: ${escapeHtml(mm.makerName)}`;
    }
    banner.classList.remove('hidden');
  }
}

function renderContract(game) {
  $('contract-name').textContent = game.contract.name;
  $('contract-desc').textContent = game.contract.description;
  $('round-label').textContent =
    `Round ${game.round} of ${game.numRounds}` +
    ` · ${game.revealedCount}/${game.totalAssets} ${game.contract.assetLabel.toLowerCase()} revealed` +
    (game.settled ? ' — Market Closed' : '');
  const pct = game.numRounds ? (game.round / game.numRounds) * 100 : 0;
  $('progress-bar').style.width = pct + '%';

  const wrap = $('assets');
  wrap.innerHTML = '';
  for (const a of game.revealedAssets) {
    const div = document.createElement('div');
    if (a.kind === 'die') div.className = 'asset die';
    else if (a.kind === 'number') div.className = 'asset number';
    else div.className = 'asset' + (a.red ? ' red' : '');
    div.innerHTML = `<div class="av">${a.label}</div><div class="as">value ${a.value}</div>`;
    wrap.appendChild(div);
  }
  if (game.revealedCount === 0) {
    wrap.innerHTML = '<div class="muted" style="align-self:center;">No assets revealed yet — click "Next Round".</div>';
  }

  const box = $('settlement-box');
  const revealBox = $('private-reveal');
  if (game.settled) {
    box.classList.remove('hidden');
    $('settlement-value').textContent = game.settlement;
    if (game.privateReveal && game.privateReveal.length) {
      revealBox.classList.remove('hidden');
      const rows = game.privateReveal
        .map((r) => `<div class="pr-row"><span class="pr-name">${escapeHtml(r.name)}</span><span class="pr-cards">${r.assets.map((a) => escapeHtml(a.label ?? a.value)).join(', ')}</span></div>`)
        .join('');
      revealBox.innerHTML = `<div class="pr-label">Private cards (counted toward settlement)</div>${rows}`;
    } else {
      revealBox.classList.add('hidden');
    }
  } else {
    box.classList.add('hidden');
    revealBox.classList.add('hidden');
  }
}

function renderPlayers(players) {
  const body = $('players-body');
  body.innerHTML = '';
  players.sort((a, b) => b.pnl - a.pnl);
  for (const p of players) {
    const tr = document.createElement('tr');
    if (p.id === myId) tr.className = 'you';
    const posCls = p.position > 0 ? 'pos-pos' : p.position < 0 ? 'pos-neg' : '';
    const pnlCls = p.pnl > 0 ? 'pos-pos' : p.pnl < 0 ? 'pos-neg' : '';
    const mmTag = p.isMarketMaker ? ' <span class="mm-tag">MM</span>' : '';
    const hostTag = p.isHost ? ' <span class="host-tag">HOST</span>' : '';
    const botTag = p.isBot ? ' <span class="bot-tag">BOT</span>' : '';
    tr.innerHTML = `
      <td>${escapeHtml(p.name)}${botTag}${mmTag}${hostTag}${p.connected ? '' : ' 💤'}</td>
      <td>${p.cash}</td>
      <td class="${posCls}">${p.position}</td>
      <td class="${pnlCls}">${p.pnl >= 0 ? '+' : ''}${p.pnl}</td>
    `;
    body.appendChild(tr);
  }
}

function renderYou(players) {
  const me = players.find((p) => p.id === myId);
  if (!me) return;
  $('your-cash').textContent = me.cash;
  $('your-pos').textContent = me.position;
  const pnlEl = $('your-pnl');
  pnlEl.textContent = (me.pnl >= 0 ? '+' : '') + me.pnl;
  pnlEl.style.color = me.pnl > 0 ? 'var(--green)' : me.pnl < 0 ? 'var(--red)' : 'var(--text)';
}

function renderTape(trades) {
  const tape = $('tape');
  tape.innerHTML = '';
  for (const t of [...trades].reverse()) {
    const row = document.createElement('div');
    row.className = 'tape-row';
    if (t.mmRound) {
      // MM trade: one taker, recorded with side. `forced` = auto-trade for an idle taker.
      const forcedTag = t.forced ? ' <span class="forced-tag">AUTO</span>' : '';
      row.innerHTML = `
        <span class="${t.side}">${t.side.toUpperCase()} ${t.qty} @ ${t.price} <span class="mm-tag">MM</span>${forcedTag}</span>
        <span class="tt">${escapeHtml(t.trader)} · R${t.round}</span>
      `;
    } else {
      // Open-outcry trade: bilateral, show buyer vs seller.
      row.innerHTML = `
        <span class="buy">${t.qty} @ ${t.price}</span>
        <span class="tt">${escapeHtml(t.buyer)} / ${escapeHtml(t.seller)} · R${t.round}</span>
      `;
    }
    tape.appendChild(row);
  }
  if (!trades.length) tape.innerHTML = '<div class="muted">No trades yet.</div>';
}

function renderOrderBook(orderBook) {
  const { bids, asks } = orderBook;

  // bids/asks are arrays sorted by price.
  const sortedBids = [...bids].sort((a, b) => b.price - a.price);
  const sortedAsks = [...asks].sort((a, b) => a.price - b.price);

  function renderSide(containerId, orders, side) {
    const el = $(containerId);
    el.innerHTML = '';
    if (!orders.length) { el.innerHTML = '<div class="ob-empty">—</div>'; return; }
    for (const order of orders) {
      const isMe = order.socketId === myId;
      const row = document.createElement('div');
      row.className = 'ob-row' + (isMe ? ' ob-mine' : '');
      const action = isMe
        ? `<button class="ob-cancel-btn" data-order-id="${order.id}">Cancel</button>`
        : side === 'bid'
          ? `<button class="ob-take-btn ob-sell-btn" data-side="bid" data-order-id="${order.id}">SELL</button>`
          : `<button class="ob-take-btn ob-buy-btn" data-side="ask" data-order-id="${order.id}">BUY</button>`;
      row.innerHTML = `
        <span class="ob-name">${escapeHtml(order.name)}</span>
        <span class="ob-qty">${order.qty}</span>
        <span class="ob-price">@ ${order.price}</span>
        ${action}
      `;
      el.appendChild(row);
    }
  }

  renderSide('ob-bids', sortedBids, 'bid');
  renderSide('ob-asks', sortedAsks, 'ask');

  // Render your resting orders status.
  const myBids = bids.filter(o => o.socketId === myId);
  const myAsks = asks.filter(o => o.socketId === myId);
  const parts = [
    ...myBids.map(o => `Bid ${o.qty} @ ${o.price}`),
    ...myAsks.map(o => `Ask ${o.qty} @ ${o.price}`),
  ];
  $('your-orders').textContent = parts.length ? `Your orders: ${parts.join(' · ')}` : '';
}

// Delegated click handler for order book buttons.
$('order-book').addEventListener('click', (e) => {
  const takeBtn = e.target.closest('.ob-take-btn');
  const cancelBtn = e.target.closest('.ob-cancel-btn');
  if (takeBtn) {
    socket.emit('takeOrder', { side: takeBtn.dataset.side, orderId: takeBtn.dataset.orderId });
  } else if (cancelBtn) {
    socket.emit('cancelOrder', { orderId: cancelBtn.dataset.orderId });
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

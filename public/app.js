const SOCKET_URL = window.__SOCKET_URL__ || undefined;
const socket = SOCKET_URL ? io(SOCKET_URL) : io();

let myId = null;
let startCash = 1000;
const revealed = {};

const $ = (id) => document.getElementById(id);

// ---------- Room ----------
const roomId = location.hash.slice(1) || 'main';

socket.on('connect', () => {
  socket.emit('joinRoom', roomId);
  $('start-btn').textContent = 'Start Game';
  $('start-btn').disabled = false;
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
let hasJoined = false;

socket.on('config', ({ assetClasses: classes, contracts: ctrs, current }) => {
  assetClasses = classes;
  contracts = ctrs;
  chosenClass = current.assetClass;
  chosenContractId = current.contractId;
  $('mm-mode').checked = !!current.marketMaking;
  renderAssetClassButtons();
  renderContractButtons();
  $('num-assets').value = current.numAssets;
  $('num-rounds').value = current.numRounds;
  syncSettingsLabels();
});

function renderAssetClassButtons() {
  const group = $('asset-class-group');
  group.innerHTML = '';
  for (const c of assetClasses) {
    const b = document.createElement('button');
    b.className = 'seg-btn' + (c.key === chosenClass ? ' active' : '');
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
  let note = '';
  if (numRounds < numAssets) note = `Only ${numRounds} of ${numAssets} assets will be revealed before settlement.`;
  else if (numRounds > numAssets) note = `${numAssets} reveals, then ${numRounds - numAssets} extra trading round(s).`;
  else note = 'One asset revealed per round.';
  $('rounds-note').textContent = note;
}

$('num-assets').addEventListener('input', syncSettingsLabels);
$('num-rounds').addEventListener('input', syncSettingsLabels);
$('start-btn').addEventListener('click', startGame);
$('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') startGame(); });

function startGame() {
  const name = $('name-input').value.trim();
  if (!hasJoined) {
    socket.emit('join', name);
    hasJoined = true;
    // Wait for server to confirm join before applying settings.
    socket.once('joined', () => applySettings());
  } else {
    if (name) socket.emit('rename', name);
    applySettings();
  }
}

function applySettings() {
  socket.emit('applySettings', {
    assetClass: chosenClass,
    contractId: chosenContractId,
    numAssets: parseInt($('num-assets').value, 10),
    numRounds: parseInt($('num-rounds').value, 10),
    marketMaking: $('mm-mode').checked,
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
socket.on('joined', ({ id, startCash: sc }) => {
  myId = id;
  startCash = sc;
  $('lobby-section').classList.remove('hidden');
});

// ---------- Hints ----------
let hintCards = [];
socket.on('hints', (cards) => {
  hintCards = cards;
  for (const c of cards) revealed[c.key] = false;
  renderHints();
});

function renderHints() {
  const wrap = $('hints');
  wrap.innerHTML = '';
  if (!hintCards.length) { wrap.innerHTML = '<div class="muted">No hints available.</div>'; return; }
  for (const c of hintCards) {
    const isShown = revealed[c.key];
    const div = document.createElement('div');
    div.className = 'hint-card ' + (isShown ? 'revealed' : 'hidden-state');
    div.innerHTML = `<div class="hl">${c.label}</div><div class="hv">${isShown ? c.value : '•••'}</div>`;
    div.title = isShown ? 'Click to hide' : 'Click to reveal';
    div.addEventListener('click', () => { revealed[c.key] = !revealed[c.key]; renderHints(); });
    wrap.appendChild(div);
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

socket.on('setMarketPrompt', ({ margin }) => {
  $('quote-wait-overlay').classList.add('hidden');
  $('quote-sub').textContent = `You won with margin ${margin}. Set your bid and ask prices — other players trade at these.`;
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

$('quote-submit-btn').addEventListener('click', () => {
  const bid = parseFloat($('quote-bid').value);
  const ask = parseFloat($('quote-ask').value);
  if (!isFinite(bid) || bid < 0) { $('quote-error').textContent = 'Enter a valid bid price.'; return; }
  if (!isFinite(ask) || ask < 0) { $('quote-error').textContent = 'Enter a valid ask price.'; return; }
  if (ask <= bid) { $('quote-error').textContent = 'Ask must be higher than bid.'; return; }
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

// ---------- Controls ----------
$('next-round-btn').addEventListener('click', () => socket.emit('nextRound'));
$('restart-btn').addEventListener('click', () => socket.emit('restart'));

// ---------- Trading ----------
$('buy-btn').addEventListener('click', () => sendTrade('buy'));
$('sell-btn').addEventListener('click', () => sendTrade('sell'));

// currentMM holds the active market for this round (null if none).
let currentMM = null;

function sendTrade(side) {
  const qty = parseInt($('qty').value, 10);
  let price = parseFloat($('price').value);

  // In MM trading phase, non-makers trade at the fixed bid/ask — price is ignored.
  if (currentMM && currentMM.phase === 'trading' && myId !== currentMM.makerId) {
    price = side === 'buy' ? currentMM.ask : currentMM.bid;
  }

  if (!isFinite(price) || price < 0) { msg('Enter a valid price.'); return; }
  if (!qty || qty < 1) { msg('Enter a valid quantity.'); return; }
  socket.emit('trade', { side, qty, price });
  msg(`${side.toUpperCase()} ${qty} @ ${price} sent.`);
}

function msg(t) {
  $('trade-msg').textContent = t;
  clearTimeout(msg._t);
  msg._t = setTimeout(() => { $('trade-msg').textContent = ''; }, 3500);
}

// ---------- State render ----------
socket.on('state', ({ game, players, trades, lastPrice, mm }) => {
  currentMM = mm;
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

  $('buy-btn').disabled = settled || blocked;
  $('sell-btn').disabled = settled || blocked;
  $('next-round-btn').disabled = settled || blocked;
  $('next-round-btn').textContent = settled ? 'Settled' : 'Next Round ▶';

  // Show price input only for market maker or non-MM mode.
  const priceLabel = $('price').closest('label');
  if (priceLabel) priceLabel.style.display = (mm?.phase === 'trading' && !isMaker) ? 'none' : '';
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
  if (game.settled) {
    box.classList.remove('hidden');
    $('settlement-value').textContent = game.settlement;
  } else {
    box.classList.add('hidden');
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
    tr.innerHTML = `
      <td>${escapeHtml(p.name)}${mmTag}${p.connected ? '' : ' 💤'}</td>
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
    row.innerHTML = `
      <span class="${t.side}">${t.side.toUpperCase()} ${t.qty} @ ${t.price}${t.mmRound ? ' <span class="mm-tag">MM</span>' : ''}</span>
      <span class="tt">${escapeHtml(t.trader)} · R${t.round}</span>
    `;
    tape.appendChild(row);
  }
  if (!trades.length) tape.innerHTML = '<div class="muted">No trades yet.</div>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

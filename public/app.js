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
  $('abstract-mode').checked = !!current.abstractMode;
  $('solo-mode').checked = !!current.soloMM;
  $('signal-mode').checked = !!current.signalMode;
  if (current.signalRounds != null) $('signal-rounds').value = current.signalRounds;
  if (current.signalBots != null) $('signal-bots').value = current.signalBots;
  $('round-duration').value = current.roundDuration ?? 60;
  $('position-limit').value = current.positionLimit ?? 10;
  $('num-bots').value = current.numBots ?? 0;
  $('bot-sims').value = current.botSims ?? 500;
  renderAssetClassButtons();
  renderContractButtons();
  $('num-assets').value = current.numAssets;
  $('num-rounds').value = current.numRounds;
  $('private-per-player').value = current.privatePerPlayer ?? 0;
  $('trial-prob').value = Math.round((current.trialProb ?? 0.6) * 100);
  $('series-mode').checked = !!current.seriesMode;
  $('success-target').value = current.successTarget ?? 4;
  $('poisson-rate').value = Math.round((current.poissonRate ?? 3) * 10);
  $('tick-size').value = String(current.tickSize ?? 0.01);
  syncSettingsLabels();
  syncBotsVisibility();
  syncRoundDurationLabel();
  syncPositionLimitLabel();
  syncTrialsVisibility();
  syncSoloVisibility();
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
      syncTrialsVisibility();
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

// Bots play both trading modes — the slider is always shown.
function syncBotsVisibility() {
  const n = parseInt($('num-bots').value, 10);
  $('num-bots-val').textContent = n;
  // The bot-quality slider only matters when there are bots.
  $('bot-sims-row').classList.toggle('hidden', n === 0);
  syncBotSimsLabel();
}

function syncBotSimsLabel() {
  const sims = parseInt($('bot-sims').value, 10);
  $('bot-sims-val').textContent = `${sims} sims`;
  // A rough human-readable quality tier so the number means something.
  let tier;
  if (sims <= 25) tier = '(very weak)';
  else if (sims <= 75) tier = '(weak)';
  else if (sims <= 250) tier = '(fair)';
  else if (sims <= 800) tier = '(sharp)';
  else tier = '(very sharp)';
  $('bot-sims-tier').textContent = tier;
}

// The Trials and Poisson classes have their own settings and pin their own
// contract, so show their controls and hide the contract picker / private cards /
// number-of-rounds (which don't apply) when either is selected.
function syncTrialsVisibility() {
  const isTrials = chosenClass === 'trials';
  const isPoisson = chosenClass === 'poisson';
  const special = isTrials || isPoisson;
  $('trials-settings').classList.toggle('hidden', !isTrials);
  $('poisson-settings').classList.toggle('hidden', !isPoisson);
  $('contract-row').classList.toggle('hidden', special);
  $('private-row').classList.toggle('hidden', special);
  $('num-rounds-row').classList.toggle('hidden', special);
  if (isTrials) syncTrialsLabels();
  if (isPoisson) syncPoissonLabels();
}

// Single-player (solo MM): the market width is dealt per round and the bot's
// minimum size is chosen in the quote overlay, so there are no pre-game controls
// left here. Solo still forces market-making with exactly one bot, so reflect
// that in the UI (check & disable the MM toggle, pin the bot slider) to match
// what the server will enforce.
function syncSoloVisibility() {
  const solo = $('solo-mode').checked;
  if (solo) {
    $('mm-mode').checked = true;
    $('mm-mode').disabled = true;
    $('num-bots').value = 1;
    $('num-bots').disabled = true;
  } else {
    $('mm-mode').disabled = false;
    $('num-bots').disabled = false;
  }
  syncBotsVisibility();
}


// Signal Reading mode replaces the asset class, the contract and the whole
// trading model, so when it's on we hide every setting it ignores rather than
// leave dead controls on screen. It's also single-player by construction (the
// bots aren't counterparties), so the market-mode toggles are disabled.
function syncSignalVisibility() {
  const on = $('signal-mode').checked;
  $('signal-settings').classList.toggle('hidden', !on);
  for (const id of ['mm-mode', 'solo-mode', 'abstract-mode']) {
    const el = $(id);
    el.disabled = on;
    if (on) el.checked = false;
  }
  // Settings signal mode doesn't read. When switching back off, syncTrialsVisibility
  // re-derives which of these the chosen asset class wants shown, so we only force
  // them hidden here and let it undo that.
  for (const id of ['contract-row', 'private-row', 'num-rounds-row', 'num-bots-row',
                    'trials-settings', 'poisson-settings']) {
    if (on) $(id)?.classList.add('hidden');
  }
  $('asset-class-group').classList.toggle('hidden', on);
  if (on) syncSignalLabels();
  else { syncTrialsVisibility(); syncSoloVisibility(); }
}

function syncSignalLabels() {
  $('signal-rounds-val').textContent = $('signal-rounds').value;
  $('signal-bots-val').textContent = $('signal-bots').value;
}

function syncTrialsLabels() {
  const p = parseInt($('trial-prob').value, 10);
  $('trial-prob-val').textContent = `${p}%`;
  const series = $('series-mode').checked;
  // Target only matters in series mode; grey it out otherwise.
  $('success-target-row').classList.toggle('hidden', !series);
  // Target can't exceed the number of trials.
  const trials = parseInt($('num-assets').value, 10);
  const tSlider = $('success-target');
  tSlider.max = trials;
  if (parseInt(tSlider.value, 10) > trials) tSlider.value = trials;
  $('success-target-val').textContent = parseInt(tSlider.value, 10);
}

// The λ slider carries integer steps = λ×10, so 0.1-granularity from 0.1 to 20.0.
function syncPoissonLabels() {
  const lambda = parseInt($('poisson-rate').value, 10) / 10;
  $('poisson-rate-val').textContent = lambda.toFixed(1);
}

$('num-assets').addEventListener('input', () => { syncSettingsLabels(); syncTrialsLabels(); });
$('num-rounds').addEventListener('input', syncSettingsLabels);
$('private-per-player').addEventListener('input', syncSettingsLabels);
$('round-duration').addEventListener('input', syncRoundDurationLabel);
$('position-limit').addEventListener('input', syncPositionLimitLabel);
$('num-bots').addEventListener('input', syncBotsVisibility);
$('bot-sims').addEventListener('input', syncBotSimsLabel);
$('mm-mode').addEventListener('change', syncBotsVisibility);
$('solo-mode').addEventListener('change', syncSoloVisibility);
$('signal-mode').addEventListener('change', syncSignalVisibility);
$('signal-rounds').addEventListener('input', syncSignalLabels);
$('signal-bots').addEventListener('input', syncSignalLabels);
$('trial-prob').addEventListener('input', syncTrialsLabels);
$('series-mode').addEventListener('change', syncTrialsLabels);
$('success-target').addEventListener('input', syncTrialsLabels);
$('poisson-rate').addEventListener('input', syncPoissonLabels);
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
    abstractMode: $('abstract-mode').checked,
    soloMM: $('solo-mode').checked,
    signalMode: $('signal-mode').checked,
    signalRounds: parseInt($('signal-rounds').value, 10),
    signalBots: parseInt($('signal-bots').value, 10),
    numBots: parseInt($('num-bots').value, 10),
    botSims: parseInt($('bot-sims').value, 10),
    roundDuration: parseInt($('round-duration').value, 10),
    positionLimit: parseInt($('position-limit').value, 10),
    trialProb: parseInt($('trial-prob').value, 10) / 100,
    seriesMode: $('series-mode').checked,
    successTarget: parseInt($('success-target').value, 10),
    poissonRate: parseInt($('poisson-rate').value, 10) / 10,
    tickSize: parseFloat($('tick-size').value),
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
  // Section label so it's clear this row is the player's private clues, not public info.
  if (hintCards.length || myPrivateAssets.length) {
    const heading = document.createElement('div');
    heading.className = 'hints-heading';
    heading.textContent = 'Your private info';
    wrap.appendChild(heading);
  }
  for (const a of myPrivateAssets) {
    const div = document.createElement('div');
    div.className = 'hint-card revealed private-card';
    div.innerHTML = `<div class="hl">Your private ${escapeHtml(a.kind ?? 'card')}</div><div class="hv">${escapeHtml(a.label ?? a.value)}</div>`;
    wrap.appendChild(div);
  }
  for (const c of hintCards) {
    const div = document.createElement('div');
    div.className = 'hint-card revealed';
    // Explicitly tag each as a HINT so players know it's a private clue only they
    // hold — not a public fact — and that other players may hold different ones.
    div.innerHTML = `<div class="hint-tag">🔒 Your hint</div><div class="hl">${c.label}</div><div class="hv">${c.value}</div>`;
    wrap.appendChild(div);
  }
  // Clarify what a hint is: private, per-player, and only about the community cards.
  if (hintCards.length) {
    const note = document.createElement('div');
    note.className = 'hint-scope-note';
    note.textContent = myPrivateAssets.length
      ? 'A hint is a private clue only you can see — other players get different hints. Hints describe the shared community cards only; your private card is extra and not counted in them.'
      : 'A hint is a private clue only you can see — other players may hold different hints about the shared community cards.';
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

socket.on('setMarketPrompt', ({ margin, soloMM }) => {
  myWinMargin = margin;
  $('quote-wait-overlay').classList.add('hidden');
  // Solo mode: the width is dealt at random each round rather than won in a bid,
  // and the maker also picks the bot's minimum size here. The min-size slider
  // resets to 1 every round so it's always a deliberate choice.
  $('quote-sub').textContent = soloMM
    ? `This round's market width is ${margin} — set any bid price and ask will be bid + ${margin}. Choose how much the bot must trade against you below.`
    : `You won with margin ${margin}. Your spread must be exactly ${margin} — set any bid price and ask will be bid + ${margin}.`;
  $('quote-minsize-row').classList.toggle('hidden', !soloMM);
  if (soloMM) {
    $('quote-min-size').value = 1;
    syncQuoteMinSizeLabel();
  }
  $('quote-bid').value = '';
  $('quote-ask').value = '';
  $('quote-error').textContent = '';
  $('quote-submit-btn').disabled = false;
  $('quote-overlay').classList.remove('hidden');
});

function syncQuoteMinSizeLabel() {
  $('quote-min-size-val').textContent = parseInt($('quote-min-size').value, 10);
}
$('quote-min-size').addEventListener('input', syncQuoteMinSizeLabel);

socket.on('marketSet', ({ makerName, bid, ask }) => {
  $('quote-wait-overlay').classList.add('hidden');
  $('quote-overlay').classList.add('hidden');
  msg(`${makerName} set market — Bid ${bid} / Ask ${ask}`);
});

$('quote-bid').addEventListener('input', () => {
  const bid = parseFloat($('quote-bid').value);
  if (isFinite(bid) && myWinMargin != null) {
    // Preview the ask as (tick-snapped bid) + margin, matching how the server
    // derives it — so the maker sees exactly what will be set.
    const snapped = Math.round(bid / currentTick) * currentTick;
    $('quote-ask').value = Math.round((snapped + myWinMargin) * 100) / 100;
  }
});

$('quote-submit-btn').addEventListener('click', () => {
  const bid = parseFloat($('quote-bid').value);
  const ask = parseFloat($('quote-ask').value);
  if (!isFinite(bid)) { $('quote-error').textContent = 'Enter a valid bid price.'; return; }
  if (!isFinite(ask)) { $('quote-error').textContent = 'Enter a valid ask price.'; return; }
  const spread = Math.round((ask - bid) * 100) / 100;
  if (spread !== myWinMargin) { $('quote-error').textContent = `Spread must be exactly ${myWinMargin}.`; return; }
  socket.emit('setMarket', {
    bid, ask,
    botMinSize: parseInt($('quote-min-size').value, 10),
  });
  $('quote-submit-btn').disabled = true;
  $('quote-overlay').classList.add('hidden');
});

$('bid-submit-btn').addEventListener('click', () => {
  const margin = parseFloat($('bid-input').value);
  if (!isFinite(margin) || margin < 0.01) { $('bid-status').textContent = 'Enter a margin of at least 0.01.'; return; }
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

// Signal mode: six fixed buttons (buy/sell × 1/2/3). No price field — the fill is
// always the revealed card's value — so the only decision is side and size.
document.querySelectorAll('.sig-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    socket.emit('trade', { side: btn.dataset.side, qty: parseInt(btn.dataset.qty, 10) });
  });
});

// currentMM holds the active market for this round (null if none).
let currentMM = null;
let isMMMode = false;
let currentTick = 0.01;

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
  currentTick = game.tickSize ?? 0.01;
  // Reflect the configured tick as the input step so keyboard/spinner nudges land
  // on the grid (the server snaps regardless, but this makes the UI honest).
  const tickStr = String(currentTick);
  $('price').step = tickStr;
  $('quote-bid').step = tickStr;
  $('quote-ask').step = tickStr;
  startCountdown(roundEndsAt);
  const me = players.find(p => p.id === myId);
  const amMaker = mm?.phase === 'trading' && myId === mm.makerId;
  // Limit readout differs by mode:
  //  • MM mode: per-round trade count + net-position limit (maker exempt).
  //  • Open-outcry: per-round NET position limit (positionLimit), reset each round.
  if (isMMMode) {
    const myRoundTrades = (me && !amMaker) ? (roundTradeCount?.[me.name] ?? 0) : null;
    if (myRoundTrades !== null) {
      const net = roundNetPos?.[me.name] ?? 0;
      const lim = roundNetLimit ?? 10;
      $('pos-limit-display').textContent =
        `${roundTradeLimit - myRoundTrades}/${roundTradeLimit} trades · net ${net > 0 ? '+' : ''}${net} (±${lim})`;
    } else {
      $('pos-limit-display').textContent = '—';
    }
  } else if (me) {
    const net = roundNetPos?.[me.name] ?? 0;
    const lim = game.positionLimit ?? 10;
    $('pos-limit-display').textContent = `round net ${net > 0 ? '+' : ''}${net} (±${lim})`;
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

  applySignalLayout(game);
  renderContract(game);
  if (game.signalMode) renderSignal(game, players);
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

  if (game.signalMode) {
    // Signal mode uses its own trade panel (applySignalLayout hides the ticket and
    // the book), so none of the market-mode button/overlay wiring below applies.
  } else if (isMMMode) {
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
  renderDist(game);
  $('round-label').textContent =
    `Round ${game.round} of ${game.numRounds}` +
    ` · ${game.revealedCount}/${game.totalAssets} ${game.contract.assetLabel.toLowerCase()} revealed` +
    (game.settled ? ' — Market Closed' : '');
  const pct = game.numRounds ? (game.round / game.numRounds) * 100 : 0;
  $('progress-bar').style.width = pct + '%';

  const wrap = $('assets');
  wrap.innerHTML = '';
  let succ = 0;
  let poissonTotal = 0;
  for (const a of game.revealedAssets) {
    const div = document.createElement('div');
    if (a.kind === 'trial') {
      if (a.value === 1) succ++;
      div.className = 'asset trial' + (a.value === 1 ? ' success' : ' fail');
      div.innerHTML = `<div class="av">${a.value === 1 ? '✔' : '✕'}</div><div class="as">${a.value === 1 ? 'success' : 'fail'}</div>`;
    } else if (a.kind === 'poisson') {
      poissonTotal += a.value;
      div.className = 'asset poisson';
      // Each interval shows its own event count, plus the running process total.
      div.innerHTML = `<div class="av">${a.value}</div><div class="as">Σ ${poissonTotal}</div>`;
    } else {
      if (a.kind === 'die') div.className = 'asset die';
      else if (a.kind === 'number') div.className = 'asset number';
      else if (a.kind === 'abstract') div.className = 'asset abstract';
      else div.className = 'asset' + (a.red ? ' red' : '');
      div.innerHTML = `<div class="av">${a.label}</div><div class="as">value ${a.value}</div>`;
    }
    wrap.appendChild(div);
  }
  if (game.revealedCount === 0) {
    const msg = game.contract.assetClass === 'poisson'
      ? 'No intervals yet — the first event count is coming.'
      : game.contract.assetClass === 'trials'
        ? 'No trials yet — the first result is coming.'
        : 'No assets revealed yet — click "Next Round".';
    wrap.innerHTML = `<div class="muted" style="align-self:center;">${msg}</div>`;
  } else if (game.contract.assetClass === 'trials') {
    // Running tally under the trial row — successes vs fails so far.
    const fails = game.revealedCount - succ;
    const tally = document.createElement('div');
    tally.className = 'trial-tally';
    tally.innerHTML = `<span class="t-succ">${succ} success</span> · <span class="t-fail">${fails} fail</span> of ${game.totalAssets} trials`;
    wrap.appendChild(tally);
  } else if (game.contract.assetClass === 'poisson') {
    // Running total under the interval row — the process value so far.
    const tally = document.createElement('div');
    tally.className = 'trial-tally';
    tally.innerHTML = `Process value: <span class="t-succ">${poissonTotal}</span> events over ${game.revealedCount}/${game.totalAssets} intervals`;
    wrap.appendChild(tally);
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
    renderBotHintReveal(game.botHintReveal);
    renderPnlRecap(game.pnlRecap);
  } else {
    box.classList.add('hidden');
    revealBox.classList.add('hidden');
    $('bot-hint-reveal').classList.add('hidden');
    $('pnl-recap').classList.add('hidden');
  }
}

// ---------- Signal Reading mode ----------

// Toggle the whole UI between market mode and signal mode. Signal mode has no
// order book, no market-maker banner and no price input, so those are hidden
// rather than left inert.
function applySignalLayout(game) {
  const on = !!game.signalMode;
  document.body.classList.toggle('signal-mode-active', on);
  $('signal-trade').classList.toggle('hidden', !on);
  $('signal-bots-panel').classList.toggle('hidden', !on);
  // Market-mode furniture that has no meaning here.
  $('ticket-heading').classList.toggle('hidden', on);
  document.querySelector('.ticket').classList.toggle('hidden', on);
  $('your-orders').classList.toggle('hidden', on);
  if (on) {
    $('order-book').classList.add('hidden');
    $('mm-banner').classList.add('hidden');
  }
}

function renderSignal(game, players) {
  const sig = game.signal;
  if (!sig) return;

  // The tradeable card for this round.
  const cardEl = $('signal-card');
  if (sig.currentCard) {
    cardEl.className = 'signal-card' + (sig.currentCard.red ? ' red' : '');
    cardEl.innerHTML =
      `<span class="sc-label">${escapeHtml(sig.currentCard.label)}</span>` +
      `<span class="sc-value">trades at ${sig.currentValue}</span>`;
  } else {
    cardEl.className = 'signal-card';
    cardEl.textContent = '—';
  }

  // One trade per round: lock the buttons once taken, or when the game is over.
  const locked = sig.closed || sig.traded;
  document.querySelectorAll('.sig-btn').forEach((b) => { b.disabled = locked; });
  const tradedEl = $('signal-traded');
  const cur = sig.revealed.length ? sig.revealed[sig.revealed.length - 1] : null;
  if (sig.closed) {
    tradedEl.textContent = 'Game over — see the reveal on the left.';
    tradedEl.className = 'signal-traded';
  } else if (cur && cur.playerSide) {
    tradedEl.innerHTML = `You <b class="${cur.playerSide === 'buy' ? 'sig-t-buy' : 'sig-t-sell'}">` +
      `${cur.playerSide.toUpperCase()} ${cur.playerQty}</b> at ${cur.value}. Waiting for the next round…`;
    tradedEl.className = 'signal-traded done';
  } else {
    tradedEl.textContent = 'Pick a side and a size — or sit this one out.';
    tradedEl.className = 'signal-traded';
  }

  // The player's own running sample statistics. This is the honest estimate of
  // fair value from public information alone, so showing it removes pointless
  // arithmetic without giving anything away — the inference that matters is what
  // the BOTS know, not what the mean of the reveals is.
  const vals = sig.revealed.map((r) => r.value);
  const statsEl = $('signal-stats');
  if (vals.length) {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = vals.length > 1
      ? Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length - 1))
      : null;
    // Standard error of the mean: how much the player's own estimate can still move.
    const se = sd != null ? sd / Math.sqrt(vals.length) : null;
    const me = players.find((p) => p.id === myId);
    statsEl.innerHTML =
      `<div class="sig-stat"><span>Your sample mean</span><b>${mean.toFixed(2)}</b></div>` +
      `<div class="sig-stat"><span>Cards seen</span><b>${vals.length}</b></div>` +
      (se != null ? `<div class="sig-stat"><span>± std error</span><b>${se.toFixed(2)}</b></div>` : '') +
      `<div class="sig-stat"><span>Your position</span><b>${me ? (me.position > 0 ? '+' : '') + me.position : '—'}</b></div>`;
  } else {
    statsEl.innerHTML = '';
  }

  renderSignalBotTape(sig);
  renderSignalDebrief(sig);
}

// The bot tape: one row per round, newest first, showing what each bot did. This
// is the entire information channel, so it has to be readable at a glance —
// direction by colour, size by the number, and the bot's running position after
// the trade (which is what gives an inventory-shy bot away).
function renderSignalBotTape(sig) {
  const wrap = $('signal-bot-tape');
  if (!sig.botNames.length) {
    wrap.innerHTML = '<div class="muted">No bots in this game.</div>';
    return;
  }
  const head = `<div class="sbt-row sbt-head"><span class="sbt-r">#</span>` +
    `<span class="sbt-c">card</span>` +
    sig.botNames.map((n) => `<span class="sbt-b">${escapeHtml(n)}</span>`).join('') +
    `</div>`;
  const rows = sig.revealed.slice().reverse().map((r, idx) => {
    const roundNo = sig.revealed.length - idx;
    const cells = sig.botNames.map((n) => {
      const a = r.botActions.find((x) => x.name === n);
      if (!a || !a.qty) return `<span class="sbt-b sbt-pass">·</span>`;
      const cls = a.side === 'buy' ? 'sbt-buy' : 'sbt-sell';
      const arrow = a.side === 'buy' ? '▲' : '▼';
      // `pos` is the bot's position AFTER this trade — the inventory trail.
      return `<span class="sbt-b ${cls}">${arrow}${a.qty}` +
        `<i class="sbt-pos">${a.position > 0 ? '+' : ''}${a.position}</i></span>`;
    }).join('');
    const mine = r.playerSide
      ? `<i class="sbt-mine ${r.playerSide === 'buy' ? 'sbt-buy' : 'sbt-sell'}">you ${r.playerSide === 'buy' ? '▲' : '▼'}${r.playerQty}</i>`
      : '';
    return `<div class="sbt-row"><span class="sbt-r">${roundNo}</span>` +
      `<span class="sbt-c${r.card?.red ? ' red' : ''}">${r.value}</span>${cells}${mine}</div>`;
  }).join('');
  wrap.innerHTML = head + rows +
    `<div class="sbt-note">▲ buy, ▼ sell, · passed. The small number is that bot's position after the trade.</div>`;
}

// The end-of-game reveal. Three things, in order of how much they teach:
//   1. The true distribution vs the sample you actually saw.
//   2. Your PnL split into edge (knowable at the time) and luck (not).
//   3. Every bot's hidden traits, and the verdict on whether trusting it paid.
function renderSignalDebrief(sig) {
  const el = $('signal-debrief');
  if (!sig.closed || !sig.debrief) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const d = sig.debrief;

  const maxP = Math.max(...d.dist.probs);
  const bars = d.dist.values.map((v, i) => {
    const p = d.dist.probs[i];
    return `<div class="sd-cell"><div class="sd-v">${v}</div>` +
      `<div class="sd-bar"><div class="sd-fill" style="height:${Math.round((p / maxP) * 100)}%"></div></div>` +
      `<div class="sd-p">${(p * 100).toFixed(0)}%</div></div>`;
  }).join('');

  // Edge vs luck. The sign of each half is what the player should read: positive
  // edge with negative PnL means good decisions, bad draws.
  const edgeGood = d.totalEdge >= 0;
  const luckGood = d.variance >= 0;
  const verdict = edgeGood
    ? (luckGood ? 'You read it well and the cards went your way.'
                : 'You read it well — the cards just went against you. Same decisions, different draw, and this is a win.')
    : (luckGood ? 'The result flattered you: your positions were against the evidence available at the time.'
                : 'Both the reads and the draws went against you.');

  const botRows = d.botReport.map((b) => {
    const traits = [
      b.biased ? 'biased' : 'unbiased',
      b.noisy ? 'incoherent' : 'coherent',
      b.opaque ? 'opaque sizing' : 'readable sizing',
      b.invAverse ? 'inventory-shy' : 'no inventory limit',
    ];
    const worth = b.rightWhenDisagreeing == null
      ? '<span class="muted">never disagreed with your running mean</span>'
      : (b.rightWhenDisagreeing >= 50
          ? `<span class="sd-good">worth following — right ${b.rightWhenDisagreeing}% of the times it disagreed with your own mean</span>`
          : `<span class="sd-bad">not worth following — right only ${b.rightWhenDisagreeing}% of the times it disagreed with your own mean</span>`);
    return `<div class="sd-bot">
      <div class="sd-bot-head"><b>${escapeHtml(b.name)}</b>
        <span class="sd-traits">${traits.map((t) => `<i>${t}</i>`).join('')}</span></div>
      <div class="sd-bot-body">
        <div class="sd-kv"><span>Saw</span><b>${b.k} private cards</b></div>
        <div class="sd-kv"><span>Its fair estimate</span><b>${b.muBot}</b>
          <i class="${Math.abs(b.muError) < 0.5 ? 'sd-good' : 'sd-bad'}">${b.muError > 0 ? '+' : ''}${b.muError} vs truth</i></div>
        <div class="sd-kv"><span>Looked coherent</span><b>${b.coherence == null ? '—' : b.coherence + '%'}</b>
          <i class="muted">of its trades fit one threshold</i></div>
        <div class="sd-kv"><span>Ended at</span><b>${b.finalPosition > 0 ? '+' : ''}${b.finalPosition}</b></div>
        <div class="sd-kv sd-kv-wide">${worth}</div>
      </div></div>`;
  }).join('');

  el.innerHTML = `
    <div class="sd-head">The Reveal</div>
    <div class="sd-block">
      <div class="sd-sub">The hidden distribution <i>(${escapeHtml(d.dist.shape)})</i></div>
      <div class="sd-grid">${bars}</div>
      <div class="sd-truth">
        <div class="sd-kv"><span>True mean (fair value)</span><b>${d.trueMean}</b></div>
        <div class="sd-kv"><span>Mean of what you saw</span><b>${d.sampleMean}</b></div>
        <div class="sd-kv"><span>Settled at</span><b>${d.settlement}</b></div>
      </div>
      <div class="sd-note">Fair value was the true mean. Your sample mean is what the reveals suggested — the gap between them is how misleading your sample was, before any decision you made.</div>
    </div>
    <div class="sd-block">
      <div class="sd-sub">Edge vs luck</div>
      <div class="sd-split">
        <div class="sd-half ${edgeGood ? 'sd-good-bg' : 'sd-bad-bg'}">
          <div class="sd-half-v">${d.totalEdge > 0 ? '+' : ''}${d.totalEdge}</div>
          <div class="sd-half-l">EDGE<br><i>decisions the evidence supported at the time</i></div>
        </div>
        <div class="sd-half ${luckGood ? 'sd-good-bg' : 'sd-bad-bg'}">
          <div class="sd-half-v">${d.variance > 0 ? '+' : ''}${d.variance}</div>
          <div class="sd-half-l">LUCK<br><i>the part that wasn't knowable</i></div>
        </div>
        <div class="sd-half sd-total">
          <div class="sd-half-v">${d.totalPnl > 0 ? '+' : ''}${d.totalPnl}</div>
          <div class="sd-half-l">TOTAL PnL<br><i>edge + luck</i></div>
        </div>
      </div>
      <div class="sd-verdict">${verdict}</div>
      <div class="sd-note">Each round is scored against the running mean of the cards revealed <b>up to that point</b> — the best estimate you could have had then, not the answer you have now.</div>
    </div>
    <div class="sd-block">
      <div class="sd-sub">The bots</div>
      ${botRows || '<div class="muted">No bots in this game.</div>'}
    </div>`;
}

// The wacky abstract distribution panel: the value→probability table plus the
// single-asset mean (EV). Shown for abstract games so the fair is easy to compute;
// hidden for every other class. The value with the highest probability is marked.
function renderDist(game) {
  const panel = $('dist-panel');
  const dist = game.abstractDist;
  if (!dist || !dist.values?.length) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const maxP = Math.max(...dist.probs);
  const cells = dist.values.map((v, i) => {
    const p = dist.probs[i];
    const top = p === maxP ? ' dist-top' : '';
    return `<div class="dist-cell${top}"><div class="dist-v">${v}</div>` +
      `<div class="dist-bar"><div class="dist-fill" style="height:${Math.round((p / maxP) * 100)}%"></div></div>` +
      `<div class="dist-p">${(p * 100).toFixed(0)}%</div></div>`;
  }).join('');
  panel.innerHTML =
    `<div class="dist-head">Abstract underlying — value distribution ` +
    `<span class="dist-mean">EV per asset = ${dist.mean}</span></div>` +
    `<div class="dist-grid">${cells}</div>` +
    `<div class="dist-note">Each hidden asset is an independent draw from this table. The single-asset fair value is the mean shown above.</div>`;
}

// End-game reveal of the hint each bot held, so players can see what the bot(s)
// were pricing off. Hidden when there are no bots.
function renderBotHintReveal(reveal) {
  const box = $('bot-hint-reveal');
  if (!reveal || !reveal.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const rows = reveal.map((r) => {
    const h = r.hint
      ? `${escapeHtml(r.hint.label)}: <b>${escapeHtml(String(r.hint.value))}</b>`
      : '<span class="muted">no hint</span>';
    return `<div class="pr-row"><span class="pr-name">${escapeHtml(r.name)}</span><span class="pr-cards">${h}</span></div>`;
  }).join('');
  box.innerHTML = `<div class="pr-label">Bot hints (revealed)</div>${rows}`;
}

// End-game PnL recap: one card per round with a per-player table of PnL earned by
// Making vs Taking, and the Adverse-selection hit (a subset of making). All marked
// to settlement, so Making + Taking = the player's total trading PnL.
function renderPnlRecap(recap) {
  const box = $('pnl-recap');
  if (!recap || !recap.players || !Object.keys(recap.players).length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  const money = (x) => `${x > 0 ? '+' : ''}${x.toFixed(2)}`;
  const cls = (x) => x > 0 ? 'pos-pos' : x < 0 ? 'pos-neg' : '';
  const rounds = recap.rounds;

  // Order players by net trading PnL (best first); put "you" first if present.
  const names = Object.keys(recap.players).sort((a, b) => recap.players[b].net - recap.players[a].net);
  const myName = (typeof joinedName === 'string' && joinedName) ? joinedName : null;
  if (myName) names.sort((a, b) => (a === myName ? -1 : 0) - (b === myName ? -1 : 0));

  // One card per round; rows are players. A trailing "All rounds" card shows each
  // player's totals across the game.
  // "−4.20 by Bot-3" — the adverse cell, annotated with who picked the maker off
  // (largest loss first). Falls back to just the number if attribution is missing.
  const adverseCell = (V) => {
    if (!(V.adverse < 0)) return '—';
    const by = V.adverseBy || {};
    const takers = Object.keys(by).sort((a, b) => by[a] - by[b]); // most-negative first
    const who = takers.length
      ? `<span class="rc-adv-by">by ${takers.map((t) => escapeHtml(t)).join(', ')}</span>`
      : '';
    return `${money(V.adverse)}${who ? '<br>' + who : ''}`;
  };
  const roundCard = (label, valueFor) => {
    const playerRows = names.map((name) => {
      const V = valueFor(name);
      const isMe = name === myName;
      return `<tr class="${isMe ? 'rc-me-row' : ''}">
        <td class="rc-round">${escapeHtml(name)}${isMe ? ' <span class="rc-youtag">YOU</span>' : ''}</td>
        <td class="${cls(V.making)}">${money(V.making)}</td>
        <td class="${cls(V.taking)}">${money(V.taking)}</td>
        <td class="${cls(V.adverse)}">${adverseCell(V)}</td>
        <td class="${cls(V.net)}">${money(V.net)}</td>
      </tr>`;
    }).join('');
    return `<div class="rc-card">
      <div class="rc-name">${label}</div>
      <table class="rc-table">
        <thead><tr><th></th><th>Making</th><th>Taking</th><th>Adverse</th><th>Net</th></tr></thead>
        <tbody>${playerRows}</tbody>
      </table>
    </div>`;
  };

  const cards = rounds.map((r) =>
    roundCard(`R${r}`, (name) => recap.players[name].rounds[r] || { making: 0, taking: 0, adverse: 0, net: 0, adverseBy: {} })
  ).join('') + roundCard('All rounds', (name) => recap.players[name]);

  box.innerHTML = `
    <div class="rc-label">PnL breakdown — Making vs Taking (marked to settlement)</div>
    <div class="rc-note">Making = your resting orders getting hit · Taking = your aggressive fills · Adverse = making PnL lost when the taker's position was a near-lock (≥90%) on their info</div>
    <div class="rc-cards">${cards}</div>`;
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
    // Adverse fills (flagged at settlement): the resting maker was picked off by a
    // better-informed taker, for a big loss vs settlement. Highlighted blue.
    row.className = 'tape-row' + (t.adverse ? ' tape-adverse' : '');
    if (t.mmRound) {
      // MM trade: one taker, recorded with side. `forced` = auto-trade for an idle taker.
      const forcedTag = t.forced ? ' <span class="forced-tag">AUTO</span>' : '';
      row.innerHTML = `
        <span class="${t.side}">${t.side.toUpperCase()} ${t.qty} @ ${t.price} <span class="mm-tag">MM</span>${forcedTag}</span>
        <span class="tt">${escapeHtml(t.trader)} · R${t.round}</span>
      `;
    } else {
      // Open-outcry trade. When a taker hit a resting order, frame it from the
      // taker's side: "taker bought/sold from maker". Auto-matched crossing
      // limit orders have no taker, so fall back to buyer/seller.
      let detail;
      if (t.taker && t.takerSide) {
        const sideClass = t.takerSide === 'bought' ? 'buy' : 'sell';
        detail = `<span class="${sideClass}">${escapeHtml(t.taker)} ${t.takerSide}</span> from ${escapeHtml(t.maker)}`;
      } else {
        detail = `<span class="buy">${escapeHtml(t.buyer)} bought</span> from <span class="sell">${escapeHtml(t.seller)}</span>`;
      }
      const adverseTag = t.adverse ? ' <span class="adverse-tag">ADVERSE</span>' : '';
      row.innerHTML = `
        <span class="buy">${t.qty} @ ${t.price}</span>
        <span class="tt">${detail} · R${t.round}${adverseTag}</span>
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
      // For your own orders, the Cancel button sits in the name column (you don't
      // need to see your own name); for others', the name leads and a take button
      // (SELL/BUY) trails.
      if (isMe) {
        row.innerHTML = `
          <button class="ob-cancel-btn ob-name" data-order-id="${order.id}">Cancel</button>
          <span class="ob-qty">${order.qty}</span>
          <span class="ob-price">@ ${order.price}</span>
        `;
      } else {
        const takeBtn = side === 'bid'
          ? `<button class="ob-take-btn ob-sell-btn" data-side="bid" data-order-id="${order.id}">SELL</button>`
          : `<button class="ob-take-btn ob-buy-btn" data-side="ask" data-order-id="${order.id}">BUY</button>`;
        row.innerHTML = `
          <span class="ob-name">${escapeHtml(order.name)}</span>
          <span class="ob-qty">${order.qty}</span>
          <span class="ob-price">@ ${order.price}</span>
          ${takeBtn}
        `;
      }
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

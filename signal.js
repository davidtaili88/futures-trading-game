// Signal Reading mode ("signal") — a single-player inference game.
//
// The player trades against the HOUSE (a fixed, known fill price), not against
// the bots. Bots are pure SIGNAL: each round they trade publicly and the player
// watches. Nothing the bots do changes the player's fill price, so the bots'
// only role is to leak information about the hidden distribution.
//
// Each round:
//   1. One card is drawn from a HIDDEN distribution over 1..13 and revealed.
//   2. The bots each act on that card (buy/sell/pass, with a size).
//   3. The player may buy or sell 1/2/3 lots at the card's value (the house fill).
//
// At the end, the contract settles to a FRESH draw from the same hidden
// distribution. So the deck mean IS the fair value, and every revealed card is a
// sample from the settlement distribution — learning the deck is directly
// profitable.
//
// A position of q lots bought at price c pays (settlement − c) · q. The player's
// edge on a buy is therefore (trueMean − card), which they must estimate from
// the reveals so far plus whatever the bots are leaking.

// ---------- The hidden distribution ----------

const VAL_MIN = 1;
const VAL_MAX = 13;

// Roll a hidden distribution over 1..13. Deliberately non-uniform and varied in
// SHAPE so the player can't assume a flat 7 fair: the shape is picked from a few
// archetypes, each of which puts the mean in a different place and gives a
// different learning curve. Weights are snapped to whole percents so the
// end-of-game reveal reads cleanly.
//
// Shapes:
//   uniform  — flat over a sub-range (mean = midpoint of that range)
//   skew     — geometric decay toward one end (mean pulled to the heavy tail)
//   bimodal  — two humps (wide spread, mean between them, slow to learn)
//   peaked   — a tight bell (narrow spread, fast to learn)
export function rollHiddenDist() {
  const shapes = ['uniform', 'skew', 'bimodal', 'peaked'];
  const shape = shapes[Math.floor(Math.random() * shapes.length)];
  const span = VAL_MAX - VAL_MIN + 1;
  const raw = new Array(span).fill(0);

  if (shape === 'uniform') {
    // Flat over a random contiguous sub-range of width >= 5.
    const width = 5 + Math.floor(Math.random() * (span - 4));
    const lo = Math.floor(Math.random() * (span - width + 1));
    for (let i = lo; i < lo + width; i++) raw[i] = 1;
  } else if (shape === 'skew') {
    // Geometric decay from one end; direction random, decay rate random.
    const decay = 0.55 + Math.random() * 0.3; // 0.55..0.85 per step
    const fromLow = Math.random() < 0.5;
    for (let i = 0; i < span; i++) {
      const d = fromLow ? i : span - 1 - i;
      raw[i] = Math.pow(decay, d);
    }
  } else if (shape === 'bimodal') {
    // Two Gaussian humps at random, well-separated centers. The humps are
    // deliberately allowed to be very LOPSIDED (weight ratio up to ~10:1) and the
    // pair can sit anywhere in the range — symmetric humps of equal weight always
    // average to the middle, which would make every bimodal game a predictable
    // "fair is about 7" and waste the shape.
    const c1 = Math.floor(Math.random() * (span - 5));          // 0..7
    const c2 = c1 + 5 + Math.floor(Math.random() * (span - 5 - c1)); // >= c1+5
    const s = 0.8 + Math.random() * 0.8;
    const w = 0.1 + Math.random() * 1.8; // 0.1..1.9 — often strongly lopsided
    for (let i = 0; i < span; i++) {
      raw[i] = Math.exp(-((i - c1) ** 2) / (2 * s * s)) + w * Math.exp(-((i - c2) ** 2) / (2 * s * s));
    }
  } else {
    // Peaked: a tight bell at a random center.
    const c = Math.floor(Math.random() * span);
    const s = 1.0 + Math.random() * 1.2;
    for (let i = 0; i < span; i++) raw[i] = Math.exp(-((i - c) ** 2) / (2 * s * s));
  }

  // Normalize to integer percents summing to 100, dropping negligible mass so the
  // reveal table stays readable. Values below 0.5% are zeroed out entirely.
  const total = raw.reduce((a, b) => a + b, 0);
  let pct = raw.map((w) => Math.round((w / total) * 100));
  // Zero out sub-1% noise so the support is crisp, then renormalize drift onto
  // the mode.
  let drift = 100 - pct.reduce((a, b) => a + b, 0);
  if (drift !== 0) {
    const idx = pct.indexOf(Math.max(...pct));
    pct[idx] = Math.max(1, pct[idx] + drift);
  }

  const values = [];
  const probs = [];
  for (let i = 0; i < span; i++) {
    if (pct[i] > 0) { values.push(VAL_MIN + i); probs.push(pct[i] / 100); }
  }
  const mean = values.reduce((s, v, i) => s + v * probs[i], 0);
  const varr = values.reduce((s, v, i) => s + probs[i] * (v - mean) ** 2, 0);
  return {
    shape,
    values,
    probs,
    mean: Math.round(mean * 1000) / 1000,
    sd: Math.round(Math.sqrt(varr) * 1000) / 1000,
  };
}

// Draw one value from a hidden distribution (with replacement — every draw is iid,
// so the reveals are a clean sample and the settlement draw is exchangeable with
// them).
export function sampleHidden(dist) {
  let r = Math.random();
  for (let i = 0; i < dist.values.length; i++) {
    r -= dist.probs[i];
    if (r <= 0) return dist.values[i];
  }
  return dist.values[dist.values.length - 1];
}

// Card presentation for a drawn value (A=1…K=13), matching the cards asset class.
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

export function makeCard(value) {
  const s = SUITS[Math.floor(Math.random() * SUITS.length)];
  return {
    kind: 'card',
    label: `${RANKS[value - 1]}${s}`,
    value,
    red: s === '♥' || s === '♦',
  };
}

// ---------- Bots ----------
//
// Every bot parameter is an INDEPENDENT coin flip, rolled once at spawn and fixed
// for the whole game. The player's job is to work out, from the bot's trades
// alone, which side of each flip it landed on — and therefore how much its
// behaviour is worth.
//
// A bot's belief about fair value each round is
//
//     mu_t = muBot + eps_t,    eps_t ~ N(0, sigma^2)
//
// where muBot is the mean of a PRIVATE burn-in sample of k draws from the same
// hidden distribution (drawn before the game, never shown). So:
//
//   k large  → muBot is close to the true mean: the bot is UNBIASED by
//              construction, and genuinely knows more than the player early on.
//   k small  → muBot is off by ~sd/sqrt(k) in a random direction: the bot is
//              BIASED, but its bias is a plausible estimate rather than an
//              arbitrary offset, which is what makes the debrief honest.
//
// sigma is the bot's COHERENCE: how much its belief jitters round to round. Low
// sigma reads as a near-fixed threshold (buys below it, sells above it). High
// sigma means it contradicts itself — buying at 9 and selling at 8 — which is
// detectable with no knowledge of the deck at all.
//
// Sizing is a SOFTMAX over {0,1,2,3} on perceived edge, not a deterministic
// function of it. This matters: a deterministic size would make each trade an
// exact interval reveal on mu_t, and two or three trades would pin muBot by
// constraint-solving rather than inference. Sampling the size makes every trade
// evidence instead of a constraint. `temp` is the opacity dial — low temp is
// near-deterministic (leaky), high temp makes size nearly independent of edge, so
// only the DIRECTION carries information.
//
// Inventory aversion (lambda > 0) subtracts a multiple of the bot's current
// position from its desired trade, so a bot that is too long will sometimes sell
// a cheap card. From outside that looks incoherent, but it isn't — a player who
// tracks the bot's inventory can untangle it, and one who doesn't can't. That
// raises the skill ceiling without moving the floor.

// Parameter levels for each independent coin flip.
//
// K_UNBIASED is deliberately ~12, not ~40. A k of 40 gives the bot a private
// estimate (error ~sd/sqrt(40)) that the player's own running mean never catches
// up to within 25 rounds, which collapses the game into "find the unbiased bot
// and copy it forever". At k≈12 the bot's edge is real and large early but the
// player's running mean overtakes it around round 12–15 — so knowing WHEN to stop
// deferring to the bot is itself the skill, which is the point of the mode.
const K_UNBIASED = 12;   // burn-in size when the bias flip lands "unbiased"
const K_BIASED = 3;      // burn-in size when it lands "biased"
const SIGMA_COHERENT = 0.4;
const SIGMA_NOISY = 2.6;
const TEMP_TRANSPARENT = 2.2;  // sharper: size tracks edge fairly closely
const TEMP_OPAQUE = 0.55;      // flatter: size says little about edge
const LAMBDA_AVERSE = 0.45;
const SIZE_SCALE = 2.0;        // edge per lot: |edge|/2 lots of desired size
const MAX_LOT = 3;

function gauss() {
  // Box–Muller.
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Spawn `n` bots, each with independently flipped parameters.
export function spawnSignalBots(dist, n) {
  const bots = [];
  for (let i = 1; i <= n; i++) {
    const biased = Math.random() < 0.5;
    const noisy = Math.random() < 0.5;
    const opaque = Math.random() < 0.5;
    const invAverse = Math.random() < 0.5;

    const k = biased ? K_BIASED : K_UNBIASED;
    // The bot's private burn-in sample from the SAME hidden distribution. This is
    // the bot's genuine private information: the player never sees these draws.
    const burnIn = Array.from({ length: k }, () => sampleHidden(dist));
    const muBot = burnIn.reduce((a, b) => a + b, 0) / k;

    bots.push({
      id: `sbot:${i}`,
      name: `Bot-${i}`,
      // Hidden parameters — revealed only in the debrief.
      biased,
      noisy,
      opaque,
      invAverse,
      k,
      muBot: Math.round(muBot * 1000) / 1000,
      sigma: noisy ? SIGMA_NOISY : SIGMA_COHERENT,
      temp: opaque ? TEMP_OPAQUE : TEMP_TRANSPARENT,
      lambda: invAverse ? LAMBDA_AVERSE : 0,
      burnIn,
      // Running state.
      position: 0,
      trades: [],
    });
  }
  return bots;
}

// Softmax sample over lot sizes 0..MAX_LOT given a desired (fractional) lot count.
// The score for lot L is -(L - desired)^2, so the distribution peaks at `desired`
// and `temp` controls how sharply. Low temp → flat → size carries little info.
function sampleLot(desired, temp) {
  const scores = [];
  for (let L = 0; L <= MAX_LOT; L++) scores.push(-((L - desired) ** 2) * temp);
  const m = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(s - m));
  const tot = exps.reduce((a, b) => a + b, 0);
  let r = Math.random() * tot;
  for (let L = 0; L < exps.length; L++) {
    r -= exps[L];
    if (r <= 0) return L;
  }
  return 0;
}

// One bot's action for a revealed card. Returns { side, qty, } with qty 0 meaning
// it passed. The bot's own belief and edge are recorded server-side for the
// debrief but never sent to the client mid-game.
export function botAct(bot, cardValue) {
  const mu = bot.muBot + gauss() * bot.sigma;
  // Perceived edge on BUYING this card: positive means it looks cheap.
  const edge = mu - cardValue;
  // Inventory aversion pulls the desired trade back toward flat.
  const desiredSigned = edge / SIZE_SCALE - bot.lambda * bot.position;
  const qty = sampleLot(Math.abs(desiredSigned), bot.temp);
  const side = desiredSigned >= 0 ? 'buy' : 'sell';
  const rec = {
    card: cardValue,
    side,
    qty,
    // Server-side truth for the debrief.
    mu: Math.round(mu * 1000) / 1000,
    edge: Math.round(edge * 1000) / 1000,
    posBefore: bot.position,
  };
  if (qty > 0) bot.position += side === 'buy' ? qty : -qty;
  bot.trades.push(rec);
  return rec;
}

// ---------- Inference scoring (the debrief) ----------
//
// Revealing the true distribution tells the player whether they were RIGHT. It
// does not tell them whether they were REASONABLE — and that's the more useful
// feedback, because a correct decision that lost money should not be
// "corrected". So we replay the game and score every position against the
// posterior a well-calibrated player COULD have held at the time, using only the
// cards revealed up to and including that round.
//
// For round t with revealed cards c_1..c_t, the knowable estimate of fair value
// is the running sample mean m_t. The player's per-round edge is then
//
//     edge_t = (m_t − card_t) · signedQty_t
//
// i.e. positive when they traded in the direction the evidence available at the
// time supported. Their realised PnL for the same trade is
//
//     pnl_t  = (settlement − card_t) · signedQty_t
//
// The difference is variance: the part of the outcome that was not knowable. A
// player with positive total edge and negative total PnL played well and got
// unlucky; the reverse means they got bailed out. That decomposition is the whole
// point of the debrief.
export function buildSignalDebrief(state) {
  const { dist, rounds, settlement, bots } = state;

  // Running sample mean of revealed cards — the knowable fair at each round.
  const running = [];
  let sum = 0;
  rounds.forEach((r, i) => {
    sum += r.card;
    running.push(sum / (i + 1));
  });

  let totalEdge = 0;
  let totalPnl = 0;
  const perRound = rounds.map((r, i) => {
    const signed = r.playerSide === 'buy' ? r.playerQty : (r.playerSide === 'sell' ? -r.playerQty : 0);
    const knowable = running[i];
    const edge = (knowable - r.card) * signed;
    const pnl = (settlement - r.card) * signed;
    totalEdge += edge;
    totalPnl += pnl;
    return {
      round: i + 1,
      card: r.card,
      side: r.playerSide,
      qty: r.playerQty,
      signed,
      knowableFair: Math.round(knowable * 100) / 100,
      // Edge available at the time on the side they actually took.
      edge: Math.round(edge * 100) / 100,
      pnl: Math.round(pnl * 100) / 100,
      // What the optimal-given-information trade would have been: max size in the
      // direction the running mean supported, sized by conviction.
      bestSide: knowable > r.card ? 'buy' : (knowable < r.card ? 'sell' : 'flat'),
      botActions: r.botActions,
    };
  });

  // Per-bot debrief: reveal every coin flip, the private burn-in, and — the part
  // that actually closes the loop on the trust question — what following that bot
  // blindly would have earned.
  const botReport = bots.map((b) => {
    // Two different questions, so two different numbers.
    //
    // followPnl: what copying every one of its trades at its own size would have
    // paid, marked against the ACTUAL settlement draw. This is what the player
    // would really have made, but it is noisy — one settlement draw against an
    // accumulated position swamps bot quality with luck.
    //
    // directionScore: the same trades marked against the TRUE MEAN instead, per
    // lot. This strips the settlement draw out and measures only whether the bot
    // was pointing the right way, which is the actual quality question. A good bot
    // scores positive here even in a game where it happened to lose money.
    //
    // disagreeRate / rightWhenDisagreeing: the numbers that actually decide
    // whether the bot was worth listening to. Almost every bot buys low and sells
    // high against its own mu, so on most cards it agrees with the player's own
    // running mean and following it changes nothing. All the value (or damage) is
    // concentrated in the rounds where the two DISAGREED. A well-informed bot
    // disagrees rarely and is usually right; a biased one disagrees more often and
    // is usually wrong — and the disagreement RATE is visible to the player
    // without knowing the truth, which makes it the fair tell.
    let followPnl = 0;
    let lots = 0;
    let dirTotal = 0;
    let disagreed = 0;
    let disagreedAndBotRight = 0;
    // b.trades is appended once per round, in round order, so index i is round i.
    b.trades.forEach((t, i) => {
      if (t.qty) {
        const signed = t.side === 'buy' ? t.qty : -t.qty;
        followPnl += (settlement - t.card) * signed;
        dirTotal += (dist.mean - t.card) * signed;
        lots += t.qty;
      }
      // Disagreement is measured on the bot's UNDERLYING BELIEF (muBot) against
      // the player's running mean, on every round including ones it sized to zero.
      //
      // Two deliberate choices here. Counting only traded rounds would throw away
      // most disagreements — a bot passes precisely when the card sits near its own
      // mu, which is exactly where the two views differ. And comparing the bot's
      // *realized* direction rather than its belief lets sigma-noise and inventory
      // flips swamp the bias: measured that way, a well-informed bot and a biased
      // one both come out around 21% disagreement / 16% right, telling the player
      // nothing. Measured on the belief, they separate cleanly (roughly 10%/50% for
      // unbiased vs 14%/29% for biased). This number answers "was this bot's
      // information worth having", which is a separate question from how noisily it
      // expressed that information — `coherence` covers the latter.
      const own = i < running.length ? running[i] : dist.mean;
      const botDir = Math.sign(b.muBot - t.card);
      const ownDir = Math.sign(own - t.card);
      if (botDir === 0) return;
      if (ownDir !== 0 && botDir !== ownDir) {
        disagreed += 1;
        if ((dist.mean - t.card) * botDir > 0) disagreedAndBotRight += 1;
      }
    });
    // Empirical coherence: fraction of its trades that a single fixed threshold at
    // muBot would explain (bought below it / sold above it). A player can compute
    // exactly this from the visible tape, so it's the honest scoreboard for the
    // "is it coherent" question.
    const acted = b.trades.filter((t) => t.qty > 0);
    const consistent = acted.filter((t) =>
      (t.side === 'buy' && t.card < b.muBot) || (t.side === 'sell' && t.card > b.muBot)
    ).length;
    return {
      name: b.name,
      biased: b.biased,
      noisy: b.noisy,
      opaque: b.opaque,
      invAverse: b.invAverse,
      k: b.k,
      muBot: b.muBot,
      sigma: b.sigma,
      temp: b.temp,
      lambda: b.lambda,
      // How far its private estimate actually was from truth.
      muError: Math.round((b.muBot - dist.mean) * 1000) / 1000,
      coherence: acted.length ? Math.round((consistent / acted.length) * 100) : null,
      tradeCount: acted.length,
      finalPosition: b.position,
      followPnl: Math.round(followPnl * 100) / 100,
      // Edge per lot against the true mean: the luck-free quality measure.
      directionScore: lots ? Math.round((dirTotal / lots) * 100) / 100 : null,
      // Where the bot's information actually mattered. disagreeRate is computable
      // by the player during the game; rightWhenDisagreeing needs the truth, so it
      // is the debrief's verdict on whether the trust was warranted.
      disagreed,
      // Denominator is every round (disagreement is measured on implied direction,
      // including zero-lot rounds), not just the rounds it traded.
      disagreeRate: b.trades.length ? Math.round((disagreed / b.trades.length) * 100) : null,
      rightWhenDisagreeing: disagreed ? Math.round((disagreedAndBotRight / disagreed) * 100) : null,
    };
  });

  return {
    dist,
    settlement,
    trueMean: dist.mean,
    trueSd: dist.sd,
    // The sample mean of everything the player actually saw — how misleading the
    // sample itself was, which is the other half of "did I get unlucky".
    sampleMean: rounds.length ? Math.round((sum / rounds.length) * 100) / 100 : null,
    perRound,
    totalEdge: Math.round(totalEdge * 100) / 100,
    totalPnl: Math.round(totalPnl * 100) / 100,
    // PnL not explained by knowable edge: pure variance.
    variance: Math.round((totalPnl - totalEdge) * 100) / 100,
    botReport,
  };
}

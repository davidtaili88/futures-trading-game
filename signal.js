// Signal Reading mode ("signal") — a single-player inference game.
//
// The player trades against the HOUSE (a fixed, known fill price), not against
// the bots. Bots are pure SIGNAL: each round they trade publicly and the player
// watches. Nothing the bots do changes the player's fill price, so the bots'
// only role is to leak information about the hidden distribution.
//
// Each round:
//   1. One value is drawn from a HIDDEN distribution and revealed.
//   2. The bots each act on that value (buy/sell/pass, with a size).
//   3. The player may buy or sell 1/2/3 lots at the value PLUS the house spread
//      for that size (see FEE_SD_MULT), or pass the round entirely.
//
// At the end, the contract settles to a FRESH draw from the same hidden
// distribution. So the distribution's mean IS the fair value, and every revealed
// value is a sample from the settlement distribution — learning it is directly
// profitable.
//
// A position of q lots bought at fill price p pays (settlement − p) · q. The
// player's edge on a buy is therefore (trueMean − p), which they must estimate
// from the reveals so far plus whatever the bots are leaking — and because p
// rises with size, a bigger position needs a bigger edge to be worth taking.

// ---------- The hidden distribution ----------
//
// The value range is itself randomized per game and never disclosed. Each game
// rolls a VOLATILITY REGIME (see REGIMES) that sets how wide its value window is,
// and the window is then placed somewhere in [MIN_FLOOR, MAX_CEIL] — so the
// player cannot anchor on any fixed scale, and has to infer the level, the
// spread and the shape. Nothing in the UI states the bounds, and the reveal is
// the first time they are shown.
//
// The window is still bounded. An unbounded range would let one freak draw
// decide the whole game's PnL, which is variance masquerading as difficulty.
// Even the violent regime keeps tail events meaningful without letting a single
// sample swamp 25 rounds of good decisions.
const MIN_FLOOR = 10;     // lowest value any game can produce
const MAX_CEIL = 900;     // highest — wide regimes need room to sit high

// VOLATILITY REGIMES. Rolling every game from one window range made the mode
// feel samey: the spread was always about the same fraction of the level, so
// after a few games you stopped being surprised. Instead each game rolls a
// regime, which sets how wide the value window is.
//
// The tight regime is deliberately KEPT — it is the calm, readable game where
// inference is cleanest, and removing it would flatten the mode in the other
// direction. It is just no longer most of the games: it is now a minority, so a
// calm game reads as a lull rather than the default.
//
// `weight` is relative frequency; `min`/`max` bound the window width.
const REGIMES = [
  // Calm: the old behaviour, now the minority. Small spreads, obvious level.
  { name: 'tight',  weight: 1.6, min: 45,  max: 90 },
  // The workhorse: roughly the previous default.
  { name: 'normal', weight: 3.0, min: 90,  max: 180 },
  // Wide: spreads big enough that a single draw genuinely moves your estimate.
  { name: 'wide',   weight: 2.2, min: 180, max: 340 },
  // Violent: rare, and the games people remember. A tail draw here can be
  // hundreds of units from the body — still bounded, so one sample cannot
  // literally decide the game, but it will hurt.
  { name: 'violent', weight: 1.0, min: 340, max: 560 },
];

// Resolution of the value grid. The window is divided into this many discrete
// steps; values are integers, so a ~100-wide window gives ~100 candidate values.
// That is the whole point of moving off a 13-card deck: with ~100 values, a thin
// tail can carry real probability mass while still being rare enough to
// under-show in a 25-draw sample, and the support can have GAPS the player can
// never fully map.
//
// ADVERSARIAL BY CONSTRUCTION. The design constraint is that "buy anything below
// the middle of what I've seen, sell anything above it" must NOT be a winning
// strategy. Against symmetric distributions it always is, because the mean sits
// near the midpoint of the support, so relative rank is a free proxy for fair
// value. The fix is heavy, one-sided tails: most mass on one side and a thin tail
// of rare far draws on the other, dragging the mean well away from where the
// values LOOK centred.
//
// Three further properties, all required:
//
//   * The support has GAPS and ragged edges, so a player can never pin the true
//     min or max. Every shape punches holes in its own support and sets its
//     endpoints off the window edges, so the extremes you have seen are never
//     evidently the extremes that exist.
//
//   * A tail on the opposite side is ALWAYS possible. Whatever side the mass
//     concentrates on, a thin band of mass is guaranteed on the far side (see
//     addOppositeTail), so a high-concentrated distribution can still print a
//     substantially lower value. This is what makes a confident read dangerous.
//
//   * Genuine multimodality. Several shapes place 2-4 separated modes, so the
//     sample looks like it is centring on one level while the mean sits
//     somewhere else entirely.
//
// Shapes:
//   tailUp     — mass low, thin tail far above; mean well above the median
//   tailDown   — mirror image; mean well below the median
//   multimodal — 2-4 separated humps with large weight ratios
//   cliff      — dense block, sharp edge, sparse shelf beyond it
//   scatter    — irregular comb of spikes with strongly skewed weights
//   plateau    — broad flat body with a distant minority cluster
const SUPPORT_MIN = 18;   // distinct values that must carry mass
const SKEW_MIN = 0.06;    // |mean - median| floor, as a fraction of window width
const OPP_TAIL_MIN = 0.02; // min probability mass on the far side of the mode

// Relative frequency of each shape. Tail shapes dominate because they are the
// ones that reliably punish a rank-based read (see pickWeighted call below).
const SHAPE_WEIGHTS = {
  tailUp: 3.0, tailDown: 3.0, plateau: 1.6, cliff: 1.0, multimodal: 1.0, scatter: 0.4,
};

function pickWeightedIdx(weights) {
  const tot = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * tot;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

function pickWeighted(keys, weights) {
  const tot = keys.reduce((a, k) => a + (weights[k] ?? 1), 0);
  let r = Math.random() * tot;
  for (const k of keys) {
    r -= weights[k] ?? 1;
    if (r <= 0) return k;
  }
  return keys[keys.length - 1];
}

export function rollHiddenDist() {
  const shapes = ['tailUp', 'tailDown', 'multimodal', 'cliff', 'scatter', 'plateau'];

  // Pick the shape ONCE, outside the retry loop. Re-rolling it per attempt biases
  // the mix badly toward shapes that happen to satisfy the adversity checks on
  // the first try — measured, that gave 18x more multimodal games than plateau.
  //
  // The mix is WEIGHTED toward the tail shapes. Measured as (observed range
  // midpoint − true mean) / sd, the tail shapes displace the naive rank proxy by
  // ~1.15 sd and do it consistently in one direction, which is what actually
  // breaks "buy below the middle". The symmetric shapes only manage 0.23–0.47 sd,
  // so they are kept for variety but are no longer the bulk of the games.
  const shape = pickWeighted(shapes, SHAPE_WEIGHTS);
  // Regime is rolled once per game too, so the whole game shares one character.
  const regime = REGIMES[pickWeightedIdx(REGIMES.map((r) => r.weight))];

  let best = null;
  let bestScore = -1;
  for (let attempt = 0; attempt < 60; attempt++) {
    // Roll this game's value window. Both the width and the placement are random
    // and hidden, so the player must infer the level as well as the shape.
    const width = regime.min + Math.floor(Math.random() * (regime.max - regime.min + 1));
    const base = MIN_FLOOR + Math.floor(Math.random() * (MAX_CEIL - width - MIN_FLOOR + 1));
    const span = width + 1;
    let raw = new Array(span).fill(0);

    if (shape === 'tailUp' || shape === 'tailDown') {
      // A dense body low in the window plus a thin, long tail reaching far up.
      // The tail carries little probability but a lot of VALUE, so it moves the
      // mean far more than it moves the median — the core adverse mechanism, and
      // far more effective over ~100 values than it was over 13.
      const bodyLo = Math.floor(span * (0.02 + Math.random() * 0.10));
      const bodyW = Math.floor(span * (0.10 + Math.random() * 0.18));
      const bodyHi = bodyLo + bodyW;
      for (let i = bodyLo; i <= bodyHi && i < span; i++) raw[i] = 1;
      // Tail height as a fraction of body height, and how fast it decays. A low
      // tailH with slow decay is the most adverse: rare, but reaching very far.
      const tailH = 0.010 + Math.random() * 0.045;
      const decay = Math.pow(0.02, 1 / (span * (0.45 + Math.random() * 0.5)));
      for (let i = bodyHi + 1; i < span; i++) {
        raw[i] = tailH * Math.pow(decay, i - bodyHi - 1);
      }
      if (shape === 'tailDown') raw.reverse();
    } else if (shape === 'multimodal') {
      // 2-4 separated humps with large weight ratios. The heavy hump dominates
      // what you SEE, so the light ones read as noise until enough of them show
      // up — and the mean sits between them, at a level that matches no mode.
      const k = 2 + Math.floor(Math.random() * 3);
      const centers = [];
      for (let m = 0; m < k; m++) {
        // Spread the modes across the window with jitter, keeping them apart.
        const slot = (m + 0.5) / k;
        centers.push(Math.floor(span * (slot + (Math.random() - 0.5) * 0.5 / k)));
      }
      for (let m = 0; m < k; m++) {
        const sd = span * (0.020 + Math.random() * 0.045);
        // Weights spread over an order of magnitude so one mode dominates.
        const w = Math.pow(Math.random(), 2.2) + 0.03;
        for (let i = 0; i < span; i++) {
          raw[i] += w * Math.exp(-((i - centers[m]) ** 2) / (2 * sd * sd));
        }
      }
    } else if (shape === 'cliff') {
      // A dense block ending in a sharp edge, with a sparse shelf beyond it. The
      // shelf is the adverse part: cheap to dismiss, expensive to misprice.
      const edge = Math.floor(span * (0.25 + Math.random() * 0.5));
      const up = Math.random() < 0.5;
      const shelf = 0.02 + Math.random() * 0.07;
      for (let i = 0; i < span; i++) {
        raw[i] = (up ? i <= edge : i >= edge) ? 1 : shelf;
      }
    } else if (shape === 'scatter') {
      // Irregular comb of spikes at random values with strongly skewed weights.
      // Naturally gappy: most of the window carries no mass at all.
      const nSpikes = SUPPORT_MIN + Math.floor(Math.random() * Math.max(1, span * 0.5));
      const pool = Array.from({ length: span }, (_, i) => i);
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      for (const idx of pool.slice(0, nSpikes)) {
        raw[idx] = Math.pow(Math.random(), 3) + 0.004;
      }
    } else {
      // Plateau: a broad flat body plus a distant minority cluster. The body
      // makes the level look obvious; the cluster quietly moves the mean.
      const lo = Math.floor(span * (0.05 + Math.random() * 0.25));
      const hi = lo + Math.floor(span * (0.25 + Math.random() * 0.35));
      for (let i = lo; i <= hi && i < span; i++) raw[i] = 1;
      const far = Math.random() < 0.5
        ? Math.floor(span * (0.80 + Math.random() * 0.18))
        : Math.floor(span * (0.02 + Math.random() * 0.12));
      const fsd = span * (0.02 + Math.random() * 0.04);
      const fw = 0.04 + Math.random() * 0.14;
      for (let i = 0; i < span; i++) {
        raw[i] += fw * Math.exp(-((i - far) ** 2) / (2 * fsd * fsd));
      }
    }

    // Guarantee a thin band of mass on the far side of the mode, so a rare draw
    // well away from where the mass sits is ALWAYS possible. Without this, a
    // player who has seen 25 high values could safely conclude low values don't
    // exist — and the whole point is that they can never be sure.
    // Punch holes so the support is ragged and the true min/max stay unknowable,
    // THEN add the opposite tail. Order matters: punchGaps feathers the support's
    // ends, which would otherwise erase the tail it is supposed to guarantee.
    raw = punchGaps(raw, span);
    raw = addOppositeTail(raw, span);

    const cand = finalizeDist(shape, raw, span, base, width, regime.name);
    if (!cand) continue;

    // Accept only if genuinely adverse AND rich AND both tails live.
    const relSkew = Math.abs(cand.mean - cand.median) / width;
    const ok = cand.values.length >= SUPPORT_MIN
      && relSkew >= SKEW_MIN
      && cand.oppTailMass >= OPP_TAIL_MIN;
    if (ok) return cand;
    // Otherwise keep the most adverse candidate seen, so we always return one.
    const score = relSkew * (cand.values.length >= SUPPORT_MIN ? 1 : 0.3);
    if (score > bestScore) { bestScore = score; best = cand; }
  }
  return best;
}

// Ensure mass exists on the opposite side of the distribution's centre of mass,
// as a thin, far band. Returns a new weight vector.
function addOppositeTail(raw, span) {
  const total = raw.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return raw;
  // Centre of mass, as a fraction of the window.
  const com = raw.reduce((s, w, i) => s + w * i, 0) / total / (span - 1);
  const out = raw.slice();
  // Put the band on the far side of the centre of mass, near (but not at) the
  // window edge, so the extreme itself stays ambiguous.
  const low = com > 0.5;
  const bandCentre = low
    ? Math.floor(span * (0.06 + Math.random() * 0.14))
    : Math.floor(span * (0.80 + Math.random() * 0.14));
  const bandSd = span * (0.03 + Math.random() * 0.06);
  // Target 2-7% of total mass in the band: rare enough to under-show in 25
  // draws, heavy enough to matter when it lands.
  const targetFrac = 0.02 + Math.random() * 0.05;
  const kernel = new Array(span).fill(0);
  for (let i = 0; i < span; i++) {
    kernel[i] = Math.exp(-((i - bandCentre) ** 2) / (2 * bandSd * bandSd));
  }
  const kTot = kernel.reduce((a, b) => a + b, 0);
  if (!(kTot > 0)) return out;
  const scale = (targetFrac * total) / (kTot * (1 - targetFrac));
  for (let i = 0; i < span; i++) out[i] += kernel[i] * scale;
  return out;
}

// Punch holes in the support and ragged the endpoints, so the player can never
// establish the true min or max. Values that carry no mass are simply never
// drawn, and with ~100 candidate values the pattern of holes is unmappable in 25
// draws.
function punchGaps(raw, span) {
  const out = raw.slice();
  // Blank a random fraction of the window in irregular runs.
  const holeFrac = 0.10 + Math.random() * 0.30;
  let blanked = 0;
  let guard = 0;
  while (blanked < span * holeFrac && guard++ < 200) {
    const runLen = 1 + Math.floor(Math.random() * Math.max(2, span * 0.05));
    const at = Math.floor(Math.random() * span);
    for (let i = at; i < Math.min(span, at + runLen); i++) {
      if (out[i] > 0) { out[i] = 0; blanked++; }
    }
  }
  // Always trim a ragged amount off both ends so the endpoints of the SUPPORT
  // are not the endpoints of the WINDOW — the observed extremes then say nothing
  // about where the true bounds are.
  const trimLo = Math.floor(span * Math.random() * 0.06);
  const trimHi = Math.floor(span * Math.random() * 0.06);
  for (let i = 0; i < trimLo; i++) out[i] = 0;
  for (let i = 0; i < trimHi; i++) out[span - 1 - i] = 0;

  // Then FEATHER both ends: scale the outermost live values down steeply so the
  // true extremes are individually very unlikely to be drawn. Without this the
  // support's endpoints carry ordinary mass and a 25-draw sample hits the exact
  // true min or max about 43% of the time — which would let a player pin the
  // bounds, the one thing this mode must never allow. Feathering drops that to
  // a few percent while keeping the values genuinely possible.
  const live = [];
  for (let i = 0; i < span; i++) if (out[i] > 0) live.push(i);
  if (live.length > 6) {
    const featherN = Math.max(3, Math.floor(live.length * (0.08 + Math.random() * 0.14)));
    for (let j = 0; j < featherN && j < live.length; j++) {
      // Steep geometric fade toward each end.
      const f = Math.pow(0.45, featherN - j);
      out[live[j]] *= f;
      out[live[live.length - 1 - j]] *= f;
    }
  }
  return out;
}

// Normalize a raw weight vector to probabilities and compute summary statistics.
// Returns null if the result is degenerate.
//
// Resolution matters here. The old 13-value version snapped probabilities to
// whole percents, which was fine for a coarse deck but would silently delete
// exactly the thin tails this mode depends on — a 0.4% tail would round to zero.
// Probabilities are kept to 1e-4 instead, so a tail can carry well under 1% and
// still be real.
const PROB_UNITS = 10000;

function finalizeDist(shape, raw, span, base, width, regime) {
  const total = raw.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  const units = raw.map((w) => Math.round((w / total) * PROB_UNITS));
  const drift = PROB_UNITS - units.reduce((a, b) => a + b, 0);
  if (drift !== 0) {
    const idx = units.indexOf(Math.max(...units));
    units[idx] = Math.max(1, units[idx] + drift);
  }

  const values = [];
  const probs = [];
  for (let i = 0; i < span; i++) {
    if (units[i] > 0) { values.push(base + i); probs.push(units[i] / PROB_UNITS); }
  }
  if (values.length < 2) return null;

  const mean = values.reduce((s, v, i) => s + v * probs[i], 0);
  const varr = values.reduce((s, v, i) => s + probs[i] * (v - mean) ** 2, 0);
  // The median is what a rank-based ("buy below the middle") player is really
  // trading against, so the gap between it and the mean is the size of the trap.
  let cum = 0;
  let median = values[values.length - 1];
  for (let i = 0; i < values.length; i++) {
    cum += probs[i];
    if (cum >= 0.5) { median = values[i]; break; }
  }
  // Mass sitting on the far side of the mode — the "a surprise is always
  // possible" guarantee. Measured as the mass more than a third of the window
  // away from the mode, on the opposite side to the bulk.
  const modeIdx = probs.indexOf(Math.max(...probs));
  const modeVal = values[modeIdx];
  const bulkLow = modeVal < base + width / 2;
  let oppTailMass = 0;
  for (let i = 0; i < values.length; i++) {
    const far = bulkLow
      ? values[i] > modeVal + width / 3
      : values[i] < modeVal - width / 3;
    if (far) oppTailMass += probs[i];
  }

  return {
    shape,
    regime,
    values,
    probs,
    mean: Math.round(mean * 1000) / 1000,
    sd: Math.round(Math.sqrt(varr) * 1000) / 1000,
    median,
    mode: modeVal,
    // The window this game was played over. Server-side only until the reveal —
    // the player is never told the bounds, which is why the observed extremes
    // can never be trusted as the true ones.
    windowBase: base,
    windowWidth: width,
    oppTailMass: Math.round(oppTailMass * 10000) / 10000,
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

// ---------- House edge ----------
//
// The house charges a size-dependent spread around the card's face value: buying
// q lots costs `card + FEE[q]` each, selling q lots receives `card − FEE[q]` each.
// So a card of 8 fills at 8.3 / 9.5 / 10.8 to buy 1 / 2 / 3, and at 7.7 / 6.5 /
// 5.2 to sell — the mirror image, as specified.
//
// This is not decoration: it is the only thing that makes position sizing a real
// decision. Without a fee, "trade toward the centre at max size" is unbeatable —
// not because the distribution is easy, but because that rule is a noisy version
// of the correct rule, so it is positive-EV against ANY iid distribution. No
// choice of shape can flip that; only a cost on size can. Measured over 25 rounds:
// with no fee, always-size-3 earns +141 against a disciplined player's +111, so
// spamming size wins. At this schedule always-size-3 earns +31 against +68, so
// discipline wins clearly and size 3 has to be justified by a real edge.
//
// The fee is per lot and applies to every lot in the trade (not just the marginal
// one), which is what makes the cost of size super-linear: 3 lots cost 3 × 1.5 =
// 4.5 in fees, not 0.3 + 0.8 + 1.5.
// The fee must scale with the game's value spread, not be an absolute number:
// 0.3 was meaningful against a 13-wide deck and is rounding error against a
// 100-wide window. These are multipliers on the distribution's standard
// deviation, so the cost of size stays proportionate whatever window was rolled.
// Calibrated against the measured edge distribution. A typical |value − trueMean|
// is about 0.82 sd, so these multipliers put the size-1 fee at roughly two thirds
// of a typical edge and the size-3 fee well above it.
//
// This is the level at which an UNINFORMED player stops winning. Measured over 25
// rounds, trading purely on rank ("buy below the middle of what I've seen"):
//
//   fee 0.22/0.48/0.80 -> rank size-1 earns +217 and wins 97% of games
//   fee 0.55/0.90/1.30 -> rank size-1 earns  +28 and wins 56% — a coin flip
//
// while a player who actually estimates the mean and sizes to conviction still
// earns +170 to +221 and wins 90-95%. Pushing the fee higher starts taxing good
// play too (at 0.85/1.20/1.70 the informed sized strategy goes negative), so this
// is the point where the uninformed lose and the informed still win.
export const FEE_SD_MULT = [0, 0.55, 0.90, 1.30];

// Fallback absolute schedule, used only if a caller has no dist to scale against.
export const HOUSE_FEE = [0, 1, 2.6, 5];

// The fee schedule for a given game, in absolute value units.
export function feeSchedule(dist) {
  const sd = dist?.sd;
  if (!(sd > 0)) return HOUSE_FEE.slice();
  return FEE_SD_MULT.map((m) => Math.round(m * sd * 100) / 100);
}

// The price the player actually fills at for `qty` lots on `side`.
export function fillPrice(cardValue, side, qty, dist = null) {
  const sched = dist ? feeSchedule(dist) : HOUSE_FEE;
  const fee = sched[Math.max(0, Math.min(sched.length - 1, qty))] ?? 0;
  const px = side === 'buy' ? cardValue + fee : cardValue - fee;
  return Math.round(px * 100) / 100;
}

// Presentation for a drawn value. Values are now plain numbers over a hidden,
// per-game window rather than playing cards, so there is no rank/suit dressing —
// and, importantly, nothing in the label hints at the range.
export function makeCard(value) {
  return { kind: 'value', label: String(value), value, red: false };
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
// Belief noise, as a MULTIPLIER on the distribution's own standard deviation.
// Absolute values can't work across a randomized window: 0.4 is near-zero noise
// on a 100-wide range and huge on a 13-wide one.
const SIGMA_COHERENT = 0.12;
const SIGMA_NOISY = 0.80;
const TEMP_TRANSPARENT = 2.2;  // sharper: size tracks edge fairly closely
const TEMP_OPAQUE = 0.55;      // flatter: size says little about edge
const LAMBDA_AVERSE = 0.45;
// Edge required per lot of desired size, as a multiple of the distribution's sd.
// |edge| of ~0.6 sd reads as one lot, so max size needs a genuinely large edge.
const SIZE_SCALE_SD = 0.6;
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
      // sigma and sizeScale are stored ABSOLUTE, resolved from the distribution's
      // own spread at spawn, so the bot behaves the same way relative to the game
      // whatever window was rolled.
      sigma: Math.round((noisy ? SIGMA_NOISY : SIGMA_COHERENT) * dist.sd * 1000) / 1000,
      sizeScale: Math.max(0.5, Math.round(SIZE_SCALE_SD * dist.sd * 1000) / 1000),
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
  const desiredSigned = edge / (bot.sizeScale || 1) - bot.lambda * bot.position;
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
// is the running sample mean m_t. Both halves are scored against the price the
// player actually PAID (card ± the house fee for that size), not the card's face
// value — otherwise the fee would vanish from the scoring and a player who
// oversized would be told they had edge they never actually had.
//
//     edge_t = (m_t − fill_t) · signedQty_t
//
// i.e. positive when they traded in the direction the evidence available at the
// time supported, after costs. Their realised PnL for the same trade is
//
//     pnl_t  = (settlement − fill_t) · signedQty_t
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
  let totalFees = 0;
  let passes = 0;
  // Edge the player declined by passing: what one lot in the direction the
  // evidence supported would have earned, after the 1-lot fee. A pass is the
  // right call when this is negative, so summing it says whether the player's
  // restraint was well judged or merely timid.
  let passedEdge = 0;
  const perRound = rounds.map((r, i) => {
    const signed = r.playerSide === 'buy' ? r.playerQty : (r.playerSide === 'sell' ? -r.playerQty : 0);
    const knowable = running[i];
    // Score against the actual fill, so the house fee is charged against both
    // halves of the decomposition rather than disappearing.
    const fill = signed === 0 ? r.card : fillPrice(r.card, r.playerSide, r.playerQty, dist);
    const edge = (knowable - fill) * signed;
    const pnl = (settlement - fill) * signed;
    totalEdge += edge;
    totalPnl += pnl;
    totalFees += signed === 0 ? 0 : Math.abs(fill - r.card) * r.playerQty;
    // Only a DELIBERATE pass counts as restraint. A round where the player never
    // acted (ran out of time, or was blocked by the position limit) is not a
    // judgement call and shouldn't be scored as one.
    if (signed === 0 && r.playerSide === 'pass') {
      passes += 1;
      const dir = knowable > r.card ? 'buy' : (knowable < r.card ? 'sell' : null);
      if (dir) {
        // Edge on one lot in the supported direction, after that size's fee.
        // Negative when the fee eats the whole edge — i.e. passing was right.
        const oneLot = fillPrice(r.card, dir, 1, dist);
        passedEdge += (knowable - oneLot) * (dir === 'buy' ? 1 : -1);
      }
    }
    return {
      round: i + 1,
      card: r.card,
      side: r.playerSide,
      qty: r.playerQty,
      signed,
      knowableFair: Math.round(knowable * 100) / 100,
      // The price actually paid, and the house fee embedded in it.
      fill: Math.round(fill * 100) / 100,
      fee: signed === 0 ? 0 : Math.round(Math.abs(fill - r.card) * r.playerQty * 100) / 100,
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
    // What the player's own sample looked like, for the bounds comparison in the
    // debrief: the observed extremes are almost never the true ones.
    seenMin: rounds.length ? Math.min(...rounds.map((r) => r.card)) : null,
    seenMax: rounds.length ? Math.max(...rounds.map((r) => r.card)) : null,
    seenDistinct: new Set(rounds.map((r) => r.card)).size,
    perRound,
    totalEdge: Math.round(totalEdge * 100) / 100,
    totalPnl: Math.round(totalPnl * 100) / 100,
    // What the house took in spread. Shown separately so a player who oversized
    // can see the cost of it as its own number rather than buried in the edge.
    totalFees: Math.round(totalFees * 100) / 100,
    houseFee: feeSchedule(dist),
    passes,
    // Net edge available on the rounds the player sat out (after the 1-lot fee).
    // Positive means restraint cost them; negative means passing was correct.
    passedEdge: Math.round(passedEdge * 100) / 100,
    // PnL not explained by knowable edge: pure variance.
    variance: Math.round((totalPnl - totalEdge) * 100) / 100,
    botReport,
  };
}

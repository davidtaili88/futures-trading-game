// Game engine: contract definitions, drawing underlying assets,
// settlement computation, and hint generation.
//
// A game is configured by:
//   assetClass : 'dice' | 'cards' | 'numbers'
//   numAssets  : how many underlying assets are drawn (e.g. 4 cards)
//   numRounds  : how many trading rounds; one asset is revealed at the start
//                of each round, up to numAssets. If numRounds < numAssets,
//                some assets are never revealed (they still settle the
//                contract). If numRounds > numAssets, the extra rounds are
//                pure trading with no new reveal.


// ---------- Asset-class definitions ----------
// Each class knows how to draw N assets and the theoretical distribution of a
// single asset value (used for hint computation).

const NUMBER_MIN = 1;
const NUMBER_MAX = 20; // "numbers" = random integers in [1, 20]

const ASSET_CLASSES = {
  cards: {
    label: 'Cards',
    unit: 'card',
    // Cards drawn WITH replacement: each card is an independent uniform rank
    // (A=1…K=13) with a random suit. With replacement keeps every asset iid, so
    // each unseen card's EV is a flat 7 regardless of what's revealed — matching
    // dice/numbers and simplifying EV for players and bots alike. (Ranks and
    // suits can therefore repeat across the drawn cards.)
    draw(n) {
      const suits = ['♠', '♥', '♦', '♣'];
      const rankLabels = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
      return Array.from({ length: n }, () => {
        const value = 1 + Math.floor(Math.random() * 13);
        const s = suits[Math.floor(Math.random() * suits.length)];
        return { kind: 'card', label: `${rankLabels[value - 1]}${s}`, value, red: s === '♥' || s === '♦' };
      });
    },
    sampleValue() {
      return 1 + Math.floor(Math.random() * 13);
    },
    valueMin: 1,
    valueMax: 13,
    maxAssets: 13,
  },

  dice: {
    label: 'Dice',
    unit: 'die',
    // Six-sided dice, sampled with replacement.
    draw(n) {
      return Array.from({ length: n }, () => {
        const v = 1 + Math.floor(Math.random() * 6);
        return { kind: 'die', label: `⚅ ${v}`, value: v };
      });
    },
    sampleValue() {
      return 1 + Math.floor(Math.random() * 6);
    },
    valueMin: 1,
    valueMax: 6,
    maxAssets: 10,
  },

  numbers: {
    label: 'Numbers',
    unit: 'number',
    // Random integers in [NUMBER_MIN, NUMBER_MAX], with replacement.
    draw(n) {
      const span = NUMBER_MAX - NUMBER_MIN + 1;
      return Array.from({ length: n }, () => {
        const v = NUMBER_MIN + Math.floor(Math.random() * span);
        return { kind: 'number', label: `${v}`, value: v };
      });
    },
    sampleValue() {
      const span = NUMBER_MAX - NUMBER_MIN + 1;
      return NUMBER_MIN + Math.floor(Math.random() * span);
    },
    valueMin: NUMBER_MIN,
    valueMax: NUMBER_MAX,
    maxAssets: 10,
  },
};

// ---------- Contract definitions ----------
// Contracts are now asset-class agnostic: each is a settlement function over
// the drawn values plus a name/description. A random contract is chosen each
// game and applied to whatever asset class the players configured.

// ----- Value-set statistics used by several contracts -----
// Median of a value set. Even count → average of the two middle values (so it
// can land on a .5, like the mean hint). Rounded to 2 decimals.
function median(vals) {
  const s = [...vals].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  const m = n % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return Math.round(m * 100) / 100;
}

// The k-th value from the top (nthFromTop(vals, 2) = second highest). Clamps to
// the extremes when there are fewer than k values.
function nthFromTop(vals, k) {
  const s = [...vals].sort((a, b) => b - a);
  return s[Math.min(k - 1, s.length - 1)] ?? 0;
}

// Sum of the two highest values minus sum of the two lowest. With <4 values it
// still works on whatever is available (may overlap), which only matters for the
// tiny games the UI disallows anyway (numAssets ≥ 2, and this contract wants ≥4).
function topTwoMinusBottomTwo(vals) {
  const s = [...vals].sort((a, b) => a - b);
  const n = s.length;
  const bottom = (s[0] ?? 0) + (s[1] ?? 0);
  const top = (s[n - 1] ?? 0) + (s[n - 2] ?? 0);
  return top - bottom;
}

const CONTRACTS = [
  {
    id: 'sum',
    name: 'Sum',
    description: 'Settles to the SUM of all underlying values.',
    settle: (vals) => vals.reduce((a, b) => a + b, 0),
  },
  {
    id: 'product',
    name: 'Product',
    description: 'Settles to the PRODUCT of all underlying values.',
    settle: (vals) => vals.reduce((a, b) => a * b, 1),
  },
  {
    id: 'odds_minus_evens',
    name: 'Odds minus Evens',
    description: 'Sum of ODD underlying values minus sum of EVEN underlying values.',
    settle: (vals) => vals.reduce((acc, v) => acc + (v % 2 === 1 ? v : -v), 0),
  },
  {
    id: 'high_low_spread',
    name: 'High-Low Spread',
    description: 'Highest underlying value minus the lowest, times the number of assets.',
    settle: (vals) => (Math.max(...vals) - Math.min(...vals)) * vals.length,
  },
  {
    id: 'max_plus_min',
    name: 'Max plus Min',
    description: 'Highest underlying value plus the lowest underlying value.',
    settle: (vals) => Math.max(...vals) + Math.min(...vals),
  },
  {
    id: 'median',
    name: 'Median',
    description: 'Settles to the MEDIAN underlying value (average of the two middle values if even).',
    settle: (vals) => median(vals),
  },
  {
    id: 'second_highest',
    name: 'Second Highest',
    description: 'Settles to the SECOND-HIGHEST underlying value.',
    settle: (vals) => nthFromTop(vals, 2),
  },
  {
    id: 'sum_of_squares',
    name: 'Sum of Squares',
    description: 'Settles to the sum of each underlying value SQUARED (Σ v²).',
    settle: (vals) => vals.reduce((a, b) => a + b * b, 0),
  },
  {
    id: 'max_times_min',
    name: 'Max times Min',
    description: 'Highest underlying value MULTIPLIED by the lowest.',
    settle: (vals) => Math.max(...vals) * Math.min(...vals),
  },
  {
    id: 'count_above_k',
    name: 'Count ≥ K',
    description: 'Settles to how many underlying values are GREATER THAN OR EQUAL TO K (K is fixed for the game).',
    // K is rolled per game and stored on game.contract.params.k; passed in here.
    settle: (vals, params = {}) => {
      const k = params.k ?? Math.max(...vals);
      return vals.filter((v) => v >= k).length;
    },
  },
  {
    id: 'high_low_mean',
    name: 'High − Low − Mean',
    description: 'Highest minus lowest, minus the mean of all values. Can settle negative.',
    settle: (vals) => {
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      return Math.round((Math.max(...vals) - Math.min(...vals) - mean) * 100) / 100;
    },
  },
  {
    id: 'top2_minus_bottom2',
    name: 'Top-two minus Bottom-two',
    description: 'Sum of the two HIGHEST values minus the sum of the two LOWEST. Can settle negative.',
    settle: (vals) => topTwoMinusBottomTwo(vals),
  },
];

// Per-game contract parameters, rolled once in newGame and stored on the game's
// contract so every settle/estimate uses the same value. Currently only
// count_above_k needs one: a threshold K for the asset class.
//
// K is rolled from the MIDDLE HALF of the value range (the interquartile band),
// not the full span. A K near the extremes makes the count almost always 0 or n
// — a near-constant, uncertainty-free contract with no reason to trade. Keeping K
// central means the count genuinely varies with the draw, so there's real edge.
function rollContractParams(contract, cls) {
  if (contract.id === 'count_above_k') {
    const min = cls.valueMin ?? 1;
    const max = cls.valueMax ?? 13;
    const span = max - min;
    const lo = min + Math.max(1, Math.round(span * 0.25)); // ~lower quartile
    const hi = min + Math.max(1, Math.round(span * 0.75)); // ~upper quartile
    const k = hi >= lo ? lo + Math.floor(Math.random() * (hi - lo + 1)) : lo;
    return { k };
  }
  return {};
}

// Contract name shown in the UI, incorporating any rolled parameters (e.g. the
// concrete K for the count contract, so players see "Count ≥ 4").
function contractDisplayName(contract, params = {}) {
  if (contract.id === 'count_above_k' && params.k != null) return `Count ≥ ${params.k}`;
  return contract.name;
}

function makeHintCards(contract, assets) {
  const vals = assets.map((a) => a.value);
  const n = vals.length;
  const mn = Math.min(...vals);
  const mx = Math.max(...vals);
  const sum = vals.reduce((a, b) => a + b, 0);
  const mean = Math.round((sum / n) * 100) / 100;
  const range = mx - mn;

  // Hide max & min when knowing both would (help) reconstruct the settlement:
  //  • high_low_spread = (max−min)·n, max_plus_min = max+min,
  //  • max_times_min   = max·min,     high_low_mean = max−min−mean.
  const hideMaxMin = contract.id === 'high_low_spread' || contract.id === 'max_plus_min'
    || contract.id === 'max_times_min' || contract.id === 'high_low_mean';

  const cards = [];

  // Every hint carries a `tier` ('good' | 'medium' | 'bad') describing roughly
  // how much it pins down. Tier is internal only — it is NOT sent to clients
  // (players must judge their own signal's worth). See stripHintForClient.

  // ----- Existing stat hints -----
  if (!hideMaxMin) {
    cards.push({ key: 'min', label: 'Asset Min', value: mn, tier: 'good' });
    cards.push({ key: 'max', label: 'Asset Max', value: mx, tier: 'good' });
  }

  // Mean * numAssets = settlement for sum — too revealing. Also part of the
  // high_low_mean reconstruction (max−min−mean), so hide it there too.
  if (contract.id !== 'sum' && contract.id !== 'high_low_mean') {
    cards.push({ key: 'mean', label: 'Asset Mean', value: mean, tier: 'good' });
  }

  // Range * numAssets = settlement for high_low_spread — too revealing.
  if (contract.id !== 'high_low_spread') {
    cards.push({ key: 'range', label: 'Asset Range (Max − Min)', value: range, tier: 'medium' });
  }

  // ----- Good: exact value of one random COMMUNITY asset -----
  // Private cards are never passed into this function, so this can only ever
  // reveal a community asset. Safe for every contract (one of many assets).
  // `idx` is stored so a hint can be re-evaluated on a candidate community set.
  {
    const idx = Math.floor(Math.random() * n);
    cards.push({ key: 'exact', idx, label: `Asset #${idx + 1} exact value`, value: vals[idx], tier: 'good' });
  }

  // ----- Medium: count of assets ≥ a RANDOM threshold -----
  // Threshold rolled once here (cached in game.hintCards), so it's stable across
  // reconnects. An extreme roll makes this hint useless — that's intentional:
  // the holder must judge how much their own signal is worth. `threshold` stored
  // for re-evaluation. Hidden entirely for count_above_k, where a threshold-count
  // hint could reconstruct the settlement (it IS a threshold count).
  if (contract.id !== 'count_above_k') {
    const t = mn + Math.floor(Math.random() * (Math.max(1, range) + 1)); // in [min, max]
    const k = vals.filter((v) => v >= t).length;
    cards.push({ key: 'count_above', threshold: t, label: `Assets ≥ ${t}`, value: k, tier: 'medium' });
  }

  // ----- Medium: count of odd assets -----
  // Directly reconstructs odds_minus_evens when combined with the sum, so hide there.
  if (contract.id !== 'odds_minus_evens') {
    const kOdd = vals.filter((v) => v % 2 === 1).length;
    cards.push({ key: 'count_odd', label: 'Odd-valued assets', value: kOdd, tier: 'medium' });
  }

  // ----- Bad: number of assets above the mean -----
  {
    const kAbove = vals.filter((v) => v > mean).length;
    cards.push({ key: 'above_mean', label: 'Assets above the mean', value: kAbove, tier: 'bad' });
  }

  // ----- Bad: sum parity -----
  // Too revealing for odds_minus_evens (parity of that settlement follows directly).
  if (contract.id !== 'odds_minus_evens') {
    cards.push({ key: 'parity', label: 'Sum parity', value: sum % 2 === 0 ? 'even' : 'odd', tier: 'bad' });
  }

  return cards;
}

// Remove server-only fields (e.g. `tier`) before sending a hint to a client.
// Players must judge their own signal's strength, so tier is never exposed.
export function stripHintForClient(card) {
  if (!card) return card;
  const { tier, ...rest } = card;
  return rest;
}

// Probability each player's hint lands in a given tier. Rolled INDEPENDENTLY
// per player (so two players can both get good, or both bad). Tune here.
export const HINT_TIER_WEIGHTS = { good: 0.2, medium: 0.6, bad: 0.2 };

// Roll a single hint for one player: pick a tier by HINT_TIER_WEIGHTS, then a
// uniform-random hint from that tier. Duplicates across players are allowed.
// If the rolled tier has no available hints (some contracts lack a tier after
// the too-revealing guards), re-roll weighting only over non-empty tiers.
export function rollHintByTier(cards) {
  if (!cards || !cards.length) return null;
  const byTier = { good: [], medium: [], bad: [] };
  for (const c of cards) (byTier[c.tier] ?? (byTier[c.tier] = [])).push(c);

  // Keep only tiers that actually have hints, renormalizing their weights.
  const avail = Object.keys(byTier).filter((t) => byTier[t].length && HINT_TIER_WEIGHTS[t] > 0);
  if (!avail.length) return cards[Math.floor(Math.random() * cards.length)];
  const total = avail.reduce((s, t) => s + HINT_TIER_WEIGHTS[t], 0);

  let r = Math.random() * total;
  let tier = avail[avail.length - 1];
  for (const t of avail) {
    if (r < HINT_TIER_WEIGHTS[t]) { tier = t; break; }
    r -= HINT_TIER_WEIGHTS[t];
  }
  const pool = byTier[tier];
  return pool[Math.floor(Math.random() * pool.length)];
}

// Validate + clamp incoming settings to safe bounds.
export function normalizeSettings(s = {}) {
  const classKey = ASSET_CLASSES[s.assetClass] ? s.assetClass : 'cards';
  const cls = ASSET_CLASSES[classKey];
  let numAssets = parseInt(s.numAssets, 10);
  if (!Number.isFinite(numAssets)) numAssets = 5;
  numAssets = Math.max(2, Math.min(cls.maxAssets, numAssets));
  let numRounds = parseInt(s.numRounds, 10);
  if (!Number.isFinite(numRounds)) numRounds = numAssets;
  numRounds = Math.max(1, Math.min(20, numRounds));
  // privatePerPlayer: hole cards each player privately holds; they count toward
  // settlement but are never revealed publicly. 0 disables the private-card model.
  let privatePerPlayer = parseInt(s.privatePerPlayer, 10);
  if (!Number.isFinite(privatePerPlayer)) privatePerPlayer = 0;
  privatePerPlayer = Math.max(0, Math.min(3, privatePerPlayer));
  // numBots: computer players added to the game (both trading modes). 0 disables bots.
  let numBots = parseInt(s.numBots, 10);
  if (!Number.isFinite(numBots)) numBots = 0;
  numBots = Math.max(0, Math.min(8, numBots));
  const contractId = CONTRACTS.find((c) => c.id === s.contractId) ? s.contractId : null;
  return { assetClass: classKey, numAssets, numRounds, privatePerPlayer, numBots, contractId };
}

export function defaultSettings() {
  return { assetClass: 'cards', numAssets: 5, numRounds: 5, privatePerPlayer: 0, numBots: 0, contractId: null, roundDuration: 60, positionLimit: 10 };
}

// Draw `count` private (hole) assets for a single player from the game's asset
// class. Drawn independently of the community pool (with replacement for
// dice/numbers; cards are drawn fresh, so ranks can repeat across players —
// acceptable for a training game).
export function drawPrivateAssets(game, count) {
  const cls = ASSET_CLASSES[game.contract.assetClass];
  return cls.draw(count);
}

// Recompute settlement over the community pool plus every player's private
// assets. `privateValues` is a flat array of all players' private asset values.
export function computeSettlement(game, privateValues = []) {
  const contract = CONTRACTS.find((c) => c.id === game.contract.id);
  const vals = game.assets.map((a) => a.value).concat(privateValues);
  return contract.settle(vals, game.contract.params ?? {});
}

// Monte Carlo fair-value estimate for a bot, over ALL contract types.
// The bot knows: `revealedValues` (community assets revealed so far) and
// `ownPrivateValues` (its own hole cards). It does NOT know the unrevealed
// community assets (`hiddenCommunityCount`) or other players' private cards
// (`otherPrivateCount`). We simulate those unknowns `sims` times, run the
// contract's settle over the full value set, and return the mean (fair) and
// standard deviation (uncertainty / confidence signal).
//
// If `hint` (the bot's own hint card) is supplied, the simulation is CONDITIONED
// on it by rejection sampling: hints are statistics over the FULL community set
// (revealed + hidden), so we resample the hidden community assets until the
// candidate set reproduces the hint's value, then settle. Rejection is capped
// (maxAttemptsPerSim) and falls back to an unconstrained draw if the hint is too
// tight to hit — so the estimator never hangs.
export function estimateFair(game, {
  revealedValues = [],
  ownPrivateValues = [],
  hiddenCommunityCount = 0,
  otherPrivateCount = 0,
  hint = null,
  sims = 500,
} = {}) {
  const cls = ASSET_CLASSES[game.contract.assetClass];
  const contract = CONTRACTS.find((c) => c.id === game.contract.id);
  const hidden = Math.max(0, hiddenCommunityCount);
  const others = Math.max(0, otherPrivateCount);
  const useHint = hint && hintIsEvaluable(hint);
  const maxAttemptsPerSim = 200;

  let sum = 0;
  let sumSq = 0;
  const n = Math.max(1, sims);
  for (let i = 0; i < n; i++) {
    // Draw the hidden community assets, conditioned on the hint if present.
    let hiddenVals;
    if (useHint) {
      let ok = false;
      for (let a = 0; a < maxAttemptsPerSim; a++) {
        hiddenVals = Array.from({ length: hidden }, () => cls.sampleValue());
        if (hintMatches(hint, revealedValues.concat(hiddenVals))) { ok = true; break; }
      }
      if (!ok) hiddenVals = Array.from({ length: hidden }, () => cls.sampleValue()); // fallback
    } else {
      hiddenVals = Array.from({ length: hidden }, () => cls.sampleValue());
    }

    const vals = revealedValues.concat(hiddenVals, ownPrivateValues);
    for (let u = 0; u < others; u++) vals.push(cls.sampleValue()); // other players' privates
    const s = contract.settle(vals, game.contract.params ?? {});
    sum += s;
    sumSq += s * s;
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return { fair: mean, stdev: Math.sqrt(variance) };
}

// Can this hint be re-evaluated on a candidate community set? (All current hint
// keys can; guards future/unknown keys so they're simply ignored, not crashed on.)
function hintIsEvaluable(hint) {
  return hint && HINT_EVALUATORS[hint.key] !== undefined;
}

// Recompute what a hint's value WOULD be for a given full community set, so the
// simulation can accept/reject candidates. One evaluator per hint key; the value
// is compared against the hint's actual `value`.
const HINT_EVALUATORS = {
  min: (v) => Math.min(...v),
  max: (v) => Math.max(...v),
  mean: (v) => Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100,
  range: (v) => Math.max(...v) - Math.min(...v),
  exact: (v, hint) => v[hint.idx],
  count_above: (v, hint) => v.filter((x) => x >= hint.threshold).length,
  count_odd: (v) => v.filter((x) => x % 2 === 1).length,
  above_mean: (v) => {
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    return v.filter((x) => x > m).length;
  },
  parity: (v) => (v.reduce((a, b) => a + b, 0) % 2 === 0 ? 'even' : 'odd'),
};

function hintMatches(hint, communityValues) {
  const evalFn = HINT_EVALUATORS[hint.key];
  if (!evalFn) return true; // unknown hint: don't constrain
  return evalFn(communityValues, hint) === hint.value;
}

// Expose contract metadata for the settings UI.
export function contractInfo() {
  return CONTRACTS.map(({ id, name, description }) => ({ id, name, description }));
}

// Expose class metadata for the settings UI.
export function assetClassInfo() {
  return Object.entries(ASSET_CLASSES).map(([key, c]) => ({
    key, label: c.label, unit: c.unit, maxAssets: c.maxAssets,
  }));
}

export function newGame(rawSettings) {
  const settings = normalizeSettings(rawSettings);
  const cls = ASSET_CLASSES[settings.assetClass];
  const contract = settings.contractId
    ? CONTRACTS.find((c) => c.id === settings.contractId)
    : CONTRACTS[Math.floor(Math.random() * CONTRACTS.length)];
  const assets = cls.draw(settings.numAssets);
  // Roll any per-game contract parameters (currently just K for count_above_k).
  const params = rollContractParams(contract, cls);
  const settlement = contract.settle(assets.map((a) => a.value), params);
  const hintCards = makeHintCards(contract, assets);
  return {
    settings,
    contract: {
      id: contract.id,
      name: `${contractDisplayName(contract, params)} of ${cls.label}`,
      description: contract.description,
      assetClass: settings.assetClass,
      assetLabel: cls.label,
      unit: cls.unit,
      numAssets: settings.numAssets,
      numRounds: settings.numRounds,
      params,
    },
    assets,                 // full set (server-side truth)
    settlement,             // final settlement value (server-side truth)
    hintCards,
    round: 0,               // current round number (0 = not started)
  };
}

// Round N reveals N assets (round 1 reveals 1, round 2 reveals 2, etc.)
export function revealedForRound(game) {
  return Math.min(Math.max(0, game.round), game.assets.length);
}

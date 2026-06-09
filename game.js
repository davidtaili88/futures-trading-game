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

// ---------- Random helpers ----------
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Asset-class definitions ----------
// Each class knows how to draw N assets and the theoretical distribution of a
// single asset value (used for hint computation).

const NUMBER_MIN = 1;
const NUMBER_MAX = 20; // "numbers" = random integers in [1, 20]

const ASSET_CLASSES = {
  cards: {
    label: 'Cards',
    unit: 'card',
    // Standard 52-card deck, drawn without replacement. Value = rank (A=1…K=13).
    draw(n) {
      const suits = ['♠', '♥', '♦', '♣'];
      const ranks = [
        { label: 'A', value: 1 }, { label: '2', value: 2 }, { label: '3', value: 3 },
        { label: '4', value: 4 }, { label: '5', value: 5 }, { label: '6', value: 6 },
        { label: '7', value: 7 }, { label: '8', value: 8 }, { label: '9', value: 9 },
        { label: '10', value: 10 }, { label: 'J', value: 11 }, { label: 'Q', value: 12 },
        { label: 'K', value: 13 },
      ];
      const deck = [];
      for (const s of suits) {
        for (const r of ranks) {
          deck.push({ kind: 'card', label: `${r.label}${s}`, value: r.value, red: s === '♥' || s === '♦' });
        }
      }
      return shuffle(deck).slice(0, n);
    },
    sampleValue() {
      return 1 + Math.floor(Math.random() * 13);
    },
    maxAssets: 13, // keep it sane; plenty for a single suit's worth
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
    maxAssets: 10,
  },
};

// ---------- Contract definitions ----------
// Contracts are now asset-class agnostic: each is a settlement function over
// the drawn values plus a name/description. A random contract is chosen each
// game and applied to whatever asset class the players configured.

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
];

// Monte-Carlo hint computation against the theoretical single-asset
// distribution, so a single hint never gives away the realized draw.
function computeHints(contract, assetClass, numAssets) {
  const SAMPLES = 20000;
  let mn = Infinity, mx = -Infinity, total = 0;
  for (let s = 0; s < SAMPLES; s++) {
    const vals = new Array(numAssets);
    for (let i = 0; i < numAssets; i++) vals[i] = assetClass.sampleValue();
    const v = contract.settle(vals);
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    total += v;
  }
  const mean = total / SAMPLES;
  return {
    min: Math.round(mn),
    max: Math.round(mx),
    mean: Math.round((total / SAMPLES) * 100) / 100,
    range: Math.round(mx - mn),
  };
}

function makeHintCards(hints, assets) {
  const vals = assets.map((a) => a.value);
  const assetRange = Math.max(...vals) - Math.min(...vals);
  return [
    { key: 'min', label: 'Minimum Value', value: hints.min },
    { key: 'max', label: 'Maximum Value', value: hints.max },
    { key: 'mean', label: 'Mean (Expected) Value', value: hints.mean },
    { key: 'range', label: 'Asset Range (Max − Min)', value: assetRange },
  ];
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
  const contractId = CONTRACTS.find((c) => c.id === s.contractId) ? s.contractId : null;
  return { assetClass: classKey, numAssets, numRounds, contractId };
}

export function defaultSettings() {
  return { assetClass: 'cards', numAssets: 5, numRounds: 5, contractId: null };
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
  const settlement = contract.settle(assets.map((a) => a.value));
  const hints = computeHints(contract, cls, settings.numAssets);
  const hintCards = makeHintCards(hints, assets);
  return {
    settings,
    contract: {
      id: contract.id,
      name: `${contract.name} of ${cls.label}`,
      description: contract.description,
      assetClass: settings.assetClass,
      assetLabel: cls.label,
      unit: cls.unit,
      numAssets: settings.numAssets,
      numRounds: settings.numRounds,
    },
    assets,                 // full set (server-side truth)
    settlement,             // final settlement value (server-side truth)
    hintCards,
    round: 0,               // current round number (0 = not started)
  };
}

// How many assets are revealed given the current round: one per round, capped
// at the number of assets drawn.
export function revealedForRound(game) {
  return Math.min(game.round, game.assets.length);
}

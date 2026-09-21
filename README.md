# 📈 Trading Games v1

A multiplayer futures-contract trading game. Players trade a contract whose settlement
value is a **secret arithmetic result** of randomly drawn underlying assets (cards, dice,
or numbers). Each round reveals one more asset; at settlement, all open positions cash out
at the true value. Highest PnL wins.

## Features

- **Real-time multiplayer** via Socket.IO — share a URL with others to play in the same room.
- **Per-room isolation** — each URL hash (`/#room-name`) is a separate independent game.
- **Configurable game settings** at the start of every game:
  - **Asset class** — Cards (A=1…K=13), Dice (d6), Numbers (1–20), Trials (Bernoulli outcomes), or Poisson (event counts).
  - **Contract type** — Sum, Product, Odds minus Evens, High-Low Spread, Max plus Min, Median, Second Highest, Sum of Squares, Max times Min, Count ≥ K, High − Low − Mean, Top-two minus Bottom-two, or Random.
  - **Trials (Bernoulli) contracts** — pick the Trials asset class to trade a sequence of independent success/fail trials with an adjustable success probability. One result is revealed per round (round duration = time between results).
    - **Successes** (default) — settles to the concrete number of successful trials.
    - **Series mode** — a race: pays **$1.00** if successes reach an adjustable target before the trials run out, else **$0.00**, and settles **early** the moment the outcome is clinched. E.g. Leo vs William, best-of-seven first-to-four, Leo winning 60% of matches with a result every 15s: 7 trials, p=0.6, target 4, round duration 15.
  - **Poisson Process contract** — pick the Poisson asset class to trade the value of a Poisson process with an adjustable intensity λ. Each round reveals one interval's event count (a Poisson(λ) draw); the contract settles to the running total across all intervals.
  - **Number of assets** and **number of rounds**.
  - **Tick size** — the minimum price increment (default 0.01; selectable up to 1). Every order and quote price, from humans and bots, snaps to this grid.
- **Per-player hints** — each player gets one randomly assigned hint (Min, Max, Mean, or Asset Range), hidden by default.
- **Market Making Mode** — before each round, players bid a spread margin. The tightest quote wins and becomes the market maker, setting their own bid/ask prices. All other players trade at those prices.
- **Signal Reading Mode** — a single-player inference game (see below).
- **Trade ticket**, **live leaderboard** (mark-to-market PnL), and **trade tape**.

---

## Signal Reading Mode

A single-player game about **inference**, not market making. Turn it on with the violet
toggle in the settings panel; it overrides the asset class, contract and trading model.

Each round one **value** is drawn from a **hidden** distribution and revealed. You may buy
or sell **1–3 lots against the house**, or press **No Trade** to pass — one action per round.
After the last round the contract settles to **one fresh draw from the same hidden
distribution**.

Nothing about the distribution is disclosed while you play: not its shape, not its spread,
and not even the range of values it runs over. The range is itself rolled per game — a
window roughly 100 wide, placed anywhere from about 10 to 400 — so you cannot anchor on a
fixed scale and must infer the level as well as the shape. The window is bounded on purpose:
an unbounded range would let one freak draw hundreds of units away decide the entire game,
which is variance masquerading as difficulty.

That settlement rule is what gives the mode its spine: because the settlement draw comes
from the same distribution as the reveals, **fair value is the distribution's mean**, and
every value you see is a sample of it. A position of `q` lots bought at fill price `p` pays
`(settlement − p) · q`, so your edge on a buy is `trueMean − p` — a quantity you must
estimate and are never told.

The house charges a spread that widens with size, scaled to each game's own spread (so it
stays proportionate whatever window was rolled). The fee applies to every lot in the trade,
which makes the cost of size super-linear.

### Why the distributions are shaped the way they are

The distributions are **adversarial by construction**, built so that "buy anything below the
middle of what I've seen, sell anything above it" is not a winning strategy. Six shapes —
`tailUp`, `tailDown`, `multimodal`, `cliff`, `scatter`, `plateau` — weighted toward the tail
shapes, because those are the ones that actually break a rank-based read: measured as
(observed range midpoint − true mean) / sd, the tail shapes displace the naive proxy by about
**1.15 sd** and do it consistently in one direction, while the symmetric shapes manage only
0.23–0.47.

Three properties are enforced on every distribution:

- **The bounds are unknowable.** The support has gaps, and both ends are feathered so the
  outermost values are individually very unlikely. Over 25 draws a player hits the exact true
  minimum in about **6%** of games (it was 45% before feathering) and the true maximum in
  **3%**; the observed range typically falls ~10 short at each end.
- **A surprise is always possible.** Whatever side the mass sits on, a thin band of mass is
  guaranteed on the far side, so a high-concentrated distribution can still print a
  substantially lower value. This is applied *after* the gap-punching, so feathering cannot
  erase it.
- **Genuine multimodality and skew.** Several shapes place 2–4 separated modes with large
  weight ratios, so the sample looks like it is centring on one level while the mean sits
  elsewhere.

Support averages ~69 distinct values with ~14 seen per 25-round game, so a game is never two
values repeating — the point of moving off a 13-card deck.

### Making the uninformed player lose

There is a limit to what distribution shape alone can do, and it is worth stating plainly:
**no iid distribution can make "trade toward the centre" unprofitable**, because that rule is
a noisy version of the correct one and so is positive-EV against any distribution. Skew
reduces its edge but never flips it negative.

The house spread is what closes that hole. It is calibrated against the measured edge
distribution — a typical `|value − trueMean|` is about 0.82 sd — at **0.55 / 0.90 / 1.30 sd**
for 1 / 2 / 3 lots. That is the level at which the uninformed stop winning while the informed
still do:

| Strategy | Avg edge | Games won |
| --- | --- | --- |
| **Uninformed**: rank-based, always size 3 | −962 | 0% |
| **Uninformed**: rank-based, sized by conviction | −202 | 22% |
| **Uninformed**: rank-based, always size 1 | +36 | 64% |
| **Informed**: running mean, always size 3 | −887 | 0% |
| **Informed**: running mean, sized by conviction | +140 | 92% |
| **Informed**: running mean, patient | **+183** | **98%** |

Blind max-sizing is wiped out, rank-based play is at best a coin flip, and only estimating
the mean and sizing to conviction reliably wins. Raising the fee further starts taxing good
play too, so this is the point where the uninformed lose and the informed still win.

### The bots are signal, not counterparties

Bots trade publicly alongside you, but **you never trade against them** — your fill is
always the house price. Their only role is to leak information. Each bot holds a **private
burn-in sample** of the same hidden distribution that you never see, so a well-informed bot
genuinely knows more than you do early on, while your own running mean catches up as the
reveals accumulate. Knowing *when to stop deferring* to a bot is the core skill (with the
default settings the crossover lands around round 13 of 25).

Every bot's traits are **independent coin flips**, fixed at spawn for the whole game:

| Trait | Heads | Tails |
| --- | --- | --- |
| Bias | saw 12 private draws — near-unbiased | saw 3 — badly biased, but plausibly so |
| Coherence | low belief noise: near-fixed threshold | high noise: contradicts itself |
| Sizing | readable — size tracks perceived edge | opaque — size says little about edge |
| Inventory | trades freely | inventory-shy: sizes down when long |

Two deliberate design points. Sizes are drawn from a **softmax** over `{0,1,2,3}` rather
than computed from edge, because a deterministic size would make each trade an exact
interval reveal on the bot's belief — two or three trades would pin it by constraint-solving
instead of inference. And an **inventory-shy** bot will sometimes sell a cheap card simply
because it is too long; that looks incoherent from outside but isn't, so a player who tracks
the inventory trail (shown on the bot tape) can untangle what a casual player cannot.

The two hidden axes show up as genuinely independent observables: coherence is readable from
how well one threshold explains a bot's trades (~92% vs ~75%), and bias from how often it
disagrees with your own running mean and whether it is right when it does (~58% vs ~39%).

### The debrief

At the end everything is revealed: the true distribution and its mean, the mean of the
sample you actually saw, and every bot's traits, private sample size and estimate.

The part that matters most is the **edge vs luck** split. Each round is re-scored against
the running mean of the cards revealed *up to that point* — the best estimate available at
the time, not the answer you have afterwards — and against the price you actually paid, so
the house spread is charged to your edge rather than hidden. Edge is the PnL your decisions
earned given what was knowable; luck is the remainder, and the two always sum to your
realised PnL. A positive-edge, negative-PnL game means you played well and the cards went
against you, which is precisely the outcome a naive scoreboard would punish you for.

The reveal also shows the true **median** beside the mean, the true range of values against
the range you actually saw, and how much mass sat on the far side of the mode — so you can
see the size of the trap you were trading against, what you paid the house in spread, and how
your **passes** scored — the edge you declined on the rounds you sat out, after fees. Negative means passing
was the right call; positive means you were too timid.

Settings: **rounds** (5–60, default 25) and **signal bots** (0–6, default 3). Note that more
bots makes the game *easier*, not harder — several independent noisy estimates average out.

---

## Hosting on Render (free, no credit card)

This is the recommended way to host the game so anyone can join from a link.

### 1. Fork or push to GitHub

Make sure your code is in a GitHub repository.

### 2. Create a Render account

Go to [render.com](https://render.com) and sign up with GitHub. No credit card required.

### 3. Create a new Web Service

1. Click **New** → **Web Service**
2. Connect your GitHub repository
3. Render will detect `render.yaml` automatically and pre-fill the settings:
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
4. Click **Deploy Web Service**

### 4. Wait for the deploy (~2 minutes)

Once it's done, Render gives you a URL like:
```
https://trading-game-xxxx.onrender.com
```

### 5. Share the link

Send players a URL with a room hash:
```
https://trading-game-xxxx.onrender.com/#your-room-name
```

Anyone who opens the same URL plays in the same room. Different hashes = different independent games.

### Notes on the free tier

- The server **sleeps after 15 minutes of inactivity**. The first player to open the link after a sleep will see the start button say "Connecting to server…" for up to 60 seconds while it wakes up. It becomes clickable once connected.
- After waking, the game runs normally for all players.
- To keep it awake during a session, just leave the tab open.

---

## Run locally

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). To play with others on the same network, share `http://<your-local-ip>:3000`.

---

## Project structure

- `server.js` — Express + Socket.IO server; room management, game state, trading, market making, round/settlement logic.
- `game.js` — game engine: asset classes, contracts, drawing, settlement, hint generation.
- `signal.js` — Signal Reading mode: the hidden distribution, the signal bots, and the edge/luck debrief scoring.
- `public/` — frontend (`index.html`, `styles.css`, `app.js`).
- `render.yaml` — Render deployment config.

## Tech

Node.js, Express, Socket.IO, vanilla HTML/CSS/JS. No build step.

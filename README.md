# 📈 Futures Trading Game

A multiplayer, futures-contract-style trading game for localhost. Players trade a
contract whose settlement value is a **secret arithmetic result** of randomly drawn
underlying assets (cards, dice, or numbers). Each round reveals one more asset; at
settlement, all open positions cash out at the true value. Highest PnL wins.

## Features

- **Real-time multiplayer** over Socket.IO (one shared room — open multiple tabs or
  play across devices on your network).
- **Configurable game settings** (shown at start and on Restart):
  - **Asset class** — Cards (standard 52-card deck, A=1…K=13), Dice (d6), or Numbers (1–20).
  - **Number of assets** — how many are drawn (e.g. 4 cards vs. 3).
  - **Number of rounds** — independent of asset count. One asset is revealed per round:
    - `rounds < assets` → some assets stay hidden at settlement (but still count).
    - `rounds > assets` → all reveal, then extra pure-trading rounds.
- **Random contract each game**, applied to the chosen asset class:
  - Sum, Product, Odds minus Evens, High-Low Spread, Max plus Min.
- **Per-player hints** (Min, Max, Mean, Range) computed via Monte-Carlo against the
  theoretical distribution — **hidden by default, click to reveal / hide**.
- **Trade ticket** (buy/sell with qty & price), **live leaderboard** (mark-to-market
  PnL), and a **trade tape**.

## Run it

```bash
npm install
npm start
```

Then open <http://localhost:3000>. To play with others, share `http://<your-ip>:3000`
on the same network. Enter a name, pick settings, and hit **Start Game**.

## Project structure

- `server.js` — Express + Socket.IO server; game state, trading, round/settlement logic.
- `game.js` — game engine: asset classes, contracts, drawing, settlement, hint generation.
- `public/` — frontend (`index.html`, `styles.css`, `app.js`).

## Tech

Node.js, Express, Socket.IO, vanilla HTML/CSS/JS. No build step.

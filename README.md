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
- **Per-player hints** — each player gets one randomly assigned hint (Min, Max, Mean, or Asset Range), hidden by default.
- **Market Making Mode** — before each round, players bid a spread margin. The tightest quote wins and becomes the market maker, setting their own bid/ask prices. All other players trade at those prices.
- **Trade ticket**, **live leaderboard** (mark-to-market PnL), and **trade tape**.

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
- `public/` — frontend (`index.html`, `styles.css`, `app.js`).
- `render.yaml` — Render deployment config.

## Tech

Node.js, Express, Socket.IO, vanilla HTML/CSS/JS. No build step.

# Blockchain Breakout

Endless runner PWA with a Netlify Blobs leaderboard and the Meme power-up.

```
public/                 the game (index.html), manifest, service worker, icons
netlify/functions/      leaderboard.mts, the /api/leaderboard endpoint
netlify/lib/core.mjs    leaderboard logic (validation, ranking, anti-cheat)
test/                   unit tests and a local dev server
netlify.toml            publishes public/, functions from netlify/functions
```

## Deploy

The Netlify site already exists: **blockchain-breakout** (site id `2e339c16-b2bc-4523-8398-a365df00a8b1`,
https://blockchain-breakout.netlify.app). The `LEADERBOARD_SECRET` environment variable is already set on it.
It has not been deployed yet.

Pick one:

1. **Git (best, builds and installs dependencies for you).** Push this folder to a GitHub repo, then in Netlify
   open the blockchain-breakout site, go to Site configuration, Build & deploy, Link repository. Leave the build
   command empty. Publish directory is read from `netlify.toml`.
2. **CLI.** From this folder:
   ```
   npm install
   npx netlify-cli deploy --prod --site 2e339c16-b2bc-4523-8398-a365df00a8b1
   ```

Dragging only the `public` folder into Netlify will deploy the game but not the leaderboard function.

## Test locally

```
npm test                       # leaderboard logic, 19 tests
node test/dev-server.mjs       # http://localhost:8788 with the real leaderboard code, in memory
```

## How the leaderboard resists cheating

* A run starts by asking the server for a signed token. A score is only accepted with a valid token, and the
  claimed run time cannot be longer than the real time since the token was issued.
* Distance, fragments and bonus points must be plausible for the run time, using the game's own speed limits.
* Names are protected by a 4 to 8 digit PIN (stored as a salted hash). Submissions are rate limited per player
  and per IP.
* It cannot stop a determined cheater who replays the game logic, but it stops casual console edits and
  made-up scores.

## Events

Four events interrupt the run. Add `#rug`, `#halv`, `#cold` or `#hack` to the URL to trigger them after 4 seconds for testing. Runs started from those links are never posted to the leaderboard.

* **Rug Pull** (green drone): scan, 5 second warning, 12 rows of cracking floor. +50 per row, +300 for surviving.
* **The Halving**: 5 second warning, then the road forks into two chains for about 3 seconds. The longest chain is bright with a fragment
  trail and the higher height sign, the orphan is dim and flickering. Right chain: +300 and a x3 Bull Run for 12 seconds. Wrong chain:
  score halved, then a x2 Bull Run. Nothing in the fork can kill you. First one arrives around 70 to 85 seconds, then every 95 to 135 seconds
  after the bull run ends. Events never overlap. The game reports `forks` and `halvings` with the score so the leaderboard can allow for them.
  The fork itself runs about 7 seconds with fragments to collect and arcs to jump, then a reveal banner shows the result.
* **Cold Storage**: 3 second warning, then 11 seconds where the score freezes and the road turns to ice (lane changes slide past and settle back). Fragments become gems, and each gem moves 1% of the current score into the vault, up to half the score. The Halving only halves the unbanked part and a hack hit cannot take banked points. First one comes 36 to 44 seconds in, then every 80 to 110 seconds. The submit payload carries `colds`, and the server allows the frozen distance for each one.
* **The Hack**: 3 second warning, then 13 seconds of screen interference (tearing, static, scanlines, colour fringing, a glitching score).
  Phantom blocks and firewalls flicker and cannot hurt you (+15 for walking through one). Real hazards hold still and follow the usual
  fair patterns, but a real hit during the hack costs 500 points (capped at your score) instead of ending the run. Surviving it gives +200.
  First one arrives around 48 to 58 seconds, then every 70 to 100 seconds. The game reports `hacks` and `hits` so the leaderboard can allow for them.

## Tuning

Meme mode length is `MEME_DUR` in `public/index.html`. The first Meme coin appears after roughly 18 to 26 seconds,
then every 32 to 48 seconds (`memeAt`).

## PIN recovery by email (Resend)

Players can add an optional email when they pick a name and PIN. If they forget the PIN, "Forgot PIN?" emails them a six digit code that sets a new one, so nobody loses their name or their best score.

To switch it on, add two environment variables in Netlify (Site configuration, Environment variables), then redeploy:

* `RESEND_API_KEY`: your Resend API key (the same one Guess the Opening uses is fine).
* `RESEND_FROM`: the sender, on a domain you have verified in Resend, for example `Blockchain Breakout <noreply@yourdomain.com>`.

Without them the game works exactly as before and "Forgot PIN?" says recovery is not switched on yet.

How it is kept safe: emails are stored against the player record only and are never returned by the leaderboard (the owner only ever sees a masked version like p***@gmail.com). The answer to "Forgot PIN?" is the same whether or not a name exists or has an email, so it cannot be used to find out who is registered. Codes are stored hashed, last 15 minutes, die after five wrong guesses and cannot be reused, and a name can be sent at most one code a minute and five a day. Only the right PIN can add or change the email on a name.

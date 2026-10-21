# Tank Tangle

Retro pixel maze tank battles for 2 to 12 players in the browser, on a phosphor terminal CRT, in the spirit of the old Flash game Tank Trouble. Drive around a maze, bank shots off the walls, blow holes in the brickwork and fight over power-up crates.

Play at https://tanktangle.bradwindy.workers.dev. Press Create room, send the link to your friends, and the host presses Start. No friends around? The host can add Easy, Normal, Hard or Expert bots to fill seats or play solo.

## How to play

- Drive with WASD or the arrow keys. Fire with Space or Enter. Hold fire to keep shooting.
- On a phone, put your left thumb anywhere on the left side for a joystick. A light push turns the tank on the spot, a full push drives. The big button fires.
- Tanks have 3 hit points. Bullets bounce off walls, and your own bullets can hit you once they have bounced.
- Brick walls crack and break under fire, then grow back after about 30 seconds. Steel walls never break.
- Crates appear away from everyone to draw you out. Driving over one picks it up. A new weapon replaces the one you hold.
- After you die you respawn 2 seconds later somewhere safe, with a short spawn shield. A big arrow points at your tank and it flashes, at the start and after every respawn.
- Pick your colour in the lobby. No two players can hold the same one, and your browser remembers your pick.
- The results screen shows the top 5 awards from a pool of 22 and a stats board with everyone's kills, deaths, accuracy, damage, best streak, crates and bricks.

Two modes:

- **Lives**: everyone starts with N lives. The last tank (or team) with lives left wins. After 3 minutes a storm closes in from the edges and hurts anyone caught in it, so nobody can hide forever.
- **Timed**: the most kills when the clock runs out wins. A tie goes to sudden death.

Killing yourself costs a kill. Killing a teammate costs your team a kill. If someone damaged you in the 5 seconds before you blew yourself up, they get the kill instead.

### Power-ups

| Crate | What it does |
|---|---|
| Laser | One instant beam that ricochets several times. Kills on hit. Shows its path while you aim. |
| Gatling | Hold fire. Spins up, then sprays 24 rounds. |
| Shotgun | Three blasts of pellets. Deadly up close. |
| Homing missile | Flies straight for 1.5 s, then hunts the nearest enemy through the maze. |
| Frag bomb | A big bouncing shell. Press fire again to burst it into shrapnel. Smashes bricks. |
| Mines | Drop three mines behind you. They go off shortly after a tank touches them, or when shot. |
| Death ray | Charges for 1.5 s, then fires a beam that passes through walls and bends toward a target. Rare. |
| RC missile | You steer it with your controls while your tank waits. Fire again to detonate. Rare. |
| Shield | 6 seconds of immunity. Bullets bounce off it. |
| Repair kit | Back to full health. |
| Speed boost | 35% faster for 10 seconds. |
| Aimer | Shows where your shots will bounce for 10 seconds. |

### Host settings

Mode, lives or minutes, maze size (it scales with the number of tanks, and the slider makes it smaller or bigger), teams (off, 2, 3 or 4) with a friendly fire switch, power-up frequency, how much of the maze is brick, game speed, and how many times a bullet bounces (3 by default).

People who open the link mid-match watch and join the next match. If your connection drops mid-match you have 15 seconds to rejoin your tank.

## How it works

The whole game is one Cloudflare Worker.

- `src/client` is the browser game. It draws the arena at pixel-art resolution into a canvas, then scales it up through a WebGL pass that adds bloom, colour fringing, line wobble and phosphor trails. `crt.ts` gives the DOM UI the same glow and fringing and lays scanlines, an aperture mask, grain, flicker, a rolling band and a vignette over everything. The menu cycles the CRT look between Full, Soft (steady) and Off. Every sprite is drawn from code and every sound is synthesised with Web Audio, so there are no image or audio files.
- `src/worker` holds the Worker, one Durable Object class (`Arena`), the match rules and the bots. Each room code maps to its own Durable Object through `getByName(code)`. It runs the game at 60 Hz and sends snapshots at 30 Hz over WebSockets.
- `src/shared` holds code both sides run: the maze generator, movement and projectile physics, weapon tables, settings and the message protocol.

The server is authoritative. Clients send their input only when it changes, stamped with the tick it should apply on. Each client runs slightly ahead of the server, predicting its own tank by replaying its unconfirmed inputs on top of every snapshot, and it extrapolates other tanks and bullets with the same physics code, so the game stays responsive over the internet.

Some details follow the current Cloudflare guidance:

- Sockets use the WebSocket Hibernation API, so an idle lobby costs nothing. The tick timer only exists while a match is running.
- The game advances by a fixed 1/60 s per tick. `Date.now()` does not advance inside a Worker invocation, so wall-clock deltas would be wrong in production.
- Inputs are sent only on change, plus a slow heartbeat, which keeps Durable Object requests low.
- Lobby state is written to the Durable Object's SQLite storage only when it changes, never per tick.
- The Worker checks the path, upgrade header, origin, room code and protocol version before a request reaches a Durable Object.
- Static assets are served without running the Worker. Only `/api/*` runs it.

## Development

Needs Node 22.13 or newer, 24, or 26 and up.

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run check
```

`npm run dev` serves the game at http://localhost:5173 with the Worker and Durable Object running locally in `workerd`, bots included. Open the room link in a second tab to play against yourself. `npm run check` runs the type check, lint and tests. The tests run inside the Workers runtime through `@cloudflare/vitest-plugin`, and include full matches over real WebSockets and bots-only matches at every level.

To work on graphics and sound without a server, run the renderer lab and open http://localhost:5180/lab.html:

```bash
npx vite --config vite.lab.config.ts
```

After changing `wrangler.jsonc`, regenerate the binding types with `npm run types`.

## Deploying

Pushes to `main` deploy through Workers Builds, Cloudflare's Git integration. Branch pushes get a preview with their own Durable Objects. To deploy by hand from a machine signed in with `npx wrangler login`:

```bash
npm run deploy
```

Every deploy restarts the Durable Objects, so live matches drop. Players reconnect into the lobby and keep their places.

The repo has no secrets. The Cloudflare account comes from the wrangler login or the `CLOUDFLARE_ACCOUNT_ID` environment variable, never from config.

## Licence

MIT

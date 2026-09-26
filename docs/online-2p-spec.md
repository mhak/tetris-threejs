# Spec: online 2-player versus with a join code

Status: implemented (all six milestones); decisions from two reviews and
what changed while building are in section 10
Scope: play the existing versus rules on two different devices (phone, tablet
or desktop, in any mix). One player creates a room and gets a short join code;
the other enters the code, opens a share link or scans a QR code.

Items marked **(low confidence)** are assumptions that need checking with a
prototype before we commit to them.

## 1. Goals and non-goals

### Goals

- Two players on two devices play one versus match: garbage lines on a Tetris,
  and all four powers (Add Line, Clear Line, Drop, Left Slide) work across devices.
- Joining takes one short code, a link or a QR scan. No accounts, no sign-in.
- Nothing new to host. The site stays a static build on GitHub Pages.
- Rematch in the same room without a new code.
- A dropped connection (phone locks, Wi-Fi blip) can recover within a grace
  period. A page reload keeps the room and the win counter but loses the
  current round.
- Each device shows its own well full size and the opponent's well as a small
  live view, so it fits a phone.
- Both players get the same piece sequence each round, so neither gets luckier
  pieces.
- Players pick a name, shown on the opponent's screen and the result screen.

### Non-goals (for this version)

- Matchmaking with strangers, lobbies, friend lists or chat.
- More than 2 players, or spectators.
- Cheat prevention. Both clients are trusted.
- Changing the game rules. The rules stay as they are; the
  shared piece sequence (5.4) changes only where pieces come from, not the rules.
- Local 2-player on one device (`PLAYER_COUNT = 2`). It stays as it is today.

## 2. User flows

### 2.1 Start screen

The start overlay (`#start` in `index.html`) gets three choices:

| Choice | What happens |
| --- | --- |
| **Solo** | Today's single-player game. |
| **Create room** | Becomes the host, shows a join code and waits. |
| **Join room** | Shows a code input, then connects to the host. |

"Press any key / tap to start" keeps starting Solo, so the current one-tap flow
is not slower. The two online buttons sit below it.

Keyboard and clicks on the start screen need two changes, or the lobby can't
be used:
- Today any key (`input.onAnyInput`) or any click on the overlay starts Solo
  (`src/main.ts`). Clicks on the online buttons must not reach that handler,
  and the shortcut is off while the Create / Join panel is open.
- `Input` calls `preventDefault()` on every game key for the whole window
  (`src/game/input.ts`), which would block typing A, C, D, E, F, K, L, Q, R, S,
  W, Z and space into the name and code fields. `Input` ignores key events
  whose target is a text field (`input`, `textarea`).

Until the online mode is finished (milestone 6), the two online buttons only
show with `?online=1` in the address, because every merge to `main` deploys.

### 2.1a Player name

- Create and Join both show a **Name** field above the rest of the screen,
  filled in with the last name used (`localStorage`, wrapped in try/catch), or
  empty the first time.
- 1 to 10 characters, forced to upper case, limited to `A-Z 0-9` and space
  (the Press Start 2P font and the 3D text both handle these). Leading and
  trailing spaces are trimmed.
- Empty means `PLAYER`. If both players have the same name, the opponent's is
  shown with a `2` after it on each screen, so the result screen isn't
  confusing.
- A name is sent once in `hello` and can't be changed while in a room.
- A received name is re-checked against the same rules (the other client is
  trusted for gameplay, but text still gets cleaned). It is only drawn with
  `TextPlane` or set with `textContent`, never as HTML.

### 2.2 Create room (host)

1. The host taps **Create room**.
2. The page registers with the signaling broker under a new code (see 4.2) and
   shows:
   - the code in large type, e.g. `K7QX3`
   - a **Share** button (Web Share API, falls back to copying the link)
   - a QR code of the join link
   - "Waiting for opponent..." and a **Cancel** button
3. When a guest connects, both screens show "<NAME> joined" and a 3-2-1
   countdown, then the round starts.

### 2.3 Join room (guest)

1. The guest taps **Join room** and types the code. Input is forced to upper
   case, ignores characters outside the code alphabet, and connects on its own
   once all 5 characters are entered.
2. Or the guest opens `https://<site>/?join=K7QX3` (from the share link or QR).
   The code is filled in and the overlay shows **Tap to join**. The tap is
   needed because browsers only allow audio after a user gesture (same reason
   the start screen exists today).
3. Errors shown on the join screen:
   - "No room with that code" (host not found)
   - "Room is full" (host already has an opponent)
   - "Couldn't connect" (peer connection failed, or no open channel after
     15 s, see 4.4)
   - "Your opponent is on a different version. Reload the page." (build ID
     mismatch, see 6)

After joining, the `?join=` parameter is removed from the address bar with
`history.replaceState`, so a reload doesn't try to join a finished room. A
`?join=` link works without `?online=1`.

### 2.4 During the match

- Each player controls only their own well, with the same touch, keyboard and
  gamepad controls as today. On desktop both keyboard layouts control the local
  player, so either set of keys works.
- On each device the local player is board 0 and the opponent's `RemoteField`
  is board 1. Touch input only feeds board 0 (`getState` in `src/main.ts`).
- **Use power** now has a target: Add Line and Drop hit the opponent. The solo
  power list (`SOLO_POWERS` in `gameScreen.ts`) is not used online.
- **Pause** pauses both devices. Resuming shows a 3-2-1 countdown on both.
  Either player can pause and resume.
- Going to the background (`visibilitychange`) pauses the match for both, as
  solo play does today, by sending `{ t: 'pause', reason: 'hidden' }`.
- The Pause button has no time limit (5.6), but being in the background can
  have one. A background tab stops `requestAnimationFrame` and slows its
  timers, and iOS may suspend the page altogether. **(low confidence)** on
  how fast each browser does this. If the other side stops hearing from it,
  it shows "Reconnecting..." after 5 s, and after the 30 s grace the player
  who left forfeits (2.6).

### 2.5 End of round and rematch

- When one player tops out, the other wins. Both screens show the result with
  names, e.g. `ALEX WINS` over the winner's well, or `DRAW` (see 5.5).
- Each player presses Start (or taps) to say "ready for a rematch". The screen
  shows "Waiting for opponent..." until both are ready, then a countdown and a
  new round in the same room. Online, that press only sends `ready`; the
  round restarts when the host's `start` arrives, never locally (5.1).
- A win counter with names (e.g. `ALEX 2 - 1 SAM`) is shown for the life of
  the room.
- **Leave** returns to the start screen and tells the opponent, who sees
  "<NAME> left" and a button back to the start screen.

### 2.6 Disconnect and reconnect

- If the data channel closes or no message arrives for 5 s, both sides pause
  and show "Reconnecting..." with a countdown from 30 s. This works in any
  room state, not just during play (see the state machine in 7).
- The guest retries connecting to the host's code. The host keeps its broker
  registration (or re-registers the same code after a reload, see 4.5).
- If the connection comes back inside the grace period, the round resumes with
  a 3-2-1 countdown.
- A page reload keeps the room and the win counter, but the player who
  reloaded loses the current round (4.5). The page shows **Tap to rejoin**
  first, because audio needs a user gesture again.
- If the grace period runs out, the room ends and each side decides the
  outcome on its own, since no message can get through:
  - If the opponent sent `pause` with `reason: 'hidden'` and no `resume`
    since, the opponent went to the background and forfeits: "<NAME> LEFT,
    YOU WIN".
  - The player who was in the background, on coming back to a lost
    connection, sees "YOU LEFT, YOU LOSE". A page can tell it was away from
    how long `document.hidden` was true.
  - Otherwise (a network outage, neither side was hidden) both see
    "CONNECTION LOST" and no one wins. Without this rule, both sides of an
    outage would each think the other one left and both claim the win.
  - Every case shows a button back to the start screen.

## 3. Screen layout

Each device renders two boards: the local one at full size and the opponent's
as a mini board. The mini board shows the well, the falling piece and the
opponent's power slots, with the opponent's name above it. It does not need
hold, next or the ghost piece. The local board is not labelled.

- **Landscape** (desktop, phone sideways): local board in the current
  landscape layout; the mini board at about 45% scale to the right of the
  hold / next column, with the opponent's score above it.
- **Portrait** (phone upright): local board in the current portrait layout;
  the mini board at about 30% scale in the HUD area above the well. The HUD
  gets less room, so hold / next / power sizes shrink.

Visual feedback on attacks:
- Incoming garbage or Add Line: short red flash on the local well edge.
- Incoming Drop: the existing `boom` sound and camera shake.
- Outgoing attack: a small pulse on the mini board.

This needs a design pass on a real phone, especially portrait. **(low
confidence)** that 30% scale is still readable on a small phone.

Renderer changes: `Renderer` currently assumes every board has the same layout
and spreads them evenly (`applyLayout`). It needs a per-board layout and scale,
e.g. `new Renderer(app, [{ layout: 'auto' }, { layout: 'mini' }])`, plus a
`mini` entry in `LAYOUTS`. Today `drawPlayer()` reads `shadowY`, `heldPiece`
and `nextPiece` from every field; the `mini` layout skips the ghost, hold and
next, so `RemoteField` doesn't need to provide them.

## 4. Networking

### 4.1 Choice: WebRTC data channel with PeerJS

- Devices connect peer to peer over a WebRTC data channel.
- [PeerJS](https://peerjs.com) handles signaling, using its free public broker
  (`0.peerjs.com`). The broker is only used to set up the connection; game
  messages go directly between the devices.
- Add `peerjs` as an npm dependency and bundle it with Vite. Import it lazily
  (`await import('peerjs')`) when the player taps Create or Join, so solo play
  doesn't download it.

Risks:
- The public PeerJS broker is a free community service with no uptime promise.
  Decision: acceptable for launch. **(low confidence)** on its current limits;
  worth a quick check during milestone 1. If it becomes a problem, we can run
  our own `peerjs-server`. The transport interface (4.6) keeps this swappable.
- WebRTC without a TURN relay fails on some networks (symmetric NAT, some
  mobile carriers, strict corporate Wi-Fi). **(low confidence)** on how often
  this happens for our players; I have seen estimates from roughly 10% to 20%
  of connections but have not verified them. PeerJS's default settings
  include a free relay that should cover most of these (4.4).

### 4.2 Join code

- 5 characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (31 symbols, no `0 O 1 I L`),
  about 28.6 million codes. Easy to read out loud and type on a phone.
- The host's PeerJS peer ID is `tetris-threejs-<code>`. The prefix keeps our
  IDs apart from other apps on the shared broker.
- The host generates a code with `crypto.getRandomValues`. If the broker says
  the ID is taken (`unavailable-id` error), pick a new code and retry, up to 5
  times.
- The guest gets a random PeerJS ID (no code needed).
- Codes are not secret. Anyone with the code can join an empty room. The host
  accepts only the first guest and rejects others with `{ t: 'full' }`, then
  closes with `conn.close({ flush: true })` so the message is delivered before
  the channel closes.
- While reconnecting, the host lets the guest back in only if its `hello`
  carries the room's resume `token` (4.5). That also covers a reloaded guest,
  which comes back with a new random peer ID.

### 4.3 Share link and QR

- Join link: built from the current page address, e.g.
  `const url = new URL(location.href); url.search = '?join=' + code; url.hash = '';`.
  Not from `import.meta.env.BASE_URL`: `vite.config.ts` sets `base: './'`, so
  in the build it is `./` and `location.origin + BASE_URL` gives
  `https://<host>./?join=...`, which drops the `/tetris-threejs/` path.
- **Share**: `navigator.share({ url })` where supported, else copy the link with
  `navigator.clipboard.writeText` and show "Link copied".
- QR code: generated on the client. Add a small QR library (e.g. `qrcode` or
  `qrcode-generator` on npm), also loaded lazily. **(low confidence)** on which
  one is smallest; compare bundle size before picking.

### 4.4 ICE servers

- Keep PeerJS's default `config.iceServers` and don't override it. In peerjs
  1.5.5 the default is Google's STUN server plus a free TURN relay run by the
  PeerJS project (`eu-0.turn.peerjs.com` and `us-0.turn.peerjs.com`, with
  shared public credentials). Decision: use it. Nothing to host and no
  credentials of our own, and it covers networks where a direct connection
  fails. **(low confidence)** on how reliable and fast that relay is; like the
  broker, it is a free community service with no uptime promise.
- The first draft said the PeerJS default was STUN only. That was wrong:
  "no TURN" would have meant removing the relay on purpose.
- A join that has no open channel after 15 s fails with "Couldn't connect.
  Try both devices on the same Wi-Fi." PeerJS reports an ICE failure itself
  (`negotiation-failed`), but **(low confidence)** on how long browsers take
  to give up, so the timeout doesn't rely on it.

### 4.5 Reconnect details

- A PeerJS `Peer` that loses the broker connection (`disconnected` event) calls
  `peer.reconnect()`, which keeps the same ID.
- A data channel that closes, or goes 5 s without a message: the guest closes
  it and calls `peer.connect(hostId)` again every 2 s during the grace period.
- Liveness comes from `ping` (6), sent from a `setInterval` timer, not from
  the `requestAnimationFrame` loop, which stops in a background tab.
- Resume token: the host's `hello` carries a random `token`. A guest that
  reconnects sends it back in its own `hello`. While reconnecting, the host
  accepts a `hello` with the right token, closes the old connection and
  carries on; anything else gets `full`.
- On reconnect without a reload, the round continues from each side's current
  board. Each device owns its own board (5.1), so there is nothing to replay:
  the local board was paused, and the opponent sends a fresh snapshot.

Page reload. Decision: a reload keeps the room and the win counter but loses
the current round. The board itself is not saved, because a restored board
would also need the piece generator's exact position, or that player's
pieces would stop matching the opponent's (5.4).
- `sessionStorage` (per tab) keeps: role, room code, both names, resume
  token, win counter and round number. Nothing about the board.
- Host reload: on load, if there is a live room, the host re-registers the
  same peer ID. **(low confidence)** that the broker frees the old ID fast
  enough; if it doesn't, the host retries until the grace period ends.
- Guest reload: the guest gets a new random peer ID and rejoins with the
  saved token.
- After reconnecting, a reload counts as topping out: the reloaded side sends
  `over` for the interrupted round (a reloaded host applies its own `over`),
  and the result follows the normal rules in 5.5. If the round was already
  over, both go straight to the rematch screen.

### 4.6 Transport interface

```js
// src/net/transport.ts
// A transport moves JSON messages between exactly two peers.
export class Transport {
  host(code) {}          // Promise<void>; rejects with { code: 'taken' }
  join(code) {}          // Promise<void>; rejects with { code: 'not-found' | 'full' | 'failed' } ('failed' also after 15 s)
  send(message) {}       // reliable, ordered
  close() {}
  onMessage = (msg) => {};
  onState = (state) => {}; // 'connecting' | 'open' | 'lost' | 'closed'
}
```

Two implementations:
- `PeerTransport` (PeerJS, the real one).
- `LoopbackTransport` (in memory, a pair that talk to each other). Used by unit
  tests and a `?debug=loopback` mode that runs host and guest side by side in
  one tab.

## 5. Game sync

### 5.1 Model: each device owns its own board

Each device runs the full rules for its own `TetrisField` only: gravity, input,
line clears, powers, randomness. It sends the opponent:

1. **Snapshots** of its board, so the opponent can draw the mini board.
2. **Attacks**, the only things that change the other player's board.

Why this model:
- No input lag on your own board, which matters most in Tetris.
- No lockstep or rollback. The only shared effects are attacks, and a
  50 to 150 ms delay on an incoming garbage line is not noticeable.
- The existing `TetrisField` code runs almost unchanged.

The cost is that we trust each client for its own board. That is fine for a
friends-only game (see non-goals).

`GameScreen` needs an `online` mode, because today it ends and restarts
rounds on its own:
- It marks a player the winner as soon as every other field is game over,
  and `allOut` shows a draw. Online, a `RemoteField` turns game over as soon
  as a snapshot says `over`, so the local screen would show a result before
  the host decides it (5.5).
- Start (or a tap, `src/main.ts`) after a round calls `restartGame()` locally,
  which would skip the rematch handshake (2.5).

In `online` mode, `GameScreen` doesn't set `isWinner`, doesn't treat `allOut`
as a result and never calls `restartGame()` itself. The session shows the
result from the host's `result` message, turns Start into `ready` and starts
each round from the host's `start` message.

### 5.2 Attacks

These are the rules in `GameScreen` that touch an opponent, and what they
become online:

| Local event | Today (`gameScreen.ts`) | Online |
| --- | --- | --- |
| Clear 4 lines | `opponent.addLine()` | send `{ t: 'attack', kind: 'line' }` |
| Use Add Line | `opponent.addLine()` | send `{ t: 'attack', kind: 'line' }` |
| Use Drop | `opponent.movePieceHardDrop()` + `boom` | send `{ t: 'attack', kind: 'drop' }`, play `boom` locally |

A Tetris and Add Line are one message kind. Both call the same
`opponent.addLine()` (see `RemoteField` below), so the sender can't tell them
apart, and they have the same effect on the receiver.

On receive:
- `line`: `field.addLine()`. The gap column is picked by the receiver's own
  random source.
- `drop`: `field.movePieceHardDrop()`, play `boom`, camera shake.
- Ignored if the receiver is already game over, not in a round, or the
  message's round number is old.
- Received while paused: queued and applied on resume.

Implementation: a `RemoteField` class stands in for the opponent inside
`GameScreen.players`. Its `addLine()` and `movePieceHardDrop()` send attacks
instead of changing a board, so `opponentsOf()` and `usePower()` need no
changes. `GameScreen.update()` skips `update()` and input for remote players
(new `isRemote` flag).

### 5.3 Snapshots

A snapshot has what the mini board and score need:

```js
{
  t: 'state',
  round: 3,              // snapshots from an old round are ignored
  field: '0000...2211',  // 200 chars, one base-36 digit per cell (values 0..11)
  piece: { kind: 'T', rot: 1, x: 3, y: 7 },  // null after top out
  powers: [8, 11],
  score: 1200, lines: 14,  // level is worked out from lines, as in TetrisField
  over: false,
}
```

- Sent when anything in it changes, at most 20 times per second. About 300
  bytes each, so under 10 KB/s. No heartbeat snapshot: `ping` does that job.
- No sequence number. The channel is reliable and ordered, so snapshots can't
  arrive out of order, and a counter would break after a reload: the reloaded
  side would start again from 0 and every new snapshot would look old.
- The receiver copies it into `RemoteField`; the renderer draws `RemoteField`
  with the `mini` layout (3). No interpolation.

### 5.4 Round start and randomness

- The host starts every round: `{ t: 'start', round, seed, countdownMs: 3000 }`.
  `seed` is a new random 32-bit integer from `crypto.getRandomValues` each
  round, so a rematch gets a new sequence.
- Both players get the same piece sequence: the Nth piece is the same kind on
  both devices, however the round plays out.

How, given the current code: `TetrisField` has one `random` that is used for
three things: `generatePiece()`, `spawnRandomPower()` and the gap column in
`addLine()`. With one shared stream, a garbage line or a power spawn on one
side would shift that side's later pieces, and the sequences would drift apart.
So there are two streams:

| Stream | Used by | Source |
| --- | --- | --- |
| `pieceRandom` | `generatePiece()` only | Seeded PRNG from the round's `seed` |
| `random` | `spawnRandomPower()`, `addLine()` gap | `Math.random`, per device |

- Add a small seeded PRNG (e.g. mulberry32, about 10 lines) in
  `src/game/random.ts`. The same seed only gives the same pieces if both
  devices generate pieces the same way: same PRNG, same `TETROMINO_KINDS`
  order, same `generatePiece()`. A protocol version number bumped by hand
  could miss a change to any of these, so `hello` compares a build ID instead
  (6), and both devices always run the same JS build.
- `TetrisField` takes a new `pieceRandom` option that defaults to `random`, so
  solo and local 2-player behave exactly as today.
- `GameScreen` takes a `pieceSeed` option and gives each local field its own
  PRNG made from that seed. It must be a fresh PRNG per field, not a shared
  one, or one player's pieces would consume the other's numbers (this matters
  for local 2-player if we ever turn seeding on there).
- Hold doesn't break this: it only takes the next piece from the same sequence
  (`activatePiece()` when the hold slot is empty), so it never skips or reorders
  pieces.
- Not seeded on purpose: garbage gaps and where powers spawn stay per device.
  Only the piece order has to match to be fair.

### 5.5 Top out and the result

- When the local player tops out, it sends `{ t: 'over', round }`.
- The host decides the result, so both screens always agree:
  - First `over` the host sees (its own, or the guest's on receipt) loses.
  - After the first `over`, the host waits 250 ms. If the other side also
    tops out in that time, the round is a draw. This is close to the local
    rule "both top out in the same frame = draw".
  - The host sends `{ t: 'result', round, winner: 'host' | 'guest' | 'draw' }`.
- Known bias: the host sees its own `over` at once but the guest's only after
  the network delay, so a close finish tilts against the host. With a 250 ms
  window it only matters on slow links. Decision: accept it for a friends-only
  game rather than sync clocks.
- Until the result arrives, the guest keeps playing if it hasn't topped out.
  In practice the result arrives within one round trip plus 250 ms.
- A lost connection can't use `result`, because no message gets through. Each
  side decides that outcome itself (2.6).

### 5.6 Pause

- `{ t: 'pause' }` and `{ t: 'resume' }`. Either side can send either one.
- No limit on how many times or how long a player can pause. Decision: the
  game is played between friends, so stalling isn't a concern. This covers
  the Pause button only; a page in the background loses its connection and
  forfeits after the grace period (2.4, 2.6).
- On `resume`, both run a 3 s countdown before input and gravity restart.
- `GameScreen.pause` is set from the network as well as from the Start button.

## 6. Protocol

All messages are JSON objects with a `t` (type) field, sent over one reliable,
ordered data channel.

| Type | Direction | Fields | Meaning |
| --- | --- | --- | --- |
| `hello` | both | `v`, `name`, `token?` | First message. `v` is the build ID, `name` the player name (2.1a). The host's `hello` carries a new resume `token`; a reconnecting guest sends it back (4.5). |
| `full` | host to guest | | Room already has a guest. |
| `version` | both | `v` | Build IDs don't match; show the reload message. |
| `start` | host to guest | `round`, `seed`, `countdownMs` | Start a round with this piece seed (5.4). |
| `state` | both | see 5.3 | Board snapshot. |
| `attack` | both | `round`, `kind` | `line` or `drop` (5.2). |
| `over` | both | `round` | Sender topped out, or reloaded mid-round (4.5). |
| `result` | host to guest | `round`, `winner` | Round result. |
| `ready` | both | `round` | Ready for a rematch. |
| `pause` / `resume` | both | `reason?` | Pause both / resume both. `pause` has `reason: 'hidden'` when the sender went to the background (2.6). |
| `ping` / `pong` | both | `ts` | Every 1 s from a timer; the only liveness signal ("lost" after 5 s) and a latency readout. |
| `bye` | both | | Player left the room. |
| `sync` | host to guest | `round`, `seed`, `winner`, `ready`, `wins`, `paused` | Sent right after the host's `hello` on a reconnect: where the room is (added while building, see 10). |

The build ID is the deployed commit, injected at build time with Vite's
`define` (e.g. `__BUILD_ID__` from `GITHUB_SHA` in the deploy workflow, `dev`
otherwise). Two devices play only if their IDs match, so a page cached from an
old deploy shows the reload message instead of desyncing, and nobody has to
remember to bump a version number. `hello` and `version` must keep their shape
forever, so any two builds can at least tell each other they differ.

## 7. Code layout

New files:

| File | Contents |
| --- | --- |
| `src/net/transport.ts` | `Transport` interface and `LoopbackTransport` |
| `src/net/peerTransport.ts` | PeerJS implementation |
| `src/net/joinCode.ts` | Code generation, validation, peer ID prefix |
| `src/net/playerName.ts` | Name rules, cleaning, saved name |
| `src/game/random.ts` | Seeded PRNG for the shared piece sequence |
| `src/net/protocol.ts` | Message types, build ID, field encoding |
| `src/net/session.ts` | Room state machine (below) |
| `src/game/remoteField.ts` | Read-only opponent field plus attack forwarding |
| `src/ui/lobby.ts` | Create / join / share / QR screens |

Changed files:

| File | Change |
| --- | --- |
| `src/main.ts` | Mode select (solo / host / guest), builds `GameScreen` with a `RemoteField` online; no Solo shortcut while the lobby is open; `?online=1` flag |
| `src/game/input.ts` | Ignore key events from text fields |
| `src/game/gameScreen.ts` | Skip remote players in `update()`; `online` mode with no local result or restart; `onAttack` / `onOver` hooks; round number; `pieceSeed` option |
| `src/game/tetrisField.ts` | `pieceRandom` option used only by `generatePiece()` |
| `src/render/renderer.ts` | Per-board layout and scale, `mini` layout without ghost / hold / next, attack flash |
| `vite.config.ts` | `define` the build ID |
| `index.html`, `src/style.css` | Start screen buttons, lobby panel, status banners |
| `README.md` | How to play online |

Room state machine (`session.ts`):

```
idle -> hosting -> waiting -> countdown -> playing -> roundOver -> countdown ...
idle -> joining -> countdown
playing <-> paused
countdown | playing | paused | roundOver -> reconnecting -> (countdown | roundOver | closed)
any -> closed (bye, cancel, fatal error, grace period over)
```

`reconnecting` goes back to `roundOver` when it was entered from there, or
when a reload lost the round (4.5). Otherwise it goes to `countdown` and the
round resumes.

## 8. Testing

Automated (`npm test`, `node:test`, no browser):
- `joinCode`: alphabet, length, validation, normalizing typed input.
- `protocol`: field encode / decode round trip.
- `playerName`: length, allowed characters, trimming, empty becomes `PLAYER`,
  cleaning of a received name.
- Seeded pieces: two fields with the same seed produce the same first 100
  pieces even when one gets garbage lines, power spawns and holds and the
  other doesn't; a different seed gives a different sequence; without a seed,
  `TetrisField` still uses `random` for pieces (existing tests keep passing).
- `RemoteField`: applies snapshots, ignores snapshots from an old round,
  forwards attacks.
- `Input`: keys typed into a text field are not blocked or turned into game
  input.
- `GameScreen` in `online` mode: the opponent topping out doesn't make the
  local player the winner, and Start after a round doesn't restart it.
- `GameScreen` with two `LoopbackTransport` ends: a Tetris on one side adds a
  garbage line on the other; Add Line and Drop powers; top-out gives the same
  result on both sides; simultaneous top-out is a draw; pause and resume reach
  both sides; attacks from an old round are ignored.
- Session: reconnect inside the grace period resumes; a reload rejoins with
  the token and loses the round; a wrong token gets `full`; after the grace
  period, the side that went to the background loses and a plain outage ends
  with no winner.

Manual matrix before release:
- iOS Safari + Android Chrome, desktop Chrome + phone, desktop Firefox + Safari.
- Same Wi-Fi; one on cellular; both on cellular.
- Lock the phone mid-round and unlock within 30 s, and after 30 s. Same with
  switching to another app.
- Reload the host tab mid-round, and the guest tab.
- Open the share link and the QR code from a phone camera.

## 9. Milestones

1. **Transport and codes**: `Transport`, `LoopbackTransport`, `PeerTransport`,
   join codes, names, and a bare create / join screen that shows "connected".
2. **Mirror**: snapshots and `RemoteField`; opponent board drawn (full size is
   fine at this step).
3. **Versus rules**: attacks, top-out and result, pause, countdown, seeded
   piece sequence.
4. **Layout**: mini board in landscape and portrait, attack feedback.
5. **Room features**: rematch and score counter, share link, QR, reconnect.
6. **Polish**: error messages, README, manual test matrix.

Each milestone is a separate PR that keeps solo play working. Every merge to
`main` deploys, so the online buttons stay behind `?online=1` until
milestone 6 (2.1).

## 10. Decisions

Answers to the open questions from the first draft:

| Question | Decision | Where |
| --- | --- | --- |
| Same piece sequence for both players? | Yes, seeded per round | 5.4 |
| Limit pauses? | No, unlimited (Pause button only) | 5.6 |
| Public PeerJS broker for launch? | Yes | 4.1 |
| TURN relay for failed connections? | Changed in the second review, see below | 4.4 |
| Player names? | Yes | 2.1a, 3 |

Second review, after checking the spec against the code and peerjs 1.5.5:

| Question | Decision | Where |
| --- | --- | --- |
| TURN relay? | Use the free PeerJS relay in PeerJS's default settings. The first draft thought the default had no relay. | 4.4 |
| Page reload mid-round? | Keep the room and win counter; the reloaded player loses the round | 2.6, 4.5 |
| Background for more than 30 s? | The player who left forfeits; a plain outage ends with no winner | 2.4, 2.6 |
| Same code on both devices? | `hello` compares a build ID, not a hand-bumped version | 5.4, 6 |
| Close top-outs favour the guest by the network delay? | Accepted | 5.5 |
| Tetris vs. Add Line message? | One kind, `line` | 5.2 |

Fixed in the second review (spec was wrong about the code): typing in the
lobby (2.1), the share link URL (4.3), `GameScreen` deciding results itself
(5.1), `drawPlayer()` needing ghost / hold / next (3), the snapshot sequence
number (5.3).

Found while building:

| Topic | What changed | Where |
| --- | --- | --- |
| A result or `start` lost in an outage | New `sync` message: after a reconnect the host sends round, seed, result, its ready flag and the win counter, and the guest lines up with it. Without it, a `result` sent just before the connection dropped would leave the guest playing a round the host had ended. | 4.5, 6 |
| Who says "Room is full" | The session, not the transport: only the session knows the resume token. The host's transport delivers messages from new connections as candidates and the session calls `accept(conn)` or `reject(conn, message)`. `join()` rejects with `not-found` or `failed` only. | 4.2, 4.6 |
| QR library | `lean-qr`: 3.7 KB gzipped, against 3.9 KB for `uqr`, 7.6 KB for `qrcode-generator` and 9.6 KB for `qrcode` (esbuild, minified). | 4.3 |
| Guest reconnect timing | A new attempt starts 2 s after the previous one failed (each attempt gives up after 8 s), not every 2 s, so attempts can't pile up on a slow network. | 4.5 |
| What `sessionStorage` keeps | Also the round's seed and result, so a reload after a finished round goes straight back to the result screen. Still nothing about the board. | 4.5 |
| Grace period start | Counted from the last message heard (plus the 5 s), so a page back from a long suspension sees at once that the grace period is over. | 2.6 |
| Who "went to the background" when the grace period ends | Our side: the page is hidden right then (a page coming back checks the connection before it counts as back). Their side: they sent `pause` with `reason: 'hidden'` and nothing since that shows they're back: a page that comes back sends a plain `pause`, and `resume` or `ready` also clear it. Without this, a player who came back and kept playing would still forfeit on a later plain outage. | 2.6 |
| Pause across a reconnect | A pause nobody resumed stays paused after a reconnect (`sync` carries `paused`), and a page still in the background pauses again, instead of both sides counting down into play. | 2.6, 4.5 |
| Own broker | `VITE_PEER_SERVER` at build time points PeerJS at our own peerjs-server. Also used to test `PeerTransport` against a local broker. | 4.1 |
| Outgoing Drop | Plays `boom` but doesn't shake the sender's camera; the shake is for the player who is hit. | 5.2 |
| "Joined" message | The host sees "SAM JOINED", the guest "JOINED ALEX". | 2.2 |
| Portrait HUD with the mini board | Stats, hold, next and powers move into the left 7 units of the HUD; the mini board takes the top right at 30%. Still needs a check on a real small phone. | 3 |

No open questions left.

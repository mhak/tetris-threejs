# Spec: online 2-player versus with a join code

Status: draft
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
- A dropped connection (phone locks, Wi-Fi blip, page reload) can recover
  within a grace period.
- Each device shows its own well full size and the opponent's well as a small
  live view, so it fits a phone.

### Non-goals (for this version)

- Matchmaking with strangers, lobbies, friend lists or chat.
- More than 2 players, or spectators.
- Cheat prevention. Both clients are trusted.
- Changing the game rules. The rules stay as ported from the C# game.
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

### 2.2 Create room (host)

1. The host taps **Create room**.
2. The page registers with the signaling broker under a new code (see 4.2) and
   shows:
   - the code in large type, e.g. `K7QX3`
   - a **Share** button (Web Share API, falls back to copying the link)
   - a QR code of the join link
   - "Waiting for opponent..." and a **Cancel** button
3. When a guest connects, both screens show "Opponent joined" and a 3-2-1
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
   - "Couldn't connect" (peer connection failed, see 4.4)
   - "Your opponent is on a different version. Reload the page." (protocol mismatch)

After joining, the `?join=` parameter is removed from the address bar with
`history.replaceState`, so a reload doesn't try to join a finished room.

### 2.4 During the match

- Each player controls only their own well, with the same touch, keyboard and
  gamepad controls as today. On desktop both keyboard layouts control the local
  player, so either set of keys works.
- **Use power** now has a target: Add Line and Drop hit the opponent. The solo
  power list (`SOLO_POWERS` in `gameScreen.js`) is not used online.
- **Pause** pauses both devices. Resuming shows a 3-2-1 countdown on both.
  Either player can pause and resume.
- Going to the background (`visibilitychange`) pauses the match for both, as
  solo play does today.

### 2.5 End of round and rematch

- When one player tops out, the other wins. Both screens show the result
  (WINNER / LOSER, or DRAW, see 5.5).
- Each player presses Start (or taps) to say "ready for a rematch". The screen
  shows "Waiting for opponent..." until both are ready, then a countdown and a
  new round in the same room.
- A win counter (e.g. `2 - 1`) is shown for the life of the room.
- **Leave** returns to the start screen and tells the opponent, who sees
  "Opponent left" and a button back to the start screen.

### 2.6 Disconnect and reconnect

- If the data channel closes or no message arrives for 5 s, both sides pause
  and show "Reconnecting..." with a countdown from 30 s.
- The guest retries connecting to the host's code. The host keeps its broker
  registration (or re-registers the same code after a reload, see 4.5).
- If the connection comes back inside the grace period, the round resumes with
  a 3-2-1 countdown.
- If not, the player still connected wins by forfeit and gets a button back to
  the start screen.

## 3. Screen layout

Each device renders two boards: the local one at full size and the opponent's
as a mini board. The mini board shows the well, the falling piece and the
opponent's power slots. It does not need hold, next or the ghost piece.

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
`mini` entry in `LAYOUTS`.

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
  **(low confidence)** on its current limits and reliability; check before
  release. Fallback: run our own `peerjs-server` later. The transport interface
  (4.6) keeps this swappable.
- WebRTC without a TURN relay fails on some networks (symmetric NAT, some
  mobile carriers, strict corporate Wi-Fi). **(low confidence)** on how often
  this happens for our players; I have seen estimates from roughly 10% to 20%
  of connections but have not verified them. Mitigation in 4.4.

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
  accepts only the first guest and rejects others with `{ t: 'full' }`.

### 4.3 Share link and QR

- Join link: `location.origin + import.meta.env.BASE_URL + '?join=' + code`.
- **Share**: `navigator.share({ url })` where supported, else copy the link with
  `navigator.clipboard.writeText` and show "Link copied".
- QR code: generated on the client. Add a small QR library (e.g. `qrcode` or
  `qrcode-generator` on npm), also loaded lazily. **(low confidence)** on which
  one is smallest; compare bundle size before picking.

### 4.4 ICE servers

- STUN: Google's public STUN servers (the PeerJS default).
- TURN: none in the first version, so no credentials to manage. If the
  connection fails, show "Couldn't connect. Try both devices on the same Wi-Fi."
- Follow-up if failures are common: add a TURN service (e.g. Cloudflare Calls
  TURN or Metered). These need short-lived credentials, which means a tiny
  serverless function, so it is out of scope for now.

### 4.5 Reconnect details

- A PeerJS `Peer` that loses the broker connection (`disconnected` event) calls
  `peer.reconnect()`, which keeps the same ID.
- A data channel that closes: the guest calls `peer.connect(hostId)` again every
  2 s during the grace period.
- Host page reload: the room code and round state are kept in `sessionStorage`
  (per tab). On load, if there is a live room, the host re-registers the same
  peer ID. **(low confidence)** that the broker frees the old ID fast enough;
  if it doesn't, the host retries until the grace period ends.
- Guest page reload: the code is kept in `sessionStorage` too, and the guest
  rejoins with a `resume` flag.
- On reconnect, the round continues from each side's current board. Each
  device owns its own board (5.1), so there is nothing to replay: the local
  board was paused, and the opponent sends a fresh snapshot.

### 4.6 Transport interface

```js
// src/net/transport.js
// A transport moves JSON messages between exactly two peers.
export class Transport {
  host(code) {}          // Promise<void>; rejects with { code: 'taken' }
  join(code) {}          // Promise<void>; rejects with { code: 'not-found' | 'full' | 'failed' }
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
- The existing `GameScreen` / `TetrisField` code runs almost unchanged.

The cost is that we trust each client for its own board. That is fine for a
friends-only game (see non-goals).

### 5.2 Attacks

These are the rules in `GameScreen` that touch an opponent, and what they
become online:

| Local event | Today (`gameScreen.js`) | Online |
| --- | --- | --- |
| Clear 4 lines | `opponent.addLine()` | send `{ t: 'attack', kind: 'line' }` |
| Use Add Line | `opponent.addLine()` | send `{ t: 'attack', kind: 'addLine' }` |
| Use Drop | `opponent.movePieceHardDrop()` + `boom` | send `{ t: 'attack', kind: 'drop' }`, play `boom` locally |

On receive:
- `line` / `addLine`: `field.addLine()`. The gap column is picked by the
  receiver's own random source.
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
  round: 3,
  seq: 1042,             // increases per snapshot; drop older ones
  field: '0000...2211',  // 200 chars, one base-36 digit per cell (values 0..11)
  piece: { kind: 'T', rot: 1, x: 3, y: 7 },  // null between pieces
  powers: [8, 11],
  score: 1200, lines: 14, level: 1,
  over: false,
}
```

- Sent when anything in it changes, at most 20 times per second, plus once per
  second as a heartbeat. About 300 bytes each, so under 10 KB/s.
- The receiver copies it into `RemoteField`; the renderer draws `RemoteField`
  like any other field. No interpolation.

### 5.4 Round start and randomness

- The host starts every round: `{ t: 'start', round, countdownMs: 3000 }`.
- Each device keeps using `Math.random` for its own pieces. Players don't get
  the same piece sequence (the original game didn't have that either).
  Optional later: the host sends a seed and both use a seeded PRNG so both
  players get the same pieces. `GameScreen` and `TetrisField` already accept a
  `random` option, so this is cheap to add.

### 5.5 Top out and the result

- When the local player tops out, it sends `{ t: 'over', round }`.
- The host decides the result, so both screens always agree:
  - First `over` the host sees (its own, or the guest's on receipt) loses.
  - If the other side also tops out within 250 ms, the round is a draw. This
    mirrors the local rule "both top out in the same frame = draw".
  - The host sends `{ t: 'result', round, winner: 'host' | 'guest' | 'draw' }`.
- Until the result arrives, the guest keeps playing if it hasn't topped out.
  In practice the result arrives within one round trip.
- Forfeit on a lost connection (2.6) uses the same message with
  `reason: 'forfeit'`.

### 5.6 Pause

- `{ t: 'pause' }` and `{ t: 'resume' }`. Either side can send either one.
- On `resume`, both run a 3 s countdown before input and gravity restart.
- `GameScreen.pause` is set from the network as well as from the Start button.

## 6. Protocol

All messages are JSON objects with a `t` (type) field, sent over one reliable,
ordered data channel.

| Type | Direction | Fields | Meaning |
| --- | --- | --- | --- |
| `hello` | both | `v`, `resume?` | First message. `v` is the protocol version. |
| `full` | host to guest | | Room already has a guest. |
| `version` | both | `v` | Versions don't match; show the reload message. |
| `start` | host to guest | `round`, `countdownMs` | Start a round. |
| `state` | both | see 5.3 | Board snapshot. |
| `attack` | both | `round`, `kind` | `line`, `addLine` or `drop`. |
| `over` | both | `round` | Sender topped out. |
| `result` | host to guest | `round`, `winner`, `reason?` | Round result. |
| `ready` | both | `round` | Ready for a rematch. |
| `pause` / `resume` | both | | Pause both / resume both. |
| `ping` / `pong` | both | `ts` | Every 1 s; used for "lost" detection and a latency readout. |
| `bye` | both | | Player left the room. |

`PROTOCOL_VERSION` starts at 1. Bump it on any breaking change. A page cached
from an old deploy then shows the reload message instead of desyncing.

## 7. Code layout

New files:

| File | Contents |
| --- | --- |
| `src/net/transport.js` | `Transport` interface and `LoopbackTransport` |
| `src/net/peerTransport.js` | PeerJS implementation |
| `src/net/joinCode.js` | Code generation, validation, peer ID prefix |
| `src/net/protocol.js` | Message types, `PROTOCOL_VERSION`, field encoding |
| `src/net/session.js` | Room state machine (below) |
| `src/game/remoteField.js` | Read-only opponent field plus attack forwarding |
| `src/ui/lobby.js` | Create / join / share / QR screens |

Changed files:

| File | Change |
| --- | --- |
| `src/main.js` | Mode select (solo / host / guest), builds `GameScreen` with a `RemoteField` online |
| `src/game/gameScreen.js` | Skip remote players in `update()`; `onAttack` / `onOver` hooks; round number |
| `src/render/renderer.js` | Per-board layout and scale, `mini` layout, attack flash |
| `index.html`, `src/style.css` | Start screen buttons, lobby panel, status banners |
| `README.md` | How to play online |

Room state machine (`session.js`):

```
idle -> hosting -> waiting -> countdown -> playing -> roundOver -> countdown ...
idle -> joining -> countdown
playing <-> paused
playing | paused -> reconnecting -> (countdown | forfeit)
any -> closed (bye, cancel, fatal error)
```

## 8. Testing

Automated (`npm test`, `node:test`, no browser):
- `joinCode`: alphabet, length, validation, normalizing typed input.
- `protocol`: field encode / decode round trip.
- `RemoteField`: applies snapshots, drops stale `seq`, forwards attacks.
- `GameScreen` with two `LoopbackTransport` ends: a Tetris on one side adds a
  garbage line on the other; Add Line and Drop powers; top-out gives the same
  result on both sides; simultaneous top-out is a draw; pause and resume reach
  both sides; attacks from an old round are ignored.
- Session: reconnect inside the grace period resumes; after it, forfeit.

Manual matrix before release:
- iOS Safari + Android Chrome, desktop Chrome + phone, desktop Firefox + Safari.
- Same Wi-Fi; one on cellular; both on cellular.
- Lock the phone mid-round and unlock within 30 s, and after 30 s.
- Reload the host tab mid-round.
- Open the share link and the QR code from a phone camera.

## 9. Milestones

1. **Transport and codes**: `Transport`, `LoopbackTransport`, `PeerTransport`,
   join codes, and a bare create / join screen that shows "connected".
2. **Mirror**: snapshots and `RemoteField`; opponent board drawn (full size is
   fine at this step).
3. **Versus rules**: attacks, top-out and result, pause, countdown.
4. **Layout**: mini board in landscape and portrait, attack feedback.
5. **Room features**: rematch and score counter, share link, QR, reconnect.
6. **Polish**: error messages, README, manual test matrix.

Each milestone is a separate PR that keeps solo play working.

## 10. Open questions

1. Same piece sequence for both players (seeded PRNG)? Fairer, but a change
   from the original game. Default in this spec: no.
2. Should pause be limited (e.g. 3 per player per round) so it can't be used to
   stall? Default: unlimited.
3. Is the public PeerJS broker acceptable for launch, or do we want our own
   `peerjs-server` from day one?
4. Should a failed connection offer a TURN relay (needs a small serverless
   function for credentials), or is "use the same Wi-Fi" enough for now?
5. Player names on the result screen, or just "YOU" / "OPPONENT"?

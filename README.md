# tetris-threejs

A Three.js port of [mhak/tetris](https://github.com/mhak/tetris), the two-player
MonoGame versus Tetris. It runs as a **single-player** game built for phones as
well as desktop, and as **online versus** between two devices with a join code
(see [Playing online](#playing-online)). Local 2-player on one device is
switched off for now (set `PLAYER_COUNT` to 2 in `src/main.js` and uncomment
the P2 controls in `index.html` to bring it back). The game rules are ported
one-to-one from the C# code; rendering is now a 3D scene with textured cubes,
glass-style wells and a slowly drifting camera.

## Running

```sh
npm install
npm run dev      # dev server
npm run build    # static build in dist/
npm test         # game-logic and online tests (node:test)
```

## Playing online

Two devices (phone, tablet or desktop, in any mix) play one versus match:

1. One player taps **Create room**, picks a name and gets a 5-character code,
   a **Share link** button and a QR code.
2. The other taps **Join room** and types the code (it connects by itself once
   all 5 characters are in), or opens the link or scans the QR code and taps
   **Tap to join**.
3. After a 3-2-1 countdown the round starts. Each device shows its own well
   full size and the opponent's as a small live view with their name and score.

- Both players get the same pieces each round.
- A Tetris sends a garbage line, and all four powers work: Add Line and Drop
  hit the other player.
- Pause (the button, or the app going to the background) pauses both devices;
  play resumes after a 3-2-1 countdown.
- The first player to top out loses; topping out within 250 ms of each other
  is a draw. The host's device decides, so both screens always agree.
- After a round, Start, a tap or **Rematch** says you're ready; the next round
  starts when both are. The win counter stays for the life of the room.
  **Leave** ends the room for both.
- If the connection drops, both pause and show a 30-second Reconnecting
  countdown. If the connection doesn't come back, a player whose app was in
  the background loses; otherwise nobody wins. A page reload keeps the room
  and the win counter (**Tap to rejoin**) but loses the round in progress.

How it works: the devices connect peer to peer over a WebRTC data channel
using [PeerJS](https://peerjs.com). PeerJS's free public broker is only used to
set up the connection, and its free TURN relay helps on networks where a
direct connection fails. Nothing extra is hosted, and PeerJS is only loaded
when someone creates or joins a room. Both devices must run the same build: a
device on an old cached page is asked to reload. The design is in
[docs/online-2p-spec.md](docs/online-2p-spec.md).

To use your own [peerjs-server](https://github.com/peers/peerjs-server)
instead of the public broker, build with
`VITE_PEER_SERVER=https://your-server.example/path npm run build`.

For development, `?debug=loopback` runs a host and a guest side by side in one
tab over an in-memory connection (left: WASD keys, right: arrow keys;
`&latency=100` adds delay).

## Deploying

`.github/workflows/deploy.yml` builds and tests every pull request, and deploys
to GitHub Pages on every push to `main` (or a manual run from the Actions tab).
One-time setup: in the repository's **Settings > Pages**, set **Source** to
**GitHub Actions**. The site is then served at
`https://<owner>.github.io/tetris-threejs/`.

The site asks search engines not to index it: `index.html` has a
`noindex, nofollow` robots meta tag, and `public/robots.txt` disallows all
crawlers. Crawlers only read `robots.txt` at a domain root, so on a project
page like this one the meta tag is what takes effect; `robots.txt` applies if
the site is ever served from its own domain. Neither one hides the site from
people who have the link.

## What was ported

| Original (C#) | Port |
| --- | --- |
| `Models/TetrisField.cs` | `src/game/tetrisField.js` |
| `Models/Tetrinoms/*.cs` | `src/game/tetromino.js` |
| `GameLogic/WallKick.cs` | `src/game/wallKick.js` |
| `Models/Block.cs` | `src/game/block.js` |
| `Screens/GameScreen.cs` (rules, input, powers) | `src/game/gameScreen.js` |
| `Screens/GameScreen.cs` (drawing) | `src/render/renderer.js` |
| MonoGame `GamePad` | `src/game/input.js` (Gamepad API + keyboard) |
| `SoundEffect` / `MediaPlayer` | `src/audio.js` (Web Audio + `<audio>`) |
| `Content/` | `public/assets/` |

Online play is new: `src/net/` (transport, PeerJS, join codes, names,
protocol, room session), `src/game/remoteField.js`, `src/game/random.js` and
`src/ui/` (lobby and in-match status).

Gameplay is the same: 2 players, hold, next, ghost piece, SRS-style wall kicks,
a Tetris sends a garbage line to the opponent, and power blocks (add line,
clear line, drop, left slide) that spawn every 4 lines and are collected by
clearing the row they sit in.

Intentional differences:

- Touch controls and a phone layout: on a tall screen the score, hold and next
  sit in a compact HUD above the well, and the buttons are at the bottom (or on
  the right when the phone is sideways).
- In single-player only the Clear Line and Left Slide powers spawn, since Add
  Line and Drop hit the opponent. All four come back in 2-player and online play.
- Keyboard controls were added (gamepads still work).
- A start screen is shown first, because browsers only allow audio after a user gesture.
  If you start with a controller, sound begins after the first key press or click.
- Bugs from the original were fixed:
  - A garbage line, or your own Clear Line / Left Slide power, no longer ends the
    game when it shifts blocks under the falling piece; the piece is pushed up instead.
  - Game over happens only when a piece locks with cells above the well (or a new
    piece can't spawn), not whenever a piece's empty top rows stick out.
  - A piece swapped in from hold spawns at the normal spawn row, and held pieces
    return to their spawn rotation.
  - The ghost piece is always up to date (it used to float too high after a line clear).
  - The power counter counts cleared rows correctly, so a power spawns every
    4 cleared lines (rows that paid out a power don't count).
  - If both players top out in the same frame the round is a draw and Start restarts it.
  - Powers no longer affect players who are already out.
  - `SpawnRandomPower` picks from the valid cells directly, so it can't hang.
- `Arcade.wav` and the two line-clear sounds were re-encoded as MP3 (19 MB to 2.6 MB).

## Controls

### Touch

| Gesture | Action |
| --- | --- |
| Drag left / right | Move one column per cell dragged |
| Drag down | Soft drop |
| Flick down | Hard drop |
| Flick up | Hold |
| Tap the board | Rotate right (or restart after game over; online, ready for a rematch) |

The button bar has Hold, Rotate left, Rotate right, Use power and Pause.
The game pauses itself when the app goes to the background.

### Keyboard and gamepad

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Move | A / D or Left / Right | Stick or D-pad |
| Soft drop | S or Down | Down |
| Hard drop | W or Up | Up |
| Rotate left / right | Q / E or , / . | X / A |
| Hold | R or / | RB |
| Use power | F or L | Y |
| Cycle powers | Z / C or K / ; | LT / RT |
| Pause, restart after game over (online: rematch) | Space or Enter | Start |

In 2-player mode on one device, player 1 uses the first keyboard set and
player 2 the second. Online, either set controls your own board.

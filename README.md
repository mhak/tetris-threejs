# tetris-threejs

A Three.js port of [mhak/tetris](https://github.com/mhak/tetris), the two-player
MonoGame versus Tetris. The game rules are ported one-to-one from the C# code;
rendering is now a 3D scene with textured cubes, glass-style wells and a
slowly drifting camera.

## Running

```sh
npm install
npm run dev      # dev server
npm run build    # static build in dist/
npm test         # game-logic tests (node:test)
```

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

Gameplay is the same: 2 players, hold, next, ghost piece, SRS-style wall kicks,
a Tetris sends a garbage line to the opponent, and power blocks (add line,
clear line, drop, left slide) that spawn every 4 lines and are collected by
clearing the row they sit in.

Intentional differences:

- Keyboard controls were added for both players (gamepads still work).
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

| Action | Player 1 | Player 2 | Gamepad |
| --- | --- | --- | --- |
| Move | A / D | Left / Right | Stick or D-pad |
| Soft drop | S | Down | Down |
| Hard drop | W | Up | Up |
| Rotate left / right | Q / E | , / . | X / A |
| Hold | R | / | RB |
| Use power | F | L | Y |
| Cycle powers | Z / C | K / ; | LT / RT |
| Pause, restart after a win | Space | Enter | Start |

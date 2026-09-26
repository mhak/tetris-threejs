// Port of Tetris/Models/Tetrinoms/*.cs
export type PieceKind = 'I' | 'O' | 'T' | 'J' | 'L' | 'S' | 'Z';

export class Tetromino {
  kind: PieceKind;
  shape: number[][];
  posX: number;
  posY: number;
  orientation: number; // 0..3, clockwise from the spawn orientation

  constructor(kind: PieceKind, shape: readonly (readonly number[])[], x = 0, y = 0) {
    this.kind = kind;
    // Copy so every piece owns its own matrix (rotations mutate it in place).
    this.shape = shape.map((row) => row.slice());
    this.posX = x;
    this.posY = y;
    this.orientation = 0;
  }

  /** Turns the piece back to its spawn orientation. */
  resetRotation() {
    while (this.orientation !== 0) this.rotateLeft();
  }

  rotateLeft() {
    const s = this.shape;
    const n = s.length;
    for (let x = 0; x < Math.floor(n / 2); x++) {
      for (let y = x; y < n - x - 1; y++) {
        const temp = s[x][y];
        s[x][y] = s[y][n - 1 - x];
        s[y][n - 1 - x] = s[n - 1 - x][n - 1 - y];
        s[n - 1 - x][n - 1 - y] = s[n - 1 - y][x];
        s[n - 1 - y][x] = temp;
      }
    }
    this.orientation = this.orientation === 0 ? 3 : this.orientation - 1;
  }

  rotateRight() {
    const s = this.shape;
    const n = s.length;
    for (let x = 0; x < Math.floor(n / 2); x++) {
      for (let y = x; y < n - x - 1; y++) {
        const temp = s[n - 1 - y][x];
        s[n - 1 - y][x] = s[n - 1 - x][n - 1 - y];
        s[n - 1 - x][n - 1 - y] = s[y][n - 1 - x];
        s[y][n - 1 - x] = s[x][y];
        s[x][y] = temp;
      }
    }
    this.orientation = this.orientation === 3 ? 0 : this.orientation + 1;
  }
}

export const SHAPES: Record<PieceKind, readonly (readonly number[])[]> = {
  I: [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [6, 6, 6, 6],
    [0, 0, 0, 0],
  ],
  O: [
    [5, 5],
    [5, 5],
  ],
  T: [
    [0, 4, 0],
    [4, 4, 4],
    [0, 0, 0],
  ],
  J: [
    [1, 0, 0],
    [1, 1, 1],
    [0, 0, 0],
  ],
  L: [
    [0, 0, 7],
    [7, 7, 7],
    [0, 0, 0],
  ],
  S: [
    [0, 3, 3],
    [3, 3, 0],
    [0, 0, 0],
  ],
  Z: [
    [2, 2, 0],
    [0, 2, 2],
    [0, 0, 0],
  ],
};

// Same order as TetrisField's Tetrominos list.
export const TETROMINO_KINDS: readonly PieceKind[] = ['I', 'O', 'T', 'J', 'L', 'S', 'Z'];

export function createTetromino(kind: PieceKind): Tetromino {
  return new Tetromino(kind, SHAPES[kind]);
}

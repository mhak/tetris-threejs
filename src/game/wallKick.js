// Port of Tetris/GameLogic/WallKick.cs
// Each row is indexed by the piece orientation after rotation; entries are [x, y].
export const ClockwiseOffsets = [
  [[-1, 0], [-1, -1], [0, 2], [-1, 2]],
  [[-1, 0], [-1, 1], [0, -2], [-1, -2]],
  [[1, 0], [1, -1], [0, 2], [1, 2]],
  [[1, 0], [1, 1], [0, -2], [1, -2]],
];

export const CounterclockwiseOffsets = [
  [[1, 0], [1, -1], [0, 2], [1, 2]],
  [[-1, 0], [-1, 1], [0, -2], [-1, -2]],
  [[-1, 0], [-1, -1], [0, 2], [-1, 2]],
  [[1, 0], [1, 1], [0, -2], [1, -2]],
];

export const LineClockwiseOffsets = [
  [[1, 0], [-2, 0], [1, -2], [-2, 1]],
  [[-2, 0], [1, 0], [-2, -1], [1, 2]],
  [[-1, 0], [2, 0], [-1, 2], [2, -1]],
  [[2, 0], [-1, 0], [2, 1], [-1, -2]],
];

export const LineCounterclockwiseOffsets = [
  [[2, 0], [-1, 0], [2, 1], [-1, -2]],
  [[1, 0], [-2, 0], [1, -2], [-2, 1]],
  [[-2, 0], [1, 0], [-2, -1], [1, 2]],
  [[-1, 0], [2, 0], [-1, 2], [2, -1]],
];

// Each row is indexed by the piece orientation after rotation; entries are [x, y].
export type KickTable = readonly (readonly (readonly [number, number])[])[];

export const ClockwiseOffsets: KickTable = [
  [[-1, 0], [-1, -1], [0, 2], [-1, 2]],
  [[-1, 0], [-1, 1], [0, -2], [-1, -2]],
  [[1, 0], [1, -1], [0, 2], [1, 2]],
  [[1, 0], [1, 1], [0, -2], [1, -2]],
];

export const CounterclockwiseOffsets: KickTable = [
  [[1, 0], [1, -1], [0, 2], [1, 2]],
  [[-1, 0], [-1, 1], [0, -2], [-1, -2]],
  [[-1, 0], [-1, -1], [0, 2], [-1, 2]],
  [[1, 0], [1, 1], [0, -2], [1, -2]],
];

export const LineClockwiseOffsets: KickTable = [
  [[1, 0], [-2, 0], [1, -2], [-2, 1]],
  [[-2, 0], [1, 0], [-2, -1], [1, 2]],
  [[-1, 0], [2, 0], [-1, 2], [2, -1]],
  [[2, 0], [-1, 0], [2, 1], [-1, -2]],
];

export const LineCounterclockwiseOffsets: KickTable = [
  [[2, 0], [-1, 0], [2, 1], [-1, -2]],
  [[1, 0], [-2, 0], [1, -2], [-2, 1]],
  [[-2, 0], [1, 0], [-2, -1], [1, 2]],
  [[-1, 0], [2, 0], [-1, 2], [2, -1]],
];

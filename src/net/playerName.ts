// Player names: 1 to 10 of A-Z, 0-9 and space, which both the Press Start 2P
// font and the 3D text can draw.
export const NAME_MAX = 10;
export const DEFAULT_NAME = 'PLAYER';
const STORAGE_KEY = 'tetris-threejs-name';
const ALLOWED = /[A-Z0-9 ]/;

/** For the text field while typing: upper case, allowed characters, max length. */
export function normalizeNameInput(raw: unknown): string {
  let name = '';
  for (const ch of String(raw ?? '').toUpperCase()) {
    if (ALLOWED.test(ch)) name += ch;
  }
  return name.trimStart().slice(0, NAME_MAX);
}

/** The final name, for our own and for one received from the other player. */
export function cleanName(raw: unknown): string {
  const name = normalizeNameInput(typeof raw === 'string' ? raw : '').trim();
  return name || DEFAULT_NAME;
}

/** [local, remote] as shown on screen; a clash gets a 2 on the opponent's name. */
export function displayNames(local: string, remote: string): [string, string] {
  return [local, remote === local ? `${remote}2` : remote];
}

export function loadName(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): string {
  try {
    return normalizeNameInput(storage?.getItem(STORAGE_KEY) ?? '').trim();
  } catch {
    return '';
  }
}

export function saveName(name: string, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, name);
  } catch {
    // Private mode or storage disabled: the name just isn't remembered.
  }
}

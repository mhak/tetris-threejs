// Join codes for online rooms: 5 characters that are easy to read out loud
// and type on a phone (no 0 O 1 I L).
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 5;

// Keeps our IDs apart from other apps on the shared PeerJS broker.
export const PEER_PREFIX = 'tetris-threejs-';

export type RandomValues = (bytes: Uint8Array<ArrayBuffer>) => Uint8Array;

const defaultRandomValues: RandomValues = (bytes) => globalThis.crypto.getRandomValues(bytes);

/** A new random code. Rejection sampling keeps every symbol equally likely. */
export function generateCode(getRandomValues: RandomValues = defaultRandomValues): string {
  const n = CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let code = '';
  while (code.length < CODE_LENGTH) {
    for (const byte of getRandomValues(new Uint8Array(CODE_LENGTH * 2))) {
      if (byte >= limit) continue;
      code += CODE_ALPHABET[byte % n];
      if (code.length === CODE_LENGTH) break;
    }
  }
  return code;
}

/** Cleans typed input: upper case, only code characters, at most 5 of them. */
export function normalizeCode(input: unknown): string {
  let code = '';
  for (const ch of String(input ?? '').toUpperCase()) {
    if (CODE_ALPHABET.includes(ch)) code += ch;
    if (code.length === CODE_LENGTH) break;
  }
  return code;
}

/**
 * Typed or pasted input to a code: a pasted join link gives its ?join= code,
 * anything else goes through normalizeCode (so "k7q-x3" becomes "K7QX3").
 */
export function codeFromInput(input: unknown): string {
  const text = String(input ?? '');
  const link = /[?&]join=([^&#\s]*)/i.exec(text);
  return normalizeCode(link ? link[1] : text);
}

export function isValidCode(code: unknown): code is string {
  return typeof code === 'string' && code.length === CODE_LENGTH && normalizeCode(code) === code;
}

export function peerIdFor(code: string): string {
  return PEER_PREFIX + code;
}

// Join codes for online rooms: 5 characters that are easy to read out loud
// and type on a phone (no 0 O 1 I L).
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 5;

// Keeps our IDs apart from other apps on the shared PeerJS broker.
export const PEER_PREFIX = 'tetris-threejs-';

const defaultRandomValues = (bytes) => globalThis.crypto.getRandomValues(bytes);

/** A new random code. Rejection sampling keeps every symbol equally likely. */
export function generateCode(getRandomValues = defaultRandomValues) {
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
export function normalizeCode(input) {
  let code = '';
  for (const ch of String(input ?? '').toUpperCase()) {
    if (CODE_ALPHABET.includes(ch)) code += ch;
    if (code.length === CODE_LENGTH) break;
  }
  return code;
}

export function isValidCode(code) {
  return typeof code === 'string' && code.length === CODE_LENGTH && normalizeCode(code) === code;
}

export function peerIdFor(code) {
  return PEER_PREFIX + code;
}

// Online protocol: every message is a JSON object with a `t` (type) field,
// sent over one reliable, ordered data channel. See docs/online-2p-spec.md.

/* global __BUILD_ID__ */
// The deployed commit, injected by vite.config.js. Two devices only play when
// their IDs match, so both run the same rules and the same piece generator.
export const BUILD_ID = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';

export const MSG = Object.freeze({
  hello: 'hello', // { v, name, token? } first message both ways; must keep this shape forever
  full: 'full', // host to guest: room already has a guest
  version: 'version', // { v } build IDs differ; must keep this shape forever
});

/** True for something that looks like a protocol message. */
export function isMessage(msg) {
  return msg != null && typeof msg === 'object' && typeof msg.t === 'string';
}

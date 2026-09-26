// The deployed commit, injected by vite.config.ts (see src/net/protocol.ts).
declare const __BUILD_ID__: string;

interface ImportMetaEnv {
  readonly VITE_PEER_SERVER?: string;
}

interface Window {
  // ?debug=loopback: the two sessions, for poking at from the console.
  debugSessions?: unknown;
}

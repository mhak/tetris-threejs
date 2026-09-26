// Room features over the in-memory transport: rematch, leaving, reconnects,
// reloads and what happens when the grace period runs out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopbackNetwork, LoopbackTransport } from '../src/net/transport.js';
import { Session, COUNTDOWN_MS, RESULT_WINDOW_MS, LIVENESS_MS, GRACE_MS } from '../src/net/session.js';
import { emptyState } from '../src/game/input.js';
import { Block } from '../src/game/block.js';
import { Height } from '../src/game/tetrisField.js';
import { FakeClock, flush } from './helpers.js';

const idle = () => emptyState();

function memoryStorage() {
  let value = null;
  return {
    load: () => (value ? JSON.parse(value) : null),
    save: (room) => (value = JSON.stringify(room)),
    clear: () => (value = null),
  };
}

async function room() {
  const network = new LoopbackNetwork();
  const clock = new FakeClock();
  const seeds = [11, 22, 33, 44];
  const hostStorage = memoryStorage();
  const guestStorage = memoryStorage();
  const r = { network, clock, hostStorage, guestStorage };
  r.host = new Session({
    role: 'host',
    name: 'alex',
    transport: new LoopbackTransport(network),
    clock,
    storage: hostStorage,
    makeCode: () => 'K7QX3',
    makeSeed: () => seeds.shift(),
  });
  await r.host.open();
  r.guest = new Session({
    role: 'guest',
    name: 'sam',
    code: 'K7QX3',
    transport: new LoopbackTransport(network),
    clock,
    storage: guestStorage,
  });
  await r.guest.open();
  await flush();
  /** Advances time in small steps, running both frame loops. */
  r.wait = async (ms, step = 100) => {
    for (let t = 0; t < ms; t += step) {
      clock.advance(step);
      r.host.update(step, idle);
      r.guest.update(step, idle);
      await flush();
    }
  };
  await r.wait(COUNTDOWN_MS);
  return r;
}

async function finishRound(r, loser = 'guest') {
  r[loser].game.players[0].isGameOver = true;
  await r.wait(RESULT_WINDOW_MS + 100);
}

const garbage = (field) => field[Height - 1].filter((v) => v === Block.Z).length;

test('rematch: once both are ready the host starts a new round with a new seed', async () => {
  const r = await room();
  await finishRound(r);
  r.guest.pressStart(); // Start or a tap after the round means ready
  await r.wait(100);
  assert.equal(r.host.state, 'roundOver');
  assert.equal(r.host.ready.guest, true);
  assert.equal(r.guest.ready.guest, true);
  r.host.sendReady();
  await r.wait(100);
  for (const s of [r.host, r.guest]) {
    assert.equal(s.round, 2);
    assert.equal(s.seed, 22);
    assert.equal(s.state, 'countdown');
    assert.deepEqual(s.wins, { host: 1, guest: 0 });
  }
  assert.equal(r.guest.game.result, null);
  await r.wait(COUNTDOWN_MS);
  assert.equal(r.guest.state, 'playing');
  assert.deepEqual(r.guest.score, [0, 1]);
  assert.deepEqual(r.host.score, [1, 0]);
});

test('ready from one side only does not start a round', async () => {
  const r = await room();
  await finishRound(r, 'host');
  r.host.sendReady();
  r.host.sendReady();
  await r.wait(1000);
  assert.equal(r.host.round, 1);
  assert.equal(r.guest.state, 'roundOver');
  assert.equal(r.guest.ready.host, true);
});

test('leaving tells the opponent', async () => {
  const r = await room();
  r.guest.leave();
  await flush();
  assert.equal(r.guest.closeReason, 'left');
  assert.equal(r.host.state, 'closed');
  assert.equal(r.host.closeReason, 'bye');
  assert.equal(r.hostStorage.load(), null);
});

test('ping and pong measure the latency', async () => {
  const r = await room();
  assert.ok(Number.isFinite(r.host.latency));
  assert.ok(Number.isFinite(r.guest.latency));
});

test('silence for 5 s pauses both and shows reconnecting', async () => {
  const r = await room();
  r.network.cut = true;
  await r.wait(LIVENESS_MS - 1000);
  assert.equal(r.host.state, 'playing');
  await r.wait(1100);
  assert.equal(r.host.state, 'reconnecting');
  assert.equal(r.guest.state, 'reconnecting');
  assert.equal(r.host.game.pause, true);
  assert.ok(r.host.graceLeft > 25 && r.host.graceLeft <= 30);
});

test('a reconnect inside the grace period resumes the round with a countdown', async () => {
  const r = await room();
  const hostBoard = r.host.game.players[0];
  const guestBoard = r.guest.game.players[0];
  hostBoard.field[Height - 1][0] = Block.T;
  r.network.cut = true;
  await r.wait(LIVENESS_MS + 500);
  assert.equal(r.guest.state, 'reconnecting');
  r.network.cut = false;
  await r.wait(12000);
  for (const s of [r.host, r.guest]) {
    assert.ok(s.state === 'countdown' || s.state === 'playing', s.state);
    assert.equal(s.round, 1);
  }
  await r.wait(COUNTDOWN_MS);
  assert.equal(r.host.state, 'playing');
  assert.equal(r.guest.state, 'playing');
  // Each side kept its own board, and the mirror caught up.
  assert.equal(r.host.game.players[0], hostBoard);
  assert.equal(r.guest.game.players[0], guestBoard);
  assert.equal(r.guest.game.players[1].field[Height - 1][0], Block.T);
});

test('a channel that closes reconnects too, and play goes on', async () => {
  const r = await room();
  const states = [];
  r.guest.onChange = () => states.push(r.guest.state);
  r.guest.transport.sever();
  await r.wait(RETRY_WAIT);
  assert.deepEqual(states.slice(0, 2), ['reconnecting', 'countdown']);
  assert.equal(r.host.state, 'countdown');
  assert.equal(r.guest.state, 'countdown');
  await r.wait(COUNTDOWN_MS);
  const h = r.host.game.players[0];
  for (let y = Height - 4; y < Height; y++) h.field[y].fill(Block.J);
  await r.wait(100);
  assert.equal(garbage(r.guest.game.players[0].field), 9);
});
const RETRY_WAIT = 2500;

test('a reconnect during the result screen goes back to it', async () => {
  const r = await room();
  await finishRound(r);
  r.guest.transport.sever();
  await r.wait(RETRY_WAIT);
  assert.equal(r.host.state, 'roundOver');
  assert.equal(r.guest.state, 'roundOver');
  r.host.sendReady();
  r.guest.sendReady();
  await r.wait(100);
  assert.equal(r.guest.round, 2);
});

test('a result decided during an outage reaches the guest after the reconnect', async () => {
  const r = await room();
  r.network.cut = true;
  r.guest.game.players[0].isGameOver = true; // its over never arrives
  r.host.game.players[0].isGameOver = true; // the host's does, locally
  await r.wait(LIVENESS_MS + 500);
  assert.equal(r.host.result, 'guest');
  assert.equal(r.guest.result, null);
  r.network.cut = false;
  await r.wait(12000);
  assert.equal(r.guest.result, 'guest');
  assert.equal(r.guest.state, 'roundOver');
  assert.deepEqual(r.guest.wins, r.host.wins);
});

test('a guest reload rejoins with the token and loses the round', async () => {
  const r = await room();
  const saved = r.guestStorage.load();
  assert.equal(saved.token, r.host.token);
  assert.equal(saved.round, 1);
  assert.equal(saved.field, undefined); // nothing about the board
  r.guest.shutdown(); // the old page goes away
  await r.wait(100);
  assert.equal(r.host.state, 'reconnecting');

  const g2 = Session.restore(saved, { transport: new LoopbackTransport(r.network), clock: r.clock, storage: r.guestStorage });
  r.guest = g2;
  await g2.open();
  await r.wait(1000);
  for (const s of [r.host, g2]) {
    assert.equal(s.state, 'roundOver');
    assert.equal(s.result, 'host');
    assert.deepEqual(s.wins, { host: 1, guest: 0 });
  }
  assert.equal(g2.remoteName, 'ALEX');
});

test('a host reload keeps the room and loses the round', async () => {
  const r = await room();
  await finishRound(r, 'host'); // guest leads 1-0
  r.host.sendReady();
  r.guest.sendReady();
  await r.wait(COUNTDOWN_MS + 200);
  assert.equal(r.guest.state, 'playing');
  const saved = r.hostStorage.load();
  r.host.shutdown();
  await r.wait(100);
  assert.equal(r.guest.state, 'reconnecting');

  const h2 = Session.restore(saved, {
    transport: new LoopbackTransport(r.network),
    clock: r.clock,
    storage: r.hostStorage,
    makeSeed: () => 99,
  });
  r.host = h2;
  await h2.open();
  await r.wait(4000);
  for (const s of [h2, r.guest]) {
    assert.equal(s.state, 'roundOver');
    assert.equal(s.round, 2);
    assert.equal(s.result, 'guest');
    assert.deepEqual(s.wins, { host: 0, guest: 2 });
  }
  // The room carries on with the same code.
  h2.sendReady();
  r.guest.sendReady();
  await r.wait(100);
  assert.equal(r.guest.round, 3);
  assert.equal(r.guest.seed, 99);
});

test('a reload after the round ended goes straight back to the result screen', async () => {
  const r = await room();
  await finishRound(r);
  const saved = r.guestStorage.load();
  assert.equal(saved.result, 'host');
  r.guest.shutdown();
  const g2 = Session.restore(saved, { transport: new LoopbackTransport(r.network), clock: r.clock });
  r.guest = g2;
  await g2.open();
  await r.wait(1000);
  assert.equal(g2.state, 'roundOver');
  assert.deepEqual(g2.wins, { host: 1, guest: 0 });
  assert.deepEqual(r.host.wins, { host: 1, guest: 0 });
});

test('an old saved room is not offered after a reload', () => {
  const clock = new FakeClock();
  const saved = { role: 'guest', code: 'K7QX3', names: ['SAM', 'ALEX'], token: 'abc', round: 1, lastSeen: clock.now() - GRACE_MS - 1 };
  assert.equal(Session.restore(saved, { transport: new LoopbackTransport(new LoopbackNetwork()), clock }), null);
  assert.equal(Session.restore(null, { clock }), null);
  assert.equal(Session.restore({ ...saved, lastSeen: clock.now(), code: 'nope' }, { clock }), null);
});

test('a wrong token gets full while the room waits for its guest', async () => {
  const r = await room();
  r.guest.transport.sever();
  const stranger = new Session({
    role: 'guest',
    name: 'kim',
    code: 'K7QX3',
    transport: new LoopbackTransport(r.network),
    clock: r.clock,
  });
  stranger.token = 'not-the-token';
  await stranger.open();
  await flush();
  assert.equal(stranger.closeReason, 'full');
  await r.wait(RETRY_WAIT);
  assert.equal(r.guest.state, 'countdown');
});

test('after the grace period a plain outage ends with no winner', async () => {
  const r = await room();
  r.network.cut = true;
  await r.wait(LIVENESS_MS + GRACE_MS + 1000, 500);
  for (const s of [r.host, r.guest]) {
    assert.equal(s.state, 'closed');
    assert.equal(s.closeReason, 'lost');
  }
  assert.equal(r.guestStorage.load(), null);
});

test('after the grace period the side that went to the background loses', async () => {
  const r = await room();
  r.guest.setHidden(true);
  await r.wait(100);
  assert.equal(r.host.state, 'paused');
  assert.equal(r.host.remoteAway, true);
  r.network.cut = true; // e.g. the phone locked and the page was suspended
  await r.wait(LIVENESS_MS + GRACE_MS + 1000, 500);
  assert.equal(r.host.closeReason, 'forfeit-win');
  assert.equal(r.guest.closeReason, 'forfeit-lose');
});

test('coming back from the background inside the grace period just pauses', async () => {
  const r = await room();
  r.host.setHidden(true);
  await r.wait(2000);
  r.host.setHidden(false);
  assert.equal(r.guest.state, 'paused');
  r.host.pressStart(); // resume
  await r.wait(COUNTDOWN_MS + 100);
  assert.equal(r.guest.state, 'playing');
  assert.equal(r.guest.remoteAway, false);
  assert.equal(r.host.localAway, false);
});

test('a page back from a long suspension sees that it left', async () => {
  const r = await room();
  r.guest.setHidden(true);
  await r.wait(100);
  // Frozen page: the guest's timers and frames stop, the host's carry on.
  r.network.cut = true;
  const guestTick = r.guest.tick.bind(r.guest);
  r.guest.tick = () => {};
  const guestUpdate = r.guest.update;
  r.guest.update = () => {};
  await r.wait(LIVENESS_MS + GRACE_MS + 1000, 500);
  assert.equal(r.host.closeReason, 'forfeit-win');
  r.guest.tick = guestTick;
  r.guest.update = guestUpdate;
  r.guest.setHidden(false);
  assert.equal(r.guest.state, 'closed');
  assert.equal(r.guest.closeReason, 'forfeit-lose');
});

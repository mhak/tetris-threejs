import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopbackNetwork, LoopbackTransport } from '../src/net/transport.js';
import { Session } from '../src/net/session.js';
import { FakeClock, flush } from './helpers.js';

function room({ hostBuild = 'b1', guestBuild = 'b1' } = {}) {
  const network = new LoopbackNetwork();
  const clock = new FakeClock();
  const host = new Session({
    role: 'host',
    name: 'alex',
    transport: new LoopbackTransport(network),
    clock,
    buildId: hostBuild,
    makeCode: () => 'K7QX3',
  });
  const guest = (name = 'sam', code = 'K7QX3', buildId = guestBuild) =>
    new Session({ role: 'guest', name, code, transport: new LoopbackTransport(network), clock, buildId });
  return { network, clock, host, guest };
}

test('a guest joins with the code and both learn the other name', async () => {
  const { host, guest } = room();
  await host.open();
  assert.equal(host.state, 'waiting');
  assert.equal(host.code, 'K7QX3');
  const g = guest();
  await g.open();
  await flush();
  assert.equal(host.state, 'playing');
  assert.equal(g.state, 'playing');
  assert.equal(host.remoteName, 'SAM');
  assert.equal(g.remoteName, 'ALEX');
  assert.equal(g.token, host.token);
  assert.ok(host.token.length >= 16);
});

test('joining a code nobody hosts fails with not-found', async () => {
  const { guest } = room();
  const g = guest();
  await g.open();
  assert.equal(g.state, 'closed');
  assert.equal(g.closeReason, 'not-found');
});

test('a second guest is turned away with full', async () => {
  const { host, guest } = room();
  await host.open();
  const g1 = guest();
  await g1.open();
  await flush();
  const g2 = guest('kim');
  await g2.open();
  await flush();
  assert.equal(g2.state, 'closed');
  assert.equal(g2.closeReason, 'full');
  assert.equal(g1.state, 'playing');
  assert.equal(host.remoteName, 'SAM');
});

test('different builds refuse to play and the host keeps waiting', async () => {
  const { host, guest } = room({ guestBuild: 'b2' });
  await host.open();
  const g = guest();
  await g.open();
  await flush();
  assert.equal(g.state, 'closed');
  assert.equal(g.closeReason, 'version');
  assert.equal(host.state, 'waiting');
  assert.equal(host.notice, 'version');
});

test('a taken code is replaced by a new one, up to 5 tries', async () => {
  const network = new LoopbackNetwork();
  const codes = ['AAAAA', 'BBBBB'];
  const squatter = new LoopbackTransport(network);
  await squatter.host('AAAAA');
  const host = new Session({
    role: 'host',
    name: 'alex',
    transport: new LoopbackTransport(network),
    clock: new FakeClock(),
    makeCode: () => codes.shift() ?? 'AAAAA',
  });
  await host.open();
  assert.equal(host.code, 'BBBBB');

  const stuck = new Session({
    role: 'host',
    name: 'kim',
    transport: new LoopbackTransport(network),
    clock: new FakeClock(),
    makeCode: () => 'AAAAA',
  });
  await stuck.open();
  assert.equal(stuck.state, 'closed');
  assert.equal(stuck.closeReason, 'taken');
});

test('a join that gets no answer fails after 15 s', async () => {
  const { network, clock, guest } = room();
  const silent = new LoopbackTransport(network);
  await silent.host('K7QX3'); // registered, but never answers
  const g = guest();
  await g.open();
  await flush();
  assert.equal(g.state, 'joining');
  clock.advance(15000);
  assert.equal(g.state, 'closed');
  assert.equal(g.closeReason, 'failed');
});

test('the host can rename itself until the guest arrives', async () => {
  const { host, guest } = room();
  await host.open();
  host.setLocalName('robin');
  const g = guest();
  await g.open();
  await flush();
  assert.equal(g.remoteName, 'ROBIN');
  host.setLocalName('late');
  assert.equal(host.localName, 'ROBIN');
});

const idleInput = () => ({ left: false, right: false, down: false, up: false, a: false, x: false, y: false, rb: false, lt: false, rt: false, start: false });

test('each side mirrors the other board from snapshots', async () => {
  const { clock, host, guest } = room();
  await host.open();
  const g = guest();
  await g.open();
  await flush();
  const hostBoard = host.game.players[0];
  hostBoard.movePieceHardDrop();
  clock.advance(100);
  host.update(16, idleInput);
  g.update(16, idleInput);
  await flush();
  assert.deepEqual(g.game.players[1].field, hostBoard.field);
  assert.deepEqual(host.game.players[1].field, g.game.players[0].field);
  assert.equal(g.game.players[1].currentPiece.kind, hostBoard.currentPiece.kind);
});

test('snapshots are only sent on a change, at most every 50 ms', async () => {
  const { clock, host, guest } = room();
  await host.open();
  const g = guest();
  await g.open();
  await flush();
  const sent = [];
  const send = host.transport.send.bind(host.transport);
  host.transport.send = (m) => {
    if (m.t === 'state') sent.push(m);
    send(m);
  };
  clock.advance(100);
  host.update(16, idleInput);
  assert.equal(sent.length, 1);
  host.game.players[0].movePieceLeft();
  clock.advance(10);
  host.update(16, idleInput); // changed, but within 50 ms of the last one
  assert.equal(sent.length, 1);
  clock.advance(50);
  host.update(16, idleInput);
  assert.equal(sent.length, 2);
  clock.advance(100);
  host.update(16, idleInput); // nothing changed
  assert.equal(sent.length, 2);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_ALPHABET, CODE_LENGTH, codeFromInput, generateCode, isValidCode, normalizeCode, peerIdFor } from '../src/net/joinCode.ts';

test('the code alphabet has 31 symbols and none that look alike', () => {
  assert.equal(CODE_ALPHABET.length, 31);
  for (const ch of '0O1IL') assert.ok(!CODE_ALPHABET.includes(ch), ch);
  assert.equal(new Set(CODE_ALPHABET).size, CODE_ALPHABET.length);
});

test('generated codes are 5 alphabet characters', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateCode();
    assert.equal(code.length, CODE_LENGTH);
    assert.ok(isValidCode(code), code);
  }
});

test('generateCode skips bytes that would bias the alphabet', () => {
  // 248..255 are rejected, so the first usable bytes are 0, 30, 31, 61, 247.
  const bytes = [255, 248, 0, 30, 31, 61, 247];
  const code = generateCode((buf) => {
    buf.fill(0);
    bytes.forEach((b, i) => (buf[i] = b));
    return buf;
  });
  assert.equal(code, '2Z2Z' + CODE_ALPHABET[247 % 31]);
});

test('normalizeCode upper-cases, drops other characters and stops at 5', () => {
  assert.equal(normalizeCode('k7qx3'), 'K7QX3');
  assert.equal(normalizeCode(' k7-q x3 '), 'K7QX3');
  assert.equal(normalizeCode('K7QX3ABC'), 'K7QX3');
  assert.equal(normalizeCode('0O1IL'), '');
  assert.equal(normalizeCode(null), '');
});

test('isValidCode needs exactly 5 alphabet characters', () => {
  assert.equal(isValidCode('K7QX3'), true);
  assert.equal(isValidCode('K7QX'), false);
  assert.equal(isValidCode('k7qx3'), false);
  assert.equal(isValidCode('K7QX0'), false);
  assert.equal(isValidCode(12345), false);
});

test('peer IDs carry the app prefix', () => {
  assert.equal(peerIdFor('K7QX3'), 'tetris-threejs-K7QX3');
});

test('a pasted code or join link gives the code', () => {
  assert.equal(codeFromInput('K7Q-X3'), 'K7QX3');
  assert.equal(codeFromInput('https://mhak.github.io/tetris-threejs/?join=k7qx3'), 'K7QX3');
  assert.equal(codeFromInput('join me: https://x.io/?a=1&join=K7QX3#top'), 'K7QX3');
  assert.equal(codeFromInput('K7Q'), 'K7Q');
  assert.equal(codeFromInput(null), '');
});

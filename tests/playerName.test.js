import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanName, displayNames, loadName, normalizeNameInput, saveName } from '../src/net/playerName.js';

test('typed names are upper case, A-Z 0-9 and space, at most 10', () => {
  assert.equal(normalizeNameInput('alex'), 'ALEX');
  assert.equal(normalizeNameInput('al-ex_2!'), 'ALEX2');
  assert.equal(normalizeNameInput('abcdefghijklm'), 'ABCDEFGHIJ');
  assert.equal(normalizeNameInput('  al ex'), 'AL EX');
  assert.equal(normalizeNameInput('ÅSA'), 'SA');
});

test('cleanName trims, and empty becomes PLAYER', () => {
  assert.equal(cleanName('  sam  '), 'SAM');
  assert.equal(cleanName('abcdefghi jk'), 'ABCDEFGHI');
  assert.equal(cleanName(''), 'PLAYER');
  assert.equal(cleanName('   '), 'PLAYER');
  assert.equal(cleanName('!!!'), 'PLAYER');
});

test('cleanName cleans whatever the other client sends', () => {
  assert.equal(cleanName('<img src=x>'), 'IMG SRCX');
  assert.equal(cleanName(42), 'PLAYER');
  assert.equal(cleanName(null), 'PLAYER');
  assert.equal(cleanName({ toString: () => 'x' }), 'PLAYER');
  assert.equal(cleanName('a'.repeat(1000)), 'AAAAAAAAAA');
});

test('the same name twice gets a 2 on the opponent', () => {
  assert.deepEqual(displayNames('ALEX', 'SAM'), ['ALEX', 'SAM']);
  assert.deepEqual(displayNames('PLAYER', 'PLAYER'), ['PLAYER', 'PLAYER2']);
});

test('the last name is remembered, and broken storage is ignored', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(loadName(storage), '');
  saveName('SAM', storage);
  assert.equal(loadName(storage), 'SAM');
  const broken = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
  };
  assert.equal(loadName(broken), '');
  assert.doesNotThrow(() => saveName('SAM', broken));
});

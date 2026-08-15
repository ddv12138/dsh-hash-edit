'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const E = require('../src/engine')
const {
  buildHashes, mapStableHashes, canon, idxToHash, idxOfHash, hashOfLine, splitLines
} = E

const ALL_62 = /^[A-Za-z0-9]{3}$/

test('generated anchors are unique and base-62 3-char', () => {
  const lines = ['', '}', '}', '}', 'import x', 'import x', 'a', 'a', 'a']
  const hashes = buildHashes(lines, null)
  assert.strictEqual(new Set(hashes).size, lines.length, 'unique-by-construction')
  for (const h of hashes) assert.match(h, ALL_62)
})

test('idx <-> hash round-trips for every anchor', () => {
  const lines = ['one', 'two', 'three', 'four', 'five']
  const hashes = buildHashes(lines, null)
  for (const h of hashes) assert.strictEqual(idxToHash(idxOfHash(h)), h)
})

test('canon strips CR and trims trailing whitespace', () => {
  assert.strictEqual(canon('  hello  \r\n  '), '  hello') // CR removed + trailing whitespace trimmed
  assert.strictEqual(canon('plain'), 'plain')
})

test('same canonical content -> same base hash (before collision probing)', () => {
  // two identical lines collide on base but get distinct allocated anchors
  const h1 = hashOfLine('}')
  const h2 = hashOfLine('}')
  assert.strictEqual(h1, h2)
  const hashes = buildHashes(['}', '}'], null)
  assert.notStrictEqual(hashes[0], hashes[1], 'collision resolved to distinct anchors')
})

test('anchors are stable across an insert edit', () => {
  const old = ['a', 'b', 'c', 'd', 'e']
  const h0 = buildHashes(old, null)
  const nl = ['a', 'bA', 'b', 'c', 'd', 'e'] // insert bA after b(index1)
  const h1 = mapStableHashes(h0, old, 1, 1, nl)
  assert.strictEqual(h1[0], h0[0]) // a stable
  assert.strictEqual(h1[3], h0[2]) // c stable
  assert.strictEqual(h1[4], h0[3]) // d stable
  assert.strictEqual(h1[5], h0[4]) // e stable
  assert.strictEqual(new Set(h1).size, nl.length, 'post-insert unique')
})

test('anchors are stable across a delete edit', () => {
  const old = ['a', 'b', 'c', 'd']
  const h0 = buildHashes(old, null)
  const dl = mapStableHashes(h0, old, 1, 1, ['a', 'c', 'd']) // remove b
  assert.strictEqual(dl[0], h0[0]); assert.strictEqual(dl[1], h0[2]); assert.strictEqual(dl[2], h0[3])
})

test('removed anchor is reused when identical text is re-inserted elsewhere', () => {
  const old = ['x', 'y', 'z']
  const h0 = buildHashes(old, null)
  // move y to the end
  const moved = mapStableHashes(h0, old, 1, 1, ['x', 'Q', 'z', 'y'])
  assert.strictEqual(moved[3], h0[1], 're-inserted y (now at the end) reused its removed anchor')
  assert.strictEqual(new Set(moved).size, 4)
})

test('no-op replace of a single line with identical text keeps the anchor', () => {
  const old = ['p', 'q', 'r']
  const h0 = buildHashes(old, null)
  const res = mapStableHashes(h0, old, 1, 1, ['p', 'q', 'r'])
  assert.strictEqual(res[1], h0[1])
})

test('duplicate-content survivor lines each keep a distinct anchor', () => {
  const old = ['}', '}', 'z']
  const h0 = buildHashes(old, null)
  const res = mapStableHashes(h0, old, 2, 2, ['}', '}', 'w', 'z'])
  assert.strictEqual(res[0], h0[0]); assert.strictEqual(res[1], h0[1]); assert.strictEqual(res[3], h0[2])
  assert.strictEqual(new Set(res).size, 4)
})

test('identical file content reproduces identical anchors', () => {
  const lines = ['alpha', 'beta', 'gamma', 'delta']
  const a = buildHashes(lines, null)
  const b = buildHashes(lines, null)
  assert.deepStrictEqual(a, b)
})

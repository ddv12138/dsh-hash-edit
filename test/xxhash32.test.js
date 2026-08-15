'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { xxh32 } = require('../src/engine')

// Official XXH32 (seed 0) vectors, cross-checked against the `xxhashjs` reference
// implementation in a prior session. Bit-exactness here is what makes anchors
// byte-identical to pi-hashline-edit-pro.
const VECTORS = {
  '': 0x02cc5d05,
  a: 0x550d7456,
  abc: 0x32d153ff,
  'Hello World': 0xb1fd16ee,
  'The quick brown fox jumps over the lazy dog': 0xe85ea4de,
  '\n': 0x81c9d352, // single newline
  '\u4f60\u597d': 0x6c96a25e // CJK (multibyte UTF-8)
}

test('xxh32(seed 0) matches reference vectors exactly', () => {
  for (const [input, want] of Object.entries(VECTORS)) {
    assert.strictEqual(xxh32(input, 0), want, `xxh32(${JSON.stringify(input)})`)
  }
})

test('xxh32 is deterministic and respects multibyte UTF-8', () => {
  // "./" vs "a" — different bytes must differ
  assert.notStrictEqual(xxh32('a', 0), xxh32('b', 0))
  // same input twice
  assert.strictEqual(xxh32('some content', 0), xxh32('some content', 0))
})

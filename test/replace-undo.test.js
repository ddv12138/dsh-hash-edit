'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const E = require('../src/engine')
const {
  normalizeFile, joinLines, resolveRange, computeReplace, buildHashes, splitLines, checksumOf
} = E

// Simulates the file-level read→replace→undo contract without any DSH dependency,
// exercising the exact functions the plugin's tools call.

function freshFile (raw) {
  const { bom, ending, text } = normalizeFile(raw)
  const lines = splitLines(text)
  return { bom, ending, lines, hashes: buildHashes(lines, null) }
}

test('read→replace→undo round-trips byte-exactly (LF)', () => {
  const orig = 'one\ntwo\nthree\nfour\nfive\n'
  let f = freshFile(orig)
  const h0 = f.hashes.slice()

  const range = resolveRange(f.lines, f.hashes, h0[1], h0[1])
  assert.ok(!range.error && range.fi === 1 && range.ti === 1)

  const r = computeReplace(f.lines, f.hashes, range.fi, range.ti, 'TWO\n2.5')
  assert.ok(!r.error)
  f.lines = r.newLines; f.hashes = r.newHashes

  // survivors keep anchors
  assert.strictEqual(f.hashes[0], h0[0])
  assert.strictEqual(f.hashes[f.lines.length - 1], h0[h0.length - 1])

  const edited = joinLines(f.lines, f.bom, f.ending)
  assert.strictEqual(edited, 'one\nTWO\n2.5\nthree\nfour\nfive\n')

  // undo: current normalized text must equal undo.result_content
  const cur = normalizeFile(edited)
  assert.strictEqual(cur.text, r.undo.result_content)
  // reject if file drifted
  const undoStale = normalizeFile(edited + 'DRIFTED\n')
  assert.notStrictEqual(undoStale.text, r.undo.result_content)

  // apply undo bytes
  const restored = r.undo.content.split('\n').join('\n')
  const restoredFile = joinLines(r.undo.content.split('\n'), f.bom, f.ending)
  assert.strictEqual(restoredFile, orig)
})

test('BOM and CRLF endings are preserved through replace', () => {
  const orig = '\uFEFFa\r\nb\r\nc\r\n'
  const { bom, ending } = normalizeFile(orig)
  assert.strictEqual(bom, '\uFEFF'); assert.strictEqual(ending, '\r\n')

  const lines = splitLines(normalizeFile(orig).text)
  const hashes = buildHashes(lines, null)
  const r = computeReplace(lines, hashes, 1, 1, 'B')
  const out = joinLines(r.newLines, bom, ending)
  assert.strictEqual(out, '\uFEFFa\r\nB\r\nc\r\n') // BOM + CRLF intact, b->B
})

test('resolveRange rejects stale / ambiguous / malformed anchors', () => {
  const lines = ['a', 'b', 'c']
  const hashes = buildHashes(lines, null)
  assert.match(resolveRange(lines, hashes, 'ZZZ', 'ZZZ').error, /E_STALE_ANCHOR/)
  // ambiguous: force two identical anchors by reusing one hash twice
  const dup = hashes.slice(); const other = buildHashes(lines, null)
  // build a file with a duplicated anchor to trigger ambiguity
  const dupLines = ['a', 'a', 'c']; const dupHashes = [hashes[0], hashes[0], hashes[2]]
  assert.match(resolveRange(dupLines, dupHashes, hashes[0], hashes[0]).error, /E_AMBIGUOUS_ANCHOR/)
  assert.match(resolveRange(lines, hashes, 'not-a-hash', 'x').error, /E_BAD_REF/)
})

test('checksumOf detects content change', () => {
  assert.notStrictEqual(checksumOf('a\nb\n'), checksumOf('a\nx\n'))
  assert.strictEqual(checksumOf('same\n'), checksumOf('same\n'))
})

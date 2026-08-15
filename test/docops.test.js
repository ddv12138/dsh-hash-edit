import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  openDocument, readWindow, replaceWithServed, undoFromRecord, serializeStore, parseStore
} from '../src/docops.js'

test('readWindow serves only the shown window and enforces E_RANGE_STALE outside it', () => {
  const raw = 'a\nb\nc\nd\ne\nf\n'
  const entry = openDocument({}, '/x', raw)

  // read only lines 2-3 (idx 1..2)
  const w = readWindow(entry, 2, 2)
  assert.deepStrictEqual(w.rows.length, 2)
  assert.deepStrictEqual(entry.served.idx, [1, 2])
  assert.strictEqual(w.start, 1); assert.strictEqual(w.end, 3); assert.strictEqual(w.total, 7)

  // editing a line that was NOT served -> E_RANGE_STALE
  const undo = {}
  const bad = replaceWithServed(entry, undo, '/x', entry.hashes[4], entry.hashes[4], 'X')
  assert.match(bad.error, /E_RANGE_STALE/)
  assert.deepStrictEqual(undo, {}, 'nothing should be written to undo on a rejected edit')

  // editing a served line succeeds
  const ok = replaceWithServed(entry, undo, '/x', entry.hashes[1], entry.hashes[1], 'B!')
  assert.ok(ok.ok)
  assert.strictEqual(entry.lines[1], 'B!')
  assert.ok(undo['/x'], 'undo record persisted')
})

test('E_RANGE_STALE when the file was never shown', () => {
  const entry = openDocument({}, '/x', 'a\nb\nc\n')
  // nothing read yet -> served is null
  const r = replaceWithServed(entry, {}, '/x', entry.hashes[0], entry.hashes[0], 'Z')
  assert.match(r.error, /E_RANGE_STALE/)
})

test('E_RANGE_STALE when the file changed on disk since it was served', () => {
  const entry = openDocument({}, '/x', 'a\nb\nc\n')
  readWindow(entry, 1, 3) // served all
  // simulate an external edit: refresh snapshot (drops served) then the old entry is stale
  const fresh = openDocument({}, '/x', 'a\nB\nc\n')
  assert.ok(fresh.served === null)
  assert.match(replaceWithServed(fresh, {}, '/x', fresh.hashes[0], fresh.hashes[0], 'Z').error, /E_RANGE_STALE/)
})

test('replace mutates snapshot and writes undo; undo round-trips byte-exactly', () => {
  const raw = 'one\ntwo\nthree\nfour\nfive\n'
  const snap = {}
  const undo = {}
  const entry = openDocument(snap, '/f', raw)
  const h0 = entry.hashes.slice()
  readWindow(entry, 1, 10)

  const r = replaceWithServed(entry, undo, '/f', h0[1], h0[3], '2\n2.5')
  assert.ok(r.ok)
  assert.strictEqual(r.writtenText, 'one\n2\n2.5\nfive\n')

  // undo against the post-replace bytes
  const fresh = openDocument(snap, '/f', r.writtenText)
  const u = undoFromRecord(fresh, undo['/f'], r.writtenText)
  assert.ok(u.ok)
  assert.strictEqual(u.writtenText, raw)
})

test('E_UNDO_STALE when the file moved on after a replace', () => {
  const raw = 'a\nb\nc\n'
  const snap = {}; const undo = {}
  const entry = openDocument(snap, '/f', raw)
  readWindow(entry, 1, 10)
  const r = replaceWithServed(entry, undo, '/f', entry.hashes[0], entry.hashes[0], 'A!')
  // external drift after the replace
  assert.match(undoFromRecord({}, undo['/f'], r.writtenText + 'DRIFT\n').error, /E_UNDO_STALE/)
})

test('store round-trips through serializeStore/parseStore losslessly', () => {
  const snap = {}; const undo = {}
  const entry = openDocument(snap, '/f', 'x\ny\nz\n')
  readWindow(entry, 1, 10)
  replaceWithServed(entry, undo, '/f', entry.hashes[0], entry.hashes[0], 'X')
  const round = parseStore(serializeStore(snap, undo))
  assert.deepStrictEqual(round.snap, snap)
  assert.deepStrictEqual(round.undo, undo)
  // survives restart: reopening the same content reuses the stored anchors
  const reopened = openDocument(round.snap, '/f', 'X\ny\nz\n')
  assert.deepStrictEqual(reopened.hashes, entry.hashes)
})

test('newer replace overwrites the single-level undo', () => {
  const snap = {}; const undo = {}
  let entry = openDocument(snap, '/f', 'a\nb\nc\n')
  readWindow(entry, 1, 10)
  replaceWithServed(entry, undo, '/f', entry.hashes[0], entry.hashes[0], 'A')
  const undoA = undo['/f']
  readWindow(entry, 1, 10)
  replaceWithServed(entry, undo, '/f', entry.hashes[1], entry.hashes[1], 'B')
  assert.notStrictEqual(undo['/f'], undoA, 'a second replace replaces the undo record')
})

// dsh-hash-edit — pure document operations (no I/O).
// Everything the plugins do between reading a file and writing it back, kept free of DSH
// services so the served-range rules, store serialization, and undo semantics are directly
// unit-testable (see test/docops.test.js). Plugins keep only the fs/store thin shell.
import * as E from './engine.js'
import { SEP } from './engine.js'

// Build/refresh the in-memory snapshot for a file's raw text, keeping prior anchors AND the
// last-served range when the content is byte-identical.
export function openDocument (snap, abs, raw) {
  const n = E.normalizeFile(raw)
  const text = n.text
  const lines = E.splitLines(text)
  const prev = snap[abs]
  const same = prev && prev.lines.join('\n') === text
  return {
    bom: n.bom,
    ending: n.ending,
    lines,
    hashes: same ? prev.hashes : E.buildHashes(lines, null),
    checksum: E.checksumOf(text),
    served: same ? (prev.served || null) : null,
    text
  }
}

// Slice a read window and mark those lines as *served* on the snapshot.
export function readWindow (entry, offset = 1, limit = 200) {
  const start = Math.max(0, (Math.floor(offset || 1) || 1) - 1)
  const lim = Math.min(Math.floor(limit || 200) || 200, 200)
  const end = Math.min(start + lim, entry.lines.length)
  const idx = []
  for (let i = start; i < end; i++) idx.push(i)
  entry.served = { checksum: entry.checksum, idx }
  return {
    rows: idx.map(i => entry.hashes[i] + SEP + entry.lines[i]),
    start,
    end,
    total: entry.lines.length
  }
}

// Pure replace with full served-range verification. On success it mutates `entry` (new
// lines/hashes/checksum) and writes the single-level undo record into `undoStore`.
// Returns { ok } or { error }. Never fuzzy-matches.
export function replaceWithServed (entry, undoStore, abs, remove_from, remove_to, replacement_text) {
  const served = entry.served
  if (!served || served.checksum !== entry.checksum) {
    return { error: '[E_RANGE_STALE] Nothing was modified: the file changed or was never shown. Call read first.' }
  }
  const range = E.resolveRange(
    entry.lines, entry.hashes,
    String(remove_from == null ? '' : remove_from).trim(),
    String(remove_to == null ? remove_from : remove_to).trim()
  )
  if (range.error) return { error: range.error }

  const servedSet = {}
  for (const i of served.idx) servedSet[i] = true
  let unserved = false
  for (let i = range.fi; i <= range.ti; i++) if (!servedSet[i]) unserved = true
  if (unserved) {
    const fresh = []
    for (let i = range.fi; i <= range.ti; i++) fresh.push((i - range.fi + 1) + ': ' + entry.hashes[i] + SEP + entry.lines[i])
    return { error: '[E_RANGE_STALE] Lines in the range were not shown to you. Nothing modified.' + '\n' + fresh.join('\n') }
  }

  const r = E.computeReplace(entry.lines, entry.hashes, range.fi, range.ti, replacement_text)
  if (r.error) return { error: r.error }

  const undoRec = Object.assign({ bom: entry.bom, ending: entry.ending }, r.undo)
  undoStore[abs] = undoRec

  const oldLen = entry.lines.length
  const removedCount = range.ti - range.fi + 1
  entry.lines = r.newLines
  entry.hashes = r.newHashes
  entry.checksum = E.checksumOf(r.newLines.join('\n'))
  entry.served = { checksum: entry.checksum, idx: r.newLines.map((_, i) => i) }

  return {
    ok: true,
    undoRec,
    writtenText: E.joinLines(r.newLines, entry.bom, entry.ending),
    removed: removedCount,
    inserted: r.newLines.length - (oldLen - removedCount) // net replacement count
  }
}

// Apply a single-level undo record, verifying the file has not drifted. Mutates `entry`.
// Returns { ok, writtenText } or { error }.
export function undoFromRecord (entry, undoRec, raw) {
  if (!undoRec) return { error: 'No undo history for this file.' }
  const cur = E.normalizeFile(raw)
  if (cur.text !== undoRec.result_content) return { error: '[E_UNDO_STALE] The file changed since the last replace; refusing to overwrite.' }
  const lines = undoRec.content.split('\n')
  entry.lines = lines
  entry.hashes = undoRec.hashes
  entry.checksum = E.checksumOf(undoRec.content)
  entry.bom = undoRec.bom
  entry.ending = undoRec.ending
  entry.served = { checksum: entry.checksum, idx: lines.map((_, i) => i) }
  return { ok: true, writtenText: E.joinLines(lines, undoRec.bom, undoRec.ending) }
}

// Pure store serialization (the on-disk format).
export function serializeStore (snap, undo) { return JSON.stringify({ snap, undo }) }
export function parseStore (text) {
  try {
    const d = JSON.parse(String(text))
    if (d && typeof d === 'object') return { snap: d.snap || {}, undo: d.undo || {} }
  } catch (e) {}
  return { snap: {}, undo: {} }
}

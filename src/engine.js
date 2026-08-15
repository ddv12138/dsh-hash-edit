'use strict'
// dsh-hash-edit: pure-JS hashline engine (port of pi-hashline-edit-pro behavior).
// Plain CommonJS so it can be validated with `node`; the dynamic plugin inlines
// the same algorithms because the restricted Host half has no require/import.

/* ----------------------------- xxHash32 (seed 0) ----------------------------- */
const P1 = 2654435761
const P2 = 2246822519
const P3 = 3266489917
const P4 = 668265263
const P5 = 374761393

function rotl32 (x, r) { return ((x << r) | (x >>> (32 - r))) >>> 0 }
function readU32 (b, i) { return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0 }

// Bit-exact xxHash32 over the UTF-8 bytes of `str`, seed 0. Validated against
// xxhashjs reference vectors (see the session log).
function xxh32 (str, seed) {
  seed = seed || 0
  const b = new TextEncoder().encode(str)
  const n = b.length
  let i = 0
  let hash
  if (n >= 16) {
    let v1 = (seed + P1 + P2) >>> 0
    let v2 = (seed + P2) >>> 0
    let v3 = seed >>> 0
    let v4 = (seed - P1) >>> 0
    const lim = n - 16
    while (i <= lim) {
      v1 = Math.imul(rotl32((v1 + Math.imul(readU32(b, i), P2)) >>> 0, 13), P1)
      v2 = Math.imul(rotl32((v2 + Math.imul(readU32(b, i + 4), P2)) >>> 0, 13), P1)
      v3 = Math.imul(rotl32((v3 + Math.imul(readU32(b, i + 8), P2)) >>> 0, 13), P1)
      v4 = Math.imul(rotl32((v4 + Math.imul(readU32(b, i + 12), P2)) >>> 0, 13), P1)
      i += 16
    }
    hash = (rotl32(v1 >>> 0, 1) + rotl32(v2 >>> 0, 7) + rotl32(v3 >>> 0, 12) + rotl32(v4 >>> 0, 18)) >>> 0
  } else {
    hash = (seed + P5) >>> 0
  }
  hash = (hash + n) >>> 0
  while (i + 4 <= n) { hash = Math.imul(rotl32((hash + Math.imul(readU32(b, i), P3)) >>> 0, 17), P4) >>> 0; i += 4 }
  while (i < n) { hash = Math.imul(rotl32((hash + Math.imul(b[i], P5)) >>> 0, 11), P1) >>> 0; i++ }
  hash = (hash ^ (hash >>> 15)) >>> 0; hash = Math.imul(hash, P2) >>> 0
  hash = (hash ^ (hash >>> 13)) >>> 0; hash = Math.imul(hash, P3) >>> 0
  return (hash ^ (hash >>> 16)) >>> 0
}

/* ----------------------------- anchor construction ----------------------------- */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const HASH_SPACE = 238328 // 62^3
const HASH_PROBE_STRIDE = 3907 // 62^2 + 62 + 1, coprime with HASH_SPACE
const SEP = '\u2502'

function canon (line) { return String(line).replace(/\r/g, '').trimEnd() }

function idxToHash (n) {
  const a = ALPHABET
  return a[(n / 3844) | 0] + a[((n / 62) | 0) % 62] + a[n % 62]
}

function hashOfLine (line) { return ((xxh32(canon(line), 0) >>> 14) % HASH_SPACE) >>> 0 }

// Bitset allocator: unique-by-construction with coprime-stride collision probing.
class Allocator {
  constructor () {
    this.words = new Uint32Array((HASH_SPACE >> 5) + 1)
    this.count = 0
  }
  has (n) { return ((this.words[n >> 5] >>> (n & 31)) & 1) === 1 }
  set (n) { if (!this.has(n)) { this.words[n >> 5] |= 1 << (n & 31); this.count++ } }
  alloc (base) {
    let n = base >>> 0
    for (let k = 0; k < HASH_SPACE; k++) {
      if (!this.has(n)) { this.set(n); return n }
      n = (n + HASH_PROBE_STRIDE) % HASH_SPACE
    }
    return -1 // HASH_SPACE exhausted
  }
}

/* ----------------------------- store shape ----------------------------- */
// snap[absPath] = {
//   checksum: string,  // xxh32 over LF-normalized, bom-stripped text
//   lines: string[],   // text.split('\n'); round-trips exactly via join('\n')
//   hashes: string[],  // aligned to lines
//   bom: string, ending: string,
//   served: { checksum: string, idx: number[] } | null,   // last thing shown to the model
// }
// undo[absPath] = { content (LF text), bom, ending, hashes, result_content }

function splitLines (text) { return String(text).split('\n') }
function checksumOf (text) { return xxh32(String(text), 0) + ':' + String(text).length }

function ensureSnap (snap, path, content, bom, ending) {
  const text = String(content)
  let s = snap[path]
  if (!s || s.checksum !== checksumOf(text)) {
    const lines = splitLines(text)
    s = {
      checksum: checksumOf(text),
      lines,
      hashes: buildHashes(lines, null),
      bom, ending,
      served: null
    }
    snap[path] = s
  }
  return s
}

// Build a fresh hash array for `lines`. When `existing` is provided (array aligned
// to these same lines), keep the existing anchors verbatim.
function buildHashes (lines, existing) {
  const alloc = new Allocator()
  const out = []
  let full = true
  if (existing && existing.length === lines.length) {
    for (let i = 0; i < lines.length; i++) { if (existing[i]) { alloc.set(idxOfHash(existing[i])); out[i] = existing[i] } }
    full = false
  }
  for (let i = 0; i < lines.length; i++) {
    if (full || !out[i]) {
      const idx = alloc.alloc(hashOfLine(lines[i]))
      if (idx < 0) throw Object.assign(new Error('[E_FILE_TOO_LARGE] anchor space exhausted'), { code: 'E_FILE_TOO_LARGE' })
      out[i] = idxToHash(idx)
    }
  }
  return out
}

function idxOfHash (h) {
  // base-62 decode (MS-first)
  let n = 0
  for (let i = 0; i < 3; i++) n = n * 62 + ALPHABET.indexOf(h[i])
  return n
}

// Stable remap after a replace. Removed hashes are reused (in order) for byte-
// identical re-inserted lines; survivors keep their anchors; new lines get fresh.
// Stable remap after a replace. `newLines` is the FULL post-replace line array.
// - Every line outside the removed range is a *survivor* and keeps its anchor,
//   relocated to the nearest (in original order) content-identical new line.
// - Removed lines' anchors go to a per-content pool and are reused, in order,
//   for byte-identical re-inserted lines ("replace X with X" doesn't rotate).
// - Everything else gets a fresh, unique anchor.
function mapStableHashes (oldHashes, oldLines, fromIdx, toIdx, newLines) {
  const alloc = new Allocator()
  const pool = new Map() // canon -> queue of removed anchors (FIFO)
  const result = new Array(newLines.length)
  const used = new Array(newLines.length).fill(false)

  // survivor lines in original file order (removed range excluded), plus their hashes
  const survivors = []
  for (let i = 0; i < oldLines.length; i++) {
    if (i >= fromIdx && i <= toIdx) {
      const c = canon(oldLines[i])
      if (!pool.has(c)) pool.set(c, [])
      pool.get(c).push(oldHashes[i])
    } else {
      survivors.push({ canon: canon(oldLines[i]), hash: oldHashes[i] })
    }
  }

  // greedy nearest-position: each survivor claims the first unused content-equal line
  // at or after the previously claimed position, preserving original order.
  let last = 0
  for (let si = 0; si < survivors.length; si++) {
    const s = survivors[si]
    let j = last
    while (j < newLines.length && !(canon(newLines[j]) === s.canon && !used[j])) j++
    if (j < newLines.length) {
      alloc.set(idxOfHash(s.hash))
      result[j] = s.hash
      used[j] = true
      last = j + 1
    } else {
      alloc.set(idxOfHash(s.hash)) // anchor stays reserved even if text moved away
    }
  }

  // fill remaining (unused) new lines: reuse removed anchors for identical text, else fresh
  for (let j = 0; j < newLines.length; j++) {
    if (used[j]) continue
    const c = canon(newLines[j])
    const q = pool.get(c)
    let hash
    if (q && q.length) {
      hash = q.shift()
      alloc.set(idxOfHash(hash))
    } else {
      const idx = alloc.alloc(hashOfLine(newLines[j]))
      if (idx < 0) throw Object.assign(new Error('[E_FILE_TOO_LARGE] anchor space exhausted'), { code: 'E_FILE_TOO_LARGE' })
      hash = idxToHash(idx)
    }
    result[j] = hash
    used[j] = true
  }
  return result
}

/* ----------------------- pure file-level operations (no I/O) ----------------------- */

// Detect BOM + dominant line ending; return normalized LF text.
function normalizeFile (raw) {
  let bom = ''
  let s = String(raw)
  if (s.charCodeAt(0) === 0xFEFF) { bom = '\uFEFF'; s = s.slice(1) }
  let crlf = 0, lf = 0, cr = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\r') { if (s[i + 1] === '\n') { crlf++; i++ } else cr++ } else if (c === '\n') lf++
  }
  let ending = '\n'
  if (crlf >= lf && crlf >= cr) ending = '\r\n'
  else if (cr >= lf && cr >= crlf) ending = '\r'
  return { bom, ending, text: s.replace(/\r\n?/g, '\n') }
}

// Serialize normalized lines back to raw bytes.
function joinLines (lines, bom, ending) { return bom + lines.join(ending) }

// Resolve a bare 3-char anchor to a single line index. Returns an error object or
// { fi, ti } for the closed range. Never fuzzy-matches.
function resolveRange (lines, hashes, fromHash, toHash) {
  const rb = /^[A-Za-z0-9]{3}$/
  if (!rb.test(fromHash) || !rb.test(toHash)) return { error: '[E_BAD_REF] anchors must be bare 3-char hashes (e.g. aB3); copy just the hash.' }
  function found (h) { const f = []; for (let i = 0; i < hashes.length; i++) if (hashes[i] === h) f.push(i); return f }
  const from = found(fromHash), to = found(toHash)
  if (from.length === 0) return { error: '[E_STALE_ANCHOR] ' + fromHash + ' matches no current line. Call read to refresh.' }
  if (from.length > 1) return { error: '[E_AMBIGUOUS_ANCHOR] ' + fromHash + ' matches ' + from.length + ' lines; nothing modified.' }
  if (to.length !== 1) return { error: '[E_AMBIGUOUS_ANCHOR] ' + toHash + ' is not a single current line; nothing modified.' }
  let fi = from[0], ti = to[0]
  if (fi > ti) { const t = fi; fi = ti; ti = t }
  return { fi, ti }
}

// Pure replace: produce new lines/hashes and the single-level undo record.
function computeReplace (lines, hashes, fi, ti, replacementText) {
  const replacement = splitLines(String(replacementText == null ? '' : replacementText))
  const newLines = lines.slice(0, fi).concat(replacement, lines.slice(ti + 1))
  const newHashes = mapStableHashes(hashes, lines, fi, ti, newLines)
  if (!newHashes) return { error: '[E_FILE_TOO_LARGE] anchor space exhausted' }
  return {
    newLines,
    newHashes,
    undo: {
      content: lines.join('\n'),
      hashes: hashes.slice(),
      result_content: newLines.join('\n')
    }
  }
}

export {
  P1, P2, P3, P4, P5, rotl32, readU32, xxh32,
  ALPHABET, HASH_SPACE, HASH_PROBE_STRIDE, SEP,
  canon, idxToHash, hashOfLine, Allocator, idxOfHash,
  splitLines, checksumOf, buildHashes, mapStableHashes,
  normalizeFile, joinLines, resolveRange, computeReplace
}

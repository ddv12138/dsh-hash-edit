// dsh-hash-edit — pi-aligned takeover plugin (package main, ./index.js).
// Composed into a profile so the session edits through hash-anchored read / replace /
// undo_last_replace. Because tool restriction and result interception are agent-scoped,
// this is the entry a profile mounts to *take over* the built-ins:
//   1. registers hashline tools under the pi names read / replace / undo_last_replace
//      (scoped registration shadows the built-in read for this profile);
//   2. hides the built-in `edit` via tools.restrict({deny:['edit']});
//   3. listens on tools/result so a successful built-in `write` appends an auto-read block;
//   4. injects the usage-discipline prompt section.
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as E from './engine.js'

export const name = 'dsh-hash-edit'
export const inject = ['fs', 'tools', 'systemPrompt']

function autoReadBlock (s, cap = 40) {
  return (s.lines.slice(0, cap)).map((l, i) => s.hashes[i] + E.SEP + l).join('\n')
}

export function apply (ctx) {
  const fs = ctx.fs
  const tools = ctx.tools
  const sp = ctx.get('sandboxPolicy')
  const storeDir = '.dsh-hash-edit'
  const policy = () => (sp ? sp.resolve() : undefined)

  function sessionCwd () {
    try {
      const agents = ctx.get('agents')
      const a = agents && agents.currentInitiator ? agents.currentInitiator() : undefined
      if (a) { const s = a.session || (a.ctx && a.ctx.session); const h = s ? (s.meta || s.header || s) : undefined; return h && h.cwd ? h.cwd : undefined }
    } catch (e) {}
  }
  const resolvePath = async (path) => { const cwd = sessionCwd(); return cwd ? fs.resolve(path, { cwd }) : fs.resolve(path) }
  async function readFile (path) {
    const t = await resolvePath(path)
    const raw = await fs.readText(t)
    return { target: t, raw, abs: fs.processPath(t) }
  }
  async function readStore (root) { try { const d = JSON.parse(await fs.readText(await fs.resolve(root + '/' + storeDir + '/store.json'))); if (d && typeof d === 'object') return d } catch (e) {} return {} }
  async function writeStore (root, snap, undo) { try { await fs.writeText(await fs.resolve(root + '/' + storeDir + '/store.json'), JSON.stringify({ snap, undo }), undefined, undefined, policy()) } catch (e) {} }
  async function storeRoot () {
    let root = sessionCwd()
    if (!root && sp) { const p = sp.resolve(); root = p && (p.workspaceRoot || p.root) }
    if (!root) { try { root = fs.processPath(await fs.resolve('.')) } catch (e) { root = null } }
    return root || './'
  }

  const readToolDef = defineTool({
    name: 'read',
    description: 'Read a text file with hash anchors (hashline). Returns each line as HASH│content; use the HASH, not line numbers, in replace. Supports offset/limit.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the file to read (relative or absolute).' },
      offset: { type: 'number', description: '1-based start line. Defaults to 1.' },
      limit: { type: 'number', description: 'Max lines to read. Defaults to 200.' }
    },
    output: { schema: { type: 'string' }, render (_a, v) { return [{ type: 'text', text: v }] } },
    async execute (args) {
      const { raw, abs } = await readFile(args.path)
      const root = await storeRoot(); const store = await readStore(root)
      const snap = store.snap || (store.snap = {})
      const prev = snap[abs]
      const n = E.normalizeFile(raw)
      const lines = E.splitLines(n.text)
      const s = { bom: n.bom, ending: n.ending, lines, hashes: (prev && prev.lines.join('\n') === n.text) ? prev.hashes : E.buildHashes(lines, null), checksum: E.checksumOf(n.text) }
      snap[abs] = s
      const offset = Math.max(1, Math.floor(args.offset || 1))
      const limit = Math.min(Math.floor(args.limit || 200), 200)
      const start = offset - 1; const end = Math.min(start + limit, lines.length)
      const rows = []
      for (let i = start; i < end; i++) rows.push(s.hashes[i] + E.SEP + lines[i])
      s.served = { checksum: s.checksum, idx: rows.map((_, i) => start + i) }
      await writeStore(root, snap, store.undo || {})
      let out = rows.join('\n')
      if (end < lines.length) out += '\n[Showing lines ' + (start + 1) + '-' + end + ' of ' + lines.length + '. Use offset=' + (end + 1) + ' to continue.]'
      return out
    }
  })
  tools.register(readToolDef)

  tools.register(defineTool({
    name: 'replace',
    description: 'Replace one contiguous line range by its hash anchors (remove_from..remove_to inclusive) with replacement_text (newline separates lines). Stale/ambiguous anchors are rejected, never fuzzy-matched. One edit per call; do not issue multiple replaces on one file in a single message.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the file to edit.' },
      remove_from: { type: 'string', required: true, description: 'Bare 3-char HASH of the first line to remove (inclusive).' },
      remove_to: { type: 'string', description: 'Bare 3-char HASH of the last line to remove (inclusive). Defaults to remove_from.' },
      replacement_text: { type: 'string', required: true, description: 'Replacement text; newline separates lines. Empty string deletes the range.' }
    },
    output: { schema: { type: 'string' }, render (_a, v) { return [{ type: 'text', text: v }] } },
    async execute (args) {
      const root = await storeRoot(); const store = await readStore(root)
      const snap = store.snap || (store.snap = {}); const undo = store.undo || (store.undo = {})
      const { target, raw, abs } = await readFile(args.path)
      const n = E.normalizeFile(raw)
      const lines = E.splitLines(n.text)
      const prev = snap[abs]
      const s = { bom: n.bom, ending: n.ending, lines, hashes: (prev && prev.lines.join('\n') === n.text) ? prev.hashes : E.buildHashes(lines, null), checksum: E.checksumOf(n.text) }
      const served = s.served
      if (!served || served.checksum !== s.checksum) return '[E_RANGE_STALE] Nothing was modified: the file changed or was never shown. Call read first.'
      const range = E.resolveRange(lines, s.hashes, String(args.remove_from || '').trim(), String(args.remove_to || args.remove_from || '').trim())
      if (range.error) return range.error
      const servedSet = {}; for (const i of served.idx) servedSet[i] = true
      let unserved = false; for (let i = range.fi; i <= range.ti; i++) if (!servedSet[i]) unserved = true
      if (unserved) { const fresh = []; for (let i = range.fi; i <= range.ti; i++) fresh.push((i - range.fi + 1) + ': ' + s.hashes[i] + E.SEP + s.lines[i]); return '[E_RANGE_STALE] Range lines were not shown to you. Nothing modified.' + '\n' + fresh.join('\n') }
      const r = E.computeReplace(lines, s.hashes, range.fi, range.ti, args.replacement_text)
      if (r.error) return r.error
      undo[abs] = Object.assign({ bom: s.bom, ending: s.ending }, r.undo)
      await writeStore(root, snap, undo)
      await fs.writeText(target, E.joinLines(r.newLines, s.bom, s.ending), undefined, undefined, policy())
      s.lines = r.newLines; s.hashes = r.newHashes; s.checksum = E.checksumOf(r.newLines.join('\n'))
      s.served = { checksum: s.checksum, idx: r.newLines.map((_, i) => i) }
      await writeStore(root, snap, undo)
      return 'Replaced ' + (range.ti - range.fi + 1) + ' line(s).' + '\n' + r.newLines.map((l, i) => s.hashes[i] + E.SEP + l).join('\n')
    }
  }))

  tools.register(defineTool({
    name: 'undo_last_replace',
    description: 'Undo the most recent replace for a file, restoring exact prior content, BOM, line endings, and previous anchors.',
    parameters: { path: { type: 'string', required: true, description: 'Path of the file to undo.' } },
    output: { schema: { type: 'string' }, render (_a, v) { return [{ type: 'text', text: v }] } },
    async execute (args) {
      const root = await storeRoot(); const store = await readStore(root)
      const snap = store.snap || (store.snap = {}); const undo = store.undo || (store.undo = {})
      const { target, raw, abs } = await readFile(args.path)
      const cur = E.normalizeFile(raw)
      const u = undo[abs]
      if (!u) return 'No undo history for ' + args.path + '.'
      if (cur.text !== u.result_content) return '[E_UNDO_STALE] The file changed since the last replace; refusing to overwrite.'
      await fs.writeText(target, E.joinLines(u.content.split('\n'), u.bom, u.ending), undefined, undefined, policy())
      const lines = u.content.split('\n')
      const s = snap[abs] || (snap[abs] = {})
      s.lines = lines; s.hashes = u.hashes; s.checksum = E.checksumOf(u.content); s.bom = u.bom; s.ending = u.ending
      s.served = { checksum: s.checksum, idx: lines.map((_, i) => i) }
      delete undo[abs]
      await writeStore(root, snap, undo)
      return 'Undid last replace for ' + args.path + '.' + '\n' + lines.map((l, i) => u.hashes[i] + E.SEP + l).join('\n')
    }
  }))

  // Hide the built-in `edit` tool for this profile's agent.
  try { const d = tools.restrict({ deny: ['edit'] }); ctx.effect(() => d) } catch (e) {}

  // Intercept write results: append an auto-read so anchors stay fresh.
  ctx.on('tools/result', (exec, result) => {
    if (!exec || exec.tool !== 'write') return
    const path = exec.args && (exec.args.path || exec.args.file_path)
    if (!path) return
    ;(async () => {
      try {
        const n = E.normalizeFile(await fs.readText(await resolvePath(path)))
        const lines = E.splitLines(n.text)
        const root = await storeRoot(); const store = await readStore(root)
        const snap = store.snap || (store.snap = {})
        const abs = await (async (p) => fs.processPath(await resolvePath(p)))(path)
        const prev = snap[abs]
        const hashes = (prev && prev.lines.join('\n') === n.text) ? prev.hashes : E.buildHashes(lines, null)
        snap[abs] = { bom: n.bom, ending: n.ending, lines, hashes, checksum: E.checksumOf(n.text), served: { checksum: E.checksumOf(n.text), idx: lines.map((_, i) => i) } }
        await writeStore(root, snap, store.undo || {})
        ctx.emit('hashline/autoread', { path, text: '--- Auto-read (hashline anchors) ---\n' + autoReadBlock(snap[abs]) })
      } catch (e) { ctx.emit('hashline/autoread', { path, text: '[hashline] auto-read failed: ' + (e && e.message) }) }
    })()
  })

  // Usage-discipline prompt section.
  ctx.systemPrompt.section({
    title: 'Hashline editing discipline',
    body: [
      'You edit text files through the hashline tools: read (returns HASH│content rows), replace, and undo_last_replace.',
      '- Always copy a BARE 3-char HASH (A-Za-z0-9) — never fuzzy-match, never guess content.',
      '- Issue ONE replace per file per message; a replace re-anchors the file, so parallel edits go stale.',
      '- A replace may only touch lines you were actually shown; editing a range you have not read returns E_RANGE_STALE.',
      '- After any plain write, re-read to refresh anchors before the next replace.',
      '- Undo is single-level and persisted; call undo_last_replace immediately after a bad replace.'
    ].join('\n')
  })

  ctx.effect(() => () => {})
}

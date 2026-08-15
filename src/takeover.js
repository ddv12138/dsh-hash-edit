// dsh-hash-edit — pi-aligned takeover plugin (package main, ./index.js).
// Composed into a profile so the session edits through hash-anchored read / replace /
// undo_last_replace, with the built-in `edit` hidden and `write` results carrying an
// auto-read block. Document logic is in src/docops.js (pure, unit-tested); this file is the
// agent-scoped binding: tool registration, tools.restrict, tools/result interception, prompt.
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as E from './engine.js'
import {
  openDocument, readWindow, replaceWithServed, undoFromRecord, parseStore, serializeStore
} from './docops.js'

export const name = 'dsh-hash-edit'
export const inject = ['fs', 'tools', 'systemPrompt']

function autoReadBlock (entry, cap = 40) {
  return entry.lines.slice(0, cap).map((l, i) => entry.hashes[i] + E.SEP + l).join('\n')
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
  async function readFile (path) { const t = await resolvePath(path); const raw = await fs.readText(t); return { target: t, raw, abs: fs.processPath(t) } }
  async function loadStore (root) { try { return parseStore(await fs.readText(await fs.resolve(root + '/' + storeDir + '/store.json'))) } catch (e) { return { snap: {}, undo: {} } } }
  async function saveStore (root, store) { try { await fs.writeText(await fs.resolve(root + '/' + storeDir + '/store.json'), serializeStore(store.snap, store.undo), undefined, undefined, policy()) } catch (e) {} }
  async function storeRoot () {
    let root = sessionCwd()
    if (!root && sp) { const p = sp.resolve(); root = p && (p.workspaceRoot || p.root) }
    if (!root) { try { root = fs.processPath(await fs.resolve('.')) } catch (e) { root = null } }
    return root || './'
  }

  async function readToolBody (args) {
    const { raw, abs } = await readFile(args.path)
    const store = await loadStore(await storeRoot())
    const entry = openDocument(store.snap, abs, raw)
    store.snap[abs] = entry
    const w = readWindow(entry, args.offset, args.limit)
    await saveStore(await storeRoot(), store)
    let out = w.rows.join('\n')
    if (w.end < w.total) out += '\n[Showing lines ' + (w.start + 1) + '-' + w.end + ' of ' + w.total + '. Use offset=' + (w.end + 1) + ' to continue.]'
    return out
  }

  tools.register(defineTool({
    name: 'read',
    description: 'Read a text file with hash anchors (hashline). Returns each line as HASH│content; use the HASH, not line numbers, in replace. Supports offset/limit.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the file to read (relative or absolute).' },
      offset: { type: 'number', description: '1-based start line. Defaults to 1.' },
      limit: { type: 'number', description: 'Max lines to read. Defaults to 200.' }
    },
    output: { schema: { type: 'string' }, render (_a, v) { return [{ type: 'text', text: v }] } },
    async execute (args) { return readToolBody(args) }
  }))

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
      const root = await storeRoot()
      const store = await loadStore(root)
      const { target, raw, abs } = await readFile(args.path)
      const entry = openDocument(store.snap, abs, raw)
      const r = replaceWithServed(entry, store.undo, abs, args.remove_from, args.remove_to, args.replacement_text)
      if (r.error) return r.error
      store.snap[abs] = entry
      await fs.writeText(target, r.writtenText, undefined, undefined, policy())
      await saveStore(root, store)
      return 'Replaced ' + r.removed + ' line(s) with ' + r.inserted + '.' + '\n' + entry.lines.map((l, i) => entry.hashes[i] + E.SEP + l).join('\n')
    }
  }))

  tools.register(defineTool({
    name: 'undo_last_replace',
    description: 'Undo the most recent replace for a file, restoring exact prior content, BOM, line endings, and previous anchors.',
    parameters: { path: { type: 'string', required: true, description: 'Path of the file to undo.' } },
    output: { schema: { type: 'string' }, render (_a, v) { return [{ type: 'text', text: v }] } },
    async execute (args) {
      const root = await storeRoot()
      const store = await loadStore(root)
      const { target, raw, abs } = await readFile(args.path)
      const entry = openDocument(store.snap, abs, raw)
      const u = undoFromRecord(entry, store.undo[abs], raw)
      if (u.error) return u.error
      await fs.writeText(target, u.writtenText, undefined, undefined, policy())
      store.snap[abs] = entry
      delete store.undo[abs]
      await saveStore(root, store)
      return 'Undid last replace for ' + args.path + '.' + '\n' + entry.lines.map((l, i) => entry.hashes[i] + E.SEP + l).join('\n')
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
        const raw = await fs.readText(await resolvePath(path))
        const abs = await (async (p) => fs.processPath(await resolvePath(p)))(path)
        const store = await loadStore(await storeRoot())
        const entry = openDocument(store.snap, abs, raw)
        entry.served = { checksum: entry.checksum, idx: entry.lines.map((_, i) => i) }
        store.snap[abs] = entry
        await saveStore(await storeRoot(), store)
        ctx.emit('hashline/autoread', { path, text: '--- Auto-read (hashline anchors) ---\n' + autoReadBlock(entry) })
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

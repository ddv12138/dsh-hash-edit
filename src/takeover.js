// dsh-hash-edit — pi-aligned takeover plugin (package main, ./index.js).
// Composed into a profile so the session edits through hash-anchored read / replace /
// undo_last_replace, with the built-in `edit` hidden and `write` results carrying an
// auto-read block. Tool definitions are built by buildTakeoverDefinitions(env) so their
// `execute` bodies and the write-interception (interceptWrite) are directly testable.
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

export function buildTakeoverDefinitions (env) {
  return [
    defineTool({
      name: 'read',
      description: 'Read a text file with hash anchors (hashline). Returns each line as HASH│content; use the HASH, not line numbers, in replace. Supports offset/limit.',
      parameters: {
        path: { type: 'string', required: true, description: 'Path to the file to read (relative or absolute).' },
        offset: { type: 'number', description: '1-based start line. Defaults to 1.' },
        limit: { type: 'number', description: 'Max lines to read. Defaults to 200.' }
      },
      output: { schema: { type: 'string' }, render (_a, v) { return [{ type: 'text', text: v }] } },
      async execute (args) {
        const { raw, abs } = await env.open(args.path)
        const store = await env.loadStore()
        const entry = openDocument(store.snap, abs, raw)
        store.snap[abs] = entry
        const w = readWindow(entry, args.offset, args.limit)
        await env.saveStore(store)
        let out = w.rows.join('\n')
        if (w.end < w.total) out += '\n[Showing lines ' + (w.start + 1) + '-' + w.end + ' of ' + w.total + '. Use offset=' + (w.end + 1) + ' to continue.]'
        return out
      }
    }),
    defineTool({
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
        const handle = await env.open(args.path)
        const store = await env.loadStore()
        const entry = openDocument(store.snap, handle.abs, handle.raw)
        const r = replaceWithServed(entry, store.undo, handle.abs, args.remove_from, args.remove_to, args.replacement_text)
        if (r.error) return r.error
        store.snap[handle.abs] = entry
        await env.write(handle.target, r.writtenText)
        await env.saveStore(store)
        return 'Replaced ' + r.removed + ' line(s) with ' + r.inserted + '.' + '\n' + entry.lines.map((l, i) => entry.hashes[i] + E.SEP + l).join('\n')
      }
    }),
    defineTool({
      name: 'undo_last_replace',
      description: 'Undo the most recent replace for a file, restoring exact prior content, BOM, line endings, and previous anchors.',
      parameters: { path: { type: 'string', required: true, description: 'Path of the file to undo.' } },
      output: { schema: { type: 'string' }, render (_a, v) { return [{ type: 'text', text: v }] } },
      async execute (args) {
        const handle = await env.open(args.path)
        const store = await env.loadStore()
        const entry = openDocument(store.snap, handle.abs, handle.raw)
        const u = undoFromRecord(entry, store.undo[handle.abs], handle.raw)
        if (u.error) return u.error
        await env.write(handle.target, u.writtenText)
        store.snap[handle.abs] = entry
        delete store.undo[handle.abs]
        await env.saveStore(store)
        return 'Undid last replace for ' + args.path + '.' + '\n' + entry.lines.map((l, i) => entry.hashes[i] + E.SEP + l).join('\n')
      }
    })
  ]
}

// The takeover-specific behaviors, factored so they can be wired in apply() OR tested.
export function takeoverBehaviors (ctx, env) {
  const tools = ctx.tools
  // 1. hide built-in edit for this agent
  let disposeRestrict
  try { disposeRestrict = tools.restrict({ deny: ['edit'] }) } catch (e) {}

  // 2. intercept write results -> append an auto-read so anchors stay fresh
  const off = ctx.on('tools/result', (exec, result) => {
    if (!exec || exec.tool !== 'write') return
    const path = exec.args && (exec.args.path || exec.args.file_path)
    if (!path) return
    ;(async () => {
      try {
        const handle = await env.open(path)
        const store = await env.loadStore()
        const entry = openDocument(store.snap, handle.abs, handle.raw)
        entry.served = { checksum: entry.checksum, idx: entry.lines.map((_, i) => i) }
        store.snap[handle.abs] = entry
        await env.saveStore(store)
        if (ctx.emit) ctx.emit('hashline/autoread', { path, text: '--- Auto-read (hashline anchors) ---\n' + autoReadBlock(entry) })
      } catch (e) { if (ctx.emit) ctx.emit('hashline/autoread', { path, text: '[hashline] auto-read failed: ' + (e && e.message) }) }
    })()
  })

  // 3. usage-discipline prompt
  let disposePrompt
  if (ctx.systemPrompt && ctx.systemPrompt.section) {
    try { disposePrompt = ctx.systemPrompt.section({ title: 'Hashline editing discipline', body: [
      'You edit text files through the hashline tools: read (returns HASH│content rows), replace, and undo_last_replace.',
      '- Always copy a BARE 3-char HASH (A-Za-z0-9) — never fuzzy-match, never guess content.',
      '- Issue ONE replace per file per message; a replace re-anchors the file, so parallel edits go stale.',
      '- A replace may only touch lines you were actually shown; editing a range you have not read returns E_RANGE_STALE.',
      '- After any plain write, re-read to refresh anchors before the next replace.',
      '- Undo is single-level and persisted; call undo_last_replace immediately after a bad replace.'
    ].join('\n') }) } catch (e) {}
  }

  return () => {
    if (disposeRestrict) disposeRestrict()
    if (disposePrompt) disposePrompt()
    off()
  }
}

export function apply (ctx) {
  const fs = ctx.fs
  const sp = ctx.get('sandboxPolicy')
  const policy = () => (sp ? sp.resolve() : undefined)
  function sessionCwd () {
    try {
      const agents = ctx.get('agents')
      const a = agents && agents.currentInitiator ? agents.currentInitiator() : undefined
      if (a) { const s = a.session || (a.ctx && a.ctx.session); const h = s ? (s.meta || s.header || s) : undefined; return h && h.cwd ? h.cwd : undefined }
    } catch (e) {}
  }
  const env = {
    async open (path) { const t = await fs.resolve(path); const raw = await fs.readText(t); return { target: t, raw, abs: fs.processPath(t) } },
    write: (t, content) => fs.writeText(t, content, undefined, undefined, policy()),
    async loadStore () { const cwd = sessionCwd() || './'; try { return parseStore(await fs.readText(await fs.resolve(cwd + '/.dsh-hash-edit/store.json'))) } catch (e) { return { snap: {}, undo: {} } } },
    async saveStore (store) { const cwd = sessionCwd() || './'; try { await fs.writeText(await fs.resolve(cwd + '/.dsh-hash-edit/store.json'), serializeStore(store.snap, store.undo), undefined, undefined, policy()) } catch (e) {} }
  }

  for (const def of buildTakeoverDefinitions(env)) ctx.tools.register(def)
  const disposeBehaviors = takeoverBehaviors(ctx, env)
  ctx.effect(() => disposeBehaviors())
}

// dsh-hash-edit — host-core plugin (export "./core").
// Registers the hashline tools (hashline_read / hashline_replace / hashline_undo).
//
// Tool definitions are built by buildCoreDefinitions(env) so the exact `execute` bodies
// shipped here are directly unit-testable (see test/plugin-execute.test.js) against any
// env with an fs-like surface. `apply(ctx)` builds the env from DSH's real fs/services and
// registers the definitions. All document logic lives in src/docops.js (pure, tested).
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as E from './engine.js'
import { openDocument, readWindow, replaceWithServed, undoFromRecord, parseStore, serializeStore } from './docops.js'

export const name = 'dsh-hash-edit/core'
export const inject = ['fs', 'tools']

// An env is the small dependency surface the tool bodies need. Tests supply a real fs over
// a temp dir; apply() supplies DSH's fs with a session-cwd store root.
export function buildCoreDefinitions (env) {
  return [
    defineTool({
      name: 'hashline_read',
      description: 'Read a text file with hash anchors. Returns each line as HASH│content (3-char base-62 anchor). Use the HASH, not line numbers, in hashline_replace. Supports offset/limit paging.',
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
      name: 'hashline_replace',
      description: 'Replace one contiguous line range by its hash anchors (remove_from..remove_to inclusive) with replacement_text (newline separates lines). Stale/ambiguous anchors are rejected, never fuzzy-matched. One edit per call.',
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
      name: 'hashline_undo',
      description: 'Undo the most recent hashline_replace for a file, restoring exact prior content, BOM, line endings, and previous hash anchors.',
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

export function apply (ctx) {
  const fs = ctx.fs
  const sp = ctx.get('sandboxPolicy')
  const policy = () => (sp ? sp.resolve() : undefined)

  function sessionCwd () {
    try {
      const agents = ctx.get('agents')
      const agent = agents && agents.currentInitiator ? agents.currentInitiator() : undefined
      if (agent) {
        const sess = agent.session || (agent.ctx && agent.ctx.session)
        const hdr = sess ? (sess.meta || sess.header || sess) : undefined
        return hdr && hdr.cwd ? hdr.cwd : undefined
      }
    } catch (e) {}
  }
  async function root () {
    let r = sessionCwd()
    if (!r && sp) { const p = sp.resolve(); r = p && (p.workspaceRoot || p.root) }
    if (!r) { try { r = fs.processPath(await fs.resolve('.')) } catch (e) { r = null } }
    return r || './'
  }

  const env = {
    async open (path) {
      const t = await fs.resolve(path)
      let info; try { info = await fs.stat(t) } catch (e) { info = undefined }
      if (!info) throw Object.assign(new Error('File not found: ' + path), { code: 'E_NOT_FOUND' })
      let raw; try { raw = await fs.readText(t) } catch (e) { throw Object.assign(new Error('[E_NOT_TEXT] ' + path + ' is not UTF-8 text'), { code: 'E_NOT_TEXT' }) }
      return { target: t, raw, abs: fs.processPath(t) }
    },
    write: (t, content) => fs.writeText(t, content, undefined, undefined, policy()),
    async loadStore () {
      const r = await root(); const cwd = sessionCwd()
      const base = cwd || r
      try { return parseStore(await fs.readText(await fs.resolve(base + '/.dsh-hash-edit/store.json'))) } catch (e) { return { snap: {}, undo: {} } }
    },
    async saveStore (store) {
      const cwd = sessionCwd() || await root()
      try { await fs.writeText(await fs.resolve(cwd + '/.dsh-hash-edit/store.json'), serializeStore(store.snap, store.undo), undefined, undefined, policy()) } catch (e) {}
    }
  }

  for (const def of buildCoreDefinitions(env)) ctx.tools.register(def)
  ctx.effect(() => () => {})
}

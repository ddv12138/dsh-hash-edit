// dsh-hash-edit — host-core plugin (export "./core").
// Registers the hashline tools (hashline_read / hashline_replace / hashline_undo) with the
// shared tool registry. All document logic lives in src/docops.js (pure, unit-tested); this
// file is only the fs/store shell that binds it to DSH. The pi-style *takeover* is the
// package main (./index.js) because tool restriction and result interception are agent-scoped.
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as E from './engine.js'
import { openDocument, readWindow, replaceWithServed, undoFromRecord, parseStore, serializeStore } from './docops.js'

export const name = 'dsh-hash-edit/core'
export const inject = ['fs', 'tools']

export function apply (ctx) {
  const fs = ctx.fs
  const sp = ctx.get('sandboxPolicy')
  const storeDir = '.dsh-hash-edit'
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
  const resolvePath = async (path) => { const cwd = sessionCwd(); return cwd ? fs.resolve(path, { cwd }) : fs.resolve(path) }
  async function loadStore (root) { try { return parseStore(await fs.readText(await fs.resolve(root + '/' + storeDir + '/store.json'))) } catch (e) { return { snap: {}, undo: {} } } }
  async function saveStore (root, store) { try { await fs.writeText(await fs.resolve(root + '/' + storeDir + '/store.json'), serializeStore(store.snap, store.undo), undefined, undefined, policy()) } catch (e) {} }
  async function storeRoot () {
    let root = sessionCwd()
    if (!root && sp) { const p = sp.resolve(); root = p && (p.workspaceRoot || p.root) }
    if (!root) { try { root = fs.processPath(await fs.resolve('.')) } catch (e) { root = null } }
    return root || './'
  }
  async function readFile (path) {
    const t = await resolvePath(path)
    let info; try { info = await fs.stat(t) } catch (e) { info = undefined }
    if (!info) throw Object.assign(new Error('File not found: ' + path), { code: 'E_NOT_FOUND' })
    let raw; try { raw = await fs.readText(t) } catch (e) { throw Object.assign(new Error('[E_NOT_TEXT] ' + path + ' is not UTF-8 text'), { code: 'E_NOT_TEXT' }) }
    return { target: t, raw, abs: fs.processPath(t) }
  }

  ctx.tools.register(defineTool({
    name: 'hashline_read',
    description: 'Read a text file with hash anchors. Returns each line as HASH│content (3-char base-62 anchor). Use the HASH, not line numbers, in hashline_replace. Supports offset/limit paging.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the file to read (relative or absolute).' },
      offset: { type: 'number', description: '1-based start line. Defaults to 1.' },
      limit: { type: 'number', description: 'Max lines to read. Defaults to 200.' }
    },
    output: { schema: { type: 'string' }, render (_a, v) { return [{ type: 'text', text: v }] } },
    async execute (args) {
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
  }))

  ctx.tools.register(defineTool({
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

  ctx.tools.register(defineTool({
    name: 'hashline_undo',
    description: 'Undo the most recent hashline_replace for a file, restoring exact prior content, BOM, line endings, and previous hash anchors.',
    parameters: { path: { type: 'string', required: true, description: 'Path of the file to undo.' } },
    output: { schema: { type: 'string' }, render (_a, v) { return [{ type: 'text', text: v }] } },
    async execute (args) {
      const root = await storeRoot()
      const store = await loadStore(root)
      const { target, raw, abs } = await readFile(args.path)
      const entry = openDocument(store.snap, abs, raw)
      const undoRec = store.undo[abs]
      const u = undoFromRecord(entry, undoRec, raw)
      if (u.error) return u.error
      await fs.writeText(target, u.writtenText, undefined, undefined, policy())
      store.snap[abs] = entry
      delete store.undo[abs]
      await saveStore(root, store)
      return 'Undid last replace for ' + args.path + '.' + '\n' + entry.lines.map((l, i) => entry.hashes[i] + E.SEP + l).join('\n')
    }
  }))

  ctx.effect(() => () => {})
}

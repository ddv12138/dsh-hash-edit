'use strict'
// dsh-hash-edit — Cordis Host half (published package entry).
// Registers the hashline tools on the shared host so any agent/preset can call them.
// The *takeover* (shadow built-in read, disable built-in edit, intercept write) lives in
// the agent preset (preset/), because tool restriction & result interception are
// agent-scoped in DSH. This host plugin only consumes host capabilities and publishes
// nothing, so it is safe to compose at host scope.
//
// Load as a cordis.yml row: `name: dsh-hash-edit`.
const E = require('./engine')

function defineTool (ctx, name, description, parameters, execute) {
  return harness.registerTool(ctx, harness.defineTool({
    name,
    description,
    parameters,
    output: { schema: { type: 'string' }, render (a, v) { return [{ type: 'text', text: v }] } },
    async execute (args) {
      try { return await execute(args) } catch (e) { return e && e.message ? e.message : String(e) }
    }
  }))
}

module.exports = {
  apply (ctx) {
    const fs = ctx.get('fs')
    const sp = ctx.get('sandboxPolicy')
    const storeDir = '.dsh-hash-edit'
    if (fs === undefined) return
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
    function resolvePath (path) {
      const cwd = sessionCwd()
      return cwd ? fs.resolve(path, { cwd }) : fs.resolve(path)
    }
    function readSnap (abs, raw) {
      const n = E.normalizeFile(raw)
      const lines = E.splitLines(n.text)
      const s = E._snap ? E._snap[abs] : undefined
      return { bom: n.bom, ending: n.ending, lines, hashes: s && s.lines.join('\n') === n.text ? s.hashes : E.buildHashes(lines, null), text: n.text }
    }
    async function readStore (root) {
      try { const d = JSON.parse(await fs.readText(await fs.resolve(root + '/' + storeDir + '/store.json'))); if (d && typeof d === 'object') return d } catch (e) {}
      return {}
    }
    async function writeStore (root, snap, undo) {
      try { await fs.writeText(await fs.resolve(root + '/' + storeDir + '/store.json'), JSON.stringify({ snap, undo }), undefined, undefined, policy()) } catch (e) {}
    }
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

    defineTool(ctx, 'hashline_read', 'Read a text file with hash anchors. Returns each line as HASH│content (3-char base-62 anchor). Use the HASH, not line numbers, in hashline_replace. Supports offset/limit paging.',
      {
        path: { type: 'string', required: true },
        offset: { type: 'number' },
        limit: { type: 'number' }
      },
      async (args) => {
        const { raw, abs } = await readFile(args.path)
        const root = await storeRoot()
        const store = await readStore(root)
        const snap = store.snap || (store.snap = {})
        const prev = snap[abs]
        const n = E.normalizeFile(raw)
        const lines = E.splitLines(n.text)
        const s = { bom: n.bom, ending: n.ending, lines, hashes: (prev && prev.lines.join('\n') === n.text) ? prev.hashes : E.buildHashes(lines, null), checksum: E.checksumOf(n.text) }
        snap[abs] = s
        const offset = Math.max(1, Math.floor(args.offset || 1))
        const limit = Math.min(Math.floor(args.limit || 200), 200)
        const start = offset - 1
        const end = Math.min(start + limit, lines.length)
        const rows = []
        for (let i = start; i < end; i++) rows.push(s.hashes[i] + E.SEP + lines[i])
        s.served = { checksum: s.checksum, idx: rows.map((_, i) => start + i) }
        await writeStore(root, snap, store.undo || {})
        let out = rows.join('\n')
        if (end < lines.length) out += '\n[Showing lines ' + (start + 1) + '-' + end + ' of ' + lines.length + '. Use offset=' + (end + 1) + ' to continue.]'
        return out
      })

    defineTool(ctx, 'hashline_replace', 'Replace one contiguous line range by its hash anchors (remove_from..remove_to inclusive) with replacement_text (newline separates lines). Stale/ambiguous anchors are rejected, never fuzzy-matched. One edit per call.',
      {
        path: { type: 'string', required: true },
        remove_from: { type: 'string', required: true },
        remove_to: { type: 'string' },
        replacement_text: { type: 'string', required: true }
      },
      async (args) => {
        const root = await storeRoot()
        const store = await readStore(root)
        const snap = store.snap || (store.snap = {})
        const undo = store.undo || (store.undo = {})
        const { target, raw, abs } = await readFile(args.path)
        const n = E.normalizeFile(raw)
        const prev = snap[abs]
        const lines = E.splitLines(n.text)
        const s = { bom: n.bom, ending: n.ending, lines, hashes: (prev && prev.lines.join('\n') === n.text) ? prev.hashes : E.buildHashes(lines, null), checksum: E.checksumOf(n.text) }
        const served = s.served
        if (!served || served.checksum !== s.checksum) return '[E_RANGE_STALE] Nothing was modified: the file changed or was never shown. Call hashline_read first.'
        const range = E.resolveRange(lines, s.hashes, String(args.remove_from || '').trim(), String(args.remove_to || args.remove_from || '').trim())
        if (range.error) return range.error
        const servedSet = {}; for (const i of served.idx) servedSet[i] = true
        let unserved = false; for (let i = range.fi; i <= range.ti; i++) if (!servedSet[i]) unserved = true
        if (unserved) {
          const fresh = []
          for (let i = range.fi; i <= range.ti; i++) fresh.push((i - range.fi + 1) + ': ' + s.hashes[i] + E.SEP + s.lines[i])
          return '[E_RANGE_STALE] Lines in the range were not shown to you. Nothing modified.' + '\n' + fresh.join('\n')
        }
        const r = E.computeReplace(lines, s.hashes, range.fi, range.ti, args.replacement_text)
        if (r.error) return r.error
        undo[abs] = Object.assign({ bom: s.bom, ending: s.ending }, r.undo)
        await writeStore(root, snap, undo)
        await fs.writeText(target, E.joinLines(r.newLines, s.bom, s.ending), undefined, undefined, policy())
        s.lines = r.newLines; s.hashes = r.newHashes; s.checksum = E.checksumOf(r.newLines.join('\n'))
        s.served = { checksum: s.checksum, idx: r.newLines.map((_, i) => i) }
        await writeStore(root, snap, undo)
        return 'Replaced ' + (range.ti - range.fi + 1) + ' line(s).' + '\n' + r.newLines.map((l, i) => s.hashes[i] + E.SEP + l).join('\n')
      })

    defineTool(ctx, 'hashline_undo', 'Undo the most recent hashline_replace for a file, restoring exact prior content, BOM, line endings, and previous hash anchors.',
      { path: { type: 'string', required: true } },
      async (args) => {
        const root = await storeRoot()
        const store = await readStore(root)
        const snap = store.snap || (store.snap = {})
        const undo = store.undo || (store.undo = {})
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
      })

    ctx.effect(() => () => {})
  }
}

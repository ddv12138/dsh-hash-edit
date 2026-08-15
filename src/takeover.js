'use strict'
// dsh-hash-edit — takeover Host half (pi-aligned).
// Composed INSIDE an agent preset (agent scope). This is where tool restriction and
// result interception are effective in DSH:
//   1. registers hashline tools under the pi names `read` / `replace` / `undo_last_replace`,
//      shadowing the built-in `read` for this session only;
//   2. hides the built-in `edit` via tools.restrict({deny:['edit']}) for this session only;
//   3. listens on tools/result so a successful built-in `write` appends an auto-read block
//      (fresh anchors) — leaving anchors un-stale after writes;
//   4. injects a prompt section with the usage discipline (one replace per file per message,
//      copy bare hashes only, never fuzzy-match).
// It only consumes host capabilities and publishes no service, so it can sit loose in a
// preset (no isolate realm needed).
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

function autoReadBlock (s) {
  const head = s.lines.length ? s.lines.slice(0, 40) : []
  return head.map((l, i) => s.hashes[i] + E.SEP + l).join('\n')
}

module.exports = {
  apply (ctx) {
    const fs = ctx.get('fs')
    const sp = ctx.get('sandboxPolicy')
    const tools = ctx.get('tools')
    if (fs === undefined || tools === undefined) return
    const policy = () => (sp ? sp.resolve() : undefined)

    function sessionCwd () {
      try {
        const agents = ctx.get('agents')
        const a = agents && agents.currentInitiator ? agents.currentInitiator() : undefined
        if (a) { const s = a.session || (a.ctx && a.ctx.session); const h = s ? (s.meta || s.header || s) : undefined; return h && h.cwd ? h.cwd : undefined }
      } catch (e) {}
    }
    function resolvePath (path) { const cwd = sessionCwd(); return cwd ? fs.resolve(path, { cwd }) : fs.resolve(path) }
    async function readFile (path) {
      const t = await resolvePath(path)
      const raw = await fs.readText(t)
      return { target: t, raw, abs: fs.processPath(t) }
    }
    const storeRoot = async () => {
      let root = sessionCwd()
      if (!root && sp) { const p = sp.resolve(); root = p && (p.workspaceRoot || p.root) }
      return root || '.' + '/' + ''
    }

    // --- pi-named tools (scoped to this agent) ---
    defineTool(ctx, 'read',
      'Read a text file with hash anchors (hashline). Returns each line as HASH│content; use the HASH in replace. Supports offset/limit.',
      { path: { type: 'string', required: true }, offset: { type: 'number' }, limit: { type: 'number' } },
      async (args) => {
        const { raw, abs } = await readFile(args.path)
        const n = E.normalizeFile(raw)
        const lines = E.splitLines(n.text)
        const root = await storeRoot()
        const store = await readStore(root)
        const snap = store.snap || (store.snap = {})
        const prev = snap[abs]
        const hashes = (prev && prev.lines.join('\n') === n.text) ? prev.hashes : E.buildHashes(lines, null)
        const s = { bom: n.bom, ending: n.ending, lines, hashes, checksum: E.checksumOf(n.text) }
        snap[abs] = s
        const offset = Math.max(1, Math.floor(args.offset || 1))
        const limit = Math.min(Math.floor(args.limit || 200), 200)
        const start = offset - 1; const end = Math.min(start + limit, lines.length)
        const rows = []
        for (let i = start; i < end; i++) rows.push(hashes[i] + E.SEP + lines[i])
        s.served = { checksum: s.checksum, idx: rows.map((_, i) => start + i) }
        await writeStore(root, snap, store.undo || {})
        let out = rows.join('\n')
        if (end < lines.length) out += '\n[Showing lines ' + (start + 1) + '-' + end + ' of ' + lines.length + '. Use offset=' + (end + 1) + ' to continue.]'
        return out
      })

    defineTool(ctx, 'replace',
      'Replace one contiguous line range by its hash anchors (remove_from..remove_to inclusive) with replacement_text (newline separates lines). Stale/ambiguous anchors are rejected, never fuzzy-matched. One edit per call; do not issue multiple replaces on one file in a single message.',
      { path: { type: 'string', required: true }, remove_from: { type: 'string', required: true }, remove_to: { type: 'string' }, replacement_text: { type: 'string', required: true } },
      async (args) => {
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
      })

    defineTool(ctx, 'undo_last_replace',
      'Undo the most recent replace for a file, restoring exact prior content, BOM, line endings, and previous anchors.',
      { path: { type: 'string', required: true } },
      async (args) => {
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
      })

    // --- hide the built-in `edit` tool for this agent ---
    try { const d = tools.restrict({ deny: ['edit'] }); ctx.effect(() => d) } catch (e) {}

    // --- intercept write results: append an auto-read of the fresh anchors ---
    ctx.on('tools/result', (exec, result) => {
      if (!exec || exec.tool !== 'write') return
      const path = exec.args && (exec.args.path || exec.args.file_path)
      if (!path) return
      const done = (text) => {
        try { ctx.emit('hashline/autoread', { path, text }) } catch (e) {}
      }
      ;(async () => {
        try {
          const n = E.normalizeFile(await fs.readText(await resolvePath(path)))
          const lines = E.splitLines(n.text)
          const root = await storeRoot()
          const store = await readStore(root)
          const snap = store.snap || (store.snap = {})
          const prev = snap[await nAbs(path)]
          const hashes = (prev && prev.lines.join('\n') === n.text) ? prev.hashes : E.buildHashes(lines, null)
          snap[await nAbs(path)] = { bom: n.bom, ending: n.ending, lines, hashes, checksum: E.checksumOf(n.text), served: { checksum: E.checksumOf(n.text), idx: lines.map((_, i) => i) } }
          await writeStore(root, snap, store.undo || {})
          done('--- Auto-read (hashline anchors) ---\n' + autoReadBlock(snap[await nAbs(path)]))
        } catch (e) { done('[hashline] auto-read failed: ' + (e && e.message)) }
      })()
    })

    // --- usage-discipline prompt section ---
    const spSection = ctx.get('systemPrompt')
    if (spSection && spSection.section) {
      spSection.section({
        title: 'Hashline editing discipline',
        body: [
          'You edit text files through the hashline tools: read (returns HASH│content rows), replace, and undo_last_replace.',
          '- Always copy a BARE 3-char HASH (A-Za-z0-9) — never fuzzy-match, never guess content.',
          '- Issue ONE replace per file per message; a replace re-anchors the file, so parallel edits go stale.',
          '- A replace may only touch lines you were actually shown; edit a range you have not read returns E_RANGE_STALE.',
          '- After any plain write, re-read to refresh anchors before the next replace.',
          '- Undo is single-level and persisted; call undo_last_replace immediately after a bad replace.'
        ].join('\n')
      })
    }

    // local helpers used above
    async function readStore (root) { try { const d = JSON.parse(await fs.readText(await fs.resolve(root + '/.dsh-hash-edit/store.json'))); if (d && typeof d === 'object') return d } catch (e) {} return {} }
    async function writeStore (root, snap, undo) { try { await fs.writeText(await fs.resolve(root + '/.dsh-hash-edit/store.json'), JSON.stringify({ snap, undo }), undefined, undefined, policy()) } catch (e) {} }
    let nAbs = async (p) => fs.processPath(await resolvePath(p))

    ctx.effect(() => () => {})
  }
}

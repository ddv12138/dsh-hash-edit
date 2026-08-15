import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCoreDefinitions } from '../src/plugin.js'
import { buildTakeoverDefinitions, takeoverBehaviors } from '../src/takeover.js'

// A real-filesystem env: the same interface the tool bodies consume, backed by node:fs over
// a fresh temp dir. This exercises the ACTUAL execute() code paths and the on-disk store.
function makeFSEnv (existingDir) {
  const dir = existingDir || mkdtempSync(join(tmpdir(), 'hashline-int-'))
  const storeDir = join(dir, '.dsh-hash-edit')
  const storeFile = join(storeDir, 'store.json')
  const env = {
    async open (path) {
      const abs = join(dir, path)
      let raw
      try { raw = readFileSync(abs, 'utf8') } catch (e) { throw Object.assign(new Error('File not found: ' + path), { code: 'E_NOT_FOUND' }) }
      return { target: abs, raw, abs }
    },
    write: async (target, content) => writeFileSync(target, content, 'utf8'),
    async loadStore () { try { return JSON.parse(readFileSync(storeFile, 'utf8')) } catch (e) { return { snap: {}, undo: {} } } },
    async saveStore (s) { mkdirSync(storeDir, { recursive: true }); writeFileSync(storeFile, JSON.stringify(s)) },
    _storeFile: () => readFileSync(storeFile, 'utf8')
  }
  return { env, dir, storeDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function defsByName (build, env) {
  const map = {}
  for (const d of build(env)) map[d.name] = d
  return map
}

test('host-core: read→replace→undo through the real execute bodies persists across restart', async () => {
  const { env, dir, storeDir, cleanup } = makeFSEnv()
  try {
    const file = join(dir, 'sample.txt')
    const orig = 'line one\nline two\nline three\nline four\nline five\n'
    writeFileSync(file, orig)
    const t = defsByName(buildCoreDefinitions, env)
    assert.ok(t.hashline_read && t.hashline_replace && t.hashline_undo, 'defs built')

    const shown = await t.hashline_read.execute({ path: 'sample.txt' })
    const [h0] = shown.split('\n') // first row HASH│line
    const anchor0 = h0.split('\u2502')[0]
    assert.match(anchor0, /^[A-Za-z0-9]{3}$/)

    const { ls, ts } = parseRows(shown)
    const replaced = await t.hashline_replace.execute({ path: 'sample.txt', remove_from: ls[1], remove_to: ls[1], replacement_text: 'TWO\n2.5' })
    assert.match(replaced, /^Replaced 1 line\(s\) with 2\./)
    assert.strictEqual(readFileSync(file, 'utf8'), 'line one\nTWO\n2.5\nline three\nline four\nline five\n')
    // survivor anchors stayed stable
    assert.ok(replaced.includes(ts[3]), 'survivor row present')
    assert.ok(await t.hashline_read.execute({ path: 'sample.txt' }), 'post-edit read works')

    // persistence: the store is on disk; simulating a restart is a fresh env on the SAME dir
    assert.ok(existsSync(storeDir) && readFileSync(join(storeDir, 'store.json'), 'utf8').includes('undo'))
    const { env: env2 } = makeFSEnv(dir)
    const t2 = defsByName(buildCoreDefinitions, env2)

    // undo from the persisted store (read back fresh from disk) restores byte-exactly
    const undone = await t2.hashline_undo.execute({ path: 'sample.txt' })
    assert.match(undone, /^Undid last replace/)
    assert.strictEqual(readFileSync(file, 'utf8'), orig)
  } finally { cleanup() }
  function parseRows (out) {
    const ls = []; const ts = []
    for (const line of out.split('\n')) { if (line.includes('\u2502')) { const [h, ...rest] = line.split('\u2502'); ls.push(h); ts.push(h + '\u2502' + rest.join('\u2502')) } }
    return { ls, ts }
  }
})

test('host-core: BOM + CRLF preserved through the real execute path', async () => {
  const { env, dir, cleanup } = makeFSEnv()
  try {
    const file = join(dir, 'win.txt')
    writeFileSync(file, '\uFEFFa\r\nb\r\nc\r\n', 'utf8')
    const t = defsByName(buildCoreDefinitions, env)
    const shown = await t.hashline_read.execute({ path: 'win.txt' })
    const second = shown.split('\n')[1]
    const anchor = second.split('\u2502')[0]
    await t.hashline_replace.execute({ path: 'win.txt', remove_from: anchor, remove_to: anchor, replacement_text: 'B' })
    assert.strictEqual(readFileSync(file, 'utf8'), '\uFEFFa\r\nB\r\nc\r\n')
  } finally { cleanup() }
})

test('host-core: E_NOT_FOUND from the real execute path', async () => {
  const { env, cleanup } = makeFSEnv()
  try {
    const t = defsByName(buildCoreDefinitions, env)
    await assert.rejects(
      t.hashline_replace.execute({ path: 'nope.txt', remove_from: 'aaa', remove_to: 'aaa', replacement_text: 'x' }),
      /File not found: nope\.txt/
    )
  } finally { cleanup() }
})

test('takeover: deny edit + prompt + write-interception auto-read', async () => {
  const { env, dir, cleanup } = makeFSEnv()
  try {
    const file = join(dir, 'auto.txt')
    writeFileSync(file, 'a\nb\nc\n', 'utf8')
    const t = defsByName(buildTakeoverDefinitions, env)
    assert.deepStrictEqual(Object.keys(t).sort(), ['read', 'replace', 'undo_last_replace'])

    // mock ctx that records the tools/result listener, the emitted auto-read, restrict, prompt
    let restrictCalls = []
    let promptTitles = []
    let capturedEmit = []
    let listener
    const ctx = {
      tools: { register: () => () => {}, restrict: (f) => { restrictCalls.push(f); return () => {} } },
      systemPrompt: { section: (s) => { promptTitles.push(s.title); return () => {} } },
      on: (name, h) => { listener = h; return () => {} },
      emit: (name, payload) => { capturedEmit.push(payload) }
    }
    const dispose = takeoverBehaviors(ctx, env)
    try {
      assert.deepStrictEqual(restrictCalls, [{ deny: ['edit'] }])
      assert.deepStrictEqual(promptTitles, ['Hashline editing discipline'])
      // simulate a write tool result -> should append an auto-read of fresh anchors
      await listener({ tool: 'write', args: { path: 'auto.txt' } }, {})
      await new Promise(r => setTimeout(r, 0)) // auto-read fires asynchronously
      assert.strictEqual(capturedEmit.length, 1)
      assert.ok(capturedEmit[0].text.startsWith('--- Auto-read (hashline anchors) ---'))
      assert.ok(capturedEmit[0].text.includes('│a'))
      // a non-write tool must NOT trigger the auto-read
      await listener({ tool: 'read', args: { path: 'auto.txt' } }, {})
      await new Promise(r => setTimeout(r, 0))
      assert.strictEqual(capturedEmit.length, 1)
    } finally { dispose() }
  } finally { cleanup() }
})

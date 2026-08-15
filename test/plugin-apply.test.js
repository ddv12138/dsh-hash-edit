import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyTakeover } from '../src/takeover.js'
import { apply as applyCore } from '../src/plugin.js'

// A minimal DSH ctx mock — just enough for apply() to register tools, restrict edit,
// and inject a prompt section. These tests verify the plugin wiring (not I/O).
function makeCtx () {
  const registered = []
  const restricted = []
  const prompts = []
  return {
    tools: {
      register: (def) => { registered.push(def.name); return () => {} },
      restrict: (f) => { restricted.push(f); return () => {} }
    },
    fs: {
      resolve: async (p) => p,
      readText: async () => '',
      writeText: async () => {},
      stat: async () => ({})
    },
    systemPrompt: { section: (s) => { prompts.push(s.title) } },
    get: () => undefined,
    on: () => () => {},
    emit: () => {},
    effect: () => () => {},
    _registered: registered,
    _restricted: restricted,
    _prompts: prompts
  }
}

test('takeover plugin registers pi-named tools and hides edit', () => {
  const ctx = makeCtx()
  applyTakeover(ctx)
  assert.deepStrictEqual(ctx._registered.sort(), ['read', 'replace', 'undo_last_replace'])
  assert.deepStrictEqual(ctx._restricted, [{ deny: ['edit'] }])
  assert.ok(ctx._prompts.some(t => t === 'Hashline editing discipline'))
})

test('core plugin registers hashline_* tools (no takeover)', () => {
  const ctx = makeCtx()
  applyCore(ctx)
  assert.deepStrictEqual(ctx._registered.sort(), ['hashline_read', 'hashline_replace', 'hashline_undo'])
  assert.deepStrictEqual(ctx._restricted, [])
})

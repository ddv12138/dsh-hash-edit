// Coverage gate: run `node --experimental-test-coverage --test`, parse the "all files"
// line-coverage percentage from the TAP summary, and fail if it drops below the threshold.
// Used by CI so "tests are good enough" is an enforced, not aspirational, property.
import { spawnSync } from 'node:child_process'

const THRESHOLD = Number(process.env.COVERAGE_THRESHOLD || 85)
const nodeArgs = ['--experimental-test-coverage', '--test']

const res = spawnSync(process.execPath, nodeArgs, { encoding: 'utf8' })
const out = `${res.stdout || ''}\n${res.stderr || ''}`

// The summary line looks like:
//   # all files             |  92.25 |    85.14 |   73.72 |
const match = out.match(/^# all files\s*\|\s*([0-9.]+)/m)
if (!match) {
  console.error('Coverage gate: could not find the "# all files" summary line.')
  process.exit(1)
}
const linePct = Number.parseFloat(match[1])

console.log(`Coverage gate: ${linePct}% lines (threshold ${THRESHOLD}%) — tests exit=${res.status}`)
if (res.status !== 0) process.exit(res.status) // test failures always fail the gate
if (linePct < THRESHOLD) {
  console.error(`Coverage gate FAILED: ${linePct}% < ${THRESHOLD}% required.`)
  process.exit(1)
}
console.log(`Coverage gate PASSED (${linePct}% >= ${THRESHOLD}%).`)

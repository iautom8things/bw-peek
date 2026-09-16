// bw-peek: what one AssistantMessage redraw costs with the hook in the chain, through the engine's
// own `$` under `claude plugin test`. The world beneath is mocked and cheap, so the number is the
// hook's own work (scan, next, wrap) plus the harness's dispatch. Printed, and bounded loosely so a
// regression that makes a redraw slow fails here rather than in someone's terminal.
import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

// the sandbox lib has no DOM; console exists at run time under bun and the test runner
declare const console: { log: (...args: unknown[]) => void }

const T0 = Date.parse('2026-09-16T10:00:00')
const REGISTRY = JSON.stringify({ schema_version: 1, repos: { '/a': { prefix: 'adf' }, '/b': { prefix: 'think' } } })

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
let seed = 7
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
function local(len: number): string {
  let s = ''
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)]
  return s
}
const boardIds: string[] = []
while (boardIds.length < 500) boardIds.push(`adf-${local(3)}`)
const LIST = boardIds.join('\n')

const FILLER = 'The implementation now handles the worktree bootstrap path'
function replyText(candidates: number, real: number): string {
  const words: string[] = []
  for (let i = 0; i < candidates; i++) words.push(i < real ? (boardIds[i * 3] as string).slice(4) : local(4))
  return words.map(w => `${FILLER} ${w}, `).join('')
}

function world(on: On) {
  mock.clock(on, { now: T0 })
  mock.store(on)
  on('env.get', async () => ({ value: '/home/mz' }))
  on('process.run', async (_, e) => {
    const argv = [...e.argv]
    if (argv[0] === 'cat') return { value: { exitCode: 0, stdout: REGISTRY, stderr: '' } }
    if (argv[1] === 'config') return { value: { exitCode: 0, stdout: 'adf\n', stderr: '' } }
    if (argv[0] === 'sh' || argv[1] === 'list') return { value: { exitCode: 0, stdout: LIST, stderr: '' } }
    return { value: { exitCode: 1, stdout: '', stderr: 'unexpected' } }
  })
  on('command.register', async (_, e) => ({ value: { command: e.name } }))
  on('ui.invalidate', async () => ({ value: undefined }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.render', async (_, e) => ({ type: 'Box', children: [(e.props as { text: string }).text] }))
}

function render($: Engine, text: string, requestId: string) {
  return $.ui.render({ surface: 'terminal', component: 'AssistantMessage', requestId, viewport: { columns: 120, rows: 40 }, props: { text, isFirstOfReply: true } })
}

async function time($: Engine, text: string, n: number): Promise<number> {
  for (let i = 0; i < 20; i++) await render($, text, `warm-${i}`)
  const t0 = performance.now()
  for (let i = 0; i < n; i++) await render($, text, `m-${i}`)
  return (performance.now() - t0) / n
}

describe('redraw cost', () => {
  test('a 5 KB reply with 100 bare candidates redraws in well under a frame', { timeoutMs: 60_000 }, async ($, on) => {
    world(on)
    const rows: string[] = []
    // the first render fires the board read; settle it so every timed render sees the board
    await render($, 'warm', 'w0')
    for (const [label, text] of [
      ['plain prose, no candidates', FILLER.repeat(90)],
      ['100 candidates, 1 real', replyText(100, 1)],
      ['100 candidates, 5 real', replyText(100, 5)],
      ['100 candidates, 10 real', replyText(100, 10)],
      ['1000 candidates, 100 real (50 KB)', replyText(1000, 100)],
    ] as const) {
      const ms = await time($, text, 200)
      rows.push(`${label.padEnd(36)} ${String(text.length).padStart(6)} bytes  ${ms.toFixed(3)} ms/redraw`)
      expect(ms).toBeLessThan(text.length > 20_000 ? 40 : 10)
    }
    console.log(`\n${rows.join('\n')}\n`)
  })
})

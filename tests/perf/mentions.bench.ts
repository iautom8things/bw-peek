// bw-peek: what the mention scan costs per reply. Run with `bun run tests/perf/mentions.bench.ts`.
// A board the size of adf (500 ids), replies with 100 and 1000 bare candidates of which 1%, 5% and
// 10% are real tickets, and a 50 KB reply with the same density. Prints microseconds per scan.
import { findMentions, mentionMatcher } from '../../hooks/ticket.ts'

// the sandbox lib has no DOM; console exists at run time under bun and the test runner
declare const console: { log: (...args: unknown[]) => void }

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
let seed = 42
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
function local(len: number): string {
  let s = ''
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)]
  return s
}

const PREFIX = 'adf'
const board = new Set<string>()
while (board.size < 500) board.add(`${PREFIX}-${local(3)}${rand() < 0.4 ? `.${Math.floor(rand() * 20) + 1}` : ''}`)
const boardIds = [...board]
const known = { prefix: PREFIX, boards: new Map([[PREFIX, board]]) }
const matcher = mentionMatcher([PREFIX, 'think', 'spire-cl', 'builder', 'engage'])

const FILLER = 'The implementation now handles the worktree bootstrap path correctly and the smoke gate passes on every checked script.'

// a reply with `candidates` bare id-shaped words, `real` of them tickets, spread through prose
function reply(candidates: number, real: number, targetBytes?: number): string {
  const words: string[] = []
  for (let i = 0; i < candidates; i++) {
    if (i < real) words.push((boardIds[Math.floor(rand() * boardIds.length)] as string).slice(PREFIX.length + 1))
    else {
      let w = local(rand() < 0.5 ? 3 : 4)
      while (board.has(`${PREFIX}-${w}`)) w = local(4)
      words.push(w)
    }
  }
  // shuffle
  for (let i = words.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[words[i], words[j]] = [words[j] as string, words[i] as string]
  }
  let text = words.map(w => `${FILLER.split(' ').slice(0, 6).join(' ')} ${w}, `).join('')
  while (targetBytes !== undefined && text.length < targetBytes) text += FILLER + ' '
  return text
}

function bench(name: string, text: string, iterations: number, k = known): void {
  const found = findMentions(text, matcher, k)
  // warm
  for (let i = 0; i < 200; i++) findMentions(text, matcher, k)
  const t0 = performance.now()
  for (let i = 0; i < iterations; i++) findMentions(text, matcher, k)
  const us = ((performance.now() - t0) / iterations) * 1000
  console.log(`${name.padEnd(46)} ${String(text.length).padStart(7)} bytes  ${found.length.toString().padStart(3)} found  ${us.toFixed(1).padStart(8)} µs/scan`)
}

console.log(`board: ${board.size} ids · prefixes in matcher: 5\n`)
bench('100 candidates, 1% real', reply(100, 1), 5000)
bench('100 candidates, 5% real', reply(100, 5), 5000)
bench('100 candidates, 10% real', reply(100, 10), 5000)
bench('1000 candidates, 10% real', reply(1000, 100), 1000)
bench('50 KB reply, 100 candidates, 10% real', reply(100, 10, 50_000), 500)
bench('plain prose, no candidates (2 KB)', FILLER.repeat(18), 5000)
bench('no board (full ids only), 100 candidates', reply(100, 10), 5000, undefined)

// bw-peek: the hooks against the engine's own `$`, run by `claude plugin test`. The world beneath
// the plugin is answered here: HOME, the registry file and every `bw` call from a table keyed by
// argv, the clock and store from memory.
import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

const T0 = Date.parse('2026-09-16T10:00:00')
const PLUGIN = 'bw-peek'

const REGISTRY = JSON.stringify({ schema_version: 1, repos: { '/a': { prefix: 'adf' }, '/b': { prefix: 'think' } } })
// the board, as `bw list --all --json | jq -r '.[].id'` prints it
const LIST = ['adf-c50', 'adf-wxh.5', 'adf-zu6', 'adf-the'].join('\n')
// and as the text listing prints it, for the fallback
const LIST_TEXT = ['✓ adf-c50 P1 live-activity [blocks: adf-lxh]', '❄ adf-wxh.5 P2 S5 follow-up', '○ adf-zu6 P1 [BUG] pi-real.sh guard'].join('\n')

const C50 = {
  assignee: '',
  blocked_by: [],
  blocks: ['adf-lxh'],
  closed_at: '2026-09-16T14:40:16Z',
  close_reason: 'Shipped on main at 392b2a60 (v0.100.0).',
  created: '2026-09-16T13:16:44Z',
  description: Array.from({ length: 30 }, (_, i) => `description line ${i + 1}`).join('\n'),
  id: 'adf-c50',
  labels: ['slug:live-activity-function-hooks'],
  comments: [
    { text: 'Committed a7507330 on branch live-activity (worktree agentic-dotfiles-live-activity), unmerged pending sign-off.', timestamp: '2026-09-16T13:44:53Z' },
    { text: 'Second comment, short.', timestamp: '2026-09-16T14:00:00Z' },
  ],
  priority: 1,
  status: 'closed',
  title: 'live-activity: function-hooks plugin drawing live tasks above the prompt',
  type: 'feature',
  updated_at: '2026-09-16T14:40:16Z',
}

const WXH5 = {
  ...C50,
  id: 'adf-wxh.5',
  blocks: [],
  closed_at: undefined,
  close_reason: undefined,
  comments: [],
  description: 'one line',
  labels: [],
  priority: 2,
  status: 'deferred',
  defer_until: '2026-05-31',
  title: 'S5 follow-up: reconcile cpu_pct vs cpu_percent naming',
  type: 'task',
}

type Run = { exitCode: number; stdout: string; stderr: string }

// every string in a render tree, in drawing order, whitespace collapsed; Buttons as [label]
function textOf(node: unknown): string {
  return flatten(node).replace(/\s+/g, ' ').trim()
}

function flatten(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatten).filter(t => t !== '').join(' ')
  if (typeof node === 'object' && node !== null) {
    const n = node as { type?: string; props?: { label?: string; placeholder?: string; value?: string }; children?: unknown }
    const own = n.type === 'Button' ? `[${n.props?.label ?? ''}]` : n.type === 'Input' ? `<input ${n.props?.value ?? ''}|${n.props?.placeholder ?? ''}>` : ''
    return [own, flatten(n.children)].filter(t => t !== '').join(' ')
  }
  return ''
}

function pane($: Engine, columns = 120) {
  return $.ui.render({
    surface: 'terminal',
    component: 'Pane',
    requestId: 'bw',
    viewport: { columns, rows: 40 },
    props: { title: 'Beadwork', isFocused: true, bodyColumns: columns, placement: 'inline', scroll: { offset: 0, bodyRows: 24 }, view: {} },
  })
}

function reply($: Engine, text: string, requestId = 'msg-1', columns = 120) {
  return $.ui.render({
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId,
    viewport: { columns, rows: 40 },
    props: { text, isFirstOfReply: true },
  })
}

function run($: Engine, args: string) {
  return $.command.run({ command: 'bw', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
}

// the world: HOME, the registry, `bw config get prefix`, and `bw show` from a table
function world(on: On, shows: Record<string, Run | undefined> = {}, prefix = 'adf', stored: Record<string, unknown> = {}, lists: string[] = [], noJq = false, noBoard = false) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, stored)
  const calls: string[][] = []
  const logs: unknown[] = []
  const NO_BOARD = { exitCode: 1, stdout: '', stderr: 'error: beadwork not initialized. Run: bw init\n' }
  on('env.get', async () => ({ value: '/home/mz' }))
  on('process.run', async (_, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    if (argv[0] === 'cat') return { value: { exitCode: 0, stdout: REGISTRY, stderr: '' } }
    if (argv[0] === 'bw' && argv[1] === 'config') return { value: { exitCode: 0, stdout: `${prefix}\n`, stderr: '' } }
    if (argv[0] === 'sh' && argv[2]?.startsWith('bw list --all --json | jq')) {
      if (noBoard) return { value: { ...NO_BOARD, exitCode: 0 } } // jq exits 0 on empty input; no pipefail
      if (noJq) return { value: { exitCode: 127, stdout: '', stderr: 'sh: jq: command not found' } }
      return { value: { exitCode: 0, stdout: lists.shift() ?? LIST, stderr: '' } }
    }
    if (argv[0] === 'bw' && argv[1] === 'list') return { value: noBoard ? NO_BOARD : { exitCode: 0, stdout: LIST_TEXT, stderr: '' } }
    if (argv[0] === 'bw' && argv[1] === 'show') {
      const id = argv[2] as string
      const r = shows[id]
      return { value: r ?? { exitCode: 1, stdout: '', stderr: `error: no issue found matching "${id}"\n` } }
    }
    return { value: { exitCode: 127, stdout: '', stderr: `unexpected: ${argv.join(' ')}` } }
  })
  on('command.register', async (_, e) => ({ value: { command: e.name } }))
  on('ui.invalidate', async () => ({ value: undefined }))
  on('ui.log', async (_, e) => {
    logs.push(e)
    return { value: undefined }
  })
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: undefined }))
  on('ui.close', async () => ({ value: undefined }))
  on('ui.focus', async () => ({}))
  // the engine's own drawing of a reply: its text in a Box
  on('ui.render', async (_, e) => ({ type: 'Box', children: [e.component === 'AssistantMessage' ? (e.props as { text: string }).text : ''] }))
  on('command.run', async () => ({}))
  return { clock, calls, logs }
}

const ok = (t: unknown): Run => ({ exitCode: 0, stdout: JSON.stringify(t), stderr: '' })

describe('the pane', () => {
  test('empty: the search box, the hint with this repo\'s prefix, no Refresh button', async ($, on) => {
    world(on)
    await run($, '')
    const text = textOf(await pane($))
    expect(text).toContain('◈ Beadwork')
    expect(text).toContain('<input |ticket id, e.g. adf-c50 or c50>')
    expect(text).toContain('a bare c50 means adf-c50 here')
    expect(text).not.toContain('[Refresh]')
  })

  test('/bw <id> fetches the ticket and draws digest, title, collapsed description and comment digests', async ($, on) => {
    const { calls } = world(on, { 'adf-c50': ok(C50) })
    await run($, 'adf-c50')
    expect(calls).toContainEqual(['bw', 'show', 'adf-c50', '--json'])
    const text = textOf(await pane($))
    expect(text).toContain('✓ closed')
    expect(text).toContain('P1')
    expect(text).toContain('feature')
    expect(text).toContain('⚑ slug:live-activity-function-hooks')
    expect(text).toContain('created Sep 16 · closed Sep 16')
    expect(text).toContain('live-activity: function-hooks plugin drawing live tasks above the prompt')
    expect(text).toContain('blocks [adf-lxh]')
    expect(text).toContain('↳ Shipped on main at 392b2a60')
    expect(text).toContain('Description 30 rows [Show all]')
    expect(text).toContain('description line 8')
    expect(text).not.toContain('description line 9')
    expect(text).toContain('… 22 more rows')
    expect(text).toContain('Comments (2)')
    expect(text).toContain('[+] Sep 16')
    // fifty characters, then the ellipsis
    expect(text).toContain('Committed a7507330 on branch live-activity (workt…')
    expect(text).not.toContain('unmerged pending sign-off')
    expect(text).toContain('[Refresh]')
  })

  test('Show all expands the description; + opens a comment in full; pressing again folds them', async ($, on) => {
    world(on, { 'adf-c50': ok(C50) })
    await run($, 'adf-c50')
    await pane($)
    await $.ui.press({ plugin: PLUGIN, key: 'desc-toggle', requestId: 'bw' })
    let text = textOf(await pane($))
    expect(text).toContain('description line 30')
    expect(text).toContain('[Collapse]')
    await $.ui.press({ plugin: PLUGIN, key: 'c-toggle-0', requestId: 'bw' })
    text = textOf(await pane($))
    expect(text).toContain('[−] Sep 16')
    expect(text).toContain('unmerged pending sign-off')
    await $.ui.press({ plugin: PLUGIN, key: 'c-toggle-0', requestId: 'bw' })
    await $.ui.press({ plugin: PLUGIN, key: 'desc-toggle', requestId: 'bw' })
    text = textOf(await pane($))
    expect(text).not.toContain('unmerged pending sign-off')
    expect(text).not.toContain('description line 30')
  })

  test('a bare id takes this repo\'s prefix; a deferred child shows its parent and the defer date', async ($, on) => {
    const { calls } = world(on, { 'adf-wxh.5': ok(WXH5) })
    await run($, 'wxh.5')
    expect(calls).toContainEqual(['bw', 'show', 'adf-wxh.5', '--json'])
    const text = textOf(await pane($))
    expect(text).toContain('❄ deferred')
    expect(text).toContain('❄ until May 31 (now due)')
    expect(text).toContain('parent [adf-wxh]')
    expect(text).toContain('Description 1 row')
    expect(text).not.toContain('[Show all]')
    expect(text).toContain('Comments (none)')
  })

  test('an ambiguous id lists candidates as buttons, and pressing one opens it', async ($, on) => {
    const { calls, clock } = world(on, {
      'think-1': { exitCode: 1, stdout: '', stderr: 'error: ambiguous ID "think-1": matches think-1pp, think-1av\n' },
      'think-1av': ok({ ...C50, id: 'think-1av', title: 'Planning ticket', blocks: [], comments: [], description: '' }),
    })
    await run($, 'think-1')
    let text = textOf(await pane($))
    expect(text).toContain('think-1 matches 2 tickets')
    expect(text).toContain('[think-1av] [think-1pp]')
    await $.ui.press({ plugin: PLUGIN, key: 'cand-think-1av', requestId: 'bw' })
    await clock.settle()
    expect(calls).toContainEqual(['bw', 'show', 'think-1av', '--json'])
    text = textOf(await pane($))
    expect(text).toContain('Planning ticket')
    expect(text).toContain('Description (none)')
    // the partial that bw could not resolve is not a recent entry; the ticket it led to is
    expect(text).not.toContain('recent')
    await run($, 'adf-zzz9')
    expect(textOf(await pane($))).toContain('recent [think-1av] [forget]')
  })

  test('a missing ticket says so', async ($, on) => {
    world(on)
    await run($, 'adf-zzz9')
    const text = textOf(await pane($))
    expect(text).toContain('✗ no ticket matches adf-zzz9')
  })

  test('a second look within the fresh window reuses the fetch; Refresh runs bw again', async ($, on) => {
    const { calls, clock } = world(on, { 'adf-c50': ok(C50) })
    const shows = () => calls.filter(c => c[1] === 'show').length
    await run($, 'adf-c50')
    expect(shows()).toBe(1)
    await run($, 'adf-c50')
    expect(shows()).toBe(1)
    await pane($)
    await $.ui.press({ plugin: PLUGIN, key: 'refresh', requestId: 'bw' })
    await clock.settle()
    expect(shows()).toBe(2)
    await clock.advance(60_000)
    await run($, 'adf-c50')
    expect(shows()).toBe(3)
  })

  test('the recent row starts from the store, grows with tickets found, drops a miss, and forget clears it', async ($, on) => {
    const { clock } = world(on, { 'adf-c50': ok(C50), 'adf-wxh.5': ok(WXH5) }, 'adf', { 'recent-v2': ['adf-zu6', 'adf-gone', 'not an id'] })
    await run($, '')
    let text = textOf(await pane($))
    expect(text).toContain('recent [adf-zu6] [adf-gone] [forget]')
    await run($, 'adf-c50')
    await run($, 'adf-wxh.5')
    // a stored id that turns out not to exist any more leaves the trail; typos never join it
    await run($, 'adf-gone')
    await run($, 'adf-typo')
    text = textOf(await pane($))
    expect(text).toContain('✗ no ticket matches adf-typo')
    expect(text).toContain('recent [adf-wxh.5] [adf-c50] [adf-zu6] [forget]')
    expect(text).not.toContain('adf-gone')
    await $.ui.press({ plugin: PLUGIN, key: 'forget', requestId: 'bw' })
    await clock.settle()
    text = textOf(await pane($))
    expect(text).not.toContain('recent')
  })
})

describe('under a reply', () => {
  test('a reply naming tickets gets one button per distinct id, capped with +N more', async ($, on) => {
    world(on)
    const text = textOf(await reply($, 'Closed adf-c50 and adf-c50 again; think-1pp.4 is next, then adf-a1, adf-a2, adf-a3, adf-a4, adf-a5.'))
    expect(text).toContain('Closed adf-c50 and adf-c50 again')
    expect(text).toContain('◈ [adf-c50] [think-1pp.4] [adf-a1] [adf-a2] [adf-a3] [adf-a4] +1 more')
  })

  test('a bare id that is a ticket on this board gets a button too; other words and other boards do not', async ($, on) => {
    const { clock } = world(on)
    // a redraw never waits on bw list: the first reply draws without the board, the read lands in the
    // background and invalidates, and the redraw has it
    const early = textOf(await reply($, 'Closed c50 early.', 'msg-0'))
    expect(early).not.toContain('[adf-c50]')
    await clock.settle()
    expect(textOf(await reply($, 'Closed c50 early.', 'msg-0'))).toContain('◈ [adf-c50]')
    const text = textOf(await reply($, 'Closed c50 and wxh.5; the guard in zu6 is next, but abc and 1pp are not ours and c50 repeats.'))
    expect(text).toContain('◈ [adf-c50] [adf-wxh.5] [adf-zu6]')
    expect(text).not.toContain('adf-the')
    expect(text).not.toContain('[adf-abc]')
  })

  test('a ticket filed through the Bash tool re-reads the board, so the new id lights up', async ($, on) => {
    const { calls, clock } = world(on, {}, 'adf', {}, [LIST, `${LIST}\nadf-q7z`])
    on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: 'created adf-q7z: just filed', stderr: '', interrupted: false } }))
    expect(textOf(await reply($, 'Filed q7z for this.'))).not.toContain('adf-q7z')
    await clock.settle()
    await $.tool.call({ tool: 'Bash', command: "bw create 'just filed' -t task", description: 'File a ticket' })
    await clock.settle()
    expect(calls.filter(c => c[0] === 'sh')).toHaveLength(2)
    expect(textOf(await reply($, 'Filed q7z for this.', 'msg-2'))).toContain('◈ [adf-q7z]')
  })

  test('without jq the board comes from the text listing instead', async ($, on) => {
    const { calls, clock } = world(on, {}, 'adf', {}, [], true)
    await reply($, 'warm', 'msg-0')
    await clock.settle()
    expect(calls.filter(c => c[0] === 'sh')).toHaveLength(1)
    expect(calls).toContainEqual(['bw', 'list', '--all'])
    // adf-lxh is on the text page only as a blocker, and still counts
    expect(textOf(await reply($, 'c50 blocks lxh; wxh.5 waits.'))).toContain('◈ [adf-c50] [adf-lxh] [adf-wxh.5]')
  })

  test('a repo without a board: full ids still get buttons, bare ids stay plain, one log line in all', async ($, on) => {
    const { calls, clock, logs } = world(on, {}, 'adf', {}, [], false, true)
    await reply($, 'warm', 'msg-0')
    await clock.settle()
    // the pipeline, then the text listing, then nothing more for this redraw
    expect(calls.filter(c => c[0] === 'sh')).toHaveLength(1)
    expect(calls.filter(c => c[0] === 'bw' && c[1] === 'list')).toHaveLength(1)
    const tree = textOf(await reply($, 'c50 blocks adf-lxh; see think-1pp.'))
    expect(tree).toContain('◈ [adf-lxh] [think-1pp]')
    expect(tree).not.toContain('[adf-c50]')
    // said once, without the plugin naming itself (the engine does that)
    expect(logs).toHaveLength(1)
    expect(JSON.stringify(logs[0])).toContain('beadwork not initialized')
    expect(JSON.stringify(logs[0])).not.toContain('bw-peek')
    // a later redraw past the stale window reads again and stays quiet
    await clock.advance(3 * 60_000)
    await reply($, 'still c50', 'msg-9')
    await clock.settle()
    expect(calls.filter(c => c[0] === 'bw' && c[1] === 'list')).toHaveLength(2)
    expect(logs).toHaveLength(1)
  })

  test('a reply without a known prefix is left to the engine', async ($, on) => {
    world(on)
    const tree = (await reply($, 'Use sha-256 here, not utf-8; see unknown-x1.')) as { type: string; children?: unknown[] }
    expect(textOf(tree)).toBe('Use sha-256 here, not utf-8; see unknown-x1.')
    expect(textOf(tree)).not.toContain('◈')
  })

  test('pressing an id button opens the pane on that ticket', async ($, on) => {
    const { calls, clock } = world(on, { 'adf-c50': ok(C50) })
    await reply($, 'See adf-c50.')
    await $.ui.press({ plugin: PLUGIN, key: 'mention-adf-c50', requestId: 'msg-1' })
    await clock.settle()
    expect(calls).toContainEqual(['bw', 'show', 'adf-c50', '--json'])
    const text = textOf(await pane($))
    expect(text).toContain('adf-c50')
    expect(text).toContain('✓ closed')
  })
})

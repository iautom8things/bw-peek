// bw-peek: the hooks against the engine's own `$`, run by `claude plugin test`. The world beneath
// the plugin is answered here: HOME, the registry file and every `bw` call from a table keyed by
// argv, the clock and store from memory.
import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

const T0 = Date.parse('2026-09-16T10:00:00')
const PLUGIN = 'bw-peek'

const REGISTRY = JSON.stringify({ schema_version: 1, repos: { '/a': { prefix: 'adf' }, '/b': { prefix: 'think' } } })
// the board, as `bw list --all` prints it
const LIST = ['✓ adf-c50 P1 live-activity [blocks: adf-lxh]', '❄ adf-wxh.5 P2 S5 follow-up', '○ adf-zu6 P1 [BUG] pi-real.sh guard', '○ adf-the P2 a ticket spelt like a word'].join('\n')

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
function world(on: On, shows: Record<string, Run | undefined> = {}, prefix = 'adf', stored: Record<string, unknown> = {}, lists: string[] = []) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, stored)
  const calls: string[][] = []
  on('env.get', async () => ({ value: '/home/mz' }))
  on('process.run', async (_, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    if (argv[0] === 'cat') return { value: { exitCode: 0, stdout: REGISTRY, stderr: '' } }
    if (argv[0] === 'bw' && argv[1] === 'config') return { value: { exitCode: 0, stdout: `${prefix}\n`, stderr: '' } }
    if (argv[0] === 'bw' && argv[1] === 'list') return { value: { exitCode: 0, stdout: lists.shift() ?? LIST, stderr: '' } }
    if (argv[0] === 'bw' && argv[1] === 'show') {
      const id = argv[2] as string
      const r = shows[id]
      return { value: r ?? { exitCode: 1, stdout: '', stderr: `error: no issue found matching "${id}"\n` } }
    }
    return { value: { exitCode: 127, stdout: '', stderr: `unexpected: ${argv.join(' ')}` } }
  })
  on('command.register', async (_, e) => ({ value: { command: e.name } }))
  on('ui.invalidate', async () => ({ value: undefined }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: undefined }))
  on('ui.close', async () => ({ value: undefined }))
  on('ui.focus', async () => ({}))
  // the engine's own drawing of a reply: its text in a Box
  on('ui.render', async (_, e) => ({ type: 'Box', children: [e.component === 'AssistantMessage' ? (e.props as { text: string }).text : ''] }))
  on('command.run', async () => ({}))
  return { clock, calls }
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
    // the ambiguous lookup is now a recent entry
    expect(text).toContain('recent [think-1]')
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

  test('the recent row starts from the store, grows with lookups, and forget clears it', async ($, on) => {
    const { clock } = world(on, { 'adf-c50': ok(C50), 'adf-wxh.5': ok(WXH5) }, 'adf', { 'recent-v1': ['adf-zu6', 'not an id'] })
    await run($, '')
    let text = textOf(await pane($))
    expect(text).toContain('recent [adf-zu6] [forget]')
    await run($, 'adf-c50')
    await run($, 'adf-wxh.5')
    text = textOf(await pane($))
    expect(text).toContain('recent [adf-c50] [adf-zu6] [forget]')
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
    const { calls, clock } = world(on, {}, 'adf', {}, [LIST, `${LIST}\n○ adf-q7z P2 just filed`])
    on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: 'created adf-q7z: just filed', stderr: '', interrupted: false } }))
    expect(textOf(await reply($, 'Filed q7z for this.'))).not.toContain('adf-q7z')
    await clock.settle()
    await $.tool.call({ tool: 'Bash', command: "bw create 'just filed' -t task", description: 'File a ticket' })
    await clock.settle()
    expect(calls.filter(c => c[1] === 'list')).toHaveLength(2)
    expect(textOf(await reply($, 'Filed q7z for this.', 'msg-2'))).toContain('◈ [adf-q7z]')
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

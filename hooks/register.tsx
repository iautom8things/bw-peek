/* @jsx h */
import type { EngineInterface, Register } from 'claude-code'
import { drawMentions, drawPane, type Actions, type View } from './draw.tsx'
import { type Board, findMentions, isTicketId, type Known, mentionMatcher, mentionedPrefixes, normalizeId, parseChildren, parseListIds, parseRegistry, parseRegistryPaths, parseShow, prefixOf, type Lookup, type Ticket } from './ticket.ts'

// bw-peek: a Beadwork ticket pane inside the session.
//
// The agent names tickets by id (adf-c50, think-1pp) and the person reading has no idea what they
// refer to. This plugin answers that without leaving the terminal:
// - /bw <id> opens a pane on the ticket; /bw alone opens it with the search box focused.
// - Under every reply that mentions a ticket, one dim row of [ id ] buttons; a press opens the pane
//   on that ticket. A mention is a full id that is on its board (any board bw's registry knows), or
//   a bare local part (`c50`, `wxh.5`) that is a ticket on this repo's own. The shape alone is not
//   enough: `PM-internal` in prose has the shape of a `pm` id. This is a render-side decoration: no
//   prompt text, no CLAUDE.md rule, no tokens. A board's ids come from
//   `bw list --all --json | jq -r '.[].id'`, read the first time a drawing names its prefix and
//   again when stale or after a `bw create` / `bw delete` runs through the Bash tool.
// - The pane runs `bw show <id> --json` through $.process.run (cross-repo, via bw's
//   registry) and draws the digest, the title, the description and the comments.
//
// Nothing here writes to bw. Recent lookups live in $.store across sessions.

const PANE_ID = 'bw'
// v2: only ids bw answered with a ticket; v1 kept every search, misses and all
const RECENT_KEY = 'recent-v2'
const RECENT_CAP = 10
// a ticket shown again within this window is not re-fetched; Refresh always is
const FRESH_MS = 30_000
const SHOW_TIMEOUT_MS = 20_000
// a board's id list is re-read when a drawing names its prefix and the list is older than this
const KNOWN_STALE_MS = 2 * 60_000
const LIST_TIMEOUT_MS = 20_000
// a board's ids: the JSON contract through jq (one id per line, a few KB), and when that pipeline
// cannot run (no jq, no sh) the text listing, whose lines carry the id near the front. The JSON
// itself is not read into the plugin: every description and comment rides along, 4 MB for 500
// tickets, and $.process.run cuts output at a limit. `dir` is another repo's path from the
// registry; without one bw reads the cwd's board
function listArgv(dir: string | undefined): string[] {
  return dir === undefined ? ['sh', '-c', 'bw list --all --json | jq -r ".[].id"'] : ['sh', '-c', 'bw -C "$1" list --all --json | jq -r ".[].id"', 'sh', dir]
}
function listTextArgv(dir: string | undefined): string[] {
  return ['bw', ...(dir === undefined ? [] : ['-C', dir]), 'list', '--all']
}

let ready: Promise<void> | undefined
let matcher: RegExp | undefined
let prefixes: string[] = []
let repoPaths: Record<string, string[]> = {}
let defaultPrefix: string | undefined
let recent: string[] = []
let current: string | undefined
const lookups: Record<string, Lookup> = {}
const pending = new Set<string>()
let paneOpen = false
let descriptionExpanded = false
let childrenExpanded = false
let openComments = new Set<number>()
let search = ''
let commandRegistered: Promise<void> | undefined

// every board read so far by prefix, when each was read, and the reads in flight
const boards = new Map<string, Board>()
const boardAt = new Map<string, number>()
const boardRefresh = new Map<string, Promise<void>>()
let homeAt = -Infinity
let homeRefresh: Promise<void> | undefined
// the boards said to be unreadable ('' is the session's own, when the cwd has none)
const warned = new Set<string>()

let mentionButtons = true
let bareMentions = true
let mentionCap = 6
let collapsedRows = 8
let digestChars = 50

// the engine prefixes every line with the plugin's name already
function log($: EngineInterface, text: string): void {
  $.ui.log(text)
}

// once per module load (session start, and again after a hot reload): the registry's prefixes,
// this repo's prefix, the recent list
// the prefix of the repo the session's shell is in now. A `cd` through the Bash tool moves the
// session's cwd, and $.process.run follows it, so this is read before every board read rather
// than once at start; a repo without `bw init` answers with an error
async function readPrefix($: EngineInterface): Promise<{ prefix: string } | { error: string }> {
  try {
    const r = await $.process.run(['bw', 'config', 'get', 'prefix'], { timeoutMs: 8000 })
    const p = r.stdout.trim().toLowerCase()
    if (r.exitCode !== 0) return { error: r.stderr.trim() || `bw config get prefix exit ${r.exitCode}` }
    if (!/^[a-z][a-z0-9_-]{0,23}$/.test(p)) return { error: `unusable prefix ${JSON.stringify(p)}` }
    if (!prefixes.includes(p)) {
      prefixes.push(p)
      matcher = mentionMatcher(prefixes)
    }
    return { prefix: p }
  } catch (err) {
    return { error: String(err) }
  }
}

function ensureReady($: EngineInterface): Promise<void> {
  ready ??= (async () => {
    // bw's host-local registry (0.13+; off until `registry.auto` is set in ~/.bw, see the README).
    // An older bw has no `registry` command and an empty registry prints `[]`: either way the
    // session repo's own prefix, read next, is all the plugin knows
    try {
      const r = await $.process.run(['bw', 'registry', 'list', '--json'], { timeoutMs: 8000 })
      if (r.exitCode === 0) {
        prefixes.push(...parseRegistry(r.stdout))
        repoPaths = parseRegistryPaths(r.stdout)
      }
      else log($, `registry unreadable (bw registry list exit ${r.exitCode}): ${r.stderr.trim()}`)
    } catch (err) {
      log($, `registry read failed: ${err}`)
    }
    matcher = mentionMatcher(prefixes)
    const here = await readPrefix($)
    defaultPrefix = 'prefix' in here ? here.prefix : undefined
    try {
      const saved = await $.store.get(RECENT_KEY)
      if (Array.isArray(saved)) recent = saved.filter((x): x is string => typeof x === 'string' && isTicketId(x)).slice(0, RECENT_CAP)
    } catch (err) {
      log($, `store read failed: ${err}`)
    }
  })()
  return ready
}

// one board's ids. The session's own board is the cwd's; another repo's is read at the paths the
// registry files its prefix under, all of them, since two clones can share a prefix and differ
async function readBoard($: EngineInterface, prefix: string): Promise<{ ids: Set<string> } | { error: string }> {
  const dirs: (string | undefined)[] = prefix === defaultPrefix ? [undefined] : repoPaths[prefix] ?? []
  if (dirs.length === 0) return { error: `the registry names no repo for ${prefix}` }
  const ids = new Set<string>()
  let error: string | undefined
  let read = false
  for (const dir of dirs) {
    // the jq pipeline first; when it fails (no jq) the text listing decides, quietly
    let r = await $.process.run(listArgv(dir), { timeoutMs: LIST_TIMEOUT_MS })
    if (r.exitCode !== 0 || r.stdout.trim() === '') r = await $.process.run(listTextArgv(dir), { timeoutMs: LIST_TIMEOUT_MS })
    if (r.exitCode === 0) {
      read = true
      for (const id of parseListIds(r.stdout, prefix)) ids.add(id)
    } else error ??= r.stderr.trim() || `bw list exit ${r.exitCode}`
  }
  return read ? { ids } : { error: error ?? 'bw list failed' }
}

function sameBoard(a: Board | undefined, b: Board): boolean {
  if (a === undefined || a === 'unreadable' || b === 'unreadable') return a === b
  return a.size === b.size && [...b].every(id => a.has(id))
}

// reads one board; one run at a time per prefix, the old set drawn meanwhile. A board that cannot
// be read is said once and marked, so its full ids draw unchecked instead of never
function refreshBoard($: EngineInterface, prefix: string): Promise<void> {
  let run = boardRefresh.get(prefix)
  if (run !== undefined) return run
  run = (async () => {
    try {
      const r = await readBoard($, prefix)
      const board: Board = 'ids' in r ? r.ids : 'unreadable'
      if ('error' in r && !warned.has(prefix)) {
        warned.add(prefix)
        log($, `cannot list the ${prefix} board, its ids go unchecked: ${r.error}`)
      } else if ('ids' in r) warned.delete(prefix)
      const changed = !sameBoard(boards.get(prefix), board)
      boards.set(prefix, board)
      if (changed) $.ui.invalidate('ui.render')
    } catch (err) {
      if (!warned.has(prefix)) {
        warned.add(prefix)
        log($, `bw list failed: ${err}`)
      }
    } finally {
      boardAt.set(prefix, await $.clock.now())
      boardRefresh.delete(prefix)
    }
  })()
  boardRefresh.set(prefix, run)
  return run
}

// the session's own board: where the shell is now, then that board's ids
function refreshHome($: EngineInterface): Promise<void> {
  homeRefresh ??= (async () => {
    try {
      const before = defaultPrefix
      const here = await readPrefix($)
      defaultPrefix = 'prefix' in here ? here.prefix : undefined
      // no board here (a repo without `bw init`, bw missing): said once, and full ids keep working
      // through bw's registry
      if ('error' in here && !warned.has('')) {
        warned.add('')
        log($, `no board here, bare ids stay plain: ${here.error}`)
      } else if ('prefix' in here) warned.delete('')
      if (before !== defaultPrefix) $.ui.invalidate('ui.render')
      if (defaultPrefix !== undefined) await refreshBoard($, defaultPrefix)
    } finally {
      homeAt = await $.clock.now()
      homeRefresh = undefined
    }
  })()
  return homeRefresh
}

// never blocks a drawing on bw: the session's board and the boards `text` names, where missing or
// stale, are fetched in the background, and the drawing happens again (a refresh invalidates) once
// they land
async function knownFor($: EngineInterface, text: string): Promise<Known> {
  const now = await $.clock.now()
  const homeStale = now - homeAt > KNOWN_STALE_MS
  if (homeStale) fire($, 'bw list', refreshHome($))
  for (const prefix of mentionedPrefixes(text, matcher)) {
    // the home refresh reads the session's own board itself
    if (homeStale && prefix === defaultPrefix) continue
    if (now - (boardAt.get(prefix) ?? -Infinity) > KNOWN_STALE_MS) fire($, 'bw list', refreshBoard($, prefix))
  }
  return { prefix: bareMentions ? defaultPrefix ?? '' : '', boards }
}

function ensureCommand($: EngineInterface): Promise<void> {
  commandRegistered ??= $.command
    .register({ name: 'bw', description: 'Open a Beadwork ticket in a pane (adf-c50, think-1pp, or a bare id for this repo)', argumentHint: '[ticket-id]', immediate: true })
    .then(() => undefined)
    .catch(err => {
      commandRegistered = undefined
      log($, `command.register failed: ${err}`)
    })
  return commandRegistered
}

// recent is a trail of tickets, never of searches: an id joins once bw answered with a ticket and
// leaves the moment a lookup says it is not one
function remember($: EngineInterface, id: string): void {
  recent = [id, ...recent.filter(r => r !== id)].slice(0, RECENT_CAP)
  $.store.set(RECENT_KEY, recent).catch(err => log($, `store write failed: ${err}`))
}

function forget($: EngineInterface, id: string): void {
  if (!recent.includes(id)) return
  recent = recent.filter(r => r !== id)
  $.store.set(RECENT_KEY, recent).catch(err => log($, `store write failed: ${err}`))
}

function noteLookup($: EngineInterface, id: string): void {
  const l = lookups[id]
  if (l === undefined) return
  if (l.kind === 'ticket') remember($, id)
  else forget($, id)
}

async function openPane($: EngineInterface): Promise<void> {
  paneOpen = true
  try {
    await $.ui.open({ id: PANE_ID, title: 'Beadwork', focus: true, closeOnEscape: true, rows: 24 })
  } catch (err) {
    paneOpen = false
    log($, `pane open failed: ${err}`)
    $.ui.toast(`could not open the pane: ${err}`, { timeoutMs: 4000 })
  }
  $.ui.invalidate('ui.render')
}

function closePane($: EngineInterface): void {
  paneOpen = false
  $.ui.close({ id: PANE_ID }).catch(err => log($, `pane close failed: ${err}`))
}

// the tickets filed under `id`. bw show's JSON names the parent on a child and nothing on the parent
// (its text view computes the list), so this is a second call. `bw list` reads the cwd's board only,
// where `bw show` goes through the registry: a ticket of another repo is listed with -C <its path>,
// when the registry names exactly one. jq keeps each child's description and comments out of the
// output; without jq the whole rows are read.
async function listChildren($: EngineInterface, id: string): Promise<Ticket[]> {
  const prefix = prefixOf(id, prefixes)
  let dir: string | undefined
  if (prefix !== defaultPrefix) {
    const paths = prefix === undefined ? [] : repoPaths[prefix] ?? []
    if (paths.length !== 1) return []
    dir = paths[0]
  }
  const slim = 'jq -c "[.[] | {id, title, status, priority, blocked_by}]"'
  try {
    let r = await $.process.run(
      dir === undefined
        ? ['sh', '-c', `bw list --parent "$1" --all --json | ${slim}`, 'sh', id]
        : ['sh', '-c', `bw -C "$2" list --parent "$1" --all --json | ${slim}`, 'sh', id, dir],
      { timeoutMs: SHOW_TIMEOUT_MS },
    )
    if (r.exitCode !== 0 || r.stdout.trim() === '')
      r = await $.process.run(['bw', ...(dir === undefined ? [] : ['-C', dir]), 'list', '--parent', id, '--all', '--json'], { timeoutMs: SHOW_TIMEOUT_MS })
    return r.exitCode === 0 ? parseChildren(r.stdout) : []
  } catch {
    return []
  }
}

async function fetch($: EngineInterface, id: string): Promise<void> {
  if (pending.has(id)) return
  pending.add(id)
  $.ui.invalidate('ui.render')
  const at = await $.clock.now()
  try {
    const r = await $.process.run(['bw', 'show', id, '--json'], { timeoutMs: SHOW_TIMEOUT_MS })
    const found = parseShow(id, r, at)
    lookups[id] = found
    if (found.kind === 'ticket') {
      // the ticket draws now; its children join it when the list answers (bw resolved a partial id,
      // so the list is asked by the ticket's own)
      $.ui.invalidate('ui.render')
      lookups[id] = { ...found, children: await listChildren($, found.ticket.id) }
    }
  } catch (err) {
    lookups[id] = { kind: 'error', id, message: `bw show ${id} failed: ${err}`, at }
  } finally {
    pending.delete(id)
    $.ui.invalidate('ui.render')
  }
}

// the pane on a ticket: opened if closed, fetched unless fresh, remembered
async function show($: EngineInterface, id: string, force = false): Promise<void> {
  await ensureReady($)
  if (current !== id) {
    descriptionExpanded = false
    childrenExpanded = false
    openComments = new Set()
  }
  current = id
  await openPane($)
  const have = lookups[id]
  if (force || have === undefined || (await $.clock.now()) - have.at >= FRESH_MS) await fetch($, id)
  noteLookup($, id)
}

async function submit($: EngineInterface, value: string): Promise<void> {
  await ensureReady($)
  const id = normalizeId(value, defaultPrefix)
  search = ''
  if (id === undefined) {
    $.ui.toast(value.trim() === '' ? 'type a ticket id first' : `“${value.trim()}” is not a ticket id`, { timeoutMs: 3000 })
    $.ui.invalidate('ui.render')
    return
  }
  await show($, id)
  // the redraw moves the ring off the field; put it back so the next id can be typed at once
  try {
    await $.ui.focus({ requestId: PANE_ID, key: 'search' })
  } catch (err) {
    log($, `focus failed: ${err}`)
  }
}

// a button's work runs past the press; a failure lands in the log, never as an unhandled rejection
function fire($: EngineInterface, what: string, p: Promise<unknown>): void {
  p.catch(err => {
    try {
      log($, `${what} failed: ${err}`)
    } catch {
      // the environment is gone (a reload or a session end); nothing left to tell
    }
  })
}

function actionsFor($: EngineInterface): Actions {
  return {
    open: id => fire($, `open ${id}`, show($, id)),
    submit: value => fire($, 'search', submit($, value)),
    input: value => {
      search = value
    },
    refresh: () => {
      if (current !== undefined) fire($, `refresh ${current}`, show($, current, true))
    },
    close: () => closePane($),
    toggleDescription: () => {
      descriptionExpanded = !descriptionExpanded
      $.ui.invalidate('ui.render')
    },
    toggleChildren: () => {
      childrenExpanded = !childrenExpanded
      $.ui.invalidate('ui.render')
    },
    toggleComment: i => {
      if (openComments.has(i)) openComments.delete(i)
      else openComments.add(i)
      $.ui.invalidate('ui.render')
    },
    forgetRecent: () => {
      recent = []
      $.store.delete(RECENT_KEY).catch(err => log($, `store delete failed: ${err}`))
      $.ui.invalidate('ui.render')
    },
  }
}

// the texts of a ticket the pane draws ids inside of
function proseOf(l: Lookup | undefined): string {
  if (l?.kind !== 'ticket') return ''
  const t = l.ticket
  return [t.description, t.closeReason ?? '', ...t.comments.map(c => c.text)].join('\n')
}

async function viewOf($: EngineInterface): Promise<View> {
  await ensureReady($)
  return {
    current,
    lookup: current === undefined ? undefined : lookups[current],
    pending: current !== undefined && pending.has(current),
    descriptionExpanded,
    childrenExpanded,
    openComments,
    recent,
    search,
    defaultPrefix,
    matcher,
    known: await knownFor($, proseOf(current === undefined ? undefined : lookups[current])),
    now: await $.clock.now(),
    collapsedRows,
    digestChars,
  }
}

function clampNumber(v: unknown, lo: number, hi: number, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : dflt
}

export const register: Register = (on, options) => {
  mentionButtons = options.mention_buttons !== false
  bareMentions = options.bare_mentions !== false
  mentionCap = clampNumber(options.mention_cap, 1, 20, 6)
  collapsedRows = clampNumber(options.collapsed_rows, 3, 40, 8)
  digestChars = clampNumber(options.digest_chars, 20, 200, 50)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await ensureReady($)
    await ensureCommand($)
    fire($, 'bw list', refreshHome($))
    return r
  })

  // a ticket made or removed through the Bash tool changes what a mention can mean: this board is
  // read again now, and another repo's (`bw -C <repo> create`) the next time a drawing names it
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    if (r.result !== undefined && /\bbw\s+(?:-C\s+\S+\s+)?(create|delete|import)\b/.test(e.command)) {
      await ensureReady($)
      boardAt.clear()
      fire($, 'bw list', refreshHome($))
    }
    return r
  })

  on('command.run', { command: 'bw' }, async ($, e, next) => {
    await ensureReady($)
    const args = e.args.trim()
    if (args === 'close') {
      closePane($)
      return {}
    }
    if (args === '') {
      await openPane($)
      return {}
    }
    const id = normalizeId(args, defaultPrefix)
    if (id === undefined) {
      $.ui.toast(`“${args}” is not a ticket id`, { timeoutMs: 3000 })
      return {}
    }
    await show($, id)
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE_ID) paneOpen = false
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    // the mobile table has no Input yet, so the search box cannot draw there
    if (e.surface === 'mobile') return next(e)
    paneOpen = true
    void ensureCommand($)
    const v = await viewOf($)
    const columns = Math.max(40, (e.props.bodyColumns ?? e.viewport?.columns ?? 100) - 1)
    return drawPane($.ui.resolve(e), v, columns, actionsFor($))
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!mentionButtons) return next(e)
    await ensureReady($)
    const ids = findMentions(e.props.text, matcher, await knownFor($, e.props.text))
    if (ids.length === 0) return next(e)
    const drawn = await next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {drawn}
        {drawMentions($.ui.resolve(e), ids, mentionCap, actionsFor($))}
      </Box>
    )
  })
}

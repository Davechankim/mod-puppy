import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { PupActivity, PupCall, PupEngine, PupPeer, PupPlace, PupReport } from '../types'
import { DOG_ROWS, drawScene, furthestX, targetX } from './dog'
import { clip, firstLine, formatModel, formatTokens, labelOfCall, lastParts, statusWord } from './words'

const TOOL = 'mcp__session-pup__progress'
const RASTER = 'pup'
const FRAME_MS = 125
const REFRESH_MS = 5000
const IDLE_PROMPT_MS = 30_000
const MISSED_FRAMES = 8

// Where a prompt comes from when the person typed it: the terminal's prompt
// box, a remote client, or the host app's.
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

const report = atom({ plugin: 'session-pup', key: 'report' } as const, null)
const place = atom({ plugin: 'session-pup', key: 'place' } as const, {
  name: '',
  folder: '',
  branch: null,
  peers: [],
})
const engine = atom({ plugin: 'session-pup', key: 'engine' } as const, {
  model: null,
  effort: null,
  contextPercent: null,
  contextTokens: null,
  contextWindow: null,
})
const activity = atom({ plugin: 'session-pup', key: 'activity' } as const, {
  prompt: '',
  running: [],
  agents: [],
})
const working = atom({ plugin: 'session-pup', key: 'working' } as const, false)

const DESCRIPTION =
  'Shows the person, in the status band above the prompt, what you are working on and how far along it is. ' +
  'Call it when you start a task of several steps and again each time one of its steps is done. It changes nothing else. ' +
  'Only the main conversation calls this; a subagent, workflow agent, fork or teammate never does.'

const SCHEMA = {
  type: 'object',
  properties: {
    main: { type: 'string', description: 'The whole task, in a few words.' },
    sub: { type: 'string', description: 'The step you are on now, in a few words.' },
    percent: {
      type: 'integer',
      minimum: 0,
      maximum: 100,
      description: 'Your honest estimate of how much of the whole task is done; 100 once it is done.',
    },
  },
  required: ['main', 'sub', 'percent'],
}

const GUIDE = [
  'The person watches a status band above the prompt (the session-pup mod) to see what this session is doing.',
  `When you start a task of several steps, and again each time one of its steps is done, call ${TOOL}:`,
  'main is the whole task, sub the step you are on now, percent your honest estimate (0-100) of how much of the whole task is done, 100 once it is done.',
  'Write main and sub in the language the person writes to you, under 30 characters each.',
  'Skip it for a reply that needs no tools, only the main conversation calls it, and never mention it in your reply.',
].join(' ')

type Engine = EngineInterface
type Tone = 'dim' | 'name' | 'good'
type Part = { text: string; tone?: Tone }

// The puppy's pace and what the last band drawn said live in the module:
// a reload starts them over, and the next band drawn or step taken resumes.
const run = {
  bandId: undefined as string | undefined,
  columns: 0,
  frame: 0,
  dogX: 0,
  isFacingLeft: false,
  isWorking: false,
  percent: null as number | null,
  hasTrack: false,
  bandWorking: undefined as boolean | undefined,
  missed: 0,
  ticker: undefined as Timer | undefined,
  isPainting: false,
  isRefreshing: false,
  sessionId: undefined as string | undefined,
  pending: undefined as { label: string; until: number } | undefined,
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (e.isInteractive) {
      try {
        await $.tool.register({ name: 'progress', description: DESCRIPTION, inputSchema: SCHEMA, isDeferred: false })
      } catch (error) {
        $.ui.log(`session-pup: progress tool not registered: ${String(error)}`, { to: 'debug' })
      }
    }
    const started = await next(e)
    await refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    if (await read($, working)) startRunning($)

    return started
  })

  // A /clear or /resume ends this conversation without a new session.start:
  // the band forgets its work, and the next refresh reads the new one.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await forget($)
      run.sessionId = undefined
      $.clock.after(1000, () => void refresh($))
    }

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(TOOL) || e.surfaces.length === 0 || e.traits.includes('teammate')) return composed

    return {
      sections: [...composed.sections, { id: 'session-pup:progress', text: GUIDE, scope: 'session' as const }],
    }
  })

  // The person's own request becomes the band's main work when its turn
  // starts; a note typed into a running turn is part of that turn's work.
  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    const isPersons = e.isMeta !== true && PERSON_ORIGINS.has(e.origin.kind)
    const isOwnTurn = e.turnId === undefined || e.wait
    if (entered.drop === undefined && isPersons && isOwnTurn) {
      const label =
        e.command === undefined ? clip(firstLine(e.text), 60) : clip(`/${e.command.name} ${e.command.args}`, 60)
      if (label !== '') {
        const now = await $.clock.now()
        run.pending = { label, until: e.turnId === undefined ? now + IDLE_PROMPT_MS : Number.POSITIVE_INFINITY }
      }
    }

    return entered
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId === undefined) {
      await update($, working, () => true)
      const pending = run.pending
      if (e.text.trim() !== '' && pending !== undefined) {
        run.pending = undefined
        if ((await $.clock.now()) <= pending.until) {
          await update($, activity, now => ({ ...now, prompt: pending.label }))
          await update($, report, () => null)
        }
      }
      startRunning($)
    }

    return started
  })

  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    if (e.agentId === undefined) {
      await update($, working, () => false)
      stopRunning($)
      void refresh($)
    }

    return ended
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const effort = e.effort === undefined ? null : String(e.effort)
      const now = await read($, engine)
      if (now.model !== e.model || now.effort !== effort) {
        await update($, engine, value => ({ ...value, model: e.model, effort }))
      }
      startRunning($)
    }

    return yield* next(e)
  })

  // An idle /model switch: show the new model and its saved effort before
  // its first request reports them.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const saved = await savedModel($, e.to_model)
    await update($, engine, value => ({ ...value, model: saved.model, effort: saved.effort }))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { result: 'You are not the main conversation: do not call this tool again.' }
    }
    const input = e as unknown as Record<string, unknown>
    const said: PupReport = {
      main: clip(typeof input.main === 'string' ? input.main : '', 40),
      sub: clip(typeof input.sub === 'string' ? input.sub : '', 60),
      percent: toPercent(input.percent),
      at: await $.clock.now(),
    }
    await update($, report, () => said)

    return { result: 'ok' }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || e.tool === TOOL) return next(e)
    const call: PupCall = {
      id: e.tool_use_id ?? `${e.tool}:${await $.clock.now()}`,
      label: labelOfCall(e.tool, e as unknown as Record<string, unknown>),
    }
    await update($, activity, now => ({ ...now, running: [...now.running, call].slice(-8) }))
    try {
      return await next(e)
    } finally {
      await update($, activity, now => ({ ...now, running: now.running.filter(one => one.id !== call.id) }))
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [said, where, used, doing] = await Promise.all([
      read($, report),
      read($, place),
      read($, engine),
      read($, activity),
    ])
    const isWorking = e.props.isWorking
    const percent = said?.percent ?? null
    const lines = describe(said, where, used, doing, isWorking)
    const width = e.props.bodyColumns
    const maxRows = e.props.maxRows
    run.percent = percent
    run.bandWorking = isWorking

    if (e.surface === 'terminal') {
      const { Box, Raster, Text } = $.ui.resolve(e)
      const isWide = width >= 96
      const hasRoom = isWide ? maxRows >= Math.max(DOG_ROWS, lines.length) : maxRows >= DOG_ROWS + lines.length
      const info = (
        <Box flexDirection="column" flexGrow={1} flexShrink={1} marginLeft={isWide && hasRoom ? 2 : 0}>
          {lines.map(parts => (
            <Text wrap="truncate-end">
              {parts.map(part => (
                <Text
                  dimColor={part.tone === 'dim'}
                  bold={part.tone === 'name' || part.tone === 'good'}
                  color={toneColor(part.tone)}
                >
                  {part.text}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
      )

      if (!hasRoom) {
        run.hasTrack = false

        return maxRows > lines.length ? (
          <Box flexDirection="column">
            {info}
            <Text dimColor>{textTrack(percent, isWorking)}</Text>
          </Box>
        ) : (
          info
        )
      }

      const columns = isWide ? within(Math.floor(width * 0.36), 30, 56) : within(width, 24, 56)
      run.dogX = run.columns === 0 ? targetX(columns, percent) : Math.min(run.dogX, furthestX(columns))
      run.bandId = e.requestId
      run.columns = columns
      run.hasTrack = true
      const cells = drawScene({
        columns,
        frame: run.frame,
        dogX: run.dogX,
        isFacingLeft: isWorking && run.isFacingLeft,
        isWorking,
        percent,
      })
      const track = <Raster key={RASTER} columns={columns} rows={DOG_ROWS} cells={cells} />

      return isWide ? (
        <Box flexDirection="row">
          {track}
          {info}
        </Box>
      ) : (
        <Box flexDirection="column">
          {info}
          {track}
        </Box>
      )
    }

    run.hasTrack = false
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {lines.map(parts => (
          <Text>{parts.map(part => part.text).join('')}</Text>
        ))}
        <Text dimColor>{textTrack(percent, isWorking)}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'ToolUse', props: { tool: TOOL } }, async ($, e, next) => {
    if (e.props.isExpanded === true) return next(e)
    const input = (e.props.input ?? {}) as Record<string, unknown>
    const percent = toPercent(input.percent)
    const sub = typeof input.sub === 'string' ? clip(input.sub, 40) : ''
    const { Text } = $.ui.resolve(e)

    return (
      <Text dimColor>
        🐾 진행 {percent === null ? '—' : `${percent}%`}
        {sub === '' ? '' : ` · ${sub}`}
      </Text>
    )
  })
}

function describe(
  said: PupReport | null,
  where: PupPlace,
  used: PupEngine,
  doing: PupActivity,
  isWorking: boolean,
): Part[][] {
  const spot = [where.folder, where.branch].filter(part => part !== null && part !== '').join(' · ')
  const peers =
    where.peers.length === 0
      ? ''
      : ` · 같은 작업공간: ${where.peers.map(peer => `${peer.name}(${statusWord(peer.status)})`).join(' · ')}`
  const main = said?.main || doing.prompt || '아직 요청이 없습니다'
  const now = doing.running.at(-1)?.label
  const helpers =
    doing.agents.length === 0 ? '' : `에이전트 ${doing.agents.length}개 (${doing.agents.slice(0, 2).join(', ')})`
  const sub =
    [said?.sub ?? '', now ?? '', helpers].filter(part => part !== '').join(' · ') ||
    (isWorking ? '생각 중' : '쉬는 중')
  const context =
    used.contextPercent === null
      ? '컨텍스트 —'
      : `컨텍스트 ${used.contextPercent}%` +
        (used.contextTokens !== null && used.contextWindow !== null
          ? ` (${formatTokens(used.contextTokens)}/${formatTokens(used.contextWindow)})`
          : '')
  const percent = said?.percent ?? null

  return [
    [
      { text: '🐾 ' },
      { text: where.name || '세션 이름 확인 중', tone: 'name' },
      { text: spot === '' ? '' : ` · ${spot}`, tone: 'dim' },
      { text: peers, tone: 'dim' },
    ],
    [{ text: '메인 ▸ ', tone: 'dim' }, { text: main }],
    [{ text: '서브 ▸ ', tone: 'dim' }, { text: sub }],
    [
      { text: percent === null ? '진행 —' : `진행 ${percent}%`, tone: percent === 100 ? 'good' : undefined },
      { text: ` · ${formatModel(used.model)} · Effort ${used.effort ?? '—'} · ${context}`, tone: 'dim' },
    ],
  ]
}

function toneColor(tone: Tone | undefined): 'claude' | 'success' | undefined {
  if (tone === 'name') return 'claude'
  if (tone === 'good') return 'success'

  return undefined
}

function textTrack(percent: number | null, isWorking: boolean): string {
  if (percent === null) return isWorking ? '🐶 달리는 중…' : '🐶 쉬는 중'
  const filled = Math.round(percent / 10)

  return `🐶 ${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${percent}%`
}

function toPercent(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number)) return null

  return within(Math.round(number), 0, 100)
}

function within(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function startRunning($: Engine) {
  run.isWorking = true
  if (run.ticker !== undefined) return
  run.missed = 0
  run.ticker = $.clock.every(FRAME_MS, () => void tick($))
}

function stopRunning($: Engine) {
  run.isWorking = false
  run.isFacingLeft = false
  stopTicker()
  void paint($)
}

function stopTicker() {
  run.ticker?.cancel()
  run.ticker = undefined
}

// A frame of the run. With no track drawn, a band that says the turn is
// over, or a refused blit for a second running, the ticker stops; the next
// step of a turn starts it again.
async function tick($: Engine) {
  if (!run.hasTrack || run.bandWorking === false) {
    run.missed += 1
    if (run.missed > MISSED_FRAMES) stopTicker()

    return
  }
  run.frame += 1
  const target = targetX(run.columns, run.percent)
  if (run.dogX < target) {
    run.dogX += 1
    run.isFacingLeft = false
  } else if (run.dogX > target) {
    run.dogX -= 1
    run.isFacingLeft = true
  } else {
    run.isFacingLeft = false
  }
  const isShown = await paint($)
  run.missed = isShown ? 0 : run.missed + 1
  if (run.missed > MISSED_FRAMES) stopTicker()
}

async function paint($: Engine): Promise<boolean> {
  if (run.bandId === undefined || run.columns === 0 || !run.hasTrack || run.isPainting) return false
  run.isPainting = true
  try {
    const painted = await $.ui.blit({
      requestId: run.bandId,
      key: RASTER,
      columns: run.columns,
      rows: DOG_ROWS,
      cells: drawScene({
        columns: run.columns,
        frame: run.frame,
        dogX: run.dogX,
        isFacingLeft: run.isWorking && run.isFacingLeft,
        isWorking: run.isWorking,
        percent: run.percent,
      }),
    })

    return painted.deny === undefined
  } catch {
    return false
  } finally {
    run.isPainting = false
  }
}

// What the band starts from: the model and its saved effort before the first
// request reports them, and the person's latest prompt after a reload.
async function seed($: Engine) {
  try {
    const now = await read($, engine)
    if (now.model === null || now.effort === null) {
      const saved = await savedModel($, now.model)
      await update($, engine, value => ({
        ...value,
        model: value.model ?? saved.model,
        effort: value.effort ?? saved.effort,
      }))
    }
    const doing = await read($, activity)
    if (doing.prompt === '') {
      const messages = await $.session.messages()
      const last = [...messages]
        .reverse()
        .find(
          message =>
            message.role === 'user' &&
            (message.toolResults?.length ?? 0) === 0 &&
            message.text.trim() !== '' &&
            !message.text.trimStart().startsWith('<'),
        )
      if (last !== undefined) await update($, activity, value => ({ ...value, prompt: clip(firstLine(last.text), 60) }))
    }
  } catch (error) {
    $.ui.log(`session-pup: start-up read failed: ${String(error)}`, { to: 'debug' })
  }
}

// The model as /model names it, resolved to its full id where the settings
// know it, and the effort saved for it: settings keep effort per model under
// `modelSettings`, an older file at the top level.
async function savedModel($: Engine, known: string | null): Promise<{ model: string | null; effort: string | null }> {
  const shown = known ?? (await $.session.model())
  const perModel = await $.settings.read({ key: 'modelSettings' })
  const ids = isRecord(perModel) && shown !== '' ? Object.keys(perModel).sort().reverse() : []
  const lower = shown.toLowerCase()
  const id =
    ids.find(one => one === shown) ??
    ids.find(one => lower.includes(one.toLowerCase())) ??
    ids.find(one => one.toLowerCase().includes(lower))
  const entry = id !== undefined && isRecord(perModel) ? perModel[id] : undefined
  if (isRecord(entry) && typeof entry.effortLevel === 'string') return { model: id ?? shown, effort: entry.effortLevel }
  const top = await $.settings.read({ key: 'effortLevel' })

  return { model: id ?? shown, effort: typeof top === 'string' ? top : null }
}

async function forget($: Engine) {
  run.pending = undefined
  await update($, report, () => null)
  await update($, activity, () => ({ prompt: '', running: [], agents: [] }))
  await update($, engine, value => ({ ...value, model: null, effort: null }))
}

async function refresh($: Engine) {
  if (run.isRefreshing) return
  run.isRefreshing = true
  try {
    const id = await $.session.id()
    if (id !== run.sessionId) {
      const isSwitch = run.sessionId !== undefined
      run.sessionId = id
      if (isSwitch) await forget($)
      await seed($)
    }
    const [where, usage, agents] = await Promise.all([readPlace($, id), $.session.usage(), $.agent.list()])
    const contextPercent = usage.context.percent ?? null
    const contextTokens = usage.context.tokens ?? null
    const contextWindow = usage.context.window > 0 ? usage.context.window : null
    const used = await read($, engine)
    if (
      used.contextPercent !== contextPercent ||
      used.contextTokens !== contextTokens ||
      used.contextWindow !== contextWindow
    ) {
      await update($, engine, value => ({ ...value, contextPercent, contextTokens, contextWindow }))
    }
    if (!same(await read($, place), where)) await update($, place, () => where)
    const helpers = agents
      .filter(agent => agent.status === 'running' || agent.status === 'pending')
      .map(agent => clip(agent.description || agent.type, 24))
    if (!same((await read($, activity)).agents, helpers)) await update($, activity, value => ({ ...value, agents: helpers }))
  } catch (error) {
    $.ui.log(`session-pup: refresh failed: ${String(error)}`, { to: 'debug' })
  } finally {
    run.isRefreshing = false
  }
}

// This session's name and its neighbours, from the registry every local
// session keeps at ~/.claude/sessions/<pid>.json; the key files there are
// never read.
async function readPlace($: Engine, id: string): Promise<PupPlace> {
  const [root, home] = await Promise.all([$.session.root(), $.env.get('HOME')])
  const sessions = home === undefined ? [] : await readSessions($, `${home}/.claude/sessions`)
  const me = sessions.find(one => one.sessionId === id)
  const folder = me?.cwd ?? root
  const peers: PupPeer[] = sessions
    .filter(one => one.sessionId !== id && one.cwd === folder)
    .map(one => ({ name: one.name, status: one.status }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return { name: me?.name ?? '', folder: lastParts(folder, 2), branch: await readBranch($, root), peers }
}

type Registered = { sessionId: string; cwd: string; name: string; status: string }

async function readSessions($: Engine, dir: string): Promise<Registered[]> {
  let entries: Awaited<ReturnType<Engine['fs']['list']>> = []
  try {
    entries = await $.fs.list(dir)
  } catch {
    return []
  }
  const files = entries.filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
  const rows = await Promise.all(
    files.map(async entry => {
      try {
        const raw: unknown = JSON.parse(await $.fs.read(`${dir}/${entry.name}`))
        if (!isRecord(raw) || typeof raw.sessionId !== 'string' || typeof raw.cwd !== 'string') return undefined

        return {
          sessionId: raw.sessionId,
          cwd: raw.cwd,
          name: typeof raw.name === 'string' ? raw.name : '',
          status: typeof raw.status === 'string' ? raw.status : '',
        }
      } catch {
        return undefined
      }
    }),
  )

  return rows.filter((row): row is Registered => row !== undefined)
}

// The checked-out branch, read from git's HEAD; a worktree's `.git` is a
// file naming its folder in the main repository.
async function readBranch($: Engine, root: string): Promise<string | null> {
  try {
    const dotGit = `${root}/.git`
    let gitDir = dotGit
    if ((await $.fs.stat(dotGit)).kind === 'file') {
      const named = /^gitdir:\s*(.+)$/m.exec(await $.fs.read(dotGit))
      if (named?.[1] === undefined) return null
      gitDir = named[1].trim().startsWith('/') ? named[1].trim() : `${root}/${named[1].trim()}`
    }
    const head = (await $.fs.read(`${gitDir}/HEAD`)).trim()
    const branch = /^ref:\s*refs\/heads\/(.+)$/.exec(head)

    return branch?.[1] ?? head.slice(0, 7)
  } catch {
    return null
  }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

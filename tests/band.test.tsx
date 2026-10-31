import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__session-pup__progress'
const HOME = '/home/pup'
const ROOT = '/work/shop/otter'
const SESSIONS = `${HOME}/.claude/sessions`

const BAND = {
  plugin: 'session-pup',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const FILES: Record<string, string> = {
  [`${SESSIONS}/1.json`]: JSON.stringify({ sessionId: 'me', cwd: ROOT, name: 'otter-1a', status: 'busy' }),
  [`${SESSIONS}/2.json`]: JSON.stringify({ sessionId: 'peer', cwd: ROOT, name: 'otter-2b', status: 'idle' }),
  [`${SESSIONS}/3.json`]: JSON.stringify({ sessionId: 'far', cwd: '/elsewhere', name: 'seal-7', status: 'busy' }),
  [`${ROOT}/.git`]: 'gitdir: /work/shop/.git/worktrees/otter\n',
  ['/work/shop/.git/worktrees/otter/HEAD']: 'ref: refs/heads/feature/login\n',
}

// Effort is kept per model, as this machine's settings keep it.
const SETTINGS = {
  model: 'opus',
  modelSettings: {
    'claude-opus-4-7': { effortLevel: 'low' },
    'claude-opus-5-5': { effortLevel: 'high' },
  },
}

// The engine beneath the plugin, answering every `$` call the band makes.
function world(on: On, read: string[], settings: Record<string, unknown> = SETTINGS) {
  mock.clock(on)
  mock.env(on, { HOME })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('session.id', () => ({ value: 'me' }))
  on('session.root', () => ({ value: ROOT }))
  on('session.model', () => ({ value: 'opus' }))
  on('settings.read', () => ({ value: settings }))
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('ui.blit', () => ({ value: {} }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 230_000, window: 1_000_000, percent: 23 }, rateLimits: [] },
  }))
  on('fs.list', () => ({
    value: ['1.json', '2.json', '3.json', '1.secret.key'].map(name => ({
      name,
      kind: 'file' as const,
      size: 10,
      mtimeMs: 0,
      isLink: false,
    })),
  }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 10, mtimeMs: 0, isLink: false } }))
  on('fs.read', (_, e) => {
    read.push(e.path)
    const text = FILES[e.path]
    if (text === undefined) throw new Error(`no file ${e.path}`)

    return { value: text }
  })
}

async function linesOf(ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) {
  return (await ui.findAll({ type: 'Text' })).map(found => found.text)
}

test('the band shows the session, its work, the model and the progress', async ($, on) => {
  const read: string[] = []
  world(on, read)

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, main: '모드 만들기', sub: '띠 그리기', percent: 40 })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const text = (await linesOf(ui)).join('\n')

  expect(text).toContain('otter-1a')
  expect(text).toContain('shop/otter')
  expect(text).toContain('feature/login')
  expect(text).toContain('otter-2b(쉼)')
  expect(text).not.toContain('seal-7')
  expect(text).toContain('모드 만들기')
  expect(text).toContain('띠 그리기')
  expect(text).toContain('진행 40% · Opus 5.5 · Effort high · 컨텍스트 23% (230k/1M)')

  const track = await ui.find({ type: 'Raster' })
  expect(track?.props.rows).toBe(4)
  const columns = Number(track?.props.columns)
  expect(String(track?.props.cells).length).toBe(Math.ceil((columns * 4 * 12) / 3) * 4)

  expect(read.some(path => path.endsWith('.key'))).toBe(false)
  await ui.unmount()
})

test('with no effort saved anywhere the band says so', async ($, on) => {
  world(on, [], { model: 'opus' })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await linesOf(ui)).join('\n')).toContain('Effort —')
  await ui.unmount()
})

test('narrow bands stack, short ones trade the puppy for a line, a desktop draws words', async ($, on) => {
  world(on, [])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const narrow = await $.ui.mount({
    ...BAND,
    surface: 'terminal',
    props: { ...BAND.props, bodyColumns: 70, isWorking: false },
  })
  expect(await narrow.find({ type: 'Raster' })).toBeDefined()
  expect((await linesOf(narrow)).join('\n')).toContain('진행 —')
  await narrow.unmount()

  const short = await $.ui.mount({
    ...BAND,
    surface: 'terminal',
    props: { ...BAND.props, bodyColumns: 70, maxRows: 6 },
  })
  expect(await short.find({ type: 'Raster' })).toBeUndefined()
  expect((await linesOf(short)).join('\n')).toContain('🐶')
  await short.unmount()

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await desktop.find({ type: 'Raster' })).toBeUndefined()
  expect((await linesOf(desktop)).join('\n')).toContain('🐶')
  await desktop.unmount()
})

test('the percentage leads its line, so a narrow band cuts the context first', async ($, on) => {
  world(on, [])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, main: '모드 만들기', sub: '띠 그리기', percent: 100 })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const last = (await linesOf(ui)).find(line => line.includes('Effort'))
  expect(last?.startsWith('진행 100%')).toBe(true)
  await ui.unmount()
})

test('a subagent is told once not to report', async ($, on) => {
  world(on, [])
  const answered = await $.tool.call({ tool: TOOL, main: 'x', sub: 'y', percent: 5, agentId: 'helper' })
  expect(String(answered.result)).toContain('do not call this tool again')
})

test('the guide reaches only a drawn main conversation that has the tool', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const base = { model: 'm', promptModel: 'm', outputStyle: null }
  const ids = async (args: Parameters<typeof $.prompt.compose>[0]) =>
    (await $.prompt.compose(args)).sections.map(section => section.id)

  expect(await ids({ ...base, surfaces: ['terminal'], tools: [TOOL], traits: [] })).toContain('session-pup:progress')
  expect(await ids({ ...base, surfaces: [], tools: [TOOL], traits: [] })).not.toContain('session-pup:progress')
  expect(await ids({ ...base, surfaces: ['terminal'], tools: [TOOL], traits: ['teammate'] })).not.toContain(
    'session-pup:progress',
  )
  expect(await ids({ ...base, surfaces: ['terminal'], tools: [], traits: [] })).not.toContain('session-pup:progress')
})

test('the progress call draws as one short row', async ($, on) => {
  world(on, [])
  const row = await $.ui.mount({
    plugin: 'session-pup',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'call-1',
    props: {
      tool_use_id: 'call-1',
      tool: TOOL,
      input: { main: '모드 만들기', sub: '띠 그리기', percent: 40 },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
  })

  expect((await linesOf(row)).join('\n')).toContain('진행 40% · 띠 그리기')
  await row.unmount()
})

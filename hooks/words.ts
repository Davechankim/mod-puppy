// How the band words things: model names, token counts, tool calls, peers.

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = [...flat]

  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`
}

export function firstLine(text: string): string {
  return (text.split('\n').find(line => line.trim() !== '') ?? '').trim()
}

// `claude-opus-5-5` → `Opus 5.5`; anything else is shown as given.
export function formatModel(id: string | null): string {
  if (id === null || id === '') return '모델 확인 중'
  const found = /(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(id)
  if (found === null) return id
  const [, family = '', major = '', minor] = found
  const name = family.charAt(0).toUpperCase() + family.slice(1).toLowerCase()

  return minor === undefined ? `${name} ${major}` : `${name} ${major}.${minor}`
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (count >= 1000) return `${Math.round(count / 1000)}k`

  return String(count)
}

export function statusWord(status: string): string {
  if (status === 'busy') return '작업 중'
  if (status === 'waiting') return '답 기다림'
  if (status === 'idle') return '쉼'

  return status
}

export function peerMark(status: string): string {
  if (status === 'busy') return '●'
  if (status === 'waiting') return '◐'

  return '○'
}

export function lastParts(path: string, count: number): string {
  return path.split('/').filter(Boolean).slice(-count).join('/')
}

// A few words for a tool call of the main conversation.
export function labelOfCall(tool: string, input: Record<string, unknown>): string {
  const field = (name: string) => {
    const value = input[name]
    return typeof value === 'string' ? value : ''
  }
  const file = () => lastParts(field('file_path'), 1)

  switch (tool) {
    case 'Bash':
      return clip(field('description') || firstLine(field('command')), 40)
    case 'Read':
      return `읽기 ${file()}`
    case 'Edit':
      return `고치기 ${file()}`
    case 'Write':
      return `쓰기 ${file()}`
    case 'Agent':
      return clip(`에이전트: ${field('description')}`, 40)
    case 'Workflow': {
      const named = /name:\s*['"]([^'"]+)['"]/.exec(field('script'))
      return clip(`워크플로: ${named?.[1] ?? (field('name') || '실행')}`, 40)
    }
    case 'Skill':
      return `스킬: ${field('skill')}`
    case 'ToolSearch':
      return '도구 찾기'
    case 'WebSearch':
      return clip(`웹 검색: ${field('query')}`, 40)
    case 'AskUserQuestion':
      return '질문하고 답 기다림'
    case 'Monitor':
      return '지켜보는 중'
    default: {
      if (!tool.startsWith('mcp__')) return tool
      const [, server = '', name = ''] = tool.split('__')
      return clip(`${name} (${server})`, 40)
    }
  }
}

// What the model last said it is doing, through the mod's progress tool.
export type PupReport = {
  main: string
  sub: string
  percent: number | null
  at: number
}

export type PupPeer = { name: string; status: string }

// Where this session runs, read from the local session registry and git.
export type PupPlace = {
  name: string
  folder: string
  branch: string | null
  peers: PupPeer[]
}

export type PupEngine = {
  model: string | null
  effort: string | null
  contextPercent: number | null
  contextTokens: number | null
  contextWindow: number | null
}

export type PupCall = { id: string; label: string }

export type PupActivity = {
  prompt: string
  running: PupCall[]
  agents: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-pup': {
      report: PupReport | null
      place: PupPlace
      engine: PupEngine
      activity: PupActivity
      working: boolean
    }
  }
}

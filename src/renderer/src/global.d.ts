import type { CopilotApi } from '../../shared/protocol'

declare global {
  interface Window {
    copilot: CopilotApi
  }
}

export {}

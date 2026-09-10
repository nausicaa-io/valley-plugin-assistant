import { brokerFetch } from '../../network'
import { chat } from './chat'
import { models } from './models'
import { status } from './status'

const provider = {
  id: 'ollama',
  label: 'Ollama (local)',
  defaultBaseUrl: 'http://localhost:11434',
  requiresKey: false,
  defaultModels: models,
  async listModels(context: any) {
    try {
      const response = await brokerFetch(`${context.baseUrl.replace(/\/$/, '')}/api/tags`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = (await response.json()) as any
      const live = (json.models ?? [])
        .map((model: any) => model.model ?? model.name)
        .filter(Boolean)
        .map((id: string) => ({ provider: 'ollama', id, tools: true }))
      return live.length ? live : models
    } catch (error) {
      if (context.strict) throw error
      return models
    }
  },
  getStatus: status,
  chat
}

export function register(_api: unknown) {
  return provider
}

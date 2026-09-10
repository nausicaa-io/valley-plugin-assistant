import { t } from '../../../runtime'
import { brokerFetch } from '../../network'
import { chat } from './chat'
import { models } from './models'

const provider = {
  id: 'gemini',
  label: 'Google Gemini',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  requiresKey: true,
  envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  defaultModels: models,
  async listModels(context: any) {
    if (!context.credentialHandle) {
      if (context.strict) throw new Error(t('assistant.backend.missingKey'))
      return models
    }
    try {
      const response = await brokerFetch(`${context.baseUrl.replace(/\/$/, '')}/models`, {
        credential: { handle: context.credentialHandle, placement: 'header', name: 'x-goog-api-key' }
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = (await response.json()) as any
      const live = (json.models ?? [])
        .filter((model: any) => model.supportedGenerationMethods?.includes('generateContent'))
        .map((model: any) => String(model.name || '').replace(/^models\//, ''))
        .filter(Boolean)
        .map((id: string) => ({ provider: 'gemini', id, tools: true }))
      return live.length ? live : models
    } catch (error) {
      if (context.strict) throw error
      return models
    }
  },
  chat
}

export function register(_api: unknown) {
  return provider
}

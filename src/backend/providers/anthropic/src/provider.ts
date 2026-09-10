import { t } from '../../../runtime'
import { brokerFetch } from '../../network'
import { chat } from './chat'
import { models } from './models'

const provider = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  defaultBaseUrl: 'https://api.anthropic.com/v1',
  requiresKey: true,
  envKeys: ['ANTHROPIC_API_KEY'],
  defaultModels: models,
  async listModels(context: any) {
    if (context.strict) {
      if (!context.credentialHandle) throw new Error(t('assistant.backend.missingKey'))
      const response = await brokerFetch(`${context.baseUrl.replace(/\/$/, '')}/models`, {
        headers: { 'anthropic-version': '2023-06-01' }, credential: { handle: context.credentialHandle, placement: 'header', name: 'x-api-key' }
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${context.baseUrl}/models`)
    }
    return models
  },
  chat
}

export function register(_api: unknown) {
  return provider
}

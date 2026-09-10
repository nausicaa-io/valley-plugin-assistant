import { createOpenAiCompatibleProvider } from '../../shared'
import { models } from './models'

export function createChatProvider() {
  return createOpenAiCompatibleProvider({
    id: 'xai',
    label: 'xAI (Grok)',
    defaultBaseUrl: 'https://api.x.ai/v1',
    envKeys: ['XAI_API_KEY', 'GROK_API_KEY'],
    defaultModels: models
  })
}

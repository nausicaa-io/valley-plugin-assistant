import { createOpenAiCompatibleProvider } from '../../shared'
import { models } from './models'

export function createChatProvider() {
  return createOpenAiCompatibleProvider({
    id: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    envKeys: ['OPENAI_API_KEY'],
    defaultModels: models
  })
}

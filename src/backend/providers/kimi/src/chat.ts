import { createOpenAiCompatibleProvider } from '../../shared'
import { getBalance } from './balance'
import { models } from './models'

export function createChatProvider() {
  return createOpenAiCompatibleProvider({
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    envKeys: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
    defaultModels: models,
    getBalance
  })
}

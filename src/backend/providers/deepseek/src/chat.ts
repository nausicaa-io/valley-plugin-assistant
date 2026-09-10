import { createOpenAiCompatibleProvider } from '../../shared'
import { getBalance } from './balance'
import { models } from './models'

export function createChatProvider() {
  return createOpenAiCompatibleProvider({
    id: 'deepseek',
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    envKeys: ['DEEPSEEK_API_KEY'],
    defaultModels: models,
    getBalance
  })
}

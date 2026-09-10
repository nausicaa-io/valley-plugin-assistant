import { createChatProvider } from './chat'

export function register(_api: unknown) {
  return createChatProvider()
}

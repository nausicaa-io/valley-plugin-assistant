import { createChatProvider } from './chat'
import { transcribeAudio } from './transcription'

export function register(_api: unknown) {
  return { ...createChatProvider(), transcribeAudio }
}

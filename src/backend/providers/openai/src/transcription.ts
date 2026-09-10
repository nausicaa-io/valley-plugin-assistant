import { t } from '../../../runtime'
import { brokerFetch } from '../../network'
export async function transcribeAudio(input: {
  credentialHandle: string
  baseUrl: string
  bytes: Uint8Array
  fileName: string
  model?: string
}): Promise<string> {
  const form = new FormData()
  form.append('model', input.model || 'whisper-1')
  form.append('file', new Blob([new Uint8Array(input.bytes)]), input.fileName || 'audio.ogg')
  const response = await brokerFetch(`${input.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
    method: 'POST',
    credential: { handle: input.credentialHandle, placement: 'header', name: 'authorization', prefix: 'Bearer ' },
    body: form
  })
  if (!response.ok) throw new Error(t('assistant.backend.operationFailed', { operation: 'OpenAI', status: response.status }))
  const json = (await response.json()) as { text?: string }
  return (json.text ?? '').trim()
}

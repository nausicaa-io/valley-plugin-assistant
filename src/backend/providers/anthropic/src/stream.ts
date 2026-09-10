import { t } from '../../../runtime'
import { providerSafeJson, providerStreamLines, ProviderToolCallAccumulator } from '../../shared'

export async function readAnthropicStream(body: ReadableStream<Uint8Array> | null, emit: (event: any) => void) {
  const calls = new ProviderToolCallAccumulator()
  let finishReason: string | undefined
  for await (const line of providerStreamLines(body)) {
    if (!line.startsWith('data:')) continue
    const event = providerSafeJson<any>(line.slice(5).trim(), {})
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      calls.push(event.index ?? 0, '', event.content_block.id, event.content_block.name)
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
      emit({ type: 'text', text: event.delta.text })
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
      calls.push(event.index ?? 0, event.delta.partial_json ?? '')
    } else if (event.type === 'message_start' && event.message?.usage) {
      emit({ type: 'usage', inputTokens: event.message.usage.input_tokens })
    } else if (event.type === 'message_delta') {
      finishReason = event.delta?.stop_reason ?? finishReason
      if (event.usage?.output_tokens) emit({ type: 'usage', outputTokens: event.usage.output_tokens })
    } else if (event.type === 'error') {
      throw new Error(event.error?.message || t('assistant.backend.providerStream'))
    }
  }
  for (const call of calls.finishAll()) emit({ type: 'tool_call', call })
  emit({ type: 'done', finishReason })
}

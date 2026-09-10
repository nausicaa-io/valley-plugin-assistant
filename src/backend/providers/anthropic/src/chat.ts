import { brokerFetch } from '../../network'
import type { AiMessage } from '../../../../types'
import { splitProviderSystem } from '../../shared'
import { readAnthropicStream } from './stream'
import { encodeTools } from './tools'

function encodeMessages(messages: AiMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: [
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...message.toolCalls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {} }))
        ]
      }
    }
    if (message.role === 'tool') {
      return { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: message.content }] }
    }
    if (message.role === 'user' && message.attachments?.length) {
      const content = message.attachments.map((attachment) => attachment.mime === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: attachment.mime, data: attachment.dataBase64 } }
        : { type: 'image', source: { type: 'base64', media_type: attachment.mime, data: attachment.dataBase64 } })
      if (message.content) content.push({ type: 'text', text: message.content } as any)
      return { role: 'user', content }
    }
    return { role: message.role, content: message.content }
  })
}

export async function chat(request: any, context: any, emit: (event: any) => void, cancellation: AbortSignal) {
  const { system, rest } = splitProviderSystem(request.messages)
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens ?? 8192,
    messages: encodeMessages(rest),
    stream: true
  }
  if (system) body.system = system
  const tools = encodeTools(request.tools, request.web)
  if (tools) body.tools = tools
  const response = await brokerFetch(`${context.baseUrl.replace(/\/$/, '')}/messages`, {
    method: 'POST',
    stream: true,
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    credential: context.credentialHandle ? { handle: context.credentialHandle, placement: 'header', name: 'x-api-key' } : undefined,
    body: JSON.stringify(body),
    signal: cancellation
  })
  if (!response.ok) throw new Error(`Anthropic HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
  await readAnthropicStream(response.body, emit)
}

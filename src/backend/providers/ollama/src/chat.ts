import { brokerFetch } from '../../network'
import type { AiMessage } from '../../../../types'
import { readOllamaStream } from './stream'
import { encodeTools } from './tools'

function encodeMessages(messages: AiMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'assistant' && message.toolCalls?.length) return {
      role: 'assistant',
      content: message.content || '',
      tool_calls: message.toolCalls.map((call) => ({
        function: { name: call.name, arguments: call.arguments ?? {} }
      }))
    }
    if (message.role === 'tool') return {
      role: 'tool',
      content: message.content,
      ...(message.name ? { tool_name: message.name } : {})
    }
    return { role: message.role, content: message.content }
  })
}

export async function chat(request: any, context: any, emit: (event: any) => void, cancellation: AbortSignal) {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: encodeMessages(request.messages),
    stream: true
  }
  const tools = encodeTools(request.tools)
  if (tools) body.tools = tools
  const options: Record<string, unknown> = {}
  if (typeof request.temperature === 'number') options.temperature = request.temperature
  if (typeof request.maxTokens === 'number') options.num_predict = request.maxTokens
  if (Object.keys(options).length) body.options = options
  const response = await brokerFetch(`${context.baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    stream: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: cancellation
  })
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
  await readOllamaStream(response.body, emit)
}

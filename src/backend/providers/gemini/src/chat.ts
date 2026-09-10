import { brokerFetch } from '../../network'
import type { AiMessage } from '../../../../types'
import { splitProviderSystem } from '../../shared'
import { readGeminiStream } from './stream'
import { encodeTools } from './tools'

function encodeContents(messages: AiMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'assistant' && message.toolCalls?.length) return {
      role: 'model',
      parts: [
        ...(message.content ? [{ text: message.content }] : []),
        ...message.toolCalls.map((call) => ({ functionCall: { name: call.name, args: call.arguments ?? {} } }))
      ]
    }
    if (message.role === 'tool') return {
      role: 'user',
      parts: [{ functionResponse: { name: message.name ?? 'tool', response: { result: message.content } } }]
    }
    const parts: unknown[] = (message.attachments ?? []).map((attachment) => ({
      inlineData: { mimeType: attachment.mime, data: attachment.dataBase64 }
    }))
    if (message.content) parts.push({ text: message.content })
    return { role: message.role === 'assistant' ? 'model' : 'user', parts }
  })
}

export async function chat(request: any, context: any, emit: (event: any) => void, cancellation: AbortSignal) {
  const { system, rest } = splitProviderSystem(request.messages)
  const body: Record<string, unknown> = { contents: encodeContents(rest) }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  const tools = encodeTools(request.tools, request.web)
  if (tools) body.tools = tools
  const generationConfig: Record<string, unknown> = {}
  if (typeof request.temperature === 'number') generationConfig.temperature = request.temperature
  if (typeof request.maxTokens === 'number') generationConfig.maxOutputTokens = request.maxTokens
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig
  const base = context.baseUrl.replace(/\/$/, '')
  const response = await brokerFetch(`${base}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    stream: true,
    headers: { 'content-type': 'application/json' },
    credential: context.credentialHandle ? { handle: context.credentialHandle, placement: 'header', name: 'x-goog-api-key' } : undefined,
    body: JSON.stringify(body),
    signal: cancellation
  })
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
  await readGeminiStream(response.body, emit)
}

import { t } from '../runtime'
import { brokerFetch } from './network'
import type { AiChatRequest, AiMessage, AiModelInfo, AiProviderBalance, AiProviderId, AiStreamEvent, AiToolCall, AiToolDef } from '../../types'
import type { ValleyCancellation } from '@valley/plugin-sdk/valleyCancellation'

export interface AccountCredentialEndpoint {
  host: string
  port: number
  capabilities: string[]
}

type ProviderStreamEvent = AiStreamEvent extends infer T
  ? T extends unknown
    ? Omit<T, 'requestId'>
    : never
  : never

export interface ProviderRuntimeContext {
  credentialHandle: string | null
  baseUrl: string
  vaultRoot?: string
  strict?: boolean
}

export interface OpenAiCompatibleProviderConfig {
  id: AiProviderId
  label: string
  defaultBaseUrl: string
  defaultModels: AiModelInfo[]
  envKeys?: string[]
  getBalance?: (context: ProviderRuntimeContext) => Promise<AiProviderBalance | null>
}

export function providerSafeJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export async function* providerStreamLines(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) yield line
    }
    pending += decoder.decode()
    if (pending) yield pending
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export class ProviderToolCallAccumulator {
  private calls = new Map<number, { id: string; name: string; json: string }>()

  push(index: number, json: string, id?: string, name?: string): void {
    const current = this.calls.get(index) ?? { id: id ?? '', name: name ?? '', json: '' }
    if (id) current.id = id
    if (name) current.name = name
    current.json += json
    this.calls.set(index, current)
  }

  finishAll(): AiToolCall[] {
    return [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({
      id: call.id,
      name: call.name,
      arguments: providerSafeJson<Record<string, unknown>>(call.json, {})
    }))
  }
}

export function providerOpenAiMessages(messages: AiMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content || '',
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) }
        }))
      }
    }
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.content }
    }
    if (message.role === 'user' && message.attachments?.length) {
      const content: unknown[] = message.attachments
        .filter((attachment) => attachment.mime.startsWith('image/'))
        .map((attachment) => ({
          type: 'image_url',
          image_url: { url: `data:${attachment.mime};base64,${attachment.dataBase64}` }
        }))
      if (message.content) content.push({ type: 'text', text: message.content })
      return { role: 'user', content }
    }
    return { role: message.role, content: message.content }
  })
}

export function providerOpenAiTools(tools: AiToolDef[] | undefined): unknown[] | undefined {
  return tools?.length
    ? tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters }
      }))
    : undefined
}

export function splitProviderSystem(messages: AiMessage[]): { system: string; rest: AiMessage[] } {
  return {
    system: messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n'),
    rest: messages.filter((message) => message.role !== 'system')
  }
}

function providerHttpError(label: string, status: number, detail: string, statusText: string, retryAfter?: string | null): Error {
  const parsed = providerSafeJson<{
    error?: { code?: string; type?: string; message?: string } | string
    message?: string
  }>(detail, {})
  const error = typeof parsed.error === 'string' ? { message: parsed.error } : parsed.error
  const summary = error?.message || parsed.message || detail.slice(0, 500) || statusText
  if (label === 'OpenAI' && status === 429 && error?.code === 'insufficient_quota') {
    return new Error(
      t('assistant.backend.providerQuota')
    )
  }
  const prefix = `${label} ${status}`
  if (status === 401 || status === 403) {
    return new Error(`${prefix}: ${t('assistant.backend.providerAuth')} ${summary}`)
  }
  if (status === 402) return new Error(`${prefix}: ${t('assistant.backend.providerBalance')} ${summary}`)
  if (status === 404) return new Error(`${prefix}: ${t('assistant.backend.providerMissing')} ${summary}`)
  const retryHint = retryAfter ? ` Retry-After: ${retryAfter}.` : ''
  if (status === 429) return new Error(`${prefix}: ${t('assistant.backend.providerRate')} ${summary}${retryHint}`)
  if (status >= 500) return new Error(`${prefix}: ${t('assistant.backend.providerServer')} ${summary}${retryHint}`)
  return new Error(`${prefix}: ${summary}`)
}

function providerNetworkError(label: string, baseUrl: string, error: unknown): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  const message = error instanceof Error ? error.message : String(error)
  const code = ((error as { cause?: { code?: string } })?.cause?.code ?? '').toString()
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|UND_ERR/.test(`${code} ${message}`)) {
    return new Error(t('assistant.backend.providerUnreachable', { provider: label, url: baseUrl }))
  }
  return error instanceof Error ? error : new Error(message)
}

export function createOpenAiCompatibleProvider(config: OpenAiCompatibleProviderConfig) {
  return {
    id: config.id,
    label: config.label,
    defaultBaseUrl: config.defaultBaseUrl,
    requiresKey: true,
    defaultModels: config.defaultModels,
    ...(config.envKeys?.length ? { envKeys: config.envKeys } : {}),
    ...(config.getBalance ? { getBalance: config.getBalance } : {}),
    async listModels(context: ProviderRuntimeContext): Promise<AiModelInfo[]> {
      try {
        const response = await brokerFetch(`${context.baseUrl.replace(/\/$/, '')}/models`, {
          credential: context.credentialHandle ? { handle: context.credentialHandle, placement: 'header', name: 'authorization', prefix: 'Bearer ' } : undefined
        })
        if (!response.ok) {
          if (context.strict) throw new Error(`HTTP ${response.status} from ${context.baseUrl}/models`)
          return config.defaultModels
        }
        const json = (await response.json()) as { data?: { id?: string }[] }
        const models = (json.data ?? [])
          .map((model) => model.id)
          .filter((id): id is string => Boolean(id))
          .map((id) => ({ provider: config.id, id, tools: true }))
        return models.length ? models : config.defaultModels
      } catch (error) {
        if (context.strict) throw error
        return config.defaultModels
      }
    },
    async chat(
      request: AiChatRequest,
      context: ProviderRuntimeContext,
      emit: (event: ProviderStreamEvent) => void,
      cancellation: ValleyCancellation
    ): Promise<void> {
      const body: Record<string, unknown> = {
        model: request.model,
        messages: providerOpenAiMessages(request.messages),
        stream: true,
        stream_options: { include_usage: true }
      }
      const tools = providerOpenAiTools(request.tools)
      if (tools) body.tools = tools
      if (typeof request.temperature === 'number') body.temperature = request.temperature
      if (typeof request.maxTokens === 'number') body.max_tokens = request.maxTokens
      let response: Response
      try {
        response = await brokerFetch(`${context.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
    stream: true,
          headers: {
            'content-type': 'application/json',
          },
          credential: context.credentialHandle ? { handle: context.credentialHandle, placement: 'header', name: 'authorization', prefix: 'Bearer ' } : undefined,
          body: JSON.stringify(body),
          signal: cancellation
        })
      } catch (error) {
        throw providerNetworkError(config.label, context.baseUrl, error)
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw providerHttpError(config.label, response.status, detail, response.statusText, response.headers?.get?.('retry-after') ?? null)
      }
      const calls = new ProviderToolCallAccumulator()
      let finishReason: string | undefined
      for await (const line of providerStreamLines(response.body)) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        const chunk = providerSafeJson<{
          choices?: Array<{
            delta?: {
              content?: string
              tool_calls?: Array<{
                index: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
            }
            finish_reason?: string
          }>
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }>(data, {})
        const choice = chunk.choices?.[0]
        if (choice?.delta?.content) emit({ type: 'text', text: choice.delta.content })
        for (const call of choice?.delta?.tool_calls ?? []) {
          calls.push(call.index, call.function?.arguments ?? '', call.id, call.function?.name)
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason
        if (chunk.usage) {
          emit({
            type: 'usage',
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens
          })
        }
      }
      for (const call of calls.finishAll()) emit({ type: 'tool_call', call })
      emit({ type: 'done', finishReason })
    }
  }
}

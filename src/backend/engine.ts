import { t } from './runtime'
import { withBackgroundOperation } from './runtime'
import type { AiChatRequest, AiStreamEvent, AiToolCall } from '../types'
import { valleyCancellationOf } from '@valley/plugin-sdk/valleyCancellation'
import { redactSecrets } from '@valley/plugin-sdk'
import { emitDriverEvent } from './runtime'
import { getAiProvider as getProvider } from './providers'
import type { AiStreamBody } from './providers/types'
import { resolveConnection } from './store'
import { providerKey, secretState } from './secrets'
import { recordUsage } from './usage'

/**
 * Owns in-flight streamed runs. `startRun` resolves the provider, key (from
 * safeStorage) and base URL, then streams the provider's normalized events out
 * over the single `ai`/`stream` driver-event channel, tagged with `requestId`
 * so the renderer can multiplex concurrent runs. `cancelRun` aborts a run.
 *
 * The provider emits its own terminal `done`; on error (or abort) the engine
 * emits the terminal events so a run never hangs the renderer.
 */
const active = new Map<string, AbortController>()

function send(requestId: string, event: AiStreamBody): void {
  // Error text can echo provider payloads (auth headers, request bodies) —
  // never let anything credential-shaped cross into the renderer.
  const body = event.type === 'error' ? { ...event, error: redactSecrets(event.error) } : event
  emitDriverEvent('ai', 'stream', { ...body, requestId } as AiStreamEvent)
}

export function startRun(vaultRoot: string, request: AiChatRequest): Promise<void> {
  return withBackgroundOperation(vaultRoot, () => startRunInContext(vaultRoot, request)).catch((error) => {
    send(request.requestId, { type: 'error', error: error instanceof Error ? error.message : String(error) })
    send(request.requestId, { type: 'done', finishReason: 'error' })
  })
}

async function startRunInContext(vaultRoot: string, request: AiChatRequest): Promise<void> {
  const provider = getProvider(request.provider)
  if (!provider) {
    send(request.requestId, { type: 'error', error: t('assistant.backend.unknownProvider', { value: request.provider }) })
    send(request.requestId, { type: 'done', finishReason: 'error' })
    return
  }

  const req = request
  // Resolve the credential before the meter closure so usage is billed to the
  // connection that actually ran, not to the provider at large.
  const connection = await resolveConnection(vaultRoot, req)
  const controller = new AbortController()
  const cancellation = valleyCancellationOf(controller)
  active.set(req.requestId, controller)
  // Meter token usage in main (where it streams in) so the renderer can never
  // skip or inflate a write. Anthropic emits input/output usage in separate
  // events, so accumulate rather than overwrite, then record once on `done`.
  let inputTokens = 0
  let outputTokens = 0
  let recorded = false
  const meterAndSend = (event: AiStreamBody): void => {
    if (event.type === 'usage') {
      if (typeof event.inputTokens === 'number') inputTokens = event.inputTokens
      if (typeof event.outputTokens === 'number') outputTokens = event.outputTokens
    } else if (event.type === 'done' && !recorded) {
      recorded = true
      void withBackgroundOperation(vaultRoot, () => recordUsage({
        provider: req.provider,
        connectionId: connection.connectionId,
        model: req.model,
        inputTokens,
        outputTokens,
        origin: req.origin ?? 'ui'
      }))
    }
    send(req.requestId, event)
  }
  try {
    const baseUrl = req.baseUrl || connection.baseUrl
    const credentialHandle = connection.credentialHandle
    if (provider.requiresKey && !credentialHandle) {
      send(req.requestId, {
        type: 'error',
        error: await describeMissingCredential(vaultRoot, connection.connectionId, provider.label)
      })
      send(req.requestId, { type: 'done', finishReason: 'error' })
      return
    }
    await provider.chat(req, { credentialHandle, baseUrl, vaultRoot }, meterAndSend, cancellation)
  } catch (err) {
    if (cancellation.aborted) {
      send(req.requestId, { type: 'done', finishReason: 'cancelled' })
    } else {
      send(req.requestId, { type: 'error', error: err instanceof Error ? err.message : String(err) })
      send(req.requestId, { type: 'done', finishReason: 'error' })
    }
  } finally {
    active.delete(req.requestId)
  }
}

/** "No key" and "key exists but is undecryptable" need different fixes — say which. */
async function describeMissingCredential(vaultRoot: string, connectionId: string, label: string): Promise<string> {
  const state = await secretState(vaultRoot, providerKey(connectionId))
  if (state === 'unreadable') {
    return t('assistant.backend.unreadableCredential', { value: label })
  }
  return t('assistant.backend.missingCredential', { value: label })
}

export function cancelRun(requestId: string): boolean {
  const controller = active.get(requestId)
  if (!controller) return false
  controller.abort()
  active.delete(requestId)
  return true
}

/** Result of a headless one-shot completion (no streaming, no tools). */
export interface OneShotResult {
  text: string
  inputTokens: number
  outputTokens: number
  finishReason?: string
}

export interface DetailedCompletionResult extends OneShotResult {
  toolCalls: AiToolCall[]
  events: AiStreamEvent[]
  latencyMs: number
  connectionId: string
}

/** Headless normalized completion used by the harness broker. It preserves tool
 * calls and stream events while keeping credentials and provider objects in main. */
export async function runDetailed(
  vaultRoot: string,
  request: AiChatRequest,
  controller = new AbortController()
): Promise<DetailedCompletionResult> {
  const provider = getProvider(request.provider)
  if (!provider) throw new Error(t('assistant.backend.unknownProvider', { value: request.provider }))
  const connection = await resolveConnection(vaultRoot, request)
  const baseUrl = request.baseUrl || connection.baseUrl
  if (provider.requiresKey && !connection.credentialHandle) {
    throw new Error(await describeMissingCredential(vaultRoot, connection.connectionId, provider.label))
  }
  const started = Date.now()
  let text = ''
  let inputTokens = 0
  let outputTokens = 0
  let finishReason: string | undefined
  let streamError: string | undefined
  const toolCalls: AiToolCall[] = []
  const events: AiStreamEvent[] = []
  await provider.chat(
    request,
    { credentialHandle: connection.credentialHandle, baseUrl, vaultRoot },
    (event) => {
      const normalized = { ...event, requestId: request.requestId } as AiStreamEvent
      events.push(normalized)
      if (event.type === 'text') text += event.text
      else if (event.type === 'tool_call') toolCalls.push(event.call)
      else if (event.type === 'usage') {
        if (typeof event.inputTokens === 'number') inputTokens = event.inputTokens
        if (typeof event.outputTokens === 'number') outputTokens = event.outputTokens
      } else if (event.type === 'done') finishReason = event.finishReason
      else if (event.type === 'error') streamError = event.error
    },
    valleyCancellationOf(controller)
  )
  const cancellation = valleyCancellationOf(controller)
  if (cancellation.aborted) throw new Error(t('assistant.backend.cancelled'))
  if (streamError) throw new Error(redactSecrets(streamError))
  await recordUsage({
    provider: request.provider,
    connectionId: connection.connectionId,
    model: request.model,
    inputTokens,
    outputTokens,
    origin: 'harness'
  })
  return {
    text,
    toolCalls,
    events,
    inputTokens,
    outputTokens,
    finishReason,
    latencyMs: Date.now() - started,
    connectionId: connection.connectionId
  }
}

/**
 * Headless one-shot completion behind the `ai.ask` driver method (and the
 * `valley assistant ask` CLI): resolve creds, run the provider once, accumulate
 * the reply into a **single** string buffer, meter the usage, and resolve. The
 * buffer is dropped when this returns so it GC's promptly even across many
 * sequential `ask` calls — the driver caps `maxTokens` so the buffer stays bounded.
 */
export async function runOnce(vaultRoot: string, request: AiChatRequest): Promise<OneShotResult> {
  const provider = getProvider(request.provider)
  if (!provider) throw new Error(t('assistant.backend.unknownProvider', { value: request.provider }))

  const req = request
  const connection = await resolveConnection(vaultRoot, req)
  const baseUrl = req.baseUrl || connection.baseUrl
  const credentialHandle = connection.credentialHandle
  if (provider.requiresKey && !credentialHandle) {
    throw new Error(await describeMissingCredential(vaultRoot, connection.connectionId, provider.label))
  }

  let text = ''
  let inputTokens = 0
  let outputTokens = 0
  let finishReason: string | undefined
  let streamError: string | undefined
  await provider.chat(
    req,
    { credentialHandle, baseUrl, vaultRoot },
    (event) => {
      if (event.type === 'text') text += event.text
      else if (event.type === 'usage') {
        if (typeof event.inputTokens === 'number') inputTokens = event.inputTokens
        if (typeof event.outputTokens === 'number') outputTokens = event.outputTokens
      } else if (event.type === 'done') finishReason = event.finishReason
      else if (event.type === 'error') streamError = event.error
    },
    valleyCancellationOf(new AbortController())
  )
  if (streamError) throw new Error(redactSecrets(streamError))
  await recordUsage({
    provider: req.provider,
    connectionId: connection.connectionId,
    model: req.model,
    inputTokens,
    outputTokens,
    origin: req.origin ?? 'ui'
  })
  return { text, inputTokens, outputTokens, finishReason }
}

export function cancelAllRuns(): void { for (const controller of active.values()) controller.abort(); active.clear() }

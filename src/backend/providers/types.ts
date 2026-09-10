import type { AiChatRequest, AiModelInfo, AiOllamaStatus, AiProviderBalance, AiProviderId, AiStreamEvent } from '../../types'
import type { ValleyCancellation } from '@valley/plugin-sdk/valleyCancellation'

/**
 * A normalized stream event minus its `requestId` — the engine stamps that on.
 * A *distributive* omit so each union variant keeps its own members (a plain
 * `Omit<AiStreamEvent, 'requestId'>` collapses the union to its shared keys).
 */
export type AiStreamBody = AiStreamEvent extends infer T
  ? T extends unknown
    ? Omit<T, 'requestId'>
    : never
  : never

/** Per-call provider context resolved by the engine (key from safeStorage, base URL from config). */
export interface LlmProviderContext {
  credentialHandle: string | null
  /** Effective base URL (provider default unless the user overrode it, e.g. Ollama). */
  baseUrl: string
  /** Current vault root, for providers that persist provider-local conversation state. */
  vaultRoot?: string
  /**
   * Strict discovery probe (set only by the settings "Test connection" button): when
   * true, `listModels` throws on a failed/non-2xx/unauthorized request instead of
   * falling back to `defaultModels`, so the connection test can actually fail.
   */
  strict?: boolean
}

/**
 * One LLM provider adapter. `chat` runs a streamed completion, translating the
 * neutral request into the provider's wire format and normalizing every chunk
 * back into a neutral `AiStreamEvent` via `emit`. It resolves when the stream
 * ends (success or handled error) and must honor `cancellation`.
 */
export interface LlmProvider {
  id: AiProviderId
  label: string
  description?: string
  icon?: string
  version?: string
  envKeys?: string[]
  settingsUrl?: string
  capabilities?: string[]
  transcribeAudio?(input: {
    credentialHandle: string
    baseUrl: string
    bytes: Uint8Array
    fileName: string
    model?: string
  }): Promise<string>
  /** Default API base URL (shown in settings; overridable for Ollama / gateways). */
  defaultBaseUrl: string
  /** False for providers that need no key (local Ollama). */
  requiresKey: boolean
  /** Seeded model list shown before (or instead of) live discovery. */
  defaultModels: AiModelInfo[]
  /** Live model discovery (Ollama `/api/tags`); others return `defaultModels`. */
  listModels(ctx: LlmProviderContext): Promise<AiModelInfo[]>
  chat(
    req: AiChatRequest,
    ctx: LlmProviderContext,
    emit: (event: AiStreamBody) => void,
    cancellation: ValleyCancellation
  ): Promise<void>
  /**
   * Remaining account balance, for providers that expose one to a normal API key
   * (DeepSeek, Kimi/Moonshot). Omitted by providers without such an endpoint.
   * Must never throw — resolve `null` on any failure (offline, no key, parse error).
   */
  getBalance?(ctx: LlmProviderContext): Promise<AiProviderBalance | null>
  /** Daemon reachability + installed models (Ollama only). */
  getStatus?(ctx: LlmProviderContext): Promise<AiOllamaStatus>
}

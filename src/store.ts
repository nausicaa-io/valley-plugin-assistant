import type { ValleyPluginApi } from './api'
import { AGENT_TOOL_PROVIDER_V1, resolveGuard, type ApprovalDraft, type GuardRuntimeBridge } from '@valley/plugin-sdk'
import type { AiAttachment, AiChatSummary, AiChatThread, AiMemoryEntry, AiMessage, AiProviderId, AssistantConfig, ChannelMessage, InboundAttachment, RoutingConfig } from './types'
import type {
  GuardAuditEntry,
  GuardDangerousMode,
  GuardDecision,
  GuardLayers,
  GuardOverrides,
  GuardPolicy,
  PermissionRequest
} from '@valley/plugin-sdk/guard/types'
import { isWriteFileOperation, PLATFORM_BLOCKED_PATHS } from '@valley/plugin-sdk/guard/types'
import { assetUrlForRelPath, fileExtension } from '@valley/plugin-sdk/fileTypes'
import { valleyCancellationOf } from '@valley/plugin-sdk/valleyCancellation'
import { buildTools, type AgentTool, type InAppSurface } from './agent/tools'
import { runAgent } from './agent/loop'
import { parseModelValue } from './models'
import type { RouteResult, RoutingLayers } from './router'
import {
  approvalButtons,
  expandCommand,
  helpText,
  isBuiltinCommand,
  modelPickerButtons,
  parseCallbackData,
  parseCommand,
  parseModelArg,
  parseModelPickerCallback,
  providerPickerButtons,
  resolveCustomCommand,
  type ChannelApprovalAction,
  type ModelPickerTap
} from './channelCommands'
import { api as runtimeApi, initRuntime } from './runtime'

/**
 * The assistant's runtime engine lives in the host's owner-scoped session
 * runtime. It owns chat threads, the
 * streaming state machine, the Guard approval store, and the remote-channel
 * bridge. Runs are serialized **per chat** (not globally): a turn parked on an
 * approval never freezes other chats or the in-app composer (C8). Views subscribe
 * via `useSyncExternalStore`.
 */
const STORE_KEY = 'assistant.store'

/** Telegram approvals expire after 24h (hard); in-app cards after 30 min. */
const CHANNEL_APPROVAL_TTL = 24 * 60 * 60 * 1000
const IN_APP_APPROVAL_TTL = 30 * 60 * 1000
const DEFAULT_DANGEROUS_TTL_MIN = 15

/** A permissive-but-safe stand-in used only before the real policy has loaded. */
const FALLBACK_GUARD: GuardPolicy = {
  defaultWrite: { decision: 'confirm', allowPreApproval: false },
  tools: {},
  commands: {},
  files: {
    visitMode: 'allow-all-except-blocked',
    defaultRead: { decision: 'allow' },
    defaultWrite: { decision: 'confirm', allowPreApproval: false },
    allowedToVisit: ['**/*'],
    allowedToWrite: ['**/*.md'],
    // The platform hard-blocks verbatim — this used to restate a hand-picked
    // subset, which is the drift `PLATFORM_BLOCKED_PATHS` exists to prevent.
    blocked: [...PLATFORM_BLOCKED_PATHS],
    readOverrides: {},
    writeOverrides: {}
  },
  dangerousMode: { enabled: false, scope: 'off', expiresAt: null, maxTtlMinutes: 60 },
  pluginPresets: {}
}

/** One in-flight turn's mutable state (one per chat thread). */
interface ActiveRun {
  thread: AiChatThread
  origin: TurnOrigin
  requestId: string | null
  phase: 'thinking' | 'working'
  streamingText: string
  cancelled: boolean
  /** Aborted on cancel — threaded into tool runs + bus dispatches so a cancelled
   *  turn also cancels the command it is waiting on. */
  controller: AbortController
  /** True while parked on an approval prompt — keeps the active-thread "streaming" off (C8). */
  awaitingApproval: boolean
}

/** One pending Guard approval (in-app card or channel buttons). */
interface PendingEntry {
  request: PermissionRequest
  resolve: (ok: boolean) => void
  timer: ReturnType<typeof setTimeout> | null
}

type TurnOrigin = 'ui' | { channelId: string; chatRef: string }

export interface AssistantSnapshot {
  ready: boolean
  config: AssistantConfig | null
  threads: AiChatSummary[]
  active: AiChatThread | null
  /** A run is streaming into the *active* thread (drives the thinking indicator). */
  streaming: boolean
  /** Any run is in flight anywhere (foreground or a background channel reply). */
  busy: boolean
  /** The *active* thread has a run in flight (incl. parked on approval) — gates the composer. */
  activeBusy: boolean
  streamingText: string
  /** Phase of the active-thread run, for the thinking-label. */
  phase: 'thinking' | 'working'
  lastModel: RouteResult | null
  /** The in-app approval card for the active thread, if one is pending. */
  pending: PermissionRequest | null
  /** Temporary permission bypass status (live countdown + composer warning). */
  dangerous: GuardDangerousMode | null
  error: string | null
  canGoBack: boolean
  canGoForward: boolean
}

function newThreadId(): string {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** Short, file-/callback-safe id for an approval request (Telegram callback key, C9). */
function newRequestId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function titleFrom(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > 48 ? `${t.slice(0, 48)}…` : t || 'New chat'
}

/** Base64-encode bytes in chunks (avoids a stack overflow on a large image). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}

function imageMime(path: string): string {
  switch (fileExtension(path)) {
    case '.png':
      return 'image/png'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.svg':
      return 'image/svg+xml'
    default:
      return 'image/jpeg'
  }
}

interface StableState {
  ready: boolean
  config: AssistantConfig | null
  threads: AiChatSummary[]
  active: AiChatThread | null
  lastModel: RouteResult | null
  error: string | null
}

class AssistantStore {
  readonly api: ValleyPluginApi
  private tools: AgentTool[]
  private listeners = new Set<() => void>()
  private snap: AssistantSnapshot
  private offChannel: (() => void) | null = null
  private offGuard: (() => void) | null = null
  private offToolProviders: (() => void) | null = null
  /** One in-flight turn per chat thread id (per-chat serialization, cross-chat concurrency). */
  private runs = new Map<string, ActiveRun>()
  private pendingWork = new Set<Promise<void>>()
  private pendingSaves = new Set<Promise<void>>()
  private dirtyThreads = new Map<string, AiChatThread>()
  private failedThreads = new Set<string>()
  private preparing = false
  private disposed = false
  private unloadPreparation: Promise<void> | null = null
  /** Pending approvals keyed by short requestId. */
  private pending = new Map<string, PendingEntry>()
  /** `${channelId}:${chatRef}` → the pending requestId awaiting that chat's reply. */
  private chatPending = new Map<string, string>()
  /** One-time approval tokens the loop minted, consumed by the bus gate (C6). */
  private approvalTokens = new Map<string, string | undefined>()
  /** Per-chat guard narrowing ("Always allow/ask/block here") — persisted to guard-overrides.json. */
  private chatOverrides = new Map<string, GuardOverrides>()
  /** Chat ids whose persisted overrides were already loaded this session (load-once). */
  private loadedOverrides = new Set<string>()
  /** Inbound channel messages waiting for their chat's in-flight run to finish (per-chat FIFO). */
  private channelQueue: ChannelMessage[] = []
  private drainingQueue = false
  private dangerousTimer: ReturnType<typeof setTimeout> | null = null
  private chatHistory: string[] = []
  private chatHistoryIndex = -1

  private state: StableState = {
    ready: false,
    config: null,
    threads: [],
    active: null,
    lastModel: null,
    error: null
  }

  /** The live guard runtime the command bus consults (installed on `window`). */
  private guardBridge: GuardRuntimeBridge = {
    resolve: (req) => resolveGuard(req, this.policy(), {}, this.dangerousState(), Date.now()),
    requestApproval: (draft) => this.requestApproval(draft, 'ui', this.state.active?.id ?? 'app'),
    consumeToken: (token, binding) => {
      if (!this.approvalTokens.has(token) || this.approvalTokens.get(token) !== binding) return false
      return this.approvalTokens.delete(token)
    },
    audit: (entry) => this.audit(entry)
  }

  constructor(api: ValleyPluginApi) {
    this.api = api
    this.tools = buildTools(api, () => this.state.config?.guard.files ?? null)
    this.offToolProviders = api.interop.services.subscribe(AGENT_TOOL_PROVIDER_V1, () => {
      this.tools = buildTools(api, () => this.state.config?.guard.files ?? null)
    })
    this.snap = this.build()
    this.offChannel = api.channels.onMessage((msg) => this.handleChannelMessage(msg))
    this.whenReady = this.init()
  }

  readonly whenReady: Promise<void>

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  getSnapshot = (): AssistantSnapshot => this.snap

  private policy(): GuardPolicy {
    return this.state.config?.guard ?? FALLBACK_GUARD
  }

  private dangerousState(): GuardDangerousMode {
    return this.state.config?.guard.dangerousMode ?? FALLBACK_GUARD.dangerousMode
  }

  /** Rebuild the snapshot from stable state + the per-chat run map (deep-copy active messages). */
  private build(): AssistantSnapshot {
    const activeId = this.state.active?.id
    const activeRun = activeId ? this.runs.get(activeId) : undefined
    const activeStreaming = Boolean(activeRun) && !activeRun!.awaitingApproval
    const pending =
      activeId != null
        ? [...this.pending.values()].find((e) => e.request.caller === 'agent' && e.request.chatId === activeId)?.request ?? null
        : null
    return {
      ready: this.state.ready,
      config: this.state.config,
      threads: [...this.state.threads],
      active: this.state.active ? { ...this.state.active, messages: [...this.state.active.messages] } : null,
      busy: this.runs.size > 0,
      activeBusy: Boolean(activeRun) || this.preparing,
      streaming: activeStreaming,
      streamingText: activeStreaming ? activeRun!.streamingText : '',
      phase: activeRun?.phase ?? 'thinking',
      lastModel: this.state.lastModel,
      pending,
      dangerous: this.state.config?.guard.dangerousMode ?? null,
      error: this.state.error,
      canGoBack: this.chatHistoryIndex > 0,
      canGoForward: this.chatHistoryIndex < this.chatHistory.length - 1
    }
  }

  private notify(): void {
    this.snap = this.build()
    this.listeners.forEach((cb) => cb())
  }

  private trackWork(work: Promise<void>): Promise<void> {
    const tracked = work.catch((error) => {
      this.state.error = error instanceof Error ? error.message : String(error)
    }).finally(() => {
      this.pendingWork.delete(tracked)
      this.notify()
    })
    this.pendingWork.add(tracked)
    return tracked
  }

  retainedThread(id: string): AiChatThread | undefined {
    const thread = this.dirtyThreads.get(id)
    return thread ? structuredClone(thread) : undefined
  }

  saveThread(thread: AiChatThread): Promise<void> {
    const snapshot = structuredClone(thread)
    this.dirtyThreads.set(thread.id, snapshot)
    this.failedThreads.delete(thread.id)
    const saving = (async () => {
      try {
        const result = await this.api.assistant.saveChat(snapshot)
        if (!result.ok) throw new Error(result.error || 'Assistant chat save failed')
        if (this.dirtyThreads.get(thread.id) === snapshot) this.dirtyThreads.delete(thread.id)
      } catch (error) {
        if (this.dirtyThreads.get(thread.id) === snapshot) this.failedThreads.add(thread.id)
        this.state.error = error instanceof Error ? error.message : String(error)
        throw error
      }
    })()
    this.pendingSaves.add(saving)
    void saving.then(() => this.pendingSaves.delete(saving), () => this.pendingSaves.delete(saving))
    return saving
  }

  prepareUnload(): Promise<void> {
    if (!this.unloadPreparation) {
      this.unloadPreparation = this.flushForUnload().finally(() => { this.unloadPreparation = null })
    }
    return this.unloadPreparation
  }

  private async flushForUnload(): Promise<void> {
    this.preparing = true
    if (this.dangerousTimer) clearTimeout(this.dangerousTimer)
    this.dangerousTimer = null
    this.notify()
    const retry = [...this.dirtyThreads.values()].filter((thread) => this.failedThreads.has(thread.id))
    try {
      await this.whenReady
      for (const [id] of [...this.pending]) this.resolvePending(id, false)
      for (const [id] of [...this.runs]) this.stop(id)
      while (this.pendingWork.size || this.pendingSaves.size) await Promise.allSettled([...this.pendingWork, ...this.pendingSaves])
      for (const thread of retry) {
        if (this.dirtyThreads.get(thread.id) === thread) await this.saveThread(thread)
      }
      if (this.dirtyThreads.size) throw new Error(this.state.error || 'Assistant chat save failed')
    } catch (error) {
      this.resumeAfterUnloadCancellation()
      throw error
    }
  }

  resumeAfterUnloadCancellation(): void {
    if (!this.preparing || this.disposed) return
    this.preparing = false
    this.scheduleDangerousExpiry(this.dangerousState())
    this.notify()
    this.drainChannelQueue()
  }

  private async init(): Promise<void> {
    await this.reloadConfig()
    await this.reloadThreads()
    if (this.state.threads[0]) await this.openChat(this.state.threads[0].id)
    else this.newChat()
    // Install the guard runtime so the command bus can gate autonomous dispatch.
    this.offGuard = this.api.guard.registerRuntime(this.guardBridge)
    this.scheduleDangerousExpiry(this.dangerousState())
    await this.recoverPendingApprovals()
    this.state.ready = true
    this.notify()
    // Auto-start enabled channels (e.g. Telegram) so inbound messages work at once.
    if (!this.preparing && !this.disposed) void this.api.channels.list()
  }

  async reloadConfig(): Promise<void> {
    const res = await this.api.assistant.getConfig()
    this.state.config = res.data ?? null
    this.scheduleDangerousExpiry(this.dangerousState())
    this.notify()
  }

  async reloadThreads(): Promise<void> {
    const res = await this.api.assistant.listChats()
    this.state.threads = res.data?.chats ?? []
    this.notify()
  }

  /** A new in-app chat, seeded from the Chat settings' defaults for new chats. */
  newChat(): void {
    const now = Date.now()
    const settings = this.api.settings.get()
    const profileId = typeof settings.defaultProfileId === 'string' ? settings.defaultProfileId.trim() : ''
    const defaultModel = typeof settings.defaultModel === 'string' ? settings.defaultModel : ''
    this.state.active = {
      id: newThreadId(),
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      model: parseModelValue(defaultModel, this.state.config?.connections ?? []),
      messages: [],
      ...(profileId ? { profileId } : {})
    }
    this.state.lastModel = null
    this.pushChatHistory(this.state.active.id)
    this.notify()
  }

  async openChat(id: string, recordHistory = true): Promise<boolean> {
    // If this thread is mid-run, show the live in-memory copy (stays in sync).
    const thread = this.runs.get(id)?.thread ?? this.dirtyThreads.get(id)
    if (thread) {
      this.state.active = thread
      if (recordHistory) this.pushChatHistory(id)
      this.notify()
      return true
    }
    const res = await this.api.assistant.readChat(id)
    if (res.data?.thread?.id) {
      this.state.active = res.data.thread
      if (recordHistory) this.pushChatHistory(id)
      this.notify()
      return true
    }
    return false
  }

  private pushChatHistory(id: string): void {
    if (this.chatHistory[this.chatHistoryIndex] === id) return
    this.chatHistory = [...this.chatHistory.slice(0, this.chatHistoryIndex + 1), id].slice(-20)
    this.chatHistoryIndex = this.chatHistory.length - 1
  }

  goBack(): Promise<boolean> {
    return this.goChatHistory(-1)
  }

  goForward(): Promise<boolean> {
    return this.goChatHistory(1)
  }

  private async goChatHistory(delta: -1 | 1): Promise<boolean> {
    const nextIndex = this.chatHistoryIndex + delta
    if (nextIndex < 0 || nextIndex >= this.chatHistory.length) return false
    if (!await this.openChat(this.chatHistory[nextIndex], false)) throw new Error(this.api.ui.t('assistant.surface.missing'))
    this.chatHistoryIndex = nextIndex
    this.notify()
    return true
  }

  async renameChat(id: string, title: string): Promise<void> {
    const result = await this.api.assistant.renameChat(id, title)
    if (!result.ok) throw new Error(result.error || 'Assistant chat rename failed')
    const dirty = this.dirtyThreads.get(id)
    if (dirty) {
      this.dirtyThreads.set(id, { ...dirty, title })
      this.failedThreads.add(id)
    }
    if (this.state.active?.id === id && this.state.active) {
      this.state.active = { ...this.state.active, title }
    }
    await this.reloadThreads()
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    const result = await this.api.assistant.setChatPinned(id, pinned)
    if (!result.ok) throw new Error(result.error || 'Assistant chat update failed')
    const dirty = this.dirtyThreads.get(id)
    if (dirty) {
      this.dirtyThreads.set(id, { ...dirty, pinned })
      this.failedThreads.add(id)
    }
    await this.reloadThreads()
  }

  private async clearSavedThread(id: string): Promise<void> {
    const result = await this.api.assistant.clearChat(id)
    if (!result.ok) throw new Error(result.error || 'Assistant chat clear failed')
    this.dirtyThreads.delete(id)
    this.failedThreads.delete(id)
  }

  async clearChat(id: string): Promise<void> {
    await this.clearSavedThread(id)
    if (this.state.active?.id === id && this.state.active) {
      this.state.active = { ...this.state.active, messages: [] }
      this.notify()
    }
    await this.reloadThreads()
  }

  async deleteChat(id: string): Promise<void> {
    const result = await this.api.assistant.deleteChat(id)
    if (!result.ok) throw new Error(result.error || 'Assistant chat delete failed')
    this.dirtyThreads.delete(id)
    this.failedThreads.delete(id)
    if (this.state.active?.id === id) this.newChat()
    await this.reloadThreads()
  }

  setModelOverride(model: { provider: AiProviderId; model: string } | null): void {
    if (this.state.active) {
      this.state.active.model = model
      this.notify()
    }
  }

  // ── Guard approvals ──────────────────────────────────────────────────────

  /** The user's choice on an in-app approval card. */
  respond(requestId: string, action: 'allow-once' | 'skip' | 'always-allow' | 'always-ask' | 'block'): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    if (action === 'always-allow') this.rememberChoice(entry.request, 'allow')
    else if (action === 'always-ask') this.rememberChoice(entry.request, 'confirm')
    else if (action === 'block') this.rememberChoice(entry.request, 'deny')
    this.resolvePending(requestId, action !== 'skip' && action !== 'block')
  }

  /**
   * Resolve a tapped inline button. The payload carries `<action>:<requestId>`
   * and is looked up directly in `this.pending`; an unknown or post-restart-dead
   * request is reported expired rather than silently dropped (C8).
   */
  private async handleChannelButtonTap(msg: ChannelMessage): Promise<void> {
    // A tapped quiz answer (`qz:<letter>`) is the user's reply: turn it into a
    // normal text message so the next turn judges it like a typed answer.
    if (msg.data?.startsWith('qz:')) {
      await this.handleChannelMessage({ ...msg, text: msg.data.slice(3), data: undefined })
      return
    }
    const tap = msg.data ? parseCallbackData(msg.data) : null
    if (tap && this.pending.has(tap.requestId)) {
      this.applyChannelChoice(tap.requestId, tap.action)
      return
    }
    const modelTap = msg.data ? parseModelPickerCallback(msg.data) : null
    if (modelTap) {
      await this.handleModelPickerTap(msg, modelTap)
      return
    }
    await this.api.channels.send(msg.channelId, msg.chatRef, 'That confirmation expired.')
  }

  /** Resolve a `/model` button tap: a provider pick sends that provider's models; a model pick sets it. */
  private async handleModelPickerTap(msg: ChannelMessage, tap: ModelPickerTap): Promise<void> {
    if (tap.kind === 'provider') {
      await this.api.channels.sendButtons(
        msg.channelId,
        msg.chatRef,
        `Pick a ${tap.provider} model:`,
        modelPickerButtons(tap.provider, this.state.config?.providers ?? [])
      )
      return
    }
    const thread = await this.resolveChannelThread(msg)
    await this.applyModelChoice(thread, { provider: tap.provider, model: tap.model }, async (text) => {
      await this.api.channels.send(msg.channelId, msg.chatRef, text)
    })
  }

  /** Persist a model choice on a thread and confirm — shared by the typed `/model` arg and the button picker. */
  private async applyModelChoice(thread: AiChatThread, model: { provider: AiProviderId; model: string }, reply: (t: string) => Promise<void>): Promise<void> {
    thread.model = model
    await this.persistThreadEdit(thread)
    await reply(`Model set to ${model.provider}:${model.model}.`)
  }

  /** Apply a channel approval choice (remember narrowing, then settle). Mirrors `respond`. */
  private applyChannelChoice(requestId: string, action: ChannelApprovalAction): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    if (action === 'aallow') this.rememberChoice(entry.request, 'allow')
    else if (action === 'aask') this.rememberChoice(entry.request, 'confirm')
    else if (action === 'block') this.rememberChoice(entry.request, 'deny')
    this.resolvePending(requestId, action === 'allow' || action === 'aallow')
  }

  /** Mint a one-time token the bus accepts to skip re-prompting an approved command (C6). */
  private mintToken(binding?: string): string {
    const token = newRequestId()
    this.approvalTokens.set(token, binding)
    return token
  }

  /** Persist a session-scoped per-chat narrowing for a remembered choice. */
  private rememberChoice(req: PermissionRequest, decision: GuardDecision): void {
    const ov: GuardOverrides = { ...(this.chatOverrides.get(req.chatId) ?? {}) }
    const { kind, id, path, fileOperation } = req.target
    if (kind === 'tool' && id) ov.tools = { ...ov.tools, [id]: { decision } }
    else if (kind === 'command' && id) ov.commands = { ...ov.commands, [id]: { decision } }
    else if (kind === 'file' && path) {
      if (isWriteFileOperation(fileOperation ?? 'write')) ov.fileWriteOverrides = { ...ov.fileWriteOverrides, [path]: { decision } }
      else ov.fileReadOverrides = { ...ov.fileReadOverrides, [path]: { decision } }
    }
    this.chatOverrides.set(req.chatId, ov)
    this.loadedOverrides.add(req.chatId)
    // Persist beside the chat so the choice survives a reload/restart (spec §4.4).
    void this.api.assistant.saveGuardOverrides(req.chatId, ov).catch(() => {})
  }

  /**
   * Raise an approval prompt and resolve when the user (or channel reply, or
   * expiry) answers. Non-blocking: parking a run here flips its `awaitingApproval`
   * so the active thread's "streaming" indicator stops and the global queue keeps
   * flowing for other chats (C8).
   */
  private requestApproval(draft: ApprovalDraft, origin: TurnOrigin, chatId: string, run?: ActiveRun): Promise<boolean> {
    if (this.preparing || this.disposed) return Promise.resolve(false)
    const requestId = newRequestId()
    const now = Date.now()
    const channel = origin !== 'ui'
    const ttl = channel ? CHANNEL_APPROVAL_TTL : IN_APP_APPROVAL_TTL
    const request: PermissionRequest = {
      requestId,
      createdAt: now,
      expiresAt: now + ttl,
      caller: channel ? 'telegram' : 'agent',
      channelId: channel ? (origin as { channelId: string }).channelId : undefined,
      chatId,
      actionLabel: draft.actionLabel,
      target: draft.target,
      argsPreview: draft.argsPreview,
      diffPreview: draft.diffPreview,
      canRememberApproval: draft.canRememberApproval
    }
    return new Promise<boolean>((resolve) => {
      if (run) run.awaitingApproval = true
      const wrapped = (ok: boolean): void => {
        if (run) run.awaitingApproval = false
        resolve(ok)
      }
      const timer = setTimeout(() => this.resolvePending(requestId, false, true), ttl)
      this.pending.set(requestId, { request, resolve: wrapped, timer })
      if (channel) {
        const o = origin as { channelId: string; chatRef: string }
        this.chatPending.set(`${o.channelId}:${o.chatRef}`, requestId)
        // Persist the record so a button tapped after a restart is recognized (C8).
        void this.api.assistant.addPending({
          requestId,
          channelId: request.channelId,
          chatRef: o.chatRef,
          chatId,
          actionLabel: draft.actionLabel,
          createdAt: now,
          expiresAt: request.expiresAt
        })
        const summary = (() => {
          try {
            return JSON.stringify(draft.argsPreview).slice(0, 160)
          } catch {
            return ''
          }
        })()
        // callback_data carries only `<action>:<requestId>` (<64 bytes, C9); the
        // request is looked up server-side in `this.pending`.
        void this.api.channels.sendButtons(
          o.channelId,
          o.chatRef,
          `Confirm action "${draft.actionLabel}" ${summary}?`,
          approvalButtons(requestId, draft.canRememberApproval)
        )
      }
      this.notify()
    })
  }

  /** Settle a pending approval (user choice / channel reply / expiry) and clean up. */
  private resolvePending(requestId: string, ok: boolean, expired = false): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.pending.delete(requestId)
    if (entry.timer) clearTimeout(entry.timer)
    for (const [key, id] of this.chatPending) if (id === requestId) this.chatPending.delete(key)
    // Drop the durable record (channel approvals only persist one).
    if (entry.request.caller === 'telegram') void this.api.assistant.removePending(requestId).catch(() => {})
    if (expired) {
      const r = entry.request
      this.audit({
        ts: Date.now(),
        caller: r.caller,
        decision: 'expired',
        source: 'global-guard',
        reason: 'Approval expired',
        targetKind: r.target.kind,
        targetId: r.target.id,
        path: r.target.path,
        fileOperation: r.target.fileOperation,
        channelId: r.channelId,
        chatId: r.chatId
      })
    }
    entry.resolve(ok)
    this.notify()
  }

  private audit(entry: GuardAuditEntry): void {
    void this.api.assistant.appendGuardAudit(entry).catch(() => {})
  }

  /**
   * On launch, reconcile the durable pending-approval store (C8). Any record left
   * from a prior session belongs to a run that no longer exists, so it can't be
   * resumed: audit it expired and clear it. This keeps the runtime trail legible
   * and means a button tapped on an old message resolves cleanly as "expired".
   */
  private async recoverPendingApprovals(): Promise<void> {
    let stale: import('@valley/plugin-sdk/guard/types').PendingApprovalRecord[] = []
    try {
      stale = (await this.api.assistant.listPending()).data?.pending ?? []
    } catch {
      return
    }
    for (const r of stale) {
      this.audit({
        ts: Date.now(),
        caller: 'telegram',
        decision: 'expired',
        source: 'global-guard',
        reason: 'Pending approval recovered after restart',
        targetKind: 'tool',
        channelId: r.channelId,
        chatId: r.chatId
      })
      void this.api.assistant.removePending(r.requestId).catch(() => {})
    }
  }

  // ── Dangerous mode ───────────────────────────────────────────────────────

  /** Enable the temporary permission bypass for `scope`, bounded by the hard TTL. */
  async enableDangerousMode(scope: 'chat' | 'channel' | 'session', ttlMinutes = DEFAULT_DANGEROUS_TTL_MIN): Promise<void> {
    const cfg = this.state.config
    if (!cfg) return
    const max = cfg.guard.dangerousMode.maxTtlMinutes || 60
    const minutes = Math.min(Math.max(1, Math.round(ttlMinutes)), max)
    const next: GuardDangerousMode = { enabled: true, scope, expiresAt: Date.now() + minutes * 60000, maxTtlMinutes: max }
    await this.saveDangerous(next)
    this.audit({ ts: Date.now(), caller: 'agent', decision: 'bypass', source: 'dangerous-mode', reason: `Dangerous mode enabled (${scope}, ${minutes}m)`, targetKind: 'tool' })
  }

  async disableDangerousMode(): Promise<void> {
    const cfg = this.state.config
    if (!cfg) return
    await this.saveDangerous({ ...cfg.guard.dangerousMode, enabled: false, scope: 'off', expiresAt: null })
  }

  /** Set the global default-write decision (Claude-style persistent permission toggle). */
  async setDefaultWrite(decision: GuardDecision): Promise<void> {
    const cfg = this.state.config
    if (!cfg) return
    const guard = { ...cfg.guard, defaultWrite: { ...cfg.guard.defaultWrite, decision } }
    this.state.config = { ...cfg, guard }
    this.notify()
    await this.api.assistant.saveGuard(guard)
  }

  private async saveDangerous(d: GuardDangerousMode): Promise<void> {
    const cfg = this.state.config
    if (!cfg) return
    const guard = { ...cfg.guard, dangerousMode: d }
    this.state.config = { ...cfg, guard }
    this.scheduleDangerousExpiry(d)
    this.notify()
    await this.api.assistant.saveGuard(guard)
  }

  /** Auto-disable (and write back) when the bypass TTL elapses. */
  private scheduleDangerousExpiry(d: GuardDangerousMode): void {
    if (this.dangerousTimer) clearTimeout(this.dangerousTimer)
    this.dangerousTimer = null
    if (this.preparing || this.disposed || !d.enabled || d.expiresAt == null) return
    this.dangerousTimer = setTimeout(() => {
      this.audit({ ts: Date.now(), caller: 'agent', decision: 'expired', source: 'dangerous-mode', reason: 'Dangerous mode expired', targetKind: 'tool' })
      void this.disableDangerousMode()
    }, Math.max(0, d.expiresAt - Date.now()))
  }

  stop(id = this.state.active?.id): void {
    const run = id ? this.runs.get(id) : undefined
    if (run && id) {
      run.cancelled = true
      run.controller.abort()
      if (run.requestId) void this.api.assistant.cancel(run.requestId)
      this.runs.delete(id)
    }
    if (id) {
      for (const [requestId, e] of [...this.pending]) {
        if (e.request.caller === 'agent' && e.request.chatId === id) this.resolvePending(requestId, false)
      }
    }
    this.notify()
  }

  /** Send a message from the in-app chat UI. A read-only remote thread starts a fresh chat. */
  send(text: string, attachments?: InboundAttachment[]): Promise<void> {
    if (this.preparing || this.disposed) return Promise.resolve()
    return this.trackWork(this.sendMessage(text, attachments))
  }

  private async sendMessage(text: string, attachments?: InboundAttachment[]): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed && !attachments?.length) return
    if (!this.state.active || this.state.active.source) this.newChat()
    const thread = this.state.active!
    if (this.runs.has(thread.id)) return

    // A slash-command never carries attachments — handle commands on the bare text.
    // `/clear` and `/model` run instantly (no LLM); a custom command expands into the
    // prompt; anything else is sent as a normal message.
    const parsed = !attachments?.length ? parseCommand(trimmed) : null
    if (parsed) {
      const handled = await this.runInAppCommand(thread, parsed.cmd, parsed.arg)
      if (handled === 'done') return
      if (typeof handled === 'string') {
        await this.runTurn(thread, handled, 'ui')
        return
      }
    }
    // In-app attachments are ingested via this chat's effective parser (chat →
    // default; no channel layer in-app), then prepended to the user's text.
    let turnText = trimmed
    if (attachments?.length) {
      const blocks = await this.ingestAttachments(attachments, this.resolveAttachmentParser(thread, null))
      turnText = [...blocks, trimmed].filter(Boolean).join('\n\n')
    }
    await this.runTurn(thread, turnText, 'ui')
  }

  /**
   * Speak into a mirrored remote conversation **as the bot** — no model call.
   * The text goes out over the channel first, and only a delivered message is
   * appended to the mirror, so a failed send never leaves a phantom line the
   * remote side never saw. It lands as an `assistant` message because that is
   * what the bot said: it renders on the bot's side and stays in the model's
   * context for the next inbound turn.
   */
  sendAsChannel(text: string): Promise<void> {
    if (this.preparing || this.disposed) return Promise.resolve()
    return this.trackWork(this.sendChannelMessage(text))
  }

  private async sendChannelMessage(text: string): Promise<void> {
    const trimmed = text.trim()
    const thread = this.state.active
    if (!trimmed || !thread?.source || !thread.channelId || !thread.chatRef) return
    if (this.runs.has(thread.id)) return
    try {
      await this.api.channels.send(thread.channelId, thread.chatRef, trimmed)
    } catch (err) {
      this.state.error = err instanceof Error ? err.message : String(err)
      this.notify()
      return
    }
    this.state.error = null
    thread.messages.push({ role: 'assistant', content: trimmed, ts: Date.now() })
    thread.updatedAt = Date.now()
    this.notify()
    await this.saveThread(thread)
    await this.reloadThreads()
  }

  /**
   * A tapped quiz answer button. Sends the choice value as the user's reply and
   * attaches the question image so a vision model can grade a letter tap (the
   * option→letter mapping lives only in the image). For a remote mirror thread
   * the turn runs with channel origin, so the bot's reply also reaches the channel.
   */
  answerQuiz(value: string): Promise<void> {
    if (this.preparing || this.disposed) return Promise.resolve()
    return this.trackWork(this.runQuizAnswer(value))
  }

  private async runQuizAnswer(value: string): Promise<void> {
    const thread = this.state.active
    if (!thread || !thread.quiz || this.runs.has(thread.id)) return
    const quiz = thread.quiz
    const origin: TurnOrigin =
      thread.source && thread.channelId && thread.chatRef
        ? { channelId: thread.channelId, chatRef: thread.chatRef }
        : 'ui'
    let attachments: AiAttachment[] | undefined
    if (quiz.imagePath) {
      const att = await this.readImageAttachment(quiz.imagePath)
      if (att) attachments = [att]
    }
    thread.quiz = null
    this.notify()
    await this.runTurn(thread, value, origin, attachments)
  }

  /** Fetch a vault image (via the asset protocol) as a base64 vision attachment, or null. */
  private async readImageAttachment(ref: string): Promise<AiAttachment | null> {
    try {
      const rel = this.api.workspace.resolveWikilink(ref) ?? ref
      const res = await fetch(assetUrlForRelPath(rel))
      if (!res.ok) return null
      const bytes = new Uint8Array(await res.arrayBuffer())
      return { mime: imageMime(rel), dataBase64: bytesToBase64(bytes) }
    } catch {
      return null
    }
  }

  /**
   * Handle an in-app `/command`. Returns `'done'` when fully handled with no turn
   * (built-in `/clear`, `/model` — both instant, no model call), a string to run
   * as the turn (an expanded custom command), or `null` to fall through and send
   * the text verbatim.
   */
  private async runInAppCommand(thread: AiChatThread, cmd: string, arg: string): Promise<'done' | string | null> {
    if (cmd === 'clear' || cmd === 'reset') {
      await this.clearActive()
      return 'done'
    }
    if (cmd === 'model') {
      if (!arg.trim()) return 'done' // the model picker already shows/sets it in-app
      const res = parseModelArg(arg, this.state.config?.providers ?? [])
      if (res.kind === 'clear') thread.model = null
      else if (res.kind === 'set') thread.model = res.model
      else return 'done' // ambiguous/unknown — ignore rather than send "/model …" to the model
      await this.saveThread(thread)
      this.notify()
      await this.reloadThreads()
      return 'done'
    }
    if (isBuiltinCommand(cmd)) return null // /help, /profile, /guard: fall through in-app
    const overall = (await this.api.assistant.listCommands()).data?.commands ?? []
    const match = resolveCustomCommand(cmd, { chat: thread.commands, overall })
    return match ? expandCommand(match, arg) : null
  }

  private buildSystemPrompt(memory: AiMemoryEntry[] = [], instructionsOverride?: string | null): string {
    const cfg = this.state.config
    const s = this.api.getState()
    const vault = (s.vault as { name?: string } | null)?.name ?? 'the vault'
    const rules = (cfg?.rules ?? []).map((r) => `## Rule: ${r.name}\n${r.content}`).join('\n\n')
    // Long-term memory persists across /clear; surface it so the assistant keeps
    // durable facts without re-reading the whole thread.
    const memoryBlock = memory.length
      ? ['## Long-term memory (saved facts about the user/work)', ...memory.map((m) => `- ${m.summary}`)].join('\n')
      : ''
    const context = [
      '## Current context',
      `- Vault: ${vault}`,
      `- Active file: ${s.activePath ?? 'none'}`,
      `- Today: ${new Date().toISOString().slice(0, 10)}`,
      `- You have ${this.tools.length} tools. Prefer reading/searching before acting.`
    ].join('\n')
    const toolGuide = [
      '## Tool use priorities',
      '- Invoke tools through the tool-calling interface only. Never write a tool call as JSON or describe the tools in your reply — just call the tool.',
      '- Take action directly. Do not tell the user which tools exist or ask them to do something a tool can do.',
      '- If a tool returns an error, read it, fix the arguments, and try again. Never repeat the exact same failing call.',
      '- Prefer a dedicated provider-owned tool when its description matches the request; use run_command only when no dedicated tool exists.',
      '- Omit unknown arguments; never pass "null", "undefined", or empty placeholder strings.',
      '- Treat a provider tool result as authoritative for that action and report it concisely.'
    ].join('\n')
    // A connection-level instructions file (Settings → Assistant → channel detail)
    // replaces the global standing brief for that connection's chats; rules,
    // memory, the tool guide and live context still apply.
    const instructions = instructionsOverride?.trim() || cfg?.instructions || 'You are the Valley assistant.'
    return [instructions, rules, memoryBlock, toolGuide, context].filter(Boolean).join('\n\n')
  }

  /** Read a connection's instructions-file content (vault path), or null. */
  private async channelInstructions(channelId: string): Promise<string | null> {
    const info = await this.channelInfo(channelId)
    const path = info?.instructionsPath?.trim()
    if (!path) return null
    const res = await this.api.drivers.files.readFile(path)
    return res.ok ? res.data?.content?.trim() || null : null
  }

  private modelSupportsWeb = (provider: AiProviderId, model: string): boolean => {
    const p = this.state.config?.providers.find((x) => x.provider === provider)
    return Boolean(p?.models.find((m) => m.id === model)?.web)
  }

  private async runTurn(thread: AiChatThread, text: string, origin: TurnOrigin, attachments?: AiAttachment[]): Promise<void> {
    const config = this.state.config
    if (!config) return
    const userMsg: AiMessage = { role: 'user', content: text, ts: Date.now(), ...(attachments?.length ? { attachments } : {}) }
    thread.messages.push(userMsg)
    // Any prior quiz prompt is consumed by this turn (the answer, or a new question).
    thread.quiz = null
    // A normal chat titles itself from the first message; a remote thread keeps
    // its connection-derived title.
    if (origin === 'ui' && !thread.source && thread.messages.filter((m) => m.role === 'user').length === 1) {
      thread.title = titleFrom(text)
    }
    thread.updatedAt = Date.now()

    const run: ActiveRun = { thread, origin, requestId: null, phase: 'thinking', streamingText: '', cancelled: this.preparing || this.disposed, controller: new AbortController(), awaitingApproval: false }
    if (run.cancelled) run.controller.abort()
    this.runs.set(thread.id, run)
    this.state.error = null
    this.notify()

    let lastAssistant = ''
    try {
      // Persist the chat folder + the new user message up front (append-only): gives
      // immediate crash-recovery and lets a mid-turn memory_summarize resolve this
      // chat's on-disk folder (notably for a brand-new remote conversation).
      await this.saveThread(thread)
      // Load this chat's saved long-term memory (survives /clear) into the prompt.
      const memory = (await this.api.assistant.readMemory(thread.id)).data?.memory ?? []

      // Routing precedence (C7) + guard layers for this thread: a channel turn picks
      // up its connection's default routing/guard and the thread's personality; the
      // per-chat model override (thread.model) is still more specific and handled by
      // the router. Resolved here (async) before the run so the loop stays pure.
      const { routingLayers, guardLayers } = await this.resolveLayers(thread)
      // A channel turn may use its connection's own instructions file as the brief.
      const instructionsOverride = origin === 'ui' ? null : await this.channelInstructions(origin.channelId)

      // The in-app render surface: quizzes/attachments push an inline image bubble
      // (render-only, excluded from the model context) and arm the answer buttons.
      // Wired for every origin so remote mirrors get the same images + buttons.
      const inApp: InAppSurface = {
        postImage: (path) => {
          thread.messages.push({ role: 'assistant', content: `![[${path}]]`, render: 'quiz-image' })
          thread.updatedAt = Date.now()
          this.notify()
        },
        setQuiz: (source, choices, imagePath) => {
          thread.quiz = { source, choices, ...(imagePath ? { imagePath } : {}) }
          this.notify()
        }
      }
      await runAgent({
        api: this.api,
        config,
        systemPrompt: this.buildSystemPrompt(memory, instructionsOverride),
        messages: thread.messages,
        tools: this.tools,
        modelOverride: thread.model ?? null,
        origin: origin === 'ui' ? 'ui' : 'channel',
        channel: origin === 'ui' ? null : { channelId: origin.channelId, chatRef: origin.chatRef },
        inApp,
        conversationId: thread.id,
        modelSupportsWeb: this.modelSupportsWeb,
        guardLayers,
        routingLayers,
        onText: (partial) => {
          run.phase = 'thinking'
          run.streamingText = partial
          this.notify()
        },
        onMessage: (msg) => {
          thread.messages.push(msg)
          if (msg.role === 'assistant' && msg.content) lastAssistant = msg.content
          run.phase = msg.role === 'assistant' && msg.toolCalls?.length ? 'working' : 'thinking'
          run.streamingText = ''
          this.notify()
        },
        onModel: (routed) => {
          if (thread.id === this.state.active?.id) this.state.lastModel = routed
          this.notify()
        },
        onRequestStart: (id) => {
          run.requestId = id
        },
        requestApproval: (draft) => this.requestApproval(draft, origin, thread.id, run),
        mintApprovalToken: () => this.mintToken(),
        audit: (entry) => this.audit(entry),
        isCancelled: () => run.cancelled,
        cancellation: valleyCancellationOf(run.controller)
      })
    } catch (err) {
      this.state.error = err instanceof Error ? err.message : String(err)
    } finally {
      thread.updatedAt = Date.now()
      try {
        await this.saveThread(thread)
        await this.reloadThreads()
      } finally {
        if (this.runs.get(thread.id) === run) this.runs.delete(thread.id)
        this.notify()
      }
    }

    if (origin !== 'ui' && lastAssistant) {
      try {
        await this.api.channels.send(origin.channelId, origin.chatRef, lastAssistant)
      } catch (err) {
        console.error('[assistant] channel send failed', err)
      }
    }
    // The engine freed this chat — catch up on anything queued for an idle chat.
    this.drainChannelQueue()
  }

  /** Deterministic, file-safe thread id for one channel conversation. */
  private channelThreadId(channelId: string, chatRef: string): string {
    const prefix = channelId === 'telegram' || channelId.startsWith('telegram') ? 'tg' : channelId.startsWith('whatsapp') ? 'wa' : 'ch'
    return `${prefix}-${channelId}-${chatRef}`.replace(/[^A-Za-z0-9._ -]/g, '_')
  }

  private fallbackChannelType(channelId: string): 'telegram' | 'whatsapp' {
    return channelId.startsWith('whatsapp') ? 'whatsapp' : 'telegram'
  }

  /** The full non-secret config for a channel id (default routing/profile/guard), or null. */
  private async channelInfo(channelId: string): Promise<import('./types').ChannelInfo | null> {
    const res = await this.api.channels.list()
    return res.data?.channels.find((c) => c.id === channelId) ?? null
  }

  /**
   * Assemble the routing + guard layers for a thread (spec §6/§7). Routing
   * precedence is chat-override → chat routing → personality → channel default →
   * global; here we feed the `channel` (connection default routing) and `profile`
   * (the thread's personality routing) layers — the explicit per-chat *model*
   * override is handled separately by the router. Guard layers add the channel's
   * connection-level narrowing plus the per-chat remembered overrides (narrow-only;
   * the resolver clamps them and main re-enforces the global ceiling).
   */
  private async resolveLayers(thread: AiChatThread): Promise<{ routingLayers: RoutingLayers; guardLayers: GuardLayers }> {
    // Hydrate this chat's persisted guard overrides once per session.
    if (!this.loadedOverrides.has(thread.id)) {
      this.loadedOverrides.add(thread.id)
      if (!this.chatOverrides.has(thread.id)) {
        const ov = (await this.api.assistant.readGuardOverrides(thread.id)).data?.overrides
        if (ov) this.chatOverrides.set(thread.id, ov)
      }
    }
    const channel = thread.channelId ? await this.channelInfo(thread.channelId) : null
    let profileRouting: RoutingConfig | null = null
    const profileId = thread.profileId
    if (profileId && profileId !== 'default') {
      const res = await this.api.assistant.readPersonality(profileId)
      profileRouting = res.data?.personality?.routing ?? null
    }
    return {
      routingLayers: { channel: channel?.defaultRouting ?? null, profile: profileRouting },
      guardLayers: { channel: channel?.guard, chat: this.chatOverrides.get(thread.id) }
    }
  }

  /**
   * The read-only mirror thread for one remote conversation, keyed by
   * `${channelId}:${chatRef}`. Prefers a live in-memory copy (mid-run / open),
   * then the on-disk thread, else creates a fresh remote-channel thread.
   */
  private async resolveChannelThread(msg: ChannelMessage): Promise<AiChatThread> {
    const id = this.channelThreadId(msg.channelId, msg.chatRef)
    const run = this.runs.get(id)
    if (run) return run.thread
    if (this.state.active?.id === id) return this.state.active
    const dirty = this.dirtyThreads.get(id)
    if (dirty) return dirty
    const existing = await this.api.assistant.readChat(id)
    if (existing.data?.thread?.id) return existing.data.thread
    const info = await this.channelInfo(msg.channelId)
    const source = info?.type === 'whatsapp' ? 'whatsapp' : this.fallbackChannelType(msg.channelId)
    const name = info?.name ?? (source === 'whatsapp' ? 'WhatsApp' : 'Telegram')
    const now = Date.now()
    return {
      id,
      title: `${name} · ${msg.from || msg.chatRef}`,
      createdAt: now,
      updatedAt: now,
      model: null,
      messages: [],
      source,
      channelId: msg.channelId,
      chatRef: msg.chatRef,
      channelName: name
    }
  }

  private handleChannelMessage(msg: ChannelMessage): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.preparing) {
      this.channelQueue.push(msg)
      return Promise.resolve()
    }
    return this.trackWork(this.processChannelMessage(msg))
  }

  private async processChannelMessage(msg: ChannelMessage): Promise<void> {
    const key = `${msg.channelId}:${msg.chatRef}`
    // A tapped inline button carries `<action>:<requestId>` (C9) — resolve the
    // looked-up request, or report it expired if it's gone (e.g. after restart).
    if (msg.data) {
      await this.handleChannelButtonTap(msg)
      return
    }
    // A typed reply (yes/no) resolves this chat's pending confirmation — checked
    // before commands so a "yes" isn't mistaken for a message or a command.
    const pendingId = this.chatPending.get(key)
    if (pendingId) {
      this.resolvePending(pendingId, /^\s*(y|yes|ok|sure|do it|proceed)\b/i.test(msg.text))
      return
    }
    // Built-in slash-commands (/help, /clear, /model, /profile, /guard) are handled
    // here, instantly, and never forwarded to the model. A user-defined custom
    // command expands into a prompt and runs as a normal (queue-aware) turn; an
    // unknown /command is reported rather than sent to the model.
    const parsed = parseCommand(msg.text)
    if (parsed) {
      if (isBuiltinCommand(parsed.cmd)) {
        await this.runChannelCommand(msg, parsed.cmd, parsed.arg)
        return
      }
      const expanded = await this.resolveChannelCustom(msg, parsed.cmd, parsed.arg)
      if (expanded == null) {
        await this.api.channels.send(msg.channelId, msg.chatRef, `Unknown command /${parsed.cmd}. Send /help for the list.`)
        return
      }
      msg = { ...msg, text: expanded }
    }
    const threadId = this.channelThreadId(msg.channelId, msg.chatRef)
    // This chat already has a run in flight? Queue and catch up when it frees —
    // other chats keep running concurrently (an approval wait never freezes them).
    if (this.runs.has(threadId)) {
      this.channelQueue.push(msg)
      return
    }
    const thread = await this.resolveChannelThread(msg)
    const turnText = msg.attachments?.length ? await this.ingestInbound(msg, thread) : msg.text
    await this.runTurn(thread, turnText, { channelId: msg.channelId, chatRef: msg.chatRef })
  }

  /** The effective attachment parser for a thread: chat → channel → assistant default. */
  private resolveAttachmentParser(thread: AiChatThread, channel: import('./types').ChannelInfo | null): string {
    const settingDefault = this.api.settings.get().attachmentParser
    return (
      thread.attachmentParser ||
      channel?.attachmentParser ||
      (typeof settingDefault === 'string' ? settingDefault : '') ||
      'markitdown'
    )
  }

  /**
   * Read each attachment into text via `parser`. A failed ingestion degrades to a
   * note, never blocks the turn. Returns one labelled block per attachment.
   */
  private async ingestAttachments(attachments: InboundAttachment[], parser: string): Promise<string[]> {
    const blocks: string[] = []
    for (const att of attachments) {
      try {
        const res = await this.api.assistant.ingestAttachment({ path: att.path, kind: att.kind, parser })
        const text = res.ok ? res.data?.text?.trim() : ''
        blocks.push(
          text
            ? `[Attachment "${att.fileName}" (${att.kind}) contents:]\n${text}`
            : `[Attachment "${att.fileName}" (${att.kind}) at ${att.path} — could not extract text${res.ok ? '' : `: ${res.error}`}]`
        )
      } catch (err) {
        blocks.push(`[Attachment "${att.fileName}" (${att.kind}) at ${att.path} — ingestion failed: ${err instanceof Error ? err.message : String(err)}]`)
      }
    }
    return blocks
  }

  /** Ingest a channel message's attachments and prepend them to the user's text. */
  private async ingestInbound(msg: ChannelMessage, thread: AiChatThread): Promise<string> {
    const channel = await this.channelInfo(msg.channelId)
    const parser = this.resolveAttachmentParser(thread, channel)
    const blocks = await this.ingestAttachments(msg.attachments ?? [], parser)
    return [...blocks, msg.text].filter(Boolean).join('\n\n')
  }

  /**
   * Resolve a `/name` against this chat's three command scopes (chat → connection →
   * overall) and expand it into the prompt to run, or null when undefined anywhere.
   */
  private async resolveChannelCustom(msg: ChannelMessage, cmd: string, arg: string): Promise<string | null> {
    const thread = await this.resolveChannelThread(msg)
    const channel = await this.channelInfo(msg.channelId)
    const overall = (await this.api.assistant.listCommands()).data?.commands ?? []
    const match = resolveCustomCommand(cmd, { chat: thread.commands, channel: channel?.commands ?? undefined, overall })
    return match ? expandCommand(match, arg) : null
  }

  /** Start the next queued message for any chat that is now idle. */
  private drainChannelQueue(): void {
    if (this.preparing || this.disposed || this.drainingQueue) return
    const idx = this.channelQueue.findIndex((m) => !this.runs.has(this.channelThreadId(m.channelId, m.chatRef)))
    if (idx === -1) return
    const [next] = this.channelQueue.splice(idx, 1)
    this.drainingQueue = true
    void this.handleChannelMessage(next).finally(() => {
      this.drainingQueue = false
      this.drainChannelQueue()
    })
  }

  /**
   * Wipe one channel chat's active context (`/clear`) + any queued messages, then
   * confirm. Uses `clearChat`, not `deleteChat`, so the chat's long-term
   * `memory.jsonl` survives the reset.
   */
  private async clearChannelThread(msg: ChannelMessage): Promise<void> {
    const id = this.channelThreadId(msg.channelId, msg.chatRef)
    const key = `${msg.channelId}:${msg.chatRef}`
    this.channelQueue = this.channelQueue.filter((m) => `${m.channelId}:${m.chatRef}` !== key)
    await this.clearSavedThread(id)
    if (this.state.active?.id === id) this.newChat()
    await this.reloadThreads()
    await this.api.channels.send(msg.channelId, msg.chatRef, '🧹 Conversation cleared (saved memory kept). Starting fresh.')
  }

  // ── Remote slash-commands (Telegram first) ────────────────────────────────

  /** Dispatch a parsed `/command` for a channel chat (never forwarded to the model). */
  private async runChannelCommand(msg: ChannelMessage, cmd: string, arg: string): Promise<void> {
    const reply = async (text: string): Promise<void> => {
      await this.api.channels.send(msg.channelId, msg.chatRef, text)
    }
    switch (cmd) {
      case 'clear':
      case 'reset':
        await this.clearChannelThread(msg)
        return
      case 'help':
        await reply(await this.helpFor(msg))
        return
      case 'model':
        await this.setChannelModel(msg, arg, reply)
        return
      case 'profile':
        await this.setChannelProfile(msg, arg, reply)
        return
      case 'guard':
        await reply(this.guardSummary(this.channelThreadId(msg.channelId, msg.chatRef)))
        return
      default:
        await reply(`Unknown command /${cmd}. Send /help for the list.`)
    }
  }

  /** `/help` text: the built-ins plus any custom commands in scope for this chat. */
  private async helpFor(msg: ChannelMessage): Promise<string> {
    const thread = await this.resolveChannelThread(msg)
    const channel = await this.channelInfo(msg.channelId)
    const overall = (await this.api.assistant.listCommands()).data?.commands ?? []
    // Narrowest definition wins; de-dupe by name so a chat override hides the broader one.
    const byName = new Map<string, { name: string; description?: string }>()
    for (const c of [...overall, ...(channel?.commands ?? []), ...(thread.commands ?? [])]) byName.set(c.name, c)
    const custom = [...byName.values()]
    if (custom.length === 0) return helpText()
    const lines = custom.map((c) => `/${c.name}${c.description ? ` — ${c.description}` : ''}`)
    return `${helpText()}\n\nCustom commands:\n${lines.join('\n')}`
  }

  /** Persist a thread's model/profile edit and refresh the list + active view. */
  private async persistThreadEdit(thread: AiChatThread): Promise<void> {
    await this.saveThread(thread)
    if (this.state.active?.id === thread.id) this.state.active = thread
    this.notify()
    await this.reloadThreads()
  }

  /** `/model [auto|<id>|provider:model]` — show or set this chat's model override. */
  private async setChannelModel(msg: ChannelMessage, arg: string, reply: (t: string) => Promise<void>): Promise<void> {
    const thread = await this.resolveChannelThread(msg)
    if (!arg.trim()) {
      await reply(`Model: ${thread.model ? `${thread.model.provider}:${thread.model.model}` : 'Auto'}`)
      await this.api.channels.sendButtons(
        msg.channelId,
        msg.chatRef,
        'Pick a provider:',
        providerPickerButtons(this.state.config?.providers ?? [])
      )
      return
    }
    const res = parseModelArg(arg, this.state.config?.providers ?? [])
    if (res.kind === 'clear') {
      thread.model = null
      await this.persistThreadEdit(thread)
      await reply('Model set to Auto.')
    } else if (res.kind === 'set') {
      await this.applyModelChoice(thread, res.model, reply)
    } else if (res.kind === 'ambiguous') {
      await reply(`Several providers offer that model — pick one: ${res.candidates.map((c) => `${c.provider}:${c.model}`).join(', ')}`)
    } else {
      await reply(`Unknown model "${res.query}". Try /model auto, a model id, or provider:model.`)
    }
  }

  /** `/profile [default|<id>]` — show or set this chat's personality. */
  private async setChannelProfile(msg: ChannelMessage, arg: string, reply: (t: string) => Promise<void>): Promise<void> {
    const thread = await this.resolveChannelThread(msg)
    if (!arg.trim()) {
      await reply(`Personality: ${thread.profileId ?? 'default'}`)
      return
    }
    if (/^(default|none|reset|clear)$/i.test(arg.trim())) {
      thread.profileId = undefined
      await this.persistThreadEdit(thread)
      await reply('Personality set to default.')
      return
    }
    const list = (await this.api.assistant.listPersonalities()).data?.personalities ?? []
    const match = list.find((p) => p.id.toLowerCase() === arg.trim().toLowerCase() || p.name.toLowerCase() === arg.trim().toLowerCase())
    if (!match) {
      await reply(`No personality "${arg.trim()}". Available: ${list.map((p) => p.id).join(', ') || 'default'}`)
      return
    }
    thread.profileId = match.isDefault ? undefined : match.id
    await this.persistThreadEdit(thread)
    await reply(`Personality set to ${match.name}.`)
  }

  /** A concise `/guard` summary of the effective policy for one chat. */
  private guardSummary(chatId: string): string {
    const g = this.policy()
    const d = this.dangerousState()
    const ov = this.chatOverrides.get(chatId)
    const overrideCount = ov
      ? Object.keys(ov.tools ?? {}).length +
        Object.keys(ov.commands ?? {}).length +
        Object.keys(ov.fileReadOverrides ?? {}).length +
        Object.keys(ov.fileWriteOverrides ?? {}).length +
        (ov.blocked?.length ?? 0)
      : 0
    const danger = d.enabled && d.expiresAt ? `on (${Math.max(0, Math.round((d.expiresAt - Date.now()) / 60000))}m left)` : 'off'
    return [
      'Guard policy for this chat:',
      `- Writes: ${g.defaultWrite.decision}`,
      `- File access: ${g.files.visitMode === 'allow-listed-only' ? 'allow-listed only' : 'all except blocked'}`,
      `- Dangerous mode: ${danger}`,
      `- Per-chat overrides: ${overrideCount}`
    ].join('\n')
  }

  /**
   * In-app `/clear`: wipe the active chat's messages but keep its id + saved
   * `memory.jsonl`, so the next turn starts fresh yet still remembers facts.
   */
  async clearActive(): Promise<void> {
    const active = this.state.active
    if (!active) return
    this.stop()
    await this.clearSavedThread(active.id)
    active.messages = []
    this.state.lastModel = null
    this.notify()
    await this.reloadThreads()
  }

  dispose(): void {
    this.disposed = true
    this.offChannel?.()
    this.offChannel = null
    this.offGuard?.()
    this.offGuard = null
    this.offToolProviders?.()
    this.offToolProviders = null
    if (this.dangerousTimer) clearTimeout(this.dangerousTimer)
    this.dangerousTimer = null
    for (const [id] of [...this.pending]) this.resolvePending(id, false)
    for (const run of this.runs.values()) {
      run.cancelled = true
      run.controller.abort()
      if (run.requestId) void this.api.assistant.cancel(run.requestId)
    }
    this.runs.clear()
    this.listeners.clear()
  }
}

export function getStore(api: ValleyPluginApi): AssistantStore {
  initRuntime(api)
  const holder = api.runtime.getOrCreate<{ current: AssistantStore | null }>(STORE_KEY, () => ({ current: null }))
  if (!holder.current) holder.current = new AssistantStore(api)
  return holder.current
}

export function disposeStore(): void {
  const holder = runtimeApi.runtime.getOrCreate<{ current: AssistantStore | null }>(STORE_KEY, () => ({ current: null }))
  holder.current?.dispose()
  holder.current = null
}

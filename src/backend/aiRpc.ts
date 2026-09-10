import { t } from './runtime'
import { withBackgroundOperation } from './runtime'
import { z } from 'zod'
import { startRun, cancelRun } from './exports'
import { ensureProviderPackages, getAiProvider as getProvider, reloadProviderPackages } from './providers'
import type { LlmProviderContext } from './providers/types'
import { addConnection, defaultConnectionId, listConnections, removeConnection, reorderConnections, resolveConnection, updateConnection } from './exports'
import { appendMemory, clearChat, deleteChat, deletePersonality, listChats, listPersonalities, readChat, readCommands, readConfig, readGuardOverrides, readMemory, readPersonality, renameChat, saveChat, saveCommands, saveGuardOverrides, savePersonality, setChatPinned, writeRule } from './exports'
import { appendGuardAudit, normalizeGuardPolicy, readGuardAudit, readGuardPolicy, saveGuardPolicy } from './exports'
import { ingestAttachment } from './exports'
import { addPending, listPending, removePending } from './exports'
import { backendApi } from './runtime'
const readPluginInventory = async (_root: string) => ({ plugins: await backendApi().plugins.list() })
import { applyPreset, diffPreset, findPreset, presetNeedsReview, skipPreset } from '@valley/plugin-sdk/guard/presets'
import type { GuardAuditEntry, GuardPluginPresetInfo } from '@valley/plugin-sdk/guard/types'
import { credentialEndpoint } from './secrets'
import { providerKey, setSecret } from './exports'
import { readUsage } from './exports'
import { cacheGet, cacheInvalidatePrefix, cacheSet, dedupeInFlight, readCacheStats, recordCacheHit } from './exports'
import type { AiModelInfo, AiProviderBalance } from '../types'
import { defineDriver, defineDriverMethod } from './contract'
import { createHarnessPackage, ensureHarnessPackages, listHarnessPackageStatuses, readHarnessPackage, reloadHarnessPackages, saveHarnessSettings, writeHarnessFile } from './exports'
import { clearHarnessCache } from './exports'
import { cancelHarnessRun, listHarnessRuns, readHarnessRun, startHarnessRun } from './exports'
import type { HarnessConfig, HarnessCreatePackage, HarnessManifest, HarnessSettingValue } from '../harnessTypes'

/** Cache TTLs — model lists rarely change; balances move with spend; completions are deterministic. */
const MODELS_TTL_MS = 24 * 60 * 60 * 1000
const BALANCE_TTL_MS = 120 * 1000

/**
 * Main-process AI capability behind the assistant plugin: starts streamed runs
 * (tokens/tool-calls flow back via `ai`/`stream` driver events), discovers
 * models, manages encrypted provider keys, and owns the `.valley/assistant`
 * config + chat store. Keys are write-only — never returned to the renderer.
 */
const provider = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)

const aiMessage = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  toolCalls: z
    .array(z.object({ id: z.string(), name: z.string(), arguments: z.record(z.unknown()) }))
    .optional(),
  toolCallId: z.string().optional(),
  name: z.string().optional(),
  render: z.enum(['quiz-image']).optional(),
  ts: z.number().optional(),
  attachments: z.array(z.object({ mime: z.string(), dataBase64: z.string() })).optional()
})

const quizPrompt = z.object({
  source: z.string(),
  choices: z.array(z.object({ value: z.string(), label: z.string() })),
  imagePath: z.string().optional()
})

/** A connection id is a file-safe slug — it keys a secret and a cache entry. */
const connectionId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
const harnessId = provider
const harnessTarget = z.object({ provider, connectionId: connectionId.optional(), model: z.string().min(1) }).strict()
const harnessBaseline = z.object({ mtimeMs: z.number(), size: z.number(), hash: z.string() }).strict().nullable()

const guardAuditEntry: z.ZodType<GuardAuditEntry> = z.object({
  ts: z.number(),
  caller: z.enum(['palette', 'hotkey', 'agent', 'telegram', 'plugin']),
  decision: z.enum(['allow', 'confirm', 'deny', 'bypass', 'expired', 'skipped']),
  source: z.enum(['hard-block', 'global-guard', 'profile', 'channel', 'chat', 'dangerous-mode', 'caller']),
  reason: z.string(),
  targetKind: z.enum(['tool', 'command', 'file']),
  targetId: z.string().optional(),
  path: z.string().optional(),
  fileOperation: z.enum(['list', 'search', 'open', 'read', 'create', 'write', 'delete']).optional(),
  pluginId: z.string().optional(),
  channelId: z.string().optional(),
  chatId: z.string().optional()
})

const chatRequest = z.object({
  requestId: z.string().min(1),
  provider,
  connectionId: connectionId.optional(),
  model: z.string().min(1),
  messages: z.array(aiMessage),
  tools: z
    .array(z.object({ name: z.string(), description: z.string(), parameters: z.record(z.unknown()) }))
    .optional(),
  web: z.boolean().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  baseUrl: z.string().optional(),
  origin: z.enum(['ui', 'channel']).optional(),
  conversationId: z.string().optional()
})

const modelRef = z.object({ provider, model: z.string(), connectionId: connectionId.optional() })

const routingConfig = z.object({
  auto: z.boolean(),
  default: modelRef,
  fast: modelRef.optional(),
  rules: z.array(
    z.object({
      label: z.string().optional(),
      match: z.array(z.string()).optional(),
      kind: z.string().optional(),
      minComplexity: z.number().optional(),
      provider,
      model: z.string(),
      connectionId: connectionId.optional()
    })
  )
})

/** A user-defined slash-command (prompt macro); main re-normalizes on save. */
const customCommand = z.object({
  name: z.string(),
  description: z.string().optional(),
  prompt: z.string()
})

const permission = z.enum(['allow', 'confirm', 'deny'])
const guardEntry = z.object({ decision: permission, allowPreApproval: z.boolean().optional() })
/** A per-chat/channel narrowing set (narrow-only — the resolver clamps it). */
const guardOverrides = z.object({
  tools: z.record(guardEntry).optional(),
  commands: z.record(guardEntry).optional(),
  fileReadOverrides: z.record(guardEntry).optional(),
  fileWriteOverrides: z.record(guardEntry).optional(),
  blocked: z.array(z.string()).optional()
})

const chatThread = z.object({
  id: z.string().min(1),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  model: modelRef.nullable().optional(),
  profileId: z.string().optional(),
  messages: z.array(aiMessage),
  source: z.enum(['telegram', 'whatsapp']).optional(),
  channelId: z.string().optional(),
  chatRef: z.string().optional(),
  channelName: z.string().optional(),
  commands: z.array(customCommand).optional(),
  quiz: quizPrompt.nullable().optional()
})

const personality = z.object({
  id: z.string().min(1),
  name: z.string(),
  isDefault: z.boolean(),
  instructions: z.string(),
  routing: routingConfig
})

const memoryEntry = z.object({
  id: z.string().min(1),
  summary: z.string(),
  confidence: z.number().optional(),
  sourceChatId: z.string().optional(),
  createdAt: z.number()
})

/** Resolve one connection's call context (base URL + key) through the same seam
 *  the engine uses, for the read-only balance/status methods. */
async function resolveProviderCtx(
  root: string,
  id: z.infer<typeof provider>,
  connectionId?: string
): Promise<LlmProviderContext> {
  const { credentialHandle, baseUrl } = await resolveConnection(root, { provider: id, connectionId })
  return { credentialHandle, baseUrl, vaultRoot: root }
}

/** A connection's balance, served from the short-TTL cache when fresh (else fetched
 *  and cached). Non-null balances only — a failed/absent balance is never cached.
 *  Concurrent identical fetches share one request (`dedupeInFlight`). The cache is
 *  keyed per connection: two keys on one provider have two different balances. */
async function cachedBalance(
  root: string,
  id: z.infer<typeof provider>,
  connectionId?: string
): Promise<AiProviderBalance | null> {
  await ensureProviderPackages(root)
  const p = getProvider(id)
  if (!p?.getBalance) return null
  const resolved = await resolveConnection(root, { provider: id, connectionId })
  const key = `balance:${resolved.connectionId}:${resolved.baseUrl}`
  return dedupeInFlight(key, async () => {
    const cached = await cacheGet<AiProviderBalance>(root, key)
    if (cached) {
      void withBackgroundOperation(root, () => recordCacheHit(root, 'balance'))
      return cached
    }
    try {
      const balance = await p.getBalance!({ credentialHandle: resolved.credentialHandle, baseUrl: resolved.baseUrl, vaultRoot: root })
      if (balance != null) await cacheSet(root, key, balance, BALANCE_TTL_MS)
      return balance
    } catch {
      return null
    }
  })
}

/** Drop every cached model list and balance for one connection — called whenever
 *  its credential or base URL changes, since both can change what discovery returns. */
async function invalidateConnection(root: string, connectionId: string): Promise<void> {
  await cacheInvalidatePrefix(root, `models:${connectionId}:`)
  await cacheInvalidatePrefix(root, `balance:${connectionId}:`)
}

/** Resolve one of a plugin's shipped guard presets by id (for review/apply/skip). */
async function findPluginPreset(root: string, pluginId: string, presetId: string) {
  const plugins = (await readPluginInventory(root)).plugins
  const manifest = plugins.find((p) => p.id === pluginId)
  const preset = manifest?.guardPresets ? findPreset(manifest.guardPresets, presetId) : undefined
  if (!preset) throw new Error(t('assistant.backend.missingPreset', { preset: presetId, plugin: pluginId }))
  return preset
}

export const aiDriver = defineDriver({
  reloadProviders: defineDriverMethod(z.object({}).optional(), async (root) => ({
    providers: await reloadProviderPackages(root)
  })),
  listHarnesses: defineDriverMethod(z.object({}).optional(), async (root) => {
    await ensureHarnessPackages(root)
    return { harnesses: listHarnessPackageStatuses() }
  }),
  readHarnessPackage: defineDriverMethod(z.object({ id: harnessId }), async (root, payload) => ({
    package: await readHarnessPackage(root, payload.id)
  })),
  createHarness: defineDriverMethod(z.object({ package: z.record(z.unknown()) }), async (root, payload) => {
    await createHarnessPackage(root, payload.package as unknown as HarnessCreatePackage)
    return { harnesses: await reloadHarnessPackages(root) }
  }),
  writeHarnessFile: defineDriverMethod(z.object({
    id: harnessId,
    path: z.string().min(1),
    content: z.string(),
    baseline: harnessBaseline
  }), (root, payload) => writeHarnessFile(root, payload.id, payload.path, payload.content, payload.baseline)),
  updateHarnessManifest: defineDriverMethod(z.object({
    id: harnessId,
    manifest: z.record(z.unknown()),
    baseline: harnessBaseline
  }), (root, payload) => {
    const manifest = payload.manifest as unknown as HarnessManifest
    if (manifest.id !== payload.id) throw new Error(t('assistant.backend.packageIdMismatch'))
    return writeHarnessFile(root, payload.id, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`, payload.baseline)
  }),
  updateHarnessConfig: defineDriverMethod(z.object({
    id: harnessId,
    config: z.record(z.unknown()),
    baseline: harnessBaseline
  }), (root, payload) => writeHarnessFile(
    root,
    payload.id,
    'config.json',
    `${JSON.stringify(payload.config as unknown as HarnessConfig, null, 2)}\n`,
    payload.baseline
  )),
  saveHarnessSettings: defineDriverMethod(z.object({
    id: harnessId,
    values: z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string())]))
  }), async (root, payload) => {
    await saveHarnessSettings(root, payload.id, payload.values as Record<string, HarnessSettingValue>)
    return { harnesses: await reloadHarnessPackages(root) }
  }),
  reloadHarnesses: defineDriverMethod(z.object({}).optional(), async (root) => ({
    harnesses: await reloadHarnessPackages(root)
  })),
  runHarness: defineDriverMethod(z.object({
    id: harnessId,
    targets: z.array(harnessTarget).min(1).max(32),
    options: z.object({ useCache: z.boolean().optional(), concurrency: z.number().int().positive().max(8).optional() }).optional()
  }), async (root, payload) => ({ run: await startHarnessRun(root, payload.id, payload.targets, payload.options) })),
  cancelHarnessRun: defineDriverMethod(z.object({ runId: z.string().min(1) }), (_root, payload) => ({ cancelled: cancelHarnessRun(payload.runId) })),
  listHarnessRuns: defineDriverMethod(z.object({ id: harnessId, limit: z.number().int().positive().max(50).optional() }), async (root, payload) => ({
    runs: await listHarnessRuns(root, payload.id, payload.limit)
  })),
  readHarnessRun: defineDriverMethod(z.object({ runId: z.string().min(1) }), async (root, payload) => ({
    run: await readHarnessRun(root, payload.runId)
  })),
  clearHarnessCache: defineDriverMethod(z.object({ id: harnessId }), async (root, payload) => {
    await clearHarnessCache(root, payload.id)
    return { ok: true }
  }),
  chat: defineDriverMethod(chatRequest, (root, payload) => {
      const req = payload
      void startRun(root, req)
      return { requestId: req.requestId }
    }),
  cancel: defineDriverMethod(z.object({ requestId: z.string() }), (_root, payload) => {
      cancelRun(payload.requestId)
    }),
  ingestAttachment: defineDriverMethod(z.object({
      path: z.string().min(1),
      kind: z.enum(['image', 'pdf', 'audio', 'file']),
      parser: z.string().optional()
    }), async (root, payload) => {
      const p = payload
      return ingestAttachment(root, p)
    }),
  // `baseUrl` overrides the saved value so the settings "Test connection" button can
  // probe exactly what's in the input box (live, before Save). `noCache`/`strict` make
  // Test meaningful: both bypass the cache (a cached OK must not mask a now-broken
  // endpoint), and `strict` makes discovery throw on a failed/unauthorized request
  // instead of silently falling back to the provider's static default list.
  listModels: defineDriverMethod(z.object({
      provider,
      connectionId: connectionId.optional(),
      baseUrl: z.string().optional(),
      noCache: z.boolean().optional(),
      strict: z.boolean().optional()
    }), async (root, payload) => {
      const { provider: id, connectionId: cid, baseUrl: override, noCache, strict } = payload
      await ensureProviderPackages(root)
      const p = getProvider(id)
      if (!p) throw new Error(t('assistant.backend.unknownProvider', { value: id }))
      const resolved = await resolveConnection(root, { provider: id, connectionId: cid })
      const baseUrl = override?.trim() || resolved.baseUrl
      // Cache the (slow/static) model list per connection+baseUrl. Ollama is skipped —
      // its list is the live local daemon, which changes as the user pulls models.
      const key = `models:${resolved.connectionId}:${baseUrl}`
      const skipCache = id === 'ollama' || noCache || strict
      // Dedupe concurrent identical discoveries (settings pane + router + status
      // probing at once) into a single network call.
      return dedupeInFlight(`${key}:${strict ? 1 : 0}:${skipCache ? 1 : 0}`, async () => {
        if (!skipCache) {
          const cached = await cacheGet<{ models: AiModelInfo[] }>(root, key)
          if (cached) {
            void withBackgroundOperation(root, () => recordCacheHit(root, 'modelList'))
            return cached
          }
        }
        const result = { models: await p.listModels({ credentialHandle: resolved.credentialHandle, baseUrl, vaultRoot: root, strict }) }
        if (id !== 'ollama') await cacheSet(root, key, result, MODELS_TTL_MS)
        return result
      })
    }),
  providerStatus: defineDriverMethod(z.object({}).optional(), async (root) => ({ providers: (await readConfig(root)).providers })),
  // ── Connections ────────────────────────────────────────────────────────────
  // A provider may hold any number of credentials; the connection, not the
  // provider, is what Settings lists and what usage is billed against. The
  // provider-grained `setKey`/`setBaseUrl` below stay as the default connection's
  // shorthand so every existing plugin/SDK caller keeps working.
  listConnections: defineDriverMethod(z.object({}).optional(), async (root) => ({ connections: await listConnections(root) })),
  addConnection: defineDriverMethod(z.object({ provider, label: z.string().optional() }), async (root, payload) => {
      const { provider: id, label } = payload
      return { connection: await addConnection(root, { provider: id, label }) }
    }),
  updateConnection: defineDriverMethod(z.object({
      connectionId,
      label: z.string().optional(),
      baseUrl: z.string().optional()
    }), async (root, payload) => {
      const { connectionId: id, ...patch } = payload
      await updateConnection(root, id, patch)
      if (patch.baseUrl !== undefined) await invalidateConnection(root, id)
      return { ok: true }
    }),
  /** Persist the connection list order (the stored array order is the order). */
  reorderConnections: defineDriverMethod(z.object({ connectionIds: z.array(connectionId) }), async (root, payload) => {
      await reorderConnections(root, payload.connectionIds)
      return { ok: true }
    }),
  removeConnection: defineDriverMethod(z.object({ connectionId }), async (root, payload) => {
      const { connectionId: id } = payload
      await removeConnection(root, id)
      await invalidateConnection(root, id)
      return { ok: true }
    }),
  /** Store (or clear, with `''`) one connection's API key. Write-only — never read back. */
  setConnectionKey: defineDriverMethod(z.object({ connectionId, key: z.string() }), async (root, payload) => {
      const { connectionId: id, key } = payload
      await setSecret(root, providerKey(id), key, [credentialEndpoint((await listConnections(root)).find((connection) => connection.id === id)?.baseUrl ?? (() => { throw new Error(t('assistant.backend.unknownConnection')) })())])
      // A new credential can change what discovery returns — drop stale metadata.
      await invalidateConnection(root, id)
      return { ok: true }
    }),
  setKey: defineDriverMethod(z.object({ provider, key: z.string() }), async (root, payload) => {
      const { provider: id, key } = payload
      await setSecret(root, providerKey(defaultConnectionId(id)), key, [credentialEndpoint((await listConnections(root)).find((connection) => connection.id === defaultConnectionId(id))?.baseUrl ?? (() => { throw new Error(t('assistant.backend.unknownConnection')) })())])
      await invalidateConnection(root, defaultConnectionId(id))
    }),
  setBaseUrl: defineDriverMethod(z.object({ provider, baseUrl: z.string() }), async (root, payload) => {
      const { provider: id, baseUrl } = payload
      await updateConnection(root, defaultConnectionId(id), { baseUrl })
      await invalidateConnection(root, defaultConnectionId(id))
    }),
  getConfig: defineDriverMethod(z.object({}).optional(), (root) => readConfig(root)),
  writeRule: defineDriverMethod(z.object({ name: z.string(), content: z.string() }), (root, payload) => {
      const { name, content } = payload
      return writeRule(root, name, content)
    }),
  // Guard policy (`guards.json`) — the single permission rule set. The payload is
  // validated loosely and normalized in main (tolerant: a partial object merges
  // onto defaults, hard-blocks are always re-seeded), so the renderer can never
  // persist a malformed or weakened policy.
  getGuard: defineDriverMethod(z.object({}).optional(), async (root) => ({ guard: await readGuardPolicy(root) })),
  saveGuard: defineDriverMethod(z.object({ policy: z.record(z.unknown()) }), async (root, payload) => {
      const policy = normalizeGuardPolicy(payload.policy)
      await saveGuardPolicy(root, policy)
      return { guard: policy }
    }),
  // Recent guard decisions (newest first) for the Guards Overview's audit list.
  getGuardAudit: defineDriverMethod(z.object({ limit: z.number().int().positive().max(500).optional() }).optional(), async (root, payload) => ({
      entries: await readGuardAudit(root, payload?.limit ?? 50)
    })),
  // Append one decision to the audit trail. The entry is shaped/normalized by the
  // renderer guard runtime (best-effort; main never throws on a malformed line).
  appendGuardAudit: defineDriverMethod(z.object({ entry: guardAuditEntry }), async (root, payload) => {
      await appendGuardAudit(root, payload.entry)
      return { ok: true }
    }),
  // Pending channel approvals (C8) — persisted to `.valley/assistant/runtime/` so a
  // Telegram button tapped after a restart is recognized (and the runtime trail is
  // legible). The live promise/resolver stays renderer-side; only this record is on disk.
  addPending: defineDriverMethod(z.object({
      record: z.object({
        requestId: z.string().min(1),
        channelId: z.string().optional(),
        chatRef: z.string().optional(),
        chatId: z.string(),
        actionLabel: z.string(),
        createdAt: z.number(),
        expiresAt: z.number()
      })
    }), async (root, payload) => {
      await addPending(root, payload.record)
      return { ok: true }
    }),
  removePending: defineDriverMethod(z.object({ requestId: z.string().min(1) }), async (root, payload) => {
      await removePending(root, payload.requestId)
      return { ok: true }
    }),
  listPending: defineDriverMethod(z.object({}).optional(), async (root) => ({ pending: await listPending(root) })),
  // Plugin guard presets (C15): the snapshot the Guards "Plugin presets" panel
  // renders — which plugins ship presets, their applied/skipped state, and whether
  // a newer version needs review. The command/tool catalog itself is built
  // renderer-side (from getAllCommands + the assistant tool catalog).
  getPluginPresets: defineDriverMethod(z.object({}).optional(), async (root) => {
      const [inventory, policy] = await Promise.all([readPluginInventory(root), readGuardPolicy(root)])
      const plugins = inventory.plugins
      const out: GuardPluginPresetInfo[] = plugins
        .filter((p) => p.guardPresets && p.guardPresets.presets.length > 0)
        .map((p) => ({
          pluginId: p.id,
          pluginName: p.name,
          enabled: p.enabled,
          defaultPreset: p.guardPresets!.defaultPreset,
          presets: p.guardPresets!.presets,
          applied: policy.pluginPresets[p.id],
          needsReview: presetNeedsReview(policy, p.id, p.guardPresets!)
        }))
      return { plugins: out }
    }),
  // Compute (but don't apply) the changes a preset would make — the review diff.
  reviewPluginPreset: defineDriverMethod(z.object({ pluginId: z.string(), presetId: z.string() }), async (root, payload) => {
      const { pluginId, presetId } = payload
      const preset = await findPluginPreset(root, pluginId, presetId)
      const policy = await readGuardPolicy(root)
      return { changes: diffPreset(policy, pluginId, preset) }
    }),
  // Copy a preset's entries into the central guards.json (expanding bare command
  // ids to <pluginId>:<id>) and stamp the review metadata.
  applyPluginPreset: defineDriverMethod(z.object({ pluginId: z.string(), presetId: z.string() }), async (root, payload) => {
      const { pluginId, presetId } = payload
      const preset = await findPluginPreset(root, pluginId, presetId)
      const policy = await readGuardPolicy(root)
      const next = applyPreset(policy, pluginId, preset, Date.now())
      await saveGuardPolicy(root, next)
      return { guard: next }
    }),
  // Mark a preset skipped so the review prompt stays quiet until its version advances.
  skipPluginPreset: defineDriverMethod(z.object({ pluginId: z.string(), presetId: z.string() }), async (root, payload) => {
      const { pluginId, presetId } = payload
      const preset = await findPluginPreset(root, pluginId, presetId)
      const policy = await readGuardPolicy(root)
      const next = skipPreset(policy, pluginId, preset, Date.now())
      await saveGuardPolicy(root, next)
      return { guard: next }
    }),
  listChats: defineDriverMethod(z.object({}).optional(), async (root) => ({ chats: await listChats(root) })),
  readChat: defineDriverMethod(z.object({ id: z.string() }), async (root, payload) => ({ thread: await readChat(root, payload.id) })),
  saveChat: defineDriverMethod(z.object({ thread: chatThread }), (root, payload) => saveChat(root, payload.thread)),
  renameChat: defineDriverMethod(z.object({ id: z.string(), title: z.string() }), (root, payload) => renameChat(root, payload.id, payload.title)),
  deleteChat: defineDriverMethod(z.object({ id: z.string() }), (root, payload) => deleteChat(root, payload.id)),
  // `/clear`: wipe a chat's active context but keep its long-term memory.jsonl.
  clearChat: defineDriverMethod(z.object({ id: z.string() }), (root, payload) => clearChat(root, payload.id)),
  setChatPinned: defineDriverMethod(z.object({ id: z.string(), pinned: z.boolean() }), (root, payload) => setChatPinned(root, payload.id, payload.pinned)),
  // Per-chat guard overrides (`guard-overrides.json`) — remembered approval choices
  // (narrow-only; the resolver clamps them and main re-enforces the global ceiling).
  readGuardOverrides: defineDriverMethod(z.object({ chatId: z.string() }), async (root, payload) => ({ overrides: await readGuardOverrides(root, payload.chatId) })),
  saveGuardOverrides: defineDriverMethod(z.object({ chatId: z.string(), overrides: guardOverrides }), async (root, payload) => {
      const { chatId, overrides } = payload
      await saveGuardOverrides(root, { id: chatId }, overrides)
      return { ok: true }
    }),
  // ── Personalities (Meadow/Chorus/Personalities/<id>/) ────────────────────────
  listPersonalities: defineDriverMethod(z.object({}).optional(), async (root) => ({ personalities: await listPersonalities(root) })),
  readPersonality: defineDriverMethod(z.object({ id: z.string() }), async (root, payload) => ({ personality: await readPersonality(root, payload.id) })),
  savePersonality: defineDriverMethod(z.object({ personality }), (root, payload) => savePersonality(root, payload.personality)),
  deletePersonality: defineDriverMethod(z.object({ id: z.string() }), (root, payload) => deletePersonality(root, payload.id)),
  // ── Overall custom commands (Meadow/Chorus/commands.json) ────────────────────
  listCommands: defineDriverMethod(z.object({}).optional(), async (root) => ({ commands: await readCommands(root) })),
  saveCommands: defineDriverMethod(z.object({ commands: z.array(customCommand) }), async (root, payload) => {
      await saveCommands(root, payload.commands)
      return { ok: true }
    }),
  // ── Memory (per-chat memory.jsonl; explicit summarize flow) ──────────────────
  // Writes are re-checked against the file guard in main (memory lives under
  // Meadow/Chorus), so a `deny`/hard-block is honored regardless of the renderer.
  appendMemory: defineDriverMethod(z.object({ chatId: z.string(), entry: memoryEntry }), async (root, payload) => {
      const { chatId, entry } = payload
      await appendMemory(root, { id: chatId }, entry)
      return { ok: true }
    }),
  readMemory: defineDriverMethod(z.object({ chatId: z.string() }), async (root, payload) => ({ memory: await readMemory(root, payload.chatId) })),
  // Usage/cost is metered in the engine and stored encrypted in userData (not
  // the vault). The renderer can only read aggregates and set the budget —
  // there is intentionally no `recordUsage` channel, so spend can't be forged.
  getUsage: defineDriverMethod(z.object({}).optional(), () => readUsage()),
  // Live remaining balance for one provider (DeepSeek/Kimi expose one; others →
  // null). Timeout-guarded in the adapter; never throws.
  getBalance: defineDriverMethod(z.object({ provider, connectionId: connectionId.optional() }), async (root, payload) => {
      const { provider: id, connectionId: cid } = payload
      return { provider: id, connectionId: cid, balance: await cachedBalance(root, id, cid) }
    }),
  // Safe API-metadata cache stats surfaced in Usage & Billing.
  getCacheStats: defineDriverMethod(z.object({}).optional(), (root) => readCacheStats(root)),
  // Ollama daemon reachability + installed models, for the "is it running" card.
  ollamaStatus: defineDriverMethod(z.object({ connectionId: connectionId.optional() }).optional(), async (root, payload) => {
      const cid = payload?.connectionId
      await ensureProviderPackages(root)
      const p = getProvider('ollama')
      const { baseUrl } = await resolveConnection(root, { provider: 'ollama', connectionId: cid })
      if (!p?.getStatus) return { running: false, models: [], baseUrl }
      return p.getStatus(await resolveProviderCtx(root, 'ollama', cid))
    })
})

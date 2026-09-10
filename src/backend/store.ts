import { t } from './runtime'
import * as fs from './filesystem'
import path from 'path-browserify'
import type { AiChatSummary, AiChatSource, AiChatThread, AiConnection, AiConnectionStatus, AiMemoryEntry, AiMessage, AiModelInfo, AiPersonality, AiProviderId, AiProviderStatus, AssistantConfig, CustomCommand, RoutingConfig } from '../types'
import type { GuardOverrides } from '@valley/plugin-sdk/guard/types'
import { atomicWriteFile } from './filesystem'
import {
  chatDir,
  chorusChannelsDir,
  chorusChatsDir,
  chorusCommandsPath,
  isSafeName,
  personalitiesDir,
  personalityDir,
  providersPath,
  readmePath,
  rulesDir,
  safeSegment
} from './paths'
import { guardFilePath, readGuardPolicy } from './guards'
import { queuedAppendJsonl, queuedWrite, queuedWriteJson, runExclusive } from './fileQueue'
import { ensureProviderPackages, getAiProvider, listAiProviders } from './providers'
import { normalizeBaseUrl } from './providers/tooling'
import { backendApi } from './runtime'
import { credentialEndpoint, deleteSecret, getCredential, providerKey, secretState } from './secrets'

/**
 * Owns the `.valley/assistant/` config + chat store — the single legible home of
 * the "Orchestra". Reads/writes rules, routing, the non-secret per-provider
 * config, and saved chat threads. Required directories are scaffolded
 * on first run (see `ensureScaffold`). Config is re-read on demand so editing a
 * rule file on disk takes effect on the next message without a restart.
 */

// ── Defaults ───────────────────────────────────────────────────────────────

export const DEFAULT_ROUTING: RoutingConfig = {
  auto: true,
  default: { provider: 'anthropic', model: 'claude-opus-4-8' },
  fast: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  rules: [
    { label: 'Deep planning / hard problems', kind: 'plan', minComplexity: 4, provider: 'anthropic', model: 'claude-opus-4-8' },
    { label: 'Coding & tool-heavy work', kind: 'code', provider: 'anthropic', model: 'claude-opus-4-8' },
    { label: 'Quick questions / chit-chat', kind: 'quick', provider: 'anthropic', model: 'claude-haiku-4-5' }
  ]
}

const DEFAULT_INSTRUCTIONS = `# Valley Assistant — instructions

You are the Valley assistant inside the user's personal knowledge and life app.
You can both *answer* and *act*: you have tools to read and edit the vault, control
music, read mail, manage calendar & todos, change settings, and run any app command.

## You are conducted by the user ("Mother of the orchestra")

The user sets the rules. This file plus everything under \`rules/\` is your standing
brief — read it as your operating manual. \`routing.json\` decides which model plays
which part; you focus on doing the work well.

## How to break down complex tasks

1. Restate the goal in one sentence. If it is ambiguous in a way that changes the
   outcome, ask one sharp question; otherwise proceed.
2. Decompose into the smallest sequence of concrete steps that each map to a tool.
3. Take read-only actions freely to gather context before acting.
4. For each step that changes something, do it, observe the result, then continue.
5. End by stating what you did, plainly — no filler.

## Acting safely

- Read/search/open/play are instant.
- Anything that *changes* state (sending mail, writing or deleting notes, changing a
  setting, running a command) asks for confirmation unless the user pre-approved it.
- Never invent file paths or data — look them up with a tool first.

## Registered tools

- Use the available tool descriptions to choose the action that directly matches
  the request, including tools contributed by installed plugins.
- Omit unknown optional arguments rather than sending placeholder strings.
- Report the observed tool result concisely after it succeeds.

## Tone

Direct and concise. Lead with the answer. No emojis unless asked. Match the user's
language (German or English).
`

const DEFAULT_README = `# .valley/assistant — private Assistant state

User-facing conversations and personalities live under Meadow/Chorus. This folder
contains private runtime configuration and readable provider packages.

- **rules/*.md** — extra always-on instruction snippets, one concern per file
  (e.g. tone, a project's conventions). All are appended to instructions.
- **guards.json** — the Guard permission policy.
- **assistant.json** — provider connections and ordering.
- **provider-secrets.json** — encrypted AI API keys. Do not edit by hand.
- **secrets.json** — encrypted assistant channel tokens. Do not edit by hand.
- **providers/** — readable manifest packages discovered at startup or manual reload.
- **runtime/** — transient turn recovery; rebuildable data is under ../cache/.
`

interface ProvidersConfigFile {
  connections?: AiConnection[]
}

// ── Low-level read/write ─────────────────────────────────────────────────────

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  const text = await readText(file)
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await atomicWriteFile(file, content)
}

/**
 * Coerce arbitrary input into a clean `CustomCommand[]`: trims, lower-cases and
 * slug-validates each name (`[a-z0-9_-]`, no leading slash), drops entries with an
 * empty name or prompt and duplicate names, and caps the list. Shared by the
 * overall-commands store and the per-connection channel config so a malformed
 * file or renderer payload can never corrupt the dispatch path.
 */
export function normalizeCommands(input: unknown): CustomCommand[] {
  if (!Array.isArray(input)) return []
  const out: CustomCommand[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const name = String(r.name ?? '').trim().toLowerCase().replace(/^\/+/, '')
    const prompt = String(r.prompt ?? '')
    if (!/^[a-z0-9_-]+$/.test(name) || !prompt.trim() || seen.has(name)) continue
    seen.add(name)
    const cmd: CustomCommand = { name, prompt }
    const description = String(r.description ?? '').trim()
    if (description) cmd.description = description
    out.push(cmd)
    if (out.length >= 100) break
  }
  return out
}

/** Write any missing default files on first run. Never overwrites existing edits. */
export async function ensureScaffold(vaultRoot: string): Promise<void> {
  await fs.mkdir(rulesDir(vaultRoot), { recursive: true })
  const seed: [string, string][] = [
    [providersPath(vaultRoot), JSON.stringify({ connections: [] } satisfies ProvidersConfigFile, null, 2)],
    [readmePath(vaultRoot), DEFAULT_README],
    [path.join(rulesDir(vaultRoot), 'tone.md'), '# Tone\n\nBe concise and direct. Lead with the answer. No emojis unless asked.\n']
  ]
  for (const [file, content] of seed) {
    if ((await readText(file)) === null) await writeFileAtomic(file, content)
  }
}

// ── Connections ──────────────────────────────────────────────────────────────
//
// A connection is one credential for a provider, and a provider may hold any
// number of them. **The provider's default connection carries the provider's own
// id**, which is the whole reason nothing had to migrate: `provider:anthropic`
// was already the default connection's secret key, and `anthropic:<model>` was
// already its model ref.

/** The id of the provider's seeded default connection — the provider id itself. */
export const defaultConnectionId = (provider: AiProviderId): string => provider

/** A connection id is a file-safe slug so it can key a secret and a cache entry. */
const isConnectionId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)

function newConnectionId(provider: AiProviderId, taken: ReadonlySet<string>): string {
  const base = defaultConnectionId(provider)
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error(t('assistant.backend.connectionLimit', { value: provider }))
}

/** A stored base URL, falling back to the provider default when absent or malformed. */
function resolveBaseUrl(provider: AiProviderId, stored?: string): string {
  const adapter = getAiProvider(provider)
  if (!adapter) throw new Error(t('assistant.backend.unknownProvider', { value: provider }))
  if (!stored) return adapter.defaultBaseUrl
  try {
    return normalizeBaseUrl(stored)
  } catch {
    return adapter.defaultBaseUrl
  }
}

async function readConnections(vaultRoot: string): Promise<AiConnection[]> {
  await ensureProviderPackages(vaultRoot)
  const cfg = await readJson<ProvidersConfigFile>(providersPath(vaultRoot), {})
  const providers = listAiProviders()
  const providerIds = new Set(providers.map((provider) => provider.id))
  const stored = (cfg.connections ?? []).filter(
    (c): c is AiConnection => Boolean(c) && isConnectionId(c.id) && providerIds.has(c.provider)
  )
  const seen = new Set(stored.map((c) => c.id))
  const out = [...stored]
  // Every provider always offers at least its default connection, so a provider
  // with no credential yet is still listable and addable.
  for (const adapter of providers) {
    const provider = adapter.id
    if (out.some((c) => c.provider === provider)) continue
    const id = defaultConnectionId(provider)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      provider,
      createdAt: 0
    })
  }
  return out
}

async function writeConnections(vaultRoot: string, connections: AiConnection[]): Promise<void> {
  const cfg = await readJson<ProvidersConfigFile>(providersPath(vaultRoot), {})
  cfg.connections = connections
  await writeFileAtomic(providersPath(vaultRoot), JSON.stringify(cfg, null, 2))
}

/**
 * The one place a credential and base URL are resolved. Precedence is unchanged
 * from the pre-connections engine: an env key wins over a saved one, and the
 * stored base URL wins over the provider default. An unknown `connectionId`
 * degrades to the provider's default connection rather than throwing, so a chat
 * pinned to a since-deleted connection keeps running.
 */
export async function resolveConnection(
  vaultRoot: string,
  ref: { provider: AiProviderId; connectionId?: string; capability?: string }
): Promise<{ connectionId: string; provider: AiProviderId; credentialHandle: string | null; baseUrl: string }> {
  const connections = await readConnections(vaultRoot)
  const match =
    (ref.connectionId ? connections.find((c) => c.id === ref.connectionId) : undefined) ??
    connections.find((c) => c.id === defaultConnectionId(ref.provider)) ??
    connections.find((c) => c.provider === ref.provider)
  const connectionId = match?.id ?? defaultConnectionId(ref.provider)
  const baseUrl = resolveBaseUrl(ref.provider, match?.baseUrl)
  const account = (await backendApi().accounts.list()).find((entry) => entry.id === connectionId && entry.provider === ref.provider)
  const saved = await secretState(vaultRoot, providerKey(connectionId))
  let credentialHandle: string | null = null
  if (account?.credentialState === 'ok') credentialHandle = await backendApi().accounts.authorize(connectionId, ref.capability ?? 'ai.chat', credentialEndpoint(baseUrl))
  else if (saved === 'ok') credentialHandle = await getCredential(vaultRoot, providerKey(connectionId), [credentialEndpoint(baseUrl)])
  return { connectionId, provider: ref.provider, credentialHandle, baseUrl }
}

/** Every connection with its non-secret credential status and resolved models. */
export async function listConnections(vaultRoot: string): Promise<AiConnectionStatus[]> {
  const connections = await readConnections(vaultRoot)
  const accounts = await backendApi().accounts.list()
  const out: AiConnectionStatus[] = []
  for (const connection of connections) {
    const provider = getAiProvider(connection.provider)
    if (!provider) continue
    const baseUrl = resolveBaseUrl(connection.provider, connection.baseUrl)
    const pinned: AiModelInfo[] | undefined = connection.models?.map((m) => ({
      provider: connection.provider,
      id: m.id,
      label: m.label,
      tools: true
    }))
    let models = pinned?.length ? pinned : provider.defaultModels
    if (connection.provider === 'ollama') models = await provider.listModels({ credentialHandle: null, baseUrl, vaultRoot })
    const keyState = await secretState(vaultRoot, providerKey(connection.id))
    const keyed = keyState === 'ok'
    const unreadable = keyState === 'unreadable'
    const account = accounts.find((entry) => entry.id === connection.id && entry.provider === connection.provider)
    const envKeyed = account?.credentialState === 'ok' && Boolean(account.credentialSource && !account.credentialSource.startsWith('provider:'))
    out.push({
      id: connection.id,
      provider: connection.provider,
      ...(connection.label ? { label: connection.label } : {}),
      createdAt: connection.createdAt,
      configured: envKeyed || keyed || !provider.requiresKey,
      authMode: envKeyed ? 'env' : keyed ? 'key' : 'none',
      authSources: {
        envKey: envKeyed,
        savedKey: keyed || unreadable,
        ...(unreadable ? { savedKeyUnreadable: true } : {})
      },
      baseUrl,
      models,
      providerName: provider.label,
      providerDescription: provider.description ?? '',
      providerIcon: provider.icon ?? 'extension',
      requiresKey: provider.requiresKey,
      providerCapabilities: provider.capabilities ?? [],
      ...(provider.settingsUrl ? { providerSettingsUrl: provider.settingsUrl } : {})
    })
  }
  return out
}

/** Add a connection for a provider and return it (the id is derived, never supplied). */
export async function addConnection(
  vaultRoot: string,
  input: { provider: AiProviderId; label?: string }
): Promise<AiConnection> {
  await ensureProviderPackages(vaultRoot)
  if (!getAiProvider(input.provider)) throw new Error(t('assistant.backend.unknownProvider', { value: input.provider }))
  const connections = await readConnections(vaultRoot)
  const connection: AiConnection = {
    id: newConnectionId(input.provider, new Set(connections.map((c) => c.id))),
    provider: input.provider,
    ...(input.label?.trim() ? { label: input.label.trim() } : {}),
    createdAt: Date.now()
  }
  await writeConnections(vaultRoot, [...connections, connection])
  return connection
}

/** Patch a connection's label / base URL / pinned models. `provider` and `id` are fixed. */
export async function updateConnection(
  vaultRoot: string,
  id: string,
  patch: { label?: string; baseUrl?: string; models?: { id: string; label?: string }[] }
): Promise<void> {
  const connections = await readConnections(vaultRoot)
  const next = connections.map((c) => {
    if (c.id !== id) return c
    const updated: AiConnection = { ...c }
    if (patch.label !== undefined) {
      const label = patch.label.trim()
      if (label) updated.label = label
      else delete updated.label
    }
    if (patch.baseUrl !== undefined) {
      // '' resets to the provider default; a malformed value is rejected loudly
      // here rather than silently falling back on every later read.
      if (patch.baseUrl.trim()) updated.baseUrl = normalizeBaseUrl(patch.baseUrl)
      else delete updated.baseUrl
    }
    if (patch.models !== undefined) {
      if (patch.models.length) updated.models = patch.models
      else delete updated.models
    }
    return updated
  })
  await writeConnections(vaultRoot, next)
}

/**
 * Rewrite the stored order to match `ids`. The array order in `assistant.json`'s
 * `connections` *is* the display order, so there is no separate order field to
 * drift. Unknown ids are ignored and any connection `ids` omits keeps its
 * relative position at the end, so a stale renderer list can never drop one.
 */
export async function reorderConnections(vaultRoot: string, ids: string[]): Promise<void> {
  const connections = await readConnections(vaultRoot)
  const byId = new Map(connections.map((c) => [c.id, c]))
  const ordered: AiConnection[] = []
  for (const id of ids) {
    const connection = byId.get(id)
    if (connection && !ordered.includes(connection)) ordered.push(connection)
  }
  for (const connection of connections) if (!ordered.includes(connection)) ordered.push(connection)
  await writeConnections(vaultRoot, ordered)
}

/**
 * Forget a connection and its credential. The provider's default connection is
 * never removed — it is the fallback `resolveConnection` degrades to — so
 * removing it only clears its key.
 */
export async function removeConnection(vaultRoot: string, id: string): Promise<void> {
  await deleteSecret(vaultRoot, providerKey(id))
  const connections = await readConnections(vaultRoot)
  const target = connections.find((c) => c.id === id)
  if (!target) return
  if (id === defaultConnectionId(target.provider)) {
    await updateConnection(vaultRoot, id, { label: '', baseUrl: '', models: [] })
    return
  }
  await writeConnections(vaultRoot, connections.filter((c) => c.id !== id))
}

// ── Providers ────────────────────────────────────────────────────────────────

/** A provider's base URL — its default connection's. Writes go through
 *  `updateConnection`, which is connection-grained. */
export async function getProviderBaseUrl(vaultRoot: string, id: AiProviderId): Promise<string> {
  return (await resolveConnection(vaultRoot, { provider: id })).baseUrl
}

/**
 * Per-provider status: configured?/baseUrl/models — never includes the key. Kept
 * as the provider-grained view of the connection list (a provider counts as
 * configured when *any* of its connections is), so the plugin SDK's
 * `providerStatus()` and every existing consumer read exactly what they did
 * before connections existed.
 */
export async function readProviderStatus(vaultRoot: string): Promise<AiProviderStatus[]> {
  return providerStatusFrom(await listConnections(vaultRoot))
}

/** Collapse a connection list to one row per provider. */
function providerStatusFrom(connections: AiConnectionStatus[]): AiProviderStatus[] {
  return listAiProviders().map((provider) => {
    const id = provider.id
    const mine = connections.filter((c) => c.provider === id)
    const primary = mine.find((c) => c.configured) ?? mine.find((c) => c.id === defaultConnectionId(id)) ?? mine[0]
    return {
      provider: id,
      configured: mine.some((c) => c.configured),
      authMode: primary?.authMode ?? 'none',
      authSources: {
        envKey: mine.some((c) => c.authSources?.envKey),
        savedKey: mine.some((c) => c.authSources?.savedKey),
        ...(mine.some((c) => c.authSources?.savedKeyUnreadable) ? { savedKeyUnreadable: true } : {})
      },
      baseUrl: primary?.baseUrl ?? provider.defaultBaseUrl,
      // Model ids are provider-wide, so the primary connection's list is the
      // provider's list — two keys on one provider never see different models.
      models: primary?.models ?? provider.defaultModels,
      name: provider.label,
      description: provider.description ?? '',
      icon: provider.icon ?? 'extension',
      capabilities: provider.capabilities ?? []
    }
  })
}

// ── Rules ────────────────────────────────────────────────────────────────────

async function readRules(vaultRoot: string): Promise<{ name: string; content: string }[]> {
  try {
    const files = await fs.readdir(rulesDir(vaultRoot))
    const rules: { name: string; content: string }[] = []
    for (const file of files.sort()) {
      if (!file.endsWith('.md')) continue
      const content = await readText(path.join(rulesDir(vaultRoot), file))
      if (content != null) rules.push({ name: file.replace(/\.md$/, ''), content })
    }
    return rules
  } catch {
    return []
  }
}

export async function writeRule(vaultRoot: string, name: string, content: string): Promise<void> {
  if (!isSafeName(name)) throw new Error(t('assistant.backend.invalidRule', { value: name }))
  await writeFileAtomic(path.join(rulesDir(vaultRoot), `${name}.md`), content)
}

// ── Personalities (Meadow/Chorus/Personalities/<id>/) ────────────────────────
// Reusable profiles: name · default flag · instructions · routing.

export const DEFAULT_PROFILE_ID = 'default'

function profilePath(vaultRoot: string, id: string): string {
  return path.join(personalityDir(vaultRoot, id), 'profile.json')
}
function profileInstructionsPath(vaultRoot: string, id: string): string {
  return path.join(personalityDir(vaultRoot, id), 'instructions.md')
}
function profileRoutingPath(vaultRoot: string, id: string): string {
  return path.join(personalityDir(vaultRoot, id), 'routing.json')
}

export async function readPersonality(vaultRoot: string, id: string): Promise<AiPersonality | null> {
  if (!isSafeName(id)) return null
  const profile = await readJson<{ id?: string; name?: string; isDefault?: boolean } | null>(profilePath(vaultRoot, id), null)
  if (!profile) return null
  const rel = (abs: string): string => path.relative(vaultRoot, abs).split(path.sep).join('/')
  return {
    id,
    name: typeof profile.name === 'string' && profile.name ? profile.name : id,
    isDefault: profile.isDefault === true,
    instructions: (await readText(profileInstructionsPath(vaultRoot, id))) ?? DEFAULT_INSTRUCTIONS,
    routing: await readJson<RoutingConfig>(profileRoutingPath(vaultRoot, id), DEFAULT_ROUTING),
    instructionsPath: rel(profileInstructionsPath(vaultRoot, id)),
    routingPath: rel(profileRoutingPath(vaultRoot, id))
  }
}

export async function listPersonalities(vaultRoot: string): Promise<AiPersonality[]> {
  let names: string[]
  try {
    names = (await fs.readdir(personalitiesDir(vaultRoot), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
  const out: AiPersonality[] = []
  for (const name of names.sort()) {
    const p = await readPersonality(vaultRoot, name)
    if (p) out.push(p)
  }
  // The default profile sorts first; everything else alphabetically.
  return out.sort((a, b) => (a.isDefault === b.isDefault ? a.name.localeCompare(b.name) : a.isDefault ? -1 : 1))
}

export async function savePersonality(vaultRoot: string, p: AiPersonality): Promise<void> {
  if (!isSafeName(p.id)) throw new Error(t('assistant.backend.invalidPersonality', { value: p.id }))
  // Exactly one default: clearing the flag on the others when this one claims it.
  if (p.isDefault) {
    for (const other of await listPersonalities(vaultRoot)) {
      if (other.id !== p.id && other.isDefault) {
        await queuedWriteJson(profilePath(vaultRoot, other.id), { id: other.id, name: other.name, isDefault: false })
      }
    }
  }
  await queuedWrite(profileInstructionsPath(vaultRoot, p.id), p.instructions)
  await queuedWriteJson(profileRoutingPath(vaultRoot, p.id), p.routing)
  await queuedWriteJson(profilePath(vaultRoot, p.id), { id: p.id, name: p.name, isDefault: p.isDefault })
}

export async function deletePersonality(vaultRoot: string, id: string): Promise<void> {
  if (!isSafeName(id) || id === DEFAULT_PROFILE_ID) return // the default is never deletable
  await fs.rm(personalityDir(vaultRoot, id), { recursive: true, force: true })
}

// ── Overall custom commands (Meadow/Chorus/commands.json) ────────────────────
// User-defined slash-commands shared by every chat (narrowed by per-connection
// and per-chat command lists at dispatch time). Legible, hand-editable JSON.

export async function readCommands(vaultRoot: string): Promise<CustomCommand[]> {
  return normalizeCommands(await readJson<unknown>(chorusCommandsPath(vaultRoot), []))
}

export async function saveCommands(vaultRoot: string, commands: CustomCommand[]): Promise<void> {
  await queuedWriteJson(chorusCommandsPath(vaultRoot), normalizeCommands(commands))
}

// ── Config (aggregate) ───────────────────────────────────────────────────────

export async function readConfig(vaultRoot: string): Promise<AssistantConfig> {
  await ensureScaffold(vaultRoot)
  const [instructions, rules, routing, guard, connections] = await Promise.all([
    readText(profileInstructionsPath(vaultRoot, DEFAULT_PROFILE_ID)).then((t) => t ?? DEFAULT_INSTRUCTIONS),
    readRules(vaultRoot),
    readJson<RoutingConfig>(profileRoutingPath(vaultRoot, DEFAULT_PROFILE_ID), DEFAULT_ROUTING),
    readGuardPolicy(vaultRoot),
    listConnections(vaultRoot)
  ])
  // `providers` is derived from the same snapshot rather than re-read, so the two
  // views can never disagree about what is configured.
  return { instructions, rules, routing, guard, connections, providers: providerStatusFrom(connections) }
}

export async function saveInstructions(vaultRoot: string, content: string): Promise<void> {
  await queuedWrite(profileInstructionsPath(vaultRoot, DEFAULT_PROFILE_ID), content)
}

// ── Chats (Meadow/Chorus folders) ────────────────────────────────────────────
// Each chat is a folder: `settings.json` (meta), an append-only `thread.jsonl`
// (messages, C12), and an optional `memory.jsonl`. App chats live under
// `Chats/<id>/`; remote-channel chats split under `Channels/<channelId>/<chatRef>/`.

/** The standalone settings.json shape (the meta, minus the messages). */
interface ChatMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  model?: { provider: AiProviderId; model: string } | null
  profileId?: string
  source?: AiChatSource
  channelId?: string
  chatRef?: string
  channelName?: string
  commands?: CustomCommand[]
  pinned?: boolean
}

const SETTINGS_FILE = 'settings.json'
const THREAD_FILE = 'thread.jsonl'
const MEMORY_FILE = 'memory.jsonl'
const GUARD_OVERRIDES_FILE = 'guard-overrides.json'

const settingsFile = (dir: string): string => path.join(dir, SETTINGS_FILE)
const threadFile = (dir: string): string => path.join(dir, THREAD_FILE)
const memoryFile = (dir: string): string => path.join(dir, MEMORY_FILE)
const guardOverridesFile = (dir: string): string => path.join(dir, GUARD_OVERRIDES_FILE)

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

function metaOf(thread: AiChatThread): ChatMeta {
  return {
    id: thread.id,
    title: thread.title,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    model: thread.model ?? null,
    profileId: thread.profileId,
    source: thread.source,
    channelId: thread.channelId,
    chatRef: thread.chatRef,
    channelName: thread.channelName,
    commands: thread.commands?.length ? normalizeCommands(thread.commands) : undefined,
    pinned: thread.pinned
  }
}

function threadFromMeta(meta: ChatMeta, messages: AiMessage[]): AiChatThread {
  return {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    model: meta.model,
    profileId: meta.profileId,
    messages,
    source: meta.source,
    channelId: meta.channelId,
    chatRef: meta.chatRef,
    channelName: meta.channelName,
    commands: meta.commands?.length ? meta.commands : undefined,
    pinned: meta.pinned
  }
}

/** Tolerant parse of one folder's `settings.json` → meta (null if absent/invalid). */
async function readMeta(dir: string): Promise<ChatMeta | null> {
  const meta = await readJson<ChatMeta | null>(settingsFile(dir), null)
  return meta && typeof meta.id === 'string' ? meta : null
}

/** Tolerant parse of `thread.jsonl` → messages (skips malformed lines). */
async function readThreadMessages(dir: string): Promise<AiMessage[]> {
  const text = await readText(threadFile(dir))
  if (!text) return []
  const messages: AiMessage[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      messages.push(JSON.parse(line) as AiMessage)
    } catch {
      // skip a malformed message line
    }
  }
  return messages
}

/**
 * Resolve a chat id to its on-disk folder. App chats are addressed directly
 * (`Chats/<id>/`); a remote-channel id (`tg-…` / `wa-…`) is not reliably
 * parseable, so we scan `Channels/<*>/<*>/` for a matching `settings.json`.
 * Returns null when the chat does not exist.
 */
async function resolveChatDir(vaultRoot: string, id: string): Promise<string | null> {
  if (!isSafeName(id)) return null
  const appDir = path.join(chorusChatsDir(vaultRoot), safeSegment(id))
  if (await pathExists(settingsFile(appDir))) return appDir
  let channels: import('./filesystem').DirectoryEntry[]
  try {
    channels = await fs.readdir(chorusChannelsDir(vaultRoot), { withFileTypes: true })
  } catch {
    return null
  }
  for (const ch of channels) {
    if (!ch.isDirectory()) continue
    let refs: import('./filesystem').DirectoryEntry[]
    try {
      refs = await fs.readdir(path.join(chorusChannelsDir(vaultRoot), ch.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const ref of refs) {
      if (!ref.isDirectory()) continue
      const dir = path.join(chorusChannelsDir(vaultRoot), ch.name, ref.name)
      if ((await readMeta(dir))?.id === id) return dir
    }
  }
  return null
}

export async function listChats(vaultRoot: string): Promise<AiChatSummary[]> {
  const byId = new Map<string, AiChatSummary>()
  const add = (meta: ChatMeta): void => {
    // Emit `model`/`profileId` only when set — an explicit `null`/`undefined`
    // would change object identity for equality-based consumers.
    const summary: AiChatSummary = { id: meta.id, title: meta.title, updatedAt: meta.updatedAt }
    if (meta.model) summary.model = meta.model
    if (meta.profileId) summary.profileId = meta.profileId
    if (meta.source) summary.source = meta.source
    if (meta.channelId) summary.channelId = meta.channelId
    if (meta.channelName) summary.channelName = meta.channelName
    if (meta.commands?.length) summary.commands = meta.commands
    if (meta.pinned) summary.pinned = true
    byId.set(meta.id, summary)
  }
  // App chats: one folder each under Chats/.
  try {
    for (const d of await fs.readdir(chorusChatsDir(vaultRoot), { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const meta = await readMeta(path.join(chorusChatsDir(vaultRoot), d.name))
      if (meta) add(meta)
    }
  } catch {
    /* no app chats yet */
  }
  // Remote-channel chats: Channels/<channelId>/<chatRef>/.
  try {
    for (const ch of await fs.readdir(chorusChannelsDir(vaultRoot), { withFileTypes: true })) {
      if (!ch.isDirectory()) continue
      const channelDir = path.join(chorusChannelsDir(vaultRoot), ch.name)
      for (const ref of await fs.readdir(channelDir, { withFileTypes: true })) {
        if (!ref.isDirectory()) continue
        const meta = await readMeta(path.join(channelDir, ref.name))
        if (meta) add(meta)
      }
    }
  } catch {
    /* no remote-channel chats yet */
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function readChat(vaultRoot: string, id: string): Promise<AiChatThread | null> {
  if (!isSafeName(id)) return null
  const dir = await resolveChatDir(vaultRoot, id)
  if (dir) {
    const meta = await readMeta(dir)
    if (meta) return threadFromMeta(meta, await readThreadMessages(dir))
  }
  return null
}

export async function saveChat(vaultRoot: string, thread: AiChatThread): Promise<void> {
  if (!isSafeName(thread.id)) throw new Error(t('assistant.backend.invalidChat', { value: thread.id }))
  const dir = chatDir(vaultRoot, thread)
  await fs.mkdir(dir, { recursive: true })
  await queuedWriteJson(settingsFile(dir), metaOf(thread))
  // Append-only thread.jsonl (C12): append just the messages beyond what is on
  // disk; a shrunk history (rare — edited/cleared) falls back to a full rewrite.
  const file = threadFile(dir)
  await runExclusive(file, async () => {
    const existing = await readThreadMessages(dir)
    if (thread.messages.length >= existing.length) {
      const delta = thread.messages.slice(existing.length)
      if (delta.length) await fs.appendFile(file, delta.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8')
    } else {
      await atomicWriteFile(file, thread.messages.map((m) => JSON.stringify(m)).join('\n') + (thread.messages.length ? '\n' : ''))
    }
  })
}

export async function renameChat(vaultRoot: string, id: string, title: string): Promise<void> {
  if (!isSafeName(id)) return
  const dir = await resolveChatDir(vaultRoot, id)
  if (!dir) return
  const meta = await readMeta(dir)
  if (!meta) return
  await queuedWriteJson(settingsFile(dir), { ...meta, title })
}

export async function setChatPinned(vaultRoot: string, id: string, pinned: boolean): Promise<void> {
  if (!isSafeName(id)) return
  const dir = await resolveChatDir(vaultRoot, id)
  if (!dir) return
  const meta = await readMeta(dir)
  if (!meta) return
  await queuedWriteJson(settingsFile(dir), { ...meta, pinned: pinned || undefined })
}

export async function deleteChat(vaultRoot: string, id: string): Promise<void> {
  if (!isSafeName(id)) return
  const dir = await resolveChatDir(vaultRoot, id)
  if (dir) await fs.rm(dir, { recursive: true, force: true })
}

/**
 * Wipe a chat's active context (the `/clear` command) WITHOUT deleting its
 * long-term `memory.jsonl` — the thread is reset but extracted facts persist.
 */
export async function clearChat(vaultRoot: string, id: string): Promise<void> {
  if (!isSafeName(id)) return
  const dir = await resolveChatDir(vaultRoot, id)
  if (dir) await fs.rm(threadFile(dir), { force: true })
}

// ── Memory (per-chat memory.jsonl, explicit summarize flow) ───────────────────

/**
 * Append one extracted fact to a chat's `memory.jsonl`. Runs the authoritative
 * file guard first (memory lives under `Meadow/Chorus`, so a `deny`/hard-block
 * is honored) and serializes the write per-file (C16). The chat folder is
 * resolved from `thread` when given (so a brand-new remote-channel chat works), else
 * by id.
 */
export async function appendMemory(
  vaultRoot: string,
  ref: { id: string } | AiChatThread,
  entry: AiMemoryEntry
): Promise<void> {
  if (!isSafeName(ref.id)) throw new Error(t('assistant.backend.invalidChat', { value: ref.id }))
  const dir = 'messages' in ref ? chatDir(vaultRoot, ref) : (await resolveChatDir(vaultRoot, ref.id)) ?? path.join(chorusChatsDir(vaultRoot), safeSegment(ref.id))
  const file = memoryFile(dir)
  await guardFilePath(vaultRoot, path.relative(vaultRoot, file), 'write')
  await fs.mkdir(dir, { recursive: true })
  await queuedAppendJsonl(file, [entry])
}

// ── Per-chat guard overrides (guard-overrides.json, narrow-only) ──────────────
// Remembered approval choices ("Always allow/ask/block here", in-app or remote channel)
// persist beside the chat as a `GuardOverrides` (spec §4.4). They can only narrow
// the global policy or pre-approve a globally pre-approvable `confirm`; the shared
// resolver enforces that, and main re-enforces the global ceiling — so persisting
// the raw choice is safe.

/** Read a chat's persisted guard overrides (null when absent). */
export async function readGuardOverrides(vaultRoot: string, id: string): Promise<GuardOverrides | null> {
  if (!isSafeName(id)) return null
  const dir = await resolveChatDir(vaultRoot, id)
  if (!dir) return null
  return readJson<GuardOverrides | null>(guardOverridesFile(dir), null)
}

/**
 * Persist a chat's guard overrides (atomic, queued, C16). The chat folder is taken
 * from `thread` when given (so a brand-new remote-channel chat resolves), else by id.
 */
export async function saveGuardOverrides(vaultRoot: string, ref: { id: string } | AiChatThread, overrides: GuardOverrides): Promise<void> {
  if (!isSafeName(ref.id)) throw new Error(t('assistant.backend.invalidChat', { value: ref.id }))
  const dir =
    'messages' in ref ? chatDir(vaultRoot, ref) : (await resolveChatDir(vaultRoot, ref.id)) ?? path.join(chorusChatsDir(vaultRoot), safeSegment(ref.id))
  await fs.mkdir(dir, { recursive: true })
  await queuedWriteJson(guardOverridesFile(dir), overrides)
}

/** Read a chat's extracted long-term memory (tolerant; `[]` when absent). */
export async function readMemory(vaultRoot: string, id: string): Promise<AiMemoryEntry[]> {
  if (!isSafeName(id)) return []
  const dir = await resolveChatDir(vaultRoot, id)
  if (!dir) return []
  const text = await readText(memoryFile(dir))
  if (!text) return []
  const out: AiMemoryEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as AiMemoryEntry
      if (parsed && typeof parsed.summary === 'string') out.push(parsed)
    } catch {
      /* skip a malformed memory line */
    }
  }
  return out
}

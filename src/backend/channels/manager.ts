import { t } from '../runtime'
import * as fs from '../filesystem'
import path from 'path-browserify'
import type { ChannelInfo, ChannelMessage, CustomCommand, RoutingConfig } from '../../types'
import type { GuardOverrides } from '@valley/plugin-sdk/guard/types'
import { capitalize } from '@valley/plugin-sdk/normalize'
import { emitDriverEvent } from '../runtime'
import { atomicWriteFile } from '../filesystem'
import { withBackgroundOperation } from '../runtime'
import { normalizeCommands } from '../store'
import { assistantDir } from '../paths'
import { channelKey, channelSecretKey, deleteSecret, getCredential, hasSecret } from '../secrets'
import { createTelegramChannel } from './telegram'
import { createWhatsAppChannel, DEFAULT_WHATSAPP_GRAPH_VERSION, DEFAULT_WHATSAPP_WEBHOOK_PORT, whatsappLocalCallbackUrl } from './whatsapp'
import type { ChannelButton, ChannelRuntimeConfig, InboundDownload, MessagingChannel } from './types'

/**
 * Registry + lifecycle for remote messaging channels. An adapter *type* (e.g.
 * `'telegram'`) registers one **factory**; the user can then create any number
 * of named **instances** of that type (each its own bot/connection with its own
 * token + allow-list). Adding a new adapter (e.g. WhatsApp) is a one-line
 * `registerFactory()`. The manager resolves tokens from safeStorage, persists
 * per-instance config (type + name + allow-list + enabled) to
 * `.valley/assistant/channels.json`, auto-starts enabled instances
 * (`ensureStarted`, called by every driver method), and fans every inbound
 * message out over the channel-agnostic `channels`/`message` driver event.
 */
interface ChannelConfig {
  type: string
  name: string
  allowFrom: string[]
  enabled: boolean
  /** Default personality (profile) id for this connection's chats. */
  defaultProfile?: string
  /** Vault-relative path to a markdown system-prompt file used directly by this connection. */
  instructionsPath?: string
  /** Optional per-channel routing override (the `channel` layer in routing precedence). */
  defaultRouting?: RoutingConfig
  /** Channel-level guard narrowing (the `channel` layer in the resolver — narrow-only). */
  guard?: GuardOverrides
  /** Custom slash-commands shared by every chat on this connection. */
  commands?: CustomCommand[]
  /** How inbound attachments are read for this connection (markitdown | provider:model). */
  attachmentParser?: string
  phoneNumberId?: string
  graphVersion?: string
  webhookPort?: number
  publicCallbackUrl?: string
}
type ChannelsFile = Record<string, ChannelConfig>

/** The non-secret per-channel config a caller may patch (allow-list + routing/guard defaults). */
export interface ChannelConfigPatch {
  allowFrom?: string[]
  defaultProfile?: string | null
  instructionsPath?: string | null
  defaultRouting?: RoutingConfig | null
  guard?: GuardOverrides | null
  commands?: CustomCommand[] | null
  attachmentParser?: string | null
  phoneNumberId?: string | null
  graphVersion?: string | null
  webhookPort?: number | null
  publicCallbackUrl?: string | null
}

type ChannelFactory = (id: string, name: string) => MessagingChannel

function configPath(vaultRoot: string): string {
  return path.join(assistantDir(vaultRoot), 'channels.json')
}

function newInstanceId(type: string): string {
  return `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** The native "/" menu's command list — keep in sync with channelCommands.ts's
 *  `BUILTIN_COMMANDS`/`helpText()` (the renderer-side plugin package main can't import). */
const botCommands = (): { command: string; description: string }[] => [
  { command: 'help', description: t('assistant.backend.botHelp') },
  { command: 'clear', description: t('assistant.backend.botClear') },
  { command: 'model', description: t('assistant.backend.botModel') },
  { command: 'profile', description: t('assistant.backend.botProfile') },
  { command: 'guard', description: t('assistant.backend.botGuard') },
]

class ChannelManager {
  /** Adapter factories keyed by type — one per kind of channel. */
  private factories = new Map<string, ChannelFactory>()
  private endpointHosts = new Map<string, string[]>()
  /** Live channel instances keyed by instance id (rebuilt from config). */
  private instances = new Map<string, MessagingChannel>()

  constructor() {
    this.registerFactory('telegram', (id, name) => createTelegramChannel(id, name), ['api.telegram.org'])
    this.registerFactory('whatsapp', (id, name) => createWhatsAppChannel(id, name), ['graph.facebook.com', 'lookaside.fbsbx.com'])
  }

  /** Register an adapter type so the user can create instances of it. */
  registerFactory(type: string, factory: ChannelFactory, hosts: string[]): void {
    this.factories.set(type, factory)
    this.endpointHosts.set(type, [...hosts])
  }

  private async readConfig(vaultRoot: string): Promise<ChannelsFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(configPath(vaultRoot), 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const file: ChannelsFile = {}
      for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const entry = raw as Partial<ChannelConfig>
        if (typeof entry.type !== 'string' || typeof entry.name !== 'string') continue
        file[id] = {
          type: entry.type,
          name: entry.name,
          allowFrom: Array.isArray(entry.allowFrom) ? entry.allowFrom : [],
          enabled: Boolean(entry.enabled),
          ...(entry.defaultProfile != null ? { defaultProfile: entry.defaultProfile } : {}),
          ...(entry.instructionsPath != null ? { instructionsPath: entry.instructionsPath } : {}),
          ...(entry.defaultRouting != null ? { defaultRouting: entry.defaultRouting } : {}),
          ...(entry.guard != null ? { guard: entry.guard } : {}),
          ...(entry.commands != null ? { commands: entry.commands } : {}),
          ...(entry.attachmentParser != null ? { attachmentParser: entry.attachmentParser } : {}),
          ...(entry.phoneNumberId != null ? { phoneNumberId: entry.phoneNumberId } : {}),
          ...(entry.graphVersion != null ? { graphVersion: entry.graphVersion } : {}),
          ...(typeof entry.webhookPort === 'number' ? { webhookPort: entry.webhookPort } : {}),
          ...(entry.publicCallbackUrl != null ? { publicCallbackUrl: entry.publicCallbackUrl } : {})
        }
      }
      return file
    } catch {
      return {}
    }
  }

  private runtimeConfig(cfg: ChannelConfig): ChannelRuntimeConfig {
    return {
      type: cfg.type,
      ...(cfg.phoneNumberId ? { phoneNumberId: cfg.phoneNumberId } : {}),
      ...(cfg.graphVersion ? { graphVersion: cfg.graphVersion } : cfg.type === 'whatsapp' ? { graphVersion: DEFAULT_WHATSAPP_GRAPH_VERSION } : {}),
      ...(cfg.webhookPort ? { webhookPort: cfg.webhookPort } : cfg.type === 'whatsapp' ? { webhookPort: DEFAULT_WHATSAPP_WEBHOOK_PORT } : {}),
      ...(cfg.publicCallbackUrl ? { publicCallbackUrl: cfg.publicCallbackUrl } : {})
    }
  }

  async credential(vaultRoot: string, id: string, name?: string): Promise<string | null> {
    const config = (await this.readConfig(vaultRoot))[id]
    if (!config) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    return getCredential(vaultRoot, name ? channelSecretKey(id, name) : channelKey(id), this.endpoints(config.type))
  }
  endpoints(type: string): Array<{ host: string; port: number; security: 'tls' }> {
    const hosts = this.endpointHosts.get(type) ?? []
    if (!hosts.length) throw new Error(t('assistant.backend.unknownChannelType', { value: type }))
    return hosts.map((host) => ({ host, port: 443, security: 'tls' }))
  }
  async credentialEndpoints(vaultRoot: string, id: string) {
    const config = (await this.readConfig(vaultRoot))[id]
    if (!config) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    return this.endpoints(config.type)
  }

  private async channelSecrets(vaultRoot: string, id: string, cfg: ChannelConfig): Promise<Record<string, string | null>> {
    if (cfg.type !== 'whatsapp') return {}
    return {
      verifyToken: await this.credential(vaultRoot, id, 'verifyToken'),
      appSecret: await this.credential(vaultRoot, id, 'appSecret')
    }
  }

  private async isConfigured(vaultRoot: string, id: string, cfg: ChannelConfig): Promise<boolean> {
    const hasToken = await hasSecret(vaultRoot, channelKey(id))
    if (cfg.type !== 'whatsapp') return hasToken
    return Boolean(
      hasToken &&
      cfg.phoneNumberId?.trim() &&
      await hasSecret(vaultRoot, channelSecretKey(id, 'verifyToken')) &&
      await hasSecret(vaultRoot, channelSecretKey(id, 'appSecret'))
    )
  }

  private async writeConfig(vaultRoot: string, file: ChannelsFile): Promise<void> {
    await fs.mkdir(assistantDir(vaultRoot), { recursive: true })
    await atomicWriteFile(configPath(vaultRoot), JSON.stringify(file, null, 2))
  }

  /**
   * Sync the live instance map to the persisted config: create a channel object
   * for every configured instance whose type has a factory, drop instances no
   * longer in config (stopping them first), and keep display names in step.
   */
  private async ensureInstances(vaultRoot: string): Promise<ChannelsFile> {
    const file = await this.readConfig(vaultRoot)
    for (const [id, cfg] of Object.entries(file)) {
      const factory = this.factories.get(cfg.type)
      if (!factory) continue
      const existing = this.instances.get(id)
      if (!existing) this.instances.set(id, factory(id, cfg.name))
      else existing.displayName = cfg.name
    }
    for (const [id, channel] of this.instances) {
      if (!file[id]) {
        channel.stop()
        this.instances.delete(id)
      }
    }
    return file
  }

  /** Start every enabled instance that has a token and isn't already running. */
  async ensureStarted(vaultRoot: string): Promise<void> {
    const file = await this.ensureInstances(vaultRoot)
    for (const [id, channel] of this.instances) {
      const cfg = file[id]
      if (cfg?.enabled && !channel.running) {
        const token = await this.credential(vaultRoot, id)
        if (token && await this.isConfigured(vaultRoot, id, cfg)) await this.startChannel(vaultRoot, channel, token, cfg)
      }
    }
  }

  private async startChannel(vaultRoot: string, channel: MessagingChannel, token: string, cfg: ChannelConfig): Promise<void> {
    channel.start({
      token,
      config: this.runtimeConfig(cfg),
      secrets: await this.channelSecrets(vaultRoot, channel.id, cfg),
      allowFrom: cfg.allowFrom,
      onMessage: (msg) => {
        emitDriverEvent('channels', 'message', {
          channelId: channel.id,
          chatRef: msg.chatRef,
          from: msg.from,
          text: msg.text,
          data: msg.data,
          ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
          ts: Date.now()
        } satisfies ChannelMessage)
      },
      onError: (error) => {
        console.error(`[assistant:channel:${channel.id}]`, error)
      },
      saveInbound: (download) => withBackgroundOperation(vaultRoot, () => this.saveInbound(vaultRoot, channel.id, download))
    })
    void channel.registerCommands?.(token, botCommands())
  }

  /**
   * Persist an inbound file under a legible, index-excluded inbox in the Chorus
   * tree (`Meadow/Chorus/Channels/<channelId>/<chatRef>/inbox/<ts>-<name>`). The
   * chat ref and file name are sanitized to a safe segment; the resolved path is
   * re-checked to stay inside the vault root. Returns the vault-relative path.
   */
  private async saveInbound(vaultRoot: string, channelId: string, download: InboundDownload): Promise<string> {
    const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_') || 'file'
    const name = `${Date.now()}-${safe(download.fileName)}`
    const rel = `Meadow/Chorus/Channels/${safe(channelId)}/${safe(download.chatRef)}/inbox/${name}`
    const root = path.resolve(vaultRoot)
    const abs = path.resolve(root, rel)
    if (!abs.startsWith(root + path.sep)) throw new Error(t('assistant.backend.outsideVault'))
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await atomicWriteFile(abs, download.bytes)
    return rel
  }

  async list(vaultRoot: string): Promise<ChannelInfo[]> {
    await this.ensureStarted(vaultRoot)
    const file = await this.readConfig(vaultRoot)
    const out: ChannelInfo[] = []
    for (const [id, channel] of this.instances) {
      const cfg = file[id]
      out.push({
        id,
        type: channel.type,
        name: channel.displayName,
        displayName: channel.displayName,
        configured: cfg ? await this.isConfigured(vaultRoot, id, cfg) : false,
        running: channel.running,
        allowFrom: cfg?.allowFrom ?? [],
        ...(cfg?.defaultProfile ? { defaultProfile: cfg.defaultProfile } : {}),
        ...(cfg?.instructionsPath ? { instructionsPath: cfg.instructionsPath } : {}),
        ...(cfg?.defaultRouting ? { defaultRouting: cfg.defaultRouting } : {}),
        ...(cfg?.guard ? { guard: cfg.guard } : {}),
        ...(cfg?.commands?.length ? { commands: cfg.commands } : {}),
        ...(cfg?.attachmentParser ? { attachmentParser: cfg.attachmentParser } : {}),
        ...(cfg?.phoneNumberId ? { phoneNumberId: cfg.phoneNumberId } : {}),
        ...(cfg?.type === 'whatsapp' ? { graphVersion: cfg.graphVersion ?? DEFAULT_WHATSAPP_GRAPH_VERSION } : {}),
        ...(cfg?.type === 'whatsapp' ? { webhookPort: cfg.webhookPort ?? DEFAULT_WHATSAPP_WEBHOOK_PORT } : {}),
        ...(cfg?.publicCallbackUrl ? { publicCallbackUrl: cfg.publicCallbackUrl } : {}),
        ...(cfg?.type === 'whatsapp' ? { webhookLocalUrl: whatsappLocalCallbackUrl(id, cfg.webhookPort ?? DEFAULT_WHATSAPP_WEBHOOK_PORT) } : {}),
        error: channel.lastError
      })
    }
    return out
  }

  /** Create a new instance of `type` with a display name; returns its id. */
  async add(vaultRoot: string, type: string, name: string): Promise<string> {
    if (!this.factories.has(type)) throw new Error(t('assistant.backend.unknownChannelType', { value: type }))
    const id = newInstanceId(type)
    const file = await this.readConfig(vaultRoot)
    file[id] = {
      type,
      name: name.trim() || capitalize(type),
      allowFrom: [],
      enabled: false,
      ...(type === 'whatsapp' ? { graphVersion: DEFAULT_WHATSAPP_GRAPH_VERSION, webhookPort: DEFAULT_WHATSAPP_WEBHOOK_PORT } : {})
    }
    await this.writeConfig(vaultRoot, file)
    await this.ensureInstances(vaultRoot)
    return id
  }

  /** Permanently remove an instance: stop it, drop its config entry + token. */
  async remove(vaultRoot: string, id: string): Promise<void> {
    this.instances.get(id)?.stop()
    this.instances.delete(id)
    const file = await this.readConfig(vaultRoot)
    if (file[id]) {
      delete file[id]
      await this.writeConfig(vaultRoot, file)
    }
    await deleteSecret(vaultRoot, channelKey(id))
    await deleteSecret(vaultRoot, channelSecretKey(id, 'verifyToken'))
    await deleteSecret(vaultRoot, channelSecretKey(id, 'appSecret'))
  }

  /** Rename an instance's display name. */
  async rename(vaultRoot: string, id: string, name: string): Promise<void> {
    const file = await this.readConfig(vaultRoot)
    const cfg = file[id]
    if (!cfg) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    cfg.name = name.trim() || cfg.name
    await this.writeConfig(vaultRoot, file)
    const instance = this.instances.get(id)
    if (instance) instance.displayName = cfg.name
  }

  async setConfig(vaultRoot: string, id: string, patch: ChannelConfigPatch): Promise<void> {
    await this.ensureInstances(vaultRoot)
    const channel = this.instances.get(id)
    if (!channel) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    const file = await this.readConfig(vaultRoot)
    const cfg = file[id]
    if (patch.allowFrom) cfg.allowFrom = patch.allowFrom
    // `null` clears the default; `undefined` leaves it unchanged (partial patch).
    if (patch.defaultProfile !== undefined) cfg.defaultProfile = patch.defaultProfile ?? undefined
    if (patch.instructionsPath !== undefined) cfg.instructionsPath = patch.instructionsPath?.trim() || undefined
    if (patch.defaultRouting !== undefined) cfg.defaultRouting = patch.defaultRouting ?? undefined
    if (patch.guard !== undefined) cfg.guard = patch.guard ?? undefined
    if (patch.commands !== undefined) {
      const next = patch.commands ? normalizeCommands(patch.commands) : []
      cfg.commands = next.length ? next : undefined
    }
    if (patch.attachmentParser !== undefined) cfg.attachmentParser = patch.attachmentParser?.trim() || undefined
    if (patch.phoneNumberId !== undefined) cfg.phoneNumberId = patch.phoneNumberId?.trim() || undefined
    if (patch.graphVersion !== undefined) cfg.graphVersion = patch.graphVersion?.trim() || undefined
    if (patch.webhookPort !== undefined) cfg.webhookPort = patch.webhookPort ?? undefined
    if (patch.publicCallbackUrl !== undefined) cfg.publicCallbackUrl = patch.publicCallbackUrl?.trim() || undefined
    file[id] = cfg
    await this.writeConfig(vaultRoot, file)
    if (channel.running) {
      // Restart with the new config.
      const token = await this.credential(vaultRoot, id)
      channel.stop()
      if (token && cfg.enabled && await this.isConfigured(vaultRoot, id, cfg)) await this.startChannel(vaultRoot, channel, token, cfg)
    }
  }

  async start(vaultRoot: string, id: string): Promise<void> {
    await this.ensureInstances(vaultRoot)
    const channel = this.instances.get(id)
    if (!channel) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    const token = await this.credential(vaultRoot, id)
    if (!token) throw new Error(t('assistant.backend.missingToken', { value: channel.displayName }))
    const file = await this.readConfig(vaultRoot)
    const cfg = file[id]
    if (!await this.isConfigured(vaultRoot, id, cfg)) throw new Error(t('assistant.backend.missingConfiguration', { value: channel.displayName }))
    cfg.enabled = true
    file[id] = cfg
    await this.writeConfig(vaultRoot, file)
    if (!channel.running) await this.startChannel(vaultRoot, channel, token, cfg)
  }

  stopAll(): void {
    for (const channel of this.instances.values()) channel.stop()
  }

  async stop(vaultRoot: string, id: string): Promise<void> {
    await this.ensureInstances(vaultRoot)
    const channel = this.instances.get(id)
    if (!channel) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    const file = await this.readConfig(vaultRoot)
    const cfg = file[id]
    cfg.enabled = false
    file[id] = cfg
    await this.writeConfig(vaultRoot, file)
    channel.stop()
  }

  /** Re-evaluate an instance after its token changed (driver setSecret). */
  async refresh(vaultRoot: string, id: string): Promise<void> {
    await this.ensureInstances(vaultRoot)
    const channel = this.instances.get(id)
    if (!channel) return
    const file = await this.readConfig(vaultRoot)
    const cfg = file[id]
    const token = await this.credential(vaultRoot, id)
    channel.stop()
    if (cfg?.enabled && token && await this.isConfigured(vaultRoot, id, cfg)) await this.startChannel(vaultRoot, channel, token, cfg)
  }

  async send(vaultRoot: string, id: string, chatRef: string, text: string): Promise<void> {
    await this.ensureInstances(vaultRoot)
    const channel = this.instances.get(id)
    if (!channel) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    const file = await this.readConfig(vaultRoot)
    const cfg = file[id]
    if (!cfg) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    const token = await this.credential(vaultRoot, id)
    if (!token) throw new Error(t('assistant.backend.missingToken', { value: channel.displayName }))
    await channel.send(token, chatRef, text, this.runtimeConfig(cfg))
  }

  /**
   * Send a message with choice buttons. Adapters that don't implement
   * `sendButtons` fall back to a plain message listing the choices, so a typed
   * reply still works everywhere.
   */
  async sendButtons(
    vaultRoot: string,
    id: string,
    chatRef: string,
    text: string,
    buttons: ChannelButton[]
  ): Promise<void> {
    await this.ensureInstances(vaultRoot)
    const channel = this.instances.get(id)
    if (!channel) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    const file = await this.readConfig(vaultRoot)
    const cfg = file[id]
    if (!cfg) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    const token = await this.credential(vaultRoot, id)
    if (!token) throw new Error(t('assistant.backend.missingToken', { value: channel.displayName }))
    if (channel.sendButtons) {
      await channel.sendButtons(token, chatRef, text, buttons, this.runtimeConfig(cfg))
    } else {
      const hint = buttons.map((b) => `"${b.value}"`).join(' / ')
      await channel.send(token, chatRef, `${text}\nReply ${hint}.`)
    }
  }

  /**
   * Send a vault file of any type as an attachment. `filePath` is vault-relative; it
   * is resolved against the vault root and must stay inside it (no `..`/absolute
   * escape). The adapter picks the transport by file type. Adapters without
   * `sendAttachment` fall back to a text message naming the file, so the flow never
   * breaks silently.
   */
  async sendAttachment(vaultRoot: string, id: string, chatRef: string, filePath: string, caption?: string): Promise<void> {
    await this.ensureInstances(vaultRoot)
    const channel = this.instances.get(id)
    if (!channel) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    const file = await this.readConfig(vaultRoot)
    const cfg = file[id]
    if (!cfg) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    const token = await this.credential(vaultRoot, id)
    if (!token) throw new Error(t('assistant.backend.missingToken', { value: channel.displayName }))
    const root = path.resolve(vaultRoot)
    const abs = path.resolve(root, filePath)
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(t('assistant.backend.outsideVault'))
    if (channel.sendAttachment) {
      await channel.sendAttachment(token, chatRef, abs, caption, this.runtimeConfig(cfg))
    } else {
      await channel.send(token, chatRef, `${caption ? `${caption}\n` : ''}[file: ${path.basename(abs)}]`)
    }
  }
}

/** Singleton — channel poll loops are process-global and outlive any one call. */
export const channelManager = new ChannelManager()

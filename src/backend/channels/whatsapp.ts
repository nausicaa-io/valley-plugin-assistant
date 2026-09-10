import { t } from '../runtime'
import { backendApi } from '../runtime'
import { whatsappFetch, uploadFile } from './network'
import type { PluginWebhookRequest } from '@valley/plugin-sdk/pluginWebhook'
import path from 'path-browserify'
import type {
  ChannelButton,
  ChannelInboundMessage,
  ChannelRuntimeConfig,
  InboundAttachmentRef,
  MessagingChannel,
  MessagingChannelContext
} from './types'

const GRAPH = 'https://graph.facebook.com'
export const DEFAULT_WHATSAPP_GRAPH_VERSION = 'v25.0'
export const DEFAULT_WHATSAPP_WEBHOOK_PORT = 8787

interface WhatsAppConfig {
  phoneNumberId: string
  graphVersion: string
  webhookPort: number
}

interface WhatsAppMediaSpec {
  mediaId: string
  kind: InboundAttachmentRef['kind']
  fileName: string
  mime?: string
}

export type ParsedWhatsAppMessage = ChannelInboundMessage & { mediaSpecs?: WhatsAppMediaSpec[] }

export function whatsappWebhookPath(channelId: string): string {
  return `/assistant/whatsapp/${encodeURIComponent(channelId)}`
}

export function whatsappLocalCallbackUrl(channelId: string, port = DEFAULT_WHATSAPP_WEBHOOK_PORT): string {
  return `http://127.0.0.1:${port}${whatsappWebhookPath(channelId)}`
}

export function normalizeGraphVersion(version?: string): string {
  const v = (version || DEFAULT_WHATSAPP_GRAPH_VERSION).trim()
  return v.startsWith('v') ? v : `v${v}`
}

function normalizeConfig(config?: ChannelRuntimeConfig): WhatsAppConfig {
  const phoneNumberId = config?.phoneNumberId?.trim() ?? ''
  const webhookPort = Number.isFinite(config?.webhookPort) && config?.webhookPort ? Number(config.webhookPort) : DEFAULT_WHATSAPP_WEBHOOK_PORT
  return { phoneNumberId, graphVersion: normalizeGraphVersion(config?.graphVersion), webhookPort }
}

export async function verifyWebhookChallenge(params: URLSearchParams, verifyToken: string | null | undefined): Promise<string | null> {
  if (params.get('hub.mode') !== 'subscribe' || !verifyToken) return null
  if (!await backendApi().credentials.verify({ handle: verifyToken, comparison: params.get('hub.verify_token') ?? '' })) return null
  return params.get('hub.challenge')
}
export async function verifyWebhookSignature(rawBody: string, signature: string | undefined, appSecret: string | null | undefined): Promise<boolean> {
  if (!appSecret || !signature?.startsWith('sha256=')) return false
  return backendApi().credentials.verify({ handle: appSecret, algorithm: 'sha256', dataBase64: rawBody, signature: signature.slice(7), encoding: 'hex' })
}

function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : []
}

function mimeExtension(mime?: string): string {
  if (mime === 'application/pdf') return '.pdf'
  if (mime === 'image/png') return '.png'
  if (mime === 'image/webp') return '.webp'
  if (mime === 'image/gif') return '.gif'
  if (mime === 'audio/ogg') return '.ogg'
  if (mime === 'audio/mpeg') return '.mp3'
  if (mime?.startsWith('image/')) return '.jpg'
  return ''
}

function mediaKind(type: string, mime?: string, fileName?: string): InboundAttachmentRef['kind'] {
  if (type === 'image') return 'image'
  if (type === 'audio') return 'audio'
  if (mime === 'application/pdf' || /\.pdf$/i.test(fileName ?? '')) return 'pdf'
  return 'file'
}

function contactName(value: { contacts?: { wa_id?: string; profile?: { name?: string } }[] } | undefined, waId: string): string | undefined {
  return value?.contacts?.find((c) => c.wa_id === waId)?.profile?.name
}

export function parseWhatsAppWebhook(payload: unknown): ParsedWhatsAppMessage[] {
  const messages: ParsedWhatsAppMessage[] = []
  const root = payload as {
    entry?: {
      changes?: {
        value?: {
          contacts?: { wa_id?: string; profile?: { name?: string } }[]
          messages?: {
            from?: string
            type?: string
            text?: { body?: string }
            button?: { text?: string; payload?: string }
            interactive?: {
              button_reply?: { id?: string; title?: string }
              list_reply?: { id?: string; title?: string; description?: string }
            }
            image?: { id?: string; mime_type?: string; caption?: string }
            audio?: { id?: string; mime_type?: string }
            document?: { id?: string; mime_type?: string; caption?: string; filename?: string }
          }[]
        }
      }[]
    }[]
  }
  for (const entry of asArray(root.entry)) {
    for (const change of asArray(entry.changes)) {
      const value = change.value
      for (const msg of asArray(value?.messages)) {
        if (!msg.from) continue
        const from = contactName(value, msg.from) ?? msg.from
        if (msg.text?.body != null) {
          messages.push({ chatRef: msg.from, from, text: msg.text.body })
          continue
        }
        const interactive = msg.interactive?.button_reply ?? msg.interactive?.list_reply
        if (interactive?.id) {
          messages.push({ chatRef: msg.from, from, text: interactive.title ?? '', data: interactive.id })
          continue
        }
        if (msg.button?.payload) {
          messages.push({ chatRef: msg.from, from, text: msg.button.text ?? '', data: msg.button.payload })
          continue
        }
        const mediaType = msg.type
        const media =
          mediaType === 'image' ? msg.image :
          mediaType === 'audio' ? msg.audio :
          mediaType === 'document' ? msg.document :
          undefined
        if (media?.id && mediaType) {
          const fileName =
            msg.document?.filename ||
            `${media.id}${mimeExtension(media.mime_type)}`
          messages.push({
            chatRef: msg.from,
            from,
            text: ('caption' in media && typeof media.caption === 'string') ? media.caption : '',
            mediaSpecs: [{ mediaId: media.id, kind: mediaKind(mediaType, media.mime_type, fileName), fileName, mime: media.mime_type }]
          })
        }
      }
    }
  }
  return messages
}

function isAllowed(chatRef: string, allowFrom: string[]): boolean {
  if (!allowFrom.length) return false
  return allowFrom.map((s) => s.trim()).includes(chatRef)
}

function limitText(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= max ? compact : compact.slice(0, Math.max(1, max - 1)).trimEnd()
}

function baseMessage(to: string): Record<string, unknown> {
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to }
}

export function buildTextPayload(chatRef: string, text: string): Record<string, unknown> {
  return { ...baseMessage(chatRef), type: 'text', text: { preview_url: true, body: text } }
}

export function buildButtonsPayload(chatRef: string, text: string, buttons: ChannelButton[]): Record<string, unknown> {
  if (buttons.length <= 3) {
    return {
      ...baseMessage(chatRef),
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text },
        action: {
          buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.value, title: limitText(b.label, 20) } }))
        }
      }
    }
  }
  return {
    ...baseMessage(chatRef),
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text },
      action: {
        button: t('assistant.backend.choose'),
        sections: [
          {
            title: 'Options',
            rows: buttons.slice(0, 10).map((b) => ({ id: b.value, title: limitText(b.label, 24) }))
          }
        ]
      }
    }
  }
}

function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime'
  }
  return map[ext] ?? 'application/octet-stream'
}

function outboundMediaType(mime: string): 'image' | 'audio' | 'video' | 'document' {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  return 'document'
}

async function postJson(token: string, cfg: WhatsAppConfig, body: Record<string, unknown>): Promise<void> {
  if (!cfg.phoneNumberId) throw new Error(t('assistant.backend.missingPhone'))
  const res = await whatsappFetch(`${GRAPH}/${cfg.graphVersion}/${cfg.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(t('assistant.backend.operationFailed', { operation: 'WhatsApp', status: res.status }))
}

async function uploadMedia(token: string, cfg: WhatsAppConfig, absPath: string, mime: string): Promise<string> {
  if (!cfg.phoneNumberId) throw new Error(t('assistant.backend.missingPhone'))
  const res = await uploadFile(`${GRAPH}/${cfg.graphVersion}/${cfg.phoneNumberId}/media`, { handle: token, placement: 'header', name: 'Authorization', prefix: 'Bearer ' }, absPath, { messaging_product: 'whatsapp', type: mime }, 'file')
  if (!res.ok) throw new Error(t('assistant.backend.operationFailed', { operation: 'WhatsApp', status: res.status }))
  const id = ((await res.json()) as { id?: string }).id
  if (!id) throw new Error(t('assistant.backend.invalidMedia'))
  return id
}

async function sendMedia(token: string, cfg: WhatsAppConfig, chatRef: string, absPath: string, caption?: string): Promise<void> {
  const mime = mimeForPath(absPath)
  const type = outboundMediaType(mime)
  const id = await uploadMedia(token, cfg, absPath, mime)
  const fileName = path.basename(absPath)
  if (caption && type === 'audio') await postJson(token, cfg, buildTextPayload(chatRef, caption))
  const media: Record<string, unknown> = { id }
  if (caption && type !== 'audio') media.caption = caption
  if (type === 'document') media.filename = fileName
  await postJson(token, cfg, { ...baseMessage(chatRef), type, [type]: media })
}

async function downloadMedia(token: string, graphVersion: string, spec: WhatsAppMediaSpec): Promise<{ bytes: Uint8Array; fileName: string; mime?: string }> {
  const meta = await whatsappFetch(`${GRAPH}/${graphVersion}/${spec.mediaId}`, {
    headers: { authorization: `Bearer ${token}` }
  })
  if (!meta.ok) throw new Error(t('assistant.backend.operationFailed', { operation: 'WhatsApp', status: meta.status }))
  const info = (await meta.json()) as { url?: string; mime_type?: string }
  if (!info.url) throw new Error(t('assistant.backend.invalidMedia'))
  const file = await whatsappFetch(info.url, { headers: { authorization: `Bearer ${token}` } })
  if (!file.ok) throw new Error(t('assistant.backend.operationFailed', { operation: 'WhatsApp', status: file.status }))
  const mime = info.mime_type ?? spec.mime
  const hasExt = Boolean(path.extname(spec.fileName))
  const fileName = hasExt ? spec.fileName : `${spec.fileName}${mimeExtension(mime)}`
  return { bytes: new Uint8Array(await file.arrayBuffer()), fileName, mime }
}

async function send(request: PluginWebhookRequest, status: number, body: string): Promise<void> {
  const bytes = new TextEncoder().encode(body)
  await backendApi().webhook.respond(request.requestId, { status, headers: { 'content-type': 'text/plain; charset=utf-8' }, bodyBase64: btoa(String.fromCharCode(...bytes)) })
}

export function createWhatsAppChannel(id = 'whatsapp', name = 'WhatsApp'): MessagingChannel {
  let running = false
  let listenerId: string | null = null
  let unsubscribe: (() => void) | null = null
  let generation = 0
  let ctx: MessagingChannelContext | null = null

  function reportError(message: string): void {
    channel.lastError = message
    ctx?.onError(message)
  }

  async function handlePost(req: PluginWebhookRequest): Promise<void> {
    if (!ctx) return send(req, 503, 'not running')
    const raw = req.bodyBase64
    const appSecret = ctx.secrets?.appSecret
    if (!await verifyWebhookSignature(raw, req.headers['x-hub-signature-256'], appSecret)) return send(req, 401, 'bad signature')
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), (character) => character.charCodeAt(0))))
    } catch {
      return send(req, 400, 'bad json')
    }
    const graphVersion = normalizeGraphVersion(ctx.config?.graphVersion)
    for (const msg of parseWhatsAppWebhook(parsed)) {
      if (!isAllowed(msg.chatRef, ctx.allowFrom)) continue
      const attachments: InboundAttachmentRef[] = []
      for (const spec of msg.mediaSpecs ?? []) {
        try {
          const media = await downloadMedia(ctx.token, graphVersion, spec)
          const savedPath = await ctx.saveInbound({ bytes: media.bytes, fileName: media.fileName, chatRef: msg.chatRef })
          attachments.push({ kind: spec.kind, path: savedPath, fileName: media.fileName, mime: media.mime ?? spec.mime })
        } catch (err) {
          reportError(t('assistant.backend.attachmentFailed', { value: err instanceof Error ? err.message : String(err) }))
        }
      }
      ctx.onMessage({ chatRef: msg.chatRef, from: msg.from, text: msg.text, data: msg.data, ...(attachments.length ? { attachments } : {}) })
    }
    channel.lastError = undefined
    send(req, 200, 'OK')
  }

  async function startServer(next: MessagingChannelContext): Promise<void> {
    const version = ++generation
    const cfg = normalizeConfig(next.config)
    const verifyToken = next.secrets?.verifyToken
    if (!cfg.phoneNumberId || !verifyToken || !next.secrets?.appSecret) throw new Error(t('assistant.backend.incompleteWhatsApp'))
    const listener = await backendApi().webhook.listen({ port: cfg.webhookPort, path: whatsappWebhookPath(id) })
    if (!running || generation !== version) { await backendApi().webhook.close(listener.listenerId); return }
    listenerId = listener.listenerId
    unsubscribe = backendApi().webhook.onRequest((req) => {
      if (req.listenerId !== listenerId) return
      void (async () => {
        const url = new URL(req.path, 'http://127.0.0.1')
        if (req.method === 'GET') {
          const challenge = await verifyWebhookChallenge(url.searchParams, verifyToken)
          return challenge == null ? send(req, 403, 'bad verify token') : send(req, 200, challenge)
        }
        if (req.method === 'POST') return handlePost(req)
        return send(req, 405, 'method not allowed')
      })().catch((error) => { reportError(error instanceof Error ? error.message : String(error)); void send(req, 500, 'error').catch(() => undefined) })
    })
  }

  const channel: MessagingChannel = {
    id,
    type: 'whatsapp',
    displayName: name,
    running: false,
    start(next): void {
      ctx = next
      if (running) return
      running = true
      channel.running = true
      channel.lastError = undefined
      void startServer(next).catch((error) => { running = false; channel.running = false; reportError(error instanceof Error ? error.message : String(error)) })
    },
    stop(): void {
      running = false
      channel.running = false
      ctx = null
      generation++
      unsubscribe?.(); unsubscribe = null
      const current = listenerId; listenerId = null
      if (current) void backendApi().webhook.close(current).catch(() => undefined)
    },
    async send(token, chatRef, text, config): Promise<void> {
      await postJson(token, normalizeConfig(config), buildTextPayload(chatRef, text))
    },
    async sendButtons(token, chatRef, text, buttons, config): Promise<void> {
      await postJson(token, normalizeConfig(config), buildButtonsPayload(chatRef, text, buttons))
    },
    async sendAttachment(token, chatRef, absPath, caption, config): Promise<void> {
      await sendMedia(token, normalizeConfig(config), chatRef, absPath, caption)
    },
    async registerCommands(): Promise<void> {
      return
    }
  }
  return channel
}

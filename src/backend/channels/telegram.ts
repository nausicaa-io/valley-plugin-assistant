import { t } from '../runtime'
import { telegramFetch, uploadFile } from './network'
import path from 'path-browserify'
import { valleyCancellationOf, withValleyCancellation } from '@valley/plugin-sdk/valleyCancellation'
import type { ChannelInboundMessage, InboundAttachmentRef, MessagingChannel, MessagingChannelContext } from './types'

/**
 * Telegram Bot API adapter — long-polls `getUpdates` (offset loop) and replies
 * via `sendMessage`. The bot token is created by the user with @BotFather and
 * stored encrypted; only chat ids in the allow-list are accepted. Inline-keyboard
 * buttons (`sendButtons`) come back as `callback_query` updates, parsed into
 * `data`-carrying messages and acked so Telegram clears the button spinner. Pure
 * helpers (`parseUpdates`, `isAllowed`) are exported for unit testing.
 */
const API = 'https://api.telegram.org'

// getUpdates long-polls for `timeout=25`s; abort a little past that so a wedged
// socket can never freeze the poll loop forever (Node's fetch has no default).
const POLL_TIMEOUT_MS = 30_000
const BACKOFF_BASE_MS = 3_000
const BACKOFF_MAX_MS = 60_000

/** Exponential backoff with a ceiling — widens the retry gap during an outage
 *  (network down, bad token) so we don't hammer the API or flood the console. */
export function nextBackoff(ms: number): number {
  return Math.min(ms * 2, BACKOFF_MAX_MS)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface TgUser {
  username?: string
  first_name?: string
}
interface TgFile {
  file_id?: string
  file_name?: string
  mime_type?: string
  file_size?: number
}
interface TgPhotoSize extends TgFile {
  width?: number
  height?: number
}
interface TgMessage {
  text?: string
  caption?: string
  chat?: { id?: number; username?: string; first_name?: string }
  from?: TgUser
  photo?: TgPhotoSize[]
  document?: TgFile
  voice?: TgFile
  audio?: TgFile
  video?: TgFile
}
interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: {
    id?: string
    data?: string
    from?: TgUser
    message?: { chat?: { id?: number; username?: string } }
  }
}

/** A file the message referenced, to be downloaded by the loop (getFile → bytes). */
export interface TgAttachmentSpec {
  fileId: string
  kind: InboundAttachmentRef['kind']
  fileName: string
  mime?: string
}

type ParsedMessage = ChannelInboundMessage & { chatId: string; attachmentSpecs?: TgAttachmentSpec[] }

/**
 * Extract a downloadable attachment spec from a message (largest photo size, or a
 * document / voice / audio). **Video is intentionally ignored** (returns null) —
 * inbound video is out of scope. The kind drives the ingestion path downstream.
 */
export function parseAttachment(m: TgMessage): TgAttachmentSpec | null {
  if (Array.isArray(m.photo) && m.photo.length) {
    const largest = m.photo.reduce((a, b) => ((b.file_size ?? 0) >= (a.file_size ?? 0) ? b : a))
    if (largest.file_id) return { fileId: largest.file_id, kind: 'image', fileName: `${largest.file_id}.jpg`, mime: 'image/jpeg' }
  }
  if (m.voice?.file_id) return { fileId: m.voice.file_id, kind: 'audio', fileName: m.voice.file_name || `${m.voice.file_id}.ogg`, mime: m.voice.mime_type || 'audio/ogg' }
  if (m.audio?.file_id) return { fileId: m.audio.file_id, kind: 'audio', fileName: m.audio.file_name || `${m.audio.file_id}.mp3`, mime: m.audio.mime_type }
  if (m.document?.file_id) {
    const name = m.document.file_name || m.document.file_id
    const isPdf = /\.pdf$/i.test(name) || m.document.mime_type === 'application/pdf'
    const isImage = /^image\//.test(m.document.mime_type ?? '') || /\.(png|jpe?g|gif|webp)$/i.test(name)
    return { fileId: m.document.file_id, kind: isPdf ? 'pdf' : isImage ? 'image' : 'file', fileName: name, mime: m.document.mime_type }
  }
  return null
}

/**
 * Parse a getUpdates response into inbound messages + the next polling offset.
 * Both plain text messages and button taps (`callback_query`) become inbound
 * messages — a tap carries its `data` and empty `text`; `callbackIds` lists the
 * callback ids to ack so Telegram stops the button's loading state.
 */
export function parseUpdates(json: unknown): {
  messages: ParsedMessage[]
  nextOffset: number | null
  callbackIds: string[]
} {
  const result = (json as { ok?: boolean; result?: TgUpdate[] }) ?? {}
  const updates = Array.isArray(result.result) ? result.result : []
  const messages: ParsedMessage[] = []
  const callbackIds: string[] = []
  let maxId = -Infinity
  for (const u of updates) {
    if (typeof u.update_id === 'number') maxId = Math.max(maxId, u.update_id)
    const chatId = u.message?.chat?.id
    const spec = u.message ? parseAttachment(u.message) : null
    // A message carries text, or an attachment with an optional caption, or both.
    const text = u.message?.text ?? (spec ? u.message?.caption ?? '' : undefined)
    if (text != null && typeof chatId === 'number') {
      messages.push({
        chatRef: String(chatId),
        chatId: String(chatId),
        from: u.message?.from?.username || u.message?.from?.first_name || u.message?.chat?.username,
        text,
        ...(spec ? { attachmentSpecs: [spec] } : {})
      })
    }
    const cb = u.callback_query
    const cbChatId = cb?.message?.chat?.id
    if (cb?.data && typeof cbChatId === 'number') {
      messages.push({
        chatRef: String(cbChatId),
        chatId: String(cbChatId),
        from: cb.from?.username || cb.from?.first_name || cb.message?.chat?.username,
        text: '',
        data: cb.data
      })
      if (cb.id) callbackIds.push(cb.id)
    }
  }
  return { messages, nextOffset: Number.isFinite(maxId) ? maxId + 1 : null, callbackIds }
}

/** Allow-list check. An empty list rejects everything (the safe default). */
export function isAllowed(chatId: string, allowFrom: string[]): boolean {
  if (!allowFrom.length) return false
  return allowFrom.map((s) => s.trim()).includes(chatId)
}

/** Escape the three characters Telegram's HTML parse mode treats specially. */
function escapeTgHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Convert the model's Notes-flavoured Markdown into Telegram `parse_mode: 'HTML'`.
 * HTML is far more robust than MarkdownV2 — only `& < >` ever need escaping, so an
 * arbitrary reply can't produce a broken entity — which lets us render *real*
 * formatting (bold/italic/strike, inline code & fenced code blocks, links) instead
 * of escaping every marker to a literal. Telegram can't open vault files or render
 * LaTeX, so `[[wikilinks]]` collapse to a bold label and `$math$` renders as
 * monospaced source. `send` still retries as plain text on a 400 as a safety net.
 */
export function toTelegramHtml(text: string): string {
  const NUL = '\u0000'
  const stash: string[] = []
  // Park already-built (escaped) HTML behind a NUL-wrapped index so later text
  // escaping / inline markup never reprocesses its contents.
  const keep = (html: string): string => `${NUL}${stash.push(html) - 1}${NUL}`

  let out = text
  // Fenced code blocks ```lang\n…``` → <pre> (drop the info string).
  out = out.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_m, code: string) =>
    keep(`<pre>${escapeTgHtml(code.replace(/\n$/, ''))}</pre>`)
  )
  // Inline code `…`.
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<code>${escapeTgHtml(code)}</code>`))
  // Math → monospaced source (no LaTeX rendering in Telegram).
  out = out.replace(/\$\$([\s\S]+?)\$\$/g, (_m, expr: string) => keep(`<code>${escapeTgHtml(expr.trim())}</code>`))
  out = out.replace(/\$(?!\s)((?:[^$\n\\]|\\.)+?)(?<!\s)\$(?!\d)/g, (_m, expr: string) =>
    keep(`<code>${escapeTgHtml(expr)}</code>`)
  )
  // Image embeds / images → their alt/label only (no inline vault assets in text).
  out = out.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => (alias ?? target).trim())
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => alt)
  // Markdown links [text](url) → <a> (stashed so the label isn't reprocessed).
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label: string, url: string) =>
    keep(`<a href="${escapeTgHtml(url.trim())}">${escapeTgHtml(label)}</a>`)
  )
  // Wikilinks [[target|label]] → bold label (Telegram has no vault target to open).
  out = out.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) =>
    keep(`<b>${escapeTgHtml((alias ?? target).trim())}</b>`)
  )
  // Escape the remaining plain text before injecting our own tags.
  out = escapeTgHtml(out)
  // Headings → bold line.
  out = out.replace(/^ {0,3}#{1,6}\s+(.*)$/gm, '<b>$1</b>')
  // Bold, italic, strikethrough (markers survive HTML escaping).
  out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  out = out.replace(/__([^_]+)__/g, '<b>$1</b>')
  out = out.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<i>$2</i>')
  out = out.replace(/(^|[^_\w])_([^_\s][^_]*?)_/g, '$1<i>$2</i>')
  out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>')
  // Restore the stashed (already-escaped) placeholders.
  out = out.replace(new RegExp(NUL + '(\\d+)' + NUL, 'g'), (_m, i: string) => stash[Number(i)])
  return out
}

/** The Bot API endpoint + multipart field for a file, chosen by its extension. */
export function pickTelegramMethod(filePath: string): { method: string; field: string } {
  const ext = path.extname(filePath).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return { method: 'sendPhoto', field: 'photo' }
  if (['.mp3', '.m4a', '.ogg', '.oga', '.wav', '.flac', '.aac'].includes(ext)) return { method: 'sendAudio', field: 'audio' }
  if (['.mp4', '.mov', '.webm', '.mkv'].includes(ext)) return { method: 'sendVideo', field: 'video' }
  return { method: 'sendDocument', field: 'document' }
}

export function createTelegramChannel(id = 'telegram', name = 'Telegram'): MessagingChannel {
  let running = false
  let offset = 0
  let ctx: MessagingChannelContext | null = null
  let backoff = BACKOFF_BASE_MS
  // The last error surfaced to onError. We always keep channel.lastError fresh
  // (Settings reads it), but only emit to onError when the message *changes* —
  // a sustained outage logs once, not every poll cycle.
  let lastLoggedError: string | null = null
  let polling: AbortController | null = null
  let generation = 0

  function reportError(message: string): void {
    channel.lastError = message
    if (message !== lastLoggedError) {
      lastLoggedError = message
      ctx?.onError(message)
    }
  }

  async function backoffSleep(): Promise<void> {
    await sleep(backoff)
    backoff = nextBackoff(backoff)
  }

  async function loop(version: number): Promise<void> {
    const active = (): boolean => running && version === generation && ctx !== null
    while (active() && ctx) {
      const current = ctx
      const controller = new AbortController()
      polling = controller
      const abortTimer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS)
      try {
        const res = await telegramFetch(
          `${API}/bot${current.token}/getUpdates?timeout=25&offset=${offset}`,
          withValleyCancellation({}, valleyCancellationOf(controller))
        )
        clearTimeout(abortTimer)
        if (!active()) break
        if (!res.ok) {
          reportError(t('assistant.backend.operationFailed', { operation: 'Telegram', status: res.status }))
          await backoffSleep()
          continue
        }
        const { messages, nextOffset, callbackIds } = parseUpdates(await res.json())
        if (!active()) break
        if (nextOffset != null) offset = nextOffset
        // Ack every button tap so Telegram clears its loading spinner.
        for (const id of callbackIds) { if (!active()) break; await answerCallbackQuery(current.token, id) }
        for (const m of messages) {
          if (!active()) break
          if (!isAllowed(m.chatId, current.allowFrom)) continue
          // Download any attachment(s) and persist into the vault before dispatch,
          // so the agent turn carries vault paths, not raw bytes.
          const attachments: InboundAttachmentRef[] = []
          for (const spec of m.attachmentSpecs ?? []) {
            try {
              const bytes = await downloadTelegramFile(current.token, spec.fileId)
              if (!active()) break
              const savedPath = await current.saveInbound({ bytes, fileName: spec.fileName, chatRef: m.chatRef })
              attachments.push({ kind: spec.kind, path: savedPath, fileName: spec.fileName, mime: spec.mime })
            } catch (err) {
              reportError(t('assistant.backend.attachmentFailed', { value: err instanceof Error ? err.message : String(err) }))
            }
          }
          if (!active()) break
          current.onMessage({ chatRef: m.chatRef, from: m.from, text: m.text, data: m.data, ...(attachments.length ? { attachments } : {}) })
        }
        // Recovered: clear the error and reset backoff so the next failure logs.
        if (!active()) break
        channel.lastError = undefined
        lastLoggedError = null
        backoff = BACKOFF_BASE_MS
      } catch (err) {
        clearTimeout(abortTimer)
        if (!active()) break
        reportError(err instanceof Error ? err.message : String(err))
        await backoffSleep()
      }
    }
  }

  const channel: MessagingChannel = {
    id,
    type: 'telegram',
    displayName: name,
    running: false,
    start(next): void {
      ctx = next
      if (running) return
      running = true
      channel.running = true
      backoff = BACKOFF_BASE_MS
      lastLoggedError = null
      void loop(++generation)
    },
    stop(): void {
      generation++
      running = false
      channel.running = false
      ctx = null
      polling?.abort()
      polling = null
    },
    async send(token, chatRef, text): Promise<void> {
      // Render the model's markdown as Telegram HTML; on a 400 (an entity Telegram
      // refuses), retry once as plain text so the message is never dropped.
      const post = (body: Record<string, unknown>): Promise<Response> =>
        telegramFetch(`${API}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
      const res = await post({ chat_id: chatRef, text: toTelegramHtml(text), parse_mode: 'HTML' })
      if (res.ok) return
      if (res.status === 400) {
        const plain = await post({ chat_id: chatRef, text })
        if (plain.ok) return
        throw new Error(t('assistant.backend.operationFailed', { operation: 'Telegram', status: plain.status }))
      }
      throw new Error(t('assistant.backend.operationFailed', { operation: 'Telegram', status: res.status }))
    },
    async sendButtons(token, chatRef, text, buttons): Promise<void> {
      // Chunk into rows of two so a richer approval set (allow/skip/remember…)
      // stays readable instead of one cramped row. Each `callback_data` is the
      // caller's short `<action>:<requestId>` value (kept < 64 bytes, C9).
      const rows: { text: string; callback_data: string }[][] = []
      for (let i = 0; i < buttons.length; i += 2) {
        rows.push(buttons.slice(i, i + 2).map((b) => ({ text: b.label, callback_data: b.value })))
      }
      const reply_markup = { inline_keyboard: rows }
      const post = (body: Record<string, unknown>): Promise<Response> =>
        telegramFetch(`${API}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatRef, reply_markup, ...body })
        })
      const res = await post({ text: toTelegramHtml(text), parse_mode: 'HTML' })
      if (res.ok) return
      if (res.status === 400) {
        const plain = await post({ text })
        if (plain.ok) return
        throw new Error(t('assistant.backend.operationFailed', { operation: 'Telegram', status: plain.status }))
      }
      throw new Error(t('assistant.backend.operationFailed', { operation: 'Telegram', status: res.status }))
    },
    async sendAttachment(token, chatRef, absPath, caption): Promise<void> {
      // Multipart upload of the local file. The endpoint + field are chosen by file
      // type (image→sendPhoto, audio→sendAudio, video→sendVideo, else sendDocument);
      // Node's global fetch/FormData/Blob handle the encoding and the filename lets
      // Telegram sniff the content type. The caption renders as MarkdownV2.
      const { method, field } = pickTelegramMethod(absPath)
      const fields: Record<string, string> = { chat_id: chatRef }
      if (caption) { fields.caption = toTelegramHtml(caption); fields.parse_mode = 'HTML' }
      const res = await uploadFile(`${API}/:token/${method}`, { handle: token, placement: 'path', name: 'token', prefix: 'bot' }, absPath, fields, field)
      if (!res.ok) throw new Error(t('assistant.backend.operationFailed', { operation: 'Telegram', status: res.status }))
    },
    async registerCommands(token, commands): Promise<void> {
      // Best-effort: a failed setMyCommands only leaves the native "/" menu stale,
      // never blocks start() or the poll loop.
      try {
        await telegramFetch(`${API}/bot${token}/setMyCommands`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ commands })
        })
      } catch {
        // ignore — see comment above
      }
    }
  }
  return channel
}

/**
 * Download a Telegram file by id: `getFile` yields a `file_path`, then the file is
 * fetched from the file endpoint. Returns the raw bytes for the manager to persist.
 */
async function downloadTelegramFile(token: string, fileId: string): Promise<Uint8Array> {
  const meta = await telegramFetch(`${API}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`)
  if (!meta.ok) throw new Error(t('assistant.backend.operationFailed', { operation: 'Telegram', status: meta.status }))
  const filePath = ((await meta.json()) as { result?: { file_path?: string } })?.result?.file_path
  if (typeof filePath !== 'string') throw new Error(t('assistant.backend.invalidMedia'))
  const file = await telegramFetch(`${API}/file/bot${token}/${filePath}`)
  if (!file.ok) throw new Error(t('assistant.backend.operationFailed', { operation: 'Telegram', status: file.status }))
  return new Uint8Array(await file.arrayBuffer())
}

/** Ack a button tap so Telegram stops showing the inline button's spinner. */
async function answerCallbackQuery(token: string, callbackQueryId: string): Promise<void> {
  try {
    await telegramFetch(`${API}/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId })
    })
  } catch {
    // Best-effort: a failed ack only leaves the button spinning, never blocks.
  }
}

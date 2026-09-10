import { t } from './runtime'
import path from 'path-browserify'
import type { AiProviderId } from '../types'
import { backendApi } from './runtime'
import { guardFilePath } from './guards'
import { runOnce } from './engine'
import { resolveConnection } from './store'
import { getAiProvider } from './providers'
import { runSkill } from './skills'

/**
 * Turn an inbound file into text the agent turn can act on. The **parser** is the
 * user's choice (resolved per-chat → per-channel → assistant default in the
 * renderer): either `'markitdown'` (the Toolbox runnable — OCR/extraction to text)
 * or a `'<provider>:<model>'` **vision model**. Audio always transcribes via
 * OpenAI Whisper. The streaming chat loop stays text-only — only this one-shot
 * ingestion call is multimodal (it reuses `runOnce` with an attachment-bearing
 * user message), so the provider adapters' multimodal code is exercised here alone.
 */
export type IngestKind = 'image' | 'pdf' | 'audio' | 'file'

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf'
}

function mimeFor(relPath: string, kind: IngestKind): string {
  const ext = path.extname(relPath).toLowerCase()
  return MIME_BY_EXT[ext] || (kind === 'pdf' ? 'application/pdf' : 'image/jpeg')
}

/** Parse a `provider:model` parser id, or null for markitdown / unparseable. */
function parseVisionParser(parser: string | undefined): { provider: AiProviderId; model: string } | null {
  if (!parser || parser === 'markitdown') return null
  const i = parser.indexOf(':')
  if (i < 0) return null
  const provider = parser.slice(0, i) as AiProviderId
  const model = parser.slice(i + 1)
  return model ? { provider, model } : null
}

const INGEST_PROMPT =
  'Transcribe and describe this file for an assistant. Output the full readable text content (and a short description of any non-text visual content). Do not add commentary.'

async function readBytes(_root: string, relPath: string): Promise<Uint8Array<ArrayBuffer>> {
  const file = await backendApi().files.openVault(relPath)
  const chunks: Uint8Array[] = []
  let offset = 0
  try {
    if (file.size > 32 * 1024 * 1024) throw new Error(t('assistant.backend.attachmentLimit'))
    for (;;) {
      const chunk = await backendApi().files.read(file.handle, { offset, maxBytes: 1024 * 1024 })
      const bytes = Uint8Array.from(atob(chunk.base64), (character) => character.charCodeAt(0))
      chunks.push(bytes); offset += bytes.length
      if (offset > 32 * 1024 * 1024) throw new Error(t('assistant.backend.attachmentLimit'))
      if (chunk.done) break
    }
    const result = new Uint8Array(offset)
    let position = 0
    for (const bytes of chunks) { result.set(bytes, position); position += bytes.length }
    return result
  } finally { await backendApi().files.release([file.handle]) }
}

export async function ingestAttachment(
  root: string,
  opts: { path: string; kind: IngestKind; parser?: string }
): Promise<{ text: string }> {
  await guardFilePath(root, opts.path, 'read')

  // Audio: always Whisper (independent of the visual-document parser choice).
  if (opts.kind === 'audio') {
    const { credentialHandle, baseUrl } = await resolveConnection(root, { provider: 'openai' })
    const bytes = await readBytes(root, opts.path)
    const provider = getAiProvider('openai')
    if (!credentialHandle || !provider?.transcribeAudio) throw new Error(t('assistant.backend.missingTranscription'))
    const text = await provider.transcribeAudio({ credentialHandle, baseUrl, bytes, fileName: opts.path })
    return { text }
  }

  const vision = parseVisionParser(opts.parser)
  const capabilities = vision ? getAiProvider(vision.provider)?.capabilities ?? [] : []
  const useVision =
    vision &&
    ((opts.kind === 'image' && capabilities.includes('vision-image')) ||
      (opts.kind === 'pdf' && capabilities.includes('vision-pdf')))
  if (useVision) {
    const bytes = await readBytes(root, opts.path)
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
    const dataBase64 = btoa(binary)
    const result = await runOnce(root, {
      requestId: `ingest-${Date.now()}`,
      provider: vision.provider,
      model: vision.model,
      messages: [{ role: 'user', content: INGEST_PROMPT, attachments: [{ mime: mimeFor(opts.path, opts.kind), dataBase64 }] }],
      maxTokens: 4096,
      origin: 'channel'
    })
    return { text: result.text.trim() }
  }

  const text = await runSkill(root, 'markitdown', { path: opts.path })
  return { text }
}

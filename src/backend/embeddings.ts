import { t } from './runtime'
import { z } from 'zod'
import { brokerFetch } from './providers/network'
import { resolveConnection } from './store'
import { ensureFileAccess } from './filesystem'
import { VAULT_ROOT } from './runtime'
const schema = z.object({ provider: z.enum(['openai', 'ollama']), model: z.string().max(512).optional(), texts: z.array(z.string().max(16000)).max(64) }).strict()
const defaults = { openai: 'text-embedding-3-small', ollama: 'nomic-embed-text' }
export async function computeEmbeddings(payload: unknown): Promise<{ model: string; vectors: number[][] }> {
  const checked = schema.safeParse(payload)
  if (!checked.success) throw new Error(t('assistant.backend.invalidRequest'))
  const input = checked.data
  const model = input.model?.trim() || defaults[input.provider]
  if (!input.texts.length) return { model, vectors: [] }
  await ensureFileAccess()
  const connection = await resolveConnection(VAULT_ROOT, { provider: input.provider, capability: 'ai.embeddings' })
  if (input.provider === 'openai' && !connection.credentialHandle) throw new Error(t('assistant.backend.embeddingCredential'))
  const base = connection.baseUrl.replace(/\/+$/, '')
  const response = await brokerFetch(`${base}${input.provider === 'openai' ? '/embeddings' : '/api/embed'}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input: input.texts }), stream: true,
    ...(connection.credentialHandle ? { credential: { handle: connection.credentialHandle, placement: 'header', name: 'Authorization', prefix: 'Bearer ' } as const } : {})
  })
  if (!response.ok) throw new Error(t('assistant.backend.operationFailed', { operation: 'Embedding', status: response.status }))
  const data: unknown = await response.json()
  let vectors: unknown
  if (input.provider === 'openai') {
    const rows = z.object({ data: z.array(z.object({ index: z.number().int().min(0), embedding: z.unknown() })).max(64) }).parse(data).data.sort((a, b) => a.index - b.index)
    if (rows.some((row, index) => row.index !== index)) throw new Error(t('assistant.backend.invalidEmbeddings'))
    vectors = rows.map((row) => row.embedding)
  } else vectors = z.object({ embeddings: z.unknown() }).parse(data).embeddings
  const parsed = z.array(z.array(z.number().finite()).min(1).max(16384)).length(input.texts.length).parse(vectors)
  if (parsed.reduce((count, row) => count + row.length, 0) > 250000 || parsed.some((row) => row.length !== parsed[0].length)) throw new Error(t('assistant.backend.invalidEmbeddings'))
  return { model, vectors: parsed }
}

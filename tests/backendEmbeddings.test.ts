// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), resolve: vi.fn(), files: vi.fn() }))
vi.mock('../src/backend/providers/network', () => ({ brokerFetch: mocks.fetch }))
vi.mock('../src/backend/store', () => ({ resolveConnection: mocks.resolve }))
vi.mock('../src/backend/filesystem', () => ({ ensureFileAccess: mocks.files }))
import { computeEmbeddings } from '../src/backend/embeddings'
beforeEach(() => { vi.clearAllMocks(); mocks.resolve.mockResolvedValue({ baseUrl: 'https://gateway.example.test/v1', credentialHandle: 'opaque' }) })
it('resolves package defaults without requesting files, accounts or network', async () => {
  expect(await computeEmbeddings({ provider: 'openai', texts: [] })).toEqual({ model: 'text-embedding-3-small', vectors: [] })
  expect(await computeEmbeddings({ provider: 'ollama', texts: [] })).toEqual({ model: 'nomic-embed-text', vectors: [] })
  expect(mocks.files).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled()
})
it('uses the configured endpoint and opaque credential, preserving source text order', async () => {
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }] })))
  expect(await computeEmbeddings({ provider: 'openai', model: 'custom', texts: ['a', 'b'] })).toEqual({ model: 'custom', vectors: [[1, 2], [3, 4]] })
  expect(mocks.fetch).toHaveBeenCalledWith('https://gateway.example.test/v1/embeddings', expect.objectContaining({ credential: { handle: 'opaque', placement: 'header', name: 'Authorization', prefix: 'Bearer ' } }))
  expect(mocks.resolve).toHaveBeenCalledWith('/vault', { provider: 'openai', capability: 'ai.embeddings' })
})
it('rejects incomplete, repeated-index or mismatched-dimension responses', async () => {
  for (const data of [[{ index: 0, embedding: [1] }], [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }], [{ index: 0, embedding: [1] }, { index: 1, embedding: [2, 3] }]]) {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ data })))
    await expect(computeEmbeddings({ provider: 'openai', texts: ['a', 'b'] })).rejects.toThrow()
  }
})

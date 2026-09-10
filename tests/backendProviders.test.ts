// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { initBackend } from '../src/backend/runtime'
import { getAiProvider, listAiProviders, reloadProviderPackages } from '../src/backend/providers'
import { brokerFetch } from '../src/backend/providers/network'

vi.mock('../src/backend/filesystem', () => ({ readdir: async () => [], readFile: vi.fn() }))

const network = {
  fetch: vi.fn(), fetchStream: vi.fn(), readStream: vi.fn(), cancel: vi.fn(async () => true)
}
const base64 = (text: string): string => Buffer.from(text).toString('base64')

beforeEach(async () => {
  vi.clearAllMocks()
  initBackend({ network } as unknown as PluginBackendApi)
  await reloadProviderPackages('/vault')
})

describe('package-owned providers', () => {
  it('registers all seven adapters without loading host provider code or writing package sources', () => {
    expect(listAiProviders().map((provider) => provider.id)).toEqual(['anthropic', 'deepseek', 'gemini', 'kimi', 'ollama', 'openai', 'xai'])
  })

  it.each(['anthropic', 'deepseek', 'gemini', 'kimi', 'ollama', 'openai', 'xai'])('streams %s through the network broker using opaque credentials', async (id) => {
    const text = id === 'anthropic'
      ? 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Grüezi"}}\n'
      : id === 'gemini' ? 'data: {"candidates":[{"content":{"parts":[{"text":"Grüezi"}]}}]}\n'
      : id === 'ollama' ? '{"message":{"content":"Grüezi"},"done":true}\n'
      : 'data: {"choices":[{"delta":{"content":"Grüezi"},"finish_reason":"stop"}]}\n'
    const bytes = Buffer.from(text)
    const split = bytes.indexOf(Buffer.from('ü')) + 1
    network.fetchStream.mockResolvedValue({ streamId: 'stream', status: 200, headers: {} })
    network.readStream.mockResolvedValueOnce({ bodyBase64: bytes.subarray(0, split).toString('base64'), done: false })
      .mockResolvedValueOnce({ bodyBase64: bytes.subarray(split).toString('base64'), done: true })
    const provider = getAiProvider(id)!
    const events: unknown[] = []
    await provider.chat({ requestId: 'request', provider: id, model: 'fixture', messages: [{ role: 'user', content: 'Hello' }] }, {
      credentialHandle: id === 'ollama' ? null : 'opaque-handle', baseUrl: provider.defaultBaseUrl
    }, (event) => events.push(event), new AbortController().signal)
    const request = network.fetchStream.mock.calls[0][0]
    expect(request.timeoutMs).toBe(900_000)
    expect(request.credential?.handle).toBe(id === 'ollama' ? undefined : 'opaque-handle')
    expect(JSON.stringify(request.headers)).not.toContain('opaque-handle')
    expect(events).toContainEqual({ type: 'text', text: 'Grüezi' })
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'done' })]))
    expect(network.fetch).not.toHaveBeenCalled()
  })

  it('keeps discovery failures strict only for explicit connection tests', async () => {
    network.fetch.mockResolvedValue({ status: 401, headers: {}, bodyBase64: base64('{"error":"invalid"}') })
    const provider = getAiProvider('openai')!
    const context = { credentialHandle: 'handle', baseUrl: provider.defaultBaseUrl }
    expect(await provider.listModels(context)).toEqual(provider.defaultModels)
    await expect(provider.listModels({ ...context, strict: true })).rejects.toThrow('HTTP 401')
  })

  it('cancels a streamed response when the provider is interrupted', async () => {
    network.fetchStream.mockResolvedValue({ streamId: 'stream', status: 200, headers: {} })
    network.readStream.mockImplementation(() => new Promise(() => {}))
    const controller = new AbortController()
    const response = await brokerFetch('https://api.openai.com/v1/chat/completions', { method: 'POST', stream: true, signal: controller.signal })
    controller.abort()
    await vi.waitFor(() => expect(network.cancel).toHaveBeenCalledWith(network.fetchStream.mock.calls[0][0].requestId))
    await response.body?.cancel()
  })
})

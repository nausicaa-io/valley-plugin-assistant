// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import type { LlmProvider } from '../src/backend/providers/types'
const mocks = vi.hoisted(() => ({ chat: vi.fn(), resolve: vi.fn(), record: vi.fn() }))
vi.mock('../src/backend/providers', () => ({ getAiProvider: () => ({ id: 'custom', label: 'Custom', requiresKey: true, chat: mocks.chat }) }))
vi.mock('../src/backend/store', () => ({ resolveConnection: mocks.resolve }))
vi.mock('../src/backend/secrets', () => ({ providerKey: (id: string) => id, secretState: async () => 'absent' }))
vi.mock('../src/backend/usage', () => ({ recordUsage: mocks.record }))
import { initBackend } from '../src/backend/runtime'
import { startRun, cancelRun, cancelAllRuns, runDetailed } from '../src/backend/engine'
const emit = vi.fn()
const request = { requestId: 'one', provider: 'custom', model: 'model', messages: [] }
beforeEach(() => {
  cancelAllRuns(); vi.clearAllMocks()
  mocks.resolve.mockResolvedValue({ connectionId: 'custom-two', provider: 'custom', credentialHandle: 'opaque-handle', baseUrl: 'https://api.example.test' })
  mocks.record.mockResolvedValue(undefined)
  initBackend({ rpc: { emit } } as unknown as PluginBackendApi)
})
describe('Assistant package completion engine', () => {
  it('streams normalized events through own RPC and meters the actual connection once', async () => {
    mocks.chat.mockImplementation(async (_request, context, send: Parameters<LlmProvider['chat']>[2]) => {
      expect(context).toEqual({ credentialHandle: 'opaque-handle', baseUrl: 'https://api.example.test', vaultRoot: '/vault' })
      send({ type: 'text', text: 'Grüsse' }); send({ type: 'usage', inputTokens: 11 }); send({ type: 'usage', outputTokens: 5 }); send({ type: 'done', finishReason: 'stop' }); send({ type: 'done' })
    })
    await startRun('/vault', request)
    expect(emit).toHaveBeenCalledWith('stream', { type: 'text', text: 'Grüsse', requestId: 'one' })
    expect(mocks.record).toHaveBeenCalledTimes(1)
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'custom-two', inputTokens: 11, outputTokens: 5 }))
  })
  it('finishes a denied credential request instead of leaving the UI waiting', async () => {
    mocks.resolve.mockRejectedValue(new Error('Permission denied'))
    await startRun('/vault', request)
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(emit).toHaveBeenLastCalledWith('stream', { requestId: 'one', type: 'done', finishReason: 'error' })
  })
  it('cancels active provider work and preserves detailed harness tool results', async () => {
    mocks.chat.mockImplementation(async (_request, _context, _send, cancellation) => { while (!cancellation.aborted) await new Promise((resolve) => setTimeout(resolve, 1)); throw new Error('cancelled') })
    const running = startRun('/vault', request)
    await vi.waitFor(() => expect(mocks.chat).toHaveBeenCalledOnce())
    expect(cancelRun('one')).toBe(true)
    await running
    expect(emit).toHaveBeenLastCalledWith('stream', { requestId: 'one', type: 'done', finishReason: 'cancelled' })
    mocks.chat.mockImplementation(async (_request, _context, send: Parameters<LlmProvider['chat']>[2]) => { send({ type: 'tool_call', call: { id: 'tool-one', name: 'read', arguments: {} } }); send({ type: 'usage', inputTokens: 4, outputTokens: 2 }); send({ type: 'done', finishReason: 'tool_calls' }) })
    expect(await runDetailed('/vault', request)).toMatchObject({ connectionId: 'custom-two', inputTokens: 4, outputTokens: 2, toolCalls: [{ id: 'tool-one', name: 'read', arguments: {} }] })
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from './mock'
import type { RunAgentOptions } from '../src/agent/loop'

const loop = vi.hoisted(() => ({ run: vi.fn<(options: RunAgentOptions) => Promise<void>>() }))
vi.mock('../src/agent/loop', () => ({ runAgent: loop.run, streamOnce: vi.fn() }))

import { register } from '../src/index'
import { getStore } from '../src/store'

let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); dispose = undefined; loop.run.mockReset() })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function start(mock: ReturnType<typeof createMockValleyApi>) {
  dispose = register(mock.api)
  const store = getStore(mock.api)
  await store.whenReady
  return store
}

describe('Assistant unload preparation', () => {
  it('waits for cancelled stream final saves and holds channel work until transition cancellation', async () => {
    const mock = createMockValleyApi()
    const finish = deferred<void>()
    const finalSave = deferred<{ ok: true }>()
    const save = vi.spyOn(mock.api.assistant, 'saveChat')
    save.mockResolvedValue({ ok: true }).mockResolvedValueOnce({ ok: true }).mockImplementationOnce(() => finalSave.promise)
    const cancel = vi.spyOn(mock.api.assistant, 'cancel').mockResolvedValue({ ok: true })
    loop.run.mockImplementationOnce(async (options) => {
      options.onRequestStart?.('stream-one')
      await finish.promise
      options.onMessage({ role: 'assistant', content: 'Saved partial answer' })
    }).mockImplementation(async (options) => { options.onMessage({ role: 'assistant', content: 'Queued answer' }) })
    const store = await start(mock)
    const originalUi = store.getSnapshot().active?.id
    const inbound = (text: string) => mock.emitChannelMessage({ channelId: 'telegram', chatRef: 'canopy', text, ts: Date.now() })
    inbound('first')
    await vi.waitFor(() => expect(loop.run).toHaveBeenCalledTimes(1))
    inbound('queued before preparation')
    let prepared = false
    const preparation = mock.runBeforeUnload().then(() => { prepared = true })
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('stream-one'))
    inbound('/help')
    inbound('queued during preparation')
    finish.resolve()
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(prepared).toBe(false)
    expect(loop.run).toHaveBeenCalledTimes(1)
    finalSave.resolve({ ok: true })
    await preparation
    expect(loop.run).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().active?.id).toBe(originalUi)
    expect(getStore(mock.api)).toBe(store)
    expect(save.mock.calls[1][0].messages.at(-1)?.content).toBe('Saved partial answer')
    mock.runUnloadCancellation()
    await vi.waitFor(() => expect(loop.run).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(store.getSnapshot().busy).toBe(false))
  })

  it('tracks a stopped turn after the active run is removed until its final save settles', async () => {
    const mock = createMockValleyApi()
    const finish = deferred<void>()
    const finalSave = deferred<{ ok: true }>()
    const save = vi.spyOn(mock.api.assistant, 'saveChat')
      .mockResolvedValueOnce({ ok: true }).mockImplementationOnce(() => finalSave.promise)
    loop.run.mockImplementation(async (options) => {
      await finish.promise
      options.onMessage({ role: 'assistant', content: 'Stopped answer' })
    })
    const store = await start(mock)
    const send = store.send('Keep this question')
    await vi.waitFor(() => expect(loop.run).toHaveBeenCalledOnce())
    store.stop()
    finish.resolve()
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    let prepared = false
    const preparation = mock.runBeforeUnload().then(() => { prepared = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(prepared).toBe(false)
    finalSave.resolve({ ok: true })
    await Promise.all([send, preparation])
    expect(store.getSnapshot().active?.messages.map((message) => message.content)).toEqual(['Keep this question', 'Stopped answer'])
  })

  it('rejects a failed final save, preserves the conversation, and retries it without another agent turn', async () => {
    const mock = createMockValleyApi()
    const finalSave = deferred<{ ok: false; error: string }>()
    const save = vi.spyOn(mock.api.assistant, 'saveChat')
      .mockResolvedValueOnce({ ok: true }).mockImplementationOnce(() => finalSave.promise).mockResolvedValue({ ok: true })
    loop.run.mockImplementation(async (options) => { options.onMessage({ role: 'assistant', content: 'Unsaved answer' }) })
    const store = await start(mock)
    const send = store.send('Question to retain')
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    const outcome = mock.runBeforeUnload().then(() => null, (error: unknown) => error)
    finalSave.resolve({ ok: false, error: 'Disk unavailable' })
    expect(await outcome).toMatchObject({ message: 'Disk unavailable' })
    await send
    expect(store.getSnapshot().activeBusy).toBe(false)
    expect(getStore(mock.api)).toBe(store)
    const messages = store.getSnapshot().active?.messages
    expect(messages?.map((message) => message.content)).toEqual(['Question to retain', 'Unsaved answer'])
    await mock.runBeforeUnload()
    expect(save).toHaveBeenCalledTimes(3)
    expect(save.mock.calls[2][0].messages).toEqual(messages)
    expect(loop.run).toHaveBeenCalledOnce()
  })

  it('settles pending approvals as declined before persisting the final conversation', async () => {
    const mock = createMockValleyApi()
    loop.run.mockImplementation(async (options) => {
      const approved = await options.requestApproval({ caller: 'agent', target: { kind: 'tool', id: 'write_note', sideEffect: 'write' }, actionLabel: 'write_note', argsPreview: {}, canRememberApproval: false })
      options.onMessage({ role: 'assistant', content: approved ? 'approved' : 'declined' })
    })
    const store = await start(mock)
    const send = store.send('Please write')
    await vi.waitFor(() => expect(store.getSnapshot().pending).not.toBeNull())
    await mock.runBeforeUnload()
    await send
    expect(store.getSnapshot().pending).toBeNull()
    expect(mock.chatThreads.get(store.getSnapshot().active!.id)?.messages.at(-1)?.content).toBe('declined')
    mock.runUnloadCancellation()
    expect(store.getSnapshot().activeBusy).toBe(false)
  })

  it.each(['clear-chat', 'delete-chat'] as const)('does not retry a failed conversation after explicit %s', async (operation) => {
    const mock = createMockValleyApi()
    const save = vi.spyOn(mock.api.assistant, 'saveChat')
      .mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: 'Disk unavailable' })
    loop.run.mockImplementation(async (options) => { options.onMessage({ role: 'assistant', content: 'Discarded answer' }) })
    const store = await start(mock)
    await store.send('Discard this conversation')
    const id = store.getSnapshot().active!.id
    expect(await mock.api.commands.executeOwn(operation, { id })).toMatchObject({ ok: true })
    await mock.runBeforeUnload()
    expect(save).toHaveBeenCalledTimes(2)
  })
})

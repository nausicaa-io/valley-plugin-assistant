import { describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from './mock'
import { registerHarnessCommands } from '../src/harnessCommands'
import config from '../config.json'

describe('package-owned harness commands', () => {
  it('registers declared legacy aliases and releases every command', () => {
    const mock = createMockValleyApi({ manifest: { id: 'renamed-assistant' } })
    const dispose = registerHarnessCommands(mock.api)
    expect(mock.commands.map((command) => command.id).sort()).toEqual(Object.values(config.commandAliases).sort())
    expect(Object.keys(config.commandAliases)).toContain('harness:run')
    expect(mock.commands.every((command) => command.paletteSafe === false)).toBe(true)
    dispose()
    expect(mock.commands).toHaveLength(0)
  })

  it('preserves CLI model parsing and sends harness work to its own backend', async () => {
    const mock = createMockValleyApi()
    const call = vi.spyOn(mock.api.backend, 'call').mockResolvedValue({ run: { id: 'run-one' } })
    const dispose = registerHarnessCommands(mock.api)
    const command = mock.commands.find((item) => item.id === 'harness-run')!
    const raw = command.input!.fromCli!(['jarvis', 'openai:model:variant'], { connection: 'work', 'use-cache': true, concurrency: '4' })
    const input = command.input!.parse(raw)
    expect(await command.run(input, {} as never)).toEqual({ value: { run: { id: 'run-one' } }, revert: null })
    expect(call).toHaveBeenCalledWith('ai.runHarness', { id: 'jarvis', targets: [{ provider: 'openai', model: 'model:variant', connectionId: 'work' }], options: { useCache: true, concurrency: 4 } })
    await expect(command.run({ id: 'jarvis', targets: ['invalid'] }, {} as never)).rejects.toThrow()
    expect(call).toHaveBeenCalledTimes(1)
    dispose()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from './mock'
import {
  AGENT_TOOL_PROVIDER_V1,
  createAgentToolProvider
} from '@valley/plugin-sdk'
import type { GuardFilesPolicy } from '@valley/plugin-sdk/guard/types'
import { buildTools, isVisitable } from '../src/agent/tools'
import { targetForTool } from '../src/agent/loop'

const tool = (api: ReturnType<typeof createMockValleyApi>['api'], name: string) =>
  buildTools(api).find((candidate) => candidate.name === name)!

describe('assistant tools', () => {
  it('reads and searches neutral vault fixtures through host APIs', async () => {
    const entries = [
      { title: 'Fern survey', relPath: 'Plants/fern-survey.md' },
      { title: 'Mushroom atlas', relPath: 'Fungi/atlas.md' }
    ]
    const mock = createMockValleyApi({ files: { 'Plants/fern-survey.md': '# Fern survey' } })
    mock.api.commands.register<{ query?: string }, typeof entries>({
      id: 'search:files',
      label: 'Search files',
      sideEffect: 'read',
      run: (input) => {
        const query = String(input?.query ?? '').toLowerCase()
        return entries.filter((entry) =>
          entry.title.toLowerCase().includes(query) || entry.relPath.toLowerCase().includes(query)
        )
      }
    })

    expect(await tool(mock.api, 'read_file').run({ path: 'Plants/fern-survey.md' }))
      .toContain('# Fern survey')
    const found = await tool(mock.api, 'search_vault').run({ query: 'fern' })
    expect(found).toContain('Plants/fern-survey.md')
    expect(found).not.toContain('Fungi/atlas.md')
  })

  it('routes generic file mutations through the files driver', async () => {
    const mock = createMockValleyApi()
    const path = 'Biodiversity/specimens.jsonl'

    expect(await tool(mock.api, 'write_file').run({ path, content: '{"species":"fern"}' }))
      .toContain(`Wrote ${path}`)
    expect(await tool(mock.api, 'list_dir').run({ path: 'Biodiversity' })).toContain(path)
    expect(await tool(mock.api, 'delete_file').run({ path })).toContain(`Deleted ${path}`)
    expect(mock.driverCalls).toEqual(expect.arrayContaining([
      {
        driver: 'files',
        method: 'writeFile',
        payload: { relPath: path, content: '{"species":"fern"}' }
      },
      { driver: 'files', method: 'deleteFile', payload: { relPath: path } }
    ]))
  })

  it('discovers only commands explicitly visible to autonomous consumers', async () => {
    const mock = createMockValleyApi()
    const run = vi.fn()
    mock.api.commands.register({
      id: 'survey',
      label: 'Survey canopy',
      sideEffect: 'read',
      agentVisibility: 'discoverable',
      run
    })
    mock.api.commands.register({
      id: 'internal-index',
      label: 'Rebuild fungal index',
      sideEffect: 'read',
      agentVisibility: 'hidden',
      run: vi.fn()
    })
    mock.api.commands.register({
      id: 'human-only',
      label: 'Select active specimen',
      sideEffect: 'read',
      agentVisibility: 'forbidden',
      run: vi.fn()
    })

    const listed = await tool(mock.api, 'list_commands').run({})
    expect(listed).toContain('test-plugin:survey')
    expect(listed).not.toContain('internal-index')
    expect(listed).not.toContain('human-only')
    expect(await tool(mock.api, 'run_command').run({ id: 'test-plugin:survey' })).toContain('Ran')
    expect(run).toHaveBeenCalledOnce()
  })

  it('loads and invokes provider-owned tools through the versioned service proxy', async () => {
    const mock = createMockValleyApi()
    const run = vi.fn(async (args: Record<string, unknown>) => `Observed ${String(args.species)}`)
    const dispose = mock.provideInterop(
      AGENT_TOOL_PROVIDER_V1,
      createAgentToolProvider([{
        name: 'survey_flora',
        description: 'Record a synthetic flora observation.',
        parameters: {
          type: 'object',
          properties: { species: { type: 'string' } },
          required: ['species']
        },
        sideEffect: 'read',
        commandId: 'survey',
        run
      }]),
      'biodiversity'
    )

    const providerTool = tool(mock.api, 'survey_flora')
    expect(providerTool.dispatch).toBe('bus')
    expect(providerTool.busCommandId?.({})).toBe('biodiversity:survey')
    expect(await providerTool.run({ species: 'fern' })).toBe('Observed fern')
    expect(run).toHaveBeenCalledWith(
      { species: 'fern' },
      { approvalToken: undefined, cancellation: undefined }
    )

    dispose()
    expect(buildTools(mock.api).some((candidate) => candidate.name === 'survey_flora')).toBe(false)
    expect(await providerTool.run({ species: 'moss' }))
      .toContain('Provider biodiversity could not run survey_flora: Provider unavailable')
  })

  it('attributes direct file and provider-command guards to the actual owner', () => {
    const mock = createMockValleyApi()
    mock.provideInterop(
      AGENT_TOOL_PROVIDER_V1,
      createAgentToolProvider([{
        name: 'survey_fungi',
        description: 'Run a fungal survey.',
        parameters: { type: 'object' },
        sideEffect: 'write',
        run: async () => 'Surveyed fungi.'
      }]),
      'fungi'
    )
    const tools = buildTools(mock.api)

    expect(targetForTool(tools.find((candidate) => candidate.name === 'write_note')!, {
      path: 'Plants/observation.md',
      content: 'Fern'
    })).toEqual({
      kind: 'file',
      path: 'Plants/observation.md',
      fileOperation: 'write',
      sideEffect: 'write'
    })
    expect(targetForTool(tools.find((candidate) => candidate.name === 'survey_fungi')!, {}))
      .toEqual({ kind: 'tool', id: 'fungi:survey_fungi', sideEffect: 'write' })
  })

  it('enforces blocked and allow-listed visit scopes', () => {
    const base: GuardFilesPolicy = {
      visitMode: 'allow-all-except-blocked',
      defaultRead: { decision: 'allow' },
      defaultWrite: { decision: 'confirm', allowPreApproval: false },
      allowedToVisit: ['Plants/**'],
      allowedToWrite: ['**/*.md'],
      blocked: ['.valley/assistant', 'restricted.json'],
      readOverrides: {},
      writeOverrides: {}
    }
    expect(isVisitable('Plants/fern.md', base)).toBe(true)
    expect(isVisitable('Fungi/moss.md', base)).toBe(true)
    expect(isVisitable('.valley/assistant/state.json', base)).toBe(false)
    expect(isVisitable('Plants/fern.md', { ...base, visitMode: 'allow-listed-only' })).toBe(true)
    expect(isVisitable('Fungi/moss.md', { ...base, visitMode: 'allow-listed-only' })).toBe(false)
    expect(isVisitable('anything', null)).toBe(true)
  })
})

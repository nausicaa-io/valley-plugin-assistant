import type { AiToolDef } from '../../../../types'

export function encodeTools(tools: AiToolDef[] | undefined): unknown[] | undefined {
  return tools?.length ? tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  })) : undefined
}

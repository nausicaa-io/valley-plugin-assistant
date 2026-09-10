import type { AiToolDef } from '../../../../types'

export function encodeTools(tools: AiToolDef[] | undefined, web: boolean | undefined): unknown[] | undefined {
  const encoded: unknown[] = (tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  }))
  if (web) {
    encoded.push({ type: 'web_search_20260209', name: 'web_search' })
    encoded.push({ type: 'web_fetch_20260209', name: 'web_fetch' })
  }
  return encoded.length ? encoded : undefined
}

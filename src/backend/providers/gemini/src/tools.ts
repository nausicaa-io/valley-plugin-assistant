import type { AiToolDef } from '../../../../types'

export function encodeTools(tools: AiToolDef[] | undefined, web: boolean | undefined): unknown[] | undefined {
  const encoded: unknown[] = []
  if (tools?.length) encoded.push({ functionDeclarations: tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  })) })
  if (web) encoded.push({ googleSearch: {} })
  return encoded.length ? encoded : undefined
}

import { providerSafeJson, providerStreamLines } from '../../shared'

export async function readGeminiStream(body: ReadableStream<Uint8Array> | null, emit: (event: any) => void) {
  let callSequence = 0
  let finishReason: string | undefined
  for await (const line of providerStreamLines(body)) {
    if (!line.startsWith('data:')) continue
    const chunk = providerSafeJson<any>(line.slice(5).trim(), {})
    const candidate = chunk.candidates?.[0]
    for (const part of candidate?.content?.parts ?? []) {
      if (part.text) emit({ type: 'text', text: part.text })
      if (part.functionCall?.name) emit({
        type: 'tool_call',
        call: { id: `gemini_${callSequence++}`, name: part.functionCall.name, arguments: part.functionCall.args ?? {} }
      })
    }
    finishReason = candidate?.finishReason ?? finishReason
    if (chunk.usageMetadata) emit({
      type: 'usage',
      inputTokens: chunk.usageMetadata.promptTokenCount,
      outputTokens: chunk.usageMetadata.candidatesTokenCount
    })
  }
  emit({ type: 'done', finishReason })
}

import { providerSafeJson, providerStreamLines } from '../../shared'

export async function readOllamaStream(body: ReadableStream<Uint8Array> | null, emit: (event: any) => void) {
  let callSequence = 0
  for await (const line of providerStreamLines(body)) {
    if (!line.trim()) continue
    const chunk = providerSafeJson<any>(line, {})
    if (chunk.message?.content) emit({ type: 'text', text: chunk.message.content })
    for (const call of chunk.message?.tool_calls ?? []) {
      if (call.function?.name) emit({
        type: 'tool_call',
        call: {
          id: `ollama_${callSequence++}`,
          name: call.function.name,
          arguments: call.function.arguments ?? {}
        }
      })
    }
    if (chunk.done) {
      if (chunk.prompt_eval_count || chunk.eval_count) emit({
        type: 'usage',
        inputTokens: chunk.prompt_eval_count,
        outputTokens: chunk.eval_count
      })
      emit({ type: 'done' })
    }
  }
}

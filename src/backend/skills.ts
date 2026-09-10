import { z } from 'zod'
import { backendApi, t } from './runtime'
import { guardFilePath } from './guards'

export const skillRequestSchema = z.object({
  runnable: z.string().min(1).max(128),
  args: z.record(z.string().max(4096)).default({})
}).strict()

export async function runSkill(root: string, runnable: string, args: Record<string, string>): Promise<string> {
  if (runnable !== 'markitdown') throw new Error(t('assistant.backend.unknownRunnable', { runnable }))
  if (!args.path?.trim()) throw new Error(t('assistant.backend.runnablePath', { runnable }))
  await guardFilePath(root, args.path, 'read')
  const api = backendApi()
  const tool = await api.native.resolve({ name: 'markitdown' })
  if (!tool) throw new Error(t('assistant.backend.missingTool'))
  const file = await api.files.openVault(args.path)
  const jobId = crypto.randomUUID(), decoder = new TextDecoder(), errorDecoder = new TextDecoder()
  let output = '', errors = '', truncated = false
  const off = api.native.onOutput((event) => {
    if (event.jobId !== jobId || truncated) return
    const text = (event.stream === 'stdout' ? decoder : errorDecoder).decode(Uint8Array.from(atob(event.base64), (character) => character.charCodeAt(0)), { stream: true })
    if (event.stream === 'stdout') output += text
    else errors = (errors + text).slice(-200_000)
    if (output.length > 200_000) {
      output = output.slice(0, 200_000)
      truncated = true
      void api.native.cancel(jobId).catch(() => undefined)
    }
  })
  try {
    const result = await api.native.run({ jobId, executable: tool.handle, args: [{ input: file.handle }], environment: { PYTHONDONTWRITEBYTECODE: '1' } })
    await api.files.release(result.outputs.map((entry) => entry.handle))
    errors += errorDecoder.decode()
    if (result.exitCode && !truncated) throw new Error(errors.trim() || t('assistant.backend.operationFailed', { operation: 'MarkItDown', status: result.exitCode }))
    output += decoder.decode()
    return output.trim()
  } catch (error) {
    if (truncated) return output.trim()
    throw error
  } finally { off(); await api.files.release([file.handle]) }
}

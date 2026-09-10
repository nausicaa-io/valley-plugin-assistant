import type { PluginBackendApi } from '@valley/plugin-sdk'
import { computeEmbeddings } from './embeddings'
import { runSkill, skillRequestSchema } from './skills'
import { aiDriver } from './aiRpc'
import { channelsDriver } from './channelsRpc'
import { initBackend, VAULT_ROOT, t } from './runtime'
import { ensureFileAccess, releaseFileAccess } from './filesystem'
import { channelManager } from './channels/manager'
import { cancelAllHarnessRuns } from './harness/runner'
import { cancelAllRuns } from './engine'
export function register(api: PluginBackendApi): () => void {
  initBackend(api)
  let active = true
  void ensureFileAccess().then(async () => { if (active) await channelManager.ensureStarted(VAULT_ROOT) }).catch((error) => { if (active) api.rpc.emit('backendError', error instanceof Error ? error.message : String(error)) })
  const offSkills = api.rpc.handle('skills.run', async (input) => {
    const parsed = skillRequestSchema.safeParse(input)
    if (!parsed.success) throw new Error(t('assistant.backend.invalidRequest'))
    await ensureFileAccess()
    return { output: await runSkill(VAULT_ROOT, parsed.data.runnable, parsed.data.args) }
  })
  const offEmbeddings = api.rpc.handle('embeddings.compute', computeEmbeddings)
  const disposers = Object.entries({ ai: aiDriver, channels: channelsDriver }).flatMap(([namespace, methods]) => Object.entries(methods).map(([name, method]) => api.rpc.handle(`${namespace}.${name}`, async (input) => {
    const parsed = method.schema.safeParse(input)
    if (!parsed.success) throw new Error(t('assistant.backend.invalidRequest'))
    const payload = parsed.data
    await ensureFileAccess()
    return method.run(VAULT_ROOT, payload)
  })))
  return () => { active = false; offSkills(); offEmbeddings(); disposers.forEach((dispose) => dispose()); cancelAllRuns(); cancelAllHarnessRuns(); channelManager.stopAll(); void releaseFileAccess() }
}

import { t } from '../runtime'
import type { ProviderPackageStatus } from '@valley/plugin-sdk/types'
import path from 'path-browserify'
import { compileUserModule } from '../compiler'
import { readFile, readdir } from '../filesystem'
import { VAULT_ROOT } from '../runtime'
import type { LlmProvider } from './types'
import * as shared from './shared'
import { brokerFetch } from './network'
import { register as anthropic } from './anthropic/src/provider'
import anthropicManifest from './anthropic/manifest.json'
import anthropicConfig from './anthropic/config.json'
import { register as deepseek } from './deepseek/src/provider'
import deepseekManifest from './deepseek/manifest.json'
import deepseekConfig from './deepseek/config.json'
import { register as gemini } from './gemini/src/provider'
import geminiManifest from './gemini/manifest.json'
import geminiConfig from './gemini/config.json'
import { register as kimi } from './kimi/src/provider'
import kimiManifest from './kimi/manifest.json'
import kimiConfig from './kimi/config.json'
import { register as ollama } from './ollama/src/provider'
import ollamaManifest from './ollama/manifest.json'
import ollamaConfig from './ollama/config.json'
import { register as openai } from './openai/src/provider'
import openaiManifest from './openai/manifest.json'
import openaiConfig from './openai/config.json'
import { register as xai } from './xai/src/provider'
import xaiManifest from './xai/manifest.json'
import xaiConfig from './xai/config.json'

const builtins = [
  { register: anthropic, manifest: anthropicManifest, config: anthropicConfig },
  { register: deepseek, manifest: deepseekManifest, config: deepseekConfig },
  { register: gemini, manifest: geminiManifest, config: geminiConfig },
  { register: kimi, manifest: kimiManifest, config: kimiConfig },
  { register: ollama, manifest: ollamaManifest, config: ollamaConfig },
  { register: openai, manifest: openaiManifest, config: openaiConfig },
  { register: xai, manifest: xaiManifest, config: xaiConfig }
]

const providers = new Map<string, LlmProvider>()
let statuses: ProviderPackageStatus[] = []
let activeRoot = ''
const disposers: Array<() => void> = []
const safeId = /^[a-z0-9][a-z0-9_-]{0,63}$/

function validate(value: unknown, id: string): LlmProvider {
  const provider = value as Partial<LlmProvider> | null
  if (!provider || provider.id !== id || typeof provider.label !== 'string' || typeof provider.defaultBaseUrl !== 'string'
    || typeof provider.requiresKey !== 'boolean' || !Array.isArray(provider.defaultModels) || typeof provider.chat !== 'function' || typeof provider.listModels !== 'function') throw new Error(t('assistant.backend.providerRegistration'))
  return provider as LlmProvider
}

function providerSdk(): { url: string; dispose(): void } {
  const key = `__assistantProviderSdk_${crypto.randomUUID().replaceAll('-', '')}`
  const value = Object.freeze({ ...shared, brokerFetch })
  Object.defineProperty(globalThis, key, { value, configurable: true })
  const code = Object.keys(value).map((name) => `export const ${name}=globalThis[${JSON.stringify(key)}][${JSON.stringify(name)}];`).join('\n')
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
  return { url, dispose() { URL.revokeObjectURL(url); Reflect.deleteProperty(globalThis, key) } }
}

export async function reloadProviderPackages(root = VAULT_ROOT): Promise<ProviderPackageStatus[]> {
  for (const dispose of disposers.splice(0)) dispose()
  providers.clear()
  statuses = []
  activeRoot = root
  for (const entry of builtins) {
    const { manifest, config } = entry
    const provider = validate(entry.register(Object.freeze({})), manifest.id)
    Object.assign(provider, { description: manifest.description, version: manifest.version, icon: config.icon, capabilities: config.capabilities, settingsUrl: 'settingsUrl' in config ? config.settingsUrl : undefined })
    providers.set(manifest.id, provider)
    statuses.push({ id: manifest.id, kind: 'ai-provider', name: manifest.name, description: manifest.description, version: manifest.version, icon: config.icon, main: config.main,
      capabilities: config.capabilities, authentication: config.authentication as ProviderPackageStatus['authentication'], ready: true, sourceDigest: `package:${manifest.version}` })
  }
  const directory = path.join(root, '.valley/assistant/providers')
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if ((error as { code?: string }).code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !safeId.test(entry.name) || /claude/i.test(entry.name)) continue
    let status: ProviderPackageStatus = { id: entry.name, kind: 'ai-provider', name: entry.name, description: '', version: '', icon: 'extension', main: 'src/provider.ts', capabilities: [], authentication: { type: 'none' }, ready: false }
    try {
      const ownRoot = path.join(directory, entry.name)
      const manifest = JSON.parse(await readFile(path.join(ownRoot, 'manifest.json'))) as Record<string, unknown>
      const config = JSON.parse(await readFile(path.join(ownRoot, 'config.json'))) as Record<string, unknown>
      if (manifest.id !== entry.name || typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || typeof config.main !== 'string' || config.packageKind !== 'ai-provider') throw new Error(t('assistant.backend.providerMetadata'))
      if (manifest.enabled === false) { providers.delete(entry.name); statuses = statuses.filter((value) => value.id !== entry.name); continue }
      status = { ...status, name: manifest.name, version: manifest.version, description: typeof manifest.description === 'string' ? manifest.description : '',
        main: config.main, icon: typeof config.icon === 'string' ? config.icon : 'extension', capabilities: Array.isArray(config.capabilities) ? config.capabilities.filter((value): value is string => typeof value === 'string') : [],
        authentication: config.authentication as ProviderPackageStatus['authentication'] }
      const sdk = providerSdk()
      disposers.push(sdk.dispose)
      const compiled = await compileUserModule(path.join(ownRoot, config.main), { rootPath: ownRoot, readText: readFile, sdkModules: { '@assistant/provider-sdk': sdk.url } })
      disposers.push(compiled.dispose)
      const exported = await import(/* @vite-ignore */ compiled.url)
      const provider = validate(typeof exported.register === 'function' ? await exported.register(Object.freeze({ ...shared, brokerFetch })) : exported.provider ?? exported.default, entry.name)
      Object.assign(provider, { description: status.description, icon: status.icon, version: status.version, capabilities: status.capabilities, settingsUrl: typeof config.settingsUrl === 'string' ? config.settingsUrl : undefined })
      providers.set(entry.name, provider)
      status = { ...status, ready: true, sourceDigest: compiled.sourceDigest }
    } catch (error) {
      providers.delete(entry.name)
      status.error = error instanceof Error ? error.message : String(error)
    }
    statuses = statuses.filter((value) => value.id !== entry.name)
    statuses.push(status)
  }
  return listProviderPackageStatuses()
}

export async function ensureProviderPackages(root = VAULT_ROOT): Promise<void> {
  if (activeRoot !== root || !statuses.length) await reloadProviderPackages(root)
}

export function getAiProvider(id: string): LlmProvider | null { return providers.get(id) ?? null }
export function listAiProviders(): LlmProvider[] { return [...providers.values()] }
export function listProviderPackageStatuses(_root = VAULT_ROOT): ProviderPackageStatus[] { return structuredClone(statuses) }

import { t } from './runtime'
import type { PluginCredentialStore, PluginSocketEndpoint } from '@valley/plugin-sdk/pluginNetwork'
import { backendApi } from './runtime'
import { storageLocation } from './filesystem'
import { providerSecretsPath, secretsPath } from './paths'
export type SecretState = 'absent' | 'ok' | 'unreadable'
export const providerKey = (id: string): string => `provider:${id}`
export const channelKey = (id: string): string => `channel:${id}`
export const channelSecretKey = (id: string, name: string): string => `channel:${id}:${name}`
const storeFor = async (root: string, key: string): Promise<PluginCredentialStore> => ({ location: await storageLocation(key.startsWith('provider:') ? providerSecretsPath(root) : secretsPath(root)) })
export function credentialEndpoint(baseUrl: string): PluginSocketEndpoint {
  const url = new URL(baseUrl)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(t('assistant.backend.httpsRequired'))
  return { host: url.hostname, port: Number(url.port || 443), security: 'tls' }
}
export async function setSecret(root: string, key: string, value: string, endpoints: PluginSocketEndpoint[]): Promise<void> {
  if (!value) return deleteSecret(root, key)
  await backendApi().credentials.set(key, value, endpoints, await storeFor(root, key))
}
export async function secretState(root: string, key: string): Promise<SecretState> { return backendApi().credentials.state(key, await storeFor(root, key)) }
export async function hasSecret(root: string, key: string): Promise<boolean> { return await secretState(root, key) !== 'absent' }
const sources = new Map<string, { root: string; key: string }>()
export async function credentialForEndpoint(handle: string, url: string): Promise<string> {
  const source = sources.get(handle)
  if (!source) return handle
  const credential = await getCredential(source.root, source.key, [credentialEndpoint(url)])
  if (!credential) throw new Error(t('assistant.backend.missingChannelCredential'))
  return credential
}
export async function getCredential(root: string, key: string, endpoints: PluginSocketEndpoint[]): Promise<string | null> {
  if (await secretState(root, key) !== 'ok') return null
  const handle = await backendApi().credentials.handle(key, { store: await storeFor(root, key), endpoints })
  sources.set(handle, { root, key })
  if (sources.size > 512) sources.delete(sources.keys().next().value!)
  return handle
}
export async function deleteSecret(root: string, key: string): Promise<void> { await backendApi().credentials.delete(key, await storeFor(root, key)) }

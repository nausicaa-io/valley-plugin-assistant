import { t } from '../runtime'
import path from 'path-browserify'
import type { PluginFetchRequest } from '@valley/plugin-sdk/pluginNetwork'
import { backendApi, VAULT_ROOT } from '../runtime'
import { brokerFetch } from '../providers/network'
import { credentialForEndpoint } from '../secrets'

export async function telegramFetch(url: string, input: RequestInit = {}): Promise<Response> {
  const target = new URL(url)
  const parts = target.pathname.split('/')
  const index = parts.findIndex((part) => /^bot[0-9a-f-]{36}$/.test(part))
  if (index < 0 || target.origin !== 'https://api.telegram.org') throw new Error(t('assistant.backend.invalidEndpoint'))
  const handle = parts[index].slice(3)
  parts[index] = ':token'
  target.pathname = parts.join('/')
  return brokerFetch(target.toString(), { ...input, headers: Object.fromEntries(new Headers(input.headers)), stream: true, credential: { handle, placement: 'path', name: 'token', prefix: 'bot' } })
}
export async function whatsappFetch(url: string, input: RequestInit = {}): Promise<Response> {
  const headers = new Headers(input.headers)
  const handle = headers.get('authorization')?.replace(/^Bearer /, '')
  if (!handle) throw new Error(t('assistant.backend.missingChannelCredential'))
  headers.delete('authorization')
  return brokerFetch(url, { ...input, headers: Object.fromEntries(headers), stream: true, credential: { handle: await credentialForEndpoint(handle, url), placement: 'header', name: 'Authorization', prefix: 'Bearer ' } })
}
export async function uploadFile(url: string, credential: NonNullable<PluginFetchRequest['credential']>, absolutePath: string, fields: Record<string, string>, field: string): Promise<Response> {
  const relative = path.relative(VAULT_ROOT, absolutePath)
  if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error(t('assistant.backend.outsideVault'))
  const file = await backendApi().files.openVault(relative)
  try {
    const result = await backendApi().network.fetch({ url, method: 'POST', requestId: crypto.randomUUID(), credential, multipart: { fields, files: [{ name: field, handle: file.handle }] } })
    return new Response(Uint8Array.from(atob(result.bodyBase64), (character) => character.charCodeAt(0)), { status: result.status, headers: result.headers })
  } finally { await backendApi().files.release([file.handle]) }
}

import english from '../../locales/en.json'
import type { PluginBackendApi } from '@valley/plugin-sdk'

let current: PluginBackendApi | undefined
export const VAULT_ROOT = '/vault'
export function initBackend(api: PluginBackendApi): void { current = api }
export function backendApi(): PluginBackendApi { if (!current) throw new Error(t('assistant.backend.backendUnavailable')); return current }
export function emitDriverEvent(_driver: string, event: string, payload: unknown): void { backendApi().rpc.emit(event, payload) }
export async function withBackgroundOperation<T>(_root: string, operation: () => Promise<T>): Promise<T> { backendApi(); return operation() }

export function t(key: string, params?: Record<string, string | number>): string {
  if (current?.i18n) return current.i18n.t(key, params)
  const value = (english as Record<string, string>)[key] ?? key
  return value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params?.[name] ?? `{{${name}}}`))
}

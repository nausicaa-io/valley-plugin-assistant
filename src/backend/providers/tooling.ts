import { t } from '../runtime'
export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (!/^https?:\/\//i.test(trimmed)) throw new Error(t('assistant.backend.baseUrl', { value: url }))
  return trimmed
}

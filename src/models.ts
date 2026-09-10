import type { AiConnectionStatus, AiProviderStatus } from './types'

/**
 * The `connectionId:model` select value shared by the settings pickers and the
 * store (which resolves the "default model for new chats" setting). It lives
 * outside `Settings.tsx` so the store never imports a React view.
 */
export type ModelRef = { provider: AiProviderStatus['provider']; model: string; connectionId?: string }

export function flattenModels(connections: AiConnectionStatus[]): { label: string; value: string }[] {
  return connections.flatMap((c) =>
    c.models.map((m) => ({
      label: `${c.label ? `${c.provider} · ${c.label}` : c.provider} · ${m.id}`,
      value: `${c.id}:${m.id}`
    }))
  )
}

export const modelValue = (m?: ModelRef | null): string => (m ? `${m.connectionId ?? m.provider}:${m.model}` : '')

export function parseModelValue(v: string, connections: AiConnectionStatus[]): ModelRef | null {
  if (!v) return null
  const i = v.indexOf(':')
  if (i === -1) return null
  const head = v.slice(0, i)
  const model = v.slice(i + 1)
  const connection = connections.find((c) => c.id === head)
  if (!connection || !model) return null
  return { provider: connection.provider, model, connectionId: connection.id }
}

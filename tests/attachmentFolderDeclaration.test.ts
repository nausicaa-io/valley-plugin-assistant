import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The nav warning for a plugin's own field is computed from the manifest, not
 * from the pane — the pane is unmounted for every page the user is not looking
 * at, which is exactly when the badge has to be right.
 *
 * That only holds while the manifest validates the SAME value the pane renders.
 * `attachmentFolder` is never written to `config.json` until the user edits
 * it, so an untouched install has the pane falling back to
 * `DEFAULT_ATTACH_INBOX` while core reads `undefined`. With the default in only
 * one of the two places, a missing folder drew a red field and no warning.
 */
describe('attachment folder declaration', () => {
  const root = join(__dirname, '..')
  const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as {
    settingsSchema?: { fields?: { key: string; default?: unknown; validate?: string; section?: string }[] }
  }
  const field = config.settingsSchema?.fields?.find((entry) => entry.key === 'attachmentFolder')

  it('declares the folder so core can validate it without mounting the pane', () => {
    expect(field).toBeDefined()
    expect(field?.validate).toBe('vault-folder')
    expect(field?.section).toBe('chat')
  })

  it('carries the same default the pane falls back to', () => {
    const source = readFileSync(join(root, 'src', 'Page.tsx'), 'utf8')
    const declared = /export const DEFAULT_ATTACH_INBOX = '([^']+)'/.exec(source)?.[1]
    expect(declared).toBeTruthy()
    expect(field?.default).toBe(declared)
  })
})

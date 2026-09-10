import path from 'path-browserify'
import {
  CONFIG_DIR,
  PROVIDER_SECRETS_FILE,
  SETTINGS_DOMAIN_FILES
} from './constants'

/**
 * Filesystem layout of the assistant's dedicated home, `.valley/assistant/` — the
 * private configuration and runtime state:
 *
 *   .valley/assistant/
 *     secrets.json         encrypted channel tokens (safeStorage; never plaintext)
 *     rules/<name>.md      extra always-on instruction snippets
 *     README.md            explains every file above
 *
 * Every path here is derived from the vault root; callers resolve I/O through
 * `resolveInVault` (which permits `.valley/` but refuses vault escape).
 */
export function assistantDir(vaultRoot: string): string {
  return path.join(vaultRoot, CONFIG_DIR, 'assistant')
}

export function rulesDir(vaultRoot: string): string {
  return path.join(assistantDir(vaultRoot), 'rules')
}

export function secretsPath(vaultRoot: string): string {
  return path.join(assistantDir(vaultRoot), 'secrets.json')
}

export function providerSecretsPath(vaultRoot: string): string {
  return path.join(vaultRoot, PROVIDER_SECRETS_FILE)
}

/** `guards.json` — the Guard permission policy. */
export function guardsPolicyPath(vaultRoot: string): string {
  return path.join(assistantDir(vaultRoot), 'guards.json')
}

/** `guard-audit.jsonl` — append-only trail of every guard decision/bypass/expiry. */
export function guardAuditPath(vaultRoot: string): string {
  return path.join(assistantDir(vaultRoot), 'guard-audit.jsonl')
}

/** Crash-recovery: in-flight turns + pending approvals (survives restart). */
export function runtimeDir(vaultRoot: string): string {
  return path.join(assistantDir(vaultRoot), 'runtime')
}

// ── Meadow/Chorus (legible vault knowledge — the user can read/edit) ─────────
// User-facing assistant material lives here, NOT in `.valley/assistant` (which is
// reserved for private/runtime state). Chats are folders with an append-only
// `thread.jsonl`; remote-channel conversations split under `Channels/<channelId>/`;
// reusable profiles live under `Personalities/`. See docs/architecture/ASSISTANT.md.

/** `Meadow/Chorus` — the legible home of chats, personalities, and memory. */
export function chorusDir(vaultRoot: string): string {
  return path.join(vaultRoot, 'Meadow', 'Chorus')
}

/** `Meadow/Chorus/Chats` — one folder per in-app conversation. */
export function chorusChatsDir(vaultRoot: string): string {
  return path.join(chorusDir(vaultRoot), 'Chats')
}

/** `Meadow/Chorus/Channels` — `<channelId>/<chatRef>/` per remote conversation. */
export function chorusChannelsDir(vaultRoot: string): string {
  return path.join(chorusDir(vaultRoot), 'Channels')
}

/** `Meadow/Chorus/Personalities` — reusable profiles. */
export function personalitiesDir(vaultRoot: string): string {
  return path.join(chorusDir(vaultRoot), 'Personalities')
}

export function personalityDir(vaultRoot: string, id: string): string {
  return path.join(personalitiesDir(vaultRoot), id)
}

/** `Meadow/Chorus/commands.json` — the overall (all-chat) user-defined slash-commands. */
export function chorusCommandsPath(vaultRoot: string): string {
  return path.join(chorusDir(vaultRoot), 'commands.json')
}

/**
 * The on-disk folder for one chat. App chats live under `Chats/<id>/`; remote
 * channel chats split under `Channels/<channelId>/<chatRef>/` (so a connection's
 * conversations group together). Each holds `settings.json` (meta) + an
 * append-only `thread.jsonl`, plus an optional `memory.jsonl`.
 */
export function chatDir(vaultRoot: string, meta: { id: string; source?: string; channelId?: string; chatRef?: string }): string {
  if (meta.source && meta.channelId && meta.chatRef) {
    return path.join(chorusChannelsDir(vaultRoot), safeSegment(meta.channelId), safeSegment(meta.chatRef))
  }
  return path.join(chorusChatsDir(vaultRoot), safeSegment(meta.id))
}

/** A folder segment safe to write to disk: only `[A-Za-z0-9._ -]`, no traversal. */
export function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\.\.+/g, '_') || '_'
}

/** Non-secret provider connections live beside their encrypted API credentials. */
export function providersPath(vaultRoot: string): string {
  return path.join(vaultRoot, SETTINGS_DOMAIN_FILES.provider)
}

export function readmePath(vaultRoot: string): string {
  return path.join(assistantDir(vaultRoot), 'README.md')
}

/** A bare, safe file-name segment (rule names, chat ids): no separators/traversal. */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/

export function isSafeName(name: string): boolean {
  return SAFE_NAME.test(name) && !name.includes('..')
}

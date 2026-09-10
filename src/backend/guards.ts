import * as fs from './filesystem'
import type {
  GuardAuditEntry,
  GuardDangerousMode,
  GuardFileOperation,
  GuardFilesPolicy,
  GuardPolicy,
  GuardPolicyEntry
} from '@valley/plugin-sdk/guard/types'
import { isWriteFileOperation, PLATFORM_BLOCKED_PATHS } from '@valley/plugin-sdk/guard/types'
import { resolveGuard } from './guardResolve'
import { queuedAppendJsonl, queuedWriteJson } from './fileQueue'
import { guardAuditPath, guardsPolicyPath } from './paths'

/**
 * Load/save the Guard policy (`.valley/assistant/guards.json`) and append the
 * guard audit trail. Reads are
 * tolerant — a malformed/partial file is merged onto defaults, never a crash.
 *
 * This is the policy *data* layer; authoritative *enforcement* lives in the main
 * drivers (`drivers/files.ts`/`notes.ts`) via the pure `resolveGuard`. Keep this
 * module free of any renderer import.
 */

/** Pre-approved safe tools. */
const DEFAULT_TOOL_ENTRIES: Record<string, GuardPolicyEntry> = {
  open_file: { decision: 'allow' },
  open_tab: { decision: 'allow' }
}

/**
 * Workspace layout commands are local, reversible, no-risk bookkeeping — never
 * need a confirmation, for any caller (human UI click or assistant). Without
 * this, every plugin-triggered dispatch (tagged `caller:'agent'` by the SDK,
 * same as an actual assistant tool call) falls through to `defaultWrite`
 * (confirm), so even a human clicking the workspace footer's save icon would
 * need Guards approval — parked invisibly on whatever chat thread happens to
 * be active in the assistant panel.
 */
export const DEFAULT_COMMAND_ENTRIES: Record<string, GuardPolicyEntry> = {}

const DEFAULT_FILES_POLICY: GuardFilesPolicy = {
  visitMode: 'allow-all-except-blocked',
  defaultRead: { decision: 'allow' },
  defaultWrite: { decision: 'confirm', allowPreApproval: false },
  allowedToVisit: ['**/*.md', 'Meadow/Chorus/**', 'Meadow/**', 'Garden/**'],
  allowedToWrite: ['**/*.md', 'Meadow/Chorus/**'],
  // The platform hard-blocks (shared with the renderer so the "locked" set in the
  // Guards UI can never drift). Glob-free directory entries (`.valley/assistant`,
  // `.git`, `node_modules`) match the dir AND everything under it (matchPath prefix
  // semantics) — so even a `list_dir` of the directory itself is refused, not just
  // reads of its children. `secrets.json` is kept explicitly (shown locked) and as
  // an any-depth glob for stray secret files elsewhere.
  blocked: [...PLATFORM_BLOCKED_PATHS],
  readOverrides: {},
  writeOverrides: {}
}

const DEFAULT_DANGEROUS_MODE: GuardDangerousMode = {
  enabled: false,
  scope: 'off',
  expiresAt: null,
  maxTtlMinutes: 60
}

export const DEFAULT_GUARD_POLICY: GuardPolicy = {
  defaultWrite: { decision: 'confirm', allowPreApproval: false },
  tools: { ...DEFAULT_TOOL_ENTRIES },
  commands: { ...DEFAULT_COMMAND_ENTRIES },
  files: DEFAULT_FILES_POLICY,
  dangerousMode: DEFAULT_DANGEROUS_MODE,
  pluginPresets: {}
}

// ── Tolerant normalization ────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asEntry(v: unknown, fallback: GuardPolicyEntry): GuardPolicyEntry {
  if (!isObj(v)) return fallback
  const decision = v.decision
  if (decision !== 'allow' && decision !== 'confirm' && decision !== 'deny') return fallback
  const out: GuardPolicyEntry = { decision }
  if (typeof v.allowPreApproval === 'boolean') out.allowPreApproval = v.allowPreApproval
  return out
}

function asEntryMap(v: unknown): Record<string, GuardPolicyEntry> {
  if (!isObj(v)) return {}
  const out: Record<string, GuardPolicyEntry> = {}
  for (const [k, raw] of Object.entries(v)) out[k] = asEntry(raw, { decision: 'confirm' })
  return out
}

function asStrings(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback
  return v.filter((x): x is string => typeof x === 'string')
}

function normalizeFiles(v: unknown): GuardFilesPolicy {
  if (!isObj(v)) return { ...DEFAULT_FILES_POLICY }
  const visitMode = v.visitMode === 'allow-listed-only' ? 'allow-listed-only' : 'allow-all-except-blocked'
  return {
    visitMode,
    defaultRead: asEntry(v.defaultRead, DEFAULT_FILES_POLICY.defaultRead),
    defaultWrite: asEntry(v.defaultWrite, DEFAULT_FILES_POLICY.defaultWrite),
    allowedToVisit: asStrings(v.allowedToVisit, DEFAULT_FILES_POLICY.allowedToVisit),
    allowedToWrite: asStrings(v.allowedToWrite, DEFAULT_FILES_POLICY.allowedToWrite),
    // Blocked patterns are always at least the platform hard-blocks (secrets etc).
    blocked: Array.from(new Set([...DEFAULT_FILES_POLICY.blocked, ...asStrings(v.blocked, [])])),
    readOverrides: asEntryMap(v.readOverrides),
    writeOverrides: asEntryMap(v.writeOverrides)
  }
}

function normalizeDangerous(v: unknown): GuardDangerousMode {
  if (!isObj(v)) return { ...DEFAULT_DANGEROUS_MODE }
  const scope = v.scope
  const validScope = scope === 'chat' || scope === 'channel' || scope === 'session' || scope === 'off' ? scope : 'off'
  const enabled = v.enabled === true
  const expiresAt = typeof v.expiresAt === 'number' ? v.expiresAt : null
  const maxTtlMinutes = typeof v.maxTtlMinutes === 'number' && v.maxTtlMinutes > 0 ? v.maxTtlMinutes : 60
  // Invariant: enabled requires a future expiry; otherwise treat as disabled.
  if (!enabled || expiresAt == null) return { enabled: false, scope: 'off', expiresAt: null, maxTtlMinutes }
  return { enabled: true, scope: validScope === 'off' ? 'session' : validScope, expiresAt, maxTtlMinutes }
}

function normalizePluginPresets(v: unknown): GuardPolicy['pluginPresets'] {
  if (!isObj(v)) return {}
  const out: GuardPolicy['pluginPresets'] = {}
  for (const [id, raw] of Object.entries(v)) {
    if (!isObj(raw)) continue
    if (typeof raw.presetId !== 'string') continue
    out[id] = {
      presetId: raw.presetId,
      presetVersion: typeof raw.presetVersion === 'number' ? raw.presetVersion : 0,
      status: raw.status === 'skipped' ? 'skipped' : 'applied',
      reviewedAt: typeof raw.reviewedAt === 'number' ? raw.reviewedAt : 0
    }
  }
  return out
}

/** Merge any parsed object onto defaults so a partial file never crashes. */
export function normalizeGuardPolicy(parsed: unknown): GuardPolicy {
  if (!isObj(parsed)) return { ...DEFAULT_GUARD_POLICY, files: { ...DEFAULT_FILES_POLICY } }
  return {
    defaultWrite: asEntry(parsed.defaultWrite, DEFAULT_GUARD_POLICY.defaultWrite),
    tools: { ...DEFAULT_TOOL_ENTRIES, ...asEntryMap(parsed.tools) },
    commands: { ...DEFAULT_COMMAND_ENTRIES, ...asEntryMap(parsed.commands) },
    files: normalizeFiles(parsed.files),
    dangerousMode: normalizeDangerous(parsed.dangerousMode),
    pluginPresets: normalizePluginPresets(parsed.pluginPresets)
  }
}

// ── Read / write ───────────────────────────────────────────────────────────────

async function readJsonFile(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Read and normalize the guard policy, or return defaults. Never throws.
 */
export async function readGuardPolicy(vaultRoot: string): Promise<GuardPolicy> {
  const existing = await readJsonFile(guardsPolicyPath(vaultRoot))
  if (existing != null) {
    return normalizeGuardPolicy(existing)
  }
  return { ...DEFAULT_GUARD_POLICY, files: { ...DEFAULT_FILES_POLICY }, tools: { ...DEFAULT_TOOL_ENTRIES } }
}

export async function saveGuardPolicy(vaultRoot: string, policy: GuardPolicy): Promise<void> {
  // Serialized per-file (C16): a guard save must never race a concurrent audit
  // append or a second save and corrupt `guards.json`.
  await queuedWriteJson(guardsPolicyPath(vaultRoot), policy)
}

// ── Authoritative enforcement (C1/C2) ──────────────────────────────────────────

/** Raised when the guard refuses a file op in main. Distinct so callers can detect it. */
export class GuardBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuardBlockedError'
  }
}

/**
 * Authoritative file-path enforcement, run inside the main drivers regardless of
 * what the renderer decided (the renderer is not a trust boundary — SECURITY.md).
 * Resolves the *global* policy (the ceiling — lower-layer narrowing is additional
 * renderer UX) and throws on `deny`/hard-block. `allow`/`confirm` both proceed:
 * the confirm prompt is the renderer's job; main only guarantees a `deny`/blocked
 * path can never be reached. Reads `guards.json` fresh so edits take effect at once.
 */
export async function guardFilePath(
  vaultRoot: string,
  relPath: string,
  op: GuardFileOperation
): Promise<void> {
  const policy = await readGuardPolicy(vaultRoot)
  const res = resolveGuard(
    {
      caller: 'agent',
      target: {
        kind: 'file',
        path: relPath,
        fileOperation: op,
        sideEffect: isWriteFileOperation(op) ? 'write' : 'read'
      }
    },
    policy,
    {},
    policy.dangerousMode,
    Date.now()
  )
  if (res.decision === 'deny') {
    throw new GuardBlockedError(`Blocked by Guards: ${res.reason}`)
  }
}

/** Append one decision to the audit trail (best-effort; never throws). */
export async function appendGuardAudit(vaultRoot: string, entry: GuardAuditEntry): Promise<void> {
  try {
    // Serialized per-file (C16) and ordered with any other append to the trail.
    await queuedAppendJsonl(guardAuditPath(vaultRoot), [entry])
  } catch (err) {
    console.error('[guard] audit append failed', err)
  }
}

/**
 * Read the most recent audit entries (newest first) for the Guards Overview's
 * "recent decisions" list. Tolerant — skips malformed lines, returns `[]` when the
 * trail is absent. Never throws.
 */
export async function readGuardAudit(vaultRoot: string, limit = 50): Promise<GuardAuditEntry[]> {
  let raw: string
  try {
    raw = await fs.readFile(guardAuditPath(vaultRoot), 'utf8')
  } catch {
    return []
  }
  const out: GuardAuditEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (isObj(parsed) && typeof parsed.ts === 'number') out.push(parsed as unknown as GuardAuditEntry)
    } catch {
      // skip a malformed line
    }
  }
  return out.reverse().slice(0, limit)
}

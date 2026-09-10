import { t } from './runtime'
import path from 'path-browserify'
import type { PluginStorageGrant, PluginStorageLocation } from '@valley/plugin-sdk/pluginStorage'
import { backendApi, VAULT_ROOT } from './runtime'

const roots = [
  { area: 'metadata', path: 'assistant', virtual: `${VAULT_ROOT}/.valley/assistant` },
  { area: 'metadata', path: 'cache/assistant', virtual: `${VAULT_ROOT}/.valley/cache/assistant` },
  { area: 'vault', path: 'Meadow/Chorus', virtual: `${VAULT_ROOT}/Meadow/Chorus` }
] as const
const grants = new Map<string, Promise<PluginStorageGrant>>()
const queues = new Map<string, Promise<unknown>>()
const missing = (file: string): Error => Object.assign(new Error(t('assistant.backend.missingFile', { value: file })), { code: 'ENOENT' })
export async function storageLocation(file: string): Promise<PluginStorageLocation> {
  const normalized = path.resolve(file)
  const scope = roots.find((root) => normalized === root.virtual || normalized.startsWith(root.virtual + '/'))
  if (!scope) throw new Error(t('assistant.backend.storageBinding', { value: file }))
  let pending = grants.get(scope.virtual)
  if (!pending) {
    pending = backendApi().storage.open({ area: scope.area, path: scope.path, kind: 'directory', mode: 'write' }).catch((error) => { grants.delete(scope.virtual); throw error })
    grants.set(scope.virtual, pending)
  }
  const grant = await pending
  return { handle: grant.handle, path: path.relative(scope.virtual, normalized) }
}
export async function ensureFileAccess(): Promise<void> { for (const root of roots) await storageLocation(root.virtual) }
export async function releaseFileAccess(): Promise<void> {
  const existing = [...grants.values()]
  grants.clear()
  await Promise.all(existing.map(async (value) => { try { await backendApi().storage.close((await value).handle) } catch { /* Revoked by host. */ } }))
}
export async function readFile(file: string, _encoding: 'utf8' = 'utf8'): Promise<string> {
  const location = await storageLocation(file)
  if (!await backendApi().storage.stat(location)) throw missing(file)
  const decoder = new TextDecoder()
  let result = '', offset = 0
  while (true) {
    const chunk = await backendApi().storage.readBytes(location, { offset, maxBytes: 1024 * 1024 })
    result += decoder.decode(Uint8Array.from(atob(chunk.base64), (character) => character.charCodeAt(0)), { stream: !chunk.done })
    if (chunk.done) return result
    if (chunk.nextOffset <= offset) throw new Error(t('assistant.backend.readStalled'))
    offset = chunk.nextOffset
    if (offset > 128 * 1024 * 1024) throw new Error(t('assistant.backend.textLimit'))
  }
}
function* textChunks(content: string): Generator<string> {
  for (let offset = 0; offset < content.length;) {
    let end = Math.min(content.length, offset + 256 * 1024)
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--
    yield content.slice(offset, end)
    offset = end
  }
}
export async function writeFile(file: string, content: string | Uint8Array, _encoding: 'utf8' = 'utf8'): Promise<void> {
  const location = await storageLocation(file)
  if (typeof content !== 'string') {
    if (!content.length) { await backendApi().storage.writeBytes(location, ''); return }
    for (let offset = 0; offset < content.length; offset += 1024 * 1024) {
      let binary = ''
      const chunk = content.subarray(offset, offset + 1024 * 1024)
      for (let start = 0; start < chunk.length; start += 32768) binary += String.fromCharCode(...chunk.subarray(start, start + 32768))
      await backendApi().storage.writeBytes(location, btoa(binary), offset > 0)
    }
    return
  }
  if (!content) { await backendApi().storage.write(location, ''); return }
  let append = false
  for (const chunk of textChunks(content)) { await backendApi().storage.write(location, chunk, append); append = true }
}
export async function appendFile(file: string, content: string, _encoding: 'utf8' = 'utf8'): Promise<void> {
  const location = await storageLocation(file)
  for (const chunk of textChunks(content)) await backendApi().storage.write(location, chunk, true)
}
export async function mkdir(file: string, _options?: { recursive?: boolean }): Promise<void> { await backendApi().storage.mkdir(await storageLocation(file)) }
export async function rename(from: string, to: string): Promise<void> { await backendApi().storage.move(await storageLocation(from), await storageLocation(to)) }
export async function rm(file: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> { await backendApi().storage.remove(await storageLocation(file), { recursive: options?.recursive, missingOk: options?.force }) }
export async function unlink(file: string): Promise<void> { await rm(file) }
export async function access(file: string): Promise<void> { if (!await backendApi().storage.stat(await storageLocation(file))) throw missing(file) }
export async function stat(file: string) {
  const result = await backendApi().storage.stat(await storageLocation(file))
  if (!result) throw missing(file)
  return { ...result, mtime: new Date(result.mtimeMs), isFile: () => result.kind === 'file', isDirectory: () => result.kind === 'directory', isSymbolicLink: () => result.kind === 'symlink' }
}
export const lstat = stat
export interface DirectoryEntry { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
export function readdir(file: string): Promise<string[]>
export function readdir(file: string, options: { withFileTypes: true }): Promise<DirectoryEntry[]>
export async function readdir(file: string, options?: { withFileTypes: true }): Promise<string[] | DirectoryEntry[]> {
  const entries = await backendApi().storage.list(await storageLocation(file))
  return options?.withFileTypes ? entries.map((entry) => ({ name: entry.name, isFile: () => entry.kind === 'file', isDirectory: () => entry.kind === 'directory', isSymbolicLink: () => entry.kind === 'symlink' })) : entries.map((entry) => entry.name)
}
export function queueFileWrite<T>(file: string, run: () => Promise<T>): Promise<T> {
  const pending = (queues.get(file) ?? Promise.resolve()).catch(() => undefined).then(run)
  queues.set(file, pending)
  void pending.finally(() => { if (queues.get(file) === pending) queues.delete(file) }).catch(() => undefined)
  return pending
}
export async function atomicWriteFile(file: string, text: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${crypto.randomUUID()}`
  try { await writeFile(temporary, text); await rename(temporary, file) }
  catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error }
}

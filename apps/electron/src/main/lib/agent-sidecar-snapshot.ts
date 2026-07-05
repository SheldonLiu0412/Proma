/**
 * Proma Agent 文件快照 sidecar
 *
 * Pi SDK 原生只管理会话树，不提供 Proma 需要的文件回滚 sidecar。
 * Proma 在每轮用户消息交给 Agent 前记录工作目录快照；rewind 时按 Proma
 * user message UUID 恢复到对应时刻。
 */

import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, existsSync, rmSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { homedir } from 'node:os'
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { getAgentSidecarSnapshotsDir } from './config-paths'

const SNAPSHOT_VERSION = 3

type SnapshotVersion = 2 | typeof SNAPSHOT_VERSION
type SnapshotRootKind = 'owned-session-cwd' | 'shared-root' | 'skipped'
type SnapshotRestoreMode = 'mirror' | 'recorded-only' | 'skip'

interface SnapshotRootMeta {
  id: string
  path: string
  exists: boolean
  entries: SnapshotEntry[]
  kind?: SnapshotRootKind
  ownerSessionId?: string
  restoreMode?: SnapshotRestoreMode
  skippedReason?: string
}

interface SidecarSnapshotMeta {
  version: SnapshotVersion
  sessionId: string
  messageUuid: string
  createdAt: number
  roots: SnapshotRootMeta[]
  limits: SnapshotLimits
  totals: SnapshotTotals
}

interface SnapshotLimits {
  maxEntries: number
  maxBytes: number
}

interface SnapshotTotals {
  entries: number
  bytes: number
  filesStored: number
  filesReused: number
}

interface SnapshotEntryBase {
  path: string
  mode: number
  mtimeMs: number
}

interface SnapshotDirectoryEntry extends SnapshotEntryBase {
  kind: 'directory'
}

interface SnapshotFileEntry extends SnapshotEntryBase {
  kind: 'file'
  size: number
  hash: string
}

interface SnapshotSymlinkEntry extends SnapshotEntryBase {
  kind: 'symlink'
  target: string
}

type SnapshotEntry = SnapshotDirectoryEntry | SnapshotFileEntry | SnapshotSymlinkEntry

export interface AgentSidecarSnapshotRootInput {
  path: string
  kind: Exclude<SnapshotRootKind, 'skipped'>
}

export interface AgentSidecarSnapshotInput {
  sessionId: string
  messageUuid: string
  roots: Array<string | AgentSidecarSnapshotRootInput>
}

export interface AgentSidecarRestoreResult {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  partial?: boolean
  restoredRoots?: number
  skippedRoots?: number
}

export interface AgentSidecarRestoreOptions {
  rootPathMap?: Map<string, string>
  sessionCwdById?: Map<string, string>
  restoreUnmappedRoots?: boolean
}

interface NormalizedSnapshotRootInput {
  path: string
  kind: SnapshotRootKind
  ownerSessionId?: string
  restoreMode: SnapshotRestoreMode
  skippedReason?: string
}

interface SnapshotBudget {
  limits: SnapshotLimits
  totals: SnapshotTotals
}

interface StoredBlob {
  hash: string
  size: number
  mode: number
  mtimeMs: number
}

export const AGENT_SIDECAR_LATEST_SNAPSHOT_FILE = 'latest-snapshot.json'
export const AGENT_SIDECAR_BLOBS_DIR = '_blobs'
const DEFAULT_MAX_ENTRIES = 80_000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024
const FILE_MTIME_TOLERANCE_MS = 1
const UNSAFE_ROOT_PATHS = new Set([
  resolve(homedir()),
  '/Applications',
  '/Library',
  '/System',
  '/bin',
  '/etc',
  '/opt',
  '/private',
  '/sbin',
  '/tmp',
  '/usr',
  '/var',
].map((path) => resolve(path)))

const EXCLUDED_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'dist',
  'build',
  'out',
  'coverage',
])

function getSidecarRootDir(): string {
  return getAgentSidecarSnapshotsDir()
}

function getSessionSidecarDir(sessionId: string): string {
  return join(getSidecarRootDir(), sessionId)
}

function getSnapshotDir(sessionId: string, messageUuid: string): string {
  return join(getSessionSidecarDir(sessionId), messageUuid)
}

function getSnapshotMetaPath(sessionId: string, messageUuid: string): string {
  return join(getSnapshotDir(sessionId, messageUuid), 'snapshot.json')
}

function getLatestSnapshotPath(sessionId: string): string {
  return join(getSessionSidecarDir(sessionId), AGENT_SIDECAR_LATEST_SNAPSHOT_FILE)
}

function getBlobPath(sessionId: string, hash: string): string {
  return join(getSessionSidecarDir(sessionId), AGENT_SIDECAR_BLOBS_DIR, hash.slice(0, 2), hash)
}

/**
 * 删除指定会话的整个 sidecar 快照目录（含各轮 snapshot 与去重 blob 池）。
 *
 * 用于删除会话时即时回收其 sidecar 数据。**调用方需先做 fork 引用保护**：
 * 若仍有其它会话以本会话为 forkSourceSessionId（fork 子会话恢复时会读源会话的 sidecar），
 * 则不应物理删除，留待存储维护的孤儿清理回收——注意该孤儿清理目前仅由存储设置页的手动入口触发
 * （非自动/启动时执行），因此「先删源会话、再删其最后一个 fork 子会话」这一顺序下，
 * 源会话 sidecar 会滞留为孤儿直到用户手动清理。
 *
 * @returns 是否实际删除了目录
 */
export function deleteSessionSidecarSnapshots(sessionId: string): boolean {
  const sessionDir = getSessionSidecarDir(sessionId)
  if (!existsSync(sessionDir)) return false
  rmSync(sessionDir, { recursive: true, force: true })
  return true
}


function rootId(path: string): string {
  return createHash('sha256').update(resolve(path)).digest('hex').slice(0, 16)
}

function ownedRootId(sessionId: string): string {
  return createHash('sha256').update(`owned-session-cwd\0${sessionId}`).digest('hex').slice(0, 16)
}

function shouldSkip(path: string): boolean {
  return EXCLUDED_NAMES.has(basename(path))
}

function createNormalizedRootInput(
  root: string | AgentSidecarSnapshotRootInput,
  sessionId: string,
): NormalizedSnapshotRootInput {
  if (typeof root === 'string') {
    return {
      path: resolve(root),
      kind: 'shared-root',
      restoreMode: 'recorded-only',
    }
  }

  const kind = root.kind
  return {
    path: resolve(root.path),
    kind,
    ownerSessionId: kind === 'owned-session-cwd' ? sessionId : undefined,
    restoreMode: kind === 'owned-session-cwd' ? 'mirror' : 'recorded-only',
  }
}

function withSkippedReason(root: NormalizedSnapshotRootInput, skippedReason: string): NormalizedSnapshotRootInput {
  return {
    ...root,
    kind: 'skipped',
    restoreMode: 'skip',
    skippedReason,
  }
}

function getRootPriority(root: NormalizedSnapshotRootInput): number {
  if (root.restoreMode === 'mirror') return 3
  if (root.restoreMode === 'recorded-only') return 2
  return 1
}

function isNestedPath(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

function uniqueResolvedRoots(roots: NormalizedSnapshotRootInput[]): NormalizedSnapshotRootInput[] {
  const byPath = new Map<string, NormalizedSnapshotRootInput>()
  for (const root of roots) {
    const existing = byPath.get(root.path)
    if (!existing || getRootPriority(root) > getRootPriority(existing)) {
      byPath.set(root.path, root)
    }
  }

  const deduped = [...byPath.values()]
  return deduped.filter((root, index) => !deduped.some((other, otherIndex) => {
      if (otherIndex === index || root.path === other.path) return false
      if (!isNestedPath(other.path, root.path)) return false
      if (other.restoreMode === 'mirror') return true
      return root.restoreMode === other.restoreMode
    }))
}

function normalizeSnapshotRoots(input: AgentSidecarSnapshotInput): NormalizedSnapshotRootInput[] {
  const normalized = input.roots.map((root) => createNormalizedRootInput(root, input.sessionId))
  const withSafety = normalized.map((root) => {
    if (isUnsafeSidecarRoot(root.path)) {
      return withSkippedReason(root, 'unsafe-root')
    }
    if (shouldSkip(root.path)) {
      return withSkippedReason(root, 'excluded-root-name')
    }
    return root
  })

  return uniqueResolvedRoots(withSafety)
}

function getSnapshotRootId(root: NormalizedSnapshotRootInput, sessionId: string): string {
  if (root.kind === 'owned-session-cwd' && root.ownerSessionId) {
    return ownedRootId(root.ownerSessionId)
  }
  if (root.kind === 'owned-session-cwd') {
    return ownedRootId(sessionId)
  }
  return rootId(root.path)
}

function inferOwnedSessionId(root: SnapshotRootMeta, snapshotSessionId: string): string | undefined {
  if (root.kind === 'owned-session-cwd') return root.ownerSessionId ?? snapshotSessionId
  if (!root.kind && basename(resolve(root.path)) === snapshotSessionId) return snapshotSessionId
  return undefined
}

function getRootRestoreMode(root: SnapshotRootMeta, snapshotSessionId: string): SnapshotRestoreMode {
  if (root.restoreMode) return root.restoreMode
  if (root.kind === 'skipped') return 'skip'
  if (inferOwnedSessionId(root, snapshotSessionId)) return 'mirror'
  return 'recorded-only'
}

function isValidSnapshotRelativePath(path: string): boolean {
  if (!path || path.includes('\0') || isAbsolute(path)) return false
  return path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function sortRootsForRestore(roots: SnapshotRootMeta[], snapshotSessionId: string): SnapshotRootMeta[] {
  return [...roots].sort((left, right) => {
    const leftMode = getRootRestoreMode(left, snapshotSessionId)
    const rightMode = getRootRestoreMode(right, snapshotSessionId)
    const leftPriority = leftMode === 'mirror' ? 0 : leftMode === 'recorded-only' ? 1 : 2
    const rightPriority = rightMode === 'mirror' ? 0 : rightMode === 'recorded-only' ? 1 : 2
    return leftPriority - rightPriority
  })
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

export async function getAgentSidecarSessionOwnedRootPaths(sessionId: string): Promise<string[]> {
  const sessionDir = getSessionSidecarDir(sessionId)
  if (!existsSync(sessionDir)) return []

  const paths: string[] = []
  const names = await readdir(sessionDir).catch(() => [])
  for (const name of names) {
    if (name === AGENT_SIDECAR_BLOBS_DIR || name === AGENT_SIDECAR_LATEST_SNAPSHOT_FILE) continue
    const metaPath = join(sessionDir, name, 'snapshot.json')
    if (!existsSync(metaPath)) continue
    try {
      const meta = await readSnapshotMetaFile(metaPath)
      for (const root of meta.roots) {
        if (inferOwnedSessionId(root, meta.sessionId) === sessionId) {
          paths.push(resolve(root.path))
        }
      }
    } catch (error) {
      console.warn(`[Agent Sidecar] 读取会话历史 root 失败 (${sessionId}/${name}):`, error)
    }
  }

  return uniqueStrings(paths)
}

function isUnsafeSidecarRoot(path: string): boolean {
  const root = resolve(path)
  return root === parse(root).root || UNSAFE_ROOT_PATHS.has(root)
}

function getSnapshotLimits(): SnapshotLimits {
  return {
    maxEntries: readPositiveIntegerEnv('PROMA_AGENT_SIDECAR_MAX_ENTRIES', DEFAULT_MAX_ENTRIES),
    maxBytes: readPositiveIntegerEnv('PROMA_AGENT_SIDECAR_MAX_BYTES', DEFAULT_MAX_BYTES),
  }
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function createBudget(limits: SnapshotLimits): SnapshotBudget {
  return {
    limits,
    totals: {
      entries: 0,
      bytes: 0,
      filesStored: 0,
      filesReused: 0,
    },
  }
}

function trackEntry(budget: SnapshotBudget, bytes = 0): void {
  budget.totals.entries += 1
  budget.totals.bytes += bytes
  if (budget.totals.entries > budget.limits.maxEntries) {
    throw new Error(`Proma sidecar 快照超过文件数量上限: ${budget.totals.entries}/${budget.limits.maxEntries}`)
  }
  if (budget.totals.bytes > budget.limits.maxBytes) {
    throw new Error(`Proma sidecar 快照超过容量上限: ${formatBytes(budget.totals.bytes)}/${formatBytes(budget.limits.maxBytes)}`)
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
}

function toSnapshotPath(path: string): string {
  return path.split(sep).join('/')
}

function fromSnapshotPath(root: string, snapshotPath: string): string {
  return join(root, ...snapshotPath.split('/'))
}

function joinSnapshotPath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child
}

function sortEntriesForCreate(entries: SnapshotEntry[]): SnapshotEntry[] {
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

function sortDirectoriesForRestore(entries: SnapshotEntry[]): SnapshotDirectoryEntry[] {
  return entries
    .filter((entry): entry is SnapshotDirectoryEntry => entry.kind === 'directory')
    .sort((left, right) => left.path.split('/').length - right.path.split('/').length)
}

function sortDirectoriesForMetadata(entries: SnapshotDirectoryEntry[]): SnapshotDirectoryEntry[] {
  return [...entries].sort((left, right) => right.path.split('/').length - left.path.split('/').length)
}

function buildPreviousEntryMap(meta: SidecarSnapshotMeta | undefined): Map<string, SnapshotEntry> {
  const entries = new Map<string, SnapshotEntry>()
  if (!meta) return entries
  for (const root of meta.roots) {
    for (const entry of root.entries) {
      entries.set(`${root.id}\0${entry.path}`, entry)
    }
  }
  return entries
}

function isSameFileSignature(entry: SnapshotEntry | undefined, stat: Stats): entry is SnapshotFileEntry {
  return Boolean(
    entry?.kind === 'file'
    && entry.size === stat.size
    && entry.mode === stat.mode
    && Math.abs(entry.mtimeMs - stat.mtimeMs) <= FILE_MTIME_TOLERANCE_MS,
  )
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

async function readSnapshotMetaFile(path: string): Promise<SidecarSnapshotMeta> {
  const meta = JSON.parse(await readFile(path, 'utf-8')) as SidecarSnapshotMeta
  if (meta.version !== SNAPSHOT_VERSION && meta.version !== 2) {
    throw new Error(`Proma sidecar 快照版本不兼容: ${meta.version}`)
  }
  return meta
}

async function readSnapshotMeta(sessionId: string, messageUuid: string): Promise<SidecarSnapshotMeta> {
  const metaPath = getSnapshotMetaPath(sessionId, messageUuid)
  if (!existsSync(metaPath)) {
    throw new Error(`未找到 Proma sidecar 快照: sessionId=${sessionId}, messageUuid=${messageUuid}`)
  }
  return readSnapshotMetaFile(metaPath)
}

async function readLatestSnapshotMeta(sessionId: string): Promise<SidecarSnapshotMeta | undefined> {
  const latestPath = getLatestSnapshotPath(sessionId)
  if (!existsSync(latestPath)) return undefined
  try {
    return await readSnapshotMetaFile(latestPath)
  } catch (error) {
    console.warn('[Agent Sidecar] 读取上一轮快照索引失败，将创建完整快照:', error)
    return undefined
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

async function blobMatchesEntry(sessionId: string, entry: SnapshotFileEntry | StoredBlob): Promise<boolean> {
  try {
    const blobPath = getBlobPath(sessionId, entry.hash)
    if (!existsSync(blobPath)) return false
    const stat = await lstat(blobPath)
    if (!stat.isFile() || stat.size !== entry.size) return false
    return await hashFile(blobPath) === entry.hash
  } catch {
    return false
  }
}

async function copyFileClone(source: string, target: string): Promise<void> {
  try {
    await copyFile(source, target, constants.COPYFILE_FICLONE)
  } catch {
    await copyFile(source, target)
  }
}

async function storeFileBlob(sessionId: string, source: string, stat: Stats): Promise<StoredBlob> {
  const blobRoot = join(getSessionSidecarDir(sessionId), AGENT_SIDECAR_BLOBS_DIR)
  await mkdir(blobRoot, { recursive: true })

  const tempPath = join(blobRoot, `.${randomUUID()}.tmp`)
  await copyFileClone(source, tempPath)
  const tempStat = await lstat(tempPath)
  const hash = await hashFile(tempPath)
  const blobPath = getBlobPath(sessionId, hash)
  await mkdir(dirname(blobPath), { recursive: true })

  try {
    if (!existsSync(blobPath)) {
      await rename(tempPath, blobPath)
    } else if (!await blobMatchesEntry(sessionId, {
      hash,
      size: tempStat.size,
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
    })) {
      await rm(blobPath, { force: true })
      await rename(tempPath, blobPath)
    } else {
      await rm(tempPath, { force: true })
    }
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }

  await chmod(blobPath, stat.mode).catch(() => {})
  await utimes(blobPath, stat.atime, stat.mtime).catch(() => {})
  return {
    hash,
    size: tempStat.size,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
  }
}

async function createFileEntry(
  input: {
    sessionId: string
    source: string
    stat: Stats
    rootId: string
    relativePath: string
    previousEntries: Map<string, SnapshotEntry>
    budget: SnapshotBudget
  },
): Promise<SnapshotFileEntry> {
  const previous = input.previousEntries.get(`${input.rootId}\0${input.relativePath}`)
  if (isSameFileSignature(previous, input.stat) && await blobMatchesEntry(input.sessionId, previous)) {
    input.budget.totals.filesReused += 1
    trackEntry(input.budget, previous.size)
    return { ...previous }
  }

  const stored = await storeFileBlob(input.sessionId, input.source, input.stat)
  input.budget.totals.filesStored += 1
  trackEntry(input.budget, stored.size)
  return {
    kind: 'file',
    path: input.relativePath,
    size: stored.size,
    hash: stored.hash,
    mode: stored.mode,
    mtimeMs: stored.mtimeMs,
  }
}

async function collectEntries(input: {
  sessionId: string
  rootPath: string
  currentPath: string
  currentRelativePath: string
  rootId: string
  previousEntries: Map<string, SnapshotEntry>
  budget: SnapshotBudget
  entries: SnapshotEntry[]
}): Promise<void> {
  if (shouldSkip(input.currentPath)) return

  const stat = await lstat(input.currentPath)
  const relativePath = input.currentRelativePath

  if (stat.isSymbolicLink()) {
    if (!relativePath) return
    trackEntry(input.budget)
    input.entries.push({
      kind: 'symlink',
      path: relativePath,
      target: await readlink(input.currentPath),
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
    })
    return
  }

  if (stat.isDirectory()) {
    if (relativePath) {
      trackEntry(input.budget)
      input.entries.push({
        kind: 'directory',
        path: relativePath,
        mode: stat.mode,
        mtimeMs: stat.mtimeMs,
      })
    }

    const children = (await readdir(input.currentPath)).sort((left, right) => left.localeCompare(right))
    for (const child of children) {
      await collectEntries({
        ...input,
        currentPath: join(input.currentPath, child),
        currentRelativePath: joinSnapshotPath(relativePath, child),
      })
    }
    return
  }

  if (!stat.isFile() || !relativePath) return
  input.entries.push(await createFileEntry({
    sessionId: input.sessionId,
    source: input.currentPath,
    stat,
    rootId: input.rootId,
    relativePath,
    previousEntries: input.previousEntries,
    budget: input.budget,
  }))
}

async function collectRootMeta(
  sessionId: string,
  rootInput: NormalizedSnapshotRootInput,
  previousEntries: Map<string, SnapshotEntry>,
  budget: SnapshotBudget,
): Promise<SnapshotRootMeta> {
  const rootPath = rootInput.path
  const id = getSnapshotRootId(rootInput, sessionId)
  const exists = await pathExists(rootPath)
  const root: SnapshotRootMeta = {
    id,
    path: rootPath,
    exists,
    entries: [],
    kind: rootInput.kind,
    ownerSessionId: rootInput.ownerSessionId,
    restoreMode: rootInput.restoreMode,
    skippedReason: rootInput.skippedReason,
  }
  if (!exists || rootInput.restoreMode === 'skip') return root

  await collectEntries({
    sessionId,
    rootPath,
    currentPath: rootPath,
    currentRelativePath: '',
    rootId: id,
    previousEntries,
    budget,
    entries: root.entries,
  })
  root.entries = sortEntriesForCreate(root.entries)
  return root
}

async function writeSnapshotMeta(meta: SidecarSnapshotMeta): Promise<void> {
  const snapshotDir = getSnapshotDir(meta.sessionId, meta.messageUuid)
  await rm(snapshotDir, { recursive: true, force: true })
  await mkdir(snapshotDir, { recursive: true })

  const text = JSON.stringify(meta, null, 2)
  await writeFile(getSnapshotMetaPath(meta.sessionId, meta.messageUuid), text, 'utf-8')
  await writeFile(getLatestSnapshotPath(meta.sessionId), text, 'utf-8')
}

async function removeMissingEntries(
  rootPath: string,
  currentPath: string,
  currentRelativePath: string,
  snapshotPaths: Set<string>,
  changed: Set<string>,
): Promise<void> {
  if (!await pathExists(currentPath)) return
  const stat = await lstat(currentPath)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return

  const children = await readdir(currentPath)
  for (const child of children) {
    const childPath = join(currentPath, child)
    if (shouldSkip(childPath)) continue
    const childRelativePath = joinSnapshotPath(currentRelativePath, child)
    if (!snapshotPaths.has(childRelativePath)) {
      await rm(childPath, { recursive: true, force: true })
      changed.add(childRelativePath || rootPath)
      continue
    }
    await removeMissingEntries(rootPath, childPath, childRelativePath, snapshotPaths, changed)
  }
}

async function ensureDirectory(target: string, entry: SnapshotDirectoryEntry, changed: Set<string>): Promise<void> {
  if (await pathExists(target)) {
    const stat = await lstat(target)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      await rm(target, { recursive: true, force: true })
      changed.add(entry.path)
      await mkdir(target, { recursive: true })
    }
  } else {
    await mkdir(target, { recursive: true })
    changed.add(entry.path)
  }
}

async function restoreFile(
  sessionId: string,
  target: string,
  entry: SnapshotFileEntry,
  changed: Set<string>,
): Promise<void> {
  if (await fileMatchesSnapshot(target, entry)) return

  const blobPath = getBlobPath(sessionId, entry.hash)
  if (!existsSync(blobPath)) {
    throw new Error(`Proma sidecar 缺少文件 blob: ${entry.hash}`)
  }

  await mkdir(dirname(target), { recursive: true })
  const tempPath = join(dirname(target), `.proma-restore-${basename(target)}-${randomUUID()}.tmp`)
  try {
    await copyFileClone(blobPath, tempPath)
    await chmod(tempPath, entry.mode).catch(() => {})
    await utimes(tempPath, new Date(entry.mtimeMs), new Date(entry.mtimeMs)).catch(() => {})
    await rm(target, { recursive: true, force: true })
    await rename(tempPath, target)
    changed.add(entry.path)
  } catch (error) {
    await rm(tempPath, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function restoreSymlink(target: string, entry: SnapshotSymlinkEntry, changed: Set<string>): Promise<void> {
  if (await symlinkMatchesSnapshot(target, entry)) return
  await mkdir(dirname(target), { recursive: true })
  await rm(target, { recursive: true, force: true })
  await symlink(entry.target, target)
  changed.add(entry.path)
}

async function fileMatchesSnapshot(target: string, entry: SnapshotFileEntry): Promise<boolean> {
  if (!await pathExists(target)) return false
  const stat = await lstat(target)
  if (!stat.isFile() || stat.size !== entry.size || stat.mode !== entry.mode) return false
  const currentHash = await hashFile(target)
  return currentHash === entry.hash
}

async function symlinkMatchesSnapshot(target: string, entry: SnapshotSymlinkEntry): Promise<boolean> {
  if (!await pathExists(target)) return false
  const stat = await lstat(target)
  if (!stat.isSymbolicLink()) return false
  return await readlink(target) === entry.target
}

function resolveRestoreRootPath(
  root: SnapshotRootMeta,
  snapshotSessionId: string,
  options?: AgentSidecarRestoreOptions,
): string | undefined {
  if (getRootRestoreMode(root, snapshotSessionId) === 'skip') return undefined
  const ownedSessionId = inferOwnedSessionId(root, snapshotSessionId)
  if (ownedSessionId) {
    const mappedSessionCwd = options?.sessionCwdById?.get(ownedSessionId)
    if (mappedSessionCwd) return resolve(mappedSessionCwd)
  }

  const original = resolve(root.path)
  const mapped = options?.rootPathMap?.get(original)
  if (mapped) return resolve(mapped)
  if (options?.rootPathMap && options.restoreUnmappedRoots === false) return undefined
  return original
}

async function assertWritable(path: string, purpose: string): Promise<void> {
  let current = resolve(path)
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  try {
    await access(current, constants.W_OK)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Proma sidecar 恢复预检失败，缺少写入权限: ${purpose} (${current}) ${detail}`)
  }
}

async function preflightRestoreRoot(
  sessionId: string,
  root: SnapshotRootMeta,
  rootPath: string,
  snapshotSessionId: string,
): Promise<void> {
  if (isUnsafeSidecarRoot(rootPath)) {
    throw new Error(`拒绝恢复到高风险目录: ${rootPath}`)
  }

  const restoreMode = getRootRestoreMode(root, snapshotSessionId)
  if (restoreMode === 'skip') return

  const writableChecks = new Set<string>()
  const addWritableCheck = (path: string) => {
    writableChecks.add(resolve(path))
  }

  addWritableCheck(root.exists ? rootPath : dirname(rootPath))

  for (const entry of root.entries) {
    if (!isValidSnapshotRelativePath(entry.path)) {
      throw new Error(`Proma sidecar 快照路径非法: ${entry.path}`)
    }
    if (entry.kind === 'file' && !await blobMatchesEntry(sessionId, entry)) {
      throw new Error(`Proma sidecar 文件 blob 缺失或已损坏: ${entry.hash}`)
    }
    addWritableCheck(dirname(fromSnapshotPath(rootPath, entry.path)))
  }

  for (const path of writableChecks) {
    await assertWritable(path, rootPath)
  }
}

async function restoreRoot(
  sessionId: string,
  root: SnapshotRootMeta,
  rootPath: string,
  changed: Set<string>,
  snapshotSessionId: string,
): Promise<void> {
  const restoreMode = getRootRestoreMode(root, snapshotSessionId)
  if (restoreMode === 'skip') return

  if (!root.exists) {
    if (restoreMode === 'mirror' && await pathExists(rootPath)) {
      await rm(rootPath, { recursive: true, force: true })
      changed.add(rootPath)
    }
    return
  }

  await mkdir(rootPath, { recursive: true })
  const snapshotPaths = new Set(root.entries.map((entry) => entry.path))
  if (restoreMode === 'mirror') {
    await removeMissingEntries(rootPath, rootPath, '', snapshotPaths, changed)
  }

  const directories = sortDirectoriesForRestore(root.entries)
  for (const entry of directories) {
    await ensureDirectory(fromSnapshotPath(rootPath, entry.path), entry, changed)
  }

  for (const entry of root.entries) {
    const target = fromSnapshotPath(rootPath, entry.path)
    if (entry.kind === 'file') {
      await restoreFile(sessionId, target, entry, changed)
    } else if (entry.kind === 'symlink') {
      await restoreSymlink(target, entry, changed)
    }
  }

  for (const entry of sortDirectoriesForMetadata(directories)) {
    const target = fromSnapshotPath(rootPath, entry.path)
    await chmod(target, entry.mode).catch(() => {})
    await utimes(target, new Date(entry.mtimeMs), new Date(entry.mtimeMs)).catch(() => {})
  }
}

export async function createAgentSidecarSnapshot(input: AgentSidecarSnapshotInput): Promise<void> {
  const roots = normalizeSnapshotRoots(input)
  const skippedRoots = roots.filter((root) => root.restoreMode === 'skip')
  if (skippedRoots.length > 0) {
    console.warn(
      `[Agent Sidecar] 已标记不可恢复快照根目录: `
      + skippedRoots.map((root) => `${root.path}(${root.skippedReason ?? 'unknown'})`).join(', '),
    )
  }
  if (roots.length === 0) return

  const limits = getSnapshotLimits()
  const budget = createBudget(limits)
  const previousEntries = buildPreviousEntryMap(await readLatestSnapshotMeta(input.sessionId))

  const meta: SidecarSnapshotMeta = {
    version: SNAPSHOT_VERSION,
    sessionId: input.sessionId,
    messageUuid: input.messageUuid,
    createdAt: Date.now(),
    roots: [],
    limits,
    totals: budget.totals,
  }

  for (const root of roots) {
    meta.roots.push(await collectRootMeta(input.sessionId, root, previousEntries, budget))
  }
  meta.totals = budget.totals

  await writeSnapshotMeta(meta)
  console.log(
    `[Agent Sidecar] 已创建快照: sessionId=${input.sessionId}, messageUuid=${input.messageUuid}, roots=${meta.roots.length}, entries=${meta.totals.entries}, bytes=${formatBytes(meta.totals.bytes)}, reused=${meta.totals.filesReused}, stored=${meta.totals.filesStored}`,
  )
}

export async function restoreAgentSidecarSnapshot(
  sessionId: string,
  messageUuid: string,
  options?: AgentSidecarRestoreOptions,
): Promise<AgentSidecarRestoreResult> {
  const changed = new Set<string>()

  try {
    const meta = await readSnapshotMeta(sessionId, messageUuid)
    const explicitSkippedRoots = meta.roots.filter((root) => getRootRestoreMode(root, meta.sessionId) === 'skip').length
    const resolvedTargets = sortRootsForRestore(meta.roots, meta.sessionId)
      .map((root) => ({
        root,
        rootPath: resolveRestoreRootPath(root, meta.sessionId, options),
      }))
    const restoreTargets = resolvedTargets
      .filter((target): target is { root: SnapshotRootMeta; rootPath: string } => target.rootPath !== undefined)
    const unmappedSkippedRoots = resolvedTargets.filter((target) => (
      target.rootPath === undefined && getRootRestoreMode(target.root, meta.sessionId) !== 'skip'
    )).length
    const skippedRoots = explicitSkippedRoots + unmappedSkippedRoots

    if (meta.roots.length > 0 && restoreTargets.length === 0 && explicitSkippedRoots < meta.roots.length) {
      throw new Error('Proma sidecar 快照没有可恢复到当前会话的工作区 root')
    }

    for (const target of restoreTargets) {
      await preflightRestoreRoot(sessionId, target.root, target.rootPath, meta.sessionId)
    }
    for (const target of restoreTargets) {
      await restoreRoot(sessionId, target.root, target.rootPath, changed, meta.sessionId)
    }
    const filesChanged = [...changed].slice(0, 500)
    console.log(
      `[Agent Sidecar] 已恢复快照: sessionId=${sessionId}, messageUuid=${messageUuid}, `
      + `roots=${restoreTargets.length}, skipped=${skippedRoots}, changed=${changed.size}`,
    )
    return {
      canRewind: true,
      filesChanged,
      restoredRoots: restoreTargets.length,
      skippedRoots,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[Agent Sidecar] 恢复失败: ${message}`)
    return {
      canRewind: false,
      error: message,
      filesChanged: [...changed].slice(0, 500),
      partial: changed.size > 0,
    }
  }
}

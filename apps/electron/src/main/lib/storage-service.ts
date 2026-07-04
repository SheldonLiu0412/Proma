/**
 * 存储管理服务
 *
 * 提供磁盘用量统计、孤儿数据检测和清理功能。
 * 由设置面板"磁盘管理"Tab 和启动时自动清理逻辑调用。
 */

import { existsSync, statSync, unlinkSync, rmSync } from 'node:fs'
import { promises as fsPromises } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import {
  getConfigDir,
  getAgentSessionsDir,
  getSdkConfigDir,
  getAgentSidecarSnapshotsDir,
  getAgentWorkspacesDir,
  getAttachmentsDir,
  getConversationsDir,
} from './config-paths'
import { getAgentSessionSDKMessages, listAgentSessions } from './agent-session-manager'
import { listAgentWorkspaces } from './agent-workspace-manager'
import { AGENT_SIDECAR_BLOBS_DIR, AGENT_SIDECAR_LATEST_SNAPSHOT_FILE } from './agent-sidecar-snapshot'

// ─── 类型定义 ───

export type StorageCategoryKey =
  | 'agent-sessions'
  | 'sdk-config'
  | 'agent-sidecar'
  | 'workspaces'
  | 'conversations'
  | 'attachments'
  | 'temp-files'

export interface StorageCategory {
  label: string
  key: StorageCategoryKey
  bytes: number
  count: number
  hasOrphans: boolean
  orphanBytes: number
  orphanCount: number
}

export interface StorageStats {
  categories: StorageCategory[]
  totalBytes: number
  calculatedAt: number
}

export interface CleanupOptions {
  categories: StorageCategoryKey[]
  orphansOnly: boolean
  archivedBeforeDays: number
}

export interface CleanupResult {
  freedBytes: number
  deletedCount: number
  errors: string[]
}

// ─── 工具函数 ───

// 扫描时跳过的已知大型目录，防止超大工作区阻塞主进程事件循环
const SKIP_DIRS = new Set([
  'node_modules', '.next', '.nuxt', '.git', 'dist', 'build',
  '.cache', '__pycache__', '.venv', 'venv', '.tox', 'target', '.gradle',
  '.turbo', '.parcel-cache', '.svelte-kit', '.output',
])

// 单次扫描最大文件数上限，防止超大工作区导致无限递归
const MAX_FILE_SCAN = 100_000

async function getDirSize(dirPath: string): Promise<{ bytes: number; count: number }> {
  let bytes = 0
  let count = 0
  if (!existsSync(dirPath)) return { bytes, count }

  // limit 对象通过闭包在整个递归树内共享，作为全局文件计数上限
  const limit = { remaining: MAX_FILE_SCAN }

  async function walk(dir: string): Promise<void> {
    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (limit.remaining <= 0) return
        const fullPath = join(dir, entry.name)
        try {
          if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue
            await walk(fullPath)
          } else if (entry.isFile()) {
            const stat = await fsPromises.stat(fullPath)
            bytes += stat.size
            count++
            limit.remaining--
          }
        } catch { /* skip inaccessible */ }
      }
    } catch { /* skip inaccessible dir */ }
  }

  await walk(dirPath)
  return { bytes, count }
}

function safeUnlink(filePath: string): number {
  try {
    const size = statSync(filePath).size
    unlinkSync(filePath)
    return size
  } catch {
    return 0
  }
}

async function safeRmDir(dirPath: string): Promise<number> {
  try {
    const { bytes } = await getDirSize(dirPath)
    rmSync(dirPath, { recursive: true, force: true })
    return bytes
  } catch {
    return 0
  }
}

// ─── 统计 ───

function getActiveSessionIds(): Set<string> {
  return new Set(listAgentSessions().map((s) => s.id))
}

function getReferencedSidecarSessionIds(): Set<string> {
  const ids = new Set<string>()
  for (const session of listAgentSessions()) {
    ids.add(session.id)
    if (session.forkSourceSessionId) ids.add(session.forkSourceSessionId)
  }
  return ids
}

function getActiveSdkSessionIds(): Set<string> {
  const ids = new Set<string>()
  for (const s of listAgentSessions()) {
    if (s.sdkSessionId) ids.add(s.sdkSessionId)
    if (s.legacySdkSessionId) ids.add(s.legacySdkSessionId)
    if (s.forkSourceSdkSessionId) ids.add(s.forkSourceSdkSessionId)
  }
  return ids
}

function isActiveSdkSessionFile(fileName: string, activeSdkIds: Set<string>): boolean {
  if (!fileName.endsWith('.jsonl')) return false
  const stem = basename(fileName, '.jsonl')
  if (activeSdkIds.has(stem)) return true
  for (const sdkId of activeSdkIds) {
    if (stem.includes(sdkId)) return true
  }
  return false
}

function isSidecarReservedEntry(name: string): boolean {
  return name === AGENT_SIDECAR_BLOBS_DIR || name === AGENT_SIDECAR_LATEST_SNAPSHOT_FILE
}

function addBlobHashesFromSidecarMeta(meta: unknown, hashes: Set<string>): void {
  if (!meta || typeof meta !== 'object') return
  const roots = (meta as { roots?: unknown }).roots
  if (!Array.isArray(roots)) return
  for (const root of roots) {
    const entries = (root as { entries?: unknown }).entries
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue
      const record = entry as { kind?: unknown; hash?: unknown }
      if (record.kind === 'file' && typeof record.hash === 'string') {
        hashes.add(record.hash)
      }
    }
  }
}

async function readJsonFileSafe(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fsPromises.readFile(filePath, 'utf-8')) as unknown
  } catch {
    return undefined
  }
}

async function collectReferencedSidecarBlobHashes(sessionPath: string): Promise<Set<string>> {
  const hashes = new Set<string>()
  const entries = await fsPromises.readdir(sessionPath).catch(() => [])
  for (const entry of entries) {
    if (entry === AGENT_SIDECAR_BLOBS_DIR) continue
    if (entry === AGENT_SIDECAR_LATEST_SNAPSHOT_FILE) {
      addBlobHashesFromSidecarMeta(await readJsonFileSafe(join(sessionPath, entry)), hashes)
      continue
    }
    const snapshotPath = join(sessionPath, entry)
    try {
      if (!(await fsPromises.lstat(snapshotPath)).isDirectory()) continue
      addBlobHashesFromSidecarMeta(await readJsonFileSafe(join(snapshotPath, 'snapshot.json')), hashes)
    } catch {
      // skip inaccessible snapshot
    }
  }
  return hashes
}

async function cleanupStaleLatestSidecarIndex(
  sessionPath: string,
  sidecarSessionId: string,
  activeSnapshotKeys: Set<string>,
): Promise<CleanupResult> {
  const latestPath = join(sessionPath, AGENT_SIDECAR_LATEST_SNAPSHOT_FILE)
  const meta = await readJsonFileSafe(latestPath)
  const messageUuid = meta && typeof meta === 'object'
    ? (meta as { messageUuid?: unknown }).messageUuid
    : undefined
  if (typeof messageUuid !== 'string' || activeSnapshotKeys.has(`${sidecarSessionId}/${messageUuid}`)) {
    return { freedBytes: 0, deletedCount: 0, errors: [] }
  }
  const freed = safeUnlink(latestPath)
  return { freedBytes: freed, deletedCount: freed > 0 ? 1 : 0, errors: [] }
}

async function cleanupUnreferencedSidecarBlobs(sessionPath: string, referencedHashes: Set<string>): Promise<CleanupResult> {
  const blobsDir = join(sessionPath, AGENT_SIDECAR_BLOBS_DIR)
  let freedBytes = 0
  let deletedCount = 0
  const errors: string[] = []
  if (!existsSync(blobsDir)) return { freedBytes, deletedCount, errors }

  try {
    const buckets = await fsPromises.readdir(blobsDir)
    for (const bucket of buckets) {
      const bucketPath = join(blobsDir, bucket)
      try {
        if (!(await fsPromises.lstat(bucketPath)).isDirectory()) continue
        const files = await fsPromises.readdir(bucketPath)
        for (const file of files) {
          const blobPath = join(bucketPath, file)
          try {
            if (!(await fsPromises.lstat(blobPath)).isFile()) continue
            if (referencedHashes.has(file)) continue
            const freed = safeUnlink(blobPath)
            if (freed > 0) {
              freedBytes += freed
              deletedCount++
            }
          } catch {
            // skip inaccessible blob
          }
        }
        const remaining = await fsPromises.readdir(bucketPath).catch(() => [])
        if (remaining.length === 0) rmSync(bucketPath, { recursive: true, force: true })
      } catch {
        // skip inaccessible bucket
      }
    }
    const remainingBuckets = await fsPromises.readdir(blobsDir).catch(() => [])
    if (remainingBuckets.length === 0) rmSync(blobsDir, { recursive: true, force: true })
  } catch (error) {
    errors.push(`清理孤儿 sidecar blob 失败: ${error}`)
  }

  return { freedBytes, deletedCount, errors }
}

function mergeCleanupResult(target: CleanupResult, source: CleanupResult): void {
  target.freedBytes += source.freedBytes
  target.deletedCount += source.deletedCount
  target.errors.push(...source.errors)
}

function addSidecarSnapshotKeys(keys: Set<string>, sidecarSessionId: string, sessionId: string): void {
  for (const message of getAgentSessionSDKMessages(sessionId)) {
    const record = message as unknown as Record<string, unknown>
    if (
      typeof record.uuid === 'string' &&
      (record.type === 'user' || record.type === 'assistant' || record.type === 'system')
    ) {
      keys.add(`${sidecarSessionId}/${record.uuid}`)
    }
  }
}

function getActiveSidecarSnapshotKeys(): Set<string> {
  const keys = new Set<string>()
  for (const session of listAgentSessions()) {
    addSidecarSnapshotKeys(keys, session.id, session.id)
    if (session.forkSourceSessionId) {
      addSidecarSnapshotKeys(keys, session.forkSourceSessionId, session.id)
    }
  }
  return keys
}

function getActiveWorkspaceSlugs(): Set<string> {
  return new Set(listAgentWorkspaces().map((w) => w.slug))
}

async function calcAgentSessionsCategory(): Promise<StorageCategory> {
  const dir = getAgentSessionsDir()
  const activeIds = getActiveSessionIds()
  let bytes = 0, count = 0, orphanBytes = 0, orphanCount = 0

  if (existsSync(dir)) {
    try {
      const files = await fsPromises.readdir(dir)
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const fullPath = join(dir, file)
        try {
          const stat = await fsPromises.stat(fullPath)
          const id = basename(file, '.jsonl')
          bytes += stat.size
          count++
          if (!activeIds.has(id)) {
            orphanBytes += stat.size
            orphanCount++
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return {
    label: 'Agent 会话记录',
    key: 'agent-sessions',
    bytes, count,
    hasOrphans: orphanCount > 0,
    orphanBytes, orphanCount,
  }
}

async function calcSdkConfigCategory(): Promise<StorageCategory> {
  const sdkDir = getSdkConfigDir()
  const activeSdkIds = getActiveSdkSessionIds()
  let bytes = 0, count = 0, orphanBytes = 0, orphanCount = 0

  const projectsDir = join(sdkDir, 'projects')
  if (existsSync(projectsDir)) {
    try {
      const hashDirs = await fsPromises.readdir(projectsDir)
      for (const hashDir of hashDirs) {
        const projPath = join(projectsDir, hashDir)
        try {
          if (!(await fsPromises.lstat(projPath)).isDirectory()) continue
          const files = await fsPromises.readdir(projPath)
          for (const file of files) {
            if (!file.endsWith('.jsonl')) continue
            const fullPath = join(projPath, file)
            try {
              const stat = await fsPromises.stat(fullPath)
              bytes += stat.size
              count++
              if (!isActiveSdkSessionFile(file, activeSdkIds)) {
                orphanBytes += stat.size
                orphanCount++
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  const fileHistoryDir = join(sdkDir, 'file-history')
  if (existsSync(fileHistoryDir)) {
    try {
      const sdkIds = await fsPromises.readdir(fileHistoryDir)
      for (const sdkId of sdkIds) {
        const histPath = join(fileHistoryDir, sdkId)
        try {
          if (!(await fsPromises.lstat(histPath)).isDirectory()) continue
          const sub = await getDirSize(histPath)
          bytes += sub.bytes
          count += sub.count
          if (!activeSdkIds.has(sdkId)) {
            orphanBytes += sub.bytes
            orphanCount += sub.count
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  const sessionsDir = join(sdkDir, 'sessions')
  if (existsSync(sessionsDir)) {
    try {
      const files = await fsPromises.readdir(sessionsDir)
      for (const file of files) {
        const fullPath = join(sessionsDir, file)
        try {
          const stat = await fsPromises.lstat(fullPath)
          if (stat.isDirectory()) {
            const sub = await getDirSize(fullPath)
            bytes += sub.bytes
            count += sub.count
            if (!activeSdkIds.has(file)) {
              orphanBytes += sub.bytes
              orphanCount += sub.count
            }
            continue
          }
          if (!stat.isFile()) continue
          bytes += stat.size
          count++
          if (!isActiveSdkSessionFile(file, activeSdkIds)) {
            orphanBytes += stat.size
            orphanCount++
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  // sdk-config 其他子目录（backups 等）
  if (existsSync(sdkDir)) {
    try {
      const entries = await fsPromises.readdir(sdkDir)
      for (const entry of entries) {
        if (entry === 'projects' || entry === 'file-history' || entry === 'sessions') continue
        const fullPath = join(sdkDir, entry)
        try {
          const stat = await fsPromises.lstat(fullPath)
          if (stat.isDirectory()) {
            const sub = await getDirSize(fullPath)
            bytes += sub.bytes
            count += sub.count
          } else {
            bytes += stat.size
            count++
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return {
    label: 'runtime 会话数据',
    key: 'sdk-config',
    bytes, count,
    hasOrphans: orphanCount > 0,
    orphanBytes, orphanCount,
  }
}

async function calcAgentSidecarCategory(): Promise<StorageCategory> {
  const snapshotsDir = getAgentSidecarSnapshotsDir()
  const activeSessionIds = getActiveSessionIds()
  const referencedSessionIds = getReferencedSidecarSessionIds()
  const activeSnapshotKeys = getActiveSidecarSnapshotKeys()
  let bytes = 0, count = 0, orphanBytes = 0, orphanCount = 0

  if (existsSync(snapshotsDir)) {
    try {
      const sessionDirs = await fsPromises.readdir(snapshotsDir)
      for (const sessionId of sessionDirs) {
        const sessionPath = join(snapshotsDir, sessionId)
        try {
          if (!(await fsPromises.lstat(sessionPath)).isDirectory()) continue
          const sessionSize = await getDirSize(sessionPath)
          bytes += sessionSize.bytes
          count += sessionSize.count
          if (!referencedSessionIds.has(sessionId)) {
            orphanBytes += sessionSize.bytes
            orphanCount += sessionSize.count
            continue
          }
          if (!activeSessionIds.has(sessionId)) continue
          const snapshotDirs = await fsPromises.readdir(sessionPath)
          for (const messageUuid of snapshotDirs) {
            if (isSidecarReservedEntry(messageUuid)) continue
            const snapshotPath = join(sessionPath, messageUuid)
            try {
              if (!(await fsPromises.lstat(snapshotPath)).isDirectory()) continue
              const sub = await getDirSize(snapshotPath)
              if (!activeSnapshotKeys.has(`${sessionId}/${messageUuid}`)) {
                orphanBytes += sub.bytes
                orphanCount += sub.count
              }
            } catch { /* skip */ }
          }
          const referencedBlobHashes = await collectReferencedSidecarBlobHashes(sessionPath)
          const blobsPath = join(sessionPath, AGENT_SIDECAR_BLOBS_DIR)
          if (existsSync(blobsPath)) {
            const buckets = await fsPromises.readdir(blobsPath).catch(() => [])
            for (const bucket of buckets) {
              const bucketPath = join(blobsPath, bucket)
              try {
                if (!(await fsPromises.lstat(bucketPath)).isDirectory()) continue
                const files = await fsPromises.readdir(bucketPath)
                for (const file of files) {
                  if (referencedBlobHashes.has(file)) continue
                  const blobPath = join(bucketPath, file)
                  try {
                    const stat = await fsPromises.stat(blobPath)
                    if (!stat.isFile()) continue
                    orphanBytes += stat.size
                    orphanCount++
                  } catch { /* skip */ }
                }
              } catch { /* skip */ }
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return {
    label: 'Agent 文件快照',
    key: 'agent-sidecar',
    bytes, count,
    hasOrphans: orphanCount > 0,
    orphanBytes, orphanCount,
  }
}

async function calcWorkspacesCategory(): Promise<StorageCategory> {
  const wsDir = getAgentWorkspacesDir()
  const activeIds = getActiveSessionIds()
  const activeSlugs = getActiveWorkspaceSlugs()
  let bytes = 0, count = 0, orphanBytes = 0, orphanCount = 0

  if (existsSync(wsDir)) {
    try {
      const slugs = await fsPromises.readdir(wsDir)
      for (const slug of slugs) {
        const slugDir = join(wsDir, slug)
        try {
          if (!(await fsPromises.lstat(slugDir)).isDirectory()) continue
          const entries = await fsPromises.readdir(slugDir)
          for (const entry of entries) {
            const entryPath = join(slugDir, entry)
            try {
              if (!(await fsPromises.lstat(entryPath)).isDirectory()) continue
              // workspace-files, skills, skills-inactive 等元目录不算孤儿
              if (['workspace-files', 'skills', 'skills-inactive', '.claude-plugin'].includes(entry)) {
                const sub = await getDirSize(entryPath)
                bytes += sub.bytes
                count += sub.count
                continue
              }
              const sub = await getDirSize(entryPath)
              bytes += sub.bytes
              count += sub.count
              // session 目录的 ID 不在活跃列表中 → 孤儿
              if (!activeIds.has(entry) && !activeSlugs.has(entry)) {
                orphanBytes += sub.bytes
                orphanCount++
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return {
    label: '工作区文件',
    key: 'workspaces',
    bytes, count,
    hasOrphans: orphanCount > 0,
    orphanBytes, orphanCount,
  }
}

async function calcConversationsCategory(): Promise<StorageCategory> {
  const dir = getConversationsDir()
  const { bytes, count } = await getDirSize(dir)
  return {
    label: '对话记录',
    key: 'conversations',
    bytes, count,
    hasOrphans: false,
    orphanBytes: 0, orphanCount: 0,
  }
}

async function calcAttachmentsCategory(): Promise<StorageCategory> {
  const dir = getAttachmentsDir()
  const { bytes, count } = await getDirSize(dir)
  return {
    label: '附件文件',
    key: 'attachments',
    bytes, count,
    hasOrphans: false,
    orphanBytes: 0, orphanCount: 0,
  }
}

async function calcTempFilesCategory(): Promise<StorageCategory> {
  const previewDir = join(tmpdir(), 'proma-preview')
  const installerDir = join(app.getPath('temp'), 'proma-installers')
  const [preview, installer] = await Promise.all([
    getDirSize(previewDir),
    getDirSize(installerDir),
  ])
  return {
    label: '临时预览/安装文件',
    key: 'temp-files',
    bytes: preview.bytes + installer.bytes,
    count: preview.count + installer.count,
    hasOrphans: false,
    orphanBytes: 0, orphanCount: 0,
  }
}

export async function calculateStorageStats(): Promise<StorageStats> {
  const categories = await Promise.all([
    calcAgentSessionsCategory(),
    calcSdkConfigCategory(),
    calcAgentSidecarCategory(),
    calcWorkspacesCategory(),
    calcConversationsCategory(),
    calcAttachmentsCategory(),
    calcTempFilesCategory(),
  ])
  return {
    categories,
    totalBytes: categories.reduce((sum, c) => sum + c.bytes, 0),
    calculatedAt: Date.now(),
  }
}

// ─── 清理 ───

export async function cleanupTempFiles(): Promise<CleanupResult> {
  let freedBytes = 0, deletedCount = 0
  const errors: string[] = []

  const previewDir = join(tmpdir(), 'proma-preview')
  if (existsSync(previewDir)) {
    try {
      const files = await fsPromises.readdir(previewDir)
      for (const file of files) {
        const freed = safeUnlink(join(previewDir, file))
        if (freed > 0) { freedBytes += freed; deletedCount++ }
      }
    } catch (e) {
      errors.push(`清理预览文件失败: ${e}`)
    }
  }

  const installerDir = join(app.getPath('temp'), 'proma-installers')
  if (existsSync(installerDir)) {
    try {
      const files = await fsPromises.readdir(installerDir)
      for (const file of files) {
        const freed = safeUnlink(join(installerDir, file))
        if (freed > 0) { freedBytes += freed; deletedCount++ }
      }
    } catch (e) {
      errors.push(`清理安装文件失败: ${e}`)
    }
  }

  if (freedBytes > 0) {
    console.log(`[存储清理] 临时文件: 释放 ${(freedBytes / 1024 / 1024).toFixed(1)} MB, 删除 ${deletedCount} 个文件`)
  }
  return { freedBytes, deletedCount, errors }
}

async function cleanupOrphanAgentSessions(): Promise<CleanupResult> {
  const dir = getAgentSessionsDir()
  const activeIds = getActiveSessionIds()
  let freedBytes = 0, deletedCount = 0
  const errors: string[] = []

  if (!existsSync(dir)) return { freedBytes, deletedCount, errors }

  try {
    const files = await fsPromises.readdir(dir)
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const id = basename(file, '.jsonl')
      if (activeIds.has(id)) continue
      const freed = safeUnlink(join(dir, file))
      if (freed > 0) { freedBytes += freed; deletedCount++ }
    }
  } catch (e) {
    errors.push(`清理孤儿会话文件失败: ${e}`)
  }

  return { freedBytes, deletedCount, errors }
}

async function cleanupOrphanSdkConfig(): Promise<CleanupResult> {
  const sdkDir = getSdkConfigDir()
  const activeSdkIds = getActiveSdkSessionIds()
  let freedBytes = 0, deletedCount = 0
  const errors: string[] = []

  const projectsDir = join(sdkDir, 'projects')
  if (existsSync(projectsDir)) {
    try {
      const hashDirs = await fsPromises.readdir(projectsDir)
      for (const hashDir of hashDirs) {
        const projPath = join(projectsDir, hashDir)
        try {
          if (!(await fsPromises.lstat(projPath)).isDirectory()) continue
          const files = await fsPromises.readdir(projPath)
          for (const file of files) {
            if (!file.endsWith('.jsonl')) continue
            if (isActiveSdkSessionFile(file, activeSdkIds)) continue
            const freed = safeUnlink(join(projPath, file))
            if (freed > 0) { freedBytes += freed; deletedCount++ }
          }
          // 若目录为空则删除
          const remaining = await fsPromises.readdir(projPath)
          if (remaining.length === 0) {
            rmSync(projPath, { recursive: true, force: true })
          }
        } catch { /* skip */ }
      }
    } catch (e) {
      errors.push(`清理孤儿 runtime projects 失败: ${e}`)
    }
  }

  const fileHistoryDir = join(sdkDir, 'file-history')
  if (existsSync(fileHistoryDir)) {
    try {
      const sdkIds = await fsPromises.readdir(fileHistoryDir)
      for (const sdkId of sdkIds) {
        if (activeSdkIds.has(sdkId)) continue
        const histPath = join(fileHistoryDir, sdkId)
        try {
          if (!(await fsPromises.lstat(histPath)).isDirectory()) continue
          const freed = await safeRmDir(histPath)
          if (freed > 0) { freedBytes += freed; deletedCount++ }
        } catch { /* skip */ }
      }
    } catch (e) {
      errors.push(`清理孤儿历史 file-history 失败: ${e}`)
    }
  }

  const sessionsDir = join(sdkDir, 'sessions')
  if (existsSync(sessionsDir)) {
    try {
      const files = await fsPromises.readdir(sessionsDir)
      for (const file of files) {
        const fullPath = join(sessionsDir, file)
        try {
          const stat = await fsPromises.lstat(fullPath)
          if (stat.isDirectory()) {
            if (activeSdkIds.has(file)) continue
            const freed = await safeRmDir(fullPath)
            if (freed > 0) { freedBytes += freed; deletedCount++ }
            continue
          }
          if (!stat.isFile() || !file.endsWith('.jsonl')) continue
          if (isActiveSdkSessionFile(file, activeSdkIds)) continue
          const freed = safeUnlink(fullPath)
          if (freed > 0) { freedBytes += freed; deletedCount++ }
        } catch { /* skip */ }
      }
    } catch (e) {
      errors.push(`清理孤儿 runtime sessions 失败: ${e}`)
    }
  }

  return { freedBytes, deletedCount, errors }
}

async function cleanupOrphanAgentSidecar(): Promise<CleanupResult> {
  const snapshotsDir = getAgentSidecarSnapshotsDir()
  const activeSessionIds = getActiveSessionIds()
  const referencedSessionIds = getReferencedSidecarSessionIds()
  const activeSnapshotKeys = getActiveSidecarSnapshotKeys()
  let freedBytes = 0, deletedCount = 0
  const errors: string[] = []

  if (!existsSync(snapshotsDir)) return { freedBytes, deletedCount, errors }

  try {
    const sessionDirs = await fsPromises.readdir(snapshotsDir)
    for (const sessionId of sessionDirs) {
      const sessionPath = join(snapshotsDir, sessionId)
      try {
        if (!(await fsPromises.lstat(sessionPath)).isDirectory()) continue
        if (!referencedSessionIds.has(sessionId)) {
          const freed = await safeRmDir(sessionPath)
          if (freed > 0) { freedBytes += freed; deletedCount++ }
          continue
        }
        if (!activeSessionIds.has(sessionId)) continue

        const snapshotDirs = await fsPromises.readdir(sessionPath)
        for (const messageUuid of snapshotDirs) {
          if (isSidecarReservedEntry(messageUuid)) continue
          if (activeSnapshotKeys.has(`${sessionId}/${messageUuid}`)) continue
          const snapshotPath = join(sessionPath, messageUuid)
          try {
            if (!(await fsPromises.lstat(snapshotPath)).isDirectory()) continue
            const freed = await safeRmDir(snapshotPath)
            if (freed > 0) { freedBytes += freed; deletedCount++ }
          } catch { /* skip */ }
        }

        const sidecarCleanup: CleanupResult = { freedBytes: 0, deletedCount: 0, errors: [] }
        mergeCleanupResult(sidecarCleanup, await cleanupStaleLatestSidecarIndex(sessionPath, sessionId, activeSnapshotKeys))
        mergeCleanupResult(sidecarCleanup, await cleanupUnreferencedSidecarBlobs(
          sessionPath,
          await collectReferencedSidecarBlobHashes(sessionPath),
        ))
        freedBytes += sidecarCleanup.freedBytes
        deletedCount += sidecarCleanup.deletedCount
        errors.push(...sidecarCleanup.errors)

        try {
          const remaining = (await fsPromises.readdir(sessionPath))
            .filter((entry) => !isSidecarReservedEntry(entry))
          if (remaining.length === 0) {
            const hasReservedData = (await fsPromises.readdir(sessionPath)).length > 0
            if (!hasReservedData) rmSync(sessionPath, { recursive: true, force: true })
          }
        } catch { /* skip */ }
      } catch { /* skip */ }
    }
  } catch (e) {
    errors.push(`清理孤儿 Agent 文件快照失败: ${e}`)
  }

  return { freedBytes, deletedCount, errors }
}

async function cleanupOrphanWorkspaces(): Promise<CleanupResult> {
  const wsDir = getAgentWorkspacesDir()
  const activeIds = getActiveSessionIds()
  const activeSlugs = getActiveWorkspaceSlugs()
  let freedBytes = 0, deletedCount = 0
  const errors: string[] = []

  if (!existsSync(wsDir)) return { freedBytes, deletedCount, errors }

  try {
    const slugs = await fsPromises.readdir(wsDir)
    for (const slug of slugs) {
      const slugDir = join(wsDir, slug)
      try {
        if (!(await fsPromises.lstat(slugDir)).isDirectory()) continue
        const entries = await fsPromises.readdir(slugDir)
        for (const entry of entries) {
          if (['workspace-files', 'skills', 'skills-inactive', '.claude-plugin'].includes(entry)) continue
          const entryPath = join(slugDir, entry)
          try {
            if (!(await fsPromises.lstat(entryPath)).isDirectory()) continue
            if (activeIds.has(entry) || activeSlugs.has(entry)) continue
            const freed = await safeRmDir(entryPath)
            if (freed > 0) { freedBytes += freed; deletedCount++ }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch (e) {
    errors.push(`清理孤儿工作区目录失败: ${e}`)
  }

  return { freedBytes, deletedCount, errors }
}

async function cleanupArchivedSessions(beforeDays: number): Promise<CleanupResult> {
  const cutoff = Date.now() - beforeDays * 24 * 60 * 60 * 1000
  const sessions = listAgentSessions()
  const sdkDir = getSdkConfigDir()
  const sidecarSnapshotsDir = getAgentSidecarSnapshotsDir()
  const archivedIds = new Set(sessions
    .filter((session) => session.archived && session.updatedAt <= cutoff)
    .map((session) => session.id))
  const sidecarReferencedByRemaining = new Set<string>()
  const sdkReferencedByRemaining = new Set<string>()
  for (const session of sessions) {
    if (archivedIds.has(session.id)) continue
    sidecarReferencedByRemaining.add(session.id)
    if (session.forkSourceSessionId) sidecarReferencedByRemaining.add(session.forkSourceSessionId)
    if (session.sdkSessionId) sdkReferencedByRemaining.add(session.sdkSessionId)
    if (session.legacySdkSessionId) sdkReferencedByRemaining.add(session.legacySdkSessionId)
    if (session.forkSourceSdkSessionId) sdkReferencedByRemaining.add(session.forkSourceSdkSessionId)
  }
  let freedBytes = 0, deletedCount = 0
  const errors: string[] = []

  for (const session of sessions) {
    if (!session.archived || session.updatedAt > cutoff) continue

    // 删除 JSONL 消息文件
    const msgPath = join(getAgentSessionsDir(), `${session.id}.jsonl`)
    if (existsSync(msgPath)) {
      const freed = safeUnlink(msgPath)
      if (freed > 0) { freedBytes += freed; deletedCount++ }
    }

    // 清理历史 runtime file-history（旧版本残留）
    if (session.sdkSessionId && !sdkReferencedByRemaining.has(session.sdkSessionId)) {
      const histDir = join(sdkDir, 'file-history', session.sdkSessionId)
      if (existsSync(histDir)) {
        const freed = await safeRmDir(histDir)
        if (freed > 0) { freedBytes += freed; deletedCount++ }
      }
    }

    // 清理 Pi runtime sessions（文件名可能包含 sdkSessionId 而非完全等于 sdkSessionId）
    if (session.sdkSessionId && !sdkReferencedByRemaining.has(session.sdkSessionId)) {
      const sessionsDir = join(sdkDir, 'sessions')
      if (existsSync(sessionsDir)) {
        const files = await fsPromises.readdir(sessionsDir).catch(() => [])
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue
          if (!file.includes(session.sdkSessionId)) continue
          const freed = safeUnlink(join(sessionsDir, file))
          if (freed > 0) { freedBytes += freed; deletedCount++ }
        }
      }
    }

    // 清理 Proma sidecar 快照
    const sidecarSessionDir = join(sidecarSnapshotsDir, session.id)
    if (!sidecarReferencedByRemaining.has(session.id) && existsSync(sidecarSessionDir)) {
      const freed = await safeRmDir(sidecarSessionDir)
      if (freed > 0) { freedBytes += freed; deletedCount++ }
    }
  }

  if (freedBytes > 0) {
    console.log(`[存储清理] 归档数据: 释放 ${(freedBytes / 1024 / 1024).toFixed(1)} MB, 删除 ${deletedCount} 项`)
  }
  return { freedBytes, deletedCount, errors }
}

export async function cleanupStorage(options: CleanupOptions): Promise<CleanupResult> {
  let totalFreed = 0, totalDeleted = 0
  const allErrors: string[] = []

  const merge = (r: CleanupResult) => {
    totalFreed += r.freedBytes
    totalDeleted += r.deletedCount
    allErrors.push(...r.errors)
  }

  for (const cat of options.categories) {
    if (cat === 'temp-files') {
      merge(await cleanupTempFiles())
      continue
    }

    if (options.orphansOnly) {
      switch (cat) {
        case 'agent-sessions': merge(await cleanupOrphanAgentSessions()); break
        case 'sdk-config': merge(await cleanupOrphanSdkConfig()); break
        case 'agent-sidecar': merge(await cleanupOrphanAgentSidecar()); break
        case 'workspaces': merge(await cleanupOrphanWorkspaces()); break
      }
    } else if (options.archivedBeforeDays > 0) {
      if (cat === 'agent-sessions' || cat === 'sdk-config' || cat === 'agent-sidecar') {
        merge(await cleanupArchivedSessions(options.archivedBeforeDays))
      }
    }
  }

  if (totalFreed > 0) {
    console.log(`[存储清理] 总计释放 ${(totalFreed / 1024 / 1024).toFixed(1)} MB, 删除 ${totalDeleted} 项`)
  }
  return { freedBytes: totalFreed, deletedCount: totalDeleted, errors: allErrors }
}

/**
 * Agent 会话管理器
 *
 * 负责 Agent 会话的 CRUD 操作和消息持久化。
 * - 会话索引：~/.proma/agent-sessions.json（轻量元数据）
 * - 消息存储：~/.proma/agent-sessions/{id}.jsonl（JSONL 格式，逐行追加）
 *
 * 照搬 conversation-manager.ts 的模式。
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync, rmSync, renameSync, readdirSync, createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { writeJsonFileAtomic, readJsonFileSafe } from './safe-file'
import { randomUUID } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import {
  getAgentSessionsIndexPath,
  getAgentSessionsDir,
  getAgentSessionMessagesPath,
  getAgentSessionWorkspacePath,
  getAgentWorkspacePath,
} from './config-paths'
import { getAgentWorkspace } from './agent-workspace-manager'
import type {
  AgentSessionMeta,
  AgentMessage,
  SDKMessage,
  ForkSessionInput,
  AgentMessageSearchResult,
  AgentSessionReferenceSearchInput,
  AgentSessionReferenceSearchResult,
} from '@proma/shared'
import { getConversationMessages } from './conversation-manager'
// 旧格式 → SDKMessage 的转换逻辑下沉到 @proma/session-core 作为唯一真源，避免主进程与渲染层各存一份。
import { convertLegacyMessage } from '@proma/session-core'
import { clearNanoBananaAgentHistory } from './chat-tools/nano-banana-mcp'
import { assertEnabledModelForChannel } from './agent-model-selection'
import { copyForkWorkspaceFiles } from './agent-fork-workspace-copy'
import { deleteSessionSidecarSnapshots, getAgentSidecarSessionOwnedRootPaths, restoreAgentSidecarSnapshot } from './agent-sidecar-snapshot'

/**
 * 会话索引文件格式
 */
interface AgentSessionsIndex {
  /** 配置版本号 */
  version: number
  /** 会话元数据列表 */
  sessions: AgentSessionMeta[]
}

/** 当前索引版本 */
const INDEX_VERSION = 1

interface JsonlParseError {
  lineNumber: number
  message: string
}

/**
 * 逐行解析 JSONL，调用方按业务场景决定容错或严格失败。
 */
function parseJsonlLines<T>(lines: string[]): { records: T[]; errors: JsonlParseError[] } {
  const records: T[] = []
  const errors: JsonlParseError[] = []
  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]!) as T)
    } catch (err) {
      errors.push({
        lineNumber: i + 1,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { records, errors }
}

/**
 * 展示/检索类读取：跳过损坏行，保留其它可读消息。
 */
function parseJsonlLenient<T>(lines: string[], context: string): T[] {
  const { records, errors } = parseJsonlLines<T>(lines)
  for (const error of errors) {
    console.warn(`[Agent 会话] ${context} — JSONL 第 ${error.lineNumber} 行解析失败，已跳过:`, error.message)
  }
  return records
}

/**
 * 回退/文件恢复类读取：任何损坏行都可能破坏消息顺序或快照完整性，必须停止。
 */
function parseJsonlStrict<T>(lines: string[], context: string): T[] {
  const { records, errors } = parseJsonlLines<T>(lines)
  if (errors.length > 0) {
    const first = errors[0]!
    throw new Error(`${context} 失败：JSONL 第 ${first.lineNumber} 行解析失败: ${first.message}`)
  }
  return records
}

function normalizePersistedSDKMessage(parsed: unknown): SDKMessage {
  // 旧格式检测：AgentMessage 有 `role` 字段，SDKMessage 有 `type` 字段
  if (parsed && typeof parsed === 'object' && 'role' in parsed && !('type' in parsed)) {
    return convertLegacyMessage(parsed as AgentMessage)
  }
  return parsed as SDKMessage
}

/**
 * 读取会话索引文件
 */
function readIndex(): AgentSessionsIndex {
  const indexPath = getAgentSessionsIndexPath()
  const data = readJsonFileSafe<AgentSessionsIndex>(indexPath)
  if (data) return data
  return { version: INDEX_VERSION, sessions: [] }
}

/**
 * 写入会话索引文件
 */
function writeIndex(index: AgentSessionsIndex): void {
  const indexPath = getAgentSessionsIndexPath()

  try {
    writeJsonFileAtomic(indexPath, index)
  } catch (error) {
    console.error('[Agent 会话] 写入索引文件失败:', error)
    throw new Error('写入 Agent 会话索引失败')
  }
}

/**
 * 获取所有会话（按 updatedAt 降序）
 */
export function listAgentSessions(): AgentSessionMeta[] {
  const index = readIndex()
  return index.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 获取单个会话的元数据
 */
export function getAgentSessionMeta(id: string): AgentSessionMeta | undefined {
  const index = readIndex()
  return index.sessions.find((s) => s.id === id)
}

/**
 * 创建新会话
 */
export function createAgentSession(
  title?: string,
  channelId?: string,
  workspaceId?: string,
  modelId?: string,
): AgentSessionMeta {
  const index = readIndex()
  const now = Date.now()

  const meta: AgentSessionMeta = {
    id: randomUUID(),
    title: title || '新 Agent 会话',
    channelId,
    modelId,
    workspaceId,
    createdAt: now,
    updatedAt: now,
  }

  index.sessions.push(meta)
  writeIndex(index)

  // 确保消息目录存在
  getAgentSessionsDir()

  // 若有工作区，创建 session 级别子文件夹并初始化 .context
  if (workspaceId) {
    const ws = getAgentWorkspace(workspaceId)
    if (ws) {
      const sessionDir = getAgentSessionWorkspacePath(ws.slug, meta.id)
      // 初始化 .context/ 目录
      const contextDir = join(sessionDir, '.context')
      if (!existsSync(contextDir)) mkdirSync(contextDir, { recursive: true })
    }
  }

  console.log(`[Agent 会话] 已创建会话: ${meta.title} (${meta.id})`)
  return meta
}

/**
 * 读取会话的所有消息
 */
export function getAgentSessionMessages(id: string): AgentMessage[] {
  const filePath = getAgentSessionMessagesPath(id)

  if (!existsSync(filePath)) {
    return []
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter((line) => line.trim())
    return parseJsonlLenient<AgentMessage>(lines, `读取会话消息 (${id})`)
  } catch (error) {
    console.error(`[Agent 会话] 读取消息失败 (${id}):`, error)
    return []
  }
}

/**
 * 追加一条消息到会话的 JSONL 文件
 */
export function appendAgentMessage(id: string, message: AgentMessage): void {
  const filePath = getAgentSessionMessagesPath(id)

  try {
    const line = JSON.stringify(message) + '\n'
    appendFileSync(filePath, line, 'utf-8')

    // 追加消息时更新 updatedAt，若已归档则自动恢复活跃
    const index = readIndex()
    const idx = index.sessions.findIndex((s) => s.id === id)
    if (idx !== -1) {
      const session = index.sessions[idx]!
      session.updatedAt = Date.now()
      if (session.archived) session.archived = false
      writeIndex(index)
    }
  } catch (error) {
    console.error(`[Agent 会话] 追加消息失败 (${id}):`, error)
    throw new Error('追加 Agent 消息失败')
  }
}

/** 单条 SDKMessage 序列化后最大长度（UTF-16 code units，超出则截断内容） */
const MAX_SDK_MESSAGE_LENGTH = 256 * 1024 // ~256K chars
/** 截断后保留的预览文本长度 */
const TRUNCATED_PREVIEW_LENGTH = 2000

/**
 * 追加 SDKMessage 到会话的 JSONL 文件（Phase 4 新持久化格式）
 *
 * 每条 SDKMessage 单独一行 JSON。读取时通过 `type` 字段区分新旧格式。
 * 超过 256K chars 的消息会被自动截断以防止存储膨胀。
 */
export function appendSDKMessages(id: string, messages: SDKMessage[]): void {
  if (messages.length === 0) return

  const filePath = getAgentSessionMessagesPath(id)

  try {
    for (const message of messages) {
      appendFileSync(filePath, serializeSDKMessageForStorage(message) + '\n', 'utf-8')
    }
  } catch (error) {
    console.error(`[Agent 会话] 追加 SDKMessage 失败 (${id}):`, error)
    throw new Error('追加 SDKMessage 失败')
  }
}

/**
 * 截断超大 SDKMessage 的内容，保留元数据结构。
 * 处理三类膨胀源：超长 text block、超大 tool_result、内嵌 base64 图片。
 */
function sanitizeOversizedMessage(msg: SDKMessage, originalLength: number): SDKMessage {
  const truncationNote = `\n[内容已截断: 原始 ${(originalLength / 1024).toFixed(0)}K chars 超出存储限制]`
  const truncationThreshold = MAX_SDK_MESSAGE_LENGTH / 2

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clone: any = JSON.parse(JSON.stringify(msg))
  const content = clone.message?.content
  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const block = content[i]
      if (!block || typeof block !== 'object') continue

      // 截断超长 text block
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > truncationThreshold) {
        block.text = block.text.slice(0, TRUNCATED_PREVIEW_LENGTH) + truncationNote
      }

      // 截断 Pi 风格内嵌图片（{ type: 'image', data, mimeType }）
      if (block.type === 'image' && typeof block.data === 'string') {
        const dataLen = block.data.length
        block.data = undefined
        block._truncated = true
        block._originalLength = dataLen
      }

      // 截断超大 tool_result
      if (block.type === 'tool_result') {
        if (typeof block.content === 'string' && block.content.length > truncationThreshold) {
          block.content = block.content.slice(0, TRUNCATED_PREVIEW_LENGTH) + truncationNote
        }
        // 剥离 base64 图片数据
        if (Array.isArray(block.content)) {
          block.content = block.content.map((item: Record<string, unknown>) => {
            if (item?.type === 'image' && (item.source as Record<string, unknown>)?.data) {
              const dataLen = String((item.source as Record<string, unknown>).data).length
              return { type: 'image', _truncated: true, _originalLength: dataLen }
            }
            if (item?.type === 'image' && typeof item.data === 'string') {
              return {
                type: 'image',
                mimeType: item.mimeType,
                _truncated: true,
                _originalLength: item.data.length,
              }
            }
            return item
          })
        }
      }
    }
  }

  // 截断 error.message
  if (clone.error && typeof clone.error === 'object' && typeof clone.error.message === 'string' && clone.error.message.length > truncationThreshold) {
    clone.error.message = clone.error.message.slice(0, TRUNCATED_PREVIEW_LENGTH) + truncationNote
  }

  return clone as SDKMessage
}

/**
 * 读取会话的所有 SDKMessage（兼容旧 AgentMessage 格式）
 *
 * 旧格式（有 `role` 字段）会被转换为近似的 SDKMessage。
 * 新格式（有 `type` 字段）直接返回。
 */
export function getAgentSessionSDKMessages(id: string): SDKMessage[] {
  const filePath = getAgentSessionMessagesPath(id)

  if (!existsSync(filePath)) {
    return []
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter((line) => line.trim())
    return parseJsonlLenient<unknown>(lines, `读取 SDKMessage (${id})`).map(normalizePersistedSDKMessage)
  } catch (error) {
    console.error(`[Agent 会话] 读取 SDKMessage 失败 (${id}):`, error)
    return []
  }
}

/**
 * convertLegacyMessage 已迁移至 @proma/session-core（本文件从该包 import 使用）。
 */

/**
 * 更新会话元数据
 */
export function updateAgentSessionMeta(
  id: string,
  updates: Partial<Pick<AgentSessionMeta, 'title' | 'channelId' | 'modelId' | 'sdkSessionId' | 'legacySdkSessionId' | 'workspaceId' | 'pinned' | 'archived' | 'attachedDirectories' | 'attachedFiles' | 'forkSourceDir' | 'forkSourceSessionId' | 'forkSourceSdkSessionId' | 'resumeAtMessageUuid' | 'stoppedByUser' | 'permissionMode' | 'completedButUnconfirmed' | 'sourceAutomationId' | 'automationGraduated' | 'parentSessionId' | 'rootSessionId' | 'sourceDelegationId' | 'delegationRole' | 'delegationStatus' | 'delegationDepth' | 'delegationGoal'>>,
): AgentSessionMeta {
  const index = readIndex()
  const idx = index.sessions.findIndex((s) => s.id === id)

  if (idx === -1) {
    throw new Error(`Agent 会话不存在: ${id}`)
  }

  const existing = index.sessions[idx]!
  // 非手动归档操作时，若会话已归档则自动恢复为活跃（仅更新 stoppedByUser 不触发解归档）
  const isStoppedByUserOnly = Object.keys(updates).every((k) => k === 'stoppedByUser')
  const autoUnarchive = existing.archived && !('archived' in updates) && !isStoppedByUserOnly
  const updated: AgentSessionMeta = {
    ...existing,
    ...updates,
    ...(autoUnarchive ? { archived: false } : {}),
    updatedAt: Date.now(),
  }

  index.sessions[idx] = updated
  writeIndex(index)

  console.log(`[Agent 会话] 已更新会话: ${updated.title} (${updated.id})`)
  return updated
}

/**
 * 删除会话
 */
export function deleteAgentSession(id: string): void {
  const index = readIndex()
  const idx = index.sessions.findIndex((s) => s.id === id)

  if (idx === -1) {
    console.warn(`[Agent 会话] 会话不存在，跳过删除: ${id}`)
    return
  }

  const removed = index.sessions.splice(idx, 1)[0]!
  writeIndex(index)

  // 删除消息文件
  const filePath = getAgentSessionMessagesPath(id)
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath)
    } catch (error) {
      console.warn(`[Agent 会话] 删除消息文件失败 (${id}):`, error)
    }
  }

  // 清理 session 工作目录
  if (removed.workspaceId) {
    const ws = getAgentWorkspace(removed.workspaceId)
    if (ws) {
      try {
        const sessionDir = getAgentSessionWorkspacePath(ws.slug, id)
        if (existsSync(sessionDir)) {
          rmSync(sessionDir, { recursive: true, force: true })
          console.log(`[Agent 会话] 已清理 session 工作目录: ${sessionDir}`)
        }
      } catch (error) {
        console.warn(`[Agent 会话] 清理 session 工作目录失败 (${id}):`, error)
      }
    }
  }

  console.log(`[Agent 会话] 已删除会话: ${removed.title} (${removed.id})`)

  // 清理 Nano Banana 生图历史
  clearNanoBananaAgentHistory(id)

  // 即时回收该会话的 sidecar 快照目录（各轮 snapshot + 去重 blob 池，可能达 GB 级）。
  // fork 引用保护：若仍有其它会话以本会话为 forkSourceSessionId（fork 子会话恢复时读源会话的
  // sidecar），则不物理删除，交由存储维护的孤儿清理按引用判定处理，避免破坏 fork 子会话恢复。
  const stillReferencedByFork = index.sessions.some((s) => s.forkSourceSessionId === id)
  if (!stillReferencedByFork) {
    try {
      if (deleteSessionSidecarSnapshots(id)) {
        console.log(`[Agent 会话] 已清理 sidecar 快照目录: ${id}`)
      }
    } catch (error) {
      console.warn(`[Agent 会话] 清理 sidecar 快照目录失败 (${id}):`, error)
    }
  } else {
    console.log(`[Agent 会话] 保留 sidecar 快照目录（仍被 fork 子会话引用）: ${id}`)
  }

}

/**
 * 迁移 Agent 会话到另一个工作区
 *
 * 操作步骤：
 * 1. 验证会话和目标工作区存在
 * 2. 源 == 目标 → no-op
 * 3. 移动会话工作目录到目标工作区
 * 4. 更新元数据（workspaceId + 清空 sdkSessionId）
 * 5. JSONL 消息文件保持原位（全局目录）
 */
export function moveSessionToWorkspace(sessionId: string, targetWorkspaceId: string): AgentSessionMeta {
  const index = readIndex()
  const idx = index.sessions.findIndex((s) => s.id === sessionId)
  if (idx === -1) {
    throw new Error(`Agent 会话不存在: ${sessionId}`)
  }

  const session = index.sessions[idx]!

  // 源 == 目标 → 直接返回
  if (session.workspaceId === targetWorkspaceId) return session

  const targetWs = getAgentWorkspace(targetWorkspaceId)
  if (!targetWs) {
    throw new Error(`目标工作区不存在: ${targetWorkspaceId}`)
  }

  let movedFromDir: string | undefined
  let movedToDir: string | undefined

  // 移动工作目录（如果源工作区存在）
  if (session.workspaceId) {
    const sourceWs = getAgentWorkspace(session.workspaceId)
    if (sourceWs) {
      const srcDir = join(getAgentWorkspacePath(sourceWs.slug), sessionId)
      if (existsSync(srcDir)) {
        const destDir = join(getAgentWorkspacePath(targetWs.slug), sessionId)
        // 清理已存在的空目标目录，防止 renameSync 抛出 ENOTEMPTY/EEXIST
        if (existsSync(destDir)) {
          try {
            const contents = readdirSync(destDir)
            if (contents.length === 0) {
              rmSync(destDir, { recursive: true })
              console.log(`[Agent 会话] 已清理空目标目录: ${destDir}`)
            } else {
              // 目标目录非空，合并：先移除目标，再移动源
              rmSync(destDir, { recursive: true })
              console.log(`[Agent 会话] 已清理非空目标目录（以源目录为准）: ${destDir}`)
            }
          } catch (cleanupError) {
            console.warn(`[Agent 会话] 清理目标目录失败，跳过目录迁移:`, cleanupError)
          }
        }
        renameSync(srcDir, destDir)
        movedFromDir = srcDir
        movedToDir = destDir
        console.log(`[Agent 会话] 已移动工作目录: ${srcDir} → ${destDir}`)
      }
    }
  }

  // 确保目标工作区下有 session 目录
  getAgentSessionWorkspacePath(targetWs.slug, sessionId)

  // 更新元数据
  const updated: AgentSessionMeta = {
    ...session,
    workspaceId: targetWorkspaceId,
    sdkSessionId: undefined, // SDK 上下文与工作区 cwd 绑定，必须清空
    updatedAt: Date.now(),
  }
  index.sessions[idx] = updated
  writeIndex(index)

  if (movedFromDir && movedToDir) {
    rewriteSessionJsonlPaths(sessionId, [{ sourceDir: movedFromDir, destDir: movedToDir }])
  }

  console.log(`[Agent 会话] 已迁移会话到工作区: ${updated.title} → ${targetWs.name}`)
  return updated
}

/**
 * 迁移 Chat 对话记录到 Agent 会话
 *
 * 读取 Chat 对话的消息，转换为 AgentMessage 格式，
 * 追加到目标 Agent 会话的 JSONL 文件中。
 *
 * 仅迁移 user 和 assistant 角色的消息文本内容，
 * 工具活动、推理、附件等 Chat 特有字段不迁移。
 */
export function migrateChatToAgentSession(conversationId: string, agentSessionId: string): void {
  const chatMessages = getConversationMessages(conversationId)

  if (chatMessages.length === 0) {
    console.log(`[Agent 会话] Chat 对话无消息，跳过迁移 (${conversationId})`)
    return
  }

  let count = 0
  for (const cm of chatMessages) {
    // 仅迁移 user 和 assistant 消息
    if (cm.role !== 'user' && cm.role !== 'assistant') continue
    if (!cm.content.trim()) continue

    const agentMsg: AgentMessage = {
      id: randomUUID(),
      role: cm.role,
      content: cm.content,
      createdAt: cm.createdAt,
      model: cm.role === 'assistant' ? cm.model : undefined,
    }

    appendAgentMessage(agentSessionId, agentMsg)
    count++
  }

  console.log(`[Agent 会话] 已迁移 ${count} 条消息到 Agent 会话 (${conversationId} → ${agentSessionId})`)
}

/**
 * 分叉 Agent 会话（Proma 自有 fork）
 *
 * Pi SDK 的分支树与 Proma UI 消息 UUID 不是同一套 ID。为了保留现有产品行为，
 * fork 继续以 Proma JSONL 截断和工作目录复制为准；新会话首次继续时由 Pi
 * 创建新的 runtime session，并通过 Proma 历史回填上下文。
 *
 * @returns 新创建的会话元数据
 */
export async function forkAgentSession(input: ForkSessionInput): Promise<AgentSessionMeta> {
  const { sessionId, upToMessageUuid } = input

  // 1. 获取源会话元数据
  const sourceMeta = getAgentSessionMeta(sessionId)
  if (!sourceMeta) {
    throw new Error(`源 Agent 会话不存在: ${sessionId}`)
  }

  const forkModelId = input.modelId !== undefined
    ? assertEnabledModelForChannel({
        channelId: sourceMeta.channelId,
        modelId: input.modelId,
        purpose: '分叉 Agent 会话',
      })
    : sourceMeta.modelId

  // 2. 确定源会话的工作目录
  let sourceDir: string | undefined
  if (sourceMeta.workspaceId) {
    const ws = getAgentWorkspace(sourceMeta.workspaceId)
    if (ws) {
      sourceDir = getAgentSessionWorkspacePath(ws.slug, sessionId)
    }
  }

  // 2.5 校验目标消息；若目标是子代理输出，自动回溯到最近的主线 assistant。
  let effectiveUpToMessageUuid = upToMessageUuid
  const displayUpToMessageUuid = upToMessageUuid
  if (upToMessageUuid) {
    const forkTarget = await resolveForkTargetFromStoredMessages(sessionId, upToMessageUuid)
    effectiveUpToMessageUuid = forkTarget.effectiveUpToMessageUuid

    if (forkTarget.usedSidechainFallback) {
      console.log(
        `[Agent 会话] fork 目标消息 ${upToMessageUuid} 属于 sub-agent，自动回溯到主线消息 ${effectiveUpToMessageUuid}`,
      )
    }
  }

  // 3. 创建 Proma 新会话；sdkSessionId 留空，下一轮由 Pi 创建新 runtime session。
  const forkTitle = `${sourceMeta.title} (fork)`
  const newMeta = createAgentSession(
    forkTitle,
    sourceMeta.channelId,
    sourceMeta.workspaceId,
    forkModelId,
  )

  updateAgentSessionMeta(newMeta.id, {
    forkSourceDir: sourceDir,
    forkSourceSessionId: sessionId,
  })
  // 同步返回值（updateAgentSessionMeta 已写入磁盘，这里让调用方拿到最新值）
  newMeta.forkSourceDir = sourceDir
  newMeta.forkSourceSessionId = sessionId

  // 4. 计算 fork 目标会话的 cwd（新会话目录），后续多个步骤需要用到
  let destDir: string | undefined
  if (sourceDir && sourceMeta.workspaceId) {
    const ws = getAgentWorkspace(sourceMeta.workspaceId)
    if (ws) {
      destDir = getAgentSessionWorkspacePath(ws.slug, newMeta.id)
    }
  }

  try {
    // 5. 物化源会话工作区文件到新会话目录
    // 保留 .context/，但跳过依赖、构建产物和 Git 元数据，避免 fork 点击时同步复制巨量目录拖垮主进程。
    // .context/ 必须保留 — Proma 约定 .context/note.md、todo.md、plan/ 等是会话上下文，
    // 如果不复制，fork 后这些参考资料会丢失或被 Agent 误回源目录读取。
    if (sourceDir && destDir) {
      let materializedFromSidecar = false
      if (effectiveUpToMessageUuid) {
        materializedFromSidecar = await materializeForkWorkspaceFromSidecar({
          sourceSessionId: sessionId,
          upToMessageUuid: effectiveUpToMessageUuid,
          sourceDir,
          destDir,
        })
      }
      if (!materializedFromSidecar) {
        const copyResult = copyForkWorkspaceFiles(sourceDir, destDir)
        console.log(
          `[Agent 会话] 已复制工作区文件: ${sourceDir} → ${destDir} `
          + `(${copyResult.copiedCount} 个条目, 跳过 ${copyResult.skippedCount} 个, 失败 ${copyResult.failedCount} 个)`,
        )
      }
    }

    // 6. 复制截断后的 SDKMessages 到新会话的 JSONL（用于 UI 展示历史）
    // 同时改写消息中所有源目录绝对路径为目标目录路径 — 否则 Agent 在历史里看到的所有
    // Read/Edit/Bash 工具调用都指向源会话目录，会继续在源目录而非新 cwd 下操作文件。
    const copiedMessages = await copyForkStoredSDKMessages({
      sourceSessionId: sessionId,
      destSessionId: newMeta.id,
      upToMessageUuid: displayUpToMessageUuid,
      sourceDir,
      destDir,
    })

    console.log(`[Agent 会话] 分叉会话已创建（Proma fork）: ${sourceMeta.title} → ${forkTitle} (${copiedMessages} 条消息)`)
    return newMeta
  } catch (error) {
    deleteAgentSession(newMeta.id)
    throw error
  }
}

interface ForkStoredMessageRef {
  uuid: string
  sessionId?: string
}

interface ForkTargetResolution {
  effectiveUpToMessageUuid: string
  effectiveSdkSessionId?: string
  usedSidechainFallback: boolean
}

async function materializeForkWorkspaceFromSidecar(input: {
  sourceSessionId: string
  upToMessageUuid?: string
  sourceDir?: string
  destDir?: string
}): Promise<boolean> {
  const { sourceSessionId, upToMessageUuid, sourceDir, destDir } = input
  if (!sourceDir || !destDir || !upToMessageUuid) return false

  const sourceRoot = resolve(sourceDir)
  const destRoot = resolve(destDir)
  const rootPathMap = new Map([[sourceRoot, destRoot]])
  let rewindUserUuid: string | undefined
  try {
    rewindUserUuid = resolveRewindUserMessageUuid(sourceSessionId, upToMessageUuid)
  } catch (error) {
    console.warn(`[Agent 会话] fork 解析 sidecar 快照点失败，回退为复制当前工作区:`, error)
    return false
  }
  const isLastTurn = rewindUserUuid === '__LAST_TURN__'
  const snapshotUuid = rewindUserUuid === '__LAST_TURN__'
    ? upToMessageUuid
    : rewindUserUuid
  if (!snapshotUuid) {
    console.warn('[Agent 会话] 无法解析 fork 目标对应的 Proma sidecar 快照，回退为复制当前工作区')
    return false
  }

  const result = await restoreAgentSidecarSnapshot(sourceSessionId, snapshotUuid, {
    rootPathMap,
    sessionCwdById: new Map([[sourceSessionId, destRoot]]),
    restoreUnmappedRoots: false,
  })
  if (!result.canRewind) {
    if (isLastTurn || isMissingSidecarError(result.error)) {
      console.warn(`[Agent 会话] fork 快照不可用，回退为复制当前工作区: ${result.error ?? '未知错误'}`)
      return false
    }
    throw new Error(result.error ?? '无法从 Proma sidecar 物化 fork 工作目录')
  }
  if ((result.restoredRoots ?? 0) === 0) {
    console.warn('[Agent 会话] fork 快照没有可物化的工作区 root，回退为复制当前工作区')
    return false
  }
  console.log(`[Agent 会话] 已从 sidecar 物化 fork 工作区: ${sourceRoot} → ${destRoot}, snapshot=${snapshotUuid}`)
  return true
}

function isMissingSidecarError(error?: string): boolean {
  if (!error) return false
  return error.includes('未找到 Proma sidecar 快照') || error.includes('Proma sidecar 快照没有可恢复')
}

async function resolveForkTargetFromStoredMessages(
  sessionId: string,
  upToMessageUuid: string,
): Promise<ForkTargetResolution> {
  const filePath = getAgentSessionMessagesPath(sessionId)
  if (!existsSync(filePath)) {
    throw new Error('未在会话历史中找到指定的消息，可能消息已被清理或截断')
  }

  let lastMainlineAssistant: ForkStoredMessageRef | undefined
  let target: (ForkStoredMessageRef & {
    isSidechain: boolean
    fallbackMainline?: ForkStoredMessageRef
  }) | undefined

  for await (const msg of readStoredSDKMessages(filePath, {
    mode: 'lenient',
    context: `fork 解析目标消息 (${sessionId})`,
  })) {
    const uuid = getStoredMessageUuid(msg)
    const isMainlineAssistant = msg.type === 'assistant'
      && !!uuid
      && !((msg as { parent_tool_use_id?: string | null }).parent_tool_use_id)

    if (uuid === upToMessageUuid) {
      target = {
        uuid,
        sessionId: (msg as { session_id?: string }).session_id,
        isSidechain: msg.type === 'assistant'
          && Boolean((msg as { parent_tool_use_id?: string | null }).parent_tool_use_id),
        fallbackMainline: lastMainlineAssistant,
      }
    }

    if (isMainlineAssistant) {
      lastMainlineAssistant = {
        uuid,
        sessionId: (msg as { session_id?: string }).session_id,
      }
    }
  }

  if (!target) {
    throw new Error('未在会话历史中找到指定的消息，可能消息已被清理或截断')
  }

  if (target.isSidechain) {
    if (!target.fallbackMainline) {
      throw new Error('选中的是子代理执行过程中的消息，且向前找不到可分叉的主对话消息')
    }
    return {
      effectiveUpToMessageUuid: target.fallbackMainline.uuid,
      effectiveSdkSessionId: target.fallbackMainline.sessionId,
      usedSidechainFallback: true,
    }
  }

  return {
    effectiveUpToMessageUuid: target.uuid,
    effectiveSdkSessionId: target.sessionId,
    usedSidechainFallback: false,
  }
}

interface CopyForkStoredSDKMessagesInput {
  sourceSessionId: string
  destSessionId: string
  upToMessageUuid?: string
  sourceDir?: string
  destDir?: string
}

async function copyForkStoredSDKMessages({
  sourceSessionId,
  destSessionId,
  upToMessageUuid,
  sourceDir,
  destDir,
}: CopyForkStoredSDKMessagesInput): Promise<number> {
  const sourcePath = getAgentSessionMessagesPath(sourceSessionId)
  if (!existsSync(sourcePath)) return 0

  const destPath = getAgentSessionMessagesPath(destSessionId)
  const out = createWriteStream(destPath, { flags: 'a', encoding: 'utf-8' })
  let copiedCount = 0

  try {
    const pathRewrites = await buildForkPathRewrites(sourceSessionId, sourceDir, destDir)
    for await (const msg of readStoredSDKMessages(sourcePath, {
      mode: 'lenient',
      context: `fork 复制 SDKMessage (${sourceSessionId})`,
    })) {
      await writeJsonlLine(out, serializeSDKMessageForStorage(msg, pathRewrites))
      copiedCount += 1

      if (upToMessageUuid && getStoredMessageUuid(msg) === upToMessageUuid) {
        break
      }
    }
    await endWriteStream(out)
  } catch (err) {
    out.destroy()
    rmSync(destPath, { force: true })
    throw err
  }

  return copiedCount
}

async function buildForkPathRewrites(
  sourceSessionId: string,
  sourceDir?: string,
  destDir?: string,
): Promise<PathRewrite[]> {
  if (!destDir) return []
  const destRoot = resolve(destDir)
  const candidates: string[] = []
  if (sourceDir) candidates.push(resolve(sourceDir))
  candidates.push(...await getAgentSidecarSessionOwnedRootPaths(sourceSessionId))

  return [...new Set(candidates)]
    .filter((sourceRoot) => sourceRoot && sourceRoot !== destRoot)
    .sort((left, right) => right.length - left.length)
    .map((sourceRoot) => ({
      sourceDir: sourceRoot,
      destDir: destRoot,
    }))
}

interface ReadStoredSDKMessagesOptions {
  mode: 'strict' | 'lenient'
  context: string
}

async function* readStoredSDKMessages(
  filePath: string,
  options: ReadStoredSDKMessagesOptions,
): AsyncGenerator<SDKMessage> {
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  })

  let lineNumber = 0
  for await (const line of rl) {
    lineNumber += 1
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as unknown
      yield normalizePersistedSDKMessage(parsed)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (options.mode === 'strict') {
        throw new Error(`${options.context} 失败：JSONL 第 ${lineNumber} 行解析失败: ${message}`)
      }
      console.warn(`[Agent 会话] ${options.context} — JSONL 第 ${lineNumber} 行解析失败，已跳过:`, message)
    }
  }
}

function getStoredMessageUuid(msg: SDKMessage): string | undefined {
  return 'uuid' in msg ? (msg as { uuid?: string }).uuid : undefined
}

interface PathRewrite {
  sourceDir: string
  destDir: string
}

function serializeSDKMessageForStorage(
  msg: SDKMessage,
  pathRewrites: PathRewrite[] = [],
): string {
  let serialized = JSON.stringify(msg)
  if (pathRewrites.length > 0) {
    serialized = rewriteSourceToDest(serialized, pathRewrites)
  }
  if (serialized.length <= MAX_SDK_MESSAGE_LENGTH) return serialized

  let sanitized = JSON.stringify(sanitizeOversizedMessage(msg, serialized.length))
  if (pathRewrites.length > 0) {
    sanitized = rewriteSourceToDest(sanitized, pathRewrites)
  }
  if (sanitized.length > MAX_SDK_MESSAGE_LENGTH) {
    console.warn(`[Agent 会话] 消息截断后仍超限 (${(sanitized.length / 1024).toFixed(0)}K chars)`)
  }
  return sanitized
}

async function writeJsonlLine(stream: WriteStream, line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(line + '\n', (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

async function endWriteStream(stream: WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once('error', reject)
    stream.end(resolve)
  })
}

/**
 * 将一段字符串中所有出现的源 cwd 替换为目标 cwd。
 *
 * 用于 fork 会话时把历史中嵌入的源会话绝对路径迁移到新会话目录。
 * 处理 JSON 字符串中可能出现的两种编码形式：
 * 1. 原始路径（如 /Users/a/b）
 * 2. JSON 字符串编码后的形式（路径中的 `/` JSON 标准下不会转义，所以通常与 1 一致；
 *    但保留对反斜杠的处理以兼容 Windows 路径）
 *
 * sourceDir 和 destDir 都会规范化去除末尾斜杠，避免不同形式导致漏替换。
 */
function rewriteSourceToDest(content: string, pathRewrites: PathRewrite[]): string {
  let rewritten = content
  for (const rewrite of pathRewrites) {
    const normalizedSource = rewrite.sourceDir.replace(/[\\/]+$/, '')
    const normalizedDest = rewrite.destDir.replace(/[\\/]+$/, '')
    if (!normalizedSource || normalizedSource === normalizedDest) continue
    rewritten = rewritten.split(normalizedSource).join(normalizedDest)
    // Windows 路径在 JSON 中会被转义为双反斜杠，单独处理一次
    if (normalizedSource.includes('\\')) {
      const sourceEscaped = normalizedSource.replace(/\\/g, '\\\\')
      const destEscaped = normalizedDest.replace(/\\/g, '\\\\')
      rewritten = rewritten.split(sourceEscaped).join(destEscaped)
    }
  }
  return rewritten
}

function rewriteSessionJsonlPaths(sessionId: string, pathRewrites: PathRewrite[]): void {
  if (pathRewrites.length === 0) return
  const filePath = getAgentSessionMessagesPath(sessionId)
  if (!existsSync(filePath)) return

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const rewritten = rewriteSourceToDest(raw, pathRewrites)
    if (rewritten !== raw) {
      writeFileSync(filePath, rewritten, 'utf-8')
      console.log(`[Agent 会话] 已重写会话历史 cwd 路径: sessionId=${sessionId}`)
    }
  } catch (error) {
    console.warn(`[Agent 会话] 重写会话历史 cwd 路径失败 (${sessionId}):`, error)
  }
}

/**
 * 截断 Agent 会话的 SDK 消息到指定 UUID（inclusive）
 *
 * 保留 uuid 匹配消息及之前的所有消息，删除之后的消息。
 * 通过 writeFileSync 全量重写 JSONL 文件。
 *
 * @returns 截断后保留的消息列表
 */
export function truncateSDKMessages(id: string, upToUuidInclusive: string): SDKMessage[] {
  const filePath = getAgentSessionMessagesPath(id)
  if (!existsSync(filePath)) {
    throw new Error(`[Agent 会话] 截断失败: 会话消息文件不存在, sessionId=${id}`)
  }

  const raw = readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n').filter((line) => line.trim())
  const messages = parseJsonlStrict<unknown>(lines, `截断读取 SDKMessage (${id})`).map(normalizePersistedSDKMessage)
  const cutIndex = messages.findIndex(
    (m) => 'uuid' in m && (m as { uuid?: string }).uuid === upToUuidInclusive,
  )
  if (cutIndex < 0) {
    throw new Error(`[Agent 会话] 截断失败: 未找到 uuid=${upToUuidInclusive}, sessionId=${id}`)
  }
  const kept = messages.slice(0, cutIndex + 1)

  const content = kept.map((m) => JSON.stringify(m)).join('\n') + (kept.length > 0 ? '\n' : '')
  writeFileSync(filePath, content, 'utf-8')

  console.log(`[Agent 会话] 消息已截断: sessionId=${id}, 保留 ${kept.length}/${messages.length} 条`)
  return kept
}

function isRealStoredUserMessage(message: SDKMessage): boolean {
  if (message.type !== 'user' || !getStoredMessageUuid(message)) return false
  const content = (message as { message?: { content?: Array<{ type: string }> } }).message?.content
  const hasToolResult = Array.isArray(content) && content.some((block) => block.type === 'tool_result')
  return !hasToolResult
}

/**
 * 从 Proma JSONL 中查找回退文件所需的 sidecar 快照 UUID。
 *
 * 回退到某个 assistant turn = 恢复到该 turn 完成后的文件状态。Proma sidecar
 * 在每条真实 user message 发出前创建快照，所以该状态等价于目标 assistant
 * 之后的下一条真实 user message 快照；如果没有下一条 user message，当前文件系统
 * 已经是最后一个 turn 完成后的状态，无需恢复。
 */
export function resolveRewindUserMessageUuid(
  sessionId: string,
  assistantMessageUuid: string,
): string | undefined {
  const filePath = getAgentSessionMessagesPath(sessionId)
  if (!existsSync(filePath)) return undefined

  const raw = readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n').filter((line) => line.trim())
  const messages = parseJsonlStrict<unknown>(lines, `rewind 解析 Proma JSONL (${sessionId})`).map(normalizePersistedSDKMessage)
  const assistantIdx = messages.findIndex((message) => getStoredMessageUuid(message) === assistantMessageUuid)
  if (assistantIdx < 0) {
    console.warn(`[Agent 会话] Proma JSONL 中未找到 assistant uuid=${assistantMessageUuid}`)
    return undefined
  }

  for (let i = assistantIdx + 1; i < messages.length; i++) {
    const message = messages[i]!
    if (isRealStoredUserMessage(message)) {
      const uuid = getStoredMessageUuid(message)
      console.log(`[Agent 会话] 回退解析到下一轮 user uuid=${uuid} (assistant uuid=${assistantMessageUuid})`)
      return uuid
    }
  }

  console.log(`[Agent 会话] 回退目标是最后一个 turn，无需恢复文件 (assistant uuid=${assistantMessageUuid})`)
  return '__LAST_TURN__'
}

/**
 * 自动归档超过指定天数未更新的 Agent 会话
 *
 * 置顶会话不会被归档。
 *
 * @param daysThreshold 天数阈值
 * @returns 本次归档的会话数量
 */
export function autoArchiveAgentSessions(daysThreshold: number): number {
  const index = readIndex()
  const threshold = Date.now() - daysThreshold * 86_400_000
  let count = 0

  for (const session of index.sessions) {
    if (!session.pinned && !session.archived && session.updatedAt < threshold) {
      session.archived = true
      count++
    }
  }

  if (count > 0) {
    writeIndex(index)
    console.log(`[Agent 会话] 自动归档 ${count} 个会话（阈值: ${daysThreshold} 天）`)
  }

  return count
}

/**
 * 启动时收敛遗留的委派子会话状态
 *
 * 委派子会话的运行态只在主进程内存中维护，应用退出后无法续跑。
 * 若上次退出时仍有 delegationStatus 为 'running' 的子会话，本次启动需要
 * 把它们标记为 'interrupted'，避免状态永久卡在 running、父会话也无法收敛。
 *
 * @returns 被标记为中断的子会话数量
 */
export function markRunningDelegationsAsInterrupted(): number {
  const index = readIndex()
  let count = 0

  for (const session of index.sessions) {
    if (session.sourceDelegationId && session.delegationStatus === 'running') {
      session.delegationStatus = 'interrupted'
      session.updatedAt = Date.now()
      count++
    }
  }

  if (count > 0) {
    writeIndex(index)
    console.log(`[Agent 会话] 启动收敛 ${count} 个遗留的运行中委派子会话为 interrupted`)
  }

  return count
}

/**
 * 清理所有会话中不存在的附加目录和附加文件
 * @returns 清理的条目总数
 */
export function cleanupStaleAttachedPaths(): number {
  const index = readIndex()
  let count = 0

  for (const session of index.sessions) {
    let changed = false

    if (session.attachedDirectories?.length) {
      const valid = session.attachedDirectories.filter((d) => existsSync(d))
      if (valid.length < session.attachedDirectories.length) {
        count += session.attachedDirectories.length - valid.length
        session.attachedDirectories = valid.length > 0 ? valid : undefined
        changed = true
      }
    }

    if (session.attachedFiles?.length) {
      const valid = session.attachedFiles.filter((f) => existsSync(f))
      if (valid.length < session.attachedFiles.length) {
        count += session.attachedFiles.length - valid.length
        session.attachedFiles = valid.length > 0 ? valid : undefined
        changed = true
      }
    }

    if (changed) {
      session.updatedAt = Date.now()
    }
  }

  if (count > 0) {
    writeIndex(index)
    console.log(`[Agent 会话] 清理了 ${count} 个不存在的附加路径`)
  }

  return count
}

/**
 *
 * 按行流式读取每个会话的 JSONL 文件，命中即早退。兼容旧 AgentMessage 和新 SDKMessage 格式。
 * 每个会话最多返回 1 条匹配，总计达到 maxResults 即停止扫描后续会话。
 *
 * @param query 搜索关键词
 * @returns 匹配结果列表
 */
export async function searchAgentSessionMessages(query: string): Promise<AgentMessageSearchResult[]> {
  if (!query || query.length < 2) return []

  const index = readIndex()
  const results: AgentMessageSearchResult[] = []
  const queryLower = query.toLowerCase()
  const maxResults = 30

  for (const session of index.sessions) {
    if (results.length >= maxResults) break

    const filePath = getAgentSessionMessagesPath(session.id)
    if (!existsSync(filePath)) continue

    const hit = await findFirstMatchInAgentJsonl(filePath, queryLower, query.length)
    if (hit) {
      results.push({
        sessionId: session.id,
        sessionTitle: session.title,
        messageId: hit.messageId,
        role: hit.role,
        snippet: hit.snippet,
        matchStart: hit.matchStart,
        matchLength: query.length,
        archived: session.archived,
      })
    }
  }

  return results
}

/**
 * 在单个 Agent 会话 JSONL 中按行流式查找第一条匹配。
 *
 * Agent 消息存在两种历史格式（旧 AgentMessage 与新 SDKMessage），都要兼容。
 */
async function findFirstMatchInAgentJsonl(
  filePath: string,
  queryLower: string,
  queryLength: number
): Promise<{ messageId: string; role: AgentMessageSearchResult['role']; snippet: string; matchStart: number } | null> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      let parsed: {
        role?: string
        id?: string
        uuid?: string
        content?: unknown
        message?: { role?: string; id?: string; content?: Array<{ type: string; text?: string }> }
      }
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }

      const rawRole = parsed.role ?? parsed.message?.role ?? 'assistant'
      // 收窄到 AgentMessageSearchResult.role 允许的联合类型；不在白名单的退化为 assistant
      const role: AgentMessageSearchResult['role'] =
        rawRole === 'user' || rawRole === 'assistant' || rawRole === 'tool' || rawRole === 'status'
          ? rawRole
          : 'assistant'
      const messageId = parsed.id ?? parsed.uuid ?? parsed.message?.id ?? ''

      let textContent = ''
      if (typeof parsed.content === 'string') {
        textContent = parsed.content
      } else if (Array.isArray(parsed.message?.content)) {
        textContent = parsed.message.content
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text!)
          .join('\n')
      }
      if (!textContent) continue

      const contentLower = textContent.toLowerCase()
      const matchIndex = contentLower.indexOf(queryLower)
      if (matchIndex === -1) continue

      const snippetStart = Math.max(0, matchIndex - 40)
      const snippetEnd = Math.min(textContent.length, matchIndex + queryLength + 40)
      const snippet = (snippetStart > 0 ? '...' : '') +
        textContent.slice(snippetStart, snippetEnd) +
        (snippetEnd < textContent.length ? '...' : '')
      const matchStart = matchIndex - snippetStart + (snippetStart > 0 ? 3 : 0)

      return { messageId, role, snippet, matchStart }
    }
    return null
  } finally {
    rl.close()
    stream.destroy()
  }
}

function extractTextFromPersistedMessage(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return ''
  const record = parsed as {
    content?: unknown
    message?: { content?: Array<{ type: string; text?: string }> }
  }

  if (typeof record.content === 'string') {
    return record.content
  }

  if (Array.isArray(record.message?.content)) {
    return record.message.content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
      .join('\n')
  }

  return ''
}

function createSnippet(text: string, matchIndex: number, matchLength: number): string {
  const snippetStart = Math.max(0, matchIndex - 48)
  const snippetEnd = Math.min(text.length, matchIndex + matchLength + 48)
  return (snippetStart > 0 ? '...' : '') +
    text.slice(snippetStart, snippetEnd) +
    (snippetEnd < text.length ? '...' : '')
}

function findSessionMessageSnippet(sessionId: string, query: string): string | undefined {
  if (!query || query.length < 2) return undefined

  const filePath = getAgentSessionMessagesPath(sessionId)
  if (!existsSync(filePath)) return undefined

  const queryLower = query.toLowerCase()
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter((line) => line.trim())

    for (const line of lines) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (error) {
        console.warn(`[Agent 会话] 会话引用摘要跳过无法解析的 JSONL 行 (${sessionId}):`, error)
        continue
      }
      const textContent = extractTextFromPersistedMessage(parsed)
      if (!textContent) continue

      const matchIndex = textContent.toLowerCase().indexOf(queryLower)
      if (matchIndex === -1) continue

      return createSnippet(textContent, matchIndex, query.length)
    }
  } catch {
    return undefined
  }

  return undefined
}

/**
 * 搜索当前工作区可引用的 Agent 会话。
 *
 * 仅返回当前工作区、未归档、非当前会话的结果；无关键词时返回最近更新的会话。
 */
export function searchAgentSessionReferences(input: AgentSessionReferenceSearchInput): AgentSessionReferenceSearchResult[] {
  const workspaceId = input?.workspaceId?.trim()
  if (!workspaceId) return []

  const query = (input?.query ?? '').trim()
  const queryLower = query.toLowerCase()
  const requestedLimit = Number.isFinite(input?.limit) ? input.limit! : 20
  const limit = Math.min(Math.max(requestedLimit, 1), 50)

  const candidates = listAgentSessions()
    .filter((session) => session.workspaceId === workspaceId)
    .filter((session) => !session.archived)
    .filter((session) => session.id !== input?.excludeSessionId)

  const results: AgentSessionReferenceSearchResult[] = []

  for (const session of candidates) {
    if (results.length >= limit) break

    if (!queryLower) {
      results.push({
        sessionId: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        matchSource: 'recent',
      })
      continue
    }

    if (session.title.toLowerCase().includes(queryLower)) {
      results.push({
        sessionId: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        matchSource: 'title',
      })
      continue
    }

    const snippet = findSessionMessageSnippet(session.id, query)
    if (snippet) {
      results.push({
        sessionId: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        snippet,
        matchSource: 'message',
      })
    }
  }

  return results
}

import type { SDKMessage } from '@proma/shared'
import { getToolDisplayName, getInputSummary, computeDiffStats } from './tool-utils'
import { groupIntoTurns, type AssistantTurn } from './SDKMessageRenderer'

export type ExportMode = 'final-only' | 'with-flow'

export function generateExportFilename(prefix = 'proma-export'): string {
  const d = new Date()
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${prefix}-${date}`
}

/** 工具名 → emoji 前缀（与当前会话风格一致） */
const TOOL_EMOJI: Record<string, string> = {
  Write: '📝',
  Edit: '✏️',
  Read: '📖',
  NotebookEdit: '✏️',
  Bash: '💻',
  Grep: '🔍',
  Glob: '🔎',
  WebFetch: '🌐',
  WebSearch: '🌐',
  Task: '🤖',
  Agent: '🤖',
  TaskCreate: '✅',
  TaskUpdate: '✅',
  TaskList: '📋',
  TaskGet: '📋',
  TodoWrite: '📋',
  TodoRead: '📋',
  AskUserQuestion: '💬',
  Skill: '⚡',
  generate_image: '🖼️',
  EnterPlanMode: '🗺️',
  ExitPlanMode: '🗺️',
}

function getToolEmoji(name: string): string {
  if (TOOL_EMOJI[name]) return TOOL_EMOJI[name]
  if (name.startsWith('mcp__')) return '🔌'
  return '🔧'
}

/** 计算工具调用的 diff 统计（additions 绿、deletions 红） */
function getToolDiffStats(
  name: string,
  input: Record<string, unknown>,
): { additions: number; deletions: number } | null {
  if (name === 'Edit') return computeDiffStats('Edit', input)
  if (name === 'Write') {
    const content = input.content
    if (typeof content === 'string' && content.length > 0) {
      return { additions: content.split('\n').length, deletions: 0 }
    }
    return null
  }
  if (name === 'Read') {
    const limit = input.limit
    if (typeof limit === 'number' && limit > 0) {
      return { additions: limit, deletions: 0 }
    }
    return null
  }
  return null
}

/** 格式化工具调用为一行 Markdown 引用（含 emoji、中文标题、参数摘要、+/- 统计） */
function formatToolUseLine(name: string, input: unknown): string {
  const emoji = getToolEmoji(name)
  const label = getToolDisplayName(name)
  const inputObj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const summary = getInputSummary(name, inputObj)
  const diff = getToolDiffStats(name, inputObj)

  let line = `> ${emoji} **${label}**`
  if (summary) line += ` — ${summary}`
  if (diff) {
    const parts: string[] = []
    if (diff.additions > 0) parts.push(`+${diff.additions}`)
    if (diff.deletions > 0) parts.push(`-${diff.deletions}`)
    if (parts.length > 0) line += ` \`${parts.join(' ')}\``
  }
  return line
}


/** 从 SDKMessage 列表中提取 Markdown 文本（按 turn 分组：每个 assistant turn 合并为一段） */
export function sdkMessagesToMarkdown(
  messages: SDKMessage[],
  mode: ExportMode,
  opts?: { assistantName?: string; userName?: string },
): string {
  const parts: string[] = []
  const userLabel = opts?.userName ?? 'User'
  const assistantLabel = opts?.assistantName ?? 'Assistant'

  const fmtTime = (ts: number | undefined): string => {
    if (!ts) return ''
    const d = new Date(ts)
    const pad = (n: number) => String(n).padStart(2, '0')
    return ` · ${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const groups = groupIntoTurns(messages)

  for (const g of groups) {
    if (g.type === 'user') {
      const userMsg = g.message
      const content = userMsg.message?.content
      if (!Array.isArray(content)) continue
      const textBlocks = content.filter((b) => b.type === 'text')
      const text = textBlocks.map((b) => ('text' in b ? (b as { text: string }).text : '')).join('\n')
      if (!text.trim()) continue
      const userTs = (userMsg as { _createdAt?: number })._createdAt
      parts.push(`**${userLabel}${fmtTime(userTs)}:**\n\n${text}`)
    } else if (g.type === 'assistant-turn') {
      const turn = g as AssistantTurn
      // 合并整个 turn 的所有 content blocks（thinking → tool_use → text）为一段
      const segments: string[] = []
      let hasAssistantText = false
      for (const aMsg of turn.assistantMessages) {
        const blocks = aMsg.message?.content ?? []
        if (!Array.isArray(blocks) || blocks.length === 0) continue
        for (const block of blocks) {
          const b = block as { type: string; text?: string; thinking?: string; name?: string; input?: unknown }
          if (b.type === 'thinking') {
            if (mode === 'with-flow' && b.thinking) {
              segments.push(`> 💭 **思考**\n>\n> ${b.thinking.replace(/\n/g, '\n> ')}`)
            }
          } else if (b.type === 'tool_use') {
            if (mode === 'with-flow' && typeof b.name === 'string') {
              segments.push(formatToolUseLine(b.name, b.input))
            }
          } else if (b.type === 'text' && typeof b.text === 'string') {
            if (!hasAssistantText) {
              segments.push(`**${assistantLabel}${fmtTime(turn.createdAt)}:**\n\n${b.text}`)
              hasAssistantText = true
            } else {
              segments.push(b.text)
            }
          }
        }
      }
      if (segments.length > 0) {
        parts.push(segments.join('\n\n'))
      }
    }
    // system group 忽略
  }

  return parts.join('\n\n---\n\n')
}

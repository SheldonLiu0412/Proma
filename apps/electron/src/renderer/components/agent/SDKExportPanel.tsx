import { useState, useRef, useEffect } from 'react'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { useAtomValue } from 'jotai'
import type { SDKMessage, SDKUserMessage, SDKAssistantMessage } from '@proma/shared'
import {
  groupIntoTurns,
  type MessageGroup,
  type AssistantTurn,
} from './SDKMessageRenderer'
import {
  sdkMessagesToMarkdown,
  generateExportFilename,
  type ExportMode,
} from './export-utils'
import { UserAvatar } from '@/components/chat/UserAvatar'
import { userProfileAtom } from '@/atoms/user-profile'
import { channelsAtom } from '@/atoms/chat-atoms'
import { getModelLogo, resolveModelDisplayName } from '@/lib/model-logo'

interface SDKExportPanelProps {
  messages: SDKMessage[]
  /** 当前会话标题，用于拼接到导出文件名 */
  sessionTitle?: string
  /** 当前会话使用的模型 ID（用于显示模型名称和 Logo） */
  sessionModelId?: string
  /** 触发导出的 turn 的消息（用于默认选中当前回复+对应用户消息） */
  triggerTurnMessages?: SDKMessage[]
  onClose: () => void
}

interface SelectItem {
  /** 唯一 key */
  id: string
  /** 'user' | 'assistant' */
  role: 'user' | 'assistant'
  /** 展示文字 */
  text: string
  /** 该项对应的 SDKMessage 集合（导出用） */
  messages: SDKMessage[]
}

function buildSelectItems(groups: MessageGroup[]): SelectItem[] {
  const items: SelectItem[] = []
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!
    if (g.type === 'user') {
      // 用户消息 → 独立一项
      const userMsg = g.message as SDKUserMessage
      const textBlocks = userMsg.message?.content?.filter((b) => b.type === 'text') ?? []
      const text = textBlocks
        .map((b) => ('text' in b ? (b as { text: string }).text : ''))
        .join('\n')
        .trim() || '[消息]'
      items.push({
        id: `user-${i}`,
        role: 'user',
        text,
        messages: [g.message],
      })
    } else if (g.type === 'assistant-turn') {
      // Assistant turn → 独立一项（包含整个 turn 的所有消息，含工具调用）
      const turn = g as AssistantTurn
      let previewText = ''
      for (const aMsg of turn.assistantMessages) {
        const blocks = (aMsg as SDKAssistantMessage).message?.content ?? []
        const t = blocks
          .filter((b) => b.type === 'text' && 'text' in b)
          .map((b) => (b as { text: string }).text)
          .join('\n')
          .trim()
        if (t) { previewText = t; break }
      }
      if (!previewText) previewText = '[处理中...]'
      items.push({
        id: `assistant-${i}`,
        role: 'assistant',
        text: previewText,
        messages: turn.turnMessages,
      })
    }
  }
  // 只保留最近 30 项
  return items.slice(-30)
}

export function SDKExportPanel({ messages, sessionTitle, sessionModelId, triggerTurnMessages, onClose }: SDKExportPanelProps) {
  const userProfile = useAtomValue(userProfileAtom)
  const channels = useAtomValue(channelsAtom)
  const groups = groupIntoTurns(messages)
  const items = buildSelectItems(groups)

  // 从第一个 assistant turn 推断模型（multi-model turn 暂用首个），兜底用 sessionModelId
  const inferredModelId = (() => {
    for (const g of groups) {
      if (g.type === 'assistant-turn' && g.model) return g.model
    }
    return sessionModelId
  })()
  const assistantName = inferredModelId ? resolveModelDisplayName(inferredModelId, channels) : 'Assistant'
  const userName = userProfile.userName || '用户'

  // 默认选中：触发导出的 assistant turn + 紧前的 user 消息；无触发信息时全选
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    if (!triggerTurnMessages || triggerTurnMessages.length === 0) {
      return new Set(items.map((it) => it.id))
    }
    const triggerSet = new Set(triggerTurnMessages)
    const defaultIds = new Set<string>()
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!
      if (it.role === 'assistant' && it.messages.some((m) => triggerSet.has(m))) {
        defaultIds.add(it.id)
        // 找紧前的 user item
        for (let j = i - 1; j >= 0; j--) {
          if (items[j]!.role === 'user') { defaultIds.add(items[j]!.id); break }
        }
        break
      }
    }
    return defaultIds.size > 0 ? defaultIds : new Set(items.map((it) => it.id))
  })

  const toggleId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => setSelectedIds(new Set(items.map((it) => it.id)))
  const clearAll = () => setSelectedIds(new Set())

  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      // 找到弹窗内可滚动的容器并手动滚动
      const scrollable = el.querySelector('.overflow-y-auto') as HTMLElement | null
      if (scrollable) scrollable.scrollTop += e.deltaY
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    const handleMouseDown = (e: MouseEvent) => {
      if (!el.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => {
      el.removeEventListener('wheel', handleWheel)
      document.removeEventListener('mousedown', handleMouseDown)
    }
  }, [onClose])

  // 获取选中项对应的 SDKMessage（去重，保持原始顺序）
  const getSelectedMessages = (): SDKMessage[] => {
    const seen = new Set<SDKMessage>()
    const result: SDKMessage[] = []
    for (const it of items) {
      if (!selectedIds.has(it.id)) continue
      for (const m of it.messages) {
        if (!seen.has(m)) { seen.add(m); result.push(m) }
      }
    }
    return result
  }

  const handleExport = async (mode: ExportMode) => {
    try {
      const selected = getSelectedMessages()
      const cleanTitle = (sessionTitle ?? '').replace(/[\\/:*?"<>|\n\r\t]/g, '').replace(/\s+/g, '-').trim().slice(0, 50)
      const prefix = cleanTitle ? `proma-${cleanTitle}` : 'proma-chat'
      const markdown = sdkMessagesToMarkdown(selected, mode, { assistantName, userName })
      await window.electronAPI.exportMessagesMd(markdown, generateExportFilename(prefix) + '.md')
    } catch (err) {
      alert(`导出失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      onClose()
    }
  }

  return (
    <>
      <div
        ref={panelRef}
        className="absolute z-50 w-[280px] rounded-lg border bg-popover shadow-xl flex flex-col overflow-hidden animate-in fade-in-0 zoom-in-95 duration-150 origin-top-left"
        style={{ maxHeight: 'min(520px, 75vh)', left: '100%', bottom: 0, marginLeft: 8 }}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
          <span className="text-xs font-medium text-popover-foreground/70">导出对话</span>
          <span className="text-[11px] text-muted-foreground tabular-nums">{selectedIds.size}/{items.length}</span>
        </div>

        {/* 对话项列表（User / Assistant 独立选中，带头像） */}
        <div className="overflow-y-auto p-1.5 space-y-0.5 scrollbar-thin" style={{ maxHeight: '264px' }}>
          {items.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-4">暂无可导出内容</p>
          )}
          {items.map((it) => {
            const isSelected = selectedIds.has(it.id)
            return (
              <button
                key={it.id}
                onClick={() => toggleId(it.id)}
                className={`flex items-start gap-2 w-full rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent ${
                  isSelected ? 'bg-accent/50' : ''
                }`}
              >
                {/* 复选框 */}
                <div
                  className={`size-3.5 rounded border flex items-center justify-center flex-shrink-0 mt-1 ${
                    isSelected ? 'bg-primary border-primary' : 'border-border'
                  }`}
                >
                  {isSelected && <Check className="size-2.5 text-primary-foreground" />}
                </div>
                {/* 头像 */}
                <div className="flex-shrink-0 mt-0.5">
                  {it.role === 'user' ? (
                    <UserAvatar avatar={userProfile.avatar} size={22} />
                  ) : (
                    <div className="size-[22px] rounded-[20%] overflow-hidden border-[0.5px] border-foreground/10 bg-foreground/[0.04] flex items-center justify-center">
                      <img src={inferredModelId ? getModelLogo(inferredModelId) : undefined} alt="Proma" className="size-full object-cover" />
                    </div>
                  )}
                </div>
                {/* 消息内容，最多 2 行 */}
                <div className="flex-1 min-w-0">
                  <div
                    className="leading-[1.35] text-foreground/85 whitespace-pre-wrap"
                    style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                  >
                    {it.text}
                  </div>
                </div>
              </button>
            )
          })}
        </div>

        {/* 全选/取消全选 */}
        <div className="px-3 py-1.5 flex items-center gap-2">
          <button onClick={selectAll} className="text-xs text-muted-foreground hover:text-foreground transition-colors">全选</button>
          <span className="text-muted-foreground text-xs">·</span>
          <button onClick={clearAll} className="text-xs text-muted-foreground hover:text-foreground transition-colors">取消全选</button>
        </div>

        {/* 导出 */}
        <ExportMenu disabled={selectedIds.size === 0} onExport={handleExport} />
      </div>
    </>
  )
}

function ExportMenu({
  disabled,
  onExport,
}: {
  disabled: boolean
  onExport: (mode: ExportMode) => void
}) {
  const [open, setOpen] = useState(false)

  const items: { icon: string; label: string; mode: ExportMode }[] = [
    { icon: '📝', label: 'Markdown · 不包含工具调用', mode: 'final-only' },
    { icon: '📝', label: 'Markdown · 完整', mode: 'with-flow' },
  ]

  return (
    <div className="relative border-t">
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 right-0 z-20 border-x border-t border-b bg-popover overflow-hidden">
            {items.map((item) => (
              <button
                key={item.mode}
                onClick={() => { onExport(item.mode); setOpen(false) }}
                className="flex items-center gap-2 w-full text-left px-3 py-2 text-xs hover:bg-accent transition-colors"
              >
                <span className="text-sm leading-none">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <button
        onClick={() => (open || !disabled) && setOpen((v) => !v)}
        disabled={!open && disabled}
        className={`flex items-center justify-center gap-1.5 w-full px-3 py-2 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed ${open ? 'bg-accent/50' : ''}`}
      >
        导出
        {open ? <ChevronDown className="size-3 opacity-60" /> : <ChevronUp className="size-3 opacity-60" />}
      </button>
    </div>
  )
}

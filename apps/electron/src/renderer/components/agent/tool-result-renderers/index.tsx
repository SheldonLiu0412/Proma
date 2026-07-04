/**
 * ToolResultRenderer — 工具结果分发渲染器
 *
 * 根据工具名称分发到对应的专属渲染器，
 * 未匹配时使用 DefaultResultRenderer。
 */

import * as React from 'react'
import { Download } from 'lucide-react'
import type { AgentToolResultImage } from '@proma/shared'
import { cn } from '@/lib/utils'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { BashResultRenderer } from './bash-result'
import { ReadResultRenderer } from './read-result'
import { EditResultRenderer } from './edit-result'
import { WriteResultRenderer } from './write-result'
import { GrepResultRenderer } from './grep-result'
import { GlobResultRenderer } from './glob-result'
import { WebSearchResultRenderer } from './web-search-result'
import { WebFetchResultRenderer } from './web-fetch-result'
import { TaskGetResultRenderer } from './task-get-result'
import { TaskListResultRenderer } from './task-list-result'
import { DefaultResultRenderer } from './default-result'

const PROMA_IMAGE_ATTACHMENT_RE = /\[PROMA_IMAGE_ATTACHMENT:([^\]]+)\]/g

interface ParsedAttachmentText {
  text: string
  attachments: AgentToolResultImage[]
}

interface DataToolResultImage {
  kind: 'data'
  id: string
  src: string
  filename: string
  mediaType: string
}

interface AttachmentToolResultImage {
  kind: 'attachment'
  id: string
  localPath: string
  filename: string
  mediaType: string
}

type RenderableToolResultImage = DataToolResultImage | AttachmentToolResultImage

interface ToolResultRenderData {
  text: string
  images: RenderableToolResultImage[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isAgentToolResultImage(value: unknown): value is AgentToolResultImage {
  if (!isRecord(value)) return false
  return typeof value.localPath === 'string'
    && typeof value.filename === 'string'
    && typeof value.mediaType === 'string'
}

function parsePromaImageAttachmentText(text: string): ParsedAttachmentText {
  const attachments: AgentToolResultImage[] = []
  let removedAttachmentMarker = false
  const cleaned = text.replace(PROMA_IMAGE_ATTACHMENT_RE, (_match, raw: string) => {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (isAgentToolResultImage(parsed)) {
        attachments.push(parsed)
        removedAttachmentMarker = true
        return ''
      }
    } catch {
      return _match
    }
    return _match
  })

  if (!removedAttachmentMarker) {
    return { text, attachments }
  }

  return {
    text: cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    attachments,
  }
}

function dedupeAttachments(attachments: AgentToolResultImage[]): AgentToolResultImage[] {
  const seen = new Set<string>()
  const unique: AgentToolResultImage[] = []
  for (const attachment of attachments) {
    const key = `${attachment.localPath}|${attachment.filename}|${attachment.mediaType}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(attachment)
  }
  return unique
}

function inferImageExtension(mediaType: string): string {
  switch (mediaType) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    case 'image/svg+xml':
      return 'svg'
    case 'image/bmp':
      return 'bmp'
    default:
      return 'png'
  }
}

function readImageMediaType(block: Record<string, unknown>): string {
  if (typeof block.mimeType === 'string') return block.mimeType
  if (typeof block.mediaType === 'string') return block.mediaType
  if (typeof block.mime_type === 'string') return block.mime_type
  const source = block.source
  if (isRecord(source) && typeof source.media_type === 'string') return source.media_type
  return 'image/png'
}

function readImageData(block: Record<string, unknown>): string | undefined {
  if (typeof block.data === 'string') return block.data
  const source = block.source
  if (isRecord(source) && typeof source.data === 'string') return source.data
  return undefined
}

function toDataUrl(data: string, mediaType: string): string {
  if (data.startsWith('data:')) return data
  return `data:${mediaType};base64,${data}`
}

function collectDataImages(rawContent: unknown): DataToolResultImage[] {
  const blocks = Array.isArray(rawContent) ? rawContent : [rawContent]
  const images: DataToolResultImage[] = []

  blocks.forEach((item, index) => {
    if (!isRecord(item) || item.type !== 'image') return
    const data = readImageData(item)
    if (!data) return
    const mediaType = readImageMediaType(item)
    const filename = typeof item.filename === 'string'
      ? item.filename
      : `tool-result-image-${index + 1}.${inferImageExtension(mediaType)}`
    images.push({
      kind: 'data',
      id: `data:${index}:${data.slice(0, 24)}`,
      src: toDataUrl(data, mediaType),
      filename,
      mediaType,
    })
  })

  return images
}

function buildToolResultRenderData(result: string, rawContent: unknown): ToolResultRenderData {
  const parsed = parsePromaImageAttachmentText(result)
  const attachments = dedupeAttachments(parsed.attachments)
  const attachmentImages: AttachmentToolResultImage[] = attachments.map((attachment) => ({
    kind: 'attachment',
    id: `attachment:${attachment.localPath}`,
    localPath: attachment.localPath,
    filename: attachment.filename,
    mediaType: attachment.mediaType,
  }))

  return {
    text: parsed.text,
    // Nano Banana 同时返回 image block 和 PROMA_IMAGE_ATTACHMENT 标记。
    // 有本地附件时优先展示附件，避免同一张图重复出现；纯 Pi/MCP image block 则直接用 data URL。
    images: attachmentImages.length > 0 ? attachmentImages : collectDataImages(rawContent),
  }
}

function ToolResultImageGrid({ images }: { images: RenderableToolResultImage[] }): React.ReactElement | null {
  if (images.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2.5">
      {images.map((image) => (
        <ToolResultImagePreview key={image.id} image={image} />
      ))}
    </div>
  )
}

function ToolResultImagePreview({ image }: { image: RenderableToolResultImage }): React.ReactElement {
  const [imageSrc, setImageSrc] = React.useState<string | null>(image.kind === 'data' ? image.src : null)
  const [lightboxOpen, setLightboxOpen] = React.useState(false)

  React.useEffect(() => {
    if (image.kind === 'data') {
      setImageSrc(image.src)
      return
    }

    let cancelled = false
    setImageSrc(null)
    window.electronAPI
      .readAttachment(image.localPath)
      .then((base64) => {
        if (!cancelled) setImageSrc(`data:${image.mediaType};base64,${base64}`)
      })
      .catch((error) => {
        console.error('[ToolResultImagePreview] 读取图片附件失败:', error)
      })

    return () => {
      cancelled = true
    }
  }, [image])

  const handleSave = React.useCallback((): void => {
    if (image.kind === 'attachment') {
      window.electronAPI.saveImageAs(image.localPath, image.filename)
      return
    }
    if (!imageSrc) return
    const link = document.createElement('a')
    link.href = imageSrc
    link.download = image.filename
    link.click()
  }, [image, imageSrc])

  if (!imageSrc) {
    return <div className="h-[140px] w-[200px] shrink-0 rounded-md bg-muted/30 animate-pulse" />
  }

  return (
    <div className="relative inline-block group">
      <img
        src={imageSrc}
        alt={image.filename}
        className={cn(
          'max-h-[220px] max-w-[320px] rounded-md object-contain cursor-pointer',
          'bg-muted/20 shadow-sm',
        )}
        onClick={() => setLightboxOpen(true)}
      />
      <button
        type="button"
        onClick={handleSave}
        className="absolute bottom-2 right-2 rounded-md bg-black/50 p-1.5 text-white opacity-0 transition-opacity hover:bg-black/70 group-hover:opacity-100"
        title="保存图片"
      >
        <Download className="size-4" />
      </button>
      <ImageLightbox
        src={imageSrc}
        alt={image.filename}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onSave={handleSave}
      />
    </div>
  )
}

export interface ToolResultRendererProps {
  toolName: string
  input: Record<string, unknown>
  result: string
  isError: boolean
  basePath?: string
  rawContent?: unknown
}

export function ToolResultRenderer({ toolName, input, result, isError, basePath, rawContent }: ToolResultRendererProps): React.ReactElement {
  const renderData = React.useMemo(() => buildToolResultRenderData(result, rawContent), [result, rawContent])
  const cleanedResult = renderData.text
  const hasTextResult = cleanedResult.trim().length > 0

  const renderedTextResult = hasTextResult ? (() => {
    switch (toolName) {
      case 'Bash':
        return <BashResultRenderer result={cleanedResult} isError={isError} input={input} />
      case 'Read':
        return <ReadResultRenderer result={cleanedResult} isError={isError} input={input} />
      case 'LS':
        return <DefaultResultRenderer result={cleanedResult} isError={isError} />
      case 'Edit':
      case 'MultiEdit':
        return <EditResultRenderer result={cleanedResult} isError={isError} input={input} basePath={basePath} />
      case 'Write':
        return <WriteResultRenderer result={cleanedResult} isError={isError} input={input} />
      case 'Grep':
        return <GrepResultRenderer result={cleanedResult} isError={isError} input={input} />
      case 'Glob':
        return <GlobResultRenderer result={cleanedResult} isError={isError} />
      case 'WebSearch':
        return <WebSearchResultRenderer result={cleanedResult} isError={isError} />
      case 'WebFetch':
        return <WebFetchResultRenderer result={cleanedResult} isError={isError} />
      case 'TaskGet':
        return <TaskGetResultRenderer result={cleanedResult} isError={isError} />
      case 'TaskList':
        return <TaskListResultRenderer result={cleanedResult} isError={isError} />
      default:
        return <DefaultResultRenderer result={cleanedResult} isError={isError} />
    }
  })() : null

  if (renderData.images.length > 0) {
    return (
      <div className="space-y-2.5">
        <ToolResultImageGrid images={renderData.images} />
        {renderedTextResult}
      </div>
    )
  }

  if (!renderedTextResult) {
    return <DefaultResultRenderer result={result} isError={isError} />
  }

  return renderedTextResult
}

export { CollapsibleResult } from './collapsible-result'

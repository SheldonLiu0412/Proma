function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    const serialized = JSON.stringify(value, null, 2)
    return serialized ?? String(value)
  } catch {
    return String(value)
  }
}

function summarizeToolResultBlock(block: Record<string, unknown>): string | undefined {
  if (block.type === 'image') return undefined
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  if (typeof block.text === 'string') return block.text
  if (typeof block.blob === 'string') {
    const mimeType = typeof block.mimeType === 'string'
      ? block.mimeType
      : typeof block.mediaType === 'string'
        ? block.mediaType
        : 'binary'
    return `[二进制结果: ${mimeType}]`
  }
  return safeStringify(block)
}

export function summarizeToolResultContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (isRecord(content)) return summarizeToolResultBlock(content)
    return content == null ? undefined : safeStringify(content)
  }

  const parts = content.map((item) => {
    if (!isRecord(item)) return safeStringify(item)
    return summarizeToolResultBlock(item)
  }).filter((part): part is string => typeof part === 'string' && part.length > 0)

  return parts.length > 0 ? parts.join('\n') : undefined
}

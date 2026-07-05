/** 附件媒体类型分类：预览图片、vision 图片、文本可提取图片分别处理。 */

const VISION_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

const TEXT_EXTRACTABLE_IMAGE_MIME_TYPES = new Set([
  'image/svg+xml',
])

export function normalizeAttachmentMediaType(mediaType: string): string {
  return mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

export function isPreviewableImageMediaType(mediaType: string): boolean {
  return normalizeAttachmentMediaType(mediaType).startsWith('image/')
}

export function isVisionImageMediaType(mediaType: string): boolean {
  return VISION_IMAGE_MIME_TYPES.has(normalizeAttachmentMediaType(mediaType))
}

export function isTextExtractableImageMediaType(mediaType: string): boolean {
  return TEXT_EXTRACTABLE_IMAGE_MIME_TYPES.has(normalizeAttachmentMediaType(mediaType))
}

export function isBinaryImageMediaType(mediaType: string): boolean {
  return isPreviewableImageMediaType(mediaType)
    && !isVisionImageMediaType(mediaType)
    && !isTextExtractableImageMediaType(mediaType)
}

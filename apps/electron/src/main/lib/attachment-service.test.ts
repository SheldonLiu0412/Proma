import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type AttachmentService = typeof import('./attachment-service')

let service: AttachmentService
let tempHome = ''
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
  },
  BrowserWindow: {
    getFocusedWindow: () => null,
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

function attachmentsRoot(): string {
  return join(tempHome, '.proma', 'attachments')
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-attachment-service-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  service = await import('./attachment-service')
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }

  if (originalPromaDev === undefined) {
    delete process.env.PROMA_DEV
  } else {
    process.env.PROMA_DEV = originalPromaDev
  }

  rmSync(tempHome, { recursive: true, force: true })
})

describe('附件读取与图片分类安全', () => {
  test('Given 附件根目录内的相对图片路径 When 读取附件 Then 返回 base64 内容', () => {
    const data = Buffer.from('fake-image-data').toString('base64')
    const result = service.saveAttachment({
      conversationId: 'conversation-a',
      filename: 'sample.png',
      mediaType: 'image/png',
      data,
    })

    expect(service.readAttachmentAsBase64(result.attachment.localPath)).toBe(data)
  })

  test('Given 无扩展名图片 When 保存附件 Then 根据 MIME 补全图片扩展名', () => {
    const data = Buffer.from('clipboard-image-data').toString('base64')
    const result = service.saveAttachment({
      conversationId: 'conversation-no-ext',
      filename: 'clipboard-image',
      mediaType: 'image/png',
      data,
    })

    expect(result.attachment.localPath.endsWith('.png')).toBe(true)
    expect(service.readAttachmentAsBase64(result.attachment.localPath)).toBe(data)
  })

  test('Given 历史 .bin 图片附件 When 按附件元数据读取 Then 返回 base64 内容', () => {
    const data = Buffer.from('legacy-bin-image-data').toString('base64')
    const result = service.saveAttachment({
      conversationId: 'conversation-legacy-bin',
      filename: 'legacy-image.bin',
      mediaType: 'image/png',
      data,
    })

    expect(result.attachment.localPath.endsWith('.bin')).toBe(true)
    expect(service.readAttachmentAsBase64(result.attachment.localPath)).toBe(data)
    expect(service.readImageAttachmentAsBase64(result.attachment)).toBe(data)
  })

  test('Given 图片 MIME When 分类 Then 区分 UI 预览与 vision 发送能力', () => {
    expect(service.isPreviewableImageAttachment('image/png')).toBe(true)
    expect(service.isPreviewableImageAttachment('image/svg+xml')).toBe(true)
    expect(service.isPreviewableImageAttachment('image/bmp')).toBe(true)
    expect(service.isPreviewableImageAttachment('image/x-icon')).toBe(true)
    expect(service.isPreviewableImageAttachment('image/vnd.microsoft.icon')).toBe(true)

    expect(service.isVisionImageAttachment('image/png')).toBe(true)
    expect(service.isVisionImageAttachment('image/jpeg')).toBe(true)
    expect(service.isVisionImageAttachment('image/gif')).toBe(true)
    expect(service.isVisionImageAttachment('image/webp')).toBe(true)
    expect(service.isVisionImageAttachment('image/svg+xml')).toBe(false)
    expect(service.isVisionImageAttachment('image/bmp')).toBe(false)
    expect(service.isVisionImageAttachment('image/x-icon')).toBe(false)
    expect(service.isVisionImageAttachment('image/vnd.microsoft.icon')).toBe(false)

    expect(service.isImageAttachment('image/svg+xml')).toBe(false)
  })

  test('Given svg/bmp/ico 附件 When 通用读取 Then 返回内容但拒绝进入 vision 图片通道', () => {
    const dir = join(attachmentsRoot(), 'conversation-non-vision-images')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'vector.svg'), '<svg />')
    writeFileSync(join(dir, 'bitmap.bmp'), 'bitmap')
    writeFileSync(join(dir, 'icon.ico'), 'icon')

    expect(service.readAttachmentAsBase64('conversation-non-vision-images/vector.svg')).toBe(Buffer.from('<svg />').toString('base64'))
    expect(service.readAttachmentAsBase64('conversation-non-vision-images/bitmap.bmp')).toBe(Buffer.from('bitmap').toString('base64'))
    expect(service.readAttachmentAsBase64('conversation-non-vision-images/icon.ico')).toBe(Buffer.from('icon').toString('base64'))

    expect(() => service.readImageAttachmentAsBase64({
      localPath: 'conversation-non-vision-images/vector.svg',
      mediaType: 'image/svg+xml',
    })).toThrow('只允许读取图片附件')
    expect(() => service.readImageAttachmentAsBase64({
      localPath: 'conversation-non-vision-images/bitmap.bmp',
      mediaType: 'image/bmp',
    })).toThrow('只允许读取图片附件')
    expect(() => service.readImageAttachmentAsBase64({
      localPath: 'conversation-non-vision-images/icon.ico',
      mediaType: 'image/x-icon',
    })).toThrow('只允许读取图片附件')
  })

  test('Given 历史 .bin 但 MIME 不是 vision 支持格式 When 读取图片 Then 拒绝读取', () => {
    const data = Buffer.from('<svg />').toString('base64')
    const result = service.saveAttachment({
      conversationId: 'conversation-svg-bin',
      filename: 'vector.bin',
      mediaType: 'image/svg+xml',
      data,
    })

    expect(() => service.readImageAttachmentAsBase64(result.attachment)).toThrow('只允许读取图片附件')
  })

  test('Given 非 .bin 文件伪装成图片 MIME When 读取图片 Then 拒绝读取', () => {
    const data = Buffer.from('not an image').toString('base64')
    const result = service.saveAttachment({
      conversationId: 'conversation-spoofed-text',
      filename: 'spoofed.txt',
      mediaType: 'image/png',
      data,
    })

    expect(() => service.readImageAttachmentAsBase64(result.attachment)).toThrow('只允许读取图片附件')
  })

  test('Given 相对路径包含上级目录 When 读取附件 Then 拒绝越界读取', () => {
    const outsidePath = join(tempHome, '.proma', 'escape.png')
    mkdirSync(join(tempHome, '.proma'), { recursive: true })
    writeFileSync(outsidePath, 'escape')

    expect(() => service.readAttachmentAsBase64('../escape.png')).toThrow('附件路径不在附件目录内')
  })

  test('Given 绝对路径位于附件根目录外 When 读取附件 Then 拒绝越界读取', () => {
    const outsidePath = join(tempHome, 'outside.png')
    writeFileSync(outsidePath, 'outside')

    expect(() => service.readAttachmentAsBase64(outsidePath)).toThrow('附件路径不在附件目录内')
    expect(() => service.readImageAttachmentAsBase64({ localPath: outsidePath, mediaType: 'image/png' })).toThrow(
      '附件路径不在附件目录内',
    )
  })

  test('Given 附件根目录内的非图片文件 When 通用读取 Then 返回 base64 内容', () => {
    const noteDir = join(attachmentsRoot(), 'conversation-b')
    mkdirSync(noteDir, { recursive: true })
    writeFileSync(join(noteDir, 'note.txt'), 'plain text')

    expect(service.readAttachmentAsBase64('conversation-b/note.txt')).toBe(Buffer.from('plain text').toString('base64'))
  })

  test('Given 空附件路径 When 读取附件 Then 拒绝读取', () => {
    expect(() => service.readAttachmentAsBase64('  ')).toThrow('附件路径不能为空')
  })
})

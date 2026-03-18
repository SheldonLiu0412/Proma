/**
 * API 拦截器
 *
 * 在 debug 模式（PROMA_AGENT_DEBUG=1）下启动本地 HTTP 代理服务器，
 * 拦截 Claude Agent SDK CLI 子进程对 Anthropic API 的所有请求。
 *
 * 工作原理：
 * 1. 启动本地 HTTP 服务器（随机端口）
 * 2. 通过 ANTHROPIC_BASE_URL 将 CLI 子进程的请求重定向到本地服务器
 * 3. 本地服务器将请求转发到真实的 Anthropic API，同时记录请求/响应
 * 4. 所有 API 调用（包括工具调用间的中间轮次）都会被记录到 debug JSON
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import { request as httpsReq } from 'node:https'
import { request as httpReq } from 'node:http'
import { URL } from 'node:url'

export interface ApiInterceptorHandle {
  /** 拦截器监听的本地端口 */
  port: number
  /** 停止并释放端口 */
  close: () => void
}

/** 调用方提供的 debug 条目追加函数 */
type AppendEntry = (entry: object) => void

/** 解析 SSE 事件流，返回解析后的事件对象数组 */
function parseSSEBody(body: string): unknown[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => {
      try { return JSON.parse(line.slice(6)) } catch { return null }
    })
    .filter(Boolean)
}

/**
 * 创建并启动一个 API 拦截代理服务器
 *
 * @param appendEntry - 每次捕获到 API 调用时的回调，写入 debug 文件
 * @param targetBaseUrl - 真实 Anthropic API 的 base URL（含协议和 host）
 */
export function createApiInterceptor(
  appendEntry: AppendEntry,
  targetBaseUrl: string,
): Promise<ApiInterceptorHandle> {
  let target: URL
  try {
    target = new URL(targetBaseUrl)
  } catch {
    target = new URL('https://api.anthropic.com')
  }

  const isHttps = target.protocol === 'https:'

  return new Promise((resolve, reject) => {
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // 收集完整请求体（需要先缓冲再转发，以便记录）
      const reqChunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => reqChunks.push(chunk))
      req.on('end', () => {
        const reqBodyBuf = Buffer.concat(reqChunks)
        const reqBodyStr = reqBodyBuf.toString('utf-8')
        let parsedReqBody: unknown = reqBodyStr
        try { parsedReqBody = JSON.parse(reqBodyStr) } catch { /* 保持原始字符串 */ }

        // 构建转发 headers（去掉 host，避免发给错误的 host）
        const forwardHeaders: Record<string, string | string[]> = {}
        for (const [k, v] of Object.entries(req.headers)) {
          if (k.toLowerCase() !== 'host' && v !== undefined) {
            forwardHeaders[k] = v as string | string[]
          }
        }

        // 拼接目标路径（target.pathname 可能含前缀，如 /v1）
        const targetPath = target.pathname.replace(/\/$/, '') + (req.url || '/')

        const reqOptions = {
          hostname: target.hostname,
          port: target.port ? parseInt(target.port) : (isHttps ? 443 : 80),
          path: targetPath,
          method: req.method || 'POST',
          headers: { ...forwardHeaders, host: target.host },
        }

        const makeRequest = isHttps ? httpsReq : httpReq

        const proxyReq = makeRequest(reqOptions as Parameters<typeof httpsReq>[0], (proxyRes) => {
          // 原样转发响应头和状态码
          const respHeaders: Record<string, string | string[]> = {}
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            if (v !== undefined) respHeaders[k] = v as string | string[]
          }
          res.writeHead(proxyRes.statusCode || 200, respHeaders)

          // 流式转发响应体（保证 SDK 收到实时流），同时本地缓冲用于记录
          const resChunks: Buffer[] = []
          proxyRes.on('data', (chunk: Buffer) => {
            res.write(chunk)
            resChunks.push(chunk)
          })

          proxyRes.on('end', () => {
            res.end()

            const resBodyStr = Buffer.concat(resChunks).toString('utf-8')
            const isSSE = (proxyRes.headers['content-type'] || '').includes('text/event-stream')

            let parsedResBody: unknown
            if (isSSE) {
              parsedResBody = parseSSEBody(resBodyStr)
            } else {
              try { parsedResBody = JSON.parse(resBodyStr) } catch { parsedResBody = resBodyStr }
            }

            appendEntry({
              type: 'api_call',
              timestamp: new Date().toISOString(),
              method: req.method,
              path: req.url,
              status: proxyRes.statusCode,
              isStream: isSSE,
              request: parsedReqBody,
              response: parsedResBody,
            })
          })

          proxyRes.on('error', (err: Error) => {
            console.error('[API 拦截器] 代理响应错误:', err.message)
          })
        })

        proxyReq.on('error', (err: Error) => {
          console.error('[API 拦截器] 代理请求错误:', err.message)
          if (!res.headersSent) res.writeHead(502)
          res.end(err.message)
        })

        if (reqBodyBuf.length > 0) proxyReq.write(reqBodyBuf)
        proxyReq.end()
      })
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr === 'object' && addr) {
        resolve({
          port: addr.port,
          close: () => { try { server.close() } catch { /* 忽略 */ } },
        })
      } else {
        reject(new Error('无法获取拦截器监听地址'))
      }
    })

    server.on('error', reject)
  })
}

/**
 * 本地静态服务器 —— 纯 Node，无任何依赖。
 *
 *   node server.mjs           # 默认 5173 端口
 *   PORT=8080 node server.mjs
 *
 * 为什么需要它？示例页面用的是原生 ESM（<script type="module">），
 * 直接双击打开 HTML 会因为浏览器对 file:// 协议的 CORS 限制而无法 import 模块，
 * 所以要通过 http:// 来访问。
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const port = Number(process.env.PORT) || 5173

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const server = createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (pathname === '/') pathname = '/examples/index.html'

    // 防目录穿越
    const file = normalize(join(root, pathname))
    if (!file.startsWith(root)) {
      res.writeHead(403).end('Forbidden')
      return
    }

    const body = await readFile(file)
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      // 模块开发期间禁用缓存，改完代码刷新即生效
      'Cache-Control': 'no-store',
    })
    res.end(body)
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404 Not Found: ' + new URL(req.url, 'http://x').pathname)
  }
})

server.listen(port, () => {
  console.log(`[vue-mini] 示例已就绪: http://localhost:${port}/examples/index.html`)
  console.log(`  · 编译流水线  http://localhost:${port}/examples/compile-pipeline.html`)
  console.log(`  · 渲染器 Diff  http://localhost:${port}/examples/renderer.html`)
  console.log(`  · 响应式系统   http://localhost:${port}/examples/reactivity.html`)
  console.log(`  · 组件化       http://localhost:${port}/examples/components.html`)
})

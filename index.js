/**
 * dsh-comm-protocol — host half.
 *
 * 三件事：
 *   1. 读源：protocol/PROTOCOL.md（随包分发，每次装配重新读）
 *   2. 读配置：<DSH_HOME>/comm-protocol/config.json（绝对路径，不依赖任何环境变量）
 *   3. 装配：把「版本 + 档位 + 握手格式」这些机械参数拼在正文之外，合成一个
 *      systemPrompt.section；enabled=false 时返回空串，该 section 对模型完全不存在。
 *
 * ctx.systemPrompt.section({ text }) 的 text 若是函数，每次装配都会重新求值
 * （见 @deepseek-ai/dsh-system-prompt 的 PromptSection 定义）。所以开关与档位切换
 * 不需要重启，下一轮装配即生效。只有「安装/移除插件包」本身需要重启。
 *
 * @module dsh-comm-protocol
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const name = 'comm-protocol'
/**
 * 只把 systemPrompt 作为硬依赖。webServer 是可选的——状态路由拿不到也绝不能
 * 影响 section 装配，注入才是唯一必需的。
 */
const inject = ['systemPrompt']

/** 包根目录，用 import.meta.url 推导，避免写死绝对路径。 */
const packageRoot = dirname(fileURLToPath(import.meta.url))
const sourcePath = join(packageRoot, 'protocol', 'PROTOCOL.md')

/**
 * 探测标记：只存在于内存，进程启动时生成一次，绝不落盘。
 *
 * 它是唯一能证明「正文真的进了模型上下文」的东西——因为除了 system prompt
 * 这条路径，它不存在于任何可读的地方。模型若复述得出，注入就确实发生了。
 */
const bootNonce = randomUUID().replace(/-/g, '').slice(0, 12)

/**
 * 状态与配置目录：全局一份，不按 profile 分。
 *
 * 曾经按 profile 推导、并在拿不到环境变量时兜底成 'web'，结果插件宿主进程里根本没有
 * 那些变量，配置静默落进了别的目录——"改了配置却没反应"。任何依赖宿主进程环境变量的
 * 路径推导都会重演这个故障，所以退回到唯一不依赖任何变量的位置。
 */
function stateDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'comm-protocol')
}
function configPath() {
  return join(stateDir(), 'config.json')
}
/** 装配结果的落点。给人看，不给模型看。 */
function statusPath() {
  return join(stateDir(), 'status.json')
}

const DEFAULT_CONFIG = {
  /** 总开关。false 时 section 返回空串，零 token、零存在。 */
  enabled: false,
  /** 协议档位：align / explore / deliver。与总开关是两个轴。 */
  mode: 'explore',
  /** 期望的协议版本。为 null 表示不校验（不建议）。 */
  expectVersion: null,
  /** 打开后 section 会带上本次进程的 bootNonce，用于一次性验证送达。 */
  probe: false,
}

function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_CONFIG }
    return { ...DEFAULT_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/**
 * 首次安装时自动建配置：默认开启，并把 expectVersion 对齐到当前正文版本。
 *
 * 没有这一步，别人装完必须自己手写一个 JSON 才能用，而且极易漏掉 expectVersion，
 * 结果就是"装上了但没反应"。自动对齐消掉这个坑。
 */
function ensureConfig() {
  if (existsSync(configPath())) return readConfig()

  let version = null
  try {
    version = readProtocol().version
  } catch {
    version = null
  }

  const initial = { ...DEFAULT_CONFIG, enabled: true, expectVersion: version }
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(configPath(), `${JSON.stringify(initial, null, 2)}\n`, 'utf8')
  } catch {
    // 建不出来就退回默认值，不能让插件因此不加载。
  }
  return readConfig()
}

/** 解析 PROTOCOL.md 的简单 frontmatter（只支持 `key: value`）。 */
function readProtocol() {
  if (!existsSync(sourcePath)) throw new Error(`协议源不存在：${sourcePath}`)
  const raw = readFileSync(sourcePath, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
  if (match === null) throw new Error('PROTOCOL.md 缺少 frontmatter')
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at > 0) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  const body = match[2].trim()
  if (body === '') throw new Error('PROTOCOL.md 正文为空')
  return { version: meta.version ?? 'unknown', body }
}

function tag(status, mode, body) {
  const attrs = [`status="${status}"`]
  if (mode !== '') attrs.push(`mode="${mode}"`)
  return `<comm-protocol ${attrs.join(' ')}>\n${body}\n</comm-protocol>`
}

/** 装配文本。每次装配都会调用，所以不做任何缓存：改 config 下一轮即生效。 */
function render() {
  const config = readConfig()

  if (!config.enabled) {
    record({ config, protocol: null, state: 'disabled', section: '' })
    return ''
  }

  let protocol
  try {
    protocol = readProtocol()
  } catch (error) {
    // 失败要响亮，不能静默注入一个空协议。
    const section = tag('error', '', `协议源读取失败：${String(error.message ?? error)}。协议未注入；若用户问起，如实说明。`)
    record({ config, protocol: null, state: 'source-error', section })
    return section
  }

  if (config.expectVersion !== null && String(config.expectVersion) !== protocol.version) {
    const section = tag(
      'version-mismatch',
      '',
      `版本不匹配：源=${protocol.version}，期望=${config.expectVersion}。协议未注入；若用户问起，如实说明。`,
    )
    record({ config, protocol, state: 'version-mismatch', section })
    return section
  }

  let body = `${protocol.body}

---

<!-- 以下为宿主注入的机械要求，不随协议版本变化 -->

握手：本会话**首条实质性回复的第一行**，必须原样输出下列标记，随后接框架复述：

⟨proto ${protocol.version} · mode=${config.mode}⟩

该行缺失即表示协议未生效（用户据此判断机械链路是否打通）。只在本会话第一轮输出，之后不再重复，避免逐轮噪音。`

  if (config.probe === true) {
    body += `

探测标记（仅用于验证注入链路，不进任何文件、只存在于本次进程内存与这段文字里）：⟨probe ${bootNonce}⟩`
  }

  const section = tag(protocol.version, config.mode, body)
  record({ config, protocol, state: 'ok', section })
  return section
}

let assembleCount = 0

/**
 * 把装配结果写到 status.json，供人直接查看。
 *
 * 它证明的是「我渲染出了这段文本」，不是「这段文本到了模型手里」。所以字段叫
 * sectionRendered 而不是 injected——后者会让人以为送达已被证实，而那正是要避免的假信号。
 *
 * bootNonce 永远不写：它是唯一的送达证据，一旦落盘就作废。
 */
function record({ config, protocol, state, section }) {
  assembleCount += 1
  try {
    const payload = {
      state,
      enabled: config.enabled,
      mode: config.mode,
      protoVersion: protocol?.version ?? null,
      expectVersion: config.expectVersion,
      versionMatches:
        protocol === null
          ? false
          : config.expectVersion === null || String(config.expectVersion) === protocol.version,
      sectionRendered: section.length,
      assembleCount,
      pid: process.pid,
      assembledAt: new Date().toISOString(),
    }
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(statusPath(), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch {
    // 观测设施失败，不影响装配。
  }
}

/** 自检：只覆盖插件可知的机械链路。 */
function status() {
  const config = readConfig()
  const checks = {}

  try {
    JSON.parse(readFileSync(configPath(), 'utf8'))
    checks.configParsed = true
  } catch {
    checks.configParsed = false
  }

  let protocol = null
  try {
    protocol = readProtocol()
    checks.sourceReadable = true
  } catch (error) {
    checks.sourceReadable = false
    checks.sourceError = String(error.message ?? error)
  }

  checks.version = protocol?.version ?? null
  checks.expectVersion = config.expectVersion
  checks.versionMatches =
    protocol === null ? false : config.expectVersion === null || String(config.expectVersion) === protocol.version
  checks.sectionChars = render().length
  checks.injected = config.enabled && checks.sourceReadable && checks.versionMatches

  return {
    package: 'dsh-comm-protocol',
    configPath: configPath(),
    statusPath: statusPath(),
    sourcePath,
    probeNonce: config.probe === true ? bootNonce : null,
    config,
    checks,
  }
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw === '' ? {} : JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function apply(ctx) {
  ensureConfig()

  ctx.effect(() => {
    const disposeSection = ctx.systemPrompt.section({
      name: 'comm-protocol',
      // 顺序约定：-100 是 harness 身份，0 是 deployment persona，100–199 是工具指引。
      // 协议管"怎么谈"，要排在 persona 之前被读到，所以取 -50；占 0 会撞 persona 槽位。
      order: -50,
      text: () => render(),
    })

    let disposeRoute = () => {}
    try {
      disposeRoute = ctx.webServer.register({
        kind: 'exact',
        path: '/api/comm-protocol',
        handler: async (req, res) => {
          const method = req.method ?? 'GET'
          if (method === 'GET') {
            json(res, 200, status())
            return
          }
          if (method === 'POST') {
            try {
              const next = { ...readConfig(), ...(await readBody(req)) }
              mkdirSync(stateDir(), { recursive: true })
              writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
              json(res, 200, status())
            } catch (error) {
              json(res, 400, { error: String(error.message ?? error) })
            }
            return
          }
          json(res, 405, { error: `method ${method} not allowed` })
        },
      })
    } catch {
      // 路由只是便利设施：拿不到 webServer 或注册失败，都不能拖垮注入。
    }

    return () => {
      disposeSection()
      disposeRoute()
    }
  }, 'comm-protocol: dynamic section + status route')
}

export { apply, inject, name }

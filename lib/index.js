/**
 * dsh-seedream-studio — Host 半侧。
 *
 * 设计要点（与 UI 半侧、agent 工具共用一套实现）：
 *  1. **完全自包含**：生图能力内置在本包里（`seedream-api.js` / `prompt-enhance.js`
 *     / `media-security.js`），不调用外部 skill、不起子进程、无运行时依赖。
 *     发布时不需要携带或转发任何第三方代码。
 *  2. **密钥交给 DSH 管**：界面里填的 Key 写进 DSH 凭据库
 *     （`$DSH_HOME/.credentials.yaml` 的 `ARK_AGENT_PLAN_API_KEY`），
 *     **不落进插件目录** —— 这是开源项目，Key 一旦进了仓库就是安全事故。
 *     `/state` 只回报"配没配"与打码指纹，明文仅用于拼一次 Authorization 头，
 *     绝不写日志、绝不下发前端。
 *  3. **一个操作，两个入口**：`runGeneration()` 只实现一次；HTTP 路由（给图形
 *     界面）与 `seedream_generate` 工具（给 agent）拿到完全相同的 result 结构。
 *
 * 关于 import：本包**不** import 任何 `@deepseek-ai/*`。裸包名只对
 * `<profile>/node_modules/<pkg>` 下的代码可解析，插件目录被 link 安装后解析
 * 路径不在其中，import 会在加载期直接 ERR_MODULE_NOT_FOUND。因此工具定义用
 * 普通对象 + 手写 render，config 用普通 JS 校验。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { MODELS, generateImages, prepareParams } from './seedream-api.js'
import { optimizePrompt } from './prompt-enhance.js'
import { randomUUID } from 'node:crypto'

const ROUTE_PREFIX = '/seedream-studio'

/** 支持的模型别名（技能注册表里的 alias；pro 的点号 model_id 不要直接用）。 */
/** 内置生图引擎版本，显示在界面底部；与模型版本无关。 */
const ENGINE_VERSION = '5.0'

const MODEL_ALIASES = ['auto', 'flash', 'pro']
/** 支持的尺寸档位。3K/4K/组图在 5.0 Flash/Pro 上不可用，界面明确禁用而不是静默降级。 */
const SIZE_PRESETS = ['1K', '1.5K', '2K']
const OUTPUT_FORMATS = ['jpeg', 'png']
const MAX_REFERENCE_IMAGES = 10
/** 单张图预览读取上限，防止把超大文件整个读进内存。 */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
/** 单张参考图上限：技能自己限制 30 MB，这里留一点余量。 */
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024
/** 一次生成的硬上限。生图通常几十秒，这里留足余量。 */
const GENERATION_TIMEOUT_MS = 300_000
/** stderr 里保留的进度行数。 */
const LOG_KEEP = 40
/** 内存里保留的生成记录条数上限。 */
const IMAGE_EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
])

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 展开开头的 `~`，只做这一种展开（不解析 `$VAR`，配置里不应出现）。 */
function expandHome(value) {
  if (typeof value !== 'string') return value
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return path.join(homedir(), value.slice(2))
  return value
}

/** 只认回环地址：localhost / *.localhost / 127.0.0.0/8 逐段校验 / ::1。 */
function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((part) => Number(part) <= 255)
}

/** 统一的 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 读请求体并按上限拒绝。返回已解析的 JSON 对象；失败抛带 message 的 Error。 */
async function readJsonBody(req, limit = 256 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return parsed
}

/** 默认保存目录链：插件配置 → 环境变量 → 主目录下的固定目录。 */
function defaultSavePath(dshHome) {
  /*
   * 默认落在 `$DSH_HOME/seedream-images`，和本机既有惯例一致
   * （whale-widget 也用 `$DSH_HOME/whale-*` 放自己的数据）。
   *
   * 刻意**不**跟随插件安装目录：那通常是 node_modules 或源码 checkout，
   * 卸载会连图一起删、升级换版本会变孤儿，某些安装形态还是只读的。
   * 也不默认写桌面 —— 生成产物不该持续弄脏桌面。
   */
  const fromEnv = process.env.ARK_SEEDREAM_SAVE_PATH || process.env.ARK_SAVE_PATH
  if (fromEnv) return fromEnv
  return path.join(dshHome, 'seedream-images')
}

/** 实际生效的保存目录：用户配置优先，否则用默认。 */
function effectiveSavePath(cfg) {
  return cfg.savePath || defaultSavePath(cfg.dshHome)
}

/**
 * 凭据名。写进 DSH 自己的凭据库（`$DSH_HOME/.credentials.yaml`）的 `refs` 段。
 *
 * **只用这一个名字，不做回退。** 早先为了"兼容旧命名"会依次尝试
 * `ARKCLI_AGENT_PLAN_API_KEY`、`ARK_AGENT_PLAN_CN_API_KEY`，结果有两个坑：
 *
 *  1. 那几个名字属于**别的工具**（arkcli、别的插件），插件不该替它们做决定；
 *  2. 清除时只 unset 自己的名字，读取却回退到别人的，于是"清不掉"。
 *
 * 现在语义很干脆：这个插件只认自己写的这一条，清完就是干净。
 */
const KEY_REF_NAME = 'ARK_AGENT_PLAN_API_KEY'

/** Agent Plan Key 的形状：ark- 开头，只含安全字符。 */
const KEY_PATTERN = /^ark-[A-Za-z0-9._-]+$/

/**
 * 取出 `credentials.resolve()` 返回里的明文值。
 *
 * DSH 的 `resolve()` 返回 `{ value, source }`（**不是**字符串），早先按字符串处理
 * 导致 Key 永远读不到。这里同时容忍纯字符串，免得不同版本口径不一致时又坏一次。
 *
 * @param hit resolve() 的返回值
 * @returns {string} 明文；没有则空串
 */
function unwrapCredential(hit) {
  if (typeof hit === 'string') return hit
  if (hit && typeof hit === 'object' && typeof hit.value === 'string') return hit.value
  return ''
}

/** 把 Key 中间打码，只留头尾，用于界面回显"已配置的是哪一把"。 */
function maskKey(key) {
  if (typeof key !== 'string' || key.length < 12) return null
  return `${key.slice(0, 7)}…${key.slice(-4)}`
}

/**
 * 取出生图要用的 Agent Plan Key。
 *
 * **唯一来源是 DSH 凭据库**：用户在界面里填的 Key 就存在那里（`.credentials.yaml`），
 * 这样它不会被误当成插件文件提交进开源仓库——这是最重要的理由。
 * **刻意不读 `ARK_API_KEY` 环境变量**：这个插件只认 Agent Plan，而环境里那个
 * 通用变量可能来自别的工具、指向别的计费主体；悄悄拿它去生图会造成"我没填过
 * 怎么就在扣费"的误会。没配就是没配，交给界面提示手动填。
 *
 * **只认 `KEY_REF_NAME` 一条**，不读 `ARKCLI_*` 等别的工具的名字：
 * 那会让别人的 Key 悄悄替我们生效，用户点"清除"时又清不干净。
 *
 * @param ctx 插件上下文
 * @returns {Promise<string>} 明文 Key 或空串
 */
async function resolveApiKey(ctx) {
  // 宿主 credentials 服务（界面里"配置 Key"写的就是这里），也是唯一来源。
  try {
    const store = ctx.get('credentials')
    if (store && typeof store.resolve === 'function') {
      // 只认自己那一条；不读别的工具的 Key，免得它们的值意外替我们生效。
      const value = unwrapCredential(await store.resolve(KEY_REF_NAME))
      if (value.startsWith('ark-')) return value
    }
  } catch {
    /* 没有 credentials 服务当作未配置，交给界面提示手动填 */
  }

  return ''
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

/**
 * 校验并补全插件配置。
 *
 * 没有 `export const Config`（那需要 @deepseek-ai/schemastery），所以 cordis 会把
 * 原始 YAML 配置对象直接传进 apply。手写校验的好处是能给出准确的中文提示，
 * 且不会因为缺依赖在加载期炸掉。
 */
function normalizeConfig(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh')
  const warnings = []

  const readString = (key) => {
    const value = raw[key]
    if (value === undefined || value === null) return ''
    if (typeof value !== 'string') {
      warnings.push(`${key} 必须是字符串，已忽略`)
      return ''
    }
    return expandHome(value.trim())
  }

  const savePath = readString('savePath')

  const pick = (key, allowed, fallback) => {
    const value = raw[key]
    if (value === undefined || value === null) return fallback
    if (typeof value !== 'string' || !allowed.includes(value)) {
      warnings.push(`${key} 只能是 ${allowed.join(' / ')}，已回退到 ${fallback}`)
      return fallback
    }
    return value
  }

  let historyLimit = 20
  if (raw.historyLimit !== undefined && raw.historyLimit !== null) {
    const n = Number(raw.historyLimit)
    if (Number.isInteger(n) && n >= 1 && n <= 200) historyLimit = n
    else warnings.push('historyLimit 必须是 1–200 的整数，已回退到 20')
  }

  return {
    dshHome,
    savePath: savePath || '',
    defaultModel: pick('defaultModel', MODEL_ALIASES, 'auto'),
    defaultSize: pick('defaultSize', SIZE_PRESETS, '2K'),
    defaultOutputFormat: pick('defaultOutputFormat', OUTPUT_FORMATS, 'jpeg'),
    historyLimit,
    warnings,
  }
}

/* ------------------------------------------------------------------ */
/* 生成                                                                */
/* ------------------------------------------------------------------ */

/**
 * 生成可读的模型名，用于结果摘要。
 * @param {string} modelId 模型 ID
 * @returns {string} 展示名
 */
function modelDisplayName(modelId) {
  const found = Object.values(MODELS).find((model) => model.id === modelId)
  return found ? found.displayName : modelId
}

/**
 * 跑一次生成。这是唯一的实现，HTTP 路由与 agent 工具都走这里。
 *
 * 直接用内置实现发请求、下载图片，不再启动子进程调用外部 skill：
 * 包因此完全自包含，发布时不携带也不依赖第三方代码。
 *
 * @param ctx 插件上下文。
 * @param cfg 已规整的插件配置。
 * @param opts 已校验的生成参数。
 * @param hooks { signal, onProgress }
 * @returns {Promise<object>} 统一结果
 */
async function runGeneration(ctx, cfg, opts, hooks = {}) {
  const startedAt = Date.now()
  const apiKey = await resolveApiKey(ctx)
  if (!apiKey) {
    return failureResult('还没有配置 Agent Plan Key。点界面右上角「配置 Key」填入 ark- 开头的 Key。')
  }

  // 取消在提交前就已经发生：不必发请求。
  const signal = hooks.signal
  if (signal && signal.aborted) {
    return failureResult('已取消生成。', { elapsedMs: 0, cancelled: true })
  }

  let prepared
  try {
    prepared = prepareParams({
      prompt: opts.prompt,
      model: opts.model,
      size: opts.size,
      referenceImages: opts.referenceImages,
      outputFormat: opts.outputFormat,
      watermark: opts.watermark,
      optimize: opts.optimizePrompt,
    })
  } catch (error) {
    return failureResult(errorText(error), { elapsedMs: Date.now() - startedAt })
  }

  // 提示词增强是纯本地拼接：不调接口、不计费。
  const enhanced = optimizePrompt(prepared.prompt, prepared.optimize === true, false)
  const finalPrompt = enhanced.optimized

  const report = typeof hooks.onProgress === 'function' ? hooks.onProgress : () => {}

  let outcome
  try {
    outcome = await generateImages({
      apiKey,
      params: prepared,
      finalPrompt,
      saveDir: effectiveSavePath(cfg),
      onProgress: report,
    })
  } catch (error) {
    const elapsedMs = Date.now() - startedAt
    // 取消与超时各自给准确说法，不要混成笼统的"生成失败"。
    if (signal && signal.aborted) {
      return failureResult('已取消生成。', { elapsedMs, cancelled: true })
    }
    const message = errorText(error)
    const failure = failureResult(message, { elapsedMs })
    if (error && typeof error.httpStatus === 'number') failure.httpStatus = error.httpStatus
    return failure
  }

  const elapsedMs = Math.max(0, Date.now() - startedAt)
  const images = normalizeImages(outcome.images)
  const result = {
    success: true,
    error: null,
    summary: '',
    images,
    model: modelDisplayName(outcome.model),
    size: outcome.size,
    outputFormat: prepared.outputFormat,
    elapsedMs,
    saveDir: effectiveSavePath(cfg),
    prompt: prepared.prompt,
    optimizedPrompt: finalPrompt === prepared.prompt ? null : finalPrompt,
  }
  result.summary = summarize(result)
  return result
}

function normalizeImages(payloadImages) {
  if (!Array.isArray(payloadImages)) return []
  const out = []
  for (const item of payloadImages) {
    if (!item || typeof item !== 'object') continue
    out.push({
      localPath: typeof item.local_path === 'string' && item.local_path ? item.local_path : null,
      url: typeof item.url === 'string' && item.url ? item.url : null,
      fileName: typeof item.file_name === 'string' && item.file_name ? item.file_name : null,
      downloadOk: item.download_success === true,
      downloadError: typeof item.download_error === 'string' && item.download_error ? item.download_error : null,
      index: Number.isFinite(item.index) ? item.index : null,
      outputFormat: typeof item.output_format === 'string' ? item.output_format : null,
    })
  }
  return out
}

/** 一句话总结，给工具 render 与界面共用。 */
function summarize(result) {
  // 用户主动取消不是"失败"：写"生成失败：已取消生成"既重复又误导。
  if (!result.success) {
    if (result.cancelled) return result.error || '已取消生成。'
    return result.error ? `生成失败：${result.error}` : '生成失败'
  }
  const parts = []
  if (result.model) parts.push(result.model)
  if (result.size) parts.push(String(result.size).toUpperCase())
  parts.push(`${result.images.length} 张`)
  const seconds = result.elapsedMs > 0 ? Math.round(result.elapsedMs / 1000) : null
  if (seconds !== null) parts.push(`${seconds}s`)
  return `已生成 ${parts.join(' · ')}`
}

/**
 * 读 `collect` 模式子进程的完整输出。
 *
 * 只有"打开目录 / 移到废纸篓"这类短命令还用子进程，命令失败时要把
 * stderr 原文带回界面，否则用户只看到"退出码 1"不知道发生了什么。
 *
 * @param reader 子进程输出读取器
 * @returns {string} 文本；读不到返回空串
 */
function readCollected(reader) {
  if (!reader || typeof reader.readFrom !== 'function') return ''
  try {
    return reader.readFrom(0).text || ''
  } catch {
    return ''
  }
}

/** 错误对象转一行文本。 */
function errorText(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  const message = typeof error.message === 'string' ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim()
}

/**
 * 构造一次失败结果。
 *
 * 工具与界面共用同一个形状：`success:false` + 一句话 `summary`，
 * 再带上耗时与取消标记，避免上层各写一套拼装逻辑。
 *
 * @param {string} message 失败原因
 * @param {{elapsedMs?:number, cancelled?:boolean}} [extra] 附加信息
 * @returns {object} 失败结果
 */
function failureResult(message, extra = {}) {
  const elapsedMs = Number.isFinite(extra.elapsedMs) ? extra.elapsedMs : 0
  const result = {
    success: false,
    error: message || '生成失败',
    summary: '',
    images: [],
    model: null,
    size: null,
    outputFormat: null,
    elapsedMs,
    saveDir: null,
    cancelled: extra.cancelled === true,
    httpStatus: null,
  }
  result.summary = summarize(result)
  return result
}

/* ------------------------------------------------------------------ */
/* 参数校验                                                            */
/* ------------------------------------------------------------------ */

/** 校验并补全一次生成请求。返回 { opts } 或 { error }。 */
function normalizeGenerateInput(cfg, input, overrides = {}) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const warnings = []

  const prompt = typeof body.prompt === 'string' ? body.prompt : ''
  if (!prompt.trim()) return { error: '请填写提示词。' }
  if (prompt.length > 3000) return { error: `提示词不能超过 3000 字符（当前 ${prompt.length}）。` }

  const model = typeof body.model === 'string' && MODEL_ALIASES.includes(body.model)
    ? body.model
    : (overrides.model || cfg.defaultModel)
  const size = typeof body.size === 'string' && SIZE_PRESETS.includes(body.size)
    ? body.size
    : (overrides.size || cfg.defaultSize)

  if (body.model !== undefined && body.model !== null && !MODEL_ALIASES.includes(body.model)) {
    warnings.push(`模型 ${String(body.model)} 不支持，已回退到 ${model}`)
  }
  if (body.size !== undefined && body.size !== null && !SIZE_PRESETS.includes(body.size)) {
    warnings.push(`尺寸 ${String(body.size)} 不支持，已回退到 ${size}`)
  }

  const referenceImages = []
  // 展开 `~/`：技能侧是用 fs.statSync 判断本地文件的，字面量 `~` 不存在，
  // 会一路掉到"当成 URL"的分支然后失败。用户最自然的输入就是 `~/Desktop/a.png`。
  if (Array.isArray(body.reference_images)) {
    for (const item of body.reference_images) {
      if (typeof item !== 'string') continue
      const trimmed = item.trim()
      if (trimmed) referenceImages.push(expandHome(trimmed))
    }
  } else if (typeof body.reference_images === 'string' && body.reference_images.trim()) {
    referenceImages.push(expandHome(body.reference_images.trim()))
  }
  if (referenceImages.length > MAX_REFERENCE_IMAGES) {
    return { error: `参考图最多 ${MAX_REFERENCE_IMAGES} 张（当前 ${referenceImages.length} 张）。` }
  }

  let outputFormat = null
  if (body.output_format !== undefined && body.output_format !== null) {
    if (!OUTPUT_FORMATS.includes(body.output_format)) {
      return { error: `输出格式只能是 ${OUTPUT_FORMATS.join(' / ')}。` }
    }
    outputFormat = body.output_format
  } else {
    // 界面没传就跟随配置默认值；技能自己的默认是 jpeg，与这里一致。
    outputFormat = cfg.defaultOutputFormat
  }

  return {
    opts: {
      prompt,
      model,
      size,
      referenceImages,
      outputFormat,
      watermark: body.watermark === false ? false : true,
      optimizePrompt: body.optimize_prompt === false ? false : true,
    },
    warnings,
  }
}

/* ------------------------------------------------------------------ */
/* 插件主体                                                            */
/* ------------------------------------------------------------------ */

export default {
  name: 'seedream-studio',

  /**
   * 刻意**不用**对象级 `inject`：那会推迟整个 apply，而桌面端的注入表只在宿主
   * 启动时收集一次，晚到的注册不会进表（dsh-whale-widget 踩过这个坑，留了长注释）。
   * 所以这里立刻注册，服务依赖用 `root.inject(...)` 分段拿。
   *
   * `config` 只能走第二个参数拿：cordis 的 `ctx.config` 是带 inject 门禁的访问器，
   * 直接 `root.config` 会抛 `cannot get property "config" without inject`。
   */
  apply(root, config) {
    const cfg = normalizeConfig(config)
    /*
     * 预创建保存目录：否则首次生成之前，界面底部的"打开目录"会失败
     * （目录不存在）。建不出来不致命 —— 生成时技能还会自己 mkdir。
     */
    try {
      mkdirSync(effectiveSavePath(cfg), { recursive: true })
    } catch {
      /* 权限等问题留给生成阶段报更具体的错 */
    }
    for (const warning of cfg.warnings) {
      try {
        console.warn(`[seedream-studio] 配置提示：${warning}`)
      } catch {
        /* ignore */
      }
    }

    /** 内存里的生成记录，最新在前。不写会话日志、不落盘。 */
    /*
     * 历史持久化。
     *
     * 存在 `$DSH_HOME/seedream-images/.history.json`：和图片同目录，但因为
     * 是点文件，用户看到的目录里仍然"只有图片"（Finder 默认不显示点文件）。
     * 之前历史只在内存里，重启就空 —— 用户抱怨的正是这个。
     */
    const historyFile = () => path.join(effectiveSavePath(cfg), '.history.json')
    const history = []

    const loadHistory = () => {
      let text
      try {
        text = readFileSync(historyFile(), 'utf8')
      } catch {
        return
      }
      try {
        const parsed = JSON.parse(text)
        if (!Array.isArray(parsed)) return
        for (const item of parsed) {
          // 只接受形状正确的条目，脏数据直接丢弃而不是带着崩
          if (!item || typeof item !== 'object') continue
          if (!Array.isArray(item.images)) continue
          if (typeof item.id !== 'string') continue
          history.push(item)
        }
      } catch {
        /* 文件坏了就当没有，下一次写入会覆盖 */
      }
    }

    const saveHistory = () => {
      try {
        const dir = effectiveSavePath(cfg)
        mkdirSync(dir, { recursive: true })
        writeFileSync(historyFile(), JSON.stringify(history, null, 2), 'utf8')
      } catch (error) {
        // 写不进去不该影响生成，只记一笔
        try {
          console.warn(`[seedream-studio] 历史保存失败：${errorText(error)}`)
        } catch {
          /* ignore */
        }
      }
    }

    /**
     * 把历史里的产物登记进预览/删除白名单。
     *
     * `servedFiles` 是内存集合，插件重载/宿主重启后会空掉；历史却指向
     * 真实存在的文件。不登记的话，界面能列出这些图但预览和删除都会
     * 被拒 —— 也就是用户遇到的"删不掉"。
     */
    const adoptHistoryFiles = () => {
      for (const entry of history) {
        for (const image of entry.images || []) {
          if (image.localPath) servedFiles.add(path.resolve(image.localPath))
        }
      }
    }

    // 启动即恢复历史。接管文件要等 servedFiles 声明之后（见下方）。
    loadHistory()
    /** jobId -> job，供界面轮询进度与取消。 */
    const jobs = new Map()
    /** 允许预览的绝对路径白名单：只有本插件自己产出过的文件才可读。 */
    const servedFiles = new Set()
    // 历史里的文件也要能被预览/删除：白名单是内存态，重启后必须重新接管。
    adoptHistoryFiles()
    /** 上传的参考图：uploadId → { path, name, bytes, mime }。 */
    const uploads = new Map()
    /** 参考图暂存目录：放在 profile 目录下的临时区，不污染用户目录。 */
    const uploadDir = () => path.join(cfg.dshHome, 'tmp', 'seedream-studio-reference')
    /** 同一时刻只允许一个生成任务，避免双击按钮扣两次费。 */
    let activeJobId = null

    const remember = (entry) => {
      history.unshift(entry)
      while (history.length > cfg.historyLimit) history.pop()
      saveHistory()
    }

    /**
     * 把某个绝对路径从宿主的 history 里彻底摘掉。
     *
     * 界面切走再切回来会重新拉 /history，所以删除**必须**落到宿主这份数据上，
     * 否则已删的图会复活，而且那时 servedFiles 已无该路径 → 永远删不掉。
     * 一条记录里的图删光了就连整条记录一起移除（失败记录留着，它没有图）。
     */
    const forgetFromHistory = (resolvedPath) => {
      for (let i = history.length - 1; i >= 0; i--) {
        const entry = history[i]
        if (!Array.isArray(entry.images)) continue
        const kept = entry.images.filter((img) => path.resolve(img.localPath || '') !== resolvedPath)
        entry.images = kept
        if (kept.length === 0 && entry.success) history.splice(i, 1)
      }
      saveHistory()
    }

    const rememberFiles = (images) => {
      for (const image of images) {
        // 存进白名单的必须是"和查询时同样的"绝对路径：查询侧用 path.resolve，
        // 这里若存原样字符串，带 `..` 或末尾空格的路径会永远匹配不上。
        if (image.localPath) servedFiles.add(path.resolve(image.localPath))
      }
      while (servedFiles.size > 500) {
        const first = servedFiles.values().next()
        if (first.done) break
        servedFiles.delete(first.value)
      }
    }

    /**
     * 键状态。
     *
     * 查的是 **DSH 凭据库**（`.credentials.yaml`），永远不返回明文，
     * 只给"配没配"和打码指纹，界面据此显示状态点与"已存的是哪一把"。
     *
     * @param ctx 插件上下文
     * @returns {Promise<{configured:boolean, source:string|null, masked:string|null, writable:boolean}>}
     */
    const credentialStatus = async (ctx) => {
      let store = null
      let writable = false
      try {
        const candidate = ctx.get('credentials')
        if (candidate && typeof candidate.describe === 'function') {
          store = candidate
          writable = typeof candidate.set === 'function'
        }
      } catch {
        store = null
      }
      if (store) {
        // 只看自己那一条，别把别的工具配的 Key 当成"本插件已配置"。
        try {
          const info = await store.describe(KEY_REF_NAME)
          if (info && info.configured) {
            // 能用 resolve 就顺手算个指纹，让用户看清"存的是哪一把"。
            let masked = typeof info.masked === 'string' ? info.masked : null
            if (!masked) {
              try {
                masked = maskKey(unwrapCredential(await store.resolve(KEY_REF_NAME)))
              } catch {
                /* 算不出指纹不影响"已配置"这个结论 */
              }
            }
            return {
              configured: true,
              source: `.credentials.yaml → ${KEY_REF_NAME}`,
              masked,
              writable: writable && info.writable === true,
            }
          }
        } catch {
          /* describe 失败当作未配置 */
        }
      }
      return { configured: false, source: null, masked: null, writable }
    }

    const stateSnapshot = async (ctx) => {
      const key = await credentialStatus(ctx)
      return {
        ok: true,
        // 生成能力已内置，不再依赖外部 skill；这个字段保留给界面的旧版提示逻辑。
        skill: { skillInstalled: true, generateReady: true, skillVersion: ENGINE_VERSION, builtin: true },
        key,
        savePath: effectiveSavePath(cfg),
        savePathIsCustom: Boolean(cfg.savePath),
        defaults: { model: cfg.defaultModel, size: cfg.defaultSize, outputFormat: cfg.defaultOutputFormat },
        models: MODEL_ALIASES,
        sizes: SIZE_PRESETS,
        outputFormats: OUTPUT_FORMATS,
        maxReferenceImages: MAX_REFERENCE_IMAGES,
        historyLimit: cfg.historyLimit,
      }
    }

    /* ---------------- 路由 ---------------- */

    const fence = (ctx, req) => {
      const headers = req.headers || {}
      const site = String(headers['sec-fetch-site'] || '').toLowerCase()
      if (site === 'cross-site') return 403
      let connection = null
      try {
        const candidate = ctx.get('connection')
        if (candidate && typeof candidate.requestRejection === 'function') connection = candidate
      } catch {
        connection = null
      }
      if (connection) {
        try {
          const code = connection.requestRejection(req)
          if (code === undefined || code === null || code === false) return null
          return typeof code === 'number' ? code : 403
        } catch {
          return 403
        }
      }
      // 没有宿主栅栏时只允许回环：这些接口能触发付费生图与打开本地文件。
      try {
        const hostUrl = new URL(`http://${String(headers.host || '')}`)
        return isLoopbackHostname(hostUrl.hostname) ? null : 403
      } catch {
        return 403
      }
    }

    /**
     * 输出一张图。
     *
     * `download` 为真时带上 `Content-Disposition: attachment`，浏览器会
     * 直接另存而不是内联显示 —— 下载按钮就靠这个，不需要前端读 blob。
     * 文件名用 `filename*` 的 RFC 5987 形式，中文名也不会乱码。
     */
    const serveImage = async (res, filePath, download = false) => {
      const resolved = path.resolve(filePath)
      if (!servedFiles.has(resolved)) {
        sendJson(res, 404, { error: '该文件不在可预览范围内' })
        return
      }
      const ext = path.extname(resolved).toLowerCase()
      const type = IMAGE_EXTENSIONS.get(ext)
      if (!type) {
        sendJson(res, 415, { error: '不是可预览的图片格式' })
        return
      }
      let buffer
      try {
        const info = statSync(resolved)
        if (!info.isFile()) throw new Error('not a file')
        if (info.size > MAX_IMAGE_BYTES) throw new Error('too large')
        buffer = await readFile(resolved)
      } catch (error) {
        sendJson(res, 404, { error: `读取图片失败：${errorText(error)}` })
        return
      }
      const headers = {
        'content-type': type,
        'content-length': buffer.length,
        'cache-control': 'no-cache',
        // 这些字节来自模型返回的远端内容：禁止浏览器嗅探成别的类型。
        'x-content-type-options': 'nosniff',
      }
      if (download) {
        const name = path.basename(resolved)
        // ASCII 兜底 + UTF-8 形式，兼顾老浏览器和非 ASCII 文件名。
        const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
        headers['content-disposition'] =
          `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
      }
      res.writeHead(200, headers)
      res.end(buffer)
    }

    /**
     * 把文件移到废纸篓。
     *
     * macOS 走 `osascript` 让 Finder 执行 delete，进废纸篓后可恢复 ——
     * 这是最容易"手滑"的操作，不该是不可逆的。其它平台没有统一的可恢复
     * 删除接口，只能退化成永久删除，并在返回值里如实说明。
     * 路径通过 argv 传递，不拼进脚本字符串，避免引号/特殊字符问题。
     */
    const trashFile = async (ctx, target) => {
      const platform = process.platform
      /*
       * macOS：不调 `osascript`/Finder。
       *
       * 它需要"自动化"权限，没授权时 macOS 会弹窗并把进程挂住 ——
       * 用户点了删除，界面上只会一直转圈，比删失败更糟。
       * 改成直接移动到 `~/.Trash`：这是纯粹的文件操作，不需要任何授权，
       * 照样可以恢复，而且语义上和 Finder 删除一致。
       * 目标名重名时补一个数字后缀，不覆盖废纸篓里已有的文件。
       */
      if (platform === 'darwin') {
        const trashDir = path.join(homedir(), '.Trash')
        const base = path.basename(target)
        try {
          let candidate = path.join(trashDir, base)
          if (existsSync(candidate)) {
            const ext = path.extname(base)
            const stem = base.slice(0, base.length - ext.length)
            candidate = path.join(trashDir, `${stem} ${Date.now()}${ext}`)
          }
          renameSync(target, candidate)
          return { ok: true, trashed: true }
        } catch (error) {
          /*
           * EXDEV：保存目录在另一个卷上（比如改到了外置盘），rename 跨卷
           * 会失败。这时退化成"复制进废纸篓 + 删原件"，效果一样且仍可恢复。
           */
          if (error && error.code === 'EXDEV') {
            try {
              const candidate = path.join(trashDir, `${path.basename(base, path.extname(base))} ${Date.now()}${path.extname(base)}`)
              copyFileSync(target, candidate)
              rmSync(target, { force: true })
              return { ok: true, trashed: true }
            } catch (copyError) {
              return { ok: false, error: `移入废纸篓失败：${errorText(copyError)}`, trashed: true }
            }
          }
          return { ok: false, error: `移入废纸篓失败：${errorText(error)}`, trashed: true }
        }
      }
      // 其它平台没有统一的可恢复删除接口：退化为永久删除，并如实说明。
      let argv
      if (platform === 'win32') argv = ['cmd.exe', '/c', 'del', '/f', '/q', target]
      else argv = ['rm', '-f', target]
      let handle
      try {
        handle = ctx.subprocess.spawn({
          argv,
          cwd: path.dirname(target),
          stdio: { stdin: 'ignore', stdout: 'ignore', stderr: { maxBytes: 8192 } },
          graceMs: 5000,
        })
      } catch (error) {
        return { ok: false, error: errorText(error), trashed: false }
      }
      try {
        const outcome = await handle.done
        if (outcome.exitCode === 0) return { ok: true, trashed: false }
        const err = readCollected(handle.collected?.stderr).trim()
        return { ok: false, error: err || `命令退出码 ${outcome.exitCode}`, trashed: false }
      } catch (error) {
        return { ok: false, error: errorText(error), trashed: false }
      }
    }

    /**
     * 在文件管理器里定位文件，或用默认程序打开。
     *
     * 只认两类路径：本插件产出过的图片（`servedFiles`），以及配置的保存目录本身
     * （界面底部的"打开目录"要能点）。目录不是文件、不在 `servedFiles` 里，
     * 所以必须单独放行；除此之外一律拒绝，避免这个接口被当成"打开任意路径"。
     */
    const revealPath = (ctx, filePath, mode) => new Promise((resolve) => {
      const resolved = path.resolve(filePath)
      // 必须和 /state 报给界面的那个目录一致：未配置时是 skill 的默认目录，
      // 只看 cfg.savePath 会让"打开目录"在默认配置下永远失败。
      const allowedDir = path.resolve(effectiveSavePath(cfg))
      if (!servedFiles.has(resolved) && resolved !== allowedDir) {
        resolve({ ok: false, error: '该文件不在可操作范围内' })
        return
      }
      const platform = process.platform
      let argv
      if (platform === 'darwin') {
        argv = mode === 'open' ? ['/usr/bin/open', resolved] : ['/usr/bin/open', '-R', resolved]
      } else if (platform === 'win32') {
        argv = mode === 'open' ? ['explorer.exe', resolved] : ['explorer.exe', `/select,${resolved}`]
      } else {
        argv = ['xdg-open', mode === 'open' ? resolved : path.dirname(resolved)]
      }
      let handle
      try {
        handle = ctx.subprocess.spawn({
          argv,
          cwd: path.dirname(resolved),
          stdio: { stdin: 'ignore', stdout: 'ignore', stderr: { maxBytes: 8192 } },
          graceMs: 2000,
        })
      } catch (error) {
        resolve({ ok: false, error: errorText(error) })
        return
      }
      handle.done
        .then((outcome) => {
          if (outcome.exitCode === 0) {
            resolve({ ok: true })
            return
          }
          const err = readCollected(handle.collected?.stderr).trim()
          resolve({ ok: false, error: err || `命令退出码 ${outcome.exitCode}` })
        })
        .catch((error) => resolve({ ok: false, error: errorText(error) }))
    })

    /** 单个 job 的可观测状态。 */
    const jobStatus = (job) => {
      const payload = {
        jobId: job.id,
        status: job.status,
        startedAt: job.startedAt,
        elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
        log: job.log.slice(-4),
      }
      if (job.status === 'done' || job.status === 'failed') payload.result = job.result
      if (job.error) payload.error = job.error
      return payload
    }

    const appendJobLog = (job) => {
      const reader = job.handle?.collected?.stderr
      if (!reader || typeof reader.readFrom !== 'function') return
      let read
      try {
        read = reader.readFrom(job.stderrOffset)
      } catch {
        return
      }
      job.stderrOffset = read.nextOffset
      if (!read.text) return
      for (const line of read.text.split(/[\r\n]+/)) {
        const trimmed = line.trim()
        if (!isProgressLine(trimmed)) continue
        job.log.push(trimmed)
      }
      while (job.log.length > LOG_KEEP) job.log.shift()
    }

    const startJob = (ctx, opts) => {
      const job = {
        id: randomUUID(),
        status: 'running',
        startedAt: Date.now(),
        finishedAt: 0,
        result: null,
        error: null,
        log: [],
        handle: null,
        stderrOffset: 0,
        controller: new AbortController(),
      }
      jobs.set(job.id, job)
      activeJobId = job.id
      pruneJobs(jobs)

      const entry = {
        id: job.id,
        at: new Date().toISOString(),
        prompt: opts.prompt,
        model: opts.model,
        size: opts.size,
        referenceImages: opts.referenceImages,
        success: false,
        images: [],
        saveDir: null,
        elapsedMs: 0,
        error: null,
      }

      runGeneration(ctx, cfg, opts, {
        signal: job.controller.signal,
        onSpawn: (handle) => {
          job.handle = handle
          // 生成开始后就可以读了：先吸一次，让界面第一次轮询就有内容。
          setTimeout(() => appendJobLog(job), 50)
        },
      })
        .then((result) => {
          job.result = result
          job.status = result.success ? 'done' : 'failed'
          job.finishedAt = Date.now()
          entry.success = result.success
          entry.images = result.images
          entry.saveDir = result.saveDir
          entry.elapsedMs = result.elapsedMs
          entry.error = result.error
          rememberFiles(result.images)
          /*
           * 只有**真的产出了图**才进「最近生成」。
           *
           * 失败记录没有图，混进列表里用户既不能删、也不能看，只会困惑
           * （截图里那条"生成失败"就是这么来的）。失败本身由结果区的
           * 错误框表达，那里信息更全。
           */
          if (result.success && result.images.length > 0) remember(entry)
        })
        .catch((error) => {
          job.status = 'failed'
          job.error = errorText(error)
          job.finishedAt = Date.now()
          // 同上：进程都没起来，没有产物，不进历史列表。
        })
        .finally(() => {
          job.handle = null
          if (activeJobId === job.id) activeJobId = null
          /*
           * **不要**在这里删上传的参考图。
           *
           * 参考图会跨多次生成复用：用户挑好一张图，往往要连着改几次提示词。
           * 之前在这里顺手删掉，导致第二次生成时文件已不存在，技能报
           * 「reference_images 必须是非空的图片 URL / Base64 数组」。
           * 清理只应发生在两个明确时机：用户点 × 移除该图，或插件卸载。
           */
        })

      return job
    }

    const pruneJobs = (store) => {
      const cutoff = Date.now() - 15 * 60 * 1000
      for (const [id, job] of store) {
        if (job.status !== 'running' && job.finishedAt && job.finishedAt < cutoff) store.delete(id)
      }
    }

    const handleRequest = async (ctx, req, res, pathname) => {
      const rejected = fence(ctx, req)
      if (rejected !== null) {
        sendJson(res, rejected, { error: '该请求不被信任' })
        return
      }
      const route = pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/'
      const method = String(req.method || 'GET').toUpperCase()

      if (route === '/state' && method === 'GET') {
        sendJson(res, 200, await stateSnapshot(ctx))
        return
      }

      if (route === '/history' && method === 'GET') {
        /*
         * 顺手把历史里的产物重新登记进预览/删除白名单。
         *
         * servedFiles 是内存集合，插件重载或宿主重启后会空掉；而历史记录
         * 仍指向那些真实存在的文件。不重新登记的话，界面能列出这些图，
         * 却既预览不了、也删不掉（都返回"不在可…范围内"）。
         */
        adoptHistoryFiles()
        sendJson(res, 200, { ok: true, entries: history })
        return
      }

      if (route === '/generate' && method === 'POST') {
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, { error: errorText(error) })
          return
        }
        if (activeJobId) {
          const running = jobs.get(activeJobId)
          sendJson(res, 409, {
            error: '已有一次生成正在进行，请等它结束或先取消。',
            jobId: running ? running.id : null,
          })
          return
        }
        const normalized = normalizeGenerateInput(cfg, body)
        if (normalized.error) {
          sendJson(res, 400, { error: normalized.error })
          return
        }
        const job = startJob(ctx, normalized.opts)
        sendJson(res, 202, { ok: true, jobId: job.id, warnings: normalized.warnings })
        return
      }

      if (route === '/job' && method === 'GET') {
        const url = new URL(req.url || '/', 'http://localhost')
        const id = url.searchParams.get('jobId') || ''
        const job = jobs.get(id)
        if (!job) {
          sendJson(res, 404, { error: '找不到该生成任务' })
          return
        }
        appendJobLog(job)
        sendJson(res, 200, { ok: true, ...jobStatus(job) })
        return
      }

      if (route === '/cancel' && method === 'POST') {
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, { error: errorText(error) })
          return
        }
        const job = jobs.get(String(body.jobId || ''))
        if (!job) {
          sendJson(res, 404, { error: '找不到该生成任务' })
          return
        }
        if (job.status !== 'running') {
          sendJson(res, 200, { ok: true, already: true, ...jobStatus(job) })
          return
        }
        try {
          job.controller.abort()
        } catch {
          /* ignore */
        }
        if (job.handle) {
          try {
            job.handle.terminate()
          } catch {
            /* ignore */
          }
        }
        sendJson(res, 200, { ok: true, cancelled: true, jobId: job.id })
        return
      }

      /*
       * 删除产物：移到废纸篓，不做不可逆删除。
       *
       * macOS 用 `osascript` 的 Finder delete（进废纸篓、可恢复）；
       * 其它平台没有跨平台的"可恢复删除"标准接口，退化成永久删除，
       * 所以只在用户显式确认后走这里，并在响应里说清到底做了什么。
       * 只认白名单里的路径，避免变成"任意文件删除器"。
       */
      if (route === '/delete' && method === 'POST') {
        let body
        try {
          body = await readJsonBody(req, 2 * 1024 * 1024)
        } catch (error) {
          sendJson(res, 400, { error: errorText(error) })
          return
        }
        const list = Array.isArray(body.paths) ? body.paths : (typeof body.path === 'string' ? [body.path] : [])
        if (list.length === 0) {
          sendJson(res, 400, { error: '缺少要删除的文件' })
          return
        }
        const results = []
        for (const item of list) {
          if (typeof item !== 'string' || !item) continue
          const resolved = path.resolve(item)
          if (!servedFiles.has(resolved)) {
            results.push({ path: item, ok: false, error: '该文件不在可删除范围内' })
            continue
          }
          let info
          try {
            info = statSync(resolved)
            if (!info.isFile()) throw new Error('不是一个文件')
          } catch (error) {
            // 文件已经不在（之前删过 / 用户手动删了）：当成成功，并且
            // **同样要把 history 里的残留摘掉**，否则它会一直留在列表里、
            // 而且因为不在 servedFiles 里而永远删不掉。
            servedFiles.delete(resolved)
            forgetFromHistory(resolved)
            results.push({ path: item, ok: true, missing: true })
            continue
          }
          const outcome = await trashFile(ctx, resolved)
          if (outcome.ok) {
            servedFiles.delete(resolved)
            for (const [id, record] of uploads) {
              if (record.path === resolved) uploads.delete(id)
            }
            /*
             * 关键：把这张图从宿主的 history 里摘掉。
             *
             * 界面切走再切回来会重新拉 /history；如果这里不清，
             * 已删的图会重新出现在"最近生成"里，而此时 servedFiles 已无该路径，
             * 再点删除就只会得到"不在可删除范围内"。
             * 一条记录里的图删光了，整条记录也去掉（保留失败记录）。
             */
            forgetFromHistory(resolved)
          }
          results.push({ path: item, ok: outcome.ok, error: outcome.error, trashed: outcome.trashed })
        }
        const failed = results.filter((r) => !r.ok)
        sendJson(res, failed.length === 0 ? 200 : 207, {
          ok: failed.length === 0,
          deleted: results.filter((r) => r.ok).length,
          results,
        })
        return
      }

      if (route === '/image' && method === 'GET') {
        const url = new URL(req.url || '/', 'http://localhost')
        const filePath = url.searchParams.get('p') || ''
        if (!filePath) {
          sendJson(res, 400, { error: '缺少 p 参数' })
          return
        }
        const wantDownload = url.searchParams.get('download') === '1'
        await serveImage(res, filePath, wantDownload)
        return
      }

      /*
       * 参考图上传。
       *
       * 浏览器只能给出 base64（拖拽 / 粘贴 / 文件框都一样），而技能要的是
       * 本地路径或 URL。所以这里把字节落到插件自己的临时目录，再把路径交给
       * 生成流程 —— 用户看到的是"上传了一张图"，底层仍然是技能一贯的入参形态。
       * `uploadId` 回传给界面，用于后续删除。
       */
      if (route === '/upload' && method === 'POST') {
        let body
        try {
          body = await readJsonBody(req, 40 * 1024 * 1024)
        } catch (error) {
          sendJson(res, 400, { error: errorText(error) })
          return
        }
        const name = typeof body.name === 'string' ? body.name : ''
        const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : ''
        const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl)
        if (!match) {
          sendJson(res, 400, { error: '只接受图片文件。' })
          return
        }
        const mime = match[1].toLowerCase()
        const ext = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' })[mime]
        if (!ext) {
          sendJson(res, 400, { error: `不支持的图片格式：${mime}。请用 PNG / JPEG / WebP / GIF。` })
          return
        }
        let buffer
        try {
          buffer = Buffer.from(match[2], 'base64')
        } catch {
          sendJson(res, 400, { error: '图片数据解析失败。' })
          return
        }
        if (buffer.length === 0) {
          sendJson(res, 400, { error: '图片是空的。' })
          return
        }
        if (buffer.length > MAX_UPLOAD_BYTES) {
          sendJson(res, 413, { error: `单张图片不能超过 ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB。` })
          return
        }
        const uploadId = randomUUID()
        const dir = uploadDir()
        try {
          mkdirSync(dir, { recursive: true })
          writeFileSync(path.join(dir, uploadId + ext), buffer)
        } catch (error) {
          sendJson(res, 500, { error: `保存参考图失败：${errorText(error)}` })
          return
        }
        const saved = path.join(dir, uploadId + ext)
        uploads.set(uploadId, { path: saved, name: name || uploadId + ext, bytes: buffer.length, mime })
        sendJson(res, 200, { ok: true, upload: { uploadId, path: saved, name: name || uploadId + ext, bytes: buffer.length } })
        return
      }

      /* 删除一张已上传的参考图。 */
      if (route === '/upload' && method === 'DELETE') {
        const url = new URL(req.url || '/', 'http://localhost')
        const uploadId = url.searchParams.get('uploadId') || ''
        const record = uploads.get(uploadId)
        if (!record) {
          sendJson(res, 404, { error: '找不到这张参考图' })
          return
        }
        uploads.delete(uploadId)
        try {
          await rm(record.path, { force: true })
        } catch {
          /* 删不掉也不影响流程 */
        }
        sendJson(res, 200, { ok: true })
        return
      }

      /*
       * 保存 / 清除 API Key。
       *
       * 写进 **DSH 凭据库**（`.credentials.yaml` 的 `ARK_AGENT_PLAN_API_KEY`）。
       * 开源项目里绝不能把 Key 放进插件目录：别人克隆后误提交就是重大事故。
       * 明文只在这一次请求里出现：不写日志、不回显、不进 /state。
       * 另外做一道 AgentPlan 前置校验 —— 本插件只接受 `ark-` 前缀的
       * Agent Plan Key，与其让它生成时失败，不如在这里就说清楚。
       */
      if (route === '/credential' && method === 'POST') {
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, { error: errorText(error) })
          return
        }
        let store = null
        try {
          const candidate = ctx.get('credentials')
          if (candidate && typeof candidate.set === 'function') store = candidate
        } catch {
          store = null
        }
        if (!store) {
          sendJson(res, 501, {
            error: '当前环境没有可用的凭证服务，无法在界面里保存 Key。请在 ~/.dsh/.credentials.yaml 的 refs 下配置 ARK_AGENT_PLAN_API_KEY。',
          })
          return
        }
        const action = String(body.action || 'save')
        if (action === 'clear') {
          /*
           * 只删自己写的那一条。
           *
           * `unset` 的语义是"从可写来源移除一个引用"。同名的 `ARKCLI_*`、
           * `ARK_AGENT_PLAN_CN_API_KEY` 属于别的工具，删它们等于替用户做决定，
           * 会让那边的工具莫名失效——所以绝不碰。
           *
           * 清完回读一次确认：只要自己这条还在（比如来源只读、unset 静默失败），
           * 就如实报错，而不是假装成功。
           */
          try {
            await store.unset(KEY_REF_NAME)
          } catch (error) {
            sendJson(res, 500, { error: `清除 Key 失败：${errorText(error)}` })
            return
          }
          const status = await credentialStatus(ctx)
          if (status.configured && status.source === `.credentials.yaml → ${KEY_REF_NAME}`) {
            sendJson(res, 500, {
              error: `清除未完成：${KEY_REF_NAME} 仍在凭据库里。请在 ~/.dsh/.credentials.yaml 的 refs 下手动删除这一项。`,
              key: status,
            })
            return
          }
          sendJson(res, 200, { ok: true, key: status })
          return
        }
        const value = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
        if (!value) {
          sendJson(res, 400, { error: '请填写 API Key。' })
          return
        }
        if (!KEY_PATTERN.test(value)) {
          sendJson(res, 400, {
            error: '这个 Key 不是 Agent Plan 格式（应以 ark- 开头）。当前版本仅支持 Agent Plan，请到火山方舟控制台的 Agent Plan 页面获取 Key。',
          })
          return
        }
        try {
          await store.set(KEY_REF_NAME, value)
        } catch (error) {
          sendJson(res, 500, { error: `保存 Key 失败：${errorText(error)}` })
          return
        }
        sendJson(res, 200, { ok: true, key: await credentialStatus(ctx) })
        return
      }

      if ((route === '/reveal' || route === '/open') && method === 'POST') {
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, { error: errorText(error) })
          return
        }
        const filePath = typeof body.path === 'string' ? body.path : ''
        if (!filePath) {
          sendJson(res, 400, { error: '缺少 path' })
          return
        }
        const outcome = await revealPath(ctx, filePath, route === '/open' ? 'open' : 'reveal')
        sendJson(res, outcome.ok ? 200 : 500, outcome)
        return
      }

      sendJson(res, 404, { error: `未知接口 ${pathname}` })
    }

    /* ---------------- 注册：路由 ---------------- */

    root.inject(['webServer', 'subprocess'], (ctx) => {
      /*
       * 参考图会跨多次生成复用，所以不能在生成结束后删。
       * 唯一安全的清理时机是插件卸载：此时它们一定不再被需要。
       */
      ctx.effect(() => () => {
        uploads.clear()
        rm(uploadDir(), { recursive: true, force: true }).catch(() => {})
      }, 'dsh-seedream-studio: 卸载时清理参考图暂存目录')

      const dispose = ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          handleRequest(ctx, req, res, new URL(req.url || '/', 'http://localhost').pathname)
            .catch((error) => {
              try {
                sendJson(res, 500, { error: errorText(error) })
              } catch {
                /* 响应已发出 */
              }
            })
        },
      })
      ctx.effect(() => dispose, 'dsh-seedream-studio: HTTP 路由')
    })

    /* ---------------- 注册：agent 工具 ---------------- */

    root.inject(['tools', 'subprocess'], (ctx) => {
      /**
       * 手写 JSON Schema。注意：`ctx.tools.register()` 只校验 `output.schema`，
       * 不会跑 `defineTool` 的归一化，所以这里**不能**用作者 DSL 的
       * `{ required: true }` 内联写法（那是 defineTool 专有的），必须写标准
       * JSON Schema，对象级 `required: [...]`。
       */
      const definition = {
        name: 'seedream_generate',
        description:
          '用豆包 Seedream（火山方舟 AgentPlan）生成或编辑图片，结果保存到本地并返回绝对路径。'
          + '支持 Flash / Pro 两个模型、1K/1.5K/2K 尺寸、参考图编辑（最多 10 张）。'
          + '图形界面在同名侧边栏「Seedream 工作台」里，两者能力一致。不会自动重试（每次调用都会计费）。',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: '图片描述提示词，最长 3000 字符，必填。',
            },
            model: {
              type: 'string',
              enum: MODEL_ALIASES,
              description: 'auto 按能力约束自动选；flash 便宜快速；pro 画质优先。默认 auto。',
            },
            size: {
              type: 'string',
              enum: SIZE_PRESETS,
              description: '输出尺寸档位，默认 2K。',
            },
            reference_images: {
              type: 'array',
              items: { type: 'string' },
              description:
                '参考图列表，最多 10 项。每项可以是本地绝对路径或 http(s) 图片地址。'
                + '给了参考图即进入图生图/编辑模式。',
            },
            output_format: {
              type: 'string',
              enum: OUTPUT_FORMATS,
              description: '输出文件格式，默认 jpeg。',
            },
            watermark: {
              type: 'boolean',
              description: '是否加水印，默认 true。要无水印请显式传 false。',
            },
            optimize_prompt: {
              type: 'boolean',
              description: '是否在本地为提示词追加画质与光影描述（不调用模型、不额外计费），默认 true。要保留原始提示词请传 false。',
            },
          },
          required: ['prompt'],
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              success: { type: 'boolean', description: '是否成功。' },
              summary: { type: 'string', description: '一行结果摘要。' },
              error: { type: 'string', description: '失败原因，成功时省略。' },
              model: { type: 'string', description: '实际使用的模型 ID。' },
              size: { type: 'string', description: '实际尺寸档位。' },
              outputFormat: { type: 'string', description: '实际输出格式。' },
              elapsedMs: { type: 'number', description: '总耗时（毫秒）。' },
              saveDir: { type: 'string', description: '图片保存目录。' },
              images: {
                type: 'array',
                description: '生成结果，每张一条。',
                items: {
                  type: 'object',
                  properties: {
                    localPath: { type: 'string', description: '本地绝对路径。下载失败时省略。' },
                    url: { type: 'string', description: '远端原始地址。' },
                    fileName: { type: 'string', description: '文件名。' },
                    downloadOk: { type: 'boolean', description: '是否已成功落盘。' },
                    downloadError: { type: 'string', description: '下载失败原因。' },
                  },
                  required: ['downloadOk'],
                  additionalProperties: false,
                },
              },
            },
            required: ['success', 'summary', 'images'],
            additionalProperties: false,
          },
          render: (_args, value) => {
            const lines = [value.summary || (value.success ? '生成完成' : '生成失败')]
            // summary 本身可能已经是错误文案（例如取消），别重复贴一遍。
            if (value.error && !lines[0].includes(value.error)) lines.push(`错误：${value.error}`)
            for (const image of value.images || []) {
              const mark = image.downloadOk ? '✅' : '⚠️'
              lines.push(`${mark} ${image.localPath || image.url || image.fileName || '(无路径)'}`)
              if (image.downloadError) lines.push(`   下载失败：${image.downloadError}`)
            }
            if (value.saveDir) lines.push(`保存目录：${value.saveDir}`)
            // 只有真正"失败了、什么都没拿到"时才提示去界面重试；取消是用户自己停的。
            if (value.success === false && value.images.length === 0 && !value.summary.startsWith('已取消')) {
              lines.push('提示：图形界面里同一功能在侧边栏「Seedream 工作台」。')
            }
            return [{ type: 'text', text: lines.join('\n') }]
          },
        },
        timeoutMs: GENERATION_TIMEOUT_MS + 30_000,
        execute: async (args, exec) => {
          if (exec && exec.signal) exec.signal.throwIfAborted()
          const normalized = normalizeGenerateInput(cfg, args)
          if (normalized.error) {
            return {
              success: false,
              summary: '',
              error: normalized.error,
              images: [],
            }
          }
          const result = await runGeneration(ctx, cfg, normalized.opts, { signal: exec?.signal })
          rememberFiles(result.images)
          remember({
            id: randomUUID(),
            at: new Date().toISOString(),
            prompt: normalized.opts.prompt,
            model: result.model || normalized.opts.model,
            size: result.size || normalized.opts.size,
            referenceImages: normalized.opts.referenceImages,
            success: result.success,
            images: result.images,
            saveDir: result.saveDir,
            elapsedMs: result.elapsedMs,
            error: result.error,
          })
          // 返回值必须能通过上面声明的 output.schema：缺值的字段直接省略，不写 null。
          const value = {
            success: result.success === true,
            summary: result.summary || (result.success ? '生成完成' : '生成失败'),
            images: result.images.map((image) => {
              const item = { downloadOk: image.downloadOk === true }
              if (image.localPath) item.localPath = image.localPath
              if (image.url) item.url = image.url
              if (image.fileName) item.fileName = image.fileName
              if (image.downloadError) item.downloadError = image.downloadError
              return item
            }),
          }
          if (result.error) value.error = result.error
          if (result.model) value.model = result.model
          if (result.size) value.size = result.size
          if (result.outputFormat) value.outputFormat = result.outputFormat
          if (Number.isFinite(result.elapsedMs)) value.elapsedMs = result.elapsedMs
          if (result.saveDir) value.saveDir = result.saveDir
          return value
        },
      }

      const dispose = ctx.tools.register(definition)
      ctx.effect(() => dispose, 'dsh-seedream-studio: seedream_generate 工具')
    })
  },
}

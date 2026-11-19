/**
 * Seedream 生图接口的内置实现。
 *
 * 原先插件通过子进程调用外部 skill 生成图片；为了让包自包含、不依赖第三方
 * 代码，这里把必需的部分（模型定义、参数校验、请求构造、结果下载）内置进来。
 * 只保留插件实际用到的能力，丢掉了 CLI 参数解析、模型注册表远端同步、流式
 * 输出等与图形界面无关的部分。
 */

import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, promises as fsp, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'

import { ALLOWED_API_BASE, fetchMedia, validateApiBase } from './media-security.js'

/** 可用模型：别名 → 模型 ID 与能力约束。 */
const MODELS = {
  flash: {
    id: 'doubao-seedream-5-0-flash',
    displayName: 'Seedream 5.0 Flash',
    capabilities: ['text_to_image', 'image_to_image', 'transparent_background'],
    maxReferenceImages: 10,
    sizePresets: ['1K', '1.5K', '2K'],
    defaultSize: '2K',
    defaultOutputFormat: 'jpeg',
    defaultWatermark: true,
    customSize: { minPixels: 921600, maxPixels: 4624220, minAspectRatio: 0.0625, maxAspectRatio: 16 },
    priority: 1,
  },
  pro: {
    id: 'doubao-seedream-5.0-pro',
    displayName: 'Seedream 5.0 Pro',
    capabilities: [
      'text_to_image', 'image_to_image',
      'transparent_background', 'prompt_optimization_fast',
    ],
    maxReferenceImages: 10,
    sizePresets: ['1K', '1.5K', '2K'],
    defaultSize: '2K',
    defaultOutputFormat: 'jpeg',
    defaultWatermark: true,
    customSize: { minPixels: 921600, maxPixels: 4624220, minAspectRatio: 0.0625, maxAspectRatio: 16 },
    priority: 2,
  },
}

/** 自动选模型时的候选顺序（按 priority 升序）。 */
const MODEL_ALIASES = ['auto', 'flash', 'pro']

/** 已下线的模型别名，命中时给出明确提示而不是静默替换。 */
const RETIRED_PATTERN = /^(lite|doubao-seedream-5[.-]0-lite(?:-.*)?|doubao-seedream-5-0-260128)$/

/** 参考图本地文件支持的扩展名 → MIME。 */
const LOCAL_IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
}

/** 单张参考图上限 30 MB（接口侧限制）。 */
const MAX_REFERENCE_BYTES = 30 * 1024 * 1024

/** 下载体积上限 1 GiB。 */
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024

/** 接口请求超时。 */
const API_TIMEOUT_MS = 120_000

/** 图片下载超时。 */
const DOWNLOAD_TIMEOUT_MS = 90_000

/**
 * 解析布尔值，接受真正的布尔或 'true'/'false' 字符串。
 * @param {unknown} value 输入值
 * @param {string} name 参数名（用于报错）
 * @returns {boolean} 布尔结果
 */
function toBoolean(value, name) {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  throw new Error(`${name} 必须是 true 或 false`)
}

/**
 * 按模型别名或模型 ID 查找模型定义。
 * @param {string} name 别名或 ID
 * @returns {object|undefined} 模型定义
 */
function findModel(name) {
  const key = String(name || '').trim()
  if (!key) return undefined
  if (MODELS[key]) return MODELS[key]
  return Object.values(MODELS).find((model) => model.id.toLowerCase() === key.toLowerCase())
}

/**
 * 读取 PNG / JPEG 的像素尺寸，其它格式返回 null。
 * @param {Buffer} buffer 图片内容
 * @returns {{width:number,height:number}|null} 尺寸
 */
function readImageSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null

  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
  if (isPng) {
    const width = buffer.readUInt32BE(16)
    const height = buffer.readUInt32BE(20)
    return width > 0 && height > 0 ? { width, height } : null
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buffer[offset + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      const length = buffer.readUInt16BE(offset + 2)
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) {
        const height = buffer.readUInt16BE(offset + 5)
        const width = buffer.readUInt16BE(offset + 7)
        return width > 0 && height > 0 ? { width, height } : null
      }
      offset += 2 + length
    }
  }

  return null
}

/**
 * 把本地图片路径转成 data URI；URL 与 base64 原样返回。
 * 转换前校验扩展名、体积、像素与宽高比，避免把非法素材发到服务端。
 * @param {string} value 候选值
 * @returns {string} data URI 或原值
 */
function expandLocalImagePath(value) {
  if (typeof value !== 'string') return value
  const candidate = value.trim()
  if (!candidate) return value
  if (/^https?:\/\//i.test(candidate) || candidate.startsWith('data:image/')) return value

  let info
  try {
    info = statSync(candidate)
  } catch {
    return value
  }
  if (!info.isFile()) return value

  const ext = path.extname(candidate).toLowerCase()
  const mime = LOCAL_IMAGE_MIME[ext]
  if (!mime) {
    throw new Error(
      `本地参考图格式不支持：${path.basename(candidate)}（支持 ${Object.keys(LOCAL_IMAGE_MIME).join(' ')}）`,
    )
  }
  if (info.size > MAX_REFERENCE_BYTES) {
    throw new Error(
      `本地参考图超过 30 MB 上限：${path.basename(candidate)}（${(info.size / 1024 / 1024).toFixed(1)} MB）`,
    )
  }

  const buffer = readFileSync(candidate)
  const size = readImageSize(buffer)
  if (size) {
    const pixels = size.width * size.height
    const aspect = size.width / size.height
    if (size.width <= 14 || size.height <= 14) {
      throw new Error(`本地参考图尺寸过小：${path.basename(candidate)}（${size.width}x${size.height}，宽高均须大于 14）`)
    }
    if (pixels < 196 || pixels > 36_000_000) {
      throw new Error(`本地参考图总像素超出范围：${path.basename(candidate)}（${size.width}x${size.height}，要求 196–36000000）`)
    }
    if (aspect < 1 / 16 || aspect > 16) {
      throw new Error(`本地参考图宽高比超出范围：${path.basename(candidate)}（${size.width}x${size.height}，要求 1/16–16）`)
    }
  }

  return `data:${mime};base64,${buffer.toString('base64')}`
}

/**
 * 展开参考图数组中的本地路径。
 * @param {string[]} items 参考图列表
 * @returns {string[]} 展开后的列表
 */
function expandReferenceImages(items) {
  if (!Array.isArray(items)) return []
  return items.map((item) => expandLocalImagePath(item))
}

/**
 * 校验参考图列表：必须是 URL 或 base64 data URI。
 * @param {string[]} refs 参考图列表
 * @returns {string[]} 去空白后的列表
 */
function assertReferenceList(refs) {
  if (!Array.isArray(refs) || !refs.length) {
    throw new Error('参考图必须是非空的图片 URL / Base64 数组')
  }
  for (const ref of refs) {
    if (typeof ref !== 'string' || !/^(https?:\/\/\S+|data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+)$/i.test(ref.trim())) {
      throw new Error('参考图必须是非空的图片 URL / Base64 数组')
    }
  }
  return refs.map((ref) => ref.trim())
}

/**
 * 校验生成参数并解析出实际使用的模型。
 *
 * @param {object} input 原始参数
 * @returns {object} 规范化后的参数，含 `model`（模型 ID）与 `modelDef`
 */
function prepareParams(input) {
  const params = { ...input }
  const rawModel = String(params.model ?? 'auto').trim()

  if (RETIRED_PATTERN.test(rawModel.toLowerCase())) {
    throw new Error('Seedream 5.0 Lite 已下线，请改用 flash / pro；不会自动替换显式模型')
  }

  // 参考图：支持本地路径、URL、data URI 混排。
  const rawRefs = Array.isArray(params.referenceImages) ? params.referenceImages : []
  const refs = rawRefs.length ? assertReferenceList(expandReferenceImages(rawRefs.filter(Boolean))) : []

  const prompt = typeof params.prompt === 'string' ? params.prompt : ''

  if (!prompt.trim()) throw new Error('请填写提示词。')
  if (prompt.length > 3000) throw new Error('提示词不能超过 3000 字符。')

  const mode = refs.length ? 'image-to-image' : 'text-to-image'

  const background = params.transparentBackground === true ? 'transparent' : undefined
  if (background === 'transparent') {
    if (refs.length !== 1) throw new Error('透明背景需要 1 张带透明通道的参考图。')
    if (params.outputFormat === 'jpeg') throw new Error('透明背景不能输出 JPEG。')
    if (/^data:image\/jpe?g;/i.test(refs[0]) || /\.jpe?g(?:\?|$)/i.test(refs[0])) {
      throw new Error('透明背景的输入不能是 JPEG，需要实际带透明通道的图片。')
    }
  }

  // 选模型：显式指定就校验能力，auto 则按 priority 找第一个满足约束的。
  const explicit = rawModel && rawModel !== 'auto' ? findModel(rawModel) : undefined
  if (rawModel !== 'auto' && !explicit) {
    throw new Error(`未知模型 ${rawModel}；可选 auto / flash / pro。`)
  }

  const choose = (model) => {
    const missing = []
    const need = (flag, capability) => {
      if (flag && !model.capabilities.includes(capability)) missing.push(capability)
    }
    need(mode === 'text-to-image', 'text_to_image')
    need(mode === 'image-to-image', 'image_to_image')
    need(background !== undefined, 'transparent_background')
    need(params.optimizePromptMode === 'fast', 'prompt_optimization_fast')
    if (missing.length) throw new Error(`${model.displayName} 不支持 ${missing.join('、')}`)

    if (refs.length > model.maxReferenceImages) {
      throw new Error(`参考图数量超过 ${model.displayName} 上限 ${model.maxReferenceImages}。`)
    }

    const rawSize = String(params.size || model.defaultSize).trim()
    const size = rawSize.toUpperCase()
    const presets = model.sizePresets
    if (!presets.includes(size)) {
      const match = /^(\d+)[xX](\d+)$/.exec(size)
      if (!match) {
        throw new Error(`${model.displayName} 该模式尺寸支持 ${presets.join(' / ')}，普通生成另支持合规的「宽x高」。`)
      }
      const width = Number(match[1])
      const height = Number(match[2])
      const limit = model.customSize
      const pixels = width * height
      const aspect = width / height
      if (
        !Number.isSafeInteger(pixels) || width <= 0 || height <= 0 ||
        pixels < limit.minPixels || pixels > limit.maxPixels ||
        aspect < limit.minAspectRatio || aspect > limit.maxAspectRatio
      ) {
        throw new Error(`${model.displayName} 的自定义像素或宽高比超出模型限制。`)
      }
    }

    const outputFormat = params.outputFormat || (background === 'transparent' ? 'png' : model.defaultOutputFormat)
    if (!['png', 'jpeg'].includes(outputFormat)) throw new Error('输出格式只能是 png / jpeg。')

    return {
      ...params,
      mode,
      refs,
      prompt,
      model: model.id,
      modelDef: model,
      size,
      outputFormat,
      background,
      watermark: params.watermark === undefined ? model.defaultWatermark : Boolean(params.watermark),
      optimizePromptMode: params.optimizePromptMode,
    }
  }

  let chosen
  if (explicit) {
    chosen = choose(explicit)
  } else {
    const candidates = Object.values(MODELS).sort((a, b) => a.priority - b.priority)
    const errors = []
    for (const model of candidates) {
      try {
        chosen = choose(model)
        break
      } catch (error) {
        errors.push(error.message)
      }
    }
    if (!chosen) {
      // 各候选模型的失败原因往往完全相同（参数本身非法），此时只报一条，
      // 避免同一句话重复两遍；原因不同才逐条列出。
      const unique = [...new Set(errors)]
      throw new Error(unique.length === 1 ? unique[0] : `当前参数没有兼容的模型：${unique.join('；')}`)
    }
  }

  // 优化开关默认打开；透明背景时关闭，避免干扰这类强约束任务。
  chosen.optimize =
    params.optimize === undefined ? background !== 'transparent' : Boolean(params.optimize)

  return chosen
}

/**
 * 构造发往接口的请求体。
 * @param {object} params 已规范化的参数
 * @param {string} finalPrompt 最终要提交的提示词
 * @returns {object} 请求体
 */
function buildRequestBody(params, finalPrompt) {
  const body = {
    model: params.model,
    size: params.size,
    response_format: 'url',
    output_format: params.outputFormat,
    watermark: params.watermark !== false,
  }
  if (finalPrompt !== undefined && finalPrompt !== '') body.prompt = finalPrompt
  if (params.refs.length) body.image = params.refs.length === 1 ? params.refs[0] : params.refs
  if (params.background !== undefined) body.background = params.background
  if (params.optimizePromptMode) body.optimize_prompt_options = { mode: params.optimizePromptMode }
  return body
}

/**
 * 发起一次 JSON 请求。
 * @param {string} url 目标地址
 * @param {{method?:string, headers?:Record<string,string>}} options 请求选项
 * @param {object|null} data 请求体
 * @returns {Promise<{statusCode:number, headers:object, body:any}>} 响应
 */
function requestJson(url, options, data = null) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === 'https:' ? https : http
    const request = transport.request(url, options, (response) => {
      let raw = ''
      response.on('data', (chunk) => {
        raw += chunk
      })
      response.on('end', () => {
        // 不把 Authorization 头带进任何返回值，避免日志泄漏密钥。
        const headers = { ...response.headers }
        if (headers.authorization) headers.authorization = 'Bearer ***masked***'
        let body = raw
        try {
          body = raw ? JSON.parse(raw) : null
        } catch {
          /* 保留原始文本，便于定位非 JSON 错误页 */
        }
        resolve({ statusCode: response.statusCode, headers, body })
      })
    })
    request.setTimeout(API_TIMEOUT_MS, () => {
      request.destroy(new Error(`接口请求超时（${API_TIMEOUT_MS / 1000}s）`))
    })
    request.on('error', reject)
    if (data) request.write(JSON.stringify(data))
    request.end()
  })
}

/**
 * 下载图片到目标路径。先写临时文件再改名，失败不留半截文件。
 * @param {string} url 图片地址
 * @param {string} targetPath 目标路径
 * @returns {Promise<string>} 目标路径
 */
async function downloadImage(url, targetPath) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  const partial = `${targetPath}.part.${process.pid}.${randomUUID()}`
  let handle
  try {
    const response = await fetchMedia(url, { signal: controller.signal })
    if (!response.ok) {
      response.body.destroy()
      throw new Error(`下载失败：HTTP ${response.status}`)
    }
    const contentType = response.headers.get('content-type') || ''
    const typeOk =
      contentType.startsWith('video/') ||
      /^image\/(png|jpeg|webp|gif|tiff|bmp)(;|$)/.test(contentType) ||
      contentType.startsWith('application/octet-stream')
    if (!typeOk) {
      response.body.destroy()
      throw new Error(`无效资源类型：${contentType}`)
    }
    const declared = Number(response.headers.get('content-length'))
    if (declared > MAX_DOWNLOAD_BYTES) {
      response.body.destroy()
      throw new Error('下载文件超过 1 GiB 上限')
    }

    handle = await fsp.open(partial, 'wx', 0o600)
    let total = 0
    for await (const chunk of response.body) {
      total += chunk.length
      if (total > MAX_DOWNLOAD_BYTES) {
        response.body.destroy()
        throw new Error('下载文件超过 1 GiB 上限')
      }
      await handle.writeFile(chunk)
    }
    if (!total) throw new Error('下载文件大小为 0')
    await handle.close()
    handle = null
    await fsp.rename(partial, targetPath)
    return targetPath
  } finally {
    controller.abort()
    clearTimeout(timer)
    if (handle) await handle.close()
    await fsp.rm(partial, { force: true })
  }
}

/**
 * 生成图片：提交请求、把结果下载到本地。
 *
 * @param {object} options
 * @param {string} options.apiKey AgentPlan Key
 * @param {string} [options.apiBaseUrl] 接口基址（默认官方 AgentPlan）
 * @param {object} options.params 生成参数（见 prepareParams）
 * @param {string} options.finalPrompt 已处理好的提示词
 * @param {string} options.saveDir 保存目录
 * @param {string} [options.baseName] 文件名前缀（不含扩展名）
 * @param {(message:string)=>void} [options.onProgress] 进度回调
 * @returns {Promise<{images:Array<object>, generationTime:number, model:string, size:string}>} 结果
 */
async function generateImages({ apiKey, apiBaseUrl, params, finalPrompt, saveDir, baseName, onProgress }) {
  const report = typeof onProgress === 'function' ? onProgress : () => {}
  const base = apiBaseUrl ? validateApiBase(apiBaseUrl) : ALLOWED_API_BASE

  mkdirSync(saveDir, { recursive: true })

  const body = buildRequestBody(params, finalPrompt)
  const startedAt = Date.now()
  report('正在提交请求…')

  const response = await requestJson(
    `${base}/images/generations`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    },
    body,
  )

  if (response.statusCode !== 200) {
    const detail =
      (response.body && response.body.error && (response.body.error.message || response.body.error.code)) ||
      (typeof response.body === 'string' ? response.body.slice(0, 300) : '')
    throw Object.assign(new Error(`接口返回 HTTP ${response.statusCode}${detail ? `：${detail}` : ''}`), {
      httpStatus: response.statusCode,
      apiCode: response.body && response.body.error ? response.body.error.code : undefined,
    })
  }

  const list = Array.isArray(response.body?.data) ? response.body.data : []
  if (!list.length) throw new Error('接口没有返回图片数据')

  const stamp = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const timePart =
    `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}` +
    `_${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`
  const stem = baseName || `seedream_${timePart}`

  const images = []
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index] || {}
    const format = item.output_format || params.outputFormat
    const ext = format === 'png' ? 'png' : 'jpg'
    const fileName = `${stem}_${index + 1}.${ext}`
    const localPath = path.join(saveDir, fileName)
    report(`正在下载第 ${index + 1}/${list.length} 张…`)

    const entry = {
      url: item.url,
      file_name: fileName,
      output_format: format,
      index: index + 1,
      local_path: null,
      download_success: false,
    }
    // 只保留通用字段；拆图层专用的 z_index / bounding_box / name 不再需要。
    if (item.size !== undefined) entry.size = item.size

    try {
      if (!item.url) throw new Error('接口没有返回图片地址')
      await downloadImage(item.url, localPath)
      entry.local_path = localPath
      entry.download_success = true
    } catch (error) {
      entry.download_error = error instanceof Error ? error.message : String(error)
    }
    images.push(entry)
  }

  const ok = images.filter((item) => item.download_success)
  if (!ok.length) {
    const first = images.find((item) => item.download_error)
    throw new Error(`图片下载失败：${first ? first.download_error : '未知原因'}`)
  }

  return {
    images,
    generationTime: (Date.now() - startedAt) / 1000,
    model: params.model,
    size: params.size,
  }
}

export {
  ALLOWED_API_BASE,
  API_TIMEOUT_MS,
  LOCAL_IMAGE_MIME,
  MODELS,
  MODEL_ALIASES,
  buildRequestBody,
  downloadImage,
  expandLocalImagePath,
  generateImages,
  prepareParams,
  readImageSize,
}
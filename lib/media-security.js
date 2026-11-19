/**
 * 媒体与接口地址的安全校验。
 *
 * 移植自原 skill 的安全模块，保持同等强度：
 *   - API 只允许发往火山方舟 AgentPlan 固定主机，防止密钥被引到别处；
 *   - 下载只允许公网 HTTP(S)，并拒绝回环、内网、链路本地等特殊用途地址；
 *   - DNS 校验与实际连接使用同一份解析结果，避免解析与连接之间被重绑（rebinding）。
 */

import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

/** AgentPlan 唯一允许的接口基址。 */
const ALLOWED_API_BASE = 'https://ark.cn-beijing.volces.com/api/plan/v3'

/**
 * 校验接口基址，只接受 AgentPlan 官方主机。
 * @param {string} value 待校验地址
 * @returns {string} 规范化后的基址
 */
function validateApiBase(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('接口地址不是合法 URL')
  }
  const ok =
    url.protocol === 'https:' &&
    url.hostname === 'ark.cn-beijing.volces.com' &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    ['/api/plan/v3', '/api/plan/v3/'].includes(url.pathname)
  if (!ok) {
    throw new Error(`AgentPlan 接口仅允许 ${ALLOWED_API_BASE}，禁止向其他主机发送密钥`)
  }
  return ALLOWED_API_BASE
}

/**
 * 把 data URI 内联内容替换成占位符，避免整段 base64 出现在日志里。
 * @param {unknown} value 任意结构
 * @returns {unknown} 脱敏后的副本
 */
function sanitizeData(value) {
  if (typeof value === 'string') return value.replace(/data:[^;]+;base64,[A-Za-z0-9+/=\s]+/g, '[REDACTED_DATA_URL]')
  if (Array.isArray(value)) return value.map(sanitizeData)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeData(v)]))
  }
  return value
}

/**
 * 判断地址是否为可访问的公网地址（排除私有网段与特殊用途段）。
 * @param {string} address IP 地址
 * @returns {boolean} 是否公网
 */
function isPublicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    )
  }
  if (net.isIP(address) === 6) {
    // 只允许全球单播 2000::/3，并排除文档、隧道、IPv4 映射等特殊段。
    const hex = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase()
    return /^[23]/.test(hex) && !/^2001:([01]:|2:|db8:|10:|20:)/.test(hex) && !hex.startsWith('2002:')
  }
  return false
}

/**
 * 校验下载地址：仅公网 HTTP(S)，不接受带凭据、非标准端口或内网主机。
 * @param {string} value 待校验地址
 * @returns {URL} 解析后的 URL
 */
function validateMediaUrl(value) {
  const url = new URL(value)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const bad =
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !['80', '443'].includes(url.port)) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    (net.isIP(host) && !isPublicAddress(host))
  if (bad) throw new Error('下载仅允许公网 HTTP(S) 媒体地址')
  return url
}

/**
 * 校验后才返回地址的 DNS 解析器：连接直接使用已验证的 IP。
 */
function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error)
    if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) {
      return callback(new Error('拒绝下载内网或特殊用途地址'))
    }
    if (options?.all) callback(null, addresses)
    else callback(null, addresses[0].address, addresses[0].family)
  })
}

/**
 * 带校验的媒体下载（支持最多 5 次重定向）。
 * @param {string} value 媒体地址
 * @param {{method?:string, signal?:AbortSignal}} [options] 请求选项
 * @param {number} [redirects] 已重定向次数
 * @returns {Promise<{ok:boolean,status:number,headers:{get:(k:string)=>string|null},body:import('node:stream').Readable}>}
 */
async function fetchMedia(value, { method = 'GET', signal } = {}, redirects = 0) {
  const url = validateMediaUrl(value)
  if (redirects > 5) throw new Error('下载重定向次数超限')
  const response = await new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(
      url,
      { method, signal, lookup: publicLookup, agent: false },
      resolve,
    )
    request.on('error', reject)
    request.end()
  })
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.resume()
    if (!response.headers.location) throw new Error('下载重定向缺少 Location')
    return fetchMedia(new URL(response.headers.location, url).href, { method, signal }, redirects + 1)
  }
  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    headers: { get: (key) => response.headers[key.toLowerCase()] || null },
    body: response,
  }
}

export { ALLOWED_API_BASE, fetchMedia, isPublicAddress, sanitizeData, validateApiBase, validateMediaUrl }
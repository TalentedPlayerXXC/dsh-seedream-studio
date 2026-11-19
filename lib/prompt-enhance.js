/**
 * 提示词增强。
 *
 * 从 byted-ark-seedream-skill 移植而来，纯本地字符串拼接：
 * 不发起任何网络请求、不产生额外计费。为了发布时不再依赖外部 skill，
 * 这里保持了与原实现完全一致的输出顺序与措辞，便于对照验证。
 */

/** 风格预设：关键词命中后追加的画质描述。 */
const STYLE_PRESETS = {
  '电影风': '好莱坞大片质感, 电影级光影, 杜比视界, 宽画幅, 极致细节',
  '二次元': '新海诚风格, 日系动漫, 精美原画, 高饱和度, 清澈光影',
  '插画风': '扁平插画风格, 莫兰迪色系, 简洁线条, 矢量感, 艺术设计',
  '写实风': '专业摄影, 索尼A7R5, f/1.8大光圈, RAW格式, 超写实, 细节锐利',
  '国潮风': '国潮插画风格, 中国传统元素, 金色点缀, 工笔画质感, 精致线条',
  '赛博朋克': '赛博朋克2077风格, 霓虹灯光, 高科技低生活, 雨天, 未来感',
  '水彩风': '水彩画风格, 透明质感, 晕染效果, 艺术纸张纹理, 清新',
  '3D渲染': 'Octane渲染, 3D立体, 光线追踪, 次表面散射, PBR材质, 极致写实',
  '暗黑风': '暗黑美学, 高对比度, 暗色调, 神秘氛围, 电影质感',
  '治愈系': '治愈系风格, 温暖明亮, 可爱, 吉卜力质感, 柔和光线',
}

/** 通用画质增强词。 */
const BASE_ENHANCEMENTS = '电影质感, 高分辨率, 细节丰富, 专业摄影, 构图精美, 色彩协调'

/** 连贯图（同系列多张）附加的一致性约束。 */
const SEQUENTIAL_ENHANCEMENTS = '统一画风, 相同角色, 系列插画, 风格一致, 色彩协调'

/** 没有命中风格关键词时的通用光影与构图补足。 */
const GENERIC_ENHANCEMENTS = '柔和自然光线, 构图平衡, 主体突出'

/** 风格关键词表，按声明顺序匹配，先命中先返回。 */
const STYLE_KEYWORDS = {
  '电影风': ['电影', '大片', 'cinematic', '好莱坞'],
  '二次元': ['二次元', '动漫', 'anime', '漫画'],
  '插画风': ['插画', '手绘', 'illustration', '扁平'],
  '写实风': ['照片', '写实', 'photograph', '摄影'],
  '国潮风': ['国潮', '国风', '中国风', '传统'],
  '赛博朋克': ['赛博', 'cyberpunk', '朋克', '霓虹'],
  '水彩风': ['水彩', 'watercolor', '手绘'],
  '3D渲染': ['3d', 'oc', '渲染', 'octane', '三维'],
  '暗黑风': ['暗黑', '哥特', 'dark', '黑暗'],
  '治愈系': ['治愈', '温馨', '可爱', 'cute', '温暖'],
}

/**
 * 从提示词里识别风格，未命中返回 null。
 * @param {string} prompt 原始提示词
 * @returns {string|null} 风格名
 */
function detectStyle(prompt) {
  const lower = String(prompt || '').toLowerCase()
  for (const [style, keywords] of Object.entries(STYLE_KEYWORDS)) {
    if (keywords.some((keyword) => lower.includes(keyword))) return style
  }
  return null
}

/**
 * 在原始提示词后追加画质与风格描述。
 *
 * @param {string} prompt 原始提示词
 * @param {boolean} enable 是否启用；关闭时原样返回
 * @param {boolean} isSequential 是否为连贯图模式
 * @returns {{original:string, optimized:string, style:string|null, enabled:boolean, mode:string, applied:string[]}}
 */
function optimizePrompt(prompt, enable = true, isSequential = false) {
  const original = String(prompt ?? '')
  const mode = isSequential ? 'sequential' : 'single'

  if (!enable) {
    return { original, optimized: original, style: null, enabled: false, mode, applied: [] }
  }

  const style = detectStyle(original)
  const applied = []
  let optimized = original

  if (isSequential) {
    optimized += `, ${SEQUENTIAL_ENHANCEMENTS}`
    applied.push('连贯图：统一风格约束')
    if (style) {
      optimized += `, ${STYLE_PRESETS[style]}`
      applied.push(`风格: ${style}`)
    }
  } else {
    optimized += `, ${BASE_ENHANCEMENTS}`
    applied.push('基础画质增强')
    if (style) {
      optimized += `, ${STYLE_PRESETS[style]}`
      applied.push(`风格: ${style}`)
    } else {
      optimized += `, ${GENERIC_ENHANCEMENTS}`
      applied.push('通用光影构图')
    }
  }

  return { original, optimized, style, enabled: true, mode, applied }
}

export { BASE_ENHANCEMENTS, GENERIC_ENHANCEMENTS, SEQUENTIAL_ENHANCEMENTS, STYLE_PRESETS, detectStyle, optimizePrompt }
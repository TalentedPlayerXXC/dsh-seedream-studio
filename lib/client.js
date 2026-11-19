window.__ModuleLoader__.load({
  id: 'dsh-seedream-studio',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** 与 package.json 的 name、cordis 行 id 一致。 */
    const NS = 'seedream-studio'
    /** main slot 的 key 与 sidebar.panellist 的 id 必须相同，侧边栏靠它定位主面板。 */
    const PANEL_ID = 'seedream-studio'
    /** 侧边栏图标顺序：0 = 插件市场，1 = 插件市场名额，2 空着。 */
    const ROW_ORDER = 2

    /* ---------------------------------------------------------------- */
    /* 与宿主通信                                                        */
    /* ---------------------------------------------------------------- */

    /**
     * 页面自身的 HTTP 基址。
     *
     * **不能**用 `__DSH_TRANSPORT__.streamBaseUrl`：那是另一个 origin，宿主的插件
     * 路由又不发 CORS 头，跨域 fetch 会直接 "Failed to fetch"。桌面壳把同源的非静态
     * 路径转发给宿主，所以拿 `document.baseURI` 才是对的。
     */
    function hostHttpBase() {
      const base = typeof document !== 'undefined' ? document.baseURI : void 0
      if (typeof base === 'string' && base !== '') return base
      return globalThis.__DSH_TRANSPORT__?.streamBaseUrl ?? ''
    }

    const PLACEHOLDER_ORIGIN = 'http://dsh.internal/'

    function directoryBase(baseUrl) {
      const url = new URL(baseUrl === '' ? PLACEHOLDER_ORIGIN : baseUrl, PLACEHOLDER_ORIGIN)
      url.search = ''
      url.hash = ''
      if (!url.pathname.endsWith('/')) url.pathname += '/'
      return url.href
    }

    /** 拼插件路由地址。去掉开头斜杠，反代下的目录前缀才不会丢。 */
    function routeUrl(path) {
      return new URL(String(path).replace(/^\/+/, ''), directoryBase(hostHttpBase())).href
    }

    /**
     * 下载用的 URL：和预览同一个路由，但带 `download=1`，
     * 宿主会回 `Content-Disposition: attachment`，浏览器直接另存。
     * 用它而不是 blob/FileReader，是因为大图不必先进内存。
     */
    function downloadUrl(filePath) {
      return routeUrl(`${NS}/image?download=1&p=${encodeURIComponent(filePath)}`)
    }

    async function requestJson(path, init) {
      const response = await fetch(routeUrl(`${NS}/${path}`), {
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        const message = payload && typeof payload.error === 'string' ? payload.error : `请求失败（HTTP ${response.status}）`
        const error = new Error(message)
        error.status = response.status
        error.payload = payload
        throw error
      }
      return payload ?? {}
    }

    /* ---------------------------------------------------------------- */
    /* 文案                                                              */
    /* ---------------------------------------------------------------- */

    const zh = {
      nav: 'Seedream 工作台',
      title: 'Seedream 工作台',
      subtitle: '用豆包 Seedream 生成图片，结果直接存到本地。',
      promptLabel: '提示词',
      promptPlaceholder: '描述你想要的画面。例如：一只橘猫坐在窗台上，午后逆光，胶片质感',
      promptHint: '⌘ ↵ 直接生成 · 输入 @ 引用已上传的图片',
      mentionTitle: '引用已上传的图片',
      mentionKeys: '↑↓ 选择 · ↵ 确认 · Esc 取消',
      mentionNoImages: '还没有上传图片。先把参考图拖进来，再用 @ 引用。',
      mentionNoMatch: '没有匹配的图片',
      mentionNoMatch: '没有匹配的图片',
      tooLong: '提示词超出 3000 字符',
      modelLabel: '模型',
      modelAuto: '自动',
      modelAutoHint: '按能力约束自动挑选',
      modelFlash: 'Flash',
      modelFlashHint: '便宜、速度快，日常够用',
      modelPro: 'Pro',
      modelProHint: '画质优先，适合成品图',
      sizeLabel: '尺寸',
      sizeHint: '当前两个模型都支持 1K / 1.5K / 2K',
      sizeUnsupported: '3K / 4K / 组图这套模型不支持',
      refsLabel: '参考图',
      refsHint: '给了参考图就是图生图 / 编辑模式；最多 10 张',
      refsPlaceholder: '粘贴图片路径或 http(s) 链接后回车',
      refsAdd: '添加',
      refsRemove: '移除',
      refsNotImage: '只支持图片文件（PNG / JPEG / WebP / GIF）',
      refsReadFailed: '读取图片失败，换一张试试',
      refsUploading: '正在上传…',
      refsDropTitle: '把图片拖到这里，或 ⌘V 粘贴截图',
      refsDropHint: '也可以点下面的按钮选文件；单张不超过 24 MB，最多 10 张',
      refsMentionHint: '在提示词里输入 @ 可以把这些图引用进去',
      refsPick: '选择图片',
      refsManual: '或者直接填路径 / 链接',
      planNotice: '当前版本仅支持火山方舟 Agent Plan。不是 Agent Plan 的 Key 无法用于本插件。',
      keyPanelTitle: '配置 API Key',
      keyPanelHint: 'Key 保存在 DSH 自己的凭据库（~/.dsh/.credentials.yaml 的 ARK_AGENT_PLAN_API_KEY），不会落到本插件目录里——这是开源项目，Key 绝不能跟着代码进仓库。明文不回显，界面只显示打码后的指纹。',
      keyChange: '更换 Key',
      keyStored: '已保存的 Key',
      keyPanelPlaceholder: '粘贴 Agent Plan API Key（ark- 开头）',
      keyPanelSave: '保存',
      keyPanelClear: '清除已保存的 Key',
      keyPanelSaved: '已保存',
      keyPanelCleared: '已清除',
      keyNotAgentPlan: '这不是 Agent Plan 的 Key（应以 ark- 开头）。请到火山方舟控制台的 Agent Plan 页面获取。',
      formatLabel: '格式',
      watermarkLabel: '水印',
      watermarkHint: '关掉即无水印',
      optimizeLabel: '提示词优化',
      optimizeHint: '在提示词后追加画质与光影描述',
      optimizeInfoTitle: '提示词增强是怎么工作的',
      optimizeInfo: '这个开关不会调用任何模型，也不会多花一分钱。它只是在本地往你的提示词后面拼接一段固定的画质描述（例如「电影质感, 高分辨率, 细节丰富, 专业摄影, 构图精美, 色彩协调」），必要时再按关键词补一句风格词。整个过程不发额外请求，最终仍然只生成一次、只计费一次。想保留原始提示词就关掉它。',
      advanced: '更多选项',
      generate: '生成图片',
      generating: '生成中…',
      cancel: '取消',
      cancelling: '正在取消…',
      cancelled: '已取消',
      elapsed: '已用',
      waiting: '正在排队…',
      failed: '生成失败',
      retryHint: '失败不会自动重试，避免重复计费。',
      result: '结果',
      results: '最近生成',
      openImage: '打开',
      revealImage: '在文件夹中显示',
      copyPath: '复制路径',
      copyUrl: '复制链接',
      downloadImage: '下载',
      copied: '已复制',
      copyFailed: '复制失败，请手动选中文本复制',
      noticeTitle: '提示',
      opFailed: '操作失败',
      retry: '重试',
      imagesCount: '{n} 张',
      downloadFailed: '下载失败',
      previewFailed: '预览加载不出来，用「打开」看原图',
      viewerAlt: '生成结果的放大预览',
      viewerHint: '点击任意处或按 Esc 关闭',
      selectThis: '选择这张',
      selectedCount: '已选 {n} 张',
      selectAll: '全选',
      deleteSelected: '删除所选',
      deleting: '正在删除…',
      deleteHint: '删除会把文件移到废纸篓，可以从那里恢复。',
      downloadFailedHint: '图已经生成但没落地，可复制链接手动下载；重新生成会再次计费。',
      saveDir: '保存目录',
      openDir: '打开目录',
      keyReady: '密钥已配置',
      keyMissing: '密钥未配置',
      keyMissingHint: '点右上角的「配置 Key」填入你的 Agent Plan Key。它保存在 DSH 凭据库（~/.dsh/.credentials.yaml），不会写进插件目录。',
      keyMissingAction: '手动配置 Key',
      skillMissing: '生成模块未就绪',
      skillMissingHint: '生图能力已内置在插件里，不依赖任何外部 skill。看到这条说明插件文件不完整，请重新安装。',
      loading: '正在读取状态…',
      emptyTitle: '还没有生成过图片',
      emptyHint: '写好提示词，点「生成图片」就行。',
      clear: '清空',
      advancedNote: '这些选项会改变计费与结果，默认值已经够用。',
      tailTitle: '为什么没有「交互式精修」和「拆图层」？',
      tailBody:
        '开发者（也就是我）没有这类需求，所以没有实现。如果这对你是刚需，可以参考豆包的生图 skill：byted-ark-seedream-skill——它带完整的交互编辑与拆图层能力，配合 <bbox> / <point> 标记和图层返回使用。',
      charCount: '字符',
      warning: '提示',
      stateFailed: '读取插件状态失败',
    }

    const en = {
      nav: 'Seedream Studio',
      title: 'Seedream Studio',
      subtitle: 'Generate images with Doubao Seedream and save them locally.',
      promptLabel: 'Prompt',
      promptPlaceholder: 'Describe the image. For example: an orange cat on a windowsill, backlit afternoon, film grain',
      promptHint: '⌘ ↵ to generate · type @ to reference an uploaded image',
      mentionTitle: 'Reference an uploaded image',
      mentionKeys: '↑↓ to move · ↵ to pick · Esc to cancel',
      mentionNoImages: 'No images uploaded yet. Drop a reference image first, then use @.',
      mentionNoMatch: 'No matching image',
      mentionNoMatch: 'No matching image',
      tooLong: 'Prompt is over 3000 characters',
      modelLabel: 'Model',
      modelAuto: 'Auto',
      modelAutoHint: 'Picks by capability constraints',
      modelFlash: 'Flash',
      modelFlashHint: 'Cheaper and faster, fine for everyday use',
      modelPro: 'Pro',
      modelProHint: 'Quality first, for final images',
      sizeLabel: 'Size',
      sizeHint: 'Both current models support 1K / 1.5K / 2K',
      sizeUnsupported: '3K / 4K and image sets are not supported by these models',
      refsLabel: 'Reference images',
      refsHint: 'With references this becomes image-to-image editing; up to 10',
      refsPlaceholder: 'Paste an image path or http(s) URL and press Enter',
      refsAdd: 'Add',
      refsRemove: 'Remove',
      refsNotImage: 'Images only (PNG / JPEG / WebP / GIF)',
      refsReadFailed: 'Could not read that image — try another',
      refsUploading: 'Uploading…',
      refsDropTitle: 'Drop images here, or paste a screenshot with ⌘V',
      refsDropHint: 'You can also pick files below; up to 24 MB each and 10 images',
      refsMentionHint: 'Type @ in the prompt to reference these images',
      refsPick: 'Choose images',
      refsManual: 'Or enter a path / URL',
      planNotice: 'This version supports Volcengine Ark Agent Plan only. A non-Agent-Plan key will not work here.',
      keyPanelTitle: 'Configure API key',
      keyPanelHint: 'The key is saved in the DSH credential store (ARK_AGENT_PLAN_API_KEY in ~/.dsh/.credentials.yaml), never inside this plugin\'s own folder — this is an open-source project, and a key must never travel with the code into a repository. The secret is never echoed back; the panel shows only a masked fingerprint.',
      keyChange: 'Change key',
      keyStored: 'Saved key',
      keyPanelPlaceholder: 'Paste your Agent Plan API key (starts with ark-)',
      keyPanelSave: 'Save',
      keyPanelClear: 'Clear saved key',
      keyPanelSaved: 'Saved',
      keyPanelCleared: 'Cleared',
      keyNotAgentPlan: 'That is not an Agent Plan key (it should start with ark-). Get one from the Agent Plan page in the Volcengine Ark console.',
      formatLabel: 'Format',
      watermarkLabel: 'Watermark',
      watermarkHint: 'Turn off for no watermark',
      optimizeLabel: 'Prompt optimization',
      optimizeHint: 'Appends quality and lighting descriptors to your prompt',
      optimizeInfoTitle: 'How prompt enhancement works',
      optimizeInfo: 'This toggle calls no model and costs nothing extra. It only appends a fixed block of quality descriptors to your prompt (for example "cinematic, high resolution, rich detail, professional photography, beautiful composition, harmonious color"), plus one style phrase when a keyword is detected. No extra request is sent: you still generate once and are billed once. Turn it off to keep your prompt exactly as written.',
      advanced: 'More options',
      generate: 'Generate',
      generating: 'Generating…',
      cancel: 'Cancel',
      cancelling: 'Cancelling…',
      cancelled: 'Cancelled',
      elapsed: 'Elapsed',
      waiting: 'Queued…',
      failed: 'Generation failed',
      retryHint: 'Failures are never retried automatically, to avoid double billing.',
      result: 'Result',
      results: 'Recent generations',
      openImage: 'Open',
      revealImage: 'Show in folder',
      copyPath: 'Copy path',
      copyUrl: 'Copy link',
      downloadImage: 'Download',
      copied: 'Copied',
      copyFailed: 'Copy failed — select the text and copy it manually',
      noticeTitle: 'Notice',
      opFailed: 'Action failed',
      retry: 'Retry',
      imagesCount: '{n} image(s)',
      downloadFailed: 'Download failed',
      previewFailed: 'Preview could not load — use Open to view the file',
      viewerAlt: 'Enlarged preview of the generated image',
      viewerHint: 'Click anywhere or press Esc to close',
      selectThis: 'Select this image',
      selectedCount: '{n} selected',
      selectAll: 'Select all',
      deleteSelected: 'Delete selected',
      deleting: 'Deleting…',
      deleteHint: 'Deleting moves files to the Trash, where you can restore them.',
      downloadFailedHint: 'The image was generated but not saved. Copy the link to download it manually; regenerating bills again.',
      saveDir: 'Save folder',
      openDir: 'Open folder',
      keyReady: 'API key configured',
      keyMissing: 'API key missing',
      keyMissingHint: 'Use the Configure key button at the top right to paste your Agent Plan key. It is stored in the DSH credential store (~/.dsh/.credentials.yaml), never inside the plugin folder.',
      keyMissingAction: 'Configure key manually',
      skillMissing: 'Generation module not ready',
      skillMissingHint: 'Image generation is built into the plugin and needs no external skill. Seeing this means the plugin files are incomplete — please reinstall.',
      loading: 'Reading state…',
      emptyTitle: 'No images yet',
      emptyHint: 'Write a prompt and press Generate.',
      clear: 'Clear',
      advancedNote: 'These change billing and output; the defaults are usually enough.',
      tailTitle: 'Why no interactive edit or layer decomposition?',
      tailBody:
        "The developer (me) has no use for them, so they were never implemented. If you genuinely need them, see the Doubao image-generation skill: byted-ark-seedream-skill — it ships full interactive editing and layer decomposition, with <bbox> / <point> markers and layered output.",
      charCount: 'chars',
      warning: 'Note',
      stateFailed: 'Could not read plugin state',
    }

    /* ---------------------------------------------------------------- */
    /* 样式                                                              */
    /* ---------------------------------------------------------------- */

    const CSS = `
.sds_host{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;color:var(--dsw-alias-label-primary,#1f2328);background:var(--dsw-alias-bg-base,#fff)}
.sds_scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.sds_inner{max-width:840px;margin:0 auto;padding:calc(28px + var(--dsh-frame-top-clearance,0px)) 24px 40px;display:flex;flex-direction:column;gap:18px}
.sds_head{display:flex;flex-direction:column;gap:6px}
.sds_titleRow{display:flex;align-items:center;gap:10px;min-width:0}
.sds_titleBtn{margin-left:auto;flex:0 0 auto;display:inline-flex;align-items:center;gap:6px}
.sds_keyDot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#b6bcc7);flex:0 0 auto}
.sds_keyDot[data-on="true"]{background:var(--dsw-alias-state-success-primary,#2ba471)}
.sds_keyDot[data-bad="true"]{background:var(--dsw-alias-state-warning-primary,#e6a23c)}
.sds_title{font-size:19px;font-weight:650;line-height:26px;margin:0;letter-spacing:-.01em}
.sds_sub{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#6b7280)}
.sds_card{border:.5px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);padding:16px;display:flex;flex-direction:column;gap:14px}
.sds_field{display:flex;flex-direction:column;gap:7px;min-width:0}
.sds_labelRow{display:flex;align-items:baseline;gap:8px;min-width:0}
.sds_label{font-size:12.5px;font-weight:600;line-height:18px;flex:0 0 auto}
.sds_hint{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#6b7280);min-width:0}
.sds_hintGrow{margin-left:auto;flex:0 0 auto;font-variant-numeric:tabular-nums}
.sds_hintWarn{color:var(--dsw-alias-state-warn-primary,#b45309)}
.sds_hintErr{color:var(--dsw-alias-state-error-primary,#dc2626)}
.sds_promptWrap{position:relative;border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);transition:border-color .14s,box-shadow .14s,background-color .14s}
.sds_promptWrap:focus-within{border-color:var(--dsw-alias-brand-primary,#4f6ef7);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6ef7) 16%,transparent);background:var(--dsw-alias-bg-layer-1,#fff)}
.sds_hl{position:absolute;inset:0;z-index:0;box-sizing:border-box;width:100%;min-height:208px;max-height:min(62vh,640px);overflow:hidden;pointer-events:none;font:inherit;font-size:13.5px;line-height:21px;padding:11px 12px;white-space:pre-wrap;overflow-wrap:break-word;word-break:break-word;color:var(--dsw-alias-label-primary,#1f2328)}
.sds_hlRef{border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-link,var(--dsw-static-deepseek-500,#4176e6)) 14%,transparent);color:var(--dsw-alias-link,var(--dsw-static-deepseek-500,#4176e6));font-weight:600}
.sds_textarea{position:relative;z-index:1;box-sizing:border-box;display:block;width:100%;min-height:208px;max-height:min(62vh,640px);resize:none;border:0;border-radius:10px;background:transparent;color:transparent;caret-color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:13.5px;line-height:21px;padding:11px 12px;outline:none}
.sds_textarea::selection{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6ef7) 26%,transparent);color:transparent}
.sds_textarea::placeholder{color:var(--dsw-alias-label-secondary,#9ca3af)}
.sds_input{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);color:inherit;font:inherit;font-size:12.5px;line-height:18px;padding:7px 10px;outline:none;min-width:0}
.sds_input:focus{border-color:var(--dsw-alias-brand-primary,#4f6ef7);background:var(--dsw-alias-bg-layer-1,#fff)}
.sds_seg{display:inline-flex;gap:2px;padding:3px;border-radius:10px;background:var(--dsw-alias-bg-overlay,#e9ecf2);border:none;flex-shrink:0}
.sds_segBtn{font:inherit;font-size:12.5px;line-height:18px;height:28px;padding:0 12px;border-radius:8px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#5c6570);cursor:pointer;transition:background-color .13s,color .13s;white-space:nowrap}
.sds_segBtn:hover:not(:disabled):not([data-on=true]){color:var(--dsw-alias-label-primary,#1f2328);background:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2328) 6%,transparent)}
.sds_segBtn[data-on=true]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-weight:600;box-shadow:0 0 0 .5px var(--dsw-alias-border-l2,#0000001f)}
.sds_segBtn:disabled{opacity:.45;cursor:default}
.sds_segBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:-2px}
.sds_row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.sds_rowTop{align-items:flex-start}
.sds_chips{display:flex;flex-wrap:wrap;gap:6px;min-width:0}
.sds_chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-width:0;padding:3px 4px 3px 8px;border-radius:7px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);border:.5px solid var(--dsw-alias-border-l1,#e5e7eb)}
.sds_chipText{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#5c6570);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px;unicode-bidi:plaintext;text-align:left}
.sds_chipDel{width:18px;height:18px;flex:0 0 auto;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#8b93a1);cursor:pointer;font-size:13px;line-height:1;display:inline-flex;align-items:center;justify-content:center;padding:0}
.sds_chipDel:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2328) 10%,transparent);color:var(--dsw-alias-label-primary,#1f2328)}
.sds_toggleRow{display:flex;align-items:flex-start;gap:9px;cursor:pointer;min-width:0;padding:2px 0}
.sds_toggleRow[data-disabled=true]{cursor:default;opacity:.55}
.sds_check{width:15px;height:15px;flex:0 0 auto;margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary,#4f6ef7);cursor:inherit}
.sds_toggleText{display:flex;flex-direction:column;gap:1px;min-width:0}
.sds_toggleLabel{font-size:12.5px;line-height:18px}
/* 给后来者的说明：低对比、虚线边，明确表达"这是笔记不是功能"。 */
.sds_tailNote{display:flex;flex-direction:column;gap:3px;margin-top:10px;padding:8px 10px;border:1px dashed var(--dsw-alias-separator-primary,#e0e2e7);border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2328) 3%,transparent)}
.sds_tailTitle{font-size:11.5px;line-height:16px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280)}
.sds_tailBody{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#6b7280)}
.sds_toggleHint{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#8b93a1)}
.sds_toggles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 18px}
@media (max-width:620px){.sds_toggles{grid-template-columns:minmax(0,1fr)}
.sds_grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
.sds_header,.sds_footer{padding-left:16px;padding-right:16px}
.sds_body{padding-left:16px;padding-right:16px}.sds_inner{padding-left:16px;padding-right:16px}}
.sds_tile{position:relative}
.sds_bulk{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l2,#d9dde3);background:var(--dsw-alias-bg-layer-2,#f3f4f6)}
.sds_bulkText{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#1f2328)}
.sds_promptWrap{position:relative}
.sds_mention{position:absolute;left:0;right:0;top:calc(100% + 8px);z-index:30;max-height:260px;overflow:auto;padding:6px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2,#d9dde3);background:var(--dsw-alias-bg-overlay,#fff);box-shadow:0 10px 30px #00000026}
.sds_mentionHead{display:flex;align-items:center;gap:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#8b93a1);padding:3px 6px 5px}
.sds_mentionEmpty{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#6b7280);padding:8px 8px}
.sds_mentionRow{display:flex;align-items:center;gap:8px;width:100%;padding:5px 6px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12.5px;line-height:18px;text-align:left;cursor:pointer}
.sds_mentionRow:hover,.sds_mentionRow[aria-selected=true]{background:var(--dsw-alias-bg-layer-2,#f3f4f6)}
.sds_mentionThumb{flex:0 0 auto;width:26px;height:26px;border-radius:5px;object-fit:cover;border:.5px solid var(--dsw-alias-border-l1,#e5e7eb)}
.sds_mentionThumbPh{display:inline-flex;align-items:center;justify-content:center;font-size:13px;background:var(--dsw-alias-bg-layer-1,#fff)}
.sds_mentionBody{display:flex;flex-direction:column;gap:1px;min-width:0}
.sds_mentionName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}
.sds_mentionMeta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-secondary,#8b93a1)}
.sds_mentionKeys{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8b93a1)}
.sds_mentionFoot{display:flex;justify-content:flex-end;padding:4px 4px 0}
.sds_toggleWrap{display:flex;flex-direction:column;gap:4px;min-width:0}
.sds_toggleLabelRow{display:inline-flex;align-items:center;gap:5px;min-width:0}
.sds_infoBtn{flex:0 0 auto;width:14px;height:14px;padding:0;border-radius:50%;border:.5px solid var(--dsw-alias-border-l2,#d9dde3);background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font:inherit;font-size:10px;font-weight:700;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.sds_infoBtn:hover{color:var(--dsw-alias-brand-primary,#4f6ef7);border-color:var(--dsw-alias-brand-primary,#4f6ef7)}
.sds_infoWrap{position:relative;display:inline-flex;flex:0 0 auto}
.sds_infoTip{position:absolute;bottom:calc(100% + 7px);left:-6px;z-index:50;width:300px;max-width:min(300px,70vw);padding:9px 11px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l2,#d9dde3);background:var(--dsw-alias-bg-overlay,#fff);box-shadow:0 8px 26px #00000024;font-size:11.5px;line-height:17px;font-weight:400;color:var(--dsw-alias-label-secondary,#5c6570);text-align:left;white-space:normal;opacity:0;visibility:hidden;transform:translateY(3px);transition:opacity .13s,transform .13s,visibility .13s;pointer-events:none}
.sds_infoWrap:hover .sds_infoTip,.sds_infoWrap:focus-within .sds_infoTip{opacity:1;visibility:visible;transform:translateY(0)}
.sds_planBar{display:flex;align-items:flex-start;gap:8px;padding:9px 12px;border-radius:9px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 38%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 9%,transparent)}
.sds_planDot{flex:0 0 auto;width:6px;height:6px;margin-top:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#b45309)}
.sds_planText{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#1f2328);min-width:0}
.sds_drop{display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:10px;border:1px dashed var(--dsw-alias-border-l2,#d9dde3);background:var(--dsw-alias-bg-layer-2,#f3f4f6);transition:border-color .13s,background-color .13s}
.sds_dropOn{border-color:var(--dsw-alias-brand-primary,#4f6ef7);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6ef7) 8%,transparent)}
.sds_dropBody{display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.sds_dropTitle{font-size:12.5px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}
.sds_thumbs{display:flex;flex-wrap:wrap;gap:8px}
.sds_thumbBox{position:relative;display:flex;flex-direction:column;align-items:center;gap:4px;width:84px}
.sds_thumbImg{width:84px;height:84px;object-fit:cover;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff)}
.sds_thumbIcon{display:flex;align-items:center;justify-content:center;width:84px;height:84px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff);font-size:24px}
.sds_thumbName{max-width:84px;font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-secondary,#8b93a1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sds_thumbDel{position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;border:.5px solid var(--dsw-alias-border-l2,#d9dde3);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#5c6570);cursor:pointer;font-size:12px;line-height:1;display:inline-flex;align-items:center;justify-content:center;padding:0}
.sds_thumbDel:hover{color:var(--dsw-alias-state-error-primary,#dc2626)}
.sds_manual{margin-top:2px}
.sds_manualSum{cursor:pointer;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#6b7280);list-style:none}
.sds_manualSum::-webkit-details-marker{display:none}
.sds_manualSum::before{content:'▸ ';}
.sds_manual[open] .sds_manualSum::before{content:'▾ ';}
.sds_actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sds_primary{font:inherit;font-size:13.5px;font-weight:600;line-height:20px;height:36px;padding:0 18px;border-radius:9px;border:.5px solid var(--dsw-alias-brand-primary,#4f6ef7);background:var(--dsw-alias-brand-primary,#4f6ef7);color:var(--dsw-alias-bg-base,#fff);cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:filter .13s}
.sds_primary:hover:not(:disabled){filter:brightness(1.07)}
.sds_primary:disabled{opacity:.5;cursor:default}
.sds_primary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:2px}
.sds_ghost{font:inherit;font-size:12.5px;line-height:18px;height:32px;padding:0 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,#d9dde3);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:background-color .13s}
.sds_ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#f3f4f6)}
.sds_ghost:disabled{opacity:.5;cursor:default}
a.sds_ghostSm{text-decoration:none}
.sds_ghostSm{height:26px;font-size:11.5px;padding:0 9px;border-radius:7px}
.sds_danger{color:var(--dsw-alias-state-error-primary,#dc2626);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 40%,transparent)}
.sds_spin{width:13px;height:13px;flex:0 0 auto;border-radius:50%;border:2px solid color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 40%,transparent);border-top-color:var(--dsw-alias-bg-base,#fff);animation:sds_spin .7s linear infinite}
@keyframes sds_spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.sds_spin{animation-duration:2s}}
.sds_progress{display:flex;flex-direction:column;gap:8px;padding:11px 13px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-2,#f7f8fa)}
.sds_progressTop{display:flex;align-items:center;gap:9px;min-width:0;font-size:12.5px;line-height:18px}
.sds_progressText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#5c6570);font-variant-numeric:tabular-nums}
.sds_progressElapsed{margin-left:auto;flex:0 0 auto;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#6b7280);font-size:11.5px}
.sds_bar{height:3px;border-radius:99px;background:var(--dsw-alias-border-l1,#e5e7eb);overflow:hidden}
.sds_barFill{height:100%;border-radius:99px;background:var(--dsw-alias-brand-primary,#4f6ef7);width:32%;animation:sds_slide 1.3s ease-in-out infinite}
@keyframes sds_slide{0%{margin-left:-32%}to{margin-left:100%}}
@media (prefers-reduced-motion:reduce){.sds_barFill{animation:none;width:100%;opacity:.4}}
.sds_err{display:flex;flex-direction:column;gap:5px;padding:11px 13px;border-radius:10px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 34%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 7%,transparent)}
.sds_errTitle{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;line-height:18px;color:var(--dsw-alias-state-error-primary,#dc2626)}
.sds_errBody{margin:0;font-size:12px;line-height:19px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary,#1f2328);max-height:220px;overflow:auto}
.sds_warn{display:flex;flex-direction:column;gap:4px;padding:10px 13px;border-radius:10px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 7%,transparent)}
.sds_warnTitle{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;line-height:18px;color:var(--dsw-alias-state-warn-primary,#b45309)}
.sds_warnBody{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#1f2328);word-break:break-word}
.sds_grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));gap:12px}
.sds_tile{display:flex;flex-direction:column;min-width:0;border:.5px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden}
.sds_thumb{display:block;width:100%;aspect-ratio:1/1;object-fit:contain;background:var(--dsw-alias-bg-layer-2,#f3f4f6);border:0;padding:0;cursor:zoom-in}
.sds_thumbEmpty{white-space:pre-line;display:flex;align-items:center;justify-content:center;width:100%;aspect-ratio:1/1;background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-secondary,#8b93a1);font-size:11.5px;text-align:center;padding:12px;box-sizing:border-box}
.sds_tileBody{display:flex;flex-direction:column;gap:7px;padding:9px 11px 11px;min-width:0}
.sds_meta{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#8b93a1);font-variant-numeric:tabular-nums}
.sds_pathRow{display:flex;align-items:center;gap:5px;min-width:0}
.sds_path{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#6b7280);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;unicode-bidi:plaintext;text-align:left;flex:1 1 auto;min-width:0}
.sds_tileActions{display:flex;flex-wrap:wrap;gap:5px}
.sds_sec{display:flex;align-items:baseline;gap:8px;min-width:0;margin-top:2px}
.sds_secTitle{font-size:12.5px;font-weight:600;line-height:18px}
.sds_secMeta{margin-left:auto;font-size:11.5px;color:var(--dsw-alias-label-secondary,#8b93a1);font-variant-numeric:tabular-nums}
.sds_hist{display:flex;flex-direction:column;gap:8px}
.sds_histRow{display:flex;align-items:flex-start;gap:10px;min-width:0;padding:9px 11px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff)}
.sds_histBody{display:flex;flex-direction:column;gap:7px;min-width:0;flex:1 1 auto}
.sds_histHead{display:flex;flex-wrap:wrap;gap:3px 9px;min-width:0;align-items:baseline}
.sds_histPrompt{flex:1 1 auto;min-width:8em}
.sds_histThumbs{display:flex;flex-wrap:wrap;gap:8px}
.sds_histThumb{position:relative;width:72px}
.sds_histThumbOn .sds_histThumbImg{outline:2px solid var(--dsw-alias-link,#4176e6);outline-offset:1px}
.sds_histThumbImg{display:block;width:72px;height:72px;object-fit:cover;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-2,#f3f4f6);cursor:zoom-in}
.sds_histThumbBad .sds_histThumbImg{opacity:.35}
.sds_histPick{position:absolute;top:4px;left:4px;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:5px;background:var(--dsw-alias-bg-base,#fff);border:.5px solid var(--dsw-alias-border-l2,#d9dde3);cursor:pointer}
.sds_histPick input{margin:0;cursor:pointer}
.sds_histDel{position:absolute;top:4px;right:4px;width:18px;height:18px;padding:0;border-radius:50%;border:.5px solid var(--dsw-alias-border-l2,#d9dde3);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#5c6570);font:inherit;font-size:11px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.sds_histDel:hover{color:var(--dsw-alias-state-error-primary,#dc2626);border-color:var(--dsw-alias-state-error-primary,#dc2626)}
.sds_histDl{position:absolute;top:4px;right:26px;width:18px;height:18px;border-radius:50%;border:.5px solid var(--dsw-alias-border-l2,#d9dde3);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#5c6570);font-size:11px;line-height:1;display:inline-flex;align-items:center;justify-content:center;text-decoration:none}
.sds_histDl:hover{color:var(--dsw-alias-link,#4176e6);border-color:var(--dsw-alias-link,#4176e6)}
.sds_histDot{width:7px;height:7px;flex:0 0 auto;border-radius:50%;margin-top:6px;background:var(--dsw-alias-state-success-primary,#16a34a)}
.sds_histDot[data-bad=true]{background:var(--dsw-alias-state-error-primary,#dc2626)}
.sds_histMain{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 auto}
.sds_histPrompt{font-size:12.5px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#1f2328);font-weight:500}
.sds_histMeta{flex:0 1 auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#8b93a1);font-variant-numeric:tabular-nums;display:flex;flex-wrap:wrap;gap:3px 9px}
.sds_histOpen{flex:0 0 auto}
.sds_empty{display:flex;flex-direction:column;align-items:center;gap:7px;padding:36px 20px;text-align:center;border:.5px dashed var(--dsw-alias-border-l2,#d9dde3);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff)}
.sds_emptyTitle{font-size:13px;font-weight:600;line-height:20px}
.sds_emptyHint{margin:0;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary,#6b7280);max-width:420px}
.sds_footer{flex:0 0 auto;border-top:.5px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff);padding:9px 24px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#8b93a1)}
.sds_footItem{display:inline-flex;align-items:center;gap:6px;min-width:0}
.sds_dot{width:6px;height:6px;border-radius:999px;flex:0 0 auto;background:var(--dsw-alias-state-idle-primary,#9ca3af)}
.sds_dot[data-on=true]{background:var(--dsw-alias-state-success-primary,#16a34a)}
.sds_dot[data-bad=true]{background:var(--dsw-alias-state-error-primary,#dc2626)}
.sds_footPath{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px;unicode-bidi:plaintext;text-align:left}
.sds_footActions{margin-left:auto;display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
.sds_loading{display:flex;align-items:center;gap:9px;padding:28px;justify-content:center;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12.5px}
.sds_viewer{position:fixed;inset:0;z-index:80;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:32px;background:color-mix(in srgb,#000 78%,transparent);cursor:zoom-out}
.sds_viewerHint{font-size:11.5px;line-height:17px;color:color-mix(in srgb,#fff 72%,transparent);flex:0 0 auto}
.sds_viewerImg{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;box-shadow:0 24px 64px #00000073}
`

    /**
     * 挂样式。手动插 <style> 并做去重：`styles.insert` 只在动态插件里才有，
     * 编译好的 bundle 半侧用 document 更直接，且重复加载不会叠第二份。
     */
    function mountStyles() {
      if (typeof document === 'undefined') return () => {}
      const selector = 'style[data-plugin-css="dsh-seedream-studio"]'
      const existing = document.querySelector(selector)
      if (existing) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-seedream-studio'
      tag.dataset.pluginCss = 'dsh-seedream-studio'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        try {
          tag.remove()
        } catch {
          /* ignore */
        }
      }
    }

    /* ---------------------------------------------------------------- */
    /* 小图标                                                            */
    /* ---------------------------------------------------------------- */

    /** 取景框 + 火花：一眼看出是「生成图片」，缩小到 16px 也不糊。 */
    function StudioMark(props) {
      const size = props.size || 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 36 36',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('rect', {
          x: 4.5,
          y: 7.5,
          width: 27,
          height: 21,
          rx: 5,
          stroke: 'currentColor',
          strokeWidth: 2.4,
        }),
        h('circle', { cx: 13, cy: 15.5, r: 2.5, fill: 'currentColor' }),
        h('path', {
          d: 'M7 26.5l7.6-7.2 5.2 5 3.7-3.4 5.5 5.6',
          stroke: 'currentColor',
          strokeWidth: 2.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M27.5 3.5l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z',
          fill: 'currentColor',
        }),
      )
    }

    /* ---------------------------------------------------------------- */
    /* 小组件                                                            */
    /* ---------------------------------------------------------------- */

    function Segmented(props) {
      const items = props.items || []
      return h(
        'div',
        { className: 'sds_seg', role: 'group', 'aria-label': props.label || '' },
        items.map((item) =>
          h(
            'button',
            {
              key: item.value,
              type: 'button',
              className: 'sds_segBtn',
              'data-on': item.value === props.value,
              disabled: Boolean(item.disabled) || Boolean(props.disabled),
              title: item.hint || '',
              'aria-pressed': item.value === props.value,
              onClick: () => {
                if (item.disabled || props.disabled) return
                props.onChange(item.value)
              },
            },
            item.label,
          ),
        ),
      )
    }

    function Toggle(props) {
      const disabled = Boolean(props.disabled)
      /*
       * info 是一个可点开的"！"图标：它解释这个开关**实际怎么运作**。
       * 用 button + 展开文本而不是 title 提示，因为 title 只在悬停时出现、
       * 触屏点不到，而"这个功能会不会多花钱"值得被真正读到。
       */
      return h(
        'div',
        { className: 'sds_toggleWrap', 'data-disabled': disabled },
        h(
          'label',
          { className: 'sds_toggleRow', 'data-disabled': disabled, title: props.hint || '' },
          h('input', {
            className: 'sds_check',
            type: 'checkbox',
            checked: Boolean(props.checked),
            disabled,
            onChange: (event) => props.onChange(event.target.checked),
          }),
          h(
            'span',
            { className: 'sds_toggleText' },
            h(
              'span',
              { className: 'sds_toggleLabelRow' },
              h('span', { className: 'sds_toggleLabel' }, props.label),
              /*
               * 「!」说明用 CSS tooltip，悬停/聚焦即出。
               * 纯 CSS 实现是刻意的：Toggle 是普通函数直调（不是组件），
               * 内部不能有 hooks；而 tooltip 本身也只是"看"的信息，
               * 不需要占位展开。
               * 图标在 <label> 内，点击会连带勾选框，所以这里必须
               * preventDefault + stopPropagation，让它只负责显示说明。
               */
              props.info
                ? h(
                    'span',
                    { className: 'sds_infoWrap' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'sds_infoBtn',
                        'aria-label': props.infoTitle || 'info',
                        'aria-describedby': 'sds-info-tip',
                        onClick: (event) => {
                          event.preventDefault()
                          event.stopPropagation()
                        },
                      },
                      '!',
                    ),
                    h('span', { className: 'sds_infoTip', id: 'sds-info-tip', role: 'tooltip' }, props.info),
                  )
                : null,
            ),
            props.hint ? h('span', { className: 'sds_toggleHint' }, props.hint) : null,
          ),
        ),
      )
    }

    function ErrorBox(props) {
      return h(
        'div',
        { className: 'sds_err', role: 'alert' },
        h('div', { className: 'sds_errTitle' }, props.title || ''),
        props.detail ? h('pre', { className: 'sds_errBody' }, props.detail) : null,
        props.children || null,
      )
    }

    function WarnBox(props) {
      return h(
        'div',
        { className: 'sds_warn' },
        h('div', { className: 'sds_warnTitle' }, props.title || ''),
        props.detail ? h('p', { className: 'sds_warnBody' }, props.detail) : null,
        props.children || null,
      )
    }

    /* ---------------------------------------------------------------- */
    /* 主面板                                                            */
    /* ---------------------------------------------------------------- */

    function StudioPanel(props) {
      const t = props.t

      const [state, setState] = useState(null)
      const [stateError, setStateError] = useState(null)

      const [prompt, setPrompt] = useState('')
      const [model, setModel] = useState(null)
      const [size, setSize] = useState(null)
      const [format, setFormat] = useState(null)
      const [watermark, setWatermark] = useState(true)
      const [optimize, setOptimize] = useState(true)
      const [refs, setRefs] = useState([])
      const [refDraft, setRefDraft] = useState('')
      /* 「@」引用：which = 正在被 @ 的那张图在 refs 里的下标；start = @ 字符位置 */
      const [mention, setMention] = useState(null)
      const textareaRef = useRef(null)
      /* 高亮层：与 textarea 同步滚动 */
      const hlRef = useRef(null)
      /* 默认展开：这些选项（水印 / 提示词增强 / 输出格式）是常用开关，藏起来反而多一次点击。 */
      const [showAdvanced, setShowAdvanced] = useState(true)

      const [jobId, setJobId] = useState(null)
      const [job, setJob] = useState(null)
      /* 取消请求已发出、任务还没收敛的那一小段：按钮要立刻给出反馈。 */
      const [cancelling, setCancelling] = useState(false)
      const [elapsed, setElapsed] = useState(0)
      const [formError, setFormError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [history, setHistory] = useState([])
      const [viewer, setViewer] = useState(null)
      /* 批量选择：存待删除的绝对路径。 */
      const [selected, setSelected] = useState([])
      const [deleting, setDeleting] = useState(false)
      const [copiedKey, setCopiedKey] = useState(null)

      const running = Boolean(jobId)
      const tooLong = prompt.length > 3000

      /* ---- 初始状态 ---- */
      /*
       * 抽成可重入的函数：状态读取失败时界面上要有一个"重试"入口，
       * 否则宿主抖一下就把用户锁死在一个红框里，只能关掉面板重开。
       * 顺带把宿主的 /history 读回来 —— 界面切走再切回来、
       * 或者图是 agent 用工具生成的，都不该从"最近生成"里消失。
       */
      const loadState = useCallback(async () => {
        const payload = await requestJson('state')
        setState(payload)
        setModel((current) => current ?? payload.defaults?.model ?? 'auto')
        setSize((current) => current ?? payload.defaults?.size ?? '2K')
        return payload
      }, [])

      useEffect(() => {
        let alive = true
        loadState()
          .then(() => {
            if (!alive) return
            return requestJson('history')
          })
          .then((payload) => {
            if (!alive || !payload) return
            // 宿主字段是 id，界面内部用 jobId。
            const entries = Array.isArray(payload.entries) ? payload.entries : []
            if (entries.length > 0) setHistory(entries.map((e) => ({ ...e, jobId: e.id })))
          })
          .catch((error) => {
            if (alive) setStateError(error.message || String(error))
          })
        return () => {
          alive = false
        }
      }, [loadState])

      /* ---- 计时器 ---- */
      useEffect(() => {
        if (!running) {
          setElapsed(0)
          return undefined
        }
        const startedAt = Date.now()
        setElapsed(0)
        const timer = setInterval(() => setElapsed(Date.now() - startedAt), 250)
        return () => clearInterval(timer)
      }, [running, jobId])

      /* ---- 轮询进度 ---- */
      useEffect(() => {
        if (!jobId) return undefined
        let alive = true
        let timer = null
        const tick = async () => {
          try {
            const payload = await requestJson(`job?jobId=${encodeURIComponent(jobId)}`)
            if (!alive) return
            setJob(payload)
            if (payload.status === 'done' || payload.status === 'failed') {
              setJobId(null)
              const result = payload.result
              if (result && Array.isArray(result.images)) {
                setHistory((current) => [
                  {
                    jobId,
                    prompt,
                    success: result.success === true,
                    images: result.images,
                    model: result.model,
                    size: result.size,
                    elapsedMs: result.elapsedMs,
                    error: result.error,
                    at: Date.now(),
                  },
                  ...current,
                ].slice(0, state?.historyLimit || 20))
              }
              return
            }
            timer = setTimeout(tick, 700)
          } catch (error) {
            if (!alive) return
            // 任务过期（宿主重启/超时清理）时不要卡在无限轮询里。
            if (error.status === 404) {
              setJobId(null)
              setJob(null)
              setFormError({ message: error.message || String(error), kind: 'io' })
              return
            }
            timer = setTimeout(tick, 1200)
          }
        }
        timer = setTimeout(tick, 350)
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [jobId])

      /* ---- API Key 配置 ---- */
      /* 面板默认收起；密钥缺失时由界面上的按钮展开。 */
      const [keyOpen, setKeyOpen] = useState(false)
      const [keyDraft, setKeyDraft] = useState('')
      const [keyBusy, setKeyBusy] = useState(false)
      const [keyMsg, setKeyMsg] = useState(null)

      const saveKey = useCallback(async () => {
        const value = keyDraft.trim()
        if (!value) return
        if (!/^ark-[A-Za-z0-9._-]+$/.test(value)) {
          setKeyMsg({ kind: 'error', text: t('keyNotAgentPlan') })
          return
        }
        setKeyBusy(true)
        setKeyMsg(null)
        try {
          const payload = await requestJson('credential', {
            method: 'POST',
            body: JSON.stringify({ action: 'save', apiKey: value }),
          })
          setKeyDraft('')
          setState((current) => (current ? { ...current, key: payload.key } : current))
          setKeyMsg({ kind: 'ok', text: t('keyPanelSaved') })
        } catch (error) {
          setKeyMsg({ kind: 'error', text: error.message || String(error) })
        } finally {
          setKeyBusy(false)
        }
      }, [keyDraft, t])

      const clearKey = useCallback(async () => {
        setKeyBusy(true)
        setKeyMsg(null)
        try {
          const payload = await requestJson('credential', {
            method: 'POST',
            body: JSON.stringify({ action: 'clear' }),
          })
          setState((current) => (current ? { ...current, key: payload.key } : current))
          setKeyMsg({ kind: 'ok', text: t('keyPanelCleared') })
        } catch (error) {
          setKeyMsg({ kind: 'error', text: error.message || String(error) })
        } finally {
          setKeyBusy(false)
        }
      }, [t])

      /* ---- 参考图：上传式 ---- */
      /*
       * 三种入口都归结成同一件事：拿到一个 File → 读成 base64 → 交给宿主落盘。
       * 拖拽、⌘V 粘贴截图、点按钮选文件，走的是同一条 `ingestFiles`。
       */
      const [uploading, setUploading] = useState(0)
      const [dragging, setDragging] = useState(false)
      const fileInputRef = useRef(null)

      const ingestFiles = useCallback(async (fileList) => {
        const files = Array.from(fileList || []).filter((f) => f && f.type && f.type.startsWith('image/'))
        if (files.length === 0) {
          setFormError({ message: t('refsNotImage'), kind: 'validation' })
          return
        }
        setFormError(null)
        for (const file of files) {
          if (refs.length + uploading >= 10) {
            setFormError({ message: t('refsHint'), kind: 'validation' })
            break
          }
          setUploading((n) => n + 1)
          try {
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => resolve(String(reader.result || ''))
              reader.onerror = () => reject(new Error(t('refsReadFailed')))
              reader.readAsDataURL(file)
            })
            const payload = await requestJson('upload', {
              method: 'POST',
              body: JSON.stringify({ name: file.name, dataUrl }),
            })
            const upload = payload && payload.upload
            if (!upload || !upload.path) throw new Error(t('refsReadFailed'))
            setRefs((current) => (current.some((r) => r.path === upload.path)
              ? current
              : [...current, { path: upload.path, name: upload.name, uploadId: upload.uploadId, preview: dataUrl }]))
          } catch (error) {
            setFormError({ message: error.message || String(error), kind: 'io' })
          } finally {
            setUploading((n) => Math.max(0, n - 1))
          }
        }
      }, [refs.length, uploading, t])

      /* 路径 / 链接仍然可以手输：命令行用户和"图在远端"的场景还有用。 */
      const addRef = useCallback(() => {
        const value = refDraft.trim()
        if (!value) return
        if (refs.length >= 10) {
          setFormError({ message: t('refsHint'), kind: 'validation' })
          return
        }
        if (refs.some((r) => r.path === value)) {
          setRefDraft('')
          return
        }
        setRefs((current) => [...current, { path: value, name: value, uploadId: null, preview: null }])
        setRefDraft('')
        setFormError(null)
      }, [refDraft, refs, t])

      const removeRef = useCallback((entry) => {
        const target = typeof entry === 'string' ? entry : entry && entry.path
        setRefs((current) => {
          const next = current.filter((item) => item.path !== target)
          // 开关依赖参考图数量：删到不满足条件时必须一起复位，
          // 否则开关灰着却仍是 true，点生成直接被宿主 400 拒掉。
          if (next.length === 0) setInteractiveEdit(false)
          if (next.length !== 1) setLayerDecomposition(false)
          return next
        })
        const record = typeof entry === 'object' && entry ? entry : null
        // 上传产生的临时文件顺手删掉，不在宿主上留垃圾。
        if (record && record.uploadId) {
          requestJson(`upload?uploadId=${encodeURIComponent(record.uploadId)}`, { method: 'DELETE' }).catch(() => {})
        }
        setFormError(null)
      }, [])

      /* ---- 生成 ---- */
      const submit = useCallback(async () => {
        if (running) return
        setFormError(null)
        setNotice(null)
        if (!prompt.trim()) {
          setFormError({ message: t('emptyHint'), kind: 'validation' })
          return
        }
        const body = {
          prompt,
          model,
          size,
          reference_images: refs.map((r) => r.path),
          watermark,
          optimize_prompt: optimize,
        }
        if (format) body.output_format = format
        try {
          const payload = await requestJson('generate', {
            method: 'POST',
            body: JSON.stringify(body),
          })
          setJob(null)
          setJobId(payload.jobId)
          if (Array.isArray(payload.warnings) && payload.warnings.length > 0) {
            setNotice(payload.warnings.join('；'))
          }
        } catch (error) {
          // 409 = 宿主那边还有任务在跑，这次请求根本没启动、也没计费。
          // 当成"生成失败 + 不会自动重试"报出去会让人以为白花了钱。
          if (error.status === 409) {
            setNotice(error.message || String(error))
            const busyId = error.payload && error.payload.jobId
            if (busyId) setJobId(busyId)   // 接上正在跑的那个任务，进度条继续
            return
          }
          setFormError({ message: error.message || String(error), kind: 'generate' })
        }
      }, [running, prompt, model, size, refs, watermark, optimize, format, t])

      const cancel = useCallback(async () => {
        if (!jobId || cancelling) return
        setCancelling(true)
        try {
          await requestJson('cancel', {
            method: 'POST',
            body: JSON.stringify({ jobId }),
          })
        } catch {
          /* 取消失败就让轮询自然收敛 */
        }
        // 成功与否都不复位：任务结束或轮询停下时由下面的 effect 清掉，
        // 否则按钮会在真正停下来之前又变回可点的「取消」。
      }, [jobId, cancelling])

      /* 任务不在运行就复位取消态，避免下一次生成按钮一开始就是禁用的。 */
      useEffect(() => {
        if (!running) setCancelling(false)
      }, [running])

      /*
       * 「@」引用已上传的图片。
       *
       * 插入格式是 `@"文件名"`（带引号），和 DSH 内置引用一致。引号有两个作用：
       *   1. 引用有明确边界，插入后你在后面继续打字不会把面板又弹出来；
       *   2. 文件名里可以有空格，不会在空格处被截断。
       * 只认「@ 之后还没有收尾引号」的状态，所以完整引用一旦闭合就不再触发。
       */
      const scanMention = (value, caret) => {
        const before = value.slice(0, caret)
        const at = before.lastIndexOf('@')
        if (at < 0) return null
        const after = before.slice(at + 1)
        // 已经是完整的 @图片N：引用结束，不再弹面板。
        // 这是最关键的一条 —— 否则用户在引用后面接着打字时面板会一直蹦出来。
        if (/^图片\d+/.test(after)) return null
        // 换行说明用户在写正文
        if (after.includes('\n')) return null
        // 未加引号时，遇到空格就认为不是引用
        if (!after.startsWith('"') && /\s/.test(after)) return null
        const query = after.startsWith('"') ? after.slice(1) : after
        return { query, start: at, caret, active: 0 }
      }

      const promptOnChange = useCallback((event) => {
        const value = event.target.value
        setPrompt(value)
        const caret = event.target.selectionStart == null ? value.length : event.target.selectionStart
        setMention(scanMention(value, caret))
      }, [])

      /* 把选中的图插成 `@"路径"`，替换掉正在输入的 `@查询` 那段。 */
      /*
       * 插入 `@图片N`，N 按上传顺序。
       *
       * 刻意**不**插入真实路径：参考图是随请求单独发给模型的，提示词里塞一个
       * UUID 临时路径对模型毫无意义，还会让提示词变脏。`@图片1` 既短又明确，
       * 正好告诉模型"用第 1 张参考图"。
       */
      const insertMention = useCallback((entry) => {
        if (!mention) return
        const order = (refs || []).findIndex((r) => r.path === entry.path)
        const label = order >= 0 ? `图片${order + 1}` : '图片'
        const head = prompt.slice(0, mention.start)
        const tail = prompt.slice(mention.caret)
        const inserted = `@${label}`
        const gap = tail === '' || /^\s/.test(tail) ? '' : ' '
        const next = `${head}${inserted}${gap}${tail}`
        setPrompt(next)
        setMention(null)
        // 光标放在引用（及其补的空格）之后，接着就能往下打字
        const pos = head.length + inserted.length + gap.length
        setTimeout(() => {
          const node = textareaRef.current
          if (node && typeof node.setSelectionRange === 'function') {
            node.focus()
            node.setSelectionRange(pos, pos)
          }
        }, 0)
      }, [mention, prompt, refs])

      /* 面板里当前可选的条目（与面板渲染共用同一份过滤逻辑）。 */
      const mentionItems = useMemo(() => {
        if (!mention) return []
        const query = String(mention.query || '').toLowerCase()
        // order 是上传顺序（即 refs 里的下标），插入时用来生成 `@图片N`
        return (refs || [])
          .map((item, index) => ({ ...item, order: index }))
          .filter((item) => {
            if (!query) return true
            const name = String(item.name || '').toLowerCase()
            const label = `图片${item.order + 1}`
            return name.includes(query) || label.includes(query)
          })
      }, [mention, refs])

      const moveMention = useCallback((delta) => {
        setMention((current) => {
          if (!current) return current
          const total = mentionItems.length
          if (total === 0) return current
          const next = (current.active + delta + total) % total
          return { ...current, active: next }
        })
      }, [mentionItems.length])

      const onKeyDown = useCallback(
        (event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            submit()
            return
          }
          if (mention) {
            if (event.key === 'Escape') {
              event.preventDefault()
              setMention(null)
              return
            }
            // 上下键在候选里移动；回车/ Tab 选中当前项
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              moveMention(1)
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              moveMention(-1)
              return
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              const picked = mentionItems[mention.active] || mentionItems[0]
              if (picked) {
                event.preventDefault()
                insertMention(picked)
              }
              return
            }
          }
        },
        [submit, mention, mentionItems, moveMention, insertMention],
      )

      /*
       * 把提示词切成 [普通文本, 引用] 片段，供高亮层渲染。
       * 引用长得像 @"..."，所以按引号切，普通文本原样保留（含换行）。
       */
      const promptSegments = useMemo(() => {
        const out = []
        // 只认 @图片N 这种形式；同时兼容旧的 @"路径" 写法，避免历史内容不高亮
        const re = /@图片\d+|@"[^"]*"/g
        let last = 0
        let m
        while ((m = re.exec(prompt)) !== null) {
          if (m.index > last) out.push({ text: prompt.slice(last, m.index), ref: false })
          out.push({ text: m[0], ref: true })
          last = m.index + m[0].length
        }
        if (last < prompt.length) out.push({ text: prompt.slice(last), ref: false })
        return out
      }, [prompt])

      const copy = useCallback(async (key, value) => {
        try {
          await navigator.clipboard.writeText(value)
          setCopiedKey(key)
          setTimeout(() => setCopiedKey(null), 1600)
        } catch {
          // 复制是"图没落盘"时唯一的补救路径，静默失败最糟。
          setCopiedKey(null)
          setFormError({ message: t('copyFailed'), kind: 'io' })
        }
      }, [t])

      const openPath = useCallback(async (filePath, mode) => {
        try {
          await requestJson(mode === 'open' ? 'open' : 'reveal', {
            method: 'POST',
            body: JSON.stringify({ path: filePath }),
          })
        } catch (error) {
          setFormError({ message: error.message || String(error), kind: 'io' })
        }
      }, [])

      /* ---- 批量选择与删除 ---- */
      const toggleSelect = useCallback((filePath) => {
        if (!filePath) return
        setSelected((current) => (current.includes(filePath)
          ? current.filter((p) => p !== filePath)
          : [...current, filePath]))
      }, [])

      const selectAll = useCallback((paths) => {
        const list = (paths || []).filter(Boolean)
        setSelected((current) => (current.length === list.length ? [] : list))
      }, [])

      /*
       * 删除图片（支持"删选中的"和"单张删除"两种调用）。
       *
       * 成功删除后必须把**所有**持有这些路径的地方一起清掉：
       *   - history 里对应条目（图删光了就把整行移除）
       *   - 当前结果区 job.result（否则图片已删、卡片还占着位置，
       *     再点删除只会得到"已删除"却依然显示 —— 这正是之前的 bug）
       *   - selected 里的残留
       */
      const deletePaths = useCallback(async (paths) => {
        const targets = (paths || []).filter(Boolean)
        if (targets.length === 0 || deleting) return
        setDeleting(true)
        try {
          const payload = await requestJson('delete', {
            method: 'POST',
            body: JSON.stringify({ paths: targets }),
          })
          const failed = (payload.results || []).filter((r) => !r.ok)
          const done = new Set((payload.results || []).filter((r) => r.ok).map((r) => r.path))

          if (done.size > 0) {
            setHistory((current) => current
              .map((entry) => ({
                ...entry,
                images: (entry.images || []).filter((img) => !done.has(img.localPath)),
              }))
              .filter((entry) => (entry.images || []).length > 0 || !entry.success))

            // 结果区同步：把已删的图摘掉；一张不剩就让整块结果消失
            setJob((current) => {
              if (!current || !current.result) return current
              const images = (current.result.images || []).filter((img) => !done.has(img.localPath))
              if (images.length === (current.result.images || []).length) return current
              return { ...current, result: { ...current.result, images } }
            })
          }

          // 只保留"确实没删掉"的：失败的留下让用户重试，成功的移出选中。
          // 判据是"不在成功集合里"，而不是"在失败集合里"—— 这样既不会重复，
          // 也不会因为某条结果既非成功也非失败而把它误留在选中态。
          setSelected((current) => current.filter((p) => !done.has(p)))
          setNotice(failed.length > 0 ? failed.map((r) => `${r.path}：${r.error}`).join('；') : null)
        } catch (error) {
          setFormError({ message: error.message || String(error), kind: 'io' })
        } finally {
          setDeleting(false)
        }
      }, [deleting])

      const deleteSelected = useCallback(() => deletePaths(selected), [deletePaths, selected])

      /* ---- 派生 ---- */
      const result = job && job.result ? job.result : null
      const modelItems = useMemo(
        () => [
          { value: 'auto', label: t('modelAuto'), hint: t('modelAutoHint') },
          { value: 'flash', label: t('modelFlash'), hint: t('modelFlashHint') },
          { value: 'pro', label: t('modelPro'), hint: t('modelProHint') },
        ],
        [t],
      )
      const sizeItems = useMemo(
        () => [
          { value: '1K', label: '1K' },
          { value: '1.5K', label: '1.5K' },
          { value: '2K', label: '2K' },
        ],
        [],
      )
      const keyConfigured = Boolean(state?.key?.configured)
      const skillReady = Boolean(state?.skill?.generateReady)
      const lastLog = job && Array.isArray(job.log) && job.log.length > 0 ? job.log[job.log.length - 1] : null
      const saveDir = result?.saveDir || state?.savePath || ''

      /*
       * 错误分三类，标题与提示各不相同：
       *   validation → 表单没填对，还没发请求
       *   io         → 打开文件/复制/轮询等本地操作失败
       *   generate   → 真的提交给模型并失败了（只有这类才谈计费与重试）
       * 另外 job.error 是宿主在 startJob 的 catch 里写的兜底信息，
       * 那种情况下 job.result 为 null，不读它就会静默失败。
       */
      const formErrorText = formError ? formError.message : null
      const formErrorKind = formError ? formError.kind : null
      const jobFailed = job && job.status === 'failed'
      const jobErrorText = jobFailed ? (job.result ? job.result.error : job.error) || null : null
      const errorText = formErrorText || jobErrorText
      const errorKind = formErrorText ? formErrorKind : 'generate'
      /* 用户自己点取消不是"失败"：文案和"失败不会自动重试"的提示都不该出现。 */
      const wasCancelled = Boolean(job && job.result && job.result.cancelled === true)

      /* ---- 渲染 ---- */
      if (stateError) {
        return h(
          'div',
          { className: 'sds_host' },
          h(
            'div',
            { className: 'sds_scroll' },
            h(
              'div',
              { className: 'sds_inner' },
              ErrorBox({
                title: t('stateFailed'),
                detail: stateError,
                children: h(
                  'button',
                  {
                    type: 'button',
                    className: 'sds_ghost sds_ghostSm',
                    onClick: () => {
                      setStateError(null)
                      loadState().catch((error) => setStateError(error.message || String(error)))
                    },
                  },
                  t('retry'),
                ),
              }),
            ),
          ),
        )
      }

      if (!state) {
        return h(
          'div',
          { className: 'sds_host' },
          h(
            'div',
            { className: 'sds_loading' },
            h('span', { className: 'sds_spin', style: { borderColor: 'currentColor', borderTopColor: 'transparent' } }),
            t('loading'),
          ),
        )
      }

      return h(
        'div',
        { className: 'sds_host' },
        h(
          'div',
          { className: 'sds_scroll' },
          h(
            'div',
            { className: 'sds_inner' },

            /* 标题 */
            h(
              'div',
              { className: 'sds_head' },
              h(
                'div',
                { className: 'sds_titleRow' },
                h('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-brand-primary,#4f6ef7)' } }, StudioMark({ size: 20 })),
                h('h1', { className: 'sds_title' }, t('title')),
                /*
                 * Key 入口**常驻**。之前它藏在"未配置"的告警框里，
                 * 一旦 Key 已配好（或从别处读到），就再也找不到更换/清除的入口。
                 */
                h(
                  'div',
                  { className: 'sds_titleBtn' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'sds_ghost sds_ghostSm',
                      onClick: () => setKeyOpen((v) => !v),
                      title: keyConfigured ? (state.key?.masked || t('keyReady')) : t('keyMissing'),
                    },
                    h('span', { className: 'sds_keyDot', 'data-on': keyConfigured, 'data-bad': !keyConfigured, 'aria-hidden': 'true' }),
                    keyOpen ? t('keyPanelTitle') + ' ▴' : (keyConfigured ? t('keyChange') : t('keyMissingAction')),
                  ),
                ),
              ),
              h('p', { className: 'sds_sub' }, t('subtitle')),
            ),

            /* 仅支持 Agent Plan：常驻，不因为 Key 已配就消失 */
            h(
              'div',
              { className: 'sds_planBar' },
              h('span', { className: 'sds_planDot', 'aria-hidden': 'true' }),
              h('span', { className: 'sds_planText' }, t('planNotice')),
            ),

            /* 生成模块 / 密钥缺失的硬提示 */
            !skillReady
              ? WarnBox({ title: t('skillMissing'), detail: t('skillMissingHint') })
              : null,
            !keyConfigured
              ? h(
                  'div',
                  { className: 'sds_warn' },
                  h('div', { className: 'sds_warnTitle' }, t('keyMissing')),
                  h('p', { className: 'sds_warnBody' }, t('keyMissingHint')),
                )
              : null,

            /* Key 配置面板：粘贴保存到插件自己的文件 */
            keyOpen
              ? h(
                  'div',
                  { className: 'sds_card' },
                  h('div', { className: 'sds_label' }, t('keyPanelTitle')),
                  h('p', { className: 'sds_hint' }, t('keyPanelHint')),
                  keyConfigured && state.key?.masked
                    ? h(
                        'p',
                        { className: 'sds_hint', style: { marginTop: '2px' } },
                        `${t('keyStored')}: ${state.key.masked}`,
                      )
                    : null,
                  h(
                    'div',
                    { className: 'sds_row' },
                    h('input', {
                      className: 'sds_input',
                      style: { flex: '1 1 260px' },
                      type: 'password',
                      autoComplete: 'off',
                      spellCheck: false,
                      value: keyDraft,
                      placeholder: t('keyPanelPlaceholder'),
                      disabled: keyBusy,
                      onChange: (event) => setKeyDraft(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          saveKey()
                        }
                      },
                    }),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'sds_primary sds_ghostSm',
                        disabled: keyBusy || !keyDraft.trim(),
                        onClick: saveKey,
                      },
                      t('keyPanelSave'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'sds_ghost sds_ghostSm',
                        disabled: keyBusy || !keyConfigured,
                        onClick: clearKey,
                      },
                      t('keyPanelClear'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'sds_ghost sds_ghostSm',
                        onClick: () => setKeyOpen(false),
                      },
                      '×',
                    ),
                  ),
                  keyMsg
                    ? h(
                        'p',
                        { className: keyMsg.kind === 'error' ? 'sds_hint sds_hintErr' : 'sds_hint' },
                        keyMsg.text,
                      )
                    : null,
                )
              : null,

            /* 输入区 */
            h(
              'div',
              { className: 'sds_card' },
              h(
                'div',
                { className: 'sds_field' },
                h(
                  'div',
                  { className: 'sds_labelRow' },
                  h('span', { className: 'sds_label' }, t('promptLabel')),
                  h('span', { className: 'sds_hint' }, t('promptHint')),
                  h(
                    'span',
                    { className: tooLong ? 'sds_hint sds_hintGrow sds_hintErr' : 'sds_hint sds_hintGrow' },
                    `${prompt.length} ${t('charCount')}`,
                  ),
                ),
                h(
                  'div',
                  { className: 'sds_promptWrap' },
                  // 底下的高亮层：把引用染色，textarea 本身的文字是透明的
                  h(
                    'div',
                    { className: 'sds_hl', ref: hlRef, 'aria-hidden': 'true' },
                    promptSegments.length === 0
                      ? h('span', { className: 'sds_hint' }, t('promptPlaceholder'))
                      : promptSegments.map((seg, index) =>
                          seg.ref
                            ? h('span', { className: 'sds_hlRef', key: index }, seg.text)
                            : h('span', { key: index }, seg.text),
                        ),
                    // 末尾补一个换行占位，避免最后一行被吞掉
                    h('span', null, '\n'),
                  ),
                  h('textarea', {
                    ref: textareaRef,
                    className: 'sds_textarea',
                    value: prompt,
                    placeholder: '',
                    spellCheck: false,
                    disabled: running,
                    onChange: promptOnChange,
                    onKeyDown,
                    onScroll: (event) => {
                      // 两层必须同步滚动，否则文字会错位
                      const node = hlRef.current
                      if (node) {
                        node.scrollTop = event.currentTarget.scrollTop
                      }
                    },
                    onBlur: () => {
                      setTimeout(() => setMention(null), 120)
                    },
                  }),
                  mention
                    ? mentionPanel(
                        mention,
                        mentionItems,
                        insertMention,
                        setMention,
                        (index) => setMention((current) => (current ? { ...current, active: index } : current)),
                        t,
                      )
                    : null,
                ),
                tooLong ? h('span', { className: 'sds_hint sds_hintErr' }, t('tooLong')) : null,
              ),

              /* 模型 / 尺寸 */
              h(
                'div',
                { className: 'sds_row' },
                h(
                  'div',
                  { className: 'sds_field', style: { flex: '1 1 260px' } },
                  h('span', { className: 'sds_label' }, t('modelLabel')),
                  Segmented({ items: modelItems, value: model, onChange: setModel, disabled: running, label: t('modelLabel') }),
                ),
                h(
                  'div',
                  { className: 'sds_field', style: { flex: '1 1 200px' } },
                  h(
                    'div',
                    { className: 'sds_labelRow' },
                    h('span', { className: 'sds_label' }, t('sizeLabel')),
                    h('span', { className: 'sds_hint' }, t('sizeHint')),
                  ),
                  Segmented({ items: sizeItems, value: size, onChange: setSize, disabled: running, label: t('sizeLabel') }),
                  h('span', { className: 'sds_hint' }, t('sizeUnsupported')),
                ),
              ),

              /* 参考图 */
              h(
                'div',
                { className: 'sds_field' },
                h(
                  'div',
                  { className: 'sds_labelRow' },
                  h('span', { className: 'sds_label' }, t('refsLabel')),
                  h('span', { className: 'sds_hint' }, t('refsHint')),
                  h('span', { className: 'sds_hint sds_hintGrow' }, `${refs.length}/10`),
                ),
                h(
                  'div',
                  {
                    className: dragging ? 'sds_drop sds_dropOn' : 'sds_drop',
                    onDragOver: (event) => {
                      event.preventDefault()
                      if (!running) setDragging(true)
                    },
                    onDragLeave: () => setDragging(false),
                    onDrop: (event) => {
                      event.preventDefault()
                      setDragging(false)
                      if (running) return
                      ingestFiles(event.dataTransfer && event.dataTransfer.files)
                    },
                    onPaste: (event) => {
                      // ⌘V 粘截图：只有真的带文件时才拦截，普通文本粘贴不受影响
                      const items = event.clipboardData && event.clipboardData.files
                      if (items && items.length > 0) {
                        event.preventDefault()
                        ingestFiles(items)
                      }
                    },
                    tabIndex: 0,
                  },
                  refs.length > 0
                    ? h(
                        'div',
                        { className: 'sds_thumbs' },
                        refs.map((item) =>
                          h(
                            'div',
                            { className: 'sds_thumbBox', key: item.path },
                            item.preview
                              ? h('img', { className: 'sds_thumbImg', src: item.preview, alt: item.name || '' })
                              : h('span', { className: 'sds_thumbIcon' }, '🖼'),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'sds_thumbDel',
                                title: t('refsRemove'),
                                'aria-label': t('refsRemove'),
                                disabled: running,
                                onClick: () => removeRef(item),
                              },
                              '×',
                            ),
                            h('span', { className: 'sds_thumbName', title: item.path }, item.name || item.path),
                          ),
                        ),
                      )
                    : null,
                  h(
                    'div',
                    { className: 'sds_dropBody' },
                    h('span', { className: 'sds_dropTitle' }, uploading > 0 ? t('refsUploading') : t('refsDropTitle')),
                    h('span', { className: 'sds_hint' }, t('refsDropHint')),
                    refs.length > 0
                      ? h('span', { className: 'sds_hint sds_hintGrow' }, t('refsMentionHint'))
                      : null,
                    h(
                      'div',
                      { className: 'sds_row' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'sds_ghost',
                          disabled: running || refs.length + uploading >= 10,
                          onClick: () => fileInputRef.current && fileInputRef.current.click(),
                        },
                        t('refsPick'),
                      ),
                      h('input', {
                        ref: fileInputRef,
                        type: 'file',
                        accept: 'image/png,image/jpeg,image/webp,image/gif',
                        multiple: true,
                        style: { display: 'none' },
                        onChange: (event) => {
                          ingestFiles(event.target.files)
                          event.target.value = ''
                        },
                      }),
                    ),
                  ),
                ),
                h(
                  'details',
                  { className: 'sds_manual' },
                  h('summary', { className: 'sds_manualSum' }, t('refsManual')),
                  h(
                    'div',
                    { className: 'sds_row' },
                    h('input', {
                      className: 'sds_input',
                      style: { flex: '1 1 240px' },
                      value: refDraft,
                      placeholder: t('refsPlaceholder'),
                      disabled: running || refs.length >= 10,
                      onChange: (event) => setRefDraft(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          addRef()
                        }
                      },
                    }),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'sds_ghost',
                        disabled: running || refs.length >= 10 || !refDraft.trim(),
                        onClick: addRef,
                      },
                      t('refsAdd'),
                    ),
                  ),
                ),
              ),

              /* 主要动作 */
              h(
                'div',
                { className: 'sds_actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'sds_primary',
                    // 密钥没配就别让点：注定失败，白折腾一次。
                    disabled: running || tooLong || !skillReady || !keyConfigured || !prompt.trim(),
                    onClick: submit,
                  },
                  running ? h('span', { className: 'sds_spin' }) : null,
                  running ? t('generating') : t('generate'),
                ),
                running
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'sds_ghost sds_danger',
                        onClick: cancel,
                        disabled: cancelling,
                        'aria-busy': cancelling ? 'true' : 'false',
                      },
                      cancelling ? t('cancelling') : t('cancel'),
                    )
                  : null,
                running
                  ? h('span', { className: 'sds_hint' }, `${t('elapsed')} ${(elapsed / 1000).toFixed(1)}s`)
                  : null,
                h(
                  'button',
                  { type: 'button', className: 'sds_ghost', onClick: () => setShowAdvanced((v) => !v) },
                  showAdvanced ? '▾ ' : '▸ ',
                  t('advanced'),
                ),
              ),

              /* 更多选项 */
              showAdvanced
                ? h(
                    'div',
                    { className: 'sds_field' },
                    h('span', { className: 'sds_hint' }, t('advancedNote')),
                    h(
                      'div',
                      { className: 'sds_toggles' },
                      Toggle({
                        label: t('watermarkLabel'),
                        hint: t('watermarkHint'),
                        checked: watermark,
                        disabled: running,
                        onChange: setWatermark,
                      }),
                      Toggle({
                        label: t('optimizeLabel'),
                        hint: t('optimizeHint'),
                        // 本地拼接形容词，不发请求、不调模型、不额外计费 —— 值得说清
                        info: t('optimizeInfo'),
                        infoTitle: t('optimizeInfoTitle'),
                        checked: optimize,
                        disabled: running,
                        onChange: setOptimize,
                      }),
                    ),
                    h(
                      'div',
                      { className: 'sds_row' },
                      h('span', { className: 'sds_label' }, t('formatLabel')),
                      Segmented({
                        items: [
                          { value: 'jpeg', label: 'JPEG' },
                          { value: 'png', label: 'PNG' },
                        ],
                        value: format || state.defaults?.outputFormat || 'jpeg',
                        disabled: running,
                        onChange: setFormat,
                        label: t('formatLabel'),
                      }),
                    ),
                    /*
                     * 一句实话，代替两个不存在的开关。
                     *
                     * 交互式精修和拆图层没有实现——开发者自己用不上。代码里也没有
                     * 半成品残留，不存在"能用但没入口"的能力。真需要的话，指引到
                     * 带这两个能力的 skill（byted-ark-seedream-skill）更有用。
                     */
                    h(
                      'div',
                      { className: 'sds_tailNote' },
                      h('span', { className: 'sds_tailTitle' }, t('tailTitle')),
                      h('span', { className: 'sds_tailBody' }, t('tailBody')),
                    ),
                  )
                : null,
            ),

            /* 通知 / 进度 / 错误 */
            notice ? WarnBox({ title: t('warning'), detail: notice }) : null,

            running
              ? h(
                  'div',
                  { className: 'sds_progress', role: 'status', 'aria-live': 'polite' },
                  h(
                    'div',
                    { className: 'sds_progressTop' },
                    h('span', { className: 'sds_spin', style: { borderColor: 'var(--dsw-alias-border-l2,#d9dde3)', borderTopColor: 'var(--dsw-alias-brand-primary,#4f6ef7)' } }),
                    h('span', { className: 'sds_progressText' }, lastLog || t('waiting')),
                    h('span', { className: 'sds_progressElapsed', 'aria-hidden': 'true' }, `${t('elapsed')} ${(elapsed / 1000).toFixed(1)}s`),
                  ),
                  h('div', { className: 'sds_bar' }, h('div', { className: 'sds_barFill' })),
                )
              : null,

            errorText
              ? wasCancelled
                ? WarnBox({ title: t('cancelled'), detail: errorText })
                : ErrorBox({
                    title: errorKind === 'generate'
                      ? t('failed')
                      : errorKind === 'validation'
                        ? t('noticeTitle')
                        : t('opFailed'),
                    detail: errorText,
                    // 计费提示只跟"真的跑了一次生成"有关，校验和本地操作失败不该出现。
                    children: errorKind === 'generate'
                      ? h('span', { className: 'sds_hint' }, t('retryHint'))
                      : null,
                  })
              : null,

            /* 结果 */
            result && Array.isArray(result.images) && result.images.length > 0
              ? h(
                  'div',
                  { className: 'sds_field' },
                  h(
                    'div',
                    { className: 'sds_sec' },
                    h('span', { className: 'sds_secTitle' }, t('result')),
                    h(
                      'span',
                      { className: 'sds_secMeta' },
                      [
                        result.model || '',
                        result.size ? String(result.size).toUpperCase() : '',
                        result.elapsedMs ? `${Math.round(result.elapsedMs / 1000)}s` : '',
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    ),
                  ),
                  ImageGrid({
                    images: result.images,
                    t,
                    onView: setViewer,
                    onOpen: (p) => openPath(p, 'open'),
                    onReveal: (p) => openPath(p, 'reveal'),
                    onCopy: copy,
                    copiedKey,
                  }),
                )
              : null,

            /* 历史上生成（缩略图 + 批量删除） */
            h(
              'div',
              { className: 'sds_field' },
              h(
                'div',
                { className: 'sds_sec' },
                h('span', { className: 'sds_secTitle' }, t('results')),
                history.length > 0
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'sds_ghost sds_ghostSm',
                        style: { marginLeft: 'auto' },
                        onClick: () => {
                          setSelected([])
                          setHistory([])
                        },
                      },
                      t('clear'),
                    )
                  : null,
              ),
              history.length === 0
                ? h(
                    'div',
                    { className: 'sds_empty' },
                    h('span', { className: 'sds_emptyTitle' }, t('emptyTitle')),
                    h('p', { className: 'sds_emptyHint' }, t('emptyHint')),
                  )
                : h(
                    'div',
                    { className: 'sds_hist' },
                    // 批量操作栏：选中任意图片后出现
                    selected.length > 0
                      ? h(
                          'div',
                          { className: 'sds_bulk' },
                          h('span', { className: 'sds_bulkText' }, t('selectedCount', { n: selected.length })),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'sds_ghost sds_ghostSm sds_danger',
                              disabled: deleting,
                              onClick: () => deleteSelected(),
                            },
                            deleting ? t('deleting') : t('deleteSelected'),
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'sds_ghost sds_ghostSm',
                              onClick: () => setSelected([]),
                            },
                            t('cancel'),
                          ),
                          h('span', { className: 'sds_hint' }, t('deleteHint')),
                        )
                      : null,
                    history.map((entry) =>
                      h(
                        'div',
                        { className: 'sds_histRow', key: entry.jobId },
                        h('span', { className: 'sds_histDot', 'data-bad': !entry.success }),
                        h(
                          'div',
                          { className: 'sds_histBody' },
                          h(
                            'div',
                            { className: 'sds_histHead' },
                            h('span', { className: 'sds_histPrompt', title: entry.prompt || '' }, entry.prompt || '—'),
                            h(
                              'span',
                              { className: 'sds_histMeta' },
                              [
                                entry.success ? t('imagesCount', { n: (entry.images || []).length }) : entry.error || t('failed'),
                                entry.model || '',
                                entry.size ? String(entry.size).toUpperCase() : '',
                                entry.elapsedMs ? `${Math.round(entry.elapsedMs / 1000)}s` : '',
                              ]
                                .filter(Boolean)
                                .join(' · '),
                            ),
                          ),
                          // 这一条生成出来的图，缩略图排列；每张都能勾选
                          (entry.images || []).length > 0
                            ? h(
                                'div',
                                { className: 'sds_histThumbs' },
                                entry.images.map((img) => {
                                  const p = img.localPath
                                  const picked = p ? selected.includes(p) : false
                                  if (!p) return null
                                  return h(
                                    'div',
                                    {
                                      key: p,
                                      className: picked ? 'sds_histThumb sds_histThumbOn' : 'sds_histThumb',
                                    },
                                    h('img', {
                                      className: 'sds_histThumbImg',
                                      src: routeUrl(`${NS}/image?p=${encodeURIComponent(p)}`),
                                      alt: img.fileName || '',
                                      loading: 'lazy',
                                      onClick: () => setViewer(p),
                                      onError: (event) => {
                                        const node = event && event.currentTarget
                                        if (node && node.parentNode) node.parentNode.classList.add('sds_histThumbBad')
                                      },
                                    }),
                                    h(
                                      'label',
                                      { className: 'sds_histPick', title: t('selectThis') },
                                      h('input', {
                                        type: 'checkbox',
                                        checked: picked,
                                        'aria-label': t('selectThis'),
                                        onChange: () => toggleSelect(p),
                                      }),
                                    ),
                                    // 下载：同样走带 Content-Disposition 的路由
                                    h(
                                      'a',
                                      {
                                        className: 'sds_histDl',
                                        href: downloadUrl(p),
                                        download: img.fileName || '',
                                        title: t('downloadImage'),
                                        'aria-label': t('downloadImage'),
                                      },
                                      '↓',
                                    ),
                                    h(
                                      'button',
                                      {
                                        type: 'button',
                                        className: 'sds_histDel',
                                        title: t('deleteSelected'),
                                        'aria-label': t('deleteSelected'),
                                        onClick: () => deletePaths([p]),
                                      },
                                      '×',
                                    ),
                                  )
                                }),
                              )
                            : null,
                        ),
                      ),
                    ),
                  ),
            ),
          ),
        ),

        /* 底部状态栏 */
        h(
          'div',
          { className: 'sds_footer' },
          h(
            'span',
            { className: 'sds_footItem', title: state.key?.source || '' },
            h('span', { className: 'sds_dot', 'data-on': keyConfigured, 'data-bad': !keyConfigured }),
            keyConfigured ? t('keyReady') : t('keyMissing'),
          ),
          h(
            'span',
            { className: 'sds_footItem' },
            h('span', { className: 'sds_dot', 'data-on': skillReady, 'data-bad': !skillReady }),
            state.skill?.skillVersion ? `seedream ${state.skill.skillVersion}` : 'seedream',
          ),
          saveDir
            ? h(
                'span',
                { className: 'sds_footItem' },
                h('span', { className: 'sds_footPath', title: saveDir }, `${t('saveDir')}: ${saveDir}`),
              )
            : null,
          h(
            'span',
            { className: 'sds_footActions' },
            saveDir
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'sds_ghost sds_ghostSm',
                    // 目录本身要"打开"，不是"在文件夹中显示"（后者会在上级目录里选中它）
                    onClick: () => openPath(saveDir, 'open'),
                  },
                  t('openDir'),
                )
              : null,
          ),
        ),

        /* 放大预览 */
        viewer
          ? h(
              'div',
              {
                className: 'sds_viewer',
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': t('viewerAlt'),
                tabIndex: -1,
                onClick: () => setViewer(null),
                onKeyDown: (event) => {
                  if (event.key === 'Escape') setViewer(null)
                },
                ref: (node) => {
                  // 打开就把焦点移进来，Esc 才收得到
                  if (node && typeof node.focus === 'function') node.focus()
                },
              },
              h('img', {
                className: 'sds_viewerImg',
                src: routeUrl(`${NS}/image?p=${encodeURIComponent(viewer)}`),
                alt: t('viewerAlt'),
              }),
              h('span', { className: 'sds_viewerHint' }, t('viewerHint')),
            )
          : null,
      )
    }

    /* ---------------------------------------------------------------- */
    /* 结果卡片                                                          */
    /* ---------------------------------------------------------------- */

    /**
     * 「@」引用面板。
     *
     * 列出当前已上传的参考图，按输入过滤。没有图时明确告诉用户"先上传"，
     * 而不是给一个空框 —— 空框看起来像坏了。
     */
    /**
     * 「@」候选面板。
     *
     * items 是已经过滤好的列表（父组件算好，键盘导航和这里用的是同一份），
     * active 是高亮下标。全部用 onMouseDown 而不是 onClick：
     * textarea 失焦会先触发，onClick 可能等不到。
     */
    function mentionPanel(mention, items, onPick, onClose, onHover, t) {
      if (!items || items.length === 0) {
        return h(
          'div',
          { className: 'sds_mention' },
          h('div', { className: 'sds_mentionEmpty' }, t('mentionNoImages')),
          h(
            'div',
            { className: 'sds_mentionFoot' },
            h('button', { type: 'button', className: 'sds_ghost sds_ghostSm', onMouseDown: (e) => { e.preventDefault(); onClose(null) } }, t('cancel')),
          ),
        )
      }
      const active = Math.min(Math.max(mention.active || 0, 0), items.length - 1)
      return h(
        'div',
        { className: 'sds_mention', role: 'listbox', 'aria-label': t('mentionTitle') },
        h(
          'div',
          { className: 'sds_mentionHead' },
          h('span', null, t('mentionTitle')),
          h('span', { className: 'sds_mentionKeys' }, t('mentionKeys')),
        ),
        items.map((item, index) =>
          h(
            'button',
            {
              key: item.path,
              type: 'button',
              className: 'sds_mentionRow',
              role: 'option',
              'aria-selected': index === active ? 'true' : 'false',
              onMouseDown: (event) => {
                event.preventDefault()
                onPick(item)
              },
              onMouseEnter: () => onHover(index),
            },
            item.preview
              ? h('img', { className: 'sds_mentionThumb', src: item.preview, alt: '' })
              : h('span', { className: 'sds_mentionThumb sds_mentionThumbPh' }, '\u{1F5BC}'),
            h(
              'span',
              { className: 'sds_mentionBody' },
              // 只显示"图片N"和原始文件名；路径是内部临时文件，对用户没有意义
              h('span', { className: 'sds_mentionName' }, `@图片${item.order + 1}`),
              h('span', { className: 'sds_mentionMeta' }, item.name || ''),
            ),
          ),
        ),
      )
    }

    function ImageGrid(props) {
      const { images, t, onView, onOpen, onReveal, onCopy, copiedKey } = props
      return h(
        'div',
        { className: 'sds_grid' },
        images.map((image, index) => {
          const previewable = Boolean(image.localPath && image.downloadOk)
          const key = image.localPath || image.url || `idx-${index}`
          return h(
            'div',
            { className: 'sds_tile', key },
            previewable
              ? h('img', {
                  className: 'sds_thumb',
                  src: routeUrl(`${NS}/image?p=${encodeURIComponent(image.localPath)}`),
                  alt: image.fileName || `image ${index + 1}`,
                  loading: 'lazy',
                  tabIndex: 0,
                  role: 'button',
                  'aria-label': t('openImage'),
                  onClick: () => onView(image.localPath),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
                      event.preventDefault()
                      onView(image.localPath)
                    }
                  },
                  // 图片是文件仍在、但预览路由读不出来（被拒/格式不支持/文件被移走）时，
                  // 不要只留浏览器默认的破图标——那看起来像插件坏了。
                  onError: (event) => {
                    const img = event && event.currentTarget
                    if (!img || !img.parentNode) return
                    const fallback = document.createElement('div')
                    fallback.className = 'sds_thumbEmpty'
                    fallback.textContent = t('previewFailed')
                    img.parentNode.replaceChild(fallback, img)
                  },
                })
              : h(
                  'div',
                  { className: 'sds_thumbEmpty' },
                  image.downloadError ? `${t('downloadFailed')}\n${image.downloadError}` : t('downloadFailed'),
                ),
            h(
              'div',
              { className: 'sds_tileBody' },
              h(
                'div',
                { className: 'sds_meta' },
                image.outputFormat ? h('span', null, String(image.outputFormat).toUpperCase()) : null,
                image.index !== null && image.index !== undefined ? h('span', null, `#${image.index}`) : null,
              ),
              image.localPath
                ? h(
                    'div',
                    { className: 'sds_pathRow' },
                    h('span', { className: 'sds_path', title: image.localPath }, image.fileName || image.localPath),
                  )
                : null,
              !image.downloadOk && image.downloadError
                ? h('span', { className: 'sds_hint sds_hintWarn' }, t('downloadFailedHint'))
                : null,
              h(
                'div',
                { className: 'sds_tileActions' },
                previewable
                  ? h(
                      'button',
                      { type: 'button', className: 'sds_ghost sds_ghostSm', onClick: () => onOpen(image.localPath) },
                      t('openImage'),
                    )
                  : null,
                previewable
                  ? h(
                      'button',
                      { type: 'button', className: 'sds_ghost sds_ghostSm', onClick: () => onReveal(image.localPath) },
                      t('revealImage'),
                    )
                  : null,
                // 下载：走带 Content-Disposition 的路由，浏览器直接另存
                image.localPath
                  ? h(
                      'a',
                      {
                        className: 'sds_ghost sds_ghostSm',
                        href: downloadUrl(image.localPath),
                        download: image.fileName || '',
                        title: t('downloadImage'),
                      },
                      t('downloadImage'),
                    )
                  : null,
                image.localPath
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'sds_ghost sds_ghostSm',
                        onClick: () => onCopy(`p:${key}`, image.localPath),
                      },
                      copiedKey === `p:${key}` ? t('copied') : t('copyPath'),
                    )
                  : null,
                image.url
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'sds_ghost sds_ghostSm',
                        onClick: () => onCopy(`u:${key}`, image.url),
                      },
                      copiedKey === `u:${key}` ? t('copied') : t('copyUrl'),
                    )
                  : null,
              ),
            ),
          )
        }),
      )
    }

    /* ---------------------------------------------------------------- */
    /* 插件入口                                                          */
    /* ---------------------------------------------------------------- */

    function apply(ctx) {
      const disposeStyles = mountStyles()
      ctx.effect(() => disposeStyles, 'dsh-seedream-studio: styles')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-seedream-studio: dictionaries')

      const t = ctx.locale.bind(NS)

      let layout = null
      ctx.inject(['layout'], (scoped) => {
        layout = scoped.layout
      })

      /*
       * 侧边栏图标**独立注册**，不挂在 `main` 的声明回调里。
       *
       * 之前的写法是先 `slots.inject('main', ...)`、再在回调里注册两样东西。
       * 问题是 `main` 的声明来自布局模块，属于"下游"；把图标绑在它上面，
       * 意味着布局若晚一步就绪（重启时常见），图标就跟着晚出现，
       * 表现为"重启后侧边栏没有工作台，开关一次插件才回来"。
       * 图标只依赖 `sidebar.panellist`，和 layout 无关，应该自己独立等待。
       */
      ctx.effect(() => ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: ROW_ORDER, label: () => t('nav'), locale: NS },
        (owner = {}) => h(StudioMark, { size: owner.size ?? 16 }),
      ), 'dsh-seedream-studio: sidebar row')

      // 主面板：点图标时 layout 会校验 key 存在，所以它也独立注册。
      ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: PANEL_ID, locale: NS },
        // `locale: NS` 会注入一个随语言切换换新的 `t`，优先用它，保证切语言即时生效。
        (owner = {}) => h(StudioPanel, { t: typeof owner.t === 'function' ? owner.t : t }),
      ))

      // 卸载时把当前选中的面板让出来，避免停在已消失的页面上。
      ctx.effect(() => () => {
        try {
          if (layout && layout.panelInfo && layout.panelInfo.getSnapshot().activePanelId === PANEL_ID) {
            layout.selectPanel(null)
          }
        } catch {
          /* 布局可能已经卸载 */
        }
      }, 'dsh-seedream-studio: release active panel')
    }

    return { inject: ['slots', 'locale'], apply }
  },
})

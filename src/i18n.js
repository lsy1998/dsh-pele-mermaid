/**
 * dsh-pele-mermaid — message catalog + language resolution.
 *
 * SPEC §4 (frozen signatures) + SPEC §5 R11/R13. Every user-visible string in
 * the plugin is looked up here through `t()`.
 */

/** All user-visible strings. Keys are shared by `en` and `zh-CN`. */
export const MESSAGES = {
  en: {
    viewOptions: 'Pele diagram controls',
    badge: '{type} · Pele',
    diagramView: 'Diagram',
    codeView: 'Code',
    fullscreen: 'Fullscreen',
    downloadSvg: 'Download SVG',
    sourceLabel: 'Diagram source code',
    statusLabel: 'Diagram status',
    viewerLabel: 'Fullscreen Pele diagram viewer',
    viewerTitle: '{type} · Pele',
    zoomOut: 'Zoom out',
    resetZoom: 'Reset zoom to 100%',
    zoomIn: 'Zoom in',
    fitWindow: 'Fit to window',
    closeViewer: 'Close fullscreen viewer',
    rendering: 'Rendering diagram…',
    rendered: 'Pele diagram rendered.',
    renderFailed: 'Diagram rendering failed: {detail}',
    renderFailedAt: 'Diagram rendering failed: {detail} (line {line}, column {column})',
    renderFailedStatus: 'Diagram rendering failed. The source code is shown.',
    runtimeFailed: 'Could not load the Pele renderer: {detail}',
    runtimeFailedStatus: 'Could not load the Pele renderer. The source code is shown.',
    tooLong: 'Diagram not rendered: the source is {actual} characters long and exceeds the {limit} character limit.',
    tooManyLines: 'Diagram not rendered: the source has {actual} lines and exceeds the {limit} line limit.',
    limitStatus: 'Diagram not rendered: the source exceeds the configured limit. The source code is shown.',
    diagramTitle: 'Pele {type} diagram',
    downloaded: 'SVG downloaded.',
    paneLabel: 'Inline diagram viewport. Use the mouse wheel with Control held to zoom, drag to pan, and the plus and minus keys to zoom.',
    zoomStatus: 'Diagram zoom {zoom}',
  },
  'zh-CN': {
    viewOptions: 'Pele 图表控件',
    badge: '{type} · Pele',
    diagramView: '图形',
    codeView: '代码',
    fullscreen: '全屏',
    downloadSvg: '下载 SVG',
    sourceLabel: '图表源代码',
    statusLabel: '图表状态',
    viewerLabel: 'Pele 图表全屏查看',
    viewerTitle: '{type} · Pele',
    zoomOut: '缩小',
    resetZoom: '恢复到 100%',
    zoomIn: '放大',
    fitWindow: '适应窗口',
    closeViewer: '关闭全屏查看',
    rendering: '正在渲染图表…',
    rendered: 'Pele 图表已渲染。',
    renderFailed: '图表渲染失败：{detail}',
    renderFailedAt: '图表渲染失败：{detail}（第 {line} 行，第 {column} 列）',
    renderFailedStatus: '图表渲染失败，已显示源代码。',
    runtimeFailed: '无法加载 Pele 渲染器：{detail}',
    runtimeFailedStatus: '无法加载 Pele 渲染器，已显示源代码。',
    tooLong: '图表未渲染：源码长度为 {actual} 个字符，超过 {limit} 个字符的限制。',
    tooManyLines: '图表未渲染：源码共 {actual} 行，超过 {limit} 行的限制。',
    limitStatus: '图表未渲染：源码超出限制，已显示源代码。',
    diagramTitle: 'Pele {type} 图',
    downloaded: 'SVG 已下载。',
    paneLabel: '内联图表视口。按住 Ctrl 滚动鼠标滚轮可缩放，拖动可平移，可用加号和减号键缩放。',
    zoomStatus: '图表缩放 {zoom}',
  },
};

const INTERPOLATE_RE = /\{(\w+)\}/g;

/** Normalize any BCP-47-ish tag to one of our two catalogs. */
export function normalizeLang(tag) {
  const raw = String(tag == null ? '' : tag).trim().toLowerCase().replace(/_/g, '-');
  if (!raw) return 'en';
  if (raw === 'zh' || raw.startsWith('zh-')) return 'zh-CN';
  return 'en';
}

/** Resolve the active language from a document, falling back to `en`. */
export function detectLang(doc) {
  const candidates = [];
  const target = doc || (typeof document !== 'undefined' ? document : null);
  try {
    candidates.push(target && target.documentElement && target.documentElement.getAttribute('lang'));
  } catch {
    /* ignore */
  }
  try {
    candidates.push(target && target.defaultView && target.defaultView.navigator && target.defaultView.navigator.language);
  } catch {
    /* ignore */
  }
  try {
    if (typeof navigator !== 'undefined') candidates.push(navigator.language || navigator.userLanguage);
  } catch {
    /* ignore */
  }
  for (const candidate of candidates) {
    const value = String(candidate == null ? '' : candidate).trim();
    if (value) return normalizeLang(value);
  }
  return 'en';
}

/**
 * Translate `key` and interpolate `{name}` placeholders.
 * Unknown keys fall back to the `en` catalog and finally to the key itself.
 */
export function t(lang, key, params) {
  const catalog = MESSAGES[normalizeLang(lang)] || MESSAGES.en;
  let template = catalog[key];
  if (template == null) template = MESSAGES.en[key];
  if (template == null) return String(key);
  if (!params) return template;
  return template.replace(INTERPOLATE_RE, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) && params[name] != null ? String(params[name]) : match,
  );
}

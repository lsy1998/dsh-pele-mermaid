/**
 * dsh-pele-mermaid — mermaid block detection.
 *
 * Pure, DOM-light helpers used by the client orchestrator. No pele import:
 * the caller passes `detectType` (usually `window.pele.detectType`) when an
 * authoritative type check is required.
 *
 * SPEC §4 (frozen signatures) + SPEC §5 R1/R7.
 */

/** Class of a code element that declares mermaid explicitly. */
export const LANG_CLASS = /^language-(?:mermaid|mermaidjs|mmd)$/i;

/** Any `language-*` class. */
const ANY_LANG_CLASS = /^language-/i;

/** Default guard rails (SPEC R7: 50 000 chars / 2 000 lines). */
export const DEFAULT_MAX_CHARS = 50000;
export const DEFAULT_MAX_LINES = 2000;

/**
 * First-token keyword gate for the DSH/Shiki plain fallback (no `language-*`
 * class). Aliases map to Pele's canonical diagram type names.
 */
export const MERMAID_KEYWORDS = Object.freeze({
  graph: 'flowchart',
  flowchart: 'flowchart',
  sequencediagram: 'sequence',
  classdiagram: 'class',
  statediagram: 'state',
  'statediagram-v2': 'state',
  erdiagram: 'er',
  gantt: 'gantt',
  pie: 'pie',
  journey: 'journey',
  timeline: 'timeline',
  mindmap: 'mindmap',
  gitgraph: 'gitGraph',
  quadrantchart: 'quadrantChart',
  requirementdiagram: 'requirement',
  c4context: 'c4',
  c4container: 'c4',
  c4component: 'c4',
  c4dynamic: 'c4',
  c4deployment: 'c4',
  block: 'block',
  packet: 'packet',
  kanban: 'kanban',
  'architecture-beta': 'architecture',
  'sankey-beta': 'sankey',
  'xychart-beta': 'xychart',
  zenuml: 'zenuml',
});

/** Matches the leading word of a diagram source. */
const FIRST_TOKEN_RE = /^([A-Za-z][\w-]*)/;
const DIRECTIVE_RE = /^\s*%%\{[\s\S]*?\}%%/;
const COMMENT_LINE_RE = /^\s*%%[^\n]*(?:\n|$)/;

/**
 * Drop leading blank space, `%%{...}%%` directives (possibly multi-line) and
 * `%%` comment lines so detection sees the real diagram keyword (SPEC R1).
 */
function stripLeadingNoise(source) {
  let text = String(source == null ? '' : source);
  for (;;) {
    const before = text;
    text = text.replace(DIRECTIVE_RE, '').replace(COMMENT_LINE_RE, '');
    if (text === before) break;
  }
  return text.replace(/^\s+/, '');
}

/** Read a code element's source text. */
export function codeSource(codeEl) {
  if (!codeEl) return '';
  return typeof codeEl.textContent === 'string' ? codeEl.textContent : '';
}

/** Normalized class list of an element. */
function classList(el) {
  if (!el || !el.classList) {
    const raw = el && el.className;
    return raw ? String(raw).split(/\s+/).filter(Boolean) : [];
  }
  return Array.from(el.classList);
}

/** True when the element itself carries a mermaid language class. */
export function hasMermaidLanguageClass(codeEl) {
  return classList(codeEl).some((cls) => LANG_CLASS.test(cls));
}

/** True when the element carries any `language-*` class at all. */
export function hasAnyLanguageClass(codeEl) {
  return classList(codeEl).some((cls) => ANY_LANG_CLASS.test(cls));
}

/**
 * Any `language-*` class other than mermaid. Such blocks are never enhanced
 * (SPEC R1), even in the unlikely case they also carry a mermaid class.
 */
export function hasForeignLanguageClass(codeEl) {
  if (!codeEl) return false;
  if (!hasAnyLanguageClass(codeEl)) return false;
  return classList(codeEl).some((cls) => ANY_LANG_CLASS.test(cls) && !LANG_CLASS.test(cls));
}

/** Leading keyword of the diagram source, lower-cased ('' when absent). */
export function firstToken(source) {
  const match = FIRST_TOKEN_RE.exec(stripLeadingNoise(source));
  return match ? match[1].toLowerCase() : '';
}

/** True when the source starts with a known mermaid keyword. */
export function hasMermaidKeyword(source) {
  return Object.prototype.hasOwnProperty.call(MERMAID_KEYWORDS, firstToken(source));
}

/** Canonical type guessed from the leading keyword (null when unknown). */
export function keywordType(source) {
  const token = firstToken(source);
  return Object.prototype.hasOwnProperty.call(MERMAID_KEYWORDS, token) ? MERMAID_KEYWORDS[token] : null;
}

/**
 * SPEC R1 — decide whether a `pre > code` block is a mermaid diagram.
 *
 * - explicit `language-mermaid|mermaidjs|mmd` wins;
 * - a block with another `language-*` class is never a candidate;
 * - DSH/Shiki plain fallback (no `language-*` class) needs both a known
 *   leading keyword and a non-null `detectType(source)`.
 * Inline `code` is excluded by requiring a real `pre > code` pair.
 */
export function isMermaidCodeBlock(pre, codeEl, detectType) {
  if (!pre || !codeEl) return false;
  if (String(pre.tagName || '').toUpperCase() !== 'PRE') return false;
  if (String(codeEl.tagName || '').toUpperCase() !== 'CODE') return false;
  if (hasForeignLanguageClass(codeEl)) return false;
  if (hasMermaidLanguageClass(codeEl)) return true;
  if (hasAnyLanguageClass(codeEl)) return false;
  const source = codeSource(codeEl).trim();
  if (!source) return false;
  if (!hasMermaidKeyword(source)) return false;
  if (typeof detectType !== 'function') return false;
  try {
    return !!detectType(source);
  } catch {
    return false;
  }
}

/**
 * Best-effort human label for a diagram: the Pele type when detectable, the
 * keyword mapping otherwise, and `'mermaid'` as the final fallback.
 */
export function diagramLabel(source, detectType) {
  const text = String(source == null ? '' : source);
  if (typeof detectType === 'function') {
    try {
      const type = detectType(text);
      if (type) return String(type);
    } catch {
      /* fall through to the keyword heuristic */
    }
  }
  return keywordType(text) || 'mermaid';
}

/** Count logical lines the way the limit check does. */
export function countLines(source) {
  return String(source == null ? '' : source).split('\n').length;
}

function positiveInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

/**
 * SPEC R7 — size guard. Over-limit blocks stay as source and are never rendered.
 * Returns `{ ok: true }` or `{ ok: false, reason: 'chars'|'lines', actual, limit }`.
 */
export function checkLimits(source, limits) {
  const text = String(source == null ? '' : source);
  const maxChars = positiveInt(limits && limits.maxChars, DEFAULT_MAX_CHARS);
  const maxLines = positiveInt(limits && limits.maxLines, DEFAULT_MAX_LINES);
  // Lines are checked first: when both limits are exceeded the line count is the
  // more actionable diagnosis (SPEC R7; test/unit-detection.test.mjs:148).
  const lines = countLines(text);
  if (lines > maxLines) {
    return { ok: false, reason: 'lines', actual: lines, limit: maxLines };
  }
  if (text.length > maxChars) {
    return { ok: false, reason: 'chars', actual: text.length, limit: maxChars };
  }
  return { ok: true };
}

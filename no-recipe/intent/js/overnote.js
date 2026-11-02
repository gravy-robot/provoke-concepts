/**
 * Overnote — a zero-dependency HTML annotation layer.
 *
 * Three modes, toggled from a floating toolbar:
 *   - off       View mode. No annotation listeners; existing annotations are display-only.
 *   - highlight Select text → "Add comment" → <mark class="overnote-highlight"> + sidebar thread.
 *   - sticky    Hover outlines block elements; click one to pin a sticky note to it.
 *
 * Highlights are stored as W3C-style Text Quote Selectors (exact / prefix / suffix) with a
 * Text Position Selector as a disambiguation hint. Sticky notes store a CSS selector plus a
 * relative offset (0–1) inside the target's bounding box, so they follow the element through
 * scroll, resize and reflow.
 *
 * @module overnote
 */

const VERSION = '1.0.0';

export const MODES = Object.freeze({ OFF: 'off', HIGHLIGHT: 'highlight', STICKY: 'sticky' });

const MODE_ALIASES = {
  off: MODES.OFF, view: MODES.OFF, none: MODES.OFF,
  highlight: MODES.HIGHLIGHT, text: MODES.HIGHLIGHT,
  sticky: MODES.STICKY, note: MODES.STICKY, element: MODES.STICKY,
};

const MODE_LABELS = { off: 'View', highlight: 'Highlight', sticky: 'Sticky' };
const MODE_HINTS = {
  off: 'View mode — annotation tools off',
  highlight: 'Highlight mode — select text to comment',
  sticky: 'Sticky note mode — click an element to pin a note',
};

const UI_ATTR = 'data-overnote-ui';
const UI_SELECTOR = `[${UI_ATTR}]`;
// Text inside these is never indexed for highlighting.
const TEXT_SKIP = `script,style,noscript,template,textarea,select,svg,iframe,${UI_SELECTOR}`;
// Elements treated as blocks for sticky notes even though they render inline.
const REPLACED_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'IFRAME', 'PICTURE', 'OBJECT', 'EMBED', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'svg']);
const CONTEXT_LENGTH = 32;
const RESOLVE_RETRY_MS = 1000;
const STYLE_ID = 'overnote-styles';

const ICON = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const ICONS = {
  off: ICON('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  highlight: ICON('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'),
  sticky: ICON('<path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5z"/><path d="M15 3v6h6"/>'),
  comments: ICON('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  addComment: ICON('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v6M9 10h6"/>'),
  close: ICON('<path d="M18 6 6 18M6 6l12 12"/>'),
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `on-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const nowIso = () => new Date().toISOString();
const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const clamp01 = (v, fallback) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);
const toIso = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? nowIso() : d.toISOString();
};
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const textSnippet = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Minimal element factory. `html` is only ever used for the static icon strings above. */
function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) if (child != null && child !== false) el.append(child);
  return el;
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function describeEl(el) {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`;
  const cls = [...el.classList].find((c) => !c.startsWith('overnote'));
  return cls ? `${tag}.${cls}` : tag;
}

/* ------------------------------------------------------------------ */
/* Text indexing & Text Quote Selector anchoring                       */
/* ------------------------------------------------------------------ */

/** Flattens the root's visible text into one string, remembering where each text node starts. */
function buildTextIndex(root, skipSelector) {
  const nodes = [];
  const starts = new Map();
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement && !node.parentElement.closest(skipSelector)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node, start: text.length });
    starts.set(node, text.length);
    text += node.data;
  }
  return { nodes, starts, text };
}

/** Converts a DOM range boundary into a character offset within the text index. */
function boundaryToOffset(index, container, offset) {
  if (container.nodeType === Node.TEXT_NODE && index.starts.has(container)) {
    return index.starts.get(container) + offset;
  }
  const probe = document.createRange();
  probe.setStart(container, offset);
  probe.collapse(true);
  for (const { node, start } of index.nodes) {
    if (probe.comparePoint(node, 0) >= 0) return start;
  }
  return index.text.length;
}

function sharedSuffixLength(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function sharedPrefixLength(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Finds the best occurrence of a Text Quote Selector in `text`.
 * Every exact match is scored by how much of its prefix/suffix context survives; the
 * position hint breaks ties so repeated phrases resolve to the original occurrence.
 */
function locateQuote(text, { exact, prefix = '', suffix = '' }, hint) {
  if (!exact) return null;
  let best = null;
  let bestScore = -Infinity;
  for (let i = text.indexOf(exact); i !== -1; i = text.indexOf(exact, i + 1)) {
    const before = text.slice(Math.max(0, i - prefix.length), i);
    const after = text.slice(i + exact.length, i + exact.length + suffix.length);
    let score = sharedSuffixLength(before, prefix) + sharedPrefixLength(after, suffix);
    if (Number.isFinite(hint)) score -= Math.abs(i - hint) / (text.length + 1);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best === null ? null : { start: best, end: best + exact.length };
}

/** Wraps the characters [start, end) in <mark> elements, splitting text nodes as needed. */
function wrapOffsets(index, start, end, id) {
  const marks = [];
  for (const { node, start: nodeStart } of index.nodes) {
    const nodeEnd = nodeStart + node.data.length;
    if (nodeEnd <= start) continue;
    if (nodeStart >= end) break;
    if (!node.data.trim()) continue; // structural whitespace between blocks
    let target = node;
    const from = Math.max(start, nodeStart) - nodeStart;
    const to = Math.min(end, nodeEnd) - nodeStart;
    if (to < target.data.length) target.splitText(to);
    if (from > 0) target = target.splitText(from);
    const mark = h('mark', { class: 'overnote-highlight', 'data-overnote-id': id });
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
    marks.push(mark);
  }
  return marks;
}

function unwrap(mark) {
  const parent = mark.parentNode;
  if (!parent) return;
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
  parent.removeChild(mark);
  parent.normalize();
}

/* ------------------------------------------------------------------ */
/* Element targeting for sticky notes                                  */
/* ------------------------------------------------------------------ */

/** Walks up from a hovered node to the nearest block-level (non-inline) element. */
function blockTarget(node, root, ignoreSelector) {
  let el = node instanceof Element ? node : node?.parentElement;
  if (!el || el.closest(ignoreSelector)) return null;
  while (el && el !== root && el !== document.body && el !== document.documentElement) {
    if (REPLACED_TAGS.has(el.tagName)) return el;
    const display = getComputedStyle(el).display;
    if (display !== 'inline' && display !== 'contents' && display !== 'none') return el;
    el = el.parentElement;
  }
  return null;
}

function isUniqueId(id) {
  try {
    return document.querySelectorAll(`#${CSS.escape(id)}`).length === 1;
  } catch {
    return false;
  }
}

/** Builds a stable CSS path: nearest unique #id, then tag:nth-of-type steps. */
function cssPath(el) {
  const parts = [];
  for (let node = el; node && node.nodeType === Node.ELEMENT_NODE; node = node.parentElement) {
    if (node.id && isUniqueId(node.id)) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    if (node === document.body || node === document.documentElement) {
      parts.unshift(node.tagName.toLowerCase());
      break;
    }
    const tag = node.tagName.toLowerCase();
    const siblings = [...node.parentElement.children].filter((c) => c.tagName === node.tagName);
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
  }
  return parts.join(' > ');
}

/** Resolves a sticky target: CSS selector first, verified by tag; falls back to a text-hint scan. */
function resolveElement(target, ignoreSelector) {
  const css = target?.selector?.find((s) => s.type === 'CssSelector')?.value;
  let el = null;
  if (css) {
    try {
      el = document.querySelector(css);
    } catch {
      el = null;
    }
  }
  if (el && (el.closest(ignoreSelector) || (target.tagName && el.tagName !== target.tagName))) el = null;
  const hint = target?.textHint;
  if (hint && target.tagName && (!el || textSnippet(el) !== hint)) {
    for (const candidate of document.getElementsByTagName(target.tagName)) {
      if (!candidate.closest(ignoreSelector) && textSnippet(candidate) === hint) return candidate;
    }
  }
  return el;
}

function scrollParents(el) {
  const list = [];
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (/auto|scroll|hidden|clip/.test(s.overflow + s.overflowX + s.overflowY)) list.push(p);
  }
  return list;
}

/* ------------------------------------------------------------------ */
/* Import validation                                                   */
/* ------------------------------------------------------------------ */

function normalizeAnnotation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type !== 'highlight' && raw.type !== 'sticky') return null;
  const target = raw.target ?? {};
  const selectors = [].concat(target.selector ?? []).filter((s) => s && typeof s === 'object');
  const clean = { id: str(raw.id) || uid(), type: raw.type, createdAt: toIso(raw.createdAt), target: {}, comments: [] };

  if (raw.type === 'highlight') {
    const quote = selectors.find((s) => s.type === 'TextQuoteSelector');
    if (!quote || !str(quote.exact)) return null;
    clean.target.selector = [{ type: 'TextQuoteSelector', exact: quote.exact, prefix: str(quote.prefix), suffix: str(quote.suffix) }];
    const pos = selectors.find((s) => s.type === 'TextPositionSelector');
    if (pos && Number.isInteger(pos.start) && Number.isInteger(pos.end) && pos.end > pos.start) {
      clean.target.selector.push({ type: 'TextPositionSelector', start: pos.start, end: pos.end });
    }
  } else {
    const css = selectors.find((s) => s.type === 'CssSelector');
    if (!css || !str(css.value)) return null;
    clean.target = {
      selector: [{ type: 'CssSelector', value: css.value }],
      tagName: str(target.tagName) || undefined,
      textHint: str(target.textHint) || undefined,
      offset: { x: clamp01(target.offset?.x, 0), y: clamp01(target.offset?.y, 0) },
    };
  }

  clean.comments = [].concat(raw.comments ?? [])
    .filter((c) => c && str(c.text).trim())
    .map((c) => ({ id: str(c.id) || uid(), author: str(c.author, 'Anonymous'), text: c.text, createdAt: toIso(c.createdAt) }));
  return clean.comments.length ? clean : null;
}

const getSelector = (annotation, type) => annotation.target.selector.find((s) => s.type === type);

/* ------------------------------------------------------------------ */
/* Overnote                                                            */
/* ------------------------------------------------------------------ */

export class Overnote {
  static MODES = MODES;
  static VERSION = VERSION;

  /**
   * @param {object}   [options]
   * @param {Element|string} [options.root=document.body] Element whose text and children can be annotated.
   * @param {string}   [options.author='Anonymous'] Name attached to new comments.
   * @param {'bottom-right'|'bottom-left'|'top-right'|'top-left'} [options.position='bottom-right'] Toolbar corner.
   * @param {string}   [options.mode='off'] Mode to start in.
   * @param {string}   [options.ignore] Selector for page regions that must never be annotated.
   * @param {string}   [options.storageKey] If set, annotations auto-persist to localStorage under this key.
   * @param {boolean}  [options.injectStyles=true] Inject the default stylesheet.
   * @param {(data: object) => void} [options.onChange] Called with exportAnnotations() after every change.
   */
  constructor(options = {}) {
    this.options = {
      root: null,
      author: 'Anonymous',
      position: 'bottom-right',
      mode: MODES.OFF,
      ignore: '',
      storageKey: null,
      injectStyles: true,
      onChange: null,
      ...options,
    };
    this.mode = MODES.OFF;
    this.annotations = new Map();
    this._views = new Map();
    this._listeners = new Map();
    this._drafts = new Map();
    this._handledEvents = new WeakSet();
    this._activeId = null;
    this._sidebarOpen = false;
    this._initialized = false;
    this._raf = 0;
  }

  /* ---------------- Public API ---------------- */

  /** Builds the UI and starts tracking. Safe to call more than once. */
  init() {
    if (this._initialized) return this;
    if (typeof document === 'undefined') throw new Error('Overnote: init() needs a browser DOM.');
    const { root, ignore, injectStyles: inject } = this.options;
    this.root = typeof root === 'string' ? document.querySelector(root) : root || document.body;
    if (!this.root) throw new Error(`Overnote: root "${root}" not found.`);
    this._ignoreSelector = ignore ? `${UI_SELECTOR},${ignore}` : UI_SELECTOR;
    this._textSkip = ignore ? `${TEXT_SKIP},${ignore}` : TEXT_SKIP;

    if (inject) injectStyles();
    this._buildUI();
    this._bindGlobalListeners();
    this._initialized = true;

    if (this.options.storageKey) this._loadFromStorage();
    this._refresh();
    this.enableMode(this.options.mode);
    return this;
  }

  /** Switches between 'off' (alias 'view'), 'highlight' and 'sticky'. */
  enableMode(mode) {
    const next = MODE_ALIASES[String(mode).toLowerCase()];
    if (!next) throw new TypeError(`Overnote: unknown mode "${mode}". Use ${Object.values(MODES).join(', ')}.`);
    if (!this._initialized) return this.init().enableMode(next);

    const previous = this.mode;
    this._modeAbort?.abort();
    this._modeAbort = new AbortController();
    const signal = this._modeAbort.signal;
    this._hideAddButton();
    this._hideOutline();
    this.mode = next;

    if (next === MODES.HIGHLIGHT) {
      const onEnd = (e) => this._onSelectionEnd(e);
      document.addEventListener('mouseup', onEnd, { signal });
      document.addEventListener('keyup', onEnd, { signal });
      document.addEventListener('selectionchange', () => this._onSelectionChange(), { signal });
    } else if (next === MODES.STICKY) {
      document.addEventListener('mouseover', (e) => this._onHover(e), { signal, capture: true });
      document.addEventListener('mouseout', (e) => !e.relatedTarget && this._hideOutline(), { signal });
      document.addEventListener('click', (e) => this._onStickyClick(e), { signal, capture: true });
    } else {
      this._closeAllNotes();
    }

    document.documentElement.dataset.overnoteMode = next;
    this._syncToolbar();
    if (previous !== next) this._emit('modechange', { mode: next, previous });
    return this;
  }

  getMode() {
    return this.mode;
  }

  /** Returns a JSON-serialisable snapshot of every annotation that has at least one comment. */
  exportAnnotations() {
    const annotations = [...this.annotations.values()].filter((a) => a.comments.length);
    return {
      format: 'overnote',
      version: 1,
      url: globalThis.location?.href ?? null,
      exportedAt: nowIso(),
      annotations: JSON.parse(JSON.stringify(annotations)),
    };
  }

  /**
   * Loads annotations from exportAnnotations() output, a bare array, or a JSON string.
   * @param {object|string|Array} data
   * @param {{ merge?: boolean }} [options] merge=false clears existing annotations first.
   * @returns {{ imported: number, anchored: number, orphaned: number, skipped: number }}
   */
  importAnnotations(data, { merge = true, silent = false } = {}) {
    if (!this._initialized) this.init();
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    const list = Array.isArray(parsed) ? parsed : parsed?.annotations;
    if (!Array.isArray(list)) {
      throw new TypeError('Overnote: importAnnotations() expects an export object, an array, or a JSON string.');
    }
    if (!merge) for (const id of [...this.annotations.keys()]) this._destroyAnnotation(id);

    const result = { imported: 0, anchored: 0, orphaned: 0, skipped: 0 };
    for (const raw of list) {
      const annotation = normalizeAnnotation(raw);
      if (!annotation) {
        result.skipped++;
        continue;
      }
      if (this.annotations.has(annotation.id)) this._destroyAnnotation(annotation.id);
      this.annotations.set(annotation.id, annotation);
      result.imported++;
      if (this._mount(annotation)) result.anchored++;
      else result.orphaned++;
    }
    this._reposition();
    this._refresh();
    if (!silent) this._changed();
    return result;
  }

  /** Returns a copy of the current annotations (same shape as exportAnnotations().annotations). */
  getAnnotations() {
    return this.exportAnnotations().annotations;
  }

  deleteAnnotation(id) {
    const annotation = this.annotations.get(id);
    if (!annotation) return false;
    const wasDraft = !annotation.comments.length;
    this._destroyAnnotation(id);
    this._refresh();
    if (!wasDraft) this._changed();
    return true;
  }

  /** Scrolls to an annotation, flashes it and selects its thread. */
  focusAnnotation(id) {
    const annotation = this.annotations.get(id);
    const view = this._views.get(id);
    if (!annotation || !view) return;
    this._activate(id);
    const target = view.marks?.[0] ?? view.el;
    if (!target?.isConnected) return;
    target.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
    for (const el of view.marks?.length ? view.marks : [view.pin]) {
      el.classList.remove('overnote-flash');
      void el.offsetWidth; // restart the animation
      el.classList.add('overnote-flash');
      el.addEventListener('animationend', () => el.classList.remove('overnote-flash'), { once: true });
    }
    if (annotation.type === 'sticky' && this.mode !== MODES.OFF) this._toggleNote(id, true);
  }

  toggleSidebar(force) {
    if (!this._initialized) return this;
    const open = force ?? !this._sidebarOpen;
    this._sidebarOpen = open;
    const { sidebar, sidebarToggle } = this.ui;
    sidebar.classList.toggle('is-open', open);
    sidebar.inert = !open;
    sidebar.setAttribute('aria-hidden', String(!open));
    sidebarToggle.setAttribute('aria-expanded', String(open));
    document.documentElement.dataset.overnoteSidebar = open ? 'open' : 'closed';
    if (!open) {
      this._pruneDrafts(null, 'highlight');
      this._refresh();
    }
    return this;
  }

  /** Re-tries anchoring orphaned annotations (e.g. after a SPA renders new content). */
  refresh() {
    let recovered = 0;
    for (const [id, view] of [...this._views]) {
      if (!view.orphan) continue;
      this._unmount(id);
      if (this._mount(this.annotations.get(id))) recovered++;
    }
    this._reposition();
    this._refresh();
    return recovered;
  }

  /** Subscribe to 'change' or 'modechange'. Returns an unsubscribe function. */
  on(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    this._listeners.get(type)?.delete(fn);
    return this;
  }

  /** Removes all UI, marks and listeners. Annotation data is kept, so exportAnnotations() still works. */
  destroy() {
    if (!this._initialized) return;
    this._modeAbort?.abort();
    this._globalAbort?.abort();
    this._resizeObserver?.disconnect();
    this._mutationObserver?.disconnect();
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    for (const id of [...this._views.keys()]) this._unmount(id);
    for (const el of [this.ui.layer, this.ui.outline, this.ui.sidebar, this.ui.toolbar]) el.remove();
    delete document.documentElement.dataset.overnoteMode;
    delete document.documentElement.dataset.overnoteSidebar;
    this._initialized = false;
    this.mode = MODES.OFF;
  }

  /* ---------------- UI construction ---------------- */

  _buildUI() {
    const ui = (this.ui = {});
    const position = ['bottom-right', 'bottom-left', 'top-right', 'top-left'].includes(this.options.position)
      ? this.options.position
      : 'bottom-right';

    ui.layer = h('div', { class: 'overnote-layer', [UI_ATTR]: true });
    ui.addButton = h(
      'button',
      {
        type: 'button',
        class: 'overnote-add-comment',
        hidden: true,
        onmousedown: (e) => e.preventDefault(), // keep the selection alive
        onclick: () => this._commitSelection(),
      },
      [h('span', { class: 'overnote-icon', html: ICONS.addComment, 'aria-hidden': 'true' }), 'Add comment'],
    );
    ui.layer.append(ui.addButton);

    ui.outlineLabel = h('span', { class: 'overnote-hover-outline__label' });
    ui.outline = h('div', { class: 'overnote-hover-outline', hidden: true, [UI_ATTR]: true, 'aria-hidden': 'true' }, [ui.outlineLabel]);

    ui.modeButtons = {};
    for (const mode of Object.values(MODES)) {
      ui.modeButtons[mode] = h(
        'button',
        {
          type: 'button',
          class: 'overnote-toolbar__mode',
          'data-mode': mode,
          'aria-pressed': 'false',
          title: MODE_HINTS[mode],
          onclick: () => this.enableMode(mode),
        },
        [
          h('span', { class: 'overnote-icon', html: ICONS[mode], 'aria-hidden': 'true' }),
          h('span', { class: 'overnote-toolbar__label', text: MODE_LABELS[mode] }),
        ],
      );
    }
    ui.pill = h('span', { class: 'overnote-toolbar__pill', 'aria-hidden': 'true' });
    ui.status = h('span', { class: 'overnote-visually-hidden', 'aria-live': 'polite' });
    ui.count = h('span', { class: 'overnote-toolbar__count', text: '0' });
    ui.sidebarToggle = h(
      'button',
      {
        type: 'button',
        class: 'overnote-toolbar__threads',
        'aria-expanded': 'false',
        'aria-label': 'Toggle comments sidebar',
        title: 'Comments',
        onclick: () => this.toggleSidebar(),
      },
      [h('span', { class: 'overnote-icon', html: ICONS.comments, 'aria-hidden': 'true' }), ui.count],
    );
    ui.toolbar = h(
      'div',
      { class: `overnote-toolbar overnote-toolbar--${position}`, role: 'toolbar', 'aria-label': 'Overnote', [UI_ATTR]: true },
      [
        h('div', { class: 'overnote-toolbar__modes', role: 'group', 'aria-label': 'Annotation mode' }, [
          ui.pill,
          ...Object.values(ui.modeButtons),
        ]),
        h('span', { class: 'overnote-toolbar__divider', 'aria-hidden': 'true' }),
        ui.sidebarToggle,
        ui.status,
      ],
    );

    ui.list = h('div', { class: 'overnote-sidebar__list' });
    ui.sidebar = h('aside', { class: 'overnote-sidebar', 'aria-label': 'Comments', 'aria-hidden': 'true', [UI_ATTR]: true }, [
      h('header', { class: 'overnote-sidebar__header' }, [
        h('h2', { class: 'overnote-sidebar__title', text: 'Comments' }),
        h('button', {
          type: 'button',
          class: 'overnote-icon-btn',
          'aria-label': 'Close comments',
          html: ICONS.close,
          onclick: () => this.toggleSidebar(false),
        }),
      ]),
      ui.list,
    ]);
    ui.sidebar.inert = true;

    document.body.append(ui.layer, ui.outline, ui.sidebar, ui.toolbar);
  }

  _bindGlobalListeners() {
    this._globalAbort = new AbortController();
    const signal = this._globalAbort.signal;
    window.addEventListener('resize', () => {
      this._schedule();
      this._syncToolbar();
    }, { signal });
    document.addEventListener('scroll', () => this._schedule(), { signal, capture: true, passive: true });
    document.addEventListener('keydown', (e) => this._onKeydown(e), { signal });
    document.addEventListener('click', (e) => this._onDocumentClick(e), { signal });
    document.fonts?.ready.then(() => this._syncToolbar());

    // Targets can move without a scroll or resize (images loading, content reflowing).
    this._resizeObserver = new ResizeObserver(() => this._schedule());
    this._resizeObserver.observe(document.documentElement);
    this._mutationObserver = new MutationObserver((mutations) => {
      const external = mutations.some((m) => {
        const el = m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement;
        return !el?.closest(UI_SELECTOR);
      });
      if (external) this._schedule();
    });
    this._mutationObserver.observe(this.root, { childList: true, subtree: true, attributes: true, characterData: true });
  }

  _syncToolbar() {
    if (!this.ui) return;
    const { toolbar, modeButtons, pill, status } = this.ui;
    toolbar.dataset.mode = this.mode;
    for (const [mode, button] of Object.entries(modeButtons)) {
      const active = mode === this.mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    const active = modeButtons[this.mode];
    pill.style.width = `${active.offsetWidth}px`;
    pill.style.transform = `translateX(${active.offsetLeft}px)`;
    status.textContent = MODE_HINTS[this.mode];
  }

  /* ---------------- Rendering ---------------- */

  /** Re-renders the sidebar and every sticky note body, preserving composer focus. */
  _refresh() {
    if (!this._initialized) return;
    const focused = document.activeElement;
    const composerKey = focused?.dataset?.composer;
    const caret = composerKey ? focused.selectionStart : null;

    this._renderSidebar();
    for (const [id, view] of this._views) if (view.note) this._renderNote(id);

    if (composerKey) {
      const el = document.querySelector(`[data-composer="${CSS.escape(composerKey)}"]`);
      if (el) {
        el.focus({ preventScroll: true });
        el.setSelectionRange(caret, caret);
      }
    }
  }

  _renderSidebar() {
    const nodeOf = (a) => {
      const v = this._views.get(a.id);
      return v?.marks?.[0] ?? (v?.orphan ? null : v?.el) ?? null;
    };
    const items = [...this.annotations.values()].sort((a, b) => {
      const na = nodeOf(a);
      const nb = nodeOf(b);
      if (na && nb && na !== nb) return na.compareDocumentPosition(nb) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      if (na && !nb) return -1;
      if (!na && nb) return 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
    this.ui.list.replaceChildren(
      ...(items.length
        ? items.map((a) => this._threadCard(a))
        : [h('p', { class: 'overnote-sidebar__empty', text: 'No comments yet. Switch to Highlight or Sticky mode to start annotating.' })]),
    );
    this.ui.count.textContent = String(items.filter((a) => a.comments.length).length);
  }

  _threadCard(annotation) {
    const view = this._views.get(annotation.id);
    const orphan = !view || view.orphan;
    const classes = ['overnote-thread'];
    if (annotation.id === this._activeId) classes.push('is-active');
    if (orphan) classes.push('is-orphan');

    let context;
    if (annotation.type === 'highlight') {
      context = h('blockquote', { class: 'overnote-thread__quote', text: truncate(getSelector(annotation, 'TextQuoteSelector').exact, 200) });
    } else {
      const label = view?.el && !orphan ? describeEl(view.el) : annotation.target.tagName?.toLowerCase() ?? 'element';
      const hint = annotation.target.textHint ? ` — “${truncate(annotation.target.textHint, 60)}”` : '';
      context = h('p', { class: 'overnote-thread__target', text: `On <${label}>${hint}` });
    }

    return h(
      'article',
      {
        class: classes.join(' '),
        'data-overnote-id': annotation.id,
        onclick: (e) => {
          if (!e.target.closest('textarea, button, a')) this.focusAnnotation(annotation.id);
        },
      },
      [
        h('div', { class: 'overnote-thread__meta' }, [
          h('span', {
            class: `overnote-badge overnote-badge--${annotation.type}`,
            text: annotation.type === 'highlight' ? 'Highlight' : 'Sticky note',
          }),
          orphan && h('span', {
            class: 'overnote-badge overnote-badge--orphan',
            text: 'Not found',
            title: 'The annotated content could not be located on this page.',
          }),
        ]),
        context,
        this._threadBody(annotation, 'sidebar'),
      ],
    );
  }

  /** Comment list + composer, shared by sidebar cards and sticky notes. */
  _threadBody(annotation, where) {
    const isDraft = !annotation.comments.length;
    const comments = annotation.comments.map((c) =>
      h('li', { class: 'overnote-comment' }, [
        h('div', { class: 'overnote-comment__head' }, [
          h('span', { class: 'overnote-comment__author', text: c.author }),
          h('time', { class: 'overnote-comment__time', datetime: c.createdAt, text: formatTime(c.createdAt) }),
        ]),
        h('p', { class: 'overnote-comment__text', text: c.text }),
      ]),
    );

    const input = h('textarea', {
      class: 'overnote-composer__input',
      rows: '2',
      placeholder: isDraft ? 'Add a comment…' : 'Reply…',
      'aria-label': isDraft ? 'Comment' : 'Reply',
      'data-composer': `${where}:${annotation.id}`,
    });
    input.value = this._drafts.get(annotation.id) ?? '';
    const submit = () => this._addComment(annotation.id, input.value);
    input.addEventListener('input', () => this._drafts.set(annotation.id, input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    });

    const form = h('form', { class: 'overnote-composer', onsubmit: (e) => { e.preventDefault(); submit(); } }, [
      input,
      h('div', { class: 'overnote-composer__actions' }, [
        h('button', {
          type: 'button',
          class: 'overnote-btn overnote-btn--ghost',
          text: isDraft ? 'Cancel' : 'Delete',
          onclick: () => this.deleteAnnotation(annotation.id),
        }),
        h('button', { type: 'submit', class: 'overnote-btn overnote-btn--primary', text: isDraft ? 'Comment' : 'Reply' }),
      ]),
    ]);

    return h('div', { class: 'overnote-thread__body' }, [
      comments.length && h('ol', { class: 'overnote-comments' }, comments),
      form,
    ]);
  }

  _renderNote(id) {
    const annotation = this.annotations.get(id);
    const view = this._views.get(id);
    const count = annotation.comments.length;
    view.badge.textContent = String(count);
    view.badge.hidden = !count;
    view.pin.setAttribute('aria-label', count ? `Sticky note, ${count} comment${count === 1 ? '' : 's'}` : 'New sticky note');
    view.card.replaceChildren(
      h('div', { class: 'overnote-sticky__header' }, [
        h('span', { class: 'overnote-sticky__title', text: view.el ? `Note on ${describeEl(view.el)}` : 'Note' }),
        h('button', {
          type: 'button',
          class: 'overnote-icon-btn',
          'aria-label': 'Close note',
          html: ICONS.close,
          onclick: () => this._toggleNote(id, false),
        }),
      ]),
      this._threadBody(annotation, 'sticky'),
    );
  }

  /* ---------------- Mounting annotations onto the page ---------------- */

  _mount(annotation) {
    return annotation.type === 'highlight' ? this._mountHighlight(annotation) : this._mountSticky(annotation);
  }

  _mountHighlight(annotation, index = buildTextIndex(this.root, this._textSkip)) {
    const quote = getSelector(annotation, 'TextQuoteSelector');
    const position = getSelector(annotation, 'TextPositionSelector');
    const match =
      position && index.text.slice(position.start, position.end) === quote.exact
        ? position
        : locateQuote(index.text, quote, position?.start);
    const marks = match ? wrapOffsets(index, match.start, match.end, annotation.id) : [];
    this._views.set(annotation.id, { marks, orphan: marks.length === 0 });
    return marks.length > 0;
  }

  _mountSticky(annotation, el = resolveElement(annotation.target, this._ignoreSelector)) {
    const id = annotation.id;
    const badge = h('span', { class: 'overnote-sticky__badge', hidden: true });
    const pin = h(
      'button',
      { type: 'button', class: 'overnote-sticky__pin', 'aria-expanded': 'false', onclick: () => this._toggleNote(id) },
      [h('span', { class: 'overnote-icon', html: ICONS.sticky, 'aria-hidden': 'true' }), badge],
    );
    const card = h('div', { class: 'overnote-sticky__card', role: 'dialog', 'aria-label': 'Sticky note' });
    const note = h('div', { class: 'overnote-sticky', 'data-overnote-id': id, hidden: !el }, [pin, card]);
    this.ui.layer.append(note);
    this._views.set(id, {
      el,
      note,
      pin,
      badge,
      card,
      open: false,
      orphan: !el,
      clips: el ? scrollParents(el) : [],
      lastResolve: performance.now(),
    });
    if (el) this._resizeObserver.observe(el);
    this._renderNote(id);
    return Boolean(el);
  }

  _unmount(id) {
    const view = this._views.get(id);
    if (!view) return;
    view.marks?.forEach(unwrap);
    if (view.note) {
      view.note.remove();
      const shared = [...this._views].some(([other, v]) => other !== id && v.el === view.el);
      if (view.el && !shared) this._resizeObserver?.unobserve(view.el);
    }
    this._views.delete(id);
  }

  _destroyAnnotation(id) {
    this._unmount(id);
    this.annotations.delete(id);
    this._drafts.delete(id);
    if (this._activeId === id) this._activeId = null;
  }

  /** Removes annotations that never received a comment (abandoned drafts). */
  _pruneDrafts(keepId = null, type = null) {
    for (const [id, annotation] of [...this.annotations]) {
      if (id !== keepId && !annotation.comments.length && (!type || annotation.type === type)) this._destroyAnnotation(id);
    }
  }

  /* ---------------- Sticky note positioning ---------------- */

  _schedule() {
    if (this._raf || !this._initialized) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._reposition();
    });
  }

  /**
   * Pins every sticky note to its target. The note's anchor point is the target's bounding box
   * scaled by the stored offset (0–1), converted into the layer's coordinate space. Notes whose
   * anchor is scrolled out of a clipping ancestor are hidden; detached targets are re-resolved.
   */
  _reposition() {
    if (!this._initialized) return;
    const layer = this.ui.layer.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    let orphanStateChanged = false;

    for (const [id, view] of this._views) {
      if (!view.note) continue;
      const annotation = this.annotations.get(id);

      if (!view.el?.isConnected && performance.now() - view.lastResolve > RESOLVE_RETRY_MS) {
        view.lastResolve = performance.now();
        const el = resolveElement(annotation.target, this._ignoreSelector);
        if (el) {
          view.el = el;
          view.clips = scrollParents(el);
          this._resizeObserver.observe(el);
        }
      }
      const anchored = Boolean(view.el?.isConnected);
      if (anchored === view.orphan) {
        view.orphan = !anchored;
        orphanStateChanged = true;
      }

      const rect = anchored ? view.el.getBoundingClientRect() : null;
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        view.note.hidden = true;
        continue;
      }
      const x = rect.left + rect.width * annotation.target.offset.x;
      const y = rect.top + rect.height * annotation.target.offset.y;
      const clipped = view.clips.some((parent) => {
        const c = parent.getBoundingClientRect();
        return x < c.left - 1 || x > c.right + 1 || y < c.top - 1 || y > c.bottom + 1;
      });
      view.note.hidden = clipped;
      view.note.style.transform = `translate3d(${Math.round(x - layer.left)}px, ${Math.round(y - layer.top)}px, 0)`;

      if (view.open) {
        const cardWidth = view.card.offsetWidth;
        const cardHeight = view.card.offsetHeight;
        const spaceBelow = window.innerHeight - y;
        view.note.classList.toggle('overnote-sticky--flip-x', x + cardWidth + 24 > viewportWidth && x > cardWidth + 24);
        view.note.classList.toggle('overnote-sticky--flip-y', cardHeight + 24 > spaceBelow && y > spaceBelow);
      }
    }

    if (this._hoverEl) this._drawOutline(this._hoverEl);
    if (orphanStateChanged) this._refresh();
  }

  /* ---------------- Highlight mode ---------------- */

  _onSelectionEnd(e) {
    if (e.target?.closest?.(UI_SELECTOR)) return;
    // Let the browser finish updating the selection (e.g. a click that collapses it).
    setTimeout(() => this._evaluateSelection(), 0);
  }

  _onSelectionChange() {
    if (this.ui.addButton.hidden) return;
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed) this._hideAddButton();
  }

  _evaluateSelection() {
    if (this.mode !== MODES.HIGHLIGHT) return;
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return this._hideAddButton();
    const range = selection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    const ancestorEl = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement;
    if (!this.root.contains(ancestor) || ancestorEl?.closest(this._ignoreSelector) || !range.toString().trim()) {
      return this._hideAddButton();
    }
    this._pendingRange = range.cloneRange();
    const rects = range.getClientRects();
    this._showAddButton(rects[rects.length - 1] ?? range.getBoundingClientRect());
  }

  _showAddButton(rect) {
    const button = this.ui.addButton;
    button.hidden = false;
    const layer = this.ui.layer.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: bh } = button;
    const left = Math.min(Math.max(rect.right - w / 2, 8), document.documentElement.clientWidth - w - 8);
    const below = rect.bottom + 8;
    const top = below + bh > window.innerHeight - 8 ? rect.top - bh - 8 : below;
    // left/top rather than transform, so the entrance animation's transform doesn't fight it.
    button.style.left = `${Math.round(left - layer.left)}px`;
    button.style.top = `${Math.round(top - layer.top)}px`;
  }

  _hideAddButton() {
    if (!this.ui) return;
    this.ui.addButton.hidden = true;
    this._pendingRange = null;
  }

  _commitSelection() {
    const range = this._pendingRange;
    this._hideAddButton();
    if (!range) return;

    const index = buildTextIndex(this.root, this._textSkip);
    let start = boundaryToOffset(index, range.startContainer, range.startOffset);
    let end = boundaryToOffset(index, range.endContainer, range.endOffset);
    while (start < end && /\s/.test(index.text[start])) start++;
    while (end > start && /\s/.test(index.text[end - 1])) end--;
    if (start >= end) return;

    const annotation = {
      id: uid(),
      type: 'highlight',
      createdAt: nowIso(),
      target: {
        selector: [
          {
            type: 'TextQuoteSelector',
            exact: index.text.slice(start, end),
            prefix: index.text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
            suffix: index.text.slice(end, end + CONTEXT_LENGTH),
          },
          { type: 'TextPositionSelector', start, end },
        ],
      },
      comments: [],
    };

    this._pruneDrafts();
    this.annotations.set(annotation.id, annotation);
    this._mountHighlight(annotation, index);
    document.getSelection()?.removeAllRanges();
    this.toggleSidebar(true);
    this._activate(annotation.id);
    this._refresh();
    this.ui.list.querySelector(`[data-composer="sidebar:${CSS.escape(annotation.id)}"]`)?.focus();
  }

  /* ---------------- Sticky mode ---------------- */

  _onHover(e) {
    const el = blockTarget(e.target, this.root, this._ignoreSelector);
    if (!el) return this._hideOutline();
    if (el !== this._hoverEl) {
      this._hoverEl = el;
      this.ui.outlineLabel.textContent = describeEl(el);
    }
    this._drawOutline(el);
  }

  _drawOutline(el) {
    const { outline } = this.ui;
    if (!el.isConnected) return this._hideOutline();
    const r = el.getBoundingClientRect();
    Object.assign(outline.style, { top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px` });
    outline.classList.toggle('overnote-hover-outline--label-inside', r.top < 24);
    outline.hidden = false;
  }

  _hideOutline() {
    if (!this.ui) return;
    this.ui.outline.hidden = true;
    this._hoverEl = null;
  }

  _onStickyClick(e) {
    if (e.button !== 0 || e.target.closest?.(UI_SELECTOR)) return;
    const el = blockTarget(e.target, this.root, this._ignoreSelector);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    this._handledEvents.add(e);

    const r = el.getBoundingClientRect();
    const annotation = {
      id: uid(),
      type: 'sticky',
      createdAt: nowIso(),
      target: {
        selector: [{ type: 'CssSelector', value: cssPath(el) }],
        tagName: el.tagName,
        textHint: textSnippet(el) || undefined,
        offset: {
          x: clamp01((e.clientX - r.left) / (r.width || 1), 0),
          y: clamp01((e.clientY - r.top) / (r.height || 1), 0),
        },
      },
      comments: [],
    };

    this._closeAllNotes();
    this._pruneDrafts();
    this.annotations.set(annotation.id, annotation);
    this._mountSticky(annotation, el);
    this._reposition();
    this._refresh();
    this._toggleNote(annotation.id, true);
  }

  _toggleNote(id, force) {
    const view = this._views.get(id);
    if (!view?.note) return;
    const open = force ?? !view.open;
    if (open === view.open) {
      if (open) view.card.querySelector('textarea')?.focus({ preventScroll: true });
      return;
    }
    if (open) {
      for (const [other, v] of [...this._views]) if (other !== id && v.open) this._toggleNote(other, false);
    }
    view.open = open;
    view.note.classList.toggle('is-open', open);
    view.pin.setAttribute('aria-expanded', String(open));

    if (open) {
      this._activate(id);
      this._reposition();
      view.card.querySelector('textarea')?.focus({ preventScroll: true });
    } else if (!this.annotations.get(id)?.comments.length) {
      this._destroyAnnotation(id);
      this._refresh();
    }
  }

  _closeAllNotes() {
    for (const [id, view] of [...this._views]) if (view.open) this._toggleNote(id, false);
  }

  /* ---------------- Shared interaction ---------------- */

  _activate(id) {
    if (this._activeId && this._activeId !== id) {
      this._views.get(this._activeId)?.marks?.forEach((m) => m.classList.remove('overnote-highlight--active'));
    }
    this._pruneDrafts(id, 'highlight');
    this._activeId = id;
    this._views.get(id)?.marks?.forEach((m) => m.classList.add('overnote-highlight--active'));
    for (const card of this.ui.list.children) {
      const active = card.dataset.overnoteId === id;
      card.classList.toggle('is-active', active);
      if (active && this._sidebarOpen) card.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
  }

  _onDocumentClick(e) {
    if (this._handledEvents.has(e) || e.target.closest?.(UI_SELECTOR)) return;
    this._closeAllNotes();
    if (this.mode !== MODES.HIGHLIGHT) return;
    const mark = e.target.closest?.('.overnote-highlight');
    if (mark && document.getSelection()?.isCollapsed !== false) {
      this.toggleSidebar(true);
      this._activate(mark.dataset.overnoteId);
    }
  }

  _onKeydown(e) {
    if (e.key !== 'Escape') return;
    if (!this.ui.addButton.hidden) return this._hideAddButton();
    const open = [...this._views].find(([, v]) => v.open);
    if (open) return this._toggleNote(open[0], false);
    if (e.target.closest?.('input, textarea, [contenteditable]')) return;
    if (this._sidebarOpen) return this.toggleSidebar(false);
    if (this.mode !== MODES.OFF) this.enableMode(MODES.OFF);
  }

  _addComment(id, text) {
    const annotation = this.annotations.get(id);
    if (!annotation || !text.trim()) return;
    annotation.comments.push({ id: uid(), author: this.options.author, text: text.trim(), createdAt: nowIso() });
    annotation.updatedAt = nowIso();
    this._drafts.delete(id);
    this._refresh();
    this._changed();
  }

  /* ---------------- Events & persistence ---------------- */

  _emit(type, detail) {
    for (const fn of this._listeners.get(type) ?? []) {
      try {
        fn(detail);
      } catch (err) {
        console.error('Overnote listener error:', err);
      }
    }
  }

  _changed() {
    const data = this.exportAnnotations();
    if (this.options.storageKey) {
      try {
        localStorage.setItem(this.options.storageKey, JSON.stringify(data));
      } catch (err) {
        console.warn('Overnote: could not save to localStorage.', err);
      }
    }
    this.options.onChange?.(data);
    this._emit('change', data);
  }

  _loadFromStorage() {
    try {
      const raw = localStorage.getItem(this.options.storageKey);
      if (raw) this.importAnnotations(raw, { merge: false, silent: true });
    } catch (err) {
      console.warn('Overnote: could not load saved annotations.', err);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  document.head.append(h('style', { id: STYLE_ID, text: STYLES }));
}

// Defaults live in :where(:root) (zero specificity) so any `:root { --overnote-… }` override wins.
const STYLES = `
:where(:root) {
  --overnote-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --overnote-font-size: 13px;
  --overnote-z: 2147483000;
  --overnote-gap: 16px;
  --overnote-radius: 10px;
  --overnote-radius-sm: 6px;
  --overnote-surface: #ffffff;
  --overnote-surface-muted: #f4f4f5;
  --overnote-text: #18181b;
  --overnote-text-muted: #71717a;
  --overnote-border: rgba(24, 24, 27, 0.12);
  --overnote-shadow: 0 12px 32px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.08);
  --overnote-accent: #2563eb;
  --overnote-accent-contrast: #ffffff;
  --overnote-focus-ring: 0 0 0 3px rgba(37, 99, 235, 0.35);
  --overnote-danger: #b91c1c;
  --overnote-mode-off: #52525b;
  --overnote-mode-highlight: #d97706;
  --overnote-mode-sticky: #7c3aed;
  --overnote-highlight-bg: rgba(250, 204, 21, 0.35);
  --overnote-highlight-bg-hover: rgba(250, 204, 21, 0.55);
  --overnote-highlight-bg-active: rgba(245, 158, 11, 0.6);
  --overnote-highlight-underline: #f59e0b;
  --overnote-sticky-bg: #fef9c3;
  --overnote-sticky-header: #fde047;
  --overnote-sticky-text: #422006;
  --overnote-sticky-border: rgba(161, 98, 7, 0.35);
  --overnote-sticky-width: 264px;
  --overnote-hover-outline: #7c3aed;
  --overnote-hover-fill: rgba(124, 58, 237, 0.06);
  --overnote-sidebar-width: 340px;
}

[data-overnote-ui], [data-overnote-ui] *, [data-overnote-ui] *::before, [data-overnote-ui] *::after { box-sizing: border-box; }
[data-overnote-ui][hidden], [data-overnote-ui] [hidden] { display: none !important; }
[data-overnote-ui] :where(p, ol, ul, li, blockquote, h2, time, span, form) { font-size: inherit; line-height: inherit; font-family: inherit; }
.overnote-toolbar, .overnote-sidebar, .overnote-layer, .overnote-hover-outline {
  font-family: var(--overnote-font); font-size: var(--overnote-font-size); line-height: 1.45;
  color: var(--overnote-text); letter-spacing: normal; text-align: left; text-transform: none;
  -webkit-font-smoothing: antialiased;
}
.overnote-visually-hidden { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.overnote-icon { display: inline-flex; flex: none; width: 16px; height: 16px; }
.overnote-icon svg { width: 100%; height: 100%; }

/* Toolbar */
.overnote-toolbar {
  position: fixed; z-index: calc(var(--overnote-z) + 3); display: flex; align-items: center; gap: 4px; padding: 4px;
  background: var(--overnote-surface); border: 1px solid var(--overnote-border); border-radius: 999px;
  box-shadow: var(--overnote-shadow); transition: right .25s ease, left .25s ease;
  --overnote-current-mode: var(--overnote-mode-off);
}
.overnote-toolbar[data-mode="highlight"] { --overnote-current-mode: var(--overnote-mode-highlight); }
.overnote-toolbar[data-mode="sticky"] { --overnote-current-mode: var(--overnote-mode-sticky); }
.overnote-toolbar--bottom-right { right: var(--overnote-gap); bottom: var(--overnote-gap); }
.overnote-toolbar--bottom-left { left: var(--overnote-gap); bottom: var(--overnote-gap); }
.overnote-toolbar--top-right { right: var(--overnote-gap); top: var(--overnote-gap); }
.overnote-toolbar--top-left { left: var(--overnote-gap); top: var(--overnote-gap); }
html[data-overnote-sidebar="open"] .overnote-toolbar--bottom-right,
html[data-overnote-sidebar="open"] .overnote-toolbar--top-right { right: calc(var(--overnote-sidebar-width) + var(--overnote-gap)); }
.overnote-toolbar__modes { position: relative; display: flex; gap: 2px; }
.overnote-toolbar__pill {
  position: absolute; top: 0; bottom: 0; left: 0; border-radius: 999px; background: var(--overnote-current-mode);
  transition: transform .25s cubic-bezier(.2, .8, .2, 1), width .25s cubic-bezier(.2, .8, .2, 1), background-color .25s ease;
}
.overnote-toolbar button {
  appearance: none; margin: 0; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer;
}
.overnote-toolbar button:focus-visible { outline: none; box-shadow: var(--overnote-focus-ring); }
.overnote-toolbar .overnote-toolbar__mode {
  position: relative; z-index: 1; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px;
  border-radius: 999px; color: var(--overnote-text-muted); font-weight: 500; transition: color .2s ease;
}
.overnote-toolbar .overnote-toolbar__mode:hover { color: var(--overnote-text); }
.overnote-toolbar .overnote-toolbar__mode.is-active { color: var(--overnote-accent-contrast); }
.overnote-toolbar__divider { width: 1px; height: 20px; margin: 0 2px; background: var(--overnote-border); }
.overnote-toolbar .overnote-toolbar__threads {
  display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px 0 12px; border-radius: 999px;
}
.overnote-toolbar .overnote-toolbar__threads:hover,
.overnote-toolbar .overnote-toolbar__threads[aria-expanded="true"] { background: var(--overnote-surface-muted); }
.overnote-toolbar__count {
  display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
  background: var(--overnote-text); color: var(--overnote-surface); font-size: 11px; font-weight: 600; line-height: 1;
}

/* Highlights */
mark.overnote-highlight {
  background: var(--overnote-highlight-bg); color: inherit; padding: 0; border-radius: 2px;
  box-shadow: inset 0 -2px 0 var(--overnote-highlight-underline); cursor: pointer; transition: background-color .15s ease;
}
mark.overnote-highlight:hover { background: var(--overnote-highlight-bg-hover); }
mark.overnote-highlight.overnote-highlight--active { background: var(--overnote-highlight-bg-active); }
html[data-overnote-mode="off"] mark.overnote-highlight,
html[data-overnote-mode="off"] .overnote-sticky { pointer-events: none !important; }
html[data-overnote-mode="sticky"] mark.overnote-highlight { cursor: inherit; }
html[data-overnote-mode="sticky"] body :not([data-overnote-ui], [data-overnote-ui] *) { cursor: crosshair; }

.overnote-add-comment {
  position: absolute; top: 0; left: 0; display: inline-flex; align-items: center; gap: 6px; height: 32px; margin: 0;
  padding: 0 14px 0 12px; border: 0; border-radius: 999px; background: var(--overnote-text); color: var(--overnote-surface);
  font: 500 12px/1 var(--overnote-font); white-space: nowrap; box-shadow: var(--overnote-shadow); cursor: pointer;
  animation: overnote-pop .14s ease-out;
}
.overnote-add-comment:focus-visible { outline: none; box-shadow: var(--overnote-focus-ring); }

/* Element hover outline */
.overnote-hover-outline {
  position: fixed; z-index: var(--overnote-z); pointer-events: none; border-radius: 3px;
  outline: 2px solid var(--overnote-hover-outline); outline-offset: 2px; background: var(--overnote-hover-fill);
  transition: top .06s ease-out, left .06s ease-out, width .06s ease-out, height .06s ease-out;
}
.overnote-hover-outline__label {
  position: absolute; left: -4px; bottom: calc(100% + 6px); padding: 2px 6px; border-radius: 4px;
  background: var(--overnote-hover-outline); color: #fff; font: 500 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap;
}
.overnote-hover-outline--label-inside .overnote-hover-outline__label { bottom: auto; top: 4px; left: 4px; }

/* Sticky notes */
.overnote-layer { position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: calc(var(--overnote-z) + 1); pointer-events: none; }
.overnote-layer > * { pointer-events: auto; }
.overnote-sticky { position: absolute; top: 0; left: 0; will-change: transform; }
.overnote-sticky.is-open { z-index: 1; }
.overnote-sticky .overnote-sticky__pin {
  position: absolute; left: -14px; top: -14px; display: grid; place-items: center; width: 28px; height: 28px; margin: 0; padding: 0;
  border: 1px solid var(--overnote-sticky-border); border-radius: 6px 6px 6px 2px; background: var(--overnote-sticky-header);
  color: var(--overnote-sticky-text); box-shadow: 0 2px 8px rgba(0, 0, 0, .2); cursor: pointer; transition: transform .15s ease;
}
.overnote-sticky .overnote-sticky__pin:hover, .overnote-sticky.is-open .overnote-sticky__pin { transform: scale(1.1); }
.overnote-sticky .overnote-sticky__pin:focus-visible { outline: none; box-shadow: var(--overnote-focus-ring); }
.overnote-sticky__pin .overnote-icon { width: 14px; height: 14px; }
.overnote-sticky__badge {
  position: absolute; top: -7px; right: -7px; display: grid; place-items: center; min-width: 16px; height: 16px; padding: 0 4px;
  border-radius: 999px; background: var(--overnote-sticky-text); color: var(--overnote-sticky-bg); font-size: 10px; font-weight: 700; line-height: 1;
}
.overnote-sticky__card {
  position: absolute; top: 20px; left: 20px; display: none; flex-direction: column; width: var(--overnote-sticky-width);
  max-height: min(420px, 70vh); overflow: hidden; background: var(--overnote-sticky-bg); color: var(--overnote-sticky-text);
  border: 1px solid var(--overnote-sticky-border); border-radius: 4px; box-shadow: var(--overnote-shadow);
}
.overnote-sticky.is-open .overnote-sticky__card { display: flex; animation: overnote-pop .14s ease-out; }
.overnote-sticky--flip-x .overnote-sticky__card { left: auto; right: 20px; }
.overnote-sticky--flip-y .overnote-sticky__card { top: auto; bottom: 20px; }
.overnote-sticky__header {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 4px 4px 12px;
  background: var(--overnote-sticky-header); font-size: 12px; font-weight: 600;
}
.overnote-sticky__title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.overnote-sticky .overnote-thread__body { padding: 10px 12px 12px; overflow-y: auto; }
.overnote-sticky .overnote-comment__time { color: inherit; opacity: .7; }
.overnote-sticky .overnote-composer__input { background: rgba(255, 255, 255, .6); border-color: var(--overnote-sticky-border); color: var(--overnote-sticky-text); }
.overnote-sticky .overnote-btn--ghost { color: var(--overnote-sticky-text); border-color: var(--overnote-sticky-border); }

/* Sidebar */
.overnote-sidebar {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: calc(var(--overnote-z) + 2); display: flex; flex-direction: column;
  width: var(--overnote-sidebar-width); max-width: 100vw; background: var(--overnote-surface); border-left: 1px solid var(--overnote-border);
  box-shadow: var(--overnote-shadow); transform: translateX(100%); visibility: hidden;
  transition: transform .25s ease, visibility 0s linear .25s;
}
.overnote-sidebar.is-open { transform: none; visibility: visible; transition: transform .25s ease; }
.overnote-sidebar__header {
  display: flex; align-items: center; justify-content: space-between; padding: 12px 10px 12px 18px; border-bottom: 1px solid var(--overnote-border);
}
.overnote-sidebar .overnote-sidebar__title { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.3; color: inherit; }
.overnote-sidebar__list { flex: 1; display: flex; flex-direction: column; gap: 10px; padding: 12px; overflow-y: auto; overscroll-behavior: contain; }
.overnote-sidebar__empty { margin: 0; padding: 32px 16px; color: var(--overnote-text-muted); text-align: center; }

.overnote-thread {
  padding: 12px; border: 1px solid var(--overnote-border); border-radius: var(--overnote-radius); background: var(--overnote-surface);
  cursor: pointer; transition: border-color .15s ease, box-shadow .15s ease;
}
.overnote-thread:hover { border-color: var(--overnote-text-muted); }
.overnote-thread.is-active { border-color: var(--overnote-accent); box-shadow: 0 0 0 1px var(--overnote-accent); cursor: default; }
.overnote-thread.is-orphan { border-style: dashed; }
.overnote-thread__meta { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.overnote-badge {
  padding: 2px 6px; border-radius: 4px; background: var(--overnote-surface-muted); color: var(--overnote-text-muted);
  font-size: 10.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
}
.overnote-badge--highlight { color: var(--overnote-mode-highlight); }
.overnote-badge--sticky { color: var(--overnote-mode-sticky); }
.overnote-badge--orphan { color: var(--overnote-danger); }
.overnote-sidebar .overnote-thread__quote {
  margin: 0 0 10px; padding: 2px 0 2px 10px; border-left: 3px solid var(--overnote-highlight-underline);
  color: var(--overnote-text-muted); font-style: italic; quotes: none;
}
.overnote-sidebar .overnote-thread__target { margin: 0 0 10px; color: var(--overnote-text-muted); font-size: 12px; overflow-wrap: anywhere; }

/* Comments & composer (sidebar + sticky) */
[data-overnote-ui] .overnote-comments { display: flex; flex-direction: column; gap: 10px; margin: 0 0 10px; padding: 0; list-style: none; }
[data-overnote-ui] .overnote-comment { margin: 0; padding: 0; }
.overnote-comment__head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 6px; }
.overnote-comment__author { font-weight: 600; }
.overnote-comment__time { color: var(--overnote-text-muted); font-size: 11px; }
[data-overnote-ui] .overnote-comment__text { margin: 2px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; color: inherit; }
[data-overnote-ui] .overnote-composer { margin: 0; }
[data-overnote-ui] .overnote-composer__input {
  display: block; width: 100%; min-height: 56px; margin: 0; padding: 8px 10px; resize: vertical;
  border: 1px solid var(--overnote-border); border-radius: var(--overnote-radius-sm);
  background: var(--overnote-surface); color: var(--overnote-text); font: inherit; line-height: 1.4; box-shadow: none;
}
[data-overnote-ui] .overnote-composer__input:focus { outline: none; border-color: var(--overnote-accent); box-shadow: var(--overnote-focus-ring); }
.overnote-composer__actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
[data-overnote-ui] .overnote-btn {
  appearance: none; height: 28px; margin: 0; padding: 0 12px; border: 1px solid transparent; border-radius: var(--overnote-radius-sm);
  font: 500 12px/1 var(--overnote-font); cursor: pointer;
}
[data-overnote-ui] .overnote-btn:focus-visible { outline: none; box-shadow: var(--overnote-focus-ring); }
[data-overnote-ui] .overnote-btn--primary { background: var(--overnote-accent); color: var(--overnote-accent-contrast); }
[data-overnote-ui] .overnote-btn--primary:hover { filter: brightness(1.08); }
[data-overnote-ui] .overnote-btn--ghost { background: transparent; color: var(--overnote-text-muted); border-color: var(--overnote-border); }
[data-overnote-ui] .overnote-icon-btn {
  appearance: none; display: grid; place-items: center; width: 28px; height: 28px; margin: 0; padding: 6px;
  border: 0; border-radius: var(--overnote-radius-sm); background: transparent; color: inherit; cursor: pointer;
}
[data-overnote-ui] .overnote-icon-btn:hover { background: rgba(127, 127, 127, .16); }
[data-overnote-ui] .overnote-icon-btn:focus-visible { outline: none; box-shadow: var(--overnote-focus-ring); }
[data-overnote-ui] .overnote-icon-btn svg { width: 16px; height: 16px; }

.overnote-flash { animation: overnote-flash 1.2s ease-out; }
@keyframes overnote-flash {
  0%, 35% { outline: 3px solid var(--overnote-highlight-underline); outline-offset: 2px; }
  100% { outline: 3px solid transparent; outline-offset: 6px; }
}
@keyframes overnote-pop { from { opacity: 0; transform: translateY(4px) scale(.98); } }

@media (max-width: 560px) {
  .overnote-toolbar__label { display: none; }
  .overnote-sidebar { width: 100vw; }
  .overnote-sidebar__list { padding-bottom: 72px; }
  html[data-overnote-sidebar="open"] .overnote-toolbar--bottom-right,
  html[data-overnote-sidebar="open"] .overnote-toolbar--top-right { right: var(--overnote-gap); }
}
@media (prefers-reduced-motion: reduce) {
  [data-overnote-ui], [data-overnote-ui] *, mark.overnote-highlight { transition: none !important; animation: none !important; }
}
`;

export default Overnote;

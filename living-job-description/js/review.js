/**
 * Review layer for this page. index.html imports this module only when the URL has ?review=1,
 * so regular readers never download Overnote or these styles.
 */
import Overnote from './overnote.js';

const REVIEWER_KEY = 'living-job-description:reviewer';
const FALLBACK_AUTHOR = 'Reviewer';

function readReviewer() {
  try { return localStorage.getItem(REVIEWER_KEY); } catch { return null; }
}

function saveReviewer(name) {
  try { localStorage.setItem(REVIEWER_KEY, name); } catch { /* Storage blocked: the name lasts for this view. */ }
}

// Theme Overnote with the page's own tokens, which already switch for dark mode.
// --bg works as the on-accent colour because --real is dark green in light mode and mint in dark mode.
const theme = document.createElement('style');
theme.dataset.overnoteTheme = '';
theme.textContent = `
:root {
  --overnote-font: var(--display);
  --overnote-surface: var(--surface);
  --overnote-surface-muted: var(--bg);
  --overnote-text: var(--fg);
  --overnote-text-muted: var(--muted);
  --overnote-border: var(--line);
  --overnote-accent: var(--real);
  --overnote-accent-contrast: var(--bg);
  --overnote-mode-highlight: var(--brass);
  --overnote-mode-sticky: var(--invented);
  --overnote-hover-outline: var(--invented);
  --overnote-highlight-bg: rgba(244, 194, 27, .35);
  --overnote-highlight-bg-hover: rgba(244, 194, 27, .55);
  --overnote-highlight-bg-active: rgba(244, 194, 27, .7);
  --overnote-highlight-underline: var(--brass);
}`;
document.head.append(theme);

const overnote = new Overnote({
  root: document.body, // the story runs across header, main, the bench section and the end footer
  author: readReviewer() || FALLBACK_AUTHOR,
  position: 'bottom-right',
  ignore: '.fiction-band, input, button',
  storageKey: 'overnote-living-job-description',
}).init();

window.overnote = overnote;

// Ask for a name the first time someone starts annotating, not on load.
overnote.on('modechange', ({ mode }) => {
  if (mode === 'off' || readReviewer() !== null) return;
  const name = (window.prompt('Your name for review comments?', '') || '').trim() || FALLBACK_AUTHOR;
  saveReviewer(name);
  overnote.options.author = name;
});

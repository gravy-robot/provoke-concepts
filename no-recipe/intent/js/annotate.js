/**
 * Overnote setup (see OVERNOTE_REQUIREMENT.md). Every page loads this module once.
 * js/overnote.js is vendored unmodified: replace it to upgrade.
 */
import Overnote from './overnote.js';

const REVIEWER_KEY = 'no-recipe:reviewer';
const FALLBACK_AUTHOR = 'Reviewer';

function readReviewer() {
  try {
    return localStorage.getItem(REVIEWER_KEY);
  } catch {
    return null;
  }
}

function saveReviewer(name) {
  try {
    localStorage.setItem(REVIEWER_KEY, name);
  } catch {
    /* Storage blocked: the name lasts for this page view only. */
  }
}

const overnote = new Overnote({
  author: readReviewer() || FALLBACK_AUTHOR,
  storageKey: `overnote:${location.pathname}`, // one key per page
  ignore: '.review-tools',
  position: 'bottom-right',
});

overnote.init();
window.overnote = overnote;

// Ask for a name the first time someone starts annotating, not on load, so readers are never prompted.
overnote.on('modechange', ({ mode }) => {
  if (mode === 'off' || readReviewer() !== null) return;
  const name = (window.prompt('Your name for review comments?', '') || '').trim() || FALLBACK_AUTHOR;
  saveReviewer(name);
  overnote.options.author = name;
});

/* ---- Export and import ----------------------------------------------------------------------
 * Comments save only in this browser. Brandon and Laura swap them as a JSON file: one exports,
 * the other imports, and the two sets merge. */

function downloadJson(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function mountReviewTools() {
  const footer = document.querySelector('footer');
  if (!footer) return;

  const tools = Object.assign(document.createElement('div'), { className: 'review-tools' });
  const exportBtn = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Export comments' });
  const importBtn = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Import comments' });
  const file = Object.assign(document.createElement('input'), { type: 'file', accept: 'application/json,.json', hidden: true });
  const status = Object.assign(document.createElement('span'), { className: 'review-tools__status' });
  status.setAttribute('role', 'status');
  tools.append(exportBtn, importBtn, file, status);
  footer.append(tools);

  exportBtn.addEventListener('click', () => {
    const data = overnote.exportAnnotations();
    const count = data.annotations.reduce((n, a) => n + a.comments.length, 0);
    if (!count) {
      status.textContent = 'No comments to export yet.';
      return;
    }
    const who = (readReviewer() || FALLBACK_AUTHOR).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    downloadJson(data, `intent-comments-${who}-${data.exportedAt.slice(0, 10)}.json`);
    status.textContent = `Exported ${count} ${count === 1 ? 'comment' : 'comments'}.`;
  });

  importBtn.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const [chosen] = file.files;
    file.value = '';
    if (!chosen) return;
    try {
      const { imported, orphaned } = overnote.importAnnotations(await chosen.text(), { merge: true });
      status.textContent = `Imported ${imported} ${imported === 1 ? 'thread' : 'threads'}` +
        (orphaned ? `; ${orphaned} no longer match the page text.` : '.');
    } catch (err) {
      status.textContent = `Couldn't import that file: ${err.message}`;
    }
  });
}

mountReviewTools();

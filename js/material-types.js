// Material types keep the course map colors: PPTX navy, DOCX teal, PDF red, HTML amber.

export const DOC_TYPES = ['pptx', 'docx', 'pdf', 'html', 'other'];
export const DOC_TYPE_LABELS = { pptx: 'PPTX', docx: 'DOCX', pdf: 'PDF', html: 'HTML', other: 'LINK' };

// Guess the type from a link: Google Slides → PPTX, Google Docs → DOCX,
// github.io → HTML, or the file extension.
export function detectDocType(url) {
  const u = String(url || '').toLowerCase();
  if (/docs\.google\.com\/presentation\//.test(u)) return 'pptx';
  if (/docs\.google\.com\/document\//.test(u)) return 'docx';
  const path = u.split(/[?#]/)[0];
  if (/\.pdf$/.test(path)) return 'pdf';
  if (/\.pptx?$/.test(path)) return 'pptx';
  if (/\.docx?$/.test(path)) return 'docx';
  if (/\.github\.io\//.test(u) || /\.html?$/.test(path)) return 'html';
  return 'other';
}

// Google "/copy" links make the student their own copy.
export function makesCopy(url) {
  return /docs\.google\.com\/[^?#]+\/copy(?:[?#]|$)/i.test(String(url || ''));
}

// Copy links can't be embedded (they ask to make a copy first).
export function canEmbed(url) {
  return !makesCopy(url);
}

// Google Docs/Slides/Sheets need their /preview address to show inside a frame.
export function embedUrl(url) {
  const match = String(url).match(/^(https:\/\/docs\.google\.com\/(?:document|presentation|spreadsheets)\/d\/[^/?#]+)/);
  return match ? `${match[1]}/preview` : url;
}

export function isHttpsUrl(value) {
  return /^https:\/\/\S+$/i.test(String(value || '').trim());
}

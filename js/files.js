// The single file-handling module: prepare (shrink photos), upload with
// progress, get a link, delete. Files live in Backblaze B2; the `files`
// Edge Function checks permissions and returns short-lived links.
import { db } from './supabase.js';

const MB = 1024 * 1024;
const MAX_SIDE = 1600;        // longest side of an uploaded photo, in pixels
const JPEG_QUALITY = 0.82;    // ~400 KB for a phone photo
const KEEP_ORIGINAL_BELOW = 600 * 1024;
const LINK_LIFETIME_MS = 9 * 60 * 1000;  // links are valid 10 minutes; refresh a bit early

export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export const ACCEPT = {
  submission: `image/*,.pdf,.docx,application/pdf,${DOCX}`,
  material: `.pdf,.docx,.pptx,application/pdf,${DOCX},${PPTX},image/jpeg,image/png`,
  cover: 'image/*',
};

export const MAX_BYTES = { submission: 10 * MB, material: 25 * MB, cover: 5 * MB };

// ------------------------------------------------------------
// Edge Function calls
// ------------------------------------------------------------
async function callFiles(body) {
  const { data, error } = await db.functions.invoke('files', { body });
  if (error) {
    let message = 'The file service did not respond. Please try again.';
    try {
      const details = await error.context?.json();
      if (details?.error) message = details.error;
    } catch {
      // keep the general message
    }
    throw new Error(message);
  }
  return data;
}

// ------------------------------------------------------------
// Preparing files
// ------------------------------------------------------------
export function fileType(file) {
  if (file.type) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.docx')) return DOCX;
  if (name.endsWith('.pptx')) return PPTX;
  if (/\.jpe?g$/.test(name)) return 'image/jpeg';
  if (name.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This photo could not be opened. Please try a JPEG or PNG photo.'));
    };
    img.src = url;
  });
}

// Phone photos → about 1600px JPEG. Small JPEG/PNG files are kept as they are.
// (iPhones turn HEIC photos into JPEG when they are picked in the browser.)
async function shrinkImage(file) {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const keep = scale === 1 && file.size <= KEEP_ORIGINAL_BELOW && ['image/jpeg', 'image/png'].includes(file.type);
  if (keep) return { blob: file, type: file.type, name: file.name };

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const context = canvas.getContext('2d');
  context.fillStyle = '#FFFFFF';  // transparent PNGs get a white background
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(img, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('This photo could not be prepared.'))), 'image/jpeg', JPEG_QUALITY);
  });
  return { blob, type: 'image/jpeg', name: `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.jpg` };
}

export async function prepareFile(file) {
  const type = fileType(file);
  if (type.startsWith('image/')) return shrinkImage(file);
  return { blob: file, type, name: file.name };
}

// PUT with a progress callback (fetch can't report upload progress).
function putFile(url, blob, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
      ? resolve()
      : reject(new Error(`The upload failed (${xhr.status}). Please try again.`)));
    xhr.onerror = () => reject(new Error('The upload failed. Check your internet connection.'));
    xhr.send(blob);
  });
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

// purpose: 'submission' (with assignmentId) | 'material' | 'cover' (with classId)
// Returns { key, fileName, mimeType, size } for the database row.
export async function uploadFile({ purpose, assignmentId = null, classId = null, file, onProgress }) {
  const prepared = await prepareFile(file);
  if (prepared.blob.size > MAX_BYTES[purpose]) {
    throw new Error(`Files must be smaller than ${MAX_BYTES[purpose] / MB} MB.`);
  }
  const { key, url } = await callFiles({
    action: 'sign-upload',
    purpose,
    assignmentId,
    classId,
    fileName: prepared.name,
    contentType: prepared.type,
    size: prepared.blob.size,
  });
  await putFile(url, prepared.blob, prepared.type, onProgress);
  return { key, fileName: prepared.name, mimeType: prepared.type, size: prepared.blob.size };
}

const links = new Map();  // key → { url, expires }

function freshLink(key) {
  const cached = links.get(key);
  return cached && cached.expires > Date.now() ? cached.url : null;
}

export async function getFileUrl(key) {
  const cached = freshLink(key);
  if (cached) return cached;
  const { url } = await callFiles({ action: 'sign-download', key });
  links.set(key, { url, expires: Date.now() + LINK_LIFETIME_MS });
  return url;
}

// Best effort: a leftover file only costs storage, so failures are logged, not shown.
export async function deleteFile(key) {
  if (!key) return;
  links.delete(key);
  try {
    await callFiles({ action: 'delete', key });
  } catch (err) {
    console.warn('Could not delete file', key, err);
  }
}

// Fill in links after rendering:
//   <img data-file-src="key">       gets its src
//   <a data-file-key="key" href="#"> gets its href
export function hydrateFiles(root) {
  root.querySelectorAll('img[data-file-src]').forEach(async (img) => {
    try {
      img.src = await getFileUrl(img.dataset.fileSrc);
    } catch {
      img.classList.add('is-broken');
    }
  });
  root.querySelectorAll('a[data-file-key]').forEach(async (a) => {
    try {
      a.href = await getFileUrl(a.dataset.fileKey);
    } catch {
      // the click handler below tries again
    }
  });
}

// Call from a click handler. If the link isn't ready (or has expired), open
// a window right away (so it isn't blocked) and send it to the file.
// Returns true when it handled the click.
export function openFileLink(event) {
  const a = event.target.closest('a[data-file-key]');
  if (!a) return false;
  if (freshLink(a.dataset.fileKey)) return false;  // the href is valid: let the browser follow it
  event.preventDefault();
  const win = window.open('', '_blank');
  getFileUrl(a.dataset.fileKey)
    .then((url) => {
      a.href = url;
      if (win) win.location.href = url;
      else window.location.href = url;
    })
    .catch(() => win?.close());
  return true;
}

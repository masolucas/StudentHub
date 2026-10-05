// Join codes: 6 characters with no look-alikes (no 0/O, 1/I/L).

// A code from a QR link, kept while the student signs in.
export const PENDING_JOIN_KEY = 'folio.pendingJoin';

const JOIN_CODE_PATTERN = /^[A-HJKMNP-Z2-9]{6}$/;

export function normalizeJoinCode(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidJoinCode(code) {
  return JOIN_CODE_PATTERN.test(code);
}

// Accepts a scanned QR (a join link) or a bare code. Returns the code or null.
export function extractJoinCode(text) {
  let value = text;
  try {
    value = new URL(text).searchParams.get('code') || '';
  } catch {
    // Not a URL: treat it as the code itself.
  }
  const code = normalizeJoinCode(value);
  return isValidJoinCode(code) ? code : null;
}

// The link inside the class QR code. The phone's own camera opens it too.
export function joinUrl(code) {
  return new URL(`join.html?code=${encodeURIComponent(code)}`, window.location.href).href;
}

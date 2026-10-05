// Small UI helpers shared by every page.

// Escape text before putting it inside an HTML string.
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function errorMessage(err) {
  if (!err) return 'Something went wrong.';
  if (err instanceof TypeError || /failed to fetch|network/i.test(err.message || '')) {
    return 'Check your internet connection and try again.';
  }
  return err.message || 'Something went wrong.';
}

// localStorage can be blocked (private mode, settings); never let that break a page.
export const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

// Load a classic (non-module) library from a CDN once, only when it is needed.
const loadedScripts = new Map();
export function loadScript(src) {
  if (!loadedScripts.has(src)) {
    loadedScripts.set(src, new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => {
        loadedScripts.delete(src);
        reject(new Error(`Could not load ${src}`));
      };
      document.head.appendChild(script);
    }));
  }
  return loadedScripts.get(src);
}

// ============================================================
// TOASTS
// ============================================================
let toastStack = null;

export function showToast(message, type = 'info', durationMs = 3500) {
  if (!toastStack) {
    toastStack = document.createElement('div');
    toastStack.className = 'toast-stack';
    toastStack.setAttribute('role', 'status');
    toastStack.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastStack);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  toastStack.appendChild(toast);
  setTimeout(() => toast.remove(), durationMs);
}

// ============================================================
// MODALS
// Markup: <div class="modal-overlay" hidden><div role="dialog" aria-modal="true">…</div></div>
// Any element with [data-close] inside closes it. Escape closes it.
// Focus moves into the dialog, Tab stays inside, focus returns on close.
// ============================================================
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function openModal(overlay, { onClose, bodyClass = 'modal-open' } = {}) {
  const dialog = overlay.querySelector('[role="dialog"]');
  const returnFocus = document.activeElement;
  const focusables = () => [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);

  function close() {
    overlay.hidden = true;
    document.body.classList.remove(bodyClass);
    document.removeEventListener('keydown', onKey);
    overlay.removeEventListener('click', onClick);
    overlay.closeModal = null;
    onClose?.();
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }

  function onClick(event) {
    if (event.target === overlay || event.target.closest('[data-close]')) close();
  }

  overlay.hidden = false;
  document.body.classList.add(bodyClass);
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', onClick);
  overlay.closeModal = close;
  (dialog.querySelector('[autofocus]') || focusables()[0] || dialog).focus();
  return close;
}

export function closeModal(overlay) {
  overlay.closeModal?.();
}

// Installed-app helpers shared by every page.

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {
    // Not fatal: the site works without it, it just can't be installed or receive push.
  });
}

// True when opened from the Home Screen icon (or as an installed desktop app).
export function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

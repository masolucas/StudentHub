// Shared top navigation bar for signed-in pages.
import { displayName, signOut } from './supabase.js';
import { esc } from './ui.js';

// active: 'dashboard' | 'terms' | null
export function renderNavbar(container, profile, active = null) {
  const links = [{ key: 'dashboard', href: 'dashboard.html', label: 'My classes' }];
  if (profile?.role === 'academic') links.push({ key: 'terms', href: 'terms.html', label: 'Terms' });

  container.innerHTML = `
    <div class="navbar-inner">
      <a class="navbar-brand" href="dashboard.html">
        <img src="images/folio-mark.svg" alt="" width="32" height="32">
        <span>Folio</span>
      </a>
      <nav class="navbar-links" aria-label="Main">
        ${links.map((l) => `<a class="navbar-link" href="${l.href}"${l.key === active ? ' aria-current="page"' : ''}>${l.label}</a>`).join('')}
      </nav>
      <div class="navbar-user">
        <span class="navbar-name">${esc(displayName(profile))}</span>
        <button class="btn btn--nav btn--sm" type="button" data-sign-out aria-label="Sign out">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3"/></svg>
          <span class="navbar-signout-label">Sign out</span>
        </button>
      </div>
    </div>`;

  container.querySelector('[data-sign-out]').addEventListener('click', signOut);
}

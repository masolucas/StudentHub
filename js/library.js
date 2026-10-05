// Library tab (modeled on the legacy class library).
// Each book belongs to a week and unlocks with it. Title, author and cover
// are visible while locked; the reading link (book_links) only arrives from
// the database once the week is open to the student.
import { db } from './supabase.js';
import { esc, errorMessage, showToast, openModal, closeModal } from './ui.js';
import { formatDate, formatDateTime } from './time.js';
import { isHttpsUrl } from './material-types.js';
import { openViewer } from './viewer.js';
import { isOpenToClass, isOpenForStudent } from './week-access.js';
import { uploadFile, deleteFile, hydrateFiles } from './files.js';

const $ = (id) => document.getElementById(id);

const svg = (paths, size = 16, width = 2) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${width}" aria-hidden="true">${paths}</svg>`;
const ICON = {
  book: svg('<path d="M4 5.5C4 4.7 4.7 4 5.5 4H12v16H5.5C4.7 20 4 19.3 4 18.5zM20 5.5c0-.8-.7-1.5-1.5-1.5H12v16h6.5c.8 0 1.5-.7 1.5-1.5z"/>', 30, 1.6),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', 15, 1.8),
  open: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>', 15, 1.8),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 15, 2),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 16, 2.2),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>', 16, 2),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', 16, 2),
  eyeOff: svg('<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>', 16, 2),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>', 16, 2),
};

export function createLibraryTab(container, ctx, reload) {
  let editingId = null;

  const tz = () => ctx.cls.timezone;
  const weekById = (id) => ctx.weeks.find((w) => w.id === id);
  const bookById = (id) => ctx.books.find((b) => b.id === id);
  const weekLabel = (w) => (w.is_holiday ? 'Holiday' : `Week ${String(w.number).padStart(2, '0')}`);

  // Books in week order, then their own order inside a week.
  function sortedBooks() {
    const date = (b) => weekById(b.week_id)?.session_date ?? '';
    return [...ctx.books].sort((a, b) => date(a).localeCompare(date(b)) || a.sort_order - b.sort_order);
  }

  // ============================================================
  // OPENING A READING (also used by the Weeks tab chips)
  // ============================================================
  function openBook(bookId) {
    const book = bookById(bookId);
    const url = ctx.bookLinks.get(bookId);
    if (!book) return;
    if (!url) {
      // Locked for this student, or the teacher hasn't added a link yet.
      ctx.selectTab?.('library');
      return;
    }
    if (book.open_mode === 'embed') openViewer(book.title, url);
    else window.open(url, '_blank', 'noopener');
  }

  // ============================================================
  // RENDERING
  // ============================================================
  function render() {
    const books = sortedBooks();
    let html = '';

    if (ctx.isTeacher) {
      html += `
        <div class="weeks-toolbar">
          <button class="btn btn--primary btn--sm" type="button" data-action="add-book">${ICON.plus}<span>Add book</span></button>
          <span class="toolbar-note">Each book opens with its week.</span>
        </div>`;
    }

    if (!books.length) {
      html += `<div class="empty-state">
        <h2>${ctx.isTeacher ? 'Add your first book' : 'No books yet'}</h2>
        <p>${ctx.isTeacher ? 'Books appear here and in their week.' : 'Your teacher hasn’t added books yet.'}</p>
      </div>`;
    } else {
      html += `<div class="book-grid">${books.map(bookHtml).join('')}</div>`;
    }

    container.innerHTML = html;

    // Broken covers fall back to the designed placeholder.
    container.querySelectorAll('.book-cover-img').forEach((img) => {
      const fail = () => img.classList.add('is-broken');
      if (img.getAttribute('src') && img.complete && img.naturalWidth === 0) fail();
      else img.addEventListener('error', fail, { once: true });
    });
    // Uploaded covers get a short-lived link.
    hydrateFiles(container);
  }

  function statusHtml(book, week) {
    if (!week) return '';
    if (ctx.isTeacher) {
      if (week.is_holiday) return '<span class="book-status">Holiday week</span>';
      if (isOpenToClass(week)) return `<span class="book-status book-status--open">${ICON.open}Open</span>`;
      if (week.lock_state === 'scheduled') return `<span class="book-status">${ICON.clock}Opens ${esc(formatDateTime(week.unlock_at, tz()))}</span>`;
      return `<span class="book-status">${ICON.lock}Locked</span>`;
    }
    if (ctx.bookLinks.has(book.id)) return `<span class="book-status book-status--open">${ICON.open}Open</span>`;
    if (!week.is_holiday && week.lock_state === 'scheduled' && !isOpenForStudent(week, ctx)) {
      return `<span class="book-status">${ICON.clock}Opens ${esc(formatDateTime(week.unlock_at, tz()))}</span>`;
    }
    return `<span class="book-status">${ICON.lock}Locked</span>`;
  }

  function bookHtml(book) {
    const week = weekById(book.week_id);
    const url = ctx.bookLinks.get(book.id);
    const canRead = Boolean(url);
    const isCurrent = week && week.id === ctx.currentWeekId;
    const locked = !ctx.isTeacher && !canRead;

    const classes = ['book-card'];
    if (isCurrent) classes.push('is-current');
    if (locked) classes.push('is-locked');
    if (book.hidden) classes.push('is-hidden');

    const title = esc(book.title);
    const author = esc(book.author ?? '');
    const coverInner = `
      ${isCurrent ? '<span class="book-ribbon">This week</span>' : ''}
      <span class="book-cover-fallback">
        ${ICON.book}
        <span class="book-cover-title">${title}</span>
        ${author ? `<span class="book-cover-author">${author}</span>` : ''}
      </span>
      ${book.cover_key
        ? `<img class="book-cover-img" data-file-src="${esc(book.cover_key)}" alt="">`
        : book.cover_url ? `<img class="book-cover-img" src="${esc(book.cover_url)}" alt="" loading="lazy">` : ''}
      ${book.hidden ? '<span class="material-hidden-chip">Hidden</span>' : ''}`;

    const cover = canRead
      ? `<a class="book-cover" href="${esc(url)}" target="_blank" rel="noopener" data-action="open-book" data-book="${book.id}" aria-label="Read ${title}">${coverInner}</a>`
      : `<div class="book-cover">${coverInner}</div>`;

    let teacherBits = '';
    if (ctx.isTeacher) {
      teacherBits = `
        ${canRead ? '' : '<p class="book-note">No reading link yet.</p>'}
        <div class="material-actions book-actions">
          <button class="icon-btn icon-btn--sm" type="button" data-action="edit-book" data-book="${book.id}" aria-label="Edit ${title}">${ICON.edit}</button>
          <button class="icon-btn icon-btn--sm" type="button" data-action="toggle-book" data-book="${book.id}" aria-label="${book.hidden ? `Show ${title} to students` : `Hide ${title} from students`}">${book.hidden ? ICON.eye : ICON.eyeOff}</button>
          <button class="icon-btn icon-btn--sm icon-btn--danger" type="button" data-action="delete-book" data-book="${book.id}" aria-label="Delete ${title}">${ICON.trash}</button>
        </div>`;
    }

    return `
      <article class="${classes.join(' ')}">
        ${cover}
        <div class="book-info">
          <p class="book-week">${week ? `${weekLabel(week)} · ${formatDate(week.session_date)}` : ''}</p>
          <h3 class="book-title">${title}</h3>
          ${author ? `<p class="book-author">— ${author}</p>` : ''}
          ${statusHtml(book, week)}
          ${teacherBits}
        </div>
      </article>`;
  }

  // ============================================================
  // ADD / EDIT BOOK (teachers)
  // ============================================================
  function showFormError(message) {
    $('bookFormErrorText').textContent = message;
    $('bookFormError').hidden = false;
  }

  function openBookForm(bookId = null) {
    const book = bookId ? bookById(bookId) : null;
    editingId = bookId;

    $('bookWeek').innerHTML = ctx.weeks.map((w) => `<option value="${w.id}">${esc(weekLabel(w))} · ${formatDate(w.session_date)}</option>`).join('');
    // New books default to the first week without a book.
    const firstFree = ctx.weeks.find((w) => !w.is_holiday && !ctx.books.some((b) => b.week_id === w.id));
    $('bookFormTitle').textContent = book ? 'Edit book' : 'Add book';
    $('bookTitle').value = book?.title ?? '';
    $('bookAuthor').value = book?.author ?? '';
    $('bookWeek').value = book?.week_id ?? (firstFree ?? ctx.weeks[0]).id;
    $('bookCover').value = book?.cover_url ?? '';
    $('bookCoverFile').value = '';
    $('bookCoverRemove').checked = false;
    $('bookCoverCurrent').hidden = !book?.cover_key;
    $('bookCoverCurrent').textContent = book?.cover_key ? 'An uploaded cover is in use. Choose a new image to replace it.' : '';
    $('bookCoverRemoveRow').hidden = !book?.cover_key;
    $('bookUploadState').hidden = true;
    $('bookUrl').value = book ? (ctx.bookLinks.get(book.id) ?? '') : '';
    $('bookOpenMode').value = book?.open_mode ?? 'new_tab';
    $('bookHidden').checked = book?.hidden ?? false;
    $('bookFormError').hidden = true;
    openModal($('bookOverlay'));
  }

  async function run(request) {
    const { data, error } = await request;
    if (error) throw error;
    return data;
  }

  async function submitBookForm(event) {
    event.preventDefault();
    $('bookFormError').hidden = true;
    const title = $('bookTitle').value.trim();
    const cover = $('bookCover').value.trim();
    const url = $('bookUrl').value.trim();

    if (!title) return showFormError('Please type the title.');
    if (cover && !isHttpsUrl(cover)) return showFormError('The cover image link must start with https://');
    if (url && !isHttpsUrl(url)) return showFormError('The reading link must start with https://');

    const existing = editingId ? bookById(editingId) : null;
    const coverFile = $('bookCoverFile').files[0] ?? null;

    const button = $('bookFormSubmit');
    button.disabled = true;

    // Cover: an uploaded image wins, then a pasted link, then the current upload (unless removed).
    let upload = null;
    if (coverFile) {
      const progress = $('bookUploadState');
      progress.hidden = false;
      progress.textContent = 'Uploading… 0%';
      try {
        upload = await uploadFile({
          purpose: 'cover',
          classId: ctx.cls.id,
          file: coverFile,
          onProgress: (p) => { progress.textContent = `Uploading… ${Math.round(p * 100)}%`; },
        });
        progress.textContent = 'Uploaded ✓';
      } catch (err) {
        progress.hidden = true;
        showFormError(errorMessage(err));
        button.disabled = false;
        return;
      }
    }
    const keepOldKey = !upload && !cover && !$('bookCoverRemove').checked;
    const coverKey = upload?.key ?? (keepOldKey ? existing?.cover_key ?? null : null);

    const payload = {
      title,
      author: $('bookAuthor').value.trim() || null,
      week_id: $('bookWeek').value,
      cover_url: coverKey ? null : (cover || null),
      cover_key: coverKey,
      open_mode: $('bookOpenMode').value,
      hidden: $('bookHidden').checked,
    };

    try {
      let bookId = editingId;
      if (bookId) {
        await run(db.from('books').update(payload).eq('id', bookId));
      } else {
        const inWeek = ctx.books.filter((b) => b.week_id === payload.week_id);
        const created = await run(db.from('books')
          .insert({ ...payload, class_id: ctx.cls.id, sort_order: inWeek.length })
          .select('id').single());
        bookId = created.id;
      }
      if (url) await run(db.from('book_links').upsert({ book_id: bookId, reading_url: url }));
      else if (ctx.bookLinks.has(bookId)) await run(db.from('book_links').delete().eq('book_id', bookId));
    } catch (err) {
      if (upload) await deleteFile(upload.key);
      showFormError(errorMessage(err));
      button.disabled = false;
      return;
    }

    // The previous uploaded cover is no longer used.
    if (existing?.cover_key && existing.cover_key !== coverKey) await deleteFile(existing.cover_key);

    button.disabled = false;
    closeModal($('bookOverlay'));
    showToast(editingId ? 'Book saved.' : 'Book added.', 'success');
    await reload();
  }

  async function toggleBook(bookId) {
    const book = bookById(bookId);
    const { error } = await db.from('books').update({ hidden: !book.hidden }).eq('id', bookId);
    if (error) showToast(errorMessage(error), 'error');
    else showToast(book.hidden ? 'Students can see it now.' : 'Hidden from students.', 'success');
    await reload();
  }

  async function deleteBook(bookId) {
    const book = bookById(bookId);
    if (!window.confirm(`Delete "${book.title}"?`)) return;
    const { error } = await db.from('books').delete().eq('id', bookId);
    if (error) {
      showToast(errorMessage(error), 'error');
    } else {
      if (book.cover_key) await deleteFile(book.cover_key);
      showToast('Book deleted.', 'success');
    }
    await reload();
  }

  // ============================================================
  // EVENTS
  // ============================================================
  container.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el) return;
    const { action, book } = el.dataset;
    switch (action) {
      case 'open-book': event.preventDefault(); openBook(book); break;
      case 'add-book': openBookForm(); break;
      case 'edit-book': openBookForm(book); break;
      case 'toggle-book': toggleBook(book); break;
      case 'delete-book': deleteBook(book); break;
      default: break;
    }
  });

  if (ctx.isTeacher) $('bookForm').addEventListener('submit', submitBookForm);

  return { render, openBook };
}

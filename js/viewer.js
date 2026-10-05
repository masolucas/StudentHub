// Full-size viewer for materials and readings that open inside Folio.
// Always offers "Open full screen", because some embedded tools need it.
import { openModal } from './ui.js';
import { embedUrl } from './material-types.js';

const $ = (id) => document.getElementById(id);

export function openViewer(title, url) {
  $('viewerTitle').textContent = title;
  $('viewerFull').href = url;
  $('viewerFrame').src = embedUrl(url);
  openModal($('viewerOverlay'), {
    onClose: () => { $('viewerFrame').src = 'about:blank'; },
  });
}

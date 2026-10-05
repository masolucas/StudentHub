// Class and tag colors. The database stores the key (c1–c8); css/folio.css maps it to colors.

export const PALETTE = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'];
export const COLOR_NAMES = { c1: 'Navy', c2: 'Teal', c3: 'Plum', c4: 'Indigo', c5: 'Berry', c6: 'Slate', c7: 'Blue', c8: 'Gray' };

// Radio buttons for a color picker. Select one afterwards with checkSwatch().
export function swatchesHtml(name) {
  return PALETTE.map((key) => `
    <label class="swatch cls-${key}">
      <input type="radio" name="${name}" value="${key}">
      <span title="${COLOR_NAMES[key]}"></span>
      <span class="visually-hidden">${COLOR_NAMES[key]}</span>
    </label>`).join('');
}

export function checkSwatch(container, key) {
  const input = container.querySelector(`input[value="${key}"]`) ?? container.querySelector('input');
  input.checked = true;
}

export function checkedSwatch(container) {
  return container.querySelector('input:checked')?.value ?? PALETTE[0];
}

// First color not used yet (falls back to the first color).
export function nextFreeColor(usedKeys) {
  const used = new Set(usedKeys);
  return PALETTE.find((key) => !used.has(key)) ?? PALETTE[0];
}

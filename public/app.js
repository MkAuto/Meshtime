// Live preview of the color slider in Settings.
const hue = document.querySelector('.hue'), swatch = document.getElementById('swatch');
if (hue && swatch) hue.addEventListener('input', () => { swatch.className = `c${hue.value} swatch`; });

// New poll: collapse the server-rendered rows to one, grow a fresh one each time the last is filled,
// up to data-max (MAX_DATES in src/lib.js, also enforced on POST). Without JS the 6 static rows stay.
const dates = document.querySelector('.dates');
if (dates) {
  const rows = () => dates.querySelectorAll('input');
  for (const extra of [...rows()].slice(1)) extra.remove();
  dates.addEventListener('input', () => {
    const last = dates.lastElementChild;
    // cloneNode copies the value (spec: input cloning propagates value + dirty flag), so blank it.
    if (last.value && rows().length < Number(dates.dataset.max))
      dates.append(Object.assign(last.cloneNode(), { value: '' }));
  });
}

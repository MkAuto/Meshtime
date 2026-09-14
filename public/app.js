// Live preview of the color slider in Settings.
const hue = document.querySelector('.hue'), swatch = document.getElementById('swatch');
if (hue && swatch) hue.addEventListener('input', () => { swatch.className = `c${hue.value} swatch`; });

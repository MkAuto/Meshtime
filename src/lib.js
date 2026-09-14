// Pure helpers: no DB, no HTTP. Covered by test.js.
export const BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

export const today = () => new Date().toISOString().slice(0, 10);
export const isValidMonth = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(s || '');

export function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return false;
  const y = d.getUTCFullYear(), cy = new Date().getUTCFullYear();
  return y >= cy - 2 && y <= cy + 2;
}

export function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function monthInfo(ym) {
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  return {
    days: new Date(Date.UTC(y, m, 0)).getUTCDate(),
    pad: (first.getUTCDay() + 6) % 7, // Monday-first grid
    prev: new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7),
    next: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7),
    label: first.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  };
}

// Most "yes", then fewest "no", then earliest. votes: [{ date, answer }]
export function bestDate(dates, votes) {
  const score = Object.fromEntries(dates.map(d => [d, { yes: 0, no: 0 }]));
  for (const v of votes) if (score[v.date] && v.answer in score[v.date]) score[v.date][v.answer]++;
  return [...dates].sort((a, b) => score[b].yes - score[a].yes || score[a].no - score[b].no || a.localeCompare(b))[0];
}

// ---- ICS (RFC 5545) ----
const icsText = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsStamp = iso => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

// Fold at 75 octets; continuation lines start with a space, so 74 octets of content.
export function fold(line) {
  const parts = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (parts.length ? 74 : 75)) { parts.push(cur); cur = ch; }
    else cur += ch;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

// items: [{ uid, date 'YYYY-MM-DD', summary, stamp (ISO), transparent? }]
export function buildIcs({ name, host, items }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//free-days//EN', 'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:' + icsText(name), 'REFRESH-INTERVAL;VALUE=DURATION:PT12H', 'X-PUBLISHED-TTL:PT12H'];
  for (const it of items) {
    lines.push('BEGIN:VEVENT', `UID:${it.uid}@${host}`, 'DTSTAMP:' + icsStamp(it.stamp),
      'DTSTART;VALUE=DATE:' + it.date.replaceAll('-', ''),
      'DTEND;VALUE=DATE:' + addDays(it.date, 1).replaceAll('-', ''),
      'SUMMARY:' + icsText(it.summary));
    if (it.transparent) lines.push('TRANSP:TRANSPARENT');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

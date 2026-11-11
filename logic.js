/* Logik der Abbuchungs-App: Datumsrechnung, Rhythmen, Summen.
 * Keine Abhängigkeiten. Läuft im Browser (window.Logic) und in Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Logic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const INTERVALS = {
    weekly:     { label: 'Wöchentlich',     days: 7 },
    biweekly:   { label: 'Alle 2 Wochen',   days: 14 },
    monthly:    { label: 'Monatlich',       months: 1 },
    quarterly:  { label: 'Vierteljährlich', months: 3 },
    halfyearly: { label: 'Halbjährlich',    months: 6 },
    yearly:     { label: 'Jährlich',        months: 12 }
  };

  const CATEGORIES = {
    wohnen:       { label: 'Wohnen',             color: '#3b82f6' },
    energie:      { label: 'Energie',            color: '#eab308' },
    telefon:      { label: 'Telefon & Internet', color: '#06b6d4' },
    versicherung: { label: 'Versicherung',       color: '#8b5cf6' },
    abo:          { label: 'Abos & Medien',      color: '#ec4899' },
    mobilitaet:   { label: 'Mobilität',          color: '#f97316' },
    finanzen:     { label: 'Kredite & Sparen',   color: '#10b981' },
    sonstiges:    { label: 'Sonstiges',          color: '#64748b' }
  };

  /* ---------- Datumshilfen (ISO-Strings "JJJJ-MM-TT", rechnen über UTC-Tage, also DST-sicher) ---------- */

  function pad(n) { return String(n).padStart(2, '0'); }
  function toISO(y, m, d) { return String(y).padStart(4, '0') + '-' + pad(m) + '-' + pad(d); }

  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

  function isValidISO(s) {
    if (typeof s !== 'string') return false;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    const y = +m[1], mo = +m[2], d = +m[3];
    return y >= 1900 && y <= 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
  }

  function parseISO(s) {
    if (!isValidISO(s)) throw new Error('Ungültiges Datum: ' + s);
    return { y: +s.slice(0, 4), m: +s.slice(5, 7), d: +s.slice(8, 10) };
  }

  function dayNum(iso) { const p = parseISO(iso); return Date.UTC(p.y, p.m - 1, p.d) / 86400000; }
  function fromDayNum(n) {
    const dt = new Date(n * 86400000);
    return toISO(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  function addDays(iso, n) { return fromDayNum(dayNum(iso) + n); }
  function diffDays(a, b) { return dayNum(b) - dayNum(a); }

  function todayISO() {
    const d = new Date();
    return toISO(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  /** Wochentag, Montag = 0 … Sonntag = 6 */
  function weekday(iso) { return (new Date(dayNum(iso) * 86400000).getUTCDay() + 6) % 7; }
  function weekStart(iso) { return addDays(iso, -weekday(iso)); }

  function isoWeek(iso) {
    const n = dayNum(iso);
    const thursday = n - weekday(iso) + 3;
    const year = new Date(thursday * 86400000).getUTCFullYear();
    const jan1 = Date.UTC(year, 0, 1) / 86400000;
    return Math.floor((thursday - jan1) / 7) + 1;
  }

  function monthStart(iso) { const p = parseISO(iso); return toISO(p.y, p.m, 1); }
  function monthEnd(iso) { const p = parseISO(iso); return toISO(p.y, p.m, daysInMonth(p.y, p.m)); }
  /** Erster Tag des Monats, n Monate verschoben */
  function addMonths(iso, n) {
    const p = parseISO(iso);
    const idx = p.y * 12 + (p.m - 1) + n;
    return toISO(Math.floor(idx / 12), (idx % 12) + 1, 1);
  }

  /* ---------- Abbuchungstermine ---------- */

  /**
   * Alle Abbuchungstage eines Postens zwischen from und to (inklusive).
   * Monats-Rhythmen behalten den Tag des Ankerdatums; fehlt er in einem Monat
   * (z. B. der 31.), wird am letzten Tag des Monats gebucht.
   */
  function occurrences(item, from, to) {
    const spec = INTERVALS[item.interval];
    const out = [];
    if (!spec || from > to) return out;
    const anchor = item.anchor;
    const last = item.end && item.end < to ? item.end : to;
    if (from > last) return out;

    if (spec.days) {
      const a = dayNum(anchor), f = dayNum(from), t = dayNum(last);
      const n = f <= a ? 0 : Math.ceil((f - a) / spec.days);
      for (let d = a + n * spec.days; d <= t; d += spec.days) out.push(fromDayNum(d));
      return out;
    }

    const p = parseISO(anchor), pf = parseISO(from), pt = parseISO(last);
    const startIdx = p.y * 12 + (p.m - 1);
    const fromIdx = pf.y * 12 + (pf.m - 1);
    const toIdx = pt.y * 12 + (pt.m - 1);
    let k = fromIdx <= startIdx ? 0 : Math.ceil((fromIdx - startIdx) / spec.months);
    for (; ; k++) {
      const idx = startIdx + k * spec.months;
      if (idx > toIdx) break;
      const y = Math.floor(idx / 12), m = (idx % 12) + 1;
      const iso = toISO(y, m, Math.min(p.d, daysInMonth(y, m)));
      if (iso >= from && iso <= last && iso >= anchor) out.push(iso);
    }
    return out;
  }

  /** Alle Abbuchungen aller aktiven Posten im Zeitraum, sortiert. */
  function expand(items, from, to) {
    const out = [];
    for (const item of items) {
      if (item.active === false) continue;
      for (const date of occurrences(item, from, to)) out.push({ date, item });
    }
    out.sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 :
      b.item.amount - a.item.amount || a.item.name.localeCompare(b.item.name, 'de'));
    return out;
  }

  function groupByDate(entries) {
    const map = new Map();
    for (const e of entries) {
      if (!map.has(e.date)) map.set(e.date, []);
      map.get(e.date).push(e);
    }
    return map;
  }

  /** Summe in Euro, auf Cent genau. */
  function sum(entries) {
    let cents = 0;
    for (const e of entries) cents += Math.round(e.item.amount * 100);
    return cents / 100;
  }

  function byCategory(entries) {
    const map = new Map();
    for (const e of entries) {
      const key = CATEGORIES[e.item.category] ? e.item.category : 'sonstiges';
      const cur = map.get(key) || { key, label: CATEGORIES[key].label, color: CATEGORIES[key].color, cents: 0, count: 0 };
      cur.cents += Math.round(e.item.amount * 100);
      cur.count += 1;
      map.set(key, cur);
    }
    return [...map.values()].map(c => ({ key: c.key, label: c.label, color: c.color, total: c.cents / 100, count: c.count }))
      .sort((a, b) => b.total - a.total);
  }

  /** Betrag auf einen durchschnittlichen Monat umgerechnet. */
  function monthlyEquivalent(item) {
    const spec = INTERVALS[item.interval];
    if (!spec) return 0;
    if (spec.days) return (item.amount * (spec.days === 7 ? 52 : 26)) / 12;
    return item.amount / spec.months;
  }

  function monthlyTotal(items) {
    let total = 0;
    for (const it of items) if (it.active !== false) total += monthlyEquivalent(it);
    return Math.round(total * 100) / 100;
  }

  /* ---------- Eingaben prüfen ---------- */

  /** "1.234,56", "12,5", "12.50", "€ 9" → Zahl; sonst NaN */
  function parseAmount(input) {
    if (typeof input === 'number') return input;
    let s = String(input == null ? '' : input).replace(/[€\s ]/g, '');
    if (!s || !/^[\d.,]+$/.test(s)) return NaN;
    if (s.includes(',')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else if ((s.match(/\./g) || []).length > 1) {
      s = s.replace(/\./g, '');
    } else if (/^\d{1,3}\.\d{3}$/.test(s)) {
      s = s.replace('.', ''); // "1.234" lesen wir als Tausenderpunkt, also 1234
    }
    return /^\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN;
  }

  function newId() {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* unsicherer Kontext */ }
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /** Macht aus beliebigem Rohwert einen gültigen Posten – oder null, wenn er unbrauchbar ist. */
  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name == null ? '' : raw.name).trim();
    const amount = parseAmount(raw.amount);
    if (!name || !Number.isFinite(amount) || amount <= 0 || amount > 1e9) return null;
    if (!INTERVALS[raw.interval]) return null;
    if (!isValidISO(raw.anchor)) return null;
    const end = isValidISO(raw.end) && raw.end >= raw.anchor ? raw.end : '';
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
      name: name.slice(0, 80),
      amount: Math.round(amount * 100) / 100,
      interval: raw.interval,
      anchor: raw.anchor,
      end,
      category: CATEGORIES[raw.category] ? raw.category : 'sonstiges',
      note: String(raw.note == null ? '' : raw.note).slice(0, 200),
      active: raw.active !== false
    };
  }

  return {
    INTERVALS, CATEGORIES,
    isValidISO, parseISO, toISO, dayNum, addDays, diffDays, todayISO, weekday, weekStart, isoWeek,
    monthStart, monthEnd, addMonths, daysInMonth,
    occurrences, expand, groupByDate, sum, byCategory, monthlyEquivalent, monthlyTotal,
    parseAmount, normalizeItem, newId
  };
});

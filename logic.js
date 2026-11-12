/* Logik der Abbuchungs-App: Datumsrechnung, Rhythmen, Summen, Konten, Schulden.
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
    sonstiges:    { label: 'Sonstiges',          color: '#64748b' },
    gehalt:       { label: 'Gehalt & Rente',     color: '#16a34a' },
    einnahme:     { label: 'Sonstige Einnahmen', color: '#4ade80' }
  };
  const INCOME_CATEGORIES = ['gehalt', 'einnahme'];

  function categoryFits(key, type) {
    const inc = INCOME_CATEGORIES.indexOf(key) >= 0;
    return type === 'income' ? inc : !inc;
  }
  function categoriesFor(type) {
    return Object.keys(CATEGORIES).filter((k) => categoryFits(k, type));
  }

  /* ---------- Datumshilfen (ISO-Strings "JJJJ-MM-TT", rechnen über UTC-Tage, also DST-sicher) ---------- */

  function pad(n) { return String(n).padStart(2, '0'); }
  function toISO(y, m, d) { return String(y).padStart(4, '0') + '-' + pad(m) + '-' + pad(d); }
  function round2(x) { return Math.round(x * 100) / 100; }

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

  /* ---------- Termine eines Postens ---------- */

  /**
   * Alle Termine eines Postens zwischen from und to (inklusive).
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

  /* ---------- Buchungen (Einträge) ---------- */

  /** Betrag eines Eintrags; Einträge aus Schulden-Raten tragen einen eigenen Betrag. */
  function amt(e) { return e.amount != null ? e.amount : e.item.amount; }
  /** 'income' oder 'expense' */
  function typ(e) { return (e.type || (e.item && e.item.type)) === 'income' ? 'income' : 'expense'; }

  function compareEntries(a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 :
      amt(b) - amt(a) || a.item.name.localeCompare(b.item.name, 'de');
  }

  /** Alle Buchungen aller aktiven Posten im Zeitraum, sortiert. */
  function expand(items, from, to) {
    const out = [];
    for (const item of items) {
      if (item.active === false) continue;
      const type = item.type === 'income' ? 'income' : 'expense';
      for (const date of occurrences(item, from, to)) out.push({ date, item, amount: item.amount, type });
    }
    out.sort(compareEntries);
    return out;
  }

  /** Posten plus automatische Schulden-Raten. */
  function expandAll(items, debts, from, to) {
    const out = expand(items, from, to);
    for (const d of debts || []) for (const e of debtEntries(d, from, to)) out.push(e);
    out.sort(compareEntries);
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

  /** Summen in Euro, auf Cent genau: { expense, income, net } */
  function totals(entries) {
    let ex = 0, inc = 0;
    for (const e of entries) {
      const c = Math.round(amt(e) * 100);
      if (typ(e) === 'income') inc += c; else ex += c;
    }
    return { expense: ex / 100, income: inc / 100, net: (inc - ex) / 100 };
  }

  /** Summe der Ausgaben (Einnahmen zählen nicht mit). */
  function sum(entries) { return totals(entries).expense; }

  /** Ausgaben nach Kategorie, größte zuerst. */
  function byCategory(entries) {
    const map = new Map();
    for (const e of entries) {
      if (typ(e) === 'income') continue;
      const key = CATEGORIES[e.item.category] && categoryFits(e.item.category, 'expense') ? e.item.category : 'sonstiges';
      const cur = map.get(key) || { key, label: CATEGORIES[key].label, color: CATEGORIES[key].color, cents: 0, count: 0 };
      cur.cents += Math.round(amt(e) * 100);
      cur.count += 1;
      map.set(key, cur);
    }
    return [...map.values()].map((c) => ({ key: c.key, label: c.label, color: c.color, total: c.cents / 100, count: c.count }))
      .sort((a, b) => b.total - a.total);
  }

  /** Betrag auf einen durchschnittlichen Monat umgerechnet. */
  function monthlyEquivalent(item) {
    const spec = INTERVALS[item.interval];
    if (!spec) return 0;
    if (spec.days) return (item.amount * (spec.days === 7 ? 52 : 26)) / 12;
    return item.amount / spec.months;
  }

  /** Durchschnittliche monatliche Ausgaben der Posten. */
  function monthlyTotal(items) {
    let total = 0;
    for (const it of items) if (it.active !== false && it.type !== 'income') total += monthlyEquivalent(it);
    return Math.round(total * 100) / 100;
  }

  /** Durchschnittliche monatliche Einnahmen der Posten. */
  function monthlyIncome(items) {
    let total = 0;
    for (const it of items) if (it.active !== false && it.type === 'income') total += monthlyEquivalent(it);
    return Math.round(total * 100) / 100;
  }

  /** Durchschnitt pro Monat inklusive laufender Schulden-Raten: { expense, income, net } */
  function monthlyTotals(items, debts, asOf) {
    let ex = monthlyTotal(items), inc = monthlyIncome(items);
    for (const d of debts || []) {
      if (!d.rate || debtRemaining(d, asOf) <= 0) continue;
      const m = monthlyEquivalent({ interval: d.rate.interval, amount: d.rate.amount });
      if (d.kind === 'owed') inc += m; else ex += m;
    }
    return { expense: round2(ex), income: round2(inc), net: round2(inc - ex) };
  }

  /* ---------- Schulden ---------- */

  function paidCents(debt) {
    let c = 0;
    for (const p of debt.payments || []) c += Math.round(p.amount * 100);
    return c;
  }

  /** Die Rate einer Schuld als Posten (für Kalender, Woche, Monat, Konto). */
  function debtItem(debt) {
    const r = debt.rate;
    const owe = debt.kind !== 'owed';
    return {
      id: 'debt:' + debt.id, debtId: debt.id, name: debt.name + ' (Rate)',
      amount: r.amount, interval: r.interval, anchor: r.anchor, end: '',
      category: owe ? 'finanzen' : 'einnahme', note: '', active: true,
      type: owe ? 'expense' : 'income', account: r.account || ''
    };
  }

  /**
   * Automatische Raten einer Schuld im Zeitraum. Die Rate zählt ab ihrem Startdatum und endet,
   * sobald Gesamtbetrag minus Teilzahlungen erreicht ist; die letzte Rate fällt ggf. kleiner aus.
   */
  function debtEntries(debt, from, to) {
    if (!debt || !debt.rate || from > to) return [];
    const it = debtItem(debt);
    let remaining = Math.round(debt.total * 100) - paidCents(debt);
    if (remaining <= 0) return [];
    const rateC = Math.round(it.amount * 100);
    if (rateC <= 0) return [];
    const out = [];
    for (const date of occurrences(it, it.anchor, to)) {
      if (remaining <= 0) break;
      const pay = Math.min(rateC, remaining);
      remaining -= pay;
      if (date >= from) out.push({ date, item: it, amount: pay / 100, type: it.type });
    }
    return out;
  }

  /** Was von der Schuld am Stichtag noch offen ist (Euro). */
  function debtRemaining(debt, asOf) {
    let c = Math.round(debt.total * 100) - paidCents(debt);
    if (debt.rate && c > 0) {
      for (const e of debtEntries(debt, debt.rate.anchor, asOf)) c -= Math.round(e.amount * 100);
    }
    return Math.max(0, c) / 100;
  }

  /** Datum der letzten Rate (ISO) oder '' ohne Rate, ohne Rest oder bei über 100 Jahren Laufzeit. */
  function debtPayoffDate(debt) {
    if (!debt.rate) return '';
    const left = Math.round(debt.total * 100) - paidCents(debt);
    const rateC = Math.round(debt.rate.amount * 100);
    if (left <= 0 || rateC <= 0) return '';
    const n = Math.ceil(left / rateC);
    const it = debtItem(debt);
    const spec = INTERVALS[it.interval];
    if (n > 1200) return '';
    const end = spec.days ? addDays(it.anchor, (n - 1) * spec.days) : monthEnd(addMonths(it.anchor, (n - 1) * spec.months));
    const occ = occurrences(it, it.anchor, end);
    return occ.length ? occ[occ.length - 1] : '';
  }

  /* ---------- Konten ---------- */

  /** Konto eines Eintrags: das gewählte, sonst das erste Konto. */
  function effectiveAccountId(id, accounts) {
    if (id && accounts.some((a) => a.id === id)) return id;
    return accounts.length ? accounts[0].id : '';
  }

  /**
   * Kontostand am Stichtag: Startwert plus alle Einnahmen minus Ausgaben nach dem Startdatum
   * (das Startdatum selbst ist im Startwert schon enthalten).
   */
  function accountBalance(acc, accounts, items, debts, asOf) {
    if (asOf <= acc.date) return round2(acc.balance);
    let cents = Math.round(acc.balance * 100);
    for (const e of expandAll(items, debts, addDays(acc.date, 1), asOf)) {
      if (effectiveAccountId(e.item.account, accounts) !== acc.id) continue;
      cents += (typ(e) === 'income' ? 1 : -1) * Math.round(amt(e) * 100);
    }
    return cents / 100;
  }

  /**
   * Verlauf einer Kontengruppe von from bis to: { start, end, min, minDate }.
   * min ist der tiefste Stand im Zeitraum, minDate der Tag, an dem er erreicht wird.
   */
  function forecast(accs, accounts, items, debts, from, to) {
    let startC = 0;
    const delta = new Map();
    for (const acc of accs) {
      startC += Math.round(accountBalance(acc, accounts, items, debts, from) * 100);
      const lo = addDays(from < acc.date ? acc.date : from, 1);
      if (lo > to) continue;
      for (const e of expandAll(items, debts, lo, to)) {
        if (effectiveAccountId(e.item.account, accounts) !== acc.id) continue;
        const c = Math.round(amt(e) * 100) * (typ(e) === 'income' ? 1 : -1);
        delta.set(e.date, (delta.get(e.date) || 0) + c);
      }
    }
    let cur = startC, min = startC, minDate = from;
    for (const d of [...delta.keys()].sort()) {
      cur += delta.get(d);
      if (cur < min) { min = cur; minDate = d; }
    }
    return { start: startC / 100, end: cur / 100, min: min / 100, minDate };
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

  /** Wie parseAmount, erlaubt aber ein Minus am Anfang (Kontostand im Minus). */
  function parseSignedAmount(input) {
    if (typeof input === 'number') return input;
    let s = String(input == null ? '' : input).trim().replace(/−/g, '-');
    let neg = false;
    if (s[0] === '-') { neg = true; s = s.slice(1); } else if (s[0] === '+') { s = s.slice(1); }
    const v = parseAmount(s);
    return Number.isFinite(v) ? (neg ? -v : v) : NaN;
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
    const type = raw.type === 'income' ? 'income' : 'expense';
    const end = isValidISO(raw.end) && raw.end >= raw.anchor ? raw.end : '';
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
      name: name.slice(0, 80),
      type,
      amount: round2(amount),
      interval: raw.interval,
      anchor: raw.anchor,
      end,
      category: CATEGORIES[raw.category] && categoryFits(raw.category, type) ? raw.category : (type === 'income' ? 'einnahme' : 'sonstiges'),
      account: typeof raw.account === 'string' ? raw.account : '',
      note: String(raw.note == null ? '' : raw.note).slice(0, 200),
      active: raw.active !== false
    };
  }

  function normalizeAccount(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name == null ? '' : raw.name).trim();
    const balance = parseSignedAmount(raw.balance);
    if (!name || !Number.isFinite(balance) || Math.abs(balance) > 1e12) return null;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
      name: name.slice(0, 60),
      balance: round2(balance),
      date: isValidISO(raw.date) ? raw.date : todayISO()
    };
  }

  function normalizeDebt(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name == null ? '' : raw.name).trim();
    const total = parseAmount(raw.total);
    if (!name || !Number.isFinite(total) || total <= 0 || total > 1e9) return null;
    const payments = (Array.isArray(raw.payments) ? raw.payments : []).map((p) => {
      if (!p || !isValidISO(p.date)) return null;
      const a = parseAmount(p.amount);
      if (!Number.isFinite(a) || a <= 0 || a > 1e9) return null;
      return { id: typeof p.id === 'string' && p.id ? p.id : newId(), date: p.date, amount: round2(a) };
    }).filter(Boolean);
    let rate = null;
    if (raw.rate && typeof raw.rate === 'object') {
      const ra = parseAmount(raw.rate.amount);
      if (Number.isFinite(ra) && ra > 0 && ra <= 1e9 && INTERVALS[raw.rate.interval] && isValidISO(raw.rate.anchor)) {
        rate = {
          amount: round2(ra), interval: raw.rate.interval, anchor: raw.rate.anchor,
          account: typeof raw.rate.account === 'string' ? raw.rate.account : ''
        };
      }
    }
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
      kind: raw.kind === 'owed' ? 'owed' : 'owe',
      name: name.slice(0, 80),
      total: round2(total),
      payments,
      rate,
      note: String(raw.note == null ? '' : raw.note).slice(0, 200)
    };
  }

  return {
    INTERVALS, CATEGORIES, INCOME_CATEGORIES, categoryFits, categoriesFor,
    isValidISO, parseISO, toISO, dayNum, addDays, diffDays, todayISO, weekday, weekStart, isoWeek,
    monthStart, monthEnd, addMonths, daysInMonth, round2,
    occurrences, expand, expandAll, groupByDate, totals, sum, byCategory,
    monthlyEquivalent, monthlyTotal, monthlyIncome, monthlyTotals,
    debtItem, debtEntries, debtRemaining, debtPayoffDate,
    effectiveAccountId, accountBalance, forecast,
    parseAmount, parseSignedAmount, normalizeItem, normalizeAccount, normalizeDebt, newId
  };
});

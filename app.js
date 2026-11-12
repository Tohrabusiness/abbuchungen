/* Abbuchungen – Oberfläche. Daten bleiben lokal im Browser (IndexedDB). */
(function () {
  'use strict';

  const L = window.Logic;
  const $ = (sel, root) => (root || document).querySelector(sel);

  /* ---------- kleine Helfer ---------- */

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
        else if (v === true) n.setAttribute(k, '');
        else n.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }

  const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  const fmtDayShort = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
  const fmtDayLong = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtMonth = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' });
  const fmtMonthShort = new Intl.DateTimeFormat('de-DE', { month: '2-digit', year: 'numeric' });
  const fmtDM = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });
  const fmtDMY = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const fmtWeekday = new Intl.DateTimeFormat('de-DE', { weekday: 'long' });

  function dateOf(iso) { const p = L.parseISO(iso); return new Date(p.y, p.m - 1, p.d); }
  const money = (n) => eur.format(L.round2(n) === 0 ? 0 : n);
  function signed(n) {
    const r = L.round2(n);
    if (r > 0) return '+' + money(r);
    if (r < 0) return '−' + money(-r);
    return money(0);
  }
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const signClass = (n) => (L.round2(n) > 0 ? 'inc' : L.round2(n) < 0 ? 'neg' : '');

  function compact(n) {
    if (n >= 1000) return (Math.round(n / 100) / 10).toLocaleString('de-DE') + 'k';
    return Math.round(n).toLocaleString('de-DE');
  }
  function compactSigned(n) {
    const r = L.round2(n);
    return (r > 0 ? '+' : r < 0 ? '−' : '') + compact(Math.abs(r));
  }

  function relativeDay(iso, today) {
    const d = L.diffDays(today, iso);
    if (d === 0) return 'Heute';
    if (d === 1) return 'Morgen';
    return 'in ' + d + ' Tagen';
  }

  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  /* ---------- Speicher (IndexedDB, Version 2: Posten, Konten, Schulden) ---------- */

  const DB = (function () {
    const NAME = 'abbuchungen';
    const STORES = ['items', 'accounts', 'debts'];
    let opened = null;

    function open() {
      if (!opened) {
        opened = new Promise((resolve, reject) => {
          if (!window.indexedDB) { reject(new Error('IndexedDB nicht verfügbar')); return; }
          const req = indexedDB.open(NAME, 2);
          // Aus Version 1 (nur Posten) wird hier ergänzt, vorhandene Daten bleiben unberührt.
          req.onupgradeneeded = () => {
            const db = req.result;
            for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          req.onblocked = () => reject(new Error('Datenbank ist von einem anderen Fenster blockiert'));
        });
      }
      return opened;
    }

    async function run(store, mode, fn) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const os = tx.objectStore(store);
        let result;
        const req = fn(os);
        if (req) req.onsuccess = () => { result = req.result; };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Abgebrochen'));
      });
    }

    return {
      all: (store) => run(store, 'readonly', (s) => s.getAll()),
      put: (store, obj) => run(store, 'readwrite', (s) => s.put(obj)),
      putMany: (store, list) => run(store, 'readwrite', (s) => { list.forEach((i) => s.put(i)); }),
      remove: (store, id) => run(store, 'readwrite', (s) => s.delete(id)),
      clearAll: async () => {
        const db = await open();
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORES, 'readwrite');
          STORES.forEach((n) => tx.objectStore(n).clear());
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error('Abgebrochen'));
        });
      }
    };
  })();

  /* ---------- Zustand ---------- */

  const state = {
    items: [],
    accounts: [],
    debts: [],
    view: 'overview',
    weekRef: L.todayISO(),
    monthRef: L.monthStart(L.todayISO()),
    selDay: L.todayISO(),
    storageOk: true
  };

  const TITLES = { overview: 'Übersicht', week: 'Woche', month: 'Monat', items: 'Posten', accounts: 'Konten', debts: 'Schulden' };

  function setView(v) {
    state.view = v;
    render();
    window.scrollTo(0, 0);
  }

  function accountName(id) {
    const a = state.accounts.find((x) => x.id === L.effectiveAccountId(id, state.accounts));
    return a ? a.name : '';
  }

  async function persist(action) {
    try { await action(); state.storageOk = true; return true; }
    catch (e) { state.storageOk = false; console.error(e); return false; }
  }

  /* ---------- Bausteine ---------- */

  function scheduleText(it) {
    const p = L.parseISO(it.anchor);
    const wd = fmtWeekday.format(dateOf(it.anchor));
    switch (it.interval) {
      case 'weekly': return 'Jeden ' + wd;
      case 'biweekly': return 'Alle 2 Wochen, ' + wd;
      case 'monthly': return 'Monatlich am ' + p.d + '.';
      case 'quarterly': return 'Alle 3 Monate am ' + p.d + '.';
      case 'halfyearly': return 'Alle 6 Monate am ' + p.d + '.';
      case 'yearly': return 'Jährlich am ' + fmtDM.format(dateOf(it.anchor));
      default: return '';
    }
  }

  function defaultSub(it) {
    const cat = L.CATEGORIES[it.category] || L.CATEGORIES.sonstiges;
    const parts = [cat.label];
    if (state.accounts.length > 1) { const n = accountName(it.account); if (n) parts.push(n); }
    return parts.join(' · ');
  }

  function entryRow(entry, sub) {
    const it = entry.item;
    const income = entry.type === 'income';
    const cat = L.CATEGORIES[it.category] || L.CATEGORIES.sonstiges;
    const open = () => (it.debtId ? openDebt(it.debtId) : openItem(it.id));
    return el('button', { class: 'row', type: 'button', onclick: open },
      el('span', { class: 'dot', style: 'background:' + cat.color }),
      el('span', { class: 'row-main' },
        el('span', { class: 'row-title', text: it.name }),
        el('span', { class: 'row-sub', text: sub != null ? sub : defaultSub(it) })),
      el('span', { class: 'amount' + (income ? ' inc' : ''), text: (income ? '+' : '') + money(entry.amount) }));
  }

  function pager(label, sub, onPrev, onNext, onToday, showToday) {
    return el('div', { class: 'pager' },
      el('button', { type: 'button', 'aria-label': 'Zurück', onclick: onPrev, text: '‹' }),
      el('div', { class: 'mid' }, el('b', { text: label }), el('span', { text: sub })),
      showToday ? el('button', { type: 'button', class: 'today', onclick: onToday, text: 'Heute' }) : null,
      el('button', { type: 'button', 'aria-label': 'Weiter', onclick: onNext, text: '›' }));
  }

  function card(label, value, sub, opts) {
    opts = opts || {};
    return el('div', { class: 'card' + (opts.wide ? ' wide' : '') },
      el('div', { class: 'card-label', text: label }),
      el('div', { class: 'card-value' + (opts.cls ? ' ' + opts.cls : ''), text: value }),
      sub ? el('div', { class: 'card-sub', text: sub }) : null,
      opts.extra || null);
  }

  function sumBar(t) {
    return el('div', { class: 'sumbar' },
      el('div', null, el('span', { text: 'Ausgaben' }), el('b', { text: money(t.expense) })),
      el('div', null, el('span', { text: 'Einnahmen' }), el('b', { class: t.income ? 'inc' : '', text: (t.income ? '+' : '') + money(t.income) })),
      el('div', null, el('span', { text: 'Saldo' }), el('b', { class: signClass(t.net), text: signed(t.net) })));
  }

  function emptyHero() {
    return el('div', { class: 'empty-hero' },
      el('h2', { text: 'Noch nichts eingetragen' }),
      el('p', { text: 'Lege deine wiederkehrenden Abbuchungen und Einnahmen an, z. B. Miete, Gehalt oder Abos.' }),
      el('button', { type: 'button', class: 'btn primary', onclick: () => openItem(null), text: 'Ersten Posten anlegen' }));
  }

  function lowNote(f) {
    return f.min < 0 && f.start >= 0 ? ' · unter 0 € am ' + fmtDM.format(dateOf(f.minDate)) : '';
  }

  /* ---------- Ansichten ---------- */

  function viewOverview() {
    const root = el('div');
    if (!state.items.length && !state.accounts.length && !state.debts.length) { root.append(emptyHero()); return root; }

    const today = L.todayISO();
    const ws = L.weekStart(today), we = L.addDays(ws, 6);
    const ms = L.monthStart(today), me = L.monthEnd(today);
    const weekEntries = L.expandAll(state.items, state.debts, ws, we);
    const monthEntries = L.expandAll(state.items, state.debts, ms, me);
    const wt = L.totals(weekEntries), mt = L.totals(monthEntries);
    const paid = L.totals(monthEntries.filter((e) => e.date <= today));
    const openEx = L.round2(mt.expense - paid.expense);
    const share = mt.expense > 0 ? Math.round((paid.expense / mt.expense) * 100) : 0;
    const avg = L.monthlyTotals(state.items, state.debts, today);

    const cards = el('section', { class: 'cards' });

    if (state.accounts.length) {
      const f = L.forecast(state.accounts, state.accounts, state.items, state.debts, today, L.addDays(today, 30));
      cards.append(card('Kontostand gesamt', money(f.start), 'In 30 Tagen: ' + money(f.end) + lowNote(f),
        { wide: true, cls: f.start < 0 ? 'neg' : '' }));
    } else {
      cards.append(card('Kontostand', 'Noch kein Konto', 'Mit einem Konto rechnet die App Einnahmen und Abbuchungen automatisch mit.',
        { wide: true, extra: el('button', { type: 'button', class: 'btn small', onclick: () => openAccount(null), text: 'Konto anlegen' }) }));
    }

    cards.append(
      card('Diese Woche', money(wt.expense), 'Einnahmen ' + (wt.income ? '+' : '') + money(wt.income) + ' · KW ' + L.isoWeek(today)),
      card(fmtMonth.format(dateOf(today)).split(' ')[0], money(mt.expense), 'Einnahmen ' + (mt.income ? '+' : '') + money(mt.income)),
      card('Stand im Monat', share + ' %', 'Schon abgebucht: ' + money(paid.expense) + ' · Noch offen: ' + money(openEx),
        { wide: true, extra: el('div', { class: 'meter', role: 'img', 'aria-label': share + ' Prozent der Ausgaben des Monats bereits abgebucht' }, el('i', { style: 'width:' + share + '%' })) }),
      card('Übrig pro Monat (Durchschnitt)', signed(avg.net),
        'Einnahmen ' + money(avg.income) + ' minus Ausgaben ' + money(avg.expense) + '. Jahresbeiträge sind auf den Monat umgerechnet.',
        { wide: true, cls: signClass(avg.net) }));

    if (state.debts.length) {
      let owe = 0, owed = 0;
      for (const d of state.debts) {
        const r = L.debtRemaining(d, today);
        if (d.kind === 'owed') owed += r; else owe += r;
      }
      cards.append(
        card('Du schuldest', money(owe), plural(state.debts.filter((d) => d.kind !== 'owed' && L.debtRemaining(d, today) > 0).length, 'offene Schuld', 'offene Schulden'), { cls: owe > 0 ? 'neg' : '' }),
        card('Dir geschuldet', money(owed), plural(state.debts.filter((d) => d.kind === 'owed' && L.debtRemaining(d, today) > 0).length, 'offener Betrag', 'offene Beträge'), { cls: owed > 0 ? 'inc' : '' }));
    }
    root.append(cards);

    const upcoming = L.expandAll(state.items, state.debts, today, L.addDays(today, 60)).slice(0, 8);
    root.append(el('h2', { class: 'section', text: 'Als Nächstes fällig' }));
    if (!upcoming.length) {
      root.append(el('div', { class: 'list' }, el('div', { class: 'empty', text: 'In den nächsten 60 Tagen steht nichts an.' })));
    } else {
      root.append(el('div', { class: 'list' },
        upcoming.map((e) => entryRow(e, fmtDayShort.format(dateOf(e.date)) + ' · ' + relativeDay(e.date, today)))));
    }
    return root;
  }

  function viewWeek() {
    const today = L.todayISO();
    const start = L.weekStart(state.weekRef), end = L.addDays(start, 6);
    const entries = L.expandAll(state.items, state.debts, start, end);
    const byDay = L.groupByDate(entries);
    const isCurrent = start === L.weekStart(today);
    const root = el('div');

    root.append(pager(
      'KW ' + L.isoWeek(start),
      fmtDM.format(dateOf(start)) + ' – ' + fmtDMY.format(dateOf(end)),
      () => { state.weekRef = L.addDays(start, -7); render(); },
      () => { state.weekRef = L.addDays(start, 7); render(); },
      () => { state.weekRef = today; render(); },
      !isCurrent));

    root.append(sumBar(L.totals(entries)));

    if (!state.items.length && !state.debts.length) root.append(emptyHero());

    for (let i = 0; i < 7; i++) {
      const day = L.addDays(start, i);
      const list = byDay.get(day) || [];
      const dt = L.totals(list);
      root.append(el('section', { class: 'day' + (day === today ? ' is-today' : '') },
        el('div', { class: 'day-head' },
          el('span', { text: fmtDayShort.format(dateOf(day)) }),
          el('small', { class: dt.net > 0 ? 'pos' : '', text: list.length ? signed(dt.net) : '' })),
        el('div', { class: 'list' },
          list.length ? list.map((e) => entryRow(e)) : el('div', { class: 'empty', text: 'Keine Buchungen' }))));
    }
    return root;
  }

  function viewMonth() {
    const today = L.todayISO();
    const ms = L.monthStart(state.monthRef), me = L.monthEnd(ms);
    if (!(state.selDay >= ms && state.selDay <= me)) state.selDay = (today >= ms && today <= me) ? today : ms;

    const entries = L.expandAll(state.items, state.debts, ms, me);
    const byDay = L.groupByDate(entries);
    const isCurrent = ms === L.monthStart(today);
    const root = el('div');

    root.append(pager(
      fmtMonth.format(dateOf(ms)),
      plural(entries.length, 'Buchung', 'Buchungen'),
      () => { state.monthRef = L.addMonths(ms, -1); render(); },
      () => { state.monthRef = L.addMonths(ms, 1); render(); },
      () => { state.monthRef = L.monthStart(today); state.selDay = today; render(); },
      !isCurrent));

    root.append(sumBar(L.totals(entries)));

    root.append(el('div', { class: 'dow' }, ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((d) => el('span', { text: d }))));

    const grid = el('div', { class: 'grid' });
    const offset = L.weekday(ms);
    for (let i = 0; i < offset; i++) grid.append(el('span', { class: 'cell blank' }));
    const days = L.parseISO(me).d;
    for (let d = 1; d <= days; d++) {
      const iso = L.addDays(ms, d - 1);
      const list = byDay.get(iso) || [];
      const dt = L.totals(list);
      const cats = [...new Set(list.map((e) => e.item.category))].slice(0, 3);
      const cls = 'cell' + (iso === today ? ' today' : '') + (iso === state.selDay ? ' sel' : '') + (list.length ? ' has' : '');
      grid.append(el('button', {
        type: 'button', class: cls,
        'aria-label': fmtDayLong.format(dateOf(iso)) + (list.length ? ', Saldo ' + signed(dt.net) : ', keine Buchungen'),
        onclick: () => { state.selDay = iso; render(); }
      },
        el('span', { class: 'n', text: String(d) }),
        el('span', { class: 'sum' + (dt.net > 0 ? ' pos' : ''), text: list.length ? compactSigned(dt.net) : '' }),
        el('span', { class: 'dots' }, cats.map((c) => el('i', { style: 'background:' + (L.CATEGORIES[c] || L.CATEGORIES.sonstiges).color })))));
    }
    root.append(grid);

    const sel = byDay.get(state.selDay) || [];
    const st = L.totals(sel);
    root.append(el('h2', { class: 'section', text: fmtDayLong.format(dateOf(state.selDay)) + (sel.length ? ' · ' + signed(st.net) : '') }));
    root.append(el('div', { class: 'list' },
      sel.length ? sel.map((e) => entryRow(e)) : el('div', { class: 'empty', text: 'Keine Buchungen an diesem Tag' })));

    const cats = L.byCategory(entries);
    if (cats.length) {
      const total = L.totals(entries).expense;
      root.append(el('h2', { class: 'section', text: 'Ausgaben nach Kategorie' }));
      root.append(el('div', { class: 'list' }, el('div', { class: 'bars' }, cats.map((c) =>
        el('div', { class: 'bar' },
          el('div', { class: 'bar-top' },
            el('span', null, el('i', { class: 'dot', style: 'background:' + c.color }), c.label),
            el('span', { text: money(c.total) })),
          el('div', { class: 'bar-track' }, el('i', { style: 'width:' + Math.max(2, Math.round((c.total / total) * 100)) + '%;background:' + c.color })))))));
    }
    return root;
  }

  function itemRow(it) {
    const cat = L.CATEGORIES[it.category] || L.CATEGORIES.sonstiges;
    const income = it.type === 'income';
    const parts = [scheduleText(it)];
    if (it.end) parts.push('bis ' + fmtDMY.format(dateOf(it.end)));
    if (state.accounts.length > 1) { const n = accountName(it.account); if (n) parts.push(n); }
    if (it.active === false) parts.push('pausiert');
    return el('button', { class: 'row' + (it.active === false ? ' paused' : ''), type: 'button', onclick: () => openItem(it.id) },
      el('span', { class: 'dot', style: 'background:' + cat.color }),
      el('span', { class: 'row-main' },
        el('span', { class: 'row-title', text: it.name }),
        el('span', { class: 'row-sub', text: parts.join(' · ') })),
      el('span', { class: 'amount' + (income ? ' inc' : ''), text: (income ? '+' : '') + money(it.amount) }));
  }

  function viewItems() {
    const root = el('div');
    if (!state.items.length) { root.append(emptyHero()); }
    else {
      const byName = (a, b) => a.name.localeCompare(b.name, 'de');
      const expenses = state.items.filter((i) => i.type !== 'income').sort(byName);
      const incomes = state.items.filter((i) => i.type === 'income').sort(byName);
      if (expenses.length) {
        root.append(el('h2', { class: 'section', text: 'Ausgaben · Ø ' + money(L.monthlyTotal(state.items)) + ' pro Monat' }));
        root.append(el('div', { class: 'list' }, expenses.map(itemRow)));
      }
      if (incomes.length) {
        root.append(el('h2', { class: 'section', text: 'Einnahmen · Ø ' + money(L.monthlyIncome(state.items)) + ' pro Monat' }));
        root.append(el('div', { class: 'list' }, incomes.map(itemRow)));
      }
    }
    root.append(el('div', { style: 'margin-top:18px' },
      el('button', { type: 'button', class: 'btn', onclick: openData, text: 'Daten sichern & übertragen' })));
    root.append(el('p', { class: 'footnote', text: 'Alle Angaben bleiben auf diesem Gerät. Sie werden nirgendwo hochgeladen.' }));
    return root;
  }

  function viewAccounts() {
    const root = el('div');
    if (!state.accounts.length) {
      root.append(el('div', { class: 'empty-hero' },
        el('h2', { text: 'Noch kein Konto' }),
        el('p', { text: 'Lege Girokonto, Sparkonto oder Bargeld mit dem heutigen Stand an. Die App rechnet Einnahmen und Abbuchungen danach automatisch mit.' }),
        el('button', { type: 'button', class: 'btn primary', onclick: () => openAccount(null), text: 'Erstes Konto anlegen' })));
      return root;
    }
    const today = L.todayISO();
    const horizon = L.addDays(today, 30);
    const total = L.forecast(state.accounts, state.accounts, state.items, state.debts, today, horizon);

    root.append(el('section', { class: 'cards' },
      card('Gesamt heute', money(total.start), 'In 30 Tagen: ' + money(total.end) + lowNote(total), { wide: true, cls: total.start < 0 ? 'neg' : '' })));

    root.append(el('h2', { class: 'section', text: 'Konten' }));
    root.append(el('div', { class: 'list' }, state.accounts.map((a) => {
      const f = L.forecast([a], state.accounts, state.items, state.debts, today, horizon);
      return el('button', { class: 'row', type: 'button', onclick: () => openAccount(a.id) },
        el('span', { class: 'dot', style: 'background:var(--accent)' }),
        el('span', { class: 'row-main' },
          el('span', { class: 'row-title', text: a.name }),
          el('span', { class: 'row-sub', text: 'In 30 Tagen: ' + money(f.end) + lowNote(f) })),
        el('span', { class: 'amount' + (f.start < 0 ? ' neg' : ''), text: money(f.start) }));
    })));

    const we = L.addDays(L.weekStart(today), 6), me = L.monthEnd(today);
    const points = [['Ende dieser Woche', we], ['Ende dieses Monats', me], ['In 30 Tagen', L.addDays(today, 30)], ['In 90 Tagen', L.addDays(today, 90)]]
      .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    root.append(el('h2', { class: 'section', text: 'Vorschau (alle Konten)' }));
    root.append(el('div', { class: 'list' }, points.map(([label, date]) => {
      const f = L.forecast(state.accounts, state.accounts, state.items, state.debts, today, date);
      return el('div', { class: 'row static' },
        el('span', { class: 'row-main' },
          el('span', { class: 'row-title', text: label }),
          el('span', { class: 'row-sub', text: fmtDMY.format(dateOf(date)) })),
        el('span', { class: 'amount' + (f.end < 0 ? ' neg' : ''), text: money(f.end) }));
    })));

    root.append(el('div', { style: 'margin-top:18px' },
      el('button', { type: 'button', class: 'btn', onclick: () => openAccount(null), text: 'Neues Konto' })));
    root.append(el('p', { class: 'footnote', text: 'Die App geht davon aus, dass alle geplanten Buchungen pünktlich stattfinden. Weicht dein Konto ab, tippe es an und trage den aktuellen Stand ein.' }));
    return root;
  }

  function debtRow(d, today) {
    const rem = L.debtRemaining(d, today);
    const owe = d.kind !== 'owed';
    const paidShare = Math.max(0, Math.min(100, Math.round(((d.total - rem) / d.total) * 100)));
    const parts = [rem <= 0 ? 'bezahlt' : 'von ' + money(d.total)];
    if (d.rate && rem > 0) {
      parts.push('Rate ' + money(d.rate.amount) + ' ' + L.INTERVALS[d.rate.interval].label.toLowerCase());
      const po = L.debtPayoffDate(d);
      if (po) parts.push('fertig ca. ' + fmtMonthShort.format(dateOf(po)));
    }
    return el('button', { class: 'row' + (rem <= 0 ? ' done' : ''), type: 'button', onclick: () => openDebt(d.id) },
      el('span', { class: 'dot', style: 'background:' + (owe ? 'var(--danger)' : 'var(--income)') }),
      el('span', { class: 'row-main' },
        el('span', { class: 'row-title', text: d.name }),
        el('span', { class: 'row-sub', text: parts.join(' · ') }),
        el('span', { class: 'mini-meter', role: 'img', 'aria-label': paidShare + ' Prozent getilgt' }, el('i', { style: 'width:' + paidShare + '%' }))),
      el('span', { class: 'amount ' + (rem <= 0 ? '' : owe ? 'neg' : 'inc'), text: money(rem) }));
  }

  function viewDebts() {
    const root = el('div');
    if (!state.debts.length) {
      root.append(el('div', { class: 'empty-hero' },
        el('h2', { text: 'Keine Schulden eingetragen' }),
        el('p', { text: 'Trage ein, was du anderen schuldest oder was andere dir schulden. Mit einer automatischen Rate sinkt der Betrag von selbst.' }),
        el('button', { type: 'button', class: 'btn primary', onclick: () => openDebt(null), text: 'Erste Schuld anlegen' })));
      return root;
    }
    const today = L.todayISO();
    const sorter = (a, b) => L.debtRemaining(b, today) - L.debtRemaining(a, today) || a.name.localeCompare(b.name, 'de');
    const owe = state.debts.filter((d) => d.kind !== 'owed').sort(sorter);
    const owed = state.debts.filter((d) => d.kind === 'owed').sort(sorter);
    const sumRem = (list) => L.round2(list.reduce((s, d) => s + L.debtRemaining(d, today), 0));

    root.append(el('section', { class: 'cards' },
      card('Du schuldest', money(sumRem(owe)), plural(owe.length, 'Eintrag', 'Einträge'), { cls: sumRem(owe) > 0 ? 'neg' : '' }),
      card('Dir geschuldet', money(sumRem(owed)), plural(owed.length, 'Eintrag', 'Einträge'), { cls: sumRem(owed) > 0 ? 'inc' : '' })));

    if (owe.length) {
      root.append(el('h2', { class: 'section', text: 'Ich schulde' }));
      root.append(el('div', { class: 'list' }, owe.map((d) => debtRow(d, today))));
    }
    if (owed.length) {
      root.append(el('h2', { class: 'section', text: 'Mir geschuldet' }));
      root.append(el('div', { class: 'list' }, owed.map((d) => debtRow(d, today))));
    }
    root.append(el('div', { style: 'margin-top:18px' },
      el('button', { type: 'button', class: 'btn', onclick: () => openDebt(null), text: 'Neue Schuld' })));
    return root;
  }

  function render() {
    const view = $('#view');
    view.replaceChildren();
    if (!state.storageOk) {
      view.append(el('div', { class: 'banner', text: 'Speichern ist in diesem Browser gerade nicht möglich (privater Modus?). Änderungen gehen beim Schließen verloren.' }));
    }
    const builders = { overview: viewOverview, week: viewWeek, month: viewMonth, items: viewItems, accounts: viewAccounts, debts: viewDebts };
    view.append(builders[state.view]());
    $('#title').textContent = TITLES[state.view];
    document.querySelectorAll('.tabs button').forEach((b) => {
      if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
  }

  /* ---------- Posten bearbeiten ---------- */

  const itemDlg = $('#itemDlg'), form = $('#itemForm');
  const f = {
    type: $('#fType'), name: $('#fName'), amount: $('#fAmount'), interval: $('#fInterval'), anchor: $('#fAnchor'),
    anchorLabel: $('#fAnchorLabel'), end: $('#fEnd'), category: $('#fCategory'), account: $('#fAccount'),
    note: $('#fNote'), active: $('#fActive'), error: $('#fError'), del: $('#fDelete'), hint: $('#fAnchorHint')
  };
  let editingId = null;

  for (const [key, spec] of Object.entries(L.INTERVALS)) f.interval.append(el('option', { value: key, text: spec.label }));

  function fillCategories(type, keep) {
    const keys = L.categoriesFor(type);
    f.category.replaceChildren(...keys.map((k) => el('option', { value: k, text: L.CATEGORIES[k].label })));
    f.category.value = keys.includes(keep) ? keep : (type === 'income' ? 'gehalt' : 'sonstiges');
  }

  function fillAccountSelect(sel, current) {
    sel.replaceChildren();
    if (!state.accounts.length) {
      sel.append(el('option', { value: '', text: 'Kein Konto (erst unter „Konten“ anlegen)' }));
      sel.value = '';
      return;
    }
    for (const a of state.accounts) sel.append(el('option', { value: a.id, text: a.name }));
    sel.value = L.effectiveAccountId(current, state.accounts);
  }

  function applyType(keepCategory) {
    const income = f.type.value === 'income';
    f.anchorLabel.textContent = income ? 'Eingang am' : 'Abbuchung am';
    f.name.placeholder = income ? 'z. B. Gehalt, Kindergeld, Einzahlung' : 'z. B. Miete, Netflix, Handy';
    fillCategories(income ? 'income' : 'expense', keepCategory);
    updateHint();
  }

  function updateHint() {
    const iso = f.anchor.value;
    if (!L.isValidISO(iso)) { f.hint.textContent = ''; return; }
    const p = L.parseISO(iso);
    const wd = fmtWeekday.format(dateOf(iso));
    const kind = f.interval.value;
    if (kind === 'weekly') f.hint.textContent = 'Jede Woche am gleichen Wochentag: ' + wd + '.';
    else if (kind === 'biweekly') f.hint.textContent = 'Alle 14 Tage, ab diesem Datum (' + wd + ').';
    else if (p.d > 28) f.hint.textContent = 'Am ' + p.d + '. des Monats. Hat ein Monat weniger Tage, gilt der letzte Tag des Monats.';
    else f.hint.textContent = kind === 'yearly' ? 'Einmal im Jahr, jeweils am ' + fmtDM.format(dateOf(iso)) + '.' : 'Der Tag im Monat ist der ' + p.d + '.';
  }
  f.anchor.addEventListener('input', updateHint);
  f.interval.addEventListener('change', updateHint);
  f.type.addEventListener('change', () => applyType(null));

  function showError(msg) { f.error.textContent = msg; f.error.hidden = !msg; }

  function openItem(id) {
    const it = id ? state.items.find((x) => x.id === id) : null;
    editingId = it ? it.id : null;
    $('#itemDlgTitle').textContent = it ? 'Posten bearbeiten' : 'Neuer Posten';
    f.type.value = it && it.type === 'income' ? 'income' : 'expense';
    f.name.value = it ? it.name : '';
    f.amount.value = it ? String(it.amount).replace('.', ',') : '';
    f.interval.value = it ? it.interval : 'monthly';
    f.anchor.value = it ? it.anchor : (state.view === 'month' ? state.selDay : L.todayISO());
    f.end.value = it ? it.end : '';
    f.note.value = it ? it.note : '';
    f.active.checked = it ? it.active !== false : true;
    fillAccountSelect(f.account, it ? it.account : '');
    applyType(it ? it.category : null);
    f.del.hidden = !it;
    showError('');
    if (!itemDlg.open) itemDlg.showModal();
    if (!it) f.name.focus();
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const amount = L.parseAmount(f.amount.value);
    if (!f.name.value.trim()) return showError('Bitte einen Namen eintragen.');
    if (!Number.isFinite(amount) || amount <= 0) return showError('Bitte einen Betrag größer 0 eintragen, z. B. 12,50.');
    if (!L.isValidISO(f.anchor.value)) return showError('Bitte ein Datum wählen.');
    if (f.end.value && f.end.value < f.anchor.value) return showError('Das Ende liegt vor dem ersten Termin.');

    const item = L.normalizeItem({
      id: editingId || L.newId(), type: f.type.value,
      name: f.name.value, amount, interval: f.interval.value, anchor: f.anchor.value,
      end: f.end.value, category: f.category.value, account: f.account.value, note: f.note.value, active: f.active.checked
    });
    if (!item) return showError('Die Eingaben sind unvollständig.');

    const ok = await persist(() => DB.put('items', item));
    const i = state.items.findIndex((x) => x.id === item.id);
    if (i >= 0) state.items[i] = item; else state.items.push(item);
    itemDlg.close();
    render();
    toast(ok ? 'Gespeichert' : 'Nur vorläufig gespeichert');
  });

  $('#fCancel').addEventListener('click', () => itemDlg.close());
  f.del.addEventListener('click', async () => {
    const it = state.items.find((x) => x.id === editingId);
    if (!it || !confirm('„' + it.name + '“ wirklich löschen?')) return;
    await persist(() => DB.remove('items', it.id));
    state.items = state.items.filter((x) => x.id !== it.id);
    itemDlg.close();
    render();
    toast('Gelöscht');
  });

  /* ---------- Konto bearbeiten ---------- */

  const accDlg = $('#accDlg'), accForm = $('#accForm');
  const a = {
    name: $('#aName'), balance: $('#aBalance'), neg: $('#aNeg'), date: $('#aDate'),
    error: $('#aError'), del: $('#aDelete'), hint: $('#aHint')
  };
  let editingAccId = null;
  const accError = (msg) => { a.error.textContent = msg; a.error.hidden = !msg; };

  function openAccount(id) {
    const acc = id ? state.accounts.find((x) => x.id === id) : null;
    editingAccId = acc ? acc.id : null;
    const today = L.todayISO();
    $('#accDlgTitle').textContent = acc ? 'Konto bearbeiten' : 'Neues Konto';
    a.date.max = today;
    if (acc) {
      // Vorbelegt mit dem heute berechneten Stand: Nur den Betrag ändern, wenn die Bank etwas anderes zeigt.
      const now = L.accountBalance(acc, state.accounts, state.items, state.debts, today);
      a.name.value = acc.name;
      a.balance.value = String(Math.abs(now)).replace('.', ',');
      a.neg.checked = now < 0;
      a.date.value = today;
      a.hint.textContent = 'Hier steht der Stand, den die App für heute berechnet hat. Zeigt deine Bank etwas anderes, trage den Betrag der Bank ein. Ab dem gewählten Tag rechnet die App wieder automatisch weiter.';
    } else {
      a.name.value = '';
      a.balance.value = '';
      a.neg.checked = false;
      a.date.value = today;
      a.hint.textContent = 'Trage den Stand ein, den deine Bank gerade anzeigt. Ab diesem Tag rechnet die App Einnahmen und Abbuchungen automatisch mit. Alles bis einschließlich diesem Tag steckt schon im Betrag.';
    }
    a.del.hidden = !acc;
    accError('');
    if (!accDlg.open) accDlg.showModal();
    if (!acc) a.name.focus();
  }

  accForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!a.name.value.trim()) return accError('Bitte einen Namen eintragen.');
    const raw = L.parseSignedAmount(a.balance.value);
    if (!Number.isFinite(raw)) return accError('Bitte den Kontostand eintragen, z. B. 400 oder 1.250,50.');
    if (!L.isValidISO(a.date.value)) return accError('Bitte ein Datum wählen.');
    if (a.date.value > L.todayISO()) return accError('Der Stand darf nicht in der Zukunft liegen.');
    const balance = a.neg.checked ? -Math.abs(raw) : raw;

    const acc = L.normalizeAccount({ id: editingAccId || L.newId(), name: a.name.value, balance, date: a.date.value });
    if (!acc) return accError('Die Eingaben sind unvollständig.');
    const ok = await persist(() => DB.put('accounts', acc));
    const i = state.accounts.findIndex((x) => x.id === acc.id);
    if (i >= 0) state.accounts[i] = acc; else state.accounts.push(acc);
    accDlg.close();
    render();
    toast(ok ? 'Gespeichert' : 'Nur vorläufig gespeichert');
  });

  $('#aCancel').addEventListener('click', () => accDlg.close());
  a.del.addEventListener('click', async () => {
    const acc = state.accounts.find((x) => x.id === editingAccId);
    if (!acc) return;
    if (!confirm('Konto „' + acc.name + '“ löschen? Die Posten bleiben bestehen und zählen dann zum ersten Konto.')) return;
    await persist(() => DB.remove('accounts', acc.id));
    state.accounts = state.accounts.filter((x) => x.id !== acc.id);
    accDlg.close();
    render();
    toast('Gelöscht');
  });

  /* ---------- Schuld bearbeiten ---------- */

  const debtDlg = $('#debtDlg'), debtForm = $('#debtForm');
  const d = {
    kind: $('#dKind'), name: $('#dName'), nameLabel: $('#dNameLabel'), total: $('#dTotal'), note: $('#dNote'),
    payList: $('#dPayList'), payAmount: $('#dPayAmount'), payDate: $('#dPayDate'), payAdd: $('#dPayAdd'), remain: $('#dRemain'),
    rateOn: $('#dRateOn'), rateBox: $('#dRateBox'), rateAmount: $('#dRateAmount'), rateInterval: $('#dRateInterval'),
    rateAnchor: $('#dRateAnchor'), rateAccount: $('#dRateAccount'), rateAccountLabel: $('#dRateAccountLabel'),
    error: $('#dError'), del: $('#dDelete')
  };
  let editingDebtId = null;
  let draftPayments = [];
  const debtError = (msg) => { d.error.textContent = msg; d.error.hidden = !msg; };

  for (const [key, spec] of Object.entries(L.INTERVALS)) d.rateInterval.append(el('option', { value: key, text: spec.label }));

  function applyKind() {
    const owe = d.kind.value !== 'owed';
    d.nameLabel.textContent = owe ? 'Wem schuldest du es?' : 'Wer schuldet dir das Geld?';
    d.name.placeholder = owe ? 'z. B. Bank, Anna, Autohaus' : 'z. B. Anna, Max';
    d.rateAccountLabel.textContent = owe ? 'Konto, von dem die Rate abgeht' : 'Konto, auf das die Rate eingeht';
  }

  function renderPayments() {
    d.payList.replaceChildren(...draftPayments.map((p) =>
      el('div', { class: 'payrow' },
        el('span', { text: fmtDMY.format(dateOf(p.date)) }),
        el('span', { class: 'grow' }),
        el('b', { text: money(p.amount) }),
        el('button', {
          type: 'button', 'aria-label': 'Teilzahlung vom ' + fmtDMY.format(dateOf(p.date)) + ' entfernen', text: '×',
          onclick: () => { draftPayments = draftPayments.filter((x) => x.id !== p.id); renderPayments(); updateRemain(); }
        }))));
  }

  function draftRate() {
    if (!d.rateOn.checked) return null;
    return { amount: d.rateAmount.value, interval: d.rateInterval.value, anchor: d.rateAnchor.value, account: d.rateAccount.value };
  }

  function updateRemain() {
    const total = L.parseAmount(d.total.value);
    if (!Number.isFinite(total) || total <= 0) { d.remain.textContent = ''; return; }
    const tmp = L.normalizeDebt({ kind: d.kind.value, name: 'x', total, payments: draftPayments, rate: draftRate() });
    const paid = draftPayments.reduce((s, p) => s + p.amount, 0);
    let text = 'Noch offen: ' + money(Math.max(0, L.round2(total - paid))) + ' von ' + money(total);
    if (tmp && tmp.rate) {
      const po = L.debtPayoffDate(tmp);
      if (po) text += ' · mit dieser Rate abbezahlt ca. ' + fmtMonthShort.format(dateOf(po));
    }
    d.remain.textContent = text;
  }

  d.kind.addEventListener('change', applyKind);
  d.total.addEventListener('input', updateRemain);
  for (const n of [d.rateAmount, d.rateInterval, d.rateAnchor]) { n.addEventListener('input', updateRemain); n.addEventListener('change', updateRemain); }
  d.rateOn.addEventListener('change', () => { d.rateBox.hidden = !d.rateOn.checked; updateRemain(); });

  d.payAdd.addEventListener('click', () => {
    const amount = L.parseAmount(d.payAmount.value);
    if (!Number.isFinite(amount) || amount <= 0) return debtError('Bitte den Betrag der Teilzahlung eintragen.');
    if (!L.isValidISO(d.payDate.value)) return debtError('Bitte das Datum der Teilzahlung wählen.');
    debtError('');
    draftPayments.push({ id: L.newId(), date: d.payDate.value, amount: L.round2(amount) });
    draftPayments.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
    d.payAmount.value = '';
    renderPayments();
    updateRemain();
  });

  function openDebt(id) {
    const debt = id ? state.debts.find((x) => x.id === id) : null;
    editingDebtId = debt ? debt.id : null;
    const today = L.todayISO();
    $('#debtDlgTitle').textContent = debt ? 'Schuld bearbeiten' : 'Neue Schuld';
    d.kind.value = debt && debt.kind === 'owed' ? 'owed' : 'owe';
    d.name.value = debt ? debt.name : '';
    d.total.value = debt ? String(debt.total).replace('.', ',') : '';
    d.note.value = debt ? debt.note : '';
    draftPayments = debt ? debt.payments.map((p) => Object.assign({}, p)) : [];
    d.payAmount.value = '';
    d.payDate.value = today;
    d.rateOn.checked = !!(debt && debt.rate);
    d.rateBox.hidden = !d.rateOn.checked;
    d.rateAmount.value = debt && debt.rate ? String(debt.rate.amount).replace('.', ',') : '';
    d.rateInterval.value = debt && debt.rate ? debt.rate.interval : 'monthly';
    d.rateAnchor.value = debt && debt.rate ? debt.rate.anchor : today;
    fillAccountSelect(d.rateAccount, debt && debt.rate ? debt.rate.account : '');
    applyKind();
    renderPayments();
    updateRemain();
    d.del.hidden = !debt;
    debtError('');
    if (!debtDlg.open) debtDlg.showModal();
    if (!debt) d.name.focus();
  }

  debtForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!d.name.value.trim()) return debtError('Bitte einen Namen eintragen.');
    const total = L.parseAmount(d.total.value);
    if (!(total > 0)) return debtError('Bitte einen Gesamtbetrag größer 0 eintragen, z. B. 1.500.');
    let rate = null;
    if (d.rateOn.checked) {
      const ra = L.parseAmount(d.rateAmount.value);
      if (!(ra > 0)) return debtError('Bitte die Höhe der Rate eintragen oder die automatische Rate ausschalten.');
      if (!L.isValidISO(d.rateAnchor.value)) return debtError('Bitte das Datum der ersten Rate wählen.');
      rate = { amount: ra, interval: d.rateInterval.value, anchor: d.rateAnchor.value, account: d.rateAccount.value };
    }
    const debt = L.normalizeDebt({
      id: editingDebtId || L.newId(), kind: d.kind.value, name: d.name.value, total,
      note: d.note.value, payments: draftPayments, rate
    });
    if (!debt) return debtError('Die Eingaben sind unvollständig.');
    const ok = await persist(() => DB.put('debts', debt));
    const i = state.debts.findIndex((x) => x.id === debt.id);
    if (i >= 0) state.debts[i] = debt; else state.debts.push(debt);
    debtDlg.close();
    render();
    toast(ok ? 'Gespeichert' : 'Nur vorläufig gespeichert');
  });

  $('#dCancel').addEventListener('click', () => debtDlg.close());
  d.del.addEventListener('click', async () => {
    const debt = state.debts.find((x) => x.id === editingDebtId);
    if (!debt || !confirm('„' + debt.name + '“ wirklich löschen?')) return;
    await persist(() => DB.remove('debts', debt.id));
    state.debts = state.debts.filter((x) => x.id !== debt.id);
    debtDlg.close();
    render();
    toast('Gelöscht');
  });

  /* ---------- Daten sichern & übertragen ---------- */

  const dataDlg = $('#dataDlg'), dText = $('#dText'), dMsg = $('#dMsg'), dFile = $('#dFile');

  function dataMsg(msg, bad) {
    dMsg.textContent = msg;
    dMsg.hidden = !msg;
    dMsg.style.color = bad ? '' : 'var(--accent)';
  }

  function openData() { dataMsg(''); dText.value = ''; if (!dataDlg.open) dataDlg.showModal(); }

  const hasData = () => state.items.length + state.accounts.length + state.debts.length > 0;

  function exportJSON() {
    return JSON.stringify({
      app: 'abbuchungen', version: 2, exported: new Date().toISOString(),
      items: state.items, accounts: state.accounts, debts: state.debts
    }, null, 2);
  }

  async function exportFile() {
    if (!hasData()) return dataMsg('Es gibt noch nichts zu sichern.', true);
    const name = 'abbuchungen-' + L.todayISO() + '.json';
    const file = new File([exportJSON()], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Abbuchungen' }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file);
    const link = el('a', { href: url, download: name });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    dataMsg('Datei „' + name + '“ wurde gespeichert.');
  }

  async function copyText() {
    if (!hasData()) return dataMsg('Es gibt noch nichts zu kopieren.', true);
    const json = exportJSON();
    dText.value = json;
    try { await navigator.clipboard.writeText(json); dataMsg('In die Zwischenablage kopiert.'); }
    catch (e) { dText.select(); dataMsg('Text ist unten markiert – bitte selbst kopieren.'); }
  }

  function mergeInto(key, incoming) {
    const known = new Set(state[key].map((i) => i.id));
    const added = incoming.filter((i) => !known.has(i.id)).length;
    const map = new Map(state[key].map((i) => [i.id, i]));
    incoming.forEach((i) => map.set(i.id, i));
    state[key] = [...map.values()];
    return { added, updated: incoming.length - added };
  }

  async function importText(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { return dataMsg('Das ist keine gültige Sicherung (kein lesbares JSON).', true); }
    const obj = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    const rawItems = Array.isArray(data) ? data : (obj && Array.isArray(obj.items) ? obj.items : []);
    const rawAccounts = obj && Array.isArray(obj.accounts) ? obj.accounts : [];
    const rawDebts = obj && Array.isArray(obj.debts) ? obj.debts : [];
    const rawTotal = rawItems.length + rawAccounts.length + rawDebts.length;
    if (!rawTotal) return dataMsg('In dieser Datei wurden keine Daten gefunden.', true);

    const items = rawItems.map(L.normalizeItem).filter(Boolean);
    const accounts = rawAccounts.map(L.normalizeAccount).filter(Boolean);
    const debts = rawDebts.map(L.normalizeDebt).filter(Boolean);
    const validTotal = items.length + accounts.length + debts.length;
    if (!validTotal) return dataMsg('Keine gültigen Einträge gefunden.', true);

    await persist(async () => {
      if (items.length) await DB.putMany('items', items);
      if (accounts.length) await DB.putMany('accounts', accounts);
      if (debts.length) await DB.putMany('debts', debts);
    });
    const r1 = mergeInto('items', items), r2 = mergeInto('accounts', accounts), r3 = mergeInto('debts', debts);
    render();
    const added = r1.added + r2.added + r3.added, updated = r1.updated + r2.updated + r3.updated;
    const skipped = rawTotal - validTotal;
    dataMsg(added + ' neu, ' + updated + ' aktualisiert (' + plural(items.length, 'Posten', 'Posten') + ', ' + plural(accounts.length, 'Konto', 'Konten') + ', ' + plural(debts.length, 'Schuld', 'Schulden') + ')' +
      (skipped ? ', ' + skipped + ' übersprungen (unvollständig)' : '') + '.');
    dText.value = '';
  }

  $('#dExportFile').addEventListener('click', exportFile);
  $('#dCopy').addEventListener('click', copyText);
  $('#dImportFile').addEventListener('click', () => dFile.click());
  $('#dImportText').addEventListener('click', () => {
    if (!dText.value.trim()) return dataMsg('Bitte zuerst den Text einfügen.', true);
    importText(dText.value);
  });
  dFile.addEventListener('change', async () => {
    const file = dFile.files && dFile.files[0];
    dFile.value = '';
    if (file) importText(await file.text());
  });
  $('#dWipe').addEventListener('click', async () => {
    if (!hasData()) return dataMsg('Es ist nichts gespeichert.', true);
    const n = state.items.length + state.accounts.length + state.debts.length;
    if (!confirm('Wirklich ALLES löschen (' + n + ' Einträge: Posten, Konten und Schulden)? Das lässt sich nicht rückgängig machen. Tipp: erst sichern.')) return;
    await persist(() => DB.clearAll());
    state.items = []; state.accounts = []; state.debts = [];
    render();
    dataMsg('Alles gelöscht.');
  });
  $('#dClose').addEventListener('click', () => dataDlg.close());

  /* ---------- Start ---------- */

  $('#addBtn').addEventListener('click', () => {
    if (state.view === 'accounts') openAccount(null);
    else if (state.view === 'debts') openDebt(null);
    else openItem(null);
  });
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  // Klick auf den abgedunkelten Rand schließt Dialoge
  for (const dlg of [itemDlg, accDlg, debtDlg, dataDlg]) {
    dlg.addEventListener('click', (ev) => {
      if (ev.target !== dlg) return;
      const r = dlg.getBoundingClientRect();
      const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      if (!inside) dlg.close();
    });
  }

  // Beim Zurückkehren in die App (neuer Tag?) neu zeichnen
  let lastDay = L.todayISO();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const now = L.todayISO();
    if (now !== lastDay) { lastDay = now; state.weekRef = now; state.monthRef = L.monthStart(now); state.selDay = now; }
    render();
  });

  async function boot() {
    try {
      const [items, accounts, debts] = await Promise.all([DB.all('items'), DB.all('accounts'), DB.all('debts')]);
      state.items = items.map(L.normalizeItem).filter(Boolean);
      state.accounts = accounts.map(L.normalizeAccount).filter(Boolean);
      state.debts = debts.map(L.normalizeDebt).filter(Boolean);
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } catch (e) {
      console.error(e);
      state.storageOk = false;
    }
    render();

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service Worker:', e));
    }
  }

  // Für automatische Tests erreichbar, sonst unsichtbar
  window.__app = { state, render, setView, openItem, openAccount, openDebt };

  boot();
})();

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
  const fmtDM = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });
  const fmtDMY = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const fmtWeekday = new Intl.DateTimeFormat('de-DE', { weekday: 'long' });

  function dateOf(iso) { const p = L.parseISO(iso); return new Date(p.y, p.m - 1, p.d); }
  const money = (n) => eur.format(n);
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

  function compact(n) {
    if (n >= 1000) return (Math.round(n / 100) / 10).toLocaleString('de-DE') + 'k';
    return Math.round(n).toLocaleString('de-DE');
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

  /* ---------- Speicher (IndexedDB) ---------- */

  const DB = (function () {
    const NAME = 'abbuchungen', STORE = 'items';
    let opened = null;

    function open() {
      if (!opened) {
        opened = new Promise((resolve, reject) => {
          if (!window.indexedDB) { reject(new Error('IndexedDB nicht verfügbar')); return; }
          const req = indexedDB.open(NAME, 1);
          req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      }
      return opened;
    }

    async function run(mode, fn) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let result;
        const req = fn(store);
        if (req) req.onsuccess = () => { result = req.result; };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Abgebrochen'));
      });
    }

    return {
      all: () => run('readonly', (s) => s.getAll()),
      put: (item) => run('readwrite', (s) => s.put(item)),
      putMany: (items) => run('readwrite', (s) => { items.forEach((i) => s.put(i)); }),
      remove: (id) => run('readwrite', (s) => s.delete(id)),
      clear: () => run('readwrite', (s) => s.clear())
    };
  })();

  /* ---------- Zustand ---------- */

  const state = {
    items: [],
    view: 'overview',
    weekRef: L.todayISO(),
    monthRef: L.monthStart(L.todayISO()),
    selDay: L.todayISO(),
    storageOk: true
  };

  const TITLES = { overview: 'Übersicht', week: 'Woche', month: 'Monat', items: 'Posten' };

  function setView(v) {
    state.view = v;
    if (v === 'week') state.weekRef = state.weekRef || L.todayISO();
    render();
    window.scrollTo(0, 0);
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

  function entryRow(entry, sub) {
    const it = entry.item;
    const cat = L.CATEGORIES[it.category] || L.CATEGORIES.sonstiges;
    return el('button', { class: 'row', type: 'button', onclick: () => openItem(it.id) },
      el('span', { class: 'dot', style: 'background:' + cat.color }),
      el('span', { class: 'row-main' },
        el('span', { class: 'row-title', text: it.name }),
        el('span', { class: 'row-sub', text: sub != null ? sub : cat.label })),
      el('span', { class: 'amount', text: money(it.amount) }));
  }

  function pager(label, sub, onPrev, onNext, onToday, showToday) {
    return el('div', { class: 'pager' },
      el('button', { type: 'button', 'aria-label': 'Zurück', onclick: onPrev, text: '‹' }),
      el('div', { class: 'mid' }, el('b', { text: label }), el('span', { text: sub })),
      showToday ? el('button', { type: 'button', class: 'today', onclick: onToday, text: 'Heute' }) : null,
      el('button', { type: 'button', 'aria-label': 'Weiter', onclick: onNext, text: '›' }));
  }

  function emptyHero() {
    return el('div', { class: 'empty-hero' },
      el('h2', { text: 'Noch nichts eingetragen' }),
      el('p', { text: 'Lege deine wiederkehrenden Abbuchungen an, z. B. Miete, Versicherungen oder Abos.' }),
      el('button', { type: 'button', class: 'btn primary', onclick: () => openItem(null), text: 'Ersten Posten anlegen' }));
  }

  /* ---------- Ansichten ---------- */

  function viewOverview() {
    const root = el('div');
    if (!state.items.length) { root.append(emptyHero()); return root; }

    const today = L.todayISO();
    const ws = L.weekStart(today), we = L.addDays(ws, 6);
    const ms = L.monthStart(today), me = L.monthEnd(today);
    const weekEntries = L.expand(state.items, ws, we);
    const monthEntries = L.expand(state.items, ms, me);
    const monthTotal = L.sum(monthEntries);
    const paid = L.sum(monthEntries.filter((e) => e.date <= today));
    const open = Math.round((monthTotal - paid) * 100) / 100;
    const share = monthTotal > 0 ? Math.round((paid / monthTotal) * 100) : 0;

    root.append(el('section', { class: 'cards' },
      el('div', { class: 'card' },
        el('div', { class: 'card-label', text: 'Diese Woche' }),
        el('div', { class: 'card-value', text: money(L.sum(weekEntries)) }),
        el('div', { class: 'card-sub', text: 'KW ' + L.isoWeek(today) + ' · ' + plural(weekEntries.length, 'Abbuchung', 'Abbuchungen') })),
      el('div', { class: 'card' },
        el('div', { class: 'card-label', text: fmtMonth.format(dateOf(today)).split(' ')[0] }),
        el('div', { class: 'card-value', text: money(monthTotal) }),
        el('div', { class: 'card-sub', text: plural(monthEntries.length, 'Abbuchung', 'Abbuchungen') })),
      el('div', { class: 'card wide' },
        el('div', { class: 'card-label', text: 'Stand im Monat' }),
        el('div', { class: 'meter', role: 'img', 'aria-label': share + ' Prozent des Monats bereits abgebucht' }, el('i', { style: 'width:' + share + '%' })),
        el('div', { class: 'card-sub', text: 'Schon abgebucht: ' + money(paid) + ' · Noch offen: ' + money(open) })),
      el('div', { class: 'card wide' },
        el('div', { class: 'card-label', text: 'Fixkosten pro Monat (Durchschnitt)' }),
        el('div', { class: 'card-value', text: money(L.monthlyTotal(state.items)) }),
        el('div', { class: 'card-sub', text: 'Alle Rhythmen auf einen Monat umgerechnet, z. B. Jahresbeiträge geteilt durch 12.' }))));

    const upcoming = L.expand(state.items, today, L.addDays(today, 60)).slice(0, 8);
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
    const entries = L.expand(state.items, start, end);
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

    root.append(el('div', { class: 'total-bar' },
      el('span', { text: plural(entries.length, 'Abbuchung', 'Abbuchungen') }),
      el('b', { text: money(L.sum(entries)) })));

    if (!state.items.length) root.append(emptyHero());

    for (let i = 0; i < 7; i++) {
      const day = L.addDays(start, i);
      const list = byDay.get(day) || [];
      root.append(el('section', { class: 'day' + (day === today ? ' is-today' : '') },
        el('div', { class: 'day-head' },
          el('span', { text: fmtDayShort.format(dateOf(day)) }),
          el('small', { text: list.length ? money(L.sum(list)) : '' })),
        el('div', { class: 'list' },
          list.length ? list.map((e) => entryRow(e)) : el('div', { class: 'empty', text: 'Keine Abbuchungen' }))));
    }
    return root;
  }

  function viewMonth() {
    const today = L.todayISO();
    const ms = L.monthStart(state.monthRef), me = L.monthEnd(ms);
    if (!(state.selDay >= ms && state.selDay <= me)) state.selDay = (today >= ms && today <= me) ? today : ms;

    const entries = L.expand(state.items, ms, me);
    const byDay = L.groupByDate(entries);
    const isCurrent = ms === L.monthStart(today);
    const root = el('div');

    root.append(pager(
      fmtMonth.format(dateOf(ms)),
      plural(entries.length, 'Abbuchung', 'Abbuchungen'),
      () => { state.monthRef = L.addMonths(ms, -1); render(); },
      () => { state.monthRef = L.addMonths(ms, 1); render(); },
      () => { state.monthRef = L.monthStart(today); state.selDay = today; render(); },
      !isCurrent));

    root.append(el('div', { class: 'total-bar' },
      el('span', { text: 'Summe im Monat' }),
      el('b', { text: money(L.sum(entries)) })));

    root.append(el('div', { class: 'dow' }, ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((d) => el('span', { text: d }))));

    const grid = el('div', { class: 'grid' });
    const offset = L.weekday(ms);
    for (let i = 0; i < offset; i++) grid.append(el('span', { class: 'cell blank' }));
    const days = L.parseISO(me).d;
    for (let d = 1; d <= days; d++) {
      const iso = L.addDays(ms, d - 1);
      const list = byDay.get(iso) || [];
      const cats = [...new Set(list.map((e) => e.item.category))].slice(0, 3);
      const cls = 'cell' + (iso === today ? ' today' : '') + (iso === state.selDay ? ' sel' : '') + (list.length ? ' has' : '');
      grid.append(el('button', {
        type: 'button', class: cls,
        'aria-label': fmtDayLong.format(dateOf(iso)) + (list.length ? ', ' + money(L.sum(list)) : ', keine Abbuchungen'),
        onclick: () => { state.selDay = iso; render(); }
      },
        el('span', { class: 'n', text: String(d) }),
        el('span', { class: 'sum', text: list.length ? compact(L.sum(list)) : '' }),
        el('span', { class: 'dots' }, cats.map((c) => el('i', { style: 'background:' + (L.CATEGORIES[c] || L.CATEGORIES.sonstiges).color })))));
    }
    root.append(grid);

    const sel = byDay.get(state.selDay) || [];
    root.append(el('h2', { class: 'section', text: fmtDayLong.format(dateOf(state.selDay)) + (sel.length ? ' · ' + money(L.sum(sel)) : '') }));
    root.append(el('div', { class: 'list' },
      sel.length ? sel.map((e) => entryRow(e)) : el('div', { class: 'empty', text: 'Keine Abbuchungen an diesem Tag' })));

    const cats = L.byCategory(entries);
    if (cats.length) {
      const total = L.sum(entries);
      root.append(el('h2', { class: 'section', text: 'Nach Kategorie' }));
      root.append(el('div', { class: 'list' }, el('div', { class: 'bars' }, cats.map((c) =>
        el('div', { class: 'bar' },
          el('div', { class: 'bar-top' },
            el('span', null, el('i', { class: 'dot', style: 'background:' + c.color }), c.label),
            el('span', { text: money(c.total) })),
          el('div', { class: 'bar-track' }, el('i', { style: 'width:' + Math.max(2, Math.round((c.total / total) * 100)) + '%;background:' + c.color })))))));
    }
    return root;
  }

  function viewItems() {
    const root = el('div');
    if (!state.items.length) { root.append(emptyHero()); }
    else {
      const sorted = [...state.items].sort((a, b) => a.name.localeCompare(b.name, 'de'));
      root.append(el('div', { class: 'total-bar' },
        el('span', { text: plural(state.items.length, 'Posten', 'Posten') + ' · Ø pro Monat' }),
        el('b', { text: money(L.monthlyTotal(state.items)) })));
      root.append(el('div', { class: 'list' }, sorted.map((it) => {
        const cat = L.CATEGORIES[it.category] || L.CATEGORIES.sonstiges;
        const parts = [scheduleText(it)];
        if (it.end) parts.push('bis ' + fmtDMY.format(dateOf(it.end)));
        if (it.active === false) parts.push('pausiert');
        return el('button', { class: 'row' + (it.active === false ? ' paused' : ''), type: 'button', onclick: () => openItem(it.id) },
          el('span', { class: 'dot', style: 'background:' + cat.color }),
          el('span', { class: 'row-main' },
            el('span', { class: 'row-title', text: it.name }),
            el('span', { class: 'row-sub', text: parts.join(' · ') })),
          el('span', { class: 'amount', text: money(it.amount) }));
      })));
    }
    root.append(el('div', { style: 'margin-top:18px' },
      el('button', { type: 'button', class: 'btn', onclick: openData, text: 'Daten sichern & übertragen' })));
    root.append(el('p', { class: 'footnote', text: 'Alle Angaben bleiben auf diesem Gerät. Sie werden nirgendwo hochgeladen.' }));
    return root;
  }

  function render() {
    const view = $('#view');
    view.replaceChildren();
    if (!state.storageOk) {
      view.append(el('div', { class: 'banner', text: 'Speichern ist in diesem Browser gerade nicht möglich (privater Modus?). Änderungen gehen beim Schließen verloren.' }));
    }
    const builders = { overview: viewOverview, week: viewWeek, month: viewMonth, items: viewItems };
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
    name: $('#fName'), amount: $('#fAmount'), interval: $('#fInterval'), anchor: $('#fAnchor'),
    end: $('#fEnd'), category: $('#fCategory'), note: $('#fNote'), active: $('#fActive'),
    error: $('#fError'), del: $('#fDelete'), hint: $('#fAnchorHint')
  };
  let editingId = null;

  for (const [key, spec] of Object.entries(L.INTERVALS)) f.interval.append(el('option', { value: key, text: spec.label }));
  for (const [key, spec] of Object.entries(L.CATEGORIES)) f.category.append(el('option', { value: key, text: spec.label }));

  function updateHint() {
    const iso = f.anchor.value;
    if (!L.isValidISO(iso)) { f.hint.textContent = ''; return; }
    const p = L.parseISO(iso);
    const wd = fmtWeekday.format(dateOf(iso));
    const kind = f.interval.value;
    if (kind === 'weekly') f.hint.textContent = 'Jede Woche am gleichen Wochentag: ' + wd + '.';
    else if (kind === 'biweekly') f.hint.textContent = 'Alle 14 Tage, ab diesem Datum (' + wd + ').';
    else if (p.d > 28) f.hint.textContent = 'Am ' + p.d + '. des Monats. Hat ein Monat weniger Tage, wird am letzten Tag des Monats abgebucht.';
    else f.hint.textContent = kind === 'yearly' ? 'Einmal im Jahr, jeweils am ' + fmtDM.format(dateOf(iso)) + '.' : 'Der Tag im Monat ist der ' + p.d + '.';
  }
  f.anchor.addEventListener('input', updateHint);
  f.interval.addEventListener('change', updateHint);

  function showError(msg) { f.error.textContent = msg; f.error.hidden = !msg; }

  function openItem(id) {
    const it = id ? state.items.find((x) => x.id === id) : null;
    editingId = it ? it.id : null;
    $('#itemDlgTitle').textContent = it ? 'Posten bearbeiten' : 'Neuer Posten';
    f.name.value = it ? it.name : '';
    f.amount.value = it ? String(it.amount).replace('.', ',') : '';
    f.interval.value = it ? it.interval : 'monthly';
    f.anchor.value = it ? it.anchor : (state.view === 'month' ? state.selDay : L.todayISO());
    f.end.value = it ? it.end : '';
    f.category.value = it ? it.category : 'sonstiges';
    f.note.value = it ? it.note : '';
    f.active.checked = it ? it.active !== false : true;
    f.del.hidden = !it;
    showError('');
    updateHint();
    if (!itemDlg.open) itemDlg.showModal();
    if (!it) f.name.focus();
  }

  async function persist(action) {
    try { await action(); state.storageOk = true; return true; }
    catch (e) { state.storageOk = false; console.error(e); return false; }
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const amount = L.parseAmount(f.amount.value);
    if (!f.name.value.trim()) return showError('Bitte einen Namen eintragen.');
    if (!Number.isFinite(amount) || amount <= 0) return showError('Bitte einen Betrag größer 0 eintragen, z. B. 12,50.');
    if (!L.isValidISO(f.anchor.value)) return showError('Bitte ein Datum für die Abbuchung wählen.');
    if (f.end.value && f.end.value < f.anchor.value) return showError('Das Ende liegt vor der ersten Abbuchung.');

    const item = L.normalizeItem({
      id: editingId || L.newId(),
      name: f.name.value, amount, interval: f.interval.value, anchor: f.anchor.value,
      end: f.end.value, category: f.category.value, note: f.note.value, active: f.active.checked
    });
    if (!item) return showError('Die Eingaben sind unvollständig.');

    const ok = await persist(() => DB.put(item));
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
    await persist(() => DB.remove(it.id));
    state.items = state.items.filter((x) => x.id !== it.id);
    itemDlg.close();
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

  function exportJSON() {
    return JSON.stringify({ app: 'abbuchungen', version: 1, exported: new Date().toISOString(), items: state.items }, null, 2);
  }

  async function exportFile() {
    if (!state.items.length) return dataMsg('Es gibt noch nichts zu sichern.', true);
    const name = 'abbuchungen-' + L.todayISO() + '.json';
    const file = new File([exportJSON()], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Abbuchungen' }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file);
    const a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    dataMsg('Datei „' + name + '“ wurde gespeichert.');
  }

  async function copyText() {
    if (!state.items.length) return dataMsg('Es gibt noch nichts zu kopieren.', true);
    const json = exportJSON();
    dText.value = json;
    try { await navigator.clipboard.writeText(json); dataMsg('In die Zwischenablage kopiert.'); }
    catch (e) { dText.select(); dataMsg('Text ist unten markiert – bitte selbst kopieren.'); }
  }

  async function importText(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { return dataMsg('Das ist keine gültige Sicherung (kein lesbares JSON).', true); }
    const raw = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : null);
    if (!raw) return dataMsg('In dieser Datei wurden keine Posten gefunden.', true);
    const valid = raw.map(L.normalizeItem).filter(Boolean);
    if (!valid.length) return dataMsg('Keine gültigen Posten gefunden.', true);

    const known = new Set(state.items.map((i) => i.id));
    const added = valid.filter((i) => !known.has(i.id)).length;
    const updated = valid.length - added;
    await persist(() => DB.putMany(valid));
    const map = new Map(state.items.map((i) => [i.id, i]));
    valid.forEach((i) => map.set(i.id, i));
    state.items = [...map.values()];
    render();
    const skipped = raw.length - valid.length;
    dataMsg(plural(added, 'Posten neu', 'Posten neu') + ', ' + plural(updated, 'aktualisiert', 'aktualisiert') + (skipped ? ', ' + skipped + ' übersprungen (unvollständig)' : '') + '.');
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
    if (!state.items.length) return dataMsg('Es ist nichts gespeichert.', true);
    if (!confirm('Wirklich ALLE ' + state.items.length + ' Posten löschen? Das lässt sich nicht rückgängig machen. Tipp: erst sichern.')) return;
    await persist(() => DB.clear());
    state.items = [];
    render();
    dataMsg('Alles gelöscht.');
  });
  $('#dClose').addEventListener('click', () => dataDlg.close());

  /* ---------- Start ---------- */

  $('#addBtn').addEventListener('click', () => openItem(null));
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  // Klick auf den abgedunkelten Rand schließt Dialoge
  for (const dlg of [itemDlg, dataDlg]) {
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
      const stored = await DB.all();
      state.items = stored.map(L.normalizeItem).filter(Boolean);
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
  window.__app = { state, render, setView, openItem };

  boot();
})();

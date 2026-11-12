/* Abgleich zwischen Geräten: Verschlüsselung (AES-GCM, Schlüssel aus Passwort per PBKDF2)
 * und Zugriff auf eine einzelne Datei in einem privaten GitHub-Repository.
 * Die Daten verlassen das Gerät nur verschlüsselt; das Passwort wird nie übertragen. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FILE = 'abbuchungen.enc.json';
  const ITER = 600000;
  const subtle = () => (globalThis.crypto && globalThis.crypto.subtle) || null;

  /* ---------- Base64 ---------- */

  function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(str) {
    const bin = atob(String(str).replace(/\s/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const utf8 = (s) => new TextEncoder().encode(s);

  /* ---------- Verschlüsselung ---------- */

  const keyCache = new Map();

  async function deriveKey(pass, saltB64) {
    const id = saltB64 + '|' + pass;
    if (keyCache.has(id)) return keyCache.get(id);
    const s = subtle();
    if (!s) throw new Error('Verschlüsselung wird von diesem Browser nicht unterstützt.');
    const base = await s.importKey('raw', utf8(pass), 'PBKDF2', false, ['deriveKey']);
    const key = await s.deriveKey(
      { name: 'PBKDF2', salt: fromB64(saltB64), iterations: ITER, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
    if (keyCache.size > 4) keyCache.clear();
    keyCache.set(id, key);
    return key;
  }

  /** Verschlüsselt ein Objekt. Mit gleichem Salt wird der abgeleitete Schlüssel wiederverwendet. */
  async function encrypt(obj, pass, saltB64) {
    const salt = saltB64 || toB64(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pass, salt);
    const buf = await subtle().encrypt({ name: 'AES-GCM', iv }, key, utf8(JSON.stringify(obj)));
    return { app: 'abbuchungen', v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt, iv: toB64(iv), data: toB64(new Uint8Array(buf)) };
  }

  async function decrypt(file, pass) {
    if (!file || file.v !== 1 || !file.salt || !file.iv || !file.data) throw codeErr('FORMAT', 'Die Datei im Speicher hat ein unbekanntes Format.');
    const key = await deriveKey(pass, file.salt);
    let plain;
    try { plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(file.iv) }, key, fromB64(file.data)); }
    catch (e) { throw codeErr('PASS', 'Das Passwort passt nicht zu den gespeicherten Daten.'); }
    return JSON.parse(new TextDecoder().decode(plain));
  }

  /* ---------- GitHub ---------- */

  function codeErr(code, message) { const e = new Error(message); e.code = code; return e; }

  /** Nimmt „name/repo“ oder eine GitHub-Adresse und liefert „name/repo“ – oder null. */
  function parseRepo(text) {
    const m = String(text || '').trim().match(/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-_.]+)\/([A-Za-z0-9-_.]+?)(?:\.git)?\/?$/);
    return m ? m[1] + '/' + m[2] : null;
  }

  function client(cfg) {
    const base = (cfg.api || 'https://api.github.com').replace(/\/$/, '');
    const url = (p) => base + '/repos/' + cfg.repo + p;
    const headers = (extra) => Object.assign({ Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + cfg.token }, extra || {});

    async function call(path, init) {
      let res;
      try { res = await fetch(url(path), Object.assign({ cache: 'no-store', headers: headers() }, init)); }
      catch (e) { throw codeErr('NET', 'Keine Verbindung. Der Abgleich läuft, sobald wieder Netz da ist.'); }
      if (res.status === 401) throw codeErr('AUTH', 'Der Zugangsschlüssel wurde abgelehnt. Ist er abgelaufen oder falsch kopiert?');
      if (res.status === 403) throw codeErr('AUTH', 'Zugriff verweigert. Hat der Zugangsschlüssel Schreibrechte („Contents: Read and write“) für dieses Repository?');
      return res;
    }

    return {
      /** Prüft, ob das Repository erreichbar und privat ist. */
      async info() {
        const res = await call('');
        if (res.status === 404) throw codeErr('REPO', 'Repository nicht gefunden. Name richtig? Und gilt der Zugangsschlüssel für genau dieses Repository?');
        if (!res.ok) throw codeErr('HTTP', 'GitHub antwortet mit Fehler ' + res.status + '.');
        const j = await res.json();
        return { private: j.private === true };
      },
      /** Liest die verschlüsselte Datei; null, wenn es sie noch nicht gibt. */
      async get() {
        const res = await call('/contents/' + FILE);
        if (res.status === 404) return null;
        if (!res.ok) throw codeErr('HTTP', 'GitHub antwortet mit Fehler ' + res.status + '.');
        const j = await res.json();
        if (typeof j.content !== 'string') throw codeErr('FORMAT', 'Die Datei im Speicher ist zu groß oder unlesbar.');
        return { sha: j.sha, file: JSON.parse(new TextDecoder().decode(fromB64(j.content))) };
      },
      async put(file, sha) {
        const body = { message: 'Abgleich ' + new Date().toISOString(), content: toB64(utf8(JSON.stringify(file))) };
        if (sha) body.sha = sha;
        const res = await call('/contents/' + FILE, { method: 'PUT', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
        if (res.status === 409 || res.status === 422) throw codeErr('CONFLICT', 'Zwischenzeitlich wurde woanders gespeichert.');
        if (!res.ok) throw codeErr('HTTP', 'GitHub antwortet mit Fehler ' + res.status + '.');
      }
    };
  }

  return { FILE, encrypt, decrypt, client, parseRepo, toB64, fromB64 };
});

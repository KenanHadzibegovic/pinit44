/* ════════════════════════════════════════════════════════════
   PINIT SERVER — pokretanje:  node server.js
   Bez ikakvih instalacija (nula zavisnosti, samo Node.js).

   Servira:
     http://ADRESA:3000/           → mobilna aplikacija (app.html)
     http://ADRESA:3000/komandni   → komandni centar (komandni.html)
   API — građani i prijave:
     POST  /api/register            {name, city}        → {userId, token}
     GET   /api/reports?city=X      → lista prijava
     POST  /api/reports             {token, cat, note, photo, lat, lng, ts, city, name}
     POST  /api/reports/:id/vote    {delta}
     PATCH /api/reports/:id         {status, worker, cost, invoices, work, foto…}
     GET   /api/drives?city=X       → lista vožnji
     POST  /api/drives              (šalje aplikacija sama)
     GET   /api/stats?city=X

   API — radnici (nalozi i prijava):
     GET    /api/workers            → lista (bez PIN-a i tokena)
     POST   /api/workers            dispečer dodaje → vraća {code, pin} JEDNOM
     POST   /api/workers/:id/pin    dispečer resetuje PIN → novi {code, pin}
     POST   /api/worker/login       {code, pin}         → {token, worker}
     POST   /api/worker/logout      {token}
     GET    /api/worker/me?token=   provjera sesije
     POST   /api/worker/pin         {token, oldPin, newPin}
     PATCH  /api/workers/:id        {token, …}  radnik uređuje SVOJ profil
     POST   /api/workers/:id/loc    {token, lat, lng}  lokacija za dispečera
     DELETE /api/workers/:id
   Podaci se čuvaju u data.json pored servera.
   ════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'),
      crypto = require('crypto'), os = require('os');

/* ── VERZIJA ──
   Kad objaviš izmjene, otvori /api/verzija na svojoj adresi: ako tu ne piše
   broj ispod, Render još vrti stari kod (fajlovi nisu stigli ili deploy nije
   prošao). Isti broj ispiše se i u logu pri pokretanju. */
const PINIT_VERZIJA = 'v38';

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data.json');
const PUB  = path.join(__dirname, 'public');

let DB = { users: [], reports: [], drives: [], workers: [] };

/* ══════════════════════════════════════════════════════════════════
   POHRANA PODATAKA

   Do sada je sve živjelo u data.json na disku. Na Render free planu taj
   disk se briše pri svakom deployu i pri svakom gašenju instance, pa su
   nestajale sve prijave, radnici i njihovi nalozi.

   Sada, ako su postavljene varijable SUPABASE_URL i SUPABASE_KEY, podaci
   idu u Supabase (PostgreSQL) i preživljavaju sve. Ako nisu postavljene,
   sve radi kao prije preko data.json — tako lokalni rad ne traži nikakvo
   podešavanje.

   Kako radi:
     • pri pokretanju se sve učita u memoriju (kao i dosad),
     • server radi nad memorijom — brzo, bez ijedne izmjene u rutama,
     • save() u pozadini upiše u Supabase SAMO zapise koji su se stvarno
       promijenili, upoređujući ih s kopijom od zadnjeg upisa.

   Komunikacija ide preko Supabase REST sučelja običnim fetch pozivom, pa
   server i dalje nema nijednu vanjsku biblioteku i ne treba npm install.
   ══════════════════════════════════════════════════════════════════ */
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_KEY || '';
const SB_ON  = !!(SB_URL && SB_KEY);
const TABLES = { users: 'pinit_users', reports: 'pinit_reports',
                 drives: 'pinit_drives', workers: 'pinit_workers' };

function sbFetch(pathQ, opts = {}) {
  return fetch(SB_URL + '/rest/v1/' + pathQ, {
    method: opts.method || 'GET',
    headers: Object.assign({
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json'
    }, opts.headers || {}),
    body: opts.body
  }).then(async r => {
    const txt = await r.text();
    if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + txt.slice(0, 300));
    return txt ? JSON.parse(txt) : null;
  });
}

/* Kopija zadnjeg upisanog stanja — po njoj znamo šta se promijenilo. */
const LAST = { users: new Map(), reports: new Map(), drives: new Map(), workers: new Map() };
const rowId = o => String(o.id);

async function loadDB() {
  if (!SB_ON) {
    try { DB = Object.assign(DB, JSON.parse(fs.readFileSync(DATA, 'utf8'))); } catch (e) {}
    return 'data.json (lokalni fajl)';
  }
  for (const key of Object.keys(TABLES)) {
    /* Supabase vraća najviše 1000 redova odjednom, pa idemo u koracima. */
    const all = [];
    for (let from = 0; ; from += 1000) {
      const page = await sbFetch(TABLES[key] + '?select=data&order=id.asc', {
        headers: { 'Range-Unit': 'items', 'Range': from + '-' + (from + 999) }
      });
      if (!page || !page.length) break;
      page.forEach(r => all.push(r.data));
      if (page.length < 1000) break;
    }
    DB[key] = all;
    all.forEach(o => LAST[key].set(rowId(o), JSON.stringify(o)));
  }
  return 'Supabase (' + SB_URL.replace(/^https?:\/\//, '') + ')';
}

let saveT = null, saving = false, again = false;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(flush, SB_ON ? 800 : 300);
}
function flush() {
  if (!SB_ON) return fs.writeFile(DATA, JSON.stringify(DB), () => {});
  if (saving) { again = true; return; }          // upis već traje — ponovi poslije
  saving = true;
  flushSB().catch(e => log('⚠ Upis u Supabase nije uspio: ' + e.message))
    .then(() => {
      saving = false;
      if (again) { again = false; save(); }
    });
}
async function flushSB() {
  for (const key of Object.keys(TABLES)) {
    const live = DB[key] || [], seen = new Set();
    const changed = [];
    for (const o of live) {
      const id = rowId(o); seen.add(id);
      const now = JSON.stringify(o);
      if (LAST[key].get(id) !== now) changed.push({ id, data: o, _s: now });
    }
    /* Šaljemo u paketima da jedan ogroman zahtjev ne padne na vremenu. */
    for (let i = 0; i < changed.length; i += 50) {
      const part = changed.slice(i, i + 50);
      await sbFetch(TABLES[key], {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(part.map(x => ({ id: x.id, data: x.data })))
      });
      part.forEach(x => LAST[key].set(x.id, x._s));
    }
    /* Obrisani zapisi (npr. uklonjen radnik) moraju nestati i iz baze. */
    const gone = [...LAST[key].keys()].filter(id => !seen.has(id));
    for (let i = 0; i < gone.length; i += 50) {
      const part = gone.slice(i, i + 50);
      await sbFetch(TABLES[key] + '?id=in.(' +
        part.map(x => '"' + x.replace(/"/g, '') + '"').join(',') + ')', { method: 'DELETE' });
      part.forEach(id => LAST[key].delete(id));
    }
  }
}

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  /* Bez 'Access-Control-Allow-Origin': aplikacije dolaze s istog servera,
     pa im dozvola ne treba. Tuđe stranice time gube pristup ovom API-ju. */
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(b);
}
function readBody(req, cb) {
  let d = '';
  req.on('data', c => { d += c; if (d.length > 25e6) { req.destroy(); } });
  req.on('end', () => { try { cb(JSON.parse(d || '{}')); } catch (e) { cb(null); } });
}
function log(msg) { console.log(new Date().toLocaleTimeString('bs'), '·', msg); }

/* ══════════════════════════════════════════════════════════════════
   PRIJAVA ZA DISPEČERA (platforma i komandni centar)

   Dosad je svako ko zna adresu mogao otvoriti platformu, vidjeti imena i
   tačne lokacije građana, mijenjati statuse, brisati radnike i resetovati
   im PIN-ove. Sada oboje traži lozinku.

   Lozinka NE stoji u data.json nego u varijabli okruženja PINIT_ADMIN_PASS.
   Razlog je praktičan: data.json se na Render free planu briše pri svakom
   deployu, pa bi nalog spremljen u njemu nestao i zaključao te van vlastitog
   sistema. Varijabla okruženja preživi deploy.

   Na Renderu:  Dashboard → tvoj servis → Environment → Add Environment
   Variable → Key: PINIT_ADMIN_PASS, Value: tvoja lozinka → Save.
   Lokalno:     PINIT_ADMIN_PASS=nekalozinka node server.js

   Ako varijabla nije postavljena, server pri pokretanju sam smisli lozinku
   i ispiše je u konzolu — tako lokalni rad radi bez podešavanja, ali sistem
   nikad ne ostaje otključan.
   ══════════════════════════════════════════════════════════════════ */
const ADMIN_SESSION_MS = 12 * 3600e3;        // sesija dispečera traje 12 h
/* ══ PREKIDAČ ZA PODEŠAVANJE ══
   PINIT_NO_AUTH=1 isključuje SVE prijave: platforma i komandni centar se
   otvaraju bez lozinke, a radnička aplikacija bez koda i PIN-a.

   Ovo postoji samo da ti ne smeta dok podešavaš stanicu. NE OSTAVLJAJ GA
   UKLJUČENOG na javnoj adresi — bez njega svako ko pogodi /platforma može
   brisati radnike, resetovati PIN-ove i vidjeti puna imena i fotografije
   građana. Render adrese botovi skeniraju same od sebe.

   Kad završiš: obriši varijablu PINIT_NO_AUTH i sve se vrati kako je bilo.
   Ništa se ne gubi — nalozi, PIN-ovi i lozinka ostaju gdje jesu. */
const NO_AUTH = process.env.PINIT_NO_AUTH === '1' ||
                String(process.env.PINIT_NO_AUTH || '').toLowerCase() === 'true';

/* ══════════════════════════════════════════════════════════════════
   LOZINKA ZA PLATFORMU I KOMANDNI CENTAR

   Ovdje je upisana stalna lozinka. Ne mijenja se, ne treba je nigdje
   podešavati, radi odmah nakon deploya.

   DA JE PROMIJENIŠ: izmijeni red ispod i pošalji na GitHub.

   Ako ti kasnije zatreba da lozinka NE stoji u kodu (npr. ako repo
   postane javan), postavi PINIT_ADMIN_PASS u Render → Environment —
   ta vrijednost ima prednost nad ovom ovdje.
   ══════════════════════════════════════════════════════════════════ */
const UGRADJENA_LOZINKA = 'pinit2026';

let ADMIN_PASS = process.env.PINIT_ADMIN_PASS || UGRADJENA_LOZINKA;
let ADMIN_GENERATED = false;

/* ── LOZINKA KOJU SERVER SAM SMISLI ──
   Ako PINIT_ADMIN_PASS nije postavljen, server smisli privremenu. Ranije ju
   je smišljao pri SVAKOM pokretanju, pa se mijenjala kad god se servis
   restartuje — a Render restartuje sam od sebe (uspavljivanje, deploy).
   Dok čovjek pročita lozinku iz loga i upiše je, ona više ne važi.
   Zato se sada pamti u bazi i ostaje ista dok je ne promijeniš.
   Poziva se tek nakon što se baza učita. */
const LOZ_FAJL = path.join(__dirname, '.pinit-lozinka');
function pripremiLozinku() {
  if (ADMIN_PASS) return;                      // postavljena kroz okruženje

  /* Pamti se u malom fajlu pored servera. Namjerno NE u Supabaseu — to bi
     tražilo novu tabelu i da ti ručno pokreneš SQL, a lozinka bi stajala u
     bazi u čitljivom obliku. Fajl preživi restart i uspavljivanje servisa,
     što je slučaj koji je i pravio problem.
     Napomena: na besplatnom Renderu PUNI DEPLOY briše disk, pa se tada
     smisli nova. Zato je pravo rješenje postaviti PINIT_ADMIN_PASS. */
  try {
    const spremljena = fs.readFileSync(LOZ_FAJL, 'utf8').trim();
    if (spremljena) { ADMIN_PASS = spremljena; ADMIN_GENERATED = true; return; }
  } catch (e) {}

  ADMIN_PASS = crypto.randomBytes(4).toString('hex');
  try { fs.writeFileSync(LOZ_FAJL, ADMIN_PASS, { mode: 0o600 }); } catch (e) {}
  ADMIN_GENERATED = true;
}
const ADMIN_SESSIONS = new Map();            // token → vrijeme isteka

/* Poređenje lozinki u konstantnom vremenu. Obično poređenje (===) staje
   na prvom različitom znaku, pa se iz razlike u trajanju odgovora može
   pogađati lozinka znak po znak. */
function sameSecret(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}
function adminCookie(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)pinit_adm=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function isAdmin(req) {
  if (NO_AUTH) return true;              // prekidač za podešavanje
  const t = adminCookie(req);
  if (!t) return false;
  const exp = ADMIN_SESSIONS.get(t);
  if (!exp) return false;
  if (Date.now() > exp) { ADMIN_SESSIONS.delete(t); return false; }
  return true;
}
/* Kolačić je HttpOnly — JavaScript na stranici mu ne može pristupiti, pa ga
   ni ubačena skripta ne može ukrasti. Secure se šalje samo preko https. */
function setAdminCookie(res, token, req, maxAgeSec) {
  const https = (req.headers['x-forwarded-proto'] || '').indexOf('https') === 0 || !!req.socket.encrypted;
  res.setHeader('Set-Cookie',
    'pinit_adm=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAgeSec + (https ? '; Secure' : ''));
}
/* Usporavanje pogađanja lozinke: 10 promašaja s iste adrese → pauza 15 min. */
const ADMIN_FAILS = new Map();
function adminBlocked(ip) {
  const f = ADMIN_FAILS.get(ip);
  return !!(f && f.until && Date.now() < f.until);
}
/* Koliko minuta još traje pauza — da poruka bude konkretna. Bez ovoga
   blokada izgleda isto kao pogrešna lozinka, pa čovjek misli da lozinka ne
   valja i mijenja je, iako je bila tačna. */
function adminBlockMin(ip) {
  const f = ADMIN_FAILS.get(ip);
  if (!f || !f.until) return 0;
  return Math.max(1, Math.ceil((f.until - Date.now()) / 60000));
}
function adminFail(ip) {
  const f = ADMIN_FAILS.get(ip) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 10) { f.until = Date.now() + 15 * 60e3; f.n = 0; }
  ADMIN_FAILS.set(ip, f);
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
         req.socket.remoteAddress || '?';
}

/* ── PROVJERA ULAZNIH PODATAKA ──
   Sve što stiže s interneta tretiramo kao nepouzdano, i kad dolazi iz naše
   aplikacije — jer zahtjev može poslati bilo ko, ne samo naša stranica. */
function okLat(v) { return typeof v === 'number' && isFinite(v) && v >= -90 && v <= 90; }
function okLng(v) { return typeof v === 'number' && isFinite(v) && v >= -180 && v <= 180; }

/* Fotografija dolazi kao data-URL tekst. Provjeravamo da je stvarno slika
   dozvoljenog tipa, a ne skripta ili nešto treće preobučeno u sliku, i da
   nije prevelika. MAX je u znakovima base64 zapisa (~3/4 toga su bajti). */
const PHOTO_MAX = 8e6;
function okPhoto(v, max) {
  if (typeof v !== 'string') return false;
  if (v.length > (max || PHOTO_MAX)) return false;
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=\s]+$/.test(v)) return false;

  /* ── PROVJERA STVARNOG SADRŽAJA ──
     Zaglavlje "data:image/jpeg" napiše pošiljalac i može lagati. Zato gledamo
     prve bajte samog fajla — svaki format ima svoj potpis:
       JPEG → FF D8 FF        PNG → 89 50 4E 47        WEBP → RIFF....WEBP
     Ako se potpis ne poklapa, ovo nije slika nego nešto drugo preobučeno u
     sliku, i odbijamo ga. */
  try {
    const b64 = v.slice(v.indexOf(',') + 1).replace(/\s/g, '');
    const head = Buffer.from(b64.slice(0, 32), 'base64');
    if (head.length < 12) return false;
    const jpeg = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF;
    const png  = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
    const webp = head.slice(0, 4).toString('ascii') === 'RIFF' &&
                 head.slice(8, 12).toString('ascii') === 'WEBP';
    return jpeg || png || webp;
  } catch (e) { return false; }
}
/* Vrati sliku ako je ispravna, inače null — nikad polovičan zapis. */
function cleanPhoto(v, max) { return okPhoto(v, max) ? v : null; }


/* razdaljina u metrima između dvije GPS tačke */
function distM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
  const q = Math.sin(dLa / 2) ** 2 +
            Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(q));
}
/* Traži RIJEŠENU prijavu istog tipa na istoj lokaciji — znak da se kvar vratio.
   Prozor: 1–180 dana nakon popravke. Ispod 1 dana je vjerovatno duplikat, ne ponavljanje. */
const RECUR_RADIUS_M = 120, RECUR_MIN_DAYS = 1, RECUR_MAX_DAYS = 180;
function findRecurrence(r) {
  if (typeof r.lat !== 'number' || typeof r.lng !== 'number') return null;
  let best = null, bestD = Infinity;
  for (const p of DB.reports) {
    if (p.status !== 3 || !p.resolvedAt) continue;
    if (p.cat !== r.cat) continue;
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
    const days = (r.ts - p.resolvedAt) / 864e5;
    if (days < RECUR_MIN_DAYS || days > RECUR_MAX_DAYS) continue;
    const d = distM(p, r);
    if (d <= RECUR_RADIUS_M && d < bestD) { best = p; bestD = d; }
  }
  return best;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

/* ── SLA ROKOVI PO KATEGORIJI (sati) ──
   Vrijednosti prate praksu gradskih službi: hitna opasnost odmah, rupe 72 h
   (Washington DC / San Francisco standard), otpad 48 h, rasvjeta 7 dana.
   Hitan prioritet (puno potvrda građana) prepolovi rok. */
const SLA_CAT = { staklo:4, poplava:12, voda:24, predmet:24, putevi:72, otpad:48,
                  rasveta:168, rasvjeta:168, elektro:168, ostalo:72 };
function slaFor(cat, pri) {
  const base = SLA_CAT[String(cat||'').toLowerCase()] || 72;
  return pri === 'urgent' ? Math.max(2, Math.round(base / 2)) : base;
}

/* ── PROVJERA DUPLIKATA ──
   Ista praksa kao FixMyStreet / SeeClickFix: ako u krugu od 100 m već postoji
   OTVORENA prijava istog tipa, bolje je potvrditi postojeću nego otvoriti novu. */
const DUP_RADIUS_M = 100;
function findOpenDuplicate(cat, lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  let best = null, bestD = Infinity;
  for (const p of DB.reports) {
    if (p.status === 3) continue;                       // riješene ne broji
    if (String(p.cat) !== String(cat)) continue;
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
    const d = distM(p, { lat, lng });
    if (d <= DUP_RADIUS_M && d < bestD) { best = p; bestD = d; }
  }
  return best ? { report: best, dist: Math.round(bestD) } : null;
}

/* ── ZAŠTITA OD ZLOUPOTREBE ──
   Provjere se rade NA SERVERU jer se sve u aplikaciji može izmijeniti.
   Ne odbacujemo olako — sumnjivo označimo, a očito lažno odbijemo. */
const MAX_REPORTS_PER_DAY = 30;
function abuseCheck(b, ip) {
  const flags = [];
  const dayAgo = Date.now() - 864e5;
  const who = b.token || b.deviceId || ip;
  const mine = DB.reports.filter(r =>
    (r._who === who) && (r.ts || 0) > dayAgo);
  if (mine.length >= MAX_REPORTS_PER_DAY)
    return { reject: 'previše prijava u 24 h', flags };
  // isti korisnik, isti tip, isto mjesto, unutar 2 h → to je duplikat, ne nova prijava
  if (typeof b.lat === 'number') {
    const near = mine.find(r => r.cat === b.cat && typeof r.lat === 'number' &&
      distM(r, { lat: b.lat, lng: b.lng }) < 50 && (Date.now() - r.ts) < 2 * 3600e3);
    if (near) return { reject: 'isti problem si već prijavio prije manje od 2 h', flags };
  }
  if (typeof b.lat !== 'number') flags.push('bez-gps');
  else if (typeof b.acc === 'number' && b.acc > 200) flags.push('slab-gps');
  return { reject: null, flags };
}

/* ── VALIDACIJA VOŽNJE ──
   Bodovi se dijele po kilometru, pa lažna vožnja = lažni bodovi. Zato server
   provjeri putanju: da li kilometraža odgovara stvarnom GPS tragu i da li su
   brzine moguće. Ne vjerujemo brojci koju pošalje telefon. */
function validateDrive(d) {
  const flags = [];
  const path = Array.isArray(d.path) ? d.path.filter(p =>
    p && typeof p.lat === 'number' && typeof p.lng === 'number') : [];
  const km = Number(d.km) || 0;
  if (km > 500) return { reject: 'nemoguća kilometraža', flags, pathKm: 0 };
  if (d.test) flags.push('test');

  let pathM = 0, maxSpeed = 0, jumps = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dist = distM(a, b);
    const dt = (Number(b.t) - Number(a.t)) || 1;          // sekunde
    const sp = dt > 0 ? (dist / dt) * 3.6 : 0;            // km/h
    if (dist > 300) { jumps++; continue; }                 // GPS skok — ne broji
    pathM += dist;
    if (sp > maxSpeed) maxSpeed = sp;
  }
  const pathKm = +(pathM / 1000).toFixed(2);

  if (maxSpeed > 200) flags.push('nemoguća brzina');
  if (jumps > path.length * 0.2 && path.length > 10) flags.push('GPS skakao');
  if (path.length < 2) {
    flags.push('bez putanje');                             // stara verzija app-a ili bez GPS-a
  } else if (km > 2 && pathKm > 0.3 && Math.abs(pathKm - km) > Math.max(2, km * 0.7)) {
    /* Putanju računamo iz GPS-tačaka koje stižu povremeno (svakih par sekundi),
       pa je uvijek nešto kraća od stvarne kilometraže — to je normalno i nije
       greška. Upozorenje palimo tek kad je razlika stvarno velika, da ne visi
       na svakoj gradskoj vožnji. */
    flags.push('kilometraža ne odgovara putanji');
  }
  return { reject: null, flags, pathKm };
}

/* ══════════════════════════════════════════════════════════════════
   NALOZI RADNIKA — prijava, lozinka (PIN), sesija

   Kako radi:
     1. Dispečer u Platformi doda radnika  → server napravi KOD (npr. PUT-4821)
        i nasumičan 6-cifreni PIN. PIN se prikaže dispečeru SAMO TADA.
     2. Radnik u svojoj aplikaciji upiše kod + PIN → dobije token (sesiju).
     3. Svaka akcija radnika (lokacija, izmjena profila, završetak zadatka)
        nosi taj token. Bez tokena — nema pristupa.

   PIN se NE čuva u čistom obliku: čuva se sha256(salt + pin).
   Za pilot je ovo dovoljno; kod prelaska na Supabase preseliti na bcrypt/argon2.
   ══════════════════════════════════════════════════════════════════ */
const DEPT_PREFIX = { putevi: 'PUT', voda: 'VOD', elektro: 'ELE', cistoca: 'CIS' };
const SESSION_MS = 30 * 864e5;                    // sesija traje 30 dana

function hashPin(pin, salt) {
  return crypto.createHash('sha256').update(String(salt) + ':' + String(pin)).digest('hex');
}
function newPin() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
function newCode(dept) {
  const pre = DEPT_PREFIX[String(dept || '').toLowerCase()] || 'RAD';
  let code;
  do { code = pre + '-' + String(crypto.randomInt(1000, 10000)); }
  while (DB.workers.some(w => w.code === code));
  return code;
}
function setPin(w, pin) {
  w.salt = crypto.randomBytes(8).toString('hex');
  w.pinHash = hashPin(pin, w.salt);
  w.pinAt = Date.now();
}
/* Radnik kakvog vide dispečer i ostali — bez ijednog tajnog polja. */
/* ── ŠTA JAVNOST SMIJE VIDJETI O PRIJAVI ──
   Prijave su javne namjerno — u tome je i smisao: građani vide da se problemi
   rješavaju. Ali dosad je svako mogao preuzeti listu i dobiti PUNO IME uz
   TAČNU adresu, pa vezati osobu za kuću ("rupa pred mojom kućom, Titova 14").
   Zato javnosti dajemo skraćeno ime (Ana P.), a dispečer i dalje vidi sve.
   Nikad ne izlaze: lista glasača (sadrži IP adrese), token i userId. */
function shortName(n) {
  var s = String(n || '').trim();
  if (!s) return '';
  var d = s.split(/\s+/);
  return d.length < 2 ? d[0] : d[0] + ' ' + d[1].charAt(0).toUpperCase() + '.';
}
function pubReport(r) {
  var o = {};
  for (var k in r) {
    if (k === 'voters' || k === 'token' || k === 'userId' || k === 'ip') continue;
    o[k] = r[k];
  }
  o.name = shortName(r.name);

  /* ── FOTOGRAFIJE SE PRVO PREGLEDAJU ──
     Svako može poslati sliku, pa i neprimjerenu. Dok je dispečer ne odobri,
     javnost je ne vidi — prijava se prikazuje normalno, samo bez slike.
     Ovo je jedina pouzdana zaštita koja ne košta ništa: provjera u pregledaču
     se zaobiđe u deset sekundi, a vanjski servisi za prepoznavanje traže
     plaćeni ključ. Dispečer ionako gleda svaku prijavu. */
  if (r.photoOk !== true) {
    o.photo = null;
    o.photoPending = !!r.photo;      // aplikacija može reći "slika se pregleda"
  }
  if (r.photoRejected) { o.photo = null; o.photoPending = false; }
  if (r.work && r.work.byName) {
    o.work = Object.assign({}, r.work, { byName: shortName(r.work.byName) });
  }
  return o;
}
function pubWorker(w) {
  return {
    id: w.id, code: w.code, name: w.name, role: w.role, dept: w.dept, city: w.city,
    av: w.av, phone: w.phone || '', vehicle: w.vehicle || '',
    shiftFrom: w.shiftFrom || '', shiftTo: w.shiftTo || '', photo: w.photo || null,
    active: w.active !== false, lat: w.lat, lng: w.lng, locTs: w.locTs,
    lastSeen: w.lastSeen || null, created: w.created
  };
}
/* Nađi radnika po tokenu iz tijela zahtjeva ili iz ?token= u URL-u. */
function authWorker(b, u, req) {
  /* Token NE primamo kroz adresu (?token=...). Adrese se zapisuju u serverske
     logove, u historiju pregledača i šalju se stranim sajtovima kroz Referer
     zaglavlje — token bi tako procurio i tuđa osoba bi se mogla prijaviti kao
     radnik. Prima se samo iz tijela zahtjeva ili iz zaglavlja X-Pinit-Token. */
  const t = (b && b.token) ||
            (req && req.headers && req.headers['x-pinit-token']) || null;
  if (!t) return null;
  const w = DB.workers.find(x => x.token === t);
  if (!w) return null;
  if (w.tokenAt && Date.now() - w.tokenAt > SESSION_MS) return null;   // sesija istekla
  if (w.active === false) return null;                                 // nalog ugašen
  w.lastSeen = Date.now();
  return w;
}
/* Zaštita od pogađanja PIN-a: 8 pokušaja, pa pauza od 15 min. */
const LOGIN_TRIES = 8, LOGIN_LOCK_MS = 15 * 60e3;
function loginBlocked(w) {
  return w.lockUntil && Date.now() < w.lockUntil;
}
function loginFailed(w) {
  w.fails = (w.fails || 0) + 1;
  if (w.fails >= LOGIN_TRIES) { w.lockUntil = Date.now() + LOGIN_LOCK_MS; w.fails = 0; }
}

/* Migracija: radnici napravljeni prije ove verzije nemaju kod ni PIN.
   Dodijeli im ih pri pokretanju da prijava radi i za njih. Novi PIN se
   ispiše u konzolu servera — dispečer ga može i resetovati iz Platforme. */
function migrateWorkers() {
  let changed = 0;
  DB.workers.forEach(w => {
    if (!w.code) { w.code = newCode(w.dept); changed++; }
    if (!w.pinHash) {
      const pin = newPin(); setPin(w, pin); changed++;
      console.log('🔑 Radnik bez naloga: ' + w.name + ' → kod ' + w.code + ' · PIN ' + pin);
    }
    if (w.active === undefined) w.active = true;
  });
  if (changed) save();
}

/* ── SIGURNOSNA ZAGLAVLJA ──
   Ovo su upute pregledaču šta smije, a šta ne. Bez njih:
     • pregledač može "pogađati" tip fajla i izvršiti sliku kao skriptu,
     • tuđa stranica može učitati platformu u nevidljivi okvir i navesti
       dispečera da klikne nešto što ne vidi (clickjacking),
     • adresa s podacima o prijavi šalje se stranim sajtovima kroz Referer.

   X-Frame-Options je SAMEORIGIN, a ne DENY, jer platforma NAMJERNO učitava
   komandni centar u okvir — DENY bi razbio Drive karticu.

   Content-Security-Policy dozvoljava tačno ono što aplikacija koristi:
   MapLibre i Chart.js s CDN-a, karte s MapTilera/OSM-a, fotografije kao
   data-URL. Sve ostalo je zabranjeno, pa i kad bi napadač ubacio skriptu,
   ona ne bi mogla poslati podatke na svoj server. */
/* Traka koja stoji preko vrha svake stranice dok je PINIT_NO_AUTH uključen. */
const NOAUTH_BAR =
  '<div style="position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
  'background:#B42318;color:#fff;font:600 12px/1.35 system-ui,sans-serif;' +
  'padding:7px 12px;text-align:center;letter-spacing:.2px">' +
  'ZAŠTITA ISKLJUČENA — svako s ovom adresom ima pun pristup. ' +
  'Obriši PINIT_NO_AUTH prije nego pustiš stranicu u rad.' +
  '</div><div style="height:29px"></div>';

function secHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(self), camera=(self), microphone=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdnjs.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://unpkg.com",
      "img-src 'self' data: blob: https://api.maptiler.com https://*.tile.openstreetmap.org",
      "connect-src 'self' https://api.maptiler.com https://*.tile.openstreetmap.org",
      "worker-src 'self' blob:",
      "font-src 'self' data:",
      "frame-src 'self'",
      "frame-ancestors 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ')
  };
}
/* Stranica za prijavu dispečera. Namjerno je ugrađena u server, a ne
   poseban fajl u /public — tako se ne može zaobići ni slučajno. */
function loginPage(next) {
  return `<!DOCTYPE html><html lang="bs"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>PINIT — prijava</title>
<link rel="icon" href="/icon-192.png">
<script src="/jezik.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
 font:400 15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
 background:linear-gradient(165deg,#1d7a38,#0d4520);color:#12151a}
.c{background:#fff;border-radius:22px;padding:30px 26px;width:100%;max-width:360px;
 box-shadow:0 22px 60px rgba(0,0,0,.34)}
img{height:34px;display:block;margin-bottom:20px}
h1{font-size:20px;font-weight:800;letter-spacing:-.4px}
p{font-size:13px;color:#8a9099;margin:7px 0 20px}
label{font-size:10.5px;font-weight:800;color:#8a9099;text-transform:uppercase;letter-spacing:.6px}
input{width:100%;margin-top:7px;background:#f2f2f7;border:1.5px solid transparent;border-radius:12px;
 padding:13px 14px;font-size:16px;font-family:inherit;color:#12151a;outline:none}
input:focus{border-color:#1a7a34;background:#fff}
button{width:100%;margin-top:16px;padding:15px;border:none;border-radius:13px;background:#1a7a34;
 color:#fff;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer}
button:disabled{opacity:.5}
.e{background:#fdecea;color:#a8261d;font-size:12.5px;font-weight:600;border-radius:11px;
 padding:11px 13px;margin-bottom:14px;display:none}
.e.on{display:block}
.n{font-size:11.5px;color:#8a9099;margin-top:16px;line-height:1.55}
</style></head><body>
<div class="c">
  <img src="/logo.png" alt="PINIT">
  <h1>Pristup za službe</h1>
  <p>Ova strana je samo za dispečere i komunalna preduzeća. Građani koriste
     <a href="/" style="color:#1a7a34">glavnu aplikaciju</a>.</p>
  <div class="e" id="e"></div>
  <label for="p">Lozinka</label>
  <input id="p" type="password" autocomplete="current-password" autofocus>
  <button id="b">Prijavi se</button>
  ${ADMIN_GENERATED ? `<div style="margin-top:16px;padding:11px 13px;background:#fff8e6;
    border:1px solid #f0d9a0;border-radius:10px;font-size:12.5px;color:#6b4e00;line-height:1.5">
    <b>Lozinka nije postavljena.</b> Server je smislio privremenu — piše u logu
    servisa pri pokretanju (Render → Logs). Ostaje ista i nakon restarta.<br><br>
    Da postaviš svoju: Render → Environment → dodaj <b>PINIT_ADMIN_PASS</b>.
  </div>` : ''}
  <div class="n">Radnici na terenu se prijavljuju svojim kodom i PIN-om u
    <a href="/radnik" style="color:#1a7a34">aplikaciji za radnike</a>.</div>
</div>
<script>
var next=${JSON.stringify(next || '/platforma')};
function go(){
  var b=document.getElementById('b'),e=document.getElementById('e');
  b.disabled=true;b.textContent='Provjeravam...';e.className='e';
  fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({pass:document.getElementById('p').value})})
  .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})
  .then(function(x){
    if(x.ok){location.href=next;return;}
    e.textContent=x.j.error||'Prijava nije uspjela.';e.className='e on';
    b.disabled=false;b.textContent='Prijavi se';
    document.getElementById('p').value='';
  })
  .catch(function(){
    e.textContent='Nema veze sa serverom.';e.className='e on';
    b.disabled=false;b.textContent='Prijavi se';
  });
}
document.getElementById('b').onclick=go;
document.getElementById('p').addEventListener('keydown',function(ev){if(ev.key==='Enter')go();});
</script></body></html>`;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  /* CORS: sve tri aplikacije servira ovaj isti server, pa im CORS ne treba.
     Dok je stajalo '*', bilo koja tuđa stranica mogla je zvati ovaj API iz
     preglednika posjetioca. Ako ikad zatreba pristup s druge adrese, upiši
     je u varijablu PINIT_ALLOW_ORIGIN (može više, odvojeno zarezom). */
  const ALLOWED = (process.env.PINIT_ALLOW_ORIGIN || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  if (req.method === 'OPTIONS') {
    const h = { 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Vary': 'Origin' };
    if (origin && ALLOWED.indexOf(origin) >= 0) {
      h['Access-Control-Allow-Origin'] = origin;
      h['Access-Control-Allow-Credentials'] = 'true';
    }
    res.writeHead(204, h);
    return res.end();
  }

  /* ── PRIJAVA DISPEČERA ── */
  if (p === '/api/admin/login' && req.method === 'POST') {
    return readBody(req, b => {
      const ip = clientIp(req);
      if (adminBlocked(ip))
        return json(res, 429, { error: 'Previše pogrešnih pokušaja. Pristup je pauziran još ' +
          adminBlockMin(ip) + ' min. Lozinka je možda tačna — sačekaj pa probaj jednom.' });
      if (!b || !sameSecret(b.pass || '', ADMIN_PASS)) {
        adminFail(ip);
        log('⛔ Neuspjela prijava na platformu (' + ip + ')');
        return json(res, 401, { error: 'Pogrešna lozinka.' });
      }
      ADMIN_FAILS.delete(ip);
      const t = crypto.randomBytes(24).toString('hex');
      ADMIN_SESSIONS.set(t, Date.now() + ADMIN_SESSION_MS);
      setAdminCookie(res, t, req, ADMIN_SESSION_MS / 1000);
      log('🔓 Prijava na platformu (' + ip + ')');
      json(res, 200, { ok: true });
    });
  }
  if (p === '/api/admin/logout' && req.method === 'POST') {
    const t = adminCookie(req);
    if (t) ADMIN_SESSIONS.delete(t);
    setAdminCookie(res, '', req, 0);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/verzija' && req.method === 'GET') {
    return json(res, 200, { verzija: PINIT_VERZIJA, vrijeme: new Date().toISOString() });
  }

  if (p === '/api/admin/me' && req.method === 'GET') {
    return json(res, isAdmin(req) ? 200 : 401, { ok: isAdmin(req) });
  }

  /* Zaštita dispečerskih ruta. Sve ispod ovoga smije samo prijavljen
     dispečer; radnička i građanska strana imaju svoje provjere. */
  function needAdmin() {
    if (isAdmin(req)) return false;
    json(res, 401, { error: 'Potrebna prijava dispečera.' });
    return true;
  }

  /* ── API ── */
  if (p === '/api/register' && req.method === 'POST') {
    return readBody(req, b => {
      if (!b || !b.name || !b.city) return json(res, 400, { error: 'name i city su obavezni' });
      const user = {
        id: 'u_' + crypto.randomBytes(5).toString('hex'),
        token: crypto.randomBytes(16).toString('hex'),
        name: String(b.name).slice(0, 60),
        city: String(b.city).slice(0, 60),
        created: Date.now()
      };
      DB.users.push(user); save();
      log('👤 Novi nalog: ' + user.name + ' (' + user.city + ')');
      json(res, 200, { userId: user.id, token: user.token });
    });
  }

  if (p === '/api/reports' && req.method === 'GET') {
    const city = u.searchParams.get('city');
    let list = DB.reports;
    if (city) list = list.filter(r => r.city === city);
    /* Dispečer dobija sve; svi ostali dobijaju očišćenu verziju. */
    const adm = isAdmin(req);
    /* Bez ovoga aplikacija nije mogla prepoznati vlastite prijave (userId se
       ne šalje javno), pa su „Moje prijave" i brojevi u profilu bili prazni. */
    const meUser = DB.users.find(u2 => u2.token === (u.searchParams.get('token') || '\u0000'));
    return json(res, 200, list.slice(-300).map(r => {
      if (adm) return r;
      const o = pubReport(r);
      o.mine = !!(meUser && r.userId === meUser.id);
      return o;
    }));
  }

  /* ── PROVJERA DUPLIKATA prije slanja ── */
  if (p === '/api/reports/check' && req.method === 'POST') {
    return readBody(req, b => {
      if (!b || !b.cat) return json(res, 400, { error: 'cat je obavezan' });
      const d = findOpenDuplicate(b.cat, b.lat, b.lng);
      if (!d) return json(res, 200, { found: null });
      const r = d.report;
      json(res, 200, { found: {
        id: r.id, ts: r.ts, votes: r.votes || 0, confirms: r.confirms || 0,
        note: r.note || '', name: r.name || 'anonimno', status: r.status,
        dist: d.dist
      }});
    });
  }

  if (p === '/api/reports' && req.method === 'POST') {
    return readBody(req, b => {
      if (!b || !b.cat) return json(res, 400, { error: 'cat je obavezan' });
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const chk = abuseCheck(b, ip);
      if (chk.reject) { log('⛔ Odbijena prijava (' + chk.reject + ')'); return json(res, 429, { error: chk.reject }); }
      const user = DB.users.find(x => x.token === b.token) || null;
      const pri = null;
      const r = {
        id: Date.now() * 1000 + Math.floor(Math.random() * 999),
        userId: user ? user.id : null,
        _who: b.token || b.deviceId || ip,
        name: user ? user.name : (b.name || 'anonimno'),
        city: b.city || (user && user.city) || '',
        cat: String(b.cat).slice(0, 30),
        note: String(b.note || '').slice(0, 1000),
        photo: cleanPhoto(b.photo),
        /* Besmislene koordinate (lat 9999) rušile bi kartu i računanje
           udaljenosti — takva prijava se prima, ali bez lokacije. */
        lat: okLat(b.lat) ? b.lat : null,
        lng: okLng(b.lng) ? b.lng : null,
        acc: (typeof b.acc === 'number' && isFinite(b.acc) && b.acc >= 0)
               ? Math.min(Math.round(b.acc), 100000) : null,
        /* Vrijeme prijave dolazi s telefona; ako je sat pogrešno namješten,
           prijava bi ispala iz svih izvještaja. Držimo je u razumnom rasponu. */
        ts: (typeof b.ts === 'number' && b.ts > 15e11 && b.ts < Date.now() + 6e5)
               ? b.ts : Date.now(),
        status: 0, votes: 0, confirms: 0, resolvedAt: null,
        worker: null, cost: null, costAt: null, invoices: [], pri: pri,
        sla: slaFor(b.cat, pri),
        flags: chk.flags,
        rating: null, ratedAt: null,
        recurOf: null, recurDays: null, recurConfirmed: null,
        history: [{ status: 0, t: Date.now() }]
      };
      /* ── PONOVLJENI KVAR ──
         Ako je na istoj lokaciji (≤120 m) isti tip kvara već bio RIJEŠEN, a sada
         opet stiže prijava — to je ponavljanje: popravka nije izdržala.
         Vezujemo novu prijavu na staru; radnik na terenu to još mora potvrditi. */
      const prev = findRecurrence(r);
      if (prev) {
        r.recurOf = prev.id;
        r.recurDays = Math.round((r.ts - prev.resolvedAt) / 864e5);
        prev.recurredBy = (prev.recurredBy || []).concat([r.id]);
        log('🔁 PONOVLJENI KVAR: ' + r.cat + ' se vratio nakon ' + r.recurDays +
            ' dana (prijava ' + prev.id + ' bila označena riješenom)');
      }
      DB.reports.push(r); save();
      log('📨 Nova prijava: ' + r.cat + ' · ' + r.city + ' · ' + r.name +
          (r.lat ? ' @ ' + r.lat.toFixed(5) + ',' + r.lng.toFixed(5) : ' (bez GPS-a)'));
      json(res, 200, { ok: true, id: r.id, recurOf: r.recurOf, recurDays: r.recurDays });
    });
  }

  /* ── OCJENA GRAĐANINA (zatvara krug: prijava → popravka → ocjena) ── */
  let mr = p.match(/^\/api\/reports\/(\d+)\/rate$/);
  if (mr && req.method === 'POST') {
    return readBody(req, b => {
      const r = DB.reports.find(x => String(x.id) === mr[1]);
      if (!r) return json(res, 404, { error: 'nema prijave' });
      const s = b && Number(b.score);
      if (!(s >= 1 && s <= 5)) return json(res, 400, { error: 'score 1-5' });
      r.rating = Math.round(s); r.ratedAt = Date.now();
      save();
      log('⭐ Ocjena građanina: ' + r.cat + ' → ' + r.rating + '/5');
      json(res, 200, { ok: true, rating: r.rating });
    });
  }

  let m = p.match(/^\/api\/reports\/(\d+)\/vote$/);
  if (m && req.method === 'POST') {
    return readBody(req, b => {
      const r = DB.reports.find(x => String(x.id) === m[1]);
      if (!r) return json(res, 404, { error: 'nema prijave' });

      /* ── JEDAN GLAS PO KORISNIKU ──
         Dosad je isti pozivalac mogao poslati trideset zahtjeva i dodati
         trideset glasova. Glasovi određuju prioritet, pa je to značilo da se
         redoslijed radova mogao naručiti — jedna osoba dovede svoju ulicu na
         vrh liste pred stvarnim hitnim slučajevima.
         Sada pamtimo KO je glasao. Ako nema tokena, korisnik se prepoznaje po
         adresi; nije savršeno (dijeljena mreža), ali zaustavlja pumpanje. */
      const voter = (b && typeof b.token === 'string' && b.token)
        ? 'u:' + b.token.slice(0, 32)
        : 'ip:' + clientIp(req);
      if (!Array.isArray(r.voters)) r.voters = [];

      const had = r.voters.indexOf(voter) >= 0;
      const wantsDown = !!(b && b.delta === -1);

      if (wantsDown) {
        if (!had) return json(res, 200, { ok: true, votes: r.votes || 0, voted: false });
        r.voters.splice(r.voters.indexOf(voter), 1);
        r.votes = Math.max(0, (r.votes || 0) - 1);
        r.confirms = Math.max(0, (r.confirms || 0) - 1);
      } else {
        if (had) return json(res, 200, { ok: true, votes: r.votes || 0, voted: true });
        r.voters.push(voter);
        r.votes = Math.max(0, (r.votes || 0) + 1);
        r.confirms = Math.max(0, (r.confirms || 0) + 1);
      }
      save();
      json(res, 200, { ok: true, votes: r.votes, voted: !wantsDown });
    });
  }

  /* ── PREGLED FOTOGRAFIJA (dispečer) ──
     Lista prijava koje čekaju pregled slike, i odluka odobri/odbij.
     Odbijena slika se BRIŠE iz baze, ne samo skriva — nema smisla čuvati
     neprimjeren sadržaj, a i baza je ograničena. */
  if (p === '/api/photos/pending' && req.method === 'GET') {
    if (needAdmin()) return;
    const list = DB.reports
      .filter(r => r.photo && r.photoOk !== true && !r.photoRejected)
      .slice(-100)
      .map(r => ({ id: r.id, cat: r.cat, city: r.city, ts: r.ts,
                   name: r.name || '', note: r.note || '', photo: r.photo,
                   flags: (r.photoFlags || []).length }));
    return json(res, 200, list);
  }
  m = p.match(/^\/api\/reports\/(\d+)\/photo$/);
  if (m && req.method === 'POST') {
    if (needAdmin()) return;
    return readBody(req, b => {
      const r = DB.reports.find(x => String(x.id) === m[1]);
      if (!r) return json(res, 404, { error: 'nema prijave' });
      if (b && b.ok === true) {
        r.photoOk = true; r.photoRejected = false;
        log('🖼  Fotografija odobrena (prijava ' + r.id + ')');
      } else {
        r.photo = null;                 // briši sadržaj, ne samo označi
        r.photoOk = false; r.photoRejected = true;
        r.photoRejectedAt = Date.now();
        log('🚫 Fotografija odbijena i obrisana (prijava ' + r.id + ')');
      }
      save();
      json(res, 200, { ok: true, photoOk: !!r.photoOk, rejected: !!r.photoRejected });
    });
  }
  /* ── PRIJAVA NEPRIMJERENE SLIKE (bilo ko) ──
     Ako neprimjerena slika prođe pregled, svaki korisnik je može prijaviti.
     Nakon tri prijave slika se automatski skriva do ponovnog pregleda —
     bolje pogriješiti u korist skrivanja nego ostaviti nešto ružno na ekranu. */
  m = p.match(/^\/api\/reports\/(\d+)\/flag$/);
  if (m && req.method === 'POST') {
    return readBody(req, b => {
      const r = DB.reports.find(x => String(x.id) === m[1]);
      if (!r) return json(res, 404, { error: 'nema prijave' });
      if (!Array.isArray(r.photoFlags)) r.photoFlags = [];
      const who = (b && typeof b.token === 'string' && b.token)
        ? 'u:' + b.token.slice(0, 32) : 'ip:' + clientIp(req);
      if (r.photoFlags.indexOf(who) < 0) r.photoFlags.push(who);
      if (r.photoFlags.length >= 3 && r.photoOk === true) {
        r.photoOk = false;              // vrati na pregled
        log('⚠  Slika vraćena na pregled nakon ' + r.photoFlags.length + ' prijava (' + r.id + ')');
      }
      save();
      json(res, 200, { ok: true, flags: r.photoFlags.length });
    });
  }

  m = p.match(/^\/api\/reports\/(\d+)$/);
  if (m && req.method === 'PATCH') {
    return readBody(req, b => {
      const r = DB.reports.find(x => String(x.id) === m[1]);
      if (!r) return json(res, 404, { error: 'nema prijave' });

      /* Ovu rutu koriste i dispečer i radnik, pa se ne može zaključati u
         cjelini — provjeravamo polje po polje.

           dispečer  → dodjela radnika, računi, prioritet
           radnik    → samo NA SVOJOJ prijavi: status, foto dokaz, izvještaj
           niko drugi→ ništa

         Radnik smije mijenjati samo prijavu koja je njemu dodijeljena. Bez
         te provjere bi jedan radnik mogao zatvarati tuđe zadatke. */
      const adm = isAdmin(req);
      const wk  = authWorker(b, u, req);
      const mine = !!(wk && r.worker === wk.id);
      if (!adm && !mine)
        return json(res, 403, { error: 'Nemaš pravo mijenjati ovu prijavu.' });

      const dispatcherOnly = ['worker', 'cost', 'invoices', 'pri', 'sla'];
      if (!adm) {
        for (const k of dispatcherOnly) {
          if (b && k in b)
            return json(res, 403, { error: 'Polje "' + k + '" mijenja samo dispečer.' });
        }
      }

      if (b && typeof b.status === 'number' && b.status >= 0 && b.status <= 3) {
        r.status = b.status;
        r.history.push({ status: b.status, t: Date.now() });
        if (b.status === 3) r.resolvedAt = Date.now();
        log('🔧 Status prijave ' + r.cat + ' → ' + ['čeka', 'obaviještena služba', 'u toku', 'riješeno'][b.status]);
      }
      if (b && 'worker' in b) {
        r.worker = b.worker;
        const w = DB.workers.find(x => x.id === b.worker);
        log('👷 Dodijeljeno: ' + r.cat + ' → ' + (w ? w.name : 'nitko'));
      }
      if (b && typeof b.cost === 'number') {
        r.cost = (b.cost < 0) ? null : b.cost;          // -1 = obriši račun
        r.costAt = r.cost == null ? null : Date.now();
        log('🧾 Račun ' + (r.cost == null ? 'obrisan' : r.cost + ' KM') + ' · ' + r.cat);
      }
      if (b && typeof b.pri === 'string') r.pri = b.pri;
      /* Radnik na terenu potvrđuje da se kvar STVARNO ponovio (ili da nije isti kvar).
         Tek potvrđeno ponavljanje ulazi u statistiku kao propala popravka. */
      if (b && typeof b.recurConfirmed === 'boolean') {
        r.recurConfirmed = b.recurConfirmed;
        r.recurConfirmedAt = Date.now();
        const w = DB.workers.find(x => x.id === r.worker);
        log('🔁 Radnik ' + (w ? w.name : '?') + ' ' +
            (b.recurConfirmed ? 'POTVRDIO' : 'odbacio') + ' ponavljanje kvara: ' + r.cat);
      }
      if (b && Array.isArray(b.invoices)) {
        r.invoices = b.invoices.slice(0, 12).map(x => ({
          amount: (typeof x.amount === 'number' && x.amount >= 0) ? Math.round(x.amount * 100) / 100 : 0,
          img: cleanPhoto(x.img),
          at: x.at || Date.now()
        }));
        r.cost = r.invoices.length ? r.invoices.reduce((a, x) => a + x.amount, 0) : null;
        r.costAt = r.cost == null ? null : Date.now();
        log('🧾 Računi (' + r.invoices.length + ') · ukupno ' + (r.cost || 0) + ' KM · ' + r.cat);
      }
      if (b && 'photoBefore' in b) r.photoBefore = cleanPhoto(b.photoBefore);
      if (b && 'photoAfter'  in b) r.photoAfter  = cleanPhoto(b.photoAfter);

      /* ── IZVJEŠTAJ S TERENA ──
         Ovo je ono što radnik napiše kad završi: šta je zatekao, šta je uradio,
         šta je potrošio i koliko je trajalo. Ide pravo dispečeru u Platformu.
         Potpisuje se imenom radnika sa servera, ne onim što pošalje telefon —
         da se izvještaj ne može potpisati tuđim imenom. */
      if (b && b.work && typeof b.work === 'object') {
        const wk = authWorker(b, u, req);
        const entry = {
          note: String(b.work.note || '').slice(0, 1500),
          materials: String(b.work.materials || '').slice(0, 500),
          minutes: (typeof b.work.minutes === 'number' && b.work.minutes >= 0)
            ? Math.min(Math.round(b.work.minutes), 60 * 24 * 7) : null,
          startedAt: (typeof b.work.startedAt === 'number') ? b.work.startedAt : null,
          at: Date.now(),
          by: wk ? wk.id : (r.worker || null),
          byName: wk ? wk.name : null,
          lat: (typeof b.work.lat === 'number') ? b.work.lat : null,
          lng: (typeof b.work.lng === 'number') ? b.work.lng : null
        };
        r.work = entry;
        r.workLog = (r.workLog || []).concat([entry]).slice(-20);
        log('📋 Izvještaj s terena · ' + r.cat + ' · ' + (entry.byName || '?') +
            (entry.minutes != null ? ' · ' + entry.minutes + ' min' : '') +
            (entry.note ? ' · "' + entry.note.slice(0, 60) + '"' : ''));
      }
      save();
      json(res, 200, { ok: true, status: r.status, worker: r.worker });
    });
  }

  /* ── RADNICI ── */
  if (p === '/api/workers' && req.method === 'GET') {
    const city = u.searchParams.get('city');
    let list = DB.workers;
    if (city) list = list.filter(w => w.city === city);
    return json(res, 200, list.map(pubWorker));      // nikad PIN ni token napolje
  }

  /* Dispečer dodaje radnika. Odgovor sadrži PIN — jedini put kad se vidi. */
  if (p === '/api/workers' && req.method === 'POST') {
    if (needAdmin()) return;
    return readBody(req, b => {
      if (!b || !b.name) return json(res, 400, { error: 'name je obavezan' });
      const initials = String(b.name).trim().split(/\s+/).map(s => s[0] || '').join('').slice(0, 2).toUpperCase();
      const w = {
        id: 'w_' + crypto.randomBytes(4).toString('hex'),
        name: String(b.name).slice(0, 60),
        role: String(b.role || 'Terenac').slice(0, 40),
        dept: String(b.dept || 'putevi').slice(0, 20),
        city: String(b.city || '').slice(0, 60),
        phone: String(b.phone || '').slice(0, 30),
        vehicle: String(b.vehicle || '').slice(0, 60),
        shiftFrom: String(b.shiftFrom || '').slice(0, 5),
        shiftTo: String(b.shiftTo || '').slice(0, 5),
        photo: null,
        av: initials || '?',
        active: true,
        created: Date.now()
      };
      w.code = newCode(w.dept);
      const pin = newPin(); setPin(w, pin);
      DB.workers.push(w); save();
      log('➕ Novi radnik: ' + w.name + ' (' + w.role + ', ' + w.dept + ') · kod ' + w.code);
      json(res, 200, { ok: true, worker: pubWorker(w), code: w.code, pin: pin });
    });
  }

  /* Dispečer resetuje PIN (radnik ga zaboravio). Novi PIN se vraća jednom. */
  m = p.match(/^\/api\/workers\/(w_[a-f0-9]+)\/pin$/);
  if (m && req.method === 'POST') {
    if (needAdmin()) return;
    const w = DB.workers.find(x => x.id === m[1]);
    if (!w) return json(res, 404, { error: 'nema radnika' });
    const pin = newPin(); setPin(w, pin);
    w.token = null; w.fails = 0; w.lockUntil = 0;      // stara sesija se gasi
    save();
    log('🔑 Reset PIN-a: ' + w.name + ' (' + w.code + ')');
    return json(res, 200, { ok: true, code: w.code, pin: pin });
  }

  /* ── PRIJAVA RADNIKA ── */
  if (p === '/api/worker/login' && req.method === 'POST') {
    return readBody(req, b => {
      const code = String((b && b.code) || '').trim().toUpperCase();
      const pin = String((b && b.pin) || '').trim();

      /* Prekidač za podešavanje: ulazi se samo kodom, bez PIN-a. Ako nema
         nijednog radnika, napravi se privremeni da aplikacija ima šta
         prikazati. Vidi objašnjenje uz NO_AUTH na vrhu fajla. */
      if (NO_AUTH) {
        let w0 = code ? DB.workers.find(x => String(x.code).toUpperCase() === code)
                      : DB.workers[0];
        if (!w0) {
          w0 = {
            id: 'w' + Date.now().toString(36),
            code: 'TEST-0001', name: 'Radnik (podešavanje)',
            role: 'Radnik', dept: 'opšte', city: '', av: '👷',
            active: true, created: Date.now(), salt: '', pinHash: ''
          };
          DB.workers.push(w0);
        }
        w0.token = crypto.randomBytes(24).toString('hex');
        w0.tokenAt = Date.now(); w0.lastSeen = Date.now();
        save();
        log('🔓 Prijava radnika BEZ PIN-a (PINIT_NO_AUTH): ' + w0.name);
        return json(res, 200, { ok: true, token: w0.token, worker: pubWorker(w0) });
      }

      if (!code || !pin) return json(res, 400, { error: 'Upiši kod i PIN.' });
      const w = DB.workers.find(x => String(x.code).toUpperCase() === code);
      /* Ista poruka za pogrešan kod i pogrešan PIN — da se ne može
         "pecanjem" saznati koji kodovi postoje. */
      if (!w) return json(res, 401, { error: 'Pogrešan kod ili PIN.' });
      if (w.active === false) return json(res, 403, { error: 'Nalog je ugašen. Javi se dispečeru.' });
      if (loginBlocked(w)) {
        const min = Math.ceil((w.lockUntil - Date.now()) / 60e3);
        return json(res, 429, { error: 'Previše pokušaja. Pokušaj za ' + min + ' min.' });
      }
      if (hashPin(pin, w.salt) !== w.pinHash) {
        loginFailed(w); save();
        log('⛔ Neuspjela prijava radnika (' + code + ')');
        return json(res, 401, { error: 'Pogrešan kod ili PIN.' });
      }
      w.fails = 0; w.lockUntil = 0;
      w.token = crypto.randomBytes(24).toString('hex');
      w.tokenAt = Date.now(); w.lastSeen = Date.now();
      save();
      log('👷 Prijava radnika: ' + w.name + ' (' + w.code + ')');
      json(res, 200, { ok: true, token: w.token, worker: pubWorker(w) });
    });
  }

  if (p === '/api/worker/logout' && req.method === 'POST') {
    return readBody(req, b => {
      const w = authWorker(b, u, req);
      if (w) { w.token = null; save(); log('👋 Odjava: ' + w.name); }
      json(res, 200, { ok: true });
    });
  }

  /* Aplikacija ovim provjerava je li sačuvana sesija još važeća. */
  if (p === '/api/worker/me' && req.method === 'GET') {
    const w = authWorker(null, u, req);
    if (!w) return json(res, 401, { error: 'Sesija je istekla. Prijavi se ponovo.' });
    save();
    return json(res, 200, { ok: true, worker: pubWorker(w) });
  }

  /* Radnik mijenja svoj PIN. */
  if (p === '/api/worker/pin' && req.method === 'POST') {
    return readBody(req, b => {
      const w = authWorker(b, u, req);
      if (!w) return json(res, 401, { error: 'Sesija je istekla.' });
      const oldP = String((b && b.oldPin) || ''), newP = String((b && b.newPin) || '');
      if (hashPin(oldP, w.salt) !== w.pinHash) return json(res, 401, { error: 'Trenutni PIN nije tačan.' });
      if (!/^\d{4,8}$/.test(newP)) return json(res, 400, { error: 'Novi PIN mora imati 4–8 cifara.' });
      setPin(w, newP); save();
      log('🔑 Radnik promijenio PIN: ' + w.name);
      json(res, 200, { ok: true });
    });
  }

  /* ── RADNIK UREĐUJE SVOJ PROFIL ──
     Mijenja samo ono što je njegovo: ime, uloga, telefon, vozilo, smjena, slika.
     Službu (dept) i grad postavlja dispečer — radnik ih ne može sam mijenjati. */
  m = p.match(/^\/api\/workers\/(w_[a-f0-9]+)$/);
  if (m && req.method === 'PATCH') {
    return readBody(req, b => {
      const w = authWorker(b, u, req);
      if (!w || w.id !== m[1]) return json(res, 403, { error: 'Nemaš pravo mijenjati ovaj profil.' });
      if (b && typeof b.name === 'string' && b.name.trim()) {
        w.name = b.name.trim().slice(0, 60);
        w.av = w.name.split(/\s+/).map(s => s[0] || '').join('').slice(0, 2).toUpperCase() || '?';
      }
      if (b && typeof b.role === 'string') w.role = b.role.trim().slice(0, 40);
      if (b && typeof b.phone === 'string') w.phone = b.phone.trim().slice(0, 30);
      if (b && typeof b.vehicle === 'string') w.vehicle = b.vehicle.trim().slice(0, 60);
      if (b && typeof b.shiftFrom === 'string') w.shiftFrom = b.shiftFrom.slice(0, 5);
      if (b && typeof b.shiftTo === 'string') w.shiftTo = b.shiftTo.slice(0, 5);
      if (b && 'photo' in b) w.photo = (b.photo === null) ? null : cleanPhoto(b.photo, 3e6);
      w.updated = Date.now();
      save();
      log('✎ Profil ažuriran: ' + w.name);
      json(res, 200, { ok: true, worker: pubWorker(w) });
    });
  }

  /* Lokacija radnika — samo radnik za sebe, i samo sa tokenom. */
  m = p.match(/^\/api\/workers\/(w_[a-f0-9]+)\/loc$/);
  if (m && req.method === 'POST') {
    return readBody(req, b => {
      const w = authWorker(b, u, req);
      if (!w || w.id !== m[1]) return json(res, 403, { error: 'nije dozvoljeno' });
      if (b && okLat(b.lat) && okLng(b.lng)) {
        w.lat = b.lat; w.lng = b.lng;
        w.acc = (typeof b.acc === 'number' && isFinite(b.acc) && b.acc >= 0)
                  ? Math.min(Math.round(b.acc), 100000) : null;
        w.locTs = Date.now(); save();
      }
      json(res, 200, { ok: true });
    });
  }

  m = p.match(/^\/api\/workers\/(w_[a-f0-9]+)$/);
  if (m && req.method === 'DELETE') {
    if (needAdmin()) return;
    const i = DB.workers.findIndex(w => w.id === m[1]);
    if (i < 0) return json(res, 404, { error: 'nema radnika' });
    const w = DB.workers.splice(i, 1)[0];
    DB.reports.forEach(r => { if (r.worker === w.id) r.worker = null; });
    save();
    return json(res, 200, { ok: true });
  }

  if (p === '/api/drives' && req.method === 'GET') {
    const city = u.searchParams.get('city');
    let list = DB.drives;
    if (city) list = list.filter(d => d.city === city);
    return json(res, 200, list.slice(-100));
  }

  if (p === '/api/drives' && req.method === 'POST') {
    return readBody(req, b => {
      if (!b || !b.drive) return json(res, 400, { error: 'drive je obavezan' });
      const v = validateDrive(b.drive);
      if (v.reject) { log('⛔ Odbijena vožnja (' + v.reject + ')'); return json(res, 400, { error: v.reject }); }
      const rec = {
        id: 'd_' + Date.now() + '_' + Math.floor(Math.random() * 999),
        ts: Date.now(),
        deviceId: b.deviceId || null,
        city: b.city || '',
        name: b.name || '',
        flags: v.flags,
        pathKm: v.pathKm,
        drive: b.drive
      };
      DB.drives.push(rec); save();
      const d = b.drive;
      log('🚗 Nova vožnja: ' + (d.km || 0) + ' km · ' +
          ((d.segments || []).length) + ' segmenata · ' + ((d.bumps || []).length) + ' udara · ' + rec.city +
          (v.flags.length ? ' · ⚠ ' + v.flags.join(', ') : ''));
      json(res, 200, { ok: true, id: rec.id, flags: v.flags });
    });
  }

  if (p === '/api/stats' && req.method === 'GET') {
    const city = u.searchParams.get('city');
    const R = city ? DB.reports.filter(r => r.city === city) : DB.reports;
    const D = city ? DB.drives.filter(d => d.city === city) : DB.drives;
    return json(res, 200, {
      users: DB.users.length, reports: R.length,
      resolved: R.filter(r => r.status === 3).length,
      inProgress: R.filter(r => r.status === 1 || r.status === 2).length,
      drives: D.length,
      km: +D.reduce((s, d) => s + (d.drive.km || 0), 0).toFixed(1),
      bumps: D.reduce((s, d) => s + (d.drive.bumps || []).length, 0)
    });
  }

  /* ── statika ── */
  let file = null;
  if (p === '/' || p === '/app') file = 'app.html';
  else if (p === '/komandni') file = 'komandni.html';
  else if (p === '/platforma' || p === '/platform') file = 'platforma.html';
  else if (p === '/radnik') file = 'radnik.html';
  else file = p.replace(/^\/+/, '').replace(/\.\./g, '');

  /* Dispečerske stranice se ne serviraju bez prijave. Skrivanje ekrana u
     pregledniku ne bi bilo dovoljno — cijeli HTML bi se ipak preuzeo, a s
     njim i sve što je u njemu. Zato ih server uopšte ne šalje. */
  const LOCKED = ['platforma.html', 'komandni.html', 'platforma-radnici.js'];
  if (LOCKED.indexOf(file) >= 0 && !isAdmin(req)) {
    res.writeHead(200, Object.assign({ 'Content-Type': MIME['.html'] }, secHeaders()));
    return res.end(loginPage(p));
  }

  const fp = path.join(PUB, file);
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    const ext = path.extname(fp);

    /* Oznake za pregled linka (og:image, og:url) moraju sadržavati punu adresu.
       Ona ovisi o tome gdje sistem radi — localhost, lokalna mreža ili Render —
       pa je upisujemo ovdje, iz zaglavlja zahtjeva. Čitači pregleda (Viber,
       WhatsApp, Facebook) ne izvršavaju JavaScript, pa se to ne može riješiti
       u pregledniku. */
    if (ext === '.html') {
      let html = buf.toString('utf8');
      if (html.indexOf('__PINIT_ORIGIN__') >= 0) {
        const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
                      (req.socket.encrypted ? 'https' : 'http');
        const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
        const origin = host ? proto + '://' + host : '';
        html = html.split('__PINIT_ORIGIN__').join(origin);
      }
      /* Vidljiva traka dok je zaštita isključena — log se previdi, ovo ne.
         Bez ovoga je lako zaboraviti PINIT_NO_AUTH i ostaviti platformu
         otvorenu na javnoj adresi. */
      if (NO_AUTH) html = html.replace(/<body([^>]*)>/i, '<body$1>' + NOAUTH_BAR);
      res.writeHead(200, Object.assign({ 'Content-Type': MIME['.html'],
        'Cache-Control': 'no-cache, must-revalidate' }, secHeaders()));
      return res.end(html);
    }

    /* Slike se rijetko mijenjaju, a čitači pregleda ih dovlače više puta —
       neka ih drže u kešu jedan dan da se ne prenose bez potrebe. */
    const head = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.png' || ext === '.svg') head['Cache-Control'] = 'public, max-age=86400';
    /* Skripte i podešavanja moraju se provjeriti pri svakom otvaranju — dok se
       ovo keširalo, izmjene (npr. prijevodi u jezik.js) nisu stizale do telefona. */
    else head['Cache-Control'] = 'no-cache, must-revalidate';
    res.writeHead(200, head);
    res.end(buf);
  });
});

/* Server se ne smije javiti prije nego su podaci u memoriji — inače bi prvi
   posjetilac vidio prazan sistem, a prvi upis pregazio sve što je u bazi. */
loadDB().then(izvor => {
  migrateWorkers();
  pripremiLozinku();          // tek sad, kad znamo šta je u bazi
  log('PINIT verzija ' + PINIT_VERZIJA);
  server.listen(PORT, '0.0.0.0', () => {
    const nets = os.networkInterfaces(); let lan = null;
    for (const k of Object.keys(nets)) for (const n of nets[k])
      if (n.family === 'IPv4' && !n.internal) { lan = n.address; break; }
    console.log('════════════════════════════════════════════════');
    console.log(' PINIT server radi.');
    console.log('   Na ovom računaru:  http://localhost:' + PORT);
    if (lan) {
      console.log('   Sa telefona (ista Wi-Fi mreža):');
      console.log('       aplikacija:      http://' + lan + ':' + PORT);
      console.log('       komandni (Drive): http://' + lan + ':' + PORT + '/komandni');
      console.log('       platforma (prijave): http://' + lan + ':' + PORT + '/platforma');
    }
    console.log('   Podaci: ' + izvor);
    console.log('           ' + DB.reports.length + ' prijava · ' +
                DB.workers.length + ' radnika · ' + DB.drives.length + ' vožnji');
    if (!SB_ON) {
      console.log('   ⚠  SUPABASE_URL/SUPABASE_KEY nisu postavljeni.');
      console.log('      Podaci se čuvaju u data.json i BRIŠU se pri svakom deployu.');
    }
    console.log('   ──────────────────────────────────────────────');
    /* ── DIJAGNOSTIKA LOZINKE ──
       Kad čovjek postavi PINIT_ADMIN_PASS a server je i dalje ne vidi, uzrok
       je skoro uvijek greška u NAZIVU varijable, razmak u nazivu, ili je
       postavljena na drugom servisu. Zato ispisujemo šta program STVARNO
       vidi u okruženju. Vrijednosti se NE ispisuju, samo nazivi i dužina. */
    var envPass = process.env.PINIT_ADMIN_PASS;
    if (typeof envPass === 'string' && envPass.length) {
      console.log('   🔑 Lozinka: iz PINIT_ADMIN_PASS (' + envPass.length + ' znakova)');
      if (/^["'].*["']$/.test(envPass))
        console.log('      ⚠  Vrijednost je u navodnicima — oni su DIO lozinke.');
      if (envPass !== envPass.trim())
        console.log('      ⚠  Ima razmak na početku ili kraju — i on je dio lozinke.');
    } else {
      console.log('   🔑 Lozinka: ugrađena u server.js  →  ' + ADMIN_PASS);
      console.log('      Mijenja se u server.js (UGRADJENA_LOZINKA), ili');
      console.log('      postavi PINIT_ADMIN_PASS ako ne želiš da stoji u kodu.');
    }
    console.log('   ──────────────────────────────────────────────');
    if (NO_AUTH) {
      console.log('');
      console.log('   ██████████████████████████████████████████████');
      console.log('   ██  ZAŠTITA JE ISKLJUČENA  (PINIT_NO_AUTH)  ██');
      console.log('   ██████████████████████████████████████████████');
      console.log('      Platforma i komandni centar se otvaraju BEZ lozinke.');
      console.log('      Radnička aplikacija ulazi BEZ PIN-a.');
      console.log('      Svako ko zna adresu može brisati radnike i vidjeti');
      console.log('      puna imena i fotografije građana.');
      console.log('');
      console.log('      Ovo je samo za podešavanje. Kad završiš, obriši');
      console.log('      varijablu PINIT_NO_AUTH i sve se vraća samo od sebe.');
      console.log('');
    } else if (ADMIN_GENERATED) {
      console.log('   ⚠  PINIT_ADMIN_PASS nije postavljen.');
      console.log('      Lozinka za platformu i komandni centar:');
      console.log('');
      console.log('          ' + ADMIN_PASS);
      console.log('');
      console.log('      Ova lozinka OSTAJE ista i nakon restarta — zapamćena je.');
      console.log('      Da postaviš svoju: dodaj PINIT_ADMIN_PASS u okruženje');
      console.log('      (Render → Environment) i restartuj servis.');
    } else {
      console.log('   🔒 Platforma i komandni centar traže lozinku (PINIT_ADMIN_PASS).');
    }
    console.log('════════════════════════════════════════════════');
  });
}).catch(e => {
  console.error('════════════════════════════════════════════════');
  console.error(' Podaci se ne mogu učitati — server se NEĆE pokrenuti.');
  console.error(' ' + e.message);
  console.error('');
  console.error(' Provjeri SUPABASE_URL i SUPABASE_KEY, i jesu li tabele');
  console.error(' napravljene (vidi SUPABASE.md u folderu projekta).');
  console.error('════════════════════════════════════════════════');
  process.exit(1);
});

/* Render gasi instancu signalom — pokušaj upisati sve što još čeka. */
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, () => {
  clearTimeout(saveT);
  Promise.resolve(SB_ON ? flushSB() : fs.writeFileSync(DATA, JSON.stringify(DB)))
    .catch(() => {}).then(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000);
}));

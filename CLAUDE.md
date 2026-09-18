# CLAUDE.md

## O projektu

- **Šta:** PINIT — sistem za prijavu i rješavanje komunalnih problema. Građanin
  prijavi rupu ili kvar s GPS-om i fotografijom, dispečer dodijeli radnika,
  radnik ga riješi i pošalje foto dokaz. Za gradove i komunalna preduzeća u BiH.
- **Faza:** radna verzija, priprema za pilot. Nema još pravih korisnika.
- **Prioriteti:** da radi na terenu bez signala > brzina. Jasnoća > domišljatost.
  Autor nije programer — kod mora biti čitljiv i komentarisan na našem jeziku.

## Tehnologija

- Node.js 18+, **bez ijedne vanjske biblioteke**. Nema package.json ovisnosti,
  nema build koraka, nema npm install. To je namjerna odluka — ne kvari je.
- Frontend: čisti HTML/CSS/JS u jednom fajlu po aplikaciji. Bez frameworka.
- Karte: MapLibre GL preko CDN-a, zajednički modul `public/maps.js`.
- Baza: Supabase (PostgreSQL) preko REST sučelja i ugrađenog `fetch`.
  Ako varijable nisu postavljene, pada nazad na `data.json`.
- Hosting: Render (free plan).

## Naredbe

```bash
node server.js                          # pokreni (data.json, lokalno)
PINIT_ADMIN_PASS=x node server.js       # sa stalnom lozinkom za dispečera
SUPABASE_URL=... SUPABASE_KEY=... node server.js    # nad pravom bazom
node prenesi-u-supabase.js              # jednokratni prenos data.json u bazu
node -c server.js                       # provjera sintakse
```

Nema testova. Provjera se radi ručno — pokreni server i prođi kroz tok
(vidi „Definicija gotovog").

## Struktura

```
server.js                     cijeli backend — API, prijava, provjere, statika
public/app.html               građanska aplikacija        (/)
public/radnik.html            aplikacija za radnika       (/radnik)
public/platforma.html         dispečerska platforma       (/platforma)
public/platforma-radnici.js   dodatak platformi — ne dira platforma.html
public/komandni.html          komandni centar za ceste    (/komandni)
public/maps.js                zajednički modul za karte
SUPABASE.md                   uputstvo za bazu
UPUTSTVO.md                   uputstvo za svakodnevni rad
```

## Definicija gotovog

Zadatak je gotov tek kad **sve** ovo prođe:

1. `node -c server.js` bez greške (i za svaki izmijenjeni JS)
2. Server stvarno pokrenut i promjena isprobana — pozvan endpoint, otvorena stranica
3. Prošao osnovni tok: dispečer se prijavi → doda radnika → radnik se prijavi →
   građanin prijavi problem → dispečer dodijeli → radnik završi s izvještajem
4. Provjereno da nije pokvarena nijedna od tri aplikacije

Nikad ne tvrdi da nešto radi bez provjere. Ako se ne može provjeriti, reci to otvoreno.

## Konvencije

- **Komentari na bosanskom**, i objašnjavaju *zašto*, ne *šta*. Autor se vraća
  kodu nakon sedmica pauze.
- Poruke korisniku su na bosanskom, ljudske, bez tehničkog žargona.
  Ne „Error 403" nego „Nemaš pravo mijenjati ovu prijavu."
- Ne uvodi ovisnosti. Ako nešto traži npm paket, prvo pitaj.
- Ne diraj `platforma.html` ako se isto može uraditi u `platforma-radnici.js`.
- Novi API poziv → odmah odluči ko ga smije zvati i dodaj provjeru na serveru.
  Skrivanje dugmeta u pregledniku nije zaštita.
- Fotografije se smanjuju u pregledniku prije slanja, nikad se ne šalju sirove.

## Ovlaštenja — provjeravaj na serveru

| Ko | Kako se prepoznaje |
|---|---|
| Građanin | bez prijave |
| Radnik | token iz `authWorker(b, u)` |
| Dispečer | HttpOnly kolačić, `isAdmin(req)` / `needAdmin()` |

Radnik smije mijenjati **samo prijavu koja je njemu dodijeljena**, i samo svoja
polja. Polja `worker`, `cost`, `invoices`, `pri`, `sla` mijenja isključivo dispečer.

## Poznata ograničenja (ne prijavljuj kao nove greške)

- Jedna zajednička lozinka za sve dispečere — nema traga ko je šta uradio.
- Fotografije se čuvaju u bazi, ne na zasebnom prostoru za fajlove.
- Sesije dispečera žive u memoriji — restart servera odjavi sve.
- PIN-ovi se čuvaju kao sha256 sa soli, ne bcrypt.
- Nema moderacije sadržaja fotografija.

## Kad staneš i pitaš

- Prije uvođenja bilo koje vanjske biblioteke ili build koraka
- Prije mijenjanja strukture podataka koja je već u bazi
- Prije bilo čega što dira lozinke, PIN-ove ili ovlaštenja
- Kad rješenje traži da se `platforma.html` prepiše u većem dijelu

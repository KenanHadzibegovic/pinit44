# PINIT — kako pokrenuti sistem

## Šta je u paketu
- `server.js` — server (čisti Node.js, bez ikakvih instalacija)
- `public/app.html` — mobilna aplikacija V5 (prijave + Drive mjerenje)
- `public/platforma.html` — operativna platforma za PRIJAVE građana (dispečer, radnici, SLA, analitika)
- `public/komandni.html` — komandni centar za DRIVE (stanje cesta, IRI, žarišta)
- `data.json` — nastaje sam; tu su nalozi, prijave, vožnje i radnici

## Ko šta koristi
- Građanin → `app.html`: prijavljuje probleme i mjeri ceste dok vozi
- Dispečer / komunalno → `platforma.html`: prima prijave, dodjeljuje radnicima, mijenja status
- Grad / uprava → `komandni.html`: prati stanje cesta iz Drive vožnji

Isti tok podataka:
  V5 prijava  → server → PLATFORMA (dispečer dodjeljuje, rješava) → status nazad u V5
  V5 vožnja   → server → KOMANDNI (analiza stanja mreže)

## A) Test kod kuće (telefon + laptop na istoj Wi-Fi)
1. Instaliraj Node.js sa nodejs.org
2. `node server.js`
3. Server ispiše adrese:
   - aplikacija:          http://192.168.x.x:3000
   - platforma (prijave): http://192.168.x.x:3000/platforma
   - komandni (Drive):    http://192.168.x.x:3000/komandni
4. Telefon → aplikacija → nalog → prijavi problem
5. Laptop → platforma → prijava se pojavi u "Zadaci"; dodaj radnika (Radnici uživo →
   "➕ Dodaj radnika"), dodijeli mu zadatak, označi riješeno → status se vidi u aplikaciji
   NAPOMENA: preko običnog http GPS/senzori rade samo na localhost — za telefon koristi
   online varijantu (B) ili HTTPS tunel (npx localtunnel --port 3000).

## B) Online (Render — HTTPS, radi svugdje)
Netlify NE radi za ovo (samo statika). Render:
1. Cijeli folder na GitHub (server.js mora biti na vrhu, ne u podfolderu)
2. render.com → New → Web Service → poveži repo → prepozna render.yaml → Deploy
3. Adrese:
   - https://ime.onrender.com            (aplikacija)
   - https://ime.onrender.com/platforma  (prijave)
   - https://ime.onrender.com/komandni   (Drive)
Free plan: server zaspi nakon 15 min (prvi ulaz ~30 s) i data.json se briše pri deployu —
za test uredu; za pravi pilot dodajemo bazu.

## Prijava za dispečera (platforma i komandni centar)

Platforma i komandni centar više se ne otvaraju bez lozinke. Server ih uopšte
ne šalje neprijavljenom posjetiocu — umjesto njih stiže strana za prijavu.

### Postavljanje lozinke

Lozinka se **ne čuva u data.json** nego u varijabli okruženja, jer se data.json
na Render free planu briše pri svakom deployu — nalog spremljen u njemu bi
nestao i zaključao te van vlastitog sistema.

**Na Renderu:** Dashboard → tvoj servis → Environment → Add Environment Variable
→ Key `PINIT_ADMIN_PASS`, Value tvoja lozinka → Save. Servis se sam ponovo
pokrene.

**Lokalno:**
```
PINIT_ADMIN_PASS=nekalozinka node server.js
```

Ako varijabla nije postavljena, server pri pokretanju sam smisli lozinku i
ispiše je u konzolu. Tako lokalni rad radi bez podešavanja, ali sistem nikad
ne ostaje otključan. Ta lozinka se mijenja pri svakom pokretanju.

Sesija traje 12 sati. Deset pogrešnih pokušaja s iste adrese → pauza 15 minuta.
Odjava je dugmetom na dnu bočne trake.

Za sada je to **jedna zajednička lozinka** za sve dispečere. To znači da se u
zapisniku ne vidi ko je tačno šta uradio. Odvojeni nalozi po osobi dolaze
zajedno s prelaskom na pravu bazu.

### Ko šta smije

| | Građanska app | Radnička app | Platforma |
|---|---|---|---|
| Otvaranje | svako | kod + PIN | lozinka |
| Prijava problema | da | da | da |
| Mijenjanje statusa | ne | samo svoj zadatak | sve |
| Dodjela radnika | ne | ne | da |
| Računi i troškovi | ne | ne | da |
| Dodavanje/brisanje radnika | ne | ne | da |
| Reset PIN-a radniku | ne | ne | da |

Radnik može mijenjati **samo prijavu koja je njemu dodijeljena**, i samo svoja
polja: status, foto dokaz i izvještaj. Pokušaj da upiše račun ili prebaci
zadatak na sebe server odbija.

## Provjera ulaznih podataka

Server više ne vjeruje ničemu što stigne s mreže, ni kad dolazi iz naše
aplikacije — zahtjev može poslati bilo ko:

- Koordinate izvan opsega (lat ±90, lng ±180) se odbacuju; prijava se prima, ali bez lokacije.
- Fotografija mora stvarno biti JPEG, PNG ili WebP. Skripta preobučena u sliku se odbacuje.
- Vrijeme prijave s pogrešno namještenog telefonskog sata se zamjenjuje stvarnim.
- CORS je zatvoren: tuđe stranice više ne mogu zvati ovaj API iz preglednika
  posjetioca. Ako ikad zatreba pristup s druge adrese → varijabla `PINIT_ALLOW_ORIGIN`.

Fotografije iz građanske aplikacije se sada smanjuju na 1280 px prije slanja
(oko 200 KB umjesto 3–5 MB). Rupa na cesti se vidi jednako dobro, a baza raste
dvadesetak puta sporije.

## ⚠ Šta još nije riješeno

**Podaci se brišu pri svakom deployu — OSIM ako je postavljen Supabase.**
Server podržava Supabase (PostgreSQL): postavi `SUPABASE_URL` i `SUPABASE_KEY`
i podaci preživljavaju sve deploye i gašenja. Korak-po-korak uputstvo je u
**SUPABASE.md**, traje petnaestak minuta i besplatno je.

Bez tih varijabli sve i dalje radi, ali preko `data.json` na disku instance —
a Render free plan taj disk ne čuva. Provjeri log pri pokretanju: mora pisati
`Podaci: Supabase (...)`. Ako piše `data.json (lokalni fajl)`, podaci nisu
sigurni.

**Fotografije su i dalje u bazi.** Trebaju ići na zaseban prostor za fajlove
(Cloudflare R2 je besplatan do 10 GB), a u bazi ostaje samo link.



Aplikacija za radnika traži prijavu. Nema više biranja imena iz liste — svako
ima svoj nalog, kod i PIN.

### Kako radnik dobije pristup
1. Dispečer u Platformi → ekran s kartom → "Dodaj radnika" (ime, uloga, služba, telefon)
2. Server napravi nalog i **jednom** prikaže **kod** (npr. `PUT-4821`) i **PIN** (6 cifara).
   Prepiši ih ili klikni "Kopiraj kod i PIN" — PIN se poslije ne može pročitati.
3. Radnik na telefonu otvori `.../radnik`, upiše kod i PIN i vidi svoje zadatke.
4. Neka PIN promijeni u svom profilu čim se prvi put prijavi.

Zaboravljen PIN → Platforma → "Nalozi radnika" → "Novi PIN". Stari PIN i sesija
tada prestaju važiti.

Radnici koji su bili u sistemu prije ove verzije dobiju kod i PIN automatski pri
prvom pokretanju servera — ispisuju se u konzoli servera.

### Šta radnik radi u aplikaciji
- **Zadaci** — samo prijave koje je dispečer dodijelio baš njemu, sortirane po
  hitnosti i udaljenosti. Tok: Prihvati → Stigao sam → Počni rad → Završi.
- **Karta** — njegova lokacija uživo i pinovi zadataka. Ista lokacija ide dispečeru
  (šalje se svakih 15 s dok je prijavljen; prestaje odjavom).
- **Prijavi** — sam prijavi problem koji zatekne na terenu, s GPS-om i fotografijom.
- **Historija** — svi njegovi riješeni zadaci s izvještajima.
- **Profil** — sam uređuje ime, ulogu, telefon, vozilo, smjenu i sliku; mijenja PIN;
  odjavljuje se. Službu i grad postavlja dispečer.

### Izvještaj s terena
Kad završi, radnik obavezno unosi: **foto prije**, **foto poslije** i **opis šta je
uradio**. Opciono materijal, trajanje (mjeri se samo od "Počni rad") i trošak.
Sve to odlazi na server i pojavljuje se dispečeru u Platformi pod
"Detalji" prijave, a građanin vidi da je riješeno.

Izvještaj se potpisuje imenom radnika **sa servera**, ne onim što pošalje telefon —
tuđim imenom se ne može potpisati.

### Bez signala
Ako nema mreže, aplikacija sve (prihvatanje, izvještaj, fotografije, nove prijave)
sprema na telefon i šalje sama čim se signal vrati. Radnik vidi žutu traku
"nema mreže" i oznaku "čeka slanje" na zadatku.

## Radnici (Platforma)
- Dodaješ ih na ekranu s kartom: "Dodaj radnika" (ime, uloga, služba, telefon)
- "Nalozi radnika" pokazuje ko ima pristup, ko je trenutno na terenu i resetuje PIN
- Odjeli: JKP Putevi, Vodovod, Elektroprivreda, Čistoća
- Prijave se same razvrstavaju u odjel po kategoriji (rupa→Putevi, curenje/poplava→Vodovod,
  rasvjeta→Elektroprivreda, otpad→Čistoća, ostalo→Putevi)
- Prioritet se računa iz glasova građana (25+ = hitno, 10+ = srednje, inače nisko)

## Napomena o analitici Platforme
Ekrani Učinak / Smjene / Pravednost / Prognoze / Zadovoljstvo traže sedmice podataka i
ocjene građana. Dok nema dovoljno stvarnih prijava, na njima stoji žuto upozorenje da su
prikazane vrijednosti ilustrativne, ne stvarni pokazatelji. Zadaci, Radnici i osnovni
brojevi su stvarni od prve prijave.


## Provjera koja je verzija objavljena (v38)

Nakon slanja na GitHub i deploya na Render otvori:

    https://TVOJA-ADRESA.onrender.com/api/verzija

Ako tamo ne piše najnovija verzija (v38), Render još vrti stari kod — fajlovi
nisu stigli u korijen repozitorija ili deploy nije prošao. Isti broj ispiše se
i u Render logu pri pokretanju ("PINIT verzija v38").

Na telefonu: stranice se više ne keširaju, pa je dovoljno osvježiti. Ako je
aplikacija dodana na početni ekran, prvo otvaranje nakon objave povuče novu
verziju samo.

## Jezik

Dugme BS/EN stoji gore desno na platformi, u komandnom centru, u aplikaciji za
radnike i na stranici za prijavu; građanska aplikacija ima prekidač u profilu.
Izbor se pamti. Svi natpisi se prevode preko zajedničkog rječnika u
`public/jezik.js` — novi prijevod se dodaje kao jedan red u tom fajlu.

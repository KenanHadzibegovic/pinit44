/* ═══════════════════════════════════════════════════════════════════════
   PINIT Platforma — dodatak: NALOZI RADNIKA i IZVJEŠTAJI S TERENA

   Dvije stvari koje ovaj fajl dodaje dispečerskoj platformi:

   1. Dodavanje radnika sada pravi pravi NALOG. Server vrati kod i PIN,
      a dispečer ih ovdje vidi — jednom — da ih preda radniku. Postoji i
      reset PIN-a, jer će neko zaboraviti PIN već prve sedmice.

   2. Kad radnik završi posao, u aplikaciji napiše šta je uradio.
      Taj izvještaj (opis, materijal, trajanje, foto prije/poslije)
      ovdje se pojavljuje u "Detalji" prijave.

   Fajl je namjerno odvojen od platforma.html: ne dira postojeći kod,
   samo ga nadograđuje. Ako zatreba, dovoljno ga je ne učitati.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (!(location.protocol === 'http:' || location.protocol === 'https:')) return;
  var SRV = location.origin;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function el(id) { return document.getElementById(id); }
  function say(m) { if (typeof toast === 'function') toast(m); }

  /* ── 1. DODAVANJE RADNIKA S NALOGOM ───────────────────────────────── */
  var DEPTS = [
    ['putevi', 'Putevi'], ['voda', 'Voda i kanalizacija'],
    ['elektro', 'Elektro i rasvjeta'], ['cistoca', 'Čistoća']
  ];
  window.pinitAddWorker = function () {
    var cur = (typeof activeSvc === 'string') ? activeSvc : 'putevi';
    el('modal').innerHTML =
      '<div class="modal-h">Novi radnik</div>' +
      '<div class="modal-s">Kad ga sačuvaš, dobit ćeš kod i PIN za njegovu aplikaciju.</div>' +
      fld('Ime i prezime', '<input id="wkName" class="pin-in" placeholder="npr. Edin Begić">') +
      fld('Uloga', '<input id="wkRole" class="pin-in" placeholder="npr. Asfalter" value="Terenac">') +
      fld('Služba', '<select id="wkDept" class="pin-in">' + DEPTS.map(function (d) {
        return '<option value="' + d[0] + '"' + (d[0] === cur ? ' selected' : '') + '>' + d[1] + '</option>';
      }).join('') + '</select>') +
      fld('Telefon (opciono)', '<input id="wkPhone" class="pin-in" placeholder="npr. 061 000 000">') +
      '<button class="btn primary" style="width:100%;justify-content:center" onclick="pinitSaveWorker()">Napravi nalog</button>' +
      '<button class="btn ghost" style="width:100%;justify-content:center;margin-top:8px" onclick="closeModal()">Odustani</button>';
    openModal();
    setTimeout(function () { var n = el('wkName'); if (n) n.focus(); }, 80);
  };
  function fld(label, inner) {
    return '<div style="margin-bottom:11px">' +
      '<label style="font-size:11px;font-weight:700;color:var(--ink3);letter-spacing:.05em;text-transform:uppercase">' +
      esc(label) + '</label><div style="margin-top:6px">' + inner + '</div></div>';
  }
  window.pinitSaveWorker = function () {
    var name = (el('wkName').value || '').trim();
    if (name.length < 3) { say('Upiši ime i prezime radnika'); return; }
    fetch(SRV + '/api/workers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        role: (el('wkRole').value || 'Terenac').trim(),
        dept: el('wkDept').value,
        phone: (el('wkPhone').value || '').trim()
      })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok) throw 0;
      showCreds(j.worker.name, j.code, j.pin, 'Nalog je napravljen');
    }).catch(function () { say('Radnik nije dodan — provjeri server'); });
  };

  /* Kod i PIN se serveru više ne mogu izvući, pa ih treba prepisati SADA. */
  function showCreds(name, code, pin, title) {
    el('modal').innerHTML =
      '<div class="modal-h">' + esc(title) + '</div>' +
      '<div class="modal-s">' + esc(name) + ' — predaj mu ove podatke. PIN se poslije ne može pročitati, ' +
      'samo resetovati.</div>' +
      '<div style="background:var(--pinit-soft,#e8f5ec);border-radius:14px;padding:18px;text-align:center;margin-bottom:12px">' +
        '<div style="font-size:11px;font-weight:700;color:var(--pinit-d,#0f4f21);letter-spacing:.08em">KOD ZA PRIJAVU</div>' +
        '<div style="font-size:28px;font-weight:800;letter-spacing:2px;margin:6px 0 16px">' + esc(code) + '</div>' +
        '<div style="font-size:11px;font-weight:700;color:var(--pinit-d,#0f4f21);letter-spacing:.08em">PIN</div>' +
        '<div style="font-size:28px;font-weight:800;letter-spacing:6px;margin-top:6px">' + esc(pin) + '</div>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--ink3);line-height:1.55;margin-bottom:14px">' +
        'Radnik otvara <b>' + esc(location.origin) + '/radnik</b> na telefonu, upiše kod i PIN i vidi svoje zadatke. ' +
        'Neka PIN promijeni u svom profilu čim se prvi put prijavi.</div>' +
      '<button class="btn primary" style="width:100%;justify-content:center" ' +
        'onclick="pinitCopyCreds(\'' + esc(code) + '\',\'' + esc(pin) + '\')">Kopiraj kod i PIN</button>' +
      '<button class="btn ghost" style="width:100%;justify-content:center;margin-top:8px" onclick="closeModal()">Gotovo</button>';
    openModal();
  }
  window.pinitCopyCreds = function (code, pin) {
    var tr = window.pinitPrevedi || function (x) { return x; };
    var txt = tr('PINIT Radnik') + '\n' + tr('Adresa') + ': ' + location.origin + '/radnik\n' +
              tr('Kod') + ': ' + code + '\nPIN: ' + pin;
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { say('Kopirano'); },
      function () { say('Kopiranje nije uspjelo'); });
    else say('Prepiši ručno — pregledač ne dozvoljava kopiranje');
  };

  /* ── 2. RESET PIN-a ───────────────────────────────────────────────── */
  window.pinitResetPin = function (wid, wname) {
    if (!confirm('Napraviti novi PIN za ' + wname + '?\n\nStari PIN prestaje važiti i radnik će biti odjavljen.')) return;
    fetch(SRV + '/api/workers/' + wid + '/pin', { method: 'POST' })
      .then(function (r) { return r.json(); }).then(function (j) {
        if (!j || !j.ok) throw 0;
        showCreds(wname, j.code, j.pin, 'Novi PIN');
      }).catch(function () { say('Reset nije uspio'); });
  };

  /* Lista radnika s kodom, statusom i dugmetom za reset PIN-a. */
  window.pinitWorkerAccounts = function () {
    fetch(SRV + '/api/workers').then(function (r) { return r.json(); }).then(function (ws) {
      ws = Array.isArray(ws) ? ws : [];
      el('modal').innerHTML =
        '<div class="modal-h">Nalozi radnika</div>' +
        '<div class="modal-s">Ko ima pristup aplikaciji za radnike i kada je zadnji put bio aktivan.</div>' +
        (ws.length ? ws.map(function (w) {
          var live = w.locTs && (Date.now() - w.locTs < 120000);
          return '<div class="wk" style="display:flex;align-items:center;gap:11px;margin-bottom:8px">' +
            '<div style="flex:1;min-width:0">' +
              '<div style="font-weight:700;font-size:13.5px">' + esc(w.name) + '</div>' +
              '<div style="font-size:11.5px;color:var(--ink3)">' + esc(w.code || '—') + ' · ' +
                esc(w.role || '') + ' · ' + esc(w.dept || '') +
                (live ? ' · <b style="color:#1a7a34">na terenu</b>'
                      : w.lastSeen ? ' · zadnji put ' + fmtAgo(w.lastSeen) : ' · nije se još prijavio') +
              '</div></div>' +
            '<button class="btn ghost" style="padding:7px 11px;font-size:12px" ' +
              'onclick="pinitResetPin(\'' + w.id + '\',\'' + esc(w.name).replace(/'/g, '') + '\')">Novi PIN</button></div>';
        }).join('')
          : '<div style="padding:18px 4px;color:var(--ink3);font-size:13px;text-align:center">Još nema nijednog radnika.</div>') +
        '<button class="btn primary" style="width:100%;justify-content:center;margin-top:6px" ' +
          'onclick="closeModal();pinitAddWorker()">Dodaj radnika</button>' +
        '<button class="btn ghost" style="width:100%;justify-content:center;margin-top:8px" onclick="closeModal()">Zatvori</button>';
      openModal();
    }).catch(function () { say('Ne mogu učitati radnike'); });
  };
  function fmtAgo(ms) {
    var m = Math.floor((Date.now() - ms) / 60000);
    if (m < 1) return 'upravo';
    if (m < 60) return 'prije ' + m + ' min';
    if (m < 1440) return 'prije ' + Math.floor(m / 60) + ' h';
    return 'prije ' + Math.floor(m / 1440) + ' d';
  }

  /* ── 3. IZVJEŠTAJ S TERENA U "DETALJI" ───────────────────────────── */
  var RAW = {};                       // id prijave → sirova prijava sa servera
  function pullRaw() {
    fetch(SRV + '/api/reports').then(function (r) { return r.json(); }).then(function (list) {
      if (!Array.isArray(list)) return;
      var m = {};
      list.forEach(function (r) { m[r.id] = r; });
      RAW = m;
    }).catch(function () {});
  }
  pullRaw();
  setInterval(pullRaw, 12000);

  function reportBlock(r) {
    if (!r) return '';
    var w = r.work, before = r.photoBefore, after = r.photoAfter;
    if (!w && !before && !after) {
      return r.status === 3
        ? '<div class="wk" style="margin:12px 0"><div style="font-size:12.5px;color:var(--ink3);line-height:1.55">' +
          'Nema izvještaja s terena. Prijava je zatvorena iz platforme, a ne iz radničke aplikacije.</div></div>'
        : '';
    }
    var h = '<div style="margin:16px 0 8px;font-size:13px;font-weight:700">Izvještaj s terena</div>';
    if (w) {
      h += '<div class="wk" style="margin-bottom:8px">' +
        (w.note ? '<div style="font-size:13.5px;line-height:1.6">' + esc(w.note) + '</div>' : '') +
        '<div style="font-size:11.5px;color:var(--ink3);margin-top:8px;line-height:1.6">' +
          (w.byName ? '<b>' + esc(w.byName) + '</b> · ' : '') +
          (w.minutes != null ? 'trajanje ' + fmtMin(w.minutes) + ' · ' : '') +
          'poslano ' + fmtAgo(w.at) +
        '</div>' +
        (w.materials ? '<div style="font-size:12.5px;color:var(--ink2);margin-top:8px">' +
          '<b>Materijal:</b> ' + esc(w.materials) + '</div>' : '') +
        '</div>';
    }
    if (before || after) {
      h += '<div style="display:flex;gap:8px;margin-bottom:8px">' +
        photo(before, 'PRIJE') + photo(after, 'POSLIJE') + '</div>';
    }
    return h;
  }
  function photo(src, label) {
    if (!src) return '<div style="flex:1"></div>';
    return '<div style="flex:1;position:relative;border-radius:12px;overflow:hidden;cursor:pointer" ' +
      'onclick="pinitZoom(this.querySelector(\'img\').src)">' +
      '<img src="' + src + '" style="width:100%;display:block;aspect-ratio:1;object-fit:cover">' +
      '<div style="position:absolute;left:0;right:0;bottom:0;background:rgba(15,79,33,.9);color:#fff;' +
      'font-size:10px;font-weight:800;padding:4px;text-align:center;letter-spacing:.6px">' + label + '</div></div>';
  }
  function fmtMin(m) {
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60), r = m % 60;
    return h + ' h' + (r ? ' ' + r + ' min' : '');
  }
  window.pinitZoom = function (src) {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:9999;display:flex;' +
      'align-items:center;justify-content:center;padding:20px;cursor:zoom-out';
    d.innerHTML = '<img src="' + src + '" style="max-width:100%;max-height:100%;border-radius:10px">';
    d.onclick = function () { d.remove(); };
    document.body.appendChild(d);
  };

  /* Ne diramo originalni openDetail — pustimo ga da nacrta svoje,
     pa mu na kraj dopišemo izvještaj radnika. */
  var origDetail = window.openDetail;
  if (typeof origDetail === 'function') {
    window.openDetail = function (oid) {
      origDetail(oid);
      try {
        var o = getO(oid);
        var raw = o && RAW[o._srvId];
        var html = reportBlock(raw);
        if (html) {
          var m = el('modal');
          var box = document.createElement('div');
          box.innerHTML = html;
          m.appendChild(box);
        }
      } catch (e) {}
    };
  }

  /* ── 4. PRAVA KARTA RADNIKA UŽIVO ───────────────────────────────────
     Ekran "Radnici uživo" je dosad crtao shematsku sliku grada s pinovima
     raspoređenim po hash-u imena — dakle izmišljene pozicije. Sada crtamo
     pravu kartu (MapLibre, isti modul kao ostatak sistema) sa stvarnim GPS
     koordinatama koje radnička aplikacija šalje svakih 15 sekundi, i uz njih
     otvorene zadatke, da dispečer vidi ko je kome najbliži. */
  var wmap = null, wmapReady = false, wmarks = [], firstFit = true;

  function fmtWhen(ts) {
    if (!ts) return 'nikad';
    var m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return 'upravo sada';
    if (m < 60) return 'prije ' + m + ' min';
    if (m < 1440) return 'prije ' + Math.floor(m / 60) + ' h';
    return 'prije ' + Math.floor(m / 1440) + ' d';
  }
  function statCol(w) {
    if (!w._fresh) return '#8e8e93';               // siva: nema svježeg GPS-a
    return w.status === 'busy' ? '#e8850c' : '#1a7a34';
  }

  function killMap() {
    wmarks.forEach(function (m) { try { m.remove(); } catch (e) {} });
    wmarks = [];
    if (wmap) { try { wmap.remove(); } catch (e) {} }
    wmap = null; wmapReady = false; firstFit = true;
  }

  window.renderMap = function () {
    var ws = (typeof workers === 'function') ? workers() : [];
    var withGps = ws.filter(function (w) { return typeof w._lat === 'number'; });
    var live = withGps.filter(function (w) { return w._fresh; }).length;

    var host = el('sc-map');
    /* Karta se ne smije rušiti i graditi na svakom osvježenju (svakih 12 s),
       jer bi se resetovao zum i pomak koji je dispečer namjestio. Zato HTML
       crtamo samo kad ga još nema, a poslije mijenjamo samo markere. */
    if (!host.querySelector('#wLiveMap')) {
      killMap();
      host.innerHTML =
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">' +
          '<button class="btn" id="addWk" onclick="pinitAddWorker()">Dodaj radnika</button>' +
          '<button class="btn ghost" id="wkAcc" onclick="pinitWorkerAccounts()">Nalozi radnika</button>' +
          '<button class="btn ghost" onclick="pinitFitMap()">Prikaži sve</button>' +
        '</div>' +
        '<div class="card" style="padding:0;overflow:hidden;position:relative">' +
          '<div id="wLiveMap" style="height:460px;width:100%;background:var(--surface-2,#eef2f7)"></div>' +
          '<div id="wMapEmpty" style="position:absolute;inset:0;display:none;align-items:center;' +
            'justify-content:center;text-align:center;padding:0 30px;background:var(--surface,#fff);' +
            'color:var(--ink3);font-size:14px;line-height:1.6"></div>' +
          '<div class="map-legend" style="position:absolute;left:12px;bottom:12px;z-index:5;' +
            'background:rgba(255,255,255,.95);border-radius:12px;padding:8px 12px;display:flex;gap:14px;' +
            'box-shadow:0 2px 10px rgba(0,0,0,.12);font-size:11.5px;font-weight:600">' +
            lg('#e8850c', 'Na zadatku') + lg('#1a7a34', 'Slobodan') +
            lg('#8e8e93', 'Bez signala') + lg('#0a66d0', 'Otvoren zadatak') +
          '</div>' +
        '</div>' +
        '<div class="note" style="margin-top:14px">' +
          '<svg viewBox="0 0 24 24"><path d="M12 2C8.1 2 5 5.1 5 9c0 5 7 13 7 13s7-8 7-13c0-3.9-3.1-7-7-7Z"/></svg>' +
          '<div><div class="note-t">Lokacije uživo</div><div class="note-b" id="wMapNote">—</div></div></div>';
      initWMap();
    }

    var note = el('wMapNote');
    if (note) {
      note.innerHTML = withGps.length
        ? '<b>' + live + '</b> od ' + ws.length + ' radnika trenutno šalje lokaciju. ' +
          'Pozicija stiže iz radničke aplikacije svakih 15 sekundi dok je radnik prijavljen. ' +
          'Sivi pin znači da signal nije stigao zadnje 2 minute — radnik je možda u tunelu, podrumu ili se odjavio. ' +
          'Klikni na radnika za detalje i dodjelu najbližeg zadatka.'
        : 'Nijedan radnik trenutno ne šalje lokaciju. Pozicija se pojavi čim se radnik prijavi u svojoj ' +
          'aplikaciji i dozvoli pristup lokaciji.';
    }
    drawWMarks();
  };
  function lg(c, t) {
    return '<span style="display:flex;align-items:center;gap:6px"><span style="width:9px;height:9px;' +
      'border-radius:50%;background:' + c + '"></span>' + t + '</span>';
  }

  function initWMap() {
    if (wmap || typeof PINIT_MAPS === 'undefined' || typeof maplibregl === 'undefined') return;
    try {
      wmap = PINIT_MAPS.init('wLiveMap', { freeRoam: true });
      if (!wmap) return;
      wmap.on('load', function () {
        wmapReady = true;
        try { wmap.resize(); } catch (e) {}
        drawWMarks();
      });
    } catch (e) {}
  }

  function drawWMarks() {
    if (!wmap || !wmapReady) return;
    wmarks.forEach(function (m) { try { m.remove(); } catch (e) {} });
    wmarks = [];

    var ws = (typeof workers === 'function') ? workers() : [];
    var os = (typeof orders === 'function') ? orders() : [];
    var pts = [];

    /* Otvoreni zadaci — plave tačke, da se vidi ko je čemu blizu. */
    os.filter(function (o) {
      return o.status !== 'done' && typeof o.lat === 'number' && typeof o.lng === 'number';
    }).forEach(function (o) {
      var d = document.createElement('div');
      d.style.cssText = 'width:13px;height:13px;border-radius:50%;background:#0a66d0;' +
        'border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.35);cursor:pointer';
      var m = new maplibregl.Marker({ element: d }).setLngLat([o.lng, o.lat])
        .setPopup(new maplibregl.Popup({ offset: 14, closeButton: false })
          .setHTML('<div style="font:600 12.5px system-ui;padding:2px 0">' + esc(o.id) +
            '<br><span style="color:#777;font-weight:500">' + esc(ST[o.status] ? ST[o.status].l : '') +
            '</span></div>')).addTo(wmap);
      wmarks.push(m); pts.push([o.lng, o.lat]);
    });

    /* Radnici — krug s inicijalima, boja po statusu, blijedo ako nema signala. */
    ws.filter(function (w) { return typeof w._lat === 'number'; }).forEach(function (w) {
      var col = statCol(w);
      var d = document.createElement('div');
      d.style.cssText = 'width:34px;height:34px;border-radius:50%;background:' + col + ';color:#fff;' +
        'font:800 12px system-ui;display:flex;align-items:center;justify-content:center;' +
        'border:3px solid #fff;box-shadow:0 2px 9px rgba(0,0,0,.35);cursor:pointer;' +
        (w._fresh ? '' : 'opacity:.55;');
      d.textContent = w.av;
      var m = new maplibregl.Marker({ element: d }).setLngLat([w._lng, w._lat])
        .setPopup(new maplibregl.Popup({ offset: 20, closeButton: false })
          .setHTML(
            '<div style="font:600 13px system-ui;padding:3px 1px;min-width:150px">' +
              '<b>' + esc(w.name) + '</b><br>' +
              '<span style="color:#666;font-weight:500">' + esc(w.role || '') + '</span><br>' +
              '<span style="color:' + col + ';font-weight:700">' +
                (w._fresh ? (w.status === 'busy' ? w.tasks + ' aktivnih zadataka' : 'slobodan')
                          : 'bez signala · ' + fmtWhen(w._locTs)) + '</span>' +
              (w._phone ? '<br><a href="tel:' + esc(w._phone) + '" style="color:#0a66d0">' + esc(w._phone) + '</a>' : '') +
            '</div>')).addTo(wmap);
      d.addEventListener('click', function () {
        if (typeof openWorker === 'function') setTimeout(function () { openWorker(w.id); }, 240);
      });
      wmarks.push(m); pts.push([w._lng, w._lat]);
    });

    var empty = el('wMapEmpty');
    if (empty) {
      var none = !ws.some(function (w) { return typeof w._lat === 'number'; });
      empty.style.display = none ? 'flex' : 'none';
      if (none) {
        empty.innerHTML = '<div><b style="color:var(--ink)">Nijedan radnik još ne šalje lokaciju</b><br>' +
          'Pozicije se pojave čim se radnik prijavi u aplikaciji <b>' + esc(location.origin) + '/radnik</b> ' +
          'i dozvoli pristup lokaciji.</div>';
      }
    }

    /* Kadar namještamo samo prvi put — poslije toga dispečer sam bira pogled. */
    if (firstFit && pts.length) {
      firstFit = false;
      try {
        if (pts.length === 1) wmap.easeTo({ center: pts[0], zoom: 15 });
        else {
          var b = new maplibregl.LngLatBounds(pts[0], pts[0]);
          pts.forEach(function (p) { b.extend(p); });
          wmap.fitBounds(b, { padding: 70, maxZoom: 16, duration: 500 });
        }
      } catch (e) {}
    }
  }
  window.pinitFitMap = function () { firstFit = true; drawWMarks(); };

  /* Kad se promijeni služba (Putevi/Voda/…), markeri se moraju prekrojiti. */
  var origSvc = window.setSvc;
  if (typeof origSvc === 'function') {
    window.setSvc = function () {
      origSvc.apply(null, arguments);
      setTimeout(function () { if (typeof renderMap === 'function') renderMap(); }, 40);
    };
  }

  /* Ako sesija istekne (12 h), server na svaki poziv vraća 401. Bez ovoga bi
     platforma tiho prestala raditi — dugmad bi klikala, a ništa se ne bi
     mijenjalo. Ovako korisnik odmah dobije jasnu poruku i vrati se na prijavu. */
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    return origFetch.apply(this, arguments).then(function (r) {
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      if (r.status === 401 && url.indexOf('/api/') >= 0 && url.indexOf('/api/admin/login') < 0) {
        if (!window.__pinitExpired) {
          window.__pinitExpired = true;
          alert('Sesija je istekla. Prijavi se ponovo.');
          location.href = '/platforma';
        }
      }
      return r;
    });
  };

  window.pinitLogout = function () {
    if (!confirm('Odjaviti se s platforme?')) return;
    fetch('/api/admin/logout', { method: 'POST' })
      .then(function () { location.href = '/platforma'; })
      .catch(function () { location.href = '/platforma'; });
  };

  /* Dugme za odjavu u bočnoj traci, ispod menija. */
  setTimeout(function () {
    var side = document.querySelector('.side, .sidebar, nav.side');
    if (!side || side.querySelector('#pinitOut')) return;
    var b = document.createElement('button');
    b.id = 'pinitOut';
    b.className = 'btn ghost';
    b.textContent = 'Odjavi se';
    b.style.cssText = 'margin:14px 12px 22px;width:calc(100% - 24px);justify-content:center';
    b.onclick = window.pinitLogout;
    side.appendChild(b);
  }, 400);

  /* ── 5. PREGLED FOTOGRAFIJA ────────────────────────────────────────
     Fotografije koje pošalju građani ne vide se u javnosti dok ih dispečer
     ne pogleda. Ovdje ih pregleda i jednim klikom odobri ili odbije.
     Odbijena slika se briše sa servera. */
  var pendCount = 0;

  window.pinitPhotoReview = function () {
    fetch(SRV + '/api/photos/pending').then(function (r) { return r.json(); }).then(function (list) {
      list = Array.isArray(list) ? list : [];
      el('modal').innerHTML =
        '<div class="modal-h">Pregled fotografija</div>' +
        '<div class="modal-s">Slike građana se ne prikazuju javno dok ih ne pogledaš. ' +
          'Odbijena slika se odmah briše sa servera, prijava ostaje.</div>' +
        (list.length
          ? '<div style="max-height:58vh;overflow:auto;margin:0 -4px;padding:0 4px">' +
            list.map(function (r) {
              return '<div id="pv-' + r.id + '" style="border:1px solid var(--line);border-radius:14px;' +
                'padding:11px;margin-bottom:10px">' +
                '<div style="display:flex;gap:11px">' +
                  '<img src="' + esc(r.photo) + '" style="width:96px;height:96px;object-fit:cover;' +
                    'border-radius:10px;flex-shrink:0;cursor:zoom-in" ' +
                    'onclick="pinitBigPhoto(this.src)">' +
                  '<div style="flex:1;min-width:0">' +
                    '<div style="font-weight:700;font-size:13px">' + esc(r.cat || '—') + '</div>' +
                    '<div style="font-size:11.5px;color:var(--ink3);margin:2px 0 6px">' +
                      esc(r.name || 'nepoznat') + ' · ' + esc(r.city || '') + ' · ' + fmtAgo(r.ts) +
                      (r.flags ? ' · <b style="color:#b35a00">' + r.flags + ' prijava korisnika</b>' : '') +
                    '</div>' +
                    (r.note ? '<div style="font-size:12px;color:var(--ink2);line-height:1.4;' +
                      'max-height:38px;overflow:hidden">' + esc(r.note) + '</div>' : '') +
                  '</div>' +
                '</div>' +
                '<div style="display:flex;gap:8px;margin-top:10px">' +
                  '<button class="btn primary" style="flex:1;justify-content:center;padding:9px;font-size:12.5px" ' +
                    'onclick="pinitPhotoDecide(' + r.id + ',true)">Odobri</button>' +
                  '<button class="btn ghost" style="flex:1;justify-content:center;padding:9px;font-size:12.5px;' +
                    'color:#a8261d;border-color:#f0c9c5" ' +
                    'onclick="pinitPhotoDecide(' + r.id + ',false)">Odbij i briši</button>' +
                '</div></div>';
            }).join('') + '</div>'
          : '<div style="padding:22px 4px;color:var(--ink3);font-size:13px;text-align:center">' +
            'Nema slika koje čekaju pregled.</div>') +
        '<button class="btn ghost" style="width:100%;justify-content:center;margin-top:8px" ' +
          'onclick="closeModal()">Zatvori</button>';
      openModal();
    }).catch(function () { say('Ne mogu učitati slike'); });
  };

  window.pinitPhotoDecide = function (id, ok) {
    if (!ok && !confirm('Odbiti i trajno obrisati ovu sliku?\n\nPrijava ostaje, samo slika se briše.')) return;
    fetch(SRV + '/api/reports/' + id + '/photo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: !!ok })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok) throw 0;
      var box = el('pv-' + id);
      if (box) {
        box.style.transition = 'opacity .2s';
        box.style.opacity = '0';
        setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 210);
      }
      say(ok ? 'Slika odobrena — sada je javno vidljiva' : 'Slika odbijena i obrisana');
      refreshPendingBadge();
    }).catch(function () { say('Nije uspjelo'); });
  };

  window.pinitBigPhoto = function (src) {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.9);' +
      'display:flex;align-items:center;justify-content:center;padding:20px;cursor:zoom-out';
    var i = document.createElement('img');
    i.src = src;
    i.style.cssText = 'max-width:100%;max-height:100%;border-radius:10px';
    d.appendChild(i);
    d.onclick = function () { document.body.removeChild(d); };
    document.body.appendChild(d);
  };

  /* Dugme s brojem slika koje čekaju — da dispečer ne mora provjeravati sam. */
  function refreshPendingBadge() {
    fetch(SRV + '/api/photos/pending').then(function (r) { return r.json(); }).then(function (l) {
      pendCount = Array.isArray(l) ? l.length : 0;
      var b = el('pinitPhotoBtn');
      if (b) {
        b.textContent = pendCount ? 'Slike za pregled (' + pendCount + ')' : 'Pregled fotografija';
        b.style.borderColor = pendCount ? '#e8920c' : '';
        b.style.color = pendCount ? '#b35a00' : '';
      }
    }).catch(function () {});
  }

  setTimeout(function () {
    var side = document.querySelector('.side, .sidebar, nav.side');
    if (side && !el('pinitPhotoBtn')) {
      var b = document.createElement('button');
      b.id = 'pinitPhotoBtn';
      b.className = 'btn ghost';
      b.textContent = 'Pregled fotografija';
      b.style.cssText = 'margin:4px 12px 0;width:calc(100% - 24px);justify-content:center';
      b.onclick = window.pinitPhotoReview;
      var out = el('pinitOut');
      if (out) side.insertBefore(b, out); else side.appendChild(b);
    }
    refreshPendingBadge();
    setInterval(refreshPendingBadge, 30000);
  }, 500);

  /* Platforma jednom iscrta ekrane prije nego se ovaj dodatak učita, pa bi
     do prvog osvježenja (12 s) stajala stara shema. Zato odmah precrtamo. */
  setTimeout(function () { try { window.renderMap(); } catch (e) {} }, 60);
})();

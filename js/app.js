/* App shell: Explore (rotary wheel), Now Playing (turntable, waveform, arc
   progress, knob + skip controls), routing between them and the Home /
   Saved / Search pages (js/pages.js). */
(function () {
  'use strict';

  var DEMO = window.TRACKS;            // offline demo collection (tracks.js)
  var cfg = window.VINYL_CONFIG || {};
  var list = [];                       // tracks on the Explore wheel
  var N = 0;
  var queue = [];                      // what next / previous step through
  var queueSource = 'list';            // where the queue came from (search, home0, saved, playlist, explore, encore)
  var userPlayed = false;
  var engine = new window.VinylPlayer();
  var saved = new window.SavedStore();
  var encore = null;                   // next-song recommender (js/encore), created at boot

  var $ = function (id) { return document.getElementById(id); };
  var device = $('app');
  var explorePage = $('explore');
  var playingPage = $('playing');

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function mod(a, n) { return ((a % n) + n) % n; }
  function wrapDiff(d) { return mod(d + N / 2, N) - N / 2; }
  function fmt(t) {
    t = Math.max(0, Math.floor(t + 1e-6));
    var m = Math.floor(t / 60), s = t % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function sameTrack(a, b) { return !!(a && b && a.id === b.id); }
  function indexIn(arr, t) {
    if (!t) return -1;
    for (var i = 0; i < arr.length; i++) if (arr[i].id === t.id) return i;
    return -1;
  }
  function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
  function ramp(stops, x) {
    // stops: array of hex colours at x = 0, 1, 2, …
    var i = clamp(Math.floor(x), 0, stops.length - 2), f = clamp(x - i, 0, 1);
    var a = stops[i], b = stops[i + 1];
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * f) + ',' + Math.round(a[1] + (b[1] - a[1]) * f) + ',' + Math.round(a[2] + (b[2] - a[2]) * f) + ')';
  }

  /* ───────────────────────── Layout scale ───────────────────────── */

  var W = 375, H = 815, S = 1;

  function layout() {
    var r = device.getBoundingClientRect();
    W = r.width;
    H = r.height;
    S = clamp(Math.min(W / 375, H / 815), 0.5, 1.4);
    device.style.setProperty('--s', S.toFixed(4));
    wheel.layout();
    arc.layout();
  }

  /* ───────────────────────── Explore wheel ───────────────────────── */

  var STEP = 16.6;                       // degrees between items on the wheel
  var TITLE_RAMP = ['#121316', '#45474d', '#74777e', '#aaadb4', '#c9cbd0'].map(hex);
  var ARTIST_RAMP = ['#46484e', '#a3a6ad', '#b4b7bd', '#c8cad0', '#d6d8dc'].map(hex);

  var wheelEl = $('wheel');
  var listEl = $('wheel-list');

  var wheel = {
    pos: 0,
    vel: 0,
    target: 0,
    drag: null,
    suppressClick: false,
    items: [],
    g: {},
    sel: -1,
    dirty: true,

    build: function (tracks, start) {
      listEl.textContent = '';
      this.items = [];
      list = tracks;
      N = tracks.length;
      this.pos = this.target = start || 0;
      this.vel = 0;
      this.sel = -1;
      this.dirty = true;
      tracks.forEach(function (t, i) {
        var li = document.createElement('li');
        li.className = 'track';
        li.id = 'track-' + i;
        li.dataset.i = i;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-label', t.title + ' by ' + t.artist);
        li.innerHTML =
          '<div class="pill"><button class="play" type="button" tabindex="-1">Play</button></div>' +
          '<div class="art"><img alt="" draggable="false"></div>' +
          '<div class="meta"><span class="title"></span><span class="artist"></span></div>';
        li.querySelector('img').src = t.art;
        li.querySelector('.title').textContent = t.title;
        li.querySelector('.artist').textContent = t.artist;
        listEl.appendChild(li);
        wheel.items.push({
          li: li,
          pill: li.querySelector('.pill'),
          play: li.querySelector('.play'),
          img: li.querySelector('img'),
          meta: li.querySelector('.meta'),
          title: li.querySelector('.title'),
          artist: li.querySelector('.artist'),
          cache: {}
        });
      });
    },

    layout: function () {
      var g = this.g;
      g.R = 450 * S;
      g.artX = 67.5 * S;
      g.cx = g.artX + g.R;
      g.cy = 82 * S + (H - 160 * S) * 0.5235;
      g.pillLen = W - 19 * S - g.artX;
      g.itemPx = g.R * STEP * Math.PI / 180;
      this.dirty = true;
    },

    nearest: function (i) {
      // the absolute wheel position for track i closest to where the wheel is now
      return Math.round(this.pos) + Math.round(wrapDiff(i - Math.round(this.pos)));
    },

    update: function (dt) {
      if (this.drag) return;
      var d = this.target - this.pos;
      if (Math.abs(d) < 1e-4 && Math.abs(this.vel) < 1e-3) {
        if (this.pos !== this.target) { this.pos = this.target; this.dirty = true; }
        this.vel = 0;
        return;
      }
      var k = 150, c = 2 * Math.sqrt(k) * 0.92;
      var steps = Math.ceil(dt / (1 / 120));
      var h = dt / steps;
      for (var n = 0; n < steps; n++) {
        var a = k * (this.target - this.pos) - c * this.vel;
        this.vel += a * h;
        this.pos += this.vel * h;
      }
      this.dirty = true;
    },

    render: function () {
      if (!this.dirty) return;
      this.dirty = false;
      if (!N) return;
      var g = this.g, pos = this.pos;
      var sel = mod(Math.round(pos), N);
      for (var i = 0; i < N; i++) {
        var it = this.items[i], c = it.cache;
        var d = wrapDiff(i - pos), ad = Math.abs(d);
        var visible = ad < 3.9;
        if (c.visible !== visible) {
          it.li.style.visibility = visible ? '' : 'hidden';
          c.visible = visible;
        }
        if (!visible) continue;

        var tf = 'translate(' + g.cx.toFixed(2) + 'px,' + g.cy.toFixed(2) + 'px) rotate(' + (-d * STEP).toFixed(3) + 'deg) translate(' + (-g.R).toFixed(2) + 'px,0)';
        if (c.tf !== tf) { it.li.style.transform = tf; c.tf = tf; }

        var f = clamp(1 - ad, 0, 1);
        var op = ad <= 2 ? 1 : clamp(1 - (ad - 2) / 1.8, 0, 1);
        var ops = op.toFixed(3);
        if (c.op !== ops) { it.li.style.opacity = ops; c.op = ops; }
        var z = String(100 - Math.round(ad * 10));
        if (c.z !== z) { it.li.style.zIndex = z; c.z = z; }

        // the pill slides out of the artwork only as an item settles in the centre,
        // so mid-rotation two half-open pills never overlap
        var pf = clamp((f - 0.3) / 0.7, 0, 1);
        var pw = (g.pillLen * pf * pf * (3 - 2 * pf)).toFixed(1);
        if (c.pw !== pw) {
          it.pill.style.width = pw + 'px';
          it.pill.style.opacity = clamp((f - 0.3) / 0.4, 0, 1).toFixed(3);
          c.pw = pw;
        }
        var playOp = clamp((f - 0.55) / 0.45, 0, 1);
        var playOpS = playOp.toFixed(3);
        if (c.po !== playOpS) {
          it.play.style.opacity = playOpS;
          it.play.style.visibility = playOp > 0.01 ? '' : 'hidden';
          // titles only need to stop short of the Play button while it is showing
          it.meta.style.maxWidth = 'calc(' + (134 + 76 * (1 - playOp)).toFixed(1) + ' * var(--u))';
          c.po = playOpS;
        }
        var ring = (1 - (10 / 97) * (1 - f)).toFixed(4);
        if (c.ring !== ring) { it.img.style.setProperty('--ring-scale', ring); c.ring = ring; }

        var tc = ramp(TITLE_RAMP, ad), ac = ramp(ARTIST_RAMP, ad);
        if (c.tc !== tc) { it.title.style.color = tc; c.tc = tc; }
        if (c.ac !== ac) { it.artist.style.color = ac; c.ac = ac; }
      }
      if (sel !== this.sel) {
        if (this.sel >= 0) {
          this.items[this.sel].li.removeAttribute('aria-selected');
          this.items[this.sel].li.classList.remove('is-selected');
          this.items[this.sel].play.tabIndex = -1;
        }
        this.sel = sel;
        this.items[sel].li.setAttribute('aria-selected', 'true');
        this.items[sel].li.classList.add('is-selected');
        this.items[sel].play.tabIndex = 0;
        wheelEl.setAttribute('aria-activedescendant', this.items[sel].li.id);
        syncPlayLabels();
      }
    },

    go: function (i) { this.target = this.nearest(i); },

    bind: function () {
      var self = this, snapTimer = 0;

      wheelEl.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        self.drag = { id: e.pointerId, y0: e.clientY, pos0: self.pos, moved: false, samples: [[performance.now(), self.pos]] };
        self.vel = 0;
      });
      wheelEl.addEventListener('pointermove', function (e) {
        var dr = self.drag;
        if (!dr || dr.id !== e.pointerId) return;
        var dy = e.clientY - dr.y0;
        if (!dr.moved && Math.abs(dy) > 6) {
          dr.moved = true;
          dr.y0 = e.clientY;
          dy = 0;
          wheelEl.setPointerCapture(e.pointerId);
          wheelEl.classList.add('is-dragging');
        }
        if (!dr.moved) return;
        self.pos = dr.pos0 - dy / self.g.itemPx;
        self.target = self.pos;
        self.dirty = true;
        var now = performance.now();
        dr.samples.push([now, self.pos]);
        while (dr.samples.length > 2 && now - dr.samples[0][0] > 100) dr.samples.shift();
      });
      function end(e) {
        var dr = self.drag;
        if (!dr || dr.id !== e.pointerId) return;
        self.drag = null;
        wheelEl.classList.remove('is-dragging');
        if (!dr.moved) return;
        self.suppressClick = true;
        setTimeout(function () { self.suppressClick = false; }, 0);
        var a = dr.samples[0], b = dr.samples[dr.samples.length - 1];
        var v = b[0] - a[0] > 8 ? (b[1] - a[1]) / ((b[0] - a[0]) / 1000) : 0;
        v = clamp(v, -14, 14);
        self.vel = v;
        self.target = Math.round(self.pos + clamp(v * 0.2, -4, 4));
      }
      wheelEl.addEventListener('pointerup', end);
      wheelEl.addEventListener('pointercancel', end);

      wheelEl.addEventListener('wheel', function (e) {
        e.preventDefault();
        var dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
        clearTimeout(snapTimer);
        if (Math.abs(dy) >= 50) {
          self.target = Math.round(self.target) + (dy > 0 ? 1 : -1);
        } else {
          self.target += dy / self.g.itemPx;
          snapTimer = setTimeout(function () { self.target = Math.round(self.target); }, 130);
        }
      }, { passive: false });

      wheelEl.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { self.target = Math.round(self.target) + 1; e.preventDefault(); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { self.target = Math.round(self.target) - 1; e.preventDefault(); }
        else if ((e.key === 'Enter' || e.key === ' ') && e.target === wheelEl && N) { openTrack(mod(Math.round(self.target), N)); e.preventDefault(); }
      });

      listEl.addEventListener('click', function (e) {
        if (self.suppressClick) return;
        var li = e.target.closest('.track');
        if (!li) return;
        var i = +li.dataset.i;
        var d = wrapDiff(i - self.pos);
        if (Math.abs(d) < 0.5) {
          if (e.target.closest('.play')) onPlayButton(i);
          else openTrack(i);
        } else {
          self.go(i);
        }
      });
    }
  };

  function syncPlayLabels() {
    var sel = wheel.sel;
    if (sel < 0 || !wheel.items[sel]) return;
    var it = wheel.items[sel];
    var isPause = sameTrack(engine.track, list[sel]) && engine.playing;
    var label = isPause ? 'Pause' : 'Play';
    if (it.play.textContent !== label) it.play.textContent = label;
    it.play.setAttribute('aria-label', label + ' ' + list[sel].title);
  }

  // Play track i of a list (it becomes the queue) and open Now Playing.
  function playFrom(tracks, i, source) {
    var t = tracks[i];
    if (!t) return;
    queue = tracks.slice();
    queueSource = source || 'list';
    userPlayed = true;
    if (!sameTrack(engine.track, t)) {
      if (encore) encore.note('pick', queueSource);
      engine.load(t, true);
    } else if (!engine.playing) engine.play();
    openPlaying();
  }

  function openTrack(i) { playFrom(list, i, 'explore'); }

  function onPlayButton(i) {
    if (sameTrack(engine.track, list[i]) && engine.playing) { engine.pause(); return; }
    openTrack(i);
  }

  /* ───────────────────────── Turntable deck ───────────────────────── */

  var PIVOT = [308.8, 53.9];
  var STYLUS = [320, 252.5];
  var CENTER = [170, 170];

  var deck = {
    spin: 0, spinVel: 0, arm: 0, armVel: 0,
    el: $('deck'),

    build: function () {
      var grooves = '', r, k = 0;
      for (r = 49; r <= 127.5; r += 1.55, k++) {
        var o = 0.02 + 0.035 * Math.abs(Math.sin(k * 2.37) * Math.cos(k * 0.71));
        grooves += '<circle cx="170" cy="170" r="' + r.toFixed(2) + '" fill="none" stroke="#fff" stroke-opacity="' + o.toFixed(3) + '" stroke-width=".55"/>';
      }
      [67, 89, 109].forEach(function (rr) {
        grooves += '<circle cx="170" cy="170" r="' + rr + '" fill="none" stroke="#000" stroke-opacity=".55" stroke-width="1.6"/>' +
                   '<circle cx="170" cy="170" r="' + (rr + 1.1) + '" fill="none" stroke="#fff" stroke-opacity=".07" stroke-width=".5"/>';
      });
      function polar(a, rad) {
        var t = a * Math.PI / 180;
        return (170 + rad * Math.cos(t)).toFixed(2) + ' ' + (170 + rad * Math.sin(t)).toFixed(2);
      }
      function wedge(a0, a1) {
        return 'M170 170L' + polar(a0, 140) + 'A140 140 0 0 1 ' + polar(a1, 140) + 'Z';
      }
      var cx = 37.8, cy = 302.2, rr2 = 21;
      function spoke(a) {
        var t = a * Math.PI / 180;
        return '<line x1="' + cx + '" y1="' + cy + '" x2="' + (cx + rr2 * Math.cos(t)).toFixed(2) + '" y2="' + (cy + rr2 * Math.sin(t)).toFixed(2) + '"/>';
      }

      this.el.innerHTML =
        '<defs>' +
          '<linearGradient id="plinthG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e9edf2"/><stop offset="1" stop-color="#e2e6ec"/></linearGradient>' +
          '<radialGradient id="vinylG" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#1a1b20"/><stop offset=".6" stop-color="#0d0e11"/><stop offset="1" stop-color="#07080a"/></radialGradient>' +
          '<linearGradient id="cwG" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#5d6269"/><stop offset=".45" stop-color="#d9dde2"/><stop offset=".6" stop-color="#b8bdc4"/><stop offset="1" stop-color="#555a61"/></linearGradient>' +
          '<radialGradient id="pivotG" cx=".45" cy=".4" r=".6"><stop offset="0" stop-color="#fbfcfd"/><stop offset="1" stop-color="#e6e9ee"/></radialGradient>' +
          '<filter id="soft5" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5"/></filter>' +
          '<filter id="sheenBlur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7"/></filter>' +
          '<filter id="armShadow" x="-50%" y="-20%" width="200%" height="140%"><feDropShadow dx="2.4" dy="3.4" stdDeviation="2" flood-color="#2a3040" flood-opacity=".28"/></filter>' +
          '<mask id="grooveMask"><circle cx="170" cy="170" r="127.5" fill="#fff"/><circle cx="170" cy="170" r="47" fill="#000"/></mask>' +
          '<clipPath id="labelClip"><circle cx="170" cy="170" r="37.5"/></clipPath>' +
        '</defs>' +

        // back-panel connectors peeking over the top edge
        '<g aria-hidden="true">' +
          '<rect x="131.5" y="-7.5" width="9" height="6" rx="1.6" fill="#2a2b2f"/>' +
          '<rect x="183" y="-9" width="6.5" height="8.5" rx="1.4" fill="#b8925a"/><rect x="184.3" y="-11" width="3.9" height="3" rx="1" fill="#d9b67e"/>' +
          '<rect x="198" y="-9" width="6.5" height="8.5" rx="1.4" fill="#b8925a"/><rect x="199.3" y="-11" width="3.9" height="3" rx="1" fill="#d9b67e"/>' +
        '</g>' +

        // plinth
        '<rect x="0" y="0" width="340" height="340" rx="10" fill="url(#plinthG)" stroke="#d4d9e0" stroke-width=".8"/>' +
        '<rect x=".9" y=".9" width="338.2" height="338.2" rx="9.2" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width=".8"/>' +

        // record
        '<circle cx="171" cy="174.5" r="130.5" fill="#4a5165" opacity=".26" filter="url(#soft5)"/>' +
        '<circle cx="170" cy="170" r="130" fill="url(#vinylG)"/>' +
        '<g mask="url(#grooveMask)">' + grooves +
          '<path d="' + wedge(-64, -16) + '" fill="#fff" opacity=".13" filter="url(#sheenBlur)"/>' +
          '<path d="' + wedge(-48, -30) + '" fill="#fff" opacity=".08" filter="url(#sheenBlur)"/>' +
          '<path d="' + wedge(116, 164) + '" fill="#fff" opacity=".08" filter="url(#sheenBlur)"/>' +
        '</g>' +
        '<circle cx="170" cy="170" r="129.4" fill="none" stroke="#fff" stroke-opacity=".12" stroke-width=".7"/>' +

        // label (spins)
        '<g id="spin">' +
          '<circle cx="170" cy="170" r="44.5" fill="#dcdcdc"/>' +
          '<image id="label-art" x="132.5" y="132.5" width="75" height="75" clip-path="url(#labelClip)" preserveAspectRatio="xMidYMid slice"/>' +
          '<circle cx="170" cy="170" r="37.5" fill="none" stroke="#000" stroke-opacity=".08" stroke-width=".6"/>' +
          '<circle cx="170" cy="170" r="3.2" fill="#ececec" stroke="#b9b9b9" stroke-width=".5"/>' +
          '<circle cx="170" cy="170" r="1.3" fill="#8f8f8f"/>' +
        '</g>' +

        // tonearm base plate, screw, rest and cue lever
        '<g aria-hidden="true">' +
          '<path d="M257 7.5h69a10 10 0 0 1 10 10v104a10 10 0 0 1-13.5 9.4c-6-2.3-11-7.6-16-14.4L262 51.5c-6-8.6-10-17-10-27.5v-6a10.5 10.5 0 0 1 5-10.5z" fill="none" stroke="#c6ccd4" stroke-width=".9"/>' +
          '<circle cx="263.4" cy="29.7" r="2.3" fill="#2a2b30"/>' +
          '<circle cx="321.5" cy="124" r="2" fill="#2a2b30"/>' +
          '<line x1="290" y1="94" x2="347" y2="94" stroke="#9aa1aa" stroke-width="1.5" stroke-linecap="round"/>' +
          '<rect x="341" y="91.6" width="9" height="4.8" rx="2" fill="#6b7179"/>' +
          '<path d="M297 93.6c-7-.6-12 .8-15.5 6" fill="none" stroke="#1d1e22" stroke-width="2.6" stroke-linecap="round"/>' +
        '</g>' +

        // tonearm (rotates around pivot)
        '<g id="arm" filter="url(#armShadow)">' +
          '<rect x="303.5" y="22" width="10.5" height="10" rx="1.5" fill="#2b2d31"/>' +
          '<rect x="292.5" y="3.5" width="32" height="21" rx="3" fill="url(#cwG)"/>' +
          '<rect x="292.5" y="18.5" width="32" height="6" rx="2" fill="#1f2125" opacity=".85"/>' +
          '<circle cx="308.8" cy="53.9" r="22.7" fill="url(#pivotG)" stroke="#c2c8d0" stroke-width=".9"/>' +
          '<circle cx="308.8" cy="53.9" r="14.5" fill="none" stroke="#d3d8de" stroke-width=".7"/>' +
          '<line x1="308.8" y1="28" x2="319.9" y2="212.6" stroke="#17181b" stroke-width="4.6" stroke-linecap="round"/>' +
          '<line x1="307.7" y1="34" x2="318.6" y2="208" stroke="#fff" stroke-opacity=".22" stroke-width="1"/>' +
          '<rect x="315.4" y="168.6" width="6.6" height="4.2" rx=".8" fill="#c63a40" transform="rotate(-3.5 318.7 170.7)"/>' +
          '<rect x="316.3" y="210.5" width="7.4" height="6.5" rx="1.4" fill="#2a2b2f"/>' +
          '<path d="M313.6 216.5h12.6l3 28.5-16.4 3.8z" fill="#2c2e33" stroke="#17181b" stroke-width=".6"/>' +
          '<path d="M313.2 236.5l14-2 1.6 18.3-13.8 2.2z" fill="#3e4148"/>' +
          '<path d="M328 239.5c4.6 2 7 5.4 7.4 10.6" fill="none" stroke="#2a2b2f" stroke-width="1.7" stroke-linecap="round"/>' +
          '<circle cx="320.6" cy="253.4" r="1.1" fill="#9aa0a8"/>' +
        '</g>' +

        // start / stop button (bottom-left) and decorative speed dial (bottom-right)
        '<g class="deck-btn" id="deck-start" role="button" tabindex="0" aria-label="Start or stop the record">' +
          '<circle class="hit" cx="' + cx + '" cy="' + cy + '" r="26"/>' +
          '<g class="btn-face" fill="none" stroke="#3a3c42" stroke-width=".9" stroke-linecap="round">' +
            '<circle class="btn-ring" cx="' + cx + '" cy="' + cy + '" r="' + rr2 + '"/>' +
            spoke(210) + spoke(330) + spoke(90) +
          '</g>' +
        '</g>' +
        '<circle cx="302.2" cy="302.2" r="21" fill="none" stroke="#3a3c42" stroke-width=".9" aria-hidden="true"/>';

      this.spinEl = $('spin');
      this.armEl = $('arm');
      this.labelArt = $('label-art');

      var start = $('deck-start');
      start.addEventListener('click', function () { engine.toggle(); });
      start.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); engine.toggle(); }
      });
    },

    // angle the arm must rotate to put the stylus at radius r on the record
    angleFor: function (r) {
      var lo = 0, hi = 53;
      for (var n = 0; n < 30; n++) {
        var mid = (lo + hi) / 2, t = mid * Math.PI / 180;
        var vx = STYLUS[0] - PIVOT[0], vy = STYLUS[1] - PIVOT[1];
        var x = PIVOT[0] + vx * Math.cos(t) - vy * Math.sin(t);
        var y = PIVOT[1] + vx * Math.sin(t) + vy * Math.cos(t);
        var d = Math.hypot(x - CENTER[0], y - CENTER[1]);
        if (d > r) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    },

    setTrack: function (t) { this.labelArt.setAttribute('href', t.art); },

    update: function (dt, progress) {
      var on = engine.playing;
      var target = on ? 200 : 0;                                 // 33⅓ rpm = 200°/s
      this.spinVel += (target - this.spinVel) * (1 - Math.exp(-dt * (on ? 3.4 : 1.6)));
      if (this.spinVel < 0.05 && !on) this.spinVel = 0;
      if (this.spinVel) {
        this.spin = (this.spin + this.spinVel * dt) % 360;
        this.spinEl.setAttribute('transform', 'rotate(' + this.spin.toFixed(2) + ' 170 170)');
      }
      var armTarget = on ? this.angleFor(123 - 69 * clamp(progress, 0, 1)) : 0;
      var k = 34, c = 2 * Math.sqrt(k);
      var a = k * (armTarget - this.arm) - c * this.armVel;
      this.armVel += a * dt;
      this.arm += this.armVel * dt;
      if (Math.abs(armTarget - this.arm) < 0.001 && Math.abs(this.armVel) < 0.001) { this.arm = armTarget; this.armVel = 0; }
      var tf = 'rotate(' + this.arm.toFixed(3) + ' ' + PIVOT[0] + ' ' + PIVOT[1] + ')';
      if (tf !== this._tf) { this.armEl.setAttribute('transform', tf); this._tf = tf; }
    }
  };

  /* ───────────────────────── Arc progress / seek ───────────────────────── */

  var consoleEl = playingPage.querySelector('.console');
  var arc = {
    svg: $('arc'),
    played: $('arc-played'),
    thumb: $('arc-thumb'),
    seek: $('seek'),
    seeking: false,
    dragP: 0,
    last: '',

    layout: function () {
      this.rx = W;
      this.ry = 190 * S;
      this.pad = 14 * S;
      this.svg.setAttribute('viewBox', '0 0 ' + W.toFixed(2) + ' ' + (40 * S).toFixed(2));
      this.thumb.setAttribute('r', (4 * S).toFixed(2));
      this.last = '';
    },

    y: function (x) {
      var u = (x - W / 2) / this.rx;
      return this.ry - this.ry * Math.sqrt(Math.max(0, 1 - u * u));
    },

    draw: function (p) {
      var key = p.toFixed(4) + '|' + W;
      if (key === this.last) return;
      this.last = key;
      var x0 = this.pad, x1 = this.pad + (W - 2 * this.pad) * p;
      var n = Math.max(2, Math.ceil(36 * p) + 1), d = '';
      for (var i = 0; i <= n; i++) {
        var x = x0 + (x1 - x0) * (i / n);
        d += (i ? 'L' : 'M') + x.toFixed(2) + ' ' + this.y(x).toFixed(2);
      }
      this.played.setAttribute('d', p > 0.0005 ? d : '');
      this.thumb.setAttribute('cx', x1.toFixed(2));
      this.thumb.setAttribute('cy', this.y(x1).toFixed(2));
    },

    pFromEvent: function (e) {
      var r = this.seek.getBoundingClientRect();
      var pad = this.pad * (r.width / W);
      return clamp((e.clientX - r.left - pad) / (r.width - 2 * pad), 0, 1);
    },

    bind: function () {
      var self = this, el = this.seek;
      el.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        el.setPointerCapture(e.pointerId);
        self.seeking = true;
        self.dragP = self.pFromEvent(e);
        consoleEl.classList.add('is-seeking');
      });
      el.addEventListener('pointermove', function (e) {
        if (self.seeking) self.dragP = self.pFromEvent(e);
      });
      function end(e) {
        if (!self.seeking) return;
        self.seeking = false;
        consoleEl.classList.remove('is-seeking');
        if (e.type === 'pointerup') engine.seek(self.dragP * engine.duration());
      }
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('keydown', function (e) {
        var t = engine.position(), d = engine.duration(), nt = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') nt = t + 5;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') nt = t - 5;
        else if (e.key === 'PageUp') nt = t + 15;
        else if (e.key === 'PageDown') nt = t - 15;
        else if (e.key === 'Home') nt = 0;
        else if (e.key === 'End') nt = d - 1;
        if (nt !== null) { e.preventDefault(); engine.seek(clamp(nt, 0, d)); }
      });
      el.addEventListener('focus', function () { if (el.matches(':focus-visible')) consoleEl.classList.add('is-seek-focus'); });
      el.addEventListener('blur', function () { consoleEl.classList.remove('is-seek-focus'); });
    }
  };

  /* ───────────────────────── Console: time, waveform, controls ───────────────────────── */

  var timeEl = $('time');
  var waveBars = Array.prototype.slice.call(document.querySelectorAll('#wave i'));
  var WAVE_BASE = [22, 43, 30, 36, 22, 43];
  var WAVE_BAND = [4, 0, 2, 1, 3, 5];
  var waveCur = WAVE_BASE.map(function (h) { return h / 44; });
  var levels = [0, 0, 0, 0, 0, 0];
  var flashUntil = 0, flashMsg = null;     // short messages in the time readout
  var lastTime = '';
  var lastAria = -1;

  var knob = $('knob');
  var knobFace = $('knob-face');

  function renderKnob() {
    knobFace.style.transform = 'rotate(' + (-135 + engine.volume * 270).toFixed(1) + 'deg)';
    knob.setAttribute('aria-valuetext', 'Volume ' + Math.round(engine.volume * 100) + '%');
  }

  function setVolume(v) {
    engine.setVolume(v);
    flashMsg = null;
    flashUntil = performance.now() + 1100;
    renderKnob();
  }

  function bindKnob() {
    var st = null, suppress = false;
    function angle(e) {
      var r = knob.getBoundingClientRect();
      var dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      return { a: Math.atan2(dy, dx) * 180 / Math.PI, d: Math.hypot(dx, dy) };
    }
    knob.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var a = angle(e);
      st = { id: e.pointerId, x: e.clientX, y: e.clientY, a: a.a, moved: false };
    });
    knob.addEventListener('pointermove', function (e) {
      if (!st || st.id !== e.pointerId) return;
      if (!st.moved && Math.hypot(e.clientX - st.x, e.clientY - st.y) > 6) {
        st.moved = true;
        knob.setPointerCapture(e.pointerId);
        knob.classList.add('is-turning');
      }
      if (!st.moved) return;
      var a = angle(e);
      if (a.d < 8 * S) return;                     // too close to the centre to read an angle
      var delta = a.a - st.a;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      st.a = a.a;
      setVolume(engine.volume + delta / 270);
    });
    function end(e) {
      if (!st || st.id !== e.pointerId) return;
      if (st.moved) { suppress = true; setTimeout(function () { suppress = false; }, 0); }
      st = null;
      knob.classList.remove('is-turning');
    }
    knob.addEventListener('pointerup', end);
    knob.addEventListener('pointercancel', end);
    knob.addEventListener('click', function () { if (!suppress) engine.toggle(); });
    knob.addEventListener('wheel', function (e) {
      e.preventDefault();
      setVolume(engine.volume + (e.deltaY < 0 ? 0.05 : -0.05));
    }, { passive: false });
    knob.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); setVolume(engine.volume + 0.05); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); setVolume(engine.volume - 0.05); }
    });
  }

  function currentQueue() {
    if (indexIn(queue, engine.track) >= 0) return queue;
    if (indexIn(list, engine.track) >= 0) return list;
    return engine.track ? [engine.track] : [];
  }

  /* What plays next. Your own ordered lists (liked songs, playlists) play in
     order; everything else — search, Home, Explore, Encore's own picks — and
     the end of any list get Encore's next song (when Smart next is on). */
  var ORDERED = { saved: true, playlist: true };

  function upcoming() {
    var q = currentQueue(), i = indexIn(q, engine.track);
    var inOrder = ORDERED[queueSource] && q.length > 1 && i >= 0 && i < q.length - 1;
    if (!inOrder && encore && encore.settings.smart && engine.track && !engine.track.music) {
      var p = encore.peek();
      if (p && p.t) return { t: p.t, encore: true, back: !!p.back };
      // no pick yet (first seconds, slow network): the first song from your last list not heard this session
      var heard = encore.session.ids;
      for (var k = 0; i < 0 && k < queue.length; k++) {
        if (heard.indexOf(queue[k].id) < 0 && !sameTrack(queue[k], engine.track)) return { t: queue[k], encore: false };
      }
    }
    return q.length > 1 ? { t: q[mod(i + 1, q.length)], encore: false } : null;
  }

  // reason: 'next' (the button) or 'auto' (the song ended)
  function advance(reason) {
    var nx = upcoming();
    if (!nx) return false;
    var t = nx.encore ? encore.next() : nx.t;
    if (!t) return false;
    if (nx.encore) queueSource = 'encore';
    if (encore) encore.note(reason, queueSource);
    engine.load(t, reason === 'auto' || engine.playing);
    return true;
  }

  function step(dir) {
    if (dir < 0 && engine.position() > 3) { engine.seek(0); return; }
    if (dir > 0) { if (!advance('next')) engine.seek(0); return; }
    // back through what you actually heard, then through the list
    var back = encore && encore.previous();
    if (back) { encore.note('prev', queueSource); engine.load(back, engine.playing); return; }
    var q = currentQueue(), i = indexIn(q, engine.track);
    if (q.length < 2) { engine.seek(0); return; }
    if (encore) encore.note('prev', queueSource);
    engine.load(q[mod(i - 1, q.length)], engine.playing);
  }

  function updateConsole(dt, now, p, pos, dur) {
    var txt = now < flashUntil
      ? (flashMsg || 'VOL ' + Math.round(engine.volume * 100) + '%')
      : fmt(pos) + ' / ' + fmt(dur);
    if (txt !== lastTime) { timeEl.textContent = txt; lastTime = txt; }

    var sec = Math.floor(pos);
    if (sec !== lastAria) {
      arc.seek.setAttribute('aria-valuenow', sec);
      arc.seek.setAttribute('aria-valuetext', fmt(pos) + ' of ' + fmt(dur));
      lastAria = sec;
    }
    arc.draw(p);

    engine.levels(levels);
    var k = 1 - Math.exp(-dt * 16);
    for (var i = 0; i < 6; i++) {
      var base = WAVE_BASE[i];
      var h = engine.playing ? clamp(base * (0.3 + 1.35 * levels[WAVE_BAND[i]]), 5, 44) : base;
      waveCur[i] += (h / 44 - waveCur[i]) * k;
      waveBars[i].style.transform = 'scaleY(' + waveCur[i].toFixed(3) + ')';
    }
  }

  /* ───────────────────────── Track & state sync ───────────────────────── */

  var infoEl = playingPage.querySelector('.info');
  var titleEl = $('np-title');
  var artistEl = $('np-artist');
  var firstTrack = true;

  engine.on('track', function () {
    var t = engine.track;
    deck.setTrack(t);
    arc.seek.setAttribute('aria-valuemax', t.duration);
    lastAria = -1;
    if (firstTrack) {
      titleEl.textContent = t.title;
      artistEl.textContent = t.artist;
      firstTrack = false;
    } else {
      infoEl.classList.add('is-swapping');
      setTimeout(function () {
        titleEl.textContent = t.title;
        artistEl.textContent = t.artist;
        infoEl.classList.remove('is-swapping');
      }, 200);
    }
    syncPlayLabels();
  });

  engine.on('state', function () {
    knob.classList.toggle('is-on', engine.playing);
    knob.setAttribute('aria-pressed', String(engine.playing));
    knob.setAttribute('aria-label', engine.playing ? 'Pause' : 'Play');
    syncPlayLabels();
  });

  // Now Playing bookmark: mirrors the liked songs for whatever is on the deck
  var npSave = $('np-save');
  function syncNpSave() {
    var t = engine.track, s = !!(t && saved.has(t.id));
    npSave.classList.toggle('is-saved', s);
    npSave.setAttribute('aria-pressed', String(s));
    npSave.setAttribute('aria-label', t ? (s ? 'Remove from liked songs: ' : 'Like: ') + t.title : 'Like');
  }
  npSave.addEventListener('click', function () {
    if (!engine.track) return;
    if (saved.toggle(engine.track)) npSave.classList.add('pop');
  });
  npSave.addEventListener('animationend', function () { npSave.classList.remove('pop'); });
  engine.on('track', syncNpSave);
  saved.on(syncNpSave);

  engine.on('ended', function () { advance('auto'); });

  engine.on('error', function () {
    flashMsg = 'UNAVAILABLE';
    flashUntil = performance.now() + 2200;
  });

  // remember what gets played: it shapes Explore
  var recordedId = null;
  engine.on('track', function () { recordedId = null; });
  engine.on('state', function () {
    var t = engine.track;
    if (engine.playing && t && t.src && recordedId !== t.id) {
      recordedId = t.id;
      saved.recordPlay(t);
      scheduleExplore();
    }
  });

  /* ───────────────────────── Navigation ─────────────────────────
     #/home · #/explore · #/saved   tabs (switching replaces history)
     #/search                        search, over Home
     #/playlist                      a playlist, over Saved
     #/playing                       Now Playing over whatever was open   */

  var ctx = {};
  var TABS = ['home', 'explore', 'saved'];
  var tabPages = { home: $('home'), explore: explorePage, saved: $('saved') };
  var OVERLAYS = {
    search:   { page: $('search'), tab: 'home',  cls: 'is-search' },
    playlist: { page: $('plview'), tab: 'saved', cls: 'is-playlist' }
  };
  var tabbar = $('tabbar');
  var tabButtons = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var tab = 'home', overlay = null, onPlayingPage = null;
  var pushedPlaying = false, pushedOverlay = false;

  function route() { return location.hash.replace(/^#\/?/, '').toLowerCase(); }

  function setLive(el, live) {
    el.inert = !live;
    el.setAttribute('aria-hidden', String(!live));
  }

  function exploreVisible() {
    return tab === 'explore' && !overlay && !device.classList.contains('is-playing');
  }

  function applyRoute() {
    var r = route(), playing = r === 'playing';
    if (!playing) {
      overlay = OVERLAYS[r] ? r : null;
      // a reload on #/playlist has no playlist open: fall back to Saved
      if (overlay === 'playlist' && !(ctx.hasPlaylist && ctx.hasPlaylist())) {
        overlay = null;
        r = 'saved';
        history.replaceState(null, '', '#/saved');
      }
      tab = overlay ? OVERLAYS[overlay].tab : (TABS.indexOf(r) >= 0 ? r : 'home');
    }
    device.classList.toggle('is-playing', playing);
    Object.keys(OVERLAYS).forEach(function (name) {
      var on = overlay === name;
      device.classList.toggle(OVERLAYS[name].cls, on);
      setLive(OVERLAYS[name].page, on && !playing);
    });
    TABS.forEach(function (name) {
      var active = name === tab;
      tabPages[name].classList.toggle('is-active', active);
      setLive(tabPages[name], active && !playing && !overlay);
    });
    setLive(playingPage, playing);
    setLive(tabbar, !playing && !overlay);
    tabButtons.forEach(function (b) {
      var active = b.dataset.tab === tab;
      b.classList.toggle('is-active', active);
      if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    if (exploreVisible() && pendingExplore) {
      // a fresher mix was made while you were elsewhere
      applyExplore(pendingExplore);
      pendingExplore = null;
    } else if (!playing && onPlayingPage && tab === 'explore' && !overlay) {
      // back from Now Playing: turn the wheel to whatever is on the deck
      var i = indexIn(list, engine.track);
      if (i >= 0 && wheel.sel !== i) setTimeout(function () { wheel.go(i); }, 260);
    }
    onPlayingPage = playing;
  }

  function goTab(name) {
    if (route() === name) return;
    history.replaceState(null, '', '#/' + name);
    applyRoute();
  }

  function openPlaying() {
    if (route() !== 'playing') { location.hash = '#/playing'; pushedPlaying = true; }
  }

  function closePlaying() {
    if (pushedPlaying) { history.back(); return; }
    history.replaceState(null, '', '#/' + (overlay || tab));
    applyRoute();
  }

  function openOverlay(name) {
    if (route() === name) return;
    location.hash = '#/' + name;
    pushedOverlay = true;
    applyRoute();                     // now, so a field can take focus in this gesture
  }

  function closeOverlay() {
    if (pushedOverlay) { history.back(); return; }
    history.replaceState(null, '', '#/' + tab);
    applyRoute();
  }

  window.addEventListener('hashchange', function () {
    var r = route();
    if (r !== 'playing') pushedPlaying = false;
    if (!OVERLAYS[r] && r !== 'playing') pushedOverlay = false;
    if (ctx.closeSheet) ctx.closeSheet();
    applyRoute();
  });

  /* ───────────────────────── Explore: songs for your taste ───────────────────────── */

  var wheelStatus = $('wheel-status');
  var exploreSig = null, exploreBusy = false, pendingExplore = null, exploreTimer = 0;

  function applyExplore(res) {
    var start = Math.max(0, indexIn(res.tracks, engine.track));
    wheel.build(res.tracks, start);
    // until something is played, the deck holds the first song instead of the demo
    if (!userPlayed && engine.track && engine.track.music && !engine.playing) engine.load(res.tracks[0], false);
  }

  // Explore: Encore's songs for right now once it knows you, else the taste mix
  function exploreSignature() {
    var s = window.VinylTaste.signature(saved);
    if (encore && encore.prof.n >= 5) s += '|e' + window.EncoreProfile.context(Date.now()).block;
    return s;
  }

  function refreshExplore() {
    var sig = exploreSignature();
    if (exploreBusy || sig === exploreSig) return;
    exploreBusy = true;
    var mix = encore
      ? encore.forNow(24).catch(function () { return window.VinylTaste.build(saved, cfg); })
      : window.VinylTaste.build(saved, cfg);
    mix.then(function (res) {
      exploreSig = sig;
      if (exploreVisible() && N) pendingExplore = res;     // don't swap the wheel under you
      else applyExplore(res);
    }, function () {
      if (!N) wheel.build(DEMO, DEMO.initialWheel || 0);
    }).then(function () {
      exploreBusy = false;
      wheelStatus.hidden = true;
      if (exploreSignature() !== exploreSig) scheduleExplore();
    });
  }

  function scheduleExplore() {
    clearTimeout(exploreTimer);
    exploreTimer = setTimeout(refreshExplore, 1500);
  }

  saved.on(scheduleExplore);

  /* ───────────────────────── Boot ───────────────────────── */

  deck.build();
  wheel.bind();
  arc.bind();
  bindKnob();
  $('prev').addEventListener('click', function () { step(-1); });
  $('next').addEventListener('click', function () { step(1); });
  $('back').addEventListener('click', closePlaying);
  tabButtons.forEach(function (b) {
    b.addEventListener('click', function () { goTab(b.dataset.tab); });
  });

  engine.load(DEMO[DEMO.initialTrack || 0], false);
  renderKnob();
  if (window.Encore) {
    try { encore = window.Encore.init({ engine: engine, saved: saved }); } catch (e) { encore = null; if (window.console) console.error('[encore] off:', e); }
  }
  refreshExplore();

  ctx.engine = engine;
  ctx.saved = saved;
  ctx.demo = DEMO;
  ctx.playFrom = playFrom;
  ctx.openOverlay = openOverlay;
  ctx.closeOverlay = closeOverlay;
  ctx.encore = encore;
  ctx.peekNext = upcoming;
  ctx.playUpNow = function () {
    var t = encore && encore.next();
    if (!t) return;
    queueSource = 'encore';
    encore.note('next', 'encore');
    engine.load(t, true);
  };
  var ui = window.VinylPages.init(ctx);
  window.VinylPlaylists.init(ctx, ui);
  if (encore && window.EncoreUI) window.EncoreUI.init(ctx, encore);

  if (window.ResizeObserver) new ResizeObserver(layout).observe(device);
  window.addEventListener('resize', layout);
  layout();

  // first paint without the page transition
  device.classList.add('no-anim');
  applyRoute();
  requestAnimationFrame(function () {
    requestAnimationFrame(function () { device.classList.remove('no-anim'); });
  });

  var lastT = performance.now();
  function frame(now) {
    var dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000));
    lastT = now;
    var dur = engine.duration();
    var pos = arc.seeking ? arc.dragP * dur : engine.position();
    var p = dur ? pos / dur : 0;
    wheel.update(dt);
    wheel.render();
    deck.update(dt, p);
    updateConsole(dt, now, p, pos, dur);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();

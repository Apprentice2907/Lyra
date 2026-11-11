/* Home (famous songs), Saved › Liked songs, and the Search overlay.
   Also builds the shared song rows / cards used by js/playlists.js. */
(function () {
  'use strict';

  var ICONS = {
    save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.4 3.8h9.2a1.7 1.7 0 0 1 1.7 1.7v14.6L12 16.3l-6.3 3.8V5.5a1.7 1.7 0 0 1 1.7-1.7z"/></svg>',
    remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.2"/><path d="M8.4 12h7.2"/></svg>',
    add: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.2"/><path class="ic-plus" d="M12 8.4v7.2M8.4 12h7.2"/><path class="ic-check" d="m8.3 12.3 2.5 2.5 5-5.2"/></svg>'
  };

  function init(ctx) {
    var engine = ctx.engine;
    var saved = ctx.saved;
    var api = window.MusicAPI;
    var cfg = window.VINYL_CONFIG || {};
    var $ = function (id) { return document.getElementById(id); };
    var lists = {};               // list name → tracks (also the play queue)
    var suppressClick = false;

    /* ───────── builders ───────── */

    // action: 'save' (bookmark), 'remove' (take out of a playlist) or 'add' (pick for a playlist)
    function row(t, i, action) {
      action = action || 'save';
      var li = document.createElement('li');
      li.className = 'row';
      li.dataset.id = t.id;
      li.dataset.i = i;
      li.innerHTML =
        '<button class="row-main" type="button">' +
          '<span class="row-art"><img alt="" loading="lazy" decoding="async" draggable="false"></span>' +
          '<span class="row-meta"><span class="row-title"></span><span class="row-artist"></span></span>' +
        '</button>' +
        '<button class="row-act ' + action + '" type="button">' + ICONS[action] + '</button>';
      li.querySelector('img').src = t.artSmall || t.art;
      li.querySelector('.row-title').textContent = t.title;
      li.querySelector('.row-artist').textContent = t.artist;
      var b = li.querySelector('.row-act');
      b.dataset.title = t.title;
      if (action === 'remove') b.setAttribute('aria-label', 'Remove from this playlist: ' + t.title);
      return li;
    }

    function card(t, i) {
      var li = document.createElement('li');
      li.className = 'card';
      li.dataset.id = t.id;
      li.dataset.i = i;
      li.innerHTML =
        '<button class="card-main" type="button">' +
          '<span class="card-art"><img alt="" loading="lazy" decoding="async" draggable="false"></span>' +
          '<span class="card-title"></span><span class="card-artist"></span>' +
        '</button>';
      li.querySelector('img').src = t.art || t.artSmall;
      li.querySelector('.card-title').textContent = t.title;
      li.querySelector('.card-artist').textContent = t.artist;
      return li;
    }

    function skeleton(ul, n, kind) {
      var html = '';
      for (var i = 0; i < n; i++) {
        html += kind === 'card'
          ? '<li class="card is-skel"><span class="card-main"><span class="card-art"></span>' +
            '<span class="skel-line" style="width:70%;margin-top:calc(14*var(--u))"></span>' +
            '<span class="skel-line" style="width:45%;margin-top:calc(7*var(--u))"></span></span></li>'
          : '<li class="row is-skel"><span class="row-main"><span class="row-art"></span><span class="row-meta" style="flex:1">' +
            '<span class="skel-line" style="width:' + (50 + (i * 17) % 30) + '%"></span>' +
            '<span class="skel-line" style="width:32%;margin-top:calc(8*var(--u))"></span></span></span></li>';
      }
      ul.innerHTML = html;
    }

    function fill(ul, name, tracks, make) {
      lists[name] = tracks;
      ul.dataset.list = name;
      var frag = document.createDocumentFragment();
      tracks.forEach(function (t, i) { frag.appendChild(make(t, i)); });
      ul.textContent = '';
      ul.appendChild(frag);
      sync();
    }

    /* ───────── state: playing row + liked bookmarks ───────── */

    function sync() {
      var cur = engine.track ? engine.track.id : null, on = engine.playing;
      var nodes = document.querySelectorAll('.lib [data-id]');
      for (var k = 0; k < nodes.length; k++) {
        var n = nodes[k], isCur = n.dataset.id === cur;
        n.classList.toggle('is-current', isCur);
        n.classList.toggle('is-on', isCur && on);
        var b = n.querySelector('.save');
        if (b) {
          var s = saved.has(n.dataset.id);
          b.classList.toggle('is-saved', s);
          b.setAttribute('aria-pressed', String(s));
          b.setAttribute('aria-label', (s ? 'Remove from liked songs: ' : 'Like: ') + b.dataset.title);
        }
      }
    }

    engine.on('track', sync);
    engine.on('state', sync);

    /* ───────── clicks (rows, cards, row buttons) ───────── */

    function bindList(ul, opts) {
      opts = opts || {};
      ul.addEventListener('click', function (e) {
        if (suppressClick) return;
        var item = e.target.closest('[data-i]');
        if (!item || !ul.contains(item) || item.classList.contains('is-skel')) return;
        var tracks = lists[ul.dataset.list];
        var i = +item.dataset.i, t = tracks && tracks[i];
        if (!t) return;
        if (e.target.closest('.save')) {
          if (opts.removeAnimated && saved.has(t.id)) leave(item, function () { saved.toggle(t); });
          else saved.toggle(t);
          return;
        }
        if (e.target.closest('.remove')) { if (opts.onRemove) leave(item, function () { opts.onRemove(t); }); return; }
        if (e.target.closest('.add')) { if (opts.onAdd) opts.onAdd(t, item); return; }
        if (opts.onPick) { opts.onPick(t, item); return; }
        ctx.playFrom(tracks, i, ul.dataset.list);
      });
    }

    function leave(item, done) {
      if (item.dataset.leaving) return;
      item.dataset.leaving = '1';
      item.classList.add('is-leaving');
      setTimeout(done, 240);
    }

    // mouse drag-to-scroll for carousels (touch and trackpads scroll natively)
    function dragScroll(el) {
      var st = null;
      el.addEventListener('pointerdown', function (e) {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        st = { id: e.pointerId, x: e.clientX, left: el.scrollLeft, moved: false };
      });
      el.addEventListener('pointermove', function (e) {
        if (!st || st.id !== e.pointerId) return;
        var dx = e.clientX - st.x;
        if (!st.moved && Math.abs(dx) > 5) {
          st.moved = true;
          el.setPointerCapture(e.pointerId);
          el.classList.add('is-dragging');
        }
        if (st.moved) el.scrollLeft = st.left - dx;
      });
      function end() {
        if (st && st.moved) {
          suppressClick = true;
          setTimeout(function () { suppressClick = false; }, 0);
        }
        st = null;
        el.classList.remove('is-dragging');
      }
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    }

    /* ───────── Home: famous songs ───────── */

    var sectionsEl = $('home-sections');
    var note = $('home-note');
    var homeSections = (cfg.home && cfg.home.length) ? cfg.home : [
      { title: 'Superhits', style: 'carousel', playlist: '1134548194', query: 'bollywood superhits' }
    ];

    function loadHome() {
      var uls = homeSections.map(function (s, k) {
        var h = document.createElement('h2');
        h.className = 'section-title';
        h.textContent = s.title;
        var ul = document.createElement('ul');
        ul.className = s.style === 'carousel' ? 'carousel' : 'rows';
        sectionsEl.appendChild(h);
        sectionsEl.appendChild(ul);
        skeleton(ul, s.style === 'carousel' ? 4 : 6, s.style === 'carousel' ? 'card' : 'row');
        bindList(ul);
        if (s.style === 'carousel') dragScroll(ul);
        ul.dataset.list = 'home' + k;
        return ul;
      });

      Promise.all(homeSections.map(function (s) {
        return api.collection(s, 30).catch(function () { return null; });
      })).then(function (results) {
        var failed = results.every(function (r) { return !r; });
        if (failed) {
          note.textContent = 'Can’t reach the music service right now — playing demo tracks.';
          note.hidden = false;
        }
        var seen = {};
        results.forEach(function (tracks, k) {
          var s = homeSections[k];
          if (!tracks) tracks = failed ? ctx.demo.slice(k * 4, k * 4 + 5) : [];
          // a song shows up once on Home, in the first section that has it
          tracks = tracks.filter(function (t) { if (seen[t.id]) return false; seen[t.id] = true; return true; });
          tracks = tracks.slice(0, s.style === 'carousel' ? 14 : 20);
          var ul = uls[k];
          fill(ul, 'home' + k, tracks, s.style === 'carousel' ? card : function (t, i) { return row(t, i); });
          var hidden = !tracks.length;
          ul.hidden = hidden;
          ul.previousElementSibling.hidden = hidden;
        });
      });
    }

    /* ───────── Saved › Liked songs ───────── */

    var likedUl = $('saved-list');

    function renderLiked() {
      var items = saved.list();
      fill(likedUl, 'saved', items, function (t, i) { return row(t, i); });
      $('saved-empty').hidden = items.length > 0;
      if (ctx.onLikedCount) ctx.onLikedCount(items.length);
    }

    bindList(likedUl, { removeAnimated: true });
    saved.on(function (kind) {
      if (kind === 'liked') renderLiked();
      sync();
    });

    /* ───────── Search ───────── */

    var input = $('search-input');
    var resultsUl = $('search-results');
    var status = $('search-status');
    var clearBtn = $('search-clear');
    var timer = 0, ctl = null, lastQ = null;

    function setStatus(s) { status.textContent = s; status.hidden = !s; }

    function run() {
      clearTimeout(timer);
      var q = input.value.trim();
      if (q === lastQ) return;
      lastQ = q;
      if (ctl) { ctl.abort(); ctl = null; }
      if (!q) {
        fill(resultsUl, 'search', [], row);
        setStatus('Find songs and artists');
        return;
      }
      setStatus('Searching…');
      var mine = ctl = new AbortController();
      api.searchSongs(q, 25, mine.signal).then(function (l) {
        if (mine !== ctl) return;
        fill(resultsUl, 'search', l, function (t, i) { return row(t, i); });
        setStatus(l.length ? '' : 'No songs found for “' + q + '”');
      }, function () {
        if (mine !== ctl) return;
        lastQ = null;                              // let the same query be retried
        fill(resultsUl, 'search', [], row);
        setStatus('Couldn’t reach the music service. Check your connection and try again.');
      });
    }

    input.addEventListener('input', function () {
      clearBtn.hidden = !input.value;
      clearTimeout(timer);
      timer = setTimeout(run, 320);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); run(); input.blur(); }
      else if (e.key === 'Escape') { input.blur(); ctx.closeOverlay(); }
    });
    clearBtn.addEventListener('click', function (e) {
      e.preventDefault();
      input.value = '';
      clearBtn.hidden = true;
      run();
      input.focus({ preventScroll: true });
    });
    bindList(resultsUl);

    $('open-search').addEventListener('click', function () {
      ctx.openOverlay('search');
      input.focus({ preventScroll: true });        // same gesture, so mobile keyboards open
    });
    $('close-search').addEventListener('click', function () {
      input.blur();
      ctx.closeOverlay();
    });

    /* ───────── boot ───────── */

    loadHome();
    renderLiked();

    return {
      icons: ICONS, row: row, card: card, fill: fill, skeleton: skeleton,
      sync: sync, bindList: bindList, lists: lists
    };
  }

  window.VinylPages = { init: init };
})();

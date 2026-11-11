/* Saved › Playlists: your own playlists (create, rename, delete, add and
   remove songs), ready-made playlists of famous songs, the playlist page,
   and the bottom sheets those use. */
(function () {
  'use strict';

  var ICON = {
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>',
    disc: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.4"/></svg>',
    chevron: '<svg viewBox="0 0 12 20" aria-hidden="true"><path d="m3 3 7 7-7 7"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.6" cy="10.6" r="6.3"/><path d="m15.4 15.4 4.6 4.6"/></svg>'
  };

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function totalTime(tracks) {
    var s = 0;
    tracks.forEach(function (t) { s += t.duration || 0; });
    var m = Math.round(s / 60);
    if (!m) return '';
    return m >= 60 ? Math.floor(m / 60) + ' hr ' + (m % 60) + ' min' : m + ' min';
  }

  function init(ctx, ui) {
    var saved = ctx.saved;
    var api = window.MusicAPI;
    var cfg = window.VINYL_CONFIG || {};
    var $ = function (id) { return document.getElementById(id); };

    /* ───────── Liked / Playlists switch ───────── */

    var seg = $('saved-seg');
    var segBtns = Array.prototype.slice.call(seg.querySelectorAll('.seg-btn'));
    var views = { liked: $('view-liked'), playlists: $('view-playlists') };
    var countEl = $('saved-count');
    var likedCount = saved.list().length;
    var view = 'liked';

    function updateCount() {
      var n = view === 'liked' ? likedCount : saved.playlists().length;
      countEl.textContent = n ? (view === 'liked' ? plural(n, 'song', 'songs') : plural(n, 'playlist', 'playlists')) : '';
    }

    function setView(v, focus) {
      view = v;
      seg.dataset.active = v;
      segBtns.forEach(function (b) {
        var on = b.dataset.view === v;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
        if (on && focus) b.focus();
      });
      views.liked.hidden = v !== 'liked';
      views.playlists.hidden = v !== 'playlists';
      updateCount();
      if (v === 'playlists') loadFeatured();
      try { localStorage.setItem('vinyl.savedView', v); } catch (e) { /* ignore */ }
    }

    segBtns.forEach(function (b) {
      b.addEventListener('click', function () { setView(b.dataset.view); });
    });
    seg.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        setView(view === 'liked' ? 'playlists' : 'liked', true);
      }
    });
    ctx.onLikedCount = function (n) { likedCount = n; updateCount(); };

    /* ───────── playlist rows ───────── */

    function plRow(name, sub, image, attrs) {
      var li = document.createElement('li');
      li.className = 'row pl-row';
      Object.keys(attrs).forEach(function (k) { li.dataset[k] = attrs[k]; });
      li.innerHTML =
        '<button class="row-main" type="button">' +
          '<span class="row-art pl-art">' + (image ? '<img alt="" loading="lazy" decoding="async" draggable="false">' : ICON.disc) + '</span>' +
          '<span class="row-meta"><span class="row-title"></span><span class="row-artist"></span></span>' +
        '</button>' +
        '<span class="row-go">' + ICON.chevron + '</span>';
      if (image) li.querySelector('img').src = image;
      else li.querySelector('.pl-art').classList.add('is-empty');
      li.querySelector('.row-title').textContent = name;
      li.querySelector('.row-artist').textContent = sub;
      return li;
    }

    /* ───────── your playlists ───────── */

    var mineUl = $('my-playlists');

    function renderMine() {
      mineUl.textContent = '';
      var add = document.createElement('li');
      add.className = 'row pl-row pl-new';
      add.innerHTML =
        '<button class="row-main" type="button">' +
          '<span class="row-art pl-art is-new">' + ICON.plus + '</span>' +
          '<span class="row-meta"><span class="row-title">New playlist</span><span class="row-artist">Collect songs you love</span></span>' +
        '</button>';
      mineUl.appendChild(add);
      saved.playlists().forEach(function (p) {
        var tracks = saved.playlistTracks(p.id);
        var cover = tracks[0] ? (tracks[0].artSmall || tracks[0].art) : '';
        mineUl.appendChild(plRow(p.name, plural(tracks.length, 'song', 'songs'), cover, { pl: p.id }));
      });
      updateCount();
    }

    mineUl.addEventListener('click', function (e) {
      var li = e.target.closest('.pl-row');
      if (!li) return;
      if (li.classList.contains('pl-new')) createFlow();
      else openPlaylist('mine', li.dataset.pl);
    });

    /* ───────── ready-made playlists (famous songs) ───────── */

    var featUl = $('featured-playlists');
    var featTitle = $('featured-title');
    var featured = null, featLoading = false;

    function loadFeatured() {
      if (featured || featLoading) return;
      featLoading = true;
      ui.skeleton(featUl, 4, 'row');
      Promise.all((cfg.featured || []).map(function (id) {
        return api.playlistInfo(id, 40).catch(function () { return null; });
      })).then(function (list) {
        featLoading = false;
        featured = list.filter(function (p) { return p && p.tracks.length; });
        featUl.textContent = '';
        featured.forEach(function (p, i) {
          featUl.appendChild(plRow(p.name, plural(p.tracks.length, 'song', 'songs'), p.image, { fi: i }));
        });
        var none = !featured.length;
        featUl.hidden = none;
        featTitle.hidden = none;
        if (none) featured = null;               // try again next time
      });
    }

    featUl.addEventListener('click', function (e) {
      var li = e.target.closest('.pl-row');
      if (li && featured) openPlaylist('featured', +li.dataset.fi);
    });

    /* ───────── the playlist page ───────── */

    var cur = null;                     // { kind: 'mine', id } or { kind: 'featured', info }
    var tracksUl = $('pl-tracks');
    var coverEl = $('pl-cover');

    function curTracks() {
      if (!cur) return [];
      return cur.kind === 'mine' ? saved.playlistTracks(cur.id) : cur.info.tracks;
    }

    function openPlaylist(kind, key) {
      if (kind === 'mine') {
        if (!saved.playlist(key)) return;
        cur = { kind: 'mine', id: key };
      } else {
        cur = { kind: 'featured', info: featured[key] };
      }
      renderPlaylist();
      $('plview').querySelector('.scroll').scrollTop = 0;
      ctx.openOverlay('playlist');
    }

    function renderPlaylist() {
      if (!cur) return;
      var mine = cur.kind === 'mine';
      var tracks = curTracks();
      var name = mine ? saved.playlist(cur.id).name : cur.info.name;
      var image = mine ? (tracks[0] && tracks[0].art) : cur.info.image;
      $('pl-name').textContent = name;
      var meta = [plural(tracks.length, 'song', 'songs')];
      var time = totalTime(tracks);
      if (time) meta.push(time);
      meta.push(mine ? 'Your playlist' : 'Popular playlist');
      $('pl-meta').textContent = meta.join(' · ');
      coverEl.classList.toggle('is-empty', !image);
      coverEl.innerHTML = image ? '<img alt="" draggable="false">' : ICON.disc;
      if (image) coverEl.querySelector('img').src = image;
      $('pl-add').hidden = !mine;
      $('pl-more').hidden = !mine;
      $('pl-play').disabled = !tracks.length;
      ui.fill(tracksUl, 'playlist', tracks, function (t, i) { return ui.row(t, i, mine ? 'remove' : 'save'); });
      $('pl-empty').hidden = !(mine && !tracks.length);
    }

    ui.bindList(tracksUl, {
      onRemove: function (t) { if (cur && cur.kind === 'mine') saved.togglePlaylistTrack(cur.id, t); }
    });

    $('pl-play').addEventListener('click', function () {
      var tracks = curTracks();
      if (tracks.length) ctx.playFrom(tracks, 0, 'playlist');
    });
    $('pl-add').addEventListener('click', function () { openAddSheet(); });
    $('pl-more').addEventListener('click', function () { optionsSheet(); });
    $('pl-back').addEventListener('click', function () { ctx.closeOverlay(); });

    saved.on(function (kind) {
      if (kind !== 'playlists') return;
      renderMine();
      if (cur && cur.kind === 'mine') {
        if (saved.playlist(cur.id)) renderPlaylist();
        else { cur = null; ctx.closeOverlay(); }
      }
    });

    ctx.hasPlaylist = function () { return !!cur; };

    /* ───────── bottom sheets ───────── */

    var layer = $('sheet');
    var sheetEl = layer.querySelector('.sheet');
    var sheetTitle = $('sheet-title');
    var sheetBody = $('sheet-body');
    var gen = 0, lastFocus = null;

    function openSheet(title, build, tall) {
      gen++;
      if (layer.hidden) lastFocus = document.activeElement;
      sheetTitle.textContent = title;
      sheetBody.textContent = '';
      sheetEl.classList.toggle('is-tall', !!tall);
      build(sheetBody);
      layer.hidden = false;
      void layer.offsetWidth;                       // start the slide-up from the hidden state
      layer.classList.add('is-open');
      (sheetBody.querySelector('[data-autofocus]') || sheetEl).focus({ preventScroll: true });
    }

    function closeSheet() {
      if (layer.hidden) return;
      var g = ++gen;
      layer.classList.remove('is-open');
      setTimeout(function () {
        if (g !== gen) return;
        layer.hidden = true;
        sheetBody.textContent = '';
      }, 380);
      if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
    }

    layer.addEventListener('click', function (e) { if (e.target.closest('[data-close]')) closeSheet(); });
    ctx.closeSheet = closeSheet;
    ctx.openSheet = openSheet;
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !layer.hidden) { e.stopPropagation(); closeSheet(); }
    }, true);

    function nameSheet(title, initial, action, done) {
      openSheet(title, function (body) {
        body.innerHTML =
          '<form class="sheet-form" novalidate>' +
            '<label class="inset-field"><input id="pl-name-input" data-autofocus type="text" maxlength="60" autocomplete="off" placeholder="Playlist name" aria-label="Playlist name"></label>' +
            '<div class="sheet-actions">' +
              '<button type="button" class="chip-btn" data-close>Cancel</button>' +
              '<button type="submit" class="chip-btn is-primary"></button>' +
            '</div>' +
          '</form>';
        var input = body.querySelector('input');
        body.querySelector('.is-primary').textContent = action;
        input.value = initial;
        body.querySelector('form').addEventListener('submit', function (e) {
          e.preventDefault();
          var v = input.value.trim();
          if (!v) { input.focus(); return; }
          closeSheet();
          done(v);
        });
      });
      var input = $('pl-name-input');
      if (input) input.select();
    }

    function createFlow() {
      nameSheet('New playlist', 'My playlist ' + (saved.playlists().length + 1), 'Create', function (name) {
        var p = saved.createPlaylist(name);
        openPlaylist('mine', p.id);
        setTimeout(openAddSheet, 420);             // straight on to filling it
      });
    }

    function optionsSheet() {
      if (!cur || cur.kind !== 'mine') return;
      var p = saved.playlist(cur.id);
      openSheet(p.name, function (body) {
        body.innerHTML =
          '<div class="sheet-menu">' +
            '<button type="button" class="menu-item" data-act="rename" data-autofocus>Rename</button>' +
            '<button type="button" class="menu-item is-danger" data-act="delete">Delete playlist</button>' +
          '</div>';
        body.querySelector('[data-act="rename"]').addEventListener('click', function () {
          nameSheet('Rename playlist', p.name, 'Save', function (name) { saved.renamePlaylist(p.id, name); });
        });
        body.querySelector('[data-act="delete"]').addEventListener('click', function () {
          openSheet('Delete “' + p.name + '”?', function (b) {
            b.innerHTML =
              '<p class="sheet-text">The playlist goes away. Its songs stay in your liked songs if you liked them.</p>' +
              '<div class="sheet-actions">' +
                '<button type="button" class="chip-btn" data-close data-autofocus>Cancel</button>' +
                '<button type="button" class="chip-btn is-primary is-danger">Delete</button>' +
              '</div>';
            b.querySelector('.is-danger').addEventListener('click', function () {
              closeSheet();
              saved.deletePlaylist(p.id);
            });
          });
        });
      });
    }

    // Add songs: your liked songs (or popular ones) plus a search of everything.
    function openAddSheet() {
      if (!cur || cur.kind !== 'mine') return;
      var pid = cur.id;
      openSheet('Add songs', function (body) {
        body.innerHTML =
          '<label class="inset-field sheet-search">' + ICON.search +
            '<input id="add-search" type="search" placeholder="Search songs to add" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="Search songs to add">' +
          '</label>' +
          '<p class="sheet-hint" id="add-hint"></p>' +
          '<ul class="rows sheet-list" id="add-list"></ul>' +
          '<div class="sheet-actions"><button type="button" class="chip-btn is-primary" data-close>Done</button></div>';
        var input = body.querySelector('input');
        var ul = body.querySelector('#add-list');
        var hint = body.querySelector('#add-hint');
        var timer = 0, ctl = null;

        function mark() {
          var items = ul.querySelectorAll('[data-id]');
          for (var k = 0; k < items.length; k++) {
            var b = items[k].querySelector('.add'), on = saved.inPlaylist(pid, items[k].dataset.id);
            b.classList.toggle('is-in', on);
            b.setAttribute('aria-pressed', String(on));
            b.setAttribute('aria-label', (on ? 'Remove from playlist: ' : 'Add to playlist: ') + b.dataset.title);
          }
        }
        function show(tracks, text) {
          hint.textContent = text;
          ui.fill(ul, 'add', tracks, function (t, i) { return ui.row(t, i, 'add'); });
          mark();
        }
        function starters() {
          var liked = saved.list();
          if (liked.length) show(liked, 'From your liked songs');
          else show(ui.lists.home0 || [], 'Popular right now');
        }
        function toggle(t) {
          saved.togglePlaylistTrack(pid, t);
          mark();
        }

        ui.bindList(ul, { onAdd: toggle, onPick: toggle });
        input.addEventListener('input', function () {
          clearTimeout(timer);
          timer = setTimeout(function () {
            var q = input.value.trim();
            if (ctl) ctl.abort();
            if (!q) { starters(); return; }
            hint.textContent = 'Searching…';
            var mine = ctl = new AbortController();
            api.searchSongs(q, 25, mine.signal).then(function (l) {
              if (mine !== ctl) return;
              show(l, l.length ? '' : 'No songs found for “' + q + '”');
            }, function () {
              if (mine !== ctl) return;
              show([], 'Couldn’t reach the music service. Check your connection and try again.');
            });
          }, 320);
        });
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
        starters();
      }, true);
    }

    /* ───────── boot ───────── */

    renderMine();
    var startView = 'liked';
    try { startView = localStorage.getItem('vinyl.savedView') === 'playlists' ? 'playlists' : 'liked'; } catch (e) { /* ignore */ }
    setView(startView);
  }

  window.VinylPlaylists = { init: init };
})();

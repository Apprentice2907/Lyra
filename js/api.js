/* Thin client for the JioSaavn API (sumitkolhe/jiosaavn-api).
   Every song is mapped to the player's track shape:
   { id, sid, title, artist, album, duration, art, artSmall, src } */
(function () {
  'use strict';

  var cfg = window.VINYL_CONFIG || {};
  var bases = (cfg.apiBases && cfg.apiBases.length ? cfg.apiBases : ['https://saavn.sumit.co/api']).slice();
  var working = null;
  var TIMEOUT = 10000;

  var decoder = document.createElement('textarea');
  function decode(s) {
    s = String(s == null ? '' : s);
    // the API sometimes double-encodes (&amp;quot;)
    for (var k = 0; k < 2 && /&[#a-z0-9]+;/i.test(s); k++) { decoder.innerHTML = s; s = decoder.value; }
    return s.trim();
  }

  function pick(list, quality) {
    if (!list || !list.length) return '';
    for (var i = 0; i < list.length; i++) if (list[i].quality === quality) return list[i].url;
    return list[list.length - 1].url;
  }

  function https(u) { return u ? String(u).replace(/^http:\/\//, 'https://') : ''; }

  function toTrack(s) {
    if (!s || !s.id) return null;
    var src = pick(s.downloadUrl, '160kbps');
    if (!src) return null;
    var primary = (s.artists && s.artists.primary) || [];
    var artist = primary.slice(0, 2).map(function (a) { return decode(a.name); }).join(', ');
    var full = decode(s.name);
    return {
      id: 'js:' + s.id,
      sid: s.id,
      // "Song (From "Film")" → "Song"; the film is already the album
      title: full.replace(/\s*\((?:From|from)\s+["“][^"”]*["”]\)\s*$/, '') || full,
      artist: artist || 'Unknown artist',
      album: decode(s.album && s.album.name),
      language: s.language || '',
      artistIds: primary.slice(0, 2).map(function (a) { return a.id; }),
      duration: Number(s.duration) || 0,
      art: https(pick(s.image, '500x500')),
      artSmall: https(pick(s.image, '150x150')),
      src: https(src)
    };
  }

  function clean(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (s) {
      var t = toTrack(s);
      if (t && !seen[t.id]) { seen[t.id] = true; out.push(t); }
    });
    return out;
  }

  function fetchJson(url, signal) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, TIMEOUT);
    if (signal) {
      if (signal.aborted) ctl.abort();
      else signal.addEventListener('abort', function () { ctl.abort(); });
    }
    return fetch(url, { signal: ctl.signal })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (!j || j.success === false) throw new Error((j && j.message) || 'API error');
        return j.data;
      })
      .finally(function () { clearTimeout(timer); });
  }

  // Try the instance that worked last, then the others.
  function get(path, signal) {
    var order = working ? [working].concat(bases.filter(function (b) { return b !== working; })) : bases;
    var i = 0;
    function attempt() {
      var base = order[i];
      return fetchJson(base + path, signal).then(function (data) {
        working = base;
        return data;
      }, function (err) {
        if (signal && signal.aborted) throw err;
        if (++i < order.length) return attempt();
        throw err;
      });
    }
    return attempt();
  }

  function searchSongs(query, limit, signal) {
    return get('/search/songs?query=' + encodeURIComponent(query) + '&limit=' + (limit || 20), signal)
      .then(function (d) { return clean(d && d.results); });
  }

  function playlist(id, limit) {
    return playlistInfo(id, limit).then(function (p) { return p.tracks; });
  }

  // A playlist with its name and cover: { id, name, image, count, tracks }
  function playlistInfo(id, limit) {
    return get('/playlists?id=' + encodeURIComponent(id) + '&limit=' + (limit || 30))
      .then(function (d) {
        var tracks = clean(d && d.songs);
        return {
          id: String(id),
          name: decode(d && d.name),
          image: https(pick(d && d.image, '500x500')),
          count: Number(d && d.songCount) || tracks.length,
          tracks: tracks
        };
      });
  }

  // An artist's most popular songs (10 per page).
  function artistSongs(id) {
    return get('/artists/' + encodeURIComponent(id) + '/songs?page=0&sortBy=popularity&sortOrder=desc')
      .then(function (d) { return clean(d && d.songs); });
  }

  // A configured source: its playlist, falling back to its search query.
  function collection(source, limit) {
    source = source || {};
    var first = source.playlist ? playlist(source.playlist, limit) : Promise.reject(new Error('no playlist'));
    return first
      .then(function (list) { if (!list.length) throw new Error('empty'); return list; })
      .catch(function (err) {
        if (!source.query) throw err;
        return searchSongs(source.query, limit).then(function (list) {
          if (!list.length) throw new Error('empty');
          return list;
        });
      });
  }

  window.MusicAPI = {
    searchSongs: searchSongs, playlist: playlist, playlistInfo: playlistInfo,
    artistSongs: artistSongs, collection: collection
  };
})();

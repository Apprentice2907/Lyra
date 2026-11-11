/* Explore's song mix, shaped by what you like:
   - liked songs count most, then songs in your playlists, then recent plays
   - your top artists are searched for songs you haven't liked yet
   - a few of your liked songs are mixed back in
   With no history yet, Explore shows random famous songs instead. */
(function () {
  'use strict';

  var SIZE = 24;

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1)), t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  function artistsOf(t) {
    return String((t && t.artist) || '').split(/\s*,\s*/).filter(function (n) {
      return n && n !== 'Unknown artist';
    });
  }

  // Your top artists: [{ name, id }], strongest first.
  function profile(store) {
    var w = {}, ids = {};
    function add(t, weight) {
      var aids = t.artistIds || [];
      // the main artist counts fully, a featured artist half
      artistsOf(t).forEach(function (a, i) {
        w[a] = (w[a] || 0) + weight * (i ? 0.5 : 1);
        if (aids[i] && !ids[a]) ids[a] = aids[i];
      });
    }
    store.list().forEach(function (t) { if (!t.music) add(t, 3); });
    store.playlists().forEach(function (p) { p.tracks.forEach(function (t) { if (!t.demo) add(t, 2); }); });
    store.history().forEach(function (h, i) { if (h.id.indexOf('js:') === 0) add(h, i < 20 ? 1.5 : 1); });
    var names = Object.keys(w).sort(function (a, b) { return w[b] - w[a]; });
    return { artists: names.slice(0, 4).map(function (n) { return { name: n, id: ids[n] || null }; }) };
  }

  // An artist's popular songs; by name search when the catalogue has few.
  function songsBy(artist) {
    var api = window.MusicAPI;
    var byId = artist.id ? api.artistSongs(artist.id).catch(function () { return []; }) : Promise.resolve([]);
    return byId.then(function (list) {
      if (list.length >= 5) return list;
      return api.searchSongs(artist.name, 20).then(function (more) { return list.concat(more); }, function () { return list; });
    });
  }

  // Changes when the taste inputs change enough to be worth a new mix.
  function signature(store) {
    var liked = store.list().map(function (t) { return t.id; }).join(',');
    var pls = store.playlists().map(function (p) { return p.tracks.length; }).join(',');
    return liked + '|' + pls + '|' + Math.floor(store.history().length / 4);
  }

  // "Ishq (Lofi)", "Ishq - Female" and "Ishq" are one song for a mix
  function titleKey(t) {
    return String(t.title || '').toLowerCase()
      .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
      .replace(/\s+-\s+.*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function uniq(list) {
    var seen = {};
    return list.filter(function (t) {
      if (!t) return false;
      var k = titleKey(t) || t.id;
      if (seen[t.id] || seen[k]) return false;
      seen[t.id] = seen[k] = true;
      return true;
    });
  }

  function random(cfg) {
    var api = window.MusicAPI;
    var pool = shuffle((cfg.explorePool || []).slice()).slice(0, 3);
    return Promise.all(pool.map(function (id) {
      return api.playlist(id, 40).catch(function () { return []; });
    })).then(function (groups) {
      var all = uniq(shuffle([].concat.apply([], groups)));
      if (!all.length) throw new Error('no songs');
      return all.slice(0, SIZE);
    });
  }

  // Resolves { mode: 'taste' | 'random', tracks }
  function build(store, cfg) {
    var prof = profile(store);
    var liked = store.list().filter(function (t) { return !!t.src; });

    if (!prof.artists.length) {
      return random(cfg).then(function (tracks) { return { mode: 'random', tracks: tracks }; });
    }

    return Promise.all(prof.artists.slice(0, 3).map(songsBy)).then(function (groups) {
      var likedIds = {};
      liked.forEach(function (t) { likedIds[t.id] = true; });
      var recs = [];
      groups.forEach(function (g, k) {
        var name = prof.artists[k].name.toLowerCase();
        // keep songs that really feature the artist and that you haven't liked yet
        recs = recs.concat(uniq(g.filter(function (t) {
          return !likedIds[t.id] && t.artist.toLowerCase().indexOf(name) >= 0;
        })).slice(0, 8));
      });
      var likedKeys = {};
      liked.forEach(function (t) { likedKeys[titleKey(t)] = true; });
      recs = shuffle(uniq(recs).filter(function (t) { return !likedKeys[titleKey(t)]; })).slice(0, 18);
      var mine = shuffle(liked.slice()).slice(0, 6);

      // a liked song after every three recommendations
      var out = [];
      while (recs.length || mine.length) {
        for (var k = 0; k < 3 && recs.length; k++) out.push(recs.shift());
        if (mine.length) out.push(mine.shift());
      }
      out = uniq(out);
      if (out.length >= 10) return { mode: 'taste', tracks: out.slice(0, SIZE) };
      // not much to go on yet: top up with famous songs
      return random(cfg).then(function (extra) {
        return { mode: 'taste', tracks: uniq(out.concat(extra)).slice(0, SIZE) };
      }, function () {
        if (!out.length) throw new Error('no songs');
        return { mode: 'taste', tracks: out };
      });
    });
  }

  window.VinylTaste = { build: build, signature: signature, profile: profile };
})();

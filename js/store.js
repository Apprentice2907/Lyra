/* Your library, kept in this browser (localStorage):
   liked songs, your playlists, and a short listening history used to learn
   your taste for Explore. */
(function () {
  'use strict';

  var KEYS = { liked: 'vinyl.saved.v1', playlists: 'vinyl.playlists.v1', history: 'vinyl.history.v1' };
  var HISTORY_MAX = 80;

  function read(key) {
    try {
      var v = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(v) ? v.filter(function (x) { return x && x.id; }) : [];
    } catch (e) { return []; }
  }

  function write(key, items) {
    try { localStorage.setItem(key, JSON.stringify(items)); } catch (e) { /* private mode / full */ }
  }

  // Demo tracks are rebuilt from tracks.js; streamed songs keep what's needed to play.
  function slim(t) {
    if (t.music) return { id: t.id, demo: true, artist: t.artist };
    return {
      id: t.id, sid: t.sid, title: t.title, artist: t.artist, album: t.album,
      duration: t.duration, art: t.art, artSmall: t.artSmall, src: t.src,
      language: t.language, artistIds: t.artistIds,
      albumId: t.albumId, year: t.year, playCount: t.playCount, explicit: t.explicit
    };
  }

  function hydrate(x) {
    if (!x || !x.demo) return x;
    var demo = window.TRACKS || [];
    for (var i = 0; i < demo.length; i++) if (demo[i].id === x.id) return demo[i];
    return null;
  }

  function indexOf(arr, id) {
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return i;
    return -1;
  }

  function uid() { return 'pl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function Store() {
    var self = this;
    this.items = read(KEYS.liked);
    this.pls = read(KEYS.playlists);
    this.hist = read(KEYS.history);
    this._subs = [];
    window.addEventListener('storage', function (e) {
      if (e.key === KEYS.liked) { self.items = read(KEYS.liked); self._emit('liked'); }
      else if (e.key === KEYS.playlists) { self.pls = read(KEYS.playlists); self._emit('playlists'); }
    });
  }

  /* ── liked songs ── */

  Store.prototype.has = function (id) { return indexOf(this.items, id) >= 0; };

  Store.prototype.list = function () { return this.items.map(hydrate).filter(Boolean); };

  Store.prototype.toggle = function (t) {
    var i = indexOf(this.items, t.id);
    if (i >= 0) this.items.splice(i, 1);
    else this.items.unshift(slim(t));
    write(KEYS.liked, this.items);
    this._emit('liked');
    return i < 0;
  };

  /* ── playlists ── */

  Store.prototype.playlists = function () { return this.pls.slice(); };

  Store.prototype.playlist = function (id) {
    var i = indexOf(this.pls, id);
    return i >= 0 ? this.pls[i] : null;
  };

  Store.prototype.playlistTracks = function (id) {
    var p = this.playlist(id);
    return p ? p.tracks.map(hydrate).filter(Boolean) : [];
  };

  Store.prototype.createPlaylist = function (name) {
    var p = { id: uid(), name: String(name).trim().slice(0, 60) || 'New playlist', created: Date.now(), tracks: [] };
    this.pls.unshift(p);
    this._savePls();
    return p;
  };

  Store.prototype.renamePlaylist = function (id, name) {
    var p = this.playlist(id);
    if (!p) return;
    p.name = String(name).trim().slice(0, 60) || p.name;
    this._savePls();
  };

  Store.prototype.deletePlaylist = function (id) {
    var i = indexOf(this.pls, id);
    if (i < 0) return;
    this.pls.splice(i, 1);
    this._savePls();
  };

  Store.prototype.inPlaylist = function (pid, trackId) {
    var p = this.playlist(pid);
    return !!p && indexOf(p.tracks, trackId) >= 0;
  };

  // Adds the song if it's missing, removes it if present. Returns true when added.
  Store.prototype.togglePlaylistTrack = function (pid, t) {
    var p = this.playlist(pid);
    if (!p) return false;
    var i = indexOf(p.tracks, t.id);
    if (i >= 0) p.tracks.splice(i, 1);
    else p.tracks.push(slim(t));
    this._savePls();
    return i < 0;
  };

  Store.prototype._savePls = function () {
    write(KEYS.playlists, this.pls);
    this._emit('playlists');
  };

  /* ── listening history (for taste) ── */

  Store.prototype.recordPlay = function (t) {
    if (!t || !t.id) return;
    var i = indexOf(this.hist, t.id);
    if (i >= 0) this.hist.splice(i, 1);
    this.hist.unshift({ id: t.id, artist: t.artist, artistIds: t.artistIds, language: t.language, at: Date.now() });
    if (this.hist.length > HISTORY_MAX) this.hist.length = HISTORY_MAX;
    write(KEYS.history, this.hist);
  };

  Store.prototype.history = function () { return this.hist.slice(); };

  /* ── change events ── */

  Store.prototype.on = function (fn) { this._subs.push(fn); };
  Store.prototype._emit = function (kind) { for (var i = 0; i < this._subs.length; i++) this._subs[i](kind, this); };

  window.SavedStore = Store;
})();

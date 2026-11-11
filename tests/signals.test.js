/* The listening logger against a fake player that behaves like the real one
   (load() resets the position and stops playback before 'track' fires).
   node --test tests/ */
'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');

/* ── a tiny browser: clock, storage, document, window ── */
var clock = { now: new Date(2026, 10, 11, 21, 0, 0).getTime() };
function setupDom() {
  var store = {}, listeners = {};
  global.window = global;
  global.localStorage = {
    getItem: function (k) { return k in store ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  };
  global.document = { hidden: false, addEventListener: function () {} };
  global.addEventListener = function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); };
  global.matchMedia = function () { return { matches: true }; };
  global.setInterval = function () { return 0; };              // ticks are driven by hand
  Date.now = function () { return clock.now; };
  return { store: store, fire: function (ev) { (listeners[ev] || []).forEach(function (f) { f(); }); } };
}
var dom = setupDom();
global.EncoreProfile = require('../js/encore/profile.js');
require(path.join(__dirname, '../js/encore/signals.js'));
var Signals = global.EncoreSignals;

function FakeEngine() { this.track = null; this.playing = false; this.pos = 0; this.volume = 0.5; this.ls = {}; }
FakeEngine.prototype.on = function (ev, fn) { (this.ls[ev] = this.ls[ev] || []).push(fn); };
FakeEngine.prototype.emit = function (ev) { (this.ls[ev] || []).forEach(function (f) { f(); }); };
FakeEngine.prototype.position = function () { return this.pos; };
FakeEngine.prototype.duration = function () { return this.track ? this.track.duration : 0; };
FakeEngine.prototype.load = function (t, autoplay) { this.playing = false; this.pos = 0; this.track = t; this.emit('track'); if (autoplay) this.play(); };
FakeEngine.prototype.play = function () { this.playing = true; this.emit('state'); };
FakeEngine.prototype.pause = function () { this.playing = false; this.emit('state'); };
FakeEngine.prototype.seek = function (t) { this.pos = t; this.emit('seek'); };
FakeEngine.prototype.setVolume = function (v) { this.volume = v; this.emit('volume'); };

function FakeSaved() { this.liked = {}; this.ls = []; this.pls = []; }
FakeSaved.prototype.has = function (id) { return !!this.liked[id]; };
FakeSaved.prototype.on = function (fn) { this.ls.push(fn); };
FakeSaved.prototype.playlists = function () { return this.pls; };
FakeSaved.prototype.toggle = function (t) { this.liked[t.id] = !this.liked[t.id]; this.ls.forEach(function (f) { f('liked'); }); };

function song(id, dur) { return { id: id, title: 'Song ' + id, artist: 'Artist', duration: dur || 200, src: 'https://x/' + id + '_160.mp4' }; }

function rig() {
  var engine = new FakeEngine(), saved = new FakeSaved(), ended = [];
  var sig = new Signals(engine, { saved: saved, onEnd: function (r) { ended.push(r); } });
  // play for s seconds of real time, ticking every 0.5 s like the app
  function play(s) {
    for (var i = 0; i < s * 2; i++) {
      clock.now += 500;
      if (engine.playing) engine.pos = Math.min(engine.duration(), engine.pos + 0.5);
      sig._tick();
    }
  }
  return { engine: engine, saved: saved, sig: sig, ended: ended, play: play };
}

test('a skip: seconds heard, no fake restart when the player switches tracks', function () {
  var r = rig();
  r.engine.load(song('a'), true);
  r.play(14.5);
  r.sig.note('next');
  r.engine.load(song('b'), true);
  var a = r.ended[0];
  assert.equal(a.end, 'next');
  assert.ok(Math.abs(a.heard - 14.5) <= 0.6, 'heard ' + a.heard);
  assert.equal(a.restarts, 0);
  assert.equal(r.sig.current().how, 'next');
});

test('restart, seeking back, and skipping the intro', function () {
  var r = rig();
  r.engine.load(song('a'), true);
  r.play(5);
  r.engine.seek(40); r.play(30);          // jumped past the intro, then stayed
  r.engine.seek(20); r.play(10);          // went back to hear a part again
  r.engine.seek(0); r.play(10);           // back to the start, and kept listening: a loop
  r.sig.note('pick');
  r.engine.load(song('b'), true);
  var a = r.ended[0];
  assert.equal(a.seekFwdEarly, 1);
  assert.equal(a.seekBack, 1);
  assert.equal(a.restarts, 1);
  assert.ok(Math.abs(a.heard - 55) <= 1.5, 'only real listening counts: ' + a.heard);
});

test('double-tap on Previous: the restart is not counted as a loop', function () {
  var r = rig();
  r.engine.load(song('a'), true); r.play(20);
  r.sig.note('next'); r.engine.load(song('b'), true); r.play(12);
  r.engine.seek(0); r.play(1);            // first tap: back to the start of b
  r.sig.note('prev'); r.engine.load(song('a'), true);   // second tap: back to a
  assert.equal(r.ended[1].tid, 'b');
  assert.equal(r.ended[1].restarts, 0);
  assert.equal(r.ended[1].end, 'prev');
});

test('a natural end with auto-advance: the next song is not ended with it', function () {
  var engine = new FakeEngine(), saved = new FakeSaved(), ended = [], sig;
  // like app.js: its 'ended' handler is registered first and loads the next song
  engine.on('ended', function () { sig.note('auto'); engine.load(song('b'), true); });
  sig = new Signals(engine, { saved: saved, onEnd: function (r) { ended.push(r); } });
  engine.load(song('a', 30), true);
  for (var i = 0; i < 60; i++) { clock.now += 500; engine.pos = Math.min(30, engine.pos + 0.5); sig._tick(); }
  engine.playing = false; engine.emit('state'); engine.emit('ended');
  assert.equal(ended.length, 1, 'only the song that ended');
  assert.equal(ended[0].tid, 'a');
  assert.equal(ended[0].end, 'ended');
  assert.equal(sig.current().tid, 'b');
  assert.equal(sig.current().end, undefined);
});

test('pauses are counted; a natural end is not a pause', function () {
  var r = rig();
  r.engine.load(song('a', 60), true);
  r.play(10);
  r.engine.pause(); r.play(3); r.engine.play();
  r.play(50);                              // reaches the end
  r.engine.playing = false; r.engine.emit('state'); r.engine.emit('ended');
  var a = r.ended[0];
  assert.equal(a.end, 'ended');
  assert.equal(a.pauses, 1);
  assert.ok(Math.abs(a.pauseSec - 3) < 0.6, 'pause length ' + a.pauseSec);
  assert.equal(EncoreProfile.reward(a, EncoreProfile.create(clock.now)).completed, true);
});

test('likes and volume changes during the song belong to that play', function () {
  var r = rig(), t = song('a');
  r.engine.load(t, true);
  r.play(20);
  r.saved.toggle(t);
  r.engine.setVolume(0.8);
  r.play(5);
  r.sig.note('next');
  r.engine.load(song('b'), true);
  var a = r.ended[0];
  assert.equal(a.liked, 1);
  assert.equal(a.vol0, 0.5);
  assert.equal(a.volEnd, 0.8);
});

test('sessions: a 30-minute gap starts a new one; a song heard twice in one is a replay', function () {
  var r = rig();
  r.engine.load(song('a'), true); r.play(20);
  r.sig.note('next'); r.engine.load(song('b'), true); r.play(20);
  r.sig.note('prev'); r.engine.load(song('a'), true); r.play(5);
  var s1 = r.ended[0].sess;
  assert.equal(r.sig.current().replay, true, 'going back to a song is a replay');
  r.engine.pause();
  clock.now += 31 * 60e3;
  r.sig.note('pick'); r.engine.load(song('c'), true); r.play(5);
  assert.notEqual(r.sig.current().sess, s1);
  assert.equal(r.sig.current().pos, 0);
});

test('a play left open when the app is killed is finished on the next visit', function () {
  var r = rig();
  r.engine.load(song('z'), true);
  r.play(42);
  dom.fire('pagehide');
  var ended = [];
  new Signals(new FakeEngine(), { saved: new FakeSaved(), onEnd: function (x) { ended.push(x); } });
  return new Promise(function (resolve) {
    setTimeout(function () {
      assert.equal(ended.length, 1);
      assert.equal(ended[0].tid, 'z');
      assert.equal(ended[0].end, 'close');
      assert.ok(Math.abs(ended[0].heard - 42) <= 0.6);
      resolve();
    }, 5);
  });
});

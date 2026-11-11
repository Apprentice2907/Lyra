/* Encore in the interface:
   - an "Up next" line under the artist on Now Playing (tap → the panel)
   - the Encore panel (a bottom sheet): why this song, the mood setting,
     what Encore has learned about you, how the last song was scored, how
     this song sounds, and the controls (smart next, export, reset). */
(function () {
  'use strict';

  var P = window.EncoreProfile;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function init(ctx, encore) {
    var engine = ctx.engine;
    var info = document.querySelector('#playing .info');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'up-next';
    btn.id = 'up-next';
    btn.innerHTML = '<span class="un-k">Up next</span><span class="un-t"></span>';
    info.appendChild(btn);
    var label = btn.querySelector('.un-t'), kind = btn.querySelector('.un-k');
    var panelOpen = false, lastKey = '';

    function render() {
      var nx = ctx.peekNext ? ctx.peekNext() : null, t = engine.track;
      var key, text, k;
      if (!t || t.music) { key = 'none'; }
      else if (nx && nx.t) {
        k = nx.encore ? (nx.back ? 'Next' : 'Up next') : 'Next in list';
        text = nx.t.title + ' · ' + String(nx.t.artist || '').split(/\s*,\s*/)[0];
        key = k + text;
      } else if (encore.settings.smart) {
        k = 'Up next'; text = 'Encore is listening…'; key = 'wait';
      } else key = 'none';
      if (key === lastKey) return;
      lastKey = key;
      btn.hidden = key === 'none';
      if (key === 'none') return;
      kind.textContent = k;
      label.textContent = text;
      btn.setAttribute('aria-label', k + ': ' + text + '. Open Encore');
      btn.classList.toggle('is-encore', !!(nx && nx.encore));
    }

    encore.on(function (kind) {
      render();
      if (panelOpen && (kind === 'up' || kind === 'learned' || kind === 'settings')) refreshPanel();
    });
    engine.on('track', render);
    render();

    btn.addEventListener('click', openPanel);

    /* ───────── the panel ───────── */

    var body = null;

    function openPanel() {
      if (!ctx.openSheet) return;
      ctx.openSheet('Encore', function (b) {
        body = b;
        panelOpen = true;
        b.innerHTML = '<div class="sheet-list enc" id="enc-panel"></div>';
        refreshPanel();
        b.addEventListener('click', onClick);
      }, true);
      var layer = document.getElementById('sheet');
      var obs = new MutationObserver(function () { if (layer.hidden) { panelOpen = false; obs.disconnect(); } });
      obs.observe(layer, { attributes: true, attributeFilter: ['hidden'] });
    }

    function section(title, html) {
      return '<section class="enc-sec"><h3 class="enc-h">' + esc(title) + '</h3>' + html + '</section>';
    }

    function refreshPanel() {
      var el = body && body.querySelector('#enc-panel');
      if (!el) return;
      var html = '', nx = ctx.peekNext ? ctx.peekNext() : null, up = encore.up, t = engine.track;

      // 1. up next and why
      if (nx && nx.t) {
        var why = nx.encore && up && up.t.id === nx.t.id ? up.reasons : [];
        if (!nx.encore) why = ['Next in the list you are playing. Encore picks once it ends.'];
        if (nx.back) why = ['The song you stepped back from.'];
        html += section('Up next',
          '<div class="enc-up"><img alt="" src="' + esc(nx.t.artSmall || nx.t.art || '') + '">' +
          '<div class="enc-up-m"><p class="enc-up-t">' + esc(nx.t.title) + '</p><p class="enc-up-a">' + esc(nx.t.artist) + '</p></div></div>' +
          (why.length ? '<ul class="enc-why">' + why.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>' : '') +
          (nx.encore && up ? '<div class="enc-row"><button class="chip-btn is-primary" type="button" data-act="play">Play now</button>' +
            '<button class="chip-btn" type="button" data-act="not">Not this one</button></div>' : ''));
      } else if (t && !t.music) {
        html += section('Up next', '<p class="enc-p">Encore is choosing from songs that fit this moment…</p>');
      }

      // 2. mood setting
      var mode = encore.settings.mode;
      html += section('After a sad song',
        '<div class="enc-seg" role="radiogroup" aria-label="After a sad song">' +
        [['auto', 'Learn it'], ['match', 'Stay in the mood'], ['lift', 'Lift me up']].map(function (m) {
          return '<button type="button" role="radio" aria-checked="' + (mode === m[0]) + '" class="enc-seg-b' + (mode === m[0] ? ' is-on' : '') + '" data-mode="' + m[0] + '">' + m[1] + '</button>';
        }).join('') + '</div>');

      // 3. what it learned
      var ins = encore.insights();
      html += section('What Encore has learned', '<ul class="enc-list">' + ins.map(function (i) { return '<li>' + esc(i.text) + '</li>'; }).join('') + '</ul>');

      // 4. how the last song was scored (full transparency)
      var L = encore.lastLearn;
      if (L) {
        html += section('Last song', '<p class="enc-p"><b>' + esc(L.title) + '</b> scored ' + (L.r > 0 ? '+' : '') + L.r.toFixed(1) + ': ' +
          esc(L.parts.map(function (p) { return p[0]; }).join(', ')) + '.</p>');
      }

      // 5. how this song sounds
      var f = t && !t.music ? window.EncoreFeatures.describe(t.id) : null;
      if (f) {
        var tempo = f.tempoConf > 0.3 ? Math.round(f.bpm) + ' BPM' : 'free tempo';
        html += section('This song', '<div class="enc-meters">' +
          meter('Energy', f.energy) + meter('Mood', f.valence) + meter('Intensity', f.arousal) + meter('Groove', f.dance) + meter('Acoustic', f.acoustic) +
          '</div><p class="enc-p enc-small">' + esc(tempo + ' · ' + f.key + ' (' + f.camelot + ')' + (f.intro > 4 ? ' · ' + f.intro + ' s intro' : '')) + '</p>');
      } else if (t && !t.music) {
        html += section('This song', '<p class="enc-p enc-small">Listening to how it sounds…</p>');
      }

      // 6. the numbers and the controls
      var s = encore.stats();
      html += '<p class="enc-p enc-small enc-foot">Learned from ' + s.plays + ' play' + (s.plays === 1 ? '' : 's') + ' · ' + s.analysed +
        ' songs analysed. Everything stays on this device.</p>' +
        '<div class="enc-row enc-ctrl">' +
          '<button class="chip-btn" type="button" data-act="smart" aria-pressed="' + encore.settings.smart + '">Smart next: ' + (encore.settings.smart ? 'On' : 'Off') + '</button>' +
          '<button class="chip-btn" type="button" data-act="export">Export data</button>' +
          '<button class="chip-btn" type="button" data-act="reset">Reset</button>' +
        '</div>';
      var keep = el.scrollTop;
      el.innerHTML = html;
      el.scrollTop = keep;
    }

    function meter(name, v) {
      var pct = Math.round((v || 0) * 100);
      return '<div class="enc-m"><span class="enc-m-n">' + name + '</span><span class="enc-m-bar"><i style="width:' + pct + '%"></i></span></div>';
    }

    var resetArmed = 0;
    function onClick(e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.mode) { encore.setSetting('mode', b.dataset.mode); return; }
      var act = b.dataset.act;
      if (act === 'play') {
        if (ctx.playUpNow) ctx.playUpNow();
        if (ctx.closeSheet) ctx.closeSheet();
      } else if (act === 'not') {
        encore.notThis();
      } else if (act === 'smart') {
        encore.setSetting('smart', !encore.settings.smart);
      } else if (act === 'export') {
        var blob = new Blob([JSON.stringify(encore.exportData(), null, 1)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'encore-data-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      } else if (act === 'reset') {
        if (Date.now() - resetArmed < 4000) { encore.reset(); resetArmed = 0; refreshPanel(); return; }
        resetArmed = Date.now();
        b.textContent = 'Tap again to forget everything';
        b.classList.add('is-danger');
      }
    }
  }

  window.EncoreUI = { init: init };
})();

/* Dummy music collection.
   Artwork is generated as monochrome SVG posters (data URIs) to match the
   reference's black / white / grey palette with a single yellow accent.
   `music` describes how the engine synthesises each song. */
(function () {
  'use strict';

  var HEAVY = "'Arial Black','Helvetica Neue',Helvetica,Arial,sans-serif";
  var SANS = "Helvetica,Arial,sans-serif";

  function grain(id, op, freq) {
    return '<filter id="' + id + '" x="0" y="0" width="100%" height="100%">' +
      '<feTurbulence type="fractalNoise" baseFrequency="' + (freq || 0.9) + '" numOctaves="3" stitchTiles="stitch"/>' +
      '<feColorMatrix values=".33 .33 .33 0 0 .33 .33 .33 0 0 .33 .33 .33 0 0 0 0 0 0 1"/></filter>' +
      '</defs><rect width="200" height="200" filter="url(#' + id + ')" opacity="' + op + '"/>';
  }

  function svg(body) {
    var s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="400" height="400">' + body + '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
  }

  /* Each art function returns body markup; the grain helper closes the
     <defs> it is placed inside, so art bodies open <defs> before calling it. */
  var ART = {
    oneWeekLast: function () {
      var dots = '';
      for (var k = 0; k < 7; k++) {
        var x = 37 + k * 21;
        dots += k === 5
          ? '<circle cx="' + x + '" cy="138" r="7" fill="#111"/>'
          : '<circle cx="' + x + '" cy="138" r="6.2" fill="none" stroke="#111" stroke-width="1.6"/>';
      }
      return svg(
        '<rect width="200" height="200" fill="#efede8"/>' +
        '<text x="26" y="116" font-family="' + HEAVY + '" font-weight="900" font-size="94" letter-spacing="-7" fill="#111">07</text>' +
        '<rect x="132" y="44" width="40" height="5" fill="#111"/><rect x="132" y="54" width="28" height="5" fill="#111"/>' +
        dots +
        '<rect x="30" y="156" width="140" height="2.4" fill="#111"/>' +
        '<text x="100" y="172" text-anchor="middle" font-family="' + SANS + '" font-weight="700" font-size="7.5" letter-spacing="2.4" fill="#333">ONE WEEK LAST</text>' +
        '<defs>' + grain('g', 0.1)
      );
    },

    afterglow: function () {
      var rings = [[118, '#1c1c1e'], [97, '#2a2a2d'], [77, '#434347'], [58, '#68686d'], [41, '#9a9a9e'], [26, '#cfcfd2'], [13, '#efe43c']];
      var r = '';
      rings.forEach(function (x) { r += '<circle cx="100" cy="126" r="' + x[0] + '" fill="' + x[1] + '"/>'; });
      return svg(
        '<rect width="200" height="200" fill="#0c0c0d"/>' + r +
        '<rect y="126" width="200" height="74" fill="#0c0c0d"/>' +
        '<rect y="125.4" width="200" height="1.4" fill="#efe43c" opacity=".75"/>' +
        '<rect x="70" y="134" width="60" height="1.6" fill="#9a9a9e" opacity=".5"/>' +
        '<rect x="82" y="141" width="36" height="1.4" fill="#9a9a9e" opacity=".35"/>' +
        '<rect x="90" y="148" width="20" height="1.2" fill="#9a9a9e" opacity=".25"/>' +
        '<text x="100" y="176" text-anchor="middle" font-family="' + SANS + '" font-weight="700" font-size="7" letter-spacing="3" fill="#8a8a8e">AFTERGLOW</text>' +
        '<defs>' + grain('g', 0.16)
      );
    },

    forgotten: function () {
      return svg(
        '<defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9"/></filter></defs>' +
        '<rect width="200" height="200" fill="#f6f6f7"/>' +
        '<ellipse cx="106" cy="132" rx="66" ry="30" fill="#b9bbc0" filter="url(#b)"/>' +
        '<ellipse cx="94" cy="120" rx="44" ry="17" fill="#ebecee" filter="url(#b)"/>' +
        '<text x="100" y="70" text-anchor="middle" font-family="Georgia,serif" font-style="italic" font-size="15" fill="#9c9ea3">forgotten</text>' +
        '<defs>' + grain('g', 0.08)
      );
    },

    dreams: function () {
      return svg(
        '<rect width="200" height="200" fill="#f3f3f3"/>' +
        '<g transform="rotate(-14 100 100)">' +
        '<text x="-30" y="176" font-family="' + HEAVY + '" font-weight="900" font-size="214" letter-spacing="-20" fill="#131313">do</text>' +
        '<rect x="50" y="88" width="108" height="22" rx="11" fill="#2b2b2b"/>' +
        '<text x="104" y="102.4" text-anchor="middle" font-family="' + SANS + '" font-weight="700" font-size="7.4" letter-spacing="1.6" fill="#e9e9e9">IN YOUR DREAMS</text>' +
        '</g>' +
        '<defs>' + grain('g', 0.08)
      );
    },

    horizon: function () {
      return svg(
        '<defs>' +
        '<radialGradient id="bg" cx=".45" cy=".42" r=".72"><stop offset="0" stop-color="#7b7b7b"/><stop offset=".55" stop-color="#3b3b3b"/><stop offset="1" stop-color="#151515"/></radialGradient>' +
        '<filter id="rough"><feTurbulence type="fractalNoise" baseFrequency=".07" numOctaves="2" seed="4"/><feDisplacementMap in="SourceGraphic" scale="5"/></filter>' +
        '<filter id="soft"><feGaussianBlur stdDeviation="1.3"/></filter>' +
        '</defs>' +
        '<rect width="200" height="200" fill="url(#bg)"/>' +
        '<g fill="#cdcdcd" stroke="#cdcdcd" stroke-linecap="round" filter="url(#soft)">' +
        '<ellipse cx="106" cy="50" rx="12" ry="14" stroke="none"/>' +
        '<path d="M97 66C85 90 87 112 99 132h14c10-22 8-46 0-66z" stroke="none"/>' +
        '<path d="M99 74C76 70 58 84 42 104" fill="none" stroke-width="9"/>' +
        '<path d="M113 74c18-12 32-26 42-44" fill="none" stroke-width="9"/>' +
        '<path d="M101 130c-8 20-22 30-40 46" fill="none" stroke-width="12"/>' +
        '<path d="M111 130c10 20 22 38 40 42" fill="none" stroke-width="12"/>' +
        '</g>' +
        '<g fill="#efe43c" font-family="' + HEAVY + '" font-weight="900" filter="url(#rough)">' +
        '<text x="38" y="72" font-size="32" transform="rotate(-16 38 72)">ART</text>' +
        '<text x="76" y="120" font-size="27" font-style="italic" transform="rotate(-26 76 120)">create</text>' +
        '<text x="50" y="162" font-size="21" transform="rotate(-9 50 162)">HORIZON</text>' +
        '</g>' +
        '<defs>' + grain('g', 0.2)
      );
    },

    daylight: function () {
      return svg(
        '<defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="12"/></filter></defs>' +
        '<rect width="200" height="200" fill="#0b0b0c"/>' +
        '<ellipse cx="64" cy="80" rx="64" ry="40" fill="#efefef" opacity=".92" filter="url(#b)" transform="rotate(-28 64 80)"/>' +
        '<ellipse cx="42" cy="136" rx="30" ry="16" fill="#bdbdbd" opacity=".5" filter="url(#b)"/>' +
        '<g transform="translate(118 184) rotate(-74)"><text font-family="' + HEAVY + '" font-weight="900" font-style="italic" font-size="35" letter-spacing="-1.5" fill="#f5f5f5">DAYLIGHT</text></g>' +
        '<g transform="translate(104 70) rotate(-74)"><text font-family="' + HEAVY + '" font-weight="900" font-size="10" fill="#f5f5f5">THE</text></g>' +
        '<g transform="translate(166 146) rotate(-90)"><text font-family="' + SANS + '" font-size="5.4" letter-spacing="1.2" fill="#9a9a9a">KERNIN JOKI · LP</text></g>' +
        '<defs>' + grain('g', 0.2)
      );
    },

    cassette: function () {
      return svg(
        '<defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="7"/></filter></defs>' +
        '<rect width="200" height="200" fill="#f1f1f1"/>' +
        '<ellipse cx="112" cy="124" rx="58" ry="48" fill="#d6c9cc"/>' +
        '<ellipse cx="98" cy="114" rx="30" ry="22" fill="#f3eaec" filter="url(#b)"/>' +
        '<path d="M-10 36C30 6 112-2 172 30c28 18 24 58 6 74-26-20-56-34-86-28-30 6-50 34-54 74-2 20-26 30-48 26z" fill="#111"/>' +
        '<path d="M170 96c18 26 16 64-18 86l48 18V88z" fill="#141414"/>' +
        '<defs>' + grain('g', 0.26, 1.1)
      );
    },

    crimson: function () {
      return svg(
        '<defs>' +
        '<radialGradient id="bg" cx=".55" cy=".45" r=".7"><stop offset="0" stop-color="#d6d6d6"/><stop offset="1" stop-color="#a9a9a9"/></radialGradient>' +
        '<filter id="torn"><feTurbulence type="fractalNoise" baseFrequency=".09" numOctaves="3" seed="9"/><feDisplacementMap in="SourceGraphic" scale="7"/></filter>' +
        '</defs>' +
        '<rect width="200" height="200" fill="url(#bg)"/>' +
        '<g transform="rotate(8 100 100)" filter="url(#torn)">' +
        '<polygon points="64,52 154,46 160,146 70,156" fill="#8f8f8f" opacity=".35" transform="translate(4 6)"/>' +
        '<polygon points="64,52 154,46 160,146 70,156" fill="#ededed"/>' +
        '</g>' +
        '<rect x="136" y="60" width="5" height="46" fill="#a3262e"/>' +
        '<g transform="translate(48 146) rotate(-90)"><text font-family="' + SANS + '" font-weight="700" font-size="7" letter-spacing="2.4" fill="#2a2a2a">CRIMSON</text></g>' +
        '<defs>' + grain('g', 0.16)
      );
    },

    phantom: function () {
      var streaks = '';
      [38, 60, 94, 120, 150, 172].forEach(function (y, i) {
        streaks += '<rect x="0" y="' + y + '" width="200" height="' + (1 + (i % 3)) + '" fill="#fff" opacity=".07"/>';
      });
      return svg(
        '<defs>' +
        '<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9c9c9f"/><stop offset="1" stop-color="#4a4a4e"/></linearGradient>' +
        '<filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>' +
        '</defs>' +
        '<rect width="200" height="200" fill="url(#bg)"/>' + streaks +
        '<g fill="#f4f4f4" opacity=".86" filter="url(#b)">' +
        '<ellipse cx="100" cy="84" rx="24" ry="29"/>' +
        '<path d="M50 210c4-62 26-88 50-90 24 2 46 28 50 90z"/>' +
        '</g>' +
        '<defs>' + grain('g', 0.22)
      );
    },

    static: function () {
      var lines = '';
      for (var y = 2; y < 200; y += 4) lines += '<rect y="' + y + '" width="200" height="1.4" fill="#000" opacity=".12"/>';
      return svg(
        '<defs><filter id="tv" x="0" y="0" width="100%" height="100%">' +
        '<feTurbulence type="fractalNoise" baseFrequency="1.4 .7" numOctaves="1" seed="7"/>' +
        '<feColorMatrix type="saturate" values="0"/>' +
        '<feComponentTransfer><feFuncR type="discrete" tableValues=".1 .35 .6 .85 1"/><feFuncG type="discrete" tableValues=".1 .35 .6 .85 1"/><feFuncB type="discrete" tableValues=".1 .35 .6 .85 1"/><feFuncA type="linear" slope="0" intercept="1"/></feComponentTransfer>' +
        '</filter></defs>' +
        '<rect width="200" height="200" filter="url(#tv)"/>' + lines +
        '<rect y="88" width="200" height="25" fill="#111"/>' +
        '<text x="100" y="105.5" text-anchor="middle" font-family="\'Courier New\',monospace" font-weight="700" font-size="13" letter-spacing="5" fill="#f2f2f2">STATIC</text>'
      );
    }
  };

  window.TRACKS = [
    {
      id: 'one-week-last', title: 'One Week Last', artist: 'Justin Bibber', duration: 169, art: ART.oneWeekLast(),
      music: { seed: 11, bpm: 82, root: 57, mode: 'minor', prog: [0, 5, 2, 6], chordLen: 1, swing: 0.2,
        keys: 'stabs', pad: false, drums: 'boom', bassPat: 'walk', lead: 0.55, tone: 8200, crackle: 0.9 }
    },
    {
      id: 'afterglow', title: 'Afterglow', artist: 'Sato, Lena', duration: 156, art: ART.afterglow(),
      music: { seed: 23, bpm: 76, root: 62, mode: 'dorian', prog: [0, 3], chordLen: 2, swing: 0.24,
        keys: 'stabs', pad: true, drums: 'half', bassPat: 'long', lead: 0.42, tone: 7600, crackle: 1 }
    },
    {
      id: 'forgotten', title: 'Forgotten', artist: 'Nguyen, Shane', duration: 184, art: ART.forgotten(),
      music: { seed: 37, bpm: 70, root: 60, mode: 'minor', prog: [0, 5, 3, 4], chordLen: 1, swing: 0.16,
        keys: 'sustain', pad: true, drums: 'half', bassPat: 'long', lead: 0.36, tone: 6800, crackle: 1.2 }
    },
    {
      id: 'dreams', title: 'Dreams', artist: 'Miles, Esther', duration: 141, art: ART.dreams(),
      music: { seed: 41, bpm: 88, root: 65, mode: 'major', prog: [3, 2, 1, 0], chordLen: 1, swing: 0.22,
        keys: 'arp', pad: true, drums: 'boom', bassPat: 'walk', lead: 0.48, tone: 9000, crackle: 0.8 }
    },
    {
      id: 'horizon', title: 'Horizon', artist: 'Kristin', duration: 178, art: ART.horizon(),
      music: { seed: 53, bpm: 92, root: 64, mode: 'minor', prog: [0, 3, 6, 5], chordLen: 1, swing: 0.12,
        keys: 'stabs', pad: false, drums: 'four', bassPat: 'drive', lead: 0.6, tone: 9800, crackle: 0.6 }
    },
    {
      id: 'day-light', title: 'Day light', artist: 'Kernin Joki', duration: 163, art: ART.daylight(),
      music: { seed: 67, bpm: 84, root: 67, mode: 'major', prog: [0, 4, 5, 3], chordLen: 1, swing: 0.2,
        keys: 'stabs', pad: true, drums: 'boom', bassPat: 'walk', lead: 0.55, tone: 9400, crackle: 0.8 }
    },
    {
      id: 'cassette', title: 'Cassette', artist: 'Black, Marvin', duration: 147, art: ART.cassette(),
      music: { seed: 71, bpm: 80, root: 58, mode: 'minor', prog: [0, 6, 5, 4], chordLen: 1, swing: 0.26,
        keys: 'sustain', pad: false, drums: 'boom', bassPat: 'long', lead: 0.45, tone: 6200, crackle: 1, wow: 9 }
    },
    {
      id: 'crimson', title: 'Crimson', artist: 'Henry, Arthur', duration: 192, art: ART.crimson(),
      music: { seed: 83, bpm: 96, root: 62, mode: 'minor', prog: [0, 0, 5, 6], chordLen: 1, swing: 0.1,
        keys: 'arp', pad: true, drums: 'four', bassPat: 'drive', lead: 0.5, tone: 9200, crackle: 0.6 }
    },
    {
      id: 'phantom', title: 'Phantom', artist: 'Flores, Juanita', duration: 159, art: ART.phantom(),
      music: { seed: 97, bpm: 68, root: 59, mode: 'minor', prog: [0, 2, 5, 4], chordLen: 1, swing: 0.18,
        keys: 'sustain', pad: true, drums: 'half', bassPat: 'long', lead: 0.34, tone: 5600, crackle: 1.1 }
    },
    {
      id: 'static', title: 'Static', artist: 'Rowan, Ivy', duration: 138, art: ART.static(),
      music: { seed: 101, bpm: 90, root: 63, mode: 'dorian', prog: [0, 3, 0, 4], chordLen: 1, swing: 0.14,
        keys: 'stabs', pad: false, drums: 'four', bassPat: 'drive', lead: 0.5, tone: 8600, crackle: 1.5 }
    }
  ];

  /* Track centred on the Explore wheel at start, and the track loaded in the deck. */
  window.TRACKS.initialWheel = 5;   // Day light
  window.TRACKS.initialTrack = 0;   // One Week Last
})();

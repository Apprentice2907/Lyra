/* Runs EncoreDSP.analyze off the main thread.
   in:  { id, samples (Float32Array, transferred), sr }
   out: { id, raw, ms }  or  { id, error } */
importScripts('dsp.js');

self.onmessage = function (e) {
  var m = e.data, t0 = Date.now();
  try {
    var raw = self.EncoreDSP.analyze(m.samples, m.sr);
    self.postMessage({ id: m.id, raw: raw, ms: Date.now() - t0 });
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err && err.message || err) });
  }
};

/* Browser platform layer for the Paksukese Seiklused (Fatman Adventures) port.
 * Provides the FM object used by the wasm imports in src/fm_lib.js. */
'use strict';
var FM = (function () {
  var FM = {};
  var canvas, ctx;
  var manifest = null;
  var surfaces = [];
  var hdrs = {};             // image key -> Uint8Array header
  var surfOf = {};           // image key -> surface id
  var files = {};            // key -> Uint8Array (read-only game data + persisted saves)
  var persistKeys = {};      // keys that are user data (saved to IndexedDB)
  var actx = null, sfxGain = null, musicGain = null, sfxBus = null, musicBus = null;
  var SFX_LEVEL = 1.0, MUSIC_LEVEL = 1.0;   // player's volume settings (1 = the game's own mix); music mix is set in vendor/xm.js
  var sfxBuf = {};           // key -> AudioBuffer
  var slotKey = [];          // slot -> key
  var slotSrc = [];          // slot -> playing source
  var musicData = {};        // key -> ArrayBuffer
  var curMusic = null, musicWanted = false;
  var inputQ = [];
  var frameWaiters = [];

  var mod = null;   // the running engine instance (one per episode build)
  FM.setModule = function (m) { mod = m; };

  /* ---------- clock and pause ---------- */
  // the engine paces itself against this clock; time spent paused is taken out so the game
  // continues exactly where it stopped instead of fast-forwarding to catch up
  var pauseReasons = {}, pausedAt = 0, pausedTotal = 0;
  function isPaused() { for (var k in pauseReasons) return true; return false; }
  FM.nowUs = function () { return ((isPaused() ? pausedAt : performance.now()) - pausedTotal) * 1000; };
  FM.setPaused = function (reason, on) {
    var was = isPaused();
    if (on) pauseReasons[reason] = 1; else delete pauseReasons[reason];
    var now = isPaused();
    // sound keeps playing while the settings are open (so volume changes can be heard),
    // and stops while the page is hidden
    if (actx) {
      if (pauseReasons.hidden && actx.state === 'running') actx.suspend();
      else if (!pauseReasons.hidden && actx.state === 'suspended') actx.resume();
    }
    if (now === was) return;
    if (now) pausedAt = performance.now();
    else { pausedTotal += performance.now() - pausedAt; flushFrames(); }
  };
  FM.isPaused = isPaused;
  function heap32() { return mod.HEAP32; }
  function heapu8() { return mod.HEAPU8; }

  /* ---------- assets: manifest.json, img/*.webp, sfx/*.wav, bundle.json ---------- */
  var dataBins = {};
  function b64(s) {
    var bin = atob(s), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function get(url, type) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
      return type === 'json' ? r.json() : type === 'blob' ? r.blob() : r.arrayBuffer();
    });
  }
  FM.load = function (base, progress) {
    var done = 0, total = 1;
    function tick(x) { done++; if (progress) progress(done / total); return x; }
    return get(base + 'manifest.json', 'json').then(function (m) {
      manifest = m;
      var jobs = [];
      Object.keys(m.images).forEach(function (k) {
        var im = m.images[k];
        hdrs[k] = b64(im.hdr);
        surfOf[k] = im.surf;
        jobs.push(get(base + im.file, 'blob').then(decodeImage).then(function (bmp) { surfaces[im.surf] = bmp; tick(); }));
      });
      Object.keys(m.files).forEach(function (k) {
        var f = m.files[k];
        if (f.indexOf('bundle:') === 0) return;
        jobs.push(get(base + f, 'buf').then(function (b) { files[k] = new Uint8Array(b); tick(); }));
      });
      jobs.push(get(base + 'bundle.json', 'json').then(function (bundle) {
        Object.keys(bundle).forEach(function (k) {
          var d = b64(bundle[k]);
          if (/^data(_e\d)?\.bin$/.test(k)) dataBins[k] = d;
          else if (/\.xm$/.test(k)) musicData[k] = d.buffer;
          else files[k] = d;
        });
        tick();
      }));
      total = jobs.length;
      return Promise.all(jobs);
    }).then(loadSaves);
  };
  function decodeImage(blob) {
    if (window.createImageBitmap) {
      return createImageBitmap(blob, { premultiplyAlpha: 'default' }).catch(function () { return viaImg(blob); });
    }
    return viaImg(blob);
  }
  function viaImg(blob) {
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () { res(img); };
      img.onerror = rej;
      img.src = URL.createObjectURL(blob);
    });
  }
  FM.dataBin = function (name) { return dataBins[name || 'data.bin']; };

  /* ---------- persistence (IndexedDB, falls back to memory) ---------- */
  var DB = 'paksuke-saves', STORE = 'files';
  function idb() {
    return new Promise(function (res, rej) {
      try {
        var r = indexedDB.open(DB, 1);
        r.onupgradeneeded = function () { r.result.createObjectStore(STORE); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      } catch (e) { rej(e); }
    });
  }
  function loadSaves() {
    return idb().then(function (db) {
      return new Promise(function (res) {
        try {
          var tx = db.transaction(STORE, 'readonly');
          var st = tx.objectStore(STORE);
          var req = st.openCursor();
          req.onsuccess = function () {
            var c = req.result;
            if (c) { files[c.key] = rleDecode(new Uint8Array(c.value)); persistKeys[c.key] = 1; c.continue(); }
            else res();
          };
          req.onerror = function () { res(); };
        } catch (e) { res(); }
      });
    }).catch(function () { });
  }
  function persist(key, data) {
    idb().then(function (db) {
      try {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(rleEncode(data).buffer, key);
      } catch (e) { }
    }).catch(function () { });
  }
  // zero-run compression (save files are mostly zeros)
  function rleEncode(d) {
    var n = d.length, out = new Uint8Array(n + 8 + (n >> 6)), o = 4, i = 0;
    out[0] = n & 255; out[1] = (n >> 8) & 255; out[2] = (n >> 16) & 255; out[3] = (n >>> 24) & 255;
    while (i < n) {
      if (d[i] === 0) {
        var j = i; while (j < n && d[j] === 0 && j - i < 0xffffff) j++;
        var r = j - i;
        if (o + 4 > out.length) { var g = new Uint8Array(out.length * 2); g.set(out); out = g; }
        out[o++] = 0; out[o++] = r & 255; out[o++] = (r >> 8) & 255; out[o++] = (r >> 16) & 255; i = j;
      } else {
        if (o + 1 > out.length) { var g2 = new Uint8Array(out.length * 2); g2.set(out); out = g2; }
        out[o++] = d[i++];
      }
    }
    return out.slice(0, o);
  }
  function rleDecode(e) {
    var n = e[0] | (e[1] << 8) | (e[2] << 16) | (e[3] << 24);
    var d = new Uint8Array(n), i = 4, o = 0;
    while (i < e.length && o < n) {
      if (e[i] === 0) { var r = e[i + 1] | (e[i + 2] << 8) | (e[i + 3] << 16); o += r; i += 4; }
      else d[o++] = e[i++];
    }
    return d;
  }

  /* ---------- rendering ---------- */
  FM.attachCanvas = function (c) {
    canvas = c;
    ctx = c.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
  };
  FM.render = function (base, layers, slots) {
    var H = heap32();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 640, 480);
    for (var l = 0; l < layers; l++) {
      var p = (base + l * 0x12c40) >> 2;
      for (var s = 0; s < slots; s++, p += 16) {
        var st = H[p];
        if (st === 0) break;
        if (st !== 1) continue;
        var sx = H[p + 1], sy = H[p + 2], w = H[p + 3], h = H[p + 4];
        var srcx = H[p + 5], srcy = H[p + 6], p8 = H[p + 7], blend = H[p + 10], surf = H[p + 11];
        var img = surfaces[surf];
        if (!img || w <= 0 || h <= 0) continue;
        // clip source to the sheet (drawImage rejects out-of-range rects in some browsers)
        if (srcx < 0) { sx -= srcx; w += srcx; srcx = 0; }
        if (srcy < 0) { sy -= srcy; h += srcy; srcy = 0; }
        if (srcx + w > img.width) w = img.width - srcx;
        if (srcy + h > img.height) h = img.height - srcy;
        if (w <= 0 || h <= 0) continue;
        if (blend === 3) {
          var a = (255 - (p8 & 255)) / 255;
          if (a <= 0) continue;
          ctx.globalAlpha = a;
          ctx.drawImage(img, srcx, srcy, w, h, sx, sy, w, h);
          ctx.globalAlpha = 1;
        } else {
          ctx.drawImage(img, srcx, srcy, w, h, sx, sy, w, h);
        }
      }
    }
  };
  var frameQueued = false;
  function flushFrames() {
    if (frameQueued || !frameWaiters.length || isPaused()) return;
    frameQueued = true;
    var go = function () {
      frameQueued = false;
      if (isPaused()) return;          // resumed later by setPaused
      var w = frameWaiters; frameWaiters = []; w.forEach(function (f) { f(); });
    };
    if (document.hidden) setTimeout(go, 50); else requestAnimationFrame(go);
  }
  FM.waitFrame = function (wake) {
    frameWaiters.push(wake);
    flushFrames();
  };

  /* ---------- images ---------- */
  FM.imgHeader = function (key, dst, cap) {
    var h = hdrs[key];
    if (!h) return -1;
    var n = Math.min(h.length, cap);
    heapu8().set(h.subarray(0, n), dst);
    return n;
  };
  FM.imgSurf = function (key) { return surfOf[key] !== undefined ? surfOf[key] : -1; };

  /* ---------- audio ---------- */
  function ensureAudio() {
    if (actx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    actx = new AC();
    sfxBus = actx.createGain(); sfxBus.gain.value = curve(SFX_LEVEL); sfxBus.connect(actx.destination);
    musicBus = actx.createGain(); musicBus.gain.value = curve(MUSIC_LEVEL); musicBus.connect(actx.destination);
    sfxGain = actx.createGain(); sfxGain.connect(sfxBus);
    musicGain = actx.createGain(); musicGain.connect(musicBus);
    if (FM._sfxcb !== undefined) FM.sfxVolume(FM._sfxcb);
    if (FM._muscb !== undefined) FM.musicVolume(FM._muscb);
    if (window.XMPlayer) {
      XMPlayer.audioctx = actx;
      XMPlayer.output = musicGain;
      XMPlayer.init();
    }
    Object.keys(files).forEach(function (k) {
      if (/\.wav$/.test(k)) decodeSfx(k);
    });
  }
  function decodeSfx(k) {
    if (sfxBuf[k] !== undefined) return;
    sfxBuf[k] = null;
    var data = files[k].slice().buffer;
    try {
      var pr = actx.decodeAudioData(data, function (b) { sfxBuf[k] = b; }, function () { });
      if (pr && pr.catch) pr.catch(function () { });
    } catch (e) { }
  }
  // slider position 0..1 -> gain; squared so the middle of the slider sounds like half volume
  function curve(v) { v = Math.max(0, Math.min(1, v)); return v * v; }
  FM.setVolumes = function (music, sfx) {
    MUSIC_LEVEL = music; SFX_LEVEL = sfx;
    if (musicBus) musicBus.gain.setTargetAtTime(curve(music), actx.currentTime, 0.03);
    if (sfxBus) sfxBus.gain.setTargetAtTime(curve(sfx), actx.currentTime, 0.03);
  };
  // a short effect at the current level, for the settings panel
  FM.previewSfx = function () {
    FM.unlockAudio();
    if (!actx) return;
    var key = slotKey[0x32] || Object.keys(sfxBuf).filter(function (k) { return sfxBuf[k]; })[0];
    var buf = key && sfxBuf[key];
    if (!buf) return;
    var src = actx.createBufferSource();
    src.buffer = buf; src.connect(sfxGain || sfxBus); src.start();
  };
  var musicStarted = false;   // the current track is playing (don't restart it on later taps)
  FM.unlockAudio = function () {
    var first = !actx;
    ensureAudio();
    if (actx && actx.state === 'suspended' && !pauseReasons.hidden) actx.resume();
    // only start a track that was requested before audio was available
    if (first && musicWanted && curMusic && !musicStarted) FM.musicPlay();
  };
  FM.sfxLoad = function (key, slot) { slotKey[slot] = key; return files[key] ? 1 : 0; };
  FM.sfxPlay = function (slot, pan) {
    if (!actx) return;
    var key = slotKey[slot];
    var buf = key && sfxBuf[key];
    if (!buf) return;
    var old = slotSrc[slot];
    if (old) { try { old.stop(); } catch (e) { } }
    var src = actx.createBufferSource();
    src.buffer = buf;
    var node = src;
    if (pan && actx.createStereoPanner) {
      var att = Math.pow(10, -Math.abs(pan) / 2000);
      var pn = actx.createStereoPanner();
      pn.pan.value = (pan < 0 ? -1 : 1) * (1 - att);
      src.connect(pn); node = pn;
    }
    node.connect(sfxGain);
    src.start();
    slotSrc[slot] = src;
    src.onended = function () { if (slotSrc[slot] === src) slotSrc[slot] = null; };
  };
  FM.sfxStop = function (slot) {
    var s = slotSrc[slot];
    if (s) { try { s.stop(); } catch (e) { } slotSrc[slot] = null; }
  };
  FM.sfxVolume = function (cb) { if (sfxGain) sfxGain.gain.value = cb <= -10000 ? 0 : Math.pow(10, cb / 2000); FM._sfxcb = cb; };
  FM.musicVolume = function (cb) { if (musicGain) musicGain.gain.value = cb <= -10000 ? 0 : Math.pow(10, cb / 2000); FM._muscb = cb; };
  FM.musicLoad = function (key) {
    curMusic = key; musicWanted = false; musicStarted = false;
    if (window.XMPlayer && actx) { try { XMPlayer.stop(); } catch (e) { } }
  };
  FM.musicPlay = function () {
    musicWanted = true;
    if (musicStarted) return;
    if (!actx || !window.XMPlayer || !curMusic || !musicData[curMusic]) return;
    try {
      XMPlayer.stop();
      if (XMPlayer.load(musicData[curMusic].slice(0))) { XMPlayer.play(); musicStarted = true; }
    } catch (e) { console.warn('music', e); }
  };
  FM.musicStop = function () {
    musicWanted = false; musicStarted = false;
    if (window.XMPlayer && actx) { try { XMPlayer.stop(); } catch (e) { } }
  };

  /* ---------- files ---------- */
  FM.fileSize = function (key) { var f = files[key]; return f ? f.length : -1; };
  FM.fileRead = function (key, dst, cap) {
    var f = files[key]; if (!f) return -1;
    var n = Math.min(f.length, cap);
    heapu8().set(f.subarray(0, n), dst);
    return n;
  };
  FM.fileWrite = function (key, src, len) {
    var d = heapu8().slice(src, src + len);
    files[key] = d; persistKeys[key] = 1;
    persist(key, d);
  };

  /* ---------- input ---------- */
  FM.key = function (vk, down) { inputQ.push((vk & 255) | (down ? 256 : 0)); };
  FM.inputNext = function () { return inputQ.length ? inputQ.shift() : -1; };
  FM.quit = function () { stopAll(); if (FM.onQuit) FM.onQuit(); };

  /* ---------- name entry: tells the page when a name-entry screen has the keyboard ---------- */
  FM.textMode = function (on) { FM.textActive = !!on; if (FM.onTextMode) FM.onTextMode(!!on); };

  /* ---------- leaving an episode: drop the engine and silence it ---------- */
  function stopAll() {
    if (window.XMPlayer && actx) { try { XMPlayer.stop(); } catch (e) { } }
    musicWanted = false; musicStarted = false; curMusic = null;
    for (var i = 0; i < slotSrc.length; i++) FM.sfxStop(i);
    inputQ = [];
  }
  FM.abandon = function () {
    stopAll();
    frameWaiters = []; mod = null;   // the old engine stays suspended and is garbage collected
    slotKey = []; FM._sfxcb = undefined; FM._muscb = undefined;
    if (sfxGain) sfxGain.gain.value = 1;
    if (musicGain) musicGain.gain.value = 1;
    FM.textMode(0);
  };

  return FM;
})();

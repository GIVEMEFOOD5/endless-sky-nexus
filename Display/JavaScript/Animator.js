// Plays Endless Sky sprites on a canvas the way the game does (frame rate, blend modes, ping-pong …).

'use strict';

// Blend mode constants
const ES_BLEND = Object.freeze({
  ALPHA:         'alpha',
  ADDITIVE:      'additive',
  HALF_ADDITIVE: 'half',
  PREMULTIPLIED: 'premul',
});

// Separator char -> blend mode
const _SEP_BLEND = {
  '-': ES_BLEND.ALPHA,
  '+': ES_BLEND.ADDITIVE,
  '^': ES_BLEND.HALF_ADDITIVE,
  '~': ES_BLEND.HALF_ADDITIVE,   // deprecated alias (pre-0.10.9)
  '=': ES_BLEND.PREMULTIPLIED,
};


class EndlessSkyAnimator {
  // draws onto this canvas
  constructor(canvas) {
    this._canvas = canvas;
    this._ctx    = canvas.getContext('2d');

    this._frames = [];           // Array<ImageBitmap>
    this._blend  = ES_BLEND.ALPHA;

    // Sprite params
    this._spf         = 0.5;    // seconds per frame
    this._delay       = 0;      // ticks between loops
    this._noRepeat    = false;
    this._rewind      = false;
    this._scale       = 1.0;
    this._startFrame  = 0;
    this._randomStart = false;

    // Playback state
    this._framePos   = 0.0;
    this._direction  = 1;       // +1 forward, -1 backward
    this._delayTicks = 0.0;
    this._finished   = false;
    this._playing    = false;
    this._rafId      = null;
    this._lastTs     = null;

    this._objectUrls = [];
  }

  // Public: load 

  // load frames from findImageVariations (blend mode from the file names)
  async loadVariations(variations, params) {
    params = params || {};
    if (!variations || !variations.length) {
      this._emit('es:error', 'no variations provided');
      return;
    }

    const blend  = _blendFromVariations(variations);
    const sorted = _sortVariations(variations);

    // Revoke any previous object URLs
    this._revokeUrls();

    const urls = sorted.map(function(v) {
      const u = URL.createObjectURL(v.blob);
      this._objectUrls.push(u);
      return u;
    }, this);

    const images = await _loadImages(urls);
    await this._prepareFrames(images, blend, params);
  }

  // load ready-made images
  async loadFrames(images, params) {
    params = params || {};
    const blend = params.blendMode || ES_BLEND.ALPHA;
    await this._prepareFrames(images, blend, params);
  }

  // play / pause / stop

  play() {
    if (!this._frames.length || this._playing) return;
    this._playing  = true;
    this._finished = false;
    this._lastTs   = null;
    this._rafId    = requestAnimationFrame(this._tick.bind(this));
  }

  pause() {
    this._playing = false;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  stop() {
    this.pause();
    this._resetState();
    this._draw();
  }

  dispose() {
    this.pause();
    this._frames.forEach(function(f) { if (f && f.close) f.close(); });
    this._frames = [];
    this._revokeUrls();
  }

  // get frames ready to draw

  async _prepareFrames(images, blend, params) {
    // Close previous bitmaps
    this._frames.forEach(function(f) { if (f && f.close) f.close(); });
    this._frames = [];
    this._blend  = blend;
    this._applyParams(params);

    for (let i = 0; i < images.length; i++) {
      const bmp = await _bakeFrame(images[i], blend);
      if (bmp) this._frames.push(bmp);
    }

    if (!this._frames.length) {
      this._emit('es:error', 'no frames could be processed');
      return;
    }

    this._fitCanvas();
    this._resetState();
    this._draw();
    this._emit('es:ready', { frameCount: this._frames.length, blend: blend });
  }

  _applyParams(p) {
    if (p.frameTime != null) {
      this._spf = p.frameTime / 60;
    } else {
      const fps = (p.frameRate != null) ? p.frameRate : 2;
      this._spf = fps > 0 ? 1 / fps : Infinity;
    }
    this._delay       = p.delay       || 0;
    this._noRepeat    = p.noRepeat    || false;
    this._rewind      = p.rewind      || false;
    this._scale       = (p.scale != null) ? p.scale : 1.0;
    this._startFrame  = p.startFrame  || 0;
    this._randomStart = p.randomStart || false;
  }

  _tick(ts) {
    if (!this._playing) return;
    if (this._lastTs === null) this._lastTs = ts;

    const dt = (ts - this._lastTs) / 1000;
    this._lastTs = ts;

    this._advance(dt);
    this._draw();

    if (this._playing) {
      this._rafId = requestAnimationFrame(this._tick.bind(this));
    }
  }

  _advance(dt) {
    if (this._finished) return;

    const n = this._frames.length;
    if (n <= 1) return;

    // Consume inter-loop delay (delay is in ticks = 1/60 s)
    if (this._delayTicks > 0) {
      this._delayTicks -= dt * 60;
      if (this._delayTicks > 0) return;
      this._delayTicks = 0;
    }

    this._framePos += (dt / this._spf) * this._direction;

    if (this._direction > 0) {
      if (this._framePos >= n) {
        if (this._rewind) {
          // Reflect off end: overshoot becomes reverse distance from last frame
          this._framePos  = (n - 1) - (this._framePos - n);
          this._direction = -1;
        } else if (this._noRepeat) {
          this._framePos = n - 1;
          this._finish();
        } else {
          // Loop: wrap; ES tweens last->first across the boundary
          this._framePos = this._framePos % n;
          if (this._delay > 0) this._delayTicks = this._delay;
        }
      }
    } else {
      if (this._framePos <= 0) {
        if (this._noRepeat) {
          this._framePos = 0;
          this._finish();
        } else {
          // Reflect off start
          this._framePos  = Math.abs(this._framePos);
          this._direction = 1;
          if (this._delay > 0) this._delayTicks = this._delay;
        }
      }
    }
  }

  _finish() {
    this._finished = true;
    this.pause();
    this._emit('es:done', null);
  }

  _draw() {
    const n = this._frames.length;
    if (!n) return;

    const ctx = this._ctx;
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);

    if (n === 1) {
      this._blitFrame(this._frames[0], 1.0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      return;
    }

    // Float frame position -> two-frame tween
    const pos  = Math.max(0, Math.min(this._framePos, n - 0.0001));
    const base = Math.floor(pos);
    const frac = pos - base;
    // Wrap next for loop tween across last->first
    const next = (base + 1) % n;

    if (frac < 0.0001) {
      this._blitFrame(this._frames[base], 1.0);
    } else {
      this._blitFrame(this._frames[base], 1.0 - frac);
      this._blitFrame(this._frames[next], frac);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  _blitFrame(bitmap, weight) {
    if (!bitmap) return;
    const ctx = this._ctx;
    const sw  = bitmap.width  * this._scale;
    const sh  = bitmap.height * this._scale;
    const dx  = (this._canvas.width  - sw) / 2;
    const dy  = (this._canvas.height - sh) / 2;

    ctx.globalAlpha = weight;
    // how each blend mode adds onto the background
    ctx.globalCompositeOperation =
      this._blend === ES_BLEND.ADDITIVE ? 'lighter' : 'source-over';

    ctx.drawImage(bitmap, dx, dy, sw, sh);
  }

  _resetState() {
    const n = this._frames.length;
    this._finished   = false;
    this._direction  = 1;
    this._delayTicks = 0;
    if (this._randomStart && n > 0) {
      this._framePos = Math.random() * (n - 1);
    } else {
      this._framePos = Math.min(this._startFrame, Math.max(0, n - 1));
    }
  }

  _fitCanvas() {
    if (!this._frames.length || this._canvas.dataset.fixedSize) return;
    const f = this._frames[0];
    this._canvas.width  = Math.round(f.width  * this._scale);
    this._canvas.height = Math.round(f.height * this._scale);
  }

  _revokeUrls() {
    this._objectUrls.forEach(function(u) { URL.revokeObjectURL(u); });
    this._objectUrls = [];
  }

  _emit(type, detail) {
    this._canvas.dispatchEvent(new CustomEvent(type, { bubbles: true, detail: detail }));
  }
}


// bake the blend mode into the pixels (as the game's loader does)
async function _bakeFrame(img, blend) {
  try {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;

    // Fast paths: no pixel manipulation needed
    if (blend !== ES_BLEND.HALF_ADDITIVE) {
      return await createImageBitmap(img);
    }

    // HALF_ADDITIVE: halve alpha channel
    const oc  = new OffscreenCanvas(w, h);
    const oct = oc.getContext('2d', { willReadFrequently: true });
    oct.drawImage(img, 0, 0);

    const idata = oct.getImageData(0, 0, w, h);
    const px    = idata.data;  // un-premultiplied RGBA bytes

    for (let i = 3; i < px.length; i += 4) {
      px[i] = px[i] >> 1;      // alpha / 2
    }

    oct.putImageData(idata, 0, 0);
    return await createImageBitmap(oc);

  } catch (err) {
    console.warn('EndlessSkyAnimator _bakeFrame:', err);
    return null;
  }
}


// blend mode from the file names

function _blendFromVariations(variations) {
  for (let i = 0; i < variations.length; i++) {
    const sep = variations[i].variation && variations[i].variation[0];
    if (sep && _SEP_BLEND[sep]) return _SEP_BLEND[sep];
  }
  return ES_BLEND.ALPHA;
}

// frames in order
function _sortVariations(variations) {
  return variations.slice().sort(function(a, b) {
    const na = parseInt(a.variation.replace(/\D/g, ''), 10);
    const nb = parseInt(b.variation.replace(/\D/g, ''), 10);
    if (isNaN(na) && isNaN(nb)) return 0;
    if (isNaN(na)) return -1;
    if (isNaN(nb)) return  1;
    return na - nb;
  });
}

// load images
function _loadImages(urls) {
  return Promise.all(
    urls.map(function(src) {
      return new Promise(function(resolve) {
        const img = new Image();
        img.onload  = function() { resolve(img); };
        img.onerror = function() {
          console.warn('EndlessSkyAnimator: could not load', src);
          resolve(null);
        };
        img.src = src;
      });
    })
  ).then(function(imgs) { return imgs.filter(Boolean); });
}


// Globals 
window.EndlessSkyAnimator = EndlessSkyAnimator;
window.ES_BLEND           = ES_BLEND;

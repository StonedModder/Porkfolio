// ── System View ───────────────────────────────────────────────────────────────
let _svGifWorker = null;
let _svGifJobId = 0;
let _svGifSavePath = '';
let _svVidWriteQueue = Promise.resolve();
const SV_GIF_MAX_WIDTH = 480;
const SV_GIF_MAX_COLORS = 128;
const SV_GIF_MAX_FPS = 8;

async function loadSystemView(options = {}) {
  const passive = !!options.passive;
  if (window.pork.isWebMode) {
    if (!passive) await _loadSystemViewWeb();
    return;
  }
  $('sv-status-codec').textContent = svDetectCodec().label;
  if (!passive) await enumerateSvDevices();
  let autoLoad = false;
  // Restore all persisted system-view settings
  try {
    const s = await window.pork.getSettings();
    if (s.svResolution) $('sv-resolution').value = s.svResolution;
    if (s.svGifFps)     $('sv-gif-fps').value     = s.svGifFps;
    if (s.svVidQuality) $('sv-vid-quality').value  = s.svVidQuality;
    if (s.svHotkeys)    _svHotkeys = { ..._svHotkeys, ...s.svHotkeys };
    autoLoad = !!s.svAutoLoad;
    $('sv-auto-load').checked = autoLoad;
    // Restore saved device selections only if nothing is currently selected
    if (!passive) {
      const videoSel = $('sv-video-device');
      const audioSel = $('sv-audio-device');
      if (!videoSel.value && s.svVideoDevice &&
          [...videoSel.options].some(o => o.value === s.svVideoDevice)) {
        videoSel.value = s.svVideoDevice;
      }
      if (!audioSel.value && s.svAudioDevice &&
          [...audioSel.options].some(o => o.value === s.svAudioDevice)) {
        audioSel.value = s.svAudioDevice;
      }
    }
  } catch (_) {}
  if (!$('sv-gif-fps').value) $('sv-gif-fps').value = '8';
  if (!$('sv-vid-quality').value) $('sv-vid-quality').value = '8000000';
  // Re-attach existing stream if still active (user navigated away and back)
  if (_svStream && !_svStream.active) _svStream = null;
  if (_svStream) {
    // Re-attach video-only (AudioContext keeps running independently)
    $('sv-video').srcObject = new MediaStream(_svStream.getVideoTracks());
    $('sv-video').muted = true;
    $('sv-no-signal').classList.add('hidden');
    $('btn-sv-mute').disabled    = false;
    $('btn-sv-popout').disabled  = false;
    $('btn-sv-record').disabled  = false;
    $('btn-sv-vid-rec').disabled = false;
    $('sv-ctx-popout').disabled  = false;
    updateSvMuteBtn();
    svSetLive($('sv-video-device').selectedOptions[0]?.text || '');
  } else if (!passive && autoLoad && $('sv-video-device').value) {
    // Auto-start stream only when the user explicitly enabled it
    await startSvStream();
  }
}

async function enumerateSvDevices() {
  let devices;
  try {
    // A brief getUserMedia call is needed to unlock device labels in some browsers
    if (!_svStream) {
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        tmp.getTracks().forEach(t => t.stop());
      } catch (_) {}
    }
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (e) {
    console.error('enumerateDevices failed:', e);
    return;
  }

  const prevVideo = $('sv-video-device').value;
  const prevAudio = $('sv-audio-device').value;

  // Video
  const videoSel = $('sv-video-device');
  while (videoSel.options.length > 1) videoSel.remove(1);
  devices.filter(d => d.kind === 'videoinput').forEach(d => {
    videoSel.add(new Option(d.label || `Camera ${d.deviceId.slice(0,8)}`, d.deviceId));
  });

  // Audio
  const audioSel = $('sv-audio-device');
  while (audioSel.options.length > 1) audioSel.remove(1);
  devices.filter(d => d.kind === 'audioinput').forEach(d => {
    audioSel.add(new Option(d.label || `Mic ${d.deviceId.slice(0,8)}`, d.deviceId));
  });

  // Restore previous selection if device still present
  if (prevVideo && [...videoSel.options].some(o => o.value === prevVideo)) videoSel.value = prevVideo;
  if (prevAudio && [...audioSel.options].some(o => o.value === prevAudio)) audioSel.value = prevAudio;
}

function _svAudioStop() {
  if (_svAudioCtx) { _svAudioCtx.close().catch(() => {}); _svAudioCtx = null; }
  _svAudioGain = null;
}

// ── System View — stream relay (web UI forwarding) ────────────────────────────
let _relayWs        = null;
let _relayRecorder  = null;
let _relayRequested = false;
let _webViewerWs    = null; // browser-side viewer WS

const _RELAY_CODECS = [
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8',
  'video/webm',
];

async function startSvRelay() {
  if (_relayWs || !_svStream || !_svStream.active) return;
  try {
    const status = await window.pork.webuiStatus();
    if (!status.running) return;

    const mimeType = _RELAY_CODECS.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';

    _relayWs = new WebSocket(`ws://localhost:${status.port}/sv-stream?role=encoder`);

    _relayWs.onopen = () => {
      _relayWs.send(JSON.stringify({ type: 'meta', mimeType }));

      _relayRecorder = new MediaRecorder(_svStream, {
        mimeType,
        videoBitsPerSecond: 4_000_000,
      });
      _relayRecorder.ondataavailable = async (e) => {
        if (e.data.size === 0 || !_relayWs || _relayWs.readyState !== WebSocket.OPEN) return;
        try {
          const buf = await e.data.arrayBuffer();
          if (_relayWs && _relayWs.readyState === WebSocket.OPEN) _relayWs.send(buf);
        } catch (_) {}
      };
      _relayRecorder.start(500);
    };

    _relayWs.onclose = () => {
      if (_relayRecorder && _relayRecorder.state !== 'inactive') {
        try { _relayRecorder.stop(); } catch (_) {}
      }
      _relayRecorder = null;
      _relayWs = null;
    };
    _relayWs.onerror = () => { try { _relayWs.close(); } catch (_) {} };
  } catch (e) {
    console.error('[SvRelay] Failed to start:', e);
  }
}

function stopSvRelay() {
  if (_relayRecorder && _relayRecorder.state !== 'inactive') {
    try { _relayRecorder.stop(); } catch (_) {}
  }
  _relayRecorder = null;
  if (_relayWs) { try { _relayWs.close(); } catch (_) {} _relayWs = null; }
}

window.pork.on('sv:relay:request', ({ active }) => {
  _relayRequested = active;
  if (active && _svStream && _svStream.active) {
    startSvRelay().catch(() => {});
  } else if (!active) {
    stopSvRelay();
  }
});

// ── System View — web-mode viewer ─────────────────────────────────────────────
async function _loadSystemViewWeb() {
  // Hide desktop-only controls
  const deviceBar = document.querySelector('.sv-device-bar');
  if (deviceBar) deviceBar.hidden = true;
  ['btn-sv-refresh-devices', 'btn-sv-mute', 'btn-sv-popout', 'btn-sv-record',
   'sv-gif-fps', 'btn-sv-vid-rec', 'sv-vid-quality',
   'btn-sv-vid-pause', 'btn-sv-vid-stop', 'sv-rec-status', 'sv-vid-rec-status',
  ].forEach(id => { const el = $(id); if (el) el.hidden = true; });

  const video      = $('sv-video');
  const noSignal   = $('sv-no-signal');
  const noSignalMsg = $('sv-no-signal-msg');

  noSignalMsg.textContent = 'Connecting to host stream…';
  noSignal.classList.remove('hidden');
  svSetIdle('Connecting…');

  // Close previous viewer WS if navigated away and back
  if (_webViewerWs) { try { _webViewerWs.close(); } catch (_) {} _webViewerWs = null; }
  if (video.src && video.src.startsWith('blob:')) URL.revokeObjectURL(video.src);
  video.srcObject = null;
  video.src = '';

  let mimeType      = 'video/webm;codecs=vp8,opus';
  let ms            = null;
  let sourceBuffer  = null;
  let pendingChunks = [];
  let initialized   = false;

  function _appendNext() {
    if (!sourceBuffer || sourceBuffer.updating || !pendingChunks.length) return;
    try { sourceBuffer.appendBuffer(pendingChunks.shift()); } catch (_) { pendingChunks = []; }
  }

  function _trimBuffer() {
    if (!sourceBuffer || sourceBuffer.updating || !sourceBuffer.buffered.length) return;
    const start = sourceBuffer.buffered.start(0);
    const cur   = video.currentTime;
    if (cur - start > 30) {
      try { sourceBuffer.remove(start, cur - 10); } catch (_) {}
    }
  }

  const ws = new WebSocket(`ws://${location.host}/sv-stream?role=viewer`);
  ws.binaryType = 'arraybuffer';
  _webViewerWs = ws;

  ws.onopen = () => {
    noSignalMsg.textContent = 'Waiting for stream — start System View in the desktop app first';
  };

  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'meta' && msg.mimeType) mimeType = msg.mimeType;
        if (msg.type === 'no-stream') {
          noSignalMsg.textContent = 'No stream active — open System View in the desktop app to begin';
          noSignal.classList.remove('hidden');
          svSetIdle('No stream from host');
        }
      } catch (_) {}
      return;
    }

    // First binary chunk — init MediaSource
    if (!initialized) {
      initialized = true;
      ms = new MediaSource();
      const blobUrl = URL.createObjectURL(ms);
      video.src = blobUrl;
      ms.addEventListener('sourceopen', () => {
        URL.revokeObjectURL(blobUrl);
        try {
          sourceBuffer = ms.addSourceBuffer(mimeType);
          sourceBuffer.mode = 'sequence';
          sourceBuffer.addEventListener('updateend', () => { _appendNext(); _trimBuffer(); });
          pendingChunks.push(new Uint8Array(e.data));
          _appendNext();
          noSignal.classList.add('hidden');
          svSetLive('Host capture card');
        } catch (err) {
          noSignalMsg.textContent = `Stream error: ${err.message}`;
        }
      }, { once: true });
    } else {
      pendingChunks.push(new Uint8Array(e.data));
      _appendNext();
    }
  };

  ws.onclose = () => {
    _webViewerWs = null;
    svSetIdle('Stream disconnected');
    noSignalMsg.textContent = 'Stream disconnected — reconnecting…';
    noSignal.classList.remove('hidden');
    // Reconnect if still on this page
    setTimeout(() => {
      if (document.querySelector('#page-system-view.active')) _loadSystemViewWeb();
    }, 3000);
  };
}

async function startSvStream() {
  if (_svRecording) stopSvRecording();
  stopSvRelay();
  if (_svStream) { _svStream.getTracks().forEach(t => t.stop()); _svStream = null; }
  _svAudioStop();
  $('sv-video').srcObject = null;

  const videoId = $('sv-video-device').value;
  if (!videoId) {
    $('sv-no-signal-msg').textContent = 'Select a video source above to begin';
    $('sv-no-signal').classList.remove('hidden');
    $('btn-sv-mute').disabled    = true;
    $('btn-sv-popout').disabled  = true;
    $('btn-sv-record').disabled  = true;
    $('btn-sv-vid-rec').disabled = true;
    $('sv-ctx-popout').disabled  = true;
    svSetIdle('No device selected');
    return;
  }

  $('sv-no-signal-msg').textContent = 'Starting stream…';

  const audioId = $('sv-audio-device').value;
  const res = $('sv-resolution').value; // "1920x1080" or ""
  const [rW, rH] = res ? res.split('x').map(Number) : [];

  const _buildConstraints = (exactRes) => {
    const vc = { deviceId: { exact: videoId } };
    if (rW) {
      vc.width  = exactRes ? { exact: rW } : { ideal: rW };
      vc.height = exactRes ? { exact: rH } : { ideal: rH };
    }
    return {
      video: vc,
      audio: audioId ? {
        deviceId:         { exact: audioId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
        channelCount:     2,
      } : false,
    };
  };

  try {
    // First try exact resolution; fall back to ideal if the device can't match
    try {
      _svStream = await navigator.mediaDevices.getUserMedia(_buildConstraints(true));
    } catch (exactErr) {
      if (rW && exactErr.name === 'OverconstrainedError') {
        console.warn(`[SysView] Exact ${rW}×${rH} not supported, falling back to ideal`);
        _svStream = await navigator.mediaDevices.getUserMedia(_buildConstraints(false));
      } else {
        throw exactErr;
      }
    }

    // Feed only video tracks to the video element.  Chromium syncs audio
    // to the video element's clock, which introduces ~150-300 ms of buffering.
    // Routing audio separately via AudioContext (latencyHint:'interactive')
    // drops that to ~20-40 ms and eliminates the choppiness.
    $('sv-video').srcObject = new MediaStream(_svStream.getVideoTracks());
    $('sv-video').muted = true; // always; audio is handled by AudioContext below

    const audioTracks = _svStream.getAudioTracks();
    if (audioId && audioTracks.length) {
      _svAudioCtx  = new AudioContext({ latencyHint: 'interactive' });
      _svAudioGain = _svAudioCtx.createGain();
      _svAudioGain.gain.value = _svMuted ? 0 : 1;
      _svAudioCtx.createMediaStreamSource(new MediaStream(audioTracks))
        .connect(_svAudioGain)
        .connect(_svAudioCtx.destination);
    }

    $('sv-no-signal').classList.add('hidden');
    $('btn-sv-mute').disabled    = false;
    $('btn-sv-popout').disabled  = false;
    $('btn-sv-record').disabled  = false;
    $('btn-sv-vid-rec').disabled = false;
    $('sv-ctx-popout').disabled  = false;
    updateSvMuteBtn();
    svSetLive($('sv-video-device').selectedOptions[0]?.text || videoId);
    if (_relayRequested) startSvRelay().catch(() => {});
  } catch (e) {
    $('sv-no-signal-msg').textContent = `Error: ${e.message}`;
    $('sv-no-signal').classList.remove('hidden');
    $('btn-sv-mute').disabled    = true;
    $('btn-sv-popout').disabled  = true;
    $('btn-sv-record').disabled  = true;
    $('btn-sv-vid-rec').disabled = true;
    $('sv-ctx-popout').disabled  = true;
    svSetIdle(`Error: ${e.message}`);
  }
}

function updateSvMuteBtn() {
  $('btn-sv-mute').textContent = _svMuted ? '🔇 Unmute' : '🔊 Mute';
}

// ── System View — status bar ───────────────────────────────────────────────────
function svSetLive(label) {
  $('sv-status-dot').className   = 'sv-status-dot live';
  $('sv-status-text').textContent = `Live — ${label}`;
}
function svSetIdle(msg = 'No device selected') {
  $('sv-status-dot').className    = 'sv-status-dot';
  $('sv-status-text').textContent  = msg;
  $('sv-status-res').textContent   = '';
}
function svSetSaving() {
  $('sv-status-dot').className    = 'sv-status-dot saving';
  $('sv-status-text').textContent  = 'Saving video…';
}

function svSetGifSaving() {
  $('sv-status-dot').className    = 'sv-status-dot saving';
  $('sv-status-text').textContent  = 'Saving GIF…';
}

$('sv-video').addEventListener('loadedmetadata', () => {
  const { videoWidth: w, videoHeight: h } = $('sv-video');
  if (w && h) $('sv-status-res').textContent = `${w}×${h}`;
});

// ── System View — codec detection ─────────────────────────────────────────────
function svDetectCodec() {
  const candidates = [
    { mime: 'video/mp4;codecs="avc1.640032,mp4a.40.2"', ext: 'mp4', label: 'H264/AAC · MP4' },
    { mime: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', ext: 'mp4', label: 'H264/AAC · MP4' },
    { mime: 'video/mp4;codecs=avc1,mp4a.40.2',          ext: 'mp4', label: 'H264/AAC · MP4' },
    { mime: 'video/mp4',                                 ext: 'mp4', label: 'MP4' },
    { mime: 'video/webm;codecs="vp9,opus"',              ext: 'webm', label: 'VP9/Opus · WebM' },
    { mime: 'video/webm;codecs="vp8,opus"',              ext: 'webm', label: 'VP8/Opus · WebM' },
    { mime: 'video/webm',                                ext: 'webm', label: 'WebM' },
  ];
  return candidates.find(c => MediaRecorder.isTypeSupported(c.mime))
      || { mime: '', ext: 'webm', label: 'WebM (default)' };
}

// ── System View — video recording ─────────────────────────────────────────────
function svFmtBytes(n) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function svFmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function svUpdateVidStatus() {
  const elapsed = _svVidPaused
    ? _svVidStart
    : Date.now() - _svVidStart;
  $('sv-vid-rec-time').textContent = svFmtTime(elapsed);
  $('sv-vid-rec-size').textContent = _svVidBytes > 0 ? ` · ${svFmtBytes(_svVidBytes)}` : '';
}

async function startSvVidRecording() {
  if (!_svStream) return;

  const codec = svDetectCodec();
  _svVidMimeType = codec.mime;
  _svVidExt      = codec.ext;
  $('sv-status-codec').textContent = codec.label;

  const bitrate = Math.max(2_500_000, Math.min(12_000_000, parseInt($('sv-vid-quality').value) || 8_000_000));
  const name    = `porkfolio-${new Date().toISOString().slice(0,19).replace(/[T:]/g,'-')}.${_svVidExt}`;

  try {
    const picked = await window.pork.systemViewPickSave({
      defaultPath: name,
      filters: [{ name: `${_svVidExt.toUpperCase()} Video`, extensions: [_svVidExt] }],
    });
    if (picked?.canceled || !picked?.filePath) return;
    _svVidWritable = picked.filePath;
    _svVidWriteQueue = Promise.resolve();
    await window.pork.systemViewWriteFile({ filePath: _svVidWritable, buffer: new Uint8Array(0).buffer });
  } catch (e) {
    setStatus(`Video save dialog failed: ${e.message}`, 'error');
    return;
  }

  _svVidBytes = 0; _svVidPaused = false; _svVidStart = Date.now();

  const recOpts = { videoBitsPerSecond: bitrate, audioBitsPerSecond: 256_000 };
  if (_svVidMimeType) recOpts.mimeType = _svVidMimeType;
  _svVidRecorder = new MediaRecorder(_svStream, recOpts);

  _svVidRecorder.ondataavailable = async (e) => {
    if (!e.data || e.data.size === 0) return;
    _svVidBytes += e.data.size;
    if (_svVidWritable) {
      const filePath = _svVidWritable;
      _svVidWriteQueue = _svVidWriteQueue.then(async () => {
        const buffer = await e.data.arrayBuffer();
        await window.pork.systemViewAppendFile({ filePath, buffer });
      }).catch(err => {
        console.error('[system-view] video append failed', err);
      });
    }
  };

  _svVidRecorder.onstop = async () => {
    clearInterval(_svVidTimer);
    svSetSaving();
    await _svVidWriteQueue.catch(() => {});
    _svVidWritable = null;
    _svVidRecorder = null;
    svSetVidIdle();
    if (_svStream) svSetLive($('sv-video-device').selectedOptions[0]?.text || '');
  };

  _svVidRecorder.start(500);

  $('btn-sv-vid-rec').hidden   = true;
  $('btn-sv-vid-pause').hidden = false;
  $('btn-sv-vid-stop').hidden  = false;
  $('sv-vid-rec-status').hidden = false;
  $('sv-vid-rec-label').textContent = 'REC';
  $('sv-vid-rec-status').className  = 'sv-vid-rec-status';
  $('btn-sv-record').disabled = true;  // no GIF while video recording

  _svVidTimer = setInterval(svUpdateVidStatus, 500);
}

function pauseSvVidRecording() {
  if (!_svVidRecorder) return;
  if (_svVidPaused) {
    _svVidRecorder.resume();
    _svVidStart   = Date.now() - _svVidStart;
    _svVidPaused  = false;
    $('btn-sv-vid-pause').textContent      = '⏸ Pause';
    $('sv-vid-rec-label').textContent       = 'REC';
    $('sv-vid-rec-status').className        = 'sv-vid-rec-status';
  } else {
    _svVidRecorder.pause();
    _svVidStart  = Date.now() - _svVidStart;
    _svVidPaused = true;
    $('btn-sv-vid-pause').textContent      = '▶ Resume';
    $('sv-vid-rec-label').textContent       = 'PAUSED';
    $('sv-vid-rec-status').className        = 'sv-vid-rec-status paused';
  }
}

function stopSvVidRecording() {
  if (!_svVidRecorder) return;
  if (_svVidPaused) { _svVidRecorder.resume(); _svVidPaused = false; }
  _svVidRecorder.stop();
}

function svSetVidIdle() {
  $('btn-sv-vid-rec').hidden    = false;
  $('btn-sv-vid-pause').hidden  = true;
  $('btn-sv-vid-stop').hidden   = true;
  $('sv-vid-rec-status').hidden = true;
  $('btn-sv-vid-pause').textContent = '⏸ Pause';
  $('sv-vid-rec-label').textContent  = 'REC';
  $('sv-vid-rec-status').className   = 'sv-vid-rec-status';
  $('btn-sv-record').disabled = !_svStream;
  _svVidPaused = false;
}

// ── System View — recording helpers ───────────────────────────────────────────

function getSvRecCtx() {
  const vid = $('sv-video');
  const srcW = vid.videoWidth  || GIF_W;
  const srcH = vid.videoHeight || GIF_H;
  const scale = srcW > SV_GIF_MAX_WIDTH ? (SV_GIF_MAX_WIDTH / srcW) : 1;
  const w = Math.max(2, Math.round(srcW * scale));
  const h = Math.max(2, Math.round(srcH * scale));
  if (!_svRecCanvas || _svRecCanvas.width !== w || _svRecCanvas.height !== h) {
    _svRecCanvas = document.createElement('canvas');
    _svRecCanvas.width = w; _svRecCanvas.height = h;
    _svRecCtx = _svRecCanvas.getContext('2d');
  }
  return _svRecCtx;
}

function getSvGifWorker() {
  if (_svGifWorker) return _svGifWorker;
  const workerSource = `
    importScripts(${JSON.stringify(new URL('gif-encoder.js', location.href).href)});
    self.onmessage = e => {
      const { id, width, height, fps, maxColors, frames } = e.data || {};
      try {
        const enc = new self.GifEncoder(width, height, { fps, maxColors });
        for (const frame of frames || []) enc.addFrame(new Uint8ClampedArray(frame));
        const bytes = enc.encode();
        self.postMessage({ id, ok: true, bytes }, [bytes.buffer]);
      } catch (error) {
        self.postMessage({ id, ok: false, error: error?.message || String(error) });
      }
    };
  `;
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'application/javascript' }));
  _svGifWorker = new Worker(workerUrl);
  URL.revokeObjectURL(workerUrl);
  return _svGifWorker;
}

function encodeGifOffThread({ width, height, fps, frames, maxColors }) {
  return new Promise((resolve, reject) => {
    const worker = getSvGifWorker();
    const id = ++_svGifJobId;
    const onMessage = (event) => {
      const msg = event.data || {};
      if (msg.id !== id) return;
      worker.removeEventListener('message', onMessage);
      if (!msg.ok) reject(new Error(msg.error || 'GIF encode failed'));
      else resolve(new Uint8Array(msg.bytes));
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({
      id,
      width,
      height,
      fps,
      maxColors,
      frames: frames.map(f => f.buffer),
    }, frames.map(f => f.buffer));
  });
}

async function startSvRecording() {
  if (_svRecording || !_svStream) return;
  const fps       = Math.min(SV_GIF_MAX_FPS, parseInt($('sv-gif-fps').value) || 10);
  const picked = await window.pork.systemViewPickSave({
    defaultPath: `porkfolio-${Date.now()}.gif`,
    filters: [{ name: 'GIF Image', extensions: ['gif'] }],
  });
  if (picked?.canceled || !picked?.filePath) return;
  _svGifSavePath = picked.filePath;
  _svRecording = true; _svRecFrames = []; _svRecStart = Date.now();
  $('btn-sv-record').textContent = '⏹ Stop & Save';
  $('sv-rec-status').hidden = false;
  const ctx = getSvRecCtx();
  const vid = $('sv-video');
  const gifW = _svRecCanvas.width, gifH = _svRecCanvas.height;
  _svRecInterval = setInterval(() => {
    ctx.drawImage(vid, 0, 0, gifW, gifH);
    _svRecFrames.push(new Uint8ClampedArray(ctx.getImageData(0, 0, gifW, gifH).data));
  }, Math.round(1000 / fps));
  _svRecTimer = setInterval(() => {
    const s = Math.floor((Date.now() - _svRecStart) / 1000);
    $('sv-rec-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}

async function stopSvRecording() {
  if (!_svRecording) return;
  clearInterval(_svRecInterval); clearInterval(_svRecTimer);
  _svRecording = false;
  $('btn-sv-record').textContent = '⏺ Record GIF';
  $('sv-rec-status').hidden = true;
  $('sv-rec-time').textContent = '0:00';
  if (!_svRecFrames.length) return;
  const fps   = Math.min(SV_GIF_MAX_FPS, parseInt($('sv-gif-fps').value) || 10);
  const gifW  = _svRecCanvas?.width  || GIF_W;
  const gifH  = _svRecCanvas?.height || GIF_H;
  const frames = _svRecFrames;
  const filePath = _svGifSavePath;
  _svRecFrames = [];
  _svGifSavePath = '';
  svSetGifSaving();
  try {
    const bytes = await encodeGifOffThread({
      width: gifW,
      height: gifH,
      fps,
      frames,
      maxColors: SV_GIF_MAX_COLORS,
    });
    await window.pork.systemViewWriteFile({ filePath, buffer: bytes.buffer });
  } catch (e) {
    console.error('[system-view] gif save failed', e);
    setStatus(`GIF save failed: ${e.message}`, 'error');
  }
  if (_svStream) svSetLive($('sv-video-device').selectedOptions[0]?.text || '');
}

// System View — event handlers (attached once at startup)
$('sv-video-device').addEventListener('change', () => {
  window.pork.setSettings({ svVideoDevice: $('sv-video-device').value });
  startSvStream();
});
$('sv-audio-device').addEventListener('change', () => {
  window.pork.setSettings({ svAudioDevice: $('sv-audio-device').value });
  startSvStream();
});
$('btn-sv-refresh-devices').addEventListener('click', enumerateSvDevices);

$('sv-resolution').addEventListener('change', () => {
  window.pork.setSettings({ svResolution: $('sv-resolution').value });
  if ($('sv-video-device').value) startSvStream();
});
$('sv-gif-fps').addEventListener('change', () =>
  window.pork.setSettings({ svGifFps: $('sv-gif-fps').value }));
$('sv-vid-quality').addEventListener('change', () =>
  window.pork.setSettings({ svVidQuality: $('sv-vid-quality').value }));

$('sv-auto-load').addEventListener('change', () => {
  window.pork.setSettings({ svAutoLoad: $('sv-auto-load').checked });
});

$('btn-sv-mute').addEventListener('click', () => {
  _svMuted = !_svMuted;
  if (_svAudioGain) _svAudioGain.gain.value = _svMuted ? 0 : 1;
  updateSvMuteBtn();
});

// In-app fullscreen: CSS-based fixed overlay — requestFullscreen() is
// unreliable in Electron's frameless window and silently fails.
function svToggleFullscreen() {
  const wrap = $('sv-viewer-wrap');
  const entering = !wrap.classList.contains('sv-viewer-wrap--fullscreen');
  wrap.classList.toggle('sv-viewer-wrap--fullscreen', entering);
  $('btn-sv-fullscreen').title = entering ? 'Exit Fullscreen (Esc)' : 'Fullscreen (or double-click)';
  $('btn-sv-fullscreen').innerHTML = entering ? '&#x2715;' : '&#x26F6;';
}

$('btn-sv-fullscreen').addEventListener('click', svToggleFullscreen);

$('sv-viewer-wrap').addEventListener('dblclick', svToggleFullscreen);

$('btn-sv-record').addEventListener('click', () => {
  (_svRecording ? stopSvRecording() : startSvRecording()).catch(err => {
    setStatus(err.message, 'error');
  });
});

$('btn-sv-vid-rec').addEventListener('click',   startSvVidRecording);
$('btn-sv-vid-pause').addEventListener('click', pauseSvVidRecording);
$('btn-sv-vid-stop').addEventListener('click',  stopSvVidRecording);

// Right-click context menu on video area
const _svCtxMenu = $('sv-ctx-menu');
$('sv-viewer-wrap').addEventListener('contextmenu', e => {
  e.preventDefault();
  const x = Math.min(e.clientX, window.innerWidth  - 164);
  const y = Math.min(e.clientY, window.innerHeight -  80);
  _svCtxMenu.style.left = `${x}px`;
  _svCtxMenu.style.top  = `${y}px`;
  _svCtxMenu.hidden = false;
});
document.addEventListener('click', () => { _svCtxMenu.hidden = true; });
$('sv-ctx-fs').addEventListener('click', svToggleFullscreen);
$('sv-ctx-popout').addEventListener('click', () => $('btn-sv-popout').click());

if (navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener('devicechange', () => enumerateSvDevices().catch(() => {}));
}

$('btn-sv-popout').addEventListener('click', async () => {
  const videoId = $('sv-video-device').value;
  const audioId = $('sv-audio-device').value;
  const resolution = $('sv-resolution').value;
  if (_svRecording) stopSvRecording();
  stopSvRelay();
  // Stop the main stream — the pop-out will start its own
  if (_svStream) { _svStream.getTracks().forEach(t => t.stop()); _svStream = null; }
  _svAudioStop();
  $('sv-video').srcObject = null;
  $('sv-no-signal').classList.remove('hidden');
  $('sv-no-signal-msg').textContent = 'Stream moved to pop-out window';
  $('btn-sv-mute').disabled = true;
  $('btn-sv-popout').disabled = true;
  $('btn-sv-record').disabled = true;
  await window.pork.openSystemViewPopout(videoId, audioId, resolution);
});

// When pop-out closes, auto-restart stream in main window if device still selected
window.pork.on('system-view:popout-closed', () => {
  if ($('page-system-view')?.classList.contains('active') && $('sv-video-device').value) {
    startSvStream();
  }
});

// ── System View mini-cards (Transfers / Jailbreak) ────────────────────────────

function svMiniGetStatus() {
  const sel = $('sv-video-device');
  const opt = sel?.selectedOptions?.[0];
  return (opt && opt.value) ? `Capture device: ${opt.text}` : 'No capture device selected.';
}

['transfers', 'jailbreak'].forEach(pageId => {
  $(`sv-mini-${pageId}-hdr`).addEventListener('click', () => {
    const card = $(`sv-mini-${pageId}`);
    card.classList.toggle('open');
    if (card.classList.contains('open')) {
      $(`sv-mini-${pageId}-status`).textContent = svMiniGetStatus();
    }
  });

  $(`btn-sv-mini-${pageId}-nav`).addEventListener('click', () => navigate('system-view'));

  $(`btn-sv-mini-${pageId}-popout`).addEventListener('click', async () => {
    const videoId    = $('sv-video-device').value;
    const audioId    = $('sv-audio-device').value;
    const resolution = $('sv-resolution').value;
    try {
      await window.pork.openSystemViewPopout(videoId, audioId, resolution);
    } catch (e) {
      setStatus(e.message, 'error');
    }
  });
});

async function loadTransfers() {
  try {
    const st = await window.pork.transferState();
    renderTransferPage(st);
    updateNavTransferBadge(st);
  } catch (_) {}
}

// Global transfer:update listener (always active, not page-specific)
window.pork.on('transfer:update', st => {
  renderTransferPage(st);
  updateNavTransferBadge(st);
});

document.querySelectorAll('.nav-link').forEach(a =>
  a.addEventListener('click', e => { e.preventDefault(); navigate(a.dataset.page); })
);


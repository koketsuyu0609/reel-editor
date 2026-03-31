/**
 * リール動画エディタ - App.js
 * ブラウザだけでリール動画を完成させるWebアプリ
 */

// ============================================================
// 1. 設定 (Configuration)
// ============================================================
const CONFIG = {
  maxCharsPerCaption: 20,
  maxCaptionDuration: 10,
  minCaptionDuration: 1.0,
  charDurationSec: 0.25,     // 1文字あたりの表示秒数
  silenceThreshold: 0.02,
  silenceMinDuration: 0.3,
  canvasWidth: 1080,
  canvasHeight: 1920,
  fps: 30,
  videoBitrate: 5_000_000,
  audioBitrate: 128_000,
  captionFont: '700 60px "Noto Sans JP", sans-serif',
  captionFontPreview: '700 15px "Noto Sans JP", sans-serif',
};

const MOTION_EFFECTS = [
  { value: 'none',      label: 'なし' },
  { value: 'pan-left',  label: '← パン左' },
  { value: 'pan-right', label: 'パン右 →' },
  { value: 'pan-up',    label: '↑ パン上' },
  { value: 'pan-down',  label: 'パン下 ↓' },
  { value: 'zoom-in',   label: '🔍 ズームイン' },
  { value: 'zoom-out',  label: '🔍 ズームアウト' },
];

// ============================================================
// 2. アプリケーション状態 (State)
// ============================================================
const state = {
  currentStep: 1,
  audioFile: null,
  originalAudioBuffer: null,
  processedAudioBuffer: null,
  silentSegments: [],
  audioDuration: 0,
  scriptText: '',
  captions: [],       // { text, duration, imageFile, imageUrl, imageBitmap, motion }
  isPlaying: false,
  isExporting: false,
  previewAnimId: null,
  previewStartTime: 0,
  previewAudioSource: null,
  previewAudioCtx: null,
  // Audio selection
  selectionStart: null, // in seconds
  selectionEnd: null,   // in seconds
  isSelecting: false,
};

// ============================================================
// 3. テキスト分割 (Text Splitter)
// ============================================================
function splitScript(text, maxChars) {
  const lines = text.split(/\n+/).filter(l => l.trim());
  const result = [];

  for (const line of lines) {
    const sentences = splitBySentence(line.trim());
    for (const sentence of sentences) {
      if (sentence.length <= maxChars) {
        result.push(sentence);
      } else {
        const chunks = splitLongSentence(sentence, maxChars);
        result.push(...chunks);
      }
    }
  }
  return result.filter(t => t.trim().length > 0);
}

function splitBySentence(text) {
  const parts = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    current += text[i];
    if ('。！？!?'.includes(text[i])) {
      parts.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function splitLongSentence(text, maxChars) {
  // 読点で分割
  const commaChunks = text.split(/、/).reduce((acc, part, i, arr) => {
    const sep = i < arr.length - 1 ? '、' : '';
    if (acc.length === 0) {
      acc.push(part + sep);
    } else {
      const last = acc[acc.length - 1];
      if ((last + part + sep).length <= maxChars) {
        acc[acc.length - 1] = last + part + sep;
      } else {
        acc.push(part + sep);
      }
    }
    return acc;
  }, []);

  const result = [];
  for (const chunk of commaChunks) {
    if (chunk.length <= maxChars) {
      result.push(chunk);
    } else {
      // 助詞で分割
      const particleResult = splitByParticles(chunk, maxChars);
      result.push(...particleResult);
    }
  }
  return result;
}

function splitByParticles(text, maxChars) {
  const particles = ['ことが', 'ために', 'として', 'ている', 'ですが', 'ますが', 'には', 'では', 'とは', 'から', 'まで', 'より', 'ので', 'のに', 'けど', 'って', 'は', 'が', 'を', 'に', 'で', 'と', 'も', 'の', 'へ'];
  let best = null;

  for (const p of particles) {
    const idx = text.indexOf(p);
    if (idx > 0 && idx + p.length < text.length) {
      const splitPos = idx + p.length;
      const part1 = text.slice(0, splitPos);
      const part2 = text.slice(splitPos);
      if (part1.length <= maxChars && (!best || Math.abs(part1.length - part2.length) < Math.abs(best[0].length - best[1].length))) {
        best = [part1, part2];
      }
    }
  }

  if (best) {
    const results = [];
    for (const part of best) {
      if (part.length > maxChars) {
        results.push(...forceSplit(part, maxChars));
      } else {
        results.push(part);
      }
    }
    return results;
  }
  return forceSplit(text, maxChars);
}

function forceSplit(text, maxChars) {
  const result = [];
  for (let i = 0; i < text.length; i += maxChars) {
    result.push(text.slice(i, i + maxChars));
  }
  return result;
}

// ============================================================
// 4. 音声処理 (Audio Processing)
// ============================================================
async function decodeAudioFile(file) {
  const ctx = new AudioContext();
  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  ctx.close();
  return audioBuffer;
}

function detectSilence(audioBuffer, threshold, minDuration) {
  const data = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;
  const windowSize = Math.floor(sampleRate * 0.02); // 20ms window
  const segments = [];
  let silenceStart = -1;

  for (let i = 0; i < data.length; i += windowSize) {
    const end = Math.min(i + windowSize, data.length);
    let rms = 0;
    for (let j = i; j < end; j++) {
      rms += data[j] * data[j];
    }
    rms = Math.sqrt(rms / (end - i));

    if (rms < threshold) {
      if (silenceStart === -1) silenceStart = i;
    } else {
      if (silenceStart !== -1) {
        const duration = (i - silenceStart) / sampleRate;
        if (duration >= minDuration) {
          segments.push({
            start: silenceStart / sampleRate,
            end: i / sampleRate,
            duration
          });
        }
        silenceStart = -1;
      }
    }
  }

  if (silenceStart !== -1) {
    const duration = (data.length - silenceStart) / sampleRate;
    if (duration >= minDuration) {
      segments.push({
        start: silenceStart / sampleRate,
        end: data.length / sampleRate,
        duration
      });
    }
  }

  return segments;
}

function removeSilence(audioBuffer, silentSegments) {
  const sampleRate = audioBuffer.sampleRate;
  const channels = audioBuffer.numberOfChannels;
  const originalLength = audioBuffer.length;

  // Calculate total samples to remove
  let removeSamples = 0;
  for (const seg of silentSegments) {
    const startSample = Math.floor(seg.start * sampleRate);
    const endSample = Math.floor(seg.end * sampleRate);
    removeSamples += (endSample - startSample);
  }

  const newLength = originalLength - removeSamples;
  if (newLength <= 0) return audioBuffer;

  const ctx = new OfflineAudioContext(channels, newLength, sampleRate);
  const newBuffer = ctx.createBuffer(channels, newLength, sampleRate);

  for (let ch = 0; ch < channels; ch++) {
    const oldData = audioBuffer.getChannelData(ch);
    const newData = newBuffer.getChannelData(ch);
    let writePos = 0;
    let readPos = 0;

    for (const seg of silentSegments) {
      const startSample = Math.floor(seg.start * sampleRate);
      const endSample = Math.floor(seg.end * sampleRate);

      // Copy non-silent audio before this segment
      while (readPos < startSample && writePos < newLength) {
        newData[writePos++] = oldData[readPos++];
      }
      readPos = endSample;
    }

    // Copy remaining audio
    while (readPos < originalLength && writePos < newLength) {
      newData[writePos++] = oldData[readPos++];
    }
  }

  return newBuffer;
}

function removeBufferRange(audioBuffer, startSeconds, endSeconds) {
  const sampleRate = audioBuffer.sampleRate;
  const channels = audioBuffer.numberOfChannels;
  
  const startSample = Math.floor(Math.max(0, startSeconds) * sampleRate);
  const endSample = Math.floor(Math.min(audioBuffer.duration, endSeconds) * sampleRate);
  
  if (startSample >= endSample) return audioBuffer;
  
  const removeLength = endSample - startSample;
  const newLength = audioBuffer.length - removeLength;
  
  if (newLength <= 0) return audioBuffer;
  
  const ctx = new OfflineAudioContext(channels, newLength, sampleRate);
  const newBuffer = ctx.createBuffer(channels, newLength, sampleRate);
  
  for (let ch = 0; ch < channels; ch++) {
    const oldData = audioBuffer.getChannelData(ch);
    const newData = newBuffer.getChannelData(ch);
    
    // Copy before range
    newData.set(oldData.subarray(0, startSample), 0);
    // Copy after range
    newData.set(oldData.subarray(endSample), startSample);
  }
  
  return newBuffer;
}

function drawWaveform(canvas, audioBuffer, silentSegments) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const data = audioBuffer.getChannelData(0);
  const step = Math.ceil(data.length / w);
  const duration = audioBuffer.duration;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#12121f';
  ctx.fillRect(0, 0, w, h);

  // Draw manual selection
  if (state.selectionStart !== null && state.selectionEnd !== null) {
    const x1 = (state.selectionStart / duration) * w;
    const x2 = (state.selectionEnd / duration) * w;
    ctx.fillStyle = 'rgba(6, 182, 212, 0.3)';
    ctx.fillRect(x1, 0, x2 - x1, h);
  }

  // Draw silent segments background
  for (const seg of silentSegments) {
    const x1 = (seg.start / duration) * w;
    const x2 = (seg.end / duration) * w;
    ctx.fillStyle = 'rgba(239, 68, 68, 0.15)';
    ctx.fillRect(x1, 0, x2 - x1, h);
  }

  // Draw waveform
  const mid = h / 2;
  ctx.beginPath();
  ctx.strokeStyle = '#7c3aed';
  ctx.lineWidth = 1;

  for (let i = 0; i < w; i++) {
    let maxVal = 0;
    const start = i * step;
    for (let j = 0; j < step && start + j < data.length; j++) {
      const val = Math.abs(data[start + j]);
      if (val > maxVal) maxVal = val;
    }
    const barH = maxVal * mid;
    ctx.moveTo(i, mid - barH);
    ctx.lineTo(i, mid + barH);
  }
  ctx.stroke();

  // Draw silence markers
  ctx.strokeStyle = 'rgba(239, 68, 68, 0.6)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  for (const seg of silentSegments) {
    const x1 = (seg.start / duration) * w;
    const x2 = (seg.end / duration) * w;
    ctx.beginPath();
    ctx.moveTo(x1, 0); ctx.lineTo(x1, h);
    ctx.moveTo(x2, 0); ctx.lineTo(x2, h);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

// ============================================================
// 5. キャンバスレンダリング (Canvas Rendering)
// ============================================================
function getCaptionAtTime(time) {
  let t = 0;
  for (let i = 0; i < state.captions.length; i++) {
    const cap = state.captions[i];
    if (time >= t && time < t + cap.duration) {
      return { caption: cap, index: i, progress: (time - t) / cap.duration };
    }
    t += cap.duration;
  }
  return null;
}

function renderFrame(canvas, time, scale) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const s = scale || 1;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

  const info = getCaptionAtTime(time);
  if (!info) return;

  const { caption, progress } = info;

  // Draw image with motion
  if (caption.imageBitmap) {
    drawImageWithMotion(ctx, caption.imageBitmap, caption.motion, progress, w, h);
  }

  // Draw caption text
  const captionStyle = document.getElementById('caption-style')?.value || 'bold-shadow';
  const captionPosition = document.getElementById('caption-position')?.value || 'bottom';
  drawCaption(ctx, caption.text, w, h, s, captionStyle, captionPosition);
}

function drawImageWithMotion(ctx, img, motion, progress, cw, ch) {
  const iw = img.width;
  const ih = img.height;

  // Calculate cover dimensions
  const ratio = Math.max(cw / iw, ch / ih);
  const scaledW = iw * ratio;
  const scaledH = ih * ratio;

  ctx.save();

  // Motion amount (10% movement range)
  const range = 0.1;
  const p = progress;

  let dx = (cw - scaledW) / 2;
  let dy = (ch - scaledH) / 2;
  let scale = 1;

  switch (motion) {
    case 'pan-left':
      dx += scaledW * range * (0.5 - p);
      break;
    case 'pan-right':
      dx += scaledW * range * (p - 0.5);
      break;
    case 'pan-up':
      dy += scaledH * range * (0.5 - p);
      break;
    case 'pan-down':
      dy += scaledH * range * (p - 0.5);
      break;
    case 'zoom-in':
      scale = 1 + range * p;
      break;
    case 'zoom-out':
      scale = 1 + range * (1 - p);
      break;
  }

  if (scale !== 1) {
    ctx.translate(cw / 2, ch / 2);
    ctx.scale(scale, scale);
    ctx.translate(-cw / 2, -ch / 2);
  }

  ctx.drawImage(img, dx, dy, scaledW, scaledH);
  ctx.restore();
}

function drawCaption(ctx, text, cw, ch, scale, style, position) {
  const fontSize = Math.round(60 * scale);
  const lineHeight = fontSize * 1.3;
  ctx.font = `700 ${fontSize}px "Noto Sans JP", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Calculate wrapped lines
  const maxWidth = cw * 0.9;
  const lines = getLines(ctx, text, maxWidth);
  const totalHeight = lines.length * lineHeight;

  // Calculate base y position
  let baseY;
  const padding = Math.round(20 * scale);
  switch (position) {
    case 'top':
      baseY = ch * 0.12;
      break;
    case 'center':
      baseY = ch * 0.5;
      break;
    case 'bottom':
    default:
      baseY = ch * 0.82;
  }

  const x = cw / 2;
  
  // Calculate vertical offset to center the block of lines around baseY
  const startY = baseY - (totalHeight / 2) + (lineHeight / 2);

  switch (style) {
    case 'bg-box':
      // Find max width among all lines for the background box
      let maxLineW = 0;
      lines.forEach(line => {
        const w = ctx.measureText(line).width;
        if (w > maxLineW) maxLineW = w;
      });

      // Draw a single background box that covers all lines
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      const boxRadius = Math.round(10 * scale);
      roundRect(
        ctx, 
        x - maxLineW / 2 - padding, 
        baseY - totalHeight / 2 - (padding / 2), 
        maxLineW + padding * 2, 
        totalHeight + padding, 
        boxRadius
      );
      ctx.fill();

      // Draw each line
      ctx.fillStyle = '#ffffff';
      lines.forEach((line, i) => {
        ctx.fillText(line, x, startY + (i * lineHeight));
      });
      break;

    case 'outline':
      // White text with black outline
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = Math.round(6 * scale);
      ctx.lineJoin = 'round';
      lines.forEach((line, i) => {
        ctx.strokeText(line, x, startY + (i * lineHeight));
      });

      ctx.fillStyle = '#ffffff';
      lines.forEach((line, i) => {
        ctx.fillText(line, x, startY + (i * lineHeight));
      });
      break;

    case 'bold-shadow':
    default:
      // Bold with shadow
      ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
      ctx.shadowBlur = Math.round(12 * scale);
      ctx.shadowOffsetX = Math.round(2 * scale);
      ctx.shadowOffsetY = Math.round(2 * scale);
      ctx.fillStyle = '#ffffff';
      lines.forEach((line, i) => {
        ctx.fillText(line, x, startY + (i * lineHeight));
      });
      ctx.shadowColor = 'transparent';
      break;
  }
}

/**
 * Text wrapping helper
 */
function getLines(ctx, text, maxWidth) {
  if (!text) return [];
  const words = text.split(''); // For Japanese, split per character
  const lines = [];
  let currentLine = words[0];

  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const width = ctx.measureText(currentLine + word).width;
    if (width < maxWidth) {
      currentLine += word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }
  lines.push(currentLine);
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ============================================================
// 6. プレビュー (Preview)
// ============================================================
function getTotalDuration() {
  return state.captions.reduce((sum, c) => sum + c.duration, 0);
}

function startPreview() {
  if (state.isPlaying) {
    stopPreview();
    return;
  }

  const canvas = document.getElementById('preview-canvas');
  const totalDuration = getTotalDuration();
  if (totalDuration <= 0) return;

  state.isPlaying = true;
  document.getElementById('preview-play-btn').textContent = '⏸';

  // Start audio playback
  const audioBuffer = state.processedAudioBuffer || state.originalAudioBuffer;
  if (audioBuffer) {
    state.previewAudioCtx = new AudioContext();
    state.previewAudioSource = state.previewAudioCtx.createBufferSource();
    state.previewAudioSource.buffer = audioBuffer;
    state.previewAudioSource.connect(state.previewAudioCtx.destination);
    state.previewAudioSource.start();
  }

  state.previewStartTime = performance.now();
  const previewScale = canvas.width / CONFIG.canvasWidth;

  function animate() {
    if (!state.isPlaying) return;

    const elapsed = (performance.now() - state.previewStartTime) / 1000;
    if (elapsed >= totalDuration) {
      stopPreview();
      return;
    }

    renderFrame(canvas, elapsed, previewScale);
    updatePreviewProgress(elapsed, totalDuration);
    state.previewAnimId = requestAnimationFrame(animate);
  }

  animate();
}

function stopPreview() {
  state.isPlaying = false;
  document.getElementById('preview-play-btn').textContent = '▶';

  if (state.previewAnimId) {
    cancelAnimationFrame(state.previewAnimId);
    state.previewAnimId = null;
  }
  if (state.previewAudioSource) {
    try { state.previewAudioSource.stop(); } catch(e) {}
    state.previewAudioSource = null;
  }
  if (state.previewAudioCtx) {
    state.previewAudioCtx.close();
    state.previewAudioCtx = null;
  }
}

function updatePreviewProgress(current, total) {
  const pct = (current / total) * 100;
  document.getElementById('preview-progress-fill').style.width = `${pct}%`;
  document.getElementById('preview-current').textContent = formatTime(current);
  document.getElementById('preview-total').textContent = formatTime(total);
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ============================================================
// 7. 動画エクスポート (Video Export)
// ============================================================
async function exportMP4() {
  if (state.isExporting) return;
  state.isExporting = true;

  const progressEl = document.getElementById('export-progress');
  const progressFill = document.getElementById('export-progress-fill');
  const progressText = document.getElementById('export-progress-text');
  progressEl.style.display = 'block';
  progressText.textContent = '動画を生成中...';

  const resSelect = document.getElementById('export-resolution');
  const resValue = parseInt(resSelect.value);
  const exportWidth = resValue;
  const exportHeight = Math.round(resValue * (1920 / 1080));
  const scale = exportWidth / CONFIG.canvasWidth;

  const totalDuration = getTotalDuration();
  const totalFrames = Math.ceil(totalDuration * CONFIG.fps);

  // Create offscreen canvas
  const offCanvas = document.createElement('canvas');
  offCanvas.width = exportWidth;
  offCanvas.height = exportHeight;

  const hasWebCodecs = 'VideoEncoder' in window;

  if (hasWebCodecs && typeof Mp4Muxer !== 'undefined') {
    try {
      console.log('WebCodecs + mp4-muxer で MP4 を生成します');
      await exportWithWebCodecs(offCanvas, totalFrames, totalDuration, scale, progressFill, progressText);
    } catch (err) {
      console.error('WebCodecs export failed, falling back to MediaRecorder:', err);
      showToast('高画質エンコードに失敗。代替方式で書き出します...', 'error');
      await exportWithMediaRecorder(offCanvas, totalDuration, scale, progressFill, progressText);
    }
  } else {
    console.log('WebCodecs/Mp4Muxer not available. hasWebCodecs:', hasWebCodecs, ', Mp4Muxer:', typeof Mp4Muxer);
    await exportWithMediaRecorder(offCanvas, totalDuration, scale, progressFill, progressText);
  }

  state.isExporting = false;
  progressText.textContent = '完了！';
  setTimeout(() => { progressEl.style.display = 'none'; }, 3000);
}

async function exportWithWebCodecs(canvas, totalFrames, totalDuration, scale, progressFill, progressText) {
  const w = canvas.width;
  const h = canvas.height;

  const target = new Mp4Muxer.ArrayBufferTarget();

  const muxerOptions = {
    target,
    video: {
      codec: 'avc',
      width: w,
      height: h,
    },
    fastStart: 'in-memory',
  };

  // Add audio track if available
  const audioBuffer = state.processedAudioBuffer || state.originalAudioBuffer;
  let hasAudio = false;

  if (audioBuffer && 'AudioEncoder' in window) {
    muxerOptions.audio = {
      codec: 'aac',
      numberOfChannels: 1,
      sampleRate: audioBuffer.sampleRate,
    };
    hasAudio = true;
  }

  const muxer = new Mp4Muxer.Muxer(muxerOptions);

  // Video encoder
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => console.error('VideoEncoder error:', e),
  });

  videoEncoder.configure({
    codec: 'avc1.42001f',
    width: w,
    height: h,
    bitrate: CONFIG.videoBitrate,
    framerate: CONFIG.fps,
  });

  // Encode video frames
  for (let i = 0; i < totalFrames; i++) {
    const time = i / CONFIG.fps;
    renderFrame(canvas, time, scale);

    const frame = new VideoFrame(canvas, {
      timestamp: Math.round(time * 1_000_000),
    });
    videoEncoder.encode(frame, { keyFrame: i % 30 === 0 });
    frame.close();

    // Update progress
    const pct = ((i / totalFrames) * (hasAudio ? 80 : 100));
    progressFill.style.width = `${pct}%`;
    progressText.textContent = `動画レンダリング中... ${Math.round(pct)}%`;

    // Yield to prevent UI freeze
    if (i % 10 === 0) await new Promise(r => setTimeout(r, 0));
  }

  await videoEncoder.flush();

  // Encode audio if available
  if (hasAudio) {
    progressText.textContent = '音声をエンコード中...';

    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => console.error('AudioEncoder error:', e),
    });

    audioEncoder.configure({
      codec: 'mp4a.40.2',
      numberOfChannels: 1,
      sampleRate: audioBuffer.sampleRate,
      bitrate: CONFIG.audioBitrate,
    });

    // Get mono audio data
    const channelData = audioBuffer.getChannelData(0);
    const chunkSize = 1024;
    const sampleRate = audioBuffer.sampleRate;

    // Only encode up to totalDuration of audio
    const maxSamples = Math.min(channelData.length, Math.ceil(totalDuration * sampleRate));

    for (let i = 0; i < maxSamples; i += chunkSize) {
      const frameCount = Math.min(chunkSize, maxSamples - i);
      const chunk = new Float32Array(frameCount);
      for (let j = 0; j < frameCount; j++) {
        chunk[j] = channelData[i + j];
      }

      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate: sampleRate,
        numberOfFrames: frameCount,
        numberOfChannels: 1,
        timestamp: Math.round((i / sampleRate) * 1_000_000),
        data: chunk,
      });
      audioEncoder.encode(audioData);
      audioData.close();

      const audioPct = 80 + (i / maxSamples) * 20;
      progressFill.style.width = `${audioPct}%`;

      if (i % (chunkSize * 50) === 0) await new Promise(r => setTimeout(r, 0));
    }

    await audioEncoder.flush();
    audioEncoder.close();
  }

  videoEncoder.close();
  muxer.finalize();

  const blob = new Blob([target.buffer], { type: 'video/mp4' });
  downloadBlob(blob, 'reel_video.mp4');
  showToast('MP4動画をダウンロードしました！', 'success');
}

async function exportWithMediaRecorder(canvas, totalDuration, scale, progressFill, progressText) {
  // Try to find the best supported format for MP4 or WebM
  const mimeTypes = [
    'video/mp4;codecs=h264',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm'
  ];
  const selectedMime = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
  const extension = selectedMime.includes('mp4') ? 'mp4' : 'webm';

  progressText.textContent = `${extension.toUpperCase()}で書き出し中（リアルタイム処理）...`;

  const stream = canvas.captureStream(CONFIG.fps);

  // Add audio track if available
  const audioBuffer = state.processedAudioBuffer || state.originalAudioBuffer;
  let audioCtx, audioSource;

  if (audioBuffer) {
    audioCtx = new AudioContext();
    audioSource = audioCtx.createBufferSource();
    audioSource.buffer = audioBuffer;
    const dest = audioCtx.createMediaStreamDestination();
    audioSource.connect(dest);
    audioSource.connect(audioCtx.destination);

    for (const track of dest.stream.getAudioTracks()) {
      stream.addTrack(track);
    }
  }

  const chunks = [];
  const recorder = new MediaRecorder(stream, {
    mimeType: selectedMime,
    videoBitsPerSecond: CONFIG.videoBitrate,
  });

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  return new Promise((resolve) => {
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: selectedMime });
      downloadBlob(blob, `reel_video.${extension}`);
      showToast(`${extension.toUpperCase()}動画をダウンロードしました！`, 'success');

      if (audioCtx) audioCtx.close();
      resolve();
    };

    recorder.start();
    if (audioSource) audioSource.start();

    const startTime = performance.now();

    function animateExport() {
      const elapsed = (performance.now() - startTime) / 1000;
      if (elapsed >= totalDuration) {
        recorder.stop();
        if (audioSource) try { audioSource.stop(); } catch(e) {}
        return;
      }

      renderFrame(canvas, elapsed, scale);
      const pct = (elapsed / totalDuration) * 100;
      progressFill.style.width = `${pct}%`;
      progressText.textContent = `録画中... ${formatTime(elapsed)} / ${formatTime(totalDuration)}`;
      requestAnimationFrame(animateExport);
    }

    animateExport();
  });
}

// ============================================================
// 8. SRT生成 (SRT Generator)
// ============================================================
function generateSRT() {
  let srt = '';
  let time = 0;

  for (let i = 0; i < state.captions.length; i++) {
    const cap = state.captions[i];
    const start = time;
    const end = time + cap.duration;

    srt += `${i + 1}\n`;
    srt += `${formatSRTTime(start)} --> ${formatSRTTime(end)}\n`;
    srt += `${cap.text}\n\n`;

    time = end;
  }

  return srt;
}

function formatSRTTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

function pad(num, len) {
  return num.toString().padStart(len, '0');
}

function exportSRT() {
  const srt = generateSRT();
  const bom = '\uFEFF';
  const blob = new Blob([bom + srt], { type: 'text/srt;charset=utf-8' });
  downloadBlob(blob, 'reel_captions.srt');
  showToast('SRTファイルをダウンロードしました！', 'success');
}

// ============================================================
// 9. ユーティリティ (Utilities)
// ============================================================
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function showToast(message, type) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `toast ${type}`;

  requestAnimationFrame(() => {
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
  });
}

// ============================================================
// 10. UI制御 (UI Controller)
// ============================================================
function showStep(step) {
  state.currentStep = step;

  // Update panels
  document.querySelectorAll('.step-panel').forEach(panel => {
    panel.classList.remove('active');
  });
  const activePanel = document.getElementById(`step-${step}`);
  if (activePanel) activePanel.classList.add('active');

  // Update step nav
  document.querySelectorAll('.step-item').forEach(item => {
    const s = parseInt(item.dataset.step);
    item.classList.remove('active', 'completed');
    if (s === step) item.classList.add('active');
    else if (s < step) item.classList.add('completed');
  });

  // Update nav buttons
  document.getElementById('prev-btn').disabled = step === 1;
  document.getElementById('next-btn').textContent = step === 4 ? '完了' : '次へ →';

  // Render step-specific content
  if (step === 2) renderCaptionEditor();
  if (step === 3) renderImageEditor();
  if (step === 4) renderPreviewStep();
}

function renderCaptionEditor() {
  const list = document.getElementById('caption-list');
  list.innerHTML = '';

  const maxChars = parseInt(document.getElementById('max-chars').value) || CONFIG.maxCharsPerCaption;

  state.captions.forEach((cap, i) => {
    const item = document.createElement('div');
    item.className = 'caption-item';
    item.innerHTML = `
      <span class="caption-num">${i + 1}</span>
      <input type="text" class="caption-text-input" value="${escapeHtml(cap.text)}" data-index="${i}">
      <div class="caption-duration">
        <input type="number" value="${cap.duration.toFixed(1)}" step="0.5" min="0.5" max="${CONFIG.maxCaptionDuration}" data-index="${i}" class="duration-input">
        <span>秒</span>
      </div>
      <span class="caption-charcount ${cap.text.length > maxChars ? 'over' : ''}">${cap.text.length}字</span>
      <button class="caption-delete" data-index="${i}" title="削除">×</button>
    `;
    list.appendChild(item);
  });

  document.getElementById('caption-count').textContent = `${state.captions.length}テロップ`;

  const totalEl = document.getElementById('caption-total');
  totalEl.style.display = 'block';
  document.getElementById('total-duration-display').textContent = `${getTotalDuration().toFixed(1)}s`;

  // Event listeners
  list.querySelectorAll('.caption-text-input').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.index);
      state.captions[idx].text = e.target.value;
      const counter = e.target.closest('.caption-item').querySelector('.caption-charcount');
      counter.textContent = `${e.target.value.length}字`;
      counter.classList.toggle('over', e.target.value.length > maxChars);
    });
  });

  list.querySelectorAll('.duration-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.index);
      state.captions[idx].duration = parseFloat(e.target.value) || 2;
      document.getElementById('total-duration-display').textContent = `${getTotalDuration().toFixed(1)}s`;
    });
  });

  list.querySelectorAll('.caption-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.index);
      state.captions.splice(idx, 1);
      renderCaptionEditor();
    });
  });
}

function renderImageEditor() {
  const editor = document.getElementById('image-editor');
  editor.innerHTML = '';

  state.captions.forEach((cap, i) => {
    const item = document.createElement('div');
    item.className = 'image-item';

    const motionOptions = MOTION_EFFECTS.map(m =>
      `<option value="${m.value}" ${cap.motion === m.value ? 'selected' : ''}>${m.label}</option>`
    ).join('');

    item.innerHTML = `
      <div class="image-thumb" data-index="${i}">
        ${cap.imageUrl
          ? `<img src="${cap.imageUrl}" alt="テロップ${i + 1}">`
          : '<span class="thumb-placeholder">＋</span>'}
        <input type="file" accept="image/*" data-index="${i}" class="image-file-input">
      </div>
      <div class="image-details">
        <div class="caption-preview">${i + 1}. ${escapeHtml(cap.text)}</div>
        <div class="motion-select">
          <label>モーション：</label>
          <select class="input-select motion-select-input" data-index="${i}">
            ${motionOptions}
          </select>
        </div>
        ${i > 0 ? `
        <label class="use-prev-label">
          <input type="checkbox" class="use-prev-image" data-index="${i}" ${!cap.imageFile && !cap.imageUrl && i > 0 ? '' : ''}>
          前のスライドと同じ画像を使用
        </label>` : ''}
      </div>
    `;
    editor.appendChild(item);
  });

  // Event listeners
  editor.querySelectorAll('.image-file-input').forEach(input => {
    input.addEventListener('change', async (e) => {
      const idx = parseInt(e.target.dataset.index);
      const file = e.target.files[0];
      if (!file) return;

      state.captions[idx].imageFile = file;
      state.captions[idx].imageUrl = URL.createObjectURL(file);
      state.captions[idx].imageBitmap = await createImageBitmap(file);

      renderImageEditor();
    });
  });

  editor.querySelectorAll('.motion-select-input').forEach(select => {
    select.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.index);
      state.captions[idx].motion = e.target.value;
    });
  });

  editor.querySelectorAll('.use-prev-image').forEach(cb => {
    cb.addEventListener('change', async (e) => {
      const idx = parseInt(e.target.dataset.index);
      if (e.target.checked && idx > 0) {
        const prev = state.captions[idx - 1];
        state.captions[idx].imageFile = prev.imageFile;
        state.captions[idx].imageUrl = prev.imageUrl;
        state.captions[idx].imageBitmap = prev.imageBitmap;
        renderImageEditor();
      }
    });
  });
}

function renderPreviewStep() {
  const canvas = document.getElementById('preview-canvas');
  const totalDuration = getTotalDuration();
  document.getElementById('preview-total').textContent = formatTime(totalDuration);
  document.getElementById('preview-current').textContent = '0:00';
  document.getElementById('preview-progress-fill').style.width = '0%';

  // Render first frame
  if (state.captions.length > 0) {
    const scale = canvas.width / CONFIG.canvasWidth;
    renderFrame(canvas, 0, scale);
  }
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
// 11. イベント設定 & 初期化 (Event Setup & Initialization)
// ============================================================
function initApp() {
  // Step navigation
  document.getElementById('next-btn').addEventListener('click', () => {
    if (state.currentStep < 4) showStep(state.currentStep + 1);
  });
  document.getElementById('prev-btn').addEventListener('click', () => {
    if (state.currentStep > 1) showStep(state.currentStep - 1);
  });

  document.querySelectorAll('.step-item').forEach(item => {
    item.addEventListener('click', () => {
      const step = parseInt(item.dataset.step);
      showStep(step);
    });
  });

  // Audio drop zone
  const audioDrop = document.getElementById('audio-drop');
  const audioInput = document.getElementById('audio-input');

  audioDrop.addEventListener('click', () => audioInput.click());
  audioDrop.addEventListener('dragover', (e) => {
    e.preventDefault();
    audioDrop.classList.add('drag-over');
  });
  audioDrop.addEventListener('dragleave', () => audioDrop.classList.remove('drag-over'));
  audioDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    audioDrop.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('audio/')) handleAudioFile(file);
  });
  audioInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleAudioFile(e.target.files[0]);
  });

  // Audio controls
  document.getElementById('silence-threshold').addEventListener('input', (e) => {
    document.getElementById('threshold-value').textContent = e.target.value;
  });
  document.getElementById('silence-min-duration').addEventListener('input', (e) => {
    document.getElementById('duration-value').textContent = `${e.target.value}s`;
  });
  document.getElementById('detect-silence-btn').addEventListener('click', handleDetectSilence);
  document.getElementById('remove-silence-btn').addEventListener('click', handleRemoveSilence);

  // Script split
  document.getElementById('split-btn').addEventListener('click', handleSplitScript);

  // Bulk image upload
  document.getElementById('bulk-image-btn').addEventListener('click', () => {
    document.getElementById('bulk-image-input').click();
  });
  document.getElementById('bulk-image-input').addEventListener('change', handleBulkImageUpload);

  // Preview
  document.getElementById('preview-play-btn').addEventListener('click', startPreview);

  // Export
  document.getElementById('export-mp4-btn').addEventListener('click', exportMP4);
  document.getElementById('export-srt-btn').addEventListener('click', exportSRT);

  // Audio Reset and Change
  document.getElementById('reset-audio-btn').addEventListener('click', handleResetAudio);
  document.getElementById('change-audio-btn').addEventListener('click', handleChangeAudio);
  document.getElementById('cut-selection-btn').addEventListener('click', handleCutSelection);

  // Waveform interaction
  const waveformCanvas = document.getElementById('waveform-canvas');
  waveformCanvas.addEventListener('mousedown', (e) => {
    if (!state.originalAudioBuffer) return;
    const rect = waveformCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const duration = (state.processedAudioBuffer || state.originalAudioBuffer).duration;
    state.selectionStart = (x / rect.width) * duration;
    state.selectionEnd = state.selectionStart;
    state.isSelecting = true;
    updateWaveformWithSelection();
  });

  window.addEventListener('mousemove', (e) => {
    if (!state.isSelecting) return;
    const rect = waveformCanvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const duration = (state.processedAudioBuffer || state.originalAudioBuffer).duration;
    state.selectionEnd = (x / rect.width) * duration;
    updateWaveformWithSelection();
  });

  window.addEventListener('mouseup', () => {
    if (state.isSelecting) {
      state.isSelecting = false;
      if (Math.abs(state.selectionStart - state.selectionEnd) < 0.05) {
        state.selectionStart = null;
        state.selectionEnd = null;
        document.getElementById('cut-selection-btn').style.display = 'none';
      } else {
        document.getElementById('cut-selection-btn').style.display = 'inline-flex';
      }
      updateWaveformWithSelection();
    }
  });

}


async function handleAudioFile(file) {
  state.audioFile = file;
  state.silentSegments = [];

  const audioEl = document.getElementById('audio-element');
  audioEl.src = URL.createObjectURL(file);

  document.getElementById('audio-drop').style.display = 'none';
  document.getElementById('audio-controls').style.display = 'block';
  document.getElementById('change-audio-btn').style.display = 'inline-flex';
  document.getElementById('reset-audio-btn').style.display = 'none';
  document.getElementById('audio-status').textContent = file.name;
  document.getElementById('audio-status').style.background = 'rgba(16,185,129,0.15)';
  document.getElementById('audio-status').style.color = '#10b981';

  try {
    state.originalAudioBuffer = await decodeAudioFile(file);
    state.audioDuration = state.originalAudioBuffer.duration;
    drawWaveform(document.getElementById('waveform-canvas'), state.originalAudioBuffer, []);
    showToast(`音声を読み込みました (${formatTime(state.audioDuration)})`, 'info');
  } catch (err) {
    showToast('音声ファイルの読み込みに失敗しました', 'error');
    console.error(err);
  }
}

function handleDetectSilence() {
  if (!state.originalAudioBuffer) {
    showToast('先に音声ファイルをアップロードしてください', 'info');
    return;
  }

  const threshold = parseFloat(document.getElementById('silence-threshold').value);
  const minDuration = parseFloat(document.getElementById('silence-min-duration').value);

  const buffer = state.processedAudioBuffer || state.originalAudioBuffer;
  state.silentSegments = detectSilence(buffer, threshold, minDuration);

  const totalSilence = state.silentSegments.reduce((s, seg) => s + seg.duration, 0);
  document.getElementById('silence-count').textContent = `検出: ${state.silentSegments.length}区間`;
  document.getElementById('silence-total').textContent = `合計: ${totalSilence.toFixed(1)}s`;

  drawWaveform(document.getElementById('waveform-canvas'), buffer, state.silentSegments);

  if (state.silentSegments.length > 0) {
    document.getElementById('remove-silence-btn').style.display = 'inline-flex';
    showToast(`${state.silentSegments.length}個の無音区間を検出 (${totalSilence.toFixed(1)}s)`, 'info');
  } else {
    document.getElementById('remove-silence-btn').style.display = 'none';
    showToast('無音区間は見つかりませんでした', 'info');
  }
}

function handleRemoveSilence() {
  if (state.silentSegments.length === 0) return;

  const source = state.processedAudioBuffer || state.originalAudioBuffer;
  state.processedAudioBuffer = removeSilence(source, state.silentSegments);
  state.audioDuration = state.processedAudioBuffer.duration;

  // Update audio element
  const audioEl = document.getElementById('audio-element');
  const offlineCtx = new OfflineAudioContext(
    state.processedAudioBuffer.numberOfChannels,
    state.processedAudioBuffer.length,
    state.processedAudioBuffer.sampleRate
  );
  const bufferSource = offlineCtx.createBufferSource();
  bufferSource.buffer = state.processedAudioBuffer;
  bufferSource.connect(offlineCtx.destination);
  bufferSource.start();
  offlineCtx.startRendering().then(renderedBuffer => {
    const wavBlob = audioBufferToWav(renderedBuffer);
    audioEl.src = URL.createObjectURL(wavBlob);
  });

  state.silentSegments = [];
  drawWaveform(document.getElementById('waveform-canvas'), state.processedAudioBuffer, []);
  document.getElementById('remove-silence-btn').style.display = 'none';
  document.getElementById('silence-count').textContent = '検出: 0区間';
  document.getElementById('silence-total').textContent = '合計: 0.0s';

  showToast(`無音カット完了！ 新しい長さ: ${formatTime(state.audioDuration)}`, 'success');
}

function audioBufferToWav(buffer) {
  const length = buffer.length;
  const numberOfChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = 2;
  const dataLength = length * numberOfChannels * bytesPerSample;
  const headerLength = 44;
  const totalLength = headerLength + dataLength;
  const arrayBuffer = new ArrayBuffer(totalLength);
  const view = new DataView(arrayBuffer);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  writeString(0, 'RIFF');
  view.setUint32(4, totalLength - 8, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numberOfChannels * bytesPerSample, true);
  view.setUint16(32, numberOfChannels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = headerLength;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(offset, sample * 0x7FFF, true);
      offset += bytesPerSample;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function handleSplitScript() {
  const text = document.getElementById('script-input').value.trim();
  if (!text) {
    showToast('スクリプトを入力してください', 'info');
    return;
  }

  const maxChars = parseInt(document.getElementById('max-chars').value) || CONFIG.maxCharsPerCaption;
  const texts = splitScript(text, maxChars);

  // Auto-calculate durations
  const audioBuffer = state.processedAudioBuffer || state.originalAudioBuffer;
  const audioDuration = audioBuffer ? audioBuffer.duration : 0;
  const totalChars = texts.reduce((s, t) => s + t.length, 0);

  state.captions = texts.map(t => {
    let dur;
    if (audioDuration > 0 && totalChars > 0) {
      dur = (t.length / totalChars) * audioDuration;
    } else {
      dur = Math.min(Math.max(t.length * CONFIG.charDurationSec, CONFIG.minCaptionDuration), CONFIG.maxCaptionDuration);
    }
    dur = Math.round(dur * 10) / 10;

    return {
      text: t,
      duration: dur,
      imageFile: null,
      imageUrl: null,
      imageBitmap: null,
      motion: 'none',
    };
  });

  showToast(`${state.captions.length}個のテロップに分割しました`, 'success');
  showStep(2);
}

async function handleBulkImageUpload(e) {
  const files = Array.from(e.target.files);
  if (files.length === 0) return;

  for (let i = 0; i < files.length && i < state.captions.length; i++) {
    state.captions[i].imageFile = files[i];
    state.captions[i].imageUrl = URL.createObjectURL(files[i]);
    state.captions[i].imageBitmap = await createImageBitmap(files[i]);
  }

  // If fewer images than captions, fill remaining with last image
  if (files.length < state.captions.length && files.length > 0) {
    const lastIdx = files.length - 1;
    for (let i = files.length; i < state.captions.length; i++) {
      state.captions[i].imageFile = state.captions[lastIdx].imageFile;
      state.captions[i].imageUrl = state.captions[lastIdx].imageUrl;
      state.captions[i].imageBitmap = state.captions[lastIdx].imageBitmap;
    }
  }

  renderImageEditor();
  showToast(`${files.length}枚の画像をアップロードしました`, 'success');
}

function updateWaveformWithSelection() {
  const buffer = state.processedAudioBuffer || state.originalAudioBuffer;
  if (buffer) {
    drawWaveform(document.getElementById('waveform-canvas'), buffer, state.silentSegments);
  }
}

async function handleCutSelection() {
  if (state.selectionStart === null || state.selectionEnd === null) return;
  
  const start = Math.min(state.selectionStart, state.selectionEnd);
  const end = Math.max(state.selectionStart, state.selectionEnd);
  
  const source = state.processedAudioBuffer || state.originalAudioBuffer;
  state.processedAudioBuffer = removeBufferRange(source, start, end);
  state.audioDuration = state.processedAudioBuffer.duration;

  // Clear selection
  state.selectionStart = null;
  state.selectionEnd = null;
  document.getElementById('cut-selection-btn').style.display = 'none';
  document.getElementById('reset-audio-btn').style.display = 'inline-flex';

  await updateAudioElement(state.processedAudioBuffer);
  drawWaveform(document.getElementById('waveform-canvas'), state.processedAudioBuffer, []);
  
  showToast(`選択範囲をカットしました (${(end - start).toFixed(1)}s)`, 'success');
}

function handleResetAudio() {
  if (!state.originalAudioBuffer) return;
  
  state.processedAudioBuffer = null;
  state.audioDuration = state.originalAudioBuffer.duration;
  state.silentSegments = [];
  state.selectionStart = null;
  state.selectionEnd = null;
  
  updateAudioElement(state.originalAudioBuffer);
  drawWaveform(document.getElementById('waveform-canvas'), state.originalAudioBuffer, []);
  
  document.getElementById('reset-audio-btn').style.display = 'none';
  document.getElementById('cut-selection-btn').style.display = 'none';
  document.getElementById('remove-silence-btn').style.display = 'none';
  document.getElementById('silence-count').textContent = '検出: 0区間';
  document.getElementById('silence-total').textContent = '合計: 0.0s';
  
  showToast('編集をリセットしました', 'info');
}

function handleChangeAudio() {
  state.audioFile = null;
  state.originalAudioBuffer = null;
  state.processedAudioBuffer = null;
  state.audioDuration = 0;
  state.silentSegments = [];
  state.selectionStart = null;
  state.selectionEnd = null;

  document.getElementById('audio-element').src = '';
  document.getElementById('audio-drop').style.display = 'flex';
  document.getElementById('audio-controls').style.display = 'none';
  document.getElementById('change-audio-btn').style.display = 'none';
  document.getElementById('audio-status').textContent = '未アップロード';
  document.getElementById('audio-status').style.background = '';
  document.getElementById('audio-status').style.color = '';
  
  showToast('音声をクリアしました', 'info');
}

async function updateAudioElement(audioBuffer) {
  const audioEl = document.getElementById('audio-element');
  const offlineCtx = new OfflineAudioContext(
    audioBuffer.numberOfChannels,
    audioBuffer.length,
    audioBuffer.sampleRate
  );
  const bufferSource = offlineCtx.createBufferSource();
  bufferSource.buffer = audioBuffer;
  bufferSource.connect(offlineCtx.destination);
  bufferSource.start();
  const renderedBuffer = await offlineCtx.startRendering();
  const wavBlob = audioBufferToWav(renderedBuffer);
  audioEl.src = URL.createObjectURL(wavBlob);
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  // Wait for fonts to load before initializing
  document.fonts.ready.then(() => {
    initApp();
    showToast('リール動画エディタへようこそ！', 'info');
  });
});

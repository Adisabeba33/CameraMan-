// Снимки и запись видео прямо с канваса эффекта.

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function pickMime() {
  const list = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  return list.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
}

export class Capture {
  constructor(canvas) {
    this.canvas = canvas;
    this.shots = [];       // { url, blob, kind, name }
    this.recorder = null;
    this.chunks = [];
    this.startedAt = 0;
    this.onChange = () => {};
  }

  get recording() { return !!this.recorder && this.recorder.state === 'recording'; }

  async photo(modeId, source = this.canvas) {
    const blob = await new Promise((res) => source.toBlob(res, 'image/png'));
    if (!blob) throw new Error('Не удалось получить кадр');
    return this._add(blob, 'photo', `chrono-${modeId}-${stamp()}.png`);
  }

  startRecording(modeId, fps = 30) {
    const mime = pickMime();
    if (!window.MediaRecorder) throw new Error('Запись видео не поддерживается браузером');
    const stream = this.canvas.captureStream(fps);
    this.chunks = [];
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : undefined);
    rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    rec.onstop = () => {
      const type = mime || 'video/webm';
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const blob = new Blob(this.chunks, { type });
      this.chunks = [];
      this.recorder = null;
      stream.getTracks().forEach((t) => t.stop());
      if (blob.size) this._add(blob, 'video', `chrono-${modeId}-${stamp()}.${ext}`);
      this.onChange();
    };
    rec.start(250);
    this.recorder = rec;
    this.startedAt = performance.now();
  }

  stopRecording() {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
  }

  elapsed() {
    return this.recording ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  _add(blob, kind, name) {
    const item = { blob, kind, name, url: URL.createObjectURL(blob) };
    this.shots.unshift(item);
    while (this.shots.length > 30) URL.revokeObjectURL(this.shots.pop().url);
    this.onChange();
    return item;
  }

  download(item) {
    const a = document.createElement('a');
    a.href = item.url;
    a.download = item.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async share(item) {
    const file = new File([item.blob], item.name, { type: item.blob.type });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Хроно-камера' });
        return true;
      } catch { /* пользователь отменил */ }
    }
    return false;
  }
}

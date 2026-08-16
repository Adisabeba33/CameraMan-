// Работа с камерой: запуск потока, список устройств, переключение.

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.devices = [];
    this.deviceId = null;
    this.facing = 'user';
    this.onFrame = null;
    this._vfc = null;
  }

  async start({ deviceId = null, facing = null, width = 1280 } = {}) {
    this.stop();
    // все ограничения — мягкие: разные камеры поддерживают очень разные наборы
    const video = {
      width: { ideal: width },
      height: { ideal: Math.round((width * 9) / 16) },
      frameRate: { ideal: 60 },
    };
    if (deviceId) video.deviceId = { exact: deviceId };
    else if (facing) video.facingMode = { ideal: facing };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      if (e?.name === 'NotAllowedError') throw e;
      // упрощаем запрос и пробуем ещё раз — лучше любая камера, чем никакой
      const fallback = deviceId ? { deviceId: { exact: deviceId } } : true;
      stream = await navigator.mediaDevices.getUserMedia({ video: fallback, audio: false });
    }

    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};
    this.deviceId = settings.deviceId || deviceId || null;
    this.facing = settings.facingMode || facing || this.facing;

    this.video.srcObject = stream;
    await this.video.play().catch(() => {});
    await this.refreshDevices();
    this._watchFrames();
    return { width: settings.width, height: settings.height, label: track.label };
  }

  /** Сообщает о каждом новом кадре камеры (важно для честной «оси времени»). */
  _watchFrames() {
    const v = this.video;
    if (typeof v.requestVideoFrameCallback !== 'function') {
      // запасной путь: считаем каждый кадр анимации новым
      this._vfc = null;
      return;
    }
    if (this._vfc !== null) v.cancelVideoFrameCallback?.(this._vfc);
    const own = this.stream; // цикл живёт ровно столько, сколько его поток
    const tick = () => {
      if (this.stream !== own) return;
      this.onFrame?.();
      this._vfc = v.requestVideoFrameCallback(tick);
    };
    this._vfc = v.requestVideoFrameCallback(tick);
  }

  get tracksFrames() {
    return typeof this.video.requestVideoFrameCallback === 'function';
  }

  async refreshDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      this.devices = all.filter((d) => d.kind === 'videoinput');
    } catch { /* доступ к списку может быть закрыт — не критично */ }
  }

  async next() {
    if (this.devices.length > 1) {
      const i = this.devices.findIndex((d) => d.deviceId === this.deviceId);
      const d = this.devices[(i + 1) % this.devices.length];
      const res = await this.start({ deviceId: d.deviceId });
      this.facing = /back|rear|environment/i.test(d.label) ? 'environment' : 'user';
      return res;
    }
    const facing = this.facing === 'user' ? 'environment' : 'user';
    return this.start({ facing });
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

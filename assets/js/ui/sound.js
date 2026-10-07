/** Tiny WebAudio chimes for fills and alerts (opt-in, no audio files). */
let ctx = null;

export function chime(kind = 'fill') {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const notes = kind === 'alert' ? [880, 1175] : kind === 'sell' ? [660, 523] : [523, 784];
    const t0 = ctx.currentTime;
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      const t = t0 + i * 0.09;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.25);
    });
  } catch {
    /* audio unavailable */
  }
}

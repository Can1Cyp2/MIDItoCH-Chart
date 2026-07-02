/**
 * Minimal Web Audio melody player for the vocals timeline. Plays each note at
 * its pitch for its real duration using a look-ahead scheduler, so the melody
 * can be auditioned even when no reference song audio is loaded.
 *
 * The transport clock is the AudioContext's own clock, so the playhead the UI
 * derives from getTime() stays sample-accurate with what you hear.
 */

interface SynthNote {
  time: number
  duration: number
  midi: number
}

type AudioContextCtor = typeof AudioContext

function getAudioContextCtor(): AudioContextCtor | null {
  const w = window as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

const LOOKAHEAD_SEC = 0.12
const TICK_MS = 25
const PEAK_GAIN = 0.16

export class MelodySynth {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private volume = 0.9
  private playbackRate = 1
  private notes: SynthNote[] = []
  private endPos = 0

  private playing = false
  private startPos = 0
  private startCtxTime = 0
  private pausedPos = 0
  private nextIndex = 0

  private active: OscillatorNode[] = []
  private timer: number | null = null

  /** Called when playback runs past the end of the melody. */
  onEnded: (() => void) | null = null

  setNotes(notes: SynthNote[]): void {
    this.notes = [...notes].sort((a, b) => a.time - b.time)
    this.endPos = this.notes.reduce((max, n) => Math.max(max, n.time + n.duration), 0)
    if (this.playing) {
      // Re-seat the scheduler pointer against the edited note list.
      const now = this.getTime()
      this.nextIndex = this.firstIndexAtOrAfter(now)
    }
  }

  get isPlaying(): boolean {
    return this.playing
  }

  getTime(): number {
    if (!this.playing || !this.ctx) {
      return this.pausedPos
    }
    return this.startPos + (this.ctx.currentTime - this.startCtxTime) * this.playbackRate
  }

  private ensureCtx(): AudioContext | null {
    if (!this.ctx) {
      const Ctor = getAudioContextCtor()
      if (!Ctor) {
        return null
      }
      this.ctx = new Ctor()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.volume
      this.master.connect(this.ctx.destination)
    }
    return this.ctx
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value))
    if (this.master) {
      this.master.gain.value = this.volume
    }
  }

  setPlaybackRate(value: number): void {
    const nextRate = Math.max(0.25, Math.min(1.25, value))
    if (nextRate === this.playbackRate) {
      return
    }

    const currentPos = this.getTime()
    this.playbackRate = nextRate

    if (this.playing && this.ctx) {
      this.startPos = currentPos
      this.startCtxTime = this.ctx.currentTime
      this.nextIndex = this.firstIndexAtOrAfter(currentPos)
      this.stopActiveVoices()
    }
  }

  private firstIndexAtOrAfter(pos: number): number {
    const index = this.notes.findIndex((n) => n.time >= pos)
    return index < 0 ? this.notes.length : index
  }

  play(fromPos?: number): void {
    const ctx = this.ensureCtx()
    if (!ctx) {
      return
    }
    void ctx.resume()
    this.startPos = fromPos ?? this.pausedPos
    this.startCtxTime = ctx.currentTime
    this.nextIndex = this.firstIndexAtOrAfter(this.startPos)
    this.playing = true
    this.tick()
    this.timer = window.setInterval(() => this.tick(), TICK_MS)
  }

  playPreviewNote(midi: number, duration = 0.55): void {
    const ctx = this.ensureCtx()
    if (!ctx) {
      return
    }
    void ctx.resume()
    this.scheduleVoice(midi, ctx.currentTime, Math.max(0.08, duration))
  }

  pause(): void {
    if (!this.playing) {
      return
    }
    this.pausedPos = this.getTime()
    this.stopTransport()
  }

  seek(pos: number): void {
    const wasPlaying = this.playing
    this.stopActiveVoices()
    this.pausedPos = Math.max(0, pos)
    if (wasPlaying) {
      this.play(this.pausedPos)
    }
  }

  dispose(): void {
    this.stopTransport()
    void this.ctx?.close()
    this.ctx = null
  }

  private tick(): void {
    const ctx = this.ctx
    if (!this.playing || !ctx) {
      return
    }
    const now = this.getTime()
    const rate = Math.max(0.01, this.playbackRate)
    while (
      this.nextIndex < this.notes.length &&
      this.notes[this.nextIndex].time < now + LOOKAHEAD_SEC * rate
    ) {
      const note = this.notes[this.nextIndex]
      const when = Math.max(ctx.currentTime, this.startCtxTime + (note.time - this.startPos) / rate)
      this.scheduleVoice(note.midi, when, Math.max(0.06, note.duration / rate))
      this.nextIndex += 1
    }

    if (now > this.endPos + 0.25) {
      this.stopTransport()
      this.pausedPos = 0
      this.onEnded?.()
    }
  }

  private scheduleVoice(midi: number, when: number, duration: number): void {
    const ctx = this.ctx
    if (!ctx) {
      return
    }
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12)

    const release = Math.min(0.08, duration * 0.4)
    gain.gain.setValueAtTime(0, when)
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, when + 0.012)
    gain.gain.setValueAtTime(PEAK_GAIN, when + Math.max(0.012, duration - release))
    gain.gain.linearRampToValueAtTime(0, when + duration)

    osc.connect(gain)
    gain.connect(this.master ?? ctx.destination)
    osc.start(when)
    osc.stop(when + duration + 0.02)

    this.active.push(osc)
    osc.onended = () => {
      this.active = this.active.filter((o) => o !== osc)
    }
  }

  private stopActiveVoices(): void {
    this.active.forEach((osc) => {
      try {
        osc.stop()
      } catch {
        // already stopped
      }
    })
    this.active = []
  }

  private stopTransport(): void {
    this.playing = false
    if (this.timer != null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
    this.stopActiveVoices()
  }
}

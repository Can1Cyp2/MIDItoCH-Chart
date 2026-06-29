/**
 * Client-side audio analysis for the vocals timeline — all in-browser via the
 * Web Audio API (no dependencies, no server), so it works on static hosting.
 *
 *  - decodeAudio:  file -> AudioBuffer
 *  - computePeaks: AudioBuffer -> min/max envelope buckets for waveform drawing
 *  - detectBpm:    AudioBuffer -> estimated tempo (offline low-pass + peak
 *                  interval histogram). Good on strong-beat mixes, unreliable
 *                  on bare vocal stems, so callers treat it as a suggestion.
 */

export interface WavePeaks {
  min: Float32Array
  max: Float32Array
  bucketsPerSec: number
  duration: number
}

type AudioContextCtor = typeof AudioContext
type OfflineAudioContextCtor = typeof OfflineAudioContext

function getAudioContextCtor(): AudioContextCtor | null {
  const w = window as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

function getOfflineCtor(): OfflineAudioContextCtor | null {
  const w = window as unknown as {
    OfflineAudioContext?: OfflineAudioContextCtor
    webkitOfflineAudioContext?: OfflineAudioContextCtor
  }
  return w.OfflineAudioContext ?? w.webkitOfflineAudioContext ?? null
}

export async function decodeAudio(file: File): Promise<AudioBuffer> {
  const Ctor = getAudioContextCtor()
  if (!Ctor) {
    throw new Error('Web Audio API is not available in this browser.')
  }
  const arrayBuffer = await file.arrayBuffer()
  const ctx = new Ctor()
  try {
    return await ctx.decodeAudioData(arrayBuffer)
  } finally {
    void ctx.close()
  }
}

/** Downsample to min/max envelope buckets for cheap, aligned waveform drawing. */
export function computePeaks(buffer: AudioBuffer, bucketsPerSec = 400): WavePeaks {
  const channel = buffer.numberOfChannels > 0 ? buffer.getChannelData(0) : new Float32Array()
  const samplesPerBucket = Math.max(1, Math.floor(buffer.sampleRate / bucketsPerSec))
  const bucketCount = Math.max(1, Math.ceil(channel.length / samplesPerBucket))
  const min = new Float32Array(bucketCount)
  const max = new Float32Array(bucketCount)

  for (let b = 0; b < bucketCount; b += 1) {
    const start = b * samplesPerBucket
    const end = Math.min(channel.length, start + samplesPerBucket)
    let lo = 1
    let hi = -1
    for (let i = start; i < end; i += 1) {
      const v = channel[i]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    min[b] = lo
    max[b] = hi
  }

  return { min, max, bucketsPerSec, duration: buffer.duration }
}

interface Peak {
  position: number
  volume: number
}

/** Loudest sample in each half-second window, then keep the strongest half. */
function getPeaks(data: Float32Array, sampleRate: number): Peak[] {
  const partSize = Math.floor(sampleRate / 2)
  if (partSize <= 0) {
    return []
  }
  const parts = Math.floor(data.length / partSize)
  const peaks: Peak[] = []

  for (let part = 0; part < parts; part += 1) {
    let best: Peak | null = null
    for (let i = part * partSize; i < (part + 1) * partSize; i += 1) {
      const volume = Math.abs(data[i])
      if (!best || volume > best.volume) {
        best = { position: i, volume }
      }
    }
    if (best) {
      peaks.push(best)
    }
  }

  peaks.sort((a, b) => b.volume - a.volume)
  const strongest = peaks.slice(0, Math.max(1, Math.floor(peaks.length * 0.5)))
  strongest.sort((a, b) => a.position - b.position)
  return strongest
}

interface TempoCount {
  tempo: number
  count: number
}

/** Histogram peak-to-peak intervals, fold into a sane BPM range, rank by count. */
function intervalsToTempos(peaks: Peak[], sampleRate: number): TempoCount[] {
  const tempoCounts: TempoCount[] = []

  peaks.forEach((peak, index) => {
    for (let lookahead = 1; lookahead < 10 && index + lookahead < peaks.length; lookahead += 1) {
      const interval = peaks[index + lookahead].position - peak.position
      if (interval <= 0) {
        continue
      }
      let tempo = 60 / (interval / sampleRate)
      while (tempo < 90) tempo *= 2
      while (tempo > 180) tempo /= 2
      tempo = Math.round(tempo)
      const existing = tempoCounts.find((t) => t.tempo === tempo)
      if (existing) {
        existing.count += 1
      } else {
        tempoCounts.push({ tempo, count: 1 })
      }
    }
  })

  tempoCounts.sort((a, b) => b.count - a.count)
  return tempoCounts
}

/** Estimate BPM offline. Returns null if it cannot be determined. */
export async function detectBpm(buffer: AudioBuffer): Promise<number | null> {
  const Offline = getOfflineCtor()
  if (!Offline || buffer.length === 0) {
    return null
  }

  const offline = new Offline(1, buffer.length, buffer.sampleRate)
  const source = offline.createBufferSource()
  source.buffer = buffer

  // Emphasize the rhythmic low end (kick/bass) and strip sub-rumble.
  const lowpass = offline.createBiquadFilter()
  lowpass.type = 'lowpass'
  lowpass.frequency.value = 150
  lowpass.Q.value = 1

  const highpass = offline.createBiquadFilter()
  highpass.type = 'highpass'
  highpass.frequency.value = 90
  highpass.Q.value = 1

  source.connect(lowpass)
  lowpass.connect(highpass)
  highpass.connect(offline.destination)
  source.start(0)

  const rendered = await offline.startRendering()
  const peaks = getPeaks(rendered.getChannelData(0), rendered.sampleRate)
  const tempos = intervalsToTempos(peaks, rendered.sampleRate)
  return tempos.length > 0 ? tempos[0].tempo : null
}

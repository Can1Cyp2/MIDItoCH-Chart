/**
 * Merge a converted instrument chart (drums / guitar / bass) with the edited
 * vocal chart into a single RB/YARG-style `notes.mid`.
 *
 * v1 assumes the instruments and vocals share the same song tempo (the same
 * MIDI/GP source). The instrument notes keep their native ticks; the vocal
 * notes are given in real seconds and converted to ticks against the
 * instrument's tempo map, so both land at the correct times in one timebase.
 */

import {
  assembleMidi,
  midiMetaEvent,
  midiTextBytes,
  tempoTrackEvents,
  vocalsTrackEvents,
  type TimedEvent,
  type VocalNote,
} from './vocalsChart'

export type MergeInstrument = 'drums' | 'guitar' | 'bass'

export interface MergeInstrumentNote {
  tick: number
  length: number
  lane: 0 | 1 | 2 | 3 | 4
  cymbal: boolean
  openHiHat: boolean
}

/** A vocal note positioned in real seconds (already aligned to the song). */
export interface MergeVocalNote {
  time: number
  duration: number
  midi: number
  lyric: string
}

export interface MergeMidiInput {
  ppq: number
  tempos: Array<{ ticks: number; bpm: number }>
  timeSignatures: Array<{ ticks: number; numerator: number; denominator: number }>
  instrument: MergeInstrument
  instrumentNotes: MergeInstrumentNote[]
  vocalNotes: MergeVocalNote[]
}

const TRACK_NAMES: Record<MergeInstrument, string> = {
  drums: 'PART DRUMS',
  guitar: 'PART GUITAR',
  bass: 'PART BASS',
}

// Expert gem lane -> MIDI note (RB/CH convention: 96..100).
const EXPERT_BASE = 96
// Pro-drums cymbal markers for yellow/blue/green.
const CYMBAL_MARKER: Record<number, number> = { 2: 110, 3: 111, 4: 112 }

/** Convert a time in seconds to ticks against a tempo map (handles changes). */
export function secondsToTicks(
  seconds: number,
  ppq: number,
  tempos: Array<{ ticks: number; bpm: number }>,
): number {
  const sorted = [...tempos].sort((a, b) => a.ticks - b.ticks)
  if (sorted.length === 0 || sorted[0].ticks > 0) {
    sorted.unshift({ ticks: 0, bpm: sorted[0]?.bpm ?? 120 })
  }
  let elapsed = 0
  for (let i = 0; i < sorted.length; i += 1) {
    const seg = sorted[i]
    const next = sorted[i + 1]
    const secPerTick = 60 / (seg.bpm * ppq)
    if (next) {
      const segSeconds = (next.ticks - seg.ticks) * secPerTick
      if (seconds <= elapsed + segSeconds) {
        return Math.round(seg.ticks + (seconds - elapsed) / secPerTick)
      }
      elapsed += segSeconds
    } else {
      return Math.round(seg.ticks + (seconds - elapsed) / secPerTick)
    }
  }
  return 0
}

function instrumentTrackEvents(instrument: MergeInstrument, notes: MergeInstrumentNote[]): TimedEvent[] {
  const events: TimedEvent[] = [
    { ticks: 0, order: 0, bytes: midiMetaEvent(0x03, midiTextBytes(TRACK_NAMES[instrument])) },
  ]
  for (const note of notes) {
    const pitch = EXPERT_BASE + note.lane
    const end = note.tick + Math.max(1, note.length || 1)
    events.push({ ticks: note.tick, order: 2, bytes: [0x90, pitch, 100] })
    events.push({ ticks: end, order: 1, bytes: [0x80, pitch, 0] })

    if (instrument === 'drums' && note.cymbal && CYMBAL_MARKER[note.lane]) {
      const marker = CYMBAL_MARKER[note.lane]
      events.push({ ticks: note.tick, order: 2, bytes: [0x90, marker, 100] })
      events.push({ ticks: end, order: 1, bytes: [0x80, marker, 0] })
    }
  }
  return events
}

/** Build a format-1 SMF with a tempo map, one instrument track, and PART VOCALS. */
export function buildMergedMidi(input: MergeMidiInput): Uint8Array {
  const { ppq, tempos } = input

  const vocalNotes: VocalNote[] = input.vocalNotes.map((note, index) => {
    const startTick = secondsToTicks(Math.max(0, note.time), ppq, tempos)
    const endTick = secondsToTicks(Math.max(0, note.time + note.duration), ppq, tempos)
    return {
      id: `merge-vox-${index}`,
      ticks: startTick,
      durationTicks: Math.max(1, endTick - startTick),
      time: note.time,
      duration: note.duration,
      midi: note.midi,
      lyric: note.lyric,
    }
  })

  return assembleMidi(ppq, [
    tempoTrackEvents(tempos, input.timeSignatures),
    instrumentTrackEvents(input.instrument, input.instrumentNotes),
    vocalsTrackEvents(vocalNotes, ppq),
  ])
}

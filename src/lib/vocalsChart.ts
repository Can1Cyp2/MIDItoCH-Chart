import { Midi } from '@tonejs/midi'
import { parseMidi } from 'midi-file'

/**
 * Vocals charting for YARG / Rock Band style `PART VOCALS` tracks.
 *
 * Path A (implemented here): take a vocal-melody MIDI plus plain lyrics text,
 * map syllables onto the melody notes, and export a Standard MIDI File whose
 * `PART VOCALS` track carries pitched notes, per-note lyric events, and phrase
 * markers. We read MIDI with @tonejs/midi but hand-write the export, because
 * @tonejs/midi cannot emit per-track lyric meta events at specific ticks.
 *
 * YARG/RB lyric conventions used here:
 *   - a syllable that continues a word ends with `-`
 *   - `+`  connects/slides from the previous note (held / melisma)
 *   - `#`  non-pitched ("talky"), `^` lenient non-pitched (left to manual edits)
 *   - phrase markers are note 105 covering each sung phrase
 */

export const VOCALS_PHRASE_NOTE = 105
export const VOCALS_MIN_PITCH = 36
export const VOCALS_MAX_PITCH = 84

export interface VocalNote {
  id: string
  ticks: number
  durationTicks: number
  /** Start time in seconds (for audio overlay / playback). */
  time: number
  /** Duration in seconds. */
  duration: number
  midi: number
  /** Lyric token for this note, including any `-`/`+` connectors. '' = unset. */
  lyric: string
}

export interface ParsedMidiTrack {
  index: number
  name: string
  noteCount: number
  /** RB/YARG marker notes (phrase 105/106, overdrive 116, etc.) dropped on import. */
  markersIgnored: number
  notes: VocalNote[]
}

/**
 * Notes at or above this pitch in a vocals MIDI are control markers, not sung
 * pitches: phrase markers (105 = A7, 106), overdrive (116), and percussion. We
 * drop them on import and emit fresh phrase markers on export.
 */
const VOCAL_MARKER_FLOOR = 96

export interface ParsedVocalMidi {
  fileName: string
  ppq: number
  tempos: Array<{ ticks: number; bpm: number }>
  timeSignatures: Array<{ ticks: number; numerator: number; denominator: number }>
  tracks: ParsedMidiTrack[]
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export function midiToNoteName(midi: number): string {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 1
  return `${name}${octave}`
}

/**
 * Read existing lyric events from the raw MIDI, keyed by absolute tick, so
 * imported charts that already have lyrics keep them. @tonejs/midi only surfaces
 * meta events from track 0, so we parse with midi-file to catch lyrics on the
 * vocal track. Falls back to text events if no lyric events are present.
 */
function buildLyricMap(buffer: ArrayBuffer): Map<number, string> {
  const map = new Map<number, string>()
  let raw: ReturnType<typeof parseMidi>
  try {
    raw = parseMidi(new Uint8Array(buffer))
  } catch {
    return map
  }
  const collect = (type: 'lyrics' | 'text') => {
    for (const track of raw.tracks) {
      let tick = 0
      for (const event of track) {
        tick += event.deltaTime
        const text = (event as { text?: string }).text
        if (event.type === type && typeof text === 'string' && text.length > 0 && !map.has(tick)) {
          map.set(tick, text)
        }
      }
    }
  }
  collect('lyrics')
  if (map.size === 0) {
    collect('text')
  }
  return map
}

/** Parse a MIDI file into per-track note lists for vocal melody selection. */
export async function parseVocalMidi(file: File): Promise<ParsedVocalMidi> {
  const buffer = await file.arrayBuffer()
  const midi = new Midi(buffer)
  const lyricByTick = buildLyricMap(buffer)

  const tracks: ParsedMidiTrack[] = midi.tracks
    .map((track, index) => {
      const sung = track.notes.filter((note) => note.midi < VOCAL_MARKER_FLOOR)
      const markersIgnored = track.notes.length - sung.length
      const notes: VocalNote[] = sung
        .map((note) => ({
          id: `n-${index}-${note.ticks}-${note.midi}`,
          ticks: note.ticks,
          durationTicks: Math.max(1, note.durationTicks),
          time: note.time,
          duration: Math.max(0.05, note.duration),
          midi: note.midi,
          lyric: lyricByTick.get(note.ticks) ?? '',
        }))
        .sort((a, b) => a.ticks - b.ticks || a.midi - b.midi)
      return {
        index,
        name: track.name?.trim() || `Track ${index + 1}`,
        noteCount: notes.length,
        markersIgnored,
        notes,
      }
    })
    .filter((track) => track.noteCount > 0)

  return {
    fileName: file.name,
    ppq: midi.header.ppq,
    tempos: midi.header.tempos.map((t) => ({ ticks: t.ticks, bpm: t.bpm })),
    timeSignatures: midi.header.timeSignatures.map((ts) => ({
      ticks: ts.ticks,
      numerator: ts.timeSignature[0],
      denominator: ts.timeSignature[1],
    })),
    tracks,
  }
}

interface Syllable {
  text: string
  /** True when this is the last syllable of its word (a space follows). */
  wordEnd: boolean
  /** True when this syllable ends a lyric line (phrase boundary). */
  lineEnd: boolean
}

const VOWELS = 'aeiouy'

/** Heuristic English syllable split for a single word (no whitespace). */
function syllabifyWord(word: string, autoSplit: boolean): string[] {
  // Respect explicit hyphenation the user typed, e.g. "hel-lo".
  if (word.includes('-')) {
    return word.split('-').filter(Boolean)
  }

  // Auto-splitting off: keep each word as a single syllable.
  if (!autoSplit) {
    return [word]
  }

  const lower = word.toLowerCase()
  const letters = [...word]
  // Find vowel-group boundaries; each syllable carries roughly one vowel group.
  const groups: number[] = [] // index where each new vowel group starts
  let inVowel = false
  for (let i = 0; i < lower.length; i += 1) {
    const isVowel = VOWELS.includes(lower[i])
    if (isVowel && !inVowel) {
      groups.push(i)
    }
    inVowel = isVowel
  }

  if (groups.length <= 1) {
    return [word]
  }

  // Split between vowel groups: cut before the consonant that precedes the
  // next vowel group (leaves at least one consonant with the following group).
  const cuts: number[] = []
  for (let g = 1; g < groups.length; g += 1) {
    const vowelStart = groups[g]
    let cut = vowelStart
    // Walk back over consonants between the two vowel groups, keep one ahead.
    while (cut - 1 > groups[g - 1] && !VOWELS.includes(lower[cut - 1])) {
      cut -= 1
    }
    if (cut > (cuts[cuts.length - 1] ?? 0) && cut < letters.length) {
      cuts.push(cut)
    }
  }

  if (cuts.length === 0) {
    return [word]
  }

  const parts: string[] = []
  let start = 0
  for (const cut of cuts) {
    parts.push(letters.slice(start, cut).join(''))
    start = cut
  }
  parts.push(letters.slice(start).join(''))
  return parts.filter(Boolean)
}

/**
 * Turn pasted plain lyrics into an ordered syllable list with phrase info.
 * When `autoSplit` is false, words are kept whole unless the user typed dashes.
 */
export function syllabifyLyrics(raw: string, autoSplit = true): Syllable[] {
  const lines = raw.split(/\r?\n/)
  const syllables: Syllable[] = []

  lines.forEach((line) => {
    const words = line
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    if (words.length === 0) {
      return
    }
    words.forEach((word) => {
      const parts = syllabifyWord(word, autoSplit)
      parts.forEach((part, partIndex) => {
        syllables.push({
          text: part,
          wordEnd: partIndex === parts.length - 1,
          lineEnd: false,
        })
      })
    })
    // Mark the last syllable produced for this line as a phrase boundary.
    const last = syllables[syllables.length - 1]
    if (last) {
      last.lineEnd = true
    }
  })

  return syllables
}

/** Format a syllable into its YARG lyric token (adds `-` mid-word). */
function syllableToken(syllable: Syllable): string {
  return syllable.wordEnd ? syllable.text : `${syllable.text}-`
}

/** Full ordered list of formatted lyric tokens for the given lyrics text. */
export function lyricTokens(raw: string, autoSplit = true): string[] {
  return syllabifyLyrics(raw, autoSplit).map(syllableToken)
}

export interface AlignmentResult {
  notes: VocalNote[]
  /** Formatted tokens that did not fit (more syllables than notes), in order. */
  leftoverTokens: string[]
  /** Notes past the last syllable, auto-marked as `+` slides. */
  slideNotes: number
}

/**
 * Assign syllables to melody notes in order. Extra notes beyond the lyrics are
 * marked `+` (held/slide); extra syllables beyond the notes are returned as
 * leftover tokens so the editor can flow them back in when notes shift.
 */
export function alignLyricsToNotes(notes: VocalNote[], syllables: Syllable[]): AlignmentResult {
  const aligned = notes.map((note) => ({ ...note }))
  let slideNotes = 0

  for (let i = 0; i < aligned.length; i += 1) {
    if (i < syllables.length) {
      aligned[i].lyric = syllableToken(syllables[i])
    } else {
      // Out of syllables: treat remaining notes as held/slide.
      aligned[i].lyric = '+'
      slideNotes += 1
    }
  }

  return {
    notes: aligned,
    leftoverTokens: syllables.slice(notes.length).map(syllableToken),
    slideNotes,
  }
}

// ---------------------------------------------------------------------------
// Standard MIDI File writer
// ---------------------------------------------------------------------------

function variableLengthQuantity(value: number): number[] {
  let v = Math.max(0, Math.round(value))
  const bytes = [v & 0x7f]
  v >>= 7
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80)
    v >>= 7
  }
  return bytes
}

function stringBytes(text: string): number[] {
  const out: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    out.push(text.charCodeAt(i) & 0xff)
  }
  return out
}

function metaEvent(type: number, data: number[]): number[] {
  return [0xff, type, ...variableLengthQuantity(data.length), ...data]
}

function chunk(id: string, body: number[]): number[] {
  const len = body.length
  return [
    ...stringBytes(id),
    (len >> 24) & 0xff,
    (len >> 16) & 0xff,
    (len >> 8) & 0xff,
    len & 0xff,
    ...body,
  ]
}

export interface TimedEvent {
  ticks: number
  /** Lower sort first at equal ticks: meta(0) < noteOff(1) < noteOn(2). */
  order: number
  bytes: number[]
}

export function midiMetaEvent(type: number, data: number[]): number[] {
  return metaEvent(type, data)
}

export function midiTextBytes(text: string): number[] {
  return stringBytes(text)
}

export function eventsToTrackBody(events: TimedEvent[]): number[] {
  const sorted = [...events].sort((a, b) => a.ticks - b.ticks || a.order - b.order)
  const body: number[] = []
  let prevTicks = 0
  for (const event of sorted) {
    const delta = event.ticks - prevTicks
    body.push(...variableLengthQuantity(delta), ...event.bytes)
    prevTicks = event.ticks
  }
  body.push(...variableLengthQuantity(0), ...metaEvent(0x2f, [])) // end of track
  return body
}

export interface BuildVocalsMidiInput {
  ppq: number
  tempos: Array<{ ticks: number; bpm: number }>
  timeSignatures: Array<{ ticks: number; numerator: number; denominator: number }>
  notes: VocalNote[]
}

/** Group notes into sung phrases, splitting on line ends and large rests. */
function buildPhraseRanges(notes: VocalNote[], ppq: number): Array<{ start: number; end: number }> {
  if (notes.length === 0) {
    return []
  }
  const gapThreshold = ppq * 2 // a rest of >= a half note starts a new phrase
  const ranges: Array<{ start: number; end: number }> = []
  let start = notes[0].ticks
  let end = notes[0].ticks + notes[0].durationTicks

  for (let i = 1; i < notes.length; i += 1) {
    const note = notes[i]
    if (note.ticks - end >= gapThreshold) {
      ranges.push({ start, end })
      start = note.ticks
    }
    end = Math.max(end, note.ticks + note.durationTicks)
  }
  ranges.push({ start, end })
  return ranges
}

/** Tempo + time-signature map events for track 0 of a format-1 SMF. */
export function tempoTrackEvents(
  tempos: Array<{ ticks: number; bpm: number }>,
  timeSignatures: Array<{ ticks: number; numerator: number; denominator: number }>,
): TimedEvent[] {
  const events: TimedEvent[] = []
  const list = tempos.length > 0 ? tempos : [{ ticks: 0, bpm: 120 }]
  for (const tempo of list) {
    const usPerQuarter = Math.round(60000000 / tempo.bpm)
    events.push({
      ticks: tempo.ticks,
      order: 0,
      bytes: metaEvent(0x51, [(usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff]),
    })
  }
  for (const ts of timeSignatures) {
    const denomPow = Math.round(Math.log2(Math.max(1, ts.denominator)))
    events.push({ ticks: ts.ticks, order: 0, bytes: metaEvent(0x58, [ts.numerator, denomPow, 24, 8]) })
  }
  events.push({ ticks: 0, order: 0, bytes: metaEvent(0x03, stringBytes('TEMPO')) })
  return events
}

/** PART VOCALS track events: lyric meta, pitched notes, and phrase markers. */
export function vocalsTrackEvents(notesInput: VocalNote[], ppq: number): TimedEvent[] {
  const notes = [...notesInput].sort((a, b) => a.ticks - b.ticks)
  const events: TimedEvent[] = [
    { ticks: 0, order: 0, bytes: metaEvent(0x03, stringBytes('PART VOCALS')) },
  ]
  for (const note of notes) {
    const pitch = Math.min(VOCALS_MAX_PITCH, Math.max(VOCALS_MIN_PITCH, note.midi))
    const end = note.ticks + Math.max(1, note.durationTicks)
    if (note.lyric.trim().length > 0) {
      events.push({ ticks: note.ticks, order: 0, bytes: metaEvent(0x05, stringBytes(note.lyric)) })
    }
    events.push({ ticks: note.ticks, order: 2, bytes: [0x90, pitch, 100] })
    events.push({ ticks: end, order: 1, bytes: [0x80, pitch, 0] })
  }
  for (const range of buildPhraseRanges(notes, ppq)) {
    events.push({ ticks: range.start, order: 2, bytes: [0x90, VOCALS_PHRASE_NOTE, 100] })
    events.push({ ticks: range.end, order: 1, bytes: [0x80, VOCALS_PHRASE_NOTE, 0] })
  }
  return events
}

/** Assemble a format-1 SMF from one event list per track. */
export function assembleMidi(ppq: number, trackEventLists: TimedEvent[][]): Uint8Array {
  const trackCount = trackEventLists.length
  const header = chunk('MThd', [
    0x00,
    0x01, // format 1
    (trackCount >> 8) & 0xff,
    trackCount & 0xff,
    (ppq >> 8) & 0xff,
    ppq & 0xff,
  ])
  const bytes = [...header]
  for (const list of trackEventLists) {
    bytes.push(...chunk('MTrk', eventsToTrackBody(list)))
  }
  return new Uint8Array(bytes)
}

/** Build a format-1 SMF: track 0 tempo/time-sig map, track 1 PART VOCALS. */
export function buildVocalsMidi(input: BuildVocalsMidiInput): Uint8Array {
  return assembleMidi(input.ppq, [
    tempoTrackEvents(input.tempos, input.timeSignatures),
    vocalsTrackEvents(input.notes, input.ppq),
  ])
}

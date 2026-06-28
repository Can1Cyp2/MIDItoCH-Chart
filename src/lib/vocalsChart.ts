import { Midi } from '@tonejs/midi'

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
  notes: VocalNote[]
}

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

/** Parse a MIDI file into per-track note lists for vocal melody selection. */
export async function parseVocalMidi(file: File): Promise<ParsedVocalMidi> {
  const buffer = await file.arrayBuffer()
  const midi = new Midi(buffer)

  const tracks: ParsedMidiTrack[] = midi.tracks
    .map((track, index) => {
      const notes: VocalNote[] = track.notes
        .map((note) => ({
          id: `n-${index}-${note.ticks}-${note.midi}`,
          ticks: note.ticks,
          durationTicks: Math.max(1, note.durationTicks),
          time: note.time,
          duration: Math.max(0.05, note.duration),
          midi: note.midi,
          lyric: '',
        }))
        .sort((a, b) => a.ticks - b.ticks || a.midi - b.midi)
      return {
        index,
        name: track.name?.trim() || `Track ${index + 1}`,
        noteCount: notes.length,
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

interface TimedEvent {
  ticks: number
  /** Lower sort first at equal ticks: meta(0) < noteOff(1) < noteOn(2). */
  order: number
  bytes: number[]
}

function eventsToTrackBody(events: TimedEvent[]): number[] {
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

/** Build a format-1 SMF: track 0 tempo/time-sig map, track 1 PART VOCALS. */
export function buildVocalsMidi(input: BuildVocalsMidiInput): Uint8Array {
  const { ppq } = input
  const notes = [...input.notes].sort((a, b) => a.ticks - b.ticks)

  // --- Track 0: tempo / time-signature map ---
  const tempoEvents: TimedEvent[] = []
  const tempos = input.tempos.length > 0 ? input.tempos : [{ ticks: 0, bpm: 120 }]
  for (const tempo of tempos) {
    const usPerQuarter = Math.round(60000000 / tempo.bpm)
    tempoEvents.push({
      ticks: tempo.ticks,
      order: 0,
      bytes: metaEvent(0x51, [
        (usPerQuarter >> 16) & 0xff,
        (usPerQuarter >> 8) & 0xff,
        usPerQuarter & 0xff,
      ]),
    })
  }
  for (const ts of input.timeSignatures) {
    const denomPow = Math.round(Math.log2(Math.max(1, ts.denominator)))
    tempoEvents.push({
      ticks: ts.ticks,
      order: 0,
      bytes: metaEvent(0x58, [ts.numerator, denomPow, 24, 8]),
    })
  }
  tempoEvents.push({ ticks: 0, order: 0, bytes: metaEvent(0x03, stringBytes('TEMPO')) })

  // --- Track 1: PART VOCALS ---
  const vocalEvents: TimedEvent[] = []
  vocalEvents.push({ ticks: 0, order: 0, bytes: metaEvent(0x03, stringBytes('PART VOCALS')) })

  for (const note of notes) {
    const pitch = Math.min(VOCALS_MAX_PITCH, Math.max(VOCALS_MIN_PITCH, note.midi))
    const end = note.ticks + Math.max(1, note.durationTicks)
    if (note.lyric.trim().length > 0) {
      vocalEvents.push({ ticks: note.ticks, order: 0, bytes: metaEvent(0x05, stringBytes(note.lyric)) })
    }
    vocalEvents.push({ ticks: note.ticks, order: 2, bytes: [0x90, pitch, 100] })
    vocalEvents.push({ ticks: end, order: 1, bytes: [0x80, pitch, 0] })
  }

  for (const range of buildPhraseRanges(notes, ppq)) {
    vocalEvents.push({ ticks: range.start, order: 2, bytes: [0x90, VOCALS_PHRASE_NOTE, 100] })
    vocalEvents.push({ ticks: range.end, order: 1, bytes: [0x80, VOCALS_PHRASE_NOTE, 0] })
  }

  const header = chunk('MThd', [
    0x00,
    0x01, // format 1
    0x00,
    0x02, // 2 tracks
    (ppq >> 8) & 0xff,
    ppq & 0xff,
  ])

  const bytes = [
    ...header,
    ...chunk('MTrk', eventsToTrackBody(tempoEvents)),
    ...chunk('MTrk', eventsToTrackBody(vocalEvents)),
  ]

  return new Uint8Array(bytes)
}

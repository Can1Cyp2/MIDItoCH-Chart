import { Midi } from '@tonejs/midi'
import {
  buildFiveFretSection,
  dedupeAndSortFiveFretNotes,
  mapPitchedNotesToFiveFret,
  type FretboardPlacementSummary,
  type FiveFretNote,
  type PitchedSourceNote,
} from './stringedChart'

export type DrumDifficulty = 'EasyDrums' | 'MediumDrums' | 'HardDrums' | 'ExpertDrums'
export type InstrumentMode = 'drums' | 'guitar' | 'bass'

export interface ConvertOptions {
  instrumentMode: InstrumentMode
  preferChannel10Only: boolean
  emitCymbalMarkers: boolean
  forceZeroLengthNotes: boolean
  preserveStackedHits: boolean
  difficulty: DrumDifficulty
  manualMidiRemap: Record<number, number>
  guitarMaxFret: number
  bassMaxFret: number
}

export interface LaneStats {
  kick: number
  red: number
  yellow: number
  blue: number
  green: number
  laneCounts: [number, number, number, number, number]
  cymbalFlags: number
  openNotes: number
  unmapped: number
}

export interface ConversionMeta {
  sourceFileName: string
  ppq: number
  usedTrackNames: string[]
  totalMappedNotes: number
  stats: LaneStats
  sourceNoteHistogram: Array<{ midi: number; count: number }>
  unmappedHistogram: Array<{ midi: number; count: number }>
  kickSourceHistogram: Array<{ midi: number; count: number }>
  instrumentMode: InstrumentMode
  fretboardSummary: FretboardPlacementSummary | null
  mappedPreviewNotes: Array<{ tick: number; lane: 0 | 1 | 2 | 3 | 4; cymbal: boolean; openHiHat: boolean }>
  maxTick: number
}

export interface ConversionResult {
  chartText: string
  outputFileName: string
  meta: ConversionMeta
}

interface MappedNote {
  tick: number
  lane: 0 | 1 | 2 | 3 | 4
  length: number
  cymbal: boolean
  openHiHat: boolean
}

type MidiTrack = Midi['tracks'][number]
type MidiNote = MidiTrack['notes'][number]

const DRUM_TRACK_NAME_PATTERN = /(drum|kit|perc|rhythm)/i
const GUITAR_TRACK_NAME_PATTERN = /(guitar|lead|rhythm|strum|pluck)/i
const BASS_TRACK_NAME_PATTERN = /(bass|finger|picked bass|slap)/i

const KICK = new Set([35, 36])
const RED = new Set([31, 37, 38, 39, 40])
const YELLOW_CYMBAL = new Set([22, 26, 42, 44, 46])
const YELLOW_TOM = new Set([48, 50])
const BLUE_CYMBAL = new Set([51, 53, 59])
const BLUE_TOM = new Set([45, 47])
const GREEN_CYMBAL = new Set([49, 52, 55, 57])
const GREEN_TOM = new Set([41, 43])
const OPEN_HIHAT = new Set([26, 46])

function emptyLaneStats(): LaneStats {
  return {
    kick: 0,
    red: 0,
    yellow: 0,
    blue: 0,
    green: 0,
    laneCounts: [0, 0, 0, 0, 0],
    cymbalFlags: 0,
    openNotes: 0,
    unmapped: 0,
  }
}

function statsFromFiveLaneCounts(laneCounts: [number, number, number, number, number], unmapped: number): LaneStats {
  return {
    kick: laneCounts[0],
    red: laneCounts[1],
    yellow: laneCounts[2],
    blue: laneCounts[3],
    green: laneCounts[4],
    laneCounts,
    cymbalFlags: 0,
    openNotes: 0,
    unmapped,
  }
}

const CYMBAL_MARKER_FAMILIES: Array<Record<2 | 3 | 4, number>> = [
  {
    2: 66,
    3: 67,
    4: 68,
  },
]

const DEFAULT_OPTIONS: ConvertOptions = {
  instrumentMode: 'drums',
  preferChannel10Only: true,
  emitCymbalMarkers: true,
  forceZeroLengthNotes: true,
  preserveStackedHits: true,
  difficulty: 'ExpertDrums',
  manualMidiRemap: {},
  guitarMaxFret: 22,
  bassMaxFret: 20,
}

function sanitizeQuoted(value: string): string {
  return value.replaceAll('"', "'")
}

function buildSongSection(ppq: number, name: string, instrumentMode: InstrumentMode): string {
  const safeName = sanitizeQuoted(name)
  const player2 = instrumentMode === 'drums' ? 'drums' : instrumentMode
  return [
    '[Song]',
    '{',
    `  Name = "${safeName}"`,
    '  Artist = "Unknown Artist"',
    '  Charter = "MIDItoCH-Chart"',
    '  Album = ""',
    '  Year = ", 2026"',
    '  Offset = 0',
    `  Resolution = ${ppq}`,
    `  Player2 = ${player2}`,
    '  Difficulty = 0',
    '  PreviewStart = 0',
    '  PreviewEnd = 0',
    '  Genre = "rock"',
    '  MediaType = "cd"',
    '  MusicStream = "song.ogg"',
    '}',
  ].join('\n')
}

function buildSyncTrackSection(midi: Midi): string {
  const bpmEvents = [...midi.header.tempos]
    .sort((a, b) => a.ticks - b.ticks)
    .map((tempo) => `${Math.max(0, Math.round(tempo.ticks))} = B ${Math.round(tempo.bpm * 1000)}`)

  const tsEvents = [...midi.header.timeSignatures]
    .sort((a, b) => a.ticks - b.ticks)
    .map((signature) => {
      const numerator = signature.timeSignature[0] ?? 4
      const denominator = signature.timeSignature[1] ?? 4
      const denominatorPower = Math.max(0, Math.round(Math.log2(denominator)))
      if (denominatorPower === 2) {
        return `${Math.max(0, Math.round(signature.ticks))} = TS ${numerator}`
      }
      return `${Math.max(0, Math.round(signature.ticks))} = TS ${numerator} ${denominatorPower}`
    })

  const merged = [...bpmEvents, ...tsEvents]
  if (merged.length === 0) {
    merged.push('0 = B 120000', '0 = TS 4')
  }

  return ['[SyncTrack]', '{', ...merged.map((entry) => `  ${entry}`), '}'].join('\n')
}

function buildEventsSection(): string {
  return ['[Events]', '{', '  0 = E "section Intro"', '}'].join('\n')
}

function mapMidiNumber(midi: number): Pick<MappedNote, 'lane' | 'cymbal' | 'openHiHat'> | null {

  if (KICK.has(midi)) {
    return { lane: 0, cymbal: false, openHiHat: false }
  }
  if (RED.has(midi)) {
    return { lane: 1, cymbal: false, openHiHat: false }
  }
  if (YELLOW_CYMBAL.has(midi)) {
    return { lane: 2, cymbal: true, openHiHat: OPEN_HIHAT.has(midi) }
  }
  if (YELLOW_TOM.has(midi)) {
    return { lane: 2, cymbal: false, openHiHat: false }
  }
  if (BLUE_CYMBAL.has(midi)) {
    return { lane: 3, cymbal: true, openHiHat: false }
  }
  if (BLUE_TOM.has(midi)) {
    return { lane: 3, cymbal: false, openHiHat: false }
  }
  if (GREEN_CYMBAL.has(midi)) {
    return { lane: 4, cymbal: true, openHiHat: false }
  }
  if (GREEN_TOM.has(midi)) {
    return { lane: 4, cymbal: false, openHiHat: false }
  }

  return null
}

function mapMidiNote(note: MidiNote): Pick<MappedNote, 'lane' | 'cymbal' | 'openHiHat'> | null {
  return mapMidiNumber(note.midi)
}

function scoreDrumTrack(track: MidiTrack): number {
  let mapped = 0
  const uniqueMappedMidi = new Set<number>()

  for (const note of track.notes) {
    if (mapMidiNote(note)) {
      mapped += 1
      uniqueMappedMidi.add(note.midi)
    }
  }

  const nameBonus = DRUM_TRACK_NAME_PATTERN.test(track.name) ? 500 : 0
  const channelBonus = track.channel === 9 ? 500 : 0

  return mapped * 100 + uniqueMappedMidi.size * 10 + nameBonus + channelBonus
}

function pickBestTrack(tracks: MidiTrack[]): MidiTrack[] {
  if (tracks.length <= 1) {
    return tracks
  }

  const ranked = [...tracks].sort((a, b) => {
    const scoreDiff = scoreDrumTrack(b) - scoreDrumTrack(a)
    if (scoreDiff !== 0) {
      return scoreDiff
    }
    return b.notes.length - a.notes.length
  })

  return ranked.slice(0, 1)
}

function pickDrumTracks(midi: Midi, preferChannel10Only: boolean): MidiTrack[] {
  const channel10 = midi.tracks.filter((track) => track.channel === 9 && track.notes.length > 0)
  if (preferChannel10Only && channel10.length > 0) {
    return pickBestTrack(channel10)
  }

  const named = midi.tracks.filter((track) => DRUM_TRACK_NAME_PATTERN.test(track.name) && track.notes.length > 0)
  if (named.length > 0) {
    return pickBestTrack(named)
  }

  if (channel10.length > 0) {
    return pickBestTrack(channel10)
  }

  const nonEmpty = midi.tracks.filter((track) => track.notes.length > 0)
  if (nonEmpty.length === 0) {
    return []
  }

  return pickBestTrack(nonEmpty)
}

function scoreStringedTrack(track: MidiTrack, instrumentMode: 'guitar' | 'bass'): number {
  const isBass = instrumentMode === 'bass'
  const namePattern = isBass ? BASS_TRACK_NAME_PATTERN : GUITAR_TRACK_NAME_PATTERN
  const nameBonus = namePattern.test(track.name) ? 700 : 0
  const nonDrumBonus = track.channel !== 9 ? 300 : 0
  const pitchSpread = track.notes.length
    ? Math.max(...track.notes.map((note) => note.midi)) - Math.min(...track.notes.map((note) => note.midi))
    : 0

  return track.notes.length * 100 + pitchSpread * 5 + nameBonus + nonDrumBonus
}

function pickBestStringedTrack(tracks: MidiTrack[], instrumentMode: 'guitar' | 'bass'): MidiTrack[] {
  if (tracks.length <= 1) {
    return tracks
  }

  const ranked = [...tracks].sort((a, b) => {
    const scoreDiff = scoreStringedTrack(b, instrumentMode) - scoreStringedTrack(a, instrumentMode)
    if (scoreDiff !== 0) {
      return scoreDiff
    }
    return b.notes.length - a.notes.length
  })

  return ranked.slice(0, 1)
}

function pickStringedTracks(midi: Midi, instrumentMode: 'guitar' | 'bass'): MidiTrack[] {
  const nonDrumTracks = midi.tracks.filter((track) => track.channel !== 9 && track.notes.length > 0)
  const pattern = instrumentMode === 'bass' ? BASS_TRACK_NAME_PATTERN : GUITAR_TRACK_NAME_PATTERN
  const named = nonDrumTracks.filter((track) => pattern.test(track.name))

  if (named.length > 0) {
    return pickBestStringedTrack(named, instrumentMode)
  }

  if (nonDrumTracks.length > 0) {
    return pickBestStringedTrack(nonDrumTracks, instrumentMode)
  }

  const fallback = midi.tracks.filter((track) => track.notes.length > 0)
  if (fallback.length === 0) {
    return []
  }

  return pickBestStringedTrack(fallback, instrumentMode)
}

function collectStringedMappedNotes(
  midi: Midi,
  options: ConvertOptions,
  instrumentMode: 'guitar' | 'bass',
): {
  notes: MappedNote[]
  stats: LaneStats
  usedTrackNames: string[]
  sourceNoteHistogram: Array<{ midi: number; count: number }>
  unmappedHistogram: Array<{ midi: number; count: number }>
  kickSourceHistogram: Array<{ midi: number; count: number }>
  fretboardSummary: FretboardPlacementSummary
} {
  const tracks = pickStringedTracks(midi, instrumentMode)
  const sourceHistogram = new Map<number, number>()
  const manualMidiRemap = options.manualMidiRemap ?? {}
  const pitched: PitchedSourceNote[] = []

  for (const track of tracks) {
    for (const note of track.notes) {
      const normalizedMidi = manualMidiRemap[note.midi] ?? note.midi
      sourceHistogram.set(normalizedMidi, (sourceHistogram.get(normalizedMidi) ?? 0) + 1)
      pitched.push({
        tick: Math.max(0, Math.round(note.ticks)),
        length: options.forceZeroLengthNotes ? 0 : Math.max(0, Math.round(note.durationTicks || 0)),
        midi: normalizedMidi,
      })
    }
  }

  const maxFret = instrumentMode === 'bass' ? options.bassMaxFret : options.guitarMaxFret
  const mapped = mapPitchedNotesToFiveFret(pitched, instrumentMode, Math.max(8, maxFret))
  const deduped: FiveFretNote[] = dedupeAndSortFiveFretNotes(mapped.notes, options.preserveStackedHits)

  const laneCounts: [number, number, number, number, number] = [0, 0, 0, 0, 0]
  const notes: MappedNote[] = deduped.map((note) => {
    laneCounts[note.lane] += 1
    return {
      tick: note.tick,
      lane: note.lane,
      length: note.length,
      cymbal: false,
      openHiHat: false,
    }
  })

  return {
    notes,
    stats: statsFromFiveLaneCounts(laneCounts, 0),
    usedTrackNames: tracks.map((track, index) => track.name || `Track ${index + 1}`),
    sourceNoteHistogram: [...sourceHistogram.entries()]
      .map(([midiNumber, count]) => ({ midi: midiNumber, count }))
      .sort((a, b) => b.count - a.count || a.midi - b.midi),
    unmappedHistogram: [],
    kickSourceHistogram: [],
    fretboardSummary: mapped.summary,
  }
}

function buildDrumSection(
  mappedNotes: MappedNote[],
  difficulty: DrumDifficulty,
  emitCymbalMarkers: boolean,
): string {
  const lines: string[] = []

  for (const note of mappedNotes) {
    lines.push(`  ${note.tick} = N ${note.lane} ${note.length}`)
    if (emitCymbalMarkers && note.cymbal && note.lane >= 2) {
      const cymbalLane = note.lane as 2 | 3 | 4
      for (const family of CYMBAL_MARKER_FAMILIES) {
        lines.push(`  ${note.tick} = N ${family[cymbalLane]} ${note.length}`)
      }
    }
  }

  return [`[${difficulty}]`, '{', ...lines, '}'].join('\n')
}

function dedupeAndSort(notes: MappedNote[], preserveStackedHits: boolean): MappedNote[] {
  const sorted = [...notes].sort((a, b) => {
    if (a.tick !== b.tick) {
      return a.tick - b.tick
    }
    return a.lane - b.lane
  })

  if (preserveStackedHits) {
    const occupied = new Set<string>()
    const out: MappedNote[] = []

    for (const note of sorted) {
      let tick = note.tick
      let key = `${tick}:${note.lane}`

      // Keep all source hits: if two hits collide, nudge later one by 1 tick.
      while (occupied.has(key)) {
        tick += 1
        key = `${tick}:${note.lane}`
      }

      occupied.add(key)
      out.push({ ...note, tick })
    }

    return out
  }

  const merged = new Map<string, MappedNote>()
  for (const note of sorted) {
    const key = `${note.tick}:${note.lane}`
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...note })
      continue
    }
    existing.length = Math.max(existing.length, note.length)
    existing.cymbal = existing.cymbal || note.cymbal
  }

  return [...merged.values()]
}

function buildOutputFileName(sourceFileName: string, instrumentMode: InstrumentMode): string {
  const base = sourceFileName.replace(/\.[^/.]+$/, '')
  if (instrumentMode === 'guitar') {
    return `${base}_guitar.chart`
  }
  if (instrumentMode === 'bass') {
    return `${base}_bass.chart`
  }
  return `${base}_prodrums.chart`
}

function buildPreviewNotes(notes: MappedNote[]): Array<{ tick: number; lane: 0 | 1 | 2 | 3 | 4; cymbal: boolean; openHiHat: boolean }> {
  return notes.map((note) => ({
    tick: note.tick,
    lane: note.lane,
    cymbal: note.cymbal,
    openHiHat: note.openHiHat,
  }))
}

function collectMappedNotes(
  midi: Midi,
  options: ConvertOptions,
): {
  notes: MappedNote[]
  stats: LaneStats
  usedTrackNames: string[]
  sourceNoteHistogram: Array<{ midi: number; count: number }>
  unmappedHistogram: Array<{ midi: number; count: number }>
  kickSourceHistogram: Array<{ midi: number; count: number }>
} {
  const tracks = pickDrumTracks(midi, options.preferChannel10Only)
  const stats: LaneStats = emptyLaneStats()

  const mapped: MappedNote[] = []
  const sourceHistogram = new Map<number, number>()
  const unmappedHistogram = new Map<number, number>()
  const kickSourceHistogram = new Map<number, number>()
  const manualMidiRemap = options.manualMidiRemap ?? {}

  for (const track of tracks) {
    for (const note of track.notes) {
      sourceHistogram.set(note.midi, (sourceHistogram.get(note.midi) ?? 0) + 1)

      const normalizedMidi = manualMidiRemap[note.midi] ?? note.midi

      const mapping = mapMidiNumber(normalizedMidi)
      if (!mapping) {
        stats.unmapped += 1
        unmappedHistogram.set(normalizedMidi, (unmappedHistogram.get(normalizedMidi) ?? 0) + 1)
        continue
      }

      const tick = Math.max(0, Math.round(note.ticks))
      const length = options.forceZeroLengthNotes
        ? 0
        : Math.max(0, Math.round(note.durationTicks || 0))

      mapped.push({
        tick,
        lane: mapping.lane,
        length,
        cymbal: mapping.cymbal,
        openHiHat: mapping.openHiHat,
      })

      if (mapping.lane === 0) stats.kick += 1
      if (mapping.lane === 1) stats.red += 1
      if (mapping.lane === 2) stats.yellow += 1
      if (mapping.lane === 3) stats.blue += 1
      if (mapping.lane === 4) stats.green += 1
      stats.laneCounts[mapping.lane] += 1
      if (mapping.cymbal && mapping.lane >= 2) stats.cymbalFlags += 1
      if (mapping.lane === 0) {
        kickSourceHistogram.set(normalizedMidi, (kickSourceHistogram.get(normalizedMidi) ?? 0) + 1)
      }
    }
  }

  return {
    notes: dedupeAndSort(mapped, options.preserveStackedHits),
    stats,
    usedTrackNames: tracks.map((track, index) => track.name || `Track ${index + 1}`),
    sourceNoteHistogram: [...sourceHistogram.entries()]
      .map(([midiNumber, count]) => ({ midi: midiNumber, count }))
      .sort((a, b) => b.count - a.count || a.midi - b.midi),
    unmappedHistogram: [...unmappedHistogram.entries()]
      .map(([midiNumber, count]) => ({ midi: midiNumber, count }))
      .sort((a, b) => b.count - a.count || a.midi - b.midi),
    kickSourceHistogram: [...kickSourceHistogram.entries()]
      .map(([midiNumber, count]) => ({ midi: midiNumber, count }))
      .sort((a, b) => b.count - a.count || a.midi - b.midi),
  }
}

export async function convertMidiToCloneHeroChart(
  file: File,
  incomingOptions?: Partial<ConvertOptions>,
): Promise<ConversionResult> {
  const options: ConvertOptions = {
    ...DEFAULT_OPTIONS,
    ...incomingOptions,
  }

  const arrayBuffer = await file.arrayBuffer()
  const midi = new Midi(arrayBuffer)

  if (midi.tracks.length === 0) {
    throw new Error('No MIDI tracks were found in this file.')
  }

  const ppq = Math.max(1, Math.round(midi.header.ppq || 192))
  const isStringed = options.instrumentMode === 'guitar' || options.instrumentMode === 'bass'
  const collected = isStringed
    ? collectStringedMappedNotes(midi, options, options.instrumentMode as 'guitar' | 'bass')
    : {
        ...collectMappedNotes(midi, options),
        fretboardSummary: null,
      }

  const {
    notes,
    stats,
    usedTrackNames,
    sourceNoteHistogram,
    unmappedHistogram,
    kickSourceHistogram,
    fretboardSummary,
  } = collected

  if (notes.length === 0) {
    if (isStringed) {
      throw new Error('No pitched notes were found for the selected guitar/bass mode.')
    }
    throw new Error('No supported drum notes were found. Make sure your MIDI contains drum notes (channel 10 recommended).')
  }

  const title = file.name.replace(/\.[^/.]+$/, '')
  const chartText = [
    buildSongSection(ppq, title, options.instrumentMode),
    '',
    buildSyncTrackSection(midi),
    '',
    buildEventsSection(),
    '',
    isStringed
      ? buildFiveFretSection(notes, options.instrumentMode as 'guitar' | 'bass')
      : buildDrumSection(notes, options.difficulty, options.emitCymbalMarkers),
    '',
  ].join('\n')

  return {
    chartText,
    outputFileName: buildOutputFileName(file.name, options.instrumentMode),
    meta: {
      sourceFileName: file.name,
      ppq,
      usedTrackNames,
      totalMappedNotes: notes.length,
      stats,
      sourceNoteHistogram,
      unmappedHistogram,
      kickSourceHistogram,
      instrumentMode: options.instrumentMode,
      fretboardSummary,
      mappedPreviewNotes: buildPreviewNotes(notes),
      maxTick: notes.at(-1)?.tick ?? 0,
    },
  }
}

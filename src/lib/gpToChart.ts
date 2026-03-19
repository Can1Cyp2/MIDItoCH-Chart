import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import type { ConvertOptions, ConversionResult, DrumDifficulty, LaneStats } from './midiToChart'

interface GpTrackInfo {
  id: string
  name: string
  fileTrackName: string
  officialName: string
  shortName: string
  isDrums: boolean
  type: string
  inputToOutputMidi?: Record<number, number>
}

interface GpParsedData {
  title: string
  artist: string
  tracks: GpTrackInfo[]
  ppq: number
  masterBars: GpMasterBar[]
  barsById: Map<string, GpBar>
  voicesById: Map<string, GpVoice>
  beatsById: Map<string, GpBeat>
  notesById: Map<string, GpNote>
  rhythmsById: Map<string, GpRhythm>
  tempoEvents: Array<{ tick: number; bpm: number }>
}

export interface GpInspectionResult {
  title: string
  artist: string
  tracks: Array<
    Pick<
      GpTrackInfo,
      'id' | 'name' | 'fileTrackName' | 'officialName' | 'shortName' | 'isDrums' | 'type'
    >
  >
}

type AnyRecord = Record<string, unknown>

interface GpMasterBar {
  id?: string
  time?: string
  bars?: string
}

interface GpBar {
  id: string
  voices: string
}

interface GpVoice {
  id: string
  beats: string
}

interface GpBeat {
  id: string
  rhythmRef: string
  notes: string
}

interface GpNote {
  id: string
  midi: number | null
}

interface GpRhythm {
  id: string
  noteValue: string
  dotCount: number
  tupletNum: number | null
  tupletDen: number | null
}

interface GpMappedNote {
  tick: number
  lane: 0 | 1 | 2 | 3 | 4
  length: number
  cymbal: boolean
}

const KICK = new Set([35, 36])
const RED = new Set([31, 37, 38, 39, 40])
const YELLOW_CYMBAL = new Set([22, 26, 42, 44, 46])
const YELLOW_TOM = new Set([48, 50])
const BLUE_CYMBAL = new Set([51, 53, 59])
const BLUE_TOM = new Set([45, 47])
const GREEN_CYMBAL = new Set([49, 52, 55, 57])
const GREEN_TOM = new Set([41, 43])

const CYMBAL_MARKER_FAMILIES: Array<Record<2 | 3 | 4, number>> = [
  {
    2: 66,
    3: 67,
    4: 68,
  },
]

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: '#cdata',
})

function parseMidiNumberList(raw: unknown): number[] {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? [Math.round(raw)] : []
  }
  if (typeof raw === 'string') {
    return raw
      .split(/[\s,;]+/)
      .map((token) => Number(token))
      .filter((value) => Number.isFinite(value))
      .map((value) => Math.round(value))
  }
  return []
}

function buildTrackInputToOutputMidiMap(track: AnyRecord): Record<number, number> {
  const mapping: Record<number, number> = {}
  const elements = asArray(
    ((track.InstrumentSet as AnyRecord | undefined)?.Elements as AnyRecord | undefined)
      ?.Element as AnyRecord | AnyRecord[] | undefined,
  )

  for (const element of elements) {
    const articulations = asArray(
      ((element.Articulations as AnyRecord | undefined)?.Articulation as
        | AnyRecord
        | AnyRecord[]
        | undefined) ?? [],
    )

    for (const articulation of articulations) {
      const output = numberOf(articulation.OutputMidiNumber, -1)
      if (output < 0 || output > 127) {
        continue
      }

      const inputs = parseMidiNumberList(articulation.InputMidiNumbers)
      for (const input of inputs) {
        if (input >= 0 && input <= 127) {
          mapping[input] = output
        }
      }
    }
  }

  return mapping
}

function trackDisplayName(track: Pick<GpTrackInfo, 'fileTrackName' | 'officialName' | 'id'>): string {
  const fileName = track.fileTrackName.trim()
  const official = track.officialName.trim()
  if (fileName && official && fileName.toLowerCase() !== official.toLowerCase()) {
    return `${fileName} (${official})`
  }
  if (fileName) {
    return fileName
  }
  if (official) {
    return official
  }
  return `Track ${track.id}`
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

function textOf(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value && typeof value === 'object' && '#cdata' in value) {
    const cdataValue = (value as Record<string, unknown>)['#cdata']
    return typeof cdataValue === 'string' ? cdataValue : ''
  }
  return ''
}

function numberOf(value: unknown, fallback = 0): number {
  if (typeof value === 'number') {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return fallback
}

function splitRefIds(value: string | undefined): string[] {
  if (!value) {
    return []
  }
  return value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item !== '-1')
}

function readNoteMidi(noteObj: AnyRecord): number | null {
  const properties = (noteObj.Properties as AnyRecord | undefined)?.Property
  const list = asArray(properties as AnyRecord | AnyRecord[])
  let fallbackFret: number | null = null
  let stringValue: number | null = null

  for (const prop of list) {
    const propName = String(prop['@_name'] ?? '')
    if (propName === 'Midi') {
      const midi = numberOf(prop.Number, -1)
      return midi >= 0 && midi <= 127 ? midi : null
    }

    if (propName === 'Fret') {
      const fret = numberOf(prop.Fret, -1)
      if (fret >= 0 && fret <= 127) {
        fallbackFret = fret
      }
    }

    if (propName === 'String') {
      stringValue = numberOf(prop.String, 0)
    }
  }

  // Some GP drum notes encode pitch in Fret (e.g., 36 kick, 38 snare, 42 hat)
  // with negative string lanes. Accept this schema when no explicit Midi exists.
  if (fallbackFret != null && stringValue != null && stringValue < 0) {
    return fallbackFret
  }

  if (fallbackFret != null && noteObj.InstrumentArticulation != null) {
    return fallbackFret
  }

  return null
}

function trackLooksDrumLike(track: AnyRecord): boolean {
  const name = textOf(track.Name).toLowerCase()
  const type = String((track.InstrumentSet as AnyRecord | undefined)?.Type ?? '').toLowerCase()
  if (type.includes('drum') || type.includes('percussion')) {
    return true
  }

  if (/(drum|kit|perc|battery)/i.test(name)) {
    return true
  }

  const staff = ((track.Staves as AnyRecord | undefined)?.Staff as AnyRecord | undefined) ?? {}
  const staffProperties =
    ((staff.Properties as AnyRecord | undefined)?.Property as AnyRecord | AnyRecord[] | undefined) ??
    []

  const tuningProperty = asArray(staffProperties).find(
    (prop) => String(prop['@_name'] ?? '') === 'Tuning',
  )

  if (tuningProperty) {
    const pitches = String((tuningProperty as AnyRecord).Pitches ?? '').trim()
    if (pitches.length > 0 && /^0(\s+0)*$/.test(pitches)) {
      return true
    }
  }

  return false
}

function parseTimeSignature(time: string | undefined): { numerator: number; denominator: number } {
  if (!time) {
    return { numerator: 4, denominator: 4 }
  }
  const [num, den] = time.split('/')
  const numerator = Math.max(1, numberOf(num, 4))
  const denominator = Math.max(1, numberOf(den, 4))
  return { numerator, denominator }
}

function noteValueToQuarterLength(noteValue: string): number {
  const value = noteValue.toLowerCase()
  if (value === 'whole') return 4
  if (value === 'half') return 2
  if (value === 'quarter') return 1
  if (value === 'eighth') return 0.5
  if (value === '16th') return 0.25
  if (value === '32nd') return 0.125
  if (value === '64th') return 0.0625
  return 0.25
}

function rhythmDurationTicks(rhythm: GpRhythm, ppq: number): number {
  let ticks = noteValueToQuarterLength(rhythm.noteValue) * ppq

  if (rhythm.dotCount > 0) {
    let factor = 1
    for (let i = 1; i <= rhythm.dotCount; i += 1) {
      factor += 1 / 2 ** i
    }
    ticks *= factor
  }

  if (rhythm.tupletNum && rhythm.tupletDen && rhythm.tupletNum > 0) {
    ticks *= rhythm.tupletDen / rhythm.tupletNum
  }

  return ticks
}

function mapMidiNoteToLane(midi: number): Pick<GpMappedNote, 'lane' | 'cymbal'> | null {
  if (KICK.has(midi)) return { lane: 0, cymbal: false }
  if (RED.has(midi) || midi === 91) return { lane: 1, cymbal: false }
  if (YELLOW_CYMBAL.has(midi)) return { lane: 2, cymbal: true }
  if (YELLOW_TOM.has(midi)) return { lane: 2, cymbal: false }
  if (BLUE_CYMBAL.has(midi)) return { lane: 3, cymbal: true }
  if (BLUE_TOM.has(midi)) return { lane: 3, cymbal: false }
  if (GREEN_CYMBAL.has(midi)) return { lane: 4, cymbal: true }
  if (GREEN_TOM.has(midi)) return { lane: 4, cymbal: false }
  return null
}

function dedupeAndSort(notes: GpMappedNote[], preserveStackedHits: boolean): GpMappedNote[] {
  const sorted = [...notes].sort((a, b) => {
    if (a.tick !== b.tick) {
      return a.tick - b.tick
    }
    return a.lane - b.lane
  })

  if (preserveStackedHits) {
    const occupied = new Set<string>()
    const out: GpMappedNote[] = []

    for (const note of sorted) {
      let tick = note.tick
      let key = `${tick}:${note.lane}`
      while (occupied.has(key)) {
        tick += 1
        key = `${tick}:${note.lane}`
      }
      occupied.add(key)
      out.push({ ...note, tick })
    }

    return out
  }

  const map = new Map<string, GpMappedNote>()
  for (const note of sorted) {
    const key = `${note.tick}:${note.lane}`
    const existing = map.get(key)
    if (!existing) {
      map.set(key, { ...note })
      continue
    }
    existing.length = Math.max(existing.length, note.length)
    existing.cymbal = existing.cymbal || note.cymbal
  }

  return [...map.values()]
}

function sanitizeQuoted(value: string): string {
  return value.replaceAll('"', "'")
}

function buildSongSection(ppq: number, title: string, artist: string): string {
  return [
    '[Song]',
    '{',
    `  Name = "${sanitizeQuoted(title || 'Untitled')}"`,
    `  Artist = "${sanitizeQuoted(artist || 'Unknown Artist')}"`,
    '  Charter = "MIDItoCH-Chart"',
    '  Album = ""',
    '  Year = ", 2026"',
    '  Offset = 0',
    `  Resolution = ${ppq}`,
    '  Player2 = drums',
    '  Difficulty = 0',
    '  PreviewStart = 0',
    '  PreviewEnd = 0',
    '  Genre = "rock"',
    '  MediaType = "cd"',
    '  MusicStream = "song.ogg"',
    '}',
  ].join('\n')
}

function buildSyncTrackSection(
  ppq: number,
  masterBars: GpMasterBar[],
  tempoEvents: Array<{ tick: number; bpm: number }>,
): string {
  let tickCursor = 0
  const tsEvents: string[] = []

  for (const masterBar of masterBars) {
    const { numerator, denominator } = parseTimeSignature(masterBar.time)
    const denomPower = Math.max(0, Math.round(Math.log2(denominator)))
    if (denomPower === 2) {
      tsEvents.push(`${Math.round(tickCursor)} = TS ${numerator}`)
    } else {
      tsEvents.push(`${Math.round(tickCursor)} = TS ${numerator} ${denomPower}`)
    }
    tickCursor += (ppq * 4 * numerator) / denominator
  }

  const bpmEvents = tempoEvents.map((event) =>
    `${Math.max(0, Math.round(event.tick))} = B ${Math.round(event.bpm * 1000)}`,
  )

  const merged = [...new Set([...bpmEvents, ...tsEvents])]
  if (merged.length === 0) {
    merged.push('0 = B 120000', '0 = TS 4')
  }

  return ['[SyncTrack]', '{', ...merged.map((line) => `  ${line}`), '}'].join('\n')
}

function buildEventsSection(): string {
  return ['[Events]', '{', '  0 = E "section Intro"', '}'].join('\n')
}

function buildDrumSection(
  notes: GpMappedNote[],
  difficulty: DrumDifficulty,
  emitCymbalMarkers: boolean,
): string {
  const lines: string[] = []

  for (const note of notes) {
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

async function loadGpData(file: File): Promise<GpParsedData> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  const gpif = zip.file('Content/score.gpif')
  if (!gpif) {
    throw new Error('Unsupported GP file. Could not find Content/score.gpif.')
  }

  const xml = await gpif.async('string')
  const root = XML_PARSER.parse(xml)
  const gpifRoot = root?.GPIF as AnyRecord | undefined

  if (!gpifRoot) {
    throw new Error('Invalid GPIF content.')
  }

  const score = (gpifRoot.Score as AnyRecord | undefined) ?? {}
  const title = textOf(score.Title) || file.name.replace(/\.[^/.]+$/, '')
  const artist = textOf(score.Artist) || 'Unknown Artist'

  const tracksRaw = asArray((gpifRoot.Tracks as AnyRecord | undefined)?.Track as AnyRecord | AnyRecord[])
  const tracks: GpTrackInfo[] = tracksRaw.map((track) => {
    const instrumentSet = (track.InstrumentSet as AnyRecord | undefined) ?? {}
    const type = String(instrumentSet.Type ?? '')
    const fileTrackName = textOf(track.Name)
    const officialName = textOf(instrumentSet.Name)
    const shortName = textOf(track.ShortName)
    const id = String(track['@_id'] ?? '')

    return {
      id,
      name:
        fileTrackName || officialName || shortName || `Track ${id || String(track['@_id'] ?? '?')}`,
      fileTrackName,
      officialName,
      shortName,
      isDrums: trackLooksDrumLike(track),
      type,
      inputToOutputMidi: buildTrackInputToOutputMidiMap(track),
    }
  })

  const masterBarsRaw = asArray(
    (gpifRoot.MasterBars as AnyRecord | undefined)?.MasterBar as AnyRecord | AnyRecord[],
  )
  const masterBars: GpMasterBar[] = masterBarsRaw.map((bar) => ({
    id: String(bar['@_id'] ?? ''),
    time: typeof bar.Time === 'string' ? bar.Time : undefined,
    bars: typeof bar.Bars === 'string' ? bar.Bars : undefined,
  }))

  const barsRaw = asArray((gpifRoot.Bars as AnyRecord | undefined)?.Bar as AnyRecord | AnyRecord[])
  const barsById = new Map<string, GpBar>()
  for (const bar of barsRaw) {
    const id = String(bar['@_id'] ?? '')
    barsById.set(id, {
      id,
      voices: String(bar.Voices ?? ''),
    })
  }

  const voicesRaw = asArray((gpifRoot.Voices as AnyRecord | undefined)?.Voice as AnyRecord | AnyRecord[])
  const voicesById = new Map<string, GpVoice>()
  for (const voice of voicesRaw) {
    const id = String(voice['@_id'] ?? '')
    voicesById.set(id, {
      id,
      beats: String(voice.Beats ?? ''),
    })
  }

  const beatsRaw = asArray((gpifRoot.Beats as AnyRecord | undefined)?.Beat as AnyRecord | AnyRecord[])
  const beatsById = new Map<string, GpBeat>()
  for (const beat of beatsRaw) {
    const id = String(beat['@_id'] ?? '')
    const rhythmRef = String((beat.Rhythm as AnyRecord | undefined)?.['@_ref'] ?? '')
    beatsById.set(id, {
      id,
      rhythmRef,
      notes: typeof beat.Notes === 'string' ? beat.Notes : '',
    })
  }

  const notesRaw = asArray((gpifRoot.Notes as AnyRecord | undefined)?.Note as AnyRecord | AnyRecord[])
  const notesById = new Map<string, GpNote>()
  for (const note of notesRaw) {
    const id = String(note['@_id'] ?? '')
    notesById.set(id, {
      id,
      midi: readNoteMidi(note),
    })
  }

  const rhythmsRaw = asArray(
    (gpifRoot.Rhythms as AnyRecord | undefined)?.Rhythm as AnyRecord | AnyRecord[],
  )
  const rhythmsById = new Map<string, GpRhythm>()
  for (const rhythm of rhythmsRaw) {
    const id = String(rhythm['@_id'] ?? '')
    const dots = numberOf((rhythm.AugmentationDot as AnyRecord | undefined)?.['@_count'], 0)
    const tuplet = (rhythm.PrimaryTuplet as AnyRecord | undefined) ?? {}

    rhythmsById.set(id, {
      id,
      noteValue: String(rhythm.NoteValue ?? '16th'),
      dotCount: Math.max(0, dots),
      tupletNum: tuplet['@_num'] == null ? null : numberOf(tuplet['@_num'], 0),
      tupletDen: tuplet['@_den'] == null ? null : numberOf(tuplet['@_den'], 0),
    })
  }

  const tempoEvents: Array<{ tick: number; bpm: number }> = []
  const automations = asArray(
    ((gpifRoot.MasterTrack as AnyRecord | undefined)?.Automations as AnyRecord | undefined)
      ?.Automation as AnyRecord | AnyRecord[],
  )

  let tickCursor = 0
  const barTickStarts: number[] = []
  for (const masterBar of masterBars) {
    barTickStarts.push(tickCursor)
    const { numerator, denominator } = parseTimeSignature(masterBar.time)
    tickCursor += (960 * 4 * numerator) / denominator
  }

  for (const auto of automations) {
    if (String(auto.Type ?? '').toLowerCase() !== 'tempo') {
      continue
    }
    const barIndex = Math.max(0, numberOf(auto.Bar, 0))
    const position = Math.max(0, numberOf(auto.Position, 0))
    const valueTokens = String(auto.Value ?? '').split(/\s+/)
    const bpm = Math.max(1, numberOf(valueTokens[0], 120))
    const baseTick = barTickStarts[barIndex] ?? 0
    tempoEvents.push({ tick: baseTick + position, bpm })
  }

  if (tempoEvents.length === 0) {
    tempoEvents.push({ tick: 0, bpm: 120 })
  }

  return {
    title,
    artist,
    tracks,
    ppq: 960,
    masterBars,
    barsById,
    voicesById,
    beatsById,
    notesById,
    rhythmsById,
    tempoEvents,
  }
}

function collectTrackMappedNotes(
  data: GpParsedData,
  trackIndex: number,
  options: ConvertOptions,
): {
  notes: GpMappedNote[]
  stats: LaneStats
  sourceNoteHistogram: Array<{ midi: number; count: number }>
  unmappedHistogram: Array<{ midi: number; count: number }>
  kickSourceHistogram: Array<{ midi: number; count: number }>
} {
  const stats: LaneStats = {
    kick: 0,
    red: 0,
    yellow: 0,
    blue: 0,
    green: 0,
    cymbalFlags: 0,
    unmapped: 0,
  }

  const sourceHistogram = new Map<number, number>()
  const unmappedHistogram = new Map<number, number>()
  const kickSourceHistogram = new Map<number, number>()
  const mapped: GpMappedNote[] = []
  const ppq = data.ppq
  const midiNormalizationMap = data.tracks[trackIndex]?.inputToOutputMidi ?? {}

  let absoluteBarTick = 0

  for (let masterBarIndex = 0; masterBarIndex < data.masterBars.length; masterBarIndex += 1) {
    const masterBar = data.masterBars[masterBarIndex]
    const { numerator, denominator } = parseTimeSignature(masterBar.time)
    const barTicks = (ppq * 4 * numerator) / denominator

    const perTrackBarIds = splitRefIds(masterBar.bars)
    const barId = perTrackBarIds[trackIndex]
    if (!barId) {
      absoluteBarTick += barTicks
      continue
    }

    const bar = data.barsById.get(barId)
    if (!bar) {
      absoluteBarTick += barTicks
      continue
    }

    const voiceIds = splitRefIds(bar.voices)

    for (const voiceId of voiceIds) {
      const voice = data.voicesById.get(voiceId)
      if (!voice) {
        continue
      }

      let voiceTick = absoluteBarTick
      const beatIds = splitRefIds(voice.beats)

      for (const beatId of beatIds) {
        const beat = data.beatsById.get(beatId)
        if (!beat) {
          continue
        }

        const rhythm = data.rhythmsById.get(beat.rhythmRef)
        const beatLength = rhythm ? rhythmDurationTicks(rhythm, ppq) : ppq / 4

        const noteIds = splitRefIds(beat.notes)
        for (const noteId of noteIds) {
          const note = data.notesById.get(noteId)
          if (!note || note.midi == null) {
            continue
          }

          const normalizedMidi = midiNormalizationMap[note.midi] ?? note.midi

          sourceHistogram.set(normalizedMidi, (sourceHistogram.get(normalizedMidi) ?? 0) + 1)

          const mappedLane = mapMidiNoteToLane(normalizedMidi)
          if (!mappedLane) {
            stats.unmapped += 1
            unmappedHistogram.set(
              normalizedMidi,
              (unmappedHistogram.get(normalizedMidi) ?? 0) + 1,
            )
            continue
          }

          const noteLength = options.forceZeroLengthNotes ? 0 : Math.max(0, Math.round(beatLength))
          mapped.push({
            tick: Math.max(0, Math.round(voiceTick)),
            lane: mappedLane.lane,
            length: noteLength,
            cymbal: mappedLane.cymbal,
          })

          if (mappedLane.lane === 0) stats.kick += 1
          if (mappedLane.lane === 1) stats.red += 1
          if (mappedLane.lane === 2) stats.yellow += 1
          if (mappedLane.lane === 3) stats.blue += 1
          if (mappedLane.lane === 4) stats.green += 1
          if (mappedLane.cymbal && mappedLane.lane >= 2) stats.cymbalFlags += 1
          if (mappedLane.lane === 0) {
            kickSourceHistogram.set(normalizedMidi, (kickSourceHistogram.get(normalizedMidi) ?? 0) + 1)
          }
        }

        voiceTick += beatLength
      }
    }

    absoluteBarTick += barTicks
  }

  return {
    notes: dedupeAndSort(mapped, options.preserveStackedHits),
    stats,
    sourceNoteHistogram: [...sourceHistogram.entries()]
      .map(([midi, count]) => ({ midi, count }))
      .sort((a, b) => b.count - a.count || a.midi - b.midi),
    unmappedHistogram: [...unmappedHistogram.entries()]
      .map(([midi, count]) => ({ midi, count }))
      .sort((a, b) => b.count - a.count || a.midi - b.midi),
    kickSourceHistogram: [...kickSourceHistogram.entries()]
      .map(([midi, count]) => ({ midi, count }))
      .sort((a, b) => b.count - a.count || a.midi - b.midi),
  }
}

function buildPreviewNotes(notes: GpMappedNote[]): Array<{ tick: number; lane: 0 | 1 | 2 | 3 | 4; cymbal: boolean }> {
  return notes.map((note) => ({
    tick: note.tick,
    lane: note.lane,
    cymbal: note.cymbal,
  }))
}

export async function inspectGpFile(file: File): Promise<GpInspectionResult> {
  const data = await loadGpData(file)
  return {
    title: data.title,
    artist: data.artist,
    tracks: data.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      fileTrackName: track.fileTrackName,
      officialName: track.officialName,
      shortName: track.shortName,
      isDrums: track.isDrums,
      type: track.type,
    })),
  }
}

export async function convertGpToCloneHeroChart(
  file: File,
  selectedTrackId: string,
  options: ConvertOptions,
): Promise<ConversionResult> {
  const data = await loadGpData(file)
  const trackIndex = data.tracks.findIndex((track) => track.id === selectedTrackId)

  if (trackIndex < 0) {
    throw new Error('Please choose a valid track from the GP file.')
  }

  const selectedTrack = data.tracks[trackIndex]
  const { notes, stats, sourceNoteHistogram, unmappedHistogram, kickSourceHistogram } = collectTrackMappedNotes(
    data,
    trackIndex,
    options,
  )

  if (notes.length === 0) {
    const likely = data.tracks
      .filter((track) => track.isDrums)
      .map((track) => track.name)
      .slice(0, 4)

    if (likely.length > 0) {
      throw new Error(
        `No drum notes mapped from the selected GP track. Try one of: ${likely.join(', ')}`,
      )
    }

    throw new Error('No drum notes mapped from the selected GP track.')
  }

  const chartText = [
    buildSongSection(data.ppq, data.title, data.artist),
    '',
    buildSyncTrackSection(data.ppq, data.masterBars, data.tempoEvents),
    '',
    buildEventsSection(),
    '',
    buildDrumSection(
      notes,
      options.difficulty as DrumDifficulty,
      options.emitCymbalMarkers,
    ),
    '',
  ].join('\n')

  const base = file.name.replace(/\.[^/.]+$/, '')
  const displayTrackName = trackDisplayName(selectedTrack)
  const safeTrack = displayTrackName.replace(/[^a-zA-Z0-9-_]+/g, '_')

  return {
    chartText,
    outputFileName: `${base}_${safeTrack || 'track'}_prodrums.chart`,
    meta: {
      sourceFileName: file.name,
      ppq: data.ppq,
      usedTrackNames: [displayTrackName],
      totalMappedNotes: notes.length,
      stats,
      sourceNoteHistogram,
      unmappedHistogram,
      kickSourceHistogram,
      mappedPreviewNotes: buildPreviewNotes(notes),
      maxTick: notes.at(-1)?.tick ?? 0,
    },
  }
}

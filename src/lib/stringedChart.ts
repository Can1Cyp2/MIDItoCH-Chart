export type StringedInstrument = 'guitar' | 'bass'

export interface PitchedSourceNote {
  tick: number
  length: number
  midi: number
}

export interface FiveFretNote {
  tick: number
  length: number
  lane: 0 | 1 | 2 | 3 | 4
}

export interface FretboardPlacementSummary {
  instrument: StringedInstrument
  maxFret: number
  medianFret: number
  minFret: number
  maxUsedFret: number
  averageFret: number
}

interface FretCandidate {
  stringIndex: number
  fret: number
}

const STANDARD_GUITAR_TUNING = [40, 45, 50, 55, 59, 64]
const STANDARD_BASS_TUNING = [28, 33, 38, 43]

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function laneFromFret(fret: number, maxFret: number): 0 | 1 | 2 | 3 | 4 {
  const normalized = clamp(fret / Math.max(1, maxFret), 0, 1)
  const lane = clamp(Math.floor(normalized * 5), 0, 4)
  return lane as 0 | 1 | 2 | 3 | 4
}

function candidatesForPitch(
  midi: number,
  tuning: number[],
  maxFret: number,
): FretCandidate[] {
  const candidates: FretCandidate[] = []

  for (let stringIndex = 0; stringIndex < tuning.length; stringIndex += 1) {
    const openMidi = tuning[stringIndex]
    const fret = midi - openMidi
    if (fret >= 0 && fret <= maxFret) {
      candidates.push({ stringIndex, fret })
    }
  }

  return candidates
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0
  }

  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2
  }

  return sorted[middle]
}

function chooseCandidate(
  midi: number,
  tuning: number[],
  maxFret: number,
  preferredFret: number,
  previous: FretCandidate | null,
): FretCandidate {
  const candidates = candidatesForPitch(midi, tuning, maxFret)

  if (candidates.length === 0) {
    const nearestString = tuning
      .map((openMidi, index) => ({
        index,
        distance: Math.abs(midi - openMidi),
      }))
      .sort((a, b) => a.distance - b.distance)[0]

    return {
      stringIndex: nearestString.index,
      fret: clamp(midi - tuning[nearestString.index], 0, maxFret),
    }
  }

  let best = candidates[0]
  let bestCost = Number.POSITIVE_INFINITY

  for (const candidate of candidates) {
    const preferredCost = Math.abs(candidate.fret - preferredFret) * 1.1
    const movementCost = previous ? Math.abs(candidate.fret - previous.fret) * 0.35 : 0
    const stringJumpCost = previous ? Math.abs(candidate.stringIndex - previous.stringIndex) * 0.45 : 0
    const cost = preferredCost + movementCost + stringJumpCost

    if (cost < bestCost) {
      best = candidate
      bestCost = cost
    }
  }

  return best
}

export function mapPitchedNotesToFiveFret(
  sourceNotes: PitchedSourceNote[],
  instrument: StringedInstrument,
  maxFret: number,
): {
  notes: FiveFretNote[]
  summary: FretboardPlacementSummary
} {
  const tuning = instrument === 'bass' ? STANDARD_BASS_TUNING : STANDARD_GUITAR_TUNING
  const sorted = [...sourceNotes].sort((a, b) => a.tick - b.tick || a.midi - b.midi)

  const pitchMedian = median(sorted.map((note) => note.midi))
  const centerString = tuning[Math.floor(tuning.length / 2)]
  let preferredFret = clamp(Math.round(pitchMedian - centerString), 0, maxFret)

  const assignedFrets: number[] = []
  const out: FiveFretNote[] = []
  let previous: FretCandidate | null = null

  for (const note of sorted) {
    const assignment = chooseCandidate(note.midi, tuning, maxFret, preferredFret, previous)
    const lane = laneFromFret(assignment.fret, maxFret)

    out.push({
      tick: note.tick,
      length: note.length,
      lane,
    })

    assignedFrets.push(assignment.fret)
    preferredFret = Math.round(preferredFret * 0.75 + assignment.fret * 0.25)
    previous = assignment
  }

  const minFret = assignedFrets.length ? Math.min(...assignedFrets) : 0
  const maxUsedFret = assignedFrets.length ? Math.max(...assignedFrets) : 0
  const averageFret =
    assignedFrets.length > 0
      ? assignedFrets.reduce((sum, value) => sum + value, 0) / assignedFrets.length
      : 0

  return {
    notes: out,
    summary: {
      instrument,
      maxFret,
      medianFret: median(assignedFrets),
      minFret,
      maxUsedFret,
      averageFret,
    },
  }
}

export function buildFiveFretSection(
  notes: FiveFretNote[],
  instrument: StringedInstrument,
): string {
  const chartSection = instrument === 'bass' ? 'ExpertDoubleBass' : 'ExpertSingle'
  const lines = notes.map((note) => `  ${note.tick} = N ${note.lane} ${note.length}`)
  return [`[${chartSection}]`, '{', ...lines, '}'].join('\n')
}

export function dedupeAndSortFiveFretNotes(
  notes: FiveFretNote[],
  preserveStackedHits: boolean,
): FiveFretNote[] {
  const sorted = [...notes].sort((a, b) => {
    if (a.tick !== b.tick) {
      return a.tick - b.tick
    }
    return a.lane - b.lane
  })

  if (preserveStackedHits) {
    const occupied = new Set<string>()
    const out: FiveFretNote[] = []

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

  const merged = new Map<string, FiveFretNote>()
  for (const note of sorted) {
    const key = `${note.tick}:${note.lane}`
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...note })
      continue
    }
    existing.length = Math.max(existing.length, note.length)
  }

  return [...merged.values()]
}

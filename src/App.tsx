import { useEffect, useMemo, useRef, useState } from 'react'
import {
  convertMidiToCloneHeroChart,
  inspectMidiFile,
  type ConvertOptions,
  type ConversionResult,
  type DrumDifficulty,
  type MidiInspectionResult,
} from './lib/midiToChart'
import { convertGpToCloneHeroChart, inspectGpFile, type GpInspectionResult } from './lib/gpToChart'
import siteIcon from './assets/fret_icon.png'
import './App.css'

const ACCEPTED_MIDI_EXTENSIONS = ['.mid', '.midi']
const ACCEPTED_GP_EXTENSIONS = ['.gp', '.gpif', '.gpx']

type InputKind = 'midi' | 'gp' | 'unknown'

function parseManualMidiRemap(raw: string): { map: Record<number, number>; error: string | null } {
  const map: Record<number, number> = {}
  const lines = raw.split(/\r?\n/)

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const parts = line
      .split(/[;,]+/)
      .map((part) => part.trim())
      .filter(Boolean)

    for (const part of parts) {
      const match = part.match(/^(\d{1,3})\s*(?:->|=|:)\s*(\d{1,3})$/)
      if (!match) {
        return {
          map: {},
          error: `Invalid remap rule on line ${i + 1}: "${line}". Use format like 31->38`,
        }
      }

      const source = Number(match[1])
      const target = Number(match[2])
      if (
        !Number.isInteger(source) ||
        !Number.isInteger(target) ||
        source < 0 ||
        source > 127 ||
        target < 0 ||
        target > 127
      ) {
        return {
          map: {},
          error: `MIDI remap values must be between 0 and 127 (line ${i + 1}).`,
        }
      }

      map[source] = target
    }
  }

  return { map, error: null }
}

function gpTrackOptionLabel(track: GpInspectionResult['tracks'][number]): string {
  const filePart = track.fileTrackName || track.name || `Track ${track.id}`
  const official = track.officialName || track.type || 'Unknown'
  const base = `${filePart} | ${official}`
  if (base.length <= 72) {
    return base
  }
  return `${base.slice(0, 69)}...`
}

function suggestMidiTrackIndices(
  info: MidiInspectionResult,
  instrumentMode: ConvertOptions['instrumentMode'],
  preferChannel10Only: boolean,
): number[] {
  const nonEmpty = info.tracks.filter((track) => track.noteCount > 0)
  if (nonEmpty.length === 0) {
    return []
  }

  if (instrumentMode === 'drums') {
    if (preferChannel10Only) {
      const channel10 = nonEmpty.find((track) => track.channel === 9)
      if (channel10) {
        return [channel10.index]
      }
    }

    const drumNamed = nonEmpty.find((track) => /drum|kit|perc|rhythm/i.test(track.name))
    if (drumNamed) {
      return [drumNamed.index]
    }
  } else {
    const preferred =
      instrumentMode === 'bass'
        ? nonEmpty.find((track) => /bass/i.test(track.name))
        : nonEmpty.find((track) => /guitar|lead|rhythm/i.test(track.name))
    if (preferred) {
      return [preferred.index]
    }

    const nonDrum = nonEmpty.find((track) => track.channel !== 9)
    if (nonDrum) {
      return [nonDrum.index]
    }
  }

  return [nonEmpty[0].index]
}

function App() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [result, setResult] = useState<ConversionResult | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [inputKind, setInputKind] = useState<InputKind>('unknown')
  const [midiInfo, setMidiInfo] = useState<MidiInspectionResult | null>(null)
  const [selectedMidiTrackIndices, setSelectedMidiTrackIndices] = useState<number[]>([])
  const [gpInfo, setGpInfo] = useState<GpInspectionResult | null>(null)
  const [selectedGpTrackId, setSelectedGpTrackId] = useState<string>('')
  const [manualMidiRemapText, setManualMidiRemapText] = useState('')
  const [options, setOptions] = useState<ConvertOptions>({
    instrumentMode: 'drums',
    preferChannel10Only: true,
    emitCymbalMarkers: true,
    accentOpenHiHatOnYellowCymbal: true,
    forceZeroLengthNotes: true,
    preserveStackedHits: true,
    difficulty: 'ExpertDrums',
    manualMidiRemap: {},
    guitarMaxFret: 22,
    bassMaxFret: 20,
  })
  const [isTimelinePlaying, setIsTimelinePlaying] = useState(false)
  const [currentTick, setCurrentTick] = useState(0)
  const [timelineZoom, setTimelineZoom] = useState(1.2)
  const [playbackRate, setPlaybackRate] = useState(1)
  const timelineScrollRef = useRef<HTMLDivElement | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const noiseBufferRef = useRef<AudioBuffer | null>(null)
  const playbackCursorRef = useRef(0)
  const lastAudioTickRef = useRef(0)

  const chartPreview = useMemo(() => {
    if (!result) {
      return ''
    }

    const lines = result.chartText.split('\n')
    return lines.slice(0, 120).join('\n')
  }, [result])

  const isDrumMode = options.instrumentMode === 'drums'

  const firstMappedHits = useMemo(() => {
    if (!result) {
      return [] as string[]
    }

    const hits: string[] = []
    const laneToName: Record<number, string> =
      result.meta.instrumentMode === 'drums'
        ? {
            0: 'Kick',
            1: 'Snare',
            2: 'Yellow',
            3: 'Blue',
            4: 'Green',
          }
        : {
            0: 'Lane 0 (low fret)',
            1: 'Lane 1',
            2: 'Lane 2',
            3: 'Lane 3',
            4: 'Lane 4 (high fret)',
          }

    for (const line of result.chartText.split('\n')) {
      const match = line.match(/=\s+N\s+(\d+)\s+/)
      if (!match) {
        continue
      }
      const lane = Number(match[1])
      if (!Number.isFinite(lane) || lane < 0 || lane > 4) {
        continue
      }
      hits.push(laneToName[lane] ?? `Lane ${lane}`)
      if (hits.length >= 24) {
        break
      }
    }

    return hits
  }, [result])

  const openHiHatCount = useMemo(() => {
    if (!result) {
      return 0
    }
    return result.meta.mappedPreviewNotes.filter((note) => note.openHiHat).length
  }, [result])

  const timelineTempoBpm = useMemo(() => {
    if (!result) {
      return 120
    }
    const match = result.chartText.match(/\bB\s+(\d+)/)
    if (!match) {
      return 120
    }
    const raw = Number(match[1])
    if (!Number.isFinite(raw) || raw <= 0) {
      return 120
    }
    return raw / 1000
  }, [result])

  const timelineMaxTick = useMemo(() => Math.max(1, result?.meta.maxTick ?? 1), [result])

  const playbackNotes = useMemo(() => {
    if (!result) {
      return [] as ConversionResult['meta']['mappedPreviewNotes']
    }
    return [...result.meta.mappedPreviewNotes].sort((a, b) => a.tick - b.tick)
  }, [result])

  const timelineIsDrums = result?.meta.instrumentMode === 'drums'

  const miniTimeline = useMemo(() => {
    if (!result) {
      return {
        width: 1200,
        height: 150,
        points: [] as Array<{
          x: number
          y: number
          cymbal: boolean
            openHiHat: boolean
          lane: 0 | 1 | 2 | 3 | 4
        }>,
      }
    }

    const beatCount = timelineMaxTick / Math.max(1, result.meta.ppq)
    const width = Math.max(1200, Math.round(beatCount * 24 * timelineZoom))
    const height = 150
    const laneY: Record<0 | 1 | 2 | 3 | 4, number> = {
      0: 124,
      1: 99,
      2: 74,
      3: 49,
      4: 24,
    }
    const maxTick = timelineMaxTick

    return {
      width,
      height,
      points: result.meta.mappedPreviewNotes.map((note) => ({
        x: 14 + Math.round((note.tick / maxTick) * (width - 28)),
        y: laneY[note.lane],
        cymbal: note.cymbal,
        openHiHat: note.openHiHat,
        lane: note.lane,
      })),
    }
  }, [result, timelineZoom, timelineMaxTick])

  const currentTickX = useMemo(
    () => 14 + Math.round((currentTick / timelineMaxTick) * (miniTimeline.width - 28)),
    [currentTick, timelineMaxTick, miniTimeline.width],
  )

  const timelineDurationSeconds = useMemo(() => {
    if (!result) {
      return 0
    }
    const ticksPerSecond = (result.meta.ppq * timelineTempoBpm) / 60
    if (!Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) {
      return 0
    }
    return timelineMaxTick / ticksPerSecond
  }, [result, timelineTempoBpm, timelineMaxTick])

  function setCurrentTickClamped(value: number): void {
    setCurrentTick(Math.min(timelineMaxTick, Math.max(0, value)))
  }

  function ensureAudioContext(): AudioContext | null {
    const BrowserAudioContext = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!BrowserAudioContext) {
      return null
    }

    if (!audioContextRef.current) {
      audioContextRef.current = new BrowserAudioContext()
    }

    return audioContextRef.current
  }

  function ensureNoiseBuffer(context: AudioContext): AudioBuffer {
    if (noiseBufferRef.current) {
      return noiseBufferRef.current
    }

    const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate)
    const channel = buffer.getChannelData(0)
    for (let index = 0; index < channel.length; index += 1) {
      channel[index] = Math.random() * 2 - 1
    }

    noiseBufferRef.current = buffer
    return buffer
  }

  function triggerDrumSound(note: { lane: 0 | 1 | 2 | 3 | 4; cymbal: boolean; openHiHat: boolean }): void {
    const context = ensureAudioContext()
    if (!context || context.state !== 'running') {
      return
    }

    const now = context.currentTime
    const out = context.createGain()
    out.gain.setValueAtTime(0.0001, now)
    out.connect(context.destination)

    if (note.lane === 0) {
      const osc = context.createOscillator()
      const gain = context.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(160, now)
      osc.frequency.exponentialRampToValueAtTime(48, now + 0.09)
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.exponentialRampToValueAtTime(0.9, now + 0.005)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13)
      osc.connect(gain)
      gain.connect(out)
      osc.start(now)
      osc.stop(now + 0.14)
    } else if (note.lane === 1) {
      const noise = context.createBufferSource()
      noise.buffer = ensureNoiseBuffer(context)
      const highpass = context.createBiquadFilter()
      highpass.type = 'highpass'
      highpass.frequency.setValueAtTime(1200, now)
      const noiseGain = context.createGain()
      noiseGain.gain.setValueAtTime(0.0001, now)
      noiseGain.gain.exponentialRampToValueAtTime(0.5, now + 0.003)
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11)
      noise.connect(highpass)
      highpass.connect(noiseGain)
      noiseGain.connect(out)
      noise.start(now)
      noise.stop(now + 0.12)

      const body = context.createOscillator()
      const bodyGain = context.createGain()
      body.type = 'triangle'
      body.frequency.setValueAtTime(210, now)
      body.frequency.exponentialRampToValueAtTime(140, now + 0.08)
      bodyGain.gain.setValueAtTime(0.0001, now)
      bodyGain.gain.exponentialRampToValueAtTime(0.28, now + 0.004)
      bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09)
      body.connect(bodyGain)
      bodyGain.connect(out)
      body.start(now)
      body.stop(now + 0.1)
    } else if (note.cymbal) {
      const noise = context.createBufferSource()
      noise.buffer = ensureNoiseBuffer(context)
      const bandpass = context.createBiquadFilter()
      bandpass.type = 'bandpass'
      bandpass.frequency.setValueAtTime(
        note.openHiHat ? 6800 : note.lane === 2 ? 6000 : note.lane === 3 ? 5000 : 4500,
        now,
      )
      bandpass.Q.setValueAtTime(1.2, now)
      const gain = context.createGain()
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.exponentialRampToValueAtTime(note.openHiHat ? 0.5 : 0.45, now + 0.002)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + (note.openHiHat ? 0.34 : 0.24))
      noise.connect(bandpass)
      bandpass.connect(gain)
      gain.connect(out)
      noise.start(now)
      noise.stop(now + (note.openHiHat ? 0.36 : 0.25))
    } else {
      const osc = context.createOscillator()
      const gain = context.createGain()
      osc.type = 'triangle'
      const startHz = note.lane === 2 ? 280 : note.lane === 3 ? 210 : 160
      const endHz = note.lane === 2 ? 220 : note.lane === 3 ? 160 : 120
      osc.frequency.setValueAtTime(startHz, now)
      osc.frequency.exponentialRampToValueAtTime(endHz, now + 0.13)
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.exponentialRampToValueAtTime(0.6, now + 0.004)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16)
      osc.connect(gain)
      gain.connect(out)
      osc.start(now)
      osc.stop(now + 0.17)
    }

    out.gain.exponentialRampToValueAtTime(0.0001, now + 0.28)
  }

  useEffect(() => {
    setIsTimelinePlaying(false)
    setCurrentTick(0)
    playbackCursorRef.current = 0
    lastAudioTickRef.current = 0
  }, [result])

  useEffect(() => {
    if (!isTimelinePlaying || !result) {
      return
    }

    const ticksPerSecond = (result.meta.ppq * timelineTempoBpm) / 60
    if (!Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) {
      setIsTimelinePlaying(false)
      return
    }

    let raf = 0
    let last = performance.now()
    const startIndex = playbackNotes.findIndex((note) => note.tick >= currentTick)
    playbackCursorRef.current = startIndex >= 0 ? startIndex : playbackNotes.length
    lastAudioTickRef.current = currentTick

    const frame = (now: number) => {
      const elapsedMs = Math.max(0, now - last)
      // Cap frame delta so tab throttling/resume cannot cause large jumps.
      const deltaSeconds = Math.min(0.1, elapsedMs / 1000)
      last = now

      setCurrentTick((prev) => {
        const clampedPrev = Math.min(timelineMaxTick, Math.max(0, prev))
        const next = Math.min(
          timelineMaxTick,
          Math.max(clampedPrev, clampedPrev + deltaSeconds * ticksPerSecond * playbackRate),
        )

        let cursor = playbackCursorRef.current
        while (cursor < playbackNotes.length && playbackNotes[cursor].tick <= next) {
          const note = playbackNotes[cursor]
          if (note.tick >= lastAudioTickRef.current) {
            triggerDrumSound(note)
          }
          cursor += 1
        }
        playbackCursorRef.current = cursor
        lastAudioTickRef.current = next

        if (next >= timelineMaxTick) {
          setIsTimelinePlaying(false)
          return timelineMaxTick
        }
        return next
      })

      raf = window.requestAnimationFrame(frame)
    }

    raf = window.requestAnimationFrame(frame)
    return () => window.cancelAnimationFrame(raf)
  // triggerDrumSound is intentionally stable for this playback loop and does not depend on render state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTimelinePlaying, result, timelineTempoBpm, timelineMaxTick, playbackRate, playbackNotes])

  useEffect(() => {
    const container = timelineScrollRef.current
    if (!container) {
      return
    }

    if (container.scrollWidth <= container.clientWidth) {
      return
    }

    const desired = currentTickX - container.clientWidth * 0.5
    const clamped = Math.max(0, Math.min(desired, container.scrollWidth - container.clientWidth))
    container.scrollLeft = clamped
  }, [timelineZoom, currentTickX])

  useEffect(() => {
    if (!isTimelinePlaying) {
      return
    }
    const container = timelineScrollRef.current
    if (!container) {
      return
    }

    const desired = currentTickX - container.clientWidth * 0.45
    const clamped = Math.max(0, Math.min(desired, container.scrollWidth - container.clientWidth))
    container.scrollLeft = clamped
  }, [currentTickX, isTimelinePlaying])

  function isMidiFile(file: File): boolean {
    const lower = file.name.toLowerCase()
    return ACCEPTED_MIDI_EXTENSIONS.some((ext) => lower.endsWith(ext))
  }

  function isGpFile(file: File): boolean {
    const lower = file.name.toLowerCase()
    return ACCEPTED_GP_EXTENSIONS.some((ext) => lower.endsWith(ext))
  }

  async function onFilePicked(file: File | null): Promise<void> {
    if (!file) {
      return
    }

    const midi = isMidiFile(file)
    const gp = isGpFile(file)

    if (!midi && !gp) {
      setErrorMessage('Please select a valid file: .mid/.midi or .gp/.gpif/.gpx')
      return
    }

    setInputKind(midi ? 'midi' : 'gp')
    setSelectedFile(file)
    setResult(null)
    setErrorMessage(null)
    setMidiInfo(null)
    setSelectedMidiTrackIndices([])
    setGpInfo(null)
    setSelectedGpTrackId('')

    if (midi) {
      try {
        const parsed = await inspectMidiFile(file)
        setMidiInfo(parsed)
        setSelectedMidiTrackIndices(
          suggestMidiTrackIndices(parsed, options.instrumentMode, options.preferChannel10Only),
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not parse MIDI file.'
        setErrorMessage(message)
      }
    }

    if (gp) {
      try {
        const parsed = await inspectGpFile(file)
        setGpInfo(parsed)
        const defaultTrack = parsed.tracks.find((track) => track.isDrums) ?? parsed.tracks[0]
        setSelectedGpTrackId(defaultTrack?.id ?? '')
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not parse GP file.'
        setErrorMessage(message)
      }
    }
  }

  async function runConversion(): Promise<void> {
    if (!selectedFile) {
      setErrorMessage('Choose a source file first.')
      return
    }

    const remapParse = parseManualMidiRemap(manualMidiRemapText)
    if (remapParse.error) {
      setErrorMessage(remapParse.error)
      return
    }

    const effectiveOptions: ConvertOptions = {
      ...options,
      manualMidiRemap: remapParse.map,
      midiTrackIndices: inputKind === 'midi' ? selectedMidiTrackIndices : undefined,
    }

    setIsBusy(true)
    setErrorMessage(null)

    try {
      let converted: ConversionResult
      if (inputKind === 'gp') {
        if (!selectedGpTrackId) {
          throw new Error('Choose a GP track before converting.')
        }
        converted = await convertGpToCloneHeroChart(selectedFile, selectedGpTrackId, effectiveOptions)
      } else {
        converted = await convertMidiToCloneHeroChart(selectedFile, effectiveOptions)
      }

      setResult(converted)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Conversion failed.'
      setErrorMessage(message)
      setResult(null)
    } finally {
      setIsBusy(false)
    }
  }

  function downloadChart(): void {
    if (!result) {
      return
    }

    const blob = new Blob([result.chartText], { type: 'text/plain;charset=utf-8' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = result.outputFileName
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(link.href)
  }

  function setDifficulty(value: DrumDifficulty): void {
    setOptions((prev) => ({ ...prev, difficulty: value }))
  }

  return (
    <main className="page-shell">
      <section className="hero-card">
        <div className="hero-headline">
          <span className="hero-brand-chip">
            <img src={siteIcon} alt="MIDI to CH Chart logo" className="hero-brand-icon" />
            MIDI to CH Chart
          </span>
          <p className="kicker">Clone Hero Chart Converter</p>
          <h1>Build stage-ready Clone Hero charts with GuitarPro or Midi Files</h1>
          <p className="lead">
            Pull in MIDI or Guitar Pro tracks, tune your mapping, then export a
            <strong> .chart </strong>
            with fretboard-aware lanes and synced timing.
          </p>
        </div>
        <div className="pill-row">
          <span className="pill">Drums + guitar + bass modes</span>
          <span className="pill">Pick one or multiple MIDI tracks</span>
          <span className="pill">Tempo + signature lock</span>
        </div>
      </section>

      <section className="grid-layout">
        <article className="panel uploader">
          <h2>1. Pick Source File</h2>
          <label
            className={`dropzone ${isDragging ? 'dragging' : ''}`}
            onDragOver={(event) => {
              event.preventDefault()
              setIsDragging(true)
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => {
              event.preventDefault()
              setIsDragging(false)
              void onFilePicked(event.dataTransfer.files?.[0] ?? null)
            }}
          >
            <input
              type="file"
              accept=".mid,.midi,.gp,.gpif,.gpx,audio/midi,audio/x-midi"
              onChange={(event) => {
                void onFilePicked(event.target.files?.[0] ?? null)
              }}
            />
            <span className="dropzone-title">Drop MIDI or GP file here</span>
            <span className="dropzone-subtitle">Supports .mid/.midi and .gp/.gpif/.gpx</span>
          </label>

          <p className="meta-row">
            Selected:{' '}
            <strong>{selectedFile ? selectedFile.name : 'No file selected'}</strong>
          </p>

          {inputKind === 'midi' && midiInfo ? (
            <div className="gp-track-box">
              <p className="meta-row">
                MIDI track selection: choose one or more tracks to convert.
              </p>
              <div className="midi-track-list">
                {midiInfo.tracks
                  .filter((track) => track.noteCount > 0)
                  .map((track) => {
                    const checked = selectedMidiTrackIndices.includes(track.index)
                    return (
                      <label key={`midi-track-${track.index}`} className="midi-track-item">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            const next = new Set(selectedMidiTrackIndices)
                            if (event.target.checked) {
                              next.add(track.index)
                            } else {
                              next.delete(track.index)
                            }
                            setSelectedMidiTrackIndices([...next].sort((a, b) => a - b))
                          }}
                        />
                        <span>
                          <strong>{track.name}</strong> | channel{' '}
                          {track.channel == null ? 'n/a' : track.channel + 1} | notes {track.noteCount}
                        </span>
                      </label>
                    )
                  })}
              </div>
              <span className="hint-row">If none are selected, conversion falls back to auto-pick.</span>
            </div>
          ) : null}

          {inputKind === 'gp' && gpInfo ? (
            <div className="gp-track-box">
              <p className="meta-row">
                GP Song: <strong>{gpInfo.title}</strong> by <strong>{gpInfo.artist}</strong>
              </p>
              <p className="gp-warning-note" role="status">
                Notes can sometimes be missing from GP files. We are actively fixing this glitch.
                MIDI files usually convert more reliably right now.
              </p>
              <label className="select-row">
                Isolate Track / Part
                <select
                  value={selectedGpTrackId}
                  onChange={(event) => setSelectedGpTrackId(event.target.value)}
                >
                  {gpInfo.tracks.map((track) => (
                    <option key={track.id} value={track.id}>
                      {gpTrackOptionLabel(track)} {track.isDrums ? '(drums)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <div className="track-details-list">
                {gpInfo.tracks.map((track) => (
                  <p key={`track-meta-${track.id}`}>
                    <strong>{track.fileTrackName || track.name || `Track ${track.id}`}</strong> | official:{' '}
                    {track.officialName || 'Unknown'} | short: {track.shortName || '-'} | type:{' '}
                    {track.type || '-'} {track.isDrums ? '| drums-like' : ''}
                  </p>
                ))}
              </div>
            </div>
          ) : null}

          <h2>2. Conversion Settings</h2>
          <div className="control-stack">
            <label className="select-row">
              Instrument mode
              <select
                value={options.instrumentMode}
                onChange={(event) =>
                  setOptions((prev) => ({
                    ...prev,
                    instrumentMode: event.target.value as ConvertOptions['instrumentMode'],
                  }))
                }
              >
                <option value="drums">Drums (Pro Drums)</option>
                <option value="guitar">Guitar (ExpertSingle)</option>
                <option value="bass">Bass (ExpertDoubleBass)</option>
              </select>
            </label>

            {options.instrumentMode === 'guitar' ? (
              <label className="select-row">
                Guitar max fret
                <input
                  type="number"
                  min={8}
                  max={30}
                  value={options.guitarMaxFret}
                  onChange={(event) =>
                    setOptions((prev) => ({
                      ...prev,
                      guitarMaxFret: Math.max(8, Math.min(30, Number(event.target.value) || 22)),
                    }))
                  }
                />
              </label>
            ) : null}

            {options.instrumentMode === 'bass' ? (
              <label className="select-row">
                Bass max fret
                <input
                  type="number"
                  min={8}
                  max={28}
                  value={options.bassMaxFret}
                  onChange={(event) =>
                    setOptions((prev) => ({
                      ...prev,
                      bassMaxFret: Math.max(8, Math.min(28, Number(event.target.value) || 20)),
                    }))
                  }
                />
              </label>
            ) : null}

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={options.preferChannel10Only}
                onChange={(event) =>
                  setOptions((prev) => ({
                    ...prev,
                    preferChannel10Only: event.target.checked,
                  }))
                }
              />
              Prefer channel 10 tracks only
            </label>

            {isDrumMode ? (
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={options.emitCymbalMarkers}
                  onChange={(event) =>
                    setOptions((prev) => ({
                      ...prev,
                      emitCymbalMarkers: event.target.checked,
                    }))
                  }
                />
                Emit pro-drums cymbal marker notes
              </label>
            ) : null}

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={options.accentOpenHiHatOnYellowCymbal}
                disabled={!isDrumMode}
                onChange={(event) =>
                  setOptions((prev) => ({
                    ...prev,
                    accentOpenHiHatOnYellowCymbal: event.target.checked,
                  }))
                }
              />
              Accent yellow cymbal (hi-hat/open hi-hat) {isDrumMode ? '' : '(drums only)'}
            </label>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={options.forceZeroLengthNotes}
                onChange={(event) =>
                  setOptions((prev) => ({
                    ...prev,
                    forceZeroLengthNotes: event.target.checked,
                  }))
                }
              />
              Force zero-length drum gems
            </label>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={options.preserveStackedHits}
                onChange={(event) =>
                  setOptions((prev) => ({
                    ...prev,
                    preserveStackedHits: event.target.checked,
                  }))
                }
              />
              Preserve stacked hits (nudge same-tick collisions)
            </label>

            {isDrumMode ? (
              <label className="select-row">
                Difficulty section
                <select
                  value={options.difficulty}
                  onChange={(event) => setDifficulty(event.target.value as DrumDifficulty)}
                >
                  <option value="EasyDrums">EasyDrums</option>
                  <option value="MediumDrums">MediumDrums</option>
                  <option value="HardDrums">HardDrums</option>
                  <option value="ExpertDrums">ExpertDrums</option>
                </select>
              </label>
            ) : null}

            <label className="select-row">
              Manual MIDI remap rules (applies to MIDI and GP)
              <textarea
                className="remap-editor"
                value={manualMidiRemapText}
                onChange={(event) => setManualMidiRemapText(event.target.value)}
                placeholder={'Examples:\n31->38\n44->42\n# one rule per line'}
              />
              <span className="hint-row">
                Use one rule per line, with <strong>source-&gt;target</strong>. Values must be 0-127.
              </span>
            </label>
          </div>

          <div className="action-row">
            <button
              className="primary-btn"
              onClick={() => void runConversion()}
              disabled={!selectedFile || isBusy}
            >
              {isBusy ? 'Converting...' : 'Convert to .chart'}
            </button>
            <button
              className="secondary-btn"
              onClick={downloadChart}
              disabled={!result || isBusy}
            >
              Download chart
            </button>
          </div>

          {errorMessage ? <p className="error-row">{errorMessage}</p> : null}
        </article>

        <article className="panel results">
          <h2>3. Results</h2>

          {result ? (
            <>
              <div className="stat-grid">
                <div className="stat-card">
                  <span className="stat-label">Mapped Notes</span>
                  <strong>{result.meta.totalMappedNotes}</strong>
                </div>
                <div className="stat-card">
                  <span className="stat-label">PPQ / Resolution</span>
                  <strong>{result.meta.ppq}</strong>
                </div>
                <div className="stat-card">
                  <span className="stat-label">
                    {result.meta.instrumentMode === 'drums' ? 'Cymbal Flags' : 'Median Fret'}
                  </span>
                  <strong>
                    {result.meta.instrumentMode === 'drums'
                      ? result.meta.stats.cymbalFlags
                      : (result.meta.fretboardSummary?.medianFret ?? 0).toFixed(1)}
                  </strong>
                </div>
                <div className="stat-card">
                  <span className="stat-label">Unmapped Notes</span>
                  <strong>{result.meta.stats.unmapped}</strong>
                </div>
              </div>

              <div className="lane-breakdown">
                {result.meta.instrumentMode === 'drums' ? (
                  <>
                    <p>
                      Lanes: Kick {result.meta.stats.kick} | Red {result.meta.stats.red}{' '}
                      | Yellow {result.meta.stats.yellow} | Blue {result.meta.stats.blue} |
                      Green {result.meta.stats.green}
                    </p>
                    <p>Detected open hi-hat notes: {openHiHatCount}</p>
                  </>
                ) : (
                  <>
                    <p>
                      Lanes (low -&gt; high fret): {result.meta.stats.laneCounts[0]} | {result.meta.stats.laneCounts[1]} | {result.meta.stats.laneCounts[2]} | {result.meta.stats.laneCounts[3]} | {result.meta.stats.laneCounts[4]}
                    </p>
                    <p>
                      Fret range: {result.meta.fretboardSummary?.minFret ?? 0} - {result.meta.fretboardSummary?.maxUsedFret ?? 0} (avg {((result.meta.fretboardSummary?.averageFret ?? 0)).toFixed(2)})
                    </p>
                  </>
                )}
                <p>Source tracks: {result.meta.usedTrackNames.join(', ')}</p>
              </div>

              <h3>Source MIDI Note Histogram</h3>
              <div className="histogram-grid">
                {result.meta.sourceNoteHistogram.slice(0, 16).map((entry) => (
                  <div key={`src-${entry.midi}`} className="histogram-item">
                    <span>MIDI {entry.midi}</span>
                    <strong>{entry.count}</strong>
                  </div>
                ))}
              </div>

              {result.meta.unmappedHistogram.length > 0 ? (
                <>
                  <h3>Unmapped MIDI Notes</h3>
                  <div className="histogram-grid">
                    {result.meta.unmappedHistogram.slice(0, 16).map((entry) => (
                      <div key={`unmapped-${entry.midi}`} className="histogram-item unmapped">
                        <span>MIDI {entry.midi}</span>
                        <strong>{entry.count}</strong>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}

              {result.meta.kickSourceHistogram.length > 0 ? (
                <>
                  <h3>Kick Source MIDI Notes</h3>
                  <div className="histogram-grid">
                    {result.meta.kickSourceHistogram.slice(0, 12).map((entry) => (
                      <div key={`kick-src-${entry.midi}`} className="histogram-item">
                        <span>MIDI {entry.midi}</span>
                        <strong>{entry.count}</strong>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}

              <h3>Chart Preview</h3>
              <p className="sequence-row">
                First mapped hits:{' '}
                <strong>{firstMappedHits.slice(0, 12).join(' -> ') || 'n/a'}</strong>
              </p>
              <textarea readOnly value={chartPreview} rows={18} />
            </>
          ) : (
            <p className="empty-state">
              Convert a MIDI or GP part to preview the generated chart contents.
            </p>
          )}
        </article>
      </section>

      {result ? (
        <section className="timeline-panel">
          <h2>Selected Track Timeline</h2>
          <p className="timeline-caption">
            Interactive mini chart. Play, rewind, scrub, zoom, and horizontally scroll through the full selected track.
          </p>
          <div className="timeline-controls">
            <button
              className="secondary-btn"
              onClick={() => {
                setIsTimelinePlaying(false)
                setCurrentTickClamped(0)
              }}
            >
              Rewind
            </button>
            <button
              className="primary-btn"
              onClick={() => {
                const context = ensureAudioContext()
                if (context && context.state === 'suspended') {
                  void context.resume()
                }
                if (currentTick >= timelineMaxTick) {
                  setCurrentTickClamped(0)
                }
                setIsTimelinePlaying((prev) => !prev)
              }}
            >
              {isTimelinePlaying ? 'Pause' : 'Play'}
            </button>
            <label className="timeline-input">
              Speed
              <select
                value={playbackRate}
                onChange={(event) => setPlaybackRate(Number(event.target.value))}
              >
                <option value={0.5}>0.5x</option>
                <option value={0.75}>0.75x</option>
                <option value={1}>1x</option>
                <option value={1.25}>1.25x</option>
                <option value={1.5}>1.5x</option>
                <option value={2}>2x</option>
              </select>
            </label>
            <label className="timeline-input">
              Zoom
              <input
                type="range"
                min={0.8}
                max={5}
                step={0.1}
                value={timelineZoom}
                onChange={(event) => setTimelineZoom(Number(event.target.value))}
              />
            </label>
            <label className="timeline-input stretch">
              Position
              <input
                type="range"
                min={0}
                max={timelineMaxTick}
                step={1}
                value={Math.round(currentTick)}
                onChange={(event) => {
                  setIsTimelinePlaying(false)
                  setCurrentTickClamped(Number(event.target.value))
                }}
              />
            </label>
            <p className="timeline-time">
              {timelineDurationSeconds > 0
                ? `${(timelineDurationSeconds * (currentTick / timelineMaxTick)).toFixed(2)}s / ${timelineDurationSeconds.toFixed(2)}s`
                : '0.00s / 0.00s'}
            </p>
          </div>
          <div className="timeline-wrap" ref={timelineScrollRef}>
            <svg
              viewBox={`0 0 ${miniTimeline.width} ${miniTimeline.height}`}
              width={miniTimeline.width}
              height={miniTimeline.height}
              style={{ width: `${miniTimeline.width}px`, height: `${miniTimeline.height}px` }}
              role="img"
              aria-label={timelineIsDrums ? 'Mapped drum timeline' : 'Mapped stringed timeline'}
              onClick={(event) => {
                const container = timelineScrollRef.current
                if (!container) {
                  return
                }
                const rect = container.getBoundingClientRect()
                const x = event.clientX - rect.left + container.scrollLeft
                const ratio = Math.min(1, Math.max(0, x / miniTimeline.width))
                setIsTimelinePlaying(false)
                setCurrentTickClamped(ratio * timelineMaxTick)
              }}
            >
              {[24, 49, 74, 99, 124].map((y) => (
                <line key={`lane-${y}`} x1="10" y1={y} x2={miniTimeline.width - 10} y2={y} className="timeline-lane" />
              ))}
              {timelineIsDrums
                ? miniTimeline.points
                    .filter((point) => point.lane === 0)
                    .map((point, index) => (
                      <line
                        key={`kick-bar-${index}`}
                        x1={point.x}
                        y1="10"
                        x2={point.x}
                        y2="138"
                        className="timeline-kick-bar"
                      />
                    ))
                : null}
              <line x1={currentTickX} y1="10" x2={currentTickX} y2="138" className="timeline-playhead" />
              {miniTimeline.points.map((point, index) => {
                if (timelineIsDrums && point.lane === 0) {
                  return null
                }

                const laneClassName =
                  point.lane === 0
                    ? 'timeline-note lane-kick'
                    : point.lane === 1
                    ? 'timeline-note lane-red'
                    : point.lane === 2
                      ? point.openHiHat
                        ? 'timeline-note lane-yellow open-hihat'
                        : 'timeline-note lane-yellow'
                      : point.lane === 3
                        ? 'timeline-note lane-blue'
                        : 'timeline-note lane-green'

                if (timelineIsDrums && point.cymbal) {
                  return (
                    <circle
                      key={`point-${index}`}
                      cx={point.x}
                      cy={point.y}
                      r="4.5"
                      className={`${laneClassName} timeline-note-cymbal`}
                    />
                  )
                }

                return (
                  <rect
                    key={`point-${index}`}
                    x={point.x - 4}
                    y={point.y - 4}
                    width="8"
                    height="8"
                    rx={timelineIsDrums ? 0 : 2}
                    className={`${laneClassName} ${timelineIsDrums ? 'timeline-note-drum' : ''}`}
                  />
                )
              })}
            </svg>
          </div>
          <p className="timeline-legend">
            {timelineIsDrums
              ? 'Top to bottom lanes: Green, Blue, Yellow, Red, Kick. Vertical bars are kick hits.'
              : 'Top to bottom lanes: Green, Blue, Yellow, Red, Low lane. Click anywhere in the mini chart to jump position.'}
          </p>
          {timelineIsDrums ? (
            <p className="timeline-legend timeline-legend-detail">
              Cymbals are circles, drums are squares, and open hi-hat notes have a glowing outline.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="legend">
        <h2>{isDrumMode ? 'Default Drum Mapping' : 'Stringed Mapping Heuristic'}</h2>
        {isDrumMode ? (
          <p>
            Kick: 35/36 | Red: snare notes | Yellow: hi-hat + high tom | Blue:
            ride/mid tom | Green: crash/floor tom. Cymbals emit note flags 66/67/68.
          </p>
        ) : (
          <p>
            Guitar/bass notes are assigned to probable strings and frets, then mapped to
            5 lanes by relative fret position. Lower-register phrases bias to lower lanes,
            and higher-register phrases bias to higher lanes.
          </p>
        )}
      </section>
    </main>
  )
}

export default App

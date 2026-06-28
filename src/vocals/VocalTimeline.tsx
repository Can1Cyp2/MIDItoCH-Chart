import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { midiToNoteName, type VocalNote } from '../lib/vocalsChart'
import { computePeaks, decodeAudio, detectBpm, type WavePeaks } from '../lib/audioAnalysis'
import { MelodySynth } from '../lib/melodySynth'

type BpmSource = 'midi' | 'detected' | 'custom'

const LANE_HEIGHT = 16
const RULER_HEIGHT = 22
const PITCH_PADDING = 2
const MIN_NOTE_WIDTH = 8
const LYRIC_LANE_HEIGHT = 34

interface VocalTimelineProps {
  notes: VocalNote[]
  onChangeLyric: (id: string, lyric: string) => void
  onShift: (orderedIds: string[], fromIndex: number, direction: 'earlier' | 'later') => void
  onFillRest: (orderedIds: string[], fromIndex: number, resumeToken: number) => void
  lyricTokenList: string[]
  onMergeNext: (orderedIds: string[], index: number) => void
  onUpdateNote: (id: string, patch: { time?: number; duration?: number; midi?: number }) => void
  onAddNote: (time: number, midi: number) => void
  onDeleteNote: (id: string) => void
  onSplitNote: (id: string) => void
  onUndo: () => void
  canUndo: boolean
  onRedo: () => void
  canRedo: boolean
  midiBpm: number | null
  midiBpmVaries: boolean
  onEffectiveBpmChange: (bpm: number | null) => void
  onAlignOffsetChange: (offset: number) => void
}

interface PitchBounds {
  min: number
  max: number
  height: number
}

/** Memoized note-block layer so it does not re-render every animation frame. */
const NotesLayer = memo(function NotesLayer({
  notes,
  pxPerSec,
  bounds,
  selectedId,
  onSelect,
  onPointerDown,
}: {
  notes: VocalNote[]
  pxPerSec: number
  bounds: PitchBounds
  selectedId: string | null
  onSelect: (id: string) => void
  onPointerDown: (id: string, clientX: number, clientY: number, mode: 'move' | 'resize') => void
}) {
  return (
    <>
      {notes.map((note) => {
        const left = note.time * pxPerSec
        const width = Math.max(MIN_NOTE_WIDTH, note.duration * pxPerSec)
        const top = (bounds.max - note.midi) * LANE_HEIGHT + RULER_HEIGHT
        const isSelected = note.id === selectedId
        const nonPitched = note.lyric.includes('#')
        return (
          <button
            type="button"
            key={note.id}
            className={`tl-note ${isSelected ? 'selected' : ''} ${note.lyric.trim() ? 'has-lyric' : ''} ${nonPitched ? 'non-pitched' : ''}`}
            style={{ left, width, top, height: LANE_HEIGHT - 2 }}
            title={`${midiToNoteName(note.midi)} @ ${note.time.toFixed(2)}s — drag to move (up/down = pitch), drag the right edge to resize`}
            onClick={(event) => {
              event.stopPropagation()
              onSelect(note.id)
            }}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onPointerDown(note.id, event.clientX, event.clientY, 'move')
            }}
          >
            <span className="tl-note-label">{midiToNoteName(note.midi)}</span>
            <span
              className="tl-note-resize"
              onMouseDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onPointerDown(note.id, event.clientX, event.clientY, 'resize')
              }}
            />
          </button>
        )
      })}
    </>
  )
})

function VocalTimeline({
  notes,
  onChangeLyric,
  onShift,
  onFillRest,
  lyricTokenList,
  onMergeNext,
  onUpdateNote,
  onAddNote,
  onDeleteNote,
  onSplitNote,
  onUndo,
  canUndo,
  onRedo,
  canRedo,
  midiBpm,
  midiBpmVaries,
  onEffectiveBpmChange,
  onAlignOffsetChange,
}: VocalTimelineProps) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [pxPerSec, setPxPerSec] = useState(120)
  const [audioOffset, setAudioOffset] = useState(0)
  const [follow, setFollow] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [typeAlong, setTypeAlong] = useState('')
  const [audioDuration, setAudioDuration] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [songVolume, setSongVolume] = useState(1)
  const [midiVolume, setMidiVolume] = useState(0.9)
  const [resumeOffset, setResumeOffset] = useState(0)
  const [peaks, setPeaks] = useState<WavePeaks | null>(null)
  const [detectedBpm, setDetectedBpm] = useState<number | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [bpmSource, setBpmSource] = useState<BpmSource>('midi')
  const [customBpm, setCustomBpm] = useState(120)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const playheadRef = useRef<HTMLDivElement | null>(null)
  const timeLabelRef = useRef<HTMLSpanElement | null>(null)
  const waveRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const synthRef = useRef<MelodySynth | null>(null)
  const dragRef = useRef<
    | null
    | { id: string; mode: 'move' | 'resize'; startX: number; startY: number; time: number; duration: number; midi: number }
  >(null)
  const onUpdateNoteRef = useRef(onUpdateNote)
  const timeScaleRef = useRef(1)
  const togglePlayRef = useRef<() => void>(() => {})
  const stepRef = useRef<(delta: number) => void>(() => {})

  const effectiveBpm =
    bpmSource === 'midi'
      ? midiBpm ?? customBpm
      : bpmSource === 'detected'
        ? detectedBpm ?? customBpm
        : customBpm

  // If the MIDI's stored tempo is wrong, the chosen BPM time-stretches the
  // melody so it plays (and exports) at the song's real speed.
  const timeScale =
    midiBpm && midiBpm > 0 && effectiveBpm && effectiveBpm > 0 ? midiBpm / effectiveBpm : 1

  // Keep the export side (in the parent) in sync with the chosen tempo + offset.
  useEffect(() => {
    onEffectiveBpmChange(effectiveBpm && effectiveBpm > 0 ? effectiveBpm : null)
  }, [effectiveBpm, onEffectiveBpmChange])

  useEffect(() => {
    onAlignOffsetChange(audioOffset)
  }, [audioOffset, onAlignOffsetChange])

  // Mutable mirrors so the rAF loop reads current values without re-subscribing.
  const offsetRef = useRef(audioOffset)
  const pxRef = useRef(pxPerSec)
  const followRef = useRef(follow)
  useEffect(() => {
    offsetRef.current = audioOffset
    pxRef.current = pxPerSec
    followRef.current = follow
    onUpdateNoteRef.current = onUpdateNote
    timeScaleRef.current = timeScale
    togglePlayRef.current = togglePlay
    stepRef.current = step
  })

  // Drag to move/resize notes. Listeners stay mounted and no-op unless dragging.
  useEffect(() => {
    function move(event: MouseEvent) {
      const drag = dragRef.current
      if (!drag) {
        return
      }
      const scale = pxRef.current * timeScaleRef.current
      if (scale <= 0) {
        return
      }
      const dt = (event.clientX - drag.startX) / scale
      if (drag.mode === 'move') {
        const dSemi = -Math.round((event.clientY - drag.startY) / LANE_HEIGHT)
        onUpdateNoteRef.current(drag.id, { time: Math.max(0, drag.time + dt), midi: drag.midi + dSemi })
      } else {
        onUpdateNoteRef.current(drag.id, { duration: Math.max(0.05, drag.duration + dt) })
      }
    }
    function up() {
      dragRef.current = null
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [])

  // Keyboard shortcuts: Space = play/pause, Left/Right = previous/next note.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) {
        return
      }
      if (event.code === 'Space') {
        event.preventDefault()
        togglePlayRef.current()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        stepRef.current(-1)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        stepRef.current(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Apply volumes.
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = songVolume
    }
  }, [songVolume, audioUrl])

  useEffect(() => {
    synthRef.current?.setVolume(midiVolume)
  }, [midiVolume])

  const sortedNotes = useMemo(() => {
    const base = [...notes].sort((a, b) => a.time - b.time)
    return timeScale === 1
      ? base
      : base.map((n) => ({ ...n, time: n.time * timeScale, duration: n.duration * timeScale }))
  }, [notes, timeScale])

  // Melody synth: lives for the component's lifetime; notes kept in sync.
  useEffect(() => {
    const synth = new MelodySynth()
    synth.onEnded = () => setIsPlaying(false)
    synthRef.current = synth
    return () => {
      synth.dispose()
      synthRef.current = null
    }
  }, [])

  useEffect(() => {
    synthRef.current?.setNotes(
      sortedNotes.map((n) => ({ time: n.time, duration: n.duration, midi: n.midi })),
    )
  }, [sortedNotes])

  const bounds = useMemo<PitchBounds>(() => {
    if (sortedNotes.length === 0) {
      return { min: 48, max: 72, height: 24 * LANE_HEIGHT }
    }
    const pitches = sortedNotes.map((n) => n.midi)
    const min = Math.min(...pitches) - PITCH_PADDING
    const max = Math.max(...pitches) + PITCH_PADDING
    return { min, max, height: (max - min + 1) * LANE_HEIGHT }
  }, [sortedNotes])

  const lastNoteEnd = useMemo(
    () => sortedNotes.reduce((max, n) => Math.max(max, n.time + n.duration), 0),
    [sortedNotes],
  )
  const totalSeconds = Math.max(lastNoteEnd, audioDuration) + 4
  const contentWidth = totalSeconds * pxPerSec

  const selectNote = useCallback((id: string) => {
    setSelectedId(id)
    setResumeOffset(0)
  }, [])

  // Begin a note drag; origin values are read from the canonical (unscaled) notes.
  const onNotePointerDown = useCallback(
    (id: string, clientX: number, clientY: number, mode: 'move' | 'resize') => {
      const note = notes.find((n) => n.id === id)
      if (!note) {
        return
      }
      dragRef.current = {
        id,
        mode,
        startX: clientX,
        startY: clientY,
        time: note.time,
        duration: note.duration,
        midi: note.midi,
      }
      setSelectedId(id)
    },
    [notes],
  )

  /** Current playhead position in (scaled) melody seconds. */
  function getMelodyTime(): number {
    const audio = audioRef.current
    if (audio) {
      return Math.max(0, audio.currentTime - audioOffset)
    }
    return synthRef.current?.getTime() ?? 0
  }

  const selectedIndex = sortedNotes.findIndex((n) => n.id === selectedId)
  const selectedNote = selectedIndex >= 0 ? sortedNotes[selectedIndex] : null

  // Best guess for where in the lyric list the selected note belongs: count the
  // real syllables placed before it, then, if the note already has a word, snap
  // to the nearest matching token so a correct anchor word re-syncs the resume.
  const autoResumeIndex = useMemo(() => {
    const start = selectedIndex >= 0 ? selectedIndex : 0
    let count = 0
    for (let i = 0; i < start; i += 1) {
      const l = sortedNotes[i].lyric.trim()
      if (l && l !== '+') count += 1
    }
    const anchor = selectedNote?.lyric.trim()
    if (anchor && anchor !== '+') {
      let best = -1
      for (let i = 0; i < lyricTokenList.length; i += 1) {
        if (lyricTokenList[i] === anchor && (best < 0 || Math.abs(i - count) < Math.abs(best - count))) {
          best = i
        }
      }
      if (best >= 0) return best
    }
    return Math.min(count, lyricTokenList.length)
  }, [sortedNotes, selectedIndex, selectedNote, lyricTokenList])

  // Effective resume point = auto guess + the user's manual nudge (picker).
  const resumeIndex = Math.max(0, Math.min(lyricTokenList.length, autoResumeIndex + resumeOffset))

  // Position the playhead, time readout, and (optionally) selection each frame.
  // The clock is the audio element when a song is loaded, otherwise the synth.
  useEffect(() => {
    function tick() {
      const audio = audioRef.current
      const synth = synthRef.current
      let melodyTime: number | null = null
      let readout = 0
      let playing = false
      if (audio) {
        melodyTime = audio.currentTime - offsetRef.current
        readout = audio.currentTime
        playing = !audio.paused
      } else if (synth) {
        melodyTime = synth.getTime()
        readout = melodyTime
        playing = synth.isPlaying
      }

      if (melodyTime != null) {
        const left = melodyTime * pxRef.current
        if (playheadRef.current) {
          playheadRef.current.style.left = `${left}px`
        }
        if (timeLabelRef.current) {
          timeLabelRef.current.textContent = `${readout.toFixed(2)}s`
        }
        const scroller = scrollRef.current
        if (scroller && playing) {
          const view = scroller.clientWidth
          if (left < scroller.scrollLeft + 60 || left > scroller.scrollLeft + view - 160) {
            scroller.scrollLeft = left - view / 3
          }
          if (followRef.current) {
            const time = melodyTime
            const cur = sortedNotes.find((n) => time >= n.time && time < n.time + n.duration)
            if (cur) {
              setSelectedId((prev) => (prev === cur.id ? prev : cur.id))
            }
          }
        }
      }
      rafRef.current = window.requestAnimationFrame(tick)
    }
    rafRef.current = window.requestAnimationFrame(tick)
    return () => {
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current)
      }
    }
  }, [sortedNotes])

  useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl)
      }
    }
  }, [audioUrl])

  // Draw the waveform (audio energy under the notes) and the BPM beat grid.
  // Uses a viewport-sized canvas kept pinned to scrollLeft so it stays valid
  // even when the full timeline is far wider than a canvas can be.
  useEffect(() => {
    function draw() {
      const canvas = waveRef.current
      const scroller = scrollRef.current
      if (!canvas || !scroller) {
        return
      }
      const view = scroller.clientWidth
      const sl = scroller.scrollLeft
      const h = bounds.height
      if (canvas.width !== view) canvas.width = view
      if (canvas.height !== h) canvas.height = h
      canvas.style.left = `${sl}px`
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        return
      }
      ctx.clearRect(0, 0, view, h)

      if (peaks) {
        ctx.strokeStyle = 'rgba(120, 180, 255, 0.4)'
        ctx.beginPath()
        for (let px = 0; px < view; px += 1) {
          const audioTime = (sl + px) / pxPerSec + audioOffset
          if (audioTime < 0 || audioTime >= peaks.duration) {
            continue
          }
          const b = Math.floor(audioTime * peaks.bucketsPerSec)
          if (b < 0 || b >= peaks.max.length) {
            continue
          }
          const y1 = (1 - peaks.max[b]) * 0.5 * h
          const y2 = (1 - peaks.min[b]) * 0.5 * h
          ctx.moveTo(px + 0.5, y1)
          ctx.lineTo(px + 0.5, y2)
        }
        ctx.stroke()
      }

      if (effectiveBpm && effectiveBpm > 0) {
        const beatSec = 60 / effectiveBpm
        const audioLo = sl / pxPerSec + audioOffset
        const audioHi = (sl + view) / pxPerSec + audioOffset
        const kStart = Math.max(0, Math.floor(audioLo / beatSec))
        const kEnd = Math.ceil(audioHi / beatSec)
        for (let k = kStart; k <= kEnd && k - kStart < 2000; k += 1) {
          const px = (k * beatSec - audioOffset) * pxPerSec - sl
          if (px < 0 || px > view) {
            continue
          }
          ctx.strokeStyle = k % 4 === 0 ? 'rgba(255, 231, 153, 0.35)' : 'rgba(255, 231, 153, 0.13)'
          ctx.beginPath()
          ctx.moveTo(px + 0.5, 0)
          ctx.lineTo(px + 0.5, h)
          ctx.stroke()
        }
      }
    }

    draw()
    const scroller = scrollRef.current
    scroller?.addEventListener('scroll', draw)
    return () => scroller?.removeEventListener('scroll', draw)
  }, [peaks, pxPerSec, audioOffset, effectiveBpm, bounds.height, bounds.max])

  async function onAudioPicked(file: File | null): Promise<void> {
    if (!file) {
      return
    }
    setAudioUrl((prev) => {
      if (prev) {
        URL.revokeObjectURL(prev)
      }
      return URL.createObjectURL(file)
    })
    setPeaks(null)
    setDetectedBpm(null)
    setAnalyzing(true)
    try {
      const buffer = await decodeAudio(file)
      setAudioDuration(buffer.duration)
      setPeaks(computePeaks(buffer))
      const bpm = await detectBpm(buffer)
      setDetectedBpm(bpm)
      if (bpm) {
        setBpmSource('detected')
      }
    } catch {
      // Leave waveform/BPM unset; manual offset + custom BPM still work.
    } finally {
      setAnalyzing(false)
    }
  }

  function togglePlay(): void {
    const synth = synthRef.current
    const audio = audioRef.current
    if (audio) {
      // Song loaded: audio is the clock, but play the melody synth alongside it
      // so the notes are audible over the mix (balance with the volume sliders).
      if (audio.paused) {
        void audio.play()
        synth?.play(audio.currentTime - audioOffset)
        setIsPlaying(true)
      } else {
        audio.pause()
        synth?.pause()
        setIsPlaying(false)
      }
      return
    }
    // No song loaded: play the synthesized melody on its own.
    if (!synth || sortedNotes.length === 0) {
      return
    }
    if (synth.isPlaying) {
      synth.pause()
      setIsPlaying(false)
    } else {
      synth.play()
      setIsPlaying(true)
    }
  }

  // Note add/delete/split/resize operate in canonical (unscaled) seconds.
  const scaleDown = (displaySeconds: number) => (timeScale > 0 ? displaySeconds / timeScale : displaySeconds)

  function addNoteAtPlayhead(): void {
    const midi = selectedNote?.midi ?? Math.round((bounds.min + bounds.max) / 2)
    onAddNote(scaleDown(getMelodyTime()), midi)
  }

  function nudgeDuration(deltaSeconds: number): void {
    if (!selectedNote) {
      return
    }
    onUpdateNote(selectedNote.id, { duration: scaleDown(selectedNote.duration) + deltaSeconds })
  }

  function stopAll(): void {
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.currentTime = 0
    }
    const synth = synthRef.current
    if (synth) {
      synth.pause()
      synth.seek(0)
    }
    setIsPlaying(false)
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = 0
    }
    if (playheadRef.current) {
      playheadRef.current.style.left = '0px'
    }
  }

  function onTimelineClick(event: React.MouseEvent<HTMLDivElement>): void {
    const scroller = scrollRef.current
    if (!scroller) {
      return
    }
    const rect = scroller.getBoundingClientRect()
    const x = event.clientX - rect.left + scroller.scrollLeft
    const melodyTime = Math.max(0, x / pxPerSec)
    const audio = audioRef.current
    if (audio) {
      audio.currentTime = Math.max(0, melodyTime + audioOffset)
      synthRef.current?.seek(melodyTime)
    } else {
      synthRef.current?.seek(melodyTime)
    }
  }

  function commitTypeAlong(): void {
    if (!selectedNote || typeAlong.trim() === '') {
      return
    }
    onChangeLyric(selectedNote.id, typeAlong.trim())
    setTypeAlong('')
    if (!follow) {
      const next = sortedNotes[selectedIndex + 1]
      if (next) {
        setSelectedId(next.id)
      }
    }
  }

  function applyToSelected(transform: (lyric: string) => string): void {
    if (!selectedNote) {
      return
    }
    onChangeLyric(selectedNote.id, transform(selectedNote.lyric))
  }

  function startInlineEdit(note: VocalNote): void {
    setSelectedId(note.id)
    setDraft(note.lyric)
    setEditingId(note.id)
  }

  function commitInlineEdit(): void {
    if (editingId) {
      onChangeLyric(editingId, draft.trim())
    }
    setEditingId(null)
  }

  function step(delta: number): void {
    if (sortedNotes.length === 0) {
      return
    }
    const base = selectedIndex >= 0 ? selectedIndex : delta > 0 ? -1 : 0
    const next = Math.min(sortedNotes.length - 1, Math.max(0, base + delta))
    const note = sortedNotes[next]
    setSelectedId(note.id)
    setResumeOffset(0)
    // Move the playhead to the note's start.
    const audio = audioRef.current
    if (audio) {
      audio.currentTime = Math.max(0, note.time + audioOffset)
      synthRef.current?.seek(note.time)
    } else {
      synthRef.current?.seek(note.time)
    }
    // Keep the newly selected note in view.
    const scroller = scrollRef.current
    if (scroller) {
      const left = note.time * pxPerSec
      const view = scroller.clientWidth
      if (left < scroller.scrollLeft + 40 || left > scroller.scrollLeft + view - 120) {
        scroller.scrollLeft = left - view / 3
      }
    }
  }

  function shift(direction: 'earlier' | 'later'): void {
    if (sortedNotes.length === 0) {
      return
    }
    const fromIndex = selectedIndex >= 0 ? selectedIndex : 0
    onShift(
      sortedNotes.map((n) => n.id),
      fromIndex,
      direction,
    )
  }

  function fillRest(): void {
    if (sortedNotes.length === 0) {
      return
    }
    onFillRest(
      sortedNotes.map((n) => n.id),
      selectedIndex >= 0 ? selectedIndex : 0,
      resumeIndex,
    )
  }

  function deleteSelected(): void {
    if (!selectedNote) {
      return
    }
    // Move selection to a neighbor so arrow nav continues from here, not the start.
    const neighbor = sortedNotes[selectedIndex + 1] ?? sortedNotes[selectedIndex - 1] ?? null
    setSelectedId(neighbor ? neighbor.id : null)
    onDeleteNote(selectedNote.id)
  }

  const rulerMarks = useMemo(() => {
    const stepSeconds = pxPerSec < 50 ? 5 : pxPerSec < 110 ? 2 : 1
    const marks: number[] = []
    for (let t = 0; t <= totalSeconds; t += stepSeconds) {
      marks.push(t)
    }
    return marks
  }, [pxPerSec, totalSeconds])

  return (
    <div className="timeline-wrap">
      <div className="transport">
        <label
          className="audio-pick"
          title="Load the song (or an isolated vocal stem) to play under the melody. The full mix works, but a vocal-only stem is easiest to line up by ear."
        >
          <input
            type="file"
            accept="audio/*"
            onChange={(event) => void onAudioPicked(event.target.files?.[0] ?? null)}
          />
          {audioUrl ? 'Change song audio' : 'Load song / vocal stem'}
        </label>
        <button
          type="button"
          className="secondary-btn"
          onClick={togglePlay}
          disabled={!audioUrl && sortedNotes.length === 0}
          title={
            audioUrl
              ? 'Play or pause the loaded song. The red playhead follows along and the view auto-scrolls.'
              : 'Play or pause the synthesized melody (each note at its pitch and length). Load a song to play against the real audio instead.'
          }
        >
          {isPlaying ? '⏸ Pause' : audioUrl ? '▶ Play' : '▶ Play melody'}
        </button>
        <button
          type="button"
          className="secondary-btn"
          onClick={stopAll}
          title="Stop all sounds (song + melody) and return the playhead to the start"
        >
          ⏹ Stop
        </button>
        <span className="time-readout" title="Current audio playback position, in seconds">
          <span ref={timeLabelRef}>0.00s</span>
        </span>

        <label className="ctrl" title="Stretch or squeeze the time axis — zoom in for dense passages, out for an overview">
          Zoom
          <input
            type="range"
            min={30}
            max={400}
            value={pxPerSec}
            onChange={(event) => setPxPerSec(Number(event.target.value))}
          />
        </label>

        <div
          className="ctrl offset-ctrl"
          title="Slide the whole melody relative to the audio so the notes line up with what you hear. Use this if the MIDI and audio don't start at the same moment."
        >
          Align offset
          <div className="offset-buttons">
            <button
              type="button"
              className="mini-btn"
              title="Shift melody 0.5s earlier relative to the audio"
              onClick={() => setAudioOffset((o) => o - 0.5)}
            >
              −0.5
            </button>
            <button
              type="button"
              className="mini-btn"
              title="Fine shift: 0.05s earlier"
              onClick={() => setAudioOffset((o) => o - 0.05)}
            >
              −
            </button>
            <span className="offset-value" title="Current melody-to-audio offset in seconds">
              {audioOffset.toFixed(2)}s
            </span>
            <button
              type="button"
              className="mini-btn"
              title="Fine shift: 0.05s later"
              onClick={() => setAudioOffset((o) => o + 0.05)}
            >
              +
            </button>
            <button
              type="button"
              className="mini-btn"
              title="Shift melody 0.5s later relative to the audio"
              onClick={() => setAudioOffset((o) => o + 0.5)}
            >
              +0.5
            </button>
          </div>
        </div>

        <label
          className="ctrl follow-ctrl"
          title="When on, the highlighted note tracks the playhead as the song plays, so type-along lands syllables on the note currently being sung."
        >
          <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
          Follow playhead
        </label>
      </div>

      <div className="transport bpm-row">
        <span
          className="ctrl"
          title="Playback tempo. If the MIDI's stored tempo is wrong, pick Detected or Custom to time-stretch the melody so it plays — and exports — at the song's real speed. Also drives the beat grid."
        >
          Tempo:
        </span>
        <button
          type="button"
          className={`mini-btn wide ${bpmSource === 'midi' ? 'active' : ''}`}
          disabled={midiBpm == null}
          title="Use the tempo stored in the melody MIDI"
          onClick={() => setBpmSource('midi')}
        >
          MIDI {midiBpm != null ? Math.round(midiBpm) : '—'}
          {midiBpmVaries ? '*' : ''}
        </button>
        <button
          type="button"
          className={`mini-btn wide ${bpmSource === 'detected' ? 'active' : ''}`}
          disabled={detectedBpm == null}
          title="Tempo auto-detected from the loaded audio. Reliable on strong-beat mixes, shaky on bare vocal stems — double-check it."
          onClick={() => setBpmSource('detected')}
        >
          Detected {analyzing ? '…' : detectedBpm != null ? detectedBpm : '—'}
        </button>
        <button
          type="button"
          className={`mini-btn wide ${bpmSource === 'custom' ? 'active' : ''}`}
          title="Type the tempo yourself"
          onClick={() => setBpmSource('custom')}
        >
          Custom
        </button>
        {bpmSource === 'custom' ? (
          <input
            type="number"
            className="bpm-input"
            min={40}
            max={300}
            value={customBpm}
            title="Custom tempo in beats per minute"
            onChange={(event) => setCustomBpm(Number(event.target.value) || 0)}
          />
        ) : null}
        <span
          className="offset-value"
          title="Effective playback tempo (drives stretch + beat grid)"
        >
          = {effectiveBpm ? Math.round(effectiveBpm) : '—'} BPM
          {timeScale !== 1 ? ` · ${(1 / timeScale).toFixed(2)}× speed` : ''}
        </span>

        <div className="volume-group">
          <label className="ctrl" title="Volume of the synthesized melody notes">
            🎹
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={midiVolume}
              onChange={(event) => setMidiVolume(Number(event.target.value))}
            />
          </label>
          <label
            className="ctrl"
            title={audioUrl ? 'Volume of the loaded song audio' : 'Load a song to set its volume'}
          >
            🎵
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={songVolume}
              disabled={!audioUrl}
              onChange={(event) => setSongVolume(Number(event.target.value))}
            />
          </label>
        </div>
      </div>

      {audioUrl ? (
        <audio
          ref={audioRef}
          src={audioUrl}
          onLoadedMetadata={(event) => setAudioDuration(event.currentTarget.duration || 0)}
          onPause={() => setIsPlaying(false)}
          onPlay={() => setIsPlaying(true)}
        />
      ) : null}

      <div className="timeline-scroll" ref={scrollRef} onClick={onTimelineClick}>
        <div
          className="timeline-content"
          style={{ width: contentWidth, height: bounds.height + RULER_HEIGHT + LYRIC_LANE_HEIGHT }}
        >
          <div className="tl-ruler" style={{ width: contentWidth }}>
            {rulerMarks.map((t) => (
              <span key={t} className="tl-ruler-mark" style={{ left: t * pxPerSec }}>
                {t}s
              </span>
            ))}
          </div>
          <canvas ref={waveRef} className="tl-wave" style={{ top: RULER_HEIGHT }} />
          <NotesLayer
            notes={sortedNotes}
            pxPerSec={pxPerSec}
            bounds={bounds}
            selectedId={selectedId}
            onSelect={selectNote}
            onPointerDown={onNotePointerDown}
          />
          <div
            className="tl-lyric-lane"
            style={{ top: RULER_HEIGHT + bounds.height, height: LYRIC_LANE_HEIGHT }}
          />
          {sortedNotes.map((note) => {
            const left = note.time * pxPerSec
            const top = RULER_HEIGHT + bounds.height + 6
            if (editingId === note.id) {
              return (
                <input
                  key={`lyric-${note.id}`}
                  className="tl-lyric-input"
                  style={{ left, top }}
                  autoFocus
                  value={draft}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={commitInlineEdit}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitInlineEdit()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      setEditingId(null)
                    }
                  }}
                />
              )
            }
            const text = note.lyric.trim()
            return (
              <button
                key={`lyric-${note.id}`}
                type="button"
                className={`tl-lyric ${note.id === selectedId ? 'selected' : ''} ${text ? '' : 'empty'}`}
                style={{ left, top }}
                title={`${text ? 'Lyric' : 'No lyric yet'} for ${midiToNoteName(note.midi)} @ ${note.time.toFixed(2)}s — click to select, double-click to edit`}
                onClick={(event) => {
                  event.stopPropagation()
                  setSelectedId(note.id)
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation()
                  startInlineEdit(note)
                }}
              >
                {text || '+'}
              </button>
            )
          })}
          <div
            ref={playheadRef}
            className="tl-playhead"
            style={{ height: bounds.height + RULER_HEIGHT + LYRIC_LANE_HEIGHT }}
          />
        </div>
      </div>

      <div className="note-editor">
        <button
          type="button"
          className="mini-btn"
          onClick={() => step(-1)}
          title="Select the previous note"
        >
          ◀
        </button>
        <span
          className="editor-pitch"
          title="Pitch and start time of the note you're editing"
        >
          {selectedNote ? `${midiToNoteName(selectedNote.midi)} · ${selectedNote.time.toFixed(2)}s` : 'No note selected'}
        </span>
        <input
          className="note-lyric"
          value={selectedNote?.lyric ?? ''}
          placeholder={selectedNote ? 'syllable' : 'click a note'}
          disabled={!selectedNote}
          title="Edit the selected note's syllable. End with '-' to continue a word; use '+' for a held/slide note."
          onChange={(event) => selectedNote && onChangeLyric(selectedNote.id, event.target.value)}
        />
        <button
          type="button"
          className="mini-btn"
          disabled={!selectedNote}
          title="Mark as '+' — a held note / pitch slide carrying the previous syllable"
          onClick={() => applyToSelected(() => '+')}
        >
          +
        </button>
        <button
          type="button"
          className="mini-btn"
          disabled={!selectedNote}
          title="Toggle a trailing hyphen — continue this word into the next note"
          onClick={() => applyToSelected((l) => (l.endsWith('-') ? l.replace(/-+$/, '') : `${l.replace(/-+$/, '')}-`))}
        >
          -
        </button>
        <button
          type="button"
          className="mini-btn"
          disabled={!selectedNote}
          title="Toggle '#' — a non-pitched (talky / distorted, not a real sung pitch) note"
          onClick={() => applyToSelected((l) => (l.includes('#') ? l.replace(/#/g, '') : `${l}#`))}
        >
          #
        </button>
        <button
          type="button"
          className="mini-btn wide"
          disabled={!selectedNote || !selectedNote.lyric.trim().endsWith('-')}
          title="Merge the next note's word onto this hyphenated note, then pull the rest of the lyrics back one note"
          onClick={() =>
            onMergeNext(
              sortedNotes.map((n) => n.id),
              selectedIndex,
            )
          }
        >
          ↩ merge next
        </button>
        <button
          type="button"
          className="mini-btn"
          disabled={!selectedNote}
          title="Select the next note"
          onClick={() => step(1)}
        >
          ▶
        </button>
      </div>

      <div className="note-editor note-tools">
        <button
          type="button"
          className="mini-btn wide"
          disabled={!canUndo}
          title="Undo the last change (Ctrl+Z)"
          onClick={onUndo}
        >
          ↶ undo
        </button>
        <button
          type="button"
          className="mini-btn wide"
          disabled={!canRedo}
          title="Redo the last undone change (Ctrl+Shift+Z or Ctrl+Y)"
          onClick={onRedo}
        >
          ↷ redo
        </button>
        <span className="shift-label">Notes:</span>
        <button
          type="button"
          className="mini-btn wide"
          title="Add a new note at the playhead (uses the selected note's pitch)"
          onClick={addNoteAtPlayhead}
        >
          ＋ add
        </button>
        <button
          type="button"
          className="mini-btn wide"
          disabled={!selectedNote}
          title="Delete the selected note (selection moves to the next note)"
          onClick={deleteSelected}
        >
          🗑 delete
        </button>
        <button
          type="button"
          className="mini-btn wide"
          disabled={!selectedNote}
          title="Split the selected note into two halves"
          onClick={() => selectedNote && onSplitNote(selectedNote.id)}
        >
          ✂ split
        </button>
        <span className="shift-label">Length:</span>
        <button
          type="button"
          className="mini-btn"
          disabled={!selectedNote}
          title="Make the selected note shorter (0.1s)"
          onClick={() => nudgeDuration(-0.1)}
        >
          −
        </button>
        <button
          type="button"
          className="mini-btn"
          disabled={!selectedNote}
          title="Make the selected note longer (0.1s)"
          onClick={() => nudgeDuration(0.1)}
        >
          +
        </button>
      </div>

      <div className="shift-block">
        <p className="shift-help">
          <strong>Shift lyrics:</strong> if the mapping is off from a certain point on, click a note
          or lyric where it goes wrong, then shift the whole grid beyond that point — without
          retyping. With nothing selected it shifts everything.
        </p>
        <div className="shift-row">
          <span className="shift-label">
            From {selectedNote ? `${midiToNoteName(selectedNote.midi)} @ ${selectedNote.time.toFixed(2)}s` : 'the start'}:
          </span>
          <button
            type="button"
            className="secondary-btn"
            disabled={sortedNotes.length === 0}
            title="A word landed too late: remove the lyric here and pull everything after it back one note"
            onClick={() => shift('earlier')}
          >
            ← move lyrics earlier
          </button>
          <button
            type="button"
            className="secondary-btn"
            disabled={sortedNotes.length === 0}
            title="A word landed too early: insert a blank here and push everything after it forward one note"
            onClick={() => shift('later')}
          >
            move lyrics later →
          </button>

          <div className="fill-rest-group">
            <span className="shift-label">Resume at:</span>
            <button
              type="button"
              className="mini-btn"
              disabled={lyricTokenList.length === 0}
              title="Pick an earlier word in the lyrics to resume from"
              onClick={() => setResumeOffset((o) => o - 1)}
            >
              ‹
            </button>
            <span className="resume-word" title="The word that will land on the selected note">
              {lyricTokenList[resumeIndex] ?? '(end)'}
            </span>
            <button
              type="button"
              className="mini-btn"
              disabled={lyricTokenList.length === 0}
              title="Pick a later word in the lyrics to resume from"
              onClick={() => setResumeOffset((o) => o + 1)}
            >
              ›
            </button>
            <button
              type="button"
              className="mini-btn"
              disabled={resumeOffset === 0}
              title="Reset to the auto-detected resume word"
              onClick={() => setResumeOffset(0)}
            >
              ↺ auto
            </button>
            <button
              type="button"
              className="primary-btn"
              disabled={sortedNotes.length === 0}
              title="Re-flow the lyrics from the word shown above across the selected note and every note after it. Keeps earlier lyrics. Select the note where it should resume; auto guesses the word, the arrows let you choose."
              onClick={fillRest}
            >
              ⤓ fill rest from here
            </button>
          </div>
        </div>
      </div>

      <div className="type-along">
        <input
          className="note-lyric"
          value={typeAlong}
          placeholder="Type-along: play the song, type the current syllable, press Enter"
          title="Play the song, then type each syllable and press Enter. It lands on the highlighted note (the one being sung when Follow playhead is on)."
          onChange={(event) => setTypeAlong(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitTypeAlong()
            }
          }}
        />
        <button
          type="button"
          className="secondary-btn"
          onClick={commitTypeAlong}
          disabled={!selectedNote}
          title="Assign the typed syllable to the selected note, then move to the next note"
        >
          Set &amp; advance
        </button>
      </div>

      <p className="shortcuts-hint">
        Shortcuts: <kbd>Space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> previous/next note ·{' '}
        <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> redo
      </p>
    </div>
  )
}

export default VocalTimeline

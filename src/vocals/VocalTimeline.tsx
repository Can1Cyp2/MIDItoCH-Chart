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
  onDeleteNotes: (ids: string[]) => void
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

interface ResumeOption {
  index: number
  token: string
  contextBefore: string[]
  contextAfter: string[]
  searchText: string
}

function cleanResumeToken(token: string): string {
  const trimmed = token.trim()
  return trimmed.length > 0 ? trimmed : '(blank)'
}

function buildResumeOptions(tokens: string[]): ResumeOption[] {
  return tokens.map((rawToken, index) => {
    const token = cleanResumeToken(rawToken)
    const contextBefore = tokens
      .slice(Math.max(0, index - 3), index)
      .map(cleanResumeToken)
    const contextAfter = tokens
      .slice(index + 1, Math.min(tokens.length, index + 4))
      .map(cleanResumeToken)

    return {
      index,
      token,
      contextBefore,
      contextAfter,
      searchText: [...contextBefore, token, ...contextAfter, String(index + 1)]
        .join(' ')
        .toLowerCase(),
    }
  })
}

/** Memoized note-block layer so it does not re-render every animation frame. */
const NotesLayer = memo(function NotesLayer({
  notes,
  pxPerSec,
  bounds,
  selectedIds,
  onSelect,
  onPointerDown,
}: {
  notes: VocalNote[]
  pxPerSec: number
  bounds: PitchBounds
  selectedIds: Set<string>
  onSelect: (id: string) => void
  onPointerDown: (
    id: string,
    clientX: number,
    clientY: number,
    mode: 'move' | 'resize-left' | 'resize-right',
  ) => void
}) {
  return (
    <>
      {notes.map((note) => {
        const left = note.time * pxPerSec
        const width = Math.max(MIN_NOTE_WIDTH, note.duration * pxPerSec)
        const top = (bounds.max - note.midi) * LANE_HEIGHT + RULER_HEIGHT
        const isSelected = selectedIds.has(note.id)
        const nonPitched = note.lyric.includes('#')
        return (
          <button
            type="button"
            key={note.id}
            className={`tl-note ${isSelected ? 'selected' : ''} ${note.lyric.trim() ? 'has-lyric' : ''} ${nonPitched ? 'non-pitched' : ''}`}
            style={{ left, width, top, height: LANE_HEIGHT - 2 }}
            title={`${midiToNoteName(note.midi)} @ ${note.time.toFixed(2)}s — drag to move (up/down = pitch); drag either end to resize. Hold Shift to lock time (pitch only), Alt to lock pitch (time only).`}
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
            <span
              className="tl-note-resize tl-note-resize-left"
              onMouseDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onPointerDown(note.id, event.clientX, event.clientY, 'resize-left')
              }}
            />
            <span className="tl-note-label">{midiToNoteName(note.midi)}</span>
            <span
              className="tl-note-resize tl-note-resize-right"
              onMouseDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onPointerDown(note.id, event.clientX, event.clientY, 'resize-right')
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
  onDeleteNotes,
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [typeAlong, setTypeAlong] = useState('')
  const [audioDuration, setAudioDuration] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [songVolume, setSongVolume] = useState(1)
  const [midiVolume, setMidiVolume] = useState(0.9)
  const [resumeOffset, setResumeOffset] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [resumeQuery, setResumeQuery] = useState('')
  const activeItemRef = useRef<HTMLButtonElement | null>(null)
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
    | {
        id: string
        mode: 'move' | 'resize-left' | 'resize-right'
        startX: number
        startY: number
        time: number
        duration: number
        midi: number
      }
  >(null)
  const onUpdateNoteRef = useRef(onUpdateNote)
  const timeScaleRef = useRef(1)
  const togglePlayRef = useRef<() => void>(() => {})
  const stepRef = useRef<(delta: number) => void>(() => {})
  const deleteSelectedRef = useRef<() => void>(() => {})
  // Marquee (box) selection state.
  const marqueeRef = useRef<HTMLDivElement | null>(null)
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null)
  const marqueeMovedRef = useRef(false)
  const suppressClickRef = useRef(false)
  const notesGeomRef = useRef<Array<{ id: string; x1: number; x2: number; y1: number; y2: number }>>([])

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
    deleteSelectedRef.current = deleteSelected
    notesGeomRef.current = sortedNotes.map((n) => {
      const x1 = n.time * pxPerSec
      return {
        id: n.id,
        x1,
        x2: x1 + Math.max(MIN_NOTE_WIDTH, n.duration * pxPerSec),
        y1: (bounds.max - n.midi) * LANE_HEIGHT + RULER_HEIGHT,
        y2: (bounds.max - n.midi) * LANE_HEIGHT + RULER_HEIGHT + (LANE_HEIGHT - 2),
      }
    })
  })

  // Drag to move/resize notes, or marquee-select. Listeners stay mounted.
  useEffect(() => {
    function contentPoint(event: MouseEvent): { x: number; y: number } {
      const scroller = scrollRef.current
      if (!scroller) {
        return { x: 0, y: 0 }
      }
      const rect = scroller.getBoundingClientRect()
      return { x: event.clientX - rect.left + scroller.scrollLeft, y: event.clientY - rect.top }
    }

    function move(event: MouseEvent) {
      const drag = dragRef.current
      if (drag) {
        const scale = pxRef.current * timeScaleRef.current
        if (scale <= 0) {
          return
        }
        const dt = (event.clientX - drag.startX) / scale
        if (drag.mode === 'move') {
          // Shift locks time (vertical line, pitch only); Alt locks pitch (horizontal, time only).
          const lockTime = event.shiftKey
          const lockPitch = event.altKey
          const time = lockTime ? drag.time : Math.max(0, drag.time + dt)
          const dSemi = lockPitch ? 0 : -Math.round((event.clientY - drag.startY) / LANE_HEIGHT)
          onUpdateNoteRef.current(drag.id, { time, midi: drag.midi + dSemi })
        } else if (drag.mode === 'resize-right') {
          onUpdateNoteRef.current(drag.id, { duration: Math.max(0.05, drag.duration + dt) })
        } else {
          const maxShift = drag.duration - 0.05
          const shift = Math.min(maxShift, dt)
          onUpdateNoteRef.current(drag.id, {
            time: Math.max(0, drag.time + shift),
            duration: drag.duration - shift,
          })
        }
        return
      }

      const start = marqueeStartRef.current
      const box = marqueeRef.current
      if (start && box) {
        const p = contentPoint(event)
        if (Math.abs(p.x - start.x) > 3 || Math.abs(p.y - start.y) > 3) {
          marqueeMovedRef.current = true
        }
        const left = Math.min(start.x, p.x)
        const top = Math.min(start.y, p.y)
        box.style.display = 'block'
        box.style.left = `${left}px`
        box.style.top = `${top}px`
        box.style.width = `${Math.abs(p.x - start.x)}px`
        box.style.height = `${Math.abs(p.y - start.y)}px`
      }
    }

    function up(event: MouseEvent) {
      if (dragRef.current) {
        dragRef.current = null
        return
      }
      const start = marqueeStartRef.current
      if (!start) {
        return
      }
      marqueeStartRef.current = null
      if (marqueeRef.current) {
        marqueeRef.current.style.display = 'none'
      }
      if (!marqueeMovedRef.current) {
        return // a plain click; let onTimelineClick handle the seek
      }
      suppressClickRef.current = true
      const p = contentPoint(event)
      const x1 = Math.min(start.x, p.x)
      const x2 = Math.max(start.x, p.x)
      const y1 = Math.min(start.y, p.y)
      const y2 = Math.max(start.y, p.y)
      const hit = notesGeomRef.current.filter(
        (g) => g.x1 < x2 && g.x2 > x1 && g.y1 < y2 && g.y2 > y1,
      )
      setSelectedIds(new Set(hit.map((g) => g.id)))
      setSelectedId(hit.length > 0 ? hit[0].id : null)
    }

    function down(event: MouseEvent) {
      if (dragRef.current) {
        return
      }
      const target = event.target as HTMLElement | null
      // Only start a marquee on empty timeline background.
      if (!target || target.closest('.tl-note, .tl-lyric, .tl-lyric-input, .resume-popup')) {
        return
      }
      if (!scrollRef.current || !scrollRef.current.contains(target)) {
        return
      }
      marqueeStartRef.current = contentPoint(event)
      marqueeMovedRef.current = false
    }

    window.addEventListener('mousedown', down)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousedown', down)
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
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        deleteSelectedRef.current()
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

  // Scroll the current word into view when the resume picker opens.
  useEffect(() => {
    if (pickerOpen) {
      activeItemRef.current?.scrollIntoView({ block: 'center' })
    }
  }, [pickerOpen])

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

  const selectSingle = useCallback((id: string) => {
    setSelectedId(id)
    setSelectedIds(new Set([id]))
    setResumeOffset(0)
  }, [])
  const selectNote = selectSingle

  // Begin a note drag; origin values are read from the canonical (unscaled) notes.
  const onNotePointerDown = useCallback(
    (id: string, clientX: number, clientY: number, mode: 'move' | 'resize-left' | 'resize-right') => {
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
      selectSingle(id)
    },
    [notes, selectSingle],
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
  const resumeOptions = useMemo(() => buildResumeOptions(lyricTokenList), [lyricTokenList])
  const visibleResumeOptions = useMemo(() => {
    const query = resumeQuery.trim().toLowerCase()
    if (!query) {
      return resumeOptions
    }
    return resumeOptions.filter((option) => option.searchText.includes(query))
  }, [resumeOptions, resumeQuery])

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
              setSelectedIds((prev) => (prev.size === 1 && prev.has(cur.id) ? prev : new Set([cur.id])))
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
    // Ignore the click that ends a marquee drag.
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    const scroller = scrollRef.current
    if (!scroller) {
      return
    }
    // Clicking empty timeline clears the selection.
    if (selectedIds.size > 0) {
      setSelectedIds(new Set())
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
        selectSingle(next.id)
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
    selectSingle(note.id)
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
    selectSingle(note.id)
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
    const ids = selectedIds.size > 0 ? [...selectedIds] : selectedNote ? [selectedNote.id] : []
    if (ids.length === 0) {
      return
    }
    // Reselect a surviving neighbor so arrow nav continues sensibly.
    const remaining = sortedNotes.filter((n) => !ids.includes(n.id))
    const lastIdx = Math.max(...ids.map((id) => sortedNotes.findIndex((n) => n.id === id)))
    const neighbor =
      remaining.find((n) => sortedNotes.findIndex((s) => s.id === n.id) > lastIdx) ??
      remaining[remaining.length - 1] ??
      null
    if (neighbor) {
      selectSingle(neighbor.id)
    } else {
      setSelectedId(null)
      setSelectedIds(new Set())
    }
    onDeleteNotes(ids)
  }

  /** Pivot for range selection: the selected note, else the note at the playhead. */
  function pivotIndex(): number {
    if (selectedIndex >= 0) {
      return selectedIndex
    }
    const t = getMelodyTime()
    const i = sortedNotes.findIndex((n) => n.time + n.duration >= t)
    return i >= 0 ? i : Math.max(0, sortedNotes.length - 1)
  }

  function selectRange(direction: 'start' | 'end'): void {
    if (sortedNotes.length === 0) {
      return
    }
    const p = pivotIndex()
    const slice = direction === 'start' ? sortedNotes.slice(0, p + 1) : sortedNotes.slice(p)
    setSelectedIds(new Set(slice.map((n) => n.id)))
    setSelectedId(sortedNotes[p].id)
  }

  function selectAll(): void {
    setSelectedIds(new Set(sortedNotes.map((n) => n.id)))
    if (sortedNotes[0]) {
      setSelectedId(sortedNotes[0].id)
    }
  }

  function clearSelection(): void {
    setSelectedIds(new Set())
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

      <div className="timeline-stage">
        <div className="tl-piano" aria-hidden="true">
          <div className="tl-piano-spacer" style={{ height: RULER_HEIGHT }} />
          <div className="tl-piano-keys" style={{ height: bounds.height }}>
            {Array.from({ length: bounds.max - bounds.min + 1 }, (_, i) => {
              const midi = bounds.max - i
              const name = midiToNoteName(midi)
              const sharp = name.includes('#')
              return (
                <div key={midi} className={`tl-key ${sharp ? 'sharp' : ''}`} style={{ height: LANE_HEIGHT }}>
                  {!sharp && name.startsWith('C') ? <span className="tl-key-label">{name}</span> : null}
                </div>
              )
            })}
          </div>
        </div>
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
            selectedIds={selectedIds}
            onSelect={selectNote}
            onPointerDown={onNotePointerDown}
          />
          <div ref={marqueeRef} className="tl-marquee" />
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
                className={`tl-lyric ${selectedIds.has(note.id) ? 'selected' : ''} ${text ? '' : 'empty'}`}
                style={{ left, top }}
                title={`${text ? 'Lyric' : 'No lyric yet'} for ${midiToNoteName(note.midi)} @ ${note.time.toFixed(2)}s — click to select, double-click to edit`}
                onClick={(event) => {
                  event.stopPropagation()
                  selectSingle(note.id)
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
          className="mini-btn wide lyric-mark"
          disabled={!selectedNote}
          title="Set the lyric to '+' — a held note / pitch slide carrying the previous syllable"
          onClick={() => applyToSelected(() => '+')}
        >
          '+' hold
        </button>
        <button
          type="button"
          className="mini-btn wide lyric-mark"
          disabled={!selectedNote}
          title="Toggle a trailing '-' — continue this word into the next note"
          onClick={() => applyToSelected((l) => (l.endsWith('-') ? l.replace(/-+$/, '') : `${l.replace(/-+$/, '')}-`))}
        >
          '-' word
        </button>
        <button
          type="button"
          className="mini-btn wide lyric-mark"
          disabled={!selectedNote}
          title="Toggle '#' — a non-pitched (talky / distorted, not a real sung pitch) note"
          onClick={() => applyToSelected((l) => (l.includes('#') ? l.replace(/#/g, '') : `${l}#`))}
        >
          '#' talky
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
          disabled={selectedIds.size === 0}
          title="Delete the selected note(s) (selection moves to a neighbor)"
          onClick={deleteSelected}
        >
          🗑 delete{selectedIds.size > 1 ? ` (${selectedIds.size})` : ''}
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
        <span className="shift-label">Select:</span>
        <button
          type="button"
          className="mini-btn wide"
          disabled={sortedNotes.length === 0}
          title="Select every note from the current note back to the start of the song"
          onClick={() => selectRange('start')}
        >
          ⇤ to start
        </button>
        <button
          type="button"
          className="mini-btn wide"
          disabled={sortedNotes.length === 0}
          title="Select every note from the current note to the end of the song"
          onClick={() => selectRange('end')}
        >
          to end ⇥
        </button>
        <button
          type="button"
          className="mini-btn wide"
          disabled={sortedNotes.length === 0}
          title="Select all notes"
          onClick={selectAll}
        >
          all
        </button>
        <button
          type="button"
          className="mini-btn wide"
          disabled={selectedIds.size === 0}
          title="Clear the selection"
          onClick={clearSelection}
        >
          clear{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
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
              title="Step back one word"
              onClick={() => setResumeOffset((o) => o - 1)}
            >
              ‹
            </button>
            <div className="resume-word-wrap">
              <button
                type="button"
                className="resume-word"
                disabled={lyricTokenList.length === 0}
                title="Click to choose which word the lyrics continue from"
                onClick={() => setPickerOpen((open) => !open)}
              >
                {lyricTokenList[resumeIndex] ?? '(end)'} ▾
              </button>
              {pickerOpen ? (
                <div
                  className="resume-modal-backdrop"
                  onClick={() => {
                    setPickerOpen(false)
                    setResumeQuery('')
                  }}
                >
                  <div className="resume-modal" onClick={(event) => event.stopPropagation()}>
                    <div className="resume-modal-head">
                      <strong>Continue lyrics from…</strong>
                      <input
                        className="resume-search"
                        autoFocus
                        type="search"
                        placeholder="Search lyrics…"
                        value={resumeQuery}
                        onChange={(event) => setResumeQuery(event.target.value)}
                      />
                      <button
                        type="button"
                        className="mini-btn"
                        title="Close"
                        onClick={() => {
                          setPickerOpen(false)
                          setResumeQuery('')
                        }}
                      >
                        ✕
                      </button>
                    </div>
                    {lyricTokenList.length === 0 ? (
                      <p className="meta-row">No lyrics yet — paste lyrics first.</p>
                    ) : visibleResumeOptions.length === 0 ? (
                      <p className="meta-row">No matching lyric syllables.</p>
                    ) : (
                      <div className="resume-grid">
                        {visibleResumeOptions
                          .map(({ token, contextBefore, contextAfter, index }) => (
                            <button
                              key={`${index}-${token}`}
                              type="button"
                              ref={index === resumeIndex ? activeItemRef : undefined}
                              className={`resume-cell ${index === resumeIndex ? 'active' : ''}`}
                              title={`Resume from "${token}" (syllable ${index + 1})`}
                              onClick={() => {
                                setResumeOffset(index - autoResumeIndex)
                                setPickerOpen(false)
                                setResumeQuery('')
                              }}
                            >
                              <span className="resume-cell-word">{token}</span>
                              <span className="resume-cell-context">
                                {contextBefore.length > 0 ? `${contextBefore.join(' ')} ` : ''}
                                <mark>{token}</mark>
                                {contextAfter.length > 0 ? ` ${contextAfter.join(' ')}` : ''}
                              </span>
                              <span className="resume-cell-idx">Syllable {index + 1}</span>
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="mini-btn"
              disabled={lyricTokenList.length === 0}
              title="Step forward one word"
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
              title="Re-flow the lyrics from the word shown across the selected note and every note after it. Keeps earlier lyrics. Click the word to pick exactly where to continue."
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
        <kbd>Del</kbd>/<kbd>Backspace</kbd> delete note · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo ·{' '}
        <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> redo · drag a note end to resize · hold{' '}
        <kbd>Shift</kbd> while dragging to lock time (pitch only), <kbd>Alt</kbd> to lock pitch (time only)
      </p>
    </div>
  )
}

export default VocalTimeline

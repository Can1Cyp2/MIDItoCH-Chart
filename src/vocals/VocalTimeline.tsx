import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { midiToNoteName, type VocalNote } from '../lib/vocalsChart'

const LANE_HEIGHT = 16
const RULER_HEIGHT = 22
const PITCH_PADDING = 2
const MIN_NOTE_WIDTH = 8

interface VocalTimelineProps {
  notes: VocalNote[]
  onChangeLyric: (id: string, lyric: string) => void
  onShift: (orderedIds: string[], fromIndex: number, direction: 'earlier' | 'later') => void
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
}: {
  notes: VocalNote[]
  pxPerSec: number
  bounds: PitchBounds
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <>
      {notes.map((note) => {
        const left = note.time * pxPerSec
        const width = Math.max(MIN_NOTE_WIDTH, note.duration * pxPerSec)
        const top = (bounds.max - note.midi) * LANE_HEIGHT + RULER_HEIGHT
        const isSelected = note.id === selectedId
        return (
          <button
            type="button"
            key={note.id}
            className={`tl-note ${isSelected ? 'selected' : ''} ${note.lyric.trim() ? 'has-lyric' : ''}`}
            style={{ left, width, top, height: LANE_HEIGHT - 2 }}
            title={`${midiToNoteName(note.midi)} @ ${note.time.toFixed(2)}s`}
            onClick={(event) => {
              event.stopPropagation()
              onSelect(note.id)
            }}
          >
            <span className="tl-note-label">{note.lyric || midiToNoteName(note.midi)}</span>
          </button>
        )
      })}
    </>
  )
})

function VocalTimeline({ notes, onChangeLyric, onShift }: VocalTimelineProps) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [pxPerSec, setPxPerSec] = useState(120)
  const [audioOffset, setAudioOffset] = useState(0)
  const [follow, setFollow] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [typeAlong, setTypeAlong] = useState('')
  const [audioDuration, setAudioDuration] = useState(0)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const playheadRef = useRef<HTMLDivElement | null>(null)
  const timeLabelRef = useRef<HTMLSpanElement | null>(null)
  const rafRef = useRef<number | null>(null)
  // Mutable mirrors so the rAF loop reads current values without re-subscribing.
  const offsetRef = useRef(audioOffset)
  const pxRef = useRef(pxPerSec)
  const followRef = useRef(follow)
  useEffect(() => {
    offsetRef.current = audioOffset
    pxRef.current = pxPerSec
    followRef.current = follow
  })

  const sortedNotes = useMemo(() => [...notes].sort((a, b) => a.time - b.time), [notes])

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

  const selectNote = useCallback((id: string) => setSelectedId(id), [])

  const selectedIndex = sortedNotes.findIndex((n) => n.id === selectedId)
  const selectedNote = selectedIndex >= 0 ? sortedNotes[selectedIndex] : null

  // Position the playhead, time readout, and (optionally) selection each frame.
  useEffect(() => {
    function tick() {
      const audio = audioRef.current
      if (audio) {
        const melodyTime = audio.currentTime - offsetRef.current
        const left = melodyTime * pxRef.current
        if (playheadRef.current) {
          playheadRef.current.style.left = `${left}px`
        }
        if (timeLabelRef.current) {
          timeLabelRef.current.textContent = `${audio.currentTime.toFixed(2)}s`
        }
        const scroller = scrollRef.current
        if (scroller && !audio.paused) {
          const view = scroller.clientWidth
          if (left < scroller.scrollLeft + 60 || left > scroller.scrollLeft + view - 160) {
            scroller.scrollLeft = left - view / 3
          }
          if (followRef.current) {
            const cur = sortedNotes.find(
              (n) => melodyTime >= n.time && melodyTime < n.time + n.duration,
            )
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

  function onAudioPicked(file: File | null): void {
    if (!file) {
      return
    }
    setAudioUrl((prev) => {
      if (prev) {
        URL.revokeObjectURL(prev)
      }
      return URL.createObjectURL(file)
    })
  }

  function togglePlay(): void {
    const audio = audioRef.current
    if (!audio) {
      return
    }
    if (audio.paused) {
      void audio.play()
      setIsPlaying(true)
    } else {
      audio.pause()
      setIsPlaying(false)
    }
  }

  function onTimelineClick(event: React.MouseEvent<HTMLDivElement>): void {
    const scroller = scrollRef.current
    const audio = audioRef.current
    if (!scroller) {
      return
    }
    const rect = scroller.getBoundingClientRect()
    const x = event.clientX - rect.left + scroller.scrollLeft
    const melodyTime = Math.max(0, x / pxPerSec)
    if (audio) {
      audio.currentTime = Math.max(0, melodyTime + audioOffset)
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

  function step(delta: number): void {
    if (sortedNotes.length === 0) {
      return
    }
    const base = selectedIndex >= 0 ? selectedIndex : 0
    const next = Math.min(sortedNotes.length - 1, Math.max(0, base + delta))
    setSelectedId(sortedNotes[next].id)
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
        <label className="audio-pick">
          <input
            type="file"
            accept="audio/*"
            onChange={(event) => onAudioPicked(event.target.files?.[0] ?? null)}
          />
          {audioUrl ? 'Change song audio' : 'Load song / vocal stem'}
        </label>
        <button type="button" className="secondary-btn" onClick={togglePlay} disabled={!audioUrl}>
          {isPlaying ? '⏸ Pause' : '▶ Play'}
        </button>
        <span className="time-readout">
          <span ref={timeLabelRef}>0.00s</span>
        </span>

        <label className="ctrl">
          Zoom
          <input
            type="range"
            min={30}
            max={400}
            value={pxPerSec}
            onChange={(event) => setPxPerSec(Number(event.target.value))}
          />
        </label>

        <div className="ctrl offset-ctrl">
          Align offset
          <div className="offset-buttons">
            <button type="button" className="mini-btn" onClick={() => setAudioOffset((o) => o - 0.5)}>
              −0.5
            </button>
            <button type="button" className="mini-btn" onClick={() => setAudioOffset((o) => o - 0.05)}>
              −
            </button>
            <span className="offset-value">{audioOffset.toFixed(2)}s</span>
            <button type="button" className="mini-btn" onClick={() => setAudioOffset((o) => o + 0.05)}>
              +
            </button>
            <button type="button" className="mini-btn" onClick={() => setAudioOffset((o) => o + 0.5)}>
              +0.5
            </button>
          </div>
        </div>

        <label className="ctrl follow-ctrl">
          <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
          Follow playhead
        </label>
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
          style={{ width: contentWidth, height: bounds.height + RULER_HEIGHT }}
        >
          <div className="tl-ruler" style={{ width: contentWidth }}>
            {rulerMarks.map((t) => (
              <span key={t} className="tl-ruler-mark" style={{ left: t * pxPerSec }}>
                {t}s
              </span>
            ))}
          </div>
          <NotesLayer
            notes={sortedNotes}
            pxPerSec={pxPerSec}
            bounds={bounds}
            selectedId={selectedId}
            onSelect={selectNote}
          />
          <div ref={playheadRef} className="tl-playhead" style={{ height: bounds.height + RULER_HEIGHT }} />
        </div>
      </div>

      <div className="note-editor">
        <button type="button" className="mini-btn" onClick={() => step(-1)} title="Previous note">
          ◀
        </button>
        <span className="editor-pitch">
          {selectedNote ? `${midiToNoteName(selectedNote.midi)} · ${selectedNote.time.toFixed(2)}s` : 'No note selected'}
        </span>
        <input
          className="note-lyric"
          value={selectedNote?.lyric ?? ''}
          placeholder={selectedNote ? 'syllable' : 'click a note'}
          disabled={!selectedNote}
          onChange={(event) => selectedNote && onChangeLyric(selectedNote.id, event.target.value)}
        />
        <button type="button" className="mini-btn" disabled={!selectedNote} title="Held / slide" onClick={() => applyToSelected(() => '+')}>
          +
        </button>
        <button
          type="button"
          className="mini-btn"
          disabled={!selectedNote}
          title="Continue word into next note"
          onClick={() => applyToSelected((l) => (l.endsWith('-') ? l.replace(/-+$/, '') : `${l.replace(/-+$/, '')}-`))}
        >
          -
        </button>
        <button type="button" className="mini-btn" disabled={!selectedNote} title="Next note" onClick={() => step(1)}>
          ▶
        </button>
      </div>

      <div className="shift-row">
        <span className="shift-label">
          Shift lyrics from {selectedNote ? 'selected note' : 'start'}:
        </span>
        <button
          type="button"
          className="secondary-btn"
          disabled={sortedNotes.length === 0}
          title="Pull lyrics back — remove this note's lyric, everything after moves one note earlier"
          onClick={() => shift('earlier')}
        >
          ← earlier
        </button>
        <button
          type="button"
          className="secondary-btn"
          disabled={sortedNotes.length === 0}
          title="Push lyrics forward — insert a blank here, everything after moves one note later"
          onClick={() => shift('later')}
        >
          later →
        </button>
      </div>

      <div className="type-along">
        <input
          className="note-lyric"
          value={typeAlong}
          placeholder="Type-along: play the song, type the current syllable, press Enter"
          onChange={(event) => setTypeAlong(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitTypeAlong()
            }
          }}
        />
        <button type="button" className="secondary-btn" onClick={commitTypeAlong} disabled={!selectedNote}>
          Set &amp; advance
        </button>
      </div>
    </div>
  )
}

export default VocalTimeline

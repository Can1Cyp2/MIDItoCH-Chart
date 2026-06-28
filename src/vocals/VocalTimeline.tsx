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
  midiBpm: number | null
  midiBpmVaries: boolean
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
  const lyricLaneTop = RULER_HEIGHT + bounds.height
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
            title={`${midiToNoteName(note.midi)} @ ${note.time.toFixed(2)}s — click to select and edit`}
            onClick={(event) => {
              event.stopPropagation()
              onSelect(note.id)
            }}
          >
            <span className="tl-note-label">{midiToNoteName(note.midi)}</span>
          </button>
        )
      })}
      <div className="tl-lyric-lane" style={{ top: lyricLaneTop, height: LYRIC_LANE_HEIGHT }} />
      {notes.map((note) => {
        const text = note.lyric.trim()
        if (!text) {
          return null
        }
        return (
          <button
            type="button"
            key={`lyric-${note.id}`}
            className={`tl-lyric ${note.id === selectedId ? 'selected' : ''}`}
            style={{ left: note.time * pxPerSec, top: lyricLaneTop + 6 }}
            title={`Lyric for ${midiToNoteName(note.midi)} @ ${note.time.toFixed(2)}s — click to select`}
            onClick={(event) => {
              event.stopPropagation()
              onSelect(note.id)
            }}
          >
            {text}
          </button>
        )
      })}
    </>
  )
})

function VocalTimeline({ notes, onChangeLyric, onShift, midiBpm, midiBpmVaries }: VocalTimelineProps) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [pxPerSec, setPxPerSec] = useState(120)
  const [audioOffset, setAudioOffset] = useState(0)
  const [follow, setFollow] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [typeAlong, setTypeAlong] = useState('')
  const [audioDuration, setAudioDuration] = useState(0)
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

  const effectiveBpm =
    bpmSource === 'midi'
      ? midiBpm ?? customBpm
      : bpmSource === 'detected'
        ? detectedBpm ?? customBpm
        : customBpm
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

  const selectNote = useCallback((id: string) => setSelectedId(id), [])

  const selectedIndex = sortedNotes.findIndex((n) => n.id === selectedId)
  const selectedNote = selectedIndex >= 0 ? sortedNotes[selectedIndex] : null

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
    const audio = audioRef.current
    if (audio) {
      if (audio.paused) {
        void audio.play()
        setIsPlaying(true)
      } else {
        audio.pause()
        setIsPlaying(false)
      }
      return
    }
    // No song loaded: play the synthesized melody instead.
    const synth = synthRef.current
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
          title="Tempo for the beat grid drawn on the timeline. Needed only if the MIDI's tempo doesn't match the song — otherwise the align offset alone lines things up."
        >
          BPM grid:
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
        <span className="offset-value" title="Tempo currently driving the beat grid">
          = {effectiveBpm ? Math.round(effectiveBpm) : '—'} BPM
        </span>
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
          />
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
          title="Select the next note"
          onClick={() => step(1)}
        >
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
    </div>
  )
}

export default VocalTimeline

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  alignLyricsToNotes,
  buildVocalsMidi,
  parseVocalMidi,
  syllabifyLyrics,
  type ParsedVocalMidi,
  type VocalNote,
} from '../lib/vocalsChart'
import VocalTimeline from './VocalTimeline'

const ACCEPTED_MIDI = '.mid,.midi,audio/midi,audio/x-midi'

interface VocalsViewProps {
  onBack: () => void
}

function VocalsView({ onBack }: VocalsViewProps) {
  const [parsed, setParsed] = useState<ParsedVocalMidi | null>(null)
  const [selectedTrackIndex, setSelectedTrackIndex] = useState<number | null>(null)
  const [lyrics, setLyrics] = useState('')
  const [notes, setNotes] = useState<VocalNote[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [editorBpm, setEditorBpm] = useState<number | null>(null)
  const [autoSyllabify, setAutoSyllabify] = useState(true)
  // Tokens that didn't fit on a note; flow back in when notes are pulled earlier.
  const [overflow, setOverflow] = useState<string[]>([])
  const sawDashRef = useRef(false)

  // Undo/redo history of note + overflow snapshots.
  type Snapshot = { notes: VocalNote[]; overflow: string[] }
  const historyRef = useRef<Snapshot[]>([])
  const redoRef = useRef<Snapshot[]>([])
  const lastRecordRef = useRef<{ label: string; time: number }>({ label: '', time: 0 })
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  /** Snapshot state before a mutation. Rapid same-label edits (typing, dragging) coalesce. */
  function record(label: string): void {
    // Any fresh edit invalidates the redo stack.
    if (redoRef.current.length > 0) {
      redoRef.current = []
      setCanRedo(false)
    }
    const now = Date.now()
    const last = lastRecordRef.current
    lastRecordRef.current = { label, time: now }
    if (label === 'note-edit' && last.label === 'note-edit' && now - last.time < 700) {
      return
    }
    historyRef.current.push({ notes, overflow })
    if (historyRef.current.length > 100) {
      historyRef.current.shift()
    }
    setCanUndo(true)
  }

  function undo(): void {
    const prev = historyRef.current.pop()
    if (!prev) {
      return
    }
    redoRef.current.push({ notes, overflow })
    setNotes(prev.notes)
    setOverflow(prev.overflow)
    setCanUndo(historyRef.current.length > 0)
    setCanRedo(true)
    lastRecordRef.current = { label: '', time: 0 }
    setStatus('Undid last change.')
  }

  function redo(): void {
    const next = redoRef.current.pop()
    if (!next) {
      return
    }
    historyRef.current.push({ notes, overflow })
    setNotes(next.notes)
    setOverflow(next.overflow)
    setCanRedo(redoRef.current.length > 0)
    setCanUndo(true)
    lastRecordRef.current = { label: '', time: 0 }
    setStatus('Redid change.')
  }

  function clearHistory(): void {
    historyRef.current = []
    redoRef.current = []
    lastRecordRef.current = { label: '', time: 0 }
    setCanUndo(false)
    setCanRedo(false)
  }

  // Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z or Ctrl+Y to redo (when not typing).
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!event.ctrlKey && !event.metaKey) {
        return
      }
      const key = event.key.toLowerCase()
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) {
        return
      }
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault()
        undo()
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Once a dash appears in the lyrics, switch off auto-syllabify and respect the
  // user's manual dashes (they can turn it back on). Handled here, not in an
  // effect, so it only reacts to actual edits.
  function onLyricsChange(value: string): void {
    setLyrics(value)
    const hasDash = value.includes('-')
    if (hasDash && !sawDashRef.current) {
      setAutoSyllabify(false)
    }
    sawDashRef.current = hasDash
  }

  const midiBpm = parsed?.tempos[0]?.bpm ?? null
  const midiBpmVaries =
    (parsed?.tempos.length ?? 0) > 1 &&
    new Set(parsed?.tempos.map((t) => Math.round(t.bpm))).size > 1

  const ticksPerSecond = parsed ? (parsed.ppq * (midiBpm ?? 120)) / 60 : 480

  function withTicks(note: VocalNote, time: number, duration: number, midi: number): VocalNote {
    return {
      ...note,
      time,
      duration,
      midi,
      ticks: Math.max(0, Math.round(time * ticksPerSecond)),
      durationTicks: Math.max(1, Math.round(duration * ticksPerSecond)),
    }
  }

  const selectedTrack = useMemo(
    () => parsed?.tracks.find((track) => track.index === selectedTrackIndex) ?? null,
    [parsed, selectedTrackIndex],
  )

  const syllableCount = useMemo(
    () => syllabifyLyrics(lyrics, autoSyllabify).length,
    [lyrics, autoSyllabify],
  )

  async function onMidiPicked(file: File | null): Promise<void> {
    setError(null)
    setStatus(null)
    if (!file) {
      return
    }
    try {
      const result = await parseVocalMidi(file)
      if (result.tracks.length === 0) {
        setError('That MIDI has no note tracks. Provide a vocal melody MIDI.')
        return
      }
      const richest = result.tracks.reduce((best, track) =>
        track.noteCount > best.noteCount ? track : best,
      )
      setParsed(result)
      setSelectedTrackIndex(richest.index)
      setNotes(richest.notes.map((note) => ({ ...note })))
      setOverflow([])
      clearHistory()
      setStatus(`Loaded ${result.fileName}: ${richest.noteCount} notes from "${richest.name}".`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not parse that MIDI file.')
    }
  }

  function onTrackChange(index: number): void {
    if (!parsed) {
      return
    }
    const track = parsed.tracks.find((t) => t.index === index)
    if (!track) {
      return
    }
    setSelectedTrackIndex(index)
    setNotes(track.notes.map((note) => ({ ...note })))
    setOverflow([])
    clearHistory()
    setStatus(`Selected "${track.name}": ${track.noteCount} notes.`)
  }

  function onAutoMap(): void {
    setError(null)
    if (notes.length === 0) {
      setError('Load a vocal melody MIDI first.')
      return
    }
    const syllables = syllabifyLyrics(lyrics, autoSyllabify)
    if (syllables.length === 0) {
      setError('Paste some lyrics to map onto the melody.')
      return
    }
    record('map')
    const result = alignLyricsToNotes(notes, syllables)
    setNotes(result.notes)
    setOverflow(result.leftoverTokens)
    const bits: string[] = [`Mapped ${syllables.length} syllables onto ${notes.length} notes.`]
    if (result.slideNotes > 0) {
      bits.push(`${result.slideNotes} extra note(s) marked as "+" slides.`)
    }
    if (result.leftoverTokens.length > 0) {
      bits.push(
        `${result.leftoverTokens.length} leftover syllable(s) held in reserve — they flow in as you pull lyrics earlier.`,
      )
    }
    setStatus(bits.join(' '))
  }

  function updateNoteLyric(id: string, lyric: string): void {
    record('note-edit')
    setNotes((prev) => prev.map((note) => (note.id === id ? { ...note, lyric } : note)))
  }

  /**
   * Re-seat lyric tokens across notes from `fromIndex` onward (in the given
   * timeline order). 'later' inserts a blank at fromIndex (pushing lyrics to
   * later notes; the bumped tail token goes back to the overflow reserve).
   * 'earlier' removes fromIndex's lyric (pulling them back; the freed end slot
   * is filled from the overflow reserve if any leftover lyrics remain).
   */
  function shiftLyrics(orderedIds: string[], fromIndex: number, direction: 'earlier' | 'later'): void {
    record('shift')
    const lyricById = new Map(notes.map((note) => [note.id, note.lyric]))
    const lyrics = orderedIds.map((id) => lyricById.get(id) ?? '')
    let nextOverflow = [...overflow]

    if (direction === 'later') {
      lyrics.splice(fromIndex, 0, '')
      const bumped = lyrics.pop() ?? ''
      if (bumped.trim()) {
        nextOverflow = [bumped, ...nextOverflow]
      }
    } else {
      lyrics.splice(fromIndex, 1)
      const refill = nextOverflow.length > 0 ? nextOverflow.shift() ?? '' : ''
      lyrics.push(refill)
    }

    const shifted = new Map(orderedIds.map((id, index) => [id, lyrics[index]]))
    setNotes((prev) =>
      prev.map((note) =>
        shifted.has(note.id) ? { ...note, lyric: shifted.get(note.id) ?? '' } : note,
      ),
    )
    setOverflow(nextOverflow)
  }

  function updateNote(id: string, patch: { time?: number; duration?: number; midi?: number }): void {
    record('note-edit')
    setNotes((prev) =>
      prev
        .map((note) =>
          note.id === id
            ? withTicks(
                note,
                Math.max(0, patch.time ?? note.time),
                Math.max(0.05, patch.duration ?? note.duration),
                Math.min(108, Math.max(0, patch.midi ?? note.midi)),
              )
            : note,
        )
        .sort((a, b) => a.time - b.time),
    )
  }

  function addNote(time: number, midi: number): void {
    record('add')
    const id = `add-${Date.now()}-${Math.round(Math.random() * 1e6)}`
    const base: VocalNote = { id, ticks: 0, durationTicks: 1, time: 0, duration: 0, midi, lyric: '' }
    setNotes((prev) =>
      [...prev, withTicks(base, Math.max(0, time), 0.3, midi)].sort((a, b) => a.time - b.time),
    )
  }

  function deleteNote(id: string): void {
    record('delete')
    setNotes((prev) => prev.filter((note) => note.id !== id))
  }

  function splitNote(id: string): void {
    record('split')
    setNotes((prev) => {
      const note = prev.find((n) => n.id === id)
      if (!note) {
        return prev
      }
      const half = note.duration / 2
      const first = withTicks(note, note.time, half, note.midi)
      const second = withTicks(
        { ...note, id: `split-${Date.now()}-${Math.round(Math.random() * 1e6)}`, lyric: '' },
        note.time + half,
        half,
        note.midi,
      )
      return prev.flatMap((n) => (n.id === id ? [first, second] : [n])).sort((a, b) => a.time - b.time)
    })
  }

  /** Merge the next note's lyric onto a hyphenated note, pulling the rest back. */
  function mergeNext(orderedIds: string[], index: number): void {
    if (!orderedIds[index]) {
      return
    }
    record('merge')
    const lyricById = new Map(notes.map((n) => [n.id, n.lyric]))
    const lyrics = orderedIds.map((id) => lyricById.get(id) ?? '')
    const cur = (lyrics[index] ?? '').replace(/-+$/, '')
    const next = lyrics[index + 1] ?? ''
    lyrics[index] = `${cur}${next}`

    const nextOverflow = [...overflow]
    if (index + 1 < lyrics.length) {
      lyrics.splice(index + 1, 1)
      lyrics.push(nextOverflow.length > 0 ? nextOverflow.shift() ?? '' : '')
    }

    const shifted = new Map(orderedIds.map((id, i) => [id, lyrics[i]]))
    setNotes((prev) =>
      prev.map((note) =>
        shifted.has(note.id) ? { ...note, lyric: shifted.get(note.id) ?? '' } : note,
      ),
    )
    setOverflow(nextOverflow)
  }

  function onExport(): void {
    setError(null)
    if (!parsed || notes.length === 0) {
      setError('Load a melody and map lyrics before exporting.')
      return
    }
    // If a corrected tempo was chosen in the editor, export the tempo track at
    // that BPM. Note ticks are unchanged, so their real times scale to match
    // exactly what the editor plays (real time = ticks/ppq * 60/bpm).
    const exportTempos =
      editorBpm && midiBpm != null ? [{ ticks: 0, bpm: editorBpm }] : parsed.tempos
    const data = buildVocalsMidi({
      ppq: parsed.ppq,
      tempos: exportTempos,
      timeSignatures: parsed.timeSignatures,
      notes,
    })
    // Copy into a fresh, exactly-sized ArrayBuffer for a clean Blob.
    const out = new Uint8Array(data.length)
    out.set(data)
    const blob = new Blob([out], { type: 'audio/midi' })
    const url = URL.createObjectURL(blob)
    const base = parsed.fileName.replace(/\.[^/.]+$/, '')
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${base} (PART VOCALS).mid`
    anchor.click()
    URL.revokeObjectURL(url)
    setStatus('Exported PART VOCALS .mid — load it in YARG (or merge into your notes.mid).')
  }

  const mappedCount = notes.filter((note) => note.lyric.trim().length > 0).length

  return (
    <main className="page-shell">
      <section className="hero-card">
        <div className="hero-headline">
          <button
            type="button"
            className="link-back"
            onClick={onBack}
            title="Return to the MIDI/GuitarPro → Clone Hero chart converter"
          >
            ← Back to chart converter
          </button>
          <p className="kicker">YARG / Rock Band Vocals</p>
          <h1>Map a vocal melody MIDI to lyrics for singable charts</h1>
          <p className="lead">
            Provide a <strong>vocal melody MIDI</strong> and paste the song&apos;s
            <strong> plain lyrics</strong>. We line syllables up to the notes, you fine-tune each
            one, then export a <strong>PART VOCALS</strong> .mid for YARG.
          </p>
        </div>
        <div className="pill-row">
          <span className="pill">MIDI melody + lyrics</span>
          <span className="pill">Per-note syllable editor</span>
          <span className="pill">PART VOCALS export</span>
        </div>
      </section>

      <section className="grid-layout vocals-single">
        <article className="panel">
          <h2>1. Vocal melody MIDI</h2>
          <label
            className={`dropzone ${isDragging ? 'dragging' : ''} ${parsed ? 'loaded' : ''}`}
            onDragOver={(event) => {
              event.preventDefault()
              setIsDragging(true)
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => {
              event.preventDefault()
              setIsDragging(false)
              void onMidiPicked(event.dataTransfer.files?.[0] ?? null)
            }}
          >
            <input
              type="file"
              accept={ACCEPTED_MIDI}
              onChange={(event) => void onMidiPicked(event.target.files?.[0] ?? null)}
            />
            {parsed ? (
              <>
                <span className="dropzone-title">✓ {parsed.fileName}</span>
                <span className="dropzone-subtitle">
                  {selectedTrack?.noteCount ?? notes.length} notes loaded — drop another file or click to replace
                </span>
              </>
            ) : (
              <>
                <span className="dropzone-title">Drop a vocal melody .mid here</span>
                <span className="dropzone-subtitle">or click to browse · one note per sung pitch works best</span>
              </>
            )}
          </label>

          {parsed && parsed.tracks.length > 1 ? (
            <label className="select-row">
              Melody track
              <select
                value={selectedTrackIndex ?? ''}
                onChange={(event) => onTrackChange(Number(event.target.value))}
              >
                {parsed.tracks.map((track) => (
                  <option key={track.index} value={track.index}>
                    {track.name} ({track.noteCount} notes)
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <h2>2. Lyrics</h2>
          <p className="meta-row">
            Paste <strong>lyrics only</strong> — no section names, chords, or timestamps. One line
            per phrase. Type hyphens to control syllables (e.g. <code>hel-lo</code>).
          </p>
          <textarea
            className="lyrics-input"
            rows={8}
            placeholder={'Never gonna give you up\nNever gonna let you down'}
            value={lyrics}
            onChange={(event) => onLyricsChange(event.target.value)}
          />
          <label
            className="toggle-row"
            title="On: automatically split words into syllables. Off: keep each word whole. Turns off automatically once you type a dash, so your manual hyphens are respected."
          >
            <input
              type="checkbox"
              checked={autoSyllabify}
              onChange={(event) => setAutoSyllabify(event.target.checked)}
            />
            Auto-split words into syllables
          </label>
          <p className="meta-row">
            {syllableCount} syllable(s) · {selectedTrack?.noteCount ?? 0} melody note(s)
            {overflow.length > 0 ? ` · ${overflow.length} in reserve` : ''}
          </p>

          <div className="button-row">
            <button
              type="button"
              className="primary-btn"
              onClick={onAutoMap}
              title="Auto-assign the pasted lyrics to the melody notes in order. Extra held notes become '+' slides; you can fine-tune everything in the timeline below."
            >
              Map lyrics to melody
            </button>
            <button
              type="button"
              className="secondary-btn"
              onClick={onExport}
              disabled={!parsed || notes.length === 0}
              title="Download a PART VOCALS .mid (notes + lyric events + phrase markers) ready for YARG, or to merge into your notes.mid"
            >
              Export PART VOCALS .mid
            </button>
          </div>

          {status ? <p className="meta-row">{status}</p> : null}
          {error ? <p className="error-row">{error}</p> : null}

          <details className="coming-soon">
            <summary>Audio sync &amp; stem import (coming soon)</summary>
            <p className="meta-row">
              Planned: drop in an isolated <strong>vocal stem</strong> so word timings can be detected
              and auto-aligned to the melody. The full mixed song will not work — vocals must be
              extracted first.
            </p>
            <label className="dropzone disabled">
              <input type="file" disabled />
              <span className="dropzone-title">Audio sync — not yet available</span>
            </label>
          </details>
        </article>

      </section>

      <section className="timeline-section">
        <article className="panel">
          <h2>3. Visual editor — line the melody up to the song</h2>
          <p className="meta-row">
            {mappedCount}/{notes.length} notes have a lyric. Press <strong>Play melody</strong> to hear
            the notes, or load a song and nudge the <strong>align offset</strong> to slide the melody
            under the audio. <strong>Double-click any lyric below a note to edit it</strong> right in
            place, or use <strong>type-along</strong> to add syllables as it plays.
          </p>
          {notes.length === 0 ? (
            <p className="meta-row">Load a melody MIDI above to start editing notes.</p>
          ) : (
            <>
              <VocalTimeline
                notes={notes}
                onChangeLyric={updateNoteLyric}
                onShift={shiftLyrics}
                onMergeNext={mergeNext}
                onUpdateNote={updateNote}
                onAddNote={addNote}
                onDeleteNote={deleteNote}
                onSplitNote={splitNote}
                onUndo={undo}
                canUndo={canUndo}
                onRedo={redo}
                canRedo={canRedo}
                midiBpm={midiBpm}
                midiBpmVaries={midiBpmVaries}
                onEffectiveBpmChange={setEditorBpm}
              />
              <div className="button-row export-row">
                <button
                  type="button"
                  className="primary-btn"
                  onClick={onExport}
                  title="Download the finished PART VOCALS .mid with your edits and tempo"
                >
                  Export PART VOCALS .mid
                </button>
                {status ? <span className="meta-row">{status}</span> : null}
              </div>
            </>
          )}
        </article>
      </section>
    </main>
  )
}

export default VocalsView

import { useMemo, useState } from 'react'
import {
  alignLyricsToNotes,
  buildVocalsMidi,
  midiToNoteName,
  parseVocalMidi,
  syllabifyLyrics,
  type ParsedVocalMidi,
  type VocalNote,
} from '../lib/vocalsChart'

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

  const selectedTrack = useMemo(
    () => parsed?.tracks.find((track) => track.index === selectedTrackIndex) ?? null,
    [parsed, selectedTrackIndex],
  )

  const syllableCount = useMemo(() => syllabifyLyrics(lyrics).length, [lyrics])

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
    setStatus(`Selected "${track.name}": ${track.noteCount} notes.`)
  }

  function onAutoMap(): void {
    setError(null)
    if (notes.length === 0) {
      setError('Load a vocal melody MIDI first.')
      return
    }
    const syllables = syllabifyLyrics(lyrics)
    if (syllables.length === 0) {
      setError('Paste some lyrics to map onto the melody.')
      return
    }
    const result = alignLyricsToNotes(notes, syllables)
    setNotes(result.notes)
    const bits: string[] = [`Mapped ${syllables.length} syllables onto ${notes.length} notes.`]
    if (result.slideNotes > 0) {
      bits.push(`${result.slideNotes} extra note(s) marked as "+" slides.`)
    }
    if (result.leftoverSyllables > 0) {
      bits.push(
        `${result.leftoverSyllables} syllable(s) had no note — split a note or add notes, then fix manually.`,
      )
    }
    setStatus(bits.join(' '))
  }

  function updateNoteLyric(id: string, lyric: string): void {
    setNotes((prev) => prev.map((note) => (note.id === id ? { ...note, lyric } : note)))
  }

  function toggleHyphen(id: string): void {
    setNotes((prev) =>
      prev.map((note) => {
        if (note.id !== id) {
          return note
        }
        const base = note.lyric.replace(/-+$/, '')
        return { ...note, lyric: note.lyric.endsWith('-') ? base : `${base}-` }
      }),
    )
  }

  function onExport(): void {
    setError(null)
    if (!parsed || notes.length === 0) {
      setError('Load a melody and map lyrics before exporting.')
      return
    }
    const data = buildVocalsMidi({
      ppq: parsed.ppq,
      tempos: parsed.tempos,
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
          <button type="button" className="link-back" onClick={onBack}>
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

      <section className="grid-layout">
        <article className="panel">
          <h2>1. Vocal melody MIDI</h2>
          <label className="dropzone">
            <input
              type="file"
              accept={ACCEPTED_MIDI}
              onChange={(event) => void onMidiPicked(event.target.files?.[0] ?? null)}
            />
            <span className="dropzone-title">Drop a vocal melody .mid here</span>
            <span className="dropzone-subtitle">One note per sung pitch works best</span>
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
            onChange={(event) => setLyrics(event.target.value)}
          />
          <p className="meta-row">
            {syllableCount} syllable(s) · {selectedTrack?.noteCount ?? 0} melody note(s)
          </p>

          <div className="button-row">
            <button type="button" className="primary-btn" onClick={onAutoMap}>
              Map lyrics to melody
            </button>
            <button
              type="button"
              className="secondary-btn"
              onClick={onExport}
              disabled={!parsed || notes.length === 0}
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

        <article className="panel">
          <h2>3. Per-note lyrics</h2>
          <p className="meta-row">
            {mappedCount}/{notes.length} notes have a lyric. Use <code>+</code> for a held/slide note
            and the <code>-</code> button to continue a word into the next note.
          </p>
          {notes.length === 0 ? (
            <p className="meta-row">Load a melody MIDI to start editing notes.</p>
          ) : (
            <div className="note-table">
              {notes.map((note, index) => (
                <div key={note.id} className="note-row">
                  <span className="note-index">{index + 1}</span>
                  <span className="note-pitch">{midiToNoteName(note.midi)}</span>
                  <span className="note-beat">
                    {parsed ? `${(note.ticks / parsed.ppq).toFixed(2)}b` : ''}
                  </span>
                  <input
                    className="note-lyric"
                    value={note.lyric}
                    placeholder="syllable"
                    onChange={(event) => updateNoteLyric(note.id, event.target.value)}
                  />
                  <button
                    type="button"
                    className="mini-btn"
                    title="Held / pitch slide from previous note"
                    onClick={() => updateNoteLyric(note.id, '+')}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="mini-btn"
                    title="Continue this word into the next note"
                    onClick={() => toggleHyphen(note.id)}
                  >
                    -
                  </button>
                </div>
              ))}
            </div>
          )}
        </article>
      </section>
    </main>
  )
}

export default VocalsView

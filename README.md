# MIDI to Clone Hero Drum Chart Converter

A React web app that converts drum MIDI files (`.mid` / `.midi`) into Clone Hero / Moonscraper `.chart` files with a 4-lane pro-drums focus.

## What it does

- Parses MIDI in-browser with `@tonejs/midi`
- Detects drum tracks (channel 10 first, then drum-like track names)
- Maps drum notes into Clone Hero lanes:
  - `0` kick
  - `1` red (snare)
  - `2` yellow
  - `3` blue
  - `4` green
- Emits pro-drums cymbal flags:
  - `66` yellow cymbal
  - `67` blue cymbal
  - `68` green cymbal
- Preserves sync data (tempo + time signatures) in `[SyncTrack]`
- Exports a downloadable `.chart`

## Run

```bash
npm install
npm run dev
```

Build for production:

```bash
npm run build
npm run preview
```

Deploy output to `docs/` (for GitHub Pages configured to main branch + `/docs`):

```bash
npm run deploy
```

This command builds the app and copies `dist/` into `docs/`.

## Conversion notes

- Target output section defaults to `[ExpertDrums]` (selectable in UI).
- By default, the converter forces zero-length drum gems, which is generally preferred for drum charts.
- Unmapped MIDI notes are counted and reported in the UI.

## Current mapping profile

- Kick: `35`, `36`
- Red/snare: `37`, `38`, `39`, `40`
- Yellow cymbals: `42`, `44`, `46`
- Yellow toms: `48`, `50`
- Blue cymbals: `51`, `53`, `59`
- Blue toms: `45`, `47`
- Green cymbals: `49`, `52`, `55`, `57`
- Green toms: `41`, `43`

If your source MIDI uses a custom drum map, extend the mapping table in `src/lib/midiToChart.ts`.

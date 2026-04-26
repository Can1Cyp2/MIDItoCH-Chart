# MIDI to Clone Hero Drum Chart Converter

This project is a browser-based conversion utility that turns drum parts from MIDI and Guitar Pro files into Clone Hero and Moonscraper `.chart` files.

Its core purpose is to reduce the manual work of drum chart authoring by automatically translating common drum note layouts into a playable 4-lane pro-drums chart structure, while preserving musical timing (tempo and time signatures).

## Purpose Of This Site

Drum transcriptions are often stored in formats that are great for production or notation, but not directly usable for Clone Hero charting. This site exists to bridge that gap.

It is designed to solve these practical problems:

- You have a drum MIDI or GP file and want a fast first-pass chart.
- You want consistent lane mapping without hand-placing every note.
- You need timing data carried over correctly so the chart stays synced.
- You want visibility into what mapped successfully and what did not.
- You want manual override controls when source note numbers are non-standard.

In short, this site is a chart-conversion assistant, not a full chart authoring replacement.

## Who This Is For

- Clone Hero charters building drum charts quickly from source files.
- Moonscraper users who want an automated import baseline.
- Creators working with MIDI or Guitar Pro drum arrangements.
- Users who need a transparent conversion report before final chart cleanup.

## Supported Inputs And Output

Input formats:

- `.mid`, `.midi`
- `.gp`, `.gpif`, `.gpx`

Output format:

- Clone Hero / Moonscraper `.chart` file with drum difficulty sections.

## Future Compatibility

This site currently focuses on drum chart conversion.

The architecture is intentionally moving toward broader support so future updates can add conversion profiles for other instruments (for example, guitar, bass, keys, or other) without replacing the entire pipeline.

Current priority is improving GP drum reliability first, then generalizing the mapping layer for additional instrument types.

## What The Converter Actually Does

At conversion time, the app performs a defined pipeline:

1. Reads your file in the browser.
2. Detects or selects the relevant drum track/part.
3. Normalizes source MIDI note numbers (including GP articulation mapping).
4. Applies optional manual remap rules (for custom or unusual note layouts).
5. Maps recognized notes into 5 drum lanes:
   - `0`: kick
   - `1`: red (snare)
   - `2`: yellow
   - `3`: blue
   - `4`: green
6. Optionally emits pro-drums cymbal markers:
   - `66` yellow cymbal
   - `67` blue cymbal
   - `68` green cymbal
7. Preserves tempo and time signature events into `[SyncTrack]`.
8. Builds chart sections and exports a downloadable `.chart`.
9. Shows diagnostics (mapped count, unmapped count, note histograms, lane breakdown).

## Why Manual MIDI Remap Exists

Different authoring tools and drum libraries use different MIDI note numbers for similar hits. Because of that, some notes can appear as unmapped during conversion.

Manual remap lets you explicitly translate source notes before lane mapping, for example:

- `44->42`
- `31->38`

This is especially useful for GP imports where articulation or kit definitions vary by file.

## Current Mapping Profile

- Kick: `35`, `36`
- Red/snare: `31`, `37`, `38`, `39`, `40`
- Yellow cymbals: `22`, `26`, `42`, `44`, `46`
- Yellow toms: `48`, `50`
- Blue cymbals: `51`, `53`, `59`
- Blue toms: `45`, `47`
- Green cymbals: `49`, `52`, `55`, `57`
- Green toms: `41`, `43`

If your source files use a different map, use manual remap first, then extend mapping in code if needed.

## Conversion Settings Summary

- `Prefer channel 10 tracks only`: prioritizes standard MIDI drum channel behavior.
- `Emit pro-drums cymbal marker notes`: adds cymbal flag notes for pro-drums compatibility.
- `Accent yellow cymbal when open hi-hat is detected`: adds accent markers for open hi-hat hits on the yellow cymbal lane.
- `Force zero-length drum gems`: emits drum hits with zero sustain (common charting preference).
- `Preserve stacked hits`: nudges same-lane/same-tick collisions by 1 tick so hits are retained.
- `Difficulty section`: choose output section (`EasyDrums`, `MediumDrums`, `HardDrums`, `ExpertDrums`).
- `Manual MIDI remap rules`: user-defined source-to-target note remapping before mapping.

## What This Site Is Not

- Not an automatic quality guarantee for final chart playability.
- Not a substitute for musical chart review and cleanup.
- Not a full multi-track chart editor.

You should still open output in Moonscraper or Clone Hero workflows for final validation.

## GP Import Reliability Note

When using GP inputs, some files may still lose notes during mapping due to source-format/articulation edge cases.

Known status:

- GP mapping can occasionally miss notes on some files.
- MIDI inputs are usually more consistent right now.
- Ongoing fixes are focused on improving GP note retention and mapping accuracy.

## Typical Workflow

1. Upload MIDI or GP file.
2. If GP, choose the intended drum track/part.
3. Convert once and inspect diagnostics.
4. If unmapped notes appear, add manual remap rules.
5. Convert again until mapping looks correct.
6. Download `.chart` and perform final authoring pass.

## Run Locally

```bash
npm install
npm run dev
```

Build for production:

```bash
npm run build
npm run preview
```

## Notes For Developers

- MIDI conversion logic is implemented in `src/lib/midiToChart.ts`.
- GP conversion logic is implemented in `src/lib/gpToChart.ts`.
- If needed, you can extend mapping sets to support additional kits and authoring conventions.

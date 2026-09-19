# Subtitle templates and editor controls

The current catalog contains Quiet Editorial, Paper Resonance, Panorama Lyrics,
and Poetry Lyrics. The two lyric templates are independent visual directions,
not modifications of the first two scenes.

## Visual directions

**Panorama Lyrics / 全景映像** uses the background as a full photographic stage,
a small complete sleeve beside the track identity, and a translucent lyric
field. Its centered composition and restrained lower spectrum leave the lyrics
as the primary focus. Dark mode deepens the image; light mode uses an ivory scrim.

**Poetry Lyrics / 留白詩頁** uses an ivory or charcoal reading page with centered
serif lyrics. The uploaded background fills a tall photographic margin with
almost imperceptible drift; the complete sleeve and track identity stay still
in the header. A single ink-like line responds to low-frequency energy below
the lyrics. A fine progress rule and centered monospaced time finish the page.
The photographic margin narrows in portrait outputs to preserve reading space.
There are no rotating shapes, particles, or glow effects.

## Start-time scrolling

The parser retains only `{ start, text }` for each cue. Start times are sorted,
duplicates are merged, and end timestamps are intentionally discarded. A binary
search chooses the most recent start at a given video timestamp. No lyric clears
on an SRT end time, including during an instrumental gap or after the last cue.

At a start, the next line moves upward toward the center using an eased transition
of at most 450 ms, shortened to fit closely spaced starts. The previous row's
opacity changes continuously instead of jumping at the boundary. Opacity is
highest at the center, declines with distance, and fades at the reading field's
edges. Multiline cues occupy fixed slots and fit their available space; line
height does not change the scroll distance midway through a transition.

Preview and worker share the same scene and timeline functions. The preview is
silent and uses demonstration audio features; after SRT import it begins shortly
before the first cue and loops. There is no music playback, editing timeline,
or scrubber. Without SRT, only preview uses sample lyrics and clearly identifies
them as a demonstration. Both UI and worker scene creation reject lyric exports
without actual cues.

## Settings and persistence

Each project stores a separate settings object for each template. All four
support mode, accent, motion (0–5), background visibility (20–100%), sleeve
size (65–100%), and sleeve X/Y displacement (−50–50% of canvas dimensions).
Lyric templates also support size (80–130%), spacing (1.5–2.3),
and surrounding-line opacity (15–65%). Reset affects only the selected template.
Settings are validated, serialized with the project, and snapshotted for export.

Poetry Lyrics and Paper Resonance additionally support 1–8 wave lines and five
curated multi-color palettes (earth, coast, plum, forest, rose), plus original/custom
accent mode. Their photographic region stays right-aligned with adjustable width:
Poetry 10–60% of the canvas (scaled by 0.75 in portrait), Paper 10–100% of its
original photographic strip. Background zoom is 1–3×; X/Y pan spans −100–100%
of the available crop without exposing empty edges. Cover offsets move only the
artwork and its mount, not track text. Existing records receive neutral defaults.
Panorama's spectrum occupies approximately 50% of the frame width.

Original audio remains transient. Parsed subtitles and image references remain
local to the browser. The SRT source file and filename are not retained. Import
gates prevent a late subtitle read from changing a different project or restoring
removed subtitles. An invalid replacement keeps the last valid cues.

Retired Spectrum Cover, Vinyl Particle, and Abstract Pulse identifiers migrate
to Quiet Editorial on read; project media, metadata, and old outputs are not
deleted. The retired rendering implementations and catalog entries are removed.
Retired Geometry Lyrics also migrates to Poetry Lyrics, retaining subtitles and
per-template settings; existing Poetry Lyrics settings take precedence if both exist.

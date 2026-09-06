# tempo-lock

Take a track with live drums (so the tempo wanders), find every beat, and re-time the
audio so the beats sit on a fixed-BPM grid, without changing pitch. Makes live
recordings behave like quantised tracks when DJing.

```
MP3 in ──► Beat This! (beats + downbeats)
        ──► snap each beat to the drum transient, fix missed/spurious beats
        ──► build a fixed grid at the target BPM
        ──► Rubber Band R3 time map (variable stretch, pitch untouched)
        ──► MP3 out (tags copied, TBPM set)
```

Web app: waveform + beat grid for the original and the straightened version, a
tempo-over-time chart, A/B playback that keeps your place when you switch, and a click
track on the grid so you can hear whether the beats really land.

## Run it

```bash
cd tempo-lock
./setup.sh                      # apt/brew: rubberband-cli + ffmpeg; venv; CPU torch; pip deps
. .venv/bin/activate
python -m tempolock serve       # http://127.0.0.1:8000
```

Command line:

```bash
python -m tempolock analyse track.mp3              # beats, downbeats, tempo stats as JSON
python -m tempolock render track.mp3               # writes track_124bpm.mp3 at the rounded median tempo
python -m tempolock render track.mp3 --bpm 124.5 -o out.mp3 --grid grid.json
python -m tempolock render track.mp3 --level 2     # detector locked onto half-time
python -m pytest tests                              # ~15 s, synthesises its own test track
```

First analysis downloads the Beat This! checkpoint (~80 MB) and loads the model (~7 s).
After that a 5-minute track takes roughly 20 s to analyse and 15 s to render on a
4-core CPU. A GPU is used automatically if torch sees one.

## How it works

**Detection.** [Beat This!](https://github.com/CPJKU/beat_this) (CPJKU, ISMIR 2024)
runs on the mono mix and gives beat and downbeat times at 20 ms resolution. Its output is
plain peak-picking with no tempo-continuity prior, which is exactly what you want when
the tempo genuinely moves. We deliberately do *not* enable its optional DBN
post-processor: the DBN enforces smooth tempo and is the part that fails on unstable
tempo (see the "SMC Blind Spot" paper below).

**Refinement** (`tempolock/analysis.py`). 20 ms is too coarse for a DJ grid, so each
beat is snapped to the strongest onset within ±35 ms of it, computed from a
librosa onset-strength envelope at 5.8 ms hops. Then beats are walked in order with a
rolling local period: a gap of ~2 periods means a missed beat (the beat *index* jumps by
2 so the grid stays honest), a beat arriving at <0.6 periods is a spurious double and is
dropped, and detections in near-silence (a phantom beat at t=0 is common) are discarded.
Dropped beats are shown as small red ticks in the UI.

**Deliberate tempo changes** (`segment_tempo`). A drummer drifting and a song that
changes tempo look the same to a single-BPM grid, but they should not be treated the
same: flattening a deliberate 120→140 change slows a whole section by 14%. So the
per-beat tempo curve is scanned for *steps*: at each candidate boundary a line is fitted
to the 8 beats on either side and the gap between the two lines at the boundary is
measured. A ramp, however steep, has continuous lines and no gap; a real step shows the
whole jump. Steps of 5% or more that hold for at least 8 beats become section
boundaries. Fills and push/pull are absorbed by a 3-beat median and the minimum section
length. The UI shows a warning with the time and size of each change (click to jump
there), shades the sections on the tempo chart, and draws a histogram of per-beat BPM
coloured by section, so two tempos show up as two humps. Rendering is still one BPM for
the whole track; per-section targets are the natural next step.

**Grid.** Target beat k lands at `t_first + k · 60/BPM`, so the intro before the first
beat and the tail after the last are left untouched (ratio 1). Default BPM is the
rounded median of the instantaneous tempo. The UI refuses a target more than 30% from
the detected tempo because that would change the *speed* of the track rather than
straighten it; if the detector locked onto half- or double-time, set "Detected beats
are" instead of typing 2× the number.

**Stretch** (`tempolock/render.py`). Rubber Band's CLI accepts a time map: pairs of
`source_frame target_frame` between which it varies the stretch ratio smoothly. We
give it one pair per beat plus the end of file and run the R3 engine (`-3`). Pitch is not
touched. Gotcha found the hard way: don't include a leading `0 0` pair, R3 divides by
zero on it and silently skips stretching those segments.

**Verification.** `tests/test_end_to_end.py` synthesises a drum track whose tempo
swings ±5 BPM around 120, straightens it, re-detects the beats on the output and asserts
the inter-beat interval is constant to within a few ms. On that material the rendered
grid is within ~2 ms (median) of where we said the beats would be.

**Playback alignment.** The browser plays a server-decoded PCM copy of both versions.
MP3 decoders disagree about the encoder delay by ~25 ms, which is enough to make a
correct grid look wrong, so the browser and the analyser must share one decode.

## Beat tracker research (Sept 2026)

The requirement is offline, per-beat timestamps on music with drifting tempo, ideally
with downbeats. Summary of what is realistically installable:

| Library | GTZAN beat F1 / downbeat F1 | Handles drifting tempo | Downbeats | Weight | Install on py3.11 | Licence |
|---|---|---|---|---|---|---|
| **Beat This!** (CPJKU 2024) | **0.891 / 0.783** | Yes, by design (no tempo prior, trained with ±20% speed aug.) | Yes | torch, 80 MB ckpt | `pip install beat_this` | MIT |
| madmom RNN+DBN | ~0.88 / – | DBN enforces tempo continuity, 55–215 BPM, 3/4 or 4/4 | Yes | numpy only | broken on PyPI (2018); works from git | BSD, models CC-BY-NC |
| BeatNet / BeatNet+ | 0.75 / 0.47 (0.81 / 0.57) | online particle filter; offline uses madmom DBN | Yes | torch + madmom | PyPI unresolvable on 3.11 | CC-BY |
| All-In-One (Kim 2023) | Harmonix 0.958 / 0.915, no GTZAN | madmom DBN | Yes + segments | torch, Demucs, NATTEN | fragile, unmaintained since 2023 | MIT |
| Essentia RhythmExtractor2013 | not published as F1 | whole-track statistics | No | C++ wheels | `pip install essentia` | AGPL |
| librosa `beat_track` / `plp` | classic DP baseline, well below | `beat_track` assumes one tempo; `plp` is local | No | none extra | trivial | ISC |

Beat This! wins on every axis that matters here. The 2026 masked-diffusion follow-up
(GTZAN 0.897 / 0.795) has no released inference code yet. librosa is kept as a fallback
so the app still runs without torch, but expect it to miss fills and drift.

Sources: [Beat This! paper](https://arxiv.org/abs/2407.21658) ·
[SMC Blind Spot failure analysis](https://arxiv.org/abs/2605.12287) ·
[madmom numpy-2 PR](https://github.com/CPJKU/madmom/pull/540) ·
[BeatNet+](https://transactions.ismir.net/articles/10.5334/tismir.198) ·
[All-In-One](https://arxiv.org/abs/2307.16425) ·
[Rubber Band CLI](https://breakfastquay.com/rubberband/usage.txt).

### Why Rubber Band and not a phase vocoder

Drums are transients. Phase-vocoder stretchers (librosa, most Python TSM packages)
smear them and only do constant ratios anyway. Rubber Band R3 handles transients well,
is GPL, ships in every distro, and its time-map mode is the only off-the-shelf way to do
a *continuously varying* stretch without stitching segments together yourself. R2 with
`--crisp 6` is offered as the faster option and is worth an A/B on very dry drum-only
material.

## Layout

```
tempolock/analysis.py   detector output -> refined, indexed beats + tempo curve
tempolock/detectors.py  Beat This! (cached model) and librosa fallback
tempolock/render.py     grid, Rubber Band time map, stretch
tempolock/audio.py      decode anything, MP3 encode with tag copy + TBPM
tempolock/server.py     FastAPI: upload, analyse, render, stream, download
tempolock/cli.py        analyse | render | serve
static/                 index.html, app.js, style.css (no build step)
tests/                  unit tests + synthetic end-to-end test
```

## Known limits / ideas

- Tempo changes are flagged but not yet honoured: rendering uses one BPM for the whole
  track. Per-section targets (each section to its own steady BPM, hard cut between them)
  would reuse the same time map.
- No manual grid editing yet (nudge a beat, insert/delete one, set the downbeat). The
  data model supports it; it is mostly UI work.
- Tracks that change time signature or have long free-time sections will get a grid
  that is technically right but musically odd. Rendering only a section is not
  supported yet.
- Uploaded files live in `tempo-lock/data/` and the job table is in memory. Restarting
  the server forgets tracks.
- Beat This! processes 30 s chunks, so a beat straddling a chunk border can very
  occasionally be missed; the index logic covers that.

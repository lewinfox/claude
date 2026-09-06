"""Turn raw detector output into a clean, indexed beat list plus tempo statistics."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict

import numpy as np

from .detectors import RawBeats, detect


@dataclass
class Analysis:
    sr: int
    duration: float
    detector: str
    beats: np.ndarray  # refined beat times (s)
    beat_index: np.ndarray  # integer beat count for each beat (accounts for missed beats)
    is_downbeat: np.ndarray  # bool per beat
    bpm_times: np.ndarray  # midpoint of each inter-beat interval (s)
    bpm_curve: np.ndarray  # instantaneous BPM per interval
    median_bpm: float
    min_bpm: float
    max_bpm: float
    suggested_bpm: float
    dropped_beats: list = field(default_factory=list)  # spurious detections we discarded (s)

    def to_dict(self) -> dict:
        d = asdict(self)
        for k, v in d.items():
            if isinstance(v, np.ndarray):
                d[k] = v.tolist()
        return d


def onset_envelope(mono: np.ndarray, sr: int, hop: int = 256) -> tuple[np.ndarray, np.ndarray]:
    import librosa

    env = librosa.onset.onset_strength(y=mono, sr=sr, hop_length=hop)
    times = librosa.frames_to_time(np.arange(len(env)), sr=sr, hop_length=hop)
    return env, times


def refine_to_onsets(beats: np.ndarray, env: np.ndarray, times: np.ndarray, window: float = 0.035) -> np.ndarray:
    """Beat trackers emit frame-quantised times (Beat This!: 20 ms). Snap each beat to the
    strongest onset within +/-window so the grid lands on the actual drum transient."""
    out = np.empty_like(beats)
    for i, b in enumerate(beats):
        lo, hi = np.searchsorted(times, [b - window, b + window])
        if hi <= lo:
            out[i] = b
            continue
        seg = env[lo:hi]
        k = int(np.argmax(seg))
        # only snap when there is a clear transient; a flat window would send argmax to its edge
        if seg[k] > 0 and seg[k] > 1.5 * np.median(seg) + 1e-9:
            out[i] = times[lo + k]
        else:
            out[i] = b
    return out


def clean_beats(beats: np.ndarray, env: np.ndarray, times: np.ndarray) -> tuple[np.ndarray, np.ndarray, list]:
    """Assign an integer beat index to each detection, tolerating both missed beats
    (index jumps by 2+) and spurious extra beats (dropped). Also drops detections that
    sit in near-silence, e.g. a phantom beat at t=0 before the music starts.

    Returns (beats, indices, dropped)."""
    beats = np.sort(np.asarray(beats, float))
    if len(beats) < 2:
        return beats, np.arange(len(beats)), []

    strength = np.array([env[min(len(env) - 1, int(np.searchsorted(times, b)))] for b in beats])
    audible = strength > 0.02 * np.max(strength)
    dropped = beats[~audible].tolist()
    beats = beats[audible]
    if len(beats) < 2:
        return beats, np.arange(len(beats)), dropped

    ibi = np.diff(beats)
    period = float(np.median(ibi))
    kept = [beats[0]]
    index = [0]
    recent = [period] * 4  # rolling local period estimate
    for b in beats[1:]:
        local = float(np.median(recent))
        gap = b - kept[-1]
        if gap < 0.6 * local:
            dropped.append(float(b))  # too soon: spurious double detection
            continue
        steps = max(1, int(round(gap / local)))
        kept.append(b)
        index.append(index[-1] + steps)
        recent.append(gap / steps)
        recent = recent[-8:]
    return np.array(kept), np.array(index, int), dropped


def analyse(y: np.ndarray, sr: int, backend: str = "auto", raw: RawBeats | None = None) -> Analysis:
    mono = y.mean(axis=1) if y.ndim == 2 else y
    if raw is None:
        raw = detect(mono, sr, backend=backend)
    env, times = onset_envelope(mono, sr)
    beats = refine_to_onsets(raw.beats, env, times)
    beats, index, dropped = clean_beats(beats, env, times)

    is_down = np.zeros(len(beats), bool)
    if len(raw.downbeats):
        for d in raw.downbeats:
            if len(beats) == 0:
                break
            k = int(np.argmin(np.abs(beats - d)))
            if abs(beats[k] - d) < 0.06:
                is_down[k] = True

    if len(beats) >= 2:
        ibi = np.diff(beats) / np.diff(index)
        bpm = 60.0 / ibi
        bpm_times = (beats[1:] + beats[:-1]) / 2
        median = float(np.median(bpm))
        return Analysis(
            sr=sr,
            duration=len(y) / sr,
            detector=raw.detector,
            beats=beats,
            beat_index=index,
            is_downbeat=is_down,
            bpm_times=bpm_times,
            bpm_curve=bpm,
            median_bpm=median,
            min_bpm=float(np.percentile(bpm, 2)),
            max_bpm=float(np.percentile(bpm, 98)),
            suggested_bpm=float(round(median)),
            dropped_beats=dropped,
        )
    return Analysis(sr, len(y) / sr, raw.detector, beats, index, is_down, np.array([]), np.array([]), 0.0, 0.0, 0.0, 0.0, dropped)


def waveform_peaks(y: np.ndarray, buckets: int = 4000) -> dict:
    """Min/max per bucket, quantised to int8, for drawing the waveform in the browser."""
    mono = y.mean(axis=1) if y.ndim == 2 else y
    n = len(mono)
    buckets = min(buckets, n) or 1
    edges = np.linspace(0, n, buckets + 1).astype(int)
    mins = np.zeros(buckets, np.float32)
    maxs = np.zeros(buckets, np.float32)
    for i in range(buckets):
        seg = mono[edges[i]:max(edges[i] + 1, edges[i + 1])]
        mins[i] = seg.min()
        maxs[i] = seg.max()
    scale = max(1e-9, float(max(np.abs(mins).max(), np.abs(maxs).max())))
    return {
        "min": np.round(mins / scale * 127).astype(int).tolist(),
        "max": np.round(maxs / scale * 127).astype(int).tolist(),
    }

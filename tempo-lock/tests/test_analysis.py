import numpy as np

from tempolock.analysis import clean_beats, refine_to_onsets


def _flat_env(duration=10.0, hop_s=0.005):
    times = np.arange(0, duration, hop_s)
    return np.ones_like(times), times


def test_clean_beats_fills_missed_beat_with_index_gap():
    env, times = _flat_env()
    beats = np.array([1.0, 1.5, 2.0, 3.0, 3.5])  # beat at 2.5 was missed
    kept, idx, dropped = clean_beats(beats, env, times)
    assert list(kept) == [1.0, 1.5, 2.0, 3.0, 3.5]
    assert list(idx) == [0, 1, 2, 4, 5]
    assert dropped == []


def test_clean_beats_drops_spurious_double_detection():
    env, times = _flat_env()
    beats = np.array([1.0, 1.5, 1.6, 2.0, 2.5])  # 1.6 is a phantom
    kept, idx, dropped = clean_beats(beats, env, times)
    assert list(kept) == [1.0, 1.5, 2.0, 2.5]
    assert list(idx) == [0, 1, 2, 3]
    assert dropped == [1.6]


def test_clean_beats_drops_beats_in_silence():
    times = np.arange(0, 10, 0.005)
    env = np.ones_like(times)
    env[times < 0.9] = 0.0  # silence before the music starts
    kept, idx, dropped = clean_beats(np.array([0.0, 1.0, 1.5, 2.0]), env, times)
    assert list(kept) == [1.0, 1.5, 2.0]
    assert dropped == [0.0]


def test_refine_snaps_to_strongest_onset_in_window():
    times = np.arange(0, 5, 0.005)
    env = np.zeros_like(times)
    env[np.searchsorted(times, 2.013)] = 5.0
    out = refine_to_onsets(np.array([2.0]), env, times, window=0.035)
    assert abs(out[0] - 2.013) < 0.003
    # nothing within the window: unchanged
    out = refine_to_onsets(np.array([4.0]), env, times, window=0.035)
    assert out[0] == 4.0

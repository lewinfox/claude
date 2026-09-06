"""FastAPI app: upload a track, analyse it, render it straightened, stream both back."""
from __future__ import annotations

import logging
import os
import shutil
import threading
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import audio
from .analysis import Analysis, analyse, waveform_peaks
from .render import RubberBandMissing, render, rubberband_binary
from .detectors import beat_this_available

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("TEMPOLOCK_DATA", ROOT / "data"))
DATA.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="tempo-lock")


class Track:
    def __init__(self, id: str, name: str, path: Path):
        self.id = id
        self.name = name
        self.path = path
        self.status = "analysing"  # analysing | ready | rendering | rendered | error
        self.error: str | None = None
        self.y: np.ndarray | None = None
        self.sr: int = 0
        self.analysis: Analysis | None = None
        self.peaks: dict | None = None
        self.rendered: dict | None = None  # {bpm, peaks, grid, mp3, wav}
        self.playback_wav: Path | None = None
        self.lock = threading.Lock()

    def public(self) -> dict:
        d = {"id": self.id, "name": self.name, "status": self.status, "error": self.error}
        if self.analysis is not None:
            d["analysis"] = self.analysis.to_dict()
            d["peaks"] = self.peaks
        if self.rendered is not None:
            d["rendered"] = {k: v for k, v in self.rendered.items() if k in ("bpm", "peaks", "grid", "duration")}
        return d


TRACKS: dict[str, Track] = {}


def _analyse_job(track: Track, backend: str):
    try:
        y, sr = audio.load(track.path)
        track.y, track.sr = y, sr
        track.peaks = waveform_peaks(y)
        # the browser plays a server-decoded PCM copy so its timeline matches ours exactly
        # (MP3 decoders disagree about encoder delay by ~25 ms, enough to misplace a grid)
        track.playback_wav = track.path.with_name(f"{track.id}_original.wav")
        sf.write(str(track.playback_wav), y, sr, subtype="PCM_16")
        track.analysis = analyse(y, sr, backend=backend)
        track.status = "ready"
    except Exception as e:  # pragma: no cover
        log.exception("analysis failed")
        track.status, track.error = "error", str(e)


class RenderRequest(BaseModel):
    target_bpm: float
    engine: str = "r3"
    level: float = 1.0  # 1 = detected beats are the beat; 2 = half-time detected; 0.5 = double-time


def _render_job(track: Track, req: RenderRequest):
    try:
        assert track.y is not None and track.analysis is not None
        z, grid = render(track.y, track.sr, track.analysis, req.target_bpm, engine=req.engine, level=req.level)
        wav = track.path.with_name(f"{track.id}_rendered.wav")
        mp3 = track.path.with_name(f"{track.id}_rendered.mp3")
        sf.write(str(wav), z, track.sr, subtype="PCM_16")
        audio.write_mp3(mp3, z, track.sr, copy_tags_from=track.path, bpm=req.target_bpm)
        track.rendered = {
            "bpm": req.target_bpm,
            "peaks": waveform_peaks(z),
            "grid": grid.to_dict(),
            "duration": len(z) / track.sr,
            "wav": wav,
            "mp3": mp3,
        }
        track.status = "rendered"
    except Exception as e:
        log.exception("render failed")
        track.status, track.error = "error", str(e)


@app.get("/api/health")
def health():
    return {"beat_this": beat_this_available(), "rubberband": rubberband_binary(), "ffmpeg": bool(shutil.which("ffmpeg"))}


@app.post("/api/tracks")
async def upload(file: UploadFile = File(...), detector: str = "auto"):
    tid = uuid.uuid4().hex[:12]
    suffix = Path(file.filename or "track.mp3").suffix.lower() or ".mp3"
    dest = DATA / f"{tid}{suffix}"
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    track = Track(tid, file.filename or dest.name, dest)
    TRACKS[tid] = track
    threading.Thread(target=_analyse_job, args=(track, detector), daemon=True).start()
    return {"id": tid, "status": track.status}


@app.get("/api/tracks/{tid}")
def get_track(tid: str):
    track = TRACKS.get(tid)
    if not track:
        raise HTTPException(404)
    return JSONResponse(track.public())


@app.post("/api/tracks/{tid}/render")
def start_render(tid: str, req: RenderRequest):
    track = TRACKS.get(tid)
    if not track:
        raise HTTPException(404)
    if track.analysis is None:
        raise HTTPException(409, "analysis not finished")
    if rubberband_binary() is None:
        raise HTTPException(500, "rubberband CLI not installed on the server")
    if not (20 <= req.target_bpm <= 400):
        raise HTTPException(422, "target_bpm out of range")
    if req.level not in (0.5, 1.0, 2.0):
        raise HTTPException(422, "level must be 0.5, 1 or 2")
    detected = track.analysis.median_bpm / req.level
    if detected and abs(req.target_bpm / detected - 1) > 0.3:
        raise HTTPException(
            422,
            f"target {req.target_bpm:g} BPM is more than 30% away from the detected {detected:.1f} BPM; "
            "that would change the speed of the track rather than straighten it. If the detector "
            "locked onto half- or double-time, change the beat level instead.",
        )
    with track.lock:
        if track.status == "rendering":
            raise HTTPException(409, "already rendering")
        track.status, track.error = "rendering", None
    threading.Thread(target=_render_job, args=(track, req), daemon=True).start()
    return {"id": tid, "status": track.status}


@app.get("/api/tracks/{tid}/audio/{which}")
def get_audio(tid: str, which: str):
    track = TRACKS.get(tid)
    if not track:
        raise HTTPException(404)
    if which == "original":
        return FileResponse(track.playback_wav or track.path, media_type="audio/wav")
    if which == "rendered" and track.rendered:
        return FileResponse(track.rendered["wav"], media_type="audio/wav")
    raise HTTPException(404)


@app.get("/api/tracks/{tid}/download")
def download(tid: str):
    track = TRACKS.get(tid)
    if not track or not track.rendered:
        raise HTTPException(404)
    stem = Path(track.name).stem
    return FileResponse(track.rendered["mp3"], media_type="audio/mpeg", filename=f"{stem} [{track.rendered['bpm']:g} BPM].mp3")


app.mount("/", StaticFiles(directory=ROOT / "static", html=True), name="static")

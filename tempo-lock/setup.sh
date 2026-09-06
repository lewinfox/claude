#!/usr/bin/env bash
# One-shot setup for tempo-lock on Debian/Ubuntu or macOS. Re-runnable.
set -euo pipefail
cd "$(dirname "$0")"

if command -v apt-get >/dev/null; then
  echo ">> system packages (rubberband-cli, ffmpeg)"
  sudo apt-get install -y rubberband-cli ffmpeg
elif command -v brew >/dev/null; then
  echo ">> system packages (rubberband, ffmpeg)"
  brew install rubberband ffmpeg
else
  echo "!! install the Rubber Band CLI and ffmpeg yourself, then re-run" >&2
fi

python3 -m venv .venv
. .venv/bin/activate
pip install --upgrade pip
# CPU-only torch is ~10x smaller than the CUDA build and plenty fast for this
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt

echo
echo "done. run the web app with:   . .venv/bin/activate && python -m tempolock serve"
echo "or from the command line:     python -m tempolock render some_track.mp3"

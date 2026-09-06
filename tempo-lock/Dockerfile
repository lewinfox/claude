# tempo-lock: CPU-only image with Beat This!, Rubber Band and ffmpeg baked in.
#   docker build -t tempo-lock .
#   docker run --rm -p 8000:8000 -v tempo-lock-data:/data tempo-lock
# Or: docker compose up --build
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TORCH_HOME=/models \
    TEMPOLOCK_DATA=/data

# rubberband-cli 3.x (R3 engine) + ffmpeg (decode anything, encode MP3 with tags)
RUN apt-get update \
 && apt-get install -y --no-install-recommends rubberband-cli ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only torch is ~10x smaller than the default CUDA build and plenty fast for this
COPY requirements.txt .
RUN pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu \
 && pip install -r requirements.txt

# bake the Beat This! checkpoint (~80 MB) so the container works offline and the first
# analysis does not stall on a download
RUN python -c "from beat_this.inference import load_checkpoint; load_checkpoint('final0')"

COPY tempolock ./tempolock
COPY static ./static

RUN useradd --create-home --uid 1000 app \
 && mkdir -p /data \
 && chown -R app:app /app /data /models
USER app
VOLUME ["/data"]

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health').status==200 else 1)"

CMD ["python", "-m", "tempolock", "serve", "--host", "0.0.0.0", "--port", "8000"]

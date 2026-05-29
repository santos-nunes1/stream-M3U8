FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8000 \
    STREAM_CACHE_ROOT=/tmp/stream-buffer \
    STREAM_BUFFER_SECONDS=120 \
    STREAM_DOWNLOAD_TIMEOUT=10 \
    STREAM_PLAYBACK_MODE=auto \
    PLAYLIST_FETCH_TIMEOUT=45 \
    PRELOADED_PLAYLIST_PATH=/app/data/preloaded_playlist.m3u \
    PLAYLIST_REFRESH_ON_STARTUP=true \
    PLAYLIST_REFRESH_REQUIRED_ON_STARTUP=true \
    PLAYLIST_REFRESH_INTERVAL_SECONDS=43200 \
    STREAM_MAX_CACHE_BYTES=209715200

WORKDIR /app

COPY backend ./backend
COPY frontend ./frontend
COPY scripts ./scripts

RUN mkdir -p /tmp/stream-buffer /app/data

EXPOSE 8000

CMD ["python", "-m", "backend.app"]

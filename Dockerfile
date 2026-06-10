FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8000 \
    STREAM_CACHE_ROOT=/tmp/stream-buffer \
    STREAM_BUFFER_SECONDS=150 \
    STREAM_DOWNLOAD_TIMEOUT=10 \
    STREAM_PLAYBACK_MODE=auto \
    AUTH_DB_PATH=/app/data/auth.sqlite3 \
    AUTH_TOKEN_TTL_SECONDS=3600 \
    AUTH_SESSION_STALE_SECONDS=3600 \
    AUTH_SCREEN_LEASE_SECONDS=300 \
    AUTH_DEFAULT_MAX_SCREENS=2 \
    AUTH_DEFAULT_ACCESS_DAYS=30 \
    PLAYLIST_FETCH_TIMEOUT=300 \
    PRELOADED_PLAYLIST_PATH=/app/data/preloaded_playlist.m3u \
    PLAYLIST_REQUIRED_ON_STARTUP=true \
    PLAYLIST_MAX_AGE_SECONDS=21600 \
    PLAYLIST_REFRESH_ON_STARTUP=true \
    PLAYLIST_LOAD_BEFORE_SERVING=true \
    PLAYLIST_REFRESH_BLOCKING_ON_STARTUP=true \
    PLAYLIST_REFRESH_REQUIRED_ON_STARTUP=true \
    PLAYLIST_PARSED_CACHE_MAX_BYTES=52428800 \
    PLAYLIST_REFRESH_INTERVAL_SECONDS=21600 \
    STREAM_MAX_CACHE_BYTES=209715200

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY backend ./backend
COPY bot ./bot
COPY frontend ./frontend
COPY scripts ./scripts
COPY docker-entrypoint.py ./docker-entrypoint.py

RUN mkdir -p /tmp/stream-buffer /app/data /app/bot-data \
    && groupadd --system app \
    && useradd --system --gid app --home-dir /app app \
    && chown -R app:app /app /tmp/stream-buffer

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=30s --start-period=300s --retries=5 \
    CMD python -c "import os, socket; s=socket.create_connection(('127.0.0.1', int(os.getenv('PORT', '8000'))), 20); s.sendall(b'GET /readyz HTTP/1.0\r\nHost: localhost\r\n\r\n'); data=s.recv(128); s.close(); raise SystemExit(0 if b' 200 ' in data else 1)"

ENTRYPOINT ["python", "/app/docker-entrypoint.py"]
CMD ["python", "-m", "backend.app"]

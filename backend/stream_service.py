import hashlib
import json
import os
import re
import shutil
import socket
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple


class StreamOfflineError(Exception):
    pass


class SegmentTimeoutError(Exception):
    pass


class InvalidPlaylistError(Exception):
    pass


class StreamConfigurationError(Exception):
    pass


EXTINF_ATTR_RE = re.compile(r'([A-Za-z0-9_-]+)="([^"]*)"')


@dataclass
class Segment:
    url: str
    filename: str
    duration: float
    sequence: int


@dataclass
class ParsedPlaylist:
    media_sequence: int
    target_duration: float
    segments: List[Segment]
    endlist: bool = False


@dataclass
class StreamState:
    stream_id: str
    source_url: str
    media_url: str
    cache_dir: Path
    playlist_path: Path
    stop_event: threading.Event = field(default_factory=threading.Event)
    thread: Optional[threading.Thread] = None
    status: str = "buffering"
    last_error: Optional[str] = None
    active_clients: int = 0
    last_access: float = field(default_factory=time.time)
    segment_index: Dict[str, Segment] = field(default_factory=dict)
    is_vod: bool = False
    cache_complete: bool = False


class StreamBufferingService:
    def __init__(
        self,
        cache_root: Optional[str] = None,
        buffer_seconds: int = 120,
        download_timeout: float = 10.0,
        poll_interval: float = 0.5,
        max_cache_bytes: int = 200 * 1024 * 1024,
    ) -> None:
        self.cache_root = Path(cache_root or os.getenv("STREAM_CACHE_ROOT", "/tmp/stream-buffer"))
        self.buffer_seconds = buffer_seconds
        self.download_timeout = download_timeout
        self.poll_interval = poll_interval
        self.max_cache_bytes = max_cache_bytes
        self._states: Dict[str, StreamState] = {}
        self._states_lock = threading.Lock()
        self._cache_lock = threading.Lock()
        self.cache_root.mkdir(parents=True, exist_ok=True)

    def build_local_proxy_url(self, stream_id: str, base_url: str) -> str:
        quoted = urllib.parse.quote(stream_id, safe="")
        return f"{base_url.rstrip('/')}/proxy/{quoted}/playlist.m3u8"

    def build_direct_proxy_url(self, stream_id: str, base_url: str) -> str:
        quoted = urllib.parse.quote(stream_id, safe="")
        return f"{base_url.rstrip('/')}/media-proxy/{quoted}"

    def cache_dir_for(self, stream_id: str) -> Path:
        quoted = urllib.parse.quote(stream_id, safe="")
        if len(quoted) <= 180:
            return self.cache_root / quoted
        return self.cache_root / hashlib.sha256(stream_id.encode("utf-8")).hexdigest()

    def _cache_dir_for(self, stream_id: str) -> Path:
        return self.cache_dir_for(stream_id)

    def resolve_source_url(self, stream_id: str) -> str:
        if stream_id.startswith(("http://", "https://")):
            return stream_id

        template = os.getenv("STREAM_ORIGIN_TEMPLATE")
        if template:
            return template.format(stream_id=stream_id)

        source_map = os.getenv("STREAM_SOURCE_MAP")
        if source_map:
            try:
                data = json.loads(source_map)
            except json.JSONDecodeError as exc:
                raise StreamConfigurationError("STREAM_SOURCE_MAP must be valid JSON") from exc
            if stream_id in data:
                return data[stream_id]

        raise StreamConfigurationError(
            "No source URL available. Send a direct URL or set STREAM_ORIGIN_TEMPLATE/STREAM_SOURCE_MAP."
        )

    def start_stream(self, stream_id: str, base_url: str) -> Dict[str, str]:
        source_url = self.resolve_source_url(stream_id)
        if self._is_direct_media_url(source_url):
            return {
                "local_proxy_url": self.build_direct_proxy_url(stream_id, base_url),
                "status": "proxying",
                "media_kind": classify_media_kind(source_url, ""),
            }

        created = False
        with self._states_lock:
            state = self._states.get(stream_id)
            if state is None:
                cache_dir = self.cache_dir_for(stream_id)
                cache_dir.mkdir(parents=True, exist_ok=True)
                state = StreamState(
                    stream_id=stream_id,
                    source_url=source_url,
                    media_url=source_url,
                    cache_dir=cache_dir,
                    playlist_path=cache_dir / "playlist.m3u8",
                )
                self._states[stream_id] = state
                created = True
            state.active_clients += 1
            state.last_access = time.time()

        if created:
            try:
                self._refresh_state(state, initial=True)
            except Exception:
                with self._states_lock:
                    self._states.pop(stream_id, None)
                shutil.rmtree(state.cache_dir, ignore_errors=True)
                raise
            state.thread = threading.Thread(target=self._download_worker, args=(state,), daemon=True)
            state.thread.start()

        return {
            "local_proxy_url": self.build_local_proxy_url(stream_id, base_url),
            "status": "buffering",
            "media_kind": "hls",
        }

    def stop_stream(self, stream_id: str) -> Dict[str, str]:
        with self._states_lock:
            state = self._states.get(stream_id)
            if state is None:
                return {"status": "stopped"}

            state.active_clients = max(0, state.active_clients - 1)
            if state.active_clients == 0:
                state.stop_event.set()
                self._states.pop(stream_id, None)
                thread = state.thread
            else:
                thread = None

        if thread is not None:
            thread.join(timeout=1.0)
            shutil.rmtree(state.cache_dir, ignore_errors=True)
        return {"status": "stopped"}

    def attach_client(self, stream_id: str) -> None:
        with self._states_lock:
            state = self._states.get(stream_id)
            if state is not None:
                state.last_access = time.time()

    def get_playlist_path(self, stream_id: str) -> Optional[Path]:
        with self._states_lock:
            state = self._states.get(stream_id)
            return None if state is None else state.playlist_path

    def get_segment_path(self, stream_id: str, filename: str) -> Optional[Path]:
        with self._states_lock:
            state = self._states.get(stream_id)
            return None if state is None else state.cache_dir / filename

    def ensure_segment_path(self, stream_id: str, filename: str) -> Optional[Path]:
        with self._states_lock:
            state = self._states.get(stream_id)
            if state is None:
                return None
            target = state.cache_dir / filename
            segment = state.segment_index.get(filename)

        if target.exists():
            return target
        if segment is None:
            return None

        self._download_segment(segment, target)
        return target

    def stream_cached_file(self, target: Path, writer) -> None:
        with self._cache_lock:
            with open(target, "rb") as handle:
                while True:
                    chunk = handle.read(1024 * 64)
                    if not chunk:
                        break
                    try:
                        writer.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        return

    def prune_cache(self, stream_id: str) -> None:
        with self._states_lock:
            state = self._states.get(stream_id)
            if state is None:
                return

        keep_files: Set[str] = {"playlist.m3u8"}
        with self._cache_lock:
            if state.playlist_path.exists():
                for line in state.playlist_path.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if line and not line.startswith("#"):
                        keep_files.add(urllib.parse.unquote(Path(urllib.parse.urlsplit(line).path).name))
        self._prune_unlisted_segments(state, keep_files)

    def _download_worker(self, state: StreamState) -> None:
        while not state.stop_event.is_set():
            try:
                self._refresh_state(state)
                state.status = "buffering"
                state.last_error = None
                if state.is_vod and state.cache_complete:
                    return
            except (StreamOfflineError, SegmentTimeoutError, InvalidPlaylistError) as exc:
                state.last_error = str(exc)
                state.status = "error"
            except Exception as exc:
                state.last_error = str(exc)
                state.status = "error"
            state.stop_event.wait(self.poll_interval)

    def _refresh_state(self, state: StreamState, initial: bool = False) -> None:
        state.media_url, playlist_text = self._resolve_media_playlist(state.media_url)
        parsed = self._parse_playlist(playlist_text, state.media_url)
        segments = parsed.segments if parsed.endlist else self._window_segments(parsed.segments)
        state.is_vod = parsed.endlist
        state.segment_index = {segment.filename: segment for segment in segments}

        if parsed.endlist and initial:
            # For VOD, return quickly with a complete local playlist; the rest is cached in the worker.
            self._ensure_segments(state, segments[:1])
        else:
            self._ensure_segments(state, segments)

        self._write_playlist_file(state, parsed, segments)
        self._prune_unlisted_segments(state, {segment.filename for segment in segments})
        self._enforce_cache_size(state, {segment.filename for segment in segments})
        state.cache_complete = parsed.endlist and self._all_segments_cached(state, segments)

    def _urlopen(self, url: str, timeout: Optional[float] = None):
        context = None
        if os.getenv("STREAM_INSECURE_SSL", "false").lower() in {"1", "true", "yes", "on"}:
            context = ssl._create_unverified_context()
        request = urllib.request.Request(url, headers=self._origin_headers())
        return urllib.request.urlopen(request, timeout=timeout or self.download_timeout, context=context)

    def _origin_headers(self) -> Dict[str, str]:
        return {
            "User-Agent": os.getenv(
                "STREAM_USER_AGENT",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            ),
            "Accept": "*/*",
            "Connection": "close",
        }

    def _fetch_remote_playlist(self, source_url: str) -> str:
        try:
            with self._urlopen(source_url) as response:
                text = response.read().decode("utf-8")
                if not text or "#EXTM3U" not in text:
                    raise InvalidPlaylistError("Playlist invalida")
                return text
        except urllib.error.HTTPError as exc:
            if exc.code >= 500:
                raise StreamOfflineError("Stream offline") from exc
            raise InvalidPlaylistError("Playlist invalida") from exc
        except urllib.error.URLError as exc:
            raise StreamOfflineError("Stream offline") from exc
        except (TimeoutError, socket.timeout) as exc:
            raise SegmentTimeoutError("Timeout de segmento") from exc

    def _is_direct_media_url(self, source_url: str) -> bool:
        path = urllib.parse.urlsplit(source_url).path.lower()
        if path.endswith((".m3u", ".m3u8")):
            return False
        if path.endswith((".ts", ".mp4", ".mkv", ".avi", ".mov", ".webm")):
            return True
        return "/live/" in path or "/movie/" in path or "/series/" in path

    def _resolve_media_playlist(self, source_url: str, max_hops: int = 5) -> Tuple[str, str]:
        current_url = source_url
        for _ in range(max_hops):
            playlist_text = self._fetch_remote_playlist(current_url)
            media_url = self.select_playlist_entry(playlist_text, current_url)
            if media_url is None:
                return current_url, playlist_text
            current_url = media_url
        raise InvalidPlaylistError("Playlist invalida: redirecionamentos em excesso")

    def select_playlist_entry(self, playlist_text: str, source_url: str) -> Optional[str]:
        entries = parse_playlist_entries(playlist_text, source_url)
        if not entries:
            return None
        hls_entries = [entry for entry in entries if entry.get("type") in {"variant", "playlist"}]
        media_segments = [
            line.strip()
            for line in playlist_text.splitlines()
            if line.strip() and not line.strip().startswith("#") and ".m3u8" not in urllib.parse.urlsplit(line.strip()).path.lower()
        ]
        if hls_entries and not media_segments:
            return min(hls_entries, key=lambda entry: int(entry.get("bandwidth") or 0))["url"]
        return None

    def _parse_playlist(self, playlist_text: str, source_url: str) -> ParsedPlaylist:
        lines = [line.strip() for line in playlist_text.splitlines() if line.strip()]
        if not lines or not lines[0].startswith("#EXTM3U"):
            raise InvalidPlaylistError("Playlist invalida: cabecalho ausente")

        segments: List[Segment] = []
        current_duration = None
        target_duration = 0.0
        next_sequence = 0
        endlist = False

        for line in lines[1:]:
            if line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
                next_sequence = int(line.split(":", 1)[1])
                continue
            if line.startswith("#EXT-X-TARGETDURATION:"):
                target_duration = float(line.split(":", 1)[1])
                continue
            if line.startswith("#EXT-X-ENDLIST"):
                endlist = True
                continue
            if line.startswith("#EXTINF:"):
                current_duration = float(line.split(":", 1)[1].split(",", 1)[0])
                continue
            if line.startswith("#"):
                continue

            url = urllib.parse.urljoin(source_url, line)
            duration = current_duration if current_duration is not None else 0.0
            segments.append(
                Segment(
                    url=url,
                    filename=self._segment_filename(url, next_sequence),
                    duration=duration,
                    sequence=next_sequence,
                )
            )
            next_sequence += 1
            current_duration = None

        if not segments:
            raise InvalidPlaylistError("Playlist invalida: nenhum segmento encontrado")
        if target_duration <= 0:
            target_duration = max(segment.duration for segment in segments)
        return ParsedPlaylist(segments[0].sequence, target_duration, segments, endlist)

    def _segment_filename(self, url: str, sequence: int) -> str:
        parsed = urllib.parse.urlparse(url)
        basename = urllib.parse.unquote(Path(parsed.path).name) or "segment"
        safe_basename = re.sub(r"[^A-Za-z0-9._-]", "_", basename)
        digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:10]
        return f"{sequence}-{digest}-{safe_basename}"

    def _window_segments(self, segments: List[Segment]) -> List[Segment]:
        selected: List[Segment] = []
        total_duration = 0.0
        for segment in reversed(segments):
            selected.append(segment)
            total_duration += segment.duration
            if total_duration >= self.buffer_seconds:
                break
        return list(reversed(selected))

    def _ensure_segments(self, state: StreamState, segments: List[Segment]) -> None:
        for segment in segments:
            if state.stop_event.is_set():
                return
            target = state.cache_dir / segment.filename
            if target.exists():
                continue
            self._download_segment(segment, target)

    def _all_segments_cached(self, state: StreamState, segments: List[Segment]) -> bool:
        return all((state.cache_dir / segment.filename).exists() for segment in segments)

    def _download_segment(self, segment: Segment, target: Path) -> None:
        temp_path = target.with_name(f"{target.name}.{threading.get_ident()}.part")
        try:
            with self._urlopen(segment.url) as response:
                with open(temp_path, "wb") as handle:
                    while True:
                        chunk = response.read(1024 * 64)
                        if not chunk:
                            break
                        handle.write(chunk)
            with self._cache_lock:
                os.replace(temp_path, target)
        except urllib.error.HTTPError as exc:
            if exc.code >= 500:
                raise StreamOfflineError("Stream offline") from exc
            raise InvalidPlaylistError("Playlist invalida") from exc
        except urllib.error.URLError as exc:
            raise StreamOfflineError("Stream offline") from exc
        except (TimeoutError, socket.timeout) as exc:
            raise SegmentTimeoutError("Timeout de segmento") from exc
        finally:
            if temp_path.exists():
                temp_path.unlink()

    def _write_playlist_file(self, state: StreamState, parsed: ParsedPlaylist, segments: List[Segment]) -> None:
        if not segments:
            raise InvalidPlaylistError("Playlist invalida: janela vazia")

        lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            f"#EXT-X-TARGETDURATION:{int(max(1, parsed.target_duration))}",
            f"#EXT-X-MEDIA-SEQUENCE:{segments[0].sequence}",
        ]
        for segment in segments:
            lines.append(f"#EXTINF:{segment.duration:.1f},")
            lines.append(segment.filename)
        if parsed.endlist:
            lines.append("#EXT-X-ENDLIST")

        temp_path = state.playlist_path.with_name("playlist.m3u8.part")
        with self._cache_lock:
            temp_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            os.replace(temp_path, state.playlist_path)

    def _prune_unlisted_segments(self, state: StreamState, keep_files: Set[str]) -> None:
        keep_files = set(keep_files)
        keep_files.add("playlist.m3u8")
        with self._cache_lock:
            for path in state.cache_dir.iterdir():
                if path.name in keep_files or path.name.endswith(".part"):
                    continue
                try:
                    path.unlink()
                except FileNotFoundError:
                    continue

    def _enforce_cache_size(self, state: StreamState, keep_files: Set[str]) -> None:
        with self._cache_lock:
            files = [path for path in state.cache_dir.iterdir() if path.is_file() and not path.name.endswith(".part")]
            total_size = sum(path.stat().st_size for path in files if path.exists())
            if total_size <= self.max_cache_bytes:
                return

            removable = sorted(
                [path for path in files if path.name not in keep_files and path.name != "playlist.m3u8"],
                key=lambda path: path.stat().st_mtime,
            )
            for path in removable:
                if total_size <= self.max_cache_bytes:
                    break
                try:
                    size = path.stat().st_size
                    path.unlink()
                    total_size -= size
                except FileNotFoundError:
                    continue


def parse_extinf_attributes(line: str) -> Dict[str, str]:
    attrs = {}
    for key, value in EXTINF_ATTR_RE.findall(line):
        attrs[key.lower()] = value.strip()
    return attrs


def classify_playlist_category(title: str, group: str, url: str) -> str:
    value = f"{title} {group} {url}".lower()
    movie_tokens = ("filme", "filmes", "movie", "movies", "vod", "/movie/")
    series_tokens = ("serie", "series", "série", "séries", "/series/")
    tv_tokens = ("tv", "canal", "canais", "channel", "live", "/live/")

    if any(token in value for token in movie_tokens):
        return "movies"
    if any(token in value for token in series_tokens):
        return "series"
    if any(token in value for token in tv_tokens):
        return "tv"
    return "tv"


def classify_media_kind(url: str, fallback_type: str) -> str:
    value = url.lower()
    path = value.split("?", 1)[0]
    if path.endswith((".m3u", ".m3u8")) or fallback_type in {"variant", "playlist"}:
        return "hls"
    if path.endswith(".ts") or "/live/" in path:
        return "mpegts"
    if path.endswith((".mp4", ".m4v", ".mov", ".webm")) or "/movie/" in path:
        return "native"
    return "native"


def parse_playlist_entries(playlist_text: str, source_url: str = "") -> List[Dict[str, str]]:
    line_iter = (line.strip() for line in playlist_text.splitlines())
    first_line = next((line for line in line_iter if line), "")
    if not first_line.startswith("#EXTM3U"):
        raise InvalidPlaylistError("Playlist invalida")

    entries: List[Dict[str, str]] = []
    pending_title: Optional[str] = None
    pending_bandwidth: Optional[str] = None
    pending_resolution: Optional[str] = None
    pending_logo: Optional[str] = None
    pending_group: Optional[str] = None

    for line in line_iter:
        if not line:
            continue
        if line.startswith("#EXTINF:"):
            attrs = parse_extinf_attributes(line)
            pending_title = line.split(",", 1)[1].strip() if "," in line else "Sem titulo"
            pending_title = attrs.get("tvg-name") or pending_title
            pending_bandwidth = None
            pending_resolution = None
            pending_logo = attrs.get("tvg-logo") or ""
            pending_group = attrs.get("group-title") or ""
            continue
        if line.startswith("#EXT-X-STREAM-INF:"):
            pending_title = "Variante HLS"
            bandwidth_match = re.search(r"\bBANDWIDTH=(\d+)", line)
            resolution_match = re.search(r"\bRESOLUTION=([^,]+)", line)
            pending_bandwidth = bandwidth_match.group(1) if bandwidth_match else None
            pending_resolution = resolution_match.group(1) if resolution_match else None
            pending_logo = ""
            pending_group = ""
            continue
        if line.startswith("#"):
            continue

        url = urllib.parse.urljoin(source_url, line) if source_url else line
        path = line.lower().split("?", 1)[0]
        entry_type = "variant" if pending_bandwidth else "playlist" if path.endswith(".m3u8") else "stream"
        title = pending_title or url.rsplit("/", 1)[-1].split("?", 1)[0] or url
        group = pending_group or "Sem grupo"
        entries.append(
            {
                "title": title,
                "url": url,
                "type": entry_type,
                "bandwidth": pending_bandwidth or "",
                "resolution": pending_resolution or "",
                "logo": pending_logo or "",
                "group": group,
                "category": classify_playlist_category(title, group, url),
                "media_kind": classify_media_kind(url, entry_type),
            }
        )
        pending_title = None
        pending_bandwidth = None
        pending_resolution = None
        pending_logo = None
        pending_group = None

    return entries

import json
import hashlib
import mimetypes
import os
import socket
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from backend.stream_service import (
    InvalidPlaylistError,
    SegmentTimeoutError,
    StreamBufferingService,
    StreamConfigurationError,
    StreamOfflineError,
    parse_playlist_entries,
)


PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"
DEFAULT_PRELOADED_PLAYLIST_PATH = PROJECT_ROOT / "data" / "preloaded_playlist.m3u"


def _normalize_search_value(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", str(value).casefold())
    return "".join(char for char in normalized if not unicodedata.combining(char))


def _playback_mode() -> str:
    mode = os.getenv("STREAM_PLAYBACK_MODE", "auto").strip().lower()
    if mode not in {"auto", "direct", "proxy"}:
        return "auto"
    return mode


def _playlist_id(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _origin_headers() -> Dict[str, str]:
    return {
        "User-Agent": os.getenv(
            "STREAM_USER_AGENT",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        ),
        "Accept": "*/*",
        "Connection": "close",
    }


def _env_enabled(name: str, default: bool = True) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _stream_ref(stream_id: str) -> str:
    return hashlib.sha256(stream_id.encode("utf-8")).hexdigest()[:12] if stream_id else ""


def _format_bytes(value: int) -> str:
    if not value:
        return "0 MB"
    return f"{value / 1024 / 1024:.1f} MB"


class AppRequestHandler(BaseHTTPRequestHandler):
    server_version = "StreamM3U8App/1.0"

    def do_GET(self):
        if self.path == "/api/config":
            self._handle_config()
            return
        if self.path == "/api/playlist/cache-default/status":
            self._handle_cache_default_status()
            return
        if self.path.startswith("/proxy/"):
            self._handle_proxy()
            return
        if self.path.startswith("/media-proxy/"):
            self._handle_media_proxy()
            return
        self._serve_static()

    def do_POST(self):
        if self.path in {"/stream/start", "/api/stream/start"}:
            self._handle_start()
            return
        if self.path in {"/stream/stop", "/api/stream/stop"}:
            self._handle_stop()
            return
        if self.path == "/api/events/content-request":
            self._handle_content_request_event()
            return
        if self.path in {"/playlist/parse", "/api/playlist/parse"}:
            self._handle_playlist_parse()
            return
        if self.path == "/api/playlist/preloaded":
            self._handle_preloaded_playlist()
            return
        if self.path == "/api/playlist/cache-default":
            self._handle_cache_default_playlist()
            return
        self._send_json_error(404, "Rota nao encontrada")

    def _handle_start(self) -> None:
        try:
            payload = self._read_json()
            stream_id = (payload.get("stream_id") or payload.get("url") or "").strip()
            if not stream_id:
                raise ValueError("stream_id e obrigatorio")
            self._log_access(
                "stream_start",
                title=payload.get("title") or "",
                group=payload.get("group") or "",
                category=payload.get("category") or "",
                media_kind=payload.get("media_kind") or "",
                stream_ref=_stream_ref(stream_id),
            )
            response = self.server.service.start_stream(stream_id, self._base_url())
            self._send_json(200, response)
        except StreamConfigurationError as exc:
            self._send_json_error(503, str(exc))
        except (InvalidPlaylistError, ValueError) as exc:
            self._send_json_error(400, str(exc))
        except StreamOfflineError:
            self._send_json_error(503, "Stream offline")
        except SegmentTimeoutError:
            self._send_json_error(504, "Timeout de segmento")
        except Exception as exc:
            self._send_json_error(500, str(exc))

    def _handle_config(self) -> None:
        self._send_json(200, {"playback_mode": _playback_mode()})

    def _handle_stop(self) -> None:
        try:
            payload = self._read_json()
            stream_id = (payload.get("stream_id") or payload.get("url") or "").strip()
            if not stream_id:
                raise ValueError("stream_id e obrigatorio")
            self._log_access("stream_stop", stream_ref=_stream_ref(stream_id))
            self._send_json(200, self.server.service.stop_stream(stream_id))
        except ValueError as exc:
            self._send_json_error(400, str(exc))

    def _handle_content_request_event(self) -> None:
        payload = self._read_json()
        stream_id = (payload.get("stream_id") or payload.get("url") or "").strip()
        self._log_access(
            "content_request",
            content=payload.get("title") or "Link direto",
            title=payload.get("title") or "Link direto",
            group=payload.get("group") or "",
            category=payload.get("category") or "",
            media_kind=payload.get("media_kind") or "",
            playback_mode=payload.get("playback_mode") or "",
            stream_ref=_stream_ref(stream_id),
        )
        self._send_json(200, {"status": "logged"})

    def _handle_playlist_parse(self) -> None:
        try:
            payload = self._read_json()
            playlist_text = payload.get("text") or ""
            source_url = (payload.get("url") or "").strip()

            if source_url and not playlist_text:
                self._log_access("playlist_load_url", playlist_url=source_url)
                playlist_id = self._playlist_id(source_url)
                if playlist_id not in self.server.playlist_cache:
                    playlist_text = self._fetch_text(source_url)
                    self.server.set_playlist_entries(
                        playlist_id,
                        parse_playlist_entries(playlist_text, source_url),
                    )
                    self.server.warm_search_index_async(playlist_id)
            elif playlist_text:
                self._log_access("playlist_load_text", chars=len(playlist_text))
                playlist_id = self._playlist_id(playlist_text)
                if playlist_id not in self.server.playlist_cache:
                    self.server.set_playlist_entries(
                        playlist_id,
                        parse_playlist_entries(playlist_text, source_url),
                    )
                    self.server.warm_search_index_async(playlist_id)
            else:
                playlist_id = payload.get("playlist_id") or ""

            if not playlist_id or playlist_id not in self.server.playlist_cache:
                raise ValueError("Informe uma URL, conteudo da playlist ou playlist_id valido")

            response = self._playlist_response(
                self.server.playlist_cache[playlist_id],
                playlist_id,
                category=payload.get("category") or "all",
                group=payload.get("group") or "",
                query=payload.get("query") or "",
                offset=int(payload.get("offset") or 0),
                limit=min(int(payload.get("limit") or 200), 500),
            )
            self._send_json(200, response)
        except (InvalidPlaylistError, ValueError) as exc:
            self._send_json_error(400, str(exc))
        except urllib.error.HTTPError as exc:
            self._send_json_error(exc.code, f"Nao foi possivel carregar a playlist (HTTP {exc.code})")
        except (urllib.error.URLError, TimeoutError, socket.timeout):
            self._send_json_error(503, "Nao foi possivel carregar a playlist")

    def _handle_preloaded_playlist(self) -> None:
        try:
            payload = self._read_json()
            self._log_access(
                "playlist_load_saved",
                category=payload.get("category") or "all",
                group=payload.get("group") or "",
                query=payload.get("query") or "",
                offset=int(payload.get("offset") or 0),
            )
            load_status = self.server.start_preloaded_load(self._load_preloaded_playlist)
            if load_status["status"] == "loading":
                self._send_json(202, self._loading_playlist_response(load_status))
                return
            if load_status["status"] == "error":
                raise ValueError(load_status.get("error") or "Nao foi possivel carregar a playlist salva.")

            playlist_id = load_status["playlist_id"]
            response = self._playlist_response(
                self.server.playlist_cache[playlist_id],
                playlist_id,
                category=payload.get("category") or "all",
                group=payload.get("group") or "",
                query=payload.get("query") or "",
                offset=int(payload.get("offset") or 0),
                limit=min(int(payload.get("limit") or 200), 500),
            )
            self._send_json(200, response)
        except (InvalidPlaylistError, ValueError) as exc:
            self._send_json_error(400, str(exc))

    def _loading_playlist_response(self, load_status: Dict) -> Dict:
        return {
            "status": "loading",
            "message": load_status.get("message") or "Carregando playlist salva...",
            "playlist_id": "",
            "entries": [],
            "total": 0,
            "offset": 0,
            "limit": 0,
            "has_more": False,
            "counts": {},
            "groups": [],
        }

    def _handle_cache_default_playlist(self) -> None:
        try:
            payload = self._read_json()
            playlist_url = payload.get("url") or os.getenv("PLAYLIST_CACHE_URL") or os.getenv("PLAYLIST_URL") or ""
            playlist_url = playlist_url.strip()
            if not playlist_url:
                raise ValueError("Configure PLAYLIST_CACHE_URL no arquivo .env para baixar a playlist em cache.")

            self._log_access("playlist_cache_start", playlist_url=playlist_url)
            started = self.server.start_playlist_cache_job(playlist_url, self.server.cache_preloaded_playlist)
            self._send_json(202 if started else 200, self.server.cache_job_snapshot())
        except ValueError as exc:
            self._send_json_error(400, str(exc))

    def _handle_cache_default_status(self) -> None:
        self._send_json(200, self.server.cache_job_snapshot())

    def _handle_proxy(self) -> None:
        path = urllib.parse.urlsplit(self.path).path
        parts = [part for part in path.split("/") if part]
        if len(parts) < 3 or parts[0] != "proxy":
            self._send_json_error(404, "Rota nao encontrada")
            return

        stream_id = urllib.parse.unquote(parts[1])
        filename = urllib.parse.unquote(parts[2])
        try:
            target = (
                self.server.service.get_playlist_path(stream_id)
                if filename == "playlist.m3u8"
                else self.server.service.ensure_segment_path(stream_id, filename)
            )
        except SegmentTimeoutError:
            self._send_json_error(504, "Timeout de segmento")
            return
        except StreamOfflineError:
            self._send_json_error(503, "Stream offline")
            return

        if target is None or not target.exists():
            self._send_json_error(404, "Segmento ou playlist ainda nao disponivel")
            return

        self.server.service.attach_client(stream_id)
        self.send_response(200)
        if filename == "playlist.m3u8":
            self.send_header("Content-Type", "application/vnd.apple.mpegurl")
            self.send_header("Cache-Control", "no-store")
        else:
            self.send_header("Content-Type", "video/mp2t")
            self.send_header("Cache-Control", "public, max-age=60")
        self.send_header("Content-Length", str(target.stat().st_size))
        self.end_headers()
        self.server.service.stream_cached_file(target, self.wfile)

    def _handle_media_proxy(self) -> None:
        path = urllib.parse.urlsplit(self.path).path
        parts = [part for part in path.split("/") if part]
        if len(parts) < 2 or parts[0] != "media-proxy":
            self._send_json_error(404, "Rota nao encontrada")
            return

        source_url = urllib.parse.unquote(parts[1])
        headers = self._origin_headers()
        headers["User-Agent"] = self.headers.get("User-Agent", headers["User-Agent"])
        if self.headers.get("Range"):
            headers["Range"] = self.headers["Range"]

        try:
            req = urllib.request.Request(source_url, headers=headers)
            with urllib.request.urlopen(req, timeout=self.server.service.download_timeout) as response:
                self.send_response(response.getcode())
                content_type = response.headers.get("Content-Type") or self._guess_media_type(source_url)
                self.send_header("Content-Type", content_type)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Accept-Ranges", response.headers.get("Accept-Ranges", "bytes"))
                for header in ("Content-Length", "Content-Range"):
                    value = response.headers.get(header)
                    if value:
                        self.send_header(header, value)
                self.end_headers()
                while True:
                    chunk = response.read(1024 * 64)
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        break
        except urllib.error.HTTPError as exc:
            self._send_json_error(exc.code, "Nao foi possivel carregar a midia")
        except (urllib.error.URLError, TimeoutError):
            self._send_json_error(503, "Nao foi possivel carregar a midia")

    def _serve_static(self) -> None:
        raw_path = urllib.parse.urlsplit(self.path).path
        relative = raw_path.lstrip("/") or "index.html"
        if relative.startswith("api/"):
            self._send_json_error(404, "Rota nao encontrada")
            return

        target = (FRONTEND_DIR / relative).resolve()
        if not str(target).startswith(str(FRONTEND_DIR.resolve())) or not target.exists() or target.is_dir():
            target = FRONTEND_DIR / "index.html"

        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            return

    def _fetch_text(self, url: str) -> str:
        request = urllib.request.Request(url, headers=self._origin_headers())
        timeout = max(self.server.service.download_timeout, float(os.getenv("PLAYLIST_FETCH_TIMEOUT", "45")))
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read()
            charset = response.headers.get_content_charset() or "utf-8"
            try:
                return body.decode(charset)
            except UnicodeDecodeError:
                return body.decode("latin-1")

    def _cache_preloaded_playlist(self, url: str, progress=None) -> Tuple[str, int, int]:
        return self.server.cache_preloaded_playlist(url, progress=progress)

    def _read_playlist_text(self, path: Path) -> str:
        body = path.read_bytes()
        try:
            return body.decode("utf-8")
        except UnicodeDecodeError:
            return body.decode("latin-1")

    def _write_parsed_playlist_cache(self, path: Path, entries: List[Dict[str, str]]) -> None:
        parsed_path = path.with_suffix(path.suffix + ".entries.json")
        with tempfile.NamedTemporaryFile("w", delete=False, dir=path.parent, encoding="utf-8") as temp_file:
            parsed_temp_path = Path(temp_file.name)
            json.dump(entries, temp_file, ensure_ascii=False, separators=(",", ":"))
        parsed_temp_path.replace(parsed_path)

    def _load_preloaded_playlist(self) -> str:
        path = Path(os.getenv("PRELOADED_PLAYLIST_PATH", str(DEFAULT_PRELOADED_PLAYLIST_PATH)))
        if not path.exists():
            raise ValueError("Playlist pre-carregada nao encontrada. Baixe para data/preloaded_playlist.m3u.")

        stat = path.stat()
        playlist_id = self._playlist_id(f"preloaded:{path.resolve()}:{stat.st_mtime_ns}:{stat.st_size}")
        if playlist_id not in self.server.playlist_cache:
            parsed_path = path.with_suffix(path.suffix + ".entries.json")
            if parsed_path.exists():
                entries = json.loads(parsed_path.read_text(encoding="utf-8"))
            else:
                playlist_text = self._read_playlist_text(path)
                entries = parse_playlist_entries(playlist_text)
                self._write_parsed_playlist_cache(path, entries)
            self.server.set_playlist_entries(playlist_id, entries, clear=True)
        return playlist_id

    def _playlist_id(self, value: str) -> str:
        return _playlist_id(value)

    def _playlist_response(
        self,
        entries: List[Dict[str, str]],
        playlist_id: str,
        category: str,
        group: str,
        query: str,
        offset: int,
        limit: int,
    ) -> Dict:
        query = _normalize_search_value(query.strip())
        search_index = self.server.search_index_for(playlist_id, entries) if query else []
        metadata = self.server.metadata_for(playlist_id, entries)
        page = []
        total = 0
        page_start = max(offset, 0)
        page_end = page_start + limit

        for index, entry in enumerate(entries):
            entry_category = entry.get("category") or "other"
            if category != "all" and entry_category != category:
                continue
            if group and entry.get("group") != group:
                continue
            if query and query not in search_index[index]:
                continue

            if page_start <= total < page_end:
                page.append(entry)
            total += 1

        return {
            "playlist_id": playlist_id,
            "entries": page,
            "total": total,
            "offset": offset,
            "limit": limit,
            "has_more": offset + limit < total,
            "counts": metadata["counts"],
            "groups": metadata["groups"],
        }

    def _origin_headers(self) -> Dict[str, str]:
        return _origin_headers()

    def _guess_media_type(self, url: str) -> str:
        path = urllib.parse.urlsplit(url).path.lower()
        if path.endswith(".ts") or "/live/" in path:
            return "video/mp2t"
        if path.endswith(".mp4") or "/movie/" in path:
            return "video/mp4"
        return "application/octet-stream"

    def _read_json(self) -> Dict[str, str]:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length == 0:
            return {}
        return json.loads(self.rfile.read(content_length).decode("utf-8"))

    def _base_url(self) -> str:
        public_base_url = os.getenv("STREAM_PUBLIC_BASE_URL")
        if public_base_url:
            return public_base_url.rstrip("/")

        host = self.headers.get("Host")
        if host:
            forwarded_proto = (self.headers.get("X-Forwarded-Proto") or "").split(",", 1)[0].strip()
            proto = forwarded_proto or ("https" if host.endswith(".trycloudflare.com") else "http")
            return f"{proto}://{host}"

        bound_host, bound_port = self.server.server_address
        return f"http://{bound_host}:{bound_port}"

    def _client_ip(self) -> str:
        forwarded_for = self.headers.get("CF-Connecting-IP") or self.headers.get("X-Forwarded-For") or ""
        if forwarded_for:
            return forwarded_for.split(",", 1)[0].strip()
        return self.client_address[0]

    def _log_access(self, action: str, **details) -> None:
        payload = {
            "event": action,
            "client_ip": self._client_ip(),
            "host": self.headers.get("Host", ""),
            "user_agent": self.headers.get("User-Agent", ""),
            **details,
        }
        print(f"ACCESS {json.dumps(payload, ensure_ascii=False)}", flush=True)

    def _send_json(self, status_code: int, payload: Dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            return

    def _send_json_error(self, status_code: int, message: str) -> None:
        self._send_json(status_code, {"error": message})

    def log_message(self, format, *args):
        return


class StreamApplicationServer(ThreadingHTTPServer):
    def __init__(self, server_address, handler_cls, service: Optional[StreamBufferingService] = None):
        super().__init__(server_address, handler_cls)
        self.service = service or StreamBufferingService()
        self.playlist_cache: Dict[str, List[Dict[str, str]]] = {}
        self.playlist_search_index: Dict[str, List[str]] = {}
        self.playlist_metadata_cache: Dict[str, Dict] = {}
        self.playlist_index_lock = threading.Lock()
        self.cache_job_lock = threading.Lock()
        self.cache_job = self._empty_cache_job()
        self.cache_log_state = {"phase": "", "downloaded_bytes": -1}
        self.preloaded_load_lock = threading.Lock()
        self.preloaded_load_status = {
            "status": "idle",
            "message": "Playlist salva ainda nao carregada.",
            "playlist_id": "",
            "error": "",
        }

    def set_playlist_entries(self, playlist_id: str, entries: List[Dict[str, str]], clear: bool = False) -> None:
        with self.playlist_index_lock:
            if clear:
                self.playlist_cache.clear()
                self.playlist_search_index.clear()
                self.playlist_metadata_cache.clear()
            self.playlist_cache[playlist_id] = entries
            self.playlist_search_index.pop(playlist_id, None)
            self.playlist_metadata_cache[playlist_id] = self._build_metadata(entries)

    def search_index_for(self, playlist_id: str, entries: List[Dict[str, str]]) -> List[str]:
        with self.playlist_index_lock:
            cached = self.playlist_search_index.get(playlist_id)
            if cached is not None and len(cached) == len(entries):
                return cached

        index = self._build_search_index(entries)
        with self.playlist_index_lock:
            current_entries = self.playlist_cache.get(playlist_id)
            if current_entries is not entries:
                return index
            self.playlist_search_index[playlist_id] = index
        return index

    def metadata_for(self, playlist_id: str, entries: List[Dict[str, str]]) -> Dict:
        with self.playlist_index_lock:
            cached = self.playlist_metadata_cache.get(playlist_id)
            if cached is not None:
                return cached

            metadata = self._build_metadata(entries)
            self.playlist_metadata_cache[playlist_id] = metadata
            return metadata

    def _build_search_index(self, entries: List[Dict[str, str]]) -> List[str]:
        return [
            _normalize_search_value(
                f"{entry.get('title', '')} {entry.get('group', '')} {entry.get('url', '')}"
            )
            for entry in entries
        ]

    def _warm_search_index(self, playlist_id: str, entries: List[Dict[str, str]]) -> None:
        index = self._build_search_index(entries)
        with self.playlist_index_lock:
            current_entries = self.playlist_cache.get(playlist_id)
            if current_entries is entries:
                self.playlist_search_index[playlist_id] = index

    def warm_search_index_async(self, playlist_id: str) -> None:
        with self.playlist_index_lock:
            entries = self.playlist_cache.get(playlist_id)
            cached = self.playlist_search_index.get(playlist_id)
            if entries is None or (cached is not None and len(cached) == len(entries)):
                return
        threading.Thread(target=self._warm_search_index, args=(playlist_id, entries), daemon=True).start()

    def _build_metadata(self, entries: List[Dict[str, str]]) -> Dict:
        counts = {"tv": 0, "movies": 0, "series": 0, "other": 0}
        groups = set()
        for entry in entries:
            entry_category = entry.get("category") or "other"
            counts[entry_category] = counts.get(entry_category, 0) + 1
            if entry.get("group"):
                groups.add(entry["group"])
        return {"counts": counts, "groups": sorted(groups)}

    def cache_preloaded_playlist(self, url: str, progress=None) -> Tuple[str, int, int]:
        path = Path(os.getenv("PRELOADED_PLAYLIST_PATH", str(DEFAULT_PRELOADED_PLAYLIST_PATH)))
        path.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(url, headers=_origin_headers())
        timeout = max(self.service.download_timeout, float(os.getenv("PLAYLIST_FETCH_TIMEOUT", "90")))

        total_bytes = 0
        temp_path = None
        parsed_temp_path = None
        download_completed = False
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                content_length = int(response.headers.get("Content-Length") or 0)
                if progress:
                    progress(
                        phase="downloading",
                        message="Baixando playlist...",
                        total_bytes=content_length,
                        downloaded_bytes=0,
                    )
                with tempfile.NamedTemporaryFile("wb", delete=False, dir=path.parent) as temp_file:
                    temp_path = Path(temp_file.name)
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        temp_file.write(chunk)
                        total_bytes += len(chunk)
                        if progress:
                            progress(downloaded_bytes=total_bytes)
            download_completed = True
        finally:
            if temp_path and temp_path.exists() and not download_completed:
                temp_path.unlink()

        if progress:
            progress(
                phase="parsing",
                message="Download concluido. Processando playlist...",
                downloaded_bytes=total_bytes,
                total_bytes=total_bytes,
            )

        temp_path.replace(path)
        temp_path = None
        playlist_text = self._read_playlist_text(path)
        entries = parse_playlist_entries(playlist_text, url)

        parsed_path = path.with_suffix(path.suffix + ".entries.json")
        try:
            with tempfile.NamedTemporaryFile("w", delete=False, dir=path.parent, encoding="utf-8") as temp_file:
                parsed_temp_path = Path(temp_file.name)
                json.dump(entries, temp_file, ensure_ascii=False, separators=(",", ":"))
            parsed_temp_path.replace(parsed_path)
            parsed_temp_path = None
        finally:
            if parsed_temp_path and parsed_temp_path.exists():
                parsed_temp_path.unlink()

        if not path.exists():
            path.write_text(playlist_text, encoding="utf-8")
        playlist_id = _playlist_id(f"preloaded:{path.resolve()}:{hashlib.sha256(playlist_text.encode('utf-8')).hexdigest()}")
        self.set_playlist_entries(playlist_id, entries, clear=True)
        with self.preloaded_load_lock:
            self.preloaded_load_status = {
                "status": "done",
                "message": "Playlist carregada.",
                "playlist_id": playlist_id,
                "error": "",
            }
        return playlist_id, total_bytes, len(entries)

    def prepare_search_index(self, playlist_id: str) -> None:
        entries = self.playlist_cache.get(playlist_id)
        if entries is not None:
            self.search_index_for(playlist_id, entries)

    def _read_playlist_text(self, path: Path) -> str:
        body = path.read_bytes()
        try:
            return body.decode("utf-8")
        except UnicodeDecodeError:
            return body.decode("latin-1")

    def start_preloaded_load(self, loader) -> Dict:
        with self.preloaded_load_lock:
            status = dict(self.preloaded_load_status)
            playlist_id = status.get("playlist_id") or ""
            if status["status"] == "done" and playlist_id in self.playlist_cache:
                return status
            if status["status"] == "loading":
                return status

        cache_status = self.cache_job_snapshot()
        if cache_status.get("status") == "running":
            return {
                "status": "loading",
                "message": cache_status.get("message") or "Atualizando playlist salva...",
                "playlist_id": "",
                "error": "",
            }

        with self.preloaded_load_lock:
            self.preloaded_load_status = {
                "status": "loading",
                "message": "Carregando playlist salva...",
                "playlist_id": "",
                "error": "",
            }

        threading.Thread(target=self._load_preloaded_background, args=(loader,), daemon=True).start()
        with self.preloaded_load_lock:
            return dict(self.preloaded_load_status)

    def _load_preloaded_background(self, loader) -> None:
        try:
            playlist_id = loader()
            with self.preloaded_load_lock:
                self.preloaded_load_status["message"] = "Preparando busca da playlist..."
            entries = self.playlist_cache.get(playlist_id)
            if entries is not None:
                self.search_index_for(playlist_id, entries)
            with self.preloaded_load_lock:
                self.preloaded_load_status = {
                    "status": "done",
                    "message": "Playlist carregada.",
                    "playlist_id": playlist_id,
                    "error": "",
                }
        except Exception as exc:
            with self.preloaded_load_lock:
                self.preloaded_load_status = {
                    "status": "error",
                    "message": "Nao foi possivel carregar a playlist salva.",
                    "playlist_id": "",
                    "error": str(exc),
                }

    def _empty_cache_job(self) -> Dict:
        return {
            "status": "idle",
            "phase": "",
            "message": "Nenhum cache em andamento.",
            "downloaded_bytes": 0,
            "total_bytes": 0,
            "entry_count": 0,
            "error": "",
            "started_at": 0,
            "updated_at": 0,
        }

    def cache_job_snapshot(self) -> Dict:
        with self.cache_job_lock:
            return dict(self.cache_job)

    def _update_cache_job(self, **updates) -> None:
        with self.cache_job_lock:
            self.cache_job.update(updates)
            self.cache_job["updated_at"] = time.time()
            snapshot = dict(self.cache_job)
        self._log_cache_progress(snapshot)

    def _log_cache_progress(self, snapshot: Dict) -> None:
        phase = snapshot.get("phase") or ""
        downloaded = int(snapshot.get("downloaded_bytes") or 0)
        total = int(snapshot.get("total_bytes") or 0)
        previous_phase = self.cache_log_state.get("phase")
        previous_downloaded = int(self.cache_log_state.get("downloaded_bytes") or 0)
        should_log = phase != previous_phase or downloaded == 0
        should_log = should_log or downloaded - previous_downloaded >= 25 * 1024 * 1024
        should_log = should_log or snapshot.get("status") in {"done", "error"}
        if not should_log:
            return

        self.cache_log_state = {"phase": phase, "downloaded_bytes": downloaded}
        payload = {
            "event": "playlist_cache_progress",
            "status": snapshot.get("status") or "",
            "phase": phase,
            "message": snapshot.get("message") or "",
            "downloaded": _format_bytes(downloaded),
            "total": _format_bytes(total),
            "entry_count": snapshot.get("entry_count") or 0,
            "error": snapshot.get("error") or "",
        }
        print(f"ACCESS {json.dumps(payload, ensure_ascii=False)}", flush=True)

    def start_playlist_cache_job(self, url: str, cache_func) -> bool:
        with self.cache_job_lock:
            if self.cache_job.get("status") == "running":
                return False
            now = time.time()
            self.cache_job = {
                "status": "running",
                "phase": "starting",
                "message": "Preparando download da playlist...",
                "downloaded_bytes": 0,
                "total_bytes": 0,
                "entry_count": 0,
                "error": "",
                "started_at": now,
                "updated_at": now,
            }

        thread = threading.Thread(target=self._run_playlist_cache_job, args=(url, cache_func), daemon=True)
        thread.start()
        return True

    def start_playlist_auto_refresh(self) -> None:
        playlist_url = (os.getenv("PLAYLIST_CACHE_URL") or os.getenv("PLAYLIST_URL") or "").strip()
        if not playlist_url:
            print("Playlist auto refresh disabled: PLAYLIST_CACHE_URL is not configured.", flush=True)
            return

        interval_seconds = float(os.getenv("PLAYLIST_REFRESH_INTERVAL_SECONDS", str(12 * 60 * 60)))
        if interval_seconds <= 0:
            print("Playlist auto refresh disabled by configuration.", flush=True)
            return

        def refresh_loop() -> None:
            while True:
                time.sleep(interval_seconds)
                print("Starting scheduled playlist refresh.", flush=True)
                self._start_scheduled_playlist_refresh(playlist_url)

        thread = threading.Thread(target=refresh_loop, daemon=True)
        thread.start()

    def _start_scheduled_playlist_refresh(self, playlist_url: str) -> None:
        started = self.start_playlist_cache_job(playlist_url, self.cache_preloaded_playlist)
        if not started:
            print("Skipping scheduled playlist refresh: another cache job is running.", flush=True)

    def run_startup_playlist_refresh(self) -> None:
        playlist_url = (os.getenv("PLAYLIST_CACHE_URL") or os.getenv("PLAYLIST_URL") or "").strip()
        if not playlist_url or not _env_enabled("PLAYLIST_REFRESH_ON_STARTUP", True):
            return

        print("Starting blocking playlist refresh on startup.", flush=True)
        with self.cache_job_lock:
            now = time.time()
            self.cache_job = {
                "status": "running",
                "phase": "starting",
                "message": "Preparando download da playlist...",
                "downloaded_bytes": 0,
                "total_bytes": 0,
                "entry_count": 0,
                "error": "",
                "started_at": now,
                "updated_at": now,
            }

        try:
            playlist_id, total_bytes, entry_count = self.cache_preloaded_playlist(
                playlist_url,
                progress=self._update_cache_job,
            )
            self._update_cache_job(
                phase="indexing",
                message="Preparando busca da playlist...",
                downloaded_bytes=total_bytes,
                total_bytes=total_bytes,
                entry_count=entry_count,
            )
            self.prepare_search_index(playlist_id)
            self._update_cache_job(
                status="done",
                phase="done",
                message="Playlist cacheada com sucesso.",
                downloaded_bytes=total_bytes,
                total_bytes=total_bytes,
                entry_count=entry_count,
                error="",
            )
            print("Playlist refresh completed before serving HTTP.", flush=True)
        except Exception as exc:
            self._update_cache_job(
                status="error",
                phase="error",
                message=f"Nao foi possivel cachear a playlist: {exc}",
                error=str(exc),
            )
            if _env_enabled("PLAYLIST_REFRESH_REQUIRED_ON_STARTUP", True):
                raise
            print(f"Playlist refresh failed on startup: {exc}", flush=True)

    def _run_playlist_cache_job(self, url: str, cache_func) -> None:
        try:
            playlist_id, total_bytes, entry_count = cache_func(url, progress=self._update_cache_job)
            self._update_cache_job(
                phase="indexing",
                message="Preparando busca da playlist...",
                downloaded_bytes=total_bytes,
                total_bytes=total_bytes,
                entry_count=entry_count,
            )
            self.prepare_search_index(playlist_id)
            self._update_cache_job(
                status="done",
                phase="done",
                message="Playlist cacheada com sucesso.",
                downloaded_bytes=total_bytes,
                total_bytes=total_bytes,
                entry_count=entry_count,
                error="",
            )
        except urllib.error.HTTPError as exc:
            self._update_cache_job(
                status="error",
                phase="error",
                message=f"Nao foi possivel baixar a playlist (HTTP {exc.code}).",
                error=f"HTTP {exc.code}",
            )
        except (InvalidPlaylistError, urllib.error.URLError, TimeoutError, socket.timeout, OSError, ValueError) as exc:
            self._update_cache_job(
                status="error",
                phase="error",
                message=f"Nao foi possivel cachear a playlist: {exc}",
                error=str(exc),
            )


def create_server(host: str = "0.0.0.0", port: int = 8000, service: Optional[StreamBufferingService] = None):
    return StreamApplicationServer((host, port), AppRequestHandler, service)


def _load_dotenv() -> None:
    env_path = PROJECT_ROOT / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _get_lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return ""


def _is_running_in_docker() -> bool:
    return Path("/.dockerenv").exists()


def _access_urls(host: str, port: int) -> List[str]:
    public_base_url = os.getenv("STREAM_PUBLIC_BASE_URL", "").strip()
    if public_base_url:
        return [public_base_url.rstrip("/")]

    if host in {"0.0.0.0", "::", ""}:
        lan_ip = _computer_ip()
        urls = [f"Local: http://localhost:{port}"]
        if lan_ip and not lan_ip.startswith("127."):
            urls.append(f"Wi-Fi: http://{lan_ip}:{port}")
        return urls
    return [f"http://{host}:{port}"]


def _computer_ip() -> str:
    configured_ip = (
        os.getenv("HOST_LAN_IP")
        or os.getenv("WIFI_HOST_IP")
        or os.getenv("LAN_HOST_IP")
        or ""
    ).strip()
    if configured_ip:
        return configured_ip
    if _is_running_in_docker():
        return ""
    return _get_lan_ip()


def run_server() -> None:
    _load_dotenv()
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    service = StreamBufferingService(
        buffer_seconds=int(os.getenv("STREAM_BUFFER_SECONDS", "120")),
        download_timeout=float(os.getenv("STREAM_DOWNLOAD_TIMEOUT", "10")),
        poll_interval=float(os.getenv("STREAM_POLL_INTERVAL", "0.5")),
        max_cache_bytes=int(os.getenv("STREAM_MAX_CACHE_BYTES", str(200 * 1024 * 1024))),
    )
    server = create_server(host=host, port=port, service=service)
    server.run_startup_playlist_refresh()
    print("Serving frontend and API:")
    for url in _access_urls(host, port):
        print(f"- {url}")
    computer_ip = _computer_ip()
    if computer_ip:
        print(f"IP do PC: {computer_ip}")
    server.start_playlist_auto_refresh()
    server.serve_forever()


if __name__ == "__main__":
    run_server()

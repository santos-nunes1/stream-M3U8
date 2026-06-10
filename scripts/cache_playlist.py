import os
import sys
import tempfile
import hmac
import hashlib
import json
import pickle
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.stream_service import parse_playlist_entries_from_lines
from backend.app import PLAYLIST_CATALOG_CACHE_VERSION, PlaylistCatalog


DEFAULT_OUTPUT = Path(__file__).resolve().parent.parent / "data" / "preloaded_playlist.m3u"
DEV_AUTH_TOKEN_SECRET = "stream-m3u8-dev-secret-change-me"


def auth_token_secret() -> str:
    return os.getenv("AUTH_TOKEN_SECRET", "").strip() or DEV_AUTH_TOKEN_SECRET


def write_pickle_signature(path: Path) -> None:
    digest = hmac.new(auth_token_secret().encode("utf-8"), digestmod=hashlib.sha256)
    with path.open("rb") as file:
        while True:
            chunk = file.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    path.with_suffix(path.suffix + ".sig").write_text(digest.hexdigest(), encoding="utf-8")


def main() -> int:
    playlist_url = os.getenv("PLAYLIST_CACHE_URL") or os.getenv("PLAYLIST_URL")

    output = Path(os.getenv("PRELOADED_PLAYLIST_PATH", str(DEFAULT_OUTPUT)))
    output.parent.mkdir(parents=True, exist_ok=True)

    if playlist_url:
        request = urllib.request.Request(
            playlist_url,
            headers={
                "User-Agent": os.getenv(
                    "STREAM_USER_AGENT",
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
                ),
                "Accept": "*/*",
                "Connection": "close",
            },
        )
        timeout = float(os.getenv("PLAYLIST_FETCH_TIMEOUT", "90"))

        digest = hashlib.sha256()
        with urllib.request.urlopen(request, timeout=timeout) as response:
            with tempfile.NamedTemporaryFile("wb", delete=False, dir=output.parent) as temp_file:
                temp_path = Path(temp_file.name)
                total = 0
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    temp_file.write(chunk)
                    digest.update(chunk)
                    total += len(chunk)
                    if total % (25 * 1024 * 1024) < len(chunk):
                        print(f"Downloaded {total / 1024 / 1024:.1f} MB", flush=True)
        temp_path.replace(output)
    elif output.exists():
        total = output.stat().st_size
        digest = hashlib.sha256()
        with output.open("rb") as file:
            while True:
                chunk = file.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
    else:
        print("Set PLAYLIST_CACHE_URL/PLAYLIST_URL or create data/preloaded_playlist.m3u first.", file=sys.stderr)
        return 2

    def progress(**updates) -> None:
        entry_count = int(updates.get("entry_count") or 0)
        if entry_count:
            print(updates.get("message") or f"Parsed {entry_count} entries", flush=True)

    try:
        with output.open("r", encoding="utf-8") as playlist_file:
            entries = parse_playlist_entries_from_lines(playlist_file, playlist_url or str(output), progress=progress)
    except UnicodeDecodeError:
        with output.open("r", encoding="latin-1") as playlist_file:
            entries = parse_playlist_entries_from_lines(playlist_file, playlist_url or str(output), progress=progress)

    parsed_output = output.with_suffix(output.suffix + ".entries.json")
    parsed_pickle_output = output.with_suffix(output.suffix + ".entries.pickle")
    parsed_catalog_output = output.with_suffix(output.suffix + ".catalog.pickle")
    parsed_cache_max_bytes = int(os.getenv("PLAYLIST_PARSED_CACHE_MAX_BYTES", str(50 * 1024 * 1024)))

    with tempfile.NamedTemporaryFile("wb", delete=False, dir=output.parent) as temp_file:
        parsed_temp_path = Path(temp_file.name)
        pickle.dump(entries, temp_file, protocol=pickle.HIGHEST_PROTOCOL)
    parsed_temp_path.replace(parsed_pickle_output)
    write_pickle_signature(parsed_pickle_output)

    if total <= parsed_cache_max_bytes:
        with tempfile.NamedTemporaryFile("w", delete=False, dir=output.parent, encoding="utf-8") as temp_file:
            parsed_temp_path = Path(temp_file.name)
            json.dump(entries, temp_file, ensure_ascii=False, separators=(",", ":"))
        parsed_temp_path.replace(parsed_output)

    print("Building search catalog...", flush=True)
    catalog = PlaylistCatalog(entries, build_series_index=True)
    with tempfile.NamedTemporaryFile("wb", delete=False, dir=output.parent) as temp_file:
        parsed_temp_path = Path(temp_file.name)
        pickle.dump(catalog, temp_file, protocol=pickle.HIGHEST_PROTOCOL)
    parsed_temp_path.replace(parsed_catalog_output)
    write_pickle_signature(parsed_catalog_output)
    parsed_catalog_output.with_suffix(parsed_catalog_output.suffix + ".version").write_text(
        str(PLAYLIST_CATALOG_CACHE_VERSION),
        encoding="utf-8",
    )

    output.with_suffix(output.suffix + ".sha256").write_text(digest.hexdigest(), encoding="utf-8")

    print(f"Cached playlist at {output} ({total} bytes)")
    print(f"Cached parsed entries at {parsed_pickle_output} ({len(entries)} entries)")
    print(f"Cached parsed catalog at {parsed_catalog_output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

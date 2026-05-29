import os
import sys
import tempfile
import json
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.stream_service import parse_playlist_entries


DEFAULT_OUTPUT = Path(__file__).resolve().parent.parent / "data" / "preloaded_playlist.m3u"


def main() -> int:
    playlist_url = os.getenv("PLAYLIST_URL")

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

        with urllib.request.urlopen(request, timeout=timeout) as response:
            with tempfile.NamedTemporaryFile("wb", delete=False, dir=output.parent) as temp_file:
                temp_path = Path(temp_file.name)
                total = 0
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    temp_file.write(chunk)
                    total += len(chunk)
        temp_path.replace(output)
    elif output.exists():
        total = output.stat().st_size
    else:
        print("Set PLAYLIST_URL or create data/preloaded_playlist.m3u first.", file=sys.stderr)
        return 2

    entries = parse_playlist_entries(output.read_text(encoding="utf-8", errors="replace"))
    parsed_output = output.with_suffix(output.suffix + ".entries.json")
    with tempfile.NamedTemporaryFile("w", delete=False, dir=output.parent, encoding="utf-8") as temp_file:
        parsed_temp_path = Path(temp_file.name)
        json.dump(entries, temp_file, ensure_ascii=False, separators=(",", ":"))
    parsed_temp_path.replace(parsed_output)

    print(f"Cached playlist at {output} ({total} bytes)")
    print(f"Cached parsed entries at {parsed_output} ({len(entries)} entries)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

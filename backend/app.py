import json
import base64
import hashlib
import hmac
import ipaddress
import mimetypes
import os
import pickle
import random
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from functools import lru_cache
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple
from uuid import uuid4

from backend.stream_service import (
    InvalidPlaylistError,
    SegmentTimeoutError,
    StreamBufferingService,
    StreamConfigurationError,
    StreamOfflineError,
    extract_series_metadata,
    parse_playlist_entries,
    parse_playlist_entries_from_lines,
)


PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"
DEFAULT_PRELOADED_PLAYLIST_PATH = PROJECT_ROOT / "data" / "preloaded_playlist.m3u"
SEARCH_TOKEN_RE = re.compile(r"[a-z0-9]+")
PLAYLIST_CATALOG_CACHE_VERSION = 14
SEARCH_PREFIX_MIN_LENGTH = 2
SEARCH_PREFIX_MAX_LENGTH = 8
ADMIN_USER_ID = "__admin__"
ADMIN_USER_EMAIL = "admin@stream.local"
ADMIN_MAX_SCREENS = 999999
DEV_AUTH_TOKEN_SECRET = "stream-m3u8-dev-secret-change-me"
MAX_JSON_BODY_BYTES = int(os.getenv("MAX_JSON_BODY_BYTES", str(512 * 1024)))
MAX_PLAYLIST_TEXT_BYTES = int(os.getenv("MAX_PLAYLIST_TEXT_BYTES", str(25 * 1024 * 1024)))
MAX_REMOTE_PLAYLIST_BYTES = int(os.getenv("MAX_REMOTE_PLAYLIST_BYTES", str(250 * 1024 * 1024)))
PRIVATE_HOSTNAMES = {"localhost", "localhost.localdomain"}
ADULT_KEYWORDS = {
    "adult",
    "adulto",
    "adults",
    "xxx",
    "sex",
    "sexo",
    "porn",
    "porno",
    "pornografia",
    "erotic",
    "erotico",
    "erotica",
    "18+",
    "hot",
    "onlyfans",
    "playboy",
}


def _normalize_search_value(value: str) -> str:
    value = str(value).casefold()
    if value.isascii():
        return value
    normalized = unicodedata.normalize("NFKD", value)
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


def _headers_for_source_url(url: str) -> Dict[str, str]:
    headers = _origin_headers()
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme and parsed.netloc:
        origin = f"{parsed.scheme}://{parsed.netloc}"
        headers.setdefault("Origin", origin)
        headers.setdefault("Referer", origin + "/")
    return headers


def _is_private_address(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return True
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _validate_public_fetch_url(url: str) -> str:
    value = str(url or "").strip()
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("URL de midia invalida")
    hostname = parsed.hostname.strip().lower()
    if hostname in PRIVATE_HOSTNAMES:
        raise ValueError("URL interna nao permitida")
    if _env_enabled("STREAM_ALLOW_PRIVATE_SOURCE_URLS", False):
        return value
    try:
        for family, _, _, _, sockaddr in socket.getaddrinfo(hostname, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM):
            address = sockaddr[0]
            if _is_private_address(address):
                raise ValueError("URL interna nao permitida")
    except socket.gaierror as exc:
        raise ValueError("Host da URL nao foi resolvido") from exc
    return value


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


def _intersect_sorted(left: List[int], right: List[int]) -> List[int]:
    result = []
    left_index = 0
    right_index = 0
    while left_index < len(left) and right_index < len(right):
        left_value = left[left_index]
        right_value = right[right_index]
        if left_value == right_value:
            result.append(left_value)
            left_index += 1
            right_index += 1
        elif left_value < right_value:
            left_index += 1
        else:
            right_index += 1
    return result


POPULAR_SERIES_ALIASES = [
    ("Round 6 (Squid Game)", ("round 6", "squid game")),
    ("Stranger Things", ("stranger things",)),
    ("Game of Thrones", ("game of thrones",)),
    ("Wandinha (Wednesday)", ("wandinha", "wednesday")),
    ("Breaking Bad", ("breaking bad",)),
    ("Friends", ("friends",)),
    ("The Big Bang Theory", ("the big bang theory", "big bang theory", "big bag a teoria", "big bang a teoria")),
    ("Grey's Anatomy", ("grey s anatomy", "greys anatomy", "grey anatomy")),
    ("The Boys", ("the boys",)),
    ("A Familia Soprano (The Sopranos)", ("a familia soprano", "familia soprano", "the sopranos", "sopranos")),
    ("La Casa de Papel", ("la casa de papel", "money heist")),
    ("Better Call Saul", ("better call saul",)),
    ("The Walking Dead", ("the walking dead", "walking dead")),
    ("Modern Family", ("modern family",)),
    ("The Office", ("the office",)),
    ("Black Mirror", ("black mirror",)),
    ("Lost", ("lost",)),
    ("O Agente Noturno", ("o agente noturno", "the night agent", "agente noturno")),
    ("Bridgerton", ("bridgerton",)),
    ("Peaky Blinders", ("peaky blinders",)),
]


class PlaylistCatalog:
    def __init__(self, entries: List[Dict[str, str]], build_series_index: bool = False) -> None:
        self.entries = entries
        self.all_indices = list(range(len(entries)))
        self.search_index: List[str] = []
        self.metadata = {"counts": {"tv": 0, "movies": 0, "series": 0, "daily_games": 0, "other": 0}, "groups": []}
        self.indices_by_category: Dict[str, List[int]] = {}
        self.indices_by_group: Dict[str, List[int]] = {}
        self.daily_game_indices: List[int] = []
        self.token_index: Dict[str, List[int]] = {}
        self.token_prefix_index: Dict[str, List[int]] = {}
        self.query_cache: Dict[str, List[int]] = {}
        self.adult_indices: Set[int] = set()
        self.series_indices: Dict[str, List[int]] = {}
        self.series_summaries: Dict[str, Dict] = {}
        self.series_episode_index: Dict[str, Set[str]] = {}
        self.series_logo_keys: Dict[str, Set[str]] = {}
        self.popular_series_summary_cache: Dict[bool, List[Dict]] = {}
        self.global_groups_cache: Dict[bool, List[str]] = {}
        self.series_index_ready = build_series_index
        self.query_cache_lock = threading.Lock()
        self._build()
        if self.series_index_ready:
            self._popular_series_summaries(False, len(POPULAR_SERIES_ALIASES))

    def __getstate__(self) -> Dict:
        state = dict(self.__dict__)
        state["cache_version"] = PLAYLIST_CATALOG_CACHE_VERSION
        state["query_cache"] = {}
        state.pop("query_cache_lock", None)
        state.pop("_needs_cache_refresh", None)
        return state

    def __setstate__(self, state: Dict) -> None:
        cache_version = int(state.get("cache_version") or 0)
        self.__dict__.update(state)
        self.query_cache = {}
        self._needs_cache_refresh = cache_version < PLAYLIST_CATALOG_CACHE_VERSION
        if "adult_indices" not in self.__dict__:
            self.adult_indices = {index for index, entry in enumerate(self.entries) if _is_adult_entry(entry)}
        if "daily_game_indices" not in self.__dict__:
            self.daily_game_indices = [
                index for index, entry in enumerate(self.entries) if _is_daily_game_entry(entry)
            ]
        if "daily_games" not in self.metadata.get("counts", {}):
            self.metadata.setdefault("counts", {})["daily_games"] = len(self.daily_game_indices)
        if "series_indices" not in self.__dict__ or "series_summaries" not in self.__dict__:
            self.series_indices = {}
            self.series_summaries = {}
            self.series_episode_index = {}
            self.series_index_ready = False
        elif "series_index_ready" not in self.__dict__:
            self.series_index_ready = True
        if "series_episode_index" not in self.__dict__:
            self.series_episode_index = {}
        if "series_logo_keys" not in self.__dict__:
            self.series_logo_keys = {}
        if cache_version < PLAYLIST_CATALOG_CACHE_VERSION or "popular_series_summary_cache" not in self.__dict__:
            self.popular_series_summary_cache = {}
        if "global_groups_cache" not in self.__dict__:
            self.global_groups_cache = {}
        if "token_prefix_index" not in self.__dict__:
            self.token_prefix_index = {}
            self._needs_cache_refresh = True
        self.query_cache_lock = threading.Lock()

    def _ensure_series_index(self) -> None:
        if self.series_index_ready:
            return
        self.series_indices = {}
        self.series_summaries = {}
        self.series_episode_index = {}
        self.series_logo_keys = {}
        self.popular_series_summary_cache = {}
        for index, entry in enumerate(self.entries):
            if (entry.get("category") or "other") == "series":
                self._index_series_entry(index, entry)
        self.series_index_ready = True
        self._popular_series_summaries(False, len(POPULAR_SERIES_ALIASES))

    def _build(self) -> None:
        groups = set()

        for index, entry in enumerate(self.entries):
            category = entry.get("category") or "other"
            group = entry.get("group") or ""
            title = entry.get("title", "")
            searchable = _normalize_search_value(f"{title} {group}")
            self.metadata["counts"][category] = self.metadata["counts"].get(category, 0) + 1
            self.indices_by_category.setdefault(category, []).append(index)
            if any(
                keyword in searchable
                for keyword in (
                    "jogos do dia",
                    "jogo do dia",
                    "jogos de hoje",
                    "jogo de hoje",
                )
            ):
                self.daily_game_indices.append(index)
                self.metadata["counts"]["daily_games"] = self.metadata["counts"].get("daily_games", 0) + 1
            adult_text = _normalize_search_value(f"{searchable} {category} {entry.get('url', '')}")
            adult_tokens = set(SEARCH_TOKEN_RE.findall(adult_text))
            if bool(adult_tokens.intersection(ADULT_KEYWORDS)) or "18+" in adult_text or any(
                keyword in adult_text for keyword in ADULT_KEYWORDS if len(keyword) > 3
            ):
                self.adult_indices.add(index)
            if category == "series" and self.series_index_ready:
                self._index_series_entry(index, entry)
            if group:
                groups.add(group)
                self.indices_by_group.setdefault(group, []).append(index)

            self.search_index.append(searchable)
            entry_prefixes = set()
            for token in set(SEARCH_TOKEN_RE.findall(searchable)):
                self.token_index.setdefault(token, []).append(index)
                max_prefix_length = min(len(token), SEARCH_PREFIX_MAX_LENGTH)
                for prefix_length in range(SEARCH_PREFIX_MIN_LENGTH, max_prefix_length + 1):
                    prefix = token[:prefix_length]
                    if prefix in entry_prefixes:
                        continue
                    entry_prefixes.add(prefix)
                    self.token_prefix_index.setdefault(prefix, []).append(index)

        self.metadata["groups"] = sorted(groups)

    def _index_series_entry(self, index: int, entry: Dict[str, str]) -> None:
        if not entry.get("series_key") or not entry.get("series_title"):
            entry.update(extract_series_metadata(entry.get("title", ""), entry.get("group", ""), entry.get("url", "")))
        canonical_title = _canonical_series_title(entry.get("series_title") or entry.get("title") or "")
        if not canonical_title:
            return
        series_key = hashlib.sha256(canonical_title.encode("utf-8")).hexdigest()[:16]
        entry["series_key"] = series_key
        summary = self.series_summaries.setdefault(
            series_key,
            {
                "series_key": series_key,
                "title": _clean_series_display_title(entry.get("series_title") or entry.get("title") or "Serie"),
                "group": entry.get("group", ""),
                "groups": [],
                "logo": entry.get("logo", ""),
                "total_episodes": 0,
                "seasons": {},
            },
        )
        display_title = _clean_series_display_title(entry.get("series_title") or entry.get("title") or "")
        if display_title and len(display_title) < len(summary.get("title", "")):
            summary["title"] = display_title
        if entry.get("group") and entry.get("group") not in summary["groups"]:
            summary["groups"].append(entry.get("group"))
        if _series_logo_score(entry.get("logo", "")) > _series_logo_score(summary.get("logo", "")):
            summary["logo"] = entry.get("logo")
        normalized_logo = _normalize_logo_url(entry.get("logo", ""))
        if _series_logo_score(normalized_logo) > 0:
            self.series_logo_keys.setdefault(normalized_logo, set()).add(series_key)
        season = entry.get("season_number") or "0"
        self.series_indices.setdefault(series_key, []).append(index)
        episode_key = _series_episode_key(entry, index)
        is_new_episode = episode_key not in self.series_episode_index.setdefault(series_key, set())
        if is_new_episode:
            self.series_episode_index[series_key].add(episode_key)
            summary["total_episodes"] += 1
        season_summary = summary["seasons"].setdefault(season, {"season": season, "episode_count": 0})
        if is_new_episode:
            season_summary["episode_count"] += 1

    def response(
        self,
        playlist_id: str,
        category: str,
        group: str,
        query: str,
        offset: int,
        limit: int,
        series_key: str = "",
        season: str = "",
        include_adult: bool = False,
        allowed_terms: Optional[List[str]] = None,
        featured_sections: Optional[List[Dict]] = None,
        access_seed: str = "",
    ) -> Dict:
        query = _normalize_search_value(query.strip())
        if category == "series" or series_key:
            self._ensure_series_index()
        if series_key:
            indices = self.series_indices.get(series_key, [])
        else:
            indices = self._filtered_indices(category, group)
        if not include_adult and self.adult_indices:
            indices = [index for index in indices if index not in self.adult_indices]
        if query:
            query_indices = self._query_indices(query)
            if query_indices is None:
                indices = [index for index in indices if query in self.search_index[index]]
            else:
                indices = _intersect_sorted(indices, query_indices)

        allowed_indices = None
        if allowed_terms is not None:
            allowed_indices = self.allowed_indices(
                allowed_terms,
                featured_sections or [],
                include_adult=include_adult,
                seed=access_seed,
            )

        if category == "series" and not series_key:
            return self._series_group_response(playlist_id, indices, offset, limit, include_adult)
        if query and category == "all" and not series_key and indices and all(
            (self.entries[index].get("category") or "other") == "series" for index in indices
        ):
            self._ensure_series_index()
            return self._series_group_response(playlist_id, indices, offset, limit, include_adult)
        if series_key:
            if season:
                selected_season = _normalize_series_number(season)
                indices = [
                    index
                    for index in indices
                    if _normalize_series_number(self.entries[index].get("season_number") or "0") == selected_season
                ]
            indices = sorted(indices, key=self._series_episode_sort_key)

        series_groups_payload = []
        if query and category == "all" and not series_key:
            series_indices = [
                index
                for index in indices
                if (self.entries[index].get("category") or "other") == "series"
            ]
            if series_indices:
                self._ensure_series_index()
                series_response = self._series_group_response(
                    playlist_id,
                    series_indices,
                    0,
                    limit,
                    include_adult,
                )
                series_groups_payload = series_response.get("series_groups", [])

        total = len(indices)
        page_start = max(offset, 0)
        page_end = page_start + limit
        metadata = self.metadata if include_adult else self._metadata_for_indices(indices)
        return {
            "playlist_id": playlist_id,
            "entries": [self._public_entry(index, allowed_indices) for index in indices[page_start:page_end]],
            "series_groups": series_groups_payload,
            "total": total,
            "offset": offset,
            "limit": limit,
            "has_more": offset + limit < total,
            "counts": metadata["counts"],
            "groups": self._global_groups(include_adult),
        }

    def _series_episode_sort_key(self, index: int) -> Tuple[int, int, str]:
        entry = self.entries[index]
        try:
            season = int(entry.get("season_number") or 0)
        except (TypeError, ValueError):
            season = 0
        try:
            episode = int(entry.get("episode_number") or 0)
        except (TypeError, ValueError):
            episode = 0
        return (season, episode, _normalize_search_value(entry.get("title", "")))

    def _public_entry(self, index: int, allowed_indices: Optional[Set[int]] = None) -> Dict:
        entry = dict(self.entries[index])
        if allowed_indices is None or index in allowed_indices:
            entry["locked"] = False
            return entry
        entry["locked"] = True
        entry["url"] = ""
        entry["locked_reason"] = "Adquira um pacote para acessar este conteúdo"
        return entry

    def _is_first_series_episode(self, index: int) -> bool:
        entry = self.entries[index]
        if (entry.get("category") or "") != "series":
            return True
        season = _normalize_series_number(entry.get("season_number") or "1")
        episode = _normalize_series_number(entry.get("episode_number") or "1")
        return season in {"0", "1"} and episode in {"0", "1"}

    def _first_series_indices(self, indices: List[int]) -> List[int]:
        selected = []
        seen = set()
        for index in sorted(indices, key=self._series_episode_sort_key):
            entry = self.entries[index]
            key = entry.get("series_key") or _normalize_search_value(entry.get("series_title") or entry.get("title") or "")
            if not key or key in seen:
                continue
            selected.append(index)
            seen.add(key)
        return selected

    def _indices_for_featured_section(self, section: Dict, include_adult: bool = False, seed: str = "") -> List[int]:
        category = section.get("category") or "all"
        indices = list(self._filtered_indices(category, ""))
        if not include_adult and self.adult_indices:
            indices = [index for index in indices if index not in self.adult_indices]
        query = _normalize_search_value(section.get("query") or "")
        if query:
            query_indices = self._query_indices(query)
            if query_indices is None:
                indices = [index for index in indices if query in self.search_index[index]]
            else:
                indices = _intersect_sorted(indices, query_indices)
        terms = [_normalize_search_value(term) for term in section.get("terms", []) if _normalize_search_value(term)]
        if terms:
            indices = [
                index
                for index in indices
                if any(term in self.search_index[index] for term in terms)
            ]
        required_terms_any = [
            _normalize_search_value(term)
            for term in section.get("required_terms_any", [])
            if _normalize_search_value(term)
        ]
        if required_terms_any:
            indices = [index for index in indices if self._entry_has_any_required_term(index, required_terms_any)]
        excluded_terms_any = [
            _normalize_search_value(term)
            for term in section.get("excluded_terms_any", [])
            if _normalize_search_value(term)
        ]
        if excluded_terms_any:
            indices = [index for index in indices if not self._entry_has_any_required_term(index, excluded_terms_any)]
        if section.get("team_game_only"):
            indices = [index for index in indices if _is_team_game_entry(self.entries[index])]
        if section.get("prefer_national_teams"):
            national_indices = [index for index in indices if _is_national_team_game_entry(self.entries[index])]
            if national_indices:
                indices = national_indices
        if category == "series":
            indices = self._first_series_indices(indices)
        prefer_terms = [_normalize_search_value(term) for term in section.get("prefer_terms", []) if _normalize_search_value(term)]
        if prefer_terms:
            indices = sorted(indices, key=lambda index: self._featured_preference_score(index, prefer_terms), reverse=True)
        if section.get("random") and indices:
            picker = random.Random(f"{seed}:{section.get('id', '')}:{time.strftime('%Y-%m-%d')}")
            return [picker.choice(indices)]
        return indices[: int(section.get("limit") or 12)]

    def _featured_preference_score(self, index: int, prefer_terms: List[str]) -> int:
        entry = self.entries[index]
        haystack = _normalize_search_value(f"{entry.get('title', '')} {entry.get('group', '')} {entry.get('resolution', '')}")
        score = 0
        for position, term in enumerate(prefer_terms):
            if term in haystack:
                score += max(1, len(prefer_terms) - position)
        return score

    def _entry_has_any_required_term(self, index: int, required_terms: List[str]) -> bool:
        haystack = self.search_index[index]
        for term in required_terms:
            if len(term) <= 3:
                if re.search(rf"(^|[^a-z0-9]){re.escape(term)}([^a-z0-9]|$)", haystack):
                    return True
                continue
            if term in haystack:
                return True
        return False

    def _group_entries_by_terms(
        self,
        section: Dict,
        terms: List[str],
        include_adult: bool = False,
        seed: str = "",
        limit_per_group: int = 12,
    ) -> List[Dict]:
        groups = []
        for label in terms:
            normalized_term = _normalize_search_value(label)
            if not normalized_term:
                continue
            group_section = {
                **section,
                "terms": [label],
                "limit": limit_per_group,
                "random": False,
                "group_similar": False,
            }
            indices = self._indices_for_featured_section(group_section, include_adult=include_adult, seed=seed)
            grouped = [self._public_entry(index, set(indices)) for index in indices]
            if not grouped:
                continue
            groups.append(
                {
                    "id": normalized_term.replace(" ", "_"),
                    "title": label.upper() if len(label) <= 4 else label.title(),
                    "cover_url": next((entry.get("logo") for entry in grouped if entry.get("logo")), ""),
                    "entries": grouped,
                    "total": len(grouped),
                }
            )
        return groups

    def allowed_indices(
        self,
        allowed_terms: List[str],
        featured_sections: Optional[List[Dict]] = None,
        include_adult: bool = False,
        seed: str = "",
    ) -> Set[int]:
        normalized_allowed_terms = [_normalize_search_value(term) for term in (allowed_terms or []) if _normalize_search_value(term)]
        allowed = set()
        if normalized_allowed_terms:
            series_candidates = []
            for index in self.all_indices:
                if not include_adult and index in self.adult_indices:
                    continue
                if not any(term in self.search_index[index] for term in normalized_allowed_terms):
                    continue
                if (self.entries[index].get("category") or "") == "series":
                    series_candidates.append(index)
                    continue
                allowed.add(index)
            allowed.update(self._first_series_indices(series_candidates))
        for section in featured_sections or []:
            allowed.update(self._indices_for_featured_section(section, include_adult=include_adult, seed=seed))
        return allowed

    def _series_group_response(self, playlist_id: str, indices: List[int], offset: int, limit: int, include_adult: bool) -> Dict:
        if offset == 0 and self._looks_like_full_series_listing(indices):
            summaries = self._popular_series_summaries(include_adult, limit)
            if summaries:
                total = max(len(self.series_summaries), len(summaries))
                return {
                    "playlist_id": playlist_id,
                    "entries": [],
                    "series_groups": summaries,
                    "total": total,
                    "offset": offset,
                    "limit": limit,
                    "has_more": len(summaries) < total,
                    "counts": self.metadata["counts"],
                    "groups": self._global_groups(include_adult),
                }

        allowed = set(indices)
        summaries = []
        for series_key, series_indices in self.series_indices.items():
            visible_indices = [index for index in series_indices if index in allowed]
            if not visible_indices:
                continue
            summary = dict(self.series_summaries.get(series_key, {}))
            seasons = {}
            seen_episodes = set()
            best_logo = self._best_series_logo(series_indices, summary.get("logo", ""))
            for index in series_indices:
                if not include_adult and index in self.adult_indices:
                    continue
                entry = self.entries[index]
                season = entry.get("season_number") or "0"
                episode_key = _series_episode_key(entry, index)
                if episode_key in seen_episodes:
                    continue
                seen_episodes.add(episode_key)
                season_summary = seasons.setdefault(season, {"season": season, "episode_count": 0})
                season_summary["episode_count"] += 1
            summary["logo"] = best_logo
            summary["logo_candidates"] = self._series_logo_candidates(series_indices, best_logo)
            summary["total_episodes"] = len(seen_episodes)
            summary["seasons"] = sorted(seasons.values(), key=lambda item: int(item["season"] or 0))
            summaries.append(summary)

        summaries.sort(
            key=lambda item: (
                0 if item.get("logo") else 1,
                -int(item.get("total_episodes") or 0),
                _normalize_search_value(f"{item.get('title', '')} {item.get('group', '')}"),
            )
        )
        page_start = max(offset, 0)
        page_end = page_start + limit
        metadata = self.metadata if include_adult else self._metadata_for_indices(indices)
        return {
            "playlist_id": playlist_id,
            "entries": [],
            "series_groups": summaries[page_start:page_end],
            "total": len(summaries),
            "offset": offset,
            "limit": limit,
            "has_more": page_end < len(summaries),
            "counts": metadata["counts"],
            "groups": self._global_groups(include_adult),
        }

    def _looks_like_full_series_listing(self, indices: List[int]) -> bool:
        series_indices = self.indices_by_category.get("series", [])
        if not series_indices:
            return False
        if len(indices) == len(series_indices):
            return True
        if self.adult_indices and len(indices) >= len(series_indices) - len(self.adult_indices):
            return True
        return False

    def _popular_series_summaries(self, include_adult: bool, limit: int) -> List[Dict]:
        cached = self.popular_series_summary_cache.get(include_adult)
        if cached is not None:
            return [dict(item) for item in cached[:limit]]

        alias_rows = [
            (preferred_title, tuple(_normalize_search_value(alias) for alias in aliases))
            for preferred_title, aliases in POPULAR_SERIES_ALIASES
        ]
        best_by_title: Dict[str, Tuple[int, Dict]] = {}

        for series_key, summary in self.series_summaries.items():
            title = _normalize_search_value(summary.get("title", ""))
            haystack = _normalize_search_value(
                f"{summary.get('title', '')} {summary.get('group', '')} {' '.join(summary.get('groups', []))}"
            )
            matching_rows = []
            for preferred_title, normalized_aliases in alias_rows:
                matching_scores = [
                    _series_alias_candidate_score(alias, title, haystack)
                    for alias in normalized_aliases
                    if _series_alias_matches(alias, haystack)
                ]
                if matching_scores:
                    matching_rows.append((preferred_title, max(matching_scores)))
            if not matching_rows:
                continue
            if not include_adult and all(index in self.adult_indices for index in self.series_indices.get(series_key, [])):
                continue

            item = dict(summary)
            item["series_key"] = series_key
            item["logo"] = self._best_series_logo(self.series_indices.get(series_key, []), item.get("logo", ""))
            item["logo_candidates"] = self._series_logo_candidates(self.series_indices.get(series_key, []), item.get("logo", ""))
            item["seasons"] = sorted(
                item.get("seasons", {}).values(),
                key=lambda season: int(_normalize_series_number(season.get("season") or 0)),
            )
            for preferred_title, score in matching_rows:
                current = best_by_title.get(preferred_title)
                if current is None or score > current[0]:
                    best_by_title[preferred_title] = (score, item)

        summaries = []
        used_keys = set()
        for preferred_title, _aliases in POPULAR_SERIES_ALIASES:
            match = best_by_title.get(preferred_title, (0, None))[1]
            if not match or match["series_key"] in used_keys:
                continue
            used_keys.add(match["series_key"])
            item = dict(match)
            item["popular_title"] = preferred_title
            summaries.append(item)
        self.popular_series_summary_cache[include_adult] = [dict(item) for item in summaries]
        return [dict(item) for item in summaries[:limit]]

    def _find_popular_series_summary(self, aliases: Tuple[str, ...], include_adult: bool) -> Optional[Dict]:
        normalized_aliases = tuple(_normalize_search_value(alias) for alias in aliases)
        best_item = None
        best_score = -1
        for series_key, summary in self.series_summaries.items():
            title = _normalize_search_value(summary.get("title", ""))
            haystack = _normalize_search_value(
                f"{summary.get('title', '')} {summary.get('group', '')} {' '.join(summary.get('groups', []))}"
            )
            if not any(_series_alias_matches(alias, haystack) for alias in normalized_aliases):
                continue
            if not include_adult and all(index in self.adult_indices for index in self.series_indices.get(series_key, [])):
                continue
            score = max(_series_alias_candidate_score(alias, title, haystack) for alias in normalized_aliases)
            if score <= best_score:
                continue
            item = dict(summary)
            item["series_key"] = series_key
            item["logo"] = self._best_series_logo(self.series_indices.get(series_key, []), item.get("logo", ""))
            item["logo_candidates"] = self._series_logo_candidates(self.series_indices.get(series_key, []), item.get("logo", ""))
            item["seasons"] = sorted(
                item.get("seasons", {}).values(),
                key=lambda season: int(_normalize_series_number(season.get("season") or 0)),
            )
            best_item = item
            best_score = score
        return best_item

    def _best_series_logo(self, indices: List[int], fallback: str = "") -> str:
        best_logo = _normalize_logo_url(fallback or "")
        best_score = self._series_logo_effective_score(best_logo)
        for index in indices:
            logo = _normalize_logo_url(self.entries[index].get("logo", ""))
            score = self._series_logo_effective_score(logo)
            if score > best_score:
                best_logo = logo
                best_score = score
        return best_logo

    def _series_logo_candidates(self, indices: List[int], fallback: str = "", limit: int = 6) -> List[str]:
        logos = []
        seen = set()
        for logo in [fallback, *(self.entries[index].get("logo", "") for index in indices)]:
            normalized = _normalize_logo_url(logo)
            if not normalized or normalized in seen or _series_logo_score(normalized) <= 0:
                continue
            seen.add(normalized)
            logos.append(normalized)
        logos.sort(key=self._series_logo_effective_score, reverse=True)
        return logos[:limit]

    def _series_logo_effective_score(self, logo: str) -> int:
        score = _series_logo_score(logo)
        if score <= 0:
            return score
        usage_count = len(self.series_logo_keys.get(_normalize_logo_url(logo), set()))
        if usage_count > 1:
            score -= min(8, usage_count + 4)
        return score

    def _metadata_for_indices(self, indices: List[int]) -> Dict:
        counts = {"tv": 0, "movies": 0, "series": 0, "daily_games": 0, "other": 0}
        groups = set()
        for index in indices:
            entry = self.entries[index]
            category = entry.get("category") or "other"
            counts[category] = counts.get(category, 0) + 1
            if _is_daily_game_entry(entry):
                counts["daily_games"] = counts.get("daily_games", 0) + 1
            group = entry.get("group") or ""
            if group:
                groups.add(group)
        return {"counts": counts, "groups": sorted(groups)}

    def _global_groups(self, include_adult: bool) -> List[str]:
        cached = self.global_groups_cache.get(include_adult)
        if cached is not None:
            return cached
        groups = sorted(
            {
                self.entries[index].get("group") or ""
                for index in self.all_indices
                if index not in self.adult_indices
                and self.entries[index].get("group")
                and not _has_adult_marker(self.entries[index].get("group") or "")
            }
        )
        self.global_groups_cache[include_adult] = groups
        return groups

    def _filtered_indices(self, category: str, group: str) -> List[int]:
        if category == "daily_games":
            indices = self.daily_game_indices
        elif category == "world_cup":
            indices = [index for index in self.daily_game_indices if _is_national_team_game_entry(self.entries[index])]
        elif category == "reality":
            reality_terms = ("a casa do patrao", "casa do patrao")
            indices = [
                index
                for index in self.all_indices
                if (self.entries[index].get("category") or "other") != "series"
                and any(term in self.search_index[index] for term in reality_terms)
            ]
        else:
            indices = self.all_indices if category == "all" else self.indices_by_category.get(category, [])
        if group:
            group_indices = self.indices_by_group.get(group, [])
            indices = _intersect_sorted(indices, group_indices)
        return indices

    def featured_sections(
        self,
        playlist_id: str,
        sections: List[Dict],
        include_adult: bool = False,
        seed: str = "",
    ) -> Dict:
        payload_sections = []
        for section in sections:
            category = section.get("category") or "all"
            indices = self._indices_for_featured_section(section, include_adult=include_adult, seed=seed)
            entries = [self._public_entry(index, set(indices)) for index in indices]
            cover_url = next((entry.get("logo") for entry in entries if entry.get("logo")), "")
            groups = []
            if section.get("group_similar"):
                groups = self._group_entries_by_terms(
                    section,
                    section.get("group_terms") or section.get("terms") or [],
                    include_adult=include_adult,
                    seed=seed,
                    limit_per_group=int(section.get("limit_per_group") or 12),
                )
                if groups and not cover_url:
                    cover_url = next((group.get("cover_url") for group in groups if group.get("cover_url")), "")
            payload_sections.append(
                {
                    "id": section.get("id") or "",
                    "title": section.get("title") or "",
                    "description": section.get("description") or "",
                    "category": category,
                    "cover_url": cover_url,
                    "entries": entries,
                    "groups": groups,
                    "total": len(indices),
                }
            )
        return {"playlist_id": playlist_id, "sections": payload_sections}

    def _query_indices(self, query: str) -> Optional[List[int]]:
        with self.query_cache_lock:
            cached = self.query_cache.get(query)
            if cached is not None:
                return cached
            prefix_indices = self._cached_query_prefix(query)

        query_tokens = SEARCH_TOKEN_RE.findall(query)
        if not query_tokens:
            return None

        if prefix_indices is not None:
            final_result = [
                index
                for index in prefix_indices
                if self._entry_matches_query(index, query, query_tokens)
            ]
            self._remember_query_indices(query, final_result)
            return final_result

        result: Optional[List[int]] = None
        for query_token in query_tokens:
            current = self._indices_for_query_token(query_token)
            result = current if result is None else _intersect_sorted(result, current)
            if not result:
                break

        final_result = result or []
        if final_result and any(len(token) > SEARCH_PREFIX_MAX_LENGTH for token in query_tokens):
            final_result = [
                index for index in final_result if self._entry_matches_query(index, query, query_tokens)
            ]
        self._remember_query_indices(query, final_result)
        return final_result

    def _indices_for_query_token(self, query_token: str) -> List[int]:
        if len(query_token) >= SEARCH_PREFIX_MIN_LENGTH:
            prefix_matches = self.token_prefix_index.get(query_token[:SEARCH_PREFIX_MAX_LENGTH], [])
            if prefix_matches:
                return prefix_matches

        exact_matches = self.token_index.get(query_token)
        if exact_matches is not None:
            return exact_matches

        matched_indices: Set[int] = set()
        for token, indices in self.token_index.items():
            if query_token in token:
                matched_indices.update(indices)
        return sorted(matched_indices)

    def _cached_query_prefix(self, query: str) -> Optional[List[int]]:
        best_prefix = ""
        best_indices = None
        for cached_query, indices in self.query_cache.items():
            if cached_query and cached_query != query and query.startswith(cached_query):
                if len(cached_query) > len(best_prefix):
                    best_prefix = cached_query
                    best_indices = indices
        return best_indices

    def _entry_matches_query(self, index: int, query: str, query_tokens: List[str]) -> bool:
        searchable = self.search_index[index]
        return query in searchable or all(token in searchable for token in query_tokens)

    def _remember_query_indices(self, query: str, indices: List[int]) -> None:
        with self.query_cache_lock:
            if len(self.query_cache) > 200:
                self.query_cache.clear()
            self.query_cache[query] = indices


class AuthError(Exception):
    def __init__(self, message: str, status_code: int = 401) -> None:
        super().__init__(message)
        self.status_code = status_code


def _auth_db_path() -> Path:
    return Path(os.getenv("AUTH_DB_PATH", str(PROJECT_ROOT / "data" / "auth.sqlite3")))


def _auth_token_secret() -> str:
    secret = os.getenv("AUTH_TOKEN_SECRET", "").strip()
    if secret:
        return secret
    return DEV_AUTH_TOKEN_SECRET


def _validate_production_secrets() -> None:
    env_name = os.getenv("STREAM_ENV", os.getenv("APP_ENV", "")).strip().lower()
    production_mode = env_name in {"prod", "production"} or _env_enabled("REQUIRE_STRONG_SECRETS", False)
    if not production_mode:
        return
    auth_secret = os.getenv("AUTH_TOKEN_SECRET", "").strip()
    admin_token = os.getenv("AUTH_ADMIN_TOKEN", "").strip()
    if len(auth_secret) < 32 or auth_secret == DEV_AUTH_TOKEN_SECRET:
        raise RuntimeError("Configure AUTH_TOKEN_SECRET forte com pelo menos 32 caracteres antes de producao")
    if len(admin_token) < 24:
        raise RuntimeError("Configure AUTH_ADMIN_TOKEN forte antes de producao")


def _base64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _base64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def _json_token(payload: Dict) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    segments = [
        _base64url_encode(json.dumps(header, separators=(",", ":")).encode("utf-8")),
        _base64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8")),
    ]
    signing_input = ".".join(segments).encode("ascii")
    signature = hmac.new(_auth_token_secret().encode("utf-8"), signing_input, hashlib.sha256).digest()
    return ".".join([*segments, _base64url_encode(signature)])


def _verify_json_token(token: str) -> Dict:
    try:
        header_segment, payload_segment, signature_segment = token.split(".", 2)
        signing_input = f"{header_segment}.{payload_segment}".encode("ascii")
        expected = hmac.new(_auth_token_secret().encode("utf-8"), signing_input, hashlib.sha256).digest()
        actual = _base64url_decode(signature_segment)
        if not hmac.compare_digest(expected, actual):
            raise AuthError("Token invalido")
        payload = json.loads(_base64url_decode(payload_segment).decode("utf-8"))
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
        raise AuthError("Token invalido")
    if int(payload.get("exp") or 0) < int(time.time()):
        raise AuthError("Token expirado")
    return payload


def _password_hash(password: str) -> str:
    iterations = 200_000
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"pbkdf2_sha256${iterations}${_base64url_encode(salt)}${_base64url_encode(digest)}"


def _verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, iterations, salt, digest = stored_hash.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        expected = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            _base64url_decode(salt),
            int(iterations),
        )
        return hmac.compare_digest(_base64url_encode(expected), digest)
    except (ValueError, TypeError):
        return False


def _is_adult_entry(entry: Dict[str, str]) -> bool:
    text = _normalize_search_value(
        " ".join(
            [
                entry.get("title", ""),
                entry.get("group", ""),
                entry.get("category", ""),
                entry.get("url", ""),
            ]
        )
    )
    return _has_adult_marker(text)


def _has_adult_marker(text: str) -> bool:
    text = _normalize_search_value(text)
    tokens = set(SEARCH_TOKEN_RE.findall(text))
    return bool(tokens.intersection(ADULT_KEYWORDS)) or "18+" in text or any(
        keyword in text for keyword in ADULT_KEYWORDS if len(keyword) > 3
    )


def _normalized_catalog_terms(value) -> List[str]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            value = [value]
    if not isinstance(value, list):
        return []
    terms = []
    seen = set()
    for item in value:
        term = str(item or "").strip()
        normalized = _normalize_search_value(term)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        terms.append(term)
    return terms


def _normalized_catalog_featured_sections(value) -> List[Dict]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return []
    if not isinstance(value, list):
        return []
    sections = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            continue
        terms = _normalized_catalog_terms(item.get("terms") or item.get("catalog_allowed_terms") or [])
        query = str(item.get("query") or "").strip()
        title = str(item.get("title") or item.get("name") or f"Secao {index + 1}").strip()
        section = {
            "id": str(item.get("id") or _normalize_search_value(title) or f"section_{index + 1}"),
            "title": title,
            "description": str(item.get("description") or "").strip(),
            "category": str(item.get("category") or "all").strip() or "all",
            "query": query,
            "terms": terms,
            "required_terms_any": _normalized_catalog_terms(item.get("required_terms_any") or []),
            "excluded_terms_any": _normalized_catalog_terms(item.get("excluded_terms_any") or []),
            "prefer_terms": _normalized_catalog_terms(item.get("prefer_terms") or []),
            "group_similar": bool(item.get("group_similar")),
            "group_terms": _normalized_catalog_terms(item.get("group_terms") or []),
            "limit_per_group": max(min(int(item.get("limit_per_group") or 12), 40), 1),
            "team_game_only": bool(item.get("team_game_only")),
            "prefer_national_teams": bool(item.get("prefer_national_teams")),
            "limit": max(min(int(item.get("limit") or 12), 120), 1),
            "random": bool(item.get("random")),
        }
        sections.append(section)
    return sections


def _is_daily_game_entry(entry: Dict[str, str]) -> bool:
    text = _normalize_search_value(f"{entry.get('title', '')} {entry.get('group', '')}")
    return any(
        keyword in text
        for keyword in (
            "jogos do dia",
            "jogo do dia",
            "jogos de hoje",
            "jogo de hoje",
        )
    )


NATIONAL_TEAM_HINTS = {
    "alemanha", "africa do sul", "arabia saudita", "argelia", "argentina", "australia", "austria",
    "armenia", "azerbaijao", "belarus", "belgica", "bolivia", "bosnia", "bosnia e herzegovina", "brasil", "burkina faso", "cabo verde", "canada", "catar",
    "colombia", "coreia", "coreia do sul", "costa do marfim", "croacia", "curacao", "egito",
    "equador", "escocia", "espanha", "estados unidos", "eua", "franca", "gana", "haiti",
    "holanda", "hungria", "indonesia", "inglaterra", "ira", "iraque", "japao", "jordania",
    "cazaquistao", "kazakhstan", "marrocos", "mexico", "mocambique", "moldavia", "moldova",
    "noruega", "nova zelandia", "paises baixos", "panama", "paraguai", "portugal", "qatar",
    "rd congo", "republica democratica do congo", "republica tcheca", "san marino", "senegal",
    "suica", "suecia", "tchequia", "tunisia", "turquia", "uruguai", "uzbequistao",
}

CLUB_COMPETITION_HINTS = {
    "brasileirao", "serie a", "serie b", "libertadores", "sul americana", "champions", "premier league", "la liga",
    "bundesliga", "calcio", "mls", "nba", "ufc", "combate", "tenis", "volei", "clubes", "sub 20",
}


def _is_team_game_entry(entry: Dict[str, str]) -> bool:
    text = _normalize_search_value(f"{entry.get('title', '')} {entry.get('group', '')}")
    return bool(re.search(r"\b[\w ]{2,}\s+(?:x|vs|versus)\s+[\w ]{2,}\b", text))


def _is_national_team_game_entry(entry: Dict[str, str]) -> bool:
    text = _normalize_search_value(f"{entry.get('title', '')} {entry.get('group', '')}")
    if not _is_team_game_entry(entry):
        return False
    if any(hint in text for hint in CLUB_COMPETITION_HINTS):
        return False
    return any(team in text for team in NATIONAL_TEAM_HINTS) or any(
        hint in text
        for hint in ("amistoso", "selecao", "selecoes", "copa do mundo", "eliminatoria", "nations league", "euro", "conmebol", "concacaf")
    )


def _normalize_series_number(value) -> str:
    match = re.search(r"\d+", str(value or "0"))
    if not match:
        return "0"
    return str(int(match.group(0)))


@lru_cache(maxsize=50000)
def _canonical_series_title(value: str) -> str:
    value = _normalize_search_value(value)
    value = re.sub(r"\[[^\]]+\]|\([^)]+\)", " ", value)
    value = re.sub(r"\b(dual audio|audio dual|dublado|legendado|dub|leg|nacional|multi audio|hd|fhd|uhd|4k|1080p|720p|480p)\b", " ", value)
    value = re.sub(r"\b(hbo max|hbo|netflix|prime video|amazon prime|amazon|disney plus|disney|paramount plus|paramount|globoplay|max)\s*[a-z0-9]?\b", " ", value)
    value = re.sub(r"\b(series|serie|série|temporada|temp)\b", " ", value)
    value = re.sub(r"\b(?:s|t)\s*\d{1,2}\b.*$", " ", value)
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return " ".join(value.split())


@lru_cache(maxsize=50000)
def _clean_series_display_title(value: str) -> str:
    value = re.sub(r"\[[^\]]+\]|\([^)]+\)", " ", str(value or ""))
    value = re.sub(
        r"\b(HBO Max|HBO|Netflix|Prime Video|Amazon Prime|Amazon|Disney Plus|Disney|Paramount Plus|Paramount|Globoplay|Max)\s*[A-Z0-9]?\b",
        " ",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(r"\b(Dual Audio|Audio Dual|Dublado|Legendado|Dub|Leg|HD|FHD|UHD|4K|1080p|720p|480p)\b", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"\b(?:S|T)\s*\d{1,2}\b.*$", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"[\s._-]+", " ", value)
    return value.strip(" -._") or str(value or "Serie")


def _series_episode_key(entry: Dict[str, str], index: int) -> str:
    season = _normalize_series_number(entry.get("season_number") or "0")
    episode = _normalize_series_number(entry.get("episode_number") or "0")
    if season != "0" or episode != "0":
        return f"{season}:{episode}"
    title = _normalize_search_value(entry.get("title") or entry.get("url") or str(index))
    return f"raw:{title}:{index}"


def _series_alias_matches(alias: str, value: str) -> bool:
    if not alias:
        return False
    alias_tokens = SEARCH_TOKEN_RE.findall(alias)
    value_tokens = SEARCH_TOKEN_RE.findall(value)
    if not alias_tokens or not value_tokens:
        return False
    if len(alias_tokens) == 1:
        return alias_tokens[0] in value_tokens
    return " ".join(alias_tokens) in " ".join(value_tokens)


def _series_alias_candidate_score(alias: str, title: str, value: str) -> int:
    alias_tokens = SEARCH_TOKEN_RE.findall(alias)
    title_tokens = SEARCH_TOKEN_RE.findall(title)
    value_tokens = SEARCH_TOKEN_RE.findall(value)
    if not alias_tokens:
        return 0
    alias_phrase = " ".join(alias_tokens)
    title_phrase = " ".join(title_tokens)
    value_phrase = " ".join(value_tokens)
    if title_tokens == alias_tokens:
        return 1000
    if title_phrase.startswith(alias_phrase):
        return 700 - max(0, len(title_tokens) - len(alias_tokens))
    if alias_phrase in title_phrase:
        return 500 - max(0, len(title_tokens) - len(alias_tokens))
    if alias_phrase in value_phrase:
        return 250
    if all(token in value_tokens for token in alias_tokens):
        return 100
    return 0


def _normalize_logo_url(value: str) -> str:
    value = str(value or "").strip()
    if value.startswith("http://image.tmdb.org/"):
        return "https://image.tmdb.org/" + value[len("http://image.tmdb.org/") :]
    if value.startswith("https://image.tmdb.org//"):
        return "https://image.tmdb.org/" + value[len("https://image.tmdb.org//") :]
    return value


def _series_logo_score(value: str) -> int:
    if not value:
        return 0
    lowered = value.lower()
    if "timg.bdta.pro" in lowered or "gstaticontent.com" in lowered:
        return 0
    if any(token in lowered for token in ("placeholder", "default", "noimage", "no-image", "sem-logo", "blank", "1x1")):
        return 0
    score = 1
    if lowered.startswith(("http://", "https://")):
        score += 2
    if "image.tmdb.org" in lowered:
        score += 3
    if any(size in lowered for size in ("w600_and_h900", "w500", "w342")):
        score += 4
    if "/t/p/w1280/" in lowered:
        score -= 1
    if any(ext in lowered for ext in (".jpg", ".jpeg", ".png", ".webp")):
        score += 2
    score += 1
    return score


def _series_entry_score(entry: Dict[str, str]) -> int:
    score = _series_logo_score(entry.get("logo", ""))
    if entry.get("resolution"):
        score += 1
    if entry.get("media_kind"):
        score += 1
    if entry.get("group"):
        score += 1
    return score


class AuthStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self._init_db()

    def _connect(self):
        connection = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = NORMAL")
        return connection

    def _init_db(self) -> None:
        with self.lock, self._connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    access_hash TEXT NOT NULL UNIQUE,
                    access_expires_at REAL NOT NULL,
                    password_hash TEXT NOT NULL,
                    max_screens INTEGER NOT NULL DEFAULT 2,
                    allow_adult_content INTEGER NOT NULL DEFAULT 0,
                    catalog_access_mode TEXT NOT NULL DEFAULT 'full',
                    catalog_allowed_terms TEXT NOT NULL DEFAULT '[]',
                    catalog_featured_sections TEXT NOT NULL DEFAULT '[]',
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    device_id TEXT NOT NULL DEFAULT '',
                    device_name TEXT NOT NULL,
                    user_agent TEXT NOT NULL,
                    ip_address TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    last_heartbeat REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    revoked_at REAL,
                    FOREIGN KEY(user_id) REFERENCES users(id)
                );

                CREATE INDEX IF NOT EXISTS idx_sessions_user_active
                    ON sessions(user_id, revoked_at, last_heartbeat, expires_at);

                CREATE TABLE IF NOT EXISTS user_state (
                    user_id TEXT PRIMARY KEY,
                    favorites TEXT NOT NULL DEFAULT '[]',
                    watched_episodes TEXT NOT NULL DEFAULT '{}',
                    updated_at REAL NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(id)
                );

                CREATE TABLE IF NOT EXISTS access_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at REAL NOT NULL,
                    event TEXT NOT NULL,
                    user_id TEXT,
                    session_id TEXT,
                    client_ip TEXT,
                    host TEXT,
                    user_agent TEXT,
                    title TEXT,
                    category TEXT,
                    media_kind TEXT,
                    playback_mode TEXT,
                    details TEXT NOT NULL DEFAULT '{}'
                );

                CREATE INDEX IF NOT EXISTS idx_access_events_created
                    ON access_events(created_at);
                CREATE INDEX IF NOT EXISTS idx_access_events_event_created
                    ON access_events(event, created_at);
                """
            )
            columns = {row["name"] for row in db.execute("PRAGMA table_info(users)").fetchall()}
            if "access_hash" not in columns:
                db.execute("ALTER TABLE users ADD COLUMN access_hash TEXT")
            if "access_expires_at" not in columns:
                db.execute("ALTER TABLE users ADD COLUMN access_expires_at REAL")
            if "catalog_access_mode" not in columns:
                db.execute("ALTER TABLE users ADD COLUMN catalog_access_mode TEXT NOT NULL DEFAULT 'full'")
            if "catalog_allowed_terms" not in columns:
                db.execute("ALTER TABLE users ADD COLUMN catalog_allowed_terms TEXT NOT NULL DEFAULT '[]'")
            if "catalog_featured_sections" not in columns:
                db.execute("ALTER TABLE users ADD COLUMN catalog_featured_sections TEXT NOT NULL DEFAULT '[]'")
            session_columns = {row["name"] for row in db.execute("PRAGMA table_info(sessions)").fetchall()}
            if "device_id" not in session_columns:
                db.execute("ALTER TABLE sessions ADD COLUMN device_id TEXT NOT NULL DEFAULT ''")
            for row in db.execute("SELECT id FROM users WHERE access_hash IS NULL OR access_hash = ''").fetchall():
                db.execute("UPDATE users SET access_hash = ? WHERE id = ?", (self._new_access_hash(), row["id"]))
            default_access_days = self._default_access_days()
            for row in db.execute(
                "SELECT id, created_at FROM users WHERE access_expires_at IS NULL OR access_expires_at <= 0"
            ).fetchall():
                db.execute(
                    "UPDATE users SET access_expires_at = ? WHERE id = ?",
                    (float(row["created_at"] or time.time()) + default_access_days * 24 * 60 * 60, row["id"]),
                )
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_access_hash ON users(access_hash)")

    def create_user(
        self,
        email: str,
        name: str,
        max_screens: int,
        allow_adult_content: bool,
        access_expires_in_days: int,
        catalog_access_mode: str = "full",
        catalog_allowed_terms: Optional[List[str]] = None,
        catalog_featured_sections: Optional[List[Dict]] = None,
    ) -> Dict:
        now = time.time()
        expires_in_days = max(int(access_expires_in_days or self._default_access_days()), 1)
        catalog_access_mode = "allowlist" if str(catalog_access_mode or "").strip().lower() == "allowlist" else "full"
        user = {
            "id": uuid4().hex,
            "email": email.strip().lower(),
            "name": name.strip() or email.strip().lower(),
            "access_hash": self._new_access_hash(),
            "access_expires_at": now + expires_in_days * 24 * 60 * 60,
            "password_hash": _password_hash(secrets.token_urlsafe(32)),
            "max_screens": max(int(max_screens or 2), 1),
            "allow_adult_content": 1 if allow_adult_content else 0,
            "catalog_access_mode": catalog_access_mode,
            "catalog_allowed_terms": json.dumps(_normalized_catalog_terms(catalog_allowed_terms), ensure_ascii=False),
            "catalog_featured_sections": json.dumps(_normalized_catalog_featured_sections(catalog_featured_sections), ensure_ascii=False),
            "active": 1,
            "created_at": now,
            "updated_at": now,
        }
        if not user["email"] or "@" not in user["email"]:
            raise AuthError("E-mail invalido", 400)
        with self.lock, self._connect() as db:
            try:
                db.execute(
                    """
                    INSERT INTO users
                    (id, email, name, access_hash, access_expires_at, password_hash, max_screens, allow_adult_content, catalog_access_mode, catalog_allowed_terms, catalog_featured_sections, active, created_at, updated_at)
                    VALUES (:id, :email, :name, :access_hash, :access_expires_at, :password_hash, :max_screens, :allow_adult_content, :catalog_access_mode, :catalog_allowed_terms, :catalog_featured_sections, :active, :created_at, :updated_at)
                    """,
                    user,
                )
            except sqlite3.IntegrityError:
                raise AuthError("Usuario ja cadastrado", 409)
        return self._public_user(user)

    def list_users(self) -> List[Dict]:
        self.prune_expired_sessions()
        with self.lock, self._connect() as db:
            rows = db.execute(
                """
                SELECT users.*,
                    (
                        SELECT COUNT(*) FROM (
                            SELECT 1 FROM sessions
                            WHERE sessions.user_id = users.id
                                AND sessions.revoked_at IS NULL
                                AND sessions.last_heartbeat >= ?
                                AND sessions.expires_at > ?
                            GROUP BY
                                CASE
                                    WHEN sessions.device_id != '' THEN sessions.device_id
                                    ELSE sessions.user_agent || '|' || sessions.ip_address
                                END
                        )
                    ) AS active_sessions
                FROM users
                WHERE users.id != ?
                ORDER BY users.created_at DESC
                """,
                (
                    time.time() - self._screen_lease_seconds(),
                    time.time(),
                    ADMIN_USER_ID,
                ),
            ).fetchall()
        return [self._public_user(dict(row)) for row in rows]

    def update_user(
        self,
        user_id: str,
        email: str,
        name: str,
        max_screens: int,
        allow_adult_content: bool,
        active: bool,
        access_expires_at: float,
        catalog_access_mode: Optional[str] = None,
        catalog_allowed_terms: Optional[List[str]] = None,
        catalog_featured_sections: Optional[List[Dict]] = None,
    ) -> Dict:
        if not user_id:
            raise AuthError("Usuario obrigatorio", 400)
        email = email.strip().lower()
        if not email or "@" not in email:
            raise AuthError("E-mail invalido", 400)
        now = time.time()
        with self.lock, self._connect() as db:
            current = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            if not current:
                raise AuthError("Usuario nao encontrado", 404)
            current = dict(current)
            if catalog_access_mode is None:
                catalog_access_mode = str(current.get("catalog_access_mode") or "full")
            catalog_access_mode = "allowlist" if str(catalog_access_mode or "").strip().lower() == "allowlist" else "full"
            if catalog_allowed_terms is None:
                catalog_allowed_terms = _normalized_catalog_terms(current.get("catalog_allowed_terms") or "[]")
            if catalog_featured_sections is None:
                catalog_featured_sections = _normalized_catalog_featured_sections(current.get("catalog_featured_sections") or "[]")
            try:
                db.execute(
                    """
                    UPDATE users
                    SET email = ?, name = ?, max_screens = ?, allow_adult_content = ?,
                        catalog_access_mode = ?, catalog_allowed_terms = ?, catalog_featured_sections = ?,
                        active = ?, access_expires_at = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        email,
                        name.strip() or email,
                        max(int(max_screens or 1), 1),
                        1 if allow_adult_content else 0,
                        catalog_access_mode,
                        json.dumps(_normalized_catalog_terms(catalog_allowed_terms), ensure_ascii=False),
                        json.dumps(_normalized_catalog_featured_sections(catalog_featured_sections), ensure_ascii=False),
                        1 if active else 0,
                        max(float(access_expires_at or 0), now),
                        now,
                        user_id,
                    ),
                )
            except sqlite3.IntegrityError:
                raise AuthError("E-mail ja cadastrado", 409)
            row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return self._public_user(dict(row))

    def delete_user(self, user_id: str) -> None:
        if not user_id:
            raise AuthError("Usuario obrigatorio", 400)
        with self.lock, self._connect() as db:
            row = db.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
            if not row:
                raise AuthError("Usuario nao encontrado", 404)
            db.execute("DELETE FROM user_state WHERE user_id = ?", (user_id,))
            db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            db.execute("DELETE FROM users WHERE id = ?", (user_id,))

    def rotate_access_hash(self, user_id: str) -> Dict:
        if not user_id:
            raise AuthError("Usuario obrigatorio", 400)
        with self.lock, self._connect() as db:
            row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            if not row:
                raise AuthError("Usuario nao encontrado", 404)
            db.execute(
                "UPDATE users SET access_hash = ?, updated_at = ? WHERE id = ?",
                (self._new_access_hash(), time.time(), user_id),
            )
            row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return self._public_user(dict(row))

    def login(self, email: str, password: str, device_name: str, user_agent: str, ip_address: str, device_id: str = "") -> Dict:
        user = self._get_user_by_email(email.strip().lower())
        if not user or not int(user["active"]) or not _verify_password(password, user["password_hash"]):
            raise AuthError("E-mail ou senha invalidos", 401)
        return self._create_session(user, device_name, user_agent, ip_address, device_id)

    def login_with_access_hash(self, access_hash: str, device_name: str, user_agent: str, ip_address: str, device_id: str = "") -> Dict:
        access_hash = access_hash.strip()
        if not access_hash:
            raise AuthError("Hash de acesso obrigatorio", 400)
        admin_token = os.getenv("AUTH_ADMIN_TOKEN", "").strip()
        if admin_token and hmac.compare_digest(access_hash, admin_token):
            return self._create_admin_session(device_name, user_agent, ip_address, device_id)
        user = self._get_user_by_access_hash(access_hash)
        if not user or not int(user["active"]):
            raise AuthError("Link de acesso invalido", 401)
        if float(user.get("access_expires_at") or 0) <= time.time():
            raise AuthError("Link de acesso expirado", 401)
        return self._create_session(user, device_name, user_agent, ip_address, device_id)

    def _create_admin_session(self, device_name: str, user_agent: str, ip_address: str, device_id: str = "") -> Dict:
        now = time.time()
        user = {
            "id": ADMIN_USER_ID,
            "email": ADMIN_USER_EMAIL,
            "name": "Administrador",
            "access_hash": hashlib.sha256(os.getenv("AUTH_ADMIN_TOKEN", "").encode("utf-8")).hexdigest(),
            "access_expires_at": now + 10 * 365 * 24 * 60 * 60,
            "password_hash": _password_hash(secrets.token_urlsafe(32)),
            "max_screens": ADMIN_MAX_SCREENS,
            "allow_adult_content": 1,
            "catalog_access_mode": "full",
            "catalog_allowed_terms": "[]",
            "catalog_featured_sections": "[]",
            "active": 1,
            "created_at": now,
            "updated_at": now,
        }
        with self.lock, self._connect() as db:
            db.execute(
                """
                INSERT INTO users
                (id, email, name, access_hash, access_expires_at, password_hash, max_screens, allow_adult_content, catalog_access_mode, catalog_allowed_terms, catalog_featured_sections, active, created_at, updated_at)
                VALUES (:id, :email, :name, :access_hash, :access_expires_at, :password_hash, :max_screens, :allow_adult_content, :catalog_access_mode, :catalog_allowed_terms, :catalog_featured_sections, :active, :created_at, :updated_at)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    access_hash = excluded.access_hash,
                    access_expires_at = excluded.access_expires_at,
                    max_screens = excluded.max_screens,
                    allow_adult_content = excluded.allow_adult_content,
                    catalog_access_mode = excluded.catalog_access_mode,
                    catalog_allowed_terms = excluded.catalog_allowed_terms,
                    catalog_featured_sections = excluded.catalog_featured_sections,
                    active = excluded.active,
                    updated_at = excluded.updated_at
                """,
                user,
            )
            row = db.execute("SELECT * FROM users WHERE id = ?", (ADMIN_USER_ID,)).fetchone()
        return self._create_session(dict(row), device_name, user_agent, ip_address, device_id, skip_limit=True)

    def _create_session(
        self,
        user: Dict,
        device_name: str,
        user_agent: str,
        ip_address: str,
        device_id: str = "",
        skip_limit: bool = False,
    ) -> Dict:
        self.prune_expired_sessions()
        now = time.time()
        ttl = self._session_ttl_seconds()
        device_id = self._normalized_device_id(device_id, user_agent, ip_address)
        reusable_session = self._find_reusable_session(user["id"], device_id, user_agent, ip_address, now, ttl)
        if reusable_session:
            return self._session_response(user, reusable_session, now, ttl)

        active_count = self.active_session_count(user["id"])
        if not skip_limit and active_count >= int(user["max_screens"]):
            raise AuthError("Limite de telas simultaneas atingido para este usuario", 409)

        session_id = uuid4().hex
        with self.lock, self._connect() as db:
            db.execute(
                """
                INSERT INTO sessions
                (id, user_id, device_id, device_name, user_agent, ip_address, created_at, last_heartbeat, expires_at, revoked_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                """,
                (session_id, user["id"], device_id[:160], device_name[:120], user_agent[:500], ip_address[:120], now, now, now + ttl),
            )
        token = _json_token({"sub": user["id"], "sid": session_id, "email": user["email"], "exp": int(now + ttl)})
        return {
            "token": token,
            "user": self._public_user(user),
            "session": {"id": session_id, "heartbeat_interval_seconds": 30},
        }

    def _session_ttl_seconds(self) -> int:
        configured = int(os.getenv("AUTH_TOKEN_TTL_SECONDS", str(30 * 24 * 60 * 60)))
        minimum = int(os.getenv("AUTH_MIN_TOKEN_TTL_SECONDS", str(7 * 24 * 60 * 60)))
        return max(configured, minimum)

    def _screen_lease_seconds(self) -> int:
        return max(int(os.getenv("AUTH_SCREEN_LEASE_SECONDS", os.getenv("AUTH_SESSION_STALE_SECONDS", "300"))), 60)

    def _normalized_device_id(self, device_id: str, user_agent: str, ip_address: str) -> str:
        value = str(device_id or "").strip()
        if value:
            return value
        return hashlib.sha256(f"{user_agent}:{ip_address}".encode("utf-8")).hexdigest()

    def _find_reusable_session(self, user_id: str, device_id: str, user_agent: str, ip_address: str, now: float, ttl: int) -> Optional[str]:
        with self.lock, self._connect() as db:
            row = db.execute(
                """
                SELECT id FROM sessions
                WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
                    AND (
                        device_id = ?
                        OR (device_id = '' AND user_agent = ? AND ip_address = ?)
                    )
                ORDER BY last_heartbeat DESC
                LIMIT 1
                """,
                (user_id, now, device_id[:160], user_agent[:500], ip_address[:120]),
            ).fetchone()
            if not row:
                return None
            db.execute(
                """
                UPDATE sessions SET revoked_at = ?
                WHERE user_id = ? AND id != ? AND revoked_at IS NULL AND expires_at > ?
                    AND (
                        device_id = ?
                        OR (device_id = '' AND user_agent = ? AND ip_address = ?)
                    )
                """,
                (now, user_id, row["id"], now, device_id[:160], user_agent[:500], ip_address[:120]),
            )
            db.execute(
                "UPDATE sessions SET last_heartbeat = ?, expires_at = ? WHERE id = ?",
                (now, now + ttl, row["id"]),
            )
            return str(row["id"])

    def _session_response(self, user: Dict, session_id: str, now: float, ttl: int) -> Dict:
        token = _json_token({"sub": user["id"], "sid": session_id, "email": user["email"], "exp": int(now + ttl)})
        return {
            "token": token,
            "user": self._public_user(user),
            "session": {"id": session_id, "heartbeat_interval_seconds": 30},
        }

    def _new_access_hash(self) -> str:
        return secrets.token_urlsafe(32)

    def _default_access_days(self) -> int:
        return max(int(os.getenv("AUTH_DEFAULT_ACCESS_DAYS", "30")), 1)

    def heartbeat(self, user_id: str, session_id: str) -> Dict:
        now = time.time()
        ttl = self._session_ttl_seconds()
        self.prune_expired_sessions()
        with self.lock, self._connect() as db:
            session = db.execute(
                """
                SELECT * FROM sessions
                WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?
                """,
                (session_id, user_id, now),
            ).fetchone()
            if not session:
                raise AuthError("Sessao expirada ou encerrada", 401)
            db.execute("UPDATE sessions SET last_heartbeat = ?, expires_at = ? WHERE id = ?", (now, now + ttl, session_id))
        token = _json_token({"sub": user_id, "sid": session_id, "exp": int(now + ttl)})
        return {"status": "ok", "active_sessions": self.active_session_count(user_id), "token": token}

    def touch_session(self, user_id: str, session_id: str) -> None:
        if not user_id or not session_id:
            return
        now = time.time()
        ttl = self._session_ttl_seconds()
        with self.lock, self._connect() as db:
            db.execute(
                """
                UPDATE sessions
                SET last_heartbeat = ?, expires_at = ?
                WHERE id = ? AND user_id = ? AND revoked_at IS NULL
                """,
                (now, now + ttl, session_id, user_id),
            )

    def logout(self, user_id: str, session_id: str) -> None:
        with self.lock, self._connect() as db:
            db.execute(
                "UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
                (time.time(), session_id, user_id),
            )

    def get_user_state(self, user_id: str) -> Dict:
        with self.lock, self._connect() as db:
            row = db.execute("SELECT favorites, watched_episodes FROM user_state WHERE user_id = ?", (user_id,)).fetchone()
        if not row:
            return {"favorites": [], "watched_episodes": {}}
        try:
            favorites = json.loads(row["favorites"] or "[]")
        except json.JSONDecodeError:
            favorites = []
        try:
            watched = json.loads(row["watched_episodes"] or "{}")
        except json.JSONDecodeError:
            watched = {}
        return {
            "favorites": favorites if isinstance(favorites, list) else [],
            "watched_episodes": watched if isinstance(watched, dict) else {},
        }

    def update_user_state(
        self,
        user_id: str,
        favorites: Optional[List[Dict]] = None,
        watched_episodes: Optional[Dict[str, Dict]] = None,
    ) -> Dict:
        current = self.get_user_state(user_id)
        if favorites is not None:
            current["favorites"] = favorites[:200]
        if watched_episodes is not None:
            current["watched_episodes"] = dict(list(watched_episodes.items())[:5000])
        now = time.time()
        with self.lock, self._connect() as db:
            db.execute(
                """
                INSERT INTO user_state (user_id, favorites, watched_episodes, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    favorites = excluded.favorites,
                    watched_episodes = excluded.watched_episodes,
                    updated_at = excluded.updated_at
                """,
                (
                    user_id,
                    json.dumps(current["favorites"], ensure_ascii=False),
                    json.dumps(current["watched_episodes"], ensure_ascii=False),
                    now,
                ),
            )
        return current

    def record_access_event(self, event: str, payload: Dict) -> None:
        now = time.time()
        details = dict(payload)
        with self.lock, self._connect() as db:
            db.execute(
                """
                INSERT INTO access_events
                (created_at, event, user_id, session_id, client_ip, host, user_agent, title, category, media_kind, playback_mode, details)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    now,
                    event,
                    str(payload.get("user_id") or ""),
                    str(payload.get("session_id") or ""),
                    str(payload.get("client_ip") or ""),
                    str(payload.get("host") or ""),
                    str(payload.get("user_agent") or ""),
                    str(payload.get("title") or payload.get("content") or ""),
                    str(payload.get("category") or ""),
                    str(payload.get("media_kind") or ""),
                    str(payload.get("playback_mode") or ""),
                    json.dumps(details, ensure_ascii=False),
                ),
            )
            db.execute("DELETE FROM access_events WHERE created_at < ?", (now - 7 * 24 * 60 * 60,))

    def monitoring_summary(self) -> Dict:
        now = time.time()
        online_seconds = int(os.getenv("MONITOR_ONLINE_SECONDS", str(self._screen_lease_seconds())))
        online_cutoff = now - online_seconds
        activity_cutoff = now - int(os.getenv("MONITOR_ACTIVITY_SECONDS", "3600"))
        with self.lock, self._connect() as db:
            online_rows = db.execute(
                """
                SELECT sessions.id, sessions.user_id, sessions.device_id, sessions.device_name, sessions.ip_address,
                    sessions.user_agent, sessions.last_heartbeat, users.name, users.email
                FROM sessions
                JOIN users ON users.id = sessions.user_id
                WHERE sessions.revoked_at IS NULL AND sessions.expires_at > ?
                    AND sessions.last_heartbeat >= ?
                ORDER BY sessions.last_heartbeat DESC
                """,
                (now, online_cutoff),
            ).fetchall()
            recent_rows = db.execute(
                """
                SELECT access_events.*, users.name, users.email
                FROM access_events
                LEFT JOIN users ON users.id = access_events.user_id
                WHERE access_events.created_at >= ?
                ORDER BY access_events.created_at DESC
                LIMIT 80
                """,
                (activity_cutoff,),
            ).fetchall()
            content_rows = db.execute(
                """
                SELECT title, category, media_kind, COUNT(*) AS total, MAX(created_at) AS last_access_at
                FROM access_events
                WHERE created_at >= ? AND event IN ('content_request', 'stream_start', 'vlc_open')
                    AND title != ''
                GROUP BY title, category, media_kind
                ORDER BY total DESC, last_access_at DESC
                LIMIT 20
                """,
                (activity_cutoff,),
            ).fetchall()

        online_by_device = {}
        for row in online_rows:
            device_key = row["device_id"] or f"{row['user_agent']}|{row['ip_address']}"
            unique_key = f"{row['user_id']}|{device_key}"
            if unique_key in online_by_device:
                continue
            online_by_device[unique_key] = {
                "session_id": row["id"],
                "user_id": row["user_id"],
                "name": row["name"],
                "email": row["email"],
                "device_id": row["device_id"],
                "device_name": row["device_name"],
                "ip_address": row["ip_address"],
                "user_agent": row["user_agent"],
                "last_heartbeat": float(row["last_heartbeat"] or 0),
            }
        online_users = list(online_by_device.values())
        recent_events = []
        for row in recent_rows:
            try:
                details = json.loads(row["details"] or "{}")
            except json.JSONDecodeError:
                details = {}
            recent_events.append(
                {
                    "created_at": float(row["created_at"] or 0),
                    "event": row["event"],
                    "user_id": row["user_id"],
                    "session_id": row["session_id"],
                    "name": row["name"] or "",
                    "email": row["email"] or "",
                    "client_ip": row["client_ip"] or "",
                    "title": row["title"] or details.get("content") or "",
                    "category": row["category"] or "",
                    "media_kind": row["media_kind"] or "",
                    "playback_mode": row["playback_mode"] or "",
                    "details": details,
                }
            )
        top_content = [
            {
                "title": row["title"],
                "category": row["category"] or "",
                "media_kind": row["media_kind"] or "",
                "total": int(row["total"] or 0),
                "last_access_at": float(row["last_access_at"] or 0),
            }
            for row in content_rows
        ]
        unique_online_users = len({row["user_id"] for row in online_users})
        return {
            "generated_at": now,
            "online_seconds": online_seconds,
            "activity_seconds": int(os.getenv("MONITOR_ACTIVITY_SECONDS", "3600")),
            "summary": {
                "online_sessions": len(online_users),
                "online_users": unique_online_users,
                "recent_events": len(recent_events),
                "top_content": len(top_content),
            },
            "online_users": online_users,
            "recent_events": recent_events,
            "top_content": top_content,
        }

    def require_session(self, token: str) -> Dict:
        payload = _verify_json_token(token)
        user_id = str(payload.get("sub") or "")
        session_id = str(payload.get("sid") or "")
        if not user_id or not session_id:
            raise AuthError("Token invalido")
        self.prune_expired_sessions()
        now = time.time()
        ttl = self._session_ttl_seconds()
        with self.lock, self._connect() as db:
            row = db.execute(
                """
                SELECT users.*, sessions.id AS session_id, sessions.last_heartbeat, sessions.expires_at
                FROM sessions
                JOIN users ON users.id = sessions.user_id
                WHERE sessions.id = ? AND users.id = ? AND sessions.revoked_at IS NULL
                    AND sessions.expires_at > ? AND users.active = 1
                """,
                (session_id, user_id, now),
            ).fetchone()
            if row:
                db.execute("UPDATE sessions SET last_heartbeat = ?, expires_at = ? WHERE id = ?", (now, now + ttl, session_id))
        if not row:
            raise AuthError("Sessao expirada ou encerrada")
        user = dict(row)
        return {"user": self._public_user(user), "session_id": session_id}

    def active_session_count(self, user_id: str) -> int:
        cutoff = time.time() - self._screen_lease_seconds()
        with self.lock, self._connect() as db:
            row = db.execute(
                """
                SELECT COUNT(*) AS total FROM (
                    SELECT 1 FROM sessions
                    WHERE user_id = ? AND revoked_at IS NULL AND last_heartbeat >= ? AND expires_at > ?
                    GROUP BY
                        CASE
                            WHEN device_id != '' THEN device_id
                            ELSE user_agent || '|' || ip_address
                        END
                )
                """,
                (user_id, cutoff, time.time()),
            ).fetchone()
        return int(row["total"] if row else 0)

    def prune_expired_sessions(self) -> None:
        now = time.time()
        with self.lock, self._connect() as db:
            db.execute(
                """
                UPDATE sessions SET revoked_at = ?
                WHERE revoked_at IS NULL AND expires_at <= ?
                """,
                (now, now),
            )

    def _get_user_by_email(self, email: str) -> Optional[Dict]:
        with self.lock, self._connect() as db:
            row = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        return dict(row) if row else None

    def _get_user_by_access_hash(self, access_hash: str) -> Optional[Dict]:
        with self.lock, self._connect() as db:
            row = db.execute("SELECT * FROM users WHERE access_hash = ?", (access_hash,)).fetchone()
        return dict(row) if row else None

    def _public_user(self, user: Dict) -> Dict:
        return {
            "id": user["id"],
            "email": user["email"],
            "name": user["name"],
            "access_hash": user.get("access_hash", ""),
            "access_expires_at": float(user.get("access_expires_at") or 0),
            "max_screens": int(user["max_screens"]),
            "allow_adult_content": bool(user["allow_adult_content"]),
            "catalog_access_mode": str(user.get("catalog_access_mode") or "full"),
            "catalog_allowed_terms": _normalized_catalog_terms(user.get("catalog_allowed_terms") or "[]"),
            "catalog_featured_sections": _normalized_catalog_featured_sections(user.get("catalog_featured_sections") or "[]"),
            "active": bool(user.get("active", 1)),
            "active_sessions": int(user.get("active_sessions", 0) or 0),
            "created_at": float(user.get("created_at", 0) or 0),
            "updated_at": float(user.get("updated_at", 0) or 0),
            "is_admin": user.get("id") == ADMIN_USER_ID,
        }


class AppRequestHandler(BaseHTTPRequestHandler):
    server_version = "StreamM3U8App/1.0"

    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError):
            return

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        if self.path.startswith("/api/") or self.path.startswith("/auth/"):
            self.send_header("Cache-Control", "no-store")
        if self.path.endswith(".html") or urllib.parse.urlsplit(self.path).path in {"/", "/admin", "/monitoring"}:
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self'; img-src 'self' https: data:; media-src 'self' blob: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
            )
        super().end_headers()

    def do_GET(self):
        try:
            self._check_rate_limit("GET")
            if self.path == "/healthz":
                self._send_json(200, {"status": "ok"})
                return
            if self.path == "/readyz":
                status = self.server.preloaded_playlist_status()
                self._send_json(200 if status.get("status") == "done" else 503, status)
                return
            if self.path == "/api/config":
                self._handle_config()
                return
            if self.path == "/api/auth/me":
                self._handle_auth_me()
                return
            if self.path == "/api/user/state":
                self._handle_user_state_get()
                return
            if self.path == "/api/trial/catalog":
                self._handle_trial_catalog()
                return
            if self.path == "/api/admin/users":
                self._handle_admin_list_users()
                return
            if self.path == "/api/admin/monitoring":
                self._handle_admin_monitoring()
                return
            if self.path == "/api/playlist/cache-default/status":
                self._handle_cache_default_status()
                return
            if self.path == "/api/playlist/preloaded/status":
                self._handle_preloaded_playlist_status()
                return
            if self.path.startswith("/vlc-proxy/"):
                self._handle_vlc_proxy()
                return
            if self.path.startswith("/proxy/"):
                self._handle_proxy()
                return
            if self.path.startswith("/media-proxy"):
                self._handle_media_proxy()
                return
            if self.path.startswith("/transmux/"):
                self._handle_transmux_proxy()
                return
            self._serve_static()
        except AuthError as exc:
            self._send_json_error(exc.status_code, str(exc))
        except (ValueError, StreamConfigurationError) as exc:
            self._send_json_error(400, str(exc))
        except Exception:
            self._send_json_error(500, "Erro interno")

    def do_HEAD(self):
        try:
            self._check_rate_limit("HEAD")
            if self.path.startswith("/vlc-proxy/"):
                self._handle_vlc_proxy(send_body=False)
                return
            if self.path.startswith("/media-proxy"):
                self._handle_media_proxy(send_body=False)
                return
            if self.path.startswith("/transmux/"):
                self._handle_transmux_proxy(send_body=False)
                return
            self._send_json_error(404, "Rota nao encontrada")
        except AuthError as exc:
            self._send_json_error(exc.status_code, str(exc))
        except (ValueError, StreamConfigurationError) as exc:
            self._send_json_error(400, str(exc))
        except Exception:
            self._send_json_error(500, "Erro interno")

    def do_POST(self):
        try:
            self._check_rate_limit("POST")
            if self.path == "/api/auth/login":
                self._handle_auth_login()
                return
            if self.path == "/api/auth/link-login":
                self._handle_auth_link_login()
                return
            if self.path == "/api/auth/logout":
                self._handle_auth_logout()
                return
            if self.path == "/api/auth/heartbeat":
                self._handle_auth_heartbeat()
                return
            if self.path == "/api/user/state":
                self._handle_user_state_update()
                return
            if self.path == "/api/auth/register":
                self._handle_auth_register()
                return
            if self.path == "/api/admin/users":
                self._handle_admin_create_user()
                return
            if self.path.startswith("/api/admin/users/") and self.path.endswith("/rotate-link"):
                self._handle_admin_rotate_link()
                return
            if self.path in {"/stream/start", "/api/stream/start"}:
                self._handle_start()
                return
            if self.path in {"/stream/stop", "/api/stream/stop"}:
                self._handle_stop()
                return
            if self.path == "/api/events/content-request":
                self._handle_content_request_event()
                return
            if self.path == "/api/vlc/open":
                self._handle_vlc_open()
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
        except AuthError as exc:
            self._send_json_error(exc.status_code, str(exc))
        except (ValueError, json.JSONDecodeError) as exc:
            self._send_json_error(400, str(exc))
        except Exception:
            self._send_json_error(500, "Erro interno")

    def do_PUT(self):
        try:
            self._check_rate_limit("PUT")
            if self.path.startswith("/api/admin/users/"):
                self._handle_admin_update_user()
                return
            self._send_json_error(404, "Rota nao encontrada")
        except AuthError as exc:
            self._send_json_error(exc.status_code, str(exc))
        except (ValueError, json.JSONDecodeError) as exc:
            self._send_json_error(400, str(exc))
        except Exception:
            self._send_json_error(500, "Erro interno")

    def do_DELETE(self):
        try:
            self._check_rate_limit("DELETE")
            if self.path.startswith("/api/admin/users/"):
                self._handle_admin_delete_user()
                return
            self._send_json_error(404, "Rota nao encontrada")
        except AuthError as exc:
            self._send_json_error(exc.status_code, str(exc))
        except (ValueError, json.JSONDecodeError) as exc:
            self._send_json_error(400, str(exc))
        except Exception:
            self._send_json_error(500, "Erro interno")

    def _handle_auth_register(self) -> None:
        self._require_admin()
        payload = self._read_json()
        try:
            max_screens = int(payload.get("max_screens") or os.getenv("AUTH_DEFAULT_MAX_SCREENS", "2"))
        except (TypeError, ValueError):
            max_screens = int(os.getenv("AUTH_DEFAULT_MAX_SCREENS", "2"))
        try:
            access_expires_in_days = int(payload.get("access_expires_in_days") or os.getenv("AUTH_DEFAULT_ACCESS_DAYS", "30"))
        except (TypeError, ValueError):
            access_expires_in_days = int(os.getenv("AUTH_DEFAULT_ACCESS_DAYS", "30"))

        user = self.server.auth_store.create_user(
            email=str(payload.get("email") or ""),
            name=str(payload.get("name") or ""),
            max_screens=max_screens,
            allow_adult_content=bool(payload.get("allow_adult_content")),
            access_expires_in_days=access_expires_in_days,
            catalog_access_mode=str(payload.get("catalog_access_mode") or "full"),
            catalog_allowed_terms=_normalized_catalog_terms(payload.get("catalog_allowed_terms") or []),
            catalog_featured_sections=_normalized_catalog_featured_sections(payload.get("catalog_featured_sections") or []),
        )
        access_url = f"{self._base_url()}/access/{urllib.parse.quote(user['access_hash'], safe='')}"
        self._log_access("auth_register", user_id=user["id"], email=user["email"])
        self._send_json(201, {"user": user, "access_url": access_url})

    def _handle_admin_list_users(self) -> None:
        self._require_admin()
        users = [self._admin_user_payload(user) for user in self.server.auth_store.list_users()]
        self._send_json(200, {"users": users})

    def _handle_admin_monitoring(self) -> None:
        self._require_admin()
        self._send_json(200, self.server.auth_store.monitoring_summary())

    def _handle_admin_create_user(self) -> None:
        self._require_admin()
        payload = self._read_json()
        user = self.server.auth_store.create_user(
            email=str(payload.get("email") or ""),
            name=str(payload.get("name") or ""),
            max_screens=self._payload_int(payload, "max_screens", int(os.getenv("AUTH_DEFAULT_MAX_SCREENS", "2"))),
            allow_adult_content=bool(payload.get("allow_adult_content")),
            access_expires_in_days=self._payload_int(
                payload,
                "access_expires_in_days",
                int(os.getenv("AUTH_DEFAULT_ACCESS_DAYS", "30")),
            ),
            catalog_access_mode=str(payload.get("catalog_access_mode") or "full"),
            catalog_allowed_terms=_normalized_catalog_terms(payload.get("catalog_allowed_terms") or []),
            catalog_featured_sections=_normalized_catalog_featured_sections(payload.get("catalog_featured_sections") or []),
        )
        self._log_access("admin_user_create", user_id=user["id"], email=user["email"])
        self._send_json(201, {"user": self._admin_user_payload(user)})

    def _handle_admin_update_user(self) -> None:
        self._require_admin()
        user_id = self._admin_user_id_from_path()
        payload = self._read_json()
        user = self.server.auth_store.update_user(
            user_id=user_id,
            email=str(payload.get("email") or ""),
            name=str(payload.get("name") or ""),
            max_screens=self._payload_int(payload, "max_screens", int(os.getenv("AUTH_DEFAULT_MAX_SCREENS", "2"))),
            allow_adult_content=bool(payload.get("allow_adult_content")),
            active=bool(payload.get("active", True)),
            access_expires_at=self._payload_float(payload, "access_expires_at", time.time()),
            catalog_access_mode=str(payload.get("catalog_access_mode")) if "catalog_access_mode" in payload else None,
            catalog_allowed_terms=_normalized_catalog_terms(payload.get("catalog_allowed_terms")) if "catalog_allowed_terms" in payload else None,
            catalog_featured_sections=_normalized_catalog_featured_sections(payload.get("catalog_featured_sections")) if "catalog_featured_sections" in payload else None,
        )
        self._log_access("admin_user_update", user_id=user["id"], email=user["email"])
        self._send_json(200, {"user": self._admin_user_payload(user)})

    def _handle_admin_delete_user(self) -> None:
        self._require_admin()
        user_id = self._admin_user_id_from_path()
        self.server.auth_store.delete_user(user_id)
        self._log_access("admin_user_delete", user_id=user_id)
        self._send_json(200, {"status": "deleted"})

    def _handle_admin_rotate_link(self) -> None:
        self._require_admin()
        user_id = self._admin_user_id_from_path()
        user = self.server.auth_store.rotate_access_hash(user_id)
        self._log_access("admin_user_rotate_link", user_id=user["id"], email=user["email"])
        self._send_json(200, {"user": self._admin_user_payload(user)})

    def _handle_auth_login(self) -> None:
        payload = self._read_json()
        auth = self.server.auth_store.login(
            email=str(payload.get("email") or ""),
            password=str(payload.get("password") or ""),
            device_name=str(payload.get("device_name") or "Navegador"),
            user_agent=self.headers.get("User-Agent", ""),
            ip_address=self._client_ip(),
            device_id=str(payload.get("device_id") or ""),
        )
        self._log_access("auth_login", user_id=auth["user"]["id"], email=auth["user"]["email"])
        self._send_json(200, auth, extra_headers={"Set-Cookie": self._auth_cookie_header(auth["token"], self.server.auth_store._session_ttl_seconds())})

    def _handle_auth_link_login(self) -> None:
        payload = self._read_json()
        auth = self.server.auth_store.login_with_access_hash(
            access_hash=str(payload.get("access_hash") or ""),
            device_name=str(payload.get("device_name") or "Navegador"),
            user_agent=self.headers.get("User-Agent", ""),
            ip_address=self._client_ip(),
            device_id=str(payload.get("device_id") or ""),
        )
        self._log_access("auth_link_login", user_id=auth["user"]["id"], email=auth["user"]["email"])
        self._send_json(200, auth, extra_headers={"Set-Cookie": self._auth_cookie_header(auth["token"], self.server.auth_store._session_ttl_seconds())})

    def _handle_auth_me(self) -> None:
        auth = self._require_auth()
        user = auth["user"]
        self._send_json(
            200,
            {
                "user": user,
                "session": {
                    "id": auth["session_id"],
                    "heartbeat_interval_seconds": 30,
                    "active_sessions": self.server.auth_store.active_session_count(user["id"]),
                },
            },
        )

    def _handle_auth_heartbeat(self) -> None:
        auth = self._require_auth()
        response = self.server.auth_store.heartbeat(auth["user"]["id"], auth["session_id"])
        headers = {"Set-Cookie": self._auth_cookie_header(response["token"], self.server.auth_store._session_ttl_seconds())} if response.get("token") else {}
        self._send_json(200, response, extra_headers=headers)

    def _handle_auth_logout(self) -> None:
        auth = self._require_auth()
        self.server.auth_store.logout(auth["user"]["id"], auth["session_id"])
        self._send_json(200, {"status": "logged_out"}, extra_headers={"Set-Cookie": self._clear_auth_cookie_header()})

    def _handle_user_state_get(self) -> None:
        auth = self._require_auth()
        self._send_json(200, self.server.auth_store.get_user_state(auth["user"]["id"]))

    def _handle_user_state_update(self) -> None:
        auth = self._require_auth()
        payload = self._read_json()
        favorites = payload.get("favorites") if isinstance(payload.get("favorites"), list) else None
        watched = payload.get("watched_episodes") if isinstance(payload.get("watched_episodes"), dict) else None
        self._send_json(200, self.server.auth_store.update_user_state(auth["user"]["id"], favorites, watched))

    def _handle_start(self) -> None:
        try:
            auth = self._require_auth()
            payload = self._read_json()
            stream_id = (payload.get("stream_id") or payload.get("url") or "").strip()
            if not stream_id:
                raise ValueError("stream_id e obrigatorio")
            _validate_public_fetch_url(self.server.service.resolve_source_url(stream_id))
            source_url = _validate_public_fetch_url(self.server.service.resolve_source_url(stream_id))
            self._require_catalog_playback_allowed(auth, source_url)
            self._log_access(
                "stream_start",
                user_id=auth["user"]["id"],
                session_id=auth["session_id"],
                user_email=auth["user"]["email"],
                user_name=auth["user"]["name"],
                title=payload.get("title") or "",
                group=payload.get("group") or "",
                category=payload.get("category") or "",
                media_kind=payload.get("media_kind") or "",
                stream_ref=_stream_ref(stream_id),
            )
            requested_kind = str(payload.get("media_kind") or "")
            if self._should_transmux_for_browser(source_url, requested_kind):
                response = self.server.start_transmux_hls(
                    stream_id,
                    source_url,
                    self._base_url(),
                    auth["user"]["id"],
                    auth["session_id"],
                )
                self._send_json(200, response)
                return
            response = self.server.service.start_stream(stream_id, self._base_url())
            if response.get("media_kind") != "hls":
                token = self.server.register_vlc_stream(source_url, auth["user"]["id"], auth["session_id"])
                response["local_proxy_url"] = f"{self._base_url()}/media-proxy?vt={urllib.parse.quote(token, safe='')}"
            self._send_json(200, response)
        except StreamConfigurationError as exc:
            self._send_json_error(503, str(exc))
        except (InvalidPlaylistError, ValueError) as exc:
            self._send_json_error(400, str(exc))
        except StreamOfflineError:
            self._send_json_error(503, "Stream offline")
        except SegmentTimeoutError:
            self._send_json_error(504, "Timeout de segmento")
        except AuthError as exc:
            self._send_json_error(exc.status_code, str(exc))
        except Exception as exc:
            self._send_json_error(500, str(exc))

    def _handle_config(self) -> None:
        self._send_json(200, {"playback_mode": _playback_mode()})

    def _handle_trial_catalog(self) -> None:
        auth = self._require_auth()
        user = auth.get("user") or {}
        if user.get("catalog_access_mode") != "allowlist":
            self._send_json(200, {"sections": []})
            return
        sections = _normalized_catalog_featured_sections(user.get("catalog_featured_sections") or [])
        if not sections:
            sections = [
                {
                    "id": "allowed",
                    "title": "Conteudos liberados",
                    "description": "Selecao disponivel nesta degustacao.",
                    "category": "all",
                    "terms": user.get("catalog_allowed_terms") or [],
                    "limit": 50,
                }
            ]
        load_status = self.server.start_preloaded_load(self._load_preloaded_playlist)
        if load_status["status"] == "loading":
            self._send_json(202, self._loading_playlist_response(load_status))
            return
        if load_status["status"] == "error":
            raise ValueError(load_status.get("error") or "Nao foi possivel carregar a playlist salva.")
        response = self.server.trial_catalog_response(
            load_status["playlist_id"],
            sections,
            include_adult=bool(user.get("allow_adult_content")),
            seed=str(user.get("id") or ""),
        )
        self._send_json(200, response)

    def _handle_stop(self) -> None:
        try:
            auth = self._require_auth()
            payload = self._read_json()
            stream_id = (payload.get("stream_id") or payload.get("url") or "").strip()
            if not stream_id:
                raise ValueError("stream_id e obrigatorio")
            self._log_access(
                "stream_stop",
                user_id=auth["user"]["id"],
                session_id=auth["session_id"],
                user_email=auth["user"]["email"],
                user_name=auth["user"]["name"],
                stream_ref=_stream_ref(stream_id),
            )
            self.server.stop_transmux_stream(stream_id, auth["user"]["id"], auth["session_id"])
            self._send_json(200, self.server.service.stop_stream(stream_id))
        except ValueError as exc:
            self._send_json_error(400, str(exc))

    def _handle_content_request_event(self) -> None:
        auth = self._require_auth()
        payload = self._read_json()
        stream_id = (payload.get("stream_id") or payload.get("url") or "").strip()
        self._log_access(
            "content_request",
            user_id=auth["user"]["id"],
            session_id=auth["session_id"],
            user_email=auth["user"]["email"],
            user_name=auth["user"]["name"],
            content=payload.get("title") or "Link direto",
            title=payload.get("title") or "Link direto",
            group=payload.get("group") or "",
            category=payload.get("category") or "",
            media_kind=payload.get("media_kind") or "",
            playback_mode=payload.get("playback_mode") or "",
            stream_ref=_stream_ref(stream_id),
        )
        self._send_json(200, {"status": "logged"})

    def _handle_vlc_open(self) -> None:
        try:
            auth = self._require_auth()
            payload = self._read_json()
            stream_id = (payload.get("stream_id") or payload.get("url") or "").strip()
            if not stream_id:
                raise ValueError("stream_id e obrigatorio")
            source_url = _validate_public_fetch_url(self.server.service.resolve_source_url(stream_id))
            self._require_catalog_playback_allowed(auth, source_url)
            token = self.server.register_vlc_stream(source_url, auth["user"]["id"], auth["session_id"])
            mime_type = self._guess_media_type(source_url)
            extension = self._external_stream_extension(mime_type, source_url)
            self._log_access(
                "vlc_open",
                user_id=auth["user"]["id"],
                session_id=auth["session_id"],
                user_email=auth["user"]["email"],
                user_name=auth["user"]["name"],
                title=payload.get("title") or "",
                stream_ref=_stream_ref(stream_id),
                proxy_ref=_stream_ref(token),
                mime_type=mime_type,
                extension=extension,
                source_path=urllib.parse.urlsplit(source_url).path[-120:],
            )
            stream_url = f"{self._base_url()}/vlc-proxy/{token}/stream{extension}"
            self._send_json(
                200,
                {
                    "stream_url": stream_url,
                    "mime_type": mime_type,
                    "launch_urls": [
                        f"vlc://{stream_url}",
                        f"vlc-x-callback://x-callback-url/stream?url={urllib.parse.quote(stream_url, safe='')}",
                    ],
                },
            )
        except (StreamConfigurationError, ValueError) as exc:
            self._send_json_error(400, str(exc))

    def _handle_playlist_parse(self) -> None:
        try:
            auth = self._require_auth()
            payload = self._read_json()
            playlist_text = payload.get("text") or ""
            source_url = (payload.get("url") or "").strip()
            if playlist_text and len(playlist_text.encode("utf-8")) > MAX_PLAYLIST_TEXT_BYTES:
                raise ValueError("Playlist enviada excede o tamanho maximo permitido")

            if source_url and not playlist_text:
                self._log_access("playlist_load_url", playlist_url=source_url)
                playlist_id = self._playlist_id(source_url)
                if playlist_id not in self.server.playlist_cache:
                    playlist_text = self._fetch_text(source_url)
                    self.server.set_playlist_entries(
                        playlist_id,
                        parse_playlist_entries(playlist_text, source_url),
                    )
            elif playlist_text:
                self._log_access("playlist_load_text", chars=len(playlist_text))
                playlist_id = self._playlist_id(playlist_text)
                if playlist_id not in self.server.playlist_cache:
                    self.server.set_playlist_entries(
                        playlist_id,
                        parse_playlist_entries(playlist_text, source_url),
                    )
            else:
                playlist_id = payload.get("playlist_id") or ""

            if not playlist_id or playlist_id not in self.server.playlist_cache:
                raise ValueError("Informe uma URL, conteudo da playlist ou playlist_id valido")

            response = self.server.playlist_response(
                playlist_id,
                category=payload.get("category") or "all",
                group=payload.get("group") or "",
                query=payload.get("query") or "",
                offset=int(payload.get("offset") or 0),
                limit=min(int(payload.get("limit") or 200), 500),
                series_key=payload.get("series_key") or "",
                season=str(payload.get("season") or ""),
                include_adult=auth["user"]["allow_adult_content"],
                allowed_terms=self._catalog_allowed_terms(auth),
                featured_sections=self._catalog_featured_sections(auth),
                access_seed=str(auth["user"].get("id") or ""),
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
            auth = self._require_auth()
            payload = self._read_json()
            load_status = self.server.start_preloaded_load(self._load_preloaded_playlist)
            if load_status["status"] == "loading":
                self._send_json(202, self._loading_playlist_response(load_status))
                return
            if load_status["status"] == "error":
                raise ValueError(load_status.get("error") or "Nao foi possivel carregar a playlist salva.")

            playlist_id = load_status["playlist_id"]
            self._log_access(
                "playlist_load_saved",
                category=payload.get("category") or "all",
                group=payload.get("group") or "",
                query=payload.get("query") or "",
                offset=int(payload.get("offset") or 0),
            )
            response = self.server.playlist_response(
                playlist_id,
                category=payload.get("category") or "all",
                group=payload.get("group") or "",
                query=payload.get("query") or "",
                offset=int(payload.get("offset") or 0),
                limit=min(int(payload.get("limit") or 200), 500),
                series_key=payload.get("series_key") or "",
                season=str(payload.get("season") or ""),
                include_adult=auth["user"]["allow_adult_content"],
                allowed_terms=self._catalog_allowed_terms(auth),
                featured_sections=self._catalog_featured_sections(auth),
                access_seed=str(auth["user"].get("id") or ""),
            )
            self._send_json(200, response)
        except (InvalidPlaylistError, ValueError) as exc:
            self._send_json_error(400, str(exc))

    def _loading_playlist_response(self, load_status: Dict) -> Dict:
        return {
            "status": "loading",
            "phase": load_status.get("phase") or "loading-cache",
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
            self._require_admin()
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
        self._require_auth()
        self._send_json(200, self.server.cache_job_snapshot())

    def _handle_preloaded_playlist_status(self) -> None:
        self._send_json(200, self.server.preloaded_playlist_status())

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

    def _handle_vlc_proxy(self, send_body: bool = True) -> None:
        path = urllib.parse.urlsplit(self.path).path
        parts = [part for part in path.split("/") if part]
        if len(parts) < 2 or parts[0] != "vlc-proxy":
            self._send_json_error(404, "Rota nao encontrada")
            return

        vlc_token = parts[1]
        token_info = self.server.resolve_vlc_token_info(vlc_token)
        source_url = str(token_info.get("url") or "")
        if not source_url:
            self._send_json_error(404, "Link VLC expirado ou invalido")
            return
        source_url = _validate_public_fetch_url(source_url)
        self.server.auth_store.touch_session(str(token_info.get("user_id") or ""), str(token_info.get("session_id") or ""))

        headers = _headers_for_source_url(source_url)
        if self.headers.get("Range"):
            headers["Range"] = self.headers["Range"]

        try:
            req = urllib.request.Request(source_url, headers=headers)
            with urllib.request.urlopen(req, timeout=self.server.service.download_timeout) as response:
                content_type = self._effective_media_type(source_url, response.headers.get("Content-Type"))
                self._log_access(
                    "vlc_proxy_request",
                    status=response.getcode(),
                    content_type=content_type,
                    range=self.headers.get("Range", ""),
                    content_range=response.headers.get("Content-Range", ""),
                    source_path=urllib.parse.urlsplit(source_url).path[-120:],
                )
                if self._is_playlist_response(source_url, content_type):
                    if not send_body:
                        self.send_response(response.getcode())
                        self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("Access-Control-Allow-Origin", "*")
                        self.end_headers()
                        return
                    body = response.read().decode("utf-8", errors="replace")
                    rewritten = self._rewrite_playlist_urls(body, source_url, vlc_token)
                    self._send_bytes(
                        response.getcode(),
                        rewritten.encode("utf-8"),
                        "application/vnd.apple.mpegurl",
                        extra_headers={"Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"},
                    )
                    return
                self.send_response(response.getcode())
                self.send_header("Content-Type", content_type)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Accept-Ranges", response.headers.get("Accept-Ranges", "bytes"))
                for header in ("Content-Length", "Content-Range"):
                    value = response.headers.get(header)
                    if value:
                        self.send_header(header, value)
                self.end_headers()
                if not send_body:
                    return
                while True:
                    chunk = response.read(1024 * 64)
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        break
        except urllib.error.HTTPError as exc:
            self._log_access(
                "vlc_proxy_error",
                status=exc.code,
                range=self.headers.get("Range", ""),
                content_range=exc.headers.get("Content-Range", ""),
                upstream_reason=getattr(exc, "reason", "") or "",
                source_path=urllib.parse.urlsplit(source_url).path[-120:],
            )
            self._send_upstream_media_error(exc, source_url)
        except (urllib.error.URLError, TimeoutError) as exc:
            self._log_access(
                "vlc_proxy_error",
                status=503,
                range=self.headers.get("Range", ""),
                upstream_reason=str(getattr(exc, "reason", exc))[:160],
                source_path=urllib.parse.urlsplit(source_url).path[-120:],
            )
            self._send_media_proxy_error(503, source_url)

    def _handle_media_proxy(self, send_body: bool = True) -> None:
        parsed_path = urllib.parse.urlsplit(self.path)
        path = parsed_path.path
        parts = [part for part in path.split("/") if part]
        query_params = urllib.parse.parse_qs(parsed_path.query)
        vlc_token = query_params.get("vt", [""])[0]
        if not parts or parts[0] != "media-proxy":
            self._send_json_error(404, "Rota nao encontrada")
            return
        if not vlc_token:
            self._send_json_error(401, "Token de midia obrigatorio")
            return
        token_info = self.server.resolve_vlc_token_info(vlc_token)
        source_url = str(token_info.get("url") or "")
        if not source_url:
            self._send_json_error(404, "Link de midia expirado ou invalido")
            return
        source_url = _validate_public_fetch_url(source_url)
        self.server.auth_store.touch_session(str(token_info.get("user_id") or ""), str(token_info.get("session_id") or ""))
        headers = _headers_for_source_url(source_url)
        if self.headers.get("Range"):
            headers["Range"] = self.headers["Range"]

        try:
            req = urllib.request.Request(source_url, headers=headers)
            with urllib.request.urlopen(req, timeout=self.server.service.download_timeout) as response:
                content_type = self._effective_media_type(source_url, response.headers.get("Content-Type"))
                self._log_access(
                    "media_proxy_request",
                    status=response.getcode(),
                    content_type=content_type,
                    range=self.headers.get("Range", ""),
                    content_range=response.headers.get("Content-Range", ""),
                    source_path=urllib.parse.urlsplit(source_url).path[-120:],
                )
                if self._is_playlist_response(source_url, content_type):
                    if not send_body:
                        self.send_response(response.getcode())
                        self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("Access-Control-Allow-Origin", "*")
                        self.end_headers()
                        return
                    body = response.read().decode("utf-8", errors="replace")
                    rewritten = self._rewrite_playlist_urls(body, source_url, vlc_token)
                    self._send_bytes(
                        response.getcode(),
                        rewritten.encode("utf-8"),
                        "application/vnd.apple.mpegurl",
                        extra_headers={"Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"},
                    )
                    return
                self.send_response(response.getcode())
                self.send_header("Content-Type", content_type)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Accept-Ranges", response.headers.get("Accept-Ranges", "bytes"))
                for header in ("Content-Length", "Content-Range"):
                    value = response.headers.get(header)
                    if value:
                        self.send_header(header, value)
                self.end_headers()
                if not send_body:
                    return
                while True:
                    chunk = response.read(1024 * 64)
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        break
        except urllib.error.HTTPError as exc:
            self._log_access(
                "media_proxy_error",
                status=exc.code,
                range=self.headers.get("Range", ""),
                content_range=exc.headers.get("Content-Range", ""),
                upstream_reason=getattr(exc, "reason", "") or "",
                source_path=urllib.parse.urlsplit(source_url).path[-120:],
            )
            self._send_upstream_media_error(exc, source_url)
        except (urllib.error.URLError, TimeoutError) as exc:
            self._log_access(
                "media_proxy_error",
                status=503,
                range=self.headers.get("Range", ""),
                upstream_reason=str(getattr(exc, "reason", exc))[:160],
                source_path=urllib.parse.urlsplit(source_url).path[-120:],
            )
            self._send_media_proxy_error(503, source_url)

    def _handle_transmux_proxy(self, send_body: bool = True) -> None:
        parsed_path = urllib.parse.urlsplit(self.path)
        parts = [part for part in parsed_path.path.split("/") if part]
        if len(parts) < 3 or parts[0] != "transmux":
            self._send_json_error(404, "Rota nao encontrada")
            return

        token = parts[1]
        filename = parts[-1]
        if "/" in filename or "\\" in filename or filename.startswith("."):
            self._send_json_error(400, "Arquivo invalido")
            return

        session = self.server.resolve_transmux_session(token)
        if not session:
            self._send_json_error(404, "Link HLS expirado ou invalido")
            return

        target = Path(str(session.get("dir") or "")) / filename
        if filename == "playlist.m3u8" and not target.exists():
            self.server.wait_for_transmux_playlist(token)
        if not target.exists() or not target.is_file():
            self._send_json_error(404, "Segmento ainda nao disponivel")
            return

        self.server.touch_transmux_session(token)
        self.server.auth_store.touch_session(str(session.get("user_id") or ""), str(session.get("session_id") or ""))
        content_type = "application/vnd.apple.mpegurl" if filename.endswith(".m3u8") else "video/mp2t"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(target.stat().st_size))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if not send_body:
            return
        try:
            with open(target, "rb") as handle:
                while True:
                    chunk = handle.read(1024 * 64)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            return

    def _send_upstream_media_error(self, exc: urllib.error.HTTPError, source_url: str) -> None:
        content_type = exc.headers.get("Content-Type") or self._effective_media_type(source_url)
        body = b""
        try:
            body = exc.read() or b""
        except Exception:
            body = b""
        self.send_response(exc.code)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Accept-Ranges", exc.headers.get("Accept-Ranges", "bytes"))
        for header in ("Content-Range",):
            value = exc.headers.get(header)
            if value:
                self.send_header(header, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                return

    def _send_media_proxy_error(self, status_code: int, source_url: str) -> None:
        self._send_bytes(
            status_code,
            b"",
            self._effective_media_type(source_url),
            extra_headers={
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*",
                "Accept-Ranges": "bytes",
            },
        )

    def _serve_static(self) -> None:
        raw_path = urllib.parse.urlsplit(self.path).path
        relative = raw_path.lstrip("/") or "index.html"
        if relative in {"admin", "admin/"}:
            relative = "admin.html"
        if relative in {"monitoring", "monitoring/"}:
            relative = "monitoring.html"
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
        url = _validate_public_fetch_url(url)
        request = urllib.request.Request(url, headers=self._origin_headers())
        timeout = max(self.server.service.download_timeout, float(os.getenv("PLAYLIST_FETCH_TIMEOUT", "45")))
        with urllib.request.urlopen(request, timeout=timeout) as response:
            content_length = int(response.headers.get("Content-Length") or 0)
            if content_length > MAX_REMOTE_PLAYLIST_BYTES:
                raise ValueError("Playlist remota excede o tamanho maximo permitido")
            body = response.read(MAX_REMOTE_PLAYLIST_BYTES + 1)
            if len(body) > MAX_REMOTE_PLAYLIST_BYTES:
                raise ValueError("Playlist remota excede o tamanho maximo permitido")
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

    def _origin_headers(self) -> Dict[str, str]:
        return _origin_headers()

    def _is_playlist_response(self, url: str, content_type: str) -> bool:
        path = urllib.parse.urlsplit(url).path.lower()
        lowered_type = (content_type or "").lower()
        return path.endswith(".m3u8") or "mpegurl" in lowered_type or "vnd.apple.mpegurl" in lowered_type

    def _effective_media_type(self, url: str, upstream_content_type: str = "") -> str:
        guessed = self._guess_media_type(url)
        if guessed != "application/octet-stream":
            return guessed
        return upstream_content_type or guessed

    def _external_stream_extension(self, mime_type: str, source_url: str) -> str:
        path = urllib.parse.urlsplit(source_url).path.lower()
        if mime_type == "application/vnd.apple.mpegurl" or path.endswith(".m3u8"):
            return ".m3u8"
        if mime_type == "video/mp2t" or path.endswith(".ts"):
            return ".ts"
        if mime_type == "video/mp4" or path.endswith(".mp4"):
            return ".mp4"
        return ".bin"

    def _should_transmux_for_browser(self, source_url: str, requested_kind: str = "") -> bool:
        if not _env_enabled("STREAM_TRANSMUX_MPEGTS_TO_HLS", True):
            return False
        path = urllib.parse.urlsplit(source_url).path.lower()
        return requested_kind == "mpegts" or self._guess_media_type(source_url) == "video/mp2t" or path.endswith(".ts") or "/live/" in path

    def _media_proxy_url(self, url: str, vlc_token: str = "") -> str:
        parent_info = self.server.resolve_vlc_token_info(vlc_token) if vlc_token else {}
        token = self.server.register_vlc_stream(
            _validate_public_fetch_url(url),
            str(parent_info.get("user_id") or ""),
            str(parent_info.get("session_id") or ""),
        )
        return f"{self._base_url()}/media-proxy?vt={urllib.parse.quote(token, safe='')}"

    def _rewrite_playlist_urls(self, playlist_text: str, playlist_url: str, vlc_token: str = "") -> str:
        def proxy_url(value: str) -> str:
            raw_value = value.strip()
            parsed_value = urllib.parse.urlsplit(raw_value)
            if parsed_value.scheme and parsed_value.scheme not in {"http", "https"}:
                return raw_value
            absolute_url = urllib.parse.urljoin(playlist_url, raw_value)
            return self._media_proxy_url(absolute_url, vlc_token)

        rewritten_lines = []
        uri_pattern = re.compile(r'URI="([^"]+)"')
        for raw_line in playlist_text.splitlines():
            line = raw_line.strip()
            if not line:
                rewritten_lines.append(raw_line)
                continue
            if line.startswith("#"):
                rewritten_lines.append(uri_pattern.sub(lambda match: f'URI="{proxy_url(match.group(1))}"', raw_line))
                continue
            rewritten_lines.append(proxy_url(line))
        return "\n".join(rewritten_lines) + "\n"

    def _guess_media_type(self, url: str) -> str:
        path = urllib.parse.urlsplit(url).path.lower()
        if path.endswith(".m3u8"):
            return "application/vnd.apple.mpegurl"
        if path.endswith(".ts") or "/live/" in path:
            return "video/mp2t"
        if path.endswith((".m4s", ".m4v")):
            return "video/iso.segment"
        if path.endswith(".mp4") or "/movie/" in path:
            return "video/mp4"
        if path.endswith(".aac"):
            return "audio/aac"
        if path.endswith(".mp3"):
            return "audio/mpeg"
        if path.endswith(".key"):
            return "application/octet-stream"
        return "application/octet-stream"

    def _read_json(self) -> Dict[str, str]:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length == 0:
            return {}
        if content_length > MAX_JSON_BODY_BYTES:
            raise AuthError("Payload excede o tamanho maximo permitido", 413)
        return json.loads(self.rfile.read(content_length).decode("utf-8"))

    def _check_rate_limit(self, method: str) -> None:
        path = urllib.parse.urlsplit(self.path).path
        if path in {"/healthz", "/readyz"}:
            return
        if path.startswith(("/media-proxy", "/vlc-proxy", "/proxy", "/transmux")):
            limit = int(os.getenv("RATE_LIMIT_MEDIA_PER_MINUTE", "240"))
            action = "media"
        elif path.startswith("/api/auth") or path.startswith("/api/admin"):
            limit = int(os.getenv("RATE_LIMIT_AUTH_PER_MINUTE", "30"))
            action = "auth"
        else:
            limit = int(os.getenv("RATE_LIMIT_DEFAULT_PER_MINUTE", "120"))
            action = method
        if not self.server.check_rate_limit(self._client_ip(), action, limit, 60):
            raise AuthError("Muitas requisicoes. Tente novamente em instantes.", 429)

    def _payload_int(self, payload: Dict, name: str, default: int) -> int:
        try:
            return int(payload.get(name) or default)
        except (TypeError, ValueError):
            return default

    def _payload_float(self, payload: Dict, name: str, default: float) -> float:
        try:
            return float(payload.get(name) or default)
        except (TypeError, ValueError):
            return default

    def _catalog_allowed_terms(self, auth: Dict) -> Optional[List[str]]:
        user = auth.get("user") or {}
        if user.get("catalog_access_mode") != "allowlist":
            return None
        return _normalized_catalog_terms(user.get("catalog_allowed_terms") or [])

    def _catalog_featured_sections(self, auth: Dict) -> Optional[List[Dict]]:
        user = auth.get("user") or {}
        if user.get("catalog_access_mode") != "allowlist":
            return None
        return _normalized_catalog_featured_sections(user.get("catalog_featured_sections") or [])

    def _require_catalog_playback_allowed(self, auth: Dict, source_url: str) -> None:
        user = auth.get("user") or {}
        if user.get("catalog_access_mode") != "allowlist":
            return
        if self.server.stream_allowed_for_user(source_url, user):
            return
        raise AuthError("Conteudo bloqueado nesta versao de teste.", 403)

    def _require_auth(self) -> Dict:
        auth_header = self.headers.get("Authorization", "")
        token = ""
        if auth_header.startswith("Bearer "):
            token = auth_header.split(" ", 1)[1].strip()
        if not token:
            token = self._cookie_value("stream_auth")
        if not token:
            raise AuthError("Login necessario")
        return self.server.auth_store.require_session(token)

    def _require_admin(self) -> None:
        expected_token = os.getenv("AUTH_ADMIN_TOKEN", "").strip() or os.getenv("AUTH_REGISTRATION_TOKEN", "").strip()
        if not expected_token:
            raise AuthError("Configure AUTH_ADMIN_TOKEN para acessar o gerenciamento", 403)
        provided_token = self.headers.get("X-Admin-Token", "").strip()
        auth_header = self.headers.get("Authorization", "")
        if not provided_token and auth_header.startswith("Bearer "):
            provided_token = auth_header.split(" ", 1)[1].strip()
        if not provided_token or not hmac.compare_digest(provided_token, expected_token):
            raise AuthError("Acesso administrativo negado", 403)

    def _admin_user_id_from_path(self) -> str:
        path = urllib.parse.urlsplit(self.path).path
        parts = path.split("/")
        if len(parts) < 5:
            raise AuthError("Usuario obrigatorio", 400)
        return urllib.parse.unquote(parts[4])

    def _admin_user_payload(self, user: Dict) -> Dict:
        payload = dict(user)
        payload["access_url"] = f"{self._base_url()}/access/{urllib.parse.quote(user.get('access_hash', ''), safe='')}"
        return payload

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
        try:
            self.server.auth_store.record_access_event(action, payload)
        except Exception:
            pass
        print(f"ACCESS {json.dumps(payload, ensure_ascii=False)}", flush=True)

    def _send_json(self, status_code: int, payload: Dict, extra_headers: Optional[Dict[str, str]] = None) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            return

    def _send_bytes(self, status_code: int, body: bytes, content_type: str, extra_headers: Optional[Dict[str, str]] = None) -> None:
        self.send_response(status_code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            return

    def _send_json_error(self, status_code: int, message: str) -> None:
        self._send_json(status_code, {"error": message})

    def _auth_cookie_header(self, token: str, max_age: Optional[int] = None) -> str:
        attrs = [f"stream_auth={token}", "Path=/", "HttpOnly", "SameSite=Lax"]
        if max_age is not None:
            attrs.append(f"Max-Age={max_age}")
        if self._base_url().startswith("https://"):
            attrs.append("Secure")
        return "; ".join(attrs)

    def _clear_auth_cookie_header(self) -> str:
        attrs = ["stream_auth=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"]
        if self._base_url().startswith("https://"):
            attrs.append("Secure")
        return "; ".join(attrs)

    def _cookie_value(self, name: str) -> str:
        cookies = self.headers.get("Cookie", "")
        for item in cookies.split(";"):
            key, _, value = item.strip().partition("=")
            if key == name:
                return value
        return ""

    def log_message(self, format, *args):
        return


class StreamApplicationServer(ThreadingHTTPServer):
    def __init__(self, server_address, handler_cls, service: Optional[StreamBufferingService] = None):
        super().__init__(server_address, handler_cls)
        self.service = service or StreamBufferingService()
        self.auth_store = AuthStore(_auth_db_path())
        self.playlist_cache: Dict[str, List[Dict[str, str]]] = {}
        self.playlist_catalog_cache: Dict[str, PlaylistCatalog] = {}
        self.playlist_index_lock = threading.Lock()
        self.cache_job_lock = threading.Lock()
        self.cache_job = self._empty_cache_job()
        self.cache_log_state = {"phase": "", "downloaded_bytes": -1, "entry_count": 0}
        self.vlc_token_lock = threading.Lock()
        self.vlc_tokens: Dict[str, Dict[str, object]] = {}
        self.transmux_lock = threading.Lock()
        self.transmux_sessions: Dict[str, Dict[str, object]] = {}
        self.rate_limit_lock = threading.Lock()
        self.rate_limit_windows: Dict[Tuple[str, str], List[float]] = {}
        self.preloaded_load_lock = threading.Lock()
        self.preloaded_load_status = {
            "status": "idle",
            "message": "Playlist salva ainda nao carregada.",
            "playlist_id": "",
            "error": "",
        }

    def check_rate_limit(self, client_ip: str, action: str, limit: int, window_seconds: int) -> bool:
        if limit <= 0:
            return True
        now = time.time()
        cutoff = now - window_seconds
        key = (client_ip or "unknown", action)
        with self.rate_limit_lock:
            requests = [timestamp for timestamp in self.rate_limit_windows.get(key, []) if timestamp >= cutoff]
            if len(requests) >= limit:
                self.rate_limit_windows[key] = requests
                return False
            requests.append(now)
            self.rate_limit_windows[key] = requests
            if len(self.rate_limit_windows) > 5000:
                self.rate_limit_windows = {
                    item_key: values
                    for item_key, values in self.rate_limit_windows.items()
                    if values and values[-1] >= cutoff
                }
        return True

    def start_transmux_hls(self, stream_id: str, source_url: str, base_url: str, user_id: str = "", session_id: str = "") -> Dict[str, str]:
        if shutil.which("ffmpeg") is None:
            raise StreamConfigurationError("ffmpeg nao esta instalado no container")

        self._prune_transmux_sessions()
        token = secrets.token_urlsafe(24)
        root = Path(os.getenv("TRANSMUX_CACHE_ROOT", str(self.service.cache_root / "transmux")))
        session_dir = root / token
        session_dir.mkdir(parents=True, exist_ok=True)
        playlist_path = session_dir / "playlist.m3u8"
        stderr_path = session_dir / "ffmpeg.log"
        segment_pattern = str(session_dir / "segment_%05d.ts")
        hls_time = os.getenv("TRANSMUX_HLS_TIME_SECONDS", "3")
        hls_list_size = os.getenv("TRANSMUX_HLS_LIST_SIZE", "8")
        command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            os.getenv("TRANSMUX_FFMPEG_LOGLEVEL", "warning"),
            "-nostdin",
            "-user_agent",
            os.getenv("STREAM_USER_AGENT", "Mozilla/5.0"),
            "-reconnect",
            "1",
            "-reconnect_streamed",
            "1",
            "-reconnect_delay_max",
            "5",
            "-i",
            source_url,
            "-map",
            "0:v:0?",
            "-map",
            "0:a:0?",
            "-c",
            "copy",
            "-f",
            "hls",
            "-hls_time",
            hls_time,
            "-hls_list_size",
            hls_list_size,
            "-hls_flags",
            "delete_segments+append_list+omit_endlist+independent_segments",
            "-hls_segment_filename",
            segment_pattern,
            str(playlist_path),
        ]
        stderr_handle = open(stderr_path, "ab")
        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.DEVNULL,
                stderr=stderr_handle,
                close_fds=True,
            )
        except Exception:
            stderr_handle.close()
            shutil.rmtree(session_dir, ignore_errors=True)
            raise

        now = time.time()
        with self.transmux_lock:
            self.transmux_sessions[token] = {
                "stream_id": stream_id,
                "url": source_url,
                "dir": str(session_dir),
                "playlist": str(playlist_path),
                "process": process,
                "stderr": stderr_handle,
                "user_id": user_id,
                "session_id": session_id,
                "created_at": now,
                "last_access": now,
                "expires_at": now + float(os.getenv("TRANSMUX_SESSION_TTL_SECONDS", str(2 * 60 * 60))),
            }

        self.wait_for_transmux_playlist(token)
        return {
            "local_proxy_url": f"{base_url.rstrip('/')}/transmux/{urllib.parse.quote(token, safe='')}/playlist.m3u8",
            "status": "transmuxing",
            "media_kind": "hls",
        }

    def resolve_transmux_session(self, token: str) -> Dict[str, object]:
        with self.transmux_lock:
            self._prune_transmux_sessions_locked()
            session = self.transmux_sessions.get(token)
            if not session:
                return {}
            return dict(session)

    def touch_transmux_session(self, token: str) -> None:
        with self.transmux_lock:
            session = self.transmux_sessions.get(token)
            if session:
                session["last_access"] = time.time()

    def wait_for_transmux_playlist(self, token: str) -> bool:
        timeout = float(os.getenv("TRANSMUX_START_TIMEOUT_SECONDS", "8"))
        deadline = time.time() + timeout
        while time.time() < deadline:
            session = self.resolve_transmux_session(token)
            if not session:
                return False
            playlist = Path(str(session.get("playlist") or ""))
            if playlist.exists() and playlist.stat().st_size > 0:
                return True
            process = session.get("process")
            if isinstance(process, subprocess.Popen) and process.poll() is not None:
                return False
            time.sleep(0.2)
        return False

    def stop_transmux_stream(self, stream_id: str, user_id: str = "", session_id: str = "") -> None:
        with self.transmux_lock:
            tokens = [
                token
                for token, session in self.transmux_sessions.items()
                if session.get("stream_id") == stream_id
                and (not user_id or session.get("user_id") == user_id)
                and (not session_id or session.get("session_id") == session_id)
            ]
        for token in tokens:
            self._stop_transmux_session(token)

    def _stop_transmux_session(self, token: str) -> None:
        with self.transmux_lock:
            session = self.transmux_sessions.pop(token, None)
        if not session:
            return
        process = session.get("process")
        if isinstance(process, subprocess.Popen) and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
        stderr = session.get("stderr")
        try:
            if stderr:
                stderr.close()
        except Exception:
            pass
        shutil.rmtree(str(session.get("dir") or ""), ignore_errors=True)

    def _prune_transmux_sessions(self) -> None:
        with self.transmux_lock:
            tokens = self._expired_transmux_tokens_locked()
        for token in tokens:
            self._stop_transmux_session(token)

    def _prune_transmux_sessions_locked(self) -> None:
        tokens = self._expired_transmux_tokens_locked()
        for token in tokens:
            session = self.transmux_sessions.pop(token, None)
            if session:
                process = session.get("process")
                if isinstance(process, subprocess.Popen) and process.poll() is None:
                    process.terminate()
                stderr = session.get("stderr")
                try:
                    if stderr:
                        stderr.close()
                except Exception:
                    pass
                shutil.rmtree(str(session.get("dir") or ""), ignore_errors=True)

    def _expired_transmux_tokens_locked(self) -> List[str]:
        now = time.time()
        return [
            token
            for token, session in self.transmux_sessions.items()
            if float(session.get("expires_at") or 0) <= now
            or (now - float(session.get("last_access") or 0)) > float(os.getenv("TRANSMUX_IDLE_TTL_SECONDS", str(15 * 60)))
        ]

    def register_vlc_stream(self, source_url: str, user_id: str = "", session_id: str = "") -> str:
        token = secrets.token_urlsafe(24)
        expires_at = time.time() + float(os.getenv("VLC_PROXY_TOKEN_TTL_SECONDS", str(6 * 60 * 60)))
        with self.vlc_token_lock:
            self._prune_vlc_tokens_locked()
            self.vlc_tokens[token] = {"url": source_url, "user_id": user_id, "session_id": session_id, "expires_at": expires_at}
        return token

    def resolve_vlc_token(self, token: str) -> str:
        return str(self.resolve_vlc_token_info(token).get("url") or "")

    def resolve_vlc_token_info(self, token: str) -> Dict[str, object]:
        with self.vlc_token_lock:
            self._prune_vlc_tokens_locked()
            entry = self.vlc_tokens.get(token)
            if not entry:
                return {}
            return dict(entry)

    def _prune_vlc_tokens_locked(self) -> None:
        now = time.time()
        expired = [
            token
            for token, entry in self.vlc_tokens.items()
            if float(entry.get("expires_at") or 0) <= now
        ]
        for token in expired:
            self.vlc_tokens.pop(token, None)

    def set_playlist_entries(self, playlist_id: str, entries: List[Dict[str, str]], clear: bool = False) -> None:
        catalog = PlaylistCatalog(entries, build_series_index=True)
        self.set_playlist_catalog(playlist_id, catalog, clear=clear)

    def set_playlist_catalog(self, playlist_id: str, catalog: PlaylistCatalog, clear: bool = False) -> None:
        with self.playlist_index_lock:
            if clear:
                self.playlist_cache.clear()
                self.playlist_catalog_cache.clear()
            self.playlist_cache[playlist_id] = catalog.entries
            self.playlist_catalog_cache[playlist_id] = catalog

    def playlist_response(
        self,
        playlist_id: str,
        category: str,
        group: str,
        query: str,
        offset: int,
        limit: int,
        series_key: str = "",
        season: str = "",
        include_adult: bool = False,
        allowed_terms: Optional[List[str]] = None,
        featured_sections: Optional[List[Dict]] = None,
        access_seed: str = "",
    ) -> Dict:
        with self.playlist_index_lock:
            catalog = self.playlist_catalog_cache.get(playlist_id)
        if catalog is None:
            raise ValueError("Playlist nao encontrada no catalogo local.")
        return catalog.response(
            playlist_id,
            category,
            group,
            query,
            offset,
            limit,
            series_key=series_key,
            season=season,
            include_adult=include_adult,
            allowed_terms=allowed_terms,
            featured_sections=featured_sections,
            access_seed=access_seed,
        )

    def trial_catalog_response(
        self,
        playlist_id: str,
        sections: List[Dict],
        include_adult: bool = False,
        seed: str = "",
    ) -> Dict:
        with self.playlist_index_lock:
            catalog = self.playlist_catalog_cache.get(playlist_id)
        if catalog is None:
            raise ValueError("Playlist nao encontrada no catalogo local.")
        return catalog.featured_sections(playlist_id, sections, include_adult=include_adult, seed=seed)

    def stream_allowed_for_user(self, source_url: str, user: Dict) -> bool:
        if user.get("catalog_access_mode") != "allowlist":
            return True
        allowed_terms = _normalized_catalog_terms(user.get("catalog_allowed_terms") or [])
        featured_sections = _normalized_catalog_featured_sections(user.get("catalog_featured_sections") or [])
        include_adult = bool(user.get("allow_adult_content"))
        seed = str(user.get("id") or "")
        with self.playlist_index_lock:
            catalogs = list(self.playlist_catalog_cache.values())
        for catalog in catalogs:
            allowed = catalog.allowed_indices(allowed_terms, featured_sections, include_adult=include_adult, seed=seed)
            for index in allowed:
                if catalog.entries[index].get("url") == source_url:
                    return True
        return False

    def prepare_search_index(self, playlist_id: str) -> None:
        with self.playlist_index_lock:
            catalog = self.playlist_catalog_cache.get(playlist_id)
        if catalog is None:
            raise ValueError("Playlist nao encontrada no catalogo local.")
        catalog._ensure_series_index()

    def cache_preloaded_playlist(self, url: str, progress=None) -> Tuple[str, int, int]:
        url = _validate_public_fetch_url(url)
        path = Path(os.getenv("PRELOADED_PLAYLIST_PATH", str(DEFAULT_PRELOADED_PLAYLIST_PATH)))
        path.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(url, headers=_origin_headers())
        timeout = max(self.service.download_timeout, float(os.getenv("PLAYLIST_FETCH_TIMEOUT", "90")))

        total_bytes = 0
        temp_path = None
        download_completed = False
        content_hash = hashlib.sha256()
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                content_length = int(response.headers.get("Content-Length") or 0)
                if content_length > MAX_REMOTE_PLAYLIST_BYTES:
                    raise ValueError("Playlist remota excede o tamanho maximo permitido")
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
                        content_hash.update(chunk)
                        total_bytes += len(chunk)
                        if total_bytes > MAX_REMOTE_PLAYLIST_BYTES:
                            raise ValueError("Playlist remota excede o tamanho maximo permitido")
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

        content_digest = content_hash.hexdigest()
        parsed_path = path.with_suffix(path.suffix + ".entries.json")
        parsed_pickle_path = path.with_suffix(path.suffix + ".entries.pickle")
        parsed_catalog_path = path.with_suffix(path.suffix + ".catalog.pickle")
        digest_path = path.with_suffix(path.suffix + ".sha256")
        playlist_id = _playlist_id(f"preloaded:{path.resolve()}:{content_digest}")

        has_same_digest = digest_path.exists() and digest_path.read_text(encoding="utf-8").strip() == content_digest
        if has_same_digest:
            catalog = self._load_parsed_catalog_cache(parsed_catalog_path)
            entries = catalog.entries if catalog else self._read_cached_playlist_entries(
                path,
                parsed_path,
                parsed_pickle_path,
                content_digest,
                total_bytes,
            )
            if entries is not None:
                if temp_path and temp_path.exists():
                    temp_path.unlink()
                    temp_path = None
                if path.exists():
                    os.utime(path, None)
                if progress:
                    progress(
                        phase="cache-check",
                        message="Playlist remota sem mudancas. Reutilizando cache processado...",
                        downloaded_bytes=total_bytes,
                        total_bytes=total_bytes,
                        entry_count=len(entries),
                    )
                if catalog is None or getattr(catalog, "_needs_cache_refresh", False):
                    catalog = PlaylistCatalog(entries, build_series_index=True)
                    self._write_parsed_catalog_cache(parsed_catalog_path, catalog)
                self.set_playlist_catalog(playlist_id, catalog, clear=True)
                with self.preloaded_load_lock:
                    self.preloaded_load_status = {
                        "status": "done",
                        "message": "Playlist carregada.",
                        "playlist_id": playlist_id,
                        "error": "",
                    }
                return playlist_id, total_bytes, len(entries)

        parsed_cache_paths = [
            parsed_path,
            parsed_pickle_path,
            parsed_pickle_path.with_suffix(parsed_pickle_path.suffix + ".sig"),
            parsed_catalog_path,
            parsed_catalog_path.with_suffix(parsed_catalog_path.suffix + ".sig"),
            parsed_catalog_path.with_suffix(parsed_catalog_path.suffix + ".version"),
            digest_path,
        ]
        for cache_path in parsed_cache_paths:
            if cache_path.exists():
                cache_path.unlink()
        if progress:
            progress(
                phase="cache-check",
                message="Cache processado removido. Processando playlist baixada do zero...",
                downloaded_bytes=total_bytes,
                total_bytes=total_bytes,
            )
        if progress:
            progress(
                phase="parsing",
                message="Processando playlist baixada...",
                downloaded_bytes=total_bytes,
                total_bytes=total_bytes,
            )
        temp_path.replace(path)
        temp_path = None
        entries = self._parse_playlist_file(path, url, progress=progress)
        with tempfile.NamedTemporaryFile("wb", delete=False, dir=path.parent) as temp_file:
            parsed_temp_path = Path(temp_file.name)
            pickle.dump(entries, temp_file, protocol=pickle.HIGHEST_PROTOCOL)
        parsed_temp_path.replace(parsed_pickle_path)
        self._write_pickle_signature(parsed_pickle_path)
        digest_path.write_text(content_digest, encoding="utf-8")

        if progress:
            progress(
                phase="indexing",
                message="Montando indice de busca da playlist...",
                downloaded_bytes=total_bytes,
                total_bytes=total_bytes,
                entry_count=len(entries),
            )
        catalog = PlaylistCatalog(entries, build_series_index=True)
        self._write_parsed_catalog_cache(parsed_catalog_path, catalog)
        self.set_playlist_catalog(playlist_id, catalog, clear=True)
        with self.preloaded_load_lock:
            self.preloaded_load_status = {
                "status": "done",
                "phase": "done",
                "message": "Playlist carregada.",
                "playlist_id": playlist_id,
                "error": "",
            }
        return playlist_id, total_bytes, len(entries)

    def _read_cached_playlist_entries(
        self,
        path: Path,
        parsed_path: Path,
        parsed_pickle_path: Path,
        content_digest: str,
        total_bytes: int,
    ) -> Optional[List[Dict[str, str]]]:
        if not parsed_path.exists() and not parsed_pickle_path.exists():
            return None

        digest_path = path.with_suffix(path.suffix + ".sha256")
        if digest_path.exists() and digest_path.read_text(encoding="utf-8").strip() == content_digest:
            return self._load_parsed_entries_cache(parsed_path, parsed_pickle_path)

        if path.exists() and path.stat().st_size == total_bytes and self._file_sha256(path) == content_digest:
            digest_path.write_text(content_digest, encoding="utf-8")
            return self._load_parsed_entries_cache(parsed_path, parsed_pickle_path)

        return None

    def _load_parsed_entries_cache(self, parsed_path: Path, parsed_pickle_path: Path) -> Optional[List[Dict[str, str]]]:
        if parsed_pickle_path.exists():
            if not self._verify_pickle_signature(parsed_pickle_path):
                return json.loads(parsed_path.read_text(encoding="utf-8")) if parsed_path.exists() else None
            with parsed_pickle_path.open("rb") as file:
                return pickle.load(file)
        return json.loads(parsed_path.read_text(encoding="utf-8")) if parsed_path.exists() else None

    def _load_parsed_catalog_cache(self, parsed_catalog_path: Path) -> Optional[PlaylistCatalog]:
        if not parsed_catalog_path.exists():
            return None
        if not self._verify_pickle_signature(parsed_catalog_path):
            return None
        version_path = parsed_catalog_path.with_suffix(parsed_catalog_path.suffix + ".version")
        if not version_path.exists() or version_path.read_text(encoding="utf-8").strip() != str(PLAYLIST_CATALOG_CACHE_VERSION):
            return None
        with parsed_catalog_path.open("rb") as file:
            catalog = pickle.load(file)
        if not isinstance(catalog, PlaylistCatalog):
            return None
        return catalog

    def _write_parsed_catalog_cache(self, parsed_catalog_path: Path, catalog: PlaylistCatalog) -> None:
        with tempfile.NamedTemporaryFile("wb", delete=False, dir=parsed_catalog_path.parent) as temp_file:
            parsed_temp_path = Path(temp_file.name)
            pickle.dump(catalog, temp_file, protocol=pickle.HIGHEST_PROTOCOL)
        parsed_temp_path.replace(parsed_catalog_path)
        self._write_pickle_signature(parsed_catalog_path)
        parsed_catalog_path.with_suffix(parsed_catalog_path.suffix + ".version").write_text(
            str(PLAYLIST_CATALOG_CACHE_VERSION),
            encoding="utf-8",
        )

    def _pickle_signature_path(self, path: Path) -> Path:
        return path.with_suffix(path.suffix + ".sig")

    def _pickle_signature(self, path: Path) -> str:
        digest = hmac.new(_auth_token_secret().encode("utf-8"), digestmod=hashlib.sha256)
        with path.open("rb") as file:
            while True:
                chunk = file.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
        return digest.hexdigest()

    def _write_pickle_signature(self, path: Path) -> None:
        self._pickle_signature_path(path).write_text(self._pickle_signature(path), encoding="utf-8")

    def _verify_pickle_signature(self, path: Path) -> bool:
        signature_path = self._pickle_signature_path(path)
        if not signature_path.exists():
            return False
        expected = signature_path.read_text(encoding="utf-8").strip()
        return hmac.compare_digest(expected, self._pickle_signature(path))

    def _file_sha256(self, path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as file:
            while True:
                chunk = file.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
        return digest.hexdigest()

    def _parse_playlist_file(self, path: Path, source_url: str = "", progress=None) -> List[Dict[str, str]]:
        try:
            with path.open("r", encoding="utf-8") as playlist_file:
                return parse_playlist_entries_from_lines(playlist_file, source_url, progress=progress)
        except UnicodeDecodeError:
            with path.open("r", encoding="latin-1") as playlist_file:
                return parse_playlist_entries_from_lines(playlist_file, source_url, progress=progress)

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
                "phase": "loading-cache",
                "message": "Carregando playlist salva...",
                "playlist_id": "",
                "error": "",
            }

        threading.Thread(target=self._load_preloaded_background, args=(loader,), daemon=True).start()
        with self.preloaded_load_lock:
            return dict(self.preloaded_load_status)

    def preloaded_playlist_status(self) -> Dict:
        with self.preloaded_load_lock:
            status = dict(self.preloaded_load_status)
            playlist_id = status.get("playlist_id") or ""
            if status.get("status") == "done" and playlist_id in self.playlist_cache:
                return status
            if status.get("status") == "loading":
                snapshot = self.cache_job_snapshot()
                return {**status, "phase": status.get("phase") or snapshot.get("phase") or "loading-cache"}

        cache_status = self.cache_job_snapshot()
        if cache_status.get("status") == "running":
            return {
                "status": "loading",
                "phase": cache_status.get("phase") or "starting",
                "message": cache_status.get("message") or "Atualizando playlist salva...",
                "playlist_id": "",
                "error": "",
                "downloaded_bytes": cache_status.get("downloaded_bytes") or 0,
                "total_bytes": cache_status.get("total_bytes") or 0,
                "entry_count": cache_status.get("entry_count") or 0,
            }

        path = Path(os.getenv("PRELOADED_PLAYLIST_PATH", str(DEFAULT_PRELOADED_PLAYLIST_PATH)))
        if not path.exists():
            return {
                "status": "error",
                "phase": "error",
                "message": "Playlist pre-carregada nao encontrada.",
                "playlist_id": "",
                "error": f"Playlist pre-carregada nao encontrada: {path}",
            }

        return self.start_preloaded_load(self.load_preloaded_playlist_before_serving)

    def _load_preloaded_background(self, loader) -> None:
        try:
            playlist_id = loader()
            with self.preloaded_load_lock:
                self.preloaded_load_status["phase"] = "indexing"
                self.preloaded_load_status["message"] = "Preparando busca da playlist..."
            self.prepare_search_index(playlist_id)
            with self.preloaded_load_lock:
                self.preloaded_load_status = {
                    "status": "done",
                    "phase": "done",
                    "message": "Playlist carregada.",
                    "playlist_id": playlist_id,
                    "error": "",
                }
        except Exception as exc:
            with self.preloaded_load_lock:
                self.preloaded_load_status = {
                    "status": "error",
                    "phase": "error",
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
        entry_count = int(snapshot.get("entry_count") or 0)
        previous_phase = self.cache_log_state.get("phase")
        previous_downloaded = int(self.cache_log_state.get("downloaded_bytes") or 0)
        previous_entry_count = int(self.cache_log_state.get("entry_count") or 0)
        should_log = phase != previous_phase or downloaded == 0
        should_log = should_log or downloaded - previous_downloaded >= 25 * 1024 * 1024
        should_log = should_log or entry_count - previous_entry_count >= 25000
        should_log = should_log or snapshot.get("status") in {"done", "error"}
        if not should_log:
            return

        self.cache_log_state = {"phase": phase, "downloaded_bytes": downloaded, "entry_count": entry_count}
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

        interval_seconds = float(os.getenv("PLAYLIST_REFRESH_INTERVAL_SECONDS", str(6 * 60 * 60)))
        if interval_seconds <= 0:
            print("Playlist auto refresh disabled by configuration.", flush=True)
            return

        def refresh_loop() -> None:
            while True:
                age = self._preloaded_playlist_age_seconds()
                max_age = self._playlist_max_age_seconds()
                if age is not None and max_age > 0 and age < max_age:
                    time.sleep(max(min(max_age - age, interval_seconds), 60))
                    continue
                if age is None:
                    time.sleep(min(interval_seconds, 60))
                print("Starting scheduled playlist refresh.", flush=True)
                self._start_scheduled_playlist_refresh(playlist_url)
                time.sleep(interval_seconds)

        thread = threading.Thread(target=refresh_loop, daemon=True)
        thread.start()

    def _start_scheduled_playlist_refresh(self, playlist_url: str) -> None:
        started = self.start_playlist_cache_job(playlist_url, self.cache_preloaded_playlist)
        if not started:
            print("Skipping scheduled playlist refresh: another cache job is running.", flush=True)

    def _playlist_max_age_seconds(self) -> float:
        return float(os.getenv("PLAYLIST_MAX_AGE_SECONDS", str(6 * 60 * 60)))

    def _preloaded_playlist_age_seconds(self) -> Optional[float]:
        path = Path(os.getenv("PRELOADED_PLAYLIST_PATH", str(DEFAULT_PRELOADED_PLAYLIST_PATH)))
        if not path.exists():
            return None
        return max(time.time() - path.stat().st_mtime, 0)

    def _is_preloaded_playlist_fresh(self) -> bool:
        max_age = self._playlist_max_age_seconds()
        if max_age <= 0:
            return True
        age = self._preloaded_playlist_age_seconds()
        return age is not None and age <= max_age

    def run_startup_playlist_refresh(self) -> None:
        playlist_url = (os.getenv("PLAYLIST_CACHE_URL") or os.getenv("PLAYLIST_URL") or "").strip()
        if not playlist_url or not _env_enabled("PLAYLIST_REFRESH_ON_STARTUP", True):
            return

        age = self._preloaded_playlist_age_seconds()
        if self._is_preloaded_playlist_fresh():
            print(
                f"Skipping startup playlist refresh: local playlist is still fresh ({age / 3600:.1f}h old).",
                flush=True,
            )
            if _env_enabled("PLAYLIST_LOAD_BEFORE_SERVING", False):
                return
            started = self.start_preloaded_load(self.load_preloaded_playlist_before_serving)
            if started.get("status") == "loading":
                print("Starting background local playlist load.", flush=True)
            return

        if age is not None:
            print(
                f"Replacing existing playlist on startup ({age / 3600:.1f}h old).",
                flush=True,
            )
        else:
            print("Downloading playlist on startup before serving HTTP.", flush=True)

        if not _env_enabled("PLAYLIST_LOAD_BEFORE_SERVING", False):
            print("Starting background playlist refresh on startup.", flush=True)
            started = self.start_playlist_cache_job(playlist_url, self.cache_preloaded_playlist)
            if not started:
                print("Skipping startup playlist refresh: another cache job is running.", flush=True)
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
            if self._load_existing_playlist_after_refresh_failure():
                print(f"Startup playlist refresh failed; loaded existing cache instead: {exc}", flush=True)
                return
            if _env_enabled("PLAYLIST_REFRESH_REQUIRED_ON_STARTUP", True):
                raise
            print(f"Playlist refresh failed on startup: {exc}", flush=True)

    def _load_existing_playlist_after_refresh_failure(self) -> bool:
        path = Path(os.getenv("PRELOADED_PLAYLIST_PATH", str(DEFAULT_PRELOADED_PLAYLIST_PATH)))
        if not path.exists():
            return False
        try:
            self.load_preloaded_playlist_before_serving()
            return True
        except Exception as fallback_exc:
            print(f"Failed to load existing playlist cache after refresh failure: {fallback_exc}", flush=True)
            return False

    def load_preloaded_playlist_before_serving(self) -> str:
        with self.preloaded_load_lock:
            status = dict(self.preloaded_load_status)
        if status.get("status") == "done" and status.get("playlist_id") in self.playlist_cache:
            return status.get("playlist_id")

        path = Path(os.getenv("PRELOADED_PLAYLIST_PATH", str(DEFAULT_PRELOADED_PLAYLIST_PATH)))
        if not path.exists():
            if _env_enabled("PLAYLIST_REQUIRED_ON_STARTUP", True):
                raise FileNotFoundError(f"Playlist pre-carregada nao encontrada: {path}")
            print(f"Skipping startup playlist load: {path} not found.", flush=True)
            return ""

        print("Loading preloaded playlist from local cache.", flush=True)
        total_bytes = path.stat().st_size
        self._update_cache_job(
            status="running",
            phase="loading-cache",
            message="Carregando playlist local cacheada...",
            downloaded_bytes=total_bytes,
            total_bytes=total_bytes,
            entry_count=0,
            error="",
        )
        content_digest = self._file_sha256(path)
        parsed_path = path.with_suffix(path.suffix + ".entries.json")
        parsed_pickle_path = path.with_suffix(path.suffix + ".entries.pickle")
        parsed_catalog_path = path.with_suffix(path.suffix + ".catalog.pickle")
        digest_path = path.with_suffix(path.suffix + ".sha256")
        has_valid_digest = digest_path.exists() and digest_path.read_text(encoding="utf-8").strip() == content_digest
        catalog = self._load_parsed_catalog_cache(parsed_catalog_path) if has_valid_digest else None
        if catalog is not None:
            self._update_cache_job(
                phase="loading-cache",
                message="Catalogo indexado encontrado. Carregando em memoria...",
                downloaded_bytes=total_bytes,
                total_bytes=total_bytes,
                entry_count=len(catalog.entries),
            )
        entries = catalog.entries if catalog else self._read_cached_playlist_entries(
            path,
            parsed_path,
            parsed_pickle_path,
            content_digest,
            total_bytes,
        )
        if entries is None:
            print("Parsed playlist cache not found. Parsing local playlist.", flush=True)
            self._update_cache_job(
                phase="parsing",
                message="Cache parseado nao encontrado. Processando playlist local...",
                downloaded_bytes=total_bytes,
                total_bytes=total_bytes,
                entry_count=0,
            )
            entries = self._parse_playlist_file(path, "", progress=self._update_cache_job)
            with tempfile.NamedTemporaryFile("wb", delete=False, dir=path.parent) as temp_file:
                parsed_temp_path = Path(temp_file.name)
                pickle.dump(entries, temp_file, protocol=pickle.HIGHEST_PROTOCOL)
            parsed_temp_path.replace(parsed_pickle_path)
            self._write_pickle_signature(parsed_pickle_path)
            path.with_suffix(path.suffix + ".sha256").write_text(content_digest, encoding="utf-8")

        playlist_id = _playlist_id(f"preloaded:{path.resolve()}:{content_digest}")
        if catalog is None or getattr(catalog, "_needs_cache_refresh", False) or not getattr(catalog, "series_index_ready", False):
            self._update_cache_job(
                phase="indexing",
                message="Montando indice local da playlist...",
                downloaded_bytes=total_bytes,
                total_bytes=total_bytes,
                entry_count=len(entries),
            )
            catalog = PlaylistCatalog(entries, build_series_index=True)
            self._write_parsed_catalog_cache(parsed_catalog_path, catalog)
        else:
            self._update_cache_job(
                phase="indexing",
                message="Indice local pronto. Publicando catalogo...",
                downloaded_bytes=total_bytes,
                total_bytes=total_bytes,
                entry_count=len(entries),
            )
        self.set_playlist_catalog(playlist_id, catalog, clear=True)
        with self.preloaded_load_lock:
            self.preloaded_load_status = {
                "status": "done",
                "message": "Playlist carregada.",
                "playlist_id": playlist_id,
                "error": "",
            }
        with self.cache_job_lock:
            now = time.time()
            self.cache_job = {
                "status": "done",
                "phase": "done",
                "message": "Playlist local carregada.",
                "downloaded_bytes": total_bytes,
                "total_bytes": total_bytes,
                "entry_count": len(entries),
                "error": "",
                "started_at": now,
                "updated_at": now,
            }
        print(f"Preloaded playlist ready ({len(entries)} entries).", flush=True)
        self._update_cache_job(
            status="done",
            phase="done",
            message="Playlist local carregada e indexada.",
            downloaded_bytes=total_bytes,
            total_bytes=total_bytes,
            entry_count=len(entries),
            error="",
        )
        return playlist_id

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
        except (
            InvalidPlaylistError,
            http.client.IncompleteRead,
            urllib.error.URLError,
            TimeoutError,
            socket.timeout,
            OSError,
            ValueError,
        ) as exc:
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
    _validate_production_secrets()
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    service = StreamBufferingService(
        buffer_seconds=int(os.getenv("STREAM_BUFFER_SECONDS", "150")),
        download_timeout=float(os.getenv("STREAM_DOWNLOAD_TIMEOUT", "10")),
        poll_interval=float(os.getenv("STREAM_POLL_INTERVAL", "0.5")),
        max_cache_bytes=int(os.getenv("STREAM_MAX_CACHE_BYTES", str(200 * 1024 * 1024))),
    )
    server = create_server(host=host, port=port, service=service)
    server.run_startup_playlist_refresh()
    if _env_enabled("PLAYLIST_LOAD_BEFORE_SERVING", False):
        server.load_preloaded_playlist_before_serving()
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

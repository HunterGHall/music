import hashlib
import json
import logging
import os
import re
import subprocess
import sys
import shutil
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory, send_file

BASE_DIR = Path(__file__).resolve().parent
LIBRARY_DIR = BASE_DIR / "library"
COVERS_DIR = LIBRARY_DIR / "covers"
DATA_DIR = BASE_DIR / "data"
PLAYLISTS_FILE = DATA_DIR / "playlists.json"
STATS_FILE = DATA_DIR / "stats.json"
SETTINGS_FILE = DATA_DIR / "settings.json"
SOURCES_FILE = DATA_DIR / "sources.json"
SYNC_FILE = DATA_DIR / "spotify_sync.json"    # watched-playlist state: seen + pending tracks
LOUDNESS_FILE = DATA_DIR / "loudness.json"
META_FILE = DATA_DIR / "metadata.json"        # user-edited title/artist per track
PLAYER_STATE_FILE = DATA_DIR / "player_state.json"
PLAYLIST_COVERS_DIR = DATA_DIR / "playlist_covers"  # custom playlist covers, <playlist id>.jpg
LYRICS_DIR = DATA_DIR / "lyrics"              # cached lyrics lookups, one file per track
LRCLIB_URL = "https://lrclib.net/api/search"  # free, open lyrics database (no key needed)
TRANSITION_MODES = ("off", "gapless", "crossfade")
DEFAULT_SETTINGS = {
    "accent_color": "#ff8a3d",
    "idle_timeout_minutes": 2,
    "normalize_volume": True,
    "transition_mode": "gapless",   # off | gapless | crossfade
    "crossfade_seconds": 5,
    "lyrics_enabled": True,
    "spotify_sync_url": "",         # Spotify playlist watched for new songs ("" = off)
}
TARGET_LUFS = -14.0  # what every track is levelled to (streaming-service norm)
STATIC_DIR = BASE_DIR / "static"
AUDIO_EXTS = (".mp3", ".wav", ".m4a", ".flac", ".ogg", ".opus", ".aac")
APP_USER_MODEL_ID = "local.music.player"
USER_AGENT ="Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

app = Flask(__name__, static_folder=None)


@app.after_request
def _no_cache_static(response):
    # This is a single-user local app served fresh each launch - never let
    # the WebView2/browser cache stale HTML/CSS/JS across code changes.
    if request.path.startswith(("/css/", "/js/")) or request.path == "/":
        response.headers["Cache-Control"] = "no-store, must-revalidate"
    return response


_lock = threading.Lock()
_jobs = {}  # job_id -> dict, see _new_job()


# ---------------- logging + safe JSON storage ----------------
# Everything the app keeps lives in small JSON files. Writes go to a temp file
# that is then swapped into place, so a crash or power cut can never leave a
# half-written file; the previous good copy is kept as <name>.bak, and a file
# that turns out to be unreadable is set aside and the backup used instead.

log = logging.getLogger("music")


def _setup_logging():
    if log.handlers:
        return
    log.setLevel(logging.INFO)
    try:
        DATA_DIR.mkdir(exist_ok=True)
        from logging.handlers import RotatingFileHandler
        handler = RotatingFileHandler(DATA_DIR / "app.log", maxBytes=500_000, backupCount=2, encoding="utf-8")
    except OSError:
        handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(handler)


_setup_logging()


def _write_json(path, data, indent=2, backup=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        tmp.write_text(json.dumps(data, indent=indent), encoding="utf-8")
        if backup and path.is_file():
            try:
                shutil.copyfile(path, path.with_name(path.name + ".bak"))
            except OSError as e:
                log.warning("Couldn't back up %s: %s", path.name, e)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _read_json(path, default):
    """The JSON stored at path, falling back to its .bak if it's unreadable
    (the bad file is renamed *.corrupt so it isn't backed up over the good copy)."""
    bak = path.with_name(path.name + ".bak")
    for candidate in (path, bak):
        if not candidate.is_file():
            continue
        try:
            return json.loads(candidate.read_text(encoding="utf-8"))
        except Exception as e:
            log.error("Unreadable %s (%s)%s", candidate.name, e,
                      "; trying its backup" if candidate == path else "")
            if candidate == path:
                try:
                    os.replace(path, path.with_name(f"{path.name}.corrupt"))
                except OSError:
                    pass
    return default


# ---------------- library scanning ----------------

def find_track_paths():
    LIBRARY_DIR.mkdir(exist_ok=True)
    return sorted(
        (p for p in LIBRARY_DIR.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_EXTS),
        key=lambda p: p.name.lower(),
    )


def _ffprobe_duration(path):
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True, text=True,
        )
        return float(out.stdout.strip())
    except Exception as e:
        log.warning("ffprobe couldn't read the length of %s: %s", path.name, e)
        return None


_duration_cache = {}  # (path, mtime) -> seconds, so a rescan doesn't re-probe unchanged files


def _track_duration(path):
    try:
        key = (str(path), path.stat().st_mtime)
    except OSError:
        return 0
    if key not in _duration_cache:
        _duration_cache[key] = _ffprobe_duration(path) or 0
    return _duration_cache[key]


def _load_meta():
    return _read_json(META_FILE, {})


def _save_meta(meta):
    _write_json(META_FILE, meta)


def _name_fields(path, meta=None):
    """(title, artist) - by default the artist comes from an "Artist -
    Title.ext" filename, the convention downloads are saved under below; a
    title/artist stored in the metadata file (edited in-app, or the real names
    kept at import) takes precedence. (Those are stored beside the file rather
    than renaming it, so everything that refers to the track by filename -
    playlists, play counts - keeps working.)"""
    name = path.stem.replace("⧸", "/")  # yt-dlp's lookalike for "/" in titles
    if " - " in name:
        artist, title = name.split(" - ", 1)
    else:
        artist, title = "", name
    override = (meta if meta is not None else _load_meta()).get(path.name)
    if override:
        title = override.get("title", title)
        artist = override.get("artist", artist)
    return title, artist


def _track_fields(path, meta=None):
    """(title, artist, duration)."""
    title, artist = _name_fields(path, meta)
    return title, artist, _track_duration(path)


def _remember_real_names(final, title, artist):
    """Filenames can't hold / \\ : * ? " < > | so they're swapped for "_" on
    disk, which would show "AC/DC" as "AC_DC". When the real title/artist
    differ from what the filename gives back, keep them in the metadata file
    (flagged "auto" so the song doesn't count as user-edited)."""
    title = (title or "").strip()
    artist = (artist or "").strip()
    if not title:
        return
    on_disk = _name_fields(final, {})
    if (title, artist) == on_disk:
        return
    # Only act when the names differ in punctuation (what sanitizing swaps
    # out), never when the filename genuinely carries different words.
    def words(s):
        return re.sub(r"[\W_]+", "", s).casefold()
    if words(title) != words(on_disk[0]) or words(artist) != words(on_disk[1]):
        return
    with _lock:
        meta = _load_meta()
        meta[final.name] = {"title": title, "artist": artist, "auto": True}
        _save_meta(meta)


def _cover_path_for(audio_path):
    return COVERS_DIR / (audio_path.stem + ".jpg")


def _track_to_dict(path, stats=None, loudness=None, meta=None):
    meta = meta if meta is not None else _load_meta()
    title, artist, duration = _track_fields(path, meta)
    cover = _cover_path_for(path)
    return {
        "edited": path.name in meta and not meta[path.name].get("auto"),
        "gain_db": _cached_gain_db(path, loudness),
        "id": path.name,
        "title": title,
        "artist": artist,
        "duration": duration,
        "cover": f"/covers/{urllib.parse.quote(cover.name)}" if cover.is_file() else None,
        "plays": (stats or {}).get(path.name, 0),
        "added": path.stat().st_mtime,
    }


def _sanitize_filename(name):
    return re.sub(r'[\\/:*?"<>|]', "_", name).strip() or "track"


# ---------------- play-count stats ----------------

def _load_stats():
    return _read_json(STATS_FILE, {})


def _save_stats(stats):
    _write_json(STATS_FILE, stats)


def _record_play(track_id):
    with _lock:
        stats = _load_stats()
        stats[track_id] = stats.get(track_id, 0) + 1
        _save_stats(stats)
        return stats[track_id]


# ---------------- loudness normalization ----------------
# Each track's integrated loudness (LUFS) and peak are measured once with
# ffmpeg's ebur128 filter and cached; the player turns that into a per-track
# gain so quiet and loud songs play at about the same volume.

_loudness_lock = threading.Lock()  # one ffmpeg measurement at a time


def _load_loudness():
    return _read_json(LOUDNESS_FILE, {})


def _measure_loudness(path):
    """(integrated LUFS, peak dBFS) or None if it can't be measured (ffmpeg
    missing, unreadable file, or a silent track)."""
    try:
        out = subprocess.run(
            ["ffmpeg", "-nostats", "-hide_banner", "-i", str(path),
             "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"],
            capture_output=True, text=True, errors="ignore",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        summary = out.stderr.split("Summary:")[-1]
        lufs = re.findall(r"I:\s+(-?\d+(?:\.\d+)?)\s+LUFS", summary)
        peak = re.findall(r"Peak:\s+(-?\d+(?:\.\d+)?)\s+dBFS", summary)
        if not lufs or not peak:
            return None
        return float(lufs[-1]), float(peak[-1])
    except Exception as e:
        log.warning("Loudness measurement failed for %s: %s", path.name, e)
        return None


def _gain_db_from(entry):
    """Gain to reach TARGET_LUFS, capped so boosting never pushes the peak
    over full scale (no clipping) and so one odd file can't swing too far."""
    gain = TARGET_LUFS - entry["lufs"]
    gain = min(gain, -entry["peak"] - 1.0)  # keep 1 dB of headroom
    return round(max(-15.0, gain), 2)


def _cached_gain_db(path, loudness=None):
    entry = (loudness if loudness is not None else _load_loudness()).get(path.name)
    try:
        if entry and entry["mtime"] == path.stat().st_mtime:
            return _gain_db_from(entry)
    except (OSError, KeyError):
        pass
    return None


def _ensure_loudness(path):
    """Measures (if not cached) and returns the gain in dB, or None."""
    with _loudness_lock:
        loudness = _load_loudness()
        gain = _cached_gain_db(path, loudness)
        if gain is not None:
            return gain
        measured = _measure_loudness(path)
        if measured is None:
            return None
        loudness[path.name] = {"mtime": path.stat().st_mtime,
                               "lufs": measured[0], "peak": measured[1]}
        _write_json(LOUDNESS_FILE, loudness)
        return _gain_db_from(loudness[path.name])


_scan_running = threading.Event()


def _scan_loudness_async():
    """Measures any tracks not yet cached, in the background."""
    if _scan_running.is_set():
        return
    _scan_running.set()

    def run():
        try:
            for path in find_track_paths():
                _ensure_loudness(path)
        finally:
            _scan_running.clear()

    threading.Thread(target=run, daemon=True).start()


# ---------------- download sources (duplicate detection) ----------------
# Maps a stable source key ("yt:<video id>" / "spotify:<track id>") to the
# library filename it was downloaded as, so re-adding the same link is a no-op.

def _load_sources():
    return _read_json(SOURCES_FILE, {})


def _source_key(url):
    m = re.search(r"open\.spotify\.com/(?:intl-[a-z]+/)?track/([A-Za-z0-9]+)|spotify:track:([A-Za-z0-9]+)", url)
    if m:
        return "spotify:" + (m.group(1) or m.group(2))
    if "youtube.com" in url or "youtu.be" in url:
        m = re.search(r"(?:[?&]v=|youtu\.be/|/shorts/|/embed/)([A-Za-z0-9_-]{11})", url)
        if m:
            return "yt:" + m.group(1)
    return None


def _existing_for_source(key):
    """Path of the library file already downloaded from this source, if it
    still exists (a deleted track is no longer a duplicate)."""
    if not key:
        return None
    with _lock:
        name = _load_sources().get(key)
    if not name:
        return None
    path = LIBRARY_DIR / name
    return path if path.is_file() else None


def _record_source(key, filename):
    if not key:
        return
    with _lock:
        sources = _load_sources()
        sources[key] = filename
        _write_json(SOURCES_FILE, sources)


# ---------------- settings ----------------

def _load_settings():
    settings = dict(DEFAULT_SETTINGS)
    data = _read_json(SETTINGS_FILE, {})
    if isinstance(data, dict):
        settings.update({k: v for k, v in data.items() if k in DEFAULT_SETTINGS})
    return settings


def _save_settings(settings):
    _write_json(SETTINGS_FILE, settings)


# ---------------- playlists persistence ----------------

def _load_playlists():
    return _read_json(PLAYLISTS_FILE, [])


def _save_playlists(playlists):
    _write_json(PLAYLISTS_FILE, playlists)


def _find_playlist(playlists, pid):
    return next((p for p in playlists if p["id"] == pid), None)


def _create_playlist_record(name):
    with _lock:
        playlists = _load_playlists()
        playlist = {"id": uuid.uuid4().hex, "name": name, "track_ids": []}
        playlists.append(playlist)
        _save_playlists(playlists)
        return playlist


def _rename_playlist_record(pid, name):
    with _lock:
        playlists = _load_playlists()
        playlist = _find_playlist(playlists, pid)
        if playlist:
            playlist["name"] = name
            _save_playlists(playlists)


def _add_track_to_playlist_record(pid, track_id):
    with _lock:
        playlists = _load_playlists()
        playlist = _find_playlist(playlists, pid)
        if playlist and track_id not in playlist["track_ids"]:
            playlist["track_ids"].append(track_id)
            _save_playlists(playlists)


# ---------------- downloading ----------------

def _is_spotify_url(url):
    return "spotify.com" in url or url.startswith("spotify:")


def _is_spotify_playlist_url(url):
    return _is_spotify_url(url) and "/playlist/" in url


def _download_image(url, dest_path):
    """Best-effort - cover art is a nice-to-have, never fails the download."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read()
        dest_path.write_bytes(data)
    except Exception as e:
        log.warning("Couldn't download cover image: %s", e)


_RETRY_CODES = (429, 500, 502, 503, 504)


def _http_get(url, timeout=15, retries=3):
    """GET with a few retries and backoff for the hiccups that are normal on
    the open web (timeouts, rate limiting, brief 5xx). Returns bytes."""
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "en"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code not in _RETRY_CODES:
                raise
            last = e
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = e
        if attempt < retries - 1:
            time.sleep(1.5 * 2 ** attempt)
    raise last


def _spotify_oembed(url):
    return json.loads(_http_get("https://open.spotify.com/oembed?url=" + urllib.parse.quote(url, safe="")).decode("utf-8"))


def _spotify_embed_data(kind, spotify_id):
    """(raw html, parsed page data or None) of a Spotify embed page. The page
    carries its data as JSON in a script tag; reading that is sturdier than
    pattern-matching the markup, with the patterns kept as the fallback."""
    html = _http_get(f"https://open.spotify.com/embed/{kind}/{spotify_id}").decode("utf-8", errors="ignore")
    m = re.search(r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    data = None
    if m:
        try:
            data = json.loads(m.group(1))
        except ValueError:
            log.warning("Spotify embed page had unreadable JSON")
    return html, data


def _walk_json(node):
    """Every dict nested anywhere in node, in document order."""
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from _walk_json(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk_json(v)


def _fetch_spotify_metadata(url):
    """(title, artist, cover_url) for a Spotify track link, via Spotify's
    public oEmbed endpoint (no API credentials needed) plus a light read
    of the embed page for the artist name."""
    data = _spotify_oembed(url)
    title = data.get("title", "")
    cover_url = data.get("thumbnail_url")

    artist = ""
    match = re.search(r"open\.spotify\.com/(?:intl-[a-z]+/)?track/([A-Za-z0-9]+)", url)
    if match:
        try:
            html, page = _spotify_embed_data("track", match.group(1))
            for d in _walk_json(page):
                artists = d.get("artists")
                if isinstance(artists, list) and artists and isinstance(artists[0], dict) and artists[0].get("name"):
                    artist = artists[0]["name"]
                    break
                if isinstance(d.get("subtitle"), str) and str(d.get("uri", "")).startswith("spotify:track:"):
                    artist = d["subtitle"]
                    break
            if not artist:
                artist_match = re.search(r'"artists":\[\{"name":"([^"]+)"', html)
                if artist_match:
                    artist = artist_match.group(1)
            if not artist:
                log.warning("Spotify track page had no artist - its layout may have changed")
        except Exception as e:
            log.warning("Couldn't read the artist for %s: %s", url, e)
    return title, artist, cover_url


def _fetch_spotify_playlist_tracks(url):
    """(playlist_title, [track_url, ...]) for a Spotify playlist link.
    oEmbed gives the playlist's own title; the track URLs come from the embed
    page's data (undocumented, so read two independent ways). Note the embed
    page only lists the first ~100 tracks of a very long playlist."""
    data = _spotify_oembed(url)
    title = data.get("title", "")

    track_urls = []
    match = re.search(r"open\.spotify\.com/(?:intl-[a-z]+/)?playlist/([A-Za-z0-9]+)", url)
    if match:
        html, page = _spotify_embed_data("playlist", match.group(1))
        ids = []
        for d in _walk_json(page):
            uri = d.get("uri")
            if isinstance(uri, str) and uri.startswith("spotify:track:"):
                ids.append(uri.rsplit(":", 1)[-1])
        if not ids:  # fall back to scanning the raw page
            ids = re.findall(r'"uri":"spotify:track:([A-Za-z0-9]+)"', html)
        if not ids:
            log.warning("Spotify playlist page had no tracks - its layout may have changed")
        track_urls = [f"https://open.spotify.com/track/{t}" for t in dict.fromkeys(ids)]
    return title, track_urls


def _final_path(ydl, info):
    downloads = info.get("requested_downloads")
    if downloads:
        return Path(downloads[-1]["filepath"])
    base, _ext = os.path.splitext(ydl.prepare_filename(info))
    return Path(base + ".mp3")


def _ydl_opts(hook, **extra):
    import yt_dlp  # deferred - keeps process startup fast when no download is happening
    return {
        "format": "bestaudio/best",
        "outtmpl": str(LIBRARY_DIR / "%(title)s.%(ext)s"),
        "progress_hooks": [hook],
        "quiet": True,
        "no_warnings": True,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }],
        **extra,
    }, yt_dlp


def _youtube_track_fields(info):
    """Best-effort (title, artist) for a yt-dlp info_dict. Prefers YouTube's
    own "Music in this video" metadata (artist/track), which is far more
    reliable than the raw video title, then falls back to the uploading
    channel's name - a good guess for artist-run channels, a weaker one
    otherwise, but better than no artist at all."""
    title = (info.get("track") or info.get("title") or "").strip()
    artist = (info.get("artist") or info.get("creator")
              or info.get("channel") or info.get("uploader") or "").strip()
    if artist and " - " in title and title.split(" - ", 1)[0].strip().lower() == artist.lower():
        title = title.split(" - ", 1)[1].strip()
    return title, artist


def _rename_with_artist(path, title, artist):
    """Renames a downloaded file to the "Artist - Title" convention
    _track_fields() parses artist/title from, moving its cover art along
    with it. No-ops (returns path/title unchanged) when no artist is known,
    the title already leads with it (e.g. a raw "Artist & Other - Song"
    title, where prefixing again would just duplicate the name), or the
    file is already gone (a stale duplicate postprocessor event for a track
    some other call already renamed - yt-dlp's hooks can fire more than
    once per entry). Returns (final_path, display_name)."""
    if not artist or title.lower().startswith(artist.lower()) or not path.is_file():
        return path, title
    display_name = f"{artist} - {title}"
    final = path.with_name(_sanitize_filename(display_name) + path.suffix)
    if final.resolve() != path.resolve():
        if final.exists():
            final.unlink()
        path.rename(final)
        old_cover = _cover_path_for(path)
        if old_cover.is_file():
            new_cover = _cover_path_for(final)
            if new_cover.exists():
                new_cover.unlink()
            old_cover.rename(new_cover)
    return final, display_name


def _download_youtube(url, hook):
    """Downloads a single video, ignoring any ?list= playlist it's part of
    (playlist imports go through _download_youtube_playlist instead).
    Returns (path, title)."""
    opts, yt_dlp = _ydl_opts(hook, noplaylist=True)
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    path = _final_path(ydl, info)
    title, artist = _youtube_track_fields(info)
    final, display_name = _rename_with_artist(path, title or path.stem, artist)
    _remember_real_names(final, title or path.stem, artist)
    thumb = info.get("thumbnail")
    if thumb:
        _download_image(thumb, _cover_path_for(final))
    if info.get("id"):
        _record_source("yt:" + info["id"], final.name)
    return final, display_name


def _youtube_playlist_count(url):
    """How many videos a YouTube playlist link holds (0 if it can't be told),
    from a quick listing that downloads nothing - so progress has a real total."""
    try:
        import yt_dlp
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "extract_flat": "in_playlist",
                               "ignoreerrors": True}) as ydl:
            info = ydl.extract_info(url, download=False)
        entries = (info or {}).get("entries")
        return len([e for e in entries if e]) if entries is not None else 0
    except Exception as e:
        log.warning("Couldn't count the playlist's videos: %s", e)
        return 0


def _download_youtube_playlist(url, progress_hook, on_track, on_existing):
    """Downloads every video in a YouTube playlist URL. `on_track(path,
    title)` fires once per track as soon as it finishes converting, so the
    caller can add it to a local playlist while the rest keep downloading.
    Returns the source playlist's own title, or None if it couldn't be read."""
    def pp_hook(d):
        # "MoveFiles"/"finished" is yt-dlp's own always-last postprocessing
        # step, so info_dict['filepath'] is guaranteed to be the final
        # location by then (unlike "ExtractAudio", which also fires before
        # the file is moved into place, and fires twice per entry).
        if d.get("status") == "finished" and d.get("postprocessor") == "MoveFiles":
            info = d["info_dict"]
            path = Path(info["filepath"])
            if not path.is_file():
                return  # a stale duplicate event for a track already handled below
            title, artist = _youtube_track_fields(info)
            final, display_name = _rename_with_artist(path, title or path.stem, artist)
            _remember_real_names(final, title or path.stem, artist)
            thumb = info.get("thumbnail")
            if thumb:
                _download_image(thumb, _cover_path_for(final))
            if info.get("id"):
                _record_source("yt:" + info["id"], final.name)
            on_track(final, display_name)

    def skip_existing(info, *, incomplete=False):
        # yt-dlp match_filter: a non-None return skips the video. May be
        # called more than once per entry, so on_existing must be idempotent.
        existing = _existing_for_source("yt:" + info["id"]) if info.get("id") else None
        if existing:
            on_existing(existing)
            return "already in library"
        return None

    opts, yt_dlp = _ydl_opts(progress_hook, noplaylist=False, ignoreerrors=True,
                             match_filter=skip_existing)
    opts["postprocessor_hooks"] = [pp_hook]
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    return info.get("title") if isinstance(info, dict) else None


def _download_spotify(url, hook):
    """Downloads a single Spotify track link by finding its best match on
    YouTube. Returns (path, display_name, duplicate) - duplicate is True when
    the track was already in the library and nothing was downloaded."""
    key = _source_key(url)
    existing = _existing_for_source(key)
    if existing:
        return existing, existing.stem, True

    title, artist, cover_url = _fetch_spotify_metadata(url)
    if not title:
        raise RuntimeError("Could not read that Spotify link - check it's a track URL.")

    expected = LIBRARY_DIR / (_sanitize_filename(f"{artist} - {title}" if artist else title) + ".mp3")
    if expected.is_file():
        _record_source(key, expected.name)
        return expected, expected.stem, True

    query = f"{artist} {title} audio".strip() if artist else f"{title} audio"
    opts, yt_dlp = _ydl_opts(hook, noplaylist=True)
    with yt_dlp.YoutubeDL(opts) as ydl:
        result = ydl.extract_info(f"ytsearch1:{query}", download=True)
    entries = result.get("entries") if isinstance(result, dict) else None
    if entries is not None:
        if not entries:
            raise RuntimeError(f'No YouTube match found for "{query}"')
        entry = entries[0]
    else:
        entry = result
    downloaded = _final_path(ydl, entry)

    display_name = f"{artist} - {title}" if artist else title
    final = LIBRARY_DIR / (_sanitize_filename(display_name) + ".mp3")
    if downloaded.resolve() != final.resolve():
        if final.exists():
            final.unlink()
        downloaded.rename(final)
    _remember_real_names(final, title, artist)

    if cover_url:
        _download_image(cover_url, _cover_path_for(final))
    _record_source(key, final.name)
    return final, display_name, False


# ---------------- routes: static ----------------

@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/<path:filename>")
def static_files(filename):
    full = (STATIC_DIR / filename).resolve()
    if STATIC_DIR.resolve() not in full.parents and full != STATIC_DIR.resolve():
        abort(404)
    return send_from_directory(STATIC_DIR, filename)


@app.get("/covers/<path:name>")
def serve_cover(name):
    return send_from_directory(COVERS_DIR, name)


@app.get("/playlist-covers/<path:name>")
def serve_playlist_cover(name):
    return send_from_directory(PLAYLIST_COVERS_DIR, name)


@app.get("/audio/<path:name>")
def serve_audio(name):
    path = LIBRARY_DIR / name
    if not path.is_file():
        abort(404)
    return send_file(path, conditional=True)


# ---------------- routes: library ----------------

@app.get("/api/library")
def api_library():
    stats = _load_stats()
    loudness = _load_loudness()
    meta = _load_meta()
    return jsonify([_track_to_dict(p, stats, loudness, meta) for p in find_track_paths()])


@app.patch("/api/tracks/<path:track_id>/meta")
def api_edit_track_meta(track_id):
    """Edits a track's title/artist ({title, artist}), or restores the
    filename-derived ones ({reset: true})."""
    path = LIBRARY_DIR / track_id
    if not path.is_file():
        abort(404)
    body = request.get_json(silent=True) or {}
    with _lock:
        meta = _load_meta()
        if body.get("reset"):
            meta.pop(track_id, None)
        else:
            title = str(body.get("title", "")).strip()[:200]
            artist = str(body.get("artist", "")).strip()[:200]
            if not title:
                return jsonify({"error": "Title required"}), 400
            meta[track_id] = {"title": title, "artist": artist}
        _save_meta(meta)
    return jsonify(_track_to_dict(path, _load_stats(), _load_loudness(), meta))


@app.get("/api/tracks/<path:track_id>/loudness")
def api_track_loudness(track_id):
    path = LIBRARY_DIR / track_id
    if not path.is_file():
        abort(404)
    return jsonify({"gain_db": _ensure_loudness(path)})


@app.post("/api/tracks/<path:track_id>/play")
def api_record_play(track_id):
    return jsonify({"plays": _record_play(track_id)})


@app.delete("/api/tracks")
def api_delete_all_tracks():
    """Deletes every song file (and its cover) from the library, and clears
    everything that referred to them. Playlists themselves are kept, empty."""
    deleted = 0
    for path in find_track_paths():
        try:
            path.unlink()
            deleted += 1
        except OSError:
            continue
        cover = _cover_path_for(path)
        if cover.is_file():
            try:
                cover.unlink()
            except OSError:
                pass
    with _lock:
        playlists = _load_playlists()
        for pl in playlists:
            pl["track_ids"] = []
        _save_playlists(playlists)
        _save_stats({})
        _write_json(SOURCES_FILE, {})
        _write_json(LOUDNESS_FILE, {})
        _save_meta({})
    shutil.rmtree(LYRICS_DIR, ignore_errors=True)
    return jsonify({"deleted": deleted})


def _safe_track_path(track_id):
    """The library file for a track id, or None if the id isn't a plain
    filename inside the library (ids arrive from the client)."""
    if not isinstance(track_id, str) or not track_id:
        return None
    path = LIBRARY_DIR / track_id
    try:
        return path if path.parent.resolve() == LIBRARY_DIR.resolve() else None
    except OSError:
        return None


def _delete_tracks(track_ids):
    """Deletes song files (and covers) and scrubs them from playlists, play
    counts and saved edits. Returns how many files were removed."""
    deleted = 0
    ids = set()
    for track_id in track_ids:
        path = _safe_track_path(track_id)
        if path is None:
            continue
        ids.add(track_id)
        if path.is_file():
            try:
                path.unlink()
                deleted += 1
            except OSError:
                pass
        cover = _cover_path_for(path)
        if cover.is_file():
            try:
                cover.unlink()
            except OSError:
                pass
    if not ids:
        return 0
    with _lock:
        playlists = _load_playlists()
        for pl in playlists:
            pl["track_ids"] = [t for t in pl["track_ids"] if t not in ids]
        _save_playlists(playlists)
        stats = _load_stats()
        if any(t in stats for t in ids):
            _save_stats({k: v for k, v in stats.items() if k not in ids})
        meta = _load_meta()
        if any(t in meta for t in ids):
            _save_meta({k: v for k, v in meta.items() if k not in ids})
    for track_id in ids:
        try:
            _lyrics_cache_path(track_id).unlink(missing_ok=True)
        except OSError:
            pass
    with _loudness_lock:
        loudness = _load_loudness()
        if any(t in loudness for t in ids):
            _write_json(LOUDNESS_FILE, {k: v for k, v in loudness.items() if k not in ids})
    return deleted


@app.delete("/api/tracks/<path:track_id>")
def api_delete_track(track_id):
    _delete_tracks([track_id])
    return "", 204


@app.post("/api/tracks/batch-delete")
def api_delete_tracks():
    track_ids = (request.get_json(silent=True) or {}).get("track_ids")
    if not isinstance(track_ids, list) or not track_ids:
        return jsonify({"error": "track_ids required"}), 400
    return jsonify({"deleted": _delete_tracks(track_ids)})


# ---------------- lyrics ----------------
# Looked up on LRCLIB by artist/title/length and cached under data/lyrics, so
# each song is fetched at most once (a miss is retried after a week, or as
# soon as the song's name changes).

LYRICS_MISS_RETRY_SECONDS = 7 * 24 * 3600


def _lyrics_cache_path(track_id):
    return LYRICS_DIR / (hashlib.sha1(track_id.encode("utf-8")).hexdigest() + ".json")


def _lyrics_clean_title(title):
    """Drops "(feat. X)", "[Official Video]", "- Remastered 2011" and similar,
    which often stop a title matching the database entry."""
    t = re.sub(r"\s*[\(\[][^\)\]]*[\)\]]", "", title)
    t = re.sub(r"\s+-\s+(?:remaster|radio edit|single|from\b|live\b|mono\b|stereo\b|version\b).*$", "", t, flags=re.I)
    t = re.sub(r"\s+", " ", t).strip(" -")
    return t or title


def _lyrics_first_artist(artist):
    return re.split(r"\s*(?:,|&|\bfeat\.?|\bft\.?|\bwith\b)\s*", artist, maxsplit=1, flags=re.I)[0].strip()


def _parse_lrc(text):
    """[mm:ss.xx] timed lines -> [{"t": seconds, "text": line}], sorted."""
    lines = []
    for raw in text.splitlines():
        stamps = re.findall(r"\[(\d+):(\d+(?:\.\d+)?)\]", raw)
        if not stamps:
            continue
        content = re.sub(r"^(?:\[[^\]]*\])+", "", raw).strip()
        for minutes, seconds in stamps:
            lines.append({"t": round(int(minutes) * 60 + float(seconds), 2), "text": content})
    lines.sort(key=lambda line: line["t"])
    return lines


def _lrclib_search(params):
    req = urllib.request.Request(
        LRCLIB_URL + "?" + urllib.parse.urlencode(params),
        headers={"User-Agent": "music-player-local/1.0 (personal project)"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


# How far a database entry's length may differ from the file before its timing
# stops being trusted (timed lyrics from another edit drift out of sync):
LYRICS_EXACT_SECONDS = 2.0        # trusted as is
LYRICS_APPROX_SECONDS = 6.0       # timed, but flagged - the user can nudge the timing
LYRICS_TEXT_ONLY_SECONDS = 12.0   # same song, other edit: keep the words, drop the timing


def _pick_lyrics(results, titles, artists, duration):
    """The best database entry for the song as (entry, length difference, tier):
    same title and artist and a similar length (to avoid live/remix versions),
    preferring timed lyrics. tier is "exact", "approximate" or "text"."""
    title_words = {_words(t) for t in titles}
    artist_words = {_words(a) for a in artists if a}
    usable = [r for r in results
              if (r.get("syncedLyrics") or r.get("plainLyrics") or r.get("instrumental"))
              and _words(r.get("trackName") or "") in title_words
              and (not artist_words or any(w and (w in _words(r.get("artistName") or "") or _words(r.get("artistName") or "") in w)
                                           for w in artist_words))]
    if not duration:
        return (min(usable, key=lambda r: not r.get("syncedLyrics")), None, "exact") if usable else None
    tiers = ((LYRICS_EXACT_SECONDS, "exact"), (LYRICS_APPROX_SECONDS, "approximate"), (LYRICS_TEXT_ONLY_SECONDS, "text"))
    for tolerance, tier in tiers:
        pool = [r for r in usable if abs((r.get("duration") or 0) - duration) <= tolerance]
        if pool:
            best = min(pool, key=lambda r: (not r.get("syncedLyrics"), abs((r.get("duration") or 0) - duration)))
            return best, round(duration - (best.get("duration") or 0), 1), tier
    return None


def _fetch_lyrics(title, artist, duration):
    """Looks the song up, retrying with a cleaned-up title and the first
    credited artist. Returns a result dict; raises on network errors."""
    clean = _lyrics_clean_title(title)
    first = _lyrics_first_artist(artist)
    titles, artists = [title, clean], [artist, first]
    attempts = []
    for t, a in ((title, artist), (clean, artist), (clean, first)):
        if (t, a) not in attempts:
            attempts.append((t, a))
    rank = {"exact": 0, "approximate": 1, "text": 2}
    best = None
    searches = []
    for t, a in attempts:
        params = {"track_name": t}
        if a:
            params["artist_name"] = a
        searches.append(params)
    searches.append({"q": f"{first} {clean}".strip()})
    for params in searches:
        candidate = _pick_lyrics(_lrclib_search(params), titles, artists, duration)
        # keep the closest-length match across the different searches
        if candidate and (best is None or (rank[candidate[2]], abs(candidate[1] or 0)) < (rank[best[2]], abs(best[1] or 0))):
            best = candidate
        if best and best[2] == "exact":
            break
    if not best:
        return {"status": "none"}
    picked, diff, tier = best
    if picked.get("instrumental") and not picked.get("plainLyrics") and not picked.get("syncedLyrics"):
        return {"status": "instrumental"}

    timed = _parse_lrc(picked["syncedLyrics"]) if picked.get("syncedLyrics") else None
    plain = picked.get("plainLyrics")
    if not plain and timed:
        plain = "\n".join(line["text"] for line in timed)
    return {
        "status": "found",
        # a different edit of the song has different timing, so only the words are kept
        "synced": timed if tier != "text" else None,
        "plain": plain,
        "timing": tier,
        "duration_diff": diff,   # file length minus the database entry's length, in seconds
        "match": {"title": picked.get("trackName"), "artist": picked.get("artistName"),
                  "duration": picked.get("duration")},
    }


def _lyrics_for(path, refresh=False):
    """The lyrics result for a song: from the cache when it's still good,
    otherwise looked up (and cached). Raises on network errors, which are
    never cached."""
    title, artist = _name_fields(path)
    query = {"title": title, "artist": artist}
    cache_file = _lyrics_cache_path(path.name)

    if cache_file.is_file() and not refresh:
        try:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
            result = cached["result"]
            expired = result["status"] == "none" and time.time() - cached["fetched"] > LYRICS_MISS_RETRY_SECONDS
            # Entries saved before lengths were checked strictly: look them up
            # again if the cached version's length is clearly not this file's.
            matched = (result.get("match") or {}).get("duration")
            unchecked = (result["status"] == "found" and "timing" not in result and matched
                         and abs(_track_duration(path) - matched) > LYRICS_EXACT_SECONDS)
            if cached["query"] == query and not expired and not unchecked:
                return {**result, "offset": cached.get("offset", 0)}
        except Exception as e:
            log.warning("Unreadable lyrics cache for %s (%s); looking it up again", path.name, e)

    result = _fetch_lyrics(title, artist, _track_duration(path))
    with _lock:
        # a fresh lookup may be a different edit, so any saved timing nudge starts over
        _write_json(cache_file, {"query": query, "fetched": time.time(), "offset": 0, "result": result},
                    indent=None, backup=False)
    return {**result, "offset": 0}


@app.post("/api/tracks/<path:track_id>/lyrics/offset")
def api_lyrics_offset(track_id):
    """Saves a per-song timing nudge ({offset}: seconds added to every timed
    line) for lyrics from a slightly different edit of the song."""
    path = _safe_track_path(track_id)
    if path is None or not path.is_file():
        abort(404)
    try:
        offset = round(max(-30.0, min(30.0, float((request.get_json(silent=True) or {}).get("offset")))), 2)
    except (TypeError, ValueError):
        return jsonify({"error": "offset required"}), 400
    cache_file = _lyrics_cache_path(track_id)
    with _lock:
        try:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
        except Exception:
            return jsonify({"error": "No lyrics saved for this song"}), 404
        cached["offset"] = offset
        _write_json(cache_file, cached, indent=None, backup=False)
    return jsonify({"offset": offset})


@app.get("/api/tracks/<path:track_id>/lyrics")
def api_track_lyrics(track_id):
    path = _safe_track_path(track_id)
    if path is None or not path.is_file():
        abort(404)
    if not _load_settings().get("lyrics_enabled", True):
        return jsonify({"status": "disabled"})
    try:
        return jsonify(_lyrics_for(path, refresh=request.args.get("refresh") == "1"))
    except (urllib.error.URLError, OSError, ValueError):
        # Offline or the service is down: report it, but don't cache the failure.
        return jsonify({"status": "error", "message": "Couldn't reach the lyrics service."})


def _fetch_lyrics_with_song(path):
    """Fetches (and caches) a freshly downloaded song's lyrics as part of its
    download, so they're there - offline included - from the first play.
    Never raises: a failure just means the lyrics load on demand later."""
    if not _load_settings().get("lyrics_enabled", True):
        return
    try:
        _lyrics_for(path)
    except Exception as e:
        log.info("Lyrics lookup failed for %s: %s", path.name, e)


def _prefetch_lyrics_async(track_ids):
    """After an import, looks the new songs' lyrics up in the background so
    they're ready (and work offline) by the first play."""
    ids = list(dict.fromkeys(t for t in track_ids if t))
    if not ids or not _load_settings().get("lyrics_enabled", True):
        return

    def run():
        for track_id in ids:
            path = _safe_track_path(track_id)
            if path is None or not path.is_file():
                continue
            try:
                _lyrics_for(path)
            except (urllib.error.URLError, OSError, ValueError):
                return  # offline - stop quietly; lyrics load on demand later
            time.sleep(0.4)  # be gentle with the free service

    threading.Thread(target=run, daemon=True).start()


# ---------------- finding duplicates ----------------
# Two kinds: byte-identical files (whatever they're called), and the same song
# saved twice - same title (ignoring "(feat. ...)"-style suffixes), same lead
# artist, and nearly the same length. Merging keeps one copy and moves the
# others' play counts and playlist spots onto it.

def _file_sha1(path):
    digest = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _find_duplicate_groups():
    meta, stats, playlists = _load_meta(), _load_stats(), _load_playlists()
    info = {}
    for path in find_track_paths():
        title, artist = _name_fields(path, meta)
        info[path.name] = {
            "path": path, "title": title, "artist": artist,
            "duration": _track_duration(path), "size": path.stat().st_size,
            "title_key": _words(_lyrics_clean_title(title)),
            "artist_key": _words(_lyrics_first_artist(artist)),
        }

    parent = {name: name for name in info}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x, y):
        parent[find(x)] = find(y)

    # 1) identical bytes - only hash files that share a size
    hashes = {}
    by_size = {}
    for name, item in info.items():
        by_size.setdefault(item["size"], []).append(name)
    for names in by_size.values():
        if len(names) < 2:
            continue
        by_hash = {}
        for name in names:
            hashes[name] = _file_sha1(info[name]["path"])
            by_hash.setdefault(hashes[name], []).append(name)
        for same in by_hash.values():
            for other in same[1:]:
                union(same[0], other)

    # 2) the same song under a different name
    by_title = {}
    for name, item in info.items():
        if item["title_key"]:
            by_title.setdefault(item["title_key"], []).append(name)
    for names in by_title.values():
        for i, a_name in enumerate(names):
            for b_name in names[i + 1:]:
                a_item, b_item = info[a_name], info[b_name]
                if not (a_item["duration"] and b_item["duration"]):
                    continue
                if abs(a_item["duration"] - b_item["duration"]) > 3:
                    continue
                if a_item["artist_key"] and b_item["artist_key"] and a_item["artist_key"] != b_item["artist_key"]:
                    continue
                union(a_name, b_name)

    groups = {}
    for name in info:
        groups.setdefault(find(name), []).append(name)

    playlist_count = {}
    for pl in playlists:
        for track_id in pl["track_ids"]:
            playlist_count[track_id] = playlist_count.get(track_id, 0) + 1

    result = []
    for names in groups.values():
        if len(names) < 2:
            continue

        def rank(n):
            # keep the most-played, then most-playlisted, then biggest (best quality),
            # then the one with the fuller name (more credited artists)
            return (-stats.get(n, 0), -playlist_count.get(n, 0), -info[n]["size"], -len(n))

        names.sort(key=rank)
        identical = len({hashes.get(n) for n in names}) == 1 and None not in {hashes.get(n) for n in names}
        files = []
        for i, name in enumerate(names):
            item = info[name]
            cover = _cover_path_for(item["path"])
            files.append({
                "id": name, "title": item["title"], "artist": item["artist"],
                "duration": item["duration"], "size": item["size"],
                "plays": stats.get(name, 0), "playlists": playlist_count.get(name, 0),
                "cover": f"/covers/{urllib.parse.quote(cover.name)}" if cover.is_file() else None,
                "keep": i == 0,
            })
        result.append({"reason": "identical" if identical else "same-song", "files": files})
    result.sort(key=lambda g: g["files"][0]["title"].casefold())
    for i, group in enumerate(result):
        group["id"] = i
    return result


@app.get("/api/duplicates")
def api_find_duplicates():
    groups = _find_duplicate_groups()
    return jsonify({"groups": groups, "extra_files": sum(len(g["files"]) - 1 for g in groups)})


@app.post("/api/duplicates/merge")
def api_merge_duplicates():
    """{groups: [{keep, remove: [ids]}]} - deletes the `remove` copies, moving
    their play counts, playlist spots and import sources onto `keep`."""
    groups = (request.get_json(silent=True) or {}).get("groups")
    if not isinstance(groups, list) or not groups:
        return jsonify({"error": "groups required"}), 400

    removed = []
    with _lock:
        playlists, stats, sources = _load_playlists(), _load_stats(), _load_sources()
        for group in groups:
            if not isinstance(group, dict):
                continue
            keep = group.get("keep")
            keep_path = _safe_track_path(keep)
            if keep_path is None or not keep_path.is_file():
                continue
            drop = []
            for track_id in group.get("remove") or []:
                path = _safe_track_path(track_id)
                if track_id != keep and path is not None and path.is_file():
                    drop.append(track_id)
            if not drop:
                continue
            gone = set(drop)
            for pl in playlists:
                if gone.isdisjoint(pl["track_ids"]):
                    continue
                seen, merged = set(), []
                for track_id in pl["track_ids"]:
                    track_id = keep if track_id in gone else track_id
                    if track_id not in seen:
                        seen.add(track_id)
                        merged.append(track_id)
                pl["track_ids"] = merged
            total = stats.get(keep, 0) + sum(stats.get(t, 0) for t in drop)
            if total:
                stats[keep] = total
            for key, name in list(sources.items()):
                if name in gone:
                    sources[key] = keep
            removed.extend(drop)
        _save_playlists(playlists)
        _save_stats(stats)
        _write_json(SOURCES_FILE, sources)

    deleted = _delete_tracks(removed) if removed else 0
    return jsonify({"removed": len(removed), "deleted": deleted})


# ---------------- fixing old names ----------------
# Songs saved before real titles were kept can show "AC_DC" instead of "AC/DC"
# (files can't hold "/"), or have no artist at all. A scan finds them and
# suggests corrections, which the user reviews before anything changes.

_name_jobs = {}


def _words(s):
    """Letters and digits only - to tell punctuation changes from real ones."""
    return re.sub(r"[\W_]+", "", s).casefold()


def _needs_attention(title, artist):
    return not artist or "_" in title or "_" in artist or "\u29f8" in title + artist


def _guess_clean(text):
    """Best guess at undoing sanitizing: "A _ B" -> "A / B", "AC_DC" -> "AC/DC"."""
    s = text.replace("\u29f8", "/")
    s = re.sub(r"\s_\s", " / ", s)
    return re.sub(r"(?<=[^\W_])_(?=[^\W_])", "/", s)


def _real_names_from_source(key):
    """(title, artist) re-read from where the song came from, or None."""
    kind, _, ident = key.partition(":")
    if kind == "spotify":
        title, artist, _cover = _fetch_spotify_metadata("https://open.spotify.com/track/" + ident)
        return (title.strip(), artist.strip()) if title else None
    if kind == "yt":
        import yt_dlp
        opts = {"quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True}
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info("https://www.youtube.com/watch?v=" + ident, download=False)
        title, artist = _youtube_track_fields(info)
        return (title, artist) if title else None
    return None


def _suggest_name(source_key, title, artist):
    """(title, artist, reason) for a better name, or None. A suggestion must
    only differ from the current name by punctuation (or fill in a missing
    artist) - never replace it with different words."""
    candidates = []
    if source_key:
        try:
            real = _real_names_from_source(source_key)
        except Exception as e:
            log.warning("Couldn't read original names for %s: %s", source_key, e)
            real = None
        if real:
            candidates.append((real[0], real[1], "source"))
    candidates.append((_guess_clean(title), _guess_clean(artist), "guess"))
    for new_title, new_artist, reason in candidates:
        if (new_title, new_artist) == (title, artist):
            continue
        if _words(new_title) != _words(title):
            continue
        if artist and _words(new_artist) != _words(artist):
            continue
        return new_title, new_artist, reason
    return None


def _scan_names(job):
    try:
        with _lock:
            by_file = {name: key for key, name in _load_sources().items()}
        meta = _load_meta()
        candidates = []
        for path in find_track_paths():
            entry = meta.get(path.name)
            if entry and not entry.get("auto"):
                continue  # the user already edited this one
            title, artist = _name_fields(path, meta)
            if _needs_attention(title, artist):
                candidates.append((path, title, artist))
        job["total"] = len(candidates)
        for path, title, artist in candidates:
            job["current"] = path.stem
            suggestion = _suggest_name(by_file.get(path.name), title, artist)
            if suggestion:
                job["suggestions"].append({
                    "id": path.name,
                    "current": {"title": title, "artist": artist},
                    "suggested": {"title": suggestion[0], "artist": suggestion[1]},
                    "reason": suggestion[2],
                })
            else:
                job["unresolved"] += 1
            job["checked"] += 1
        job["status"] = "done"
    except Exception as e:
        log.exception("Name scan failed")
        job.update(status="error", error=str(e))
    job["current"] = None


@app.post("/api/fix-names/scan")
def api_fix_names_scan():
    job_id = uuid.uuid4().hex
    job = {"status": "running", "total": 0, "checked": 0, "current": None,
           "suggestions": [], "unresolved": 0, "error": None}
    _name_jobs[job_id] = job
    threading.Thread(target=_scan_names, args=(job,), daemon=True).start()
    return jsonify({"job_id": job_id}), 202


@app.get("/api/fix-names/<job_id>")
def api_fix_names_status(job_id):
    job = _name_jobs.get(job_id)
    if not job:
        return jsonify({"error": "Not found"}), 404
    return jsonify(job)


@app.post("/api/tracks/batch-meta")
def api_batch_meta():
    """Sets title/artist for several tracks at once ({items: [{id, title,
    artist}]}) - used to apply reviewed name suggestions."""
    items = (request.get_json(silent=True) or {}).get("items")
    if not isinstance(items, list) or not items:
        return jsonify({"error": "items required"}), 400
    updated = []
    with _lock:
        meta = _load_meta()
        for item in items:
            path = _safe_track_path(item.get("id") if isinstance(item, dict) else None)
            title = str(item.get("title", "")).strip()[:200] if isinstance(item, dict) else ""
            if path is None or not path.is_file() or not title:
                continue
            meta[path.name] = {"title": title, "artist": str(item.get("artist", "")).strip()[:200]}
            updated.append(path)
        _save_meta(meta)
    stats, loudness = _load_stats(), _load_loudness()
    return jsonify({"tracks": [_track_to_dict(p, stats, loudness, meta) for p in updated]})


# ---------------- routes: remembered player state ----------------

@app.get("/api/state")
def api_get_state():
    state = _read_json(PLAYER_STATE_FILE, {})
    return jsonify(state if isinstance(state, dict) else {})


@app.post("/api/state")
def api_save_state():
    # Also posted via navigator.sendBeacon when the window closes.
    if request.content_length and request.content_length > 2_000_000:
        return jsonify({"error": "Too large"}), 413
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "Object required"}), 400
    _write_json(PLAYER_STATE_FILE, body, indent=None, backup=False)
    return "", 204


# ---------------- routes: settings ----------------

@app.get("/api/settings")
def api_get_settings():
    return jsonify(_load_settings())


@app.post("/api/settings")
def api_update_settings():
    body = request.get_json(silent=True) or {}
    with _lock:
        settings = _load_settings()
        color = body.get("accent_color")
        if isinstance(color, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            settings["accent_color"] = color
        if isinstance(body.get("normalize_volume"), bool):
            settings["normalize_volume"] = body["normalize_volume"]
        if isinstance(body.get("lyrics_enabled"), bool):
            settings["lyrics_enabled"] = body["lyrics_enabled"]
        if body.get("transition_mode") in TRANSITION_MODES:
            settings["transition_mode"] = body["transition_mode"]
        if "crossfade_seconds" in body:
            try:
                seconds = float(body["crossfade_seconds"])
                if 1 <= seconds <= 12:
                    settings["crossfade_seconds"] = seconds
            except (TypeError, ValueError):
                pass
        if isinstance(body.get("spotify_sync_url"), str):
            sync_url = body["spotify_sync_url"].strip()
            if not sync_url or (_is_spotify_playlist_url(sync_url) and "open.spotify.com" in sync_url):
                settings["spotify_sync_url"] = sync_url
                _sync_wake.set()
        if "idle_timeout_minutes" in body:
            try:
                minutes = float(body["idle_timeout_minutes"])
                if 0 < minutes <= 180:
                    settings["idle_timeout_minutes"] = minutes
            except (TypeError, ValueError):
                pass
        _save_settings(settings)
    return jsonify(settings)


# ---------------- spotify playlist watch ----------------
# Every SYNC_INTERVAL seconds the watched Spotify playlist is re-read. Any track
# that isn't in the library and hasn't been seen before becomes "pending" and
# the UI asks whether to add it. The first read after choosing a playlist only
# records what's already there, so you aren't asked about its whole backlog.

SYNC_INTERVAL = 60
_sync_wake = threading.Event()


def _load_sync():
    data = _read_json(SYNC_FILE, {})
    return data if isinstance(data, dict) else {}


def _save_sync(state):
    _write_json(SYNC_FILE, state)


def _sync_check():
    """One pass over the watched playlist. Network work happens outside the lock."""
    url = _load_settings().get("spotify_sync_url", "")
    if not url:
        return
    try:
        _title, track_urls = _fetch_spotify_playlist_tracks(url)
        error = None if track_urls else "Could not read any tracks from that playlist."
    except Exception as e:
        log.warning("Spotify sync: couldn't read the playlist: %s", e)
        track_urls, error = [], f"Could not reach Spotify: {e}"

    with _lock:
        state = _load_sync()
        if state.get("url") != url:
            state = {"url": url}
        state["last_checked"] = time.time()
        state["error"] = error
        _save_sync(state)
        if error:
            return
        first_run = "seen" not in state
        seen = set(state.get("seen", []))
        pending = state.get("pending", [])
        sources = _load_sources()

    ids = [u.rsplit("/", 1)[-1] for u in track_urls]
    if first_run:
        seen.update(ids)
        new_ids = []
    else:
        queued = {p["id"] for p in pending}
        new_ids = []
        for tid in ids:
            if tid in seen or tid in queued:
                continue
            name = sources.get("spotify:" + tid)
            if name and (LIBRARY_DIR / name).is_file():
                seen.add(tid)  # already downloaded some other way
            else:
                new_ids.append(tid)

    found = []
    for tid in new_ids:
        track_url = f"https://open.spotify.com/track/{tid}"
        try:
            title, artist, cover = _fetch_spotify_metadata(track_url)
        except Exception as e:
            log.warning("Spotify sync: no metadata for %s: %s", tid, e)
            title, artist, cover = "", "", None
        found.append({"id": tid, "url": track_url, "title": title or "Unknown title",
                      "artist": artist, "cover": cover})

    with _lock:
        state = _load_sync()
        if state.get("url") != url:
            return  # playlist changed while we were reading; next pass starts over
        state["seen"] = sorted(set(state.get("seen", [])) | seen)
        known = {p["id"] for p in state.get("pending", [])}
        state["pending"] = state.get("pending", []) + [f for f in found if f["id"] not in known]
        state["last_checked"] = time.time()
        state["error"] = None
        _save_sync(state)


def _sync_loop():
    while True:
        try:
            _sync_check()
        except Exception as e:
            log.exception("Spotify sync failed: %s", e)
        _sync_wake.wait(SYNC_INTERVAL)
        _sync_wake.clear()


def _start_sync_thread():
    threading.Thread(target=_sync_loop, daemon=True).start()


@app.get("/api/sync")
def api_sync_status():
    with _lock:
        url = _load_settings().get("spotify_sync_url", "")
        state = _load_sync()
    if not url or state.get("url") != url:
        return jsonify({"url": url, "pending": [], "last_checked": None, "error": None})
    return jsonify({"url": url, "pending": state.get("pending", []),
                    "last_checked": state.get("last_checked"), "error": state.get("error")})


@app.post("/api/sync/check")
def api_sync_check():
    _sync_wake.set()
    return "", 204


@app.post("/api/sync/<track_id>/resolve")
def api_sync_resolve(track_id):
    """Take a pending track off the list (it was added, or the user skipped it)."""
    with _lock:
        state = _load_sync()
        state["pending"] = [p for p in state.get("pending", []) if p["id"] != track_id]
        state["seen"] = sorted(set(state.get("seen", [])) | {track_id})
        _save_sync(state)
    return "", 204


# ---------------- routes: playlists ----------------

def _playlist_cover_path(pid):
    return PLAYLIST_COVERS_DIR / f"{pid}.jpg"


def _playlist_public(playlist):
    """A playlist as the client sees it: with its description and, when it has
    one, the URL of its custom cover (the version in the URL busts caches)."""
    out = dict(playlist)
    out["description"] = playlist.get("description", "")
    cover = _playlist_cover_path(playlist["id"])
    out["cover"] = f"/playlist-covers/{cover.name}?v={int(cover.stat().st_mtime)}" if cover.is_file() else None
    return out


@app.get("/api/playlists")
def api_get_playlists():
    with _lock:
        return jsonify([_playlist_public(p) for p in _load_playlists()])


@app.put("/api/playlists/order")
def api_reorder_playlists():
    """Sets the order of the playlists ({ids: [...]}, a permutation of all ids)."""
    ids = (request.get_json(silent=True) or {}).get("ids")
    with _lock:
        playlists = _load_playlists()
        if not isinstance(ids, list) or sorted(ids) != sorted(p["id"] for p in playlists):
            return jsonify({"error": "ids must list every playlist exactly once"}), 400
        by_id = {p["id"]: p for p in playlists}
        _save_playlists([by_id[i] for i in ids])
    return "", 204


@app.post("/api/playlists")
def api_create_playlist():
    name = (request.get_json(silent=True) or {}).get("name", "").strip()
    if not name:
        return jsonify({"error": "Name required"}), 400
    with _lock:
        playlists = _load_playlists()
        playlist = {"id": uuid.uuid4().hex, "name": name, "track_ids": []}
        playlists.append(playlist)
        _save_playlists(playlists)
    return jsonify(playlist), 201


@app.patch("/api/playlists/<pid>")
def api_update_playlist(pid):
    """Renames a playlist ({name}) and/or sets its description ({description})."""
    body = request.get_json(silent=True) or {}
    if "name" not in body and "description" not in body:
        return jsonify({"error": "Name required"}), 400
    name = str(body["name"]).strip()[:120] if "name" in body else None
    if name is not None and not name:
        return jsonify({"error": "Name required"}), 400
    with _lock:
        playlists = _load_playlists()
        playlist = _find_playlist(playlists, pid)
        if not playlist:
            return jsonify({"error": "Not found"}), 404
        if name is not None:
            playlist["name"] = name
        if "description" in body:
            playlist["description"] = str(body["description"]).strip()[:500]
        _save_playlists(playlists)
        return jsonify(_playlist_public(playlist))


@app.post("/api/playlists/<pid>/cover")
def api_set_playlist_cover(pid):
    """Sets a custom cover from the request body (a JPEG - the client crops
    and shrinks whatever the user picked before sending it)."""
    data = request.get_data()
    if not data.startswith(b"\xff\xd8\xff"):
        return jsonify({"error": "A JPEG image is required"}), 400
    if len(data) > 3_000_000:
        return jsonify({"error": "Image too large"}), 413
    with _lock:
        playlist = _find_playlist(_load_playlists(), pid)
        if not playlist:
            return jsonify({"error": "Not found"}), 404
        PLAYLIST_COVERS_DIR.mkdir(parents=True, exist_ok=True)
        _playlist_cover_path(pid).write_bytes(data)
        return jsonify(_playlist_public(playlist))


@app.delete("/api/playlists/<pid>/cover")
def api_remove_playlist_cover(pid):
    with _lock:
        if not _find_playlist(_load_playlists(), pid):
            return jsonify({"error": "Not found"}), 404
        _playlist_cover_path(pid).unlink(missing_ok=True)
    return "", 204


@app.delete("/api/playlists")
def api_delete_all_playlists():
    """Removes every playlist. Tracks stay in the library."""
    with _lock:
        _save_playlists([])
    shutil.rmtree(PLAYLIST_COVERS_DIR, ignore_errors=True)
    return "", 204


@app.delete("/api/playlists/<pid>")
def api_delete_playlist(pid):
    with _lock:
        playlists = _load_playlists()
        remaining = [p for p in playlists if p["id"] != pid]
        if len(remaining) == len(playlists):
            return jsonify({"error": "Not found"}), 404
        _save_playlists(remaining)
        _playlist_cover_path(pid).unlink(missing_ok=True)
    return "", 204


@app.put("/api/playlists/<pid>/order")
def api_reorder_tracks(pid):
    track_ids = (request.get_json(silent=True) or {}).get("track_ids")
    if not isinstance(track_ids, list):
        return jsonify({"error": "track_ids required"}), 400
    with _lock:
        playlists = _load_playlists()
        playlist = _find_playlist(playlists, pid)
        if not playlist:
            return jsonify({"error": "Not found"}), 404
        # Must be a pure reordering - never add or drop tracks.
        if sorted(track_ids) != sorted(playlist["track_ids"]):
            return jsonify({"error": "track_ids must match the playlist's tracks"}), 400
        playlist["track_ids"] = track_ids
        _save_playlists(playlists)
        return jsonify(playlist)


@app.post("/api/playlists/<pid>/tracks")
def api_add_track(pid):
    """Adds one track ({track_id}) or several ({track_ids}) to a playlist."""
    body = request.get_json(silent=True) or {}
    track_ids = body.get("track_ids")
    if track_ids is None and body.get("track_id"):
        track_ids = [body["track_id"]]
    if not isinstance(track_ids, list) or not track_ids:
        return jsonify({"error": "track_id required"}), 400
    with _lock:
        playlists = _load_playlists()
        playlist = _find_playlist(playlists, pid)
        if not playlist:
            return jsonify({"error": "Not found"}), 404
        for track_id in track_ids:
            if isinstance(track_id, str) and track_id not in playlist["track_ids"]:
                playlist["track_ids"].append(track_id)
        _save_playlists(playlists)
        return jsonify(playlist)


@app.post("/api/playlists/<pid>/tracks/batch-remove")
def api_remove_tracks(pid):
    track_ids = (request.get_json(silent=True) or {}).get("track_ids")
    if not isinstance(track_ids, list) or not track_ids:
        return jsonify({"error": "track_ids required"}), 400
    drop = set(track_ids)
    with _lock:
        playlists = _load_playlists()
        playlist = _find_playlist(playlists, pid)
        if not playlist:
            return jsonify({"error": "Not found"}), 404
        playlist["track_ids"] = [t for t in playlist["track_ids"] if t not in drop]
        _save_playlists(playlists)
        return jsonify(playlist)


@app.delete("/api/playlists/<pid>/tracks/<path:track_id>")
def api_remove_track(pid, track_id):
    with _lock:
        playlists = _load_playlists()
        playlist = _find_playlist(playlists, pid)
        if not playlist:
            return jsonify({"error": "Not found"}), 404
        playlist["track_ids"] = [t for t in playlist["track_ids"] if t != track_id]
        _save_playlists(playlists)
        return jsonify(playlist)


# ---------------- routes: download ----------------

def _new_job(kind):
    return {
        "kind": kind,                # "track" | "playlist"
        "status": "downloading",     # downloading | done | error
        "percent": "",               # label for the file being fetched: "42.0%" / "Converting..." / ...
        "fraction": 0.0,             # 0..1 progress of the file being fetched (numeric, for the bar)
        "current_title": None,
        "title": None,               # final title, for a "track" job
        "as_playlist": True,         # False when a playlist link was imported as plain songs
        "playlist_id": None,         # for a "playlist" job (None unless as_playlist)
        "playlist_name": None,
        "total": 0,
        "duplicate": False,          # a "track" job whose track was already in the library
        "skipped": [],               # [{id, title}, ...] already in library (playlist job)
        "added": [],                 # [{id, title}, ...]
        "failed": [],                # [{title, error}, ...]
        "error": None,
    }


def _run_playlist_import(url, job, progress_hook, as_playlist=True):
    """Downloads every track of a playlist link. With as_playlist, the tracks
    are also collected into a new local playlist; otherwise they're only added
    to the library (All Songs)."""
    job["as_playlist"] = as_playlist

    def add_to_playlist(playlist, path):
        if playlist:
            _add_track_to_playlist_record(playlist["id"], path.name)

    if _is_spotify_playlist_url(url):
        title, track_urls = _fetch_spotify_playlist_tracks(url)
        if not track_urls:
            raise RuntimeError("Could not read tracks from that Spotify playlist link.")
        playlist = _create_playlist_record(title or "Imported Playlist") if as_playlist else None
        if playlist:
            job["playlist_id"] = playlist["id"]
        job["playlist_name"] = playlist["name"] if playlist else (title or "Spotify playlist")
        job["total"] = len(track_urls)
        for track_url in track_urls:
            job["current_title"] = None
            try:
                path, track_title, duplicate = _download_spotify(track_url, progress_hook)
                job["current_title"] = track_title
            except Exception as e:
                log.warning("Download failed for %s: %s", track_url, e)
                job["failed"].append({"title": track_url, "error": str(e)})
                continue
            add_to_playlist(playlist, path)
            if not duplicate:
                job["percent"] = "Fetching lyrics..."
                _fetch_lyrics_with_song(path)
            job["fraction"] = 0.0
            job["percent"] = ""
            (job["skipped"] if duplicate else job["added"]).append({"id": path.name, "title": track_title})
    else:
        playlist = _create_playlist_record("Importing playlist...") if as_playlist else None
        if playlist:
            job["playlist_id"] = playlist["id"]
        job["playlist_name"] = playlist["name"] if playlist else "YouTube playlist"

        def on_track(path, title):
            add_to_playlist(playlist, path)
            job["percent"] = "Fetching lyrics..."
            _fetch_lyrics_with_song(path)
            job["fraction"] = 0.0
            job["percent"] = ""
            job["added"].append({"id": path.name, "title": title})

        def on_existing(path):
            # Already downloaded: still belongs in the playlist, just don't re-fetch it.
            add_to_playlist(playlist, path)
            if not any(s["id"] == path.name for s in job["skipped"]):
                job["skipped"].append({"id": path.name, "title": path.stem})

        job["total"] = _youtube_playlist_count(url)
        playlist_title = _download_youtube_playlist(url, progress_hook, on_track, on_existing)
        final_name = playlist_title or "Imported Playlist"
        if playlist:
            _rename_playlist_record(playlist["id"], final_name)
        job["playlist_name"] = final_name
        if not job["added"] and not job["skipped"]:
            raise RuntimeError("Could not read any tracks from that YouTube playlist link.")


@app.post("/api/download")
def api_download():
    body = request.get_json(silent=True) or {}
    url = body.get("url", "").strip()
    mode = body.get("mode", "track")
    if not url:
        return jsonify({"error": "URL required"}), 400

    job_id = uuid.uuid4().hex
    job = _new_job("playlist" if mode == "playlist" else "track")
    _jobs[job_id] = job

    def progress_hook(d):
        if d["status"] == "downloading":
            done_bytes = d.get("downloaded_bytes") or 0
            total_bytes = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if total_bytes:
                job["fraction"] = max(0.0, min(1.0, done_bytes / total_bytes))
                job["percent"] = f"{job['fraction'] * 100:.1f}%"
            else:
                job["percent"] = ""  # size unknown: the page shows an indeterminate bar
            info = d.get("info_dict") or {}
            n_entries = info.get("n_entries")
            if n_entries:
                # per-video info often reports 1 here, so never shrink the total
                job["total"] = max(job["total"], n_entries)
            entry_title = info.get("title")
            if entry_title:
                job["current_title"] = entry_title
        elif d["status"] == "finished":
            job["fraction"] = 1.0
            job["percent"] = "Converting..."

    def worker():
        LIBRARY_DIR.mkdir(exist_ok=True)
        COVERS_DIR.mkdir(exist_ok=True)
        new_ids = []  # songs this job added, for a catch-up lyrics pass
        try:
            if mode == "playlist":
                _run_playlist_import(url, job, progress_hook, body.get("as_playlist", True) is not False)
            else:
                if _is_spotify_url(url):
                    path, title, job["duplicate"] = _download_spotify(url, progress_hook)
                else:
                    existing = _existing_for_source(_source_key(url))
                    if existing:
                        path, title, job["duplicate"] = existing, existing.stem, True
                    else:
                        path, title = _download_youtube(url, progress_hook)
                job["title"] = title
                if not job["duplicate"]:
                    new_ids = [path.name]
                    job["percent"] = "Fetching lyrics..."
                    _fetch_lyrics_with_song(path)
            job["status"] = "done"
        except Exception as e:
            log.exception("Download job failed for %s", url)
            job.update(status="error", error=str(e))
        if mode == "playlist":
            new_ids = [item["id"] for item in job["added"]]
        _scan_loudness_async()  # measure whatever was just added
        _prefetch_lyrics_async(new_ids)  # retries any lookups that failed while offline

    threading.Thread(target=worker, daemon=True).start()
    return jsonify({"job_id": job_id}), 202


@app.get("/api/download/<job_id>")
def api_download_status(job_id):
    job = _jobs.get(job_id)
    if not job:
        return jsonify({"error": "Not found"}), 404
    return jsonify(job)


# ---------------- entry points ----------------

def run_web(port=8734):
    _scan_loudness_async()
    _start_sync_thread()
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)


def run_desktop():
    import webview
    if sys.platform == "win32":
        # Name the process for the Windows media overlay instead of "Unknown
        # app": Windows looks the label up by AppUserModelID, so register a
        # DisplayName for ours under HKCU (per-user, no admin needed).
        try:
            import ctypes
            import winreg
            with winreg.CreateKey(
                winreg.HKEY_CURRENT_USER,
                rf"Software\Classes\AppUserModelId\{APP_USER_MODEL_ID}",
            ) as key:
                winreg.SetValueEx(key, "DisplayName", 0, winreg.REG_SZ, "Music")
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_USER_MODEL_ID)
        except Exception:
            pass
    port = 8734
    threading.Thread(target=run_web, kwargs={"port": port}, daemon=True).start()
    time.sleep(0.6)
    webview.create_window(
        "Music", f"http://127.0.0.1:{port}",
        width=1280, height=820, min_size=(960, 620),
        background_color="#0b0b0d",
    )
    # pywebview defaults to a private (incognito) WebView2 session, which makes
    # Windows hide track metadata in the media overlay.
    webview.start(private_mode=False, storage_path=str(DATA_DIR / "webview"))


if __name__ == "__main__":
    if "--web" in sys.argv:
        run_web()
    else:
        run_desktop()

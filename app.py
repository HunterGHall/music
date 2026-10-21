import json
import os
import re
import subprocess
import sys
import threading
import time
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
LOUDNESS_FILE = DATA_DIR / "loudness.json"
META_FILE = DATA_DIR / "metadata.json"        # user-edited title/artist per track
PLAYER_STATE_FILE = DATA_DIR / "player_state.json"
TRANSITION_MODES = ("off", "gapless", "crossfade")
DEFAULT_SETTINGS = {
    "accent_color": "#ff8a3d",
    "idle_timeout_minutes": 2,
    "normalize_volume": True,
    "transition_mode": "gapless",   # off | gapless | crossfade
    "crossfade_seconds": 5,
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
    except Exception:
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
    if not META_FILE.is_file():
        return {}
    try:
        return json.loads(META_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_meta(meta):
    DATA_DIR.mkdir(exist_ok=True)
    META_FILE.write_text(json.dumps(meta, indent=2), encoding="utf-8")


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
    if not STATS_FILE.is_file():
        return {}
    try:
        return json.loads(STATS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_stats(stats):
    DATA_DIR.mkdir(exist_ok=True)
    STATS_FILE.write_text(json.dumps(stats, indent=2), encoding="utf-8")


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
    if not LOUDNESS_FILE.is_file():
        return {}
    try:
        return json.loads(LOUDNESS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


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
    except Exception:
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
        DATA_DIR.mkdir(exist_ok=True)
        LOUDNESS_FILE.write_text(json.dumps(loudness, indent=2), encoding="utf-8")
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
    if not SOURCES_FILE.is_file():
        return {}
    try:
        return json.loads(SOURCES_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


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
        DATA_DIR.mkdir(exist_ok=True)
        SOURCES_FILE.write_text(json.dumps(sources, indent=2), encoding="utf-8")


# ---------------- settings ----------------

def _load_settings():
    settings = dict(DEFAULT_SETTINGS)
    if SETTINGS_FILE.is_file():
        try:
            data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            settings.update({k: v for k, v in data.items() if k in DEFAULT_SETTINGS})
        except Exception:
            pass
    return settings


def _save_settings(settings):
    DATA_DIR.mkdir(exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(settings, indent=2), encoding="utf-8")


# ---------------- playlists persistence ----------------

def _load_playlists():
    if not PLAYLISTS_FILE.is_file():
        return []
    try:
        return json.loads(PLAYLISTS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save_playlists(playlists):
    DATA_DIR.mkdir(exist_ok=True)
    PLAYLISTS_FILE.write_text(json.dumps(playlists, indent=2), encoding="utf-8")


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
    except Exception:
        pass


def _fetch_spotify_metadata(url):
    """(title, artist, cover_url) for a Spotify track link, via Spotify's
    public oEmbed endpoint (no API credentials needed) plus a light scrape
    of the embed page for the artist name."""
    oembed_url = "https://open.spotify.com/oembed?url=" + urllib.parse.quote(url, safe="")
    req = urllib.request.Request(oembed_url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    title = data.get("title", "")
    cover_url = data.get("thumbnail_url")

    artist = ""
    match = re.search(r"open\.spotify\.com/track/([A-Za-z0-9]+)", url)
    if match:
        try:
            embed_req = urllib.request.Request(
                f"https://open.spotify.com/embed/track/{match.group(1)}",
                headers={"User-Agent": USER_AGENT},
            )
            with urllib.request.urlopen(embed_req, timeout=15) as resp:
                html = resp.read().decode("utf-8", errors="ignore")
            artist_match = re.search(r'"artists":\[\{"name":"([^"]+)"', html)
            if artist_match:
                artist = artist_match.group(1)
        except Exception:
            pass
    return title, artist, cover_url


def _fetch_spotify_playlist_tracks(url):
    """(playlist_title, [track_url, ...]) for a Spotify playlist link.
    oEmbed gives the playlist's own title; the individual track URLs are
    scraped from the embed page's track-list JSON the same way
    _fetch_spotify_metadata() scrapes a single track's artist - undocumented,
    but stable enough for this."""
    oembed_url = "https://open.spotify.com/oembed?url=" + urllib.parse.quote(url, safe="")
    req = urllib.request.Request(oembed_url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    title = data.get("title", "")

    track_urls = []
    match = re.search(r"open\.spotify\.com/playlist/([A-Za-z0-9]+)", url)
    if match:
        embed_req = urllib.request.Request(
            f"https://open.spotify.com/embed/playlist/{match.group(1)}",
            headers={"User-Agent": USER_AGENT},
        )
        with urllib.request.urlopen(embed_req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
        seen = set()
        for m in re.finditer(r'"uri":"spotify:track:([A-Za-z0-9]+)"', html):
            track_id = m.group(1)
            if track_id not in seen:
                seen.add(track_id)
                track_urls.append(f"https://open.spotify.com/track/{track_id}")
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
        DATA_DIR.mkdir(exist_ok=True)
        SOURCES_FILE.write_text("{}", encoding="utf-8")
        LOUDNESS_FILE.write_text("{}", encoding="utf-8")
        _save_meta({})
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
    with _loudness_lock:
        loudness = _load_loudness()
        if any(t in loudness for t in ids):
            LOUDNESS_FILE.write_text(
                json.dumps({k: v for k, v in loudness.items() if k not in ids}, indent=2),
                encoding="utf-8")
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
        except Exception:
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
    if not PLAYER_STATE_FILE.is_file():
        return jsonify({})
    try:
        return jsonify(json.loads(PLAYER_STATE_FILE.read_text(encoding="utf-8")))
    except Exception:
        return jsonify({})


@app.post("/api/state")
def api_save_state():
    # Also posted via navigator.sendBeacon when the window closes.
    if request.content_length and request.content_length > 2_000_000:
        return jsonify({"error": "Too large"}), 413
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "Object required"}), 400
    DATA_DIR.mkdir(exist_ok=True)
    PLAYER_STATE_FILE.write_text(json.dumps(body), encoding="utf-8")
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
        if body.get("transition_mode") in TRANSITION_MODES:
            settings["transition_mode"] = body["transition_mode"]
        if "crossfade_seconds" in body:
            try:
                seconds = float(body["crossfade_seconds"])
                if 1 <= seconds <= 12:
                    settings["crossfade_seconds"] = seconds
            except (TypeError, ValueError):
                pass
        if "idle_timeout_minutes" in body:
            try:
                minutes = float(body["idle_timeout_minutes"])
                if 0 < minutes <= 180:
                    settings["idle_timeout_minutes"] = minutes
            except (TypeError, ValueError):
                pass
        _save_settings(settings)
    return jsonify(settings)


# ---------------- routes: playlists ----------------

@app.get("/api/playlists")
def api_get_playlists():
    with _lock:
        return jsonify(_load_playlists())


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
def api_rename_playlist(pid):
    name = (request.get_json(silent=True) or {}).get("name", "").strip()
    if not name:
        return jsonify({"error": "Name required"}), 400
    with _lock:
        playlists = _load_playlists()
        playlist = _find_playlist(playlists, pid)
        if not playlist:
            return jsonify({"error": "Not found"}), 404
        playlist["name"] = name
        _save_playlists(playlists)
        return jsonify(playlist)


@app.delete("/api/playlists")
def api_delete_all_playlists():
    """Removes every playlist. Tracks stay in the library."""
    with _lock:
        _save_playlists([])
    return "", 204


@app.delete("/api/playlists/<pid>")
def api_delete_playlist(pid):
    with _lock:
        playlists = _load_playlists()
        remaining = [p for p in playlists if p["id"] != pid]
        if len(remaining) == len(playlists):
            return jsonify({"error": "Not found"}), 404
        _save_playlists(remaining)
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
        "percent": "",
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
                job["failed"].append({"title": track_url, "error": str(e)})
                continue
            add_to_playlist(playlist, path)
            (job["skipped"] if duplicate else job["added"]).append({"id": path.name, "title": track_title})
    else:
        playlist = _create_playlist_record("Importing playlist...") if as_playlist else None
        if playlist:
            job["playlist_id"] = playlist["id"]
        job["playlist_name"] = playlist["name"] if playlist else "YouTube playlist"

        def on_track(path, title):
            add_to_playlist(playlist, path)
            job["added"].append({"id": path.name, "title": title})

        def on_existing(path):
            # Already downloaded: still belongs in the playlist, just don't re-fetch it.
            add_to_playlist(playlist, path)
            if not any(s["id"] == path.name for s in job["skipped"]):
                job["skipped"].append({"id": path.name, "title": path.stem})

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
            job["percent"] = d.get("_percent_str", "").strip()
            info = d.get("info_dict") or {}
            n_entries = info.get("n_entries")
            if n_entries:
                job["total"] = n_entries
            entry_title = info.get("title")
            if entry_title:
                job["current_title"] = entry_title
        elif d["status"] == "finished":
            job["percent"] = "Converting..."

    def worker():
        LIBRARY_DIR.mkdir(exist_ok=True)
        COVERS_DIR.mkdir(exist_ok=True)
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
            job["status"] = "done"
        except Exception as e:
            job.update(status="error", error=str(e))
        _scan_loudness_async()  # measure whatever was just added

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

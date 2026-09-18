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
STATIC_DIR = BASE_DIR / "static"
AUDIO_EXTS = (".mp3", ".wav", ".m4a", ".flac", ".ogg", ".opus", ".aac")
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

app = Flask(__name__, static_folder=None)

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


def _track_fields(path):
    """(title, artist, duration) - artist comes from an "Artist - Title.ext"
    filename, the convention downloads are saved under below."""
    name = path.stem
    if " - " in name:
        artist, title = name.split(" - ", 1)
    else:
        artist, title = "", name
    return title, artist, _track_duration(path)


def _cover_path_for(audio_path):
    return COVERS_DIR / (audio_path.stem + ".jpg")


def _track_to_dict(path, stats=None):
    title, artist, duration = _track_fields(path)
    cover = _cover_path_for(path)
    return {
        "id": path.name,
        "title": title,
        "artist": artist,
        "duration": duration,
        "cover": f"/covers/{cover.name}" if cover.is_file() else None,
        "plays": (stats or {}).get(path.name, 0),
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
    thumb = info.get("thumbnail")
    if thumb:
        _download_image(thumb, _cover_path_for(final))
    return final, display_name


def _download_youtube_playlist(url, progress_hook, on_track):
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
            thumb = info.get("thumbnail")
            if thumb:
                _download_image(thumb, _cover_path_for(final))
            on_track(final, display_name)

    opts, yt_dlp = _ydl_opts(progress_hook, noplaylist=False, ignoreerrors=True)
    opts["postprocessor_hooks"] = [pp_hook]
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    return info.get("title") if isinstance(info, dict) else None


def _download_spotify(url, hook):
    """Downloads a single Spotify track link by finding its best match on
    YouTube. Returns (path, display_name)."""
    title, artist, cover_url = _fetch_spotify_metadata(url)
    if not title:
        raise RuntimeError("Could not read that Spotify link - check it's a track URL.")

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

    if cover_url:
        _download_image(cover_url, _cover_path_for(final))
    return final, display_name


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
    return jsonify([_track_to_dict(p, stats) for p in find_track_paths()])


@app.post("/api/tracks/<path:track_id>/play")
def api_record_play(track_id):
    return jsonify({"plays": _record_play(track_id)})


@app.delete("/api/tracks/<path:track_id>")
def api_delete_track(track_id):
    path = LIBRARY_DIR / track_id
    if path.is_file():
        path.unlink()
    cover = _cover_path_for(path)
    if cover.is_file():
        cover.unlink()
    with _lock:
        playlists = _load_playlists()
        for pl in playlists:
            pl["track_ids"] = [t for t in pl["track_ids"] if t != track_id]
        _save_playlists(playlists)
    with _lock:
        stats = _load_stats()
        if track_id in stats:
            del stats[track_id]
            _save_stats(stats)
    return "", 204


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


@app.delete("/api/playlists/<pid>")
def api_delete_playlist(pid):
    with _lock:
        playlists = _load_playlists()
        remaining = [p for p in playlists if p["id"] != pid]
        if len(remaining) == len(playlists):
            return jsonify({"error": "Not found"}), 404
        _save_playlists(remaining)
    return "", 204


@app.post("/api/playlists/<pid>/tracks")
def api_add_track(pid):
    track_id = (request.get_json(silent=True) or {}).get("track_id")
    if not track_id:
        return jsonify({"error": "track_id required"}), 400
    with _lock:
        playlists = _load_playlists()
        playlist = _find_playlist(playlists, pid)
        if not playlist:
            return jsonify({"error": "Not found"}), 404
        if track_id not in playlist["track_ids"]:
            playlist["track_ids"].append(track_id)
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
        "playlist_id": None,         # for a "playlist" job
        "playlist_name": None,
        "total": 0,
        "added": [],                 # [{id, title}, ...]
        "failed": [],                # [{title, error}, ...]
        "error": None,
    }


def _run_playlist_import(url, job, progress_hook):
    if _is_spotify_playlist_url(url):
        title, track_urls = _fetch_spotify_playlist_tracks(url)
        if not track_urls:
            raise RuntimeError("Could not read tracks from that Spotify playlist link.")
        playlist = _create_playlist_record(title or "Imported Playlist")
        job["playlist_id"] = playlist["id"]
        job["playlist_name"] = playlist["name"]
        job["total"] = len(track_urls)
        for track_url in track_urls:
            job["current_title"] = None
            try:
                path, track_title = _download_spotify(track_url, progress_hook)
                job["current_title"] = track_title
            except Exception as e:
                job["failed"].append({"title": track_url, "error": str(e)})
                continue
            _add_track_to_playlist_record(playlist["id"], path.name)
            job["added"].append({"id": path.name, "title": track_title})
    else:
        playlist = _create_playlist_record("Importing playlist...")
        job["playlist_id"] = playlist["id"]
        job["playlist_name"] = playlist["name"]

        def on_track(path, title):
            _add_track_to_playlist_record(playlist["id"], path.name)
            job["added"].append({"id": path.name, "title": title})

        playlist_title = _download_youtube_playlist(url, progress_hook, on_track)
        final_name = playlist_title or "Imported Playlist"
        _rename_playlist_record(playlist["id"], final_name)
        job["playlist_name"] = final_name
        if not job["added"]:
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
                _run_playlist_import(url, job, progress_hook)
            else:
                if _is_spotify_url(url):
                    path, title = _download_spotify(url, progress_hook)
                else:
                    path, title = _download_youtube(url, progress_hook)
                job["title"] = title
            job["status"] = "done"
        except Exception as e:
            job.update(status="error", error=str(e))

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
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)


def run_desktop():
    import webview
    port = 8734
    threading.Thread(target=run_web, kwargs={"port": port}, daemon=True).start()
    time.sleep(0.6)
    webview.create_window(
        "Music", f"http://127.0.0.1:{port}",
        width=1280, height=820, min_size=(960, 620),
        background_color="#0b0b0d",
    )
    webview.start()


if __name__ == "__main__":
    if "--web" in sys.argv:
        run_web()
    else:
        run_desktop()

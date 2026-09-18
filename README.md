# music

A local music player built with Flask + pywebview. Download tracks or whole playlists from YouTube/Spotify links, organize them into playlists, and play them back — all stored locally, no accounts, no ads.

**Features:** Home dashboard (playlist covers, most-played), All Songs library with search, custom playlists, shuffle/repeat, YouTube & Spotify track/playlist import.

**Requires:** Python 3, `ffmpeg`/`ffprobe` on PATH.

**Run:**
```bash
pip install -r requirements.txt
python app.py
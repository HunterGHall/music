(() => {
  "use strict";

  // ---------------- state ----------------

  const state = {
    library: [],       // all tracks in the local library
    playlists: [],      // [{id, name, track_ids}]
    view: { type: "dashboard" },  // {type:"dashboard"} | {type:"library"} | {type:"playlist", id} | {type:"add"}
    queue: [],          // tracks currently shown / playable in order
    queueIndex: -1,
    repeat: "off",       // off | all | one
    searchQuery: "",
    sortKey: "default",  // default | title | artist | plays | duration | added
    sortDir: "asc",
    artistFilter: "",    // "" = all, UNKNOWN_ARTIST, or an artist name
    shuffle: false,
    shuffleOrder: [],    // permutation of indices into state.queue
    shufflePos: -1,      // current position within shuffleOrder
    settings: { accent_color: "#ff8a3d", idle_timeout_minutes: 2, normalize_volume: true },
  };

  let idleHintShown = false;
  let idleTimerId = null;

  const audio = new Audio();
  audio.volume = 0.7;

  // ---------------- dom refs ----------------

  const navDashboard = document.getElementById("nav-dashboard");
  const navLibrary = document.getElementById("nav-library");
  const navAdd = document.getElementById("nav-add");
  const playlistListEl = document.getElementById("playlist-list");
  const newPlaylistBtn = document.getElementById("new-playlist-btn");
  const viewTitle = document.getElementById("view-title");
  const trackListEl = document.getElementById("track-list");
  const emptyStateEl = document.getElementById("empty-state");
  const statusLine = document.getElementById("status-line");
  const addPageEl = document.getElementById("add-page");
  const dashboardPageEl = document.getElementById("dashboard-page");
  const dashboardPlaylistsGrid = document.getElementById("dashboard-playlists-grid");
  const dashboardPlaylistsEmpty = document.getElementById("dashboard-playlists-empty");
  const mostPlayedGrid = document.getElementById("most-played-grid");
  const mostPlayedEmpty = document.getElementById("most-played-empty");
  const searchBox = document.getElementById("search-box");
  const searchInput = document.getElementById("search-input");
  const searchClearBtn = document.getElementById("search-clear");
  const listControlsEl = document.getElementById("list-controls");
  const sortSelect = document.getElementById("sort-select");
  const sortDirBtn = document.getElementById("sort-dir-btn");
  const artistSelect = document.getElementById("artist-select");

  const navNowPlaying = document.getElementById("nav-nowplaying");
  const nowPlayingHintDot = document.getElementById("nowplaying-hint-dot");
  const nowplayingPageEl = document.getElementById("nowplaying-page");
  const nowplayingEmptyEl = document.getElementById("nowplaying-empty");
  const nowplayingContentEl = document.getElementById("nowplaying-content");
  const nowplayingCover = document.getElementById("nowplaying-cover");
  const nowplayingCoverFallback = document.getElementById("nowplaying-cover-fallback");
  const nowplayingTitle = document.getElementById("nowplaying-title");
  const nowplayingArtist = document.getElementById("nowplaying-artist");
  const vizCanvas = document.getElementById("nowplaying-visualizer");

  const settingsBtn = document.getElementById("settings-btn");
  const settingsDropdown = document.getElementById("settings-dropdown");
  const idleTimeoutInput = document.getElementById("idle-timeout-input");
  const normalizeToggle = document.getElementById("normalize-toggle");
  const colorSwatches = document.getElementById("color-swatches");
  const customColorInput = document.getElementById("custom-color-input");

  const trackForm = document.getElementById("track-form");
  const trackUrlInput = document.getElementById("track-url");
  const trackAddBtn = document.getElementById("track-add-btn");
  const playlistForm = document.getElementById("playlist-form");
  const playlistUrlInput = document.getElementById("playlist-url");
  const playlistImportBtn = document.getElementById("playlist-import-btn");
  const addStatusEl = document.getElementById("add-status");
  const playlistChoiceEl = document.getElementById("playlist-choice");
  const choicePlaylistBtn = document.getElementById("choice-playlist");
  const choiceSongsBtn = document.getElementById("choice-songs");
  const choiceCancelBtn = document.getElementById("choice-cancel");
  const deleteAllPlaylistsBtn = document.getElementById("delete-all-playlists-btn");
  const deleteAllSongsBtn = document.getElementById("delete-all-songs-btn");

  const npCover = document.getElementById("np-cover");
  const npCoverFallback = document.getElementById("np-cover-fallback");
  const npTitle = document.getElementById("np-title");
  const npArtist = document.getElementById("np-artist");

  const shuffleBtn = document.getElementById("shuffle-btn");
  const prevBtn = document.getElementById("prev-btn");
  const playBtn = document.getElementById("play-btn");
  const nextBtn = document.getElementById("next-btn");
  const repeatBtn = document.getElementById("repeat-btn");
  const repeatOneDot = document.getElementById("repeat-one-dot");
  const playIcon = document.getElementById("play-icon");
  const pauseIcon = document.getElementById("pause-icon");

  const seek = document.getElementById("seek");
  const timeCurrent = document.getElementById("time-current");
  const timeDuration = document.getElementById("time-duration");

  const volume = document.getElementById("volume");
  const muteBtn = document.getElementById("mute-btn");

  const modalBackdrop = document.getElementById("modal-backdrop");
  const modalTitle = document.getElementById("modal-title");
  const modalInput = document.getElementById("modal-input");
  const modalCancel = document.getElementById("modal-cancel");
  const modalConfirm = document.getElementById("modal-confirm");

  const addPopover = document.getElementById("add-popover");

  let seekDragging = false;
  let modalOnConfirm = null;

  // Some inline-SVG elements don't reflect the `hidden` IDL property in
  // every WebView engine - toggle the attribute directly instead.
  function setHidden(el, isHidden) {
    if (isHidden) el.setAttribute("hidden", "");
    else el.removeAttribute("hidden");
  }

  // ---------------- api helpers ----------------

  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    if (!res.ok) {
      let message = res.statusText;
      try {
        const data = await res.json();
        if (data.error) message = data.error;
      } catch (_) { /* no body */ }
      throw new Error(message);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // ---------------- formatting ----------------

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function setStatus(message, isError) {
    statusLine.textContent = message || "";
    setHidden(statusLine, !message);
    statusLine.classList.toggle("error", !!isError);
  }

  // ---------------- data loading ----------------

  async function loadLibrary() {
    state.library = await api("GET", "/api/library");
  }

  async function loadPlaylists() {
    state.playlists = await api("GET", "/api/playlists");
  }

  function trackById(id) {
    return state.library.find((t) => t.id === id);
  }

  function currentPlaylist() {
    if (state.view.type !== "playlist") return null;
    return state.playlists.find((p) => p.id === state.view.id) || null;
  }

  // ---------------- rendering: sidebar ----------------

  function renderSidebar() {
    navDashboard.classList.toggle("active", state.view.type === "dashboard");
    navLibrary.classList.toggle("active", state.view.type === "library");
    navAdd.classList.toggle("active", state.view.type === "add");
    navNowPlaying.classList.toggle("active", state.view.type === "nowplaying");

    playlistListEl.innerHTML = "";
    for (const pl of state.playlists) {
      const li = document.createElement("li");
      li.className = "playlist-row" + (state.view.type === "playlist" && state.view.id === pl.id ? " active" : "");
      li.dataset.id = pl.id;

      const name = document.createElement("span");
      name.className = "pl-name";
      name.textContent = pl.name;
      name.title = "Double-click to rename";

      const count = document.createElement("span");
      count.className = "pl-count";
      count.textContent = pl.track_ids.length;

      const del = document.createElement("button");
      del.className = "icon-btn small pl-delete";
      del.title = "Delete playlist";
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

      li.addEventListener("click", (e) => {
        if (e.target === del || del.contains(e.target)) return;
        if (name.isContentEditable) return;
        openPlaylist(pl.id);
      });

      name.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startRenamePlaylist(pl, name);
      });

      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete playlist "${pl.name}"? This won't delete the tracks themselves.`)) return;
        try {
          await api("DELETE", `/api/playlists/${pl.id}`);
          await loadPlaylists();
          if (state.view.type === "playlist" && state.view.id === pl.id) {
            openDashboard();
          } else {
            renderSidebar();
          }
        } catch (err) {
          setStatus(err.message, true);
        }
      });

      li.appendChild(name);
      li.appendChild(count);
      li.appendChild(del);
      playlistListEl.appendChild(li);
    }
  }

  function startRenamePlaylist(pl, nameEl) {
    nameEl.contentEditable = "true";
    nameEl.focus();
    document.execCommand("selectAll", false, null);

    const finish = async (commit) => {
      nameEl.contentEditable = "false";
      nameEl.removeEventListener("blur", onBlur);
      nameEl.removeEventListener("keydown", onKeydown);
      const newName = nameEl.textContent.trim();
      if (commit && newName && newName !== pl.name) {
        try {
          await api("PATCH", `/api/playlists/${pl.id}`, { name: newName });
          await loadPlaylists();
          renderSidebar();
          if (state.view.type === "playlist" && state.view.id === pl.id) {
            viewTitle.textContent = newName;
          }
        } catch (err) {
          setStatus(err.message, true);
          nameEl.textContent = pl.name;
        }
      } else {
        nameEl.textContent = pl.name;
      }
    };

    const onBlur = () => finish(true);
    const onKeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); nameEl.blur(); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
    };
    nameEl.addEventListener("blur", onBlur);
    nameEl.addEventListener("keydown", onKeydown);
  }

  // ---------------- rendering: track list ----------------

  function tracksForView() {
    if (state.view.type === "playlist") {
      const pl = currentPlaylist();
      if (!pl) return [];
      return pl.track_ids.map(trackById).filter(Boolean);
    }
    return state.library;
  }

  // ---------------- sorting / filtering ----------------

  const UNKNOWN_ARTIST = "__unknown__";
  const SORT_COMPARATORS = {
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
    artist: (a, b) => (a.artist || "").localeCompare(b.artist || "", undefined, { sensitivity: "base" })
      || a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
    plays: (a, b) => (a.plays || 0) - (b.plays || 0),
    duration: (a, b) => (a.duration || 0) - (b.duration || 0),
    added: (a, b) => (a.added || 0) - (b.added || 0),
  };
  const SORT_DESC_BY_DEFAULT = new Set(["plays", "added"]);

  // "A, B & C" / "A feat. B" -> each credited artist, so a collab shows up
  // under every one of its artists in the filter.
  function artistParts(track) {
    return (track.artist || "")
      .split(/\s*(?:,|&|\bfeat\.?|\bft\.?)\s*/i)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function buildArtistOptions(tracks) {
    const names = new Set();
    let hasUnknown = false;
    for (const t of tracks) {
      const parts = artistParts(t);
      if (parts.length === 0) hasUnknown = true;
      parts.forEach((p) => names.add(p));
    }
    const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    const options = [{ value: "", label: "All artists" }];
    sorted.forEach((n) => options.push({ value: n, label: n }));
    if (hasUnknown) options.push({ value: UNKNOWN_ARTIST, label: "Unknown artist" });
    return options;
  }

  function matchesArtistFilter(track) {
    if (!state.artistFilter) return true;
    const parts = artistParts(track);
    return state.artistFilter === UNKNOWN_ARTIST ? parts.length === 0 : parts.includes(state.artistFilter);
  }

  function sortTracks(tracks) {
    const cmp = SORT_COMPARATORS[state.sortKey];
    if (!cmp) return tracks; // "default": library order / the playlist's own order
    const sign = state.sortDir === "desc" ? -1 : 1;
    return [...tracks].sort((a, b) => sign * cmp(a, b));
  }

  // Syncs the controls with state and returns the artist-filter-valid tracks'
  // source list so renderView can apply search/filter/sort to it.
  function syncListControls(allTracks) {
    const options = buildArtistOptions(allTracks);
    if (!options.some((o) => o.value === state.artistFilter)) state.artistFilter = "";
    artistSelect.innerHTML = "";
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      artistSelect.appendChild(opt);
    }
    artistSelect.value = state.artistFilter;
    sortSelect.value = state.sortKey;
    setHidden(sortDirBtn, state.sortKey === "default");
    sortDirBtn.textContent = state.sortDir === "desc" ? "↓" : "↑";
    sortDirBtn.title = state.sortDir === "desc" ? "Descending (click to reverse)" : "Ascending (click to reverse)";
  }

  sortSelect.addEventListener("change", () => {
    state.sortKey = sortSelect.value;
    state.sortDir = SORT_DESC_BY_DEFAULT.has(state.sortKey) ? "desc" : "asc";
    renderView();
  });
  sortDirBtn.addEventListener("click", () => {
    state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
    renderView();
  });
  artistSelect.addEventListener("change", () => {
    state.artistFilter = artistSelect.value;
    renderView();
  });

  function hideAllPages() {
    setHidden(listControlsEl, true);
    setHidden(searchBox, true);
    setHidden(dashboardPageEl, true);
    setHidden(addPageEl, true);
    setHidden(nowplayingPageEl, true);
    setHidden(trackListEl, true);
    setHidden(emptyStateEl, true);
  }

  function renderView() {
    if (state.view.type === "add") {
      hideAllPages();
      viewTitle.textContent = "Add Music";
      setHidden(addPageEl, false);
      return;
    }
    if (state.view.type === "dashboard") {
      hideAllPages();
      viewTitle.textContent = "Home";
      setHidden(dashboardPageEl, false);
      renderDashboard();
      return;
    }
    if (state.view.type === "nowplaying") {
      hideAllPages();
      viewTitle.textContent = "Now Playing";
      setHidden(nowplayingPageEl, false);
      clearIdleHint();
      startVisualizer();
      return;
    }
    hideAllPages();
    setHidden(searchBox, false);
    setHidden(listControlsEl, false);
    setHidden(trackListEl, false);

    viewTitle.textContent = state.view.type === "playlist"
      ? (currentPlaylist() ? currentPlaylist().name : "Playlist")
      : "All Songs";

    const allTracks = tracksForView();
    syncListControls(allTracks);
    const query = state.searchQuery.trim().toLowerCase();
    const filtered = allTracks.filter((t) =>
      matchesArtistFilter(t)
      && (!query || t.title.toLowerCase().includes(query) || (t.artist || "").toLowerCase().includes(query)));
    const tracks = sortTracks(filtered);
    // Dragging only makes sense when the list on screen IS the playlist's order.
    reorderEnabled = state.view.type === "playlist" && state.sortKey === "default"
      && !query && !state.artistFilter;

    const playingId = state.queue[state.queueIndex] ? state.queue[state.queueIndex].id : null;
    state.queue = tracks;
    state.queueIndex = playingId ? tracks.findIndex((t) => t.id === playingId) : -1;
    if (state.shuffle) regenerateShuffleOrder();

    trackListEl.innerHTML = "";
    setHidden(emptyStateEl, tracks.length > 0);
    emptyStateEl.querySelector("p").textContent = (query || state.artistFilter)
      ? "No tracks match your search or filter."
      : state.view.type === "playlist"
        ? "This playlist is empty. Add tracks from All Songs."
        : "Your library is empty — go to Add Music to download something.";

    tracks.forEach((track, index) => {
      trackListEl.appendChild(buildTrackRow(track, index));
    });

    updatePlayingHighlight();
  }

  function buildTrackRow(track, index) {
    const row = document.createElement("div");
    row.className = "track-row";
    row.dataset.id = track.id;

    let cover;
    if (track.cover) {
      cover = document.createElement("img");
      cover.className = "track-cover";
      cover.src = track.cover;
      cover.alt = "";
    } else {
      cover = document.createElement("div");
      cover.className = "track-cover-fallback";
      cover.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="18" cy="16" r="3" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>';
    }

    const info = document.createElement("div");
    info.className = "track-info";
    const titleEl = document.createElement("div");
    titleEl.className = "track-title";
    titleEl.textContent = track.title;
    const artistEl = document.createElement("div");
    artistEl.className = "track-artist";
    artistEl.textContent = track.artist || "Unknown artist";
    info.appendChild(titleEl);
    info.appendChild(artistEl);

    const duration = document.createElement("div");
    duration.className = "track-duration";
    duration.textContent = formatTime(track.duration);

    const actions = document.createElement("div");
    actions.className = "track-actions";

    const addBtn = document.createElement("button");
    addBtn.className = "icon-btn";
    addBtn.title = "Add to playlist";
    addBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openAddPopover(track, addBtn);
    });
    actions.appendChild(addBtn);

    if (state.view.type === "playlist") {
      const removeBtn = document.createElement("button");
      removeBtn.className = "icon-btn";
      removeBtn.title = "Remove from playlist";
      removeBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      removeBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          const pl = currentPlaylist();
          await api("DELETE", `/api/playlists/${pl.id}/tracks/${encodeURIComponent(track.id)}`);
          await loadPlaylists();
          renderSidebar();
          renderView();
        } catch (err) {
          setStatus(err.message, true);
        }
      });
      actions.appendChild(removeBtn);
    }

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-btn danger";
    deleteBtn.title = "Delete from library";
    deleteBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${track.title}" from your library? This deletes the file.`)) return;
      try {
        await deleteTrack(track.id);
      } catch (err) {
        setStatus(err.message, true);
      }
    });
    actions.appendChild(deleteBtn);

    row.appendChild(cover);
    row.appendChild(info);
    row.appendChild(duration);
    row.appendChild(actions);

    row.addEventListener("click", () => playQueueAt(index));

    if (reorderEnabled) attachDragHandlers(row, track);

    return row;
  }

  // ---------------- playlist drag-to-reorder ----------------

  let reorderEnabled = false;
  let dragTrackId = null;

  function clearDropIndicators() {
    trackListEl.querySelectorAll(".drop-before, .drop-after").forEach((el) => {
      el.classList.remove("drop-before", "drop-after");
    });
  }

  function dropIsAfter(row, e) {
    const rect = row.getBoundingClientRect();
    return e.clientY > rect.top + rect.height / 2;
  }

  function attachDragHandlers(row, track) {
    row.draggable = true;

    row.addEventListener("dragstart", (e) => {
      dragTrackId = track.id;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", track.id);
    });

    row.addEventListener("dragend", () => {
      dragTrackId = null;
      row.classList.remove("dragging");
      clearDropIndicators();
    });

    row.addEventListener("dragover", (e) => {
      if (dragTrackId === null || dragTrackId === track.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      clearDropIndicators();
      row.classList.add(dropIsAfter(row, e) ? "drop-after" : "drop-before");
    });

    row.addEventListener("drop", async (e) => {
      e.preventDefault();
      const movedId = dragTrackId;
      const after = dropIsAfter(row, e);
      clearDropIndicators();
      if (movedId === null || movedId === track.id) return;

      const pl = currentPlaylist();
      if (!pl) return;
      const ids = pl.track_ids.filter((id) => id !== movedId);
      const targetPos = ids.indexOf(track.id);
      if (targetPos === -1) return;
      ids.splice(after ? targetPos + 1 : targetPos, 0, movedId);

      const previous = pl.track_ids;
      pl.track_ids = ids; // optimistic - the list reorders immediately
      renderView();
      try {
        await api("PUT", `/api/playlists/${pl.id}/order`, { track_ids: ids });
      } catch (err) {
        pl.track_ids = previous;
        renderView();
        setStatus(err.message, true);
      }
    });
  }

  function updatePlayingHighlight() {
    const current = state.queue[state.queueIndex];
    trackListEl.querySelectorAll(".track-row").forEach((row) => {
      row.classList.toggle("playing", !!current && row.dataset.id === current.id);
    });
  }

  // ---------------- rendering: dashboard ----------------

  const TILE_FALLBACK_ICON = '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="18" cy="16" r="3" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>';

  function buildTileArt(covers) {
    const art = document.createElement("div");
    art.className = "tile-art";
    if (covers.length >= 4) {
      art.classList.add("tile-art-grid");
      covers.slice(0, 4).forEach((src) => {
        const img = document.createElement("img");
        img.src = src;
        img.alt = "";
        art.appendChild(img);
      });
    } else if (covers.length >= 1) {
      const img = document.createElement("img");
      img.src = covers[0];
      img.alt = "";
      art.appendChild(img);
    } else {
      art.classList.add("tile-art-empty");
      art.innerHTML = TILE_FALLBACK_ICON;
    }
    return art;
  }

  // Picks the covers to show on a playlist tile: 4 distinct covers in a
  // 2x2 grid if the playlist has that much variety, otherwise just the
  // single most-used cover among its tracks (Spotify's auto-cover rule).
  function playlistTileCovers(playlist) {
    const counts = new Map();
    for (const id of playlist.track_ids) {
      const track = trackById(id);
      if (!track || !track.cover) continue;
      counts.set(track.cover, (counts.get(track.cover) || 0) + 1);
    }
    const distinct = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([cover]) => cover);
    return distinct.length >= 4 ? distinct.slice(0, 4) : distinct.slice(0, 1);
  }

  function buildPlaylistTile(playlist) {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.appendChild(buildTileArt(playlistTileCovers(playlist)));

    const name = document.createElement("div");
    name.className = "tile-name";
    name.textContent = playlist.name;
    const sub = document.createElement("div");
    sub.className = "tile-sub";
    sub.textContent = `${playlist.track_ids.length} track${playlist.track_ids.length === 1 ? "" : "s"}`;

    tile.appendChild(name);
    tile.appendChild(sub);
    tile.addEventListener("click", () => openPlaylist(playlist.id));
    return tile;
  }

  function topPlayedTracks(n) {
    return [...state.library]
      .filter((t) => (t.plays || 0) > 0)
      .sort((a, b) => (b.plays || 0) - (a.plays || 0))
      .slice(0, n);
  }

  function buildMostPlayedTile(track, index, topList) {
    const tile = document.createElement("div");
    tile.className = "tile tile-row";

    const art = buildTileArt(track.cover ? [track.cover] : []);
    art.classList.add("tile-art-sm");
    tile.appendChild(art);

    const text = document.createElement("div");
    text.className = "tile-text";
    const name = document.createElement("div");
    name.className = "tile-name";
    name.textContent = track.title;
    const sub = document.createElement("div");
    sub.className = "tile-sub";
    sub.textContent = track.artist || "Unknown artist";
    text.appendChild(name);
    text.appendChild(sub);
    tile.appendChild(text);

    tile.addEventListener("click", () => {
      state.queue = topList;
      state.queueIndex = -1;
      if (state.shuffle) regenerateShuffleOrder();
      playQueueAt(index);
    });
    return tile;
  }

  function renderDashboard() {
    dashboardPlaylistsGrid.innerHTML = "";
    setHidden(dashboardPlaylistsEmpty, state.playlists.length > 0);
    state.playlists.forEach((pl) => dashboardPlaylistsGrid.appendChild(buildPlaylistTile(pl)));

    const top = topPlayedTracks(4);
    mostPlayedGrid.innerHTML = "";
    setHidden(mostPlayedEmpty, top.length > 0);
    top.forEach((track, index) => mostPlayedGrid.appendChild(buildMostPlayedTile(track, index, top)));
  }

  // ---------------- navigation ----------------

  function resetSearch() {
    state.searchQuery = "";
    searchInput.value = "";
    setHidden(searchClearBtn, true);
  }

  function openDashboard() {
    state.view = { type: "dashboard" };
    resetSearch();
    renderSidebar();
    renderView();
  }

  function openLibrary() {
    state.view = { type: "library" };
    resetSearch();
    renderSidebar();
    renderView();
  }

  function openPlaylist(id) {
    state.view = { type: "playlist", id };
    resetSearch();
    renderSidebar();
    renderView();
  }

  function openAdd() {
    state.view = { type: "add" };
    resetSearch();
    renderSidebar();
    renderView();
  }

  function openNowPlaying() {
    state.view = { type: "nowplaying" };
    resetSearch();
    renderSidebar();
    renderView();
  }

  navDashboard.addEventListener("click", openDashboard);
  navLibrary.addEventListener("click", openLibrary);
  navAdd.addEventListener("click", openAdd);
  navNowPlaying.addEventListener("click", openNowPlaying);

  searchInput.addEventListener("input", () => {
    state.searchQuery = searchInput.value;
    setHidden(searchClearBtn, !searchInput.value);
    renderView();
  });
  searchClearBtn.addEventListener("click", () => {
    resetSearch();
    searchInput.focus();
    renderView();
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      resetSearch();
      renderView();
      searchInput.blur();
    }
  });

  // ---------------- add-to-playlist popover ----------------

  function closePopover() {
    setHidden(addPopover, true);
    addPopover.innerHTML = "";
  }

  function openAddPopover(track, anchorEl) {
    if (!addPopover.hasAttribute("hidden") && addPopover.dataset.trackId === track.id) {
      closePopover();
      return;
    }
    addPopover.innerHTML = "";
    addPopover.dataset.trackId = track.id;

    if (state.playlists.length === 0) {
      const empty = document.createElement("div");
      empty.className = "popover-empty";
      empty.textContent = "No playlists yet — create one first.";
      addPopover.appendChild(empty);
    } else {
      for (const pl of state.playlists) {
        const item = document.createElement("div");
        const checked = pl.track_ids.includes(track.id);
        item.className = "popover-item" + (checked ? " checked" : "");
        const box = document.createElement("span");
        box.className = "popover-check";
        box.innerHTML = checked ? '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>' : "";
        const label = document.createElement("span");
        label.textContent = pl.name;
        item.appendChild(box);
        item.appendChild(label);
        item.addEventListener("click", async () => {
          try {
            if (checked) {
              await api("DELETE", `/api/playlists/${pl.id}/tracks/${encodeURIComponent(track.id)}`);
            } else {
              await api("POST", `/api/playlists/${pl.id}/tracks`, { track_id: track.id });
            }
            await loadPlaylists();
            renderSidebar();
            if (state.view.type === "playlist") renderView();
            closePopover();
          } catch (err) {
            setStatus(err.message, true);
          }
        });
        addPopover.appendChild(item);
      }
    }

    const rect = anchorEl.getBoundingClientRect();
    setHidden(addPopover, false);
    const popRect = addPopover.getBoundingClientRect();
    let left = rect.left - popRect.width + rect.width;
    let top = rect.bottom + 6;
    if (top + popRect.height > window.innerHeight) top = rect.top - popRect.height - 6;
    addPopover.style.left = `${Math.max(8, left)}px`;
    addPopover.style.top = `${Math.max(8, top)}px`;
  }

  document.addEventListener("click", (e) => {
    if (!addPopover.hasAttribute("hidden") && !addPopover.contains(e.target)) closePopover();
  });

  // ---------------- playback engine ----------------

  function shuffledIndices(length) {
    const order = Array.from({ length }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  }

  // Rebuilds the shuffle play-order for the current queue, keeping whatever
  // is currently playing as the starting point so toggling shuffle on (or
  // re-filtering the view) doesn't change what's playing.
  function regenerateShuffleOrder() {
    const order = shuffledIndices(state.queue.length);
    if (state.queueIndex !== -1) {
      const pos = order.indexOf(state.queueIndex);
      if (pos > 0) [order[0], order[pos]] = [order[pos], order[0]];
      state.shufflePos = 0;
    } else {
      state.shufflePos = -1;
    }
    state.shuffleOrder = order;
  }

  function toggleShuffle() {
    state.shuffle = !state.shuffle;
    shuffleBtn.classList.toggle("active", state.shuffle);
    shuffleBtn.title = state.shuffle ? "Shuffle on" : "Shuffle off";
    if (state.shuffle) regenerateShuffleOrder();
  }

  function recordPlay(track) {
    track.plays = (track.plays || 0) + 1;
    api("POST", `/api/tracks/${encodeURIComponent(track.id)}/play`).catch(() => {});
  }

  function playQueueAt(index) {
    if (index < 0 || index >= state.queue.length) return;
    state.queueIndex = index;
    if (state.shuffle) {
      const pos = state.shuffleOrder.indexOf(index);
      state.shufflePos = pos !== -1 ? pos : 0;
    }
    const track = state.queue[index];
    applyNormalization(track);
    audio.src = `/audio/${encodeURIComponent(track.id)}`;
    audio.currentTime = 0;
    audio.play().catch(() => {});
    recordPlay(track);
    updateNowPlayingUI(track);
    updatePlayingHighlight();
  }

  function updateMediaSessionMetadata(track) {
    if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
    if (!track) {
      navigator.mediaSession.metadata = null;
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist || "Unknown artist",
      album: "Music",
      artwork: track.cover
        ? [{ src: new URL(track.cover, location.href).href, sizes: "512x512", type: "image/jpeg" }]
        : [],
    });
  }

  function updateNowPlayingUI(track) {
    updateMediaSessionMetadata(track);
    if (track && track.cover) {
      npCover.src = track.cover;
      setHidden(npCover, false);
      setHidden(npCoverFallback, true);
    } else {
      setHidden(npCover, true);
      setHidden(npCoverFallback, false);
    }
    npTitle.textContent = track ? track.title : "No track loaded";
    npArtist.textContent = track ? (track.artist || "Unknown artist") : "";

    // The dedicated Now Playing page mirrors the same track.
    setHidden(nowplayingEmptyEl, !!track);
    setHidden(nowplayingContentEl, !track);
    if (track) {
      if (track.cover) {
        nowplayingCover.src = track.cover;
        setHidden(nowplayingCover, false);
        setHidden(nowplayingCoverFallback, true);
      } else {
        setHidden(nowplayingCover, true);
        setHidden(nowplayingCoverFallback, false);
      }
      nowplayingTitle.textContent = track.title;
      nowplayingArtist.textContent = track.artist || "Unknown artist";
    }
  }

  function playPause() {
    if (state.queueIndex === -1) {
      if (state.queue.length > 0) playQueueAt(0);
      return;
    }
    if (audio.paused) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }

  function goNext(fromEnded) {
    if (state.queue.length === 0) return;
    if (fromEnded && state.repeat === "one") {
      playQueueAt(state.queueIndex);
      return;
    }
    if (state.shuffle) {
      let pos = state.shufflePos + 1;
      if (pos >= state.shuffleOrder.length) {
        if (state.repeat !== "all") return;
        const lastIndex = state.shuffleOrder[state.shuffleOrder.length - 1];
        const order = shuffledIndices(state.queue.length);
        if (order.length > 1 && order[0] === lastIndex) {
          [order[0], order[1]] = [order[1], order[0]];
        }
        state.shuffleOrder = order;
        pos = 0;
      }
      state.shufflePos = pos;
      playQueueAt(state.shuffleOrder[pos]);
      return;
    }
    let next = state.queueIndex + 1;
    if (next >= state.queue.length) {
      if (state.repeat === "all") next = 0;
      else return;
    }
    playQueueAt(next);
  }

  function goPrev() {
    if (state.queue.length === 0) return;
    if (audio.currentTime > 5) {
      audio.currentTime = 0;
      return;
    }
    if (state.shuffle) {
      let pos = state.shufflePos - 1;
      if (pos < 0) pos = state.repeat === "all" ? state.shuffleOrder.length - 1 : 0;
      state.shufflePos = pos;
      playQueueAt(state.shuffleOrder[pos]);
      return;
    }
    let prev = state.queueIndex - 1;
    if (prev < 0) prev = state.repeat === "all" ? state.queue.length - 1 : 0;
    playQueueAt(prev);
  }

  function cycleRepeat() {
    state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
    repeatBtn.classList.toggle("active", state.repeat !== "off");
    repeatBtn.title = state.repeat === "off" ? "Repeat off" : state.repeat === "all" ? "Repeat all" : "Repeat one";
    setHidden(repeatOneDot, state.repeat !== "one");
  }

  shuffleBtn.addEventListener("click", toggleShuffle);
  prevBtn.addEventListener("click", goPrev);
  nextBtn.addEventListener("click", () => goNext(false));
  playBtn.addEventListener("click", playPause);
  repeatBtn.addEventListener("click", cycleRepeat);

  // ---------------- now playing visualizer ----------------
  // Frequency bars from a Web Audio AnalyserNode. The audio is served from the
  // same origin, so routing it through the graph is allowed; the graph is built
  // lazily on first play because browsers require a user gesture to start it.

  const VIZ_BARS = 48;
  let audioCtx = null;
  let gainNode = null;
  let analyser = null;
  let freqData = null;
  let vizRaf = 0;

  // audio element -> gain (volume normalization) -> analyser (visualizer) -> speakers
  function ensureAudioGraph() {
    if (analyser) return true;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaElementSource(audio);
      gainNode = audioCtx.createGain();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.78;
      source.connect(gainNode);
      gainNode.connect(analyser);
      analyser.connect(audioCtx.destination);
      freqData = new Uint8Array(analyser.frequencyBinCount);
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
      return true;
    } catch (_) {
      analyser = null; // optional features; plain playback keeps working without the graph
      gainNode = null;
      return false;
    }
  }

  // ---------------- volume normalization ----------------
  // The server measures each track's loudness and hands back the gain (dB)
  // that brings it to a common level; it's applied here via the gain node.

  function setGainDb(db) {
    if (!gainNode) return;
    gainNode.gain.setTargetAtTime(Math.pow(10, db / 20), audioCtx.currentTime, 0.03);
  }

  async function applyNormalization(track) {
    if (state.settings.normalize_volume === false) {
      setGainDb(0); // no-op if the graph was never built
      return;
    }
    if (!ensureAudioGraph()) return;
    if (typeof track.gain_db === "number") {
      setGainDb(track.gain_db);
      return;
    }
    setGainDb(0); // not measured yet - ask the server to measure it now
    try {
      const { gain_db } = await api("GET", `/api/tracks/${encodeURIComponent(track.id)}/loudness`);
      track.gain_db = typeof gain_db === "number" ? gain_db : 0;
    } catch (_) {
      return;
    }
    const current = state.queue[state.queueIndex];
    if (current && current.id === track.id && state.settings.normalize_volume !== false) {
      setGainDb(track.gain_db);
    }
  }

  function drawVisualizer() {
    vizRaf = 0;
    if (state.view.type !== "nowplaying" || audio.paused || !analyser) return;
    analyser.getByteFrequencyData(freqData);

    const ctx = vizCanvas.getContext("2d");
    const w = vizCanvas.width;
    const h = vizCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const rgb = getComputedStyle(document.documentElement).getPropertyValue("--accent-rgb").trim() || "255, 138, 61";
    const usable = Math.floor(freqData.length * 0.6); // top bins are mostly empty
    const slot = w / VIZ_BARS;
    const barW = slot * 0.62;
    for (let i = 0; i < VIZ_BARS; i++) {
      // Spread low frequencies over more bars than high ones.
      const bin = Math.floor(Math.pow(i / VIZ_BARS, 1.5) * usable);
      const level = Math.pow(freqData[bin] / 255, 1.3);
      const barH = Math.max(4, level * h);
      const x = i * slot + (slot - barW) / 2;
      ctx.fillStyle = `rgb(${rgb})`;
      ctx.beginPath();
      ctx.roundRect(x, h - barH, barW, barH, barW / 2);
      ctx.fill();
    }
    vizRaf = requestAnimationFrame(drawVisualizer);
  }

  function startVisualizer() {
    if (state.view.type !== "nowplaying" || audio.paused || vizRaf) return;
    if (!ensureAudioGraph()) return;
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    vizRaf = requestAnimationFrame(drawVisualizer);
  }

  audio.addEventListener("play", () => {
    setHidden(playIcon, true);
    setHidden(pauseIcon, false);
    // Audio routed through the graph is silent while the context is suspended.
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    startVisualizer();
  });
  audio.addEventListener("pause", () => {
    setHidden(playIcon, false);
    setHidden(pauseIcon, true);
  });
  audio.addEventListener("ended", () => goNext(true));

  audio.addEventListener("loadedmetadata", () => {
    timeDuration.textContent = formatTime(audio.duration);
  });

  audio.addEventListener("timeupdate", () => {
    if (seekDragging) return;
    const dur = audio.duration || 0;
    const pct = dur ? (audio.currentTime / dur) * 1000 : 0;
    seek.value = pct;
    seek.style.setProperty("--fill", `${dur ? (pct / 10) : 0}%`);
    timeCurrent.textContent = formatTime(audio.currentTime);
    if (dur) timeDuration.textContent = formatTime(dur);
  });

  seek.addEventListener("input", () => {
    seekDragging = true;
    seek.style.setProperty("--fill", `${seek.value / 10}%`);
    const dur = audio.duration || 0;
    timeCurrent.textContent = formatTime((seek.value / 1000) * dur);
  });
  seek.addEventListener("change", () => {
    const dur = audio.duration || 0;
    audio.currentTime = (seek.value / 1000) * dur;
    seekDragging = false;
  });

  volume.addEventListener("input", () => {
    audio.volume = volume.value / 100;
    audio.muted = false;
    volume.style.setProperty("--fill", `${volume.value}%`);
  });

  let lastVolume = 70;
  muteBtn.addEventListener("click", () => {
    if (audio.muted || audio.volume === 0) {
      audio.muted = false;
      audio.volume = lastVolume / 100;
      volume.value = lastVolume;
    } else {
      lastVolume = volume.value;
      audio.muted = true;
      volume.value = 0;
    }
    volume.style.setProperty("--fill", `${volume.value}%`);
  });

  // ---------------- deleting tracks ----------------

  async function deleteTrack(trackId) {
    const wasPlaying = state.queue[state.queueIndex] && state.queue[state.queueIndex].id === trackId;
    await api("DELETE", `/api/tracks/${encodeURIComponent(trackId)}`);
    if (wasPlaying) {
      audio.pause();
      audio.removeAttribute("src");
      state.queueIndex = -1;
      updateNowPlayingUI(null);
    }
    await Promise.all([loadLibrary(), loadPlaylists()]);
    renderSidebar();
    renderView();
  }

  // ---------------- add music: single track ----------------

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function setAddStatus(html) {
    addStatusEl.innerHTML = html;
  }

  trackForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = trackUrlInput.value.trim();
    if (!url) return;
    trackAddBtn.disabled = true;
    setAddStatus("Starting download&hellip;");
    try {
      const { job_id } = await api("POST", "/api/download", { url, mode: "track" });
      await pollTrackJob(job_id);
    } catch (err) {
      setAddStatus(`<span class="progress-error">${escapeHtml(err.message)}</span>`);
      trackAddBtn.disabled = false;
    }
  });

  function pollTrackJob(jobId) {
    return new Promise((resolve) => {
      const tick = async () => {
        let job;
        try {
          job = await api("GET", `/api/download/${jobId}`);
        } catch (err) {
          setAddStatus(`<span class="progress-error">${escapeHtml(err.message)}</span>`);
          trackAddBtn.disabled = false;
          resolve();
          return;
        }
        if (job.status === "downloading") {
          const label = job.percent
            ? (job.percent.startsWith("Converting") ? job.percent : `Downloading ${job.percent}`)
            : "Downloading…";
          const pct = parseFloat(job.percent);
          const bar = isFinite(pct) ? `<div class="progress-bar"><div style="width:${Math.min(100, pct)}%"></div></div>` : "";
          setAddStatus(`<div class="progress-line">${escapeHtml(label)}</div>${bar}`);
          setTimeout(tick, 500);
        } else if (job.status === "done") {
          setAddStatus(job.duplicate
            ? `<span class="progress-done">Already in your library: ${escapeHtml(job.title)}</span>`
            : `<span class="progress-done">Downloaded: ${escapeHtml(job.title)}</span>`);
          trackUrlInput.value = "";
          trackAddBtn.disabled = false;
          await loadLibrary();
          if (state.view.type === "library") renderView();
          resolve();
        } else {
          setAddStatus(`<span class="progress-error">${escapeHtml(job.error || "Download failed")}</span>`);
          trackAddBtn.disabled = false;
          resolve();
        }
      };
      tick();
    });
  }

  // ---------------- add music: playlist import ----------------

  // Importing a playlist link asks how it should be saved before anything downloads.
  let pendingPlaylistUrl = "";

  function closePlaylistChoice() {
    setHidden(playlistChoiceEl, true);
    pendingPlaylistUrl = "";
    playlistImportBtn.disabled = false;
  }

  playlistForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const url = playlistUrlInput.value.trim();
    if (!url) return;
    pendingPlaylistUrl = url;
    playlistImportBtn.disabled = true;
    setHidden(playlistChoiceEl, false);
  });

  async function startPlaylistImport(asPlaylist) {
    const url = pendingPlaylistUrl;
    setHidden(playlistChoiceEl, true);
    pendingPlaylistUrl = "";
    if (!url) { playlistImportBtn.disabled = false; return; }
    setAddStatus("Reading playlist&hellip;");
    try {
      const { job_id } = await api("POST", "/api/download", { url, mode: "playlist", as_playlist: asPlaylist });
      await pollPlaylistJob(job_id);
    } catch (err) {
      setAddStatus(`<span class="progress-error">${escapeHtml(err.message)}</span>`);
      playlistImportBtn.disabled = false;
    }
  }

  choicePlaylistBtn.addEventListener("click", () => startPlaylistImport(true));
  choiceSongsBtn.addEventListener("click", () => startPlaylistImport(false));
  choiceCancelBtn.addEventListener("click", closePlaylistChoice);

  document.querySelectorAll(".add-paste").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        const text = await navigator.clipboard.readText();
        const input = document.getElementById(btn.dataset.target);
        input.value = text.trim();
        input.focus();
      } catch (_) {
        setAddStatus('<span class="progress-error">Could not read the clipboard &mdash; paste with Ctrl+V instead.</span>');
      }
    });
  });

  function renderPlaylistProgress(job) {
    const skipped = job.skipped || [];
    const done = job.added.length + skipped.length + job.failed.length;
    const total = job.total || done;
    const parts = [];
    const asPlaylist = job.as_playlist !== false;
    let line = asPlaylist
      ? `Importing "${escapeHtml(job.playlist_name || "playlist")}"`
      : `Importing songs from "${escapeHtml(job.playlist_name || "playlist")}"`;
    if (total) line += ` &mdash; ${job.added.length + skipped.length}/${total}`;
    if (job.status === "downloading" && job.current_title) line += ` &mdash; now: ${escapeHtml(job.current_title)}`;
    parts.push(`<div class="progress-line">${line}</div>`);
    if (total && job.status === "downloading") {
      const pct = Math.round(((job.added.length + skipped.length + job.failed.length) / total) * 100);
      parts.push(`<div class="progress-bar"><div style="width:${pct}%"></div></div>`);
    }
    if (job.added.length) {
      parts.push(`<div class="progress-added">Added: ${job.added.map((t) => escapeHtml(t.title)).join(", ")}</div>`);
    }
    if (skipped.length) {
      parts.push(`<div class="progress-added">Already in library: ${skipped.map((t) => escapeHtml(t.title)).join(", ")}</div>`);
    }
    if (job.failed.length) {
      parts.push(`<div class="progress-failed">Failed: ${job.failed.map((t) => escapeHtml(t.title)).join(", ")}</div>`);
    }
    if (job.status === "done") {
      const plural = (n) => `${n} track${n === 1 ? "" : "s"}`;
      let summary = `Done &mdash; added ${plural(job.added.length)}${asPlaylist ? "" : " to your library"}`;
      if (skipped.length) summary += `, ${skipped.length} already in library`;
      if (job.failed.length) summary += `, ${job.failed.length} failed`;
      parts.push(`<div class="progress-done">${summary}.</div>`);
    }
    setAddStatus(parts.join(""));
  }

  function pollPlaylistJob(jobId) {
    return new Promise((resolve) => {
      const tick = async () => {
        let job;
        try {
          job = await api("GET", `/api/download/${jobId}`);
        } catch (err) {
          setAddStatus(`<span class="progress-error">${escapeHtml(err.message)}</span>`);
          playlistImportBtn.disabled = false;
          resolve();
          return;
        }
        if (job.status === "error") {
          setAddStatus(`<span class="progress-error">${escapeHtml(job.error || "Import failed")}</span>`);
          playlistImportBtn.disabled = false;
          resolve();
          return;
        }

        renderPlaylistProgress(job);
        await Promise.all([loadLibrary(), loadPlaylists()]);
        renderSidebar();
        if (state.view.type === "playlist" && state.view.id === job.playlist_id) renderView();
        if (state.view.type === "library" || state.view.type === "dashboard") renderView();

        if (job.status === "done") {
          playlistUrlInput.value = "";
          playlistImportBtn.disabled = false;
          resolve();
        } else {
          setTimeout(tick, 800);
        }
      };
      tick();
    });
  }

  // ---------------- new playlist modal ----------------

  function openModal(title, confirmLabel, initialValue, onConfirm) {
    modalTitle.textContent = title;
    modalConfirm.textContent = confirmLabel;
    modalInput.value = initialValue || "";
    modalOnConfirm = onConfirm;
    setHidden(modalBackdrop, false);
    modalInput.focus();
    modalInput.select();
  }

  function closeModal() {
    setHidden(modalBackdrop, true);
    modalOnConfirm = null;
  }

  newPlaylistBtn.addEventListener("click", () => {
    openModal("New Playlist", "Create", "", async (name) => {
      const playlist = await api("POST", "/api/playlists", { name });
      await loadPlaylists();
      renderSidebar();
      openPlaylist(playlist.id);
    });
  });

  modalCancel.addEventListener("click", closeModal);
  modalBackdrop.addEventListener("click", (e) => {
    if (e.target === modalBackdrop) closeModal();
  });
  modalConfirm.addEventListener("click", async () => {
    const value = modalInput.value.trim();
    if (!value || !modalOnConfirm) return;
    try {
      await modalOnConfirm(value);
      closeModal();
    } catch (err) {
      setStatus(err.message, true);
    }
  });
  modalInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); modalConfirm.click(); }
    if (e.key === "Escape") { e.preventDefault(); closeModal(); }
  });

  // ---------------- settings ----------------

  function hexToRgbArr(hex) {
    const m = hex.replace("#", "");
    return [0, 2, 4].map((i) => parseInt(m.substr(i, 2), 16));
  }

  function rgbToHex([r, g, b]) {
    return "#" + [r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("");
  }

  function relativeLuminance([r, g, b]) {
    const [R, G, B] = [r, g, b].map((c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
  }

  function lighten(hex, amount) {
    const rgb = hexToRgbArr(hex).map((c) => c + (255 - c) * amount);
    return rgbToHex(rgb);
  }

  function applyAccentColor(hex) {
    const rgb = hexToRgbArr(hex);
    const root = document.documentElement.style;
    root.setProperty("--accent", hex);
    root.setProperty("--accent-hover", lighten(hex, 0.18));
    root.setProperty("--accent-rgb", rgb.join(", "));
    root.setProperty("--accent-text", relativeLuminance(rgb) > 0.5 ? "#1a0f05" : "#ffffff");

    let matched = false;
    colorSwatches.querySelectorAll(".color-swatch[data-color]").forEach((btn) => {
      const isMatch = btn.dataset.color.toLowerCase() === hex.toLowerCase();
      btn.classList.toggle("active", isMatch);
      if (isMatch) matched = true;
    });
    customColorInput.value = hex;
    colorSwatches.querySelector(".color-swatch-custom").classList.toggle("active", !matched);
  }

  async function saveSettings(partial) {
    Object.assign(state.settings, partial);
    try {
      state.settings = await api("POST", "/api/settings", partial);
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  colorSwatches.querySelectorAll(".color-swatch[data-color]").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyAccentColor(btn.dataset.color);
      saveSettings({ accent_color: btn.dataset.color });
    });
  });

  customColorInput.addEventListener("input", () => {
    applyAccentColor(customColorInput.value);
  });
  customColorInput.addEventListener("change", () => {
    saveSettings({ accent_color: customColorInput.value });
  });

  idleTimeoutInput.addEventListener("change", () => {
    let minutes = parseFloat(idleTimeoutInput.value);
    if (!isFinite(minutes) || minutes < 1) minutes = 1;
    if (minutes > 180) minutes = 180;
    idleTimeoutInput.value = minutes;
    saveSettings({ idle_timeout_minutes: minutes });
    resetIdleTimer();
  });

  deleteAllPlaylistsBtn.addEventListener("click", async () => {
    const count = state.playlists.length;
    if (count === 0) {
      setStatus("There are no playlists to delete.", false);
      return;
    }
    if (!confirm(`Delete all ${count} playlist${count === 1 ? "" : "s"}? Your songs stay in the library, but this can't be undone.`)) return;
    try {
      await api("DELETE", "/api/playlists");
      await loadPlaylists();
      setHidden(settingsDropdown, true);
      if (state.view.type === "playlist") openDashboard();
      else { renderSidebar(); renderView(); }
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  deleteAllSongsBtn.addEventListener("click", async () => {
    const count = state.library.length;
    if (count === 0) {
      setStatus("There are no songs to delete.", false);
      return;
    }
    if (!confirm(`Delete all ${count} song${count === 1 ? "" : "s"} from your library? This permanently deletes the files and can't be undone. Playlists are kept but emptied.`)) return;
    try {
      await api("DELETE", "/api/tracks");
      // Stop playback and clear the queue - the files it points at are gone.
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      state.queue = [];
      state.queueIndex = -1;
      updateNowPlayingUI(null);
      await Promise.all([loadLibrary(), loadPlaylists()]);
      setHidden(settingsDropdown, true);
      renderSidebar();
      renderView();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  normalizeToggle.addEventListener("change", () => {
    saveSettings({ normalize_volume: normalizeToggle.checked });
    const current = state.queue[state.queueIndex];
    if (current) applyNormalization(current);
  });

  function toggleSettingsDropdown() {
    if (!settingsDropdown.hasAttribute("hidden")) {
      setHidden(settingsDropdown, true);
      return;
    }
    const rect = settingsBtn.getBoundingClientRect();
    setHidden(settingsDropdown, false);
    const popRect = settingsDropdown.getBoundingClientRect();
    let top = rect.top - popRect.height - 8;
    if (top < 8) top = rect.bottom + 8;
    settingsDropdown.style.left = `${Math.max(8, rect.left)}px`;
    settingsDropdown.style.top = `${Math.max(8, top)}px`;
  }

  settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSettingsDropdown();
  });

  document.addEventListener("click", (e) => {
    if (!settingsDropdown.hasAttribute("hidden") && !settingsDropdown.contains(e.target) && !settingsBtn.contains(e.target)) {
      setHidden(settingsDropdown, true);
    }
  });

  // ---------------- idle / inactivity tracking ----------------

  function clearIdleHint() {
    idleHintShown = false;
    setHidden(nowPlayingHintDot, true);
  }

  function resetIdleTimer() {
    clearIdleHint();
    if (idleTimerId) clearTimeout(idleTimerId);
    const ms = state.settings.idle_timeout_minutes * 60 * 1000;
    idleTimerId = setTimeout(() => {
      // Only worth inviting the user to Now Playing if something is
      // actually loaded and they're not already looking at it.
      if (state.queueIndex !== -1 && state.view.type !== "nowplaying") {
        idleHintShown = true;
        setHidden(nowPlayingHintDot, false);
      }
    }, ms);
  }

  ["mousemove", "mousedown", "keydown", "wheel", "touchstart"].forEach((evt) => {
    document.addEventListener(evt, resetIdleTimer, { passive: true });
  });

  // ---------------- keyboard shortcuts ----------------

  // Fn is handled in keyboard firmware and never reaches the page, so Fn+J/K/L
  // arrives as plain J/K/L (or as media keys on keyboards that remap them).
  // Handle both: back = J / MediaTrackPrevious, pause = K / MediaPlayPause,
  // next = L / MediaTrackNext.
  document.addEventListener("keydown", (e) => {
    const typing = e.target.tagName === "INPUT" || e.target.isContentEditable;

    // Dedicated media keys are safe to honour even while typing in a field.
    if (e.code === "MediaTrackPrevious") { e.preventDefault(); goPrev(); return; }
    if (e.code === "MediaTrackNext") { e.preventDefault(); goNext(false); return; }
    if (e.code === "MediaPlayPause") { e.preventDefault(); playPause(); return; }

    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === "Space" || e.code === "KeyK") { e.preventDefault(); playPause(); }
    else if (e.code === "KeyJ") { e.preventDefault(); goPrev(); }
    else if (e.code === "KeyL") { e.preventDefault(); goNext(false); }
  });

  // Lets the OS route hardware media keys / overlay controls to the player
  // even when the window isn't focused.
  if ("mediaSession" in navigator) {
    const ms = navigator.mediaSession;
    const setHandler = (action, fn) => { try { ms.setActionHandler(action, fn); } catch (_) {} };
    setHandler("play", () => { if (audio.paused) playPause(); });
    setHandler("pause", () => { if (!audio.paused) playPause(); });
    setHandler("previoustrack", goPrev);
    setHandler("nexttrack", () => goNext(false));
  }

  // ---------------- init ----------------

  async function init() {
    volume.style.setProperty("--fill", "70%");
    seek.style.setProperty("--fill", "0%");
    try {
      await Promise.all([loadLibrary(), loadPlaylists()]);
    } catch (err) {
      setStatus(err.message, true);
    }
    try {
      state.settings = await api("GET", "/api/settings");
    } catch (err) {
      // keep the built-in defaults already in state.settings
    }
    applyAccentColor(state.settings.accent_color);
    idleTimeoutInput.value = state.settings.idle_timeout_minutes;
    normalizeToggle.checked = state.settings.normalize_volume !== false;
    resetIdleTimer();
    renderSidebar();
    renderView();
  }

  init();
})();

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
    shuffle: false,
    shuffleOrder: [],    // permutation of indices into state.queue
    shufflePos: -1,      // current position within shuffleOrder
    settings: { accent_color: "#ff8a3d", idle_timeout_minutes: 2 },
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

  const navNowPlaying = document.getElementById("nav-nowplaying");
  const nowPlayingHintDot = document.getElementById("nowplaying-hint-dot");
  const nowplayingPageEl = document.getElementById("nowplaying-page");
  const nowplayingEmptyEl = document.getElementById("nowplaying-empty");
  const nowplayingContentEl = document.getElementById("nowplaying-content");
  const nowplayingCover = document.getElementById("nowplaying-cover");
  const nowplayingCoverFallback = document.getElementById("nowplaying-cover-fallback");
  const nowplayingTitle = document.getElementById("nowplaying-title");
  const nowplayingArtist = document.getElementById("nowplaying-artist");

  const settingsBtn = document.getElementById("settings-btn");
  const settingsDropdown = document.getElementById("settings-dropdown");
  const idleTimeoutInput = document.getElementById("idle-timeout-input");
  const colorSwatches = document.getElementById("color-swatches");
  const customColorInput = document.getElementById("custom-color-input");

  const trackForm = document.getElementById("track-form");
  const trackUrlInput = document.getElementById("track-url");
  const trackAddBtn = document.getElementById("track-add-btn");
  const playlistForm = document.getElementById("playlist-form");
  const playlistUrlInput = document.getElementById("playlist-url");
  const playlistImportBtn = document.getElementById("playlist-import-btn");
  const addStatusEl = document.getElementById("add-status");

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

  function hideAllPages() {
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
      return;
    }
    hideAllPages();
    setHidden(searchBox, false);
    setHidden(trackListEl, false);

    viewTitle.textContent = state.view.type === "playlist"
      ? (currentPlaylist() ? currentPlaylist().name : "Playlist")
      : "All Songs";

    const allTracks = tracksForView();
    const query = state.searchQuery.trim().toLowerCase();
    const tracks = query
      ? allTracks.filter((t) => t.title.toLowerCase().includes(query) || (t.artist || "").toLowerCase().includes(query))
      : allTracks;

    const playingId = state.queue[state.queueIndex] ? state.queue[state.queueIndex].id : null;
    state.queue = tracks;
    state.queueIndex = playingId ? tracks.findIndex((t) => t.id === playingId) : -1;
    if (state.shuffle) regenerateShuffleOrder();

    trackListEl.innerHTML = "";
    setHidden(emptyStateEl, tracks.length > 0);
    emptyStateEl.querySelector("p").textContent = query
      ? `No matches for "${state.searchQuery.trim()}".`
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

    return row;
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
    audio.src = `/audio/${encodeURIComponent(track.id)}`;
    audio.currentTime = 0;
    audio.play().catch(() => {});
    recordPlay(track);
    updateNowPlayingUI(track);
    updatePlayingHighlight();
  }

  function updateNowPlayingUI(track) {
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

  audio.addEventListener("play", () => {
    setHidden(playIcon, true);
    setHidden(pauseIcon, false);
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
          setAddStatus(escapeHtml(label));
          setTimeout(tick, 500);
        } else if (job.status === "done") {
          setAddStatus(`<span class="progress-done">Downloaded: ${escapeHtml(job.title)}</span>`);
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

  playlistForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = playlistUrlInput.value.trim();
    if (!url) return;
    playlistImportBtn.disabled = true;
    setAddStatus("Reading playlist&hellip;");
    try {
      const { job_id } = await api("POST", "/api/download", { url, mode: "playlist" });
      await pollPlaylistJob(job_id);
    } catch (err) {
      setAddStatus(`<span class="progress-error">${escapeHtml(err.message)}</span>`);
      playlistImportBtn.disabled = false;
    }
  });

  function renderPlaylistProgress(job) {
    const done = job.added.length + job.failed.length;
    const total = job.total || done;
    const parts = [];
    let line = `Importing "${escapeHtml(job.playlist_name || "playlist")}"`;
    if (total) line += ` &mdash; ${job.added.length}/${total}`;
    if (job.status === "downloading" && job.current_title) line += ` &mdash; now: ${escapeHtml(job.current_title)}`;
    parts.push(`<div class="progress-line">${line}</div>`);
    if (job.added.length) {
      parts.push(`<div class="progress-added">Added: ${job.added.map((t) => escapeHtml(t.title)).join(", ")}</div>`);
    }
    if (job.failed.length) {
      parts.push(`<div class="progress-failed">Failed: ${job.failed.map((t) => escapeHtml(t.title)).join(", ")}</div>`);
    }
    if (job.status === "done") {
      const summary = job.failed.length
        ? `Done &mdash; added ${job.added.length} track${job.added.length === 1 ? "" : "s"}, ${job.failed.length} failed.`
        : `Done &mdash; added ${job.added.length} track${job.added.length === 1 ? "" : "s"}.`;
      parts.push(`<div class="progress-done">${summary}</div>`);
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

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.isContentEditable) return;
    if (e.code === "Space") { e.preventDefault(); playPause(); }
  });

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
    resetIdleTimer();
    renderSidebar();
    renderView();
  }

  init();
})();

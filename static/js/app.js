(() => {
  "use strict";

  // ---------------- state ----------------

  const state = {
    library: [],       // all tracks in the local library
    playlists: [],      // [{id, name, track_ids}]
    view: { type: "dashboard" },  // {type:"dashboard"} | {type:"library"} | {type:"playlist", id} | {type:"add"}
    queue: [],          // tracks currently shown / playable in order (the "context")
    queueIndex: -1,     // position of the last context track played within state.queue
    upNext: [],         // [{qid, track}] user-queued tracks, played before the context continues
    current: null,      // the track that is loaded/playing right now
    fromUpNext: false,  // whether `current` came from upNext rather than the context
    wrapOrder: null,    // pre-rolled shuffle order used when repeat-all wraps around
    selected: new Set(),   // ids of the songs ticked in the current list (multi-select)
    selectionMode: false,  // the "Select" button is on (checkboxes show even with nothing ticked)
    selectAnchor: null,    // last song ticked, the start of a shift+click range
    repeat: "off",       // off | all | one
    searchQuery: "",
    sortKey: "default",  // default | title | artist | plays | duration | added
    sortDir: "asc",
    artistFilter: "",    // "" = all, UNKNOWN_ARTIST, or an artist name
    shuffle: false,
    shuffleOrder: [],    // permutation of indices into state.queue
    shufflePos: -1,      // current position within shuffleOrder
    settings: {
      accent_color: "#ff8a3d", idle_timeout_minutes: 2, normalize_volume: true,
      transition_mode: "gapless", crossfade_seconds: 5,
    },
  };

  let idleHintShown = false;
  let idleTimerId = null;

  // Two <audio> "decks" share one Web Audio graph so the next song can be
  // preloaded and started on top of the current one (gapless / crossfade).
  // `audio` always points at the deck that is currently the player.
  const decks = [{ el: new Audio(), track: null }, { el: new Audio(), track: null }];
  decks.forEach((d) => { d.el.volume = 0.7; d.el.preload = "auto"; });
  let activeDeck = decks[0];
  let audio = activeDeck.el;

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
  const selectToggle = document.getElementById("select-toggle");
  const selectionBarEl = document.getElementById("selection-bar");
  const selectionCountEl = document.getElementById("selection-count");
  const selAllBtn = document.getElementById("sel-all");
  const selPlayNextBtn = document.getElementById("sel-play-next");
  const selQueueBtn = document.getElementById("sel-queue");
  const selPlaylistBtn = document.getElementById("sel-playlist");
  const selRemoveBtn = document.getElementById("sel-remove");
  const selDeleteBtn = document.getElementById("sel-delete");
  const sortSelect = document.getElementById("sort-select");
  const sortDirBtn = document.getElementById("sort-dir-btn");
  const artistSelect = document.getElementById("artist-select");

  const navQueue = document.getElementById("nav-queue");
  const queueCountEl = document.getElementById("queue-count");
  const queuePageEl = document.getElementById("queue-page");
  const queueNowEl = document.getElementById("queue-now");
  const queueNextEl = document.getElementById("queue-next");
  const queueNextEmptyEl = document.getElementById("queue-next-empty");
  const queueClearBtn = document.getElementById("queue-clear");
  const queueContextSectionEl = document.getElementById("queue-context-section");
  const queueContextEl = document.getElementById("queue-context");
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
  const settingsPageEl = document.getElementById("settings-page");
  const transitionModeEl = document.getElementById("transition-mode");
  const crossfadeRowEl = document.getElementById("crossfade-row");
  const crossfadeInput = document.getElementById("crossfade-seconds");
  const crossfadeValueEl = document.getElementById("crossfade-value");
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

  const editBackdrop = document.getElementById("edit-backdrop");
  const editTitleInput = document.getElementById("edit-title");
  const editArtistInput = document.getElementById("edit-artist");
  const editResetBtn = document.getElementById("edit-reset");
  const editCancelBtn = document.getElementById("edit-cancel");
  const editSaveBtn = document.getElementById("edit-save");
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
    navQueue.classList.toggle("active", state.view.type === "queue");
    settingsBtn.classList.toggle("active", state.view.type === "settings");

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
    scheduleSaveState();
    renderView();
  });
  sortDirBtn.addEventListener("click", () => {
    state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
    scheduleSaveState();
    renderView();
  });
  artistSelect.addEventListener("change", () => {
    state.artistFilter = artistSelect.value;
    scheduleSaveState();
    renderView();
  });

  function hideAllPages() {
    setHidden(listControlsEl, true);
    setHidden(selectionBarEl, true);
    setHidden(searchBox, true);
    setHidden(dashboardPageEl, true);
    setHidden(addPageEl, true);
    setHidden(nowplayingPageEl, true);
    setHidden(queuePageEl, true);
    setHidden(settingsPageEl, true);
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
    if (state.view.type === "settings") {
      hideAllPages();
      viewTitle.textContent = "Settings";
      setHidden(settingsPageEl, false);
      return;
    }
    if (state.view.type === "queue") {
      hideAllPages();
      viewTitle.textContent = "Queue";
      setHidden(queuePageEl, false);
      renderQueuePage();
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
    displayedTracks = tracks;
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
    updateSelectionUi();
  }

  function buildTrackRow(track, index) {
    const row = document.createElement("div");
    row.className = "track-row";
    row.dataset.id = track.id;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "track-check";
    check.tabIndex = -1;
    check.checked = state.selected.has(track.id);
    row.appendChild(check);

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
      openAddPopover([track], addBtn);
    });
    const playNextBtn = document.createElement("button");
    playNextBtn.className = "icon-btn";
    playNextBtn.title = "Play next";
    playNextBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 5h-2v14h2zM5 5l10 7-10 7z" fill="currentColor"/></svg>';
    playNextBtn.addEventListener("click", (e) => { e.stopPropagation(); enqueue(track, true); });
    const queueBtn = document.createElement("button");
    queueBtn.className = "icon-btn";
    queueBtn.title = "Add to queue";
    queueBtn.innerHTML = QUEUE_ADD_ICON;
    queueBtn.addEventListener("click", (e) => { e.stopPropagation(); enqueue(track, false); });
    actions.appendChild(playNextBtn);
    actions.appendChild(queueBtn);
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

    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.title = "Edit song info";
    editBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditTrack(track);
    });
    actions.appendChild(editBtn);

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

    // Shift-click selects a range, Ctrl/Cmd-click toggles one, and while
    // anything is selected a plain click toggles too (double-click plays).
    row.addEventListener("click", (e) => {
      if (e.shiftKey) { selectRangeTo(track.id); return; }
      if (e.ctrlKey || e.metaKey || selectionActive()) { toggleSelected(track.id); return; }
      playQueueAt(index);
    });
    row.addEventListener("dblclick", () => {
      if (selectionActive()) playQueueAt(index);
    });

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
    const current = state.current;
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
    resetSelection();
    renderSidebar();
    renderView();
  }

  function openLibrary() {
    state.view = { type: "library" };
    resetSearch();
    resetSelection();
    renderSidebar();
    renderView();
  }

  function openPlaylist(id) {
    state.view = { type: "playlist", id };
    resetSearch();
    resetSelection();
    renderSidebar();
    renderView();
  }

  function openAdd() {
    state.view = { type: "add" };
    resetSearch();
    resetSelection();
    renderSidebar();
    renderView();
  }

  function openQueue() {
    state.view = { type: "queue" };
    resetSearch();
    resetSelection();
    renderSidebar();
    renderView();
  }

  function openNowPlaying() {
    state.view = { type: "nowplaying" };
    resetSearch();
    resetSelection();
    renderSidebar();
    renderView();
  }

  navDashboard.addEventListener("click", openDashboard);
  navLibrary.addEventListener("click", openLibrary);
  navAdd.addEventListener("click", openAdd);
  navNowPlaying.addEventListener("click", openNowPlaying);
  navQueue.addEventListener("click", openQueue);

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

  // ---------------- multi-select ----------------

  let displayedTracks = [];   // what the current list view shows, in order

  function selectionActive() {
    return state.selectionMode || state.selected.size > 0;
  }

  function selectedTracks() {
    return displayedTracks.filter((t) => state.selected.has(t.id));
  }

  // Forget the selection without touching the screen (used when changing page).
  function resetSelection() {
    state.selected.clear();
    state.selectionMode = false;
    state.selectAnchor = null;
  }

  function clearSelection() {
    resetSelection();
    updateSelectionUi();
  }

  function toggleSelected(id) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    state.selectAnchor = id;
    updateSelectionUi();
  }

  function selectRangeTo(id) {
    const ids = displayedTracks.map((t) => t.id);
    const to = ids.indexOf(id);
    const from = state.selectAnchor ? ids.indexOf(state.selectAnchor) : -1;
    if (to === -1) return;
    if (from === -1) { toggleSelected(id); return; }
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) state.selected.add(ids[i]);
    updateSelectionUi();
  }

  function updateSelectionUi() {
    const active = selectionActive();
    trackListEl.classList.toggle("selecting", active);
    trackListEl.querySelectorAll(".track-row").forEach((row) => {
      const on = state.selected.has(row.dataset.id);
      row.classList.toggle("selected", on);
      const box = row.querySelector(".track-check");
      if (box) box.checked = on;
    });

    const listView = state.view.type === "library" || state.view.type === "playlist";
    const n = selectedTracks().length;
    selectToggle.classList.toggle("active", active);
    selectToggle.textContent = active ? "Done" : "Select";
    setHidden(selectionBarEl, !(active && listView));
    selectionCountEl.textContent = n === 0 ? "Select songs" : `${n} selected`;
    selAllBtn.textContent = n > 0 && n === displayedTracks.length ? "Deselect all" : "Select all";
    selAllBtn.disabled = displayedTracks.length === 0;
    [selPlayNextBtn, selQueueBtn, selPlaylistBtn, selRemoveBtn, selDeleteBtn].forEach((b) => { b.disabled = n === 0; });
    setHidden(selRemoveBtn, state.view.type !== "playlist");
  }

  function enqueueMany(tracks, atFront) {
    const entries = tracks.map((track) => ({ qid: ++qidCounter, track }));
    if (atFront) state.upNext.unshift(...entries);
    else state.upNext.push(...entries);
    const n = tracks.length;
    flash(`${n} song${n === 1 ? "" : "s"} ${atFront ? "will play next" : "added to the queue"}`);
    onQueueChanged();
  }

  selectToggle.addEventListener("click", () => {
    if (selectionActive()) {
      clearSelection();
    } else {
      state.selectionMode = true;
      updateSelectionUi();
    }
  });

  selAllBtn.addEventListener("click", () => {
    const allSelected = displayedTracks.length > 0 && selectedTracks().length === displayedTracks.length;
    if (allSelected) state.selected.clear();
    else displayedTracks.forEach((t) => state.selected.add(t.id));
    updateSelectionUi();
  });

  selPlayNextBtn.addEventListener("click", () => {
    enqueueMany(selectedTracks(), true);
    clearSelection();
  });

  selQueueBtn.addEventListener("click", () => {
    enqueueMany(selectedTracks(), false);
    clearSelection();
  });

  selPlaylistBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openAddPopover(selectedTracks(), selPlaylistBtn, clearSelection);
  });

  selRemoveBtn.addEventListener("click", async () => {
    const pl = currentPlaylist();
    const ids = selectedTracks().map((t) => t.id);
    if (!pl || ids.length === 0) return;
    try {
      await api("POST", `/api/playlists/${pl.id}/tracks/batch-remove`, { track_ids: ids });
      await loadPlaylists();
      renderSidebar();
      clearSelection();
      renderView();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  selDeleteBtn.addEventListener("click", async () => {
    const ids = selectedTracks().map((t) => t.id);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} song${ids.length === 1 ? "" : "s"} from your library? This deletes the files and can't be undone.`)) return;
    try {
      await deleteTracks(ids);
      clearSelection();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  // ---------------- add-to-playlist popover ----------------

  function closePopover() {
    setHidden(addPopover, true);
    addPopover.innerHTML = "";
  }

  // `tracks` is the song(s) to add. For a single song a playlist is a toggle
  // (click again to remove); for several, clicking only ever adds.
  function openAddPopover(tracks, anchorEl, onDone) {
    const ids = tracks.map((t) => t.id);
    const key = ids.join("|");
    if (!addPopover.hasAttribute("hidden") && addPopover.dataset.key === key) {
      closePopover();
      return;
    }
    addPopover.innerHTML = "";
    addPopover.dataset.key = key;
    const many = ids.length > 1;

    if (state.playlists.length === 0) {
      const empty = document.createElement("div");
      empty.className = "popover-empty";
      empty.textContent = "No playlists yet — create one first.";
      addPopover.appendChild(empty);
    } else {
      for (const pl of state.playlists) {
        const item = document.createElement("div");
        const checked = ids.every((id) => pl.track_ids.includes(id));
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
            if (checked && many) {
              // Everything selected is already there - nothing to add.
            } else if (checked) {
              await api("POST", `/api/playlists/${pl.id}/tracks/batch-remove`, { track_ids: ids });
            } else {
              await api("POST", `/api/playlists/${pl.id}/tracks`, { track_ids: ids });
              if (many) flash(`Added ${ids.length} songs to ${pl.name}`);
            }
            await loadPlaylists();
            renderSidebar();
            if (state.view.type === "playlist") renderView();
            closePopover();
            if (onDone) onDone();
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
    state.wrapOrder = null;
  }

  function syncShuffleUi() {
    shuffleBtn.classList.toggle("active", state.shuffle);
    shuffleBtn.title = state.shuffle ? "Shuffle on" : "Shuffle off";
  }

  function toggleShuffle() {
    state.shuffle = !state.shuffle;
    syncShuffleUi();
    if (state.shuffle) regenerateShuffleOrder();
    scheduleSaveState();
  }

  function recordPlay(track) {
    track.plays = (track.plays || 0) + 1;
    api("POST", `/api/tracks/${encodeURIComponent(track.id)}/play`).catch(() => {});
  }

  // Hard-cut start of a track (user action, or the fallback when no smooth
  // transition happened). `fromUpNext` marks tracks pulled from the user's
  // queue, which don't move the context position (queueIndex).
  function startTrack(track, fromUpNext) {
    ensureAudioGraph();
    finalizeTransition();
    // A skip right near the end of a song can reuse the preloaded next deck.
    const idle = idleDeck();
    if (idle.track && idle.track.id === track.id && idle.el.readyState >= 3) {
      swapTo(idle);
      audio.currentTime = 0;
    } else {
      loadDeck(activeDeck, track);
    }
    setFade(activeDeck, 1);
    audio.play().catch(() => {});
    setCurrent(track, fromUpNext);
  }

  // Everything that follows "this track is now the current one", whether it
  // started with a hard cut or a smooth transition.
  function setCurrent(track, fromUpNext) {
    state.current = track;
    state.fromUpNext = !!fromUpNext;
    recordPlay(track);
    updateNowPlayingUI(track);
    updatePlayingHighlight();
    onQueueChanged();
  }

  function playQueueAt(index) {
    if (index < 0 || index >= state.queue.length) return;
    state.queueIndex = index;
    if (state.shuffle) {
      const pos = state.shuffleOrder.indexOf(index);
      state.shufflePos = pos !== -1 ? pos : 0;
    }
    startTrack(state.queue[index], false);
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
    if (!state.current) {
      if (state.upNext.length > 0) startTrack(state.upNext.shift().track, true);
      else if (state.queue.length > 0) playQueueAt(0);
      return;
    }
    finalizeTransition();
    if (audio.paused) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }

  // What plays after the current track, without changing any state. Mirrors
  // the normal playback rules: the user's queue first, then the list
  // (shuffled or in order, wrapping when repeat-all is on).
  function computeNext() {
    if (state.upNext.length > 0) {
      return { track: state.upNext[0].track, fromUpNext: true };
    }
    if (state.queue.length === 0) return null;

    if (state.shuffle) {
      let pos = state.shufflePos + 1;
      let wrap = false;
      if (pos >= state.shuffleOrder.length) {
        if (state.repeat !== "all") return null;
        wrap = true;
        pos = 0;
      }
      const order = wrap ? pendingWrapOrder() : state.shuffleOrder;
      const index = order[pos];
      return { track: state.queue[index], fromUpNext: false, index, shufflePos: pos, wrap };
    }

    let index = state.queueIndex + 1;
    if (index >= state.queue.length) {
      if (state.repeat === "all") index = 0;
      else return null;
    }
    return { track: state.queue[index], fromUpNext: false, index };
  }

  // A new random order for when repeat-all wraps. Rolled once and cached so
  // preloading the next track and actually playing it agree.
  function pendingWrapOrder() {
    const n = state.queue.length;
    if (!state.wrapOrder || state.wrapOrder.length !== n) {
      const last = state.shuffleOrder[state.shuffleOrder.length - 1];
      const order = shuffledIndices(n);
      if (order.length > 1 && order[0] === last) [order[0], order[1]] = [order[1], order[0]];
      state.wrapOrder = order;
    }
    return state.wrapOrder;
  }

  // Applies the state changes for having moved on to `next` (from computeNext).
  function commitNext(next) {
    if (next.fromUpNext) {
      state.upNext.shift();
      return;
    }
    state.queueIndex = next.index;
    if (state.shuffle) {
      if (next.wrap) {
        state.shuffleOrder = state.wrapOrder;
        state.wrapOrder = null;
      }
      state.shufflePos = next.shufflePos;
    }
  }

  function goNext(fromEnded) {
    if (fromEnded && state.repeat === "one" && state.current) {
      startTrack(state.current, state.fromUpNext);
      return;
    }
    const next = computeNext();
    if (!next) return;
    commitNext(next);
    startTrack(next.track, next.fromUpNext);
  }

  function goPrev() {
    finalizeTransition();
    if (audio.currentTime > 5) {
      audio.currentTime = 0;
      return;
    }
    if (state.fromUpNext) {
      // Back from a queued track = return to the context track it interrupted.
      if (state.queue[state.queueIndex]) playQueueAt(state.queueIndex);
      else audio.currentTime = 0;
      return;
    }
    if (state.queue.length === 0) return;
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

  function syncRepeatUi() {
    repeatBtn.classList.toggle("active", state.repeat !== "off");
    repeatBtn.title = state.repeat === "off" ? "Repeat off" : state.repeat === "all" ? "Repeat all" : "Repeat one";
    setHidden(repeatOneDot, state.repeat !== "one");
  }

  function cycleRepeat() {
    state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
    syncRepeatUi();
    scheduleSaveState();
  }

  shuffleBtn.addEventListener("click", toggleShuffle);
  prevBtn.addEventListener("click", goPrev);
  nextBtn.addEventListener("click", () => goNext(false));
  playBtn.addEventListener("click", playPause);
  repeatBtn.addEventListener("click", cycleRepeat);

  // ---------------- queue ----------------
  // "Up next" is the user's own queue: it plays before the current list
  // (the context) carries on, like Spotify's queue.

  const QUEUE_ADD_ICON = '<svg viewBox="0 0 24 24"><path d="M3 6h12M3 12h12M3 18h8M18 14v6M15 17h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const REMOVE_ICON = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const CONTEXT_PREVIEW_LIMIT = 30;
  let qidCounter = 0;
  let dragQid = null;

  function flash(message) {
    setStatus(message, false);
    setTimeout(() => { if (statusLine.textContent === message) setStatus(""); }, 2200);
  }

  function onQueueChanged() {
    const n = state.upNext.length;
    queueCountEl.textContent = n;
    setHidden(queueCountEl, n === 0);
    if (state.view.type === "queue") renderQueuePage();
    scheduleSaveState();
  }

  function enqueue(track, atFront) {
    const entry = { qid: ++qidCounter, track };
    if (atFront) state.upNext.unshift(entry);
    else state.upNext.push(entry);
    flash(`${atFront ? "Playing next" : "Added to queue"}: ${track.title}`);
    onQueueChanged();
  }

  // Tracks the context will play after the current one, in play order.
  function upcomingContext() {
    if (state.queueIndex === -1 || state.queue.length === 0) return [];
    const out = [];
    if (state.shuffle) {
      for (let pos = state.shufflePos + 1; pos < state.shuffleOrder.length && out.length < CONTEXT_PREVIEW_LIMIT; pos++) {
        const index = state.shuffleOrder[pos];
        out.push({ track: state.queue[index], index });
      }
    } else {
      for (let index = state.queueIndex + 1; index < state.queue.length && out.length < CONTEXT_PREVIEW_LIMIT; index++) {
        out.push({ track: state.queue[index], index });
      }
    }
    return out;
  }

  function buildQueueRow(track, { playing = false, onClick = null, actions = [] } = {}) {
    const row = document.createElement("div");
    row.className = "track-row" + (playing ? " playing" : "");

    let cover;
    if (track.cover) {
      cover = document.createElement("img");
      cover.className = "track-cover";
      cover.src = track.cover;
      cover.alt = "";
    } else {
      cover = document.createElement("div");
      cover.className = "track-cover-fallback";
      cover.innerHTML = TILE_FALLBACK_ICON;
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

    const actionsEl = document.createElement("div");
    actionsEl.className = "track-actions";
    for (const a of actions) {
      const btn = document.createElement("button");
      btn.className = "icon-btn";
      btn.title = a.title;
      btn.innerHTML = a.icon;
      btn.addEventListener("click", (e) => { e.stopPropagation(); a.onClick(); });
      actionsEl.appendChild(btn);
    }

    row.append(cover, info, duration, actionsEl);
    if (onClick) row.addEventListener("click", onClick);
    return row;
  }

  function clearQueueDropIndicators() {
    queueNextEl.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
  }

  function attachQueueDrag(row, entry) {
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      dragQid = entry.qid;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(entry.qid));
    });
    row.addEventListener("dragend", () => {
      dragQid = null;
      row.classList.remove("dragging");
      clearQueueDropIndicators();
    });
    row.addEventListener("dragover", (e) => {
      if (dragQid === null || dragQid === entry.qid) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      clearQueueDropIndicators();
      row.classList.add(dropIsAfter(row, e) ? "drop-after" : "drop-before");
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      const after = dropIsAfter(row, e);
      const moved = state.upNext.find((x) => x.qid === dragQid);
      dragQid = null;
      if (!moved || moved === entry) return;
      state.upNext = state.upNext.filter((x) => x !== moved);
      const pos = state.upNext.indexOf(entry);
      state.upNext.splice(after ? pos + 1 : pos, 0, moved);
      onQueueChanged();
    });
  }

  function renderQueuePage() {
    // Now playing
    queueNowEl.innerHTML = "";
    if (state.current) {
      queueNowEl.appendChild(buildQueueRow(state.current, { playing: true }));
    } else {
      const hint = document.createElement("p");
      hint.className = "dash-empty-hint";
      hint.textContent = "Nothing playing right now.";
      queueNowEl.appendChild(hint);
    }

    // The user's queue
    queueNextEl.innerHTML = "";
    setHidden(queueNextEmptyEl, state.upNext.length > 0);
    setHidden(queueClearBtn, state.upNext.length === 0);
    for (const entry of state.upNext) {
      const row = buildQueueRow(entry.track, {
        onClick: () => {
          state.upNext = state.upNext.filter((x) => x !== entry);
          startTrack(entry.track, true);
        },
        actions: [{
          title: "Remove from queue",
          icon: REMOVE_ICON,
          onClick: () => { state.upNext = state.upNext.filter((x) => x !== entry); onQueueChanged(); },
        }],
      });
      attachQueueDrag(row, entry);
      queueNextEl.appendChild(row);
    }

    // What the list carries on with after the queue
    queueContextEl.innerHTML = "";
    const upcoming = upcomingContext();
    setHidden(queueContextSectionEl, upcoming.length === 0);
    for (const { track, index } of upcoming) {
      queueContextEl.appendChild(buildQueueRow(track, {
        onClick: () => playQueueAt(index),
        actions: [{ title: "Add to queue", icon: QUEUE_ADD_ICON, onClick: () => enqueue(track, false) }],
      }));
    }
  }

  queueClearBtn.addEventListener("click", () => {
    state.upNext = [];
    onQueueChanged();
  });

  // ---------------- audio engine ----------------
  // deck.el -> deck.norm (loudness gain) -> deck.fade (transition gain) -> analyser -> speakers
  // Both decks feed the same analyser, so the visualizer shows whatever is audible.

  const VIZ_BARS = 48;
  const PRELOAD_LEAD = 12;     // seconds before the handover point to start loading the next song
  const GAPLESS_LEAD = 0.06;   // start the next song this long before the current one ends
  const TRANSITION_TICK_MS = 50;

  let audioCtx = null;
  let analyser = null;
  let freqData = null;
  let vizRaf = 0;
  let graphFailed = false;
  let transition = null;       // {out: deck, timer} while two songs overlap

  const idleDeck = () => (decks[0] === activeDeck ? decks[1] : decks[0]);

  function ensureAudioGraph() {
    if (analyser) return true;
    if (graphFailed) return false;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.78;
      for (const d of decks) {
        d.source = audioCtx.createMediaElementSource(d.el);
        d.norm = audioCtx.createGain();
        d.fade = audioCtx.createGain();
        d.source.connect(d.norm);
        d.norm.connect(d.fade);
        d.fade.connect(analyser);
      }
      analyser.connect(audioCtx.destination);
      freqData = new Uint8Array(analyser.frequencyBinCount);
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
      return true;
    } catch (_) {
      // Optional features (visualizer, normalization, crossfade); plain playback keeps working.
      analyser = null;
      graphFailed = true;
      decks.forEach((d) => { d.norm = null; d.fade = null; });
      return false;
    }
  }

  // ---- volume normalization ----
  // The server measures each track's loudness and hands back the gain (dB)
  // that brings it to a common level; it's applied via the deck's norm node.

  function setDeckGainDb(deck, db) {
    if (!deck.norm) return;
    deck.norm.gain.setTargetAtTime(Math.pow(10, db / 20), audioCtx.currentTime, 0.03);
  }

  async function applyNormalization(track, deck = activeDeck) {
    if (state.settings.normalize_volume === false) {
      setDeckGainDb(deck, 0); // no-op if the graph was never built
      return;
    }
    if (!ensureAudioGraph()) return;
    if (typeof track.gain_db === "number") {
      setDeckGainDb(deck, track.gain_db);
      return;
    }
    setDeckGainDb(deck, 0); // not measured yet - ask the server to measure it now
    try {
      const { gain_db } = await api("GET", `/api/tracks/${encodeURIComponent(track.id)}/loudness`);
      track.gain_db = typeof gain_db === "number" ? gain_db : 0;
    } catch (_) {
      return;
    }
    if (deck.track && deck.track.id === track.id && state.settings.normalize_volume !== false) {
      setDeckGainDb(deck, track.gain_db);
    }
  }

  // ---- decks ----

  function loadDeck(deck, track) {
    deck.track = track;
    deck.el.src = `/audio/${encodeURIComponent(track.id)}`;
    deck.el.currentTime = 0;
    applyNormalization(track, deck);
  }

  function swapTo(deck) {
    const old = activeDeck;
    activeDeck = deck;
    audio = deck.el;
    if (old !== deck) {
      old.el.pause();
      old.track = null;
      setFade(old, 0);
    }
  }

  function stopPlayback() {
    finalizeTransition();
    decks.forEach((d) => {
      d.el.pause();
      d.el.removeAttribute("src");
      d.el.load();
      d.track = null;
    });
  }

  function setPlayerVolume(v) { decks.forEach((d) => { d.el.volume = v; }); }
  function setPlayerMuted(m) { decks.forEach((d) => { d.el.muted = m; }); }

  // ---- transition gains ----

  function setFade(deck, value) {
    if (!deck.fade) return;
    const p = deck.fade.gain;
    p.cancelScheduledValues(audioCtx.currentTime);
    p.setValueAtTime(value, audioCtx.currentTime);
  }

  // Equal-power curve (cos/sin) so the combined loudness stays steady mid-fade.
  function scheduleFade(deck, direction, seconds) {
    if (!deck.fade) return;
    const steps = 64;
    const curve = new Float32Array(steps);
    for (let i = 0; i < steps; i++) {
      const t = (i / (steps - 1)) * (Math.PI / 2);
      curve[i] = direction === "in" ? Math.sin(t) : Math.cos(t);
    }
    const p = deck.fade.gain;
    p.cancelScheduledValues(audioCtx.currentTime);
    p.setValueCurveAtTime(curve, audioCtx.currentTime, seconds);
  }

  // Ends any overlap right now (pause, seek, skip...): the outgoing song is
  // cut and the incoming one goes to full volume.
  function finalizeTransition() {
    if (!transition) return;
    clearTimeout(transition.timer);
    const out = transition.out;
    transition = null;
    out.el.pause();
    out.track = null;
    setFade(out, 0);
    setFade(activeDeck, 1);
  }

  // ---- smooth transitions ----

  function transitionFadeSeconds(duration) {
    if (state.settings.transition_mode !== "crossfade" || !decks[0].fade) return 0;
    const want = Number(state.settings.crossfade_seconds) || 5;
    // Never fade longer than a third of the song; very short songs just go gapless.
    const fade = Math.min(want, duration / 3);
    return fade >= 1 ? fade : 0;
  }

  function preloadNext() {
    const next = computeNext();
    if (!next) return;
    const idle = idleDeck();
    if (idle.track && idle.track.id === next.track.id) return;
    loadDeck(idle, next.track);
  }

  function beginTransition(fadeSeconds) {
    const next = computeNext();
    if (!next) return; // nothing follows - let the song end normally
    const incoming = idleDeck();
    const outgoing = activeDeck;
    if (!(incoming.track && incoming.track.id === next.track.id)) loadDeck(incoming, next.track);
    else incoming.el.currentTime = 0;

    commitNext(next);
    activeDeck = incoming;
    audio = incoming.el;

    if (fadeSeconds > 0) {
      setFade(incoming, 0);
      scheduleFade(incoming, "in", fadeSeconds);
      scheduleFade(outgoing, "out", fadeSeconds);
    } else {
      setFade(incoming, 1);
    }
    incoming.el.play().catch(() => {});

    transition = {
      out: outgoing,
      timer: setTimeout(finalizeTransition, (fadeSeconds > 0 ? fadeSeconds : 0.3) * 1000 + 150),
    };
    setCurrent(next.track, next.fromUpNext);
  }

  function checkTransition() {
    if (state.settings.transition_mode === "off" || transition || audio.paused || !state.current) return;
    if (state.repeat === "one") return; // repeat-one replays via the normal path
    const duration = audio.duration;
    if (!isFinite(duration) || duration <= 0) return;
    const remaining = duration - audio.currentTime;
    const fade = transitionFadeSeconds(duration);
    const lead = fade > 0 ? fade : GAPLESS_LEAD;
    if (remaining <= lead + PRELOAD_LEAD) preloadNext();
    if (remaining <= lead) beginTransition(fade);
  }

  setInterval(checkTransition, TRANSITION_TICK_MS);

  // ---------------- now playing visualizer ----------------
  // Frequency bars from the graph's AnalyserNode. The audio is served from the
  // same origin, so routing it through Web Audio is allowed; the graph is built
  // on first play because browsers require a user gesture to start it.

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

  // Player UI follows whichever deck is the active one; events from the deck
  // that is fading out (or preloading) are ignored.
  decks.forEach((deck) => {
    const el = deck.el;
    el.addEventListener("play", () => {
      if (el !== audio) return;
      setHidden(playIcon, true);
      setHidden(pauseIcon, false);
      // Audio routed through the graph is silent while the context is suspended.
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
      startVisualizer();
    });
    el.addEventListener("pause", () => {
      if (el !== audio) return;
      setHidden(playIcon, false);
      setHidden(pauseIcon, true);
      scheduleSaveState();
    });
    el.addEventListener("ended", () => {
      if (el === audio) goNext(true);
    });
    el.addEventListener("loadedmetadata", () => {
      if (el === audio) timeDuration.textContent = formatTime(el.duration);
    });
    el.addEventListener("timeupdate", () => {
      if (el !== audio || seekDragging) return;
      const dur = el.duration || 0;
      const pct = dur ? (el.currentTime / dur) * 1000 : 0;
      seek.value = pct;
      seek.style.setProperty("--fill", `${dur ? (pct / 10) : 0}%`);
      timeCurrent.textContent = formatTime(el.currentTime);
      if (dur) timeDuration.textContent = formatTime(dur);
    });
  });

  seek.addEventListener("input", () => {
    seekDragging = true;
    seek.style.setProperty("--fill", `${seek.value / 10}%`);
    const dur = audio.duration || 0;
    timeCurrent.textContent = formatTime((seek.value / 1000) * dur);
  });
  seek.addEventListener("change", () => {
    finalizeTransition();
    const dur = audio.duration || 0;
    audio.currentTime = (seek.value / 1000) * dur;
    seekDragging = false;
  });

  volume.addEventListener("input", () => {
    setPlayerVolume(volume.value / 100);
    setPlayerMuted(false);
    volume.style.setProperty("--fill", `${volume.value}%`);
    scheduleSaveState();
  });

  // Scroll over the volume control to change it: one mouse-wheel notch
  // (deltaY 100) is 5%, and smooth trackpad scrolling adds up fractionally.
  const volumeArea = volume.parentElement;
  let volumeWheelAcc = 0;
  volumeArea.title = "Scroll to change volume";
  volumeArea.addEventListener("wheel", (e) => {
    e.preventDefault();
    volumeWheelAcc += -e.deltaY / 20;
    const whole = Math.trunc(volumeWheelAcc);
    if (whole === 0) return;
    volumeWheelAcc -= whole;
    const next = Math.max(0, Math.min(100, Number(volume.value) + whole));
    if (next === Number(volume.value)) return;
    volume.value = next;
    volume.dispatchEvent(new Event("input"));
  }, { passive: false });

  let lastVolume = 70;
  muteBtn.addEventListener("click", () => {
    if (audio.muted || audio.volume === 0) {
      setPlayerMuted(false);
      setPlayerVolume(lastVolume / 100);
      volume.value = lastVolume;
    } else {
      lastVolume = volume.value;
      setPlayerMuted(true);
      volume.value = 0;
    }
    volume.style.setProperty("--fill", `${volume.value}%`);
    scheduleSaveState();
  });

  // ---------------- deleting tracks ----------------

  async function deleteTracks(trackIds) {
    const gone = new Set(trackIds);
    const wasPlaying = !!state.current && gone.has(state.current.id);
    await api("POST", "/api/tracks/batch-delete", { track_ids: trackIds });
    state.upNext = state.upNext.filter((e) => !gone.has(e.track.id));
    decks.forEach((d) => { if (d.track && gone.has(d.track.id)) d.track = null; });
    if (wasPlaying) {
      stopPlayback();
      if (!state.fromUpNext) state.queueIndex = -1;
      state.current = null;
      updateNowPlayingUI(null);
    }
    onQueueChanged();
    await Promise.all([loadLibrary(), loadPlaylists()]);
    renderSidebar();
    renderView();
  }

  function deleteTrack(trackId) {
    return deleteTracks([trackId]);
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
      stopPlayback();
      state.queue = [];
      state.queueIndex = -1;
      state.upNext = [];
      state.current = null;
      state.fromUpNext = false;
      updateNowPlayingUI(null);
      onQueueChanged();
      await Promise.all([loadLibrary(), loadPlaylists()]);
      renderSidebar();
      renderView();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  normalizeToggle.addEventListener("change", () => {
    saveSettings({ normalize_volume: normalizeToggle.checked });
    decks.forEach((d) => { if (d.track) applyNormalization(d.track, d); });
  });

  // Transitions: mode buttons + crossfade length.
  function syncTransitionControls() {
    const mode = state.settings.transition_mode;
    transitionModeEl.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === mode);
    });
    setHidden(crossfadeRowEl, mode !== "crossfade");
    const seconds = Number(state.settings.crossfade_seconds) || 5;
    crossfadeInput.value = seconds;
    crossfadeValueEl.textContent = `${seconds} s`;
    crossfadeInput.style.setProperty("--fill", `${((seconds - 1) / 11) * 100}%`);
  }

  transitionModeEl.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      state.settings.transition_mode = b.dataset.mode;
      syncTransitionControls();
      saveSettings({ transition_mode: b.dataset.mode });
    });
  });

  crossfadeInput.addEventListener("input", () => {
    state.settings.crossfade_seconds = Number(crossfadeInput.value);
    syncTransitionControls();
  });
  crossfadeInput.addEventListener("change", () => {
    saveSettings({ crossfade_seconds: Number(crossfadeInput.value) });
  });

  function openSettings() {
    state.view = { type: "settings" };
    resetSearch();
    resetSelection();
    renderSidebar();
    renderView();
  }

  settingsBtn.addEventListener("click", openSettings);

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
      if (state.current && state.view.type !== "nowplaying") {
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

  // ---------------- edit song info ----------------

  let editingTrack = null;

  function openEditTrack(track) {
    editingTrack = track;
    editTitleInput.value = track.title;
    editArtistInput.value = track.artist || "";
    setHidden(editResetBtn, !track.edited);
    setHidden(editBackdrop, false);
    editTitleInput.focus();
    editTitleInput.select();
  }

  function closeEditTrack() {
    setHidden(editBackdrop, true);
    editingTrack = null;
  }

  // Copies the edited fields onto every in-memory copy of the track (the
  // library, the play queue, the user's queue, the decks) so nothing is stale.
  function applyTrackUpdate(updated) {
    const fields = { title: updated.title, artist: updated.artist, edited: updated.edited };
    const copies = [
      ...state.library, ...state.queue, ...state.upNext.map((e) => e.track),
      state.current, ...decks.map((d) => d.track),
    ];
    for (const t of copies) {
      if (t && t.id === updated.id) Object.assign(t, fields);
    }
    if (state.current && state.current.id === updated.id) updateNowPlayingUI(state.current);
  }

  async function saveEditTrack(reset) {
    if (!editingTrack) return;
    const title = editTitleInput.value.trim();
    if (!reset && !title) {
      editTitleInput.focus();
      return;
    }
    try {
      const updated = await api("PATCH", `/api/tracks/${encodeURIComponent(editingTrack.id)}/meta`,
        reset ? { reset: true } : { title, artist: editArtistInput.value.trim() });
      applyTrackUpdate(updated);
      closeEditTrack();
      renderView();
      onQueueChanged();
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  editSaveBtn.addEventListener("click", () => saveEditTrack(false));
  editResetBtn.addEventListener("click", () => saveEditTrack(true));
  editCancelBtn.addEventListener("click", closeEditTrack);
  editBackdrop.addEventListener("click", (e) => {
    if (e.target === editBackdrop) closeEditTrack();
  });
  [editTitleInput, editArtistInput].forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); saveEditTrack(false); }
      if (e.key === "Escape") { e.preventDefault(); closeEditTrack(); }
    });
  });

  // ---------------- remembered player state ----------------
  // The current song + position, the queue, shuffle/repeat, volume and the
  // list sorting are saved on the server (data/player_state.json) and put back
  // on launch - paused, so the app never starts making noise by itself.

  let stateRestored = false;
  let saveStateTimer = 0;
  const SORT_KEYS = ["default", "title", "artist", "plays", "duration", "added"];

  function snapshotState() {
    const contextTrack = state.queue[state.queueIndex];
    return {
      version: 1,
      currentId: state.current ? state.current.id : null,
      fromUpNext: state.fromUpNext,
      position: state.current ? audio.currentTime || 0 : 0,
      contextId: contextTrack ? contextTrack.id : null,
      queue: state.queue.map((t) => t.id),
      upNext: state.upNext.map((e) => e.track.id),
      shuffle: state.shuffle,
      repeat: state.repeat,
      volume: audio.muted ? lastVolume : Number(volume.value),
      sortKey: state.sortKey,
      sortDir: state.sortDir,
      artistFilter: state.artistFilter,
    };
  }

  function saveStateNow() {
    if (!stateRestored) return;
    clearTimeout(saveStateTimer);
    api("POST", "/api/state", snapshotState()).catch(() => {});
  }

  function scheduleSaveState() {
    if (!stateRestored) return;
    clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(saveStateNow, 800);
  }

  function restoreState(saved) {
    if (!saved || typeof saved !== "object") return;
    const byId = new Map(state.library.map((t) => [t.id, t]));
    const pick = (ids) => (Array.isArray(ids) ? ids : []).map((id) => byId.get(id)).filter(Boolean);

    if (typeof saved.volume === "number" && saved.volume >= 0 && saved.volume <= 100) {
      volume.value = saved.volume;
      volume.style.setProperty("--fill", `${saved.volume}%`);
      setPlayerVolume(saved.volume / 100);
      lastVolume = saved.volume || 70;
    }
    if (SORT_KEYS.includes(saved.sortKey)) {
      state.sortKey = saved.sortKey;
      state.sortDir = saved.sortDir === "desc" ? "desc" : "asc";
    }
    if (typeof saved.artistFilter === "string") state.artistFilter = saved.artistFilter;
    state.repeat = ["off", "all", "one"].includes(saved.repeat) ? saved.repeat : "off";
    syncRepeatUi();

    state.queue = pick(saved.queue);
    state.queueIndex = saved.contextId ? state.queue.findIndex((t) => t.id === saved.contextId) : -1;
    state.upNext = pick(saved.upNext).map((track) => ({ qid: ++qidCounter, track }));
    state.shuffle = saved.shuffle === true;
    syncShuffleUi();
    if (state.shuffle) regenerateShuffleOrder();

    // Bring the song back (paused) at the position it was left at.
    const current = byId.get(saved.currentId);
    if (current) {
      state.current = current;
      state.fromUpNext = saved.fromUpNext === true;
      loadDeck(activeDeck, current);
      const position = Number(saved.position) || 0;
      if (position > 1) {
        const el = activeDeck.el;
        el.addEventListener("loadedmetadata", () => {
          if (position < el.duration - 2) el.currentTime = position;
        }, { once: true });
      }
      updateNowPlayingUI(current);
    }
    onQueueChanged();
  }

  async function loadSavedState() {
    try {
      return await api("GET", "/api/state");
    } catch (_) {
      return {};
    }
  }

  // Keep the saved position fresh while playing, and flush it when the window closes.
  setInterval(() => { if (!audio.paused && state.current) saveStateNow(); }, 5000);
  window.addEventListener("pagehide", () => {
    if (!stateRestored) return;
    try {
      navigator.sendBeacon("/api/state", new Blob([JSON.stringify(snapshotState())], { type: "application/json" }));
    } catch (_) { /* best effort */ }
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
    normalizeToggle.checked = state.settings.normalize_volume !== false;
    syncTransitionControls();
    try {
      restoreState(await loadSavedState());
    } catch (err) {
      console.warn("Could not restore the previous session", err);
    }
    stateRestored = true;
    resetIdleTimer();
    renderSidebar();
    renderView();
  }

  init();
})();

const els = {
  directUrl: document.querySelector("#direct-url"),
  startDirect: document.querySelector("#start-direct"),
  loadTest: document.querySelector("#load-test"),
  playlistUrl: document.querySelector("#playlist-url"),
  loadPlaylistUrl: document.querySelector("#load-playlist-url"),
  playlistFile: document.querySelector("#playlist-file"),
  playlistText: document.querySelector("#playlist-text"),
  parsePlaylistText: document.querySelector("#parse-playlist-text"),
  playlistEntries: document.querySelector("#playlist-entries"),
  entryCount: document.querySelector("#entry-count"),
  favoritesPanel: document.querySelector("#favorites-panel"),
  favoriteShortcuts: document.querySelector("#favorite-shortcuts"),
  entrySearch: document.querySelector("#entry-search"),
  groupFilter: document.querySelector("#group-filter"),
  categoryFilters: document.querySelectorAll(".filter"),
  loadMore: document.querySelector("#load-more"),
  stopStream: document.querySelector("#stop-stream"),
  playerPanel: document.querySelector(".player-panel"),
  nowPlayingLogo: document.querySelector("#now-playing-logo"),
  nowPlayingTitle: document.querySelector("#now-playing-title"),
  nowPlayingMeta: document.querySelector("#now-playing-meta"),
  video: document.querySelector("#video"),
  playbackMode: document.querySelector("#playback-mode"),
  status: document.querySelector("#status"),
  proxyUrl: document.querySelector("#proxy-url"),
  statusModal: document.querySelector("#status-modal"),
  statusModalBox: document.querySelector("#status-modal .modal"),
  statusModalTitle: document.querySelector("#status-modal-title"),
  statusModalMessage: document.querySelector("#status-modal-message"),
  statusModalClose: document.querySelector("#status-modal-close"),
  downloadProgress: document.querySelector("#download-progress"),
  downloadProgressLabel: document.querySelector("#download-progress-label"),
  downloadProgressRemaining: document.querySelector("#download-progress-remaining"),
  downloadProgressBar: document.querySelector("#download-progress-bar"),
};

let hls = null;
let mpegtsPlayer = null;
let activeStreamId = "";
let activeUsesProxy = false;
let playbackSeq = 0;
let allEntries = [];
let selectedCategory = "all";
let playlistId = "";
let playlistPayload = null;
let playlistEndpoint = "/api/playlist/parse";
let totalEntries = 0;
let hasMoreEntries = false;
let playlistRequestSeq = 0;
let playlistFetchController = null;
let favoriteEntries = [];
const PAGE_SIZE = 200;
const SEARCH_DEBOUNCE_MS = 250;
const FAVORITES_STORAGE_KEY = "streamM3U8SessionFavorites";
const PLAYBACK_MODES = new Set(["auto", "direct", "proxy"]);

function logUserAction(action, details = {}) {
  console.info(`[Stream M3U8] ${action}`, {
    at: new Date().toISOString(),
    ...details,
  });
}

function setStatus(message, type = "") {
  els.status.hidden = false;
  els.status.textContent = message;
  els.status.className = `status ${type}`.trim();
}

function normalizePlaybackMode(mode) {
  return PLAYBACK_MODES.has(mode) ? mode : "auto";
}

function currentPlaybackMode() {
  return normalizePlaybackMode(els.playbackMode.value);
}

async function loadAppConfig() {
  try {
    const config = await getJson("/api/config");
    els.playbackMode.value = normalizePlaybackMode(config.playback_mode);
  } catch {
    els.playbackMode.value = "auto";
  }
}

function scrollPlayerIntoView() {
  els.playerPanel.scrollIntoView({
    behavior: "smooth",
    block: "center",
  });
}

function loadSessionFavorites() {
  try {
    favoriteEntries = JSON.parse(sessionStorage.getItem(FAVORITES_STORAGE_KEY) || "[]");
  } catch {
    favoriteEntries = [];
  }
  renderFavoriteShortcuts();
}

function saveSessionFavorites() {
  sessionStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favoriteEntries));
}

function isFavorite(entry) {
  return favoriteEntries.some((favorite) => favorite.url === entry.url);
}

function toggleFavorite(entry) {
  if (isFavorite(entry)) {
    favoriteEntries = favoriteEntries.filter((favorite) => favorite.url !== entry.url);
    logUserAction("Removendo favorito", { title: entry.title, url: entry.url });
  } else {
    favoriteEntries.unshift({
      title: entry.title || entry.url,
      url: entry.url,
      logo: entry.logo || "",
      group: entry.group || "",
      category: entry.category || "",
      media_kind: entry.media_kind || "",
    });
    logUserAction("Adicionando favorito", { title: entry.title, url: entry.url });
  }
  saveSessionFavorites();
  renderFavoriteShortcuts();
  renderEntries();
}

function renderFavoriteShortcuts() {
  els.favoritesPanel.hidden = favoriteEntries.length === 0;
  els.favoriteShortcuts.innerHTML = "";

  favoriteEntries.forEach((entry) => {
    const shortcut = document.createElement("button");
    shortcut.className = "favorite-shortcut";
    shortcut.type = "button";
    const title = entry.title || entry.url;
    const logo = entry.logo
      ? `<img class="favorite-shortcut-logo" src="${escapeHtml(entry.logo)}" alt="" referrerpolicy="no-referrer" />`
      : `<span class="favorite-shortcut-logo">${escapeHtml(title.slice(0, 1).toUpperCase())}</span>`;
    shortcut.innerHTML = `${logo}<span>${escapeHtml(title)}</span>`;
    shortcut.addEventListener("click", () => {
      logUserAction("Abrindo favorito", { title, url: entry.url });
      scrollPlayerIntoView();
      startStream(entry.url, entry).catch(showStreamError);
    });
    els.favoriteShortcuts.appendChild(shortcut);
  });
}

function updateNowPlaying(entry) {
  const title = entry?.title || entry?.url || "Link direto";
  const logo = entry?.logo || "";

  els.nowPlayingTitle.textContent = title;
  els.nowPlayingMeta.textContent = entry ? formatEntryMeta(entry) || entry.url : "Reproduzindo link direto.";

  if (logo) {
    els.nowPlayingLogo.outerHTML = `<img id="now-playing-logo" class="now-playing-logo" src="${escapeHtml(logo)}" alt="" referrerpolicy="no-referrer" />`;
  } else {
    els.nowPlayingLogo.outerHTML = `<div id="now-playing-logo" class="now-playing-logo placeholder">${escapeHtml(
      title.slice(0, 1).toUpperCase()
    )}</div>`;
  }
  els.nowPlayingLogo = document.querySelector("#now-playing-logo");
}

function resetNowPlaying() {
  els.nowPlayingLogo.outerHTML = '<div id="now-playing-logo" class="now-playing-logo placeholder">TV</div>';
  els.nowPlayingLogo = document.querySelector("#now-playing-logo");
  els.nowPlayingTitle.textContent = "Nenhum stream selecionado";
  els.nowPlayingMeta.textContent = "Escolha um item da lista para reproduzir.";
}

function showStatusModal(title, message, type = "loading") {
  els.statusModal.hidden = false;
  els.statusModalBox.className = `modal ${type === "loading" ? "" : type}`.trim();
  els.statusModalTitle.textContent = title;
  els.statusModalMessage.textContent = message;
  if (type !== "loading") {
    hideDownloadProgress();
  }
}

function hideStatusModal() {
  els.statusModal.hidden = true;
}

function finishStatusModal(title, message, type) {
  showStatusModal(title, message, type);
}

function setPlaylistLoading(message) {
  els.entryCount.textContent = message;
  els.loadMore.hidden = true;
  els.playlistEntries.className = "entries loading";
  els.playlistEntries.innerHTML = `
    <div class="inline-loader" role="status" aria-live="polite">
      <span class="inline-spinner" aria-hidden="true"></span>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
}

function showStreamError(error) {
  setStatus(error.message, "error");
  finishStatusModal("Erro ao iniciar stream", error.message, "error");
}

function hideDownloadProgress() {
  els.downloadProgress.hidden = true;
  els.downloadProgressBar.classList.remove("indeterminate");
  els.downloadProgressBar.style.width = "0%";
  els.downloadProgressLabel.textContent = "0%";
  els.downloadProgressRemaining.textContent = "Calculando tamanho...";
}

function showDownloadProgress(downloadedBytes, totalBytes) {
  els.downloadProgress.hidden = false;

  if (!totalBytes) {
    els.downloadProgressBar.classList.add("indeterminate");
    els.downloadProgressBar.style.width = "";
    els.downloadProgressLabel.textContent = `${formatBytes(downloadedBytes)} baixados`;
    els.downloadProgressRemaining.textContent = "Tamanho total ainda indisponivel";
    return;
  }

  const percent = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
  const remainingBytes = Math.max(totalBytes - downloadedBytes, 0);
  els.downloadProgressBar.classList.remove("indeterminate");
  els.downloadProgressBar.style.width = `${percent}%`;
  els.downloadProgressLabel.textContent = `${percent}%`;
  els.downloadProgressRemaining.textContent = `${formatBytes(remainingBytes)} restantes`;
}

async function postJson(url, payload, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Erro inesperado");
  }
  return data;
}

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Erro inesperado");
  }
  return data;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes) {
  if (!bytes) {
    return "0 MB";
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function inferMediaKind(streamId, entry = null) {
  if (entry?.media_kind) {
    return entry.media_kind;
  }

  const path = streamId.toLowerCase().split("?", 1)[0];
  if (path.endsWith(".m3u") || path.endsWith(".m3u8")) {
    return "hls";
  }
  if (path.endsWith(".ts") || path.includes("/live/")) {
    return "mpegts";
  }
  return "native";
}

function logContentRequest(streamId, entry, playbackMode, mediaKind) {
  const payload = {
    stream_id: streamId,
    title: entry?.title || "Link direto",
    group: entry?.group || "",
    category: entry?.category || "",
    media_kind: mediaKind || "",
    playback_mode: playbackMode,
  };

  fetch("/api/events/content-request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => undefined);
}

async function startStream(streamId, entry = null) {
  if (!streamId) {
    const error = new Error("Informe uma URL M3U8 ou selecione um item da playlist.");
    showStreamError(error);
    return;
  }

  logUserAction("Iniciando stream", {
    title: entry?.title || "Link direto",
    url: streamId,
    playback_mode: currentPlaybackMode(),
  });
  await stopActiveStream();
  const token = ++playbackSeq;
  const mediaKind = inferMediaKind(streamId, entry);
  const playbackMode = currentPlaybackMode();
  logContentRequest(streamId, entry, playbackMode, mediaKind);

  updateNowPlaying(entry || { title: "Link direto", url: streamId });
  activeStreamId = streamId;
  activeUsesProxy = false;
  els.stopStream.disabled = false;

  if (playbackMode === "direct") {
    els.proxyUrl.textContent = streamId;
    setStatus("Tentando reproduzir direto no navegador...", "ok");
    if (!loadPlayer(streamId, mediaKind)) {
      await stopActiveStream();
      throw new Error("Este navegador nao suporta esse formato em modo direto.");
    }
    return;
  }

  if (playbackMode === "auto") {
    els.proxyUrl.textContent = streamId;
    setStatus("Tentando reproduzir direto no navegador...", "ok");
    const directStarted = loadPlayer(streamId, mediaKind, {
      onFatalError: (error) => startProxyStream(streamId, entry, token, error.message),
    });
    if (directStarted) {
      return;
    }
    await startProxyStream(streamId, entry, token, "Formato direto nao suportado pelo navegador.");
    return;
  }

  await startProxyStream(streamId, entry, token);
}

async function startProxyStream(streamId, entry, token, reason = "") {
  if (token !== playbackSeq) {
    return;
  }

  destroyPlayer();
  setStatus(reason ? `Modo direto falhou (${reason}). Iniciando proxy...` : "Iniciando buffer no backend...");
  const payload = await postJson("/stream/start", {
    stream_id: streamId,
    title: entry?.title || "Link direto",
    group: entry?.group || "",
    category: entry?.category || "",
    media_kind: entry?.media_kind || "",
  });

  if (token !== playbackSeq) {
    await postJson("/stream/stop", { stream_id: streamId }).catch(() => undefined);
    return;
  }

  activeStreamId = streamId;
  activeUsesProxy = true;
  els.stopStream.disabled = false;
  els.proxyUrl.textContent = payload.local_proxy_url;
  setStatus("Buffer iniciado. Carregando player...", "ok");
  loadPlayer(payload.local_proxy_url, payload.media_kind || "hls");
}

function destroyPlayer() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  if (mpegtsPlayer) {
    mpegtsPlayer.destroy();
    mpegtsPlayer = null;
  }
  els.video.onerror = null;
  els.video.removeAttribute("src");
  els.video.load();
}

function loadPlayer(streamUrl, mediaKind, options = {}) {
  destroyPlayer();

  let fatalErrorHandled = false;
  const handleFatalError = (message) => {
    if (fatalErrorHandled) {
      return;
    }
    fatalErrorHandled = true;
    if (options.onFatalError) {
      options.onFatalError(new Error(message));
      return;
    }
    setStatus(message, "error");
  };

  els.video.onerror = () => handleFatalError("O navegador nao conseguiu carregar o stream.");

  if (mediaKind === "mpegts" && window.mpegts && mpegts.getFeatureList().mseLivePlayback) {
    mpegtsPlayer = mpegts.createPlayer({
      type: "mpegts",
      isLive: true,
      url: streamUrl,
    });
    mpegtsPlayer.attachMediaElement(els.video);
    mpegtsPlayer.load();
    if (window.mpegts.Events?.ERROR) {
      mpegtsPlayer.on(mpegts.Events.ERROR, (_, details) => {
        handleFatalError(details || "Erro fatal no player MPEG-TS.");
      });
    }
    els.video.play().catch(() => undefined);
    return true;
  }

  if (mediaKind === "mpegts") {
    if (!options.onFatalError) {
      handleFatalError("Este navegador nao suporta MPEG-TS via MediaSource.");
    }
    return false;
  }

  if (mediaKind === "native") {
    els.video.src = streamUrl;
    els.video.play().catch(() => undefined);
    return true;
  }

  if (els.video.canPlayType("application/vnd.apple.mpegurl")) {
    els.video.src = streamUrl;
    els.video.play().catch(() => undefined);
    return true;
  }

  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({
      liveSyncDurationCount: 1,
      maxLiveSyncPlaybackRate: 1.5,
      lowLatencyMode: true,
    });
    hls.loadSource(streamUrl);
    hls.attachMedia(els.video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => els.video.play().catch(() => undefined));
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        handleFatalError(data.details || data.type || "Erro fatal no player.");
      }
    });
    return true;
  }

  if (!options.onFatalError) {
    handleFatalError("Este navegador nao suporta HLS.");
  }
  return false;
}

async function stopActiveStream() {
  playbackSeq += 1;
  if (!activeStreamId) {
    destroyPlayer();
    return;
  }

  const streamId = activeStreamId;
  logUserAction("Parando stream", { url: streamId });
  activeStreamId = "";
  const shouldStopProxy = activeUsesProxy;
  activeUsesProxy = false;
  els.stopStream.disabled = true;
  els.proxyUrl.textContent = "";
  destroyPlayer();
  resetNowPlaying();
  if (shouldStopProxy) {
    await postJson("/stream/stop", { stream_id: streamId }).catch(() => undefined);
  }
}

async function loadPlaylist(payload, endpoint = "/api/playlist/parse") {
  logUserAction("Carregando playlist", { endpoint, source: payload.url ? "url" : payload.text ? "texto" : "salva" });
  setStatus("Lendo playlist...");
  showStatusModal("Carregando playlist", "Aguarde enquanto a playlist e carregada.");
  try {
    playlistPayload = payload;
    playlistEndpoint = endpoint;
    const data = await postJson(playlistEndpoint, { ...payload, limit: PAGE_SIZE, offset: 0 });
    applyPlaylistData(data);
    setStatus("Playlist carregada.", "ok");
    finishStatusModal("Playlist carregada", `${totalEntries} ${totalEntries === 1 ? "item encontrado" : "itens encontrados"}.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
    finishStatusModal("Erro ao carregar playlist", error.message, "error");
    throw error;
  }
}

async function loadSavedPlaylistOnStartup() {
  logUserAction("Carregando playlist salva automaticamente");
  setPlaylistLoading("Carregando playlist salva...");
  showStatusModal("Carregando playlist", "Aguarde enquanto a playlist salva e preparada para busca.");
  try {
    playlistPayload = {};
    playlistEndpoint = "/api/playlist/preloaded";
    const data = await loadPreloadedPlaylistPage({ limit: PAGE_SIZE, offset: 0 });
    applyPlaylistData(data);
    setStatus("Playlist carregada.", "ok");
    finishStatusModal("Playlist carregada", `${totalEntries} ${totalEntries === 1 ? "item encontrado" : "itens encontrados"}.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
    els.playlistEntries.className = "entries empty";
    els.playlistEntries.textContent = "Nao foi possivel carregar a playlist salva.";
    finishStatusModal("Erro ao carregar playlist", error.message, "error");
  }
}

async function loadPreloadedPlaylistPage(payload) {
  while (true) {
    const data = await postJson("/api/playlist/preloaded", payload);
    if (data.status !== "loading") {
      return data;
    }

    const message = data.message || "Carregando playlist salva...";
    setPlaylistLoading(message);
    showStatusModal("Carregando playlist", `${message} Isso pode levar alguns segundos em listas grandes.`);
    await delay(1000);
  }
}

function applyPlaylistData(data) {
  playlistId = data.playlist_id || "";
  allEntries = data.entries || [];
  totalEntries = data.total || allEntries.length;
  hasMoreEntries = Boolean(data.has_more);
  populateGroups(data.groups || allEntries.map((entry) => entry.group).filter(Boolean));
  updateCategoryCounts(data.counts || {});
  renderEntries();
}

async function cacheDefaultPlaylist(sourceUrl = "") {
  logUserAction("Atualizando cache da playlist", { source: sourceUrl ? "url informada" : "playlist configurada" });
  setStatus("Baixando e cacheando playlist...");
  showStatusModal(
    "Baixando playlist",
    "Preparando download da playlist..."
  );
  hideDownloadProgress();
  try {
    playlistPayload = {};
    playlistEndpoint = "/api/playlist/preloaded";
    await postJson("/api/playlist/cache-default", sourceUrl ? { url: sourceUrl } : {});
    await pollPlaylistCacheJob();
    const data = await loadPreloadedPlaylistPage({ limit: PAGE_SIZE, offset: 0 });
    applyPlaylistData(data);
    setStatus("Playlist baixada e cacheada.", "ok");
    finishStatusModal(
      "Playlist cacheada",
      `${totalEntries} ${totalEntries === 1 ? "entrada salva" : "entradas salvas"} em cache.`,
      "success"
    );
  } catch (error) {
    setStatus(error.message, "error");
    finishStatusModal("Erro ao cachear playlist", error.message, "error");
  }
}

async function pollPlaylistCacheJob() {
  while (true) {
    const job = await getJson("/api/playlist/cache-default/status");
    updatePlaylistCacheModal(job);

    if (job.status === "done") {
      return job;
    }
    if (job.status === "error") {
      throw new Error(job.message || "Nao foi possivel cachear a playlist.");
    }

    await delay(1000);
  }
}

function updatePlaylistCacheModal(job) {
  if (job.phase === "downloading") {
    const downloaded = formatBytes(job.downloaded_bytes);
    const total = job.total_bytes ? ` de ${formatBytes(job.total_bytes)}` : "";
    showStatusModal("Baixando playlist", `Baixados ${downloaded}${total}.`);
    showDownloadProgress(job.downloaded_bytes || 0, job.total_bytes || 0);
    return;
  }

  if (job.phase === "parsing") {
    showStatusModal("Organizando playlist", "Download concluido. Preparando canais, filmes e series para busca...");
    showDownloadProgress(job.downloaded_bytes || job.total_bytes || 1, job.total_bytes || job.downloaded_bytes || 1);
    return;
  }

  if (job.phase === "indexing") {
    showStatusModal("Finalizando cache", "Download concluido. Atualizando playlist salva...");
    showDownloadProgress(job.downloaded_bytes || job.total_bytes || 1, job.total_bytes || job.downloaded_bytes || 1);
    return;
  }

  showStatusModal("Baixando playlist", job.message || "Aguarde enquanto o cache e atualizado.");
  hideDownloadProgress();
}

async function fetchPlaylistPage({ reset = true } = {}) {
  if (!playlistId && !playlistPayload) {
    return;
  }

  const requestSeq = ++playlistRequestSeq;
  const query = els.entrySearch.value.trim();
  if (playlistFetchController) {
    playlistFetchController.abort();
  }
  playlistFetchController = new AbortController();
  logUserAction("Filtrando playlist", {
    query,
    category: selectedCategory,
    group: els.groupFilter.value,
    reset,
  });
  if (reset) {
    setPlaylistLoading(query ? `Buscando "${query}"...` : "Atualizando resultados...");
  } else {
    els.loadMore.disabled = true;
    els.loadMore.textContent = "Carregando...";
  }
  const offset = reset ? 0 : allEntries.length;
  try {
    const data = await postJson(
      playlistEndpoint,
      {
        ...(reset && playlistPayload && playlistEndpoint !== "/api/playlist/preloaded" ? playlistPayload : {}),
        playlist_id: playlistId,
        category: selectedCategory,
        group: els.groupFilter.value,
        query,
        offset,
        limit: PAGE_SIZE,
      },
      { signal: playlistFetchController.signal }
    );

    if (requestSeq !== playlistRequestSeq) {
      logUserAction("Ignorando resposta antiga da busca", { query });
      return;
    }

    playlistId = data.playlist_id || playlistId;
    totalEntries = data.total || 0;
    hasMoreEntries = Boolean(data.has_more);
    allEntries = reset ? data.entries || [] : allEntries.concat(data.entries || []);
    if (data.groups) {
      populateGroups(data.groups);
    }
    updateCategoryCounts(data.counts || {});
    renderEntries();
    setStatus(query ? `${totalEntries} resultado(s) para "${query}".` : "Playlist carregada.", "ok");
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }
    throw error;
  } finally {
    if (requestSeq === playlistRequestSeq) {
      playlistFetchController = null;
      els.loadMore.disabled = false;
      els.loadMore.textContent = "Carregar mais";
    }
  }
}

function populateGroups(groups) {
  const current = els.groupFilter.value;
  groups = Array.from(new Set(groups.filter(Boolean))).sort((a, b) => a.localeCompare(b, "pt-BR"));
  els.groupFilter.innerHTML = '<option value="">Todos os grupos</option>';
  groups.forEach((group) => {
    const option = document.createElement("option");
    option.value = group;
    option.textContent = group;
    els.groupFilter.appendChild(option);
  });
  if (groups.includes(current)) {
    els.groupFilter.value = current;
  }
}

function updateCategoryCounts(counts) {
  els.categoryFilters.forEach((button) => {
    const category = button.dataset.category;
    const suffix = category === "all" ? "" : ` (${counts[category] || 0})`;
    const label = {
      all: "Tudo",
      tv: "TV",
      movies: "Filmes",
      series: "Series",
    }[category];
    button.textContent = `${label}${suffix}`;
  });
}

function renderEntries() {
  const entries = allEntries;

  els.entryCount.textContent = `${entries.length} de ${totalEntries} ${totalEntries === 1 ? "item" : "itens"}`;
  els.loadMore.hidden = !hasMoreEntries;

  if (!entries.length) {
    els.playlistEntries.className = "entries empty";
    els.playlistEntries.textContent = "Nenhum stream encontrado nessa playlist.";
    return;
  }

  els.playlistEntries.className = "entries";
  els.playlistEntries.innerHTML = "";
  const fragment = document.createDocumentFragment();
  entries.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "entry";
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    const logo = entry.logo
      ? `<img class="entry-logo" src="${escapeHtml(entry.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
      : `<div class="entry-logo placeholder">${escapeHtml((entry.title || "?").slice(0, 1))}</div>`;
    item.innerHTML = `
      ${logo}
      <span class="entry-body">
        <strong>${escapeHtml(entry.title || entry.url)}</strong>
        <small>${escapeHtml(formatEntryMeta(entry))}</small>
        <small>${escapeHtml(entry.url)}</small>
      </span>
      <button class="favorite-toggle ${isFavorite(entry) ? "active" : ""}" type="button" aria-label="Favoritar ${escapeHtml(entry.title || entry.url)}">${isFavorite(entry) ? "★" : "☆"}</button>
    `;
    const playEntry = () => {
      els.directUrl.value = entry.url;
      scrollPlayerIntoView();
      startStream(entry.url, entry).catch(showStreamError);
    };
    item.addEventListener("click", playEntry);
    item.addEventListener("keydown", (event) => {
      if (event.target.closest(".favorite-toggle")) {
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        playEntry();
      }
    });
    item.querySelector(".favorite-toggle").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleFavorite(entry);
    });
    fragment.appendChild(item);
  });
  els.playlistEntries.appendChild(fragment);
}

function formatEntryMeta(entry) {
  const pieces = [];
  pieces.push(categoryLabel(entry.category));
  if (entry.group) {
    pieces.push(entry.group);
  }
  if (entry.resolution) {
    pieces.push(entry.resolution);
  }
  if (entry.media_kind) {
    pieces.push(entry.media_kind.toUpperCase());
  }
  return pieces.filter(Boolean).join(" - ");
}

function categoryLabel(category) {
  return {
    tv: "TV",
    movies: "Filmes",
    series: "Series",
  }[category] || "Outros";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

els.loadTest.addEventListener("click", () => {
  logUserAction("Clique em atualizar playlist");
  cacheDefaultPlaylist();
});

els.startDirect.addEventListener("click", () => {
  logUserAction("Clique em iniciar link direto", { url: els.directUrl.value.trim() });
  startStream(els.directUrl.value.trim()).catch(showStreamError);
});

els.loadPlaylistUrl.addEventListener("click", () => {
  const sourceUrl = els.playlistUrl.value.trim();
  logUserAction("Clique em carregar playlist por URL", { hasUrl: Boolean(sourceUrl) });
  if (!sourceUrl) {
    loadPlaylist({ url: sourceUrl }).catch(() => undefined);
    return;
  }
  cacheDefaultPlaylist(sourceUrl);
});

els.parsePlaylistText.addEventListener("click", () => {
  logUserAction("Clique em ler playlist colada", { chars: els.playlistText.value.length });
  loadPlaylist({ text: els.playlistText.value }).catch(() => undefined);
});

els.playlistFile.addEventListener("change", async () => {
  const file = els.playlistFile.files[0];
  if (!file) {
    return;
  }
  const text = await file.text();
  logUserAction("Arquivo de playlist selecionado", { name: file.name, size: file.size });
  els.playlistText.value = text;
  loadPlaylist({ text }).catch(() => undefined);
});

els.statusModalClose.addEventListener("click", hideStatusModal);

let searchTimer = null;
els.entrySearch.addEventListener("input", () => {
  playlistRequestSeq += 1;
  if (playlistFetchController) {
    playlistFetchController.abort();
  }
  clearTimeout(searchTimer);
  const query = els.entrySearch.value.trim();
  setStatus(query ? "Buscando na playlist..." : "Limpando busca...");
  setPlaylistLoading(query ? `Buscando "${query}"...` : "Atualizando resultados...");
  searchTimer = setTimeout(() => {
    fetchPlaylistPage({ reset: true }).catch((error) => setStatus(error.message, "error"));
  }, SEARCH_DEBOUNCE_MS);
});
els.groupFilter.addEventListener("change", () => {
  logUserAction("Grupo alterado", { group: els.groupFilter.value });
  fetchPlaylistPage({ reset: true }).catch((error) => setStatus(error.message, "error"));
});
els.categoryFilters.forEach((button) => {
  button.addEventListener("click", () => {
    selectedCategory = button.dataset.category;
    logUserAction("Categoria alterada", { category: selectedCategory });
    els.categoryFilters.forEach((filter) => filter.classList.toggle("active", filter === button));
    fetchPlaylistPage({ reset: true }).catch((error) => setStatus(error.message, "error"));
  });
});

els.loadMore.addEventListener("click", () => {
  logUserAction("Carregar mais resultados", { current: allEntries.length, total: totalEntries });
  fetchPlaylistPage({ reset: false }).catch((error) => setStatus(error.message, "error"));
});

els.stopStream.addEventListener("click", () => {
  stopActiveStream().then(() => setStatus("Stream parado.", "ok"));
});

els.playbackMode.addEventListener("change", () => {
  logUserAction("Modo de reproducao alterado", { playback_mode: currentPlaybackMode() });
  setStatus(`Modo de reproducao: ${els.playbackMode.options[els.playbackMode.selectedIndex].text}.`, "ok");
});

window.addEventListener("beforeunload", () => {
  if (!activeStreamId || !activeUsesProxy) {
    return;
  }
  navigator.sendBeacon(
    "/stream/stop",
    new Blob([JSON.stringify({ stream_id: activeStreamId })], { type: "application/json" })
  );
});

document.addEventListener("DOMContentLoaded", async () => {
  await loadAppConfig();
  loadSessionFavorites();
  loadSavedPlaylistOnStartup();
});

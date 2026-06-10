const els = {
  authPanel: document.querySelector("#auth-panel"),
  authRequired: document.querySelectorAll("[data-auth-required]"),
  loginForm: document.querySelector("#login-form"),
  accessHash: document.querySelector("#access-hash"),
  authMessage: document.querySelector("#auth-message"),
  authUserName: document.querySelector("#auth-user-name"),
  authUserLimits: document.querySelector("#auth-user-limits"),
  logout: document.querySelector("#logout"),
  loadTest: document.querySelector("#load-test"),
  playlistEntries: document.querySelector("#playlist-entries"),
  entryCount: document.querySelector("#entry-count"),
  favoritesPanel: document.querySelector("#favorites-panel"),
  favoriteShortcuts: document.querySelector("#favorite-shortcuts"),
  trialPanel: document.querySelector("#trial-panel"),
  trialSections: document.querySelector("#trial-sections"),
  entrySearch: document.querySelector("#entry-search"),
  groupFilter: document.querySelector("#group-filter"),
  categoryFilters: document.querySelectorAll(".filter"),
  tvQuickLinks: document.querySelector("#tv-quick-links"),
  worldCupQuickLinks: document.querySelector("#world-cup-quick-links"),
  realityQuickLinks: document.querySelector("#reality-quick-links"),
  dailyGameQuickLinks: document.querySelector("#daily-game-quick-links"),
  seriesStreamerLinks: document.querySelector("#series-streamer-links"),
  loadMore: document.querySelector("#load-more"),
  stopStream: document.querySelector("#stop-stream"),
  openVlc: document.querySelector("#open-vlc"),
  resumeBrowserPlayback: document.querySelector("#resume-browser-playback"),
  playerPanel: document.querySelector(".player-panel"),
  nowPlayingLogo: document.querySelector("#now-playing-logo"),
  nowPlayingTitle: document.querySelector("#now-playing-title"),
  nowPlayingMeta: document.querySelector("#now-playing-meta"),
  video: document.querySelector("#video"),
  bufferHealth: document.querySelector("#buffer-health"),
  bufferHealthLabel: document.querySelector("#buffer-health-label"),
  bufferHealthDetails: document.querySelector("#buffer-health-details"),
  bufferHealthFill: document.querySelector("#buffer-health-fill"),
  playbackMode: document.querySelector("#playback-mode"),
  externalPlayer: document.querySelector("#external-player"),
  status: document.querySelector("#status"),
  proxyUrl: document.querySelector("#proxy-url"),
  statusModal: document.querySelector("#status-modal"),
  statusModalBox: document.querySelector("#status-modal .modal"),
  statusModalTitle: document.querySelector("#status-modal-title"),
  statusModalMessage: document.querySelector("#status-modal-message"),
  statusModalClose: document.querySelector("#status-modal-close"),
  statusModalActions: document.querySelector("#status-modal-actions"),
  statusModalOpenExternal: document.querySelector("#status-modal-open-external"),
  statusModalPlayBrowser: document.querySelector("#status-modal-play-browser"),
  episodeModal: document.querySelector("#episode-modal"),
  episodeModalTitle: document.querySelector("#episode-modal-title"),
  episodeModalMessage: document.querySelector("#episode-modal-message"),
  episodeModalOptions: document.querySelector("#episode-modal-options"),
  episodeModalClose: document.querySelector("#episode-modal-close"),
  hubLoading: document.querySelector("#hub-loading"),
  hubLoadingPhase: document.querySelector("#hub-loading-phase"),
  downloadProgress: document.querySelector("#download-progress"),
  downloadProgressLabel: document.querySelector("#download-progress-label"),
  downloadProgressRemaining: document.querySelector("#download-progress-remaining"),
  downloadProgressBar: document.querySelector("#download-progress-bar"),
  clockTime: document.querySelector("#clock-time"),
  clockDate: document.querySelector("#clock-date"),
  externalPlayerTitle: document.querySelector("#external-player-title"),
  externalPlayerDescription: document.querySelector("#external-player-description"),
  externalPlayerInstallLink: document.querySelector("#external-player-install-link"),
  externalPlayerRecommendation: document.querySelector("#external-player-recommendation"),
};

let hls = null;
let mpegtsPlayer = null;
let playbackMonitorTimer = null;
let activeStreamId = "";
let activeEntry = null;
let activeUsesProxy = false;
let playbackSeq = 0;
let allEntries = [];
let allSeriesGroups = [];
let selectedSeriesKey = "";
let selectedSeriesTitle = "";
let selectedSeriesLogo = "";
let selectedSeriesLogoCandidates = [];
let selectedSeriesGroupName = "";
let selectedSeriesSeasons = [];
let selectedSeriesSeason = "";
let selectedMovieCollectionOpen = false;
let selectedMovieCollectionTitle = "";
let selectedCategory = "";
let categoryInteracted = false;
let dailyGamesCatalogRequested = false;
let dailyGameShortcutEntries = [];
let worldCupCatalogRequested = false;
let worldCupShortcutEntries = [];
let realityShortcutEntries = [];
let playlistId = "";
let playlistPayload = null;
let playlistEndpoint = "/api/playlist/parse";
let totalEntries = 0;
let hasMoreEntries = false;
let playlistRequestSeq = 0;
let playlistFetchController = null;
let favoriteEntries = [];
let watchedEpisodes = {};
let authToken = "";
let currentUser = null;
let heartbeatTimer = null;
let appLoaded = false;
let startupPlaylistLoadPromise = null;
let trialCatalogLoadPromise = null;
let pendingExternalLaunch = null;
const PAGE_SIZE = 20;
const DETAIL_PAGE_SIZE = 500;
const SEARCH_DEBOUNCE_MS = 250;
const MIN_SEARCH_QUERY_LENGTH = 2;
const PLAYLIST_LOADING_POLL_MS = 3000;
const FAVORITES_STORAGE_KEY = "streamM3U8UserFavorites";
const WATCHED_STORAGE_KEY = "streamM3U8WatchedEpisodes";
const DEVICE_ID_STORAGE_KEY = "streamM3U8DeviceId";
const LAST_SELECTED_STREAM_STORAGE_KEY = "streamM3U8LastSelectedStream";
const PLAYBACK_MODES = new Set(["auto", "direct", "proxy"]);
const LIVE_START_BUFFER_SECONDS = 10;
const LIVE_FRAME_BUFFER_SECONDS = 1.5;
const LIVE_MAX_LATENCY_SECONDS = 135;
const LIVE_TARGET_LATENCY_SECONDS = 90;
const LIVE_CATCHUP_LATENCY_SECONDS = 115;
const LIVE_GROW_BUFFER_UNTIL_SECONDS = 90;
const LIVE_LOW_BUFFER_SECONDS = 45;
const LIVE_BUFFER_GROWTH_PLAYBACK_RATE = 0.985;
const LIVE_CATCHUP_PLAYBACK_RATE = 1.02;
const VLC_ANDROID_PACKAGE = "org.videolan.vlc";
const VLC_ANDROID_STORE_URL = "https://play.google.com/store/apps/details?id=org.videolan.vlc";
const VLC_IOS_STORE_URL = "https://apps.apple.com/app/vlc-media-player/id650377962";
const VLC_DESKTOP_URL = "https://www.videolan.org/vlc/";
const OUTPLAYER_IOS_STORE_URL = "https://apps.apple.com/app/outplayer/id1449923287";
const OUTPLAYER_SITE_URL = "https://outplayer.app/";
const EXTERNAL_PLAYER_LABELS = {
  vlc: "VLC",
  outplayer: "Outplayer",
};
const TV_QUICK_LINK_GROUPS = [
  {
    title: "TV aberta",
    channels: [
      { name: "TV Globo", search: "Globo", domain: "globo.com" },
      { name: "Record", domain: "r7.com" },
      { name: "SBT", domain: "sbt.com.br" },
      { name: "Band", domain: "band.uol.com.br" },
      { name: "TV Cultura", search: "Cultura", domain: "tvcultura.com.br" },
      { name: "RedeTV!", search: "RedeTV", domain: "redetv.uol.com.br" },
    ],
  },
  {
    title: "TV por assinatura",
    channels: [
      { name: "SporTV", domain: "sportv.globo.com" },
      { name: "GloboNews", domain: "globonews.globo.com" },
      { name: "TNT", domain: "tntdrama.com.br" },
      { name: "ESPN", domain: "espn.com.br" },
      { name: "CNN Brasil", domain: "cnnbrasil.com.br" },
      { name: "Jovem Pan News", domain: "jovempan.com.br" },
      { name: "Record News", domain: "recordnews.r7.com" },
    ],
  },
];
const DAILY_GAME_QUICK_LINK_GROUPS = [
  {
    title: "Futebol",
    channels: [],
  },
  {
    title: "Canais esportivos",
    channels: [
      { name: "Premiere", domain: "premiere.globo.com" },
      { name: "SporTV", domain: "sportv.globo.com" },
      { name: "ESPN", domain: "espn.com.br" },
      { name: "NBA", domain: "nba.com" },
      { name: "Combate", domain: "combate.globo.com" },
      { name: "UFC", domain: "ufc.com.br" },
    ],
  },
];
const SERIES_STREAMER_LINKS = [
  { name: "Netflix", search: "netflix", domain: "netflix.com" },
  { name: "Prime Video", search: "prime video", domain: "primevideo.com" },
  { name: "HBO / Max", search: "max", domain: "max.com" },
  { name: "Disney+", search: "disney plus", domain: "disneyplus.com" },
  { name: "Apple TV+", search: "apple tv", domain: "tv.apple.com" },
  { name: "Paramount+", search: "paramount plus", domain: "paramountplus.com" },
  { name: "Globoplay", search: "globoplay", domain: "globoplay.globo.com" },
  { name: "Star+", search: "star plus", domain: "starplus.com" },
];

function logUserAction(action, details = {}) {
  console.info(`[Stream M3U8] ${action}`, {
    at: new Date().toISOString(),
    ...details,
  });
}

function updateClock() {
  if (!els.clockTime || !els.clockDate) {
    return;
  }
  const now = new Date();
  els.clockTime.textContent = now.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  els.clockDate.textContent = now.toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });
}

function startClock() {
  updateClock();
  setInterval(updateClock, 1000);
}

function setStatus(message, type = "") {
  els.status.hidden = false;
  els.status.textContent = message;
  els.status.className = `status top-status ${type}`.trim();
}

function normalizePlaybackMode(mode) {
  return PLAYBACK_MODES.has(mode) ? mode : "auto";
}

function currentPlaybackMode() {
  return normalizePlaybackMode(els.playbackMode.value);
}

function currentExternalPlayer() {
  const player = els.externalPlayer?.value || "vlc";
  return EXTERNAL_PLAYER_LABELS[player] ? player : "vlc";
}

function authHeaders() {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

function deviceId() {
  let value = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (!value) {
    value = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, value);
  }
  return value;
}

function normalizeAccessHash(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }
  try {
    const url = new URL(rawValue, window.location.origin);
    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts[0] === "access" || pathParts[0] === "u") {
      return decodeURIComponent(pathParts[1] || "");
    }
    return url.searchParams.get("access") || url.searchParams.get("token") || rawValue;
  } catch {
    return rawValue;
  }
}

function accessHashFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const queryHash = params.get("access") || params.get("token");
  if (queryHash) {
    return queryHash;
  }
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  if (pathParts[0] === "access" || pathParts[0] === "u") {
    return decodeURIComponent(pathParts[1] || "");
  }
  return "";
}

function setAuthMessage(message, type = "") {
  els.authMessage.hidden = false;
  els.authMessage.textContent = message;
  els.authMessage.className = `auth-message ${type}`.trim();
}

function showLogin() {
  currentUser = null;
  appLoaded = false;
  trialCatalogLoadPromise = null;
  stopHeartbeat();
  els.authPanel.hidden = false;
  els.authRequired.forEach((element) => {
    element.hidden = true;
  });
  els.favoritesPanel.hidden = true;
  if (els.trialPanel) {
    els.trialPanel.hidden = true;
  }
}

function showAuthenticatedApp(user) {
  currentUser = user;
  els.authPanel.hidden = true;
  els.authRequired.forEach((element) => {
    element.hidden = false;
  });
  els.authUserName.textContent = user.name || user.email;
  if (user.is_admin) {
    els.authUserLimits.textContent = "Acesso administrador | sem limitacao";
    return;
  }
  const expiresAt = user.access_expires_at ? new Date(user.access_expires_at * 1000).toLocaleDateString("pt-BR") : "";
  const trialLabel = isTrialUser(user) ? " | degustacao gratuita" : "";
  els.authUserLimits.textContent = `${user.max_screens} tela(s) | adulto: ${user.allow_adult_content ? "ativado" : "bloqueado"}${trialLabel}${expiresAt ? ` | link expira em ${expiresAt}` : ""}`;
}

function isTrialUser(user = currentUser) {
  return user?.catalog_access_mode === "allowlist";
}

function startAuthenticatedExperience() {
  if (appLoaded) {
    return;
  }
  appLoaded = true;
  loadSessionFavorites();
  playlistPayload = {};
  playlistEndpoint = "/api/playlist/preloaded";
  if (isTrialUser()) {
    clearPlaybackSelection();
    renderInitialCollapsedView();
    setStatus("Carregando degustação gratuita...", "ok");
    hideHubLoading();
    loadTrialCatalog();
  } else {
    loadSavedPlaylistOnStartup();
    loadTrialCatalog();
  }
  if (!isTrialUser()) {
    restoreLastSelectedStream();
  }
}

function startHeartbeat(intervalSeconds = 30) {
  stopHeartbeat();
  sendHeartbeat();
  heartbeatTimer = setInterval(() => {
    sendHeartbeat();
  }, Math.max(intervalSeconds, 10) * 1000);
}

function sendHeartbeat() {
  if (!currentUser && !authToken) {
    return;
  }
  postJson("/api/auth/heartbeat", {})
    .then((response) => {
      if (response.token) {
        authToken = response.token;
      }
    })
    .catch(handleAuthFailure);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function isNetworkAuthError(error) {
  const message = String(error?.message || "").toLowerCase();
  return error?.name === "TypeError"
    || error?.name === "AbortError"
    || message.includes("failed to fetch")
    || message.includes("networkerror")
    || message.includes("load failed");
}

function handleAuthFailure(error) {
  if (isNetworkAuthError(error)) {
    setStatus("Conexao oscilou. Mantendo sua sessao ativa.", "error");
    return;
  }
  authToken = "";
  showLogin();
  setAuthMessage(error.message || "Sessao expirada. Entre novamente.", "error");
}

async function initAuth() {
  const accessHash = accessHashFromLocation();
  if (accessHash) {
    authToken = "";
    return loginWithAccessHash(accessHash, { replaceUrl: true });
  }
  try {
    const data = await getJson("/api/auth/me");
    showAuthenticatedApp(data.user);
    startHeartbeat(data.session?.heartbeat_interval_seconds || 30);
    return true;
  } catch (error) {
    if (isNetworkAuthError(error)) {
      setStatus("Conexao oscilou. Mantendo sua sessao ativa.", "error");
      return Boolean(currentUser || authToken);
    }
    handleAuthFailure(error);
    return false;
  }
}

async function login(event) {
  event.preventDefault();
  return loginWithAccessHash(normalizeAccessHash(els.accessHash.value));
}

async function loginWithAccessHash(accessHash, options = {}) {
  setAuthMessage("Validando acesso...");
  try {
    const response = await postJson(
      "/api/auth/link-login",
      {
        access_hash: normalizeAccessHash(accessHash),
        device_name: navigator.userAgent || "Navegador",
        device_id: deviceId(),
      },
      { auth: false }
    );
    authToken = response.token;
    els.accessHash.value = "";
    if (options.replaceUrl) {
      window.history.replaceState({}, "", "/");
    }
    showAuthenticatedApp(response.user);
    startHeartbeat(response.session?.heartbeat_interval_seconds || 30);
    setStatus("Login realizado.", "ok");
    startAuthenticatedExperience();
  } catch (error) {
    setAuthMessage(error.message, "error");
    return false;
  }
  return true;
}

async function logout() {
  await postJson("/api/auth/logout", {}).catch(() => undefined);
  authToken = "";
  showLogin();
  setAuthMessage("Sessao encerrada.", "ok");
}

function recommendedExternalPlayer() {
  const platform = getClientPlatform();
  if (platform === "ios") {
    return {
      player: "outplayer",
      label: "Outplayer",
      title: "Para uma melhor experiencia no iPhone/iPad, instale o Outplayer.",
      description: "O Outplayer costuma ser uma boa opcao para TV ao vivo no iOS. Se algum stream nao abrir, mantenha o VLC como alternativa.",
      message: "Melhor escolha para iPhone/iPad: Outplayer. Alternativa: VLC.",
      storeUrl: OUTPLAYER_IOS_STORE_URL,
    };
  }
  if (platform === "android") {
    return {
      player: "vlc",
      label: "VLC",
      title: "Para uma melhor experiencia no Android, instale o VLC.",
      description: "O VLC e a opcao mais compativel no Android para abrir streams de TV ao vivo com menos falhas.",
      message: "Melhor escolha para Android: VLC.",
      storeUrl: VLC_ANDROID_STORE_URL,
    };
  }
  return {
    player: "vlc",
    label: "VLC",
    title: "Para uma melhor experiencia no desktop, instale o VLC.",
    description: "No Windows, macOS e Linux, o botao de player externo tenta abrir o VLC instalado diretamente. Se o navegador bloquear a abertura, reproduza no navegador.",
    message: "Melhor escolha para desktop: VLC instalado no computador.",
    storeUrl: VLC_DESKTOP_URL,
  };
}

function applyExternalPlayerRecommendation() {
  const recommendation = recommendedExternalPlayer();
  if (els.externalPlayer && EXTERNAL_PLAYER_LABELS[recommendation.player]) {
    els.externalPlayer.value = recommendation.player;
  }
  if (els.externalPlayerTitle) {
    els.externalPlayerTitle.textContent = recommendation.title;
  }
  if (els.externalPlayerDescription) {
    els.externalPlayerDescription.firstChild.textContent = `${recommendation.description} `;
  }
  if (els.externalPlayerInstallLink) {
    els.externalPlayerInstallLink.href = recommendation.storeUrl;
    els.externalPlayerInstallLink.textContent = `Instalar ${recommendation.label}`;
  }
  if (els.externalPlayerRecommendation) {
    els.externalPlayerRecommendation.innerHTML = `${escapeHtml(recommendation.message)} <a href="${recommendation.storeUrl}" target="_blank" rel="noopener noreferrer">Instalar ${escapeHtml(recommendation.label)}</a>`;
  }
}

async function loadAppConfig() {
  try {
    const config = await getJson("/api/config", { auth: false });
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

function scrollResultsIntoView() {
  els.playlistEntries.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
}

function userStorageKey(baseKey) {
  return `${baseKey}:${currentUser?.id || "anonymous"}`;
}

function loadSessionFavorites() {
  try {
    favoriteEntries = JSON.parse(localStorage.getItem(userStorageKey(FAVORITES_STORAGE_KEY)) || "[]");
  } catch {
    favoriteEntries = [];
  }
  try {
    watchedEpisodes = JSON.parse(localStorage.getItem(userStorageKey(WATCHED_STORAGE_KEY)) || "{}");
  } catch {
    watchedEpisodes = {};
  }
  renderFavoriteShortcuts();
  fetchUserState();
}

function saveSessionFavorites() {
  saveUserState();
}

function saveUserState() {
  localStorage.setItem(userStorageKey(FAVORITES_STORAGE_KEY), JSON.stringify(favoriteEntries));
  localStorage.setItem(userStorageKey(WATCHED_STORAGE_KEY), JSON.stringify(watchedEpisodes));
  if (currentUser || authToken) {
    postJson("/api/user/state", {
      favorites: favoriteEntries,
      watched_episodes: watchedEpisodes,
    }).catch(() => undefined);
  }
}

async function fetchUserState() {
  if (!currentUser && !authToken) {
    return;
  }
  try {
    const state = await getJson("/api/user/state");
    favoriteEntries = Array.isArray(state.favorites) ? state.favorites : favoriteEntries;
    watchedEpisodes = state.watched_episodes && typeof state.watched_episodes === "object" ? state.watched_episodes : watchedEpisodes;
    localStorage.setItem(userStorageKey(FAVORITES_STORAGE_KEY), JSON.stringify(favoriteEntries));
    localStorage.setItem(userStorageKey(WATCHED_STORAGE_KEY), JSON.stringify(watchedEpisodes));
    renderFavoriteShortcuts();
    renderEntries();
  } catch {
    // Local state remains usable if the backend is temporarily unavailable.
  }
}

function favoriteKey(favorite) {
  if (favorite.type === "series") {
    return `series:${favorite.series_key || favorite.title || ""}`;
  }
  if (favorite.type === "movie_collection") {
    return `movie_collection:${(favorite.title || favorite.query || "").trim().toLowerCase()}`;
  }
  return `entry:${favorite.url || ""}`;
}

function isFavorite(favorite) {
  const key = favoriteKey(favorite);
  return favoriteEntries.some((entry) => favoriteKey(entry) === key);
}

function seriesFavorite(series) {
  return {
    type: "series",
    title: series.title || "Serie",
    logo: series.logo || "",
    logo_candidates: series.logo_candidates || [],
    group: series.group || "",
    series_key: series.series_key || "",
    seasons: series.seasons || [],
  };
}

function selectedSeriesFavorite() {
  return seriesFavorite({
    title: selectedSeriesTitle || "Serie",
    logo: selectedSeriesLogo || "",
    logo_candidates: selectedSeriesLogoCandidates,
    group: selectedSeriesGroupName || "",
    series_key: selectedSeriesKey,
    seasons: selectedSeriesSeasons,
  });
}

function coverScore(value) {
  const source = String(value || "").toLowerCase();
  if (!source) {
    return 0;
  }
  if (/timg\.bdta\.pro|gstaticontent\.com|placeholder|default|noimage|no-image|sem-logo|blank|1x1/.test(source)) {
    return 0;
  }
  let score = 1;
  if (source.startsWith("http://") || source.startsWith("https://")) {
    score += 2;
  }
  if (source.includes("image.tmdb.org")) {
    score += 3;
  }
  if (/w600_and_h900|w500|w342/.test(source)) {
    score += 4;
  }
  if (/\.(jpe?g|png|webp)(?:\?|$)/.test(source)) {
    score += 2;
  }
  score += 1;
  return score;
}

function normalizeCatalogText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function movieCoverScore(entry, entries = [], collectionTitle = "") {
  const logo = entry.logo || "";
  let score = coverScore(logo);
  if (score <= 0) {
    return 0;
  }
  const title = normalizeCatalogText(entry.title || "");
  const collection = normalizeCatalogText(collectionTitle);
  if (collection && title.includes(collection)) {
    score += 6;
  }
  if (collection && title.startsWith(collection)) {
    score += 4;
  }
  const sameLogoTitles = new Set(
    entries
      .filter((candidate) => candidate.logo === logo)
      .map((candidate) => normalizeCatalogText(candidate.title || candidate.url || ""))
      .filter(Boolean)
  );
  if (sameLogoTitles.size > 1) {
    score -= Math.min(8, sameLogoTitles.size + 3);
  }
  return score;
}

function coalesceCover(entries, collectionTitle = "") {
  const bestEntry = entries.reduce((best, entry) => {
    return !best || movieCoverScore(entry, entries, collectionTitle) > movieCoverScore(best, entries, collectionTitle) ? entry : best;
  }, null);
  return bestEntry?.logo || "";
}

function coverCandidates(entries, primary = "", collectionTitle = "") {
  return Array.from(new Set(
    entries
      .filter((entry) => (entry.logo || "") && entry.logo !== primary && coverScore(entry.logo) > 0)
      .sort((a, b) => movieCoverScore(b, entries, collectionTitle) - movieCoverScore(a, entries, collectionTitle))
      .map((entry) => entry.logo || "")
  ));
}

function imageWithFallback({ className, src, candidates = [], placeholder, alt = "" }) {
  const sources = [src, ...candidates].filter(Boolean);
  const uniqueSources = Array.from(new Set(sources));
  if (!uniqueSources.length) {
    return placeholder;
  }
  return `<img class="${className}" src="${escapeHtml(uniqueSources[0])}" alt="${escapeHtml(alt)}" loading="lazy" referrerpolicy="no-referrer" data-fallback-logos="${escapeHtml(JSON.stringify(uniqueSources.slice(1)))}" />`;
}

function bindImageFallbacks(root) {
  root.querySelectorAll("img[data-fallback-logos]").forEach((image) => {
    image.addEventListener("error", () => {
      let fallbacks = [];
      try {
        fallbacks = JSON.parse(image.dataset.fallbackLogos || "[]");
      } catch {
        fallbacks = [];
      }
      const next = fallbacks.shift();
      if (!next) {
        image.replaceWith(Object.assign(document.createElement("div"), {
          className: image.className,
          textContent: "?",
        }));
        return;
      }
      image.dataset.fallbackLogos = JSON.stringify(fallbacks);
      image.src = next;
    });
  });
}

function movieCollectionFavorite(title, movies) {
  return {
    type: "movie_collection",
    title,
    query: els.entrySearch.value.trim() || title,
    logo: coalesceCover(movies, title),
    entries: movies.map((entry) => ({
      title: entry.title || entry.url,
      url: entry.url,
      logo: entry.logo || "",
      group: entry.group || "",
      category: entry.category || "movies",
      media_kind: entry.media_kind || "",
      resolution: entry.resolution || "",
    })),
  };
}

function entryFavorite(entry) {
  return {
    title: entry.title || entry.url,
    url: entry.url,
    logo: entry.logo || "",
    group: entry.group || "",
    category: entry.category || "",
    media_kind: entry.media_kind || "",
  };
}

function toggleFavorite(favorite) {
  const key = favoriteKey(favorite);
  if (isFavorite(favorite)) {
    favoriteEntries = favoriteEntries.filter((entry) => favoriteKey(entry) !== key);
    logUserAction("Removendo favorito", { title: favorite.title, type: favorite.type || "entry" });
  } else {
    favoriteEntries.unshift(favorite);
    logUserAction("Adicionando favorito", { title: favorite.title, type: favorite.type || "entry" });
  }
  saveSessionFavorites();
  renderFavoriteShortcuts();
  renderEntries();
}

function toggleEntryFavorite(entry) {
  toggleFavorite(entryFavorite(entry));
}

function renderFavoriteShortcuts() {
  els.favoritesPanel.hidden = favoriteEntries.length === 0;
  els.favoriteShortcuts.innerHTML = "";

  favoriteEntries.forEach((favorite) => {
    const shortcut = document.createElement("button");
    shortcut.className = "favorite-shortcut";
    shortcut.type = "button";
    const title = favorite.title || favorite.url;
    const typeLabel = {
      movie_collection: "Saga",
      series: "Serie",
    }[favorite.type] || "";
    const logo = favorite.logo
      ? `<img class="favorite-shortcut-logo" src="${escapeHtml(favorite.logo)}" alt="" referrerpolicy="no-referrer" />`
      : `<span class="favorite-shortcut-logo">${escapeHtml(title.slice(0, 1).toUpperCase())}</span>`;
    shortcut.innerHTML = `${logo}<span>${typeLabel ? `<small>${escapeHtml(typeLabel)}</small>` : ""}${escapeHtml(title)}</span>`;
    shortcut.addEventListener("click", () => {
      logUserAction("Abrindo favorito", { title, type: favorite.type || "entry" });
      if (favorite.type === "series") {
        openSeriesGroup(favorite, { scroll: true }).catch((error) => setStatus(error.message, "error"));
        return;
      }
      if (favorite.type === "movie_collection") {
        openFavoriteMovieCollection(favorite);
        return;
      }
      scrollPlayerIntoView();
      startStream(favorite.url, favorite).catch(showStreamError);
    });
    els.favoriteShortcuts.appendChild(shortcut);
  });
}

function openFavoriteMovieCollection(favorite) {
  selectedCategory = "movies";
  els.categoryFilters.forEach((filter) => filter.classList.toggle("active", filter.dataset.category === "movies"));
  resetSelectedSeries();
  selectedMovieCollectionOpen = true;
  selectedMovieCollectionTitle = favorite.title || "Saga";
  els.entrySearch.value = favorite.query || favorite.title || "";
  allSeriesGroups = [];
  allEntries = (favorite.entries || []).map((entry) => ({ ...entry, category: entry.category || "movies" }));
  totalEntries = allEntries.length;
  hasMoreEntries = false;
  updateQuickLinksVisibility();
  renderEntries();
  setStatus(`${totalEntries} filme(s) em ${selectedMovieCollectionTitle}.`, "ok");
  scrollResultsIntoView();
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

function persistLastSelectedStream(streamId, entry = null) {
  if (!streamId) {
    return;
  }
  const payload = {
    stream_id: streamId,
    entry: entry || { title: "Link direto", url: streamId },
    saved_at: Date.now(),
  };
  localStorage.setItem(LAST_SELECTED_STREAM_STORAGE_KEY, JSON.stringify(payload));
  if (els.resumeBrowserPlayback) {
    els.resumeBrowserPlayback.hidden = false;
  }
}

function loadLastSelectedStream() {
  try {
    const payload = JSON.parse(localStorage.getItem(LAST_SELECTED_STREAM_STORAGE_KEY) || "{}");
    if (payload.stream_id) {
      return payload;
    }
  } catch {
    return null;
  }
  return null;
}

function restoreLastSelectedStream() {
  if (activeStreamId) {
    return;
  }
  const saved = loadLastSelectedStream();
  if (!saved?.stream_id) {
    return;
  }
  activeStreamId = saved.stream_id;
  activeEntry = saved.entry || { title: "Link direto", url: saved.stream_id };
  updateNowPlaying(activeEntry);
  els.stopStream.disabled = false;
  els.openVlc.disabled = false;
  if (els.resumeBrowserPlayback) {
    els.resumeBrowserPlayback.hidden = false;
  }
}

function clearPlaybackSelection() {
  activeStreamId = "";
  activeEntry = null;
  activeUsesProxy = false;
  localStorage.removeItem(LAST_SELECTED_STREAM_STORAGE_KEY);
  els.stopStream.disabled = true;
  els.openVlc.disabled = true;
  if (els.resumeBrowserPlayback) {
    els.resumeBrowserPlayback.hidden = true;
  }
  els.proxyUrl.textContent = "";
  destroyPlayer();
  resetNowPlaying();
}

function showStatusModal(title, message, type = "loading") {
  els.statusModal.hidden = false;
  els.statusModalBox.className = `modal ${type === "loading" ? "" : type}`.trim();
  els.statusModalTitle.textContent = title;
  els.statusModalMessage.textContent = message;
  els.statusModalActions.hidden = true;
  els.statusModalOpenExternal.hidden = false;
  els.statusModalPlayBrowser.hidden = false;
  setStatusModalExternalButton();
  if (type !== "loading") {
    hideDownloadProgress();
  }
}

function showHubLoading() {
  if (els.hubLoading) {
    els.hubLoading.hidden = false;
  }
}

function playlistPhaseLabel(phase, status = "") {
  const normalized = String(phase || "").toLowerCase();
  return {
    starting: "Starting",
    downloading: "Downloading",
    "cache-check": "Checking cache",
    "loading-cache": "Loading cache",
    parsing: "Parsing",
    indexing: "Indexing",
    done: "Ready",
    error: "Error",
  }[normalized] || (status === "done" ? "Ready" : "Preparing");
}

function setHubLoadingPhase(phase, status = "") {
  if (!els.hubLoadingPhase) {
    return;
  }
  els.hubLoadingPhase.textContent = playlistPhaseLabel(phase, status);
}

function hideHubLoading() {
  if (els.hubLoading) {
    els.hubLoading.hidden = true;
  }
}

function hideStatusModal() {
  els.statusModal.hidden = true;
  els.statusModalActions.hidden = true;
}

function finishStatusModal(title, message, type) {
  showStatusModal(title, message, type);
}

function showExternalPlayerModal(title, message, options = {}) {
  showStatusModal(title, message, "info");
  els.statusModalActions.hidden = false;
  els.statusModalPlayBrowser.hidden = options.allowBrowser === false;
}

function setStatusModalExternalButton(label = "Abrir player externo", disabled = false) {
  if (!els.statusModalOpenExternal) {
    return;
  }
  els.statusModalOpenExternal.textContent = label;
  els.statusModalOpenExternal.disabled = disabled;
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
    headers: {
      "Content-Type": "application/json",
      ...(options.auth === false ? {} : authHeaders()),
    },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Erro inesperado");
    error.status = response.status;
    if (response.status === 401 && options.auth !== false) {
      handleAuthFailure(error);
    }
    throw error;
  }
  return data;
}

async function getJson(url, options = {}) {
  const response = await fetch(url, {
    headers: options.auth === false ? {} : authHeaders(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Erro inesperado");
    error.status = response.status;
    if (response.status === 401 && options.auth !== false) {
      handleAuthFailure(error);
    }
    throw error;
  }
  return data;
}

async function waitForPreloadedPlaylistReady() {
  while (true) {
    const status = await getJson("/api/playlist/preloaded/status", { auth: false });
    setHubLoadingPhase(status.phase, status.status);
    if (status.status === "done") {
      return status;
    }
    if (status.status === "error") {
      throw new Error(status.error || status.message || "Nao foi possivel carregar a playlist.");
    }
    showHubLoading();
    await delay(PLAYLIST_LOADING_POLL_MS);
  }
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

function inferLivePlayback(streamId, entry = null, mediaKind = "") {
  if (mediaKind === "mpegts") {
    return true;
  }
  if (entry?.category && entry.category !== "tv") {
    return false;
  }

  const path = streamId.toLowerCase().split("?", 1)[0];
  return mediaKind === "hls" || path.endsWith(".m3u8") || path.includes("/live/");
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
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => undefined);
}

async function startStream(streamId, entry = null, options = {}) {
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
  pendingExternalLaunch = null;
  await stopActiveStream();
  const token = ++playbackSeq;
  const mediaKind = inferMediaKind(streamId, entry);
  const isLive = inferLivePlayback(streamId, entry, mediaKind);
  const selectedPlaybackMode = currentPlaybackMode();
  const shouldRecommendExternal = isLive && !options.allowLiveBrowser;
  const playbackMode = shouldRecommendExternal ? "external" : selectedPlaybackMode;
  logContentRequest(streamId, entry, playbackMode, mediaKind);

  updateNowPlaying(entry || { title: "Link direto", url: streamId });
  activeStreamId = streamId;
  activeEntry = entry || { title: "Link direto", url: streamId };
  persistLastSelectedStream(activeStreamId, activeEntry);
  activeUsesProxy = false;
  els.stopStream.disabled = false;
  els.openVlc.disabled = false;

  if (shouldRecommendExternal) {
    prepareLiveExternalPlayback(mediaKind);
    return;
  }

  if (playbackMode === "direct") {
    els.proxyUrl.textContent = streamId;
    setStatus("Tentando reproduzir direto no navegador...", "ok");
    if (!loadPlayer(streamId, mediaKind, { isLive })) {
      await stopActiveStream();
      throw new Error("Este navegador nao suporta esse formato em modo direto.");
    }
    return;
  }

  if (playbackMode === "auto") {
    els.proxyUrl.textContent = streamId;
    setStatus("Tentando reproduzir direto no navegador...", "ok");
    const directStarted = loadPlayer(streamId, mediaKind, {
      isLive,
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

function browserPlaybackSupportedFor(mediaKind) {
  // MPEG-TS on iOS is supported through the backend HLS remux path.
  return true;
}

function prepareLiveExternalPlayback(mediaKind = "") {
  destroyPlayer();
  els.proxyUrl.textContent = "";
  const playerLabel = EXTERNAL_PLAYER_LABELS[currentExternalPlayer()] || "player externo";
  const allowBrowser = browserPlaybackSupportedFor(mediaKind);
  const message = getClientPlatform() === "desktop"
    ? "Este conteudo e ao vivo. Para uma melhor experiencia e maior estabilidade, e recomendavel usar o player externo. Se preferir, voce tambem pode reproduzir no navegador."
    : allowBrowser
      ? `Este conteúdo é ao vivo. Para uma melhor experiencia e maior estabilidade, recomendamos abrir no ${playerLabel}. Se preferir, toque em "Reproduzir no navegador".`
      : `Este conteúdo é ao vivo. Para uma melhor experiencia, recomendamos abrir no ${playerLabel}.`;
  setStatus(
    allowBrowser ? "Conteúdo ao vivo selecionado: player externo recomendado." : "Conteúdo ao vivo selecionado: use player externo.",
    "ok"
  );
  showExternalPlayerModal(
    "Player externo recomendado",
    message,
    { allowBrowser }
  );
  prepareExternalLaunchFromModal();
}

async function startProxyStream(streamId, entry, token, reason = "") {
  if (token !== playbackSeq) {
    return;
  }

  destroyPlayer();
  setStatus(
    reason
      ? `Modo direto falhou (${reason}). Iniciando proxy...`
      : "Iniciando buffer no backend..."
  );
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
  persistLastSelectedStream(streamId, activeEntry || entry || { title: "Link direto", url: streamId });
  activeUsesProxy = true;
  els.stopStream.disabled = false;
  els.openVlc.disabled = false;
  els.proxyUrl.textContent = payload.local_proxy_url;
  setStatus("Buffer iniciado. Carregando player...", "ok");
  loadPlayer(payload.local_proxy_url, payload.media_kind || "hls", {
    isLive: inferLivePlayback(streamId, entry, payload.media_kind || "hls"),
    waitForInitialBuffer: true,
  });
}

function destroyPlayer() {
  stopPlaybackMonitor();
  hideBufferHealth();
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

function hideBufferHealth() {
  if (!els.bufferHealth) {
    return;
  }
  els.bufferHealth.hidden = true;
  els.bufferHealth.className = "buffer-health";
  els.bufferHealthFill.style.width = "0%";
  els.bufferHealthLabel.textContent = "Buffer carregando";
  els.bufferHealthDetails.textContent = `0s / ${LIVE_TARGET_LATENCY_SECONDS}s`;
}

function stopPlaybackMonitor() {
  if (playbackMonitorTimer) {
    clearInterval(playbackMonitorTimer);
    playbackMonitorTimer = null;
  }
  els.video.playbackRate = 1;
}

function pauseBrowserPlaybackForExternalPlayer() {
  stopPlaybackMonitor();
  els.video.pause();
  els.video.playbackRate = 1;
}

function liveBufferState() {
  const buffered = els.video.buffered;
  if (!buffered.length || Number.isNaN(els.video.currentTime)) {
    return null;
  }

  const currentTime = els.video.currentTime;
  for (let index = 0; index < buffered.length; index += 1) {
    const start = buffered.start(index);
    const end = buffered.end(index);
    if (currentTime >= start && currentTime <= end) {
      return { start, end, ahead: end - currentTime };
    }
  }

  const start = buffered.start(0);
  const end = buffered.end(buffered.length - 1);
  if (currentTime < start) {
    return { start, end, ahead: end - start, shouldSeekToStart: true };
  }
  return { start, end, ahead: 0 };
}

function updateBufferHealth(buffer, playbackRate = 1, phase = "playing") {
  if (!els.bufferHealth) {
    return;
  }
  const ahead = Math.max(0, buffer?.ahead || 0);
  const percent = Math.min(100, Math.round((ahead / LIVE_TARGET_LATENCY_SECONDS) * 100));
  const isFull = ahead >= LIVE_TARGET_LATENCY_SECONDS;
  const isLow = ahead < LIVE_LOW_BUFFER_SECONDS;
  const isPriming = phase === "priming";

  els.bufferHealth.hidden = false;
  els.bufferHealth.className = `buffer-health ${isFull ? "full" : isLow ? "low" : "filling"}`;
  els.bufferHealthFill.style.width = `${percent}%`;
  els.bufferHealthLabel.textContent = isFull
    ? "Buffer cheio"
    : isPriming
      ? "Mostrando imagem e carregando"
      : isLow
        ? "Buffer baixo"
        : "Enchendo buffer";
  els.bufferHealthDetails.textContent = `${Math.floor(ahead)}s / ${LIVE_TARGET_LATENCY_SECONDS}s · ${playbackRate.toFixed(3)}x`;
}

function showLoadingFrameFromBuffer(buffer) {
  if (!buffer || buffer.ahead < LIVE_FRAME_BUFFER_SECONDS) {
    return false;
  }

  const frameTime = Math.min(buffer.start + 0.25, Math.max(buffer.end - 0.1, buffer.start));
  if (els.video.currentTime < buffer.start || els.video.currentTime > buffer.end) {
    els.video.currentTime = frameTime;
  }

  els.video.play().then(() => {
    setTimeout(() => {
      if (!playbackMonitorTimer) {
        return;
      }
      els.video.pause();
    }, 250);
  }).catch(() => undefined);
  return true;
}

function startLivePlaybackMonitor({ waitForInitialBuffer = true } = {}) {
  stopPlaybackMonitor();
  let waitingForInitialBuffer = waitForInitialBuffer;
  let loadingFrameShown = !waitForInitialBuffer;
  if (waitingForInitialBuffer) {
    els.video.pause();
    setStatus(`Carregando buffer inicial (${LIVE_START_BUFFER_SECONDS}s)...`);
  }

  playbackMonitorTimer = setInterval(() => {
    const buffer = liveBufferState();
    if (!buffer) {
      return;
    }

    if (buffer.shouldSeekToStart) {
      els.video.currentTime = buffer.start;
    }

    if (waitingForInitialBuffer) {
      updateBufferHealth(buffer, 1, "priming");
      if (!loadingFrameShown) {
        loadingFrameShown = showLoadingFrameFromBuffer(buffer);
      }
      if (buffer.ahead < LIVE_START_BUFFER_SECONDS) {
        setStatus(
          `Carregando buffer ao vivo: ${Math.floor(buffer.ahead)}s de ${LIVE_START_BUFFER_SECONDS}s...`
        );
        return;
      }
      waitingForInitialBuffer = false;
      setStatus("Reproduzindo. O buffer de estabilidade sera acumulado em segundo plano.", "ok");
      els.video.play().catch(() => undefined);
      return;
    }

    const latency = buffer.ahead;
    if (latency > LIVE_MAX_LATENCY_SECONDS) {
      els.video.currentTime = Math.max(buffer.end - LIVE_TARGET_LATENCY_SECONDS, 0);
      els.video.playbackRate = 1;
      updateBufferHealth({ ...buffer, ahead: LIVE_TARGET_LATENCY_SECONDS }, 1);
      return;
    }

    if (els.video.paused && latency >= LIVE_START_BUFFER_SECONDS) {
      els.video.play().catch(() => undefined);
    }

    if (latency > LIVE_CATCHUP_LATENCY_SECONDS) {
      els.video.playbackRate = LIVE_CATCHUP_PLAYBACK_RATE;
      updateBufferHealth(buffer, els.video.playbackRate);
      return;
    }
    if (latency < LIVE_GROW_BUFFER_UNTIL_SECONDS) {
      els.video.playbackRate = LIVE_BUFFER_GROWTH_PLAYBACK_RATE;
      updateBufferHealth(buffer, els.video.playbackRate);
      return;
    }
    els.video.playbackRate = 1;
    updateBufferHealth(buffer, els.video.playbackRate);
  }, 1000);
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
    const shouldWaitForInitialBuffer = options.isLive !== false && options.waitForInitialBuffer !== false;
    mpegtsPlayer = mpegts.createPlayer(
      {
        type: "mpegts",
        isLive: true,
        url: streamUrl,
      },
      {
        enableStashBuffer: true,
        stashInitialSize: 2 * 1024 * 1024,
        lazyLoad: false,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: LIVE_MAX_LATENCY_SECONDS,
        liveBufferLatencyMinRemain: LIVE_TARGET_LATENCY_SECONDS,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 3,
        autoCleanupMinBackwardDuration: 1,
      }
    );
    mpegtsPlayer.attachMediaElement(els.video);
    mpegtsPlayer.load();
    startLivePlaybackMonitor({ waitForInitialBuffer: shouldWaitForInitialBuffer });
    if (window.mpegts.Events?.ERROR) {
      mpegtsPlayer.on(mpegts.Events.ERROR, (_, details) => {
        handleFatalError(details || "Erro fatal no player MPEG-TS.");
      });
    }
    if (!shouldWaitForInitialBuffer) {
      els.video.play().catch(() => undefined);
    }
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
    els.video.load();
    if (options.isLive !== false) {
      startLivePlaybackMonitor();
    } else {
      els.video.play().catch(() => undefined);
    }
    return true;
  }

  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({
      liveSyncDuration: LIVE_TARGET_LATENCY_SECONDS,
      liveMaxLatencyDuration: LIVE_MAX_LATENCY_SECONDS,
      maxLiveSyncPlaybackRate: 1.5,
      lowLatencyMode: false,
      backBufferLength: 0,
      liveBackBufferLength: 0,
      maxBufferLength: LIVE_TARGET_LATENCY_SECONDS + 15,
      maxMaxBufferLength: LIVE_MAX_LATENCY_SECONDS,
      maxBufferHole: 0.5,
    });
    hls.loadSource(streamUrl);
    hls.attachMedia(els.video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (options.isLive !== false) {
        startLivePlaybackMonitor();
      } else {
        els.video.play().catch(() => undefined);
      }
    });
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
    els.openVlc.disabled = true;
    return;
  }

  const streamId = activeStreamId;
  const selectedEntry = activeEntry;
  logUserAction("Parando stream", { url: streamId });
  activeStreamId = "";
  activeEntry = selectedEntry;
  const shouldStopProxy = activeUsesProxy;
  activeUsesProxy = false;
  els.stopStream.disabled = true;
  els.openVlc.disabled = true;
  if (els.resumeBrowserPlayback) {
    els.resumeBrowserPlayback.hidden = !streamId;
  }
  els.proxyUrl.textContent = "";
  destroyPlayer();
  if (selectedEntry) {
    updateNowPlaying(selectedEntry);
  } else {
    resetNowPlaying();
  }
  if (shouldStopProxy) {
    await postJson("/stream/stop", { stream_id: streamId }).catch(() => undefined);
  }
}

async function openActiveStreamInExternalPlayer() {
  const streamUrl = activeStreamId;
  const player = currentExternalPlayer();
  const playerLabel = EXTERNAL_PLAYER_LABELS[player] || "player externo";
  if (!streamUrl) {
    setStatus(`Selecione um stream antes de abrir no ${playerLabel}.`, "error");
    return;
  }

  try {
    pauseBrowserPlaybackForExternalPlayer();
    if (!pendingExternalLaunch) {
      setStatus(`Gerando link privado para abrir no ${playerLabel}...`);
      await prepareExternalLaunch(streamUrl, activeEntry);
    }
    launchPreparedExternalPlayer();
  } catch (error) {
    showStreamError(error);
  }
}

async function prepareExternalLaunchFromModal() {
  if (!activeStreamId) {
    return;
  }
  const playerLabel = EXTERNAL_PLAYER_LABELS[currentExternalPlayer()] || "player externo";
  setStatusModalExternalButton("Preparando link...", true);
  try {
    await prepareExternalLaunch(activeStreamId, activeEntry);
    setStatusModalExternalButton(`Abrir ${playerLabel}`, false);
    setStatus(`Link privado pronto para abrir no ${playerLabel}.`, "ok");
  } catch (error) {
    setStatusModalExternalButton("Tentar abrir player externo", false);
    setStatus(error.message, "error");
  }
}

async function prepareExternalLaunch(streamUrl, entry = null) {
  const player = currentExternalPlayer();
  const playerLabel = EXTERNAL_PLAYER_LABELS[player] || "player externo";
  const response = await postJson("/api/vlc/open", {
    stream_id: streamUrl,
    title: entry?.title || "Link direto",
  });
  if (!response.stream_url) {
    throw new Error("Nao foi possivel gerar o link do player externo.");
  }

  const launch = buildExternalPlayerLaunchTarget(response.stream_url, player, response.launch_urls || [], response.mime_type || "");
  if (launch.unsupportedMessage) {
    if (launch.fallbackUrl) {
      window.location.href = launch.fallbackUrl;
    }
    throw new Error(launch.unsupportedMessage);
  }
  const browserFallback = launch.browserFallback
    ? () => {
      hideStatusModal();
      setStatus("VLC nao abriu. Iniciando reproducao no navegador...", "ok");
      return startStream(streamUrl, entry || { title: "Link direto", url: streamUrl }, { allowLiveBrowser: true });
    }
    : null;

  pendingExternalLaunch = { launch, browserFallback, playerLabel };
  return pendingExternalLaunch;
}

function launchPreparedExternalPlayer() {
  if (!pendingExternalLaunch) {
    return false;
  }
  const { launch, browserFallback, playerLabel } = pendingExternalLaunch;
  pendingExternalLaunch = null;
  setStatus(launch.status || `Abrindo ${playerLabel}...`);
  if (launch.androidIntent) {
    launchAndroidExternalApp(launch.url, launch.fallbackUrl, launch.fallbackMessage, launch.timeoutMs);
    return true;
  }
  launchExternalApp(launch.urls || [launch.url], launch.fallbackUrl, launch.fallbackMessage, launch.timeoutMs, browserFallback);
  return true;
}

function buildExternalPlayerLaunchTarget(streamUrl, player, launchUrls = [], mimeType = "") {
  if (player === "outplayer") {
    return buildOutplayerLaunchTarget(streamUrl);
  }
  return buildVlcLaunchTarget(streamUrl, launchUrls, mimeType);
}

function buildVlcLaunchTarget(streamUrl, launchUrls = [], mimeType = "") {
  const platform = getClientPlatform();
  if (platform === "android") {
    return {
      url: buildAndroidPlayerIntent(streamUrl, VLC_ANDROID_PACKAGE, VLC_ANDROID_STORE_URL, androidVlcMimeType(streamUrl, mimeType)),
      fallbackUrl: VLC_ANDROID_STORE_URL,
      fallbackMessage: "VLC nao encontrado. Redirecionando para a Play Store...",
      status: "Tentando abrir o VLC no Android...",
      timeoutMs: 4200,
      androidIntent: true,
    };
  }
  if (platform === "ios") {
    return {
      url: `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(streamUrl)}`,
      fallbackUrl: VLC_IOS_STORE_URL,
      fallbackMessage: "VLC nao encontrado. Redirecionando para a App Store...",
      status: "Tentando abrir o VLC no iOS...",
      timeoutMs: 1800,
    };
  }
  return {
    urls: [...launchUrls, ...buildDesktopVlcUrls(streamUrl)],
    fallbackUrl: "",
    fallbackMessage: "Nao foi possivel confirmar a abertura do VLC. Iniciando reproducao no navegador...",
    status: "Tentando abrir o VLC instalado no computador...",
    timeoutMs: 6000,
    browserFallback: true,
  };
}

function buildOutplayerLaunchTarget(streamUrl) {
  const platform = getClientPlatform();
  if (platform === "ios") {
    return {
      url: `outplayer://x-callback-url/play?url=${encodeURIComponent(streamUrl)}`,
      fallbackUrl: OUTPLAYER_IOS_STORE_URL,
      fallbackMessage: "Outplayer nao encontrado. Redirecionando para a App Store...",
      status: "Tentando abrir o Outplayer no iOS...",
      timeoutMs: 1800,
    };
  }
  return {
    unsupportedMessage: "Outplayer e recomendado apenas no iPhone/iPad. Use VLC neste dispositivo.",
    fallbackUrl: platform === "android" ? "" : OUTPLAYER_SITE_URL,
  };
}

function getClientPlatform() {
  const userAgent = navigator.userAgent || "";
  if (/android/i.test(userAgent)) {
    return "android";
  }
  if (/iPad|iPhone|iPod/.test(userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
    return "ios";
  }
  return "desktop";
}

function androidVlcMimeType(streamUrl, mimeType = "") {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized === "application/vnd.apple.mpegurl" || /\.m3u8(?:[?#]|$)/i.test(streamUrl)) {
    return "application/vnd.apple.mpegurl";
  }
  return "video/*";
}

function buildAndroidPlayerIntent(streamUrl, packageName, storeUrl, mimeType = "video/*") {
  const fallbackUrl = encodeURIComponent(storeUrl);
  try {
    const url = new URL(streamUrl);
    const scheme = url.protocol.replace(":", "") || "https";
    const target = `${url.host}${url.pathname}${url.search}${url.hash}`;
    return `intent://${target}#Intent;scheme=${scheme};action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;type=${mimeType};package=${packageName};S.browser_fallback_url=${fallbackUrl};end`;
  } catch (error) {
    return `intent://${streamUrl.replace(/^https?:\/\//i, "")}#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;type=${mimeType};package=${packageName};S.browser_fallback_url=${fallbackUrl};end`;
  }
}

function buildDesktopVlcUrls(streamUrl) {
  const encodedStreamUrl = encodeURIComponent(streamUrl);
  const rawStreamUrl = streamUrl.replace(/"/g, "%22");
  return [
    `vlc://${rawStreamUrl}`,
    `vlc://${encodedStreamUrl}`,
    `vlc-x-callback://x-callback-url/stream?url=${encodedStreamUrl}`,
  ];
}

function launchExternalApp(urls, fallbackUrl, fallbackMessage, timeoutMs, onFallback = null) {
  const launchUrls = Array.isArray(urls) ? urls.filter(Boolean) : [urls].filter(Boolean);
  let appOpened = false;
  const markOpened = () => {
    appOpened = true;
  };
  const cleanup = () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("blur", markOpened);
    window.removeEventListener("pagehide", markOpened);
  };
  const handleVisibilityChange = () => {
    if (document.hidden) {
      markOpened();
    }
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("blur", markOpened);
  window.addEventListener("pagehide", markOpened);
  launchUrls.forEach((url, index) => {
    setTimeout(() => {
      if (!appOpened && !document.hidden) {
        window.location.href = url;
      }
    }, index * 900);
  });

  setTimeout(() => {
    cleanup();
    if (!appOpened && !document.hidden) {
      setStatus(fallbackMessage, "error");
      if (fallbackUrl) {
        window.location.href = fallbackUrl;
      } else if (onFallback) {
        onFallback().catch(showStreamError);
      } else {
        finishStatusModal("Nao foi possivel abrir o VLC", fallbackMessage, "error");
      }
    }
  }, timeoutMs);
}

function launchAndroidExternalApp(url, fallbackUrl, fallbackMessage, timeoutMs) {
  let appOpened = false;
  const markOpened = () => {
    appOpened = true;
  };
  const cleanup = () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("blur", markOpened);
    window.removeEventListener("pagehide", markOpened);
  };
  const handleVisibilityChange = () => {
    if (document.hidden) {
      markOpened();
    }
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("blur", markOpened);
  window.addEventListener("pagehide", markOpened);
  window.location.href = url;

  setTimeout(() => {
    cleanup();
    if (!appOpened && !document.hidden) {
      setStatus(fallbackMessage, "error");
      if (fallbackUrl) {
        window.location.href = fallbackUrl;
      }
    }
  }, timeoutMs);
}

async function loadPlaylist(payload, endpoint = "/api/playlist/parse") {
  logUserAction("Carregando playlist", { endpoint, source: payload.url ? "url" : payload.text ? "texto" : "salva" });
  setStatus("Lendo playlist...");
  showStatusModal("Carregando playlist", "Aguarde enquanto a playlist e carregada.");
  try {
    playlistPayload = payload;
    playlistEndpoint = endpoint;
    const data = await postJson(playlistEndpoint, { ...payload, ...currentPlaylistFilters({ limit: PAGE_SIZE, offset: 0 }) });
    applyPlaylistData(data);
    setStatus("Playlist carregada.", "ok");
    hideStatusModal();
  } catch (error) {
    setStatus(error.message, "error");
    finishStatusModal("Erro ao carregar playlist", error.message, "error");
    throw error;
  }
}

async function loadSavedPlaylistOnStartup() {
  if (startupPlaylistLoadPromise) {
    return startupPlaylistLoadPromise;
  }
  logUserAction("Carregando playlist salva automaticamente");
  startupPlaylistLoadPromise = (async () => {
    try {
      showHubLoading();
      playlistPayload = {};
      playlistEndpoint = "/api/playlist/preloaded";
      const data = await loadPreloadedPlaylistPage(currentPlaylistFilters({ limit: PAGE_SIZE, offset: 0 }));
      applyPlaylistData(data);
      renderInitialCollapsedView();
      setStatus("Escolha uma categoria ou pesquise um titulo.", "ok");
      hideHubLoading();
      hideStatusModal();
    } catch (error) {
      hideHubLoading();
      setStatus(error.message, "error");
      els.playlistEntries.className = "entries empty";
      els.playlistEntries.textContent = "Nao foi possivel carregar a playlist salva.";
      finishStatusModal("Erro ao carregar playlist", error.message, "error");
    } finally {
      startupPlaylistLoadPromise = null;
    }
  })();
  return startupPlaylistLoadPromise;
}

async function loadTrialCatalog() {
  if (!els.trialPanel || !els.trialSections || !isTrialUser()) {
    if (els.trialPanel) {
      els.trialPanel.hidden = true;
    }
    return null;
  }
  if (trialCatalogLoadPromise) {
    return trialCatalogLoadPromise;
  }
  els.trialPanel.hidden = false;
  els.trialSections.innerHTML = `
    <div class="inline-loader" role="status" aria-live="polite">
      <span class="inline-spinner" aria-hidden="true"></span>
      <span>Carregando conteúdos liberados...</span>
    </div>
  `;
  trialCatalogLoadPromise = (async () => {
    try {
      while (true) {
        const data = await getJson("/api/trial/catalog");
        if (data.status !== "loading") {
          renderTrialCatalog(data.sections || []);
          return data;
        }
        await delay(PLAYLIST_LOADING_POLL_MS);
      }
    } catch (error) {
      els.trialSections.className = "trial-sections empty";
      els.trialSections.textContent = error.message || "Não foi possível carregar a degustação.";
      return null;
    } finally {
      trialCatalogLoadPromise = null;
    }
  })();
  return trialCatalogLoadPromise;
}

async function loadPreloadedPlaylistPage(payload) {
  while (true) {
    const data = await postJson("/api/playlist/preloaded", payload);
    if (data.status !== "loading") {
      hideHubLoading();
      return data;
    }

    const message = data.message || "Carregando playlist salva...";
    showHubLoading();
    setHubLoadingPhase(data.phase, data.status);
    setPlaylistLoading(message);
    await delay(PLAYLIST_LOADING_POLL_MS);
  }
}

function applyPlaylistData(data) {
  playlistId = data.playlist_id || "";
  allEntries = data.entries || [];
  allSeriesGroups = data.series_groups || [];
  totalEntries = data.total || allEntries.length;
  hasMoreEntries = Boolean(data.has_more);
  populateGroups(data.groups || allEntries.map((entry) => entry.group).filter(Boolean));
  updateCategoryCounts(data.counts || {});
  renderEntries();
}

function renderTrialCatalog(sections) {
  if (!els.trialPanel || !els.trialSections) {
    return;
  }
  els.trialPanel.hidden = !isTrialUser();
  els.trialSections.className = "trial-sections";
  els.trialSections.innerHTML = "";
  const visibleSections = groupTrialCatalogSections(sections || []).filter((section) => {
    return (section.groups || []).length || (section.entries || []).length;
  });
  if (!visibleSections.length) {
    els.trialSections.className = "trial-sections empty";
    els.trialSections.textContent = "Nenhum conteúdo liberado encontrado para este teste.";
    return;
  }
  visibleSections.forEach((section) => {
    const block = document.createElement("section");
    block.className = "trial-section collapsed";
    const displayCount = (section.groups || []).length || (section.entries || []).length;
    const countLabel = (section.groups || []).length ? "canal(is)" : "item(ns)";
    const cover = section.cover_url
      ? `<img class="trial-cover" src="${escapeHtml(section.cover_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
      : `<div class="trial-cover placeholder">${escapeHtml((section.title || "?").slice(0, 1))}</div>`;
    block.innerHTML = `
      <button class="trial-section-header" type="button" aria-expanded="false">
        ${cover}
        <div>
          <span class="trial-badge">${escapeHtml(section.category || "liberado")}</span>
          <h3>${escapeHtml(section.title || "Conteúdos liberados")}</h3>
          ${section.description ? `<p>${escapeHtml(section.description)}</p>` : ""}
        </div>
        <small>${displayCount} ${countLabel}</small>
        <span class="trial-section-toggle">Mostrar</span>
      </button>
      <div class="trial-entry-list"></div>
    `;
    const header = block.querySelector(".trial-section-header");
    const list = block.querySelector(".trial-entry-list");
    if ((section.groups || []).length) {
      list.classList.add("trial-group-list");
      (section.groups || []).forEach((group) => {
        list.appendChild(createTrialGroupElement(group));
      });
    }
    if ((section.entries || []).length) {
      (section.entries || []).forEach((entry) => {
        const item = createEntryElement({ ...entry, trial_featured: true });
        item.classList.add("trial-entry");
        list.appendChild(item);
      });
    }
    header.addEventListener("click", () => {
      const collapsed = block.classList.toggle("collapsed");
      header.setAttribute("aria-expanded", String(!collapsed));
      block.querySelector(".trial-section-toggle").textContent = collapsed ? "Mostrar" : "Ocultar";
    });
    els.trialSections.appendChild(block);
  });
  bindImageFallbacks(els.trialSections);
}

function groupTrialCatalogSections(sections) {
  const buckets = [
    {
      id: "trial_tv",
      title: "TV liberada",
      description: "Canais de TV aberta e TV a cabo disponíveis neste teste.",
      category: "TV",
      entries: [],
      groups: [],
      cover_url: "",
    },
    {
      id: "trial_series",
      title: "Séries liberadas",
      description: "Primeiros episódios disponíveis neste teste.",
      category: "Séries",
      entries: [],
      groups: [],
      cover_url: "",
    },
    {
      id: "trial_movies",
      title: "Filmes liberados",
      description: "Filmes disponíveis neste teste.",
      category: "Filmes",
      entries: [],
      groups: [],
      cover_url: "",
    },
  ];
  const byCategory = {
    tv: buckets[0],
    series: buckets[1],
    movies: buckets[2],
  };
  const extras = [];
  (sections || []).forEach((section) => {
    const bucket = byCategory[section.category];
    if (!bucket) {
      extras.push(section);
      return;
    }
    if (!bucket.cover_url && section.cover_url) {
      bucket.cover_url = section.cover_url;
    }
    if ((section.groups || []).length) {
      bucket.groups.push(...section.groups);
      return;
    }
    bucket.entries.push(...(section.entries || []));
  });
  return [...buckets.filter((bucket) => bucket.groups.length || bucket.entries.length), ...extras];
}

const TRIAL_GROUP_LOGO_DOMAINS = {
  globo: "globo.com",
  sbt: "sbt.com.br",
  record: "record.r7.com",
  band: "band.uol.com.br",
  redetv: "redetv.uol.com.br",
  "rede tv": "redetv.uol.com.br",
  cultura: "tvcultura.com.br",
  gazeta: "tvgazeta.com.br",
  "tv brasil": "tvbrasil.ebc.com.br",
  "canal gov": "www.gov.br/secom/pt-br/acesso-a-informacao/comunicabr/lista-de-canais/canal-gov",
};

function trialGroupLogoUrl(group) {
  if (group.cover_url) {
    return group.cover_url;
  }
  const key = normalizeCatalogText(group.title || group.id || "");
  const domain = TRIAL_GROUP_LOGO_DOMAINS[key];
  return domain ? tvQuickLogoUrl(domain) : "";
}

function createTrialGroupElement(group) {
  const groupCard = document.createElement("article");
  groupCard.className = "trial-group-card collapsed";
  const logoUrl = trialGroupLogoUrl(group);
  const cover = logoUrl
    ? `<img class="trial-group-cover" src="${escapeHtml(logoUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : `<div class="trial-group-cover placeholder">${escapeHtml((group.title || "?").slice(0, 1))}</div>`;
  groupCard.innerHTML = `
    <button class="trial-group-header" type="button" aria-expanded="false">
      ${cover}
      <div>
        <strong>${escapeHtml(group.title || "Grupo")}</strong>
        <small>${(group.entries || []).length} opção(ões) liberada(s)</small>
      </div>
      <span class="trial-group-toggle">Mostrar</span>
    </button>
    <div class="trial-group-entries"></div>
  `;
  const header = groupCard.querySelector(".trial-group-header");
  const list = groupCard.querySelector(".trial-group-entries");
  (group.entries || []).forEach((entry) => {
    const item = createEntryElement({ ...entry, trial_featured: true });
    item.classList.add("trial-entry", "trial-group-entry");
    list.appendChild(item);
  });
  header.addEventListener("click", () => {
    const collapsed = groupCard.classList.toggle("collapsed");
    header.setAttribute("aria-expanded", String(!collapsed));
    groupCard.querySelector(".trial-group-toggle").textContent = collapsed ? "Mostrar" : "Ocultar";
  });
  return groupCard;
}

async function cacheDefaultPlaylist(sourceUrl = "") {
  logUserAction("Atualizando cache da playlist", { source: sourceUrl ? "url informada" : "playlist configurada" });
  setStatus("Baixando e cacheando playlist...");
  showHubLoading();
  hideStatusModal();
  hideDownloadProgress();
  try {
    playlistPayload = {};
    playlistEndpoint = "/api/playlist/preloaded";
    await postJson("/api/playlist/cache-default", sourceUrl ? { url: sourceUrl } : {});
    await pollPlaylistCacheJob();
    const data = await loadPreloadedPlaylistPage(currentPlaylistFilters({ limit: PAGE_SIZE, offset: 0 }));
    applyPlaylistData(data);
    setStatus("Playlist baixada e cacheada.", "ok");
    hideHubLoading();
  } catch (error) {
    hideHubLoading();
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
  showHubLoading();
  if (job.phase === "downloading") {
    showDownloadProgress(job.downloaded_bytes || 0, job.total_bytes || 0);
    return;
  }

  if (job.phase === "parsing") {
    showDownloadProgress(job.downloaded_bytes || job.total_bytes || 1, job.total_bytes || job.downloaded_bytes || 1);
    return;
  }

  if (job.phase === "indexing") {
    showDownloadProgress(job.downloaded_bytes || job.total_bytes || 1, job.total_bytes || job.downloaded_bytes || 1);
    return;
  }

  hideDownloadProgress();
}

function requestCategoryForQuery(query, group = "") {
  if (query) {
    return "all";
  }
  if (group) {
    return "all";
  }
  if (selectedCategory === "world_cup") {
    return "world_cup";
  }
  return selectedCategory;
}

function currentPlaylistFilters({ offset = 0, limit = PAGE_SIZE } = {}) {
  const query = els.entrySearch.value.trim();
  const group = query ? "" : els.groupFilter.value;
  return {
    category: requestCategoryForQuery(query, group),
    group,
    query,
    season: query ? "" : (selectedSeriesKey ? selectedSeriesSeason : ""),
    offset,
    limit,
  };
}

function resetSelectedSeries() {
  selectedSeriesKey = "";
  selectedSeriesTitle = "";
  selectedSeriesLogo = "";
  selectedSeriesLogoCandidates = [];
  selectedSeriesGroupName = "";
  selectedSeriesSeasons = [];
  selectedSeriesSeason = "";
}

function resetMovieCollection() {
  selectedMovieCollectionOpen = false;
  selectedMovieCollectionTitle = "";
}

function seasonLabel(season) {
  return Number(season) > 0 ? `Temporada ${Number(season)}` : "Sem temporada";
}

function compactSeasonLabel(season) {
  return Number(season) > 0 ? `T${String(season).padStart(2, "0")}` : "Sem temporada";
}

function episodeLabel(entry) {
  const episode = Number(entry.episode_number || 0);
  return episode > 0 ? `E${String(episode).padStart(2, "0")}` : "Episodio";
}

function normalizeSeriesNumber(value) {
  const match = String(value || "0").match(/\d+/);
  return match ? String(Number(match[0])) : "0";
}

function isEntryInSelectedSeason(entry) {
  if (!selectedSeriesSeason) {
    return true;
  }
  return normalizeSeriesNumber(entry.season_number || "0") === normalizeSeriesNumber(selectedSeriesSeason);
}

async function fetchPlaylistPage({ reset = true } = {}) {
  if (!playlistId && !playlistPayload) {
    return;
  }

  const requestSeq = ++playlistRequestSeq;
  const filters = currentPlaylistFilters();
  if (playlistFetchController) {
    playlistFetchController.abort();
  }
  playlistFetchController = new AbortController();
  logUserAction("Filtrando playlist", {
    query: filters.query,
    category: filters.category,
    selected_category: selectedCategory,
    group: filters.group,
    selected_group: els.groupFilter.value,
    reset,
  });
  if (reset) {
    setPlaylistLoading(filters.query ? `Buscando "${filters.query}"...` : "Atualizando resultados...");
  } else {
    els.loadMore.disabled = true;
    els.loadMore.textContent = "Carregando...";
  }
  const offset = reset ? 0 : (filters.category === "series" && !selectedSeriesKey ? allSeriesGroups.length : allEntries.length);
  try {
    const data = await postJson(
      playlistEndpoint,
      {
        ...(reset && playlistPayload && playlistEndpoint !== "/api/playlist/preloaded" ? playlistPayload : {}),
        playlist_id: playlistId,
        ...filters,
        series_key: filters.query ? "" : selectedSeriesKey,
        offset,
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
    allSeriesGroups = reset ? data.series_groups || [] : allSeriesGroups.concat(data.series_groups || []);
    if (data.groups) {
      populateGroups(data.groups);
    }
    updateCategoryCounts(data.counts || {});
    renderEntries();
    setStatus(filters.query ? `${totalEntries} resultado(s) para "${filters.query}".` : `${totalEntries} item(ns) em ${categoryLabel(selectedCategory)}.`, "ok");
    if (reset && (filters.query || filters.group || selectedCategory === "series" || selectedMovieCollectionOpen)) {
      scrollResultsIntoView();
    }
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
    const label = {
      all: "Busca geral",
      world_cup: "Copa do Mundo 2026",
      daily_games: "Esportes",
      tv: "TV",
      reality: "Reality",
      movies: "Filmes",
      series: "Series",
    }[category];
    if (category === "world_cup") {
      button.innerHTML = '<img class="world-cup-logo" src="world-cup-2026.jpg?v=2" alt="" aria-hidden="true" />Copa do Mundo 2026';
      bindWorldCupLogoFallback();
      return;
    }
    button.textContent = label;
  });
}

function tvQuickLogoUrl(domain) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

function replaceBrokenQuickLogo(image) {
  const button = image.closest(".tv-quick-link");
  const label = button?.dataset.channel || button?.textContent || "?";
  const fallback = document.createElement("span");
  fallback.className = "tv-quick-logo-fallback";
  fallback.textContent = label.trim().slice(0, 1).toUpperCase() || "?";
  image.replaceWith(fallback);
}

function bindWorldCupLogoFallback() {
  document.querySelectorAll(".world-cup-logo").forEach((image) => {
    image.addEventListener("error", () => {
      image.src = "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRHDmb9QnUeJjUSZu7Ox46bBxsqMaxqlQfp6g&s";
    }, { once: true });
  });
}

function quickLinkSearchValue(channel) {
  return Object.prototype.hasOwnProperty.call(channel, "search") ? channel.search : channel.name;
}

function dailyGameShortcutLabel(entry) {
  return (entry.title || entry.group || "Jogo").replace(/\s+/g, " ").trim();
}

function isFootballGameShortcut(entry) {
  const text = dailyGameShortcutLabel(entry);
  const hasTime = /\b(?:[01]?\d|2[0-3])[:h][0-5]\d\b/.test(text);
  const hasTeams = /\s(?:x|vs\.?|versus)\s/i.test(text);
  return hasTime && hasTeams;
}

const NATIONAL_TEAM_HINTS = [
  "alemanha", "africa do sul", "arabia saudita", "argelia", "argentina", "australia", "austria",
  "armenia", "azerbaijao", "belarus", "belgica", "bolivia", "bosnia", "bosnia e herzegovina", "brasil", "burkina faso", "cabo verde", "canada", "catar",
  "colombia", "coreia", "coreia do sul", "costa do marfim", "croacia", "curacao", "egito",
  "equador", "escocia", "espanha", "estados unidos", "eua", "franca", "gana", "haiti",
  "holanda", "hungria", "indonesia", "inglaterra", "ira", "iraque", "japao", "jordania",
  "cazaquistao", "kazakhstan", "marrocos", "mexico", "mocambique", "moldavia", "moldova",
  "noruega", "nova zelandia", "paises baixos", "panama", "paraguai", "portugal", "qatar",
  "rd congo", "republica democratica do congo", "republica tcheca", "san marino", "senegal",
  "suica", "suecia", "tchequia", "tunisia", "turquia", "uruguai", "uzbequistao",
];

const CLUB_COMPETITION_HINTS = [
  "brasileirao", "serie a", "serie b", "libertadores", "sul americana", "champions", "premier league", "la liga",
  "bundesliga", "calcio", "mls", "nba", "ufc", "combate", "tenis", "volei", "clubes", "sub 20",
];

function isNationalTeamGame(entry) {
  const text = normalizeCatalogText(`${entry.title || ""} ${entry.group || ""}`);
  if (!isFootballGameShortcut(entry)) {
    return false;
  }
  if (CLUB_COMPETITION_HINTS.some((hint) => text.includes(hint))) {
    return false;
  }
  const hasNationalTeam = NATIONAL_TEAM_HINTS.some((team) => text.includes(team));
  const hasInternationalContext = /amistoso|selecao|selecoes|copa do mundo|eliminatoria|nations league|euro|africana|concacaf|conmebol/.test(text);
  return hasNationalTeam || hasInternationalContext;
}

function isEntryPlayable(entry) {
  return Boolean(entry?.url && !entry.locked);
}

function showLockedContentMessage(entry) {
  const lockedMessage = entry?.locked_reason || "Adquira um pacote para acessar este conteúdo";
  setStatus(lockedMessage, "error");
  showStatusModal("Conteudo bloqueado", lockedMessage, "error");
}

function openDailyGameShortcut(entry) {
  selectedCategory = "daily_games";
  resetSelectedSeries();
  resetMovieCollection();
  dailyGamesCatalogRequested = true;
  worldCupCatalogRequested = false;
  categoryInteracted = true;
  els.entrySearch.value = "";
  els.groupFilter.value = "";
  els.categoryFilters.forEach((filter) => filter.classList.toggle("active", filter.dataset.category === "daily_games"));
  updateQuickLinksVisibility();
  if (!isEntryPlayable(entry)) {
    showLockedContentMessage(entry);
    return;
  }
  setStatus(`Abrindo jogo: ${dailyGameShortcutLabel(entry)}.`, "ok");
  scrollPlayerIntoView();
  startStream(entry.url, entry).catch(showStreamError);
}

function openWorldCupShortcut(entry) {
  selectedCategory = "world_cup";
  resetSelectedSeries();
  resetMovieCollection();
  worldCupCatalogRequested = true;
  categoryInteracted = true;
  els.entrySearch.value = "";
  els.groupFilter.value = "";
  els.categoryFilters.forEach((filter) => filter.classList.toggle("active", filter.dataset.category === "world_cup"));
  updateQuickLinksVisibility();
  if (!isEntryPlayable(entry)) {
    showLockedContentMessage(entry);
    return;
  }
  setStatus(`Abrindo jogo de seleção: ${dailyGameShortcutLabel(entry)}.`, "ok");
  scrollPlayerIntoView();
  startStream(entry.url, entry).catch(showStreamError);
}

function realityShortcutLabel(entry) {
  return (entry.title || entry.group || "Casa do Patrão").replace(/\s+/g, " ").trim();
}

function openRealityShortcut(entry) {
  selectedCategory = "reality";
  resetSelectedSeries();
  resetMovieCollection();
  categoryInteracted = true;
  els.entrySearch.value = "";
  els.groupFilter.value = "";
  els.categoryFilters.forEach((filter) => filter.classList.toggle("active", filter.dataset.category === "reality"));
  updateQuickLinksVisibility();
  if (!isEntryPlayable(entry)) {
    showLockedContentMessage(entry);
    return;
  }
  setStatus(`Abrindo Reality: ${realityShortcutLabel(entry)}.`, "ok");
  scrollPlayerIntoView();
  startStream(entry.url, entry).catch(showStreamError);
}

async function loadDailyGameShortcuts() {
  if (!playlistId && !playlistPayload) {
    return;
  }
  try {
    const data = await postJson(playlistEndpoint, {
      ...(playlistPayload && playlistEndpoint !== "/api/playlist/preloaded" ? playlistPayload : {}),
      playlist_id: playlistId,
      category: "daily_games",
      group: "",
      query: "",
      offset: 0,
      limit: 120,
    });
    const seen = new Set();
    const footballEntries = (data.entries || [])
      .filter(isFootballGameShortcut)
      .filter((entry) => {
        const key = dailyGameShortcutLabel(entry).toLocaleLowerCase("pt-BR");
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
    dailyGameShortcutEntries = footballEntries;
    worldCupShortcutEntries = footballEntries.filter(isNationalTeamGame);
    renderDailyGameQuickLinks();
    renderWorldCupQuickLinks();
  } catch (error) {
    console.warn("[Stream M3U8] Nao foi possivel carregar atalhos de futebol", error);
  }
}

async function loadRealityShortcuts() {
  if (!playlistId && !playlistPayload) {
    return;
  }
  try {
    const data = await postJson(playlistEndpoint, {
      ...(playlistPayload && playlistEndpoint !== "/api/playlist/preloaded" ? playlistPayload : {}),
      playlist_id: playlistId,
      category: "reality",
      group: "",
      query: "",
      offset: 0,
      limit: 120,
    });
    const seen = new Set();
    realityShortcutEntries = (data.entries || []).filter((entry) => {
      const key = realityShortcutLabel(entry).toLocaleLowerCase("pt-BR");
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    renderRealityQuickLinks();
  } catch (error) {
    console.warn("[Stream M3U8] Nao foi possivel carregar atalhos de reality", error);
  }
}

function renderTvQuickLinks() {
  if (!els.tvQuickLinks) {
    return;
  }
  els.tvQuickLinks.innerHTML = TV_QUICK_LINK_GROUPS.map((group) => `
    <section class="tv-quick-column">
      <span class="tv-quick-title">${escapeHtml(group.title)}</span>
      <div class="tv-quick-list">
        ${group.channels.map((channel) => `
          <button class="tv-quick-link" type="button" data-channel="${escapeHtml(channel.name)}" data-search="${escapeHtml(quickLinkSearchValue(channel))}">
            <img src="${tvQuickLogoUrl(channel.domain)}" alt="" loading="lazy" />
            <span>${escapeHtml(channel.name)}</span>
          </button>
        `).join("")}
      </div>
    </section>
  `).join("");
  updateQuickLinksVisibility();
}

function renderDailyGameQuickLinks() {
  if (!els.dailyGameQuickLinks) {
    return;
  }
  const groups = DAILY_GAME_QUICK_LINK_GROUPS.map((group) => {
    if (group.title !== "Futebol") {
      return group;
    }
    return {
      ...group,
      channels: dailyGameShortcutEntries.map((entry, index) => ({
        name: dailyGameShortcutLabel(entry),
        domain: "fifa.com",
        gameIndex: index,
      })),
    };
  });
  els.dailyGameQuickLinks.innerHTML = groups.map((group) => `
    <section class="tv-quick-column">
      <span class="tv-quick-title">${escapeHtml(group.title)}</span>
      <div class="tv-quick-list">
        ${group.channels.length ? group.channels.map((channel) => `
          <button class="tv-quick-link" type="button" data-channel="${escapeHtml(channel.name)}" data-search="${escapeHtml(quickLinkSearchValue(channel))}" ${Number.isInteger(channel.gameIndex) ? `data-game-index="${channel.gameIndex}"` : ""}>
            <img src="${tvQuickLogoUrl(channel.domain)}" alt="" loading="lazy" />
            <span>${escapeHtml(channel.name)}</span>
          </button>
        `).join("") : '<span class="tv-quick-empty">Nenhum jogo com horario encontrado.</span>'}
      </div>
    </section>
  `).join("");
  updateQuickLinksVisibility();
}

function renderRealityQuickLinks() {
  if (!els.realityQuickLinks) {
    return;
  }
  els.realityQuickLinks.innerHTML = `
    <section class="tv-quick-column">
      <span class="tv-quick-title">Casa do Patrão</span>
      <div class="tv-quick-list">
        ${realityShortcutEntries.length ? realityShortcutEntries.map((entry, index) => `
          <button class="tv-quick-link" type="button" data-channel="${escapeHtml(realityShortcutLabel(entry))}" data-reality-index="${index}">
            <span>${escapeHtml(realityShortcutLabel(entry))}</span>
          </button>
        `).join("") : '<span class="tv-quick-empty">Nenhum link da Casa do Patrão encontrado.</span>'}
      </div>
    </section>
  `;
  updateQuickLinksVisibility();
}

function renderSeriesStreamerLinks() {
  if (!els.seriesStreamerLinks) {
    return;
  }
  els.seriesStreamerLinks.innerHTML = `
    <section class="tv-quick-column">
      <span class="tv-quick-title">Filtrar séries por streamer</span>
      <div class="tv-quick-list">
        ${SERIES_STREAMER_LINKS.map((streamer) => `
          <button class="tv-quick-link streamer-quick-link" type="button" data-channel="${escapeHtml(streamer.name)}" data-search="${escapeHtml(streamer.search)}">
            <img src="${tvQuickLogoUrl(streamer.domain)}" alt="" loading="lazy" />
            <span>${escapeHtml(streamer.name)}</span>
          </button>
        `).join("")}
      </div>
    </section>
  `;
  updateQuickLinksVisibility();
}

function renderWorldCupQuickLinks() {
  if (!els.worldCupQuickLinks) {
    return;
  }
  els.worldCupQuickLinks.innerHTML = `
    <section class="tv-quick-column">
      <span class="tv-quick-title">Copa do Mundo 2026 - seleções</span>
      <div class="tv-quick-list">
        ${worldCupShortcutEntries.length ? worldCupShortcutEntries.map((entry, index) => `
          <button class="tv-quick-link world-cup-game-link" type="button" data-channel="${escapeHtml(dailyGameShortcutLabel(entry))}" data-world-cup-index="${index}">
            <span>${escapeHtml(dailyGameShortcutLabel(entry))}</span>
          </button>
        `).join("") : '<span class="tv-quick-empty">Nenhum amistoso ou jogo de seleção encontrado hoje.</span>'}
      </div>
    </section>
  `;
  updateQuickLinksVisibility();
}

function updateQuickLinksVisibility() {
  if (!els.tvQuickLinks) {
    return;
  }
  els.tvQuickLinks.hidden = selectedCategory !== "tv";
  if (els.worldCupQuickLinks) {
    els.worldCupQuickLinks.hidden = selectedCategory !== "world_cup";
  }
  if (els.realityQuickLinks) {
    els.realityQuickLinks.hidden = selectedCategory !== "reality";
  }
  if (els.dailyGameQuickLinks) {
    els.dailyGameQuickLinks.hidden = selectedCategory !== "daily_games";
  }
  if (els.seriesStreamerLinks) {
    els.seriesStreamerLinks.hidden = selectedCategory !== "series" || Boolean(selectedSeriesKey);
  }
}

function isTvAwaitingSearch() {
  return selectedCategory === "tv" && !els.entrySearch.value.trim();
}

function isDailyGamesAwaitingSearch() {
  return selectedCategory === "daily_games" && !els.entrySearch.value.trim() && !dailyGamesCatalogRequested;
}

function isRealityAwaitingSelection() {
  return selectedCategory === "reality" && !els.entrySearch.value.trim();
}

function isWorldCupAwaitingSelection() {
  return selectedCategory === "world_cup" && !els.entrySearch.value.trim() && !worldCupCatalogRequested;
}

function renderEntries() {
  updateQuickLinksVisibility();
  if (!shouldShowPlaylistResults()) {
    renderInitialCollapsedView();
    return;
  }

  if (!selectedSeriesKey && allSeriesGroups.length && (selectedCategory === "series" || !allEntries.length)) {
    renderSeriesGroups();
    return;
  }
  if (selectedCategory === "series" && selectedSeriesKey) {
    renderSeriesEpisodes();
    return;
  }
  if (selectedMovieCollectionOpen) {
    renderMovieCollectionEntries();
    return;
  }
  if (shouldRenderMovieCollection()) {
    renderMovieCollectionGroup();
    return;
  }

  const entries = allEntries;

  els.entryCount.textContent = selectedSeriesKey
    ? `${entries.length} de ${totalEntries} episodio(s) de ${selectedSeriesTitle}`
    : `${entries.length} de ${totalEntries} ${totalEntries === 1 ? "item" : "itens"}`;
  els.loadMore.hidden = !hasMoreEntries;

  if (!entries.length) {
    els.playlistEntries.className = "entries empty";
    els.playlistEntries.innerHTML = "";
    const emptyFragment = document.createDocumentFragment();
    renderSeriesBackButton(emptyFragment);
    emptyFragment.append("Nenhum stream encontrado nessa playlist.");
    els.playlistEntries.appendChild(emptyFragment);
    return;
  }

  els.playlistEntries.className = "entries";
  els.playlistEntries.innerHTML = "";
  const fragment = document.createDocumentFragment();
  renderSeriesBackButton(fragment);
  entries.forEach((entry) => {
    fragment.appendChild(createEntryElement(entry));
  });
  els.playlistEntries.appendChild(fragment);
}

function shouldShowPlaylistResults() {
  if (isTvAwaitingSearch() || isDailyGamesAwaitingSearch() || isWorldCupAwaitingSelection()) {
    return false;
  }
  return Boolean(els.entrySearch.value.trim() || selectedSeriesKey);
}

function renderSearchPrompt() {
  els.entryCount.textContent = "Pesquise um titulo";
  els.loadMore.hidden = true;
  els.playlistEntries.className = "entries empty";
  els.playlistEntries.textContent = "Digite pelo menos 2 caracteres no campo de busca para exibir conteudos.";
}

function renderInitialCollapsedView() {
  renderSearchPrompt();
}

function seriesGroupFromEntry(entry) {
  const existing = allSeriesGroups.find((series) => series.series_key && series.series_key === entry.series_key);
  if (existing) {
    return existing;
  }
  return {
    series_key: entry.series_key,
    title: entry.series_title || entry.title || "Serie",
    logo: entry.logo || "",
    group: entry.group || "",
    seasons: entry.season_number ? [{ season: entry.season_number, episode_count: 1 }] : [],
  };
}

async function resolveCompleteSeriesGroup(series) {
  if (!series?.series_key || (series.seasons || []).length > 1) {
    return series;
  }
  const query = series.title || "";
  if (!query) {
    return series;
  }
  try {
    const data = await postJson(playlistEndpoint, {
      ...(playlistPayload && playlistEndpoint !== "/api/playlist/preloaded" ? playlistPayload : {}),
      playlist_id: playlistId,
      category: "series",
      group: "",
      query,
      offset: 0,
      limit: DETAIL_PAGE_SIZE,
    });
    const complete = (data.series_groups || []).find((candidate) => candidate.series_key === series.series_key);
    return complete || series;
  } catch (error) {
    console.warn("[Stream M3U8] Nao foi possivel carregar temporadas completas", error);
    return series;
  }
}

function createEntryElement(entry) {
  const item = document.createElement("div");
  item.className = `entry ${entry.locked ? "locked-entry" : ""}`.trim();
  item.setAttribute("role", "button");
  item.tabIndex = 0;
  const logo = entry.logo
    ? `<img class="entry-logo" src="${escapeHtml(entry.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : `<div class="entry-logo placeholder">${escapeHtml((entry.title || "?").slice(0, 1))}</div>`;
  const urlLine = entry.locked
    ? `<small class="locked-copy">Adquira um pacote para acessar este conteúdo</small>`
    : `<small>${escapeHtml(entry.url)}</small>`;
  item.innerHTML = `
    ${logo}
    <span class="entry-body">
      <strong>${escapeHtml(entry.title || entry.url)}</strong>
      <small>${escapeHtml(formatEntryMeta(entry))}</small>
      ${urlLine}
    </span>
    ${entry.locked ? '<span class="lock-pill" aria-label="Bloqueado">Bloqueado</span>' : ""}
    <button class="favorite-toggle ${isFavorite(entryFavorite(entry)) ? "active" : ""}" type="button" aria-label="Favoritar ${escapeHtml(entry.title || entry.url)}">${isFavorite(entryFavorite(entry)) ? "★" : "☆"}</button>
  `;
  const playEntry = () => {
    if (entry.category === "series" && entry.series_key && !selectedSeriesKey) {
      openSeriesGroup(seriesGroupFromEntry(entry), { scroll: true }).catch((error) => setStatus(error.message, "error"));
      return;
    }
    if (entry.locked || !entry.url) {
      showLockedContentMessage(entry);
      return;
    }
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
    toggleEntryFavorite(entry);
  });
  return item;
}

function movieEntriesForCollection() {
  return allEntries.filter((entry) => entry.category === "movies");
}

function shouldRenderMovieCollection() {
  const query = els.entrySearch.value.trim();
  const movieEntries = movieEntriesForCollection();
  return Boolean(
    query
      && !selectedMovieCollectionOpen
      && movieEntries.length > 1
      && (selectedCategory === "movies" || movieEntries.length === allEntries.length)
  );
}

function movieCollectionTitle() {
  const query = els.entrySearch.value.trim();
  if (!query) {
    return "Colecao de filmes";
  }
  return query
    .split(/\s+/)
    .map((piece) => piece ? piece[0].toLocaleUpperCase("pt-BR") + piece.slice(1) : "")
    .join(" ");
}

function renderMovieCollectionGroup() {
  const movies = movieEntriesForCollection();
  const title = movieCollectionTitle();
  const poster = coalesceCover(movies, title);
  const posterCandidates = coverCandidates(movies, poster, title);
  const favorite = movieCollectionFavorite(title, movies);
  els.entryCount.textContent = `1 colecao encontrada`;
  els.loadMore.hidden = !hasMoreEntries;
  els.playlistEntries.className = "entries series-gallery";
  els.playlistEntries.innerHTML = "";
  const item = document.createElement("div");
  item.className = "series-title-card movie-collection-card";
  item.setAttribute("role", "button");
  item.tabIndex = 0;
  item.innerHTML = `
    <div class="series-poster-wrap">
      ${imageWithFallback({
        className: "series-poster",
        src: poster,
        candidates: posterCandidates,
        placeholder: `<div class="series-poster placeholder">${escapeHtml(title.slice(0, 1))}</div>`,
        alt: title,
      })}
    </div>
    <div class="series-card-copy">
      <strong>${escapeHtml(title)}</strong>
      <small>Colecao de filmes</small>
      <small>${movies.length} titulo(s) encontrado(s)</small>
    </div>
    <button class="favorite-toggle card-favorite-toggle ${isFavorite(favorite) ? "active" : ""}" type="button" aria-label="Favoritar saga ${escapeHtml(title)}">${isFavorite(favorite) ? "★" : "☆"}</button>
  `;
  const openCollection = () => {
    selectedMovieCollectionOpen = true;
    selectedMovieCollectionTitle = title;
    renderEntries();
    scrollResultsIntoView();
  };
  item.addEventListener("click", openCollection);
  item.addEventListener("keydown", (event) => {
    if (event.target.closest(".favorite-toggle")) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openCollection();
    }
  });
  item.querySelector(".favorite-toggle").addEventListener("click", (event) => {
    event.stopPropagation();
    toggleFavorite(favorite);
  });
  bindImageFallbacks(item);
  els.playlistEntries.appendChild(item);
}

function renderMovieCollectionEntries() {
  const movies = movieEntriesForCollection();
  els.entryCount.textContent = `${movies.length} ${movies.length === 1 ? "filme" : "filmes"} em ${selectedMovieCollectionTitle}`;
  els.loadMore.hidden = !hasMoreEntries;
  els.playlistEntries.className = "entries";
  els.playlistEntries.innerHTML = "";
  const fragment = document.createDocumentFragment();
  const button = document.createElement("button");
  button.className = "ghost small-button series-back";
  button.type = "button";
  button.textContent = `Voltar para ${selectedMovieCollectionTitle}`;
  button.addEventListener("click", () => {
    resetMovieCollection();
    renderEntries();
  });
  fragment.appendChild(button);
  movies.forEach((entry) => {
    fragment.appendChild(createEntryElement(entry));
  });
  els.playlistEntries.appendChild(fragment);
}

function renderSeriesGroups() {
  const groups = allSeriesGroups;
  els.entryCount.textContent = `${groups.length} de ${totalEntries} ${totalEntries === 1 ? "titulo" : "titulos"}`;
  els.loadMore.hidden = !hasMoreEntries;

  if (!groups.length) {
    els.playlistEntries.className = "entries empty";
    els.playlistEntries.textContent = "Nenhuma serie encontrada nessa playlist.";
    return;
  }

  els.playlistEntries.className = "entries series-gallery";
  els.playlistEntries.innerHTML = "";
  const fragment = document.createDocumentFragment();
  groups.forEach((series) => {
    const item = document.createElement("div");
    item.className = "series-title-card";
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    const displayTitle = series.popular_title || series.title || "Serie";
    const displaySeries = { ...series, title: displayTitle };
    const favorite = seriesFavorite(displaySeries);
    const logo = imageWithFallback({
      className: "series-poster",
      src: series.logo,
      candidates: series.logo_candidates || [],
      placeholder: `<div class="series-poster placeholder">${escapeHtml(displayTitle.slice(0, 1))}</div>`,
    });
    const seasons = (series.seasons || [])
      .map((season) => {
        return `<span class="series-season-pill">${escapeHtml(compactSeasonLabel(season.season))} - ${season.episode_count} ep.</span>`;
      })
      .join("");
    item.innerHTML = `
      <div class="series-poster-wrap">${logo}</div>
      <div class="series-card-copy">
        <strong>${escapeHtml(displayTitle)}</strong>
        <small>${escapeHtml(series.group || "Sem grupo")}</small>
        <small>${series.total_episodes || 0} episodio(s)</small>
        <span class="series-season-list">${seasons}</span>
      </div>
      <button class="favorite-toggle card-favorite-toggle ${isFavorite(favorite) ? "active" : ""}" type="button" aria-label="Favoritar serie ${escapeHtml(displayTitle)}">${isFavorite(favorite) ? "★" : "☆"}</button>
    `;
    const openSeries = () => openSeriesGroup(displaySeries);
    item.addEventListener("click", openSeries);
    item.addEventListener("keydown", (event) => {
      if (event.target.closest(".favorite-toggle")) {
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openSeries();
      }
    });
    item.querySelector(".favorite-toggle").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleFavorite(favorite);
    });
    bindImageFallbacks(item);
    fragment.appendChild(item);
  });
  els.playlistEntries.appendChild(fragment);
}

async function openSeriesGroup(series, options = {}) {
  series = await resolveCompleteSeriesGroup(series);
  selectedCategory = "series";
  els.categoryFilters.forEach((filter) => filter.classList.toggle("active", filter.dataset.category === "series"));
  updateQuickLinksVisibility();
  els.entrySearch.value = "";
  els.groupFilter.value = "";
  selectedSeriesKey = series.series_key;
  selectedSeriesTitle = series.title || "Serie";
  selectedSeriesLogo = series.logo || "";
  selectedSeriesLogoCandidates = series.logo_candidates || [];
  selectedSeriesGroupName = series.group || "";
  selectedSeriesSeasons = (series.seasons || []).slice().sort((a, b) => Number(a.season || 0) - Number(b.season || 0));
  selectedSeriesSeason = selectedSeriesSeasons[0]?.season || "";
  setPlaylistLoading(`Carregando episodios de ${selectedSeriesTitle}...`);
  await loadSelectedSeriesSeason();
  if (options.scroll !== false) {
    scrollResultsIntoView();
  }
}

async function loadSelectedSeriesSeason({ reset = true } = {}) {
  if (!selectedSeriesKey) {
    return;
  }
  const requestSeq = ++playlistRequestSeq;
  if (playlistFetchController) {
    playlistFetchController.abort();
  }
  playlistFetchController = new AbortController();
  const offset = reset ? 0 : allEntries.length;
  try {
    const data = await postJson(
      playlistEndpoint,
      {
        ...(reset && playlistPayload && playlistEndpoint !== "/api/playlist/preloaded" ? playlistPayload : {}),
        playlist_id: playlistId,
        category: "series",
        group: "",
        query: "",
        season: selectedSeriesSeason,
        series_key: selectedSeriesKey,
        offset,
        limit: DETAIL_PAGE_SIZE,
      },
      { signal: playlistFetchController.signal }
    );
    if (requestSeq !== playlistRequestSeq) {
      return;
    }
    playlistId = data.playlist_id || playlistId;
    allEntries = reset ? data.entries || [] : allEntries.concat(data.entries || []);
    const visibleEntries = allEntries.filter(isEntryInSelectedSeason);
    totalEntries = visibleEntries.length || data.total || 0;
    hasMoreEntries = Boolean(data.has_more) && visibleEntries.length === allEntries.length;
    updateCategoryCounts(data.counts || {});
    renderEntries();
    setStatus(`${totalEntries} episodio(s) em ${seasonLabel(selectedSeriesSeason)}.`, "ok");
  } catch (error) {
    if (error.name !== "AbortError") {
      throw error;
    }
  } finally {
    if (requestSeq === playlistRequestSeq) {
      playlistFetchController = null;
      els.loadMore.disabled = false;
      els.loadMore.textContent = "Carregar mais";
    }
  }
}

function renderSeriesEpisodes() {
  const entries = allEntries.filter(isEntryInSelectedSeason);
  const favorite = selectedSeriesFavorite();
  const activeSeason = selectedSeriesSeason || entries[0]?.season_number || "";
  const poster = imageWithFallback({
    className: "series-detail-thumb",
    src: selectedSeriesLogo,
    candidates: selectedSeriesLogoCandidates,
    placeholder: `<div class="series-detail-thumb placeholder">${escapeHtml((selectedSeriesTitle || "?").slice(0, 1))}</div>`,
    alt: selectedSeriesTitle || "Serie",
  });
  const seasonButtons = selectedSeriesSeasons
    .map((season) => `
      <button class="season-tab ${String(season.season) === String(activeSeason) ? "active" : ""}" type="button" data-season="${escapeHtml(season.season)}">
        ${escapeHtml(seasonLabel(season.season))}
        <span>${season.episode_count} ep.</span>
      </button>
    `)
    .join("");

  els.entryCount.textContent = `${entries.length} episodio(s) em ${seasonLabel(selectedSeriesSeason)}`;
  els.loadMore.hidden = !hasMoreEntries;
  els.playlistEntries.className = "entries series-detail-view";
  els.playlistEntries.innerHTML = `
    <section class="series-detail-compact">
      <div class="series-detail-toolbar">
        <button class="ghost small-button series-back" type="button">Voltar</button>
        <div class="series-detail-cover-actions">
          ${poster}
          <button class="favorite-toggle series-detail-favorite ${isFavorite(favorite) ? "active" : ""}" type="button" aria-label="Favoritar serie ${escapeHtml(selectedSeriesTitle || "Serie")}">${isFavorite(favorite) ? "★" : "☆"}</button>
        </div>
        <div class="series-detail-title">
          <strong>${escapeHtml(selectedSeriesTitle || "Serie")}</strong>
          <small>${escapeHtml(selectedSeriesGroupName || "Catalogo de series")} - ${selectedSeriesSeasons.length || 1} temporada(s)</small>
        </div>
      </div>
      <div class="season-tabs" aria-label="Temporadas">${seasonButtons}</div>
    </section>
    <section class="episode-list"></section>
  `;

  els.playlistEntries.querySelector(".series-back").addEventListener("click", () => {
    resetSelectedSeries();
    fetchPlaylistPage({ reset: true }).catch((error) => setStatus(error.message, "error"));
  });
  els.playlistEntries.querySelector(".series-detail-favorite").addEventListener("click", () => {
    toggleFavorite(favorite);
  });
  bindImageFallbacks(els.playlistEntries);
  els.playlistEntries.querySelectorAll(".season-tab").forEach((button) => {
    button.addEventListener("click", () => {
      selectedSeriesSeason = button.dataset.season || "";
      setPlaylistLoading(`Carregando ${seasonLabel(selectedSeriesSeason)}...`);
      loadSelectedSeriesSeason().catch((error) => setStatus(error.message, "error"));
    });
  });

  const episodeList = els.playlistEntries.querySelector(".episode-list");
  if (!entries.length) {
    episodeList.className = "episode-list empty";
    episodeList.textContent = "Nenhum episodio encontrado nessa temporada.";
    return;
  }
  episodeList.className = "episode-list compact";
  groupedSeriesEpisodes(entries).forEach((episode) => {
    episodeList.appendChild(createSeriesEpisodeButton(episode));
  });
}

function groupedSeriesEpisodes(entries) {
  const groups = new Map();
  entries.forEach((entry, index) => {
    const season = normalizeSeriesNumber(entry.season_number || selectedSeriesSeason || "0");
    const episode = normalizeSeriesNumber(entry.episode_number || String(index + 1));
    const key = `${season}:${episode}`;
    if (!groups.has(key)) {
      groups.set(key, {
        season,
        episode,
        title: entry.episode_title || entry.title || entry.url,
        variants: [],
      });
    }
    groups.get(key).variants.push(entry);
  });
  return Array.from(groups.values()).sort((a, b) => Number(a.episode) - Number(b.episode));
}

function seriesVariantLabel(entry, index) {
  const pieces = [];
  const text = `${entry.title || ""} ${entry.group || ""}`.toLowerCase();
  if (/dub|dublado|dual/.test(text)) {
    pieces.push("Dublado");
  }
  if (/leg|legendado/.test(text)) {
    pieces.push("Legendado");
  }
  if (entry.group) {
    pieces.push(entry.group);
  }
  if (entry.resolution) {
    pieces.push(entry.resolution);
  }
  return pieces.filter(Boolean).join(" - ") || `Opcao ${index + 1}`;
}

function episodeCode(episode) {
  return `S${String(episode.season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")}`;
}

function watchedEpisodeKey(episode) {
  return `${selectedSeriesKey}:${episode.season}:${episode.episode}`;
}

function isEpisodeWatched(episode) {
  return Boolean(watchedEpisodes[watchedEpisodeKey(episode)]);
}

function isEpisodePlayable(episode) {
  return (episode.variants || []).some(isEntryPlayable);
}

function lockedEpisodeMessage(episode) {
  const lockedVariant = (episode.variants || []).find((entry) => entry.locked_reason);
  return lockedVariant?.locked_reason || "Adquira um pacote para acessar este conteúdo";
}

function toggleEpisodeWatched(episode) {
  const key = watchedEpisodeKey(episode);
  if (watchedEpisodes[key]) {
    delete watchedEpisodes[key];
  } else {
    watchedEpisodes[key] = {
      series_key: selectedSeriesKey,
      series_title: selectedSeriesTitle,
      season: episode.season,
      episode: episode.episode,
      title: episode.title || "",
      watched_at: Date.now() / 1000,
    };
  }
  saveUserState();
  renderSeriesEpisodes();
}

function createSeriesEpisodeButton(episode) {
  const item = document.createElement("button");
  const playable = isEpisodePlayable(episode);
  item.className = [
    "episode-button",
    playable ? "episode-unlocked" : "episode-locked",
    isEpisodeWatched(episode) ? "watched" : "",
  ].filter(Boolean).join(" ");
  item.type = "button";
  const firstEntry = episode.variants[0];
  item.innerHTML = `
    <span>${episodeCode(episode)}</span>
    <small>${playable ? "Liberado" : "Bloqueado"}</small>
    ${isEpisodeWatched(episode) ? "<small>Assistido</small>" : ""}
  `;
  item.title = `${episode.title || firstEntry.title || firstEntry.url} - ${episode.variants.length} opcao(oes)`;
  item.addEventListener("click", () => {
    showEpisodeOptionsModal(episode);
  });
  return item;
}

function showEpisodeOptionsModal(episode) {
  const firstEntry = episode.variants[0];
  const playable = isEpisodePlayable(episode);
  els.episodeModal.hidden = false;
  els.episodeModalTitle.textContent = `${episodeCode(episode)} - ${episode.title || firstEntry.title || "Episodio"}`;
  els.episodeModalMessage.textContent = playable
    ? `${episode.variants.length} opcao(oes) disponivel(is).`
    : lockedEpisodeMessage(episode);
  els.episodeModalOptions.innerHTML = "";
  const watchedButton = document.createElement("button");
  watchedButton.className = `episode-watched-toggle ${isEpisodeWatched(episode) ? "active" : ""}`;
  watchedButton.type = "button";
  watchedButton.innerHTML = `
    <span>${isEpisodeWatched(episode) ? "Assistido" : "Marcar como assistido"}</span>
    <small>${isEpisodeWatched(episode) ? "Clique para desfazer" : "Salva este progresso no seu usuario"}</small>
  `;
  watchedButton.addEventListener("click", () => {
    hideEpisodeOptionsModal();
    toggleEpisodeWatched(episode);
  });
  els.episodeModalOptions.appendChild(watchedButton);
  episode.variants.forEach((entry, index) => {
    const button = document.createElement("button");
    const entryPlayable = isEntryPlayable(entry);
    button.className = `episode-option ${entryPlayable ? "" : "locked"}`.trim();
    button.type = "button";
    button.innerHTML = `
      <strong>${escapeHtml(seriesVariantLabel(entry, index))}</strong>
      <small>${escapeHtml(entryPlayable ? formatEntryMeta(entry) : (entry.locked_reason || "Adquira um pacote para acessar este conteúdo"))}</small>
    `;
    button.addEventListener("click", () => {
      if (!entryPlayable) {
        const lockedMessage = entry.locked_reason || "Adquira um pacote para acessar este conteúdo";
        setStatus(lockedMessage, "error");
        showStatusModal("Conteudo bloqueado", lockedMessage, "error");
        return;
      }
      hideEpisodeOptionsModal();
      scrollPlayerIntoView();
      startStream(entry.url, entry).catch(showStreamError);
    });
    els.episodeModalOptions.appendChild(button);
  });
}

function hideEpisodeOptionsModal() {
  els.episodeModal.hidden = true;
  els.episodeModalOptions.innerHTML = "";
}

function renderSeriesBackButton(fragment) {
  if (selectedCategory !== "series" || !selectedSeriesKey) {
    return;
  }
  const button = document.createElement("button");
  button.className = "ghost small-button series-back";
  button.type = "button";
  button.textContent = `Voltar para series${selectedSeriesTitle ? ` (${selectedSeriesTitle})` : ""}`;
  button.addEventListener("click", () => {
    resetSelectedSeries();
    fetchPlaylistPage({ reset: true }).catch((error) => setStatus(error.message, "error"));
  });
  fragment.appendChild(button);
}

function formatEntryMeta(entry) {
  const pieces = [];
  pieces.push(categoryLabel(entry.category));
  if (entry.category === "series" && (entry.season_number || entry.episode_number)) {
    const season = entry.season_number ? `T${String(entry.season_number).padStart(2, "0")}` : "Temporada";
    const episode = entry.episode_number ? `E${String(entry.episode_number).padStart(2, "0")}` : "Episodio";
    pieces.push(`${season}${episode}`);
  }
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
    all: "Busca geral",
    world_cup: "Copa do Mundo 2026",
    daily_games: "Esportes",
    tv: "TV",
    reality: "Reality",
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

if (els.loadTest) {
  els.loadTest.addEventListener("click", () => {
    logUserAction("Clique em atualizar playlist");
    cacheDefaultPlaylist();
  });
}

els.loginForm.addEventListener("submit", login);
els.logout.addEventListener("click", logout);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    sendHeartbeat();
  }
});
window.addEventListener("focus", sendHeartbeat);

els.statusModalClose.addEventListener("click", hideStatusModal);
els.statusModalOpenExternal.addEventListener("click", () => {
  if (launchPreparedExternalPlayer()) {
    hideStatusModal();
    return;
  }
  hideStatusModal();
  openActiveStreamInExternalPlayer();
});
els.statusModalPlayBrowser.addEventListener("click", () => {
  const streamUrl = activeStreamId;
  if (!streamUrl) {
    hideStatusModal();
    setStatus("Selecione um stream antes de reproduzir no navegador.", "error");
    return;
  }
  const entry = activeEntry || { title: "Link direto", url: streamUrl };
  if (!browserPlaybackSupportedFor(inferMediaKind(streamUrl, entry))) {
    showExternalPlayerModal(
      "Use um player externo",
      "O navegador do iPhone nao reproduz este formato ao vivo. Abra no player externo.",
      { allowBrowser: false }
    );
    return;
  }
  hideStatusModal();
  startStream(streamUrl, entry, { allowLiveBrowser: true }).catch(showStreamError);
});
if (els.resumeBrowserPlayback) {
  els.resumeBrowserPlayback.addEventListener("click", () => {
    const saved = activeStreamId ? { stream_id: activeStreamId, entry: activeEntry } : loadLastSelectedStream();
    const streamUrl = saved?.stream_id || "";
    if (!streamUrl) {
      setStatus("Nenhum conteúdo recente para reproduzir.", "error");
      return;
    }
    const entry = saved.entry || { title: "Link direto", url: streamUrl };
    scrollPlayerIntoView();
    startStream(streamUrl, entry, { allowLiveBrowser: true }).catch(showStreamError);
  });
}
els.episodeModalClose.addEventListener("click", hideEpisodeOptionsModal);
els.episodeModal.addEventListener("click", (event) => {
  if (event.target === els.episodeModal) {
    hideEpisodeOptionsModal();
  }
});

let searchTimer = null;
els.entrySearch.addEventListener("input", () => {
  playlistRequestSeq += 1;
  resetSelectedSeries();
  resetMovieCollection();
  if (playlistFetchController) {
    playlistFetchController.abort();
  }
  clearTimeout(searchTimer);
  const query = els.entrySearch.value.trim();
  if (!query) {
    if (isTvAwaitingSearch()) {
      setStatus("Pesquise um canal para exibir resultados de TV.");
      renderInitialCollapsedView();
      return;
    }
    if (isRealityAwaitingSelection()) {
      setStatus("Selecione uma câmera ou episódio da Casa do Patrão.");
      renderInitialCollapsedView();
      loadRealityShortcuts();
      return;
    }
    if (isDailyGamesAwaitingSearch()) {
      setStatus("Pesquise ou use um atalho para exibir esportes.");
      renderInitialCollapsedView();
      return;
    }
    if (selectedCategory === "world_cup") {
      setStatus("Pesquise uma seleção ou use os atalhos da Copa 2026.");
      loadDailyGameShortcuts();
      return;
    }
    if (categoryInteracted || els.groupFilter.value) {
      setStatus("Digite um titulo para buscar no catalogo.");
      renderInitialCollapsedView();
      return;
    }
    setStatus("Digite um titulo para buscar no catalogo.");
    renderInitialCollapsedView();
    return;
  }
  if (query.length < MIN_SEARCH_QUERY_LENGTH) {
    playlistRequestSeq += 1;
    setStatus(`Digite pelo menos ${MIN_SEARCH_QUERY_LENGTH} caracteres para buscar.`);
    renderInitialCollapsedView();
    return;
  }
  setStatus(query ? "Buscando na playlist..." : "Limpando busca...");
  setPlaylistLoading(query ? `Buscando "${query}"...` : "Atualizando resultados...");
  searchTimer = setTimeout(() => {
    fetchPlaylistPage({ reset: true }).catch((error) => setStatus(error.message, "error"));
  }, SEARCH_DEBOUNCE_MS);
});
els.groupFilter.addEventListener("change", () => {
  resetSelectedSeries();
  resetMovieCollection();
  categoryInteracted = true;
  logUserAction("Grupo alterado", { group: els.groupFilter.value });
  if (!els.groupFilter.value) {
    categoryInteracted = false;
    setStatus("Digite um titulo para buscar no catalogo.");
    renderInitialCollapsedView();
    return;
  }
  selectedCategory = "all";
  dailyGamesCatalogRequested = false;
  worldCupCatalogRequested = false;
  els.entrySearch.value = "";
  els.categoryFilters.forEach((filter) => filter.classList.remove("active"));
  renderSearchPrompt();
  setStatus("Grupo selecionado. Digite um titulo para buscar.");
});
els.categoryFilters.forEach((button) => {
  button.addEventListener("click", () => {
    selectedCategory = button.dataset.category;
    resetSelectedSeries();
    resetMovieCollection();
    dailyGamesCatalogRequested = false;
    worldCupCatalogRequested = false;
    categoryInteracted = true;
    els.entrySearch.value = "";
    els.groupFilter.value = "";
    logUserAction("Categoria alterada", { category: selectedCategory });
    els.categoryFilters.forEach((filter) => filter.classList.toggle("active", filter === button));
    updateQuickLinksVisibility();
    if (isTvAwaitingSearch()) {
      setStatus("Pesquise um canal para exibir resultados de TV.");
      renderInitialCollapsedView();
      return;
    }
    if (selectedCategory === "world_cup") {
      setStatus("Pesquise uma seleção ou use os atalhos da Copa 2026.");
      loadDailyGameShortcuts();
      return;
    }
    if (isRealityAwaitingSelection()) {
      setStatus("Selecione uma câmera ou episódio da Casa do Patrão.");
      renderInitialCollapsedView();
      loadRealityShortcuts();
      return;
    }
    if (isDailyGamesAwaitingSearch()) {
      setStatus("Pesquise ou use um atalho para exibir esportes.");
      renderInitialCollapsedView();
      loadDailyGameShortcuts();
      return;
    }
    setStatus("Digite um titulo para buscar nesta categoria.");
    renderInitialCollapsedView();
  });
});

if (els.tvQuickLinks) {
  els.tvQuickLinks.addEventListener("error", (event) => {
    if (event.target?.tagName === "IMG") {
      replaceBrokenQuickLogo(event.target);
    }
  }, true);

  els.tvQuickLinks.addEventListener("click", (event) => {
    const button = event.target.closest(".tv-quick-link");
    if (!button) {
      return;
    }
    const channel = button.dataset.channel || "";
    const search = Object.prototype.hasOwnProperty.call(button.dataset, "search") ? button.dataset.search : channel;
    selectedCategory = "tv";
    resetSelectedSeries();
    resetMovieCollection();
    dailyGamesCatalogRequested = false;
    worldCupCatalogRequested = false;
    categoryInteracted = true;
    els.entrySearch.value = search;
    els.groupFilter.value = "";
    els.categoryFilters.forEach((filter) => filter.classList.toggle("active", filter.dataset.category === "tv"));
    updateQuickLinksVisibility();
    setPlaylistLoading(`Buscando "${channel}"...`);
    fetchPlaylistPage({ reset: true }).catch((error) => setStatus(error.message, "error"));
  });
}

if (els.worldCupQuickLinks) {
  els.worldCupQuickLinks.addEventListener("click", (event) => {
    const button = event.target.closest(".tv-quick-link");
    if (!button) {
      return;
    }
    const entry = worldCupShortcutEntries[Number(button.dataset.worldCupIndex)];
    if (entry) {
      openWorldCupShortcut(entry);
    }
  });
}

if (els.realityQuickLinks) {
  els.realityQuickLinks.addEventListener("click", (event) => {
    const button = event.target.closest(".tv-quick-link");
    if (!button) {
      return;
    }
    const entry = realityShortcutEntries[Number(button.dataset.realityIndex)];
    if (entry) {
      openRealityShortcut(entry);
    }
  });
}

if (els.dailyGameQuickLinks) {
  els.dailyGameQuickLinks.addEventListener("error", (event) => {
    if (event.target?.tagName === "IMG") {
      replaceBrokenQuickLogo(event.target);
    }
  }, true);

  els.dailyGameQuickLinks.addEventListener("click", (event) => {
    const button = event.target.closest(".tv-quick-link");
    if (!button) {
      return;
    }
    if (button.dataset.gameIndex) {
      const entry = dailyGameShortcutEntries[Number(button.dataset.gameIndex)];
      if (entry) {
        openDailyGameShortcut(entry);
      }
      return;
    }
    const channel = button.dataset.channel || "";
    const search = Object.prototype.hasOwnProperty.call(button.dataset, "search") ? button.dataset.search : channel;
    selectedCategory = "daily_games";
    resetSelectedSeries();
    resetMovieCollection();
    dailyGamesCatalogRequested = !search;
    worldCupCatalogRequested = false;
    categoryInteracted = true;
    els.entrySearch.value = search;
    els.groupFilter.value = "";
    els.categoryFilters.forEach((filter) => filter.classList.toggle("active", filter.dataset.category === "daily_games"));
    updateQuickLinksVisibility();
    setPlaylistLoading(search ? `Buscando "${channel}"...` : "Carregando futebol...");
    fetchPlaylistPage({ reset: true }).catch((error) => setStatus(error.message, "error"));
  });
}

if (els.seriesStreamerLinks) {
  els.seriesStreamerLinks.addEventListener("error", (event) => {
    if (event.target?.tagName === "IMG") {
      replaceBrokenQuickLogo(event.target);
    }
  }, true);

  els.seriesStreamerLinks.addEventListener("click", (event) => {
    const button = event.target.closest(".tv-quick-link");
    if (!button) {
      return;
    }
    const streamer = button.dataset.channel || "";
    const search = button.dataset.search || streamer;
    selectedCategory = "series";
    resetSelectedSeries();
    resetMovieCollection();
    dailyGamesCatalogRequested = false;
    worldCupCatalogRequested = false;
    categoryInteracted = true;
    els.entrySearch.value = search;
    els.groupFilter.value = "";
    els.categoryFilters.forEach((filter) => filter.classList.toggle("active", filter.dataset.category === "series"));
    updateQuickLinksVisibility();
    setPlaylistLoading(`Buscando séries de ${streamer}...`);
    fetchPlaylistPage({ reset: true }).catch((error) => setStatus(error.message, "error"));
  });
}

els.loadMore.addEventListener("click", () => {
  const current = selectedCategory === "series" && !selectedSeriesKey ? allSeriesGroups.length : allEntries.length;
  logUserAction("Carregar mais resultados", { current, total: totalEntries });
  if (selectedSeriesKey) {
    loadSelectedSeriesSeason({ reset: false }).catch((error) => setStatus(error.message, "error"));
    return;
  }
  fetchPlaylistPage({ reset: false }).catch((error) => setStatus(error.message, "error"));
});

els.stopStream.addEventListener("click", () => {
  stopActiveStream().then(() => setStatus("Stream parado.", "ok"));
});

els.openVlc.addEventListener("click", openActiveStreamInExternalPlayer);

els.playbackMode.addEventListener("change", () => {
  logUserAction("Modo de reproducao alterado", { playback_mode: currentPlaybackMode() });
  setStatus(`Modo de reproducao: ${els.playbackMode.options[els.playbackMode.selectedIndex].text}.`, "ok");
});

els.externalPlayer.addEventListener("change", () => {
  pendingExternalLaunch = null;
  const playerLabel = EXTERNAL_PLAYER_LABELS[currentExternalPlayer()] || "player externo";
  setStatusModalExternalButton(`Abrir ${playerLabel}`, false);
});

window.addEventListener("beforeunload", () => {
  if (!activeStreamId || !activeUsesProxy) {
    return;
  }
  fetch("/stream/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ stream_id: activeStreamId }),
    keepalive: true,
  }).catch(() => undefined);
});

document.addEventListener("DOMContentLoaded", async () => {
  showHubLoading();
  startClock();
  renderTvQuickLinks();
  renderDailyGameQuickLinks();
  renderWorldCupQuickLinks();
  renderSeriesStreamerLinks();
  bindWorldCupLogoFallback();
  applyExternalPlayerRecommendation();
  try {
    await loadAppConfig();
    await waitForPreloadedPlaylistReady();
    const authenticated = await initAuth();
    if (!authenticated) {
      hideHubLoading();
    }
    if (authenticated && !appLoaded) {
      startAuthenticatedExperience();
    }
  } catch (error) {
    hideHubLoading();
    showLogin();
    setAuthMessage(error.message || "Nao foi possivel carregar a playlist.", "error");
  }
});

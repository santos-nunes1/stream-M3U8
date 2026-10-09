(function () {
  var API_BASE = "https://app.streamcorsario.com";
  var stage = document.querySelector("#stage");
  var hint = document.querySelector("#hint");
  var hud = document.querySelector("#hud");
  var hudTitle = document.querySelector("#hud-title");
  var hudStatus = document.querySelector("#hud-status");
  var hudTimer = 0;
  var progressTimer = 0;
  var video = document.querySelector("#player");
  var avObject = document.querySelector("#av-player");
  var groupTimer = 0;
  var modeTimer = 0;
  var infoTimer = 0;
  var infoToken = 0;
  var selectedEl = null;
  var loadToken = 0;
  var failing = false;
  var scrollTops = { groups: 0, list: 0 };
  var MODES = [
    { id: "tv", label: "Ao vivo" },
    { id: "movies", label: "Filmes" },
    { id: "series", label: "Séries" },
    { id: "search", label: "Buscar" }
  ];
  var STREAMERS = [
    { id: "netflix", name: "Netflix", search: "netflix", theme: "theme-netflix", image: "brands/netflix.png" },
    { id: "prime", name: "Prime Video", search: "prime video", theme: "theme-prime", image: "brands/prime.png" },
    { id: "disney", name: "Disney+", search: "disney plus", theme: "theme-disney", image: "brands/disney.png" },
    { id: "max", name: "Max", search: "max", theme: "theme-max", image: "brands/max.png" },
    { id: "apple", name: "Apple TV+", search: "apple tv", theme: "theme-apple", image: "brands/apple.png" },
    { id: "paramount", name: "Paramount+", search: "paramount plus", theme: "theme-paramount", image: "brands/paramount.png" },
    { id: "globoplay", name: "Globoplay", search: "globoplay", theme: "theme-globoplay", image: "brands/globoplay.png" },
    { id: "star", name: "Star+", search: "star plus", theme: "theme-star", image: "brands/star.png" }
  ];
  var GENRES = [
    { id: "acao", label: "Ação", words: ["acao", "ação", "action"] },
    { id: "aventura", label: "Aventura", words: ["aventura", "adventure"] },
    { id: "comedia", label: "Comédia", words: ["comedia", "comédia", "comedy"] },
    { id: "crime", label: "Crime", words: ["crime", "policial"] },
    { id: "documentario", label: "Documentários", words: ["document"] },
    { id: "drama", label: "Drama", words: ["drama"] },
    { id: "fantasia", label: "Fantasia", words: ["fantasia", "fantasy"] },
    { id: "ficcao", label: "Ficção científica", words: ["ficcao", "ficção", "sci-fi", "scifi", "sci fi"] },
    { id: "guerra", label: "Guerra", words: ["guerra"] },
    { id: "animacao", label: "Animação", words: ["anima", "animacao", "animação", "desenho", "cartoon"] },
    { id: "infantil", label: "Infantil", words: ["infantil", "kids"] },
    { id: "nacional", label: "Nacional", words: ["nacional"] },
    { id: "romance", label: "Romance", words: ["romance"] },
    { id: "suspense", label: "Suspense", words: ["suspense", "thriller"] },
    { id: "terror", label: "Terror", words: ["terror", "horror"] }
  ];
  var state = {
    screen: "browse",
    column: "2",
    kind: "tv",
    group: "",
    groups: [],
    groupIndex: 0,
    seriesKey: "",
    seriesTitle: "",
    seasons: [],
    season: "",
    query: "",
    draftQuery: "",
    offset: 0,
    total: 0,
    hasMore: false,
    items: [],
    itemIndex: 0,
    modeIndex: 0,
    message: "Carregando a programação...",
    activeStreamId: "",
    playingTitle: "",
    paused: false,
    catalog: null,
    watching: null,
    resumeSeconds: 0,
    resumeApplied: false,
    searchIndex: 0
  };

  function esc(value) {
    var text = "";
    if (value !== undefined && value !== null) {
      text = String(value);
    }
    return text.replace(/[&<>"']/g, function (char) {
      if (char === "&") {
        return "&amp;";
      }
      if (char === "<") {
        return "&lt;";
      }
      if (char === ">") {
        return "&gt;";
      }
      if (char === '"') {
        return "&quot;";
      }
      return "&#39;";
    });
  }

  function columnNodes(col) {
    return stage.querySelectorAll('[data-col="' + col + '"]');
  }

  function columnIndex(col) {
    if (col === "0") {
      return state.groupIndex;
    }
    if (col === "2") {
      return state.modeIndex;
    }
    return state.itemIndex;
  }

  function setColumnIndex(col, index) {
    if (col === "0") {
      state.groupIndex = index;
    } else if (col === "2") {
      state.modeIndex = index;
    } else {
      state.itemIndex = index;
    }
  }

  function rememberScroll() {
    var groups = document.getElementById("groups");
    var list = document.getElementById("list");
    if (groups) {
      scrollTops.groups = groups.scrollTop;
    }
    if (list) {
      scrollTops.list = list.scrollTop;
    }
  }

  function ensureVisible(el) {
    var parent = el.parentNode;
    while (parent && parent.id !== "groups" && parent.id !== "list" && parent !== document.body) {
      parent = parent.parentNode;
    }
    if (!parent || (parent.id !== "groups" && parent.id !== "list")) {
      return;
    }
    var top = el.offsetTop;
    var bottom = top + el.offsetHeight;
    if (top < parent.scrollTop) {
      parent.scrollTop = top > 8 ? top - 8 : 0;
    } else if (bottom > parent.scrollTop + parent.clientHeight) {
      parent.scrollTop = bottom - parent.clientHeight + 8;
    }
    if (parent.id === "groups") {
      scrollTops.groups = parent.scrollTop;
    }
    if (parent.id === "list") {
      scrollTops.list = parent.scrollTop;
    }
  }

  function markSelected(el) {
    if (selectedEl && selectedEl !== el) {
      selectedEl.removeAttribute("data-selected");
    }
    selectedEl = el || null;
    if (!selectedEl) {
      return;
    }
    selectedEl.setAttribute("data-selected", "1");
    ensureVisible(selectedEl);
  }

  function paint() {
    var nodes = state.screen === "search" ? stage.querySelectorAll(".focusable") : columnNodes(state.column);
    var index = state.screen === "search" ? state.searchIndex : columnIndex(state.column);
    if (!nodes.length) {
      selectedEl = null;
      return;
    }
    if (index >= nodes.length) {
      index = nodes.length - 1;
    }
    if (index < 0) {
      index = 0;
    }
    if (state.screen === "search") {
      state.searchIndex = index;
    } else {
      setColumnIndex(state.column, index);
    }
    markSelected(nodes[index]);
    clearTimeout(infoTimer);
    infoTimer = setTimeout(updateInfo, 30);
  }

  function updateInfo() {
    var poster = document.getElementById("info-poster");
    var titleNode = document.getElementById("info-title");
    var groupNode = document.getElementById("info-group");
    if (!poster || !titleNode || !groupNode) {
      return;
    }
    var nodes = columnNodes("1");
    var entry = null;
    if (nodes[state.itemIndex]) {
      var raw = nodes[state.itemIndex].getAttribute("data-index");
      if (raw !== null && raw !== "" && raw.charAt(0) !== "m") {
        entry = state.items[Number(raw)];
      }
    }
    poster.innerHTML = "";
    if (!entry) {
      titleNode.innerHTML = state.seriesTitle || "Escolha um título";
      groupNode.innerHTML = "";
      return;
    }
    var title = entry.title || entry.series_title || "Sem título";
    var token = infoToken + 1;
    infoToken = token;
    titleNode.innerHTML = esc(title);
    groupNode.innerHTML = esc(entry.group || state.group || "");
    poster.innerHTML = esc(title.charAt(0) || "•");
    if (!entry.logo) {
      return;
    }
    var logo = entry.logo;
    setTimeout(function () {
      if (token !== infoToken) {
        return;
      }
      var img = document.createElement("img");
      img.alt = "";
      img.src = logo;
      img.onerror = function () {
        if (token === infoToken) {
          poster.innerHTML = esc(title.charAt(0) || "•");
        }
      };
      if (token === infoToken) {
        poster.innerHTML = "";
        poster.appendChild(img);
      }
    }, 40);
  }

  function shellClass(extra) {
    var name = "";
    if (state.catalog) {
      name = "themed " + state.catalog.theme;
    }
    if (extra) {
      name = name ? name + " " + extra : extra;
    }
    return name;
  }

  function catalogQuery() {
    if (state.seriesKey || !state.catalog) {
      return state.query;
    }
    if (state.query) {
      return state.catalog.search + " " + state.query;
    }
    return state.catalog.search;
  }

  function streamerById(id) {
    var i;
    for (i = 0; i < STREAMERS.length; i++) {
      if (STREAMERS[i].id === id) {
        return STREAMERS[i];
      }
    }
    return null;
  }

  function move(direction) {
    if (state.screen === "search") {
      moveSearch(direction);
      return;
    }
    if ((state.kind === "series" || state.kind === "movies") && state.column !== "2") {
      moveSeries(direction);
      return;
    }
    var nodes = columnNodes(state.column);
    if (!nodes.length) {
      return;
    }
    var index = columnIndex(state.column);
    if (state.column === "2") {
      if (direction === "left" && index > 0) {
        state.modeIndex = index - 1;
      }
      if (direction === "right" && index < nodes.length - 1) {
        state.modeIndex = index + 1;
      }
      if (direction === "down") {
        state.column = state.kind === "series" || state.kind === "movies" ? "1" : "0";
      }
      paint();
      if (direction === "left" || direction === "right") {
        scheduleModeLoad();
      }
      return;
    }
    if (direction === "up") {
      if (index <= 0) {
        state.column = "2";
        paint();
        return;
      }
      index -= 1;
    }
    if (direction === "down") {
      index += 1;
    }
    if (direction === "left" && state.column === "1") {
      state.column = "0";
      paint();
      return;
    }
    if (direction === "right" && state.column === "0") {
      state.column = "1";
      paint();
      return;
    }
    if (index < 0) {
      index = 0;
    }
    if (index >= nodes.length) {
      index = nodes.length - 1;
    }
    setColumnIndex(state.column, index);
    paint();
    if (state.column === "0" && (direction === "up" || direction === "down")) {
      scheduleSideLoad();
    }
  }

  function moveSeries(direction) {
    var nodes = columnNodes("1");
    if (!nodes.length) {
      return;
    }
    var index = state.itemIndex;
    if (index < 0 || index >= nodes.length) {
      index = 0;
    }
    var current = nodes[index];
    var row = Number(current.getAttribute("data-row") || "0");
    var slot = Number(current.getAttribute("data-slot") || "0");
    var targetRow = row;
    var targetSlot = slot;
    if (direction === "left") {
      targetSlot -= 1;
    }
    if (direction === "right") {
      targetSlot += 1;
    }
    if (direction === "up") {
      targetRow -= 1;
    }
    if (direction === "down") {
      targetRow += 1;
    }
    if (targetRow < 0) {
      state.column = "2";
      paint();
      return;
    }
    var i;
    var best = -1;
    var bestDist = 9999;
    for (i = 0; i < nodes.length; i++) {
      var nodeRow = Number(nodes[i].getAttribute("data-row") || "0");
      var nodeSlot = Number(nodes[i].getAttribute("data-slot") || "0");
      if ((direction === "left" || direction === "right") && nodeRow === row && nodeSlot === targetSlot) {
        best = i;
      }
      if ((direction === "up" || direction === "down") && nodeRow === targetRow) {
        var dist = Math.abs(nodeSlot - slot);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
    }
    if (best < 0) {
      return;
    }
    state.column = "1";
    state.itemIndex = best;
    paint();
  }

  function openCatalog(id) {
    var streamer = streamerById(id);
    if (!streamer) {
      return;
    }
    state.catalog = streamer;
    state.kind = "series";
    state.group = "";
    state.query = "";
    state.seriesKey = "";
    state.seriesTitle = "";
    state.seasons = [];
    state.season = "";
    state.offset = 0;
    state.itemIndex = 0;
    state.column = "1";
    state.screen = "browse";
    loadItems(false);
  }

  function scheduleModeLoad() {
    clearTimeout(modeTimer);
    modeTimer = setTimeout(function () {
      var tabs = columnNodes("2");
      var tab = tabs[state.modeIndex];
      if (!tab) {
        return;
      }
      selectKind(tab.getAttribute("data-kind"), true);
    }, 80);
  }

  function selectKind(kind, stayOnTabs) {
    if (kind === "search") {
      if (!stayOnTabs) {
        state.draftQuery = state.query;
        state.screen = "search";
        state.searchIndex = 0;
        render();
      }
      return;
    }
    if (kind === "series") {
      state.kind = "series";
      state.catalog = null;
      state.group = "";
      state.groups = [];
      state.query = "";
      state.seriesKey = "";
      state.seriesTitle = "";
      state.seasons = [];
      state.season = "";
      state.offset = 0;
      state.items = [];
      state.itemIndex = 0;
      state.message = "Escolha um streaming";
      state.screen = "browse";
      state.column = stayOnTabs ? "2" : "1";
      render();
      return;
    }
    if (kind === "movies") {
      state.kind = "movies";
      state.catalog = null;
      state.group = "";
      state.groups = [];
      state.query = "";
      state.seriesKey = "";
      state.seriesTitle = "";
      state.seasons = [];
      state.season = "";
      state.offset = 0;
      state.items = [];
      state.itemIndex = 0;
      state.screen = "browse";
      state.column = stayOnTabs ? "2" : "1";
      loadMovieCatalog();
      return;
    }
    if (kind === state.kind && !state.seriesKey && !state.query && state.groups.length) {
      return;
    }
    state.kind = kind;
    state.catalog = null;
    state.group = "";
    state.groups = [];
    state.groupIndex = 0;
    state.seriesKey = "";
    state.seriesTitle = "";
    state.seasons = [];
    state.season = "";
    state.query = "";
    state.offset = 0;
    state.itemIndex = 0;
    state.column = stayOnTabs ? "2" : "1";
    loadItems(false);
  }

  function scheduleSideLoad() {
    clearTimeout(groupTimer);
    groupTimer = setTimeout(applySideSelection, 80);
  }

  function applySideSelection() {
    var nodes = columnNodes("0");
    var node = nodes[state.groupIndex];
    if (!node) {
      return;
    }
    var action = node.getAttribute("data-action");
    if (action === "group") {
      var next = node.getAttribute("data-group") || "";
      if (next === state.group && !state.seriesKey) {
        return;
      }
      state.group = next;
      state.offset = 0;
      state.itemIndex = 0;
      loadItems(false);
    } else if (action === "season") {
      var season = node.getAttribute("data-season") || "";
      if (season === state.season) {
        return;
      }
      state.season = season;
      state.offset = 0;
      state.itemIndex = 0;
      loadItems(false);
    }
  }

  function activateCurrent() {
    var col = state.screen === "search" ? "search" : state.column;
    var nodes = state.screen === "search" ? stage.querySelectorAll(".focusable") : columnNodes(col);
    var index = state.screen === "search" ? state.searchIndex : columnIndex(col);
    if (nodes[index]) {
      activate(nodes[index]);
    }
  }

  function goBack() {
    if (document.body.className.indexOf("playing") !== -1) {
      stopPlayback();
      render();
      return;
    }
    if (state.screen === "search") {
      state.screen = "browse";
      state.column = "2";
      render();
      return;
    }
    if (state.seriesKey) {
      state.seriesKey = "";
      state.seriesTitle = "";
      state.seasons = [];
      state.season = "";
      state.offset = 0;
      state.itemIndex = 0;
      state.column = "1";
      loadItems(false);
      return;
    }
    if (state.catalog && state.query) {
      state.query = "";
      state.draftQuery = "";
      state.itemIndex = 0;
      state.column = "1";
      loadStreamerCatalog();
      return;
    }
    if (state.catalog) {
      state.catalog = null;
      state.query = "";
      state.items = [];
      state.itemIndex = 0;
      state.column = "1";
      state.message = "Escolha um streaming";
      render();
      return;
    }
    if (state.query || state.group) {
      state.query = "";
      state.group = "";
      state.groupIndex = 0;
      state.offset = 0;
      state.itemIndex = 0;
      loadItems(false);
    }
  }

  function api(path, options, done) {
    var xhr = new XMLHttpRequest();
    var method = options && options.method ? options.method : "GET";
    var finished = false;
    var timer = setTimeout(function () {
      if (finished) {
        return;
      }
      finished = true;
      try {
        xhr.abort();
      } catch (ignore) {}
      done(new Error("O serviço não respondeu."));
    }, 45000);
    xhr.open(method, API_BASE + path, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4 || finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      var payload = {};
      try {
        payload = JSON.parse(xhr.responseText || "{}");
      } catch (ignore) {}
      if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 202) {
        done(null, payload);
      } else {
        done(new Error((payload && payload.error) || "O serviço não respondeu."));
      }
    };
    xhr.onerror = function () {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      done(new Error("Sem conexão com o servidor."));
    };
    xhr.send(options && options.body ? JSON.stringify(options.body) : null);
  }

  function loadItems(append) {
    if (state.catalog && !state.seriesKey && !append) {
      loadStreamerCatalog();
      return;
    }
    var token = ++loadToken;
    var requestOffset = append ? state.offset : 0;
    if (!append) {
      state.message = "Carregando a programação...";
      var status = stage.querySelector(".status");
      if (status) {
        status.innerHTML = esc(state.message);
      }
    }
    api("/api/playlist/preloaded", {
      method: "POST",
      body: {
        category: state.kind,
        group: state.seriesKey ? "" : state.group,
        query: catalogQuery(),
        series_key: state.seriesKey,
        season: state.season,
        offset: requestOffset,
        limit: 80,
        browse: "playlist"
      }
    }, function (error, payload) {
      if (token !== loadToken) {
        return;
      }
      if (error) {
        state.message = error.message;
        render();
        return;
      }
      if (payload.status === "loading") {
        state.message = payload.message || "A playlist ainda está carregando no servidor.";
        render();
        setTimeout(function () {
          if (token === loadToken) {
            loadItems(append);
          }
        }, 2000);
        return;
      }
      if (!state.seriesKey && payload.groups && payload.groups.length) {
        state.groups = payload.groups;
      }
      var batch = payload.series_groups && payload.series_groups.length ? payload.series_groups : (payload.entries || []);
      state.items = append ? state.items.concat(batch) : batch;
      state.total = payload.total || state.items.length;
      state.offset = requestOffset + batch.length;
      state.hasMore = !!payload.has_more;
      state.message = state.items.length ? state.total + " títulos" : "Nada neste grupo.";
      render();
    });
  }

  function readContinue() {
    try {
      var raw = localStorage.getItem("streamcorsario.continue");
      var parsed = raw ? JSON.parse(raw) : [];
      if (parsed && parsed.length) {
        return parsed;
      }
    } catch (ignore) {}
    return [];
  }

  function writeContinue(items) {
    try {
      localStorage.setItem("streamcorsario.continue", JSON.stringify(items));
    } catch (ignore) {}
  }

  function matchesContinueView(item) {
    if (state.kind === "movies") {
      return item.kind === "movies";
    }
    if (state.kind === "series" && state.catalog) {
      return item.catalogId === state.catalog.id;
    }
    if (state.kind === "series") {
      return item.kind === "series";
    }
    return false;
  }

  function visibleContinue() {
    var all = readContinue();
    var list = [];
    var i;
    for (i = 0; i < all.length; i++) {
      if (all[i].position >= 20 && matchesContinueView(all[i])) {
        list.push(all[i]);
      }
    }
    return list;
  }

  function savedPosition(url) {
    var items = readContinue();
    var i;
    for (i = 0; i < items.length; i++) {
      if (items[i].url === url && items[i].position >= 20) {
        if (!items[i].duration || items[i].position < items[i].duration - 30) {
          return items[i].position;
        }
      }
    }
    return 0;
  }

  function currentProgress() {
    var position = 0;
    var duration = 0;
    var av = activeAvPlay();
    if (av) {
      try {
        position = av.getCurrentTime() / 1000;
      } catch (ignore) {}
      try {
        duration = av.getDuration() / 1000;
      } catch (ignore) {}
    } else if (video && video.currentTime) {
      position = video.currentTime;
      duration = video.duration || 0;
    }
    return { position: position, duration: duration };
  }

  function saveWatching() {
    if (!state.watching || !state.watching.url || state.watching.kind === "tv") {
      return;
    }
    var progress = currentProgress();
    if (progress.position < 15) {
      return;
    }
    var kept = {
      url: state.watching.url,
      title: state.watching.title,
      logo: state.watching.logo || "",
      kind: state.watching.kind,
      catalogId: state.watching.catalogId || "",
      group: state.watching.group || "",
      category: state.watching.category || "",
      mediaKind: state.watching.mediaKind || "",
      position: Math.floor(progress.position),
      duration: Math.floor(progress.duration || 0)
    };
    var finished = kept.duration > 60 && kept.position > kept.duration * 0.92;
    var items = readContinue();
    var next = [];
    var i;
    if (!finished) {
      next.push(kept);
    }
    for (i = 0; i < items.length; i++) {
      if (items[i].url !== kept.url && next.length < 24) {
        next.push(items[i]);
      }
    }
    writeContinue(next);
  }

  function seekPlayback(seconds) {
    if (!seconds || seconds < 20 || state.resumeApplied) {
      return;
    }
    state.resumeApplied = true;
    var av = activeAvPlay();
    if (av) {
      try {
        av.seekTo(Math.floor(seconds * 1000));
      } catch (ignore) {}
    } else {
      try {
        video.currentTime = seconds;
      } catch (ignore) {}
    }
    showHud("Continuando de onde parou");
  }

  function armResume() {
    clearInterval(progressTimer);
    progressTimer = setInterval(saveWatching, 8000);
    if (!state.resumeSeconds) {
      return;
    }
    setTimeout(function () {
      seekPlayback(state.resumeSeconds);
    }, 1200);
  }

  function isLiveChannel(entry) {
    var url = String(entry.url || "").toLowerCase();
    var hay = entryHaystack(entry);
    if (url.indexOf("/movie/") !== -1 || url.indexOf(".mp4") !== -1 || url.indexOf(".mkv") !== -1 || url.indexOf(".m4v") !== -1) {
      return false;
    }
    if (url.indexOf("/live/") !== -1 || url.indexOf(".ts") !== -1) {
      return true;
    }
    if (hay.indexOf("canal") !== -1 || hay.indexOf("canais") !== -1 || hay.indexOf("24h") !== -1 || hay.indexOf("ao vivo") !== -1) {
      return true;
    }
    if (entry.media_kind === "mpegts") {
      return true;
    }
    return false;
  }

  function loadMovieCatalog() {
    var token = ++loadToken;
    state.message = "Carregando filmes...";
    state.items = [];
    render();
    api("/api/playlist/preloaded", {
      method: "POST",
      body: {
        category: "movies",
        group: "",
        query: "",
        series_key: "",
        season: "",
        offset: 0,
        limit: 500,
        browse: "playlist"
      }
    }, function (error, payload) {
      if (token !== loadToken) {
        return;
      }
      if (error || !payload || payload.status === "loading") {
        state.message = error ? error.message : "A playlist ainda está carregando.";
        render();
        return;
      }
      var batch = payload.entries || [];
      var kept = [];
      var i;
      for (i = 0; i < batch.length; i++) {
        if (!isLiveChannel(batch[i]) && entryKind(batch[i]) !== "series") {
          kept.push(batch[i]);
        }
      }
      state.items = kept;
      state.hasMore = false;
      state.message = kept.length ? kept.length + " filmes" : "Nenhum filme encontrado.";
      render();
    });
  }

  function loadStreamerCatalog() {
    var token = ++loadToken;
    var pending = 2;
    var seriesBatch = [];
    var movieBatch = [];
    state.message = "Carregando " + state.catalog.name + "...";
    state.items = [];
    render();
    function finish() {
      pending -= 1;
      if (pending > 0 || token !== loadToken) {
        return;
      }
      state.items = seriesBatch.concat(movieBatch);
      state.hasMore = false;
      state.offset = state.items.length;
      if (state.query) {
        state.message = state.items.length ? state.items.length + " títulos em " + state.catalog.name : "Nada com esse título em " + state.catalog.name + ".";
      } else {
        state.message = state.items.length ? state.items.length + " títulos" : "Nada neste streaming.";
      }
      render();
    }
    function pull(category, assign) {
      api("/api/playlist/preloaded", {
        method: "POST",
        body: {
          category: category,
          group: "",
          query: catalogQuery(),
          series_key: "",
          season: "",
          offset: 0,
          limit: 160,
          browse: "playlist"
        }
      }, function (error, payload) {
        if (token !== loadToken) {
          return;
        }
        if (error || !payload || payload.status === "loading") {
          assign([]);
          finish();
          return;
        }
        var batch = payload.series_groups && payload.series_groups.length ? payload.series_groups : (payload.entries || []);
        var kept = [];
        var i;
        for (i = 0; i < batch.length; i++) {
          if (matchesCatalog(batch[i])) {
            kept.push(batch[i]);
          }
        }
        assign(kept);
        finish();
      });
    }
    pull("series", function (items) {
      seriesBatch = items;
    });
    pull("movies", function (items) {
      movieBatch = items;
    });
  }

  function play(entry) {
    if (entry.series_key && !entry.url) {
      state.seriesKey = entry.series_key;
      state.seriesTitle = entry.title || entry.series_title || "Série";
      state.seasons = entry.seasons || [];
      state.season = "";
      state.groupIndex = 0;
      state.itemIndex = 0;
      state.column = "1";
      state.offset = 0;
      loadItems(false);
      return;
    }
    if (!entry.url || entry.locked) {
      state.message = entry.locked_reason || "Este título não tem vídeo.";
      render();
      return;
    }
    state.message = "Abrindo no servidor...";
    state.playingTitle = entry.title || entry.series_title || "Reproduzindo";
    state.watching = {
      url: entry.url,
      title: state.playingTitle,
      logo: entry.logo || "",
      kind: entry.kind || state.kind,
      catalogId: state.catalog ? state.catalog.id : (entry.catalogId || ""),
      group: entry.group || "",
      category: entry.category || state.kind,
      mediaKind: entry.media_kind || ""
    };
    state.resumeSeconds = savedPosition(entry.url);
    state.resumeApplied = false;
    render();
    api("/stream/start", {
      method: "POST",
      body: {
        stream_id: entry.url,
        title: entry.title || "",
        group: entry.group || "",
        category: entry.category || state.kind,
        media_kind: entry.media_kind || ""
      }
    }, function (error, payload) {
      if (error) {
        state.message = error.message;
        render();
        return;
      }
      state.activeStreamId = entry.url;
      var playbackUrl = (payload && payload.local_proxy_url) || "";
      if (playbackUrl && playbackUrl.charAt(0) === "/") {
        playbackUrl = API_BASE + playbackUrl;
      }
      if (!playbackUrl) {
        state.message = "O servidor não devolveu o vídeo.";
        render();
        return;
      }
      playUrl(playbackUrl);
    });
  }

  function showHud(text) {
    if (text) {
      hudStatus.innerHTML = text;
    }
    if (!hud) {
      return;
    }
    hud.className = "";
    clearTimeout(hudTimer);
    hudTimer = setTimeout(function () {
      hud.className = "hud-hidden";
    }, 4000);
  }

  function playUrl(url) {
    failing = false;
    state.paused = false;
    document.body.className = shellClass("playing");
    hudTitle.innerHTML = esc(state.playingTitle);
    showHud("Conectando...");
    if (avObject) {
      avObject.style.width = (window.innerWidth || 1920) + "px";
      avObject.style.height = (window.innerHeight || 1080) + "px";
    }
    var nativePlayer = window.AndroidPlayer;
    if (nativePlayer && nativePlayer.play) {
      nativePlayer.play(url);
      showHud(state.resumeSeconds ? "Continuando de onde parou" : "Reproduzindo");
      armResume();
      return;
    }
    var bridge = window.webapis;
    var av = bridge && bridge.avplay;
    if (av) {
      try {
        try {
          av.stop();
        } catch (ignore) {}
        try {
          av.close();
        } catch (ignore) {}
        av.open(url);
        av.setListener({
          onbufferingstart: function () {
            showHud("Carregando vídeo...");
          },
          onbufferingprogress: function () {},
          onbufferingcomplete: function () {
            if (state.resumeSeconds) {
              seekPlayback(state.resumeSeconds);
            } else if (!state.paused) {
              showHud("Reproduzindo");
            }
          },
          oncurrentplaytime: function () {},
          onstreamcompleted: function () {
            showHud("Fim do vídeo");
          },
          onevent: function () {},
          onsubtitlechange: function () {},
          onerror: function () {
            playWithVideo(url);
          }
        });
        try {
          av.setDisplayMethod("PLAYER_DISPLAY_MODE_FULL_SCREEN");
        } catch (ignore) {}
        av.setDisplayRect(0, 0, window.innerWidth || 1920, window.innerHeight || 1080);
        av.prepareAsync(function () {
          try {
            av.play();
            showHud(state.resumeSeconds ? "Continuando de onde parou" : "Reproduzindo");
            armResume();
          } catch (ignore) {
            playWithVideo(url);
          }
        }, function () {
          playWithVideo(url);
        });
        return;
      } catch (ignore) {}
    }
    playWithVideo(url);
  }

  function playWithVideo(url) {
    document.body.className = shellClass("playing use-video");
    showHud("Abrindo player...");
    video.onerror = function () {
      failPlayback("A TV não conseguiu reproduzir este título.");
    };
    video.src = url;
    var started = video.play();
    if (started && typeof started.then === "function") {
      started.then(function () {
        showHud(state.resumeSeconds ? "Continuando de onde parou" : "Reproduzindo");
        armResume();
      }, function () {
        failPlayback("A TV não conseguiu reproduzir este título.");
      });
    } else {
      armResume();
    }
  }

  function activeAvPlay() {
    if (document.body.className.indexOf("use-video") !== -1) {
      return null;
    }
    var bridge = window.webapis;
    if (bridge && bridge.avplay) {
      return bridge.avplay;
    }
    return null;
  }

  function togglePlayback() {
    if (document.body.className.indexOf("playing") === -1) {
      return;
    }
    if (state.paused) {
      resumePlayback();
    } else {
      pausePlayback();
    }
  }

  function pausePlayback() {
    var nativePlayer = window.AndroidPlayer;
    var av = activeAvPlay();
    if (nativePlayer && nativePlayer.pause) {
      nativePlayer.pause();
    }
    if (av) {
      try {
        av.pause();
      } catch (ignore) {}
    } else {
      try {
        video.pause();
      } catch (ignore) {}
    }
    state.paused = true;
    saveWatching();
    showHud("Pausado");
  }

  function resumePlayback() {
    var nativePlayer = window.AndroidPlayer;
    var av = activeAvPlay();
    if (nativePlayer && nativePlayer.resume) {
      nativePlayer.resume();
    }
    if (av) {
      try {
        av.play();
      } catch (ignore) {}
    } else {
      var started = video.play();
      if (started && typeof started.then === "function") {
        started.then(function () {}, function () {});
      }
    }
    state.paused = false;
    showHud("Reproduzindo");
  }

  function failPlayback(message) {
    if (failing) {
      return;
    }
    failing = true;
    stopPlayback();
    state.message = message;
    render();
  }

  function stopPlayback() {
    saveWatching();
    clearInterval(progressTimer);
    state.paused = false;
    clearTimeout(hudTimer);
    if (hud) {
      hud.className = "hud-hidden";
    }
    document.body.className = shellClass();
    var nativePlayer = window.AndroidPlayer;
    if (nativePlayer && nativePlayer.stop && !state.stoppingFromAndroid) {
      nativePlayer.stop();
    }
    var bridge = window.webapis;
    var av = bridge && bridge.avplay;
    if (av) {
      try {
        av.stop();
      } catch (ignore) {}
      try {
        av.close();
      } catch (ignore) {}
    }
    video.onerror = null;
    video.removeAttribute("src");
    try {
      video.load();
    } catch (ignore) {}
    if (state.activeStreamId) {
      api("/stream/stop", { method: "POST", body: { stream_id: state.activeStreamId } }, function () {});
      state.activeStreamId = "";
    }
  }

  function render() {
    selectedEl = null;
    rememberScroll();
    if (document.body.className.indexOf("playing") === -1) {
      document.body.className = shellClass();
    }
    if (state.screen === "search") {
      renderSearch();
    } else if (state.kind === "series" && !state.catalog) {
      renderStreamers();
    }     else if (state.kind === "series" && state.catalog) {
      renderCatalog();
    } else if (state.kind === "movies") {
      renderMovieShelves();
    } else {
      renderBrowse();
    }
    var groups = document.getElementById("groups");
    var list = document.getElementById("list");
    if (groups) {
      groups.scrollTop = scrollTops.groups || 0;
    }
    if (list) {
      list.scrollTop = scrollTops.list || 0;
    }
    if (state.screen === "search") {
      hint.innerHTML = "Digite no celular ou no teclado da TV · Para baixo vai ao botão · OK busca";
    } else if (state.catalog) {
      hint.innerHTML = "O campo busca só neste streaming · Setas nos cartazes · OK abre · Voltar sai da busca";
    } else if (state.kind === "series") {
      hint.innerHTML = "Escolha o streaming · OK abre o catálogo · Voltar sai";
    } else {
      hint.innerHTML = "No topo, esquerda e direita mudam Ao vivo, Filmes, Séries e Buscar · Para baixo entra na lista · OK reproduz";
    }
    paint();
    if (state.screen === "search" && state.searchIndex === 0) {
      setTimeout(focusSearchField, 60);
    }
  }

  function modeButtons() {
    var modes = "";
    var i;
    for (i = 0; i < MODES.length; i++) {
      var current = MODES[i].id === state.kind && MODES[i].id !== "search" ? " current" : "";
      modes += '<button type="button" class="mode focusable' + current + '" data-col="2" data-action="mode" data-kind="' + MODES[i].id + '">' + esc(MODES[i].label) + "</button>";
    }
    return modes;
  }

  function continueCards(row) {
    var items = visibleContinue();
    var html = "";
    var i;
    if (!items.length) {
      return "";
    }
    html += '<h2 class="row-label">Continuar assistindo</h2>';
    for (i = 0; i < items.length; i++) {
      html += resumePoster(i, items[i], row, i);
    }
    return html;
  }

  function resumePoster(index, item, row, slot) {
    var label = item.title || "Sem título";
    var art = "<b>" + esc((label || "?").charAt(0)) + "</b>";
    var width = 8;
    if (item.logo) {
      art = '<img src="' + esc(item.logo) + '" alt="" onerror="this.style.visibility=\'hidden\'">';
    }
    if (item.duration) {
      width = Math.floor((item.position / item.duration) * 100);
    }
    if (width < 8) {
      width = 8;
    }
    if (width > 100) {
      width = 100;
    }
    return '<button type="button" class="poster focusable" data-col="1" data-action="resume" data-resume="' + index + '" data-row="' + row + '" data-slot="' + slot + '">' + art + '<i class="progress" style="width:' + width + '%"></i><span>' + esc(label) + "</span></button>";
  }

  function renderStreamers() {
    var cards = "";
    var i;
    var resume = visibleContinue();
    var row = resume.length ? 1 : 0;
    for (i = 0; i < STREAMERS.length; i++) {
      var streamer = STREAMERS[i];
      var slot = i % 4;
      var cardRow = row + Math.floor(i / 4);
      cards += '<button type="button" class="brand-card focusable" data-col="1" data-action="catalog" data-catalog="' + streamer.id + '" data-row="' + cardRow + '" data-slot="' + slot + '">';
      cards += '<img src="' + streamer.image + '" alt="">';
      cards += "<span>" + esc(streamer.name) + "</span></button>";
    }
    var html = '<div class="modes">' + modeButtons() + "</div>";
    html += '<p class="status">' + esc(state.message) + "</p>";
    html += '<div id="list" class="brand-grid">';
    html += continueCards(0);
    html += '<h1 class="shelf-title">Streamings</h1>';
    html += cards;
    html += "</div>";
    stage.innerHTML = html;
  }

  function matchesCatalog(entry) {
    if (!state.catalog) {
      return true;
    }
    var extraGroups = entry.groups && entry.groups.join ? entry.groups.join(" ") : "";
    var hay = String((entry.group || "") + " " + extraGroups + " " + (entry.title || "") + " " + (entry.series_title || "")).toLowerCase();
    var tokens = state.catalog.search.split(" ");
    var i;
    for (i = 0; i < tokens.length; i++) {
      if (tokens[i] && hay.indexOf(tokens[i]) === -1) {
        return false;
      }
    }
    return true;
  }

  function entryHaystack(entry) {
    return String((entry.group || "") + " " + (entry.title || "") + " " + (entry.series_title || "")).toLowerCase();
  }

  function entryKind(entry) {
    if (entry.category === "movies" || entry.category === "movie") {
      return "movies";
    }
    if (entry.series_key || entry.category === "series") {
      return "series";
    }
    return "other";
  }

  function entryGenre(entry) {
    var hay = entryHaystack(entry);
    var i;
    var j;
    for (i = 0; i < GENRES.length; i++) {
      for (j = 0; j < GENRES[i].words.length; j++) {
        if (hay.indexOf(GENRES[i].words[j]) !== -1) {
          return GENRES[i];
        }
      }
    }
    return null;
  }

  function takeIndexes(source, limit) {
    var list = [];
    var i;
    for (i = 0; i < source.length && list.length < limit; i++) {
      list.push(source[i]);
    }
    return list;
  }

  function buildShelves(items) {
    var trending = [];
    var series = [];
    var movies = [];
    var other = [];
    var buckets = {};
    var shelves = [];
    var i;
    for (i = 0; i < items.length; i++) {
      var entry = items[i];
      var kind = entryKind(entry);
      if (trending.length < 12 && entry.logo) {
        trending.push(i);
      }
      if (kind === "movies") {
        movies.push(i);
      } else if (kind === "series") {
        series.push(i);
      } else {
        other.push(i);
      }
      var genre = entryGenre(entry);
      if (genre) {
        if (!buckets[genre.id]) {
          buckets[genre.id] = [];
        }
        if (buckets[genre.id].length < 12) {
          buckets[genre.id].push(i);
        }
      }
    }
    if (!trending.length) {
      trending = takeIndexes(series.concat(movies), 12);
    }
    if (trending.length) {
      shelves.push({ title: "Em alta", indexes: trending });
    }
    if (series.length) {
      shelves.push({ title: "Séries", indexes: takeIndexes(series, 18) });
    }
    if (movies.length) {
      shelves.push({ title: "Filmes", indexes: takeIndexes(movies, 18) });
    }
    if (other.length) {
      shelves.push({ title: "Outros conteúdos", indexes: takeIndexes(other, 12) });
    }
    for (i = 0; i < GENRES.length; i++) {
      var found = buckets[GENRES[i].id];
      if (found && found.length >= 3) {
        shelves.push({ title: GENRES[i].label, indexes: found });
      }
    }
    return shelves;
  }

  function buildMovieShelves(items) {
    var trending = [];
    var rest = [];
    var buckets = {};
    var shelves = [];
    var i;
    for (i = 0; i < items.length; i++) {
      if (trending.length < 12 && items[i].logo) {
        trending.push(i);
      }
      rest.push(i);
      var genre = entryGenre(items[i]);
      if (genre) {
        if (!buckets[genre.id]) {
          buckets[genre.id] = [];
        }
        if (buckets[genre.id].length < 14) {
          buckets[genre.id].push(i);
        }
      }
    }
    if (!trending.length) {
      trending = takeIndexes(rest, 12);
    }
    if (trending.length) {
      shelves.push({ title: "Em alta", indexes: trending });
    }
    for (i = 0; i < GENRES.length; i++) {
      var found = buckets[GENRES[i].id];
      if (found && found.length >= 3) {
        shelves.push({ title: GENRES[i].label, indexes: found });
      }
    }
    if (rest.length) {
      shelves.push({ title: "Mais filmes", indexes: takeIndexes(rest, 18) });
    }
    return shelves;
  }

  function renderMovieShelves() {
    var html = '<div class="modes">' + modeButtons() + "</div>";
    html += '<h1 class="shelf-title">Filmes</h1>';
    html += '<p class="status">' + esc(state.message) + "</p>";
    html += '<div id="list" class="poster-grid">';
    var resume = visibleContinue();
    var rowNum = resume.length ? 1 : 0;
    html += continueCards(0);
    var shelves = buildMovieShelves(state.items);
    var s;
    var n;
    for (s = 0; s < shelves.length; s++) {
      html += '<h2 class="row-label">' + esc(shelves[s].title) + "</h2>";
      for (n = 0; n < shelves[s].indexes.length; n++) {
        var itemIndex = shelves[s].indexes[n];
        html += posterButton(itemIndex, state.items[itemIndex], rowNum, n);
      }
      rowNum += 1;
    }
    html += "</div>";
    stage.innerHTML = html;
  }

  function renderCatalog() {
    var html = '<div class="modes">' + modeButtons() + "</div>";
    html += '<div class="brand-bar"><img src="' + state.catalog.image + '" alt=""><strong>' + esc(state.catalog.name) + "</strong></div>";
    if (!state.seriesKey) {
      html += '<input id="catalog-search" class="focusable" data-col="1" data-action="catalog-search" data-row="0" data-slot="0" type="text" inputmode="search" enterkeyhint="search" autocomplete="off" placeholder="Buscar em ' + esc(state.catalog.name) + '" value="' + esc(state.query) + '">';
    }
    html += '<p class="status">' + esc(state.message) + "</p>";
    if (state.seriesTitle) {
      html += '<h1 class="shelf-title">' + esc(state.seriesTitle) + "</h1>";
    }
    html += '<div id="list" class="poster-grid">';
    var resume = state.query || state.seriesKey ? [] : visibleContinue();
    var rowNum = 1;
    if (resume.length) {
      html += continueCards(rowNum);
      rowNum += 1;
    }
    var episodeIndexes = [];
    var episode;
    for (episode = 0; episode < state.items.length; episode++) {
      episodeIndexes.push(episode);
    }
    var shelves = state.seriesKey ? [{ title: "Episódios", indexes: episodeIndexes }] : (state.query ? [{ title: "Resultados", indexes: episodeIndexes }] : buildShelves(state.items));
    var s;
    var n;
    for (s = 0; s < shelves.length; s++) {
      html += '<h2 class="row-label">' + esc(shelves[s].title) + "</h2>";
      for (n = 0; n < shelves[s].indexes.length; n++) {
        var itemIndex = shelves[s].indexes[n];
        html += posterButton(itemIndex, state.items[itemIndex], rowNum, n);
      }
      rowNum += 1;
    }
    html += "</div>";
    stage.innerHTML = html;
    var field = document.getElementById("catalog-search");
    if (field) {
      field.oninput = function () {
        state.draftQuery = field.value;
      };
    }
  }

  function posterButton(index, entry, row, slot) {
    var label = entry.title || entry.series_title || "Sem título";
    if (entry.season_number || entry.episode_number) {
      label = "T" + (entry.season_number || "?") + " E" + (entry.episode_number || "?");
    }
    var art = "<b>" + esc((label || "?").charAt(0)) + "</b>";
    if (entry.logo) {
      art = '<img src="' + esc(entry.logo) + '" alt="" onerror="this.style.visibility=\'hidden\'">';
    }
    return '<button type="button" class="poster focusable" data-col="1" data-action="play" data-index="' + index + '" data-row="' + row + '" data-slot="' + slot + '">' + art + "<span>" + esc(label) + "</span></button>";
  }

  function renderBrowse() {
    var modes = "";
    var i;
    for (i = 0; i < MODES.length; i++) {
      var current = MODES[i].id === state.kind && MODES[i].id !== "search" ? " current" : "";
      modes += '<button type="button" class="mode focusable' + current + '" data-col="2" data-action="mode" data-kind="' + MODES[i].id + '">' + esc(MODES[i].label) + "</button>";
    }
    var side = "";
    var sideTitle = "Grupos";
    if (state.seriesKey) {
      sideTitle = "Temporadas";
      side += sideButton("season", "Todas", 'data-season=""');
      for (i = 0; i < state.seasons.length; i++) {
        var season = state.seasons[i].season || "";
        side += sideButton("season", "Temporada " + season, 'data-season="' + esc(season) + '"');
      }
    } else {
      side += sideButton("group", "Todos", 'data-group=""');
      for (i = 0; i < state.groups.length; i++) {
        side += sideButton("group", state.groups[i], 'data-group="' + esc(state.groups[i]) + '"');
      }
    }
    var items = "";
    var resume = state.kind === "movies" ? visibleContinue() : [];
    if (resume.length) {
      items += '<p class="row-label">Continuar assistindo</p>';
      for (i = 0; i < resume.length; i++) {
        var saved = resume[i];
        var minutes = Math.floor(saved.position / 60);
        items += '<button type="button" class="row focusable" data-col="1" data-action="resume" data-resume="' + i + '"><i>▶</i><span>Continuar · ' + minutes + " min · " + esc(saved.title) + "</span></button>";
      }
    }
    for (i = 0; i < state.items.length; i++) {
      var entry = state.items[i];
      var label = entry.title || entry.series_title || "Sem título";
      if (entry.season_number || entry.episode_number) {
        label = "T" + (entry.season_number || "?") + " E" + (entry.episode_number || "?") + "  " + label;
      }
      items += itemButton(i, label, entry.logo || "");
    }
    if (state.hasMore) {
      items += '<button type="button" class="row focusable" data-col="1" data-action="more" data-index="more"><i>+</i><span>Mais títulos</span></button>';
    }
    var heading = state.seriesTitle || (state.query ? "Busca: " + state.query : (state.group || "Todos"));
    var html = '<div class="modes">' + modes + "</div>";
    html += '<p class="status">' + esc(state.message) + "</p>";
    html += '<div class="panes">';
    html += '<div class="col-groups"><div class="col-head">' + esc(sideTitle) + '</div><div id="groups">' + side + "</div></div>";
    html += '<div class="col-info"><div class="col-head">Agora</div><div id="info-poster"></div><strong id="info-title"></strong><small id="info-group"></small><span id="info-help">OK para reproduzir</span></div>';
    html += '<div class="col-items"><div class="col-head">' + esc(heading) + '</div><div id="list">' + items + "</div></div>";
    html += "</div>";
    stage.innerHTML = html;
  }

  function sideButton(action, label, extra) {
    return '<button type="button" class="row focusable" data-col="0" data-action="' + action + '" ' + extra + '><i>' + esc((label || "?").charAt(0)) + "</i><span>" + esc(label) + "</span></button>";
  }

  function itemButton(index, label, logo) {
    var mark = "<i>" + esc((label || "?").charAt(0)) + "</i>";
    if (logo) {
      mark = '<img src="' + esc(logo) + '" alt="" onerror="this.style.visibility=\'hidden\'">';
    }
    return '<button type="button" class="row focusable" data-col="1" data-action="play" data-index="' + index + '">' + mark + "<span>" + esc(label) + "</span></button>";
  }

  function renderSearch() {
    var html = state.catalog ? "<h1>Buscar em " + esc(state.catalog.name) + "</h1>" : "<h1>Buscar na playlist</h1>";
    html += '<p class="status">' + (state.catalog ? "A busca fica só neste streaming." : "O teclado abre no celular quando este campo está selecionado.") + "</p>";
    html += '<input id="title-search" class="focusable" data-action="query-field" type="text" inputmode="search" enterkeyhint="search" autocomplete="off" placeholder="' + (state.catalog ? "Título em " + esc(state.catalog.name) : "Digite o título") + '" value="' + esc(state.draftQuery) + '">';
    html += '<div>' + searchAction("Limpar", "query-clear") + searchAction("Buscar", "query-go") + "</div>";
    stage.innerHTML = html;
    var field = document.getElementById("title-search");
    if (field) {
      field.oninput = function () {
        state.draftQuery = field.value;
      };
    }
  }

  function focusSearchField() {
    if (state.screen !== "search") {
      return;
    }
    var field = document.getElementById("title-search");
    if (!field) {
      return;
    }
    state.searchIndex = 0;
    paint();
    field.focus();
  }

  function readSearchField() {
    var field = document.getElementById("title-search");
    if (field) {
      state.draftQuery = field.value;
    }
  }

  function focusCatalogSearch() {
    var field = document.getElementById("catalog-search");
    if (!field) {
      return;
    }
    state.column = "1";
    var nodes = columnNodes("1");
    var i;
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i] === field) {
        state.itemIndex = i;
      }
    }
    paint();
    field.focus();
  }

  function submitCatalogSearch() {
    var field = document.getElementById("catalog-search");
    if (field) {
      state.draftQuery = field.value;
    }
    state.query = String(state.draftQuery || "").replace(/^\s+|\s+$/g, "");
    state.seriesKey = "";
    state.seriesTitle = "";
    state.seasons = [];
    state.season = "";
    state.itemIndex = 0;
    state.column = "1";
    loadStreamerCatalog();
  }

  function submitSearch() {
    readSearchField();
    state.query = state.draftQuery.replace(/^\s+|\s+$/g, "");
    state.group = "";
    state.groupIndex = 0;
    state.seriesKey = "";
    state.season = "";
    state.offset = 0;
    state.itemIndex = 0;
    state.screen = "browse";
    state.column = "1";
    loadItems(false);
  }

  function searchAction(label, action) {
    return '<button type="button" class="pager focusable" data-action="' + action + '">' + esc(label) + "</button>";
  }

  function moveSearch(direction) {
    var field = document.getElementById("title-search");
    var nodes = stage.querySelectorAll(".focusable");
    if (!nodes.length) {
      return;
    }
    if (field && document.activeElement === field && direction !== "down") {
      return;
    }
    var index = state.searchIndex;
    if (direction === "down") {
      index += 1;
    }
    if (direction === "up") {
      index -= 1;
    }
    if (direction === "right") {
      index += 1;
    }
    if (direction === "left") {
      index -= 1;
    }
    if (index < 0) {
      index = 0;
    }
    if (index >= nodes.length) {
      index = nodes.length - 1;
    }
    state.searchIndex = index;
    paint();
    if (nodes[index] && nodes[index].focus) {
      nodes[index].focus();
    }
  }

  function activate(target) {
    if (!target || !target.getAttribute) {
      return;
    }
    var action = target.getAttribute("data-action");
    if (action === "resume") {
      var savedItems = visibleContinue();
      var saved = savedItems[Number(target.getAttribute("data-resume"))] || null;
      if (saved) {
        if (saved.catalogId) {
          state.catalog = streamerById(saved.catalogId) || state.catalog;
        }
        play({
          url: saved.url,
          title: saved.title,
          logo: saved.logo,
          group: saved.group || "",
          category: saved.category || saved.kind,
          media_kind: saved.mediaKind || "",
          kind: saved.kind,
          catalogId: saved.catalogId || ""
        });
      }
      return;
    }
    if (action === "catalog") {
      openCatalog(target.getAttribute("data-catalog"));
      return;
    }
    if (action === "mode") {
      selectKind(target.getAttribute("data-kind"), false);
      return;
    }
    if (action === "group" || action === "season") {
      state.column = "0";
      applySideSelection();
      return;
    }
    if (action === "more") {
      loadItems(true);
      return;
    }
    if (action === "play") {
      play(state.items[Number(target.getAttribute("data-index"))] || {});
      return;
    }
    if (action === "query-field") {
      focusSearchField();
      return;
    }
    if (action === "catalog-search") {
      focusCatalogSearch();
      return;
    }
    if (action === "query-clear") {
      state.draftQuery = "";
      state.searchIndex = 0;
      render();
      return;
    }
    if (action === "query-go") {
      submitSearch();
    }
  }

  document.addEventListener("click", function (event) {
    var node = event.target;
    while (node && node !== document && !(node.getAttribute && node.getAttribute("data-action"))) {
      node = node.parentNode;
    }
    if (!node || node === document) {
      return;
    }
    if (state.screen !== "search" && node.getAttribute("data-col")) {
      state.column = node.getAttribute("data-col");
      var nodes = columnNodes(state.column);
      var i;
      for (i = 0; i < nodes.length; i++) {
        if (nodes[i] === node) {
          setColumnIndex(state.column, i);
        }
      }
    }
    activate(node);
  });

  document.addEventListener("keydown", function (event) {
    var code = event.keyCode || event.which;
    if (code === 461 || code === 10009 || code === 27 || code === 8) {
      var typingField = document.getElementById("title-search") || document.getElementById("catalog-search");
      if (code === 8 && typingField && document.activeElement === typingField) {
        return;
      }
      event.preventDefault();
      goBack();
      return;
    }
    if (code === 415 || code === 19 || code === 10252) {
      event.preventDefault();
      togglePlayback();
      return;
    }
    if (document.body.className.indexOf("playing") !== -1) {
      event.preventDefault();
      return;
    }
    if (code === 37 || code === 38 || code === 39 || code === 40) {
      var searchField = document.getElementById("title-search") || document.getElementById("catalog-search");
      if (searchField && document.activeElement === searchField && code !== 40) {
        return;
      }
      if (code === 40 && searchField && document.activeElement === searchField && searchField.blur) {
        searchField.blur();
      }
      event.preventDefault();
      if (code === 37) {
        move("left");
      } else if (code === 39) {
        move("right");
      } else if (code === 38) {
        move("up");
      } else {
        move("down");
      }
      return;
    }
    if (code === 13 || code === 23 || code === 29443 || code === 65376) {
      event.preventDefault();
      if (state.screen === "search") {
        submitSearch();
        return;
      }
      var catalogField = document.getElementById("catalog-search");
      if (catalogField && document.activeElement === catalogField) {
        submitCatalogSearch();
        return;
      }
      activateCurrent();
    }
  });

  window.__tvStopFromAndroid = function () {
    state.stoppingFromAndroid = true;
    stopPlayback();
    state.stoppingFromAndroid = false;
    render();
  };

  try {
    if (window.tizen && window.tizen.tvinputdevice && window.tizen.tvinputdevice.registerKey) {
      var remoteKeys = ["Exit", "MediaPlay", "MediaPause", "MediaPlayPause"];
      var keyIndex;
      for (keyIndex = 0; keyIndex < remoteKeys.length; keyIndex++) {
        try {
          window.tizen.tvinputdevice.registerKey(remoteKeys[keyIndex]);
        } catch (ignoreKey) {}
      }
    }
  } catch (ignore) {}

  document.body.focus();
  loadItems(false);
})();

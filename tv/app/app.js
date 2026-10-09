(function () {
  var API_BASE = "https://app.streamcorsario.com";
  var stage = document.querySelector("#stage");
  var hint = document.querySelector("#hint");
  var hudTitle = document.querySelector("#hud-title");
  var hudStatus = document.querySelector("#hud-status");
  var video = document.querySelector("#player");
  var avObject = document.querySelector("#av-player");
  var lastNav = 0;
  var groupTimer = 0;
  var modeTimer = 0;
  var loadToken = 0;
  var failing = false;
  var scrollTops = { groups: 0, list: 0 };
  var MODES = [
    { id: "tv", label: "Ao vivo" },
    { id: "movies", label: "Filmes" },
    { id: "series", label: "Séries" },
    { id: "search", label: "Buscar" }
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

  function paint() {
    var cols = ["0", "1", "2"];
    var c, i, nodes, index;
    for (c = 0; c < cols.length; c++) {
      nodes = columnNodes(cols[c]);
      index = columnIndex(cols[c]);
      if (index >= nodes.length) {
        index = nodes.length - 1;
      }
      if (index < 0) {
        index = 0;
      }
      setColumnIndex(cols[c], index);
      for (i = 0; i < nodes.length; i++) {
        if (i === index && state.column === cols[c]) {
          nodes[i].setAttribute("data-selected", "1");
        } else {
          nodes[i].removeAttribute("data-selected");
        }
      }
      if (nodes[index] && state.column === cols[c]) {
        ensureVisible(nodes[index]);
      }
    }
    updateInfo();
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
    titleNode.innerHTML = esc(title);
    groupNode.innerHTML = esc(entry.group || state.group || "");
    if (entry.logo) {
      var img = document.createElement("img");
      img.alt = "";
      img.src = entry.logo;
      img.onerror = function () { poster.innerHTML = esc(title.charAt(0) || "•"); };
      poster.appendChild(img);
    } else {
      poster.innerHTML = esc(title.charAt(0) || "•");
    }
  }

  function move(direction) {
    if (state.screen === "search") {
      moveSearch(direction);
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
        state.column = "0";
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

  function scheduleModeLoad() {
    clearTimeout(modeTimer);
    modeTimer = setTimeout(function () {
      var tabs = columnNodes("2");
      var tab = tabs[state.modeIndex];
      if (!tab) {
        return;
      }
      selectKind(tab.getAttribute("data-kind"), true);
    }, 250);
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
    if (kind === state.kind && !state.seriesKey && !state.query && state.groups.length) {
      return;
    }
    state.kind = kind;
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
    groupTimer = setTimeout(applySideSelection, 250);
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
    var token = ++loadToken;
    var requestOffset = append ? state.offset : 0;
    if (!append) {
      state.message = "Carregando a programação...";
      render();
    }
    api("/api/playlist/preloaded", {
      method: "POST",
      body: {
        category: state.kind,
        group: state.seriesKey ? "" : state.group,
        query: state.query,
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

  function playUrl(url) {
    failing = false;
    document.body.className = "playing";
    hudTitle.innerHTML = esc(state.playingTitle);
    hudStatus.innerHTML = "Conectando...";
    if (avObject) {
      avObject.style.width = (window.innerWidth || 1920) + "px";
      avObject.style.height = (window.innerHeight || 1080) + "px";
    }
    var nativePlayer = window.AndroidPlayer;
    if (nativePlayer && nativePlayer.play) {
      nativePlayer.play(url);
      hudStatus.innerHTML = "Reproduzindo";
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
            hudStatus.innerHTML = "Carregando vídeo...";
          },
          onbufferingprogress: function () {},
          onbufferingcomplete: function () {
            hudStatus.innerHTML = "Reproduzindo";
          },
          oncurrentplaytime: function () {},
          onstreamcompleted: function () {
            hudStatus.innerHTML = "Fim do vídeo";
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
            hudStatus.innerHTML = "Reproduzindo";
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
    document.body.className = "playing use-video";
    hudStatus.innerHTML = "Abrindo player...";
    video.onerror = function () {
      failPlayback("A TV não conseguiu reproduzir este título.");
    };
    video.src = url;
    var started = video.play();
    if (started && typeof started.then === "function") {
      started.then(function () {
        hudStatus.innerHTML = "Reproduzindo";
      }, function () {
        failPlayback("A TV não conseguiu reproduzir este título.");
      });
    }
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
    document.body.className = "";
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
    rememberScroll();
    if (state.screen === "search") {
      renderSearch();
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
    hint.innerHTML = "No topo, esquerda e direita mudam Ao vivo, Filmes, Séries e Buscar · Para baixo entra na lista · OK reproduz";
    if (state.screen === "search") {
      paintSearch();
    } else {
      paint();
    }
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
    var letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ";
    var keys = "";
    var i;
    for (i = 0; i < letters.length; i++) {
      var letter = letters.charAt(i);
      var shown = letter === " " ? "␣" : letter;
      keys += '<button type="button" class="key focusable" data-action="letter" data-key="' + esc(letter) + '">' + shown + "</button>";
    }
    var html = "<h1>Buscar na playlist</h1>";
    html += '<div class="query">' + esc(state.draftQuery || " ") + "</div>";
    html += keys;
    html += '<div>' + searchAction("Apagar", "query-back") + searchAction("Limpar", "query-clear") + searchAction("Buscar", "query-go") + "</div>";
    stage.innerHTML = html;
  }

  function searchAction(label, action) {
    return '<button type="button" class="pager focusable" data-action="' + action + '">' + esc(label) + "</button>";
  }

  function paintSearch() {
    var nodes = stage.querySelectorAll(".focusable");
    var i;
    if (state.searchIndex >= nodes.length) {
      state.searchIndex = nodes.length - 1;
    }
    if (state.searchIndex < 0) {
      state.searchIndex = 0;
    }
    for (i = 0; i < nodes.length; i++) {
      if (i === state.searchIndex) {
        nodes[i].setAttribute("data-selected", "1");
      } else {
        nodes[i].removeAttribute("data-selected");
      }
    }
  }

  function moveSearch(direction) {
    var nodes = stage.querySelectorAll(".focusable");
    if (!nodes.length) {
      return;
    }
    var columns = 13;
    var index = state.searchIndex;
    if (direction === "left") {
      index -= 1;
    }
    if (direction === "right") {
      index += 1;
    }
    if (direction === "up") {
      index -= columns;
    }
    if (direction === "down") {
      index += columns;
    }
    if (index < 0) {
      index = 0;
    }
    if (index >= nodes.length) {
      index = nodes.length - 1;
    }
    state.searchIndex = index;
    paintSearch();
  }

  function activate(target) {
    if (!target || !target.getAttribute) {
      return;
    }
    var action = target.getAttribute("data-action");
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
    if (action === "letter") {
      state.draftQuery += target.getAttribute("data-key") || "";
      render();
      return;
    }
    if (action === "query-back") {
      state.draftQuery = state.draftQuery.slice(0, -1);
      render();
      return;
    }
    if (action === "query-clear") {
      state.draftQuery = "";
      render();
      return;
    }
    if (action === "query-go") {
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
      event.preventDefault();
      goBack();
      return;
    }
    if (document.body.className.indexOf("playing") !== -1) {
      event.preventDefault();
      return;
    }
    if (code === 37 || code === 38 || code === 39 || code === 40) {
      event.preventDefault();
      var now = Date.now();
      if (now - lastNav < 70) {
        return;
      }
      lastNav = now;
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
    if (code === 13 || code === 23 || code === 29443) {
      event.preventDefault();
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
      window.tizen.tvinputdevice.registerKey("Exit");
    }
  } catch (ignore) {}

  document.body.focus();
  loadItems(false);
})();

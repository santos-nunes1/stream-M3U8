(function () {
  var API_BASE = "https://app.streamcorsario.com";
  var stage = document.querySelector("#stage");
  var hint = document.querySelector("#hint");
  var hudTitle = document.querySelector("#hud-title");
  var video = document.querySelector("#player");
  var focusIndex = 0;
  var focusKey = "";
  var lastNav = 0;
  var state = {
    screen: "home",
    stack: ["home"],
    kind: "tv",
    group: "",
    query: "",
    seriesKey: "",
    offset: 0,
    total: 0,
    hasMore: false,
    groups: [],
    channels: [],
    message: "",
    draftQuery: "",
    activeStreamId: "",
    playingTitle: ""
  };

  var KIND_LABEL = { tv: "Ao vivo", movies: "Filmes", series: "Séries", all: "Busca" };

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      if (char === "&") return "&amp;";
      if (char === "<") return "&lt;";
      if (char === ">") return "&gt;";
      if (char === '"') return "&quot;";
      return "&#39;";
    });
  }

  function focusables() {
    return stage.querySelectorAll(".focusable");
  }

  function setFocus(index) {
    var items = focusables();
    if (!items.length) return;
    if (index < 0) index = 0;
    if (index >= items.length) index = items.length - 1;
    focusIndex = index;
    var i;
    for (i = 0; i < items.length; i++) items[i].className = items[i].className.replace(" focused", "");
    if (items[focusIndex].className.indexOf("focused") === -1) items[focusIndex].className += " focused";
    focusKey = items[focusIndex].getAttribute("data-focus") || "";
    ensureVisible(items[focusIndex]);
  }

  function restoreFocus() {
    var items = focusables();
    var index = 0;
    var i;
    if (focusKey) {
      for (i = 0; i < items.length; i++) {
        if (items[i].getAttribute("data-focus") === focusKey) {
          index = i;
          break;
        }
      }
    }
    setFocus(index);
  }

  function ensureVisible(el) {
    var parent = document.getElementById("list");
    if (!parent || !parent.contains(el)) return;
    var top = el.offsetTop;
    var bottom = top + el.offsetHeight;
    if (top < parent.scrollTop) parent.scrollTop = top > 12 ? top - 12 : 0;
    else if (bottom > parent.scrollTop + parent.clientHeight) parent.scrollTop = bottom - parent.clientHeight + 12;
  }

  function moveFocus(direction) {
    var items = focusables();
    if (!items.length) return;
    var current = items[focusIndex].getBoundingClientRect();
    var cx = current.left + current.width / 2;
    var cy = current.top + current.height / 2;
    var best = -1;
    var bestScore = 1e15;
    var i;
    for (i = 0; i < items.length; i++) {
      if (i === focusIndex) continue;
      var rect = items[i].getBoundingClientRect();
      var dx = rect.left + rect.width / 2 - cx;
      var dy = rect.top + rect.height / 2 - cy;
      if (direction === "left" && dx >= -8) continue;
      if (direction === "right" && dx <= 8) continue;
      if (direction === "up" && dy >= -8) continue;
      if (direction === "down" && dy <= 8) continue;
      var primary = direction === "left" || direction === "right" ? Math.abs(dx) : Math.abs(dy);
      var secondary = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
      var score = primary + secondary * 3;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best >= 0) setFocus(best);
  }

  function openScreen(name) {
    state.stack.push(name);
    state.screen = name;
    focusKey = "";
    render();
  }

  function goBack() {
    if (document.body.className.indexOf("playing") !== -1) {
      stopPlayback();
      render();
      return;
    }
    if (state.stack.length > 1) {
      state.stack.pop();
      state.screen = state.stack[state.stack.length - 1];
      focusKey = "";
      render();
    }
  }

  function api(path, options, done) {
    var xhr = new XMLHttpRequest();
    var method = options && options.method ? options.method : "GET";
    var finished = false;
    var timer = setTimeout(function () {
      if (finished) return;
      finished = true;
      try { xhr.abort(); } catch (ignore) {}
      done(new Error("O serviço não respondeu."));
    }, 30000);
    xhr.open(method, API_BASE + path, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4 || finished) return;
      finished = true;
      clearTimeout(timer);
      var payload = {};
      try { payload = JSON.parse(xhr.responseText || "{}"); } catch (ignore) {}
      if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 202) done(null, payload);
      else done(new Error((payload && payload.error) || "O serviço não respondeu."));
    };
    xhr.onerror = function () {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done(new Error("Sem conexão com o servidor."));
    };
    xhr.send(options && options.body ? JSON.stringify(options.body) : null);
  }

  function loadCatalog() {
    state.message = "Carregando a programação...";
    state.screen = "channels";
    if (state.stack[state.stack.length - 1] !== "channels") state.stack.push("channels");
    render();
    api("/api/playlist/preloaded", {
      method: "POST",
      body: {
        category: state.kind,
        group: state.group,
        query: state.query,
        series_key: state.seriesKey,
        offset: state.offset,
        limit: 40
      }
    }, function (error, payload) {
      if (error) {
        state.message = error.message;
        render();
        return;
      }
      if (payload.status === "loading") {
        state.message = payload.message || "A playlist ainda está carregando no servidor.";
        render();
        return;
      }
      state.groups = payload.groups || [];
      state.channels = payload.series_groups && payload.series_groups.length ? payload.series_groups : payload.entries || [];
      state.total = payload.total || 0;
      state.hasMore = !!payload.has_more;
      state.message = state.channels.length ? (state.total ? state.total + " títulos" : "") : "Nada encontrado.";
      render();
    });
  }

  function play(entry) {
    if (entry.series_key && !entry.url) {
      state.seriesKey = entry.series_key;
      state.offset = 0;
      state.query = "";
      focusKey = "";
      loadCatalog();
      return;
    }
    if (!entry.url || entry.locked) {
      state.message = entry.locked_reason || "Este conteúdo não está liberado.";
      render();
      return;
    }
    state.message = "Abrindo no servidor...";
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
      state.playingTitle = entry.title || entry.series_title || "Reproduzindo";
      var playbackUrl = (payload && payload.local_proxy_url) || "";
      if (playbackUrl && playbackUrl.charAt(0) === "/") playbackUrl = API_BASE + playbackUrl;
      playUrl(playbackUrl);
    });
  }

  function playerApi() {
    var bridge = window.webapis;
    if (bridge && bridge.avplay) return bridge.avplay;
    return null;
  }

  function androidPlayer() {
    return window.AndroidPlayer || null;
  }

  function playUrl(url) {
    document.body.className = "playing";
    hudTitle.innerHTML = esc(state.playingTitle);
    var nativePlayer = androidPlayer();
    if (nativePlayer && nativePlayer.play) {
      nativePlayer.play(url);
      return;
    }
    var av = playerApi();
    if (av) {
      try {
        try { av.stop(); } catch (ignore) {}
        try { av.close(); } catch (ignore) {}
        av.open(url);
        av.setListener({ onerror: function () { playWithVideo(url); } });
        av.setDisplayRect(0, 0, window.innerWidth, window.innerHeight);
        av.prepareAsync(function () { av.play(); }, function () { playWithVideo(url); });
        return;
      } catch (ignore) {}
    }
    playWithVideo(url);
  }

  function playWithVideo(url) {
    video.src = url;
    var started = video.play();
    if (started && typeof started.then === "function") started.then(function () {}, function () {});
  }

  function stopPlayback() {
    document.body.className = "";
    var nativePlayer = androidPlayer();
    if (nativePlayer && nativePlayer.stop && !state.stoppingFromAndroid) nativePlayer.stop();
    var av = playerApi();
    if (av) {
      try { av.stop(); } catch (ignore) {}
      try { av.close(); } catch (ignore) {}
    }
    video.removeAttribute("src");
    try { video.load(); } catch (ignore) {}
    if (state.activeStreamId) {
      api("/stream/stop", { method: "POST", body: { stream_id: state.activeStreamId } }, function () {});
      state.activeStreamId = "";
    }
  }

  function render() {
    if (state.screen === "home") renderHome();
    else if (state.screen === "channels") renderChannels();
    else if (state.screen === "search") renderSearch();
    hint.innerHTML = document.body.className.indexOf("playing") !== -1
      ? "Voltar para parar"
      : "Setas para mover · OK para escolher · Voltar para retornar";
    restoreFocus();
  }

  function renderHome() {
    stage.innerHTML = '<span class="kicker">Escolha o conteúdo</span>'
      + "<h1>O que vamos assistir?</h1>"
      + '<p class="status">' + esc(state.message) + "</p>"
      + card("Ao vivo", "Canais de TV", "kind", 'data-kind="tv"', "kind-tv")
      + card("Filmes", "Catálogo de filmes", "kind", 'data-kind="movies"', "kind-movies")
      + card("Séries", "Temporadas e episódios", "kind", 'data-kind="series"', "kind-series")
      + card("Buscar", "Teclado na tela", "search", "", "search-open");
  }

  function card(title, subtitle, action, extra, key) {
    return '<button type="button" class="focusable home-card" data-action="' + action + '" data-focus="' + key + '" ' + extra + ">"
      + "<strong>" + esc(title) + "</strong><small>" + esc(subtitle) + "</small></button>";
  }

  function renderSearch() {
    var letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    var keys = "";
    var i;
    for (i = 0; i < letters.length; i++) {
      var letter = letters.charAt(i);
      keys += '<button type="button" class="focusable key" data-action="letter" data-key="' + letter + '" data-focus="key-' + letter + '">' + letter + "</button>";
    }
    stage.innerHTML = '<span class="kicker">Busca</span><h1>Digite o título</h1>'
      + '<div class="query">' + esc(state.draftQuery || " ") + "</div>"
      + keys
      + '<div>' + actionBtn("Apagar", "query-back") + actionBtn("Limpar", "query-clear") + actionBtn("Buscar", "query-go") + "</div>";
  }

  function actionBtn(label, action) {
    return '<button type="button" class="focusable pager" data-action="' + action + '" data-focus="' + action + '">' + esc(label) + "</button>";
  }

  function renderChannels() {
    var title = state.query ? "Busca: " + state.query : (KIND_LABEL[state.kind] || "Programação");
    var groups = "";
    var i;
    if (!state.seriesKey) {
      for (i = 0; i < state.groups.length && i < 16; i++) {
        groups += '<button type="button" class="focusable chip" data-action="group" data-group="' + esc(state.groups[i]) + '" data-focus="group-' + i + '">' + esc(state.groups[i]) + "</button>";
      }
    }
    var channels = "";
    for (i = 0; i < state.channels.length; i++) {
      var channel = state.channels[i];
      var label = channel.title || channel.series_title || "Sem título";
      channels += '<button type="button" class="focusable channel" data-action="play" data-index="' + i + '" data-focus="ch-' + i + '">' + esc(label) + "</button>";
    }
    var pager = "";
    if (state.offset > 0) pager += actionBtn("Anterior", "page-prev");
    if (state.hasMore) pager += actionBtn("Próxima", "page-next");
    stage.innerHTML = '<span class="kicker">Programação</span><h1>' + esc(title) + "</h1>"
      + '<p class="status">' + esc(state.message) + "</p>"
      + "<div>" + groups + "</div>"
      + '<div id="list">' + channels + "</div>"
      + "<div>" + pager + "</div>";
  }

  function activate(target) {
    if (!target || !target.getAttribute) return;
    var action = target.getAttribute("data-action");
    if (!action) return;
    if (action === "kind") {
      state.kind = target.getAttribute("data-kind");
      state.group = "";
      state.query = "";
      state.seriesKey = "";
      state.offset = 0;
      focusKey = "";
      loadCatalog();
    } else if (action === "group") {
      state.group = target.getAttribute("data-group");
      state.seriesKey = "";
      state.offset = 0;
      focusKey = "";
      loadCatalog();
    } else if (action === "page-prev") {
      state.offset = Math.max(0, state.offset - 40);
      focusKey = "page-prev";
      loadCatalog();
    } else if (action === "page-next") {
      state.offset += 40;
      focusKey = "page-next";
      loadCatalog();
    } else if (action === "search") {
      state.draftQuery = "";
      openScreen("search");
    } else if (action === "letter") {
      state.draftQuery += target.getAttribute("data-key") || "";
      focusKey = target.getAttribute("data-focus") || "";
      render();
    } else if (action === "query-back") {
      state.draftQuery = state.draftQuery.slice(0, -1);
      render();
    } else if (action === "query-clear") {
      state.draftQuery = "";
      render();
    } else if (action === "query-go") {
      state.query = state.draftQuery.replace(/^\s+|\s+$/g, "");
      state.group = "";
      state.seriesKey = "";
      state.offset = 0;
      state.kind = "all";
      focusKey = "";
      loadCatalog();
    } else if (action === "play") {
      play(state.channels[Number(target.getAttribute("data-index"))] || {});
    }
  }

  document.addEventListener("click", function (event) {
    var node = event.target;
    while (node && node !== document && !node.getAttribute("data-action")) node = node.parentNode;
    activate(node);
  });

  document.addEventListener("keydown", function (event) {
    var code = event.keyCode || event.which;
    if (code === 461 || code === 10009 || code === 27) {
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
      if (now - lastNav < 80) return;
      lastNav = now;
      if (code === 37) moveFocus("left");
      else if (code === 39) moveFocus("right");
      else if (code === 38) moveFocus("up");
      else moveFocus("down");
      return;
    }
    if (code === 13) {
      event.preventDefault();
      var items = focusables();
      if (items[focusIndex]) activate(items[focusIndex]);
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
  render();
})();

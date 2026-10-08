(function () {
  var API_BASE = "https://app.streamcorsario.com";
  var app = document.querySelector("#app");
  var video = document.querySelector("#player");
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
  };

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  }

  function button(label, action, extra) {
    return '<button class="focusable" data-action="' + action + '" ' + (extra || "") + ">" + esc(label) + "</button>";
  }

  function openScreen(name) {
    state.stack.push(name);
    state.screen = name;
    render();
  }

  function goBack() {
    if (document.body.classList.contains("playing")) {
      stopPlayback();
      render();
      return;
    }
    if (state.stack.length > 1) {
      state.stack.pop();
      state.screen = state.stack[state.stack.length - 1];
      render();
    }
  }

  async function api(path, options) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 30000);
    try {
      var response = await fetch(API_BASE + path, {
        method: options && options.method ? options.method : "GET",
        headers: { "Content-Type": "application/json" },
        body: options && options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      var payload = await response.json();
      if (!response.ok && response.status !== 202) throw new Error(payload.error || "O serviço não respondeu.");
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadCatalog() {
    state.message = "Carregando a programação...";
    render();
    try {
      var payload = await api("/api/playlist/preloaded", {
        method: "POST",
        body: {
          category: state.kind,
          group: state.group,
          query: state.query,
          series_key: state.seriesKey,
          offset: state.offset,
          limit: 40,
        },
      });
      if (payload.status === "loading") {
        state.message = payload.message || "A playlist ainda está carregando no servidor.";
        render();
        return;
      }
      state.groups = payload.groups || [];
      state.channels = payload.series_groups && payload.series_groups.length ? payload.series_groups : payload.entries || [];
      state.total = payload.total || 0;
      state.hasMore = Boolean(payload.has_more);
      state.message = state.channels.length ? "" : "Nada encontrado.";
      state.screen = "channels";
      if (state.stack[state.stack.length - 1] !== "channels") state.stack.push("channels");
    } catch (error) {
      state.message = error.name === "AbortError" ? "O serviço não respondeu." : error.message;
    }
    render();
  }

  async function play(entry) {
    if (entry.series_key && !entry.url) {
      state.seriesKey = entry.series_key;
      state.offset = 0;
      state.query = "";
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
    try {
      var payload = await api("/stream/start", {
        method: "POST",
        body: {
          stream_id: entry.url,
          title: entry.title || "",
          group: entry.group || "",
          category: entry.category || state.kind,
          media_kind: entry.media_kind || "",
        },
      });
      state.activeStreamId = entry.url;
      var playbackUrl = payload.local_proxy_url || "";
      if (playbackUrl && playbackUrl.charAt(0) === "/") playbackUrl = API_BASE + playbackUrl;
      playUrl(playbackUrl);
    } catch (error) {
      state.message = error.message;
      render();
    }
  }

  function playUrl(url) {
    document.body.classList.add("playing");
    if (window.AndroidPlayer && AndroidPlayer.play) {
      AndroidPlayer.play(url);
      return;
    }
    if (window.webapis && webapis.avplay) {
      try {
        var player = webapis.avplay;
        try { player.stop(); } catch (ignore) {}
        try { player.close(); } catch (ignore) {}
        player.open(url);
        player.setListener({ onerror: function () { playWithVideo(url); } });
        player.setDisplayRect(0, 0, window.innerWidth, window.innerHeight);
        player.prepareAsync(function () { player.play(); }, function () { playWithVideo(url); });
        return;
      } catch (ignore) {}
    }
    playWithVideo(url);
  }

  function playWithVideo(url) {
    video.src = url;
    var started = video.play();
    if (started && started.catch) started.catch(function () {});
  }

  function stopPlayback() {
    document.body.classList.remove("playing");
    if (window.AndroidPlayer && AndroidPlayer.stop && !state.stoppingFromAndroid) {
      AndroidPlayer.stop();
    }
    if (window.webapis && webapis.avplay) {
      try { webapis.avplay.stop(); } catch (ignore) {}
      try { webapis.avplay.close(); } catch (ignore) {}
    }
    video.removeAttribute("src");
    video.load();
    if (state.activeStreamId) {
      api("/stream/stop", { method: "POST", body: { stream_id: state.activeStreamId } }).catch(function () {});
      state.activeStreamId = "";
    }
  }

  function render() {
    if (state.screen === "home") renderHome();
    else if (state.screen === "channels") renderChannels();
    else if (state.screen === "search") renderSearch();
    var focusable = app.querySelector(".focusable");
    if (focusable) focusable.focus();
  }

  function renderHome() {
    app.innerHTML = "<h1>Stream Corsário</h1>"
      + '<p class="status">' + esc(state.message) + "</p>"
      + '<div class="grid">'
      + button("Ao vivo", "kind", 'data-kind="tv"')
      + button("Filmes", "kind", 'data-kind="movies"')
      + button("Séries", "kind", 'data-kind="series"')
      + button("Buscar", "search")
      + "</div>";
  }

  function renderSearch() {
    var letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");
    app.innerHTML = "<h1>Buscar</h1><p><strong>" + esc(state.draftQuery || " ") + "</strong></p>"
      + '<div class="keys">' + letters.map(function (letter) {
          return '<button class="key focusable" data-action="letter" data-key="' + letter + '">' + letter + "</button>";
        }).join("") + "</div>"
      + '<div class="actions">' + button("Apagar", "query-back") + button("Limpar", "query-clear") + button("Buscar", "query-go") + "</div>";
  }

  function renderChannels() {
    var groups = state.seriesKey ? "" : state.groups.slice(0, 16).map(function (group) {
      return '<button class="focusable" data-action="group" data-group="' + esc(group) + '">' + esc(group) + "</button>";
    }).join("");
    var channels = state.channels.map(function (channel, index) {
      var label = channel.title || channel.series_title || "Sem título";
      return '<button class="channel focusable" data-action="play" data-index="' + index + '">' + esc(label) + "</button>";
    }).join("");
    var pager = "";
    if (state.offset > 0) pager += button("Anterior", "page-prev");
    if (state.hasMore) pager += button("Próxima", "page-next");
    app.innerHTML = "<h1>" + esc(state.query ? "Busca: " + state.query : "Programação") + "</h1>"
      + '<p class="status">' + esc(state.message) + "</p>"
      + '<div class="actions">' + groups + "</div>"
      + '<div class="grid">' + channels + "</div>"
      + '<div class="actions">' + pager + "</div>";
  }

  document.addEventListener("click", onActivate);
  document.addEventListener("keydown", function (event) {
    var code = event.keyCode;
    if (event.key === "Backspace" && state.screen === "search") {
      event.preventDefault();
      state.draftQuery = state.draftQuery.slice(0, -1);
      render();
      return;
    }
    if (code === 461 || code === 10009 || event.key === "Escape" || event.key === "Backspace") {
      event.preventDefault();
      goBack();
    }
  });

  function onActivate(event) {
    var target = event.target.closest("[data-action]");
    if (!target) return;
    var action = target.dataset.action;
    if (action === "kind") {
      state.kind = target.dataset.kind;
      state.group = "";
      state.query = "";
      state.seriesKey = "";
      state.offset = 0;
      loadCatalog();
    }
    if (action === "group") {
      state.group = target.dataset.group;
      state.seriesKey = "";
      state.offset = 0;
      loadCatalog();
    }
    if (action === "page-prev") {
      state.offset = Math.max(0, state.offset - 40);
      loadCatalog();
    }
    if (action === "page-next") {
      state.offset += 40;
      loadCatalog();
    }
    if (action === "search") {
      state.draftQuery = "";
      openScreen("search");
    }
    if (action === "letter") {
      state.draftQuery += target.dataset.key;
      render();
    }
    if (action === "query-back") {
      state.draftQuery = state.draftQuery.slice(0, -1);
      render();
    }
    if (action === "query-clear") {
      state.draftQuery = "";
      render();
    }
    if (action === "query-go") {
      state.query = state.draftQuery.trim();
      state.group = "";
      state.seriesKey = "";
      state.offset = 0;
      state.kind = "all";
      loadCatalog();
    }
    if (action === "play") play(state.channels[Number(target.dataset.index)] || {});
  }

  window.__tvStopFromAndroid = function () {
    state.stoppingFromAndroid = true;
    stopPlayback();
    state.stoppingFromAndroid = false;
  };

  render();
})();

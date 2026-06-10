const ADMIN_TOKEN_STORAGE_KEY = "streamM3U8AdminToken";

const els = {
  loginPanel: document.querySelector("#monitoring-login-panel"),
  panel: document.querySelector("#monitoring-panel"),
  loginForm: document.querySelector("#monitoring-login-form"),
  token: document.querySelector("#monitoring-token"),
  loginMessage: document.querySelector("#monitoring-login-message"),
  updated: document.querySelector("#monitoring-updated"),
  summary: document.querySelector("#monitoring-summary"),
  onlineUsersList: document.querySelector("#online-users-list"),
  topContentList: document.querySelector("#top-content-list"),
  recentEventsList: document.querySelector("#recent-events-list"),
  refresh: document.querySelector("#monitoring-refresh"),
  logout: document.querySelector("#monitoring-logout"),
};

let adminToken = sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || "";
let monitoringTimer = null;

function adminHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Admin-Token": adminToken,
  };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...adminHeaders(),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Nao foi possivel concluir a operacao.");
  }
  return data;
}

function setMessage(element, text, type = "") {
  element.hidden = false;
  element.textContent = text;
  element.className = `auth-message ${type}`.trim();
}

function showLogin() {
  els.loginPanel.hidden = false;
  els.panel.hidden = true;
  stopRefresh();
}

function showPanel() {
  els.loginPanel.hidden = true;
  els.panel.hidden = false;
  startRefresh();
}

function startRefresh() {
  stopRefresh();
  monitoringTimer = setInterval(() => {
    loadMonitoring().catch(() => undefined);
  }, 30000);
}

function stopRefresh() {
  if (monitoringTimer) {
    clearInterval(monitoringTimer);
    monitoringTimer = null;
  }
}

function formatDate(timestampSeconds) {
  if (!timestampSeconds) {
    return "-";
  }
  return new Date(timestampSeconds * 1000).toLocaleString("pt-BR");
}

async function loadMonitoring() {
  const monitoring = await requestJson("/api/admin/monitoring");
  renderMonitoring(monitoring);
}

function renderMonitoring(monitoring) {
  const summary = monitoring.summary || {};
  els.updated.textContent = `Atualizado em ${formatDate(monitoring.generated_at)}`;
  els.summary.innerHTML = `
    <div class="monitoring-stat">
      <strong>${Number(summary.online_users || 0)}</strong>
      <span>pessoa(s) online</span>
    </div>
    <div class="monitoring-stat">
      <strong>${Number(summary.online_sessions || 0)}</strong>
      <span>sessão(ões) ativas</span>
    </div>
    <div class="monitoring-stat">
      <strong>${Number(summary.recent_events || 0)}</strong>
      <span>evento(s) na última hora</span>
    </div>
  `;
  renderOnlineUsers(monitoring.online_users || []);
  renderTopContent(monitoring.top_content || []);
  renderRecentEvents(monitoring.recent_events || []);
}

function renderOnlineUsers(onlineUsers) {
  if (!onlineUsers.length) {
    els.onlineUsersList.className = "monitoring-list empty";
    els.onlineUsersList.textContent = "Nenhum usuário online.";
    return;
  }
  els.onlineUsersList.className = "monitoring-list";
  els.onlineUsersList.innerHTML = onlineUsers.map((session) => `
    <div class="monitoring-row">
      <strong>${escapeHtml(session.name || session.email || "Usuário")}</strong>
      <small>${escapeHtml(session.email || "")}</small>
      <small>${escapeHtml(session.ip_address || "")} | visto ${escapeHtml(formatDate(session.last_heartbeat))}</small>
    </div>
  `).join("");
}

function renderTopContent(items) {
  if (!items.length) {
    els.topContentList.className = "monitoring-list empty";
    els.topContentList.textContent = "Nenhum conteúdo acessado recentemente.";
    return;
  }
  els.topContentList.className = "monitoring-list";
  els.topContentList.innerHTML = items.map((item) => `
    <div class="monitoring-row">
      <strong>${escapeHtml(item.title || "Link direto")}</strong>
      <small>${Number(item.total || 0)} acesso(s) | ${escapeHtml(item.category || "sem categoria")}</small>
      <small>Último acesso: ${escapeHtml(formatDate(item.last_access_at))}</small>
    </div>
  `).join("");
}

function renderRecentEvents(events) {
  if (!events.length) {
    els.recentEventsList.className = "monitoring-list empty";
    els.recentEventsList.textContent = "Nenhum evento recente.";
    return;
  }
  els.recentEventsList.className = "monitoring-list";
  els.recentEventsList.innerHTML = events.map((event) => `
    <div class="monitoring-row event-row">
      <strong>${escapeHtml(eventLabel(event.event))}${event.title ? `: ${escapeHtml(event.title)}` : ""}</strong>
      <small>${escapeHtml(event.name || event.email || "Usuário desconhecido")} | ${escapeHtml(formatDate(event.created_at))}</small>
      <small>${escapeHtml([event.category, event.media_kind, event.playback_mode].filter(Boolean).join(" | "))}</small>
    </div>
  `).join("");
}

function eventLabel(event) {
  return {
    content_request: "Conteúdo solicitado",
    stream_start: "Stream iniciado",
    stream_stop: "Stream parado",
    vlc_open: "Player externo",
    vlc_proxy_request: "Proxy VLC",
    media_proxy_request: "Proxy mídia",
    auth_link_login: "Login",
    auth_login: "Login",
  }[event] || event || "Evento";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  adminToken = els.token.value.trim();
  sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, adminToken);
  try {
    await loadMonitoring();
    showPanel();
  } catch (error) {
    sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    setMessage(els.loginMessage, error.message, "error");
  }
});

els.refresh.addEventListener("click", () => {
  loadMonitoring().catch((error) => setMessage(els.loginMessage, error.message, "error"));
});

els.logout.addEventListener("click", () => {
  sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
  adminToken = "";
  showLogin();
});

if (adminToken) {
  loadMonitoring()
    .then(showPanel)
    .catch(() => showLogin());
} else {
  showLogin();
}

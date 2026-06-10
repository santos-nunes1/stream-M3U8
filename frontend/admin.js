const ADMIN_TOKEN_STORAGE_KEY = "streamM3U8AdminToken";

const els = {
  loginPanel: document.querySelector("#admin-login-panel"),
  adminPanel: document.querySelector("#admin-panel"),
  loginForm: document.querySelector("#admin-login-form"),
  token: document.querySelector("#admin-token"),
  loginMessage: document.querySelector("#admin-login-message"),
  form: document.querySelector("#user-form"),
  editingUserId: document.querySelector("#editing-user-id"),
  name: document.querySelector("#user-name"),
  email: document.querySelector("#user-email"),
  maxScreens: document.querySelector("#user-max-screens"),
  accessExpiresAt: document.querySelector("#user-access-expires-at"),
  allowAdult: document.querySelector("#user-allow-adult"),
  active: document.querySelector("#user-active"),
  saveUser: document.querySelector("#save-user"),
  cancelEdit: document.querySelector("#cancel-edit"),
  message: document.querySelector("#admin-message"),
  userFilter: document.querySelector("#user-filter"),
  usersList: document.querySelector("#users-list"),
  refresh: document.querySelector("#admin-refresh"),
  logout: document.querySelector("#admin-logout"),
};

let adminToken = sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || "";
let users = [];

function setMessage(element, text, type = "") {
  element.hidden = false;
  element.textContent = text;
  element.className = `auth-message ${type}`.trim();
}

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

function showLogin() {
  els.loginPanel.hidden = false;
  els.adminPanel.hidden = true;
}

function showAdmin() {
  els.loginPanel.hidden = true;
  els.adminPanel.hidden = false;
}

function defaultExpiryValue() {
  const value = new Date();
  value.setDate(value.getDate() + 30);
  return toDatetimeLocal(value.getTime() / 1000);
}

function toDatetimeLocal(timestampSeconds) {
  const date = new Date(Number(timestampSeconds || 0) * 1000);
  if (Number.isNaN(date.getTime())) {
    return defaultExpiryValue();
  }
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function fromDatetimeLocal(value) {
  return Math.floor(new Date(value).getTime() / 1000);
}

function formatDate(timestampSeconds) {
  if (!timestampSeconds) {
    return "-";
  }
  return new Date(timestampSeconds * 1000).toLocaleString("pt-BR");
}

function resetForm() {
  els.form.reset();
  els.editingUserId.value = "";
  els.maxScreens.value = "2";
  els.accessExpiresAt.value = defaultExpiryValue();
  els.active.checked = true;
  els.saveUser.textContent = "Criar usuário";
  els.cancelEdit.hidden = true;
}

function userPayload() {
  return {
    name: els.name.value.trim(),
    email: els.email.value.trim(),
    max_screens: Number(els.maxScreens.value || 1),
    access_expires_at: fromDatetimeLocal(els.accessExpiresAt.value),
    access_expires_in_days: Math.max(
      1,
      Math.ceil((fromDatetimeLocal(els.accessExpiresAt.value) - Date.now() / 1000) / 86400)
    ),
    allow_adult_content: els.allowAdult.checked,
    active: els.active.checked,
  };
}

async function loadUsers() {
  const data = await requestJson("/api/admin/users");
  users = data.users || [];
  renderUsers();
}

function renderUsers() {
  const query = normalizeSearch(els.userFilter.value);
  const filteredUsers = query
    ? users.filter((user) => normalizeSearch(`${user.name || ""} ${user.email || ""}`).includes(query))
    : users;

  if (!users.length) {
    els.usersList.className = "users-list empty";
    els.usersList.textContent = "Nenhum usuário cadastrado.";
    return;
  }

  if (!filteredUsers.length) {
    els.usersList.className = "users-list empty";
    els.usersList.textContent = "Nenhum usuário encontrado para esse filtro.";
    return;
  }

  els.usersList.className = "users-list";
  els.usersList.innerHTML = "";
  filteredUsers.forEach((user) => {
    const item = document.createElement("article");
    item.className = "user-row";
    item.innerHTML = `
      <div class="user-row-main">
        <strong>${escapeHtml(user.name || user.email)}</strong>
        <small>${escapeHtml(user.email)}</small>
        <input class="user-access-url" type="text" value="${escapeHtml(user.access_url || "")}" readonly />
        <small>
          ${user.active ? "Ativo" : "Inativo"} |
          ${user.max_screens} tela(s) |
          ${user.active_sessions || 0} sessao(oes) ativa(s) |
          adulto: ${user.allow_adult_content ? "sim" : "nao"} |
          expira: ${escapeHtml(formatDate(user.access_expires_at))}
        </small>
      </div>
      <div class="user-row-actions">
        <button class="ghost small-button" data-action="copy" type="button">Copiar link</button>
        <button class="ghost small-button" data-action="edit" type="button">Editar</button>
        <button class="ghost small-button" data-action="rotate" type="button">Novo link</button>
        <button class="danger small-button" data-action="delete" type="button">Remover</button>
      </div>
    `;
    item.querySelector('[data-action="copy"]').addEventListener("click", () => copyLink(user.access_url || ""));
    item.querySelector('[data-action="edit"]').addEventListener("click", () => editUser(user));
    item.querySelector('[data-action="rotate"]').addEventListener("click", () => rotateLink(user));
    item.querySelector('[data-action="delete"]').addEventListener("click", () => deleteUser(user));
    els.usersList.appendChild(item);
  });
}

function normalizeSearch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

async function copyLink(url) {
  await navigator.clipboard.writeText(url);
  setMessage(els.message, "Link copiado.", "ok");
}

function editUser(user) {
  els.editingUserId.value = user.id;
  els.name.value = user.name || "";
  els.email.value = user.email || "";
  els.maxScreens.value = user.max_screens || 1;
  els.accessExpiresAt.value = toDatetimeLocal(user.access_expires_at);
  els.allowAdult.checked = Boolean(user.allow_adult_content);
  els.active.checked = Boolean(user.active);
  els.saveUser.textContent = "Salvar alterações";
  els.cancelEdit.hidden = false;
  els.form.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function saveUser(event) {
  event.preventDefault();
  const userId = els.editingUserId.value;
  const payload = userPayload();
  try {
    if (userId) {
      await requestJson(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setMessage(els.message, "Usuário atualizado.", "ok");
    } else {
      const data = await requestJson("/api/admin/users", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setMessage(els.message, `Usuário criado. Link: ${data.user.access_url}`, "ok");
    }
    resetForm();
    await loadUsers();
  } catch (error) {
    setMessage(els.message, error.message, "error");
  }
}

async function rotateLink(user) {
  if (!confirm(`Gerar novo link para ${user.email}? O link anterior deixará de funcionar.`)) {
    return;
  }
  try {
    await requestJson(`/api/admin/users/${encodeURIComponent(user.id)}/rotate-link`, { method: "POST" });
    setMessage(els.message, "Novo link gerado.", "ok");
    await loadUsers();
  } catch (error) {
    setMessage(els.message, error.message, "error");
  }
}

async function deleteUser(user) {
  if (!confirm(`Remover ${user.email}? Esta acao encerra as sessoes desse usuario.`)) {
    return;
  }
  try {
    await requestJson(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
    setMessage(els.message, "Usuário removido.", "ok");
    await loadUsers();
  } catch (error) {
    setMessage(els.message, error.message, "error");
  }
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
    await loadUsers();
    showAdmin();
    resetForm();
  } catch (error) {
    sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    setMessage(els.loginMessage, error.message, "error");
  }
});

els.form.addEventListener("submit", saveUser);
els.cancelEdit.addEventListener("click", resetForm);
els.userFilter.addEventListener("input", renderUsers);
els.refresh.addEventListener("click", () => loadUsers().catch((error) => setMessage(els.message, error.message, "error")));
els.logout.addEventListener("click", () => {
  sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
  adminToken = "";
  users = [];
  els.usersList.innerHTML = "";
  showLogin();
});

resetForm();
if (adminToken) {
  loadUsers()
    .then(showAdmin)
    .catch(() => showLogin());
} else {
  showLogin();
}

const legacyToken = localStorage.getItem("callPortalToken");
const sessionToken = sessionStorage.getItem("callPortalToken");
const persistedToken = sessionToken || legacyToken || null;
if (legacyToken && !sessionToken) {
  sessionStorage.setItem("callPortalToken", legacyToken);
}
if (legacyToken) {
  localStorage.removeItem("callPortalToken");
}

const CALL_STATUS_OPTIONS = [
  ["NOT_CALLED", "Aranmadı"],
  ["CALLING", "Aranıyor"],
  ["CALLED", "Arandı"],
  ["UNREACHABLE", "Ulaşılamadı"],
  ["CALLBACK", "Tekrar aranacak"],
  ["COMPLETED", "Tamamlandı"],
];

const RESULT_STATUS_OPTIONS = [
  ["PENDING", "Beklemede"],
  ["POSITIVE", "Olumlu"],
  ["NEGATIVE", "Olumsuz"],
  ["NO_ANSWER", "Cevap yok"],
  ["WRONG_NUMBER", "Hatalı numara"],
  ["NOT_INTERESTED", "İlgilenmiyor"],
];

const REACH_STATUS_OPTIONS = [
  ["", "Tüm ulaşım durumları"],
  ["REACHED", "Ulaşıldı"],
  ["UNREACHED", "Ulaşılamadı"],
  ["FOLLOW_UP", "Tekrar takip"],
  ["UNKNOWN", "Belirsiz"],
];

const TRANSIENT_HTTP_STATUSES = new Set([502, 503, 504]);
const RETRY_DELAYS_MS = [650, 1400, 2600];

const DEFAULT_FILTERS = {
  q: "",
  call_status: "",
  result_status: "",
  assigned_user_id: "",
  unassigned: false,
  has_email: false,
  has_phone: false,
  has_address: false,
  has_website: false,
  due_callbacks: false,
};

const DEFAULT_CONTACT_POOL_FILTERS = {
  q: "",
  reach_status: "",
  result_status: "",
  active_only: true,
  current_list_only: false,
};

const state = {
  token: persistedToken,
  booting: true,
  me: null,
  lists: [],
  records: [],
  contactPool: [],
  operatorStats: [],
  operationSummary: null,
  filteredSummary: null,
  users: [],
  activity: [],
  offerNotifications: [],
  offerNotificationModalId: "",
  selectedListId: "",
  uploadFile: null,
  uploadListName: "",
  sidebarPanel: "",
  recordDrafts: {},
  pagination: {
    offset: 0,
    limit: 100,
    total: 0,
  },
  flash: null,
  pollingHandle: null,
  teamModalOpen: false,
  listsModalOpen: false,
  contactPoolModalOpen: false,
  operatorControlModalOpen: false,
  operatorDetailUserId: "",
  operatorDetailFilter: "all",
  operatorDetailRecords: [],
  operatorDetailSummary: null,
  operatorDetailPagination: {
    offset: 0,
    limit: 25,
    total: 0,
  },
  filters: { ...DEFAULT_FILTERS },
  contactPoolFilters: { ...DEFAULT_CONTACT_POOL_FILTERS },
  assignStrategy: "equal",
  assignMode: "unassigned",
  assignDrafts: {},
  contactPoolDrafts: {},
  contactPoolPagination: {
    offset: 0,
    limit: 25,
    total: 0,
  },
  lastSyncAt: null,
  lastSyncSource: "",
  liveRefreshCount: 0,
};

const appNode = document.querySelector("#app");
const interactionState = {
  lastUserInteractionAt: 0,
  globalActivityBound: false,
  deferredRenderHandle: null,
};

document.addEventListener(
  "error",
  (event) => {
    const target = event.target;
    if (target instanceof HTMLImageElement && target.classList.contains("brand-logo")) {
      target.closest(".brand-mark")?.classList.add("logo-missing");
    }
  },
  true,
);

function noteUserInteraction() {
  interactionState.lastUserInteractionAt = Date.now();
}

function bindGlobalActivityListeners() {
  if (interactionState.globalActivityBound) return;
  interactionState.globalActivityBound = true;
  const handler = () => noteUserInteraction();
  ["pointerdown", "keydown", "focusin", "input", "change"].forEach((eventName) => {
    document.addEventListener(eventName, handler, true);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!(state.teamModalOpen || state.listsModalOpen || state.contactPoolModalOpen || state.operatorControlModalOpen || state.offerNotificationModalId)) return;
    state.teamModalOpen = false;
    state.listsModalOpen = false;
    state.contactPoolModalOpen = false;
    state.operatorControlModalOpen = false;
    state.offerNotificationModalId = "";
    render();
  });
}

function cancelDeferredRender() {
  if (interactionState.deferredRenderHandle) {
    window.clearTimeout(interactionState.deferredRenderHandle);
    interactionState.deferredRenderHandle = null;
  }
}

function resetSessionState(message = "") {
  stopPolling();
  cancelDeferredRender();
  state.token = null;
  state.booting = false;
  state.me = null;
  state.lists = [];
  state.records = [];
  state.contactPool = [];
  state.operatorStats = [];
  state.operationSummary = null;
  state.filteredSummary = null;
  state.users = [];
  state.activity = [];
  state.offerNotifications = [];
  state.offerNotificationModalId = "";
  state.selectedListId = "";
  state.uploadFile = null;
  state.uploadListName = "";
  state.recordDrafts = {};
  state.teamModalOpen = false;
  state.listsModalOpen = false;
  state.contactPoolModalOpen = false;
  state.operatorControlModalOpen = false;
  state.operatorDetailUserId = "";
  state.operatorDetailFilter = "all";
  state.operatorDetailRecords = [];
  state.operatorDetailSummary = null;
  state.operatorDetailPagination.offset = 0;
  state.operatorDetailPagination.total = 0;
  state.assignStrategy = "equal";
  state.assignMode = "unassigned";
  state.assignDrafts = {};
  state.contactPoolDrafts = {};
  state.contactPoolFilters = { ...DEFAULT_CONTACT_POOL_FILTERS };
  state.lastSyncAt = null;
  state.lastSyncSource = "";
  state.liveRefreshCount = 0;
  state.pagination.offset = 0;
  state.pagination.total = 0;
  state.contactPoolPagination.offset = 0;
  state.contactPoolPagination.total = 0;
  sessionStorage.removeItem("callPortalToken");
  localStorage.removeItem("callPortalToken");
  state.flash = message ? { type: "error", text: message } : null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function brandMark() {
  return `
    <span class="brand-mark" aria-hidden="true">
      <img class="brand-logo" src="/static/yabujin-mark.svg" alt="" />
      <span class="brand-logo-fallback">RC</span>
    </span>
  `;
}

function rainwaterBrandBannerMarkup() {
  return `
    <section class="rainwater-brand-banner" aria-label="Rainwater Control">
      <div class="rainwater-logo-window" aria-hidden="true">
        <span class="rainwater-logo-text">rainwater</span>
      </div>
      <div class="rainwater-banner-copy">
        <span>Rainwater Control</span>
        <strong>Call Operations & Offer Management Platform</strong>
      </div>
    </section>
  `;
}

function roleLabel(role) {
  if (role === "admin") return "Yönetici";
  if (role === "agent") return "Operatör";
  return role || "-";
}

function canOpenOfferTool(user = state.me) {
  if (!user) return false;
  return user.role === "admin" || Boolean(user.can_access_offer_tool);
}

function reachStatusLabel(status) {
  return REACH_STATUS_OPTIONS.find(([value]) => value === status)?.[1] || status || "-";
}

function callStatusLabel(status) {
  return CALL_STATUS_OPTIONS.find(([value]) => value === status)?.[1] || status || "-";
}

function resultStatusLabel(status) {
  return RESULT_STATUS_OPTIONS.find(([value]) => value === status)?.[1] || status || "-";
}

function setFlash(type, text) {
  state.flash = { type, text };
  render();
  window.setTimeout(() => {
    if (state.flash?.text === text) {
      state.flash = null;
      requestRender({ idleOnly: true });
    }
  }, 2600);
}

function formString(form, key) {
  return String(form.get(key) ?? "").trim();
}

function formatApiDetail(detail) {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (typeof item === "string") return item;
        const message = item?.msg || item?.message || "Geçersiz değer.";
        const location = Array.isArray(item?.loc)
          ? item.loc.filter((part) => part !== "body").join(".")
          : "";
        return location ? `${location}: ${message}` : message;
      })
      .join(" ");
  }
  if (typeof detail === "object") {
    return detail.message || JSON.stringify(detail);
  }
  return String(detail);
}

function passwordPolicyError(password) {
  if (password.length < 10) return "Şifre en az 10 karakter olmalı.";
  if (!/[a-zçğıöşü]/.test(password)) return "Şifre en az bir küçük harf içermeli.";
  if (!/[A-ZÇĞİÖŞÜ]/.test(password)) return "Şifre en az bir büyük harf içermeli.";
  if (!/\d/.test(password)) return "Şifre en az bir rakam içermeli.";
  if (!/[^\p{L}\p{N}]/u.test(password)) return "Şifre en az bir sembol içermeli.";
  return "";
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function formatClock(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatDateTimeInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function percentValue(value, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

function percentBucketClass(prefix, value) {
  const numericValue = Number(value) || 0;
  const bucket = Math.max(0, Math.min(100, Math.round(numericValue / 5) * 5));
  return `${prefix}-${bucket}`;
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function getAuthHeaders(extra = {}) {
  return state.token ? { ...extra, Authorization: `Bearer ${state.token}` } : extra;
}

async function api(path, options = {}) {
  const { retry, ...fetchOptions } = options;
  const method = String(fetchOptions.method || "GET").toUpperCase();
  const canRetry = retry !== false && (method === "GET" || method === "HEAD");
  const maxAttempts = canRetry ? RETRY_DELAYS_MS.length + 1 : 1;
  let response;
  let fetchError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      response = await fetch(path, {
        credentials: "same-origin",
        ...fetchOptions,
        headers: getAuthHeaders(fetchOptions.headers ?? {}),
      });
      if (!TRANSIENT_HTTP_STATUSES.has(response.status) || attempt === maxAttempts - 1) {
        break;
      }
    } catch (error) {
      fetchError = error;
      if (!canRetry || attempt === maxAttempts - 1) {
        throw error;
      }
    }
    await wait(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
  }

  if (!response) {
    throw fetchError || new Error("İstek başarısız.");
  }

  if (!response.ok) {
    let detail = TRANSIENT_HTTP_STATUSES.has(response.status)
      ? "Sunucu geçici olarak hazır değil. Birkaç saniye sonra tekrar deneyin."
      : "İstek başarısız.";
    try {
      const data = await response.json();
      detail = formatApiDetail(data.detail) || detail;
    } catch {
      // noop
    }
    if ((response.status === 401 || response.status === 403) && (state.token || state.me)) {
      resetSessionState("Oturum kapandı. Lütfen tekrar giriş yap.");
      render();
    }
    throw new Error(detail);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.blob();
}

function selectedList() {
  return state.lists.find((item) => item.id === state.selectedListId) ?? state.lists[0] ?? null;
}

function normalizedValue(value) {
  return String(value ?? "")
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function recordMatchesFilters(record) {
  const query = normalizedValue(state.filters.q).trim();
  if (query) {
    const haystack = [
      record.company_name,
      record.address,
      record.phone,
      record.email,
      record.website,
      record.call_list_name,
    ]
      .map(normalizedValue)
      .join(" ");
    if (!haystack.includes(query)) return false;
  }
  if (state.filters.call_status && record.call_status !== state.filters.call_status) return false;
  if (state.filters.result_status && record.result_status !== state.filters.result_status) return false;
  if (state.filters.unassigned && record.assigned_user_id) return false;
  if (state.filters.has_email && !String(record.email ?? "").trim()) return false;
  if (state.filters.has_phone && !String(record.phone ?? "").trim()) return false;
  if (state.filters.has_address && !String(record.address ?? "").trim()) return false;
  if (state.filters.has_website && !String(record.website ?? "").trim()) return false;
  return true;
}

function summarizeRecords(records) {
  return records.reduce(
    (summary, record) => {
      summary.total += 1;
      if (record.assigned_user_id) summary.assigned += 1;
      if (record.call_status === "CALLING" || record.call_status === "CALLED" || record.call_status === "COMPLETED") {
        summary.calling += 1;
      }
      if (record.result_status === "POSITIVE") {
        summary.positive += 1;
      }
      return summary;
    },
    {
      total: 0,
      assigned: 0,
      calling: 0,
      positive: 0,
    },
  );
}

function compactSummary(summary) {
  if (!summary) return null;
  return {
    total: summary.total || 0,
    assigned: summary.assigned || 0,
    calling: (summary.calling || 0) + (summary.called || 0) + (summary.completed || 0),
    positive: summary.positive || 0,
  };
}

function activeRecordFilterLabels() {
  const labels = [];
  const query = String(state.filters.q || "").trim();
  if (query) labels.push(`arama: ${query}`);
  if (state.filters.call_status) labels.push(callStatusLabel(state.filters.call_status));
  if (state.filters.result_status) labels.push(resultStatusLabel(state.filters.result_status));
  if (state.me?.role === "admin" && state.filters.assigned_user_id) {
    const user = state.users.find((item) => item.id === state.filters.assigned_user_id);
    labels.push(user ? `operatör: ${user.full_name || user.email}` : "operatör filtresi");
  }
  if (state.filters.unassigned) labels.push("atanmamış");
  if (state.filters.has_email) labels.push("e-posta var");
  if (state.filters.has_phone) labels.push("telefon var");
  if (state.filters.has_address) labels.push("adres var");
  if (state.filters.has_website) labels.push("web var");
  if (state.filters.due_callbacks) labels.push("takip zamanı gelenler");
  return labels;
}

function hasActiveRecordFilters() {
  return activeRecordFilterLabels().length > 0;
}

function latestActivity() {
  return state.activity[0] ?? null;
}

function activityActionLabel(action) {
  if (action === "UPDATED") return "kayıt güncellendi";
  if (action === "ASSIGNED") return "dağıtım işlendi";
  return action || "işlem";
}

function assignDraftFor(userId) {
  return state.assignDrafts[userId] || { enabled: false, count: "" };
}

function activeAgents() {
  return state.users.filter((user) => user.role === "agent" && user.is_active);
}

function availableAssignmentCount() {
  const list = selectedList();
  if (!list) return 0;
  if (state.assignMode === "all") return list.summary.total;
  return Math.max(0, list.summary.total - list.summary.assigned);
}

function assignSummaryValues(users = activeAgents()) {
  const selectedAgents = users.filter((user) => assignDraftFor(user.id).enabled).length;
  const requested = users.reduce((total, user) => {
    const draft = assignDraftFor(user.id);
    if (!draft.enabled) return total;
    return total + Math.max(0, Number(draft.count || 0));
  }, 0);
  const available = availableAssignmentCount();
  return {
    available,
    selectedAgents,
    requested,
    remainder: Math.max(0, available - requested),
    overflow: Math.max(0, requested - available),
  };
}

function syncAssignSummaryDisplay() {
  const nodes = {
    available: document.querySelector("#assign-available-count"),
    selected: document.querySelector("#assign-selected-count"),
    requested: document.querySelector("#assign-requested-count"),
    status: document.querySelector("#assign-status-text"),
  };
  if (!nodes.available || !nodes.selected || !nodes.requested || !nodes.status) return;
  const summary = assignSummaryValues();
  nodes.available.textContent = String(summary.available);
  nodes.selected.textContent = String(summary.selectedAgents);
  nodes.requested.textContent = state.assignStrategy === "custom" ? String(summary.requested) : "-";
  if (state.assignStrategy !== "custom") {
    nodes.status.textContent = "Eşit dağıtım aktif.";
  } else if (summary.overflow > 0) {
    nodes.status.textContent = `${summary.overflow} kayıt fazla istendi.`;
  } else {
    nodes.status.textContent = `${summary.remainder} kayıt atanmamış kalır.`;
  }
}

function markSync(source) {
  state.lastSyncAt = Date.now();
  state.lastSyncSource = source;
  state.liveRefreshCount += 1;
}

async function refreshOperationalData(source = "manual") {
  const tasks = [loadLists(), loadRecords(), loadActivity(), loadOfferNotifications(), loadOperatorStats(), loadOperationSummary()];
  if (state.contactPoolModalOpen) {
    tasks.push(loadContactPool());
  }
  if (state.operatorControlModalOpen && state.operatorDetailUserId) {
    tasks.push(loadOperatorDetailRecords());
  }
  await Promise.all(tasks);
  markSync(source);
}

function liveMonitorMarkup() {
  const lastItem = latestActivity();
  const actor = lastItem?.actor_user_name || (lastItem?.actor_role ? roleLabel(lastItem.actor_role) : "Sistem");
  const target = lastItem?.company_name || lastItem?.call_list_name || "Operasyon akışı izleniyor";
  const syncAgeSeconds = state.lastSyncAt ? Math.max(0, Math.floor((Date.now() - state.lastSyncAt) / 1000)) : null;
  return `
    <div class="live-monitor">
      <div class="live-monitor-head">
        <span class="signal-bars" aria-hidden="true"><span></span><span></span><span></span></span>
        <strong>Canlı Operasyon Monitörü</strong>
      </div>
      <div class="live-monitor-grid">
        <div class="live-monitor-cell">
          <span>Son yenileme</span>
          <strong>${escapeHtml(formatClock(state.lastSyncAt))}</strong>
        </div>
        <div class="live-monitor-cell">
          <span>Canlılık</span>
          <strong>${syncAgeSeconds === null ? "-" : `${syncAgeSeconds} sn önce`}</strong>
        </div>
        <div class="live-monitor-cell live-monitor-wide">
          <span>Akış</span>
          <strong>${escapeHtml(`${actor} / ${activityActionLabel(lastItem?.action)} / ${target}`)}</strong>
        </div>
      </div>
    </div>
  `;
}

function hasLocalInteraction() {
  const active = document.activeElement;
  const recentlyTouched = Date.now() - interactionState.lastUserInteractionAt < 12000;
  if (recentlyTouched) return true;
  if (state.teamModalOpen || state.listsModalOpen || state.contactPoolModalOpen || state.operatorControlModalOpen || state.offerNotificationModalId) return true;
  if (state.uploadFile) return true;
  if (Object.keys(state.recordDrafts).length > 0) return true;
  if (Object.keys(state.contactPoolDrafts).length > 0) return true;
  if (active && active !== document.body && active !== document.documentElement) {
    if (active.matches("input, select, textarea, button")) return true;
    if (
      active.closest(
        "#upload-form, #user-form, #assign-form, #team-modal, #contact-pool-modal, #operator-control-modal, #offer-notification-modal, .records-table, .filter-panel, #login-form",
      )
    ) {
      return true;
    }
  }
  return Boolean(document.querySelector("input:focus, select:focus, textarea:focus, button:focus"));
}

function requestRender(options = {}) {
  const { idleOnly = false, delayMs = 0 } = options;
  cancelDeferredRender();

  const attempt = () => {
    if (idleOnly && hasLocalInteraction()) {
      interactionState.deferredRenderHandle = window.setTimeout(attempt, 1000);
      return;
    }
    interactionState.deferredRenderHandle = null;
    render();
  };

  interactionState.deferredRenderHandle = window.setTimeout(attempt, delayMs);
}

function recordDraft(record) {
  return { ...record, ...(state.recordDrafts[record.id] || {}) };
}

function contactPoolDraft(entry) {
  return { ...entry, ...(state.contactPoolDrafts[entry.id] || {}) };
}

async function loadSession() {
  const hadStoredToken = Boolean(state.token);
  try {
    state.me = await api("/api/auth/me");
    await Promise.all([loadLists(), loadUsersIfAdmin()]);
    await refreshOperationalData("login");
    state.booting = false;
    startPolling();
  } catch (error) {
    if (hadStoredToken) {
      console.error(error);
    }
    state.booting = false;
    resetSessionState(hadStoredToken ? error.message : "");
    if (hadStoredToken) {
      setFlash("error", error.message);
    }
  }
}

async function loadUsersIfAdmin() {
  if (state.me?.role !== "admin") {
    state.users = [];
    return;
  }
  state.users = await api("/api/users");
}

async function loadActivity() {
  if (state.me?.role !== "admin") {
    state.activity = [];
    return;
  }
  const params = new URLSearchParams();
  if (state.selectedListId) params.set("call_list_id", state.selectedListId);
  params.set("limit", "25");
  state.activity = await api(`/api/activity?${params.toString()}`);
}

async function loadOfferNotifications() {
  if (!canOpenOfferTool()) {
    state.offerNotifications = [];
    state.offerNotificationModalId = "";
    return;
  }
  state.offerNotifications = await api("/api/offer-notifications");
  if (
    state.offerNotificationModalId
    && !state.offerNotifications.some((item) => item.id === state.offerNotificationModalId)
  ) {
    state.offerNotificationModalId = "";
  }
}

async function loadOperatorStats() {
  if (state.me?.role !== "admin") {
    state.operatorStats = [];
    return;
  }
  const params = new URLSearchParams();
  if (state.selectedListId) params.set("call_list_id", state.selectedListId);
  state.operatorStats = await api(`/api/operator-stats?${params.toString()}`);
}

async function loadOperationSummary() {
  if (state.me?.role !== "admin") {
    state.operationSummary = null;
    return;
  }
  const params = new URLSearchParams();
  if (state.selectedListId) params.set("call_list_id", state.selectedListId);
  state.operationSummary = await api(`/api/operation-summary?${params.toString()}`);
}

async function loadOperatorDetailRecords() {
  if (state.me?.role !== "admin" || !state.operatorDetailUserId) {
    state.operatorDetailRecords = [];
    state.operatorDetailSummary = null;
    state.operatorDetailPagination.total = 0;
    return;
  }

  const params = new URLSearchParams();
  if (state.selectedListId) params.set("call_list_id", state.selectedListId);
  params.set("assigned_user_id", state.operatorDetailUserId);
  if (state.operatorDetailFilter === "processed") params.set("processed", "true");
  if (state.operatorDetailFilter === "positive") params.set("result_status", "POSITIVE");
  params.set("offset", String(state.operatorDetailPagination.offset));
  params.set("limit", String(state.operatorDetailPagination.limit));

  let response = await api(`/api/records?${params.toString()}`);
  if (response.total > 0 && state.operatorDetailPagination.offset >= response.total) {
    state.operatorDetailPagination.offset = Math.max(
      0,
      Math.floor((response.total - 1) / state.operatorDetailPagination.limit) * state.operatorDetailPagination.limit,
    );
    params.set("offset", String(state.operatorDetailPagination.offset));
    response = await api(`/api/records?${params.toString()}`);
  }

  state.operatorDetailRecords = response.items;
  state.operatorDetailPagination.total = response.total;
  state.operatorDetailSummary = compactSummary(response.summary) || summarizeRecords(response.items);
}

async function loadContactPool() {
  if (state.me?.role !== "admin") {
    state.contactPool = [];
    state.contactPoolPagination.total = 0;
    return;
  }
  const params = new URLSearchParams();
  if (state.contactPoolFilters.current_list_only && state.selectedListId) {
    params.set("call_list_id", state.selectedListId);
  }
  if (state.contactPoolFilters.q.trim()) params.set("q", state.contactPoolFilters.q.trim());
  if (state.contactPoolFilters.reach_status) params.set("reach_status", state.contactPoolFilters.reach_status);
  if (state.contactPoolFilters.result_status) params.set("result_status", state.contactPoolFilters.result_status);
  if (!state.contactPoolFilters.active_only) params.set("include_inactive", "true");
  params.set("offset", String(state.contactPoolPagination.offset));
  params.set("limit", String(state.contactPoolPagination.limit));

  let response = await api(`/api/contact-pool?${params.toString()}`);
  if (response.total > 0 && state.contactPoolPagination.offset >= response.total) {
    state.contactPoolPagination.offset = Math.max(
      0,
      Math.floor((response.total - 1) / state.contactPoolPagination.limit) * state.contactPoolPagination.limit,
    );
    params.set("offset", String(state.contactPoolPagination.offset));
    response = await api(`/api/contact-pool?${params.toString()}`);
  }

  state.contactPool = response.items;
  state.contactPoolPagination.total = response.total;
}

async function loadLists() {
  if (!state.me) return;
  const path = state.me.role === "admin" ? "/api/lists?include_inactive=true" : "/api/lists";
  state.lists = await api(path);
  if (!state.selectedListId && state.lists.length) {
    state.selectedListId = state.lists[0].id;
  }
  if (state.selectedListId && !state.lists.some((item) => item.id === state.selectedListId)) {
    state.selectedListId = state.lists[0]?.id ?? "";
  }
}

async function loadRecords() {
  if (!state.me) return;
  const params = new URLSearchParams();
  if (state.selectedListId) params.set("call_list_id", state.selectedListId);
  if (state.filters.q.trim()) params.set("q", state.filters.q.trim());
  if (state.filters.call_status) params.set("call_status", state.filters.call_status);
  if (state.filters.result_status) params.set("result_status", state.filters.result_status);
  if (state.me?.role === "admin" && state.filters.assigned_user_id) {
    params.set("assigned_user_id", state.filters.assigned_user_id);
  }
  if (state.filters.unassigned) params.set("unassigned", "true");
  if (state.filters.has_email) params.set("has_email", "true");
  if (state.filters.has_phone) params.set("has_phone", "true");
  if (state.filters.has_address) params.set("has_address", "true");
  if (state.filters.has_website) params.set("has_website", "true");
  if (state.filters.due_callbacks) params.set("due_callbacks", "true");
  params.set("offset", String(state.pagination.offset));
  params.set("limit", String(state.pagination.limit));

  let response = await api(`/api/records?${params.toString()}`);

  if (response.total > 0 && state.pagination.offset >= response.total) {
    state.pagination.offset = Math.max(0, Math.floor((response.total - 1) / state.pagination.limit) * state.pagination.limit);
    params.set("offset", String(state.pagination.offset));
    response = await api(`/api/records?${params.toString()}`);
  }

  state.records = response.items;
  state.pagination.total = response.total;
  state.filteredSummary = compactSummary(response.summary) || summarizeRecords(response.items);
}

function startPolling() {
  if (state.pollingHandle) {
    window.clearInterval(state.pollingHandle);
  }
  state.pollingHandle = window.setInterval(async () => {
    if (hasLocalInteraction()) return;
    try {
      await refreshOperationalData("poll");
      requestRender({ idleOnly: true });
    } catch (error) {
      console.error(error);
    }
  }, 5000);
}

function stopPolling() {
  if (state.pollingHandle) {
    window.clearInterval(state.pollingHandle);
    state.pollingHandle = null;
  }
}

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (_error) {
    // Çerez temizleme isteği başarısız olsa da yerel oturumu kapat.
  }
  resetSessionState();
  render();
}

async function handleManualRefresh() {
  try {
    await refreshOperationalData("manual-refresh");
    render();
    setFlash("success", "Ekran yenilendi.");
  } catch (error) {
    setFlash("error", error.message);
  }
}

function statsMarkup() {
  const list = selectedList();
  const filtersActive = hasActiveRecordFilters();
  const listSummary = list?.summary ?? null;
  const operational = state.operationSummary || {};
  const summary = filtersActive
    ? (state.filteredSummary ?? summarizeRecords(state.records))
    : (listSummary ?? state.filteredSummary ?? {
      total: state.records.length,
      assigned: 0,
      calling: 0,
      positive: 0,
    });
  const listTotal = listSummary?.total ?? 0;
  const listAssigned = listSummary?.assigned ?? 0;
  const callbackCount = state.records.filter((record) => record.call_status === "CALLBACK").length;
  const unreachableCount = state.records.filter((record) => record.call_status === "UNREACHABLE").length;
  const pendingCount = Math.max(0, (summary.total ?? 0) - (summary.calling ?? 0));
  const kpis = [
    {
      tone: "info",
      label: filtersActive ? "Filtre sonucu" : "Toplam kayıt",
      value: summary.total ?? 0,
      hint: filtersActive ? `Liste toplamı ${listTotal}` : "aktif operasyon hacmi",
    },
    {
      tone: "primary",
      label: filtersActive ? "Filtrede atanan" : "Atanan kayıt",
      value: summary.assigned ?? 0,
      hint: filtersActive ? `Listede ${listAssigned} atanmış` : "operatörlere dağıtıldı",
    },
    {
      tone: "muted",
      label: "Bekleyen kayıt",
      value: pendingCount,
      hint: "işlem veya takip bekliyor",
    },
    {
      tone: "accent",
      label: "Bugün aranan",
      value: operational.today_processed_count ?? summary.calling ?? 0,
      hint: `${operational.total_daily_target || 0} günlük hedef`,
    },
    {
      tone: "success",
      label: "Ulaşıldı",
      value: operational.reached_count ?? summary.calling ?? 0,
      hint: "temas kurulmuş kayıtlar",
    },
    {
      tone: "success",
      label: "Olumlu",
      value: summary.positive ?? 0,
      hint: "teklif potansiyeli",
    },
    {
      tone: "warning",
      label: "Callback",
      value: operational.due_callback_count ?? callbackCount,
      hint: "takip sırası gelenler",
    },
    {
      tone: "danger",
      label: "Ulaşılamadı",
      value: unreachableCount,
      hint: "tekrar ayrıştırılmalı",
    },
    {
      tone: "primary",
      label: "Oluşturulan teklifler",
      value: "-",
      hint: "teklif modülünde izlenir",
    },
    {
      tone: "success",
      label: "Onaylanan teklifler",
      value: "-",
      hint: "teklif modülünde izlenir",
    },
  ];
  return `
      <section class="stats-band ${filtersActive ? "is-filtered" : ""}" aria-label="Operasyon KPI kartları">
        ${kpis
          .map(
            (item) => `
              <article class="stat stat-${item.tone}">
                <span>${escapeHtml(item.label)}</span>
                <strong>${escapeHtml(item.value)}</strong>
                <small>${escapeHtml(item.hint)}</small>
              </article>
            `,
          )
          .join("")}
    </section>
  `;
}

function managementDashboardMarkup() {
  if (state.me?.role !== "admin") return "";
  const summary = state.operationSummary || {};
  const targetPercent = summary.target_percent || percentValue(summary.today_processed_count || 0, summary.total_daily_target || 0);
  const idleText = (summary.idle_operator_count || 0) > 0 ? `${summary.idle_operator_count} operatör bugün işlem girmedi` : "Ekip bugün aktif";
  const callbackText = (summary.due_callback_count || 0) > 0 ? `${summary.due_callback_count} takip zamanı geçti` : "Geciken takip yok";
  return `
    <section class="ops-command-center">
      <div class="ops-command-head">
        <div>
          <p class="section-kicker">Admin Dashboard</p>
          <h2>Call Operations & Offer Pipeline</h2>
          <p>Arama operasyonunu, ekip kapasitesini, callback risklerini ve teklif geçişlerini tek yönetim ekranında izle.</p>
          <div class="ops-live-strip" aria-hidden="true">
            <span>Lead</span>
            <span>Call</span>
            <span>Offer</span>
            <span>Export</span>
          </div>
        </div>
        <div class="target-ring ${percentBucketClass("target-pct", targetPercent)}">
          <strong>${targetPercent}%</strong>
          <span>günlük hedef</span>
        </div>
      </div>
      <div class="ops-signal-grid">
        <article class="ops-signal">
          <span>Bugün işlenen</span>
          <strong>${summary.today_processed_count || 0}</strong>
          <small>${summary.total_daily_target || 0} kayıt hedef</small>
        </article>
        <article class="ops-signal ${summary.unassigned_count ? "warn" : ""}">
          <span>Atanmayı bekleyen</span>
          <strong>${summary.unassigned_count || 0}</strong>
          <small>çalışana verilmemiş kayıt</small>
        </article>
        <article class="ops-signal ${summary.due_callback_count ? "danger" : ""}">
          <span>Takip alarmı</span>
          <strong>${summary.due_callback_count || 0}</strong>
          <small>${escapeHtml(callbackText)}</small>
        </article>
        <article class="ops-signal ${summary.stale_assigned_count ? "warn" : ""}">
          <span>Bekleyen atanmış iş</span>
          <strong>${summary.stale_assigned_count || 0}</strong>
          <small>2+ gündür dokunulmamış</small>
        </article>
        <article class="ops-signal ${summary.idle_operator_count ? "warn" : ""}">
          <span>Ekip canlılığı</span>
          <strong>${summary.active_operator_count || 0}</strong>
          <small>${escapeHtml(idleText)}</small>
        </article>
      </div>
    </section>
  `;
}

function agentTaskDeskMarkup() {
  if (state.me?.role !== "agent") return "";
  const summary = state.filteredSummary || summarizeRecords(state.records);
  const pending = Math.max(0, (summary.total || 0) - (summary.calling || 0));
  const dueCallbacks = state.records.filter((record) => {
    if (record.call_status !== "CALLBACK" || !record.callback_at) return false;
    const date = new Date(record.callback_at);
    return !Number.isNaN(date.getTime()) && date.getTime() <= Date.now();
  }).length;
  return `
    <section class="agent-task-desk">
      <div class="agent-task-copy">
        <p class="section-kicker">Operatör Desk</p>
        <h2>Bugünkü görevlerim</h2>
        <p>Öncelikli aramaları hızlıca işle, sonucu seç, notunu yaz ve callback zamanını kapat.</p>
      </div>
      <div class="agent-task-grid">
        <article><span>Atanan</span><strong>${summary.total || 0}</strong></article>
        <article><span>Bekleyen</span><strong>${pending}</strong></article>
        <article><span>İşlenen</span><strong>${summary.calling || 0}</strong></article>
        <article class="${dueCallbacks ? "danger" : ""}"><span>Takip zamanı</span><strong>${dueCallbacks}</strong></article>
      </div>
    </section>
  `;
}

function operationFocusRailMarkup(currentList) {
  if (state.me?.role !== "admin") return "";
  const summary = state.operationSummary || {};
  const listSummary = currentList?.summary || {};
  const unassigned = Math.max(0, (listSummary.total || 0) - (listSummary.assigned || 0));
  const dueCallbacks = summary.due_callback_count || 0;
  const idleOperators = summary.idle_operator_count || 0;
  const todayProcessed = summary.today_processed_count || 0;
  const dailyTarget = summary.total_daily_target || 0;
  const targetPercent = summary.target_percent || percentValue(todayProcessed, dailyTarget);
  const focusItems = [
    {
      tone: unassigned ? "warn" : "ok",
      label: "Atanmamış",
      value: unassigned,
      copy: unassigned ? "dağıtım bekliyor" : "dağıtım tamam",
      action: "assign",
      button: "Dağıt",
    },
    {
      tone: idleOperators ? "danger" : "ok",
      label: "Boşta",
      value: idleOperators,
      copy: idleOperators ? "operatör işlem girmedi" : "ekip aktif",
      action: "operators",
      button: "Ekip",
    },
    {
      tone: dueCallbacks ? "danger" : "ok",
      label: "Takip",
      value: dueCallbacks,
      copy: dueCallbacks ? "zamanı geçti" : "gecikme yok",
      action: "due",
      button: "Filtrele",
    },
    {
      tone: targetPercent >= 80 ? "ok" : targetPercent >= 45 ? "warn" : "info",
      label: "Hedef",
      value: `%${targetPercent}`,
      copy: `${todayProcessed}/${dailyTarget || 0} işlem`,
      action: "operators",
      button: "Detay",
    },
    ];
    return `
      <section class="ops-focus-rail">
        <div class="ops-focus-head">
          <div>
            <p class="section-kicker">Aksiyon Sırası</p>
            <h2>Bugünün operasyon odağı</h2>
          </div>
          <span>${currentList ? escapeHtml(currentList.name) : "Liste seçilmedi"}</span>
        </div>
      <div class="ops-focus-grid">
        ${focusItems
          .map(
            (item) => `
              <article class="ops-focus-card ${item.tone}">
                <div>
                  <span>${item.label}</span>
                  <strong>${item.value}</strong>
                  <small>${item.copy}</small>
                </div>
                <button class="btn btn-soft mini-button" type="button" data-focus-action="${item.action}">${item.button}</button>
              </article>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function sessionHeaderMarkup(currentList) {
  const summary = state.operationSummary || {};
  const syncAgeSeconds = state.lastSyncAt ? Math.max(0, Math.floor((Date.now() - state.lastSyncAt) / 1000)) : null;
  const role = roleLabel(state.me?.role || "");
  const userName = state.me?.full_name || state.me?.email || "";
  const listSummary = currentList?.summary || {};
  const unassigned = Math.max(0, (listSummary.total || 0) - (listSummary.assigned || 0));
  return `
      <header class="topbar session-overview ops-home-hero" data-window-title="Rainwater Control">
        <div class="session-main">
          <div class="session-title-block">
            <div class="product-lockup">
              ${brandMark()}
              <div>
                <p class="section-kicker">Rainwater Control</p>
                <h2>${currentList ? escapeHtml(currentList.name) : state.me?.role === "admin" ? "Call Operations Dashboard" : "Operatör Görev Ekranı"}</h2>
                <p class="helper">Call Operations & Offer Management Platform</p>
              </div>
            </div>
          </div>
          <div class="session-stat-grid">
            <article>
              <span>Toplam</span>
              <strong>${listSummary.total || 0}</strong>
            </article>
            <article>
              <span>Atanan</span>
              <strong>${listSummary.assigned || 0}</strong>
            </article>
            <article>
              <span>Atanmayan</span>
              <strong>${unassigned}</strong>
            </article>
            <article>
              <span>Canlılık</span>
              <strong>${syncAgeSeconds === null ? "-" : `${syncAgeSeconds} sn`}</strong>
            </article>
          </div>
        </div>
      <div class="session-side">
        ${state.me?.role === "admin" ? liveMonitorMarkup() : `
          <div class="manual-refresh-group">
            <span class="topbar-chip">Manuel senkron</span>
            <button class="btn btn-soft" type="button" id="manual-refresh-button">Yenile</button>
          </div>
        `}
        <div class="user-strip">
          ${canOpenOfferTool() ? `<a class="btn btn-soft" href="/teklif/" target="_blank" rel="noreferrer">Offer Studio</a>` : ""}
          <span class="badge active">${escapeHtml(role)}</span>
          <span>${escapeHtml(userName)}</span>
          <button class="btn btn-soft" type="button" id="logout-button">Çıkış</button>
        </div>
      </div>
    </header>
  `;
}

function totalPages() {
  return Math.max(1, Math.ceil(state.pagination.total / state.pagination.limit));
}

function currentPage() {
  return Math.floor(state.pagination.offset / state.pagination.limit) + 1;
}

function contactPoolTotalPages() {
  return Math.max(1, Math.ceil(state.contactPoolPagination.total / state.contactPoolPagination.limit));
}

function contactPoolCurrentPage() {
  return Math.floor(state.contactPoolPagination.offset / state.contactPoolPagination.limit) + 1;
}

function operatorDetailTotalPages() {
  return Math.max(1, Math.ceil(state.operatorDetailPagination.total / state.operatorDetailPagination.limit));
}

function operatorDetailCurrentPage() {
  return Math.floor(state.operatorDetailPagination.offset / state.operatorDetailPagination.limit) + 1;
}

function selectedOperatorStat() {
  return state.operatorStats.find((item) => item.user_id === state.operatorDetailUserId) || null;
}

function loginConsoleMarkup() {
  return `
    <section class="login-console product-preview" aria-hidden="true">
      <div class="preview-topline">
        <span class="live-dot"></span>
        <strong>Live operations preview</strong>
      </div>
      <div class="preview-grid">
        <article>
          <span>Bugün aranan</span>
          <strong>128</strong>
          <small>+18 son 60 dk</small>
        </article>
        <article>
          <span>Callback</span>
          <strong>24</strong>
          <small>7 kritik takip</small>
        </article>
        <article>
          <span>Teklif pipeline</span>
          <strong>₺418K</strong>
          <small>12 aktif teklif</small>
        </article>
      </div>
      <div class="preview-board">
        <div class="preview-row is-success">
          <span>Olumlu lead</span>
          <strong>Metro Endüstri</strong>
          <small>Offer Studio'ya hazır</small>
        </div>
        <div class="preview-row is-warning">
          <span>Callback</span>
          <strong>Atlas Klinik</strong>
          <small>14:30 takip zamanı</small>
        </div>
        <div class="preview-row is-info">
          <span>Operatör</span>
          <strong>Ayşe K.</strong>
          <small>42/60 günlük hedef</small>
        </div>
      </div>
    </section>
  `;
}

function loginMarkup() {
  return `
    <section class="login-screen">
      <div class="login-stage">
        <section class="login-card login-access-panel window-shell" data-window-title="Secure Workspace">
          <div class="login-card-head">
            <p class="section-kicker">Güvenli erişim</p>
            <h2>Rainwater Control'a giriş</h2>
            <p>Operasyon, lead havuzu ve teklif ekranlarına rol bazlı erişim.</p>
          </div>
          ${state.flash ? `<div class="flash ${state.flash.type}">${escapeHtml(state.flash.text)}</div>` : ""}
          <form id="login-form" class="stack">
            <label class="form-field">
              <span>Kullanıcı e-postası</span>
              <input class="field" type="email" name="email" placeholder="name@company.com" autocomplete="username" required />
            </label>
            <label class="form-field">
              <span>Şifre</span>
              <input class="field" type="password" name="password" placeholder="••••••••••" autocomplete="current-password" required />
            </label>
            <button class="btn btn-primary" type="submit">Giriş yap</button>
          </form>
          <p class="login-meta">Operasyon altyapısı.</p>
        </section>

        <section class="login-brand-panel window-shell" aria-label="Rainwater Control">
          <div class="login-rainwater-header" aria-hidden="true">
            <span>rainwater</span>
          </div>
          <div class="login-brand-copy">
            <span>Rainwater Control</span>
            <strong>Call Operations & Offer Management Platform</strong>
          </div>
        </section>
      </div>
    </section>
  `;
}

function bootMarkup() {
  return `
    <section class="boot-screen">
      <div class="boot-orb" aria-hidden="true"></div>
      <div class="boot-card">
        <div class="boot-brand-row">
          <span class="boot-rainwater-mark" aria-hidden="true">rainwater</span>
          <div>
            <p class="brand-kicker">Call Operations & Offer Management Platform</p>
            <h1>Rainwater Control</h1>
          </div>
        </div>
        <div class="boot-copy">
          <strong>Operasyon çalışma alanı hazırlanıyor</strong>
          <span>Oturum, liste, ekip, lead havuzu ve teklif bağlantıları senkronize ediliyor.</span>
        </div>
        <div class="boot-loader" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <div class="boot-status-grid" aria-hidden="true">
          <span>Oturum</span>
          <span>Listeler</span>
          <span>Ekip</span>
          <span>Havuz</span>
        </div>
      </div>
    </section>
  `;
}

function uploadSectionMarkup() {
  if (state.me?.role !== "admin") return "";
  return `
    <section class="sidebar-section panel window-shell upload-dropzone" data-window-title="Excel Import">
      <div class="panel-head">
        <div>
          <h2>Excel liste yükle</h2>
          <p>Yeni lead listesini mevcut import akışıyla operasyon havuzuna al.</p>
        </div>
      </div>
      <form id="upload-form" class="stack">
        <input class="field" name="list_name" placeholder="Liste adı (opsiyonel)" value="${escapeHtml(state.uploadListName)}" />
        <input class="hidden-file-input" id="upload-file-input" type="file" name="file" accept=".xlsx" />
        <div class="file-picker-row">
          <input class="field file-display" type="text" readonly value="${escapeHtml(state.uploadFile?.name || "Dosya seçilmedi")}" />
          <button class="btn btn-soft file-picker-button" type="button" id="open-file-picker">Dosya Seç</button>
        </div>
        <button class="btn btn-primary" type="submit">Import başlat</button>
        <p class="file-note">Dosya doğrudan yüklenir, veri anında veri tabanına işlenir.</p>
      </form>
    </section>
  `;
}

function sidebarNavMarkup() {
  const activeList = state.lists.filter((list) => list.is_active).length;
  const inactiveList = Math.max(0, state.lists.length - activeList);
  const selected = selectedList();
  const agentCount = state.users.filter((user) => user.role === "agent").length;
  const adminCount = state.users.filter((user) => user.role === "admin").length;
  const offerAccessCount = state.users.filter((user) => canOpenOfferTool(user)).length;
  const poolTotal = state.contactPoolPagination.total || 0;
  const activeOperators = state.operatorStats.filter((item) => (item.assigned_count || 0) > 0).length;
  const remaining = state.operatorStats.reduce((sum, item) => sum + (item.pending_count || 0), 0);
  const items = [];

  if (state.me?.role === "admin") {
    items.push({
      tone: "dashboard",
      title: "Dashboard",
      meta: "KPI ve canlı operasyon",
      detail: "Yönetim",
      action: "dashboard",
      active: true,
    });
    items.push({
      tone: "records",
      title: "Arama Kayıtları",
      meta: `${state.pagination.total || 0} kayıt`,
      detail: selected ? selected.name : "Genel liste",
      action: "records",
    });
    items.push({
      id: "toggle-upload-flyout",
      tone: "upload",
      title: "Listeler",
      meta: "Excel import",
      detail: state.uploadFile?.name || "Dosya bekliyor",
      active: state.sidebarPanel === "upload",
    });
    items.push({
      id: "open-team-modal",
      tone: "team",
      title: "Operatörler",
      meta: `${adminCount} yönetici · ${agentCount} operatör`,
      detail: `${offerAccessCount} teklif erişimi`,
    });
    items.push({
      id: "open-lists-modal",
      tone: "lists",
      title: "Liste Yönetimi",
      meta: `${activeList} aktif · ${inactiveList} pasif`,
      detail: selected ? selected.name : "Liste seçilmedi",
    });
    items.push({
      id: "open-contact-pool-modal",
      tone: "pool",
      title: "Contact Pool",
      meta: `${poolTotal} havuz kaydı`,
      detail: "Lead ayrıştırma",
    });
    items.push({
      id: "open-operator-control-modal",
      tone: "operators",
      title: "Ekip Performansı",
      meta: `${activeOperators} aktif operatör`,
      detail: `${remaining} kalan işlem`,
    });
    if (canOpenOfferTool()) {
      items.push({
        tone: "offer",
        title: "Teklifler",
        meta: "Offer Studio",
        detail: "Liste ve kontrol",
        href: "/teklif/",
      });
      items.push({
        tone: "new-offer",
        title: "Yeni Teklif",
        meta: "Quote Builder",
        detail: "Teklif oluştur",
        href: "/teklif/",
      });
    }
    items.push({
      tone: "export",
      title: "Raporlar / Export",
      meta: "CSV çıktı",
      detail: "Kayıt export",
      action: "export",
    });
    items.push({
      tone: "settings",
      title: "Ayarlar",
      meta: "Rol ve listeler",
      detail: "Modal yönetim",
      action: "team",
    });
  } else {
    items.push({
      tone: "tasks",
      title: "Görevlerim",
      meta: `${state.pagination.total || 0} atanmış kayıt`,
      detail: "Bugünkü sıra",
      action: "records",
      active: true,
    });
    items.push({
      tone: "callback",
      title: "Callback",
      meta: "Zamanı gelenler",
      detail: "Takip",
      action: "due",
    });
    items.push({
      tone: "completed",
      title: "Tamamlananlar",
      meta: "Kapanan işler",
      detail: "Filtrele",
      action: "completed",
    });
    if (canOpenOfferTool()) {
      items.push({
        tone: "offer",
        title: "Teklifler",
        meta: "Offer Studio",
        detail: "Yeni teklif",
        href: "/teklif/",
      });
    }
  }

  return `
    <div class="sidebar-nav" aria-label="Operasyon menüsü">
      ${items
        .map(
          (item) => {
            const attrs = [
              item.id ? `id="${item.id}"` : "",
              item.action ? `data-focus-action="${item.action}"` : "",
              `data-tone="${item.tone}"`,
            ]
              .filter(Boolean)
              .join(" ");
            const inner = `
              <span class="sidebar-nav-icon" aria-hidden="true"></span>
              <span class="sidebar-nav-copy">
                <strong>${escapeHtml(item.title)}</strong>
                <small>${escapeHtml(item.meta)}</small>
              </span>
              <span class="sidebar-nav-detail">${escapeHtml(item.detail)}</span>
            `;
            return item.href
              ? `<a class="sidebar-nav-item ${item.active ? "active" : ""}" href="${item.href}" target="_blank" rel="noreferrer" ${attrs}>${inner}</a>`
              : `<button class="sidebar-nav-item ${item.active ? "active" : ""}" type="button" ${attrs}>${inner}</button>`;
          },
        )
        .join("")}
    </div>
  `;
}

function sidebarFlyoutMarkup() {
  if (state.me?.role !== "admin" || state.sidebarPanel !== "upload") return "";
  return `
    <div class="sidebar-flyout" role="dialog" aria-label="Veri yükleme">
      <div class="sidebar-flyout-head">
        <div>
          <span>Bağlı işlem</span>
          <strong>Veri Yükleme</strong>
        </div>
        <button class="window-close sidebar-flyout-close" type="button" id="close-sidebar-panel" aria-label="Kapat">X</button>
      </div>
      ${uploadSectionMarkup()}
    </div>
  `;
}

function usersSectionMarkup() {
  if (state.me?.role !== "admin") return "";
  const agentCount = state.users.filter((user) => user.role === "agent").length;
  const adminCount = state.users.filter((user) => user.role === "admin").length;
  const offerAccessCount = state.users.filter((user) => canOpenOfferTool(user)).length;
  return `
    <section class="sidebar-section panel window-shell" data-window-title="Ekip Yetkilendirme">
      <div class="panel-head">
        <div>
          <h2>Ekip Yetkilendirme</h2>
          <p>Kullanıcı yönetimini açılır pencerede düzenle.</p>
        </div>
      </div>
      <div class="stack">
        <div class="mini-meta">
          <span>${adminCount} yönetici</span>
          <span>${agentCount} operatör</span>
          <span>${offerAccessCount} teklif erişimi</span>
          <span>${state.users.length} hesap</span>
        </div>
        <button class="btn btn-primary" type="button" id="open-team-modal">Ekip Penceresini Aç</button>
      </div>
    </section>
  `;
}

function teamModalMarkup() {
  if (state.me?.role !== "admin" || !state.teamModalOpen) return "";
  return `
    <div class="modal-backdrop" id="team-modal-backdrop">
      <section class="modal-window" id="team-modal" role="dialog" aria-modal="true" aria-labelledby="team-modal-title">
        <header class="modal-titlebar">
          <strong id="team-modal-title">Ekip Yetkilendirme</strong>
          <button class="window-close" type="button" id="close-team-modal" aria-label="Kapat">×</button>
        </header>
        <div class="modal-body">
          <section class="panel stack modal-panel">
            <div class="panel-head">
              <div>
                <p class="section-kicker">Yeni Hesap</p>
                <h2>Çalışan Ekle</h2>
                <p>Operatör veya yönetici hesabını bu pencereden aç.</p>
              </div>
            </div>
            <form id="user-form" class="stack">
              <input class="field" name="full_name" placeholder="Adı / takma adı" required />
              <input class="field" type="email" name="email" placeholder="Email" required />
              <input class="field" type="password" name="password" placeholder="Geçici şifre: Operator123!" required />
              <input class="field" type="number" min="0" max="1000" name="daily_target" placeholder="Günlük hedef (örn. 50)" />
              <select class="select" name="role">
                <option value="agent">Operatör</option>
                <option value="admin">Yönetici</option>
              </select>
              <label class="check-item">
                <input type="checkbox" name="can_access_offer_tool" />
                <span>Teklif modülüne erişsin</span>
              </label>
              <p class="file-note">Şifre en az 10 karakter, büyük/küçük harf, rakam ve sembol içermeli.</p>
              <button class="btn btn-primary" type="submit">Kullanıcı Ekle</button>
            </form>
          </section>

          <section class="panel stack modal-panel">
            <div class="panel-head">
              <div>
                <p class="section-kicker">Hesaplar</p>
                <h2>Kullanıcı Düzenleme</h2>
                <p>Şifre, ad, rol ve aktiflik burada yönetilir.</p>
              </div>
            </div>
            <div class="user-admin-table-wrap">
              <table class="user-admin-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Adı / Takma Adı</th>
                    <th>Rol</th>
                    <th>Hedef</th>
                    <th>Teklif</th>
                    <th>Yeni Şifre</th>
                    <th>Durum</th>
                    <th>İşlem</th>
                  </tr>
                </thead>
                <tbody>
                  ${state.users
                    .map(
                      (user) => `
                        <tr>
                          <td class="mono-cell">${escapeHtml(user.email)}</td>
                          <td>
                            <input class="field compact-field" data-user-name="${user.id}" value="${escapeHtml(user.full_name || "")}" placeholder="Adı / takma adı" />
                          </td>
                          <td>
                            <select class="select compact-select" data-user-role="${user.id}">
                              <option value="agent" ${user.role === "agent" ? "selected" : ""}>Operatör</option>
                              <option value="admin" ${user.role === "admin" ? "selected" : ""}>Yönetici</option>
                            </select>
                          </td>
                          <td>
                            <input class="field compact-field" type="number" min="0" max="1000" data-user-daily-target="${user.id}" value="${escapeHtml(user.daily_target || 0)}" />
                          </td>
                          <td>
                            <label class="inline-check">
                              <input type="checkbox" data-user-offer-access="${user.id}" ${canOpenOfferTool(user) ? "checked" : ""} ${
                                user.role === "admin" ? "disabled" : ""
                              } />
                              <span>${canOpenOfferTool(user) ? "Açık" : "Kapalı"}</span>
                            </label>
                          </td>
                          <td>
                            <input class="field compact-field" type="password" data-user-password="${user.id}" placeholder="Boş bırak = aynı kalsın" />
                          </td>
                          <td>
                            <label class="inline-check">
                              <input type="checkbox" data-user-active="${user.id}" ${user.is_active ? "checked" : ""} />
                              <span>${user.is_active ? "Aktif" : "Pasif"}</span>
                            </label>
                          </td>
                          <td>
                            <div class="row-actions">
                              <button class="btn btn-soft mini-button" type="button" data-user-save="${user.id}">Kaydet</button>
                              <button class="btn btn-danger mini-button" type="button" data-user-delete="${user.id}">Sil</button>
                            </div>
                          </td>
                        </tr>
                      `,
                    )
                    .join("")}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </section>
    </div>
  `;
}

function listsSectionMarkup() {
  return `
    <section class="sidebar-section panel window-shell" data-window-title="Liste Havuzu">
      <div class="panel-head">
        <div>
          <h2>Liste Havuzu</h2>
          <p>${state.lists.length} liste görünüyor.</p>
        </div>
      </div>
      <div class="stack">
        <div class="mini-meta">
          <span>${state.lists.filter((list) => list.is_active).length} aktif</span>
          <span>${state.lists.filter((list) => !list.is_active).length} pasif</span>
          <span>${selectedList() ? escapeHtml(selectedList().name) : "Liste seçilmedi"}</span>
        </div>
        <button class="btn btn-primary" type="button" id="open-lists-modal">Liste Penceresini Aç</button>
      </div>
    </section>
  `;
}

function listsModalMarkup() {
  if (!state.listsModalOpen) return "";
  return `
    <div class="modal-backdrop" id="lists-modal-backdrop">
      <section class="modal-window" id="lists-modal" role="dialog" aria-modal="true" aria-labelledby="lists-modal-title">
        <header class="modal-titlebar">
          <strong id="lists-modal-title">Liste Havuzu</strong>
          <button class="window-close" type="button" id="close-lists-modal" aria-label="Kapat">×</button>
        </header>
        <div class="modal-body single-column">
          <section class="panel stack modal-panel">
            <div class="panel-head">
              <div>
                <p class="section-kicker">Liste Havuzu</p>
                <h2>Liste Seçimi</h2>
                <p>Aktif operasyon listeleri bu pencereden seçilir.</p>
              </div>
            </div>
            <div class="list-grid modal-list-grid">
              ${state.lists.length
                ? state.lists
                    .map(
                      (list) => `
                        <div class="list-card ${list.id === state.selectedListId ? "active" : ""}">
                          <div class="list-card-head">
                            <div>
                              <h3>${escapeHtml(list.name)}</h3>
                              <p>${escapeHtml(list.source_file_name || "Elle oluşturuldu")}</p>
                            </div>
                            <span class="badge ${list.is_active ? "active" : "inactive"}">${list.is_active ? "Aktif" : "Pasif"}</span>
                          </div>
                          <div class="mini-meta">
                            <span>${list.summary.total} kayıt</span>
                            <span>${list.summary.assigned} atanmış</span>
                            <span>${list.duplicate_count} tekrar</span>
                          </div>
                          <div class="list-card-actions">
                            <button class="btn btn-soft mini-button" type="button" data-list-id="${list.id}" data-close-lists-modal="true">
                              ${list.id === state.selectedListId ? "Seçili" : "Listeyi Aç"}
                            </button>
                            ${
                              state.me?.role === "admin"
                                ? `<button class="btn ${list.is_active ? "btn-danger" : "btn-primary"} mini-button" type="button" data-list-toggle="${list.id}">
                                    ${list.is_active ? "Pasife Al" : "Etkinleştir"}
                                  </button>`
                                : ""
                            }
                          </div>
                        </div>
                      `,
                    )
                    .join("")
                : `<p class="empty">Henüz liste yok.</p>`}
            </div>
          </section>
        </div>
      </section>
    </div>
  `;
}

function contactPoolSectionMarkup() {
  if (state.me?.role !== "admin") return "";
  return `
    <section class="sidebar-section panel window-shell" data-window-title="İşlem Havuzu">
      <div class="panel-head">
        <div>
          <h2>İşlem Havuzu</h2>
          <p>Görüşülen, olumlu, olumsuz ve ulaşılamayan şirketleri ayrı havuzda tut.</p>
        </div>
      </div>
      <div class="stack">
        <div class="mini-meta">
          <span>${state.contactPoolPagination.total || 0} havuz kaydı</span>
          <span>ulaşıldı / ulaşılamadı</span>
        </div>
        <button class="btn btn-primary" type="button" id="open-contact-pool-modal">Havuz Penceresini Aç</button>
      </div>
    </section>
  `;
}

function contactPoolModalMarkup() {
  if (state.me?.role !== "admin" || !state.contactPoolModalOpen) return "";
  return `
    <div class="modal-backdrop" id="contact-pool-modal-backdrop">
      <section class="modal-window wide-modal" id="contact-pool-modal" role="dialog" aria-modal="true" aria-labelledby="contact-pool-modal-title">
        <header class="modal-titlebar">
          <strong id="contact-pool-modal-title">İşlem Havuzu</strong>
          <button class="window-close" type="button" id="close-contact-pool-modal" aria-label="Kapat">×</button>
        </header>
        <div class="modal-body single-column contact-pool-modal-body">
          <section class="panel stack modal-panel contact-pool-panel">
            <div class="panel-head">
              <div>
                <p class="section-kicker">Ulaşıldı / Ulaşılamadı</p>
                <h2>Şirket Havuzu</h2>
                <p>İşlem yapılmış şirketleri filtrele, havuz notu gir ve CSV çıktı al.</p>
              </div>
              <div class="mini-meta action-meta">
                <label class="pager-size-control">
                  <span>Sayfa</span>
                  <select class="select" id="contact-pool-page-size">
                    ${[10, 25, 50, 100]
                      .map(
                        (limit) =>
                          `<option value="${limit}" ${state.contactPoolPagination.limit === limit ? "selected" : ""}>${limit}</option>`,
                      )
                      .join("")}
                  </select>
                </label>
                <button class="btn btn-soft" type="button" id="contact-pool-export">CSV İndir</button>
              </div>
            </div>
            <div class="pool-toolbar">
              <input class="field" id="contact-pool-q" value="${escapeHtml(state.contactPoolFilters.q)}" placeholder="Firma, telefon, email, adres veya not ara" />
              <select class="select" id="contact-pool-reach">
                ${REACH_STATUS_OPTIONS.map(
                  ([value, label]) => `<option value="${value}" ${state.contactPoolFilters.reach_status === value ? "selected" : ""}>${label}</option>`,
                ).join("")}
              </select>
              <select class="select" id="contact-pool-result">
                ${[["", "Tüm sonuç durumları"], ...RESULT_STATUS_OPTIONS]
                  .map(
                    ([value, label]) => `<option value="${value}" ${state.contactPoolFilters.result_status === value ? "selected" : ""}>${label}</option>`,
                  )
                  .join("")}
              </select>
              <label class="check-item compact pool-check">
                <input type="checkbox" id="contact-pool-current-list" ${state.contactPoolFilters.current_list_only ? "checked" : ""} />
                <span>Seçili liste</span>
              </label>
              <label class="check-item compact pool-check">
                <input type="checkbox" id="contact-pool-active-only" ${state.contactPoolFilters.active_only ? "checked" : ""} />
                <span>Sadece aktif</span>
              </label>
              <button class="btn btn-primary" type="button" id="contact-pool-apply">Uygula</button>
              <button class="btn btn-soft" type="button" id="contact-pool-reset">Temizle</button>
            </div>
            <div class="user-admin-table-wrap pool-table-wrap">
              <table class="pool-table">
                <colgroup>
                  <col class="pool-company" />
                  <col class="pool-contact" />
                  <col class="pool-status" />
                  <col class="pool-note" />
                  <col class="pool-meta" />
                  <col class="pool-action" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Şirket</th>
                    <th>İletişim</th>
                    <th>Havuz Durumu</th>
                    <th>Not</th>
                    <th>Kaynak</th>
                    <th>İşlem</th>
                  </tr>
                </thead>
                <tbody>
                  ${state.contactPool.length
                    ? state.contactPool
                        .map((entry) => {
                          const current = contactPoolDraft(entry);
                          return `
                            <tr class="pool-row ${current.reach_status?.toLowerCase() || "unknown"}">
                              <td>
                                <div class="record-name">${escapeHtml(current.company_name || "-")}</div>
                                <div class="record-address">${escapeHtml(current.address || "-")}</div>
                                <div class="record-meta">${escapeHtml(current.call_list_name || "-")}</div>
                              </td>
                              <td>
                                <div class="table-cell-text">${escapeHtml(current.phone || "-")}</div>
                                <div class="record-meta">${escapeHtml(current.email || "-")}</div>
                                <div class="record-meta">${escapeHtml(current.website || "-")}</div>
                              </td>
                              <td>
                                <select class="select table-select" data-pool-reach="${entry.id}">
                                  ${REACH_STATUS_OPTIONS.filter(([value]) => value)
                                    .map(
                                      ([value, label]) =>
                                        `<option value="${value}" ${current.reach_status === value ? "selected" : ""}>${label}</option>`,
                                    )
                                    .join("")}
                                </select>
                                <div class="record-meta">${escapeHtml(current.call_status)} / ${escapeHtml(current.result_status)}</div>
                                <label class="inline-check pool-active-check">
                                  <input type="checkbox" data-pool-active="${entry.id}" ${current.is_active ? "checked" : ""} />
                                  <span>${current.is_active ? "Aktif" : "Pasif"}</span>
                                </label>
                              </td>
                              <td>
                                <textarea class="textarea table-note" data-pool-note="${entry.id}" rows="4">${escapeHtml(current.admin_note || "")}</textarea>
                                ${current.record_note ? `<div class="record-meta">Kayıt: ${escapeHtml(current.record_note)}</div>` : ""}
                              </td>
                              <td>
                                <div class="record-meta">Operatör: ${escapeHtml(current.assigned_user_name || "-")}</div>
                                <div class="record-meta">Güncelleyen: ${escapeHtml(current.updated_by_user_name || "-")}</div>
                                <div class="record-meta">${escapeHtml(formatDate(current.last_record_updated_at))}</div>
                              </td>
                              <td>
                                <div class="record-actions compact">
                                  ${
                                    canOpenOfferTool() && current.result_status === "POSITIVE"
                                      ? `<a class="btn btn-primary table-action" href="/teklif/" target="_blank" rel="noreferrer">Teklif Oluştur</a>`
                                      : ""
                                  }
                                  <button class="btn btn-soft table-action" type="button" data-pool-save="${entry.id}">Kaydet</button>
                                </div>
                              </td>
                            </tr>
                          `;
                        })
                        .join("")
                    : `<tr><td colspan="6"><p class="empty">Havuzda kayıt yok. Bir kaydı arandı, olumlu, olumsuz veya ulaşılamadı yapınca buraya düşer.</p></td></tr>`}
                </tbody>
              </table>
            </div>
            <div class="table-pager">
              <div class="table-pager-status">
                ${state.contactPoolPagination.total
                  ? `${state.contactPoolPagination.offset + 1}-${Math.min(
                      state.contactPoolPagination.offset + state.contactPoolPagination.limit,
                      state.contactPoolPagination.total,
                    )} / ${state.contactPoolPagination.total} havuz kaydı`
                  : "0 havuz kaydı"}
                <span>Sayfa ${contactPoolCurrentPage()} / ${contactPoolTotalPages()}</span>
              </div>
              <div class="table-pager-actions">
                <button class="btn btn-soft" type="button" id="contact-pool-page-prev" ${
                  state.contactPoolPagination.offset <= 0 ? "disabled" : ""
                }>Önceki Sayfa</button>
                <button class="btn btn-soft" type="button" id="contact-pool-page-next" ${
                  contactPoolCurrentPage() >= contactPoolTotalPages() ? "disabled" : ""
                }>Sonraki Sayfa</button>
              </div>
            </div>
          </section>
        </div>
      </section>
    </div>
  `;
}

function assignPanelMarkup() {
  if (state.me?.role !== "admin" || !selectedList()) return "";
  const agentUsers = activeAgents();
  const summary = assignSummaryValues(agentUsers);
  return `
    <section class="panel stack assignment-panel window-shell" data-window-title="Operasyon Dağıtımı">
      <div class="panel-head">
        <div>
          <p class="section-kicker">Dağıtım</p>
          <h2>Operasyon Dağıtımı</h2>
          <p>Seçilen operatörlere kayıt havuzunu kontrollü biçimde dağıt.</p>
        </div>
        <div class="mini-meta action-meta">
          <button class="btn btn-soft" type="button" id="export-button">CSV İndir</button>
          <button class="btn btn-danger" type="button" id="toggle-list-button">${selectedList().is_active ? "Pasife Al" : "Etkinleştir"}</button>
        </div>
      </div>
      <form id="assign-form" class="stack">
        <div class="assign-mode-grid">
          <label class="check-item">
            <input type="radio" name="distribution_strategy" value="equal" ${state.assignStrategy === "equal" ? "checked" : ""} />
            <span>Eşit dağıtım</span>
          </label>
          <label class="check-item">
            <input type="radio" name="distribution_strategy" value="custom" ${state.assignStrategy === "custom" ? "checked" : ""} />
            <span>Özel dağıtım</span>
          </label>
        </div>
        <div class="assign-monitor">
          <div class="assign-monitor-cell">
            <span>Kapsam</span>
            <strong id="assign-available-count">${summary.available}</strong>
          </div>
          <div class="assign-monitor-cell">
            <span>Operatör</span>
            <strong id="assign-selected-count">${summary.selectedAgents}</strong>
          </div>
          <div class="assign-monitor-cell">
            <span>İstenen</span>
            <strong id="assign-requested-count">${state.assignStrategy === "custom" ? summary.requested : "-"}</strong>
          </div>
          <div class="assign-monitor-cell assign-monitor-wide">
            <span>Durum</span>
            <strong id="assign-status-text">${
              state.assignStrategy === "custom"
                ? summary.overflow > 0
                  ? `${summary.overflow} kayıt fazla istendi.`
                  : `${summary.remainder} kayıt atanmamış kalır.`
                : "Eşit dağıtım aktif."
            }</strong>
          </div>
        </div>
        <select class="select" name="mode">
          <option value="unassigned" ${state.assignMode === "unassigned" ? "selected" : ""}>Sadece atanmamış kayıtlar</option>
          <option value="all" ${state.assignMode === "all" ? "selected" : ""}>Tüm listeyi yeniden dağıt</option>
        </select>
        <div class="assign-grid">
          ${agentUsers
            .map(
              (user) => `
                <div class="assign-row ${assignDraftFor(user.id).enabled ? "active" : ""}">
                  <label class="check-item assign-toggle">
                    <input type="checkbox" name="agent_ids" value="${user.id}" data-assign-user-enabled="${user.id}" ${assignDraftFor(user.id).enabled ? "checked" : ""} />
                    <span>
                      <strong>${escapeHtml(user.full_name || user.email)}</strong>
                      <span class="record-meta">${escapeHtml(user.email)}</span>
                    </span>
                  </label>
                  <label class="assign-count-field">
                    <span>Adet</span>
                    <input
                      class="field compact-field assign-count-input"
                      type="number"
                      min="0"
                      step="1"
                      inputmode="numeric"
                      data-assign-user-count="${user.id}"
                      value="${escapeHtml(assignDraftFor(user.id).count || "")}"
                      ${state.assignStrategy === "equal" ? "disabled" : ""}
                    />
                  </label>
                </div>
              `,
            )
            .join("")}
        </div>
        <p class="helper assign-helper">Özel dağıtımda işaretli operatörlere adet gir. Toplam adet, kapsamdaki kayıt sayısını aşamaz.</p>
        <button class="btn btn-primary" type="submit">${state.assignStrategy === "custom" ? "Özel Dağıtımı Uygula" : "Eşit Dağıt"}</button>
      </form>
    </section>
  `;
}

function operatorControlContentMarkup() {
  if (state.me?.role !== "admin") return "";
  const percent = (value, total) => (total > 0 ? Math.round((value / total) * 100) : 0);
  const operatorStatus = (item) => {
    const remaining = Math.max(0, item.assigned_count - item.processed_count);
    if (!item.is_active) return ["Pasif", "inactive"];
    if (!item.assigned_count) return ["Boşta", "idle"];
    if (!remaining) return ["Tamamladı", "done"];
    if (item.processed_count > 0) return ["Çalışıyor", "working"];
    return ["Bekliyor", "waiting"];
  };
  const totals = state.operatorStats.reduce(
    (sum, item) => ({
      assigned: sum.assigned + item.assigned_count,
      processed: sum.processed + item.processed_count,
      reached: sum.reached + item.reached_count,
      positive: sum.positive + item.positive_count,
      negative: sum.negative + item.negative_count,
      remaining: sum.remaining + Math.max(0, item.assigned_count - item.processed_count),
      activeOperators: sum.activeOperators + (item.is_active ? 1 : 0),
      idleOperators: sum.idleOperators + (item.is_active && item.assigned_count === 0 ? 1 : 0),
    }),
    { assigned: 0, processed: 0, reached: 0, positive: 0, negative: 0, remaining: 0, activeOperators: 0, idleOperators: 0 },
  );
  const completionRate = percent(totals.processed, totals.assigned);
  const reachRate = percent(totals.reached, totals.processed);
  const positiveRate = percent(totals.positive, totals.processed);
  return `
    <section class="panel stack operator-panel">
      <div class="panel-head">
        <div>
          <p class="section-kicker">Kullanıcı Odaklı Kontrol</p>
          <h2>Operatör Kontrol Merkezi</h2>
          <p>${selectedList() ? escapeHtml(selectedList().name) : "Tüm listeler"} için kimin üstünde ne iş var, ne kadarı bitmiş ve son hareket ne.</p>
        </div>
        <div class="mini-meta action-meta">
          <span>${totals.activeOperators} aktif operatör</span>
          <span>${totals.remaining} kalan kayıt</span>
          <span>${totals.positive} olumlu</span>
        </div>
      </div>
      <div class="operator-control-summary">
        <div>
          <span>Atanan</span>
          <strong>${totals.assigned}</strong>
        </div>
        <div>
          <span>İşlenen</span>
          <strong>${totals.processed}</strong>
        </div>
        <div>
          <span>Tamamlanma</span>
          <strong>%${completionRate}</strong>
        </div>
        <div>
          <span>Bağlantı</span>
          <strong>%${reachRate}</strong>
        </div>
        <div>
          <span>Olumlu Oran</span>
          <strong>%${positiveRate}</strong>
        </div>
        <div>
          <span>Boşta</span>
          <strong>${totals.idleOperators}</strong>
        </div>
      </div>
      <div class="operator-card-grid">
        ${
          state.operatorStats.length
            ? state.operatorStats
                .map((item) => {
                  const remaining = Math.max(0, item.assigned_count - item.processed_count);
                  const doneRate = percent(item.processed_count, item.assigned_count);
                  const itemReachRate = percent(item.reached_count, item.processed_count);
                  const itemPositiveRate = percent(item.positive_count, item.processed_count);
                  const [statusLabel, statusClass] = operatorStatus(item);
                  return `
                    <article class="operator-card ${
                      state.operatorDetailUserId === item.user_id || state.filters.assigned_user_id === item.user_id ? "selected" : ""
                    }">
                      <div class="operator-card-head">
                        <div>
                          <h3>${escapeHtml(item.full_name || item.email)}</h3>
                          <p>${escapeHtml(item.email)}</p>
                        </div>
                        <span class="operator-status ${statusClass}">${statusLabel}</span>
                      </div>
                      <div class="operator-progress">
                        <div class="operator-progress-fill ${percentBucketClass("width-pct", doneRate)}"></div>
                      </div>
                      <div class="operator-metrics">
                        <div><span>Atanan</span><strong>${item.assigned_count}</strong></div>
                        <div><span>Kalan</span><strong>${remaining}</strong></div>
                        <div><span>İşlem</span><strong>${item.processed_count}</strong></div>
                        <div><span>Bağlandı</span><strong>${item.reached_count}</strong></div>
                        <div><span>Olumlu</span><strong>${item.positive_count}</strong></div>
                        <div><span>Olumsuz</span><strong>${item.negative_count}</strong></div>
                      </div>
                      <div class="operator-card-foot">
                        <span>İlerleme %${doneRate}</span>
                        <span>Bağlantı %${itemReachRate}</span>
                        <span>Olumlu %${itemPositiveRate}</span>
                        <span>Son: ${escapeHtml(formatDate(item.last_activity_at))}</span>
                      </div>
                      <div class="operator-card-actions">
                        <button class="btn btn-primary mini-button" type="button" data-operator-detail="${item.user_id}">Kayıt Penceresi</button>
                        <button class="btn btn-soft mini-button" type="button" data-filter-operator="${item.user_id}">Ana Tabloda Göster</button>
                      </div>
                    </article>
                  `;
                })
                .join("")
            : `<p class="empty">Operatör yok.</p>`
        }
      </div>
      ${operatorDetailRecordsMarkup()}
      <div class="operator-table-wrap">
        <table class="operator-table">
          <caption>Operatör detay dökümü</caption>
          <thead>
            <tr>
              <th>Operatör</th>
              <th>Atanan</th>
              <th>Kalan</th>
              <th>İşlem</th>
              <th>Bağlandı</th>
              <th>Ulaşılamadı</th>
              <th>Olumlu</th>
              <th>Olumsuz</th>
              <th>Son İşlem</th>
              <th>Filtre</th>
            </tr>
          </thead>
          <tbody>
            ${
              state.operatorStats.length
                ? state.operatorStats
                    .map(
                      (item) => {
                        const remaining = Math.max(0, item.assigned_count - item.processed_count);
                        return `
                        <tr class="${
                          state.operatorDetailUserId === item.user_id || state.filters.assigned_user_id === item.user_id ? "active-operator-row" : ""
                        }">
                          <td>
                            <div class="record-name">${escapeHtml(item.full_name || item.email)}</div>
                            <div class="record-meta">${escapeHtml(item.email)}</div>
                            <span class="badge ${item.is_active ? "active" : "inactive"}">${item.is_active ? "Aktif" : "Pasif"}</span>
                          </td>
                          <td>${item.assigned_count}</td>
                          <td>${remaining}</td>
                          <td>${item.processed_count}</td>
                          <td>${item.reached_count}</td>
                          <td>${item.unreached_count}</td>
                          <td>${item.positive_count}</td>
                          <td>${item.negative_count}</td>
                          <td class="record-meta">${escapeHtml(formatDate(item.last_activity_at))}</td>
                          <td>
                            <button class="btn btn-soft mini-button" type="button" data-operator-detail="${item.user_id}">Detay</button>
                          </td>
                        </tr>
                      `;
                      },
                    )
                    .join("")
                : `<tr><td colspan="10"><p class="empty">Operatör yok.</p></td></tr>`
            }
          </tbody>
        </table>
      </div>
      <div class="mini-meta">
        <span>Toplam atanan: ${totals.assigned}</span>
        <span>Toplam olumsuz: ${totals.negative}</span>
        <span>Pasif operatörler raporda görünür ama yeni dağıtımda seçilmez.</span>
      </div>
    </section>
  `;
}

function operatorDetailRecordsMarkup() {
  const operator = selectedOperatorStat();
  const detailFilter = state.operatorDetailFilter || "all";
  const filterLabel =
    {
      all: "Toplam",
      processed: "İşlenen",
      positive: "Olumlu",
      assigned: "Atanan",
    }[detailFilter] || "Toplam";
  if (!state.operatorDetailUserId || !operator) {
    return `
      <section class="operator-detail-panel">
        <div class="operator-detail-empty">
          <strong>Operatör seçilmedi</strong>
          <span>Kartlardan bir operatör seçince o kişinin operasyon kayıtları burada ayrı olarak açılır.</span>
        </div>
      </section>
    `;
  }

  return `
    <section class="operator-detail-panel">
      <div class="operator-detail-head">
        <div>
          <p class="section-kicker">Operatör Kayıtları</p>
          <h3>${escapeHtml(operator.full_name || operator.email)}</h3>
          <p>${escapeHtml(operator.email)} / ${selectedList() ? escapeHtml(selectedList().name) : "Tüm listeler"}</p>
        </div>
        <div class="operator-detail-actions">
          <button class="btn btn-soft mini-button" type="button" data-filter-operator="${operator.user_id}">Ana Tabloda Aç</button>
          <button class="btn btn-soft mini-button" type="button" data-operator-detail-clear="true">Seçimi Temizle</button>
        </div>
      </div>
      <div class="operator-detail-summary">
        <button class="${detailFilter === "all" ? "active" : ""}" type="button" data-operator-detail-filter="all">
          <span>Toplam</span><strong>${operator.assigned_count}</strong>
        </button>
        <button class="${detailFilter === "processed" ? "active" : ""}" type="button" data-operator-detail-filter="processed">
          <span>İşlenen</span><strong>${operator.processed_count}</strong>
        </button>
        <button class="${detailFilter === "positive" ? "active" : ""}" type="button" data-operator-detail-filter="positive">
          <span>Olumlu</span><strong>${operator.positive_count}</strong>
        </button>
        <button class="${detailFilter === "assigned" ? "active" : ""}" type="button" data-operator-detail-filter="assigned">
          <span>Atanan</span><strong>${operator.assigned_count}</strong>
        </button>
      </div>
      <div class="mini-meta operator-detail-filter-state">
        <span>Aktif detay: ${escapeHtml(filterLabel)}</span>
        <span>${state.operatorDetailPagination.total} kayıt gösteriliyor</span>
      </div>
      <div class="operator-detail-table-wrap">
        <table class="operator-detail-table">
          <thead>
            <tr>
              <th>Firma</th>
              <th>İletişim</th>
              <th>Durum</th>
              <th>Not</th>
              <th>Güncel</th>
            </tr>
          </thead>
          <tbody>
            ${
              state.operatorDetailRecords.length
                ? state.operatorDetailRecords
                    .map(
                      (record) => `
                        <tr>
                          <td>
                            <div class="record-name">${escapeHtml(record.company_name || "-")}</div>
                            <div class="record-meta">${escapeHtml(record.call_list_name || "-")}</div>
                            <div class="record-address">${escapeHtml(record.address || "-")}</div>
                          </td>
                          <td>
                            <div class="table-cell-text">${escapeHtml(record.phone || "-")}</div>
                            <div class="record-meta">${escapeHtml(record.email || "-")}</div>
                            <div class="record-meta">${escapeHtml(record.website || "-")}</div>
                          </td>
                          <td>
                            <span class="badge active">${escapeHtml(callStatusLabel(record.call_status))}</span>
                            <span class="badge ${record.result_status === "POSITIVE" ? "active" : "inactive"}">${escapeHtml(
                              resultStatusLabel(record.result_status),
                            )}</span>
                          </td>
                          <td>
                            <div class="record-meta">${escapeHtml(record.note || "-")}</div>
                          </td>
                          <td>
                            <div class="record-meta">${escapeHtml(formatDate(record.updated_at))}</div>
                            <div class="record-meta">${escapeHtml(record.updated_by_user_name || "-")}</div>
                          </td>
                        </tr>
                      `,
                    )
                    .join("")
                : `<tr><td colspan="5"><p class="empty">Bu operatör için kayıt bulunamadı.</p></td></tr>`
            }
          </tbody>
        </table>
      </div>
      <div class="table-pager">
        <div class="table-pager-status">
          ${state.operatorDetailPagination.total
            ? `${state.operatorDetailPagination.offset + 1}-${Math.min(
                state.operatorDetailPagination.offset + state.operatorDetailPagination.limit,
                state.operatorDetailPagination.total,
              )} / ${state.operatorDetailPagination.total} kayıt`
            : "0 kayıt"}
          <span>Sayfa ${operatorDetailCurrentPage()} / ${operatorDetailTotalPages()}</span>
        </div>
        <div class="table-pager-actions">
          <button class="btn btn-soft" type="button" id="operator-detail-page-prev" ${
            state.operatorDetailPagination.offset <= 0 ? "disabled" : ""
          }>Önceki</button>
          <button class="btn btn-soft" type="button" id="operator-detail-page-next" ${
            operatorDetailCurrentPage() >= operatorDetailTotalPages() ? "disabled" : ""
          }>Sonraki</button>
        </div>
      </div>
    </section>
  `;
}

function operatorStatsPanelMarkup() {
  if (state.me?.role !== "admin") return "";
  const totals = state.operatorStats.reduce(
    (sum, item) => ({
      assigned: sum.assigned + item.assigned_count,
      processed: sum.processed + item.processed_count,
      remaining: sum.remaining + Math.max(0, item.assigned_count - item.processed_count),
      activeOperators: sum.activeOperators + (item.is_active ? 1 : 0),
    }),
    { assigned: 0, processed: 0, remaining: 0, activeOperators: 0 },
  );
  return `
    <section class="sidebar-section panel window-shell operator-launch-panel" data-window-title="Operatör Kontrolü">
      <div class="panel-head">
        <div>
          <h2>Operatör Kontrolü</h2>
          <p>Operatör bazlı iş yükü ve kayıt dökümünü ayrı pencerede yönet.</p>
        </div>
      </div>
      <div class="stack">
        <div class="mini-meta">
          <span>${totals.activeOperators} aktif operatör</span>
          <span>${totals.remaining} kalan</span>
          <span>${totals.processed}/${totals.assigned} işlem</span>
        </div>
        <button class="btn btn-primary" type="button" id="open-operator-control-modal">Kontrol Penceresini Aç</button>
      </div>
    </section>
  `;
}

function operatorControlModalMarkup() {
  if (state.me?.role !== "admin" || !state.operatorControlModalOpen) return "";
  return `
    <div class="modal-backdrop" id="operator-control-modal-backdrop">
      <section class="modal-window wide-modal" id="operator-control-modal" role="dialog" aria-modal="true" aria-labelledby="operator-control-modal-title">
        <header class="modal-titlebar">
          <strong id="operator-control-modal-title">Operatör Kontrol Merkezi</strong>
          <button class="window-close" type="button" id="close-operator-control-modal" aria-label="Kapat">×</button>
        </header>
        <div class="modal-body single-column operator-control-modal-body">
          ${operatorControlContentMarkup()}
        </div>
      </section>
    </div>
  `;
}

function filtersMarkup() {
  const activeFilters = activeRecordFilterLabels();
  return `
      <section class="panel filter-panel window-shell" data-window-title="Kayıt Filtresi">
        <div class="panel-head">
          <div>
            <p class="section-kicker">Filtreleme</p>
          <h2>Kayıt Filtresi</h2>
          <p>Firma, durum, operatör ve atama bazında havuzu daralt.</p>
          </div>
          <div class="filter-state">
            <span class="badge ${activeFilters.length ? "warning" : "active"}">Aktif görünüm: ${
              activeFilters.length ? escapeHtml(activeFilters.join(" + ")) : "genel liste"
            }</span>
          </div>
        </div>
        ${
          activeFilters.length
            ? `<div class="filter-explain active-filter-strip">
                <div class="filter-chip-row" aria-label="Aktif filtreler">
                  ${activeFilters.map((label) => `<span class="filter-chip">${escapeHtml(label)} <button type="button" data-clear-record-filters aria-label="Filtreleri temizle">×</button></span>`).join("")}
                </div>
                <button class="btn btn-soft mini-button" type="button" data-clear-record-filters>Filtreleri temizle</button>
              </div>`
            : ""
        }
        <div class="toolbar">
          <input class="field" id="filter-q" placeholder="Firma, telefon, adres veya email ara" value="${escapeHtml(state.filters.q)}" />
        <select class="select" id="filter-call-status">
          <option value="">Tüm arama durumları</option>
          ${CALL_STATUS_OPTIONS
            .map(([value, label]) => `<option value="${value}" ${state.filters.call_status === value ? "selected" : ""}>${label}</option>`)
            .join("")}
        </select>
        <select class="select" id="filter-result-status">
          <option value="">Tüm sonuç durumları</option>
          ${RESULT_STATUS_OPTIONS
            .map(([value, label]) => `<option value="${value}" ${state.filters.result_status === value ? "selected" : ""}>${label}</option>`)
            .join("")}
        </select>
        ${
          state.me?.role === "admin"
            ? `<select class="select" id="filter-assigned-user">
                <option value="">Tüm operatörler</option>
                ${state.users
                  .filter((user) => user.role === "agent")
                  .map(
                    (user) =>
                      `<option value="${user.id}" ${state.filters.assigned_user_id === user.id ? "selected" : ""}>${escapeHtml(
                        user.full_name || user.email,
                      )}</option>`,
                  )
                  .join("")}
              </select>`
            : ""
        }
        <label class="check-item compact">
          <input type="checkbox" id="filter-unassigned" ${state.filters.unassigned ? "checked" : ""} />
          <span>Atanmamış</span>
        </label>
        <button class="btn btn-soft" type="button" id="filters-apply">Uygula</button>
        <button class="btn btn-soft" type="button" id="filters-reset">Temizle</button>
      </div>
      <div class="filter-presence">
        <label class="check-item">
          <input type="checkbox" id="filter-has-email" ${state.filters.has_email ? "checked" : ""} />
          <span>Sadece e-posta olanlar</span>
        </label>
        <label class="check-item">
          <input type="checkbox" id="filter-has-phone" ${state.filters.has_phone ? "checked" : ""} />
          <span>Telefonu olanlar</span>
        </label>
        <label class="check-item">
          <input type="checkbox" id="filter-has-address" ${state.filters.has_address ? "checked" : ""} />
          <span>Adresi olanlar</span>
        </label>
        <label class="check-item">
          <input type="checkbox" id="filter-has-website" ${state.filters.has_website ? "checked" : ""} />
          <span>Web sitesi olanlar</span>
        </label>
        <label class="check-item">
          <input type="checkbox" id="filter-due-callbacks" ${state.filters.due_callbacks ? "checked" : ""} />
          <span>Takip zamanı gelenler</span>
        </label>
      </div>
    </section>
  `;
}

function ownerCellMarkup(record) {
  if (state.me?.role === "admin") {
    return `
      <select class="select table-select" data-record-assignee="${record.id}">
        <option value="">Atanmamış</option>
        ${state.users
          .filter((user) => user.role === "agent" && user.is_active)
          .map(
            (user) =>
              `<option value="${user.id}" ${record.assigned_user_id === user.id ? "selected" : ""}>${escapeHtml(user.full_name || user.email)}</option>`,
          )
          .join("")}
      </select>
    `;
  }

  return `<div class="table-cell-text">${escapeHtml(record.assigned_user_name || state.me?.full_name || state.me?.email || "-")}</div>`;
}

function recordsTableMarkup() {
  const shownCount = state.records.length;
  const list = selectedList();
  const filtersActive = hasActiveRecordFilters();
  const activeFilters = activeRecordFilterLabels();
  const listTotal = list?.summary?.total ?? 0;
  return `
    <section class="panel stack records-panel window-shell" data-window-title="Operasyon Kayıtları">
        <div class="panel-head">
          <div>
            <p class="section-kicker">Operasyon</p>
            <h2>Operasyon Kayıtları</h2>
            <p>${shownCount} satır gösteriliyor / ${filtersActive ? "filtre sonucu" : "toplam"} ${state.pagination.total} kayıt.</p>
          </div>
          ${
            filtersActive
              ? `<div class="filter-state"><span class="badge warning">Filtre: ${escapeHtml(activeFilters.join(" + "))}</span></div>`
              : ""
          }
        </div>
        ${
          filtersActive && shownCount === 0 && listTotal > 0
            ? `<div class="record-filter-empty">
                <strong>Liste boş değil, aktif filtre kayıtları gizliyor.</strong>
                <span>Seçili listede ${listTotal} kayıt var. Şu anki filtre sonucu 0 kayıt döndürüyor.</span>
                <button class="btn btn-primary mini-button" type="button" data-clear-record-filters>Filtreleri temizle ve listeyi göster</button>
              </div>`
            : ""
        }
        <div class="table-wrap">
          <table class="records-table">
          <colgroup>
            <col class="col-row" />
            <col class="col-company" />
            <col class="col-address" />
            <col class="col-phone" />
            <col class="col-email" />
            <col class="col-web" />
            <col class="col-owner" />
            <col class="col-call" />
            <col class="col-result" />
            <col class="col-note" />
            <col class="col-callback" />
            <col class="col-updated" />
            <col class="col-action" />
          </colgroup>
          <thead>
            <tr>
              <th>Satır</th>
              <th>Firma</th>
              <th>Adres</th>
              <th>Telefon</th>
              <th>E-posta</th>
              <th>Web</th>
              <th>Sorumlu</th>
              <th>Arama</th>
              <th>Sonuç</th>
              <th>Not</th>
              <th>Takip</th>
              <th>Güncel</th>
              <th>İşlem</th>
            </tr>
          </thead>
          <tbody>
            ${
              state.records.length
                ? state.records.map((record, index) => {
                const current = recordDraft(record);
                const rowClass =
                  current.result_status === "POSITIVE"
                    ? "positive"
                    : current.result_status === "NEGATIVE" || current.result_status === "NOT_INTERESTED"
                      ? "negative"
                      : current.call_status === "CALLING"
                        ? "calling"
                        : "";
                return `
                  <tr class="record-row ${rowClass}">
                    <td>
                      <div class="table-cell-text table-row-number">${escapeHtml(current.source_row_number || index + 2)}</div>
                    </td>
                    <td>
                      <div class="record-name">${escapeHtml(current.company_name || "-")}</div>
                      <div class="record-meta">${escapeHtml(current.call_list_name || "-")}</div>
                    </td>
                    <td>
                      <div class="record-address">${escapeHtml(current.address || "-")}</div>
                    </td>
                    <td>
                      <div class="table-cell-text">${escapeHtml(current.phone || "-")}</div>
                    </td>
                    <td>
                      <div class="table-cell-text">${escapeHtml(current.email || "-")}</div>
                      <div class="record-meta">${escapeHtml(current.email_status || "-")}</div>
                    </td>
                    <td>
                      <div class="table-cell-text">${escapeHtml(current.website || "-")}</div>
                    </td>
                    <td>
                      ${ownerCellMarkup(current)}
                    </td>
                    <td>
                      <select class="select table-select status-control call-${String(current.call_status || "").toLowerCase()}" data-record-call-status="${current.id}">
                        ${CALL_STATUS_OPTIONS
                          .map(([value, label]) => `<option value="${value}" ${current.call_status === value ? "selected" : ""}>${label}</option>`)
                          .join("")}
                      </select>
                    </td>
                    <td>
                      <select class="select table-select status-control result-${String(current.result_status || "").toLowerCase()}" data-record-result-status="${current.id}">
                        ${RESULT_STATUS_OPTIONS
                          .map(([value, label]) => `<option value="${value}" ${current.result_status === value ? "selected" : ""}>${label}</option>`)
                          .join("")}
                      </select>
                    </td>
                    <td>
                      <textarea class="textarea table-note" data-record-note="${current.id}" rows="4">${escapeHtml(current.note || "")}</textarea>
                    </td>
                    <td>
                      <input class="field table-date" type="datetime-local" data-record-callback="${current.id}" value="${escapeHtml(formatDateTimeInput(current.callback_at))}" />
                      <div class="record-meta">${current.callback_at ? escapeHtml(formatDate(current.callback_at)) : "Takip zamanı yok"}</div>
                    </td>
                    <td>
                      <div class="record-meta">${formatDate(current.updated_at)}</div>
                      <div class="record-meta">${escapeHtml(current.updated_by_user_name || current.assigned_user_name || "-")}</div>
                      <div class="record-meta">${escapeHtml(current.result_status || "-")}</div>
                    </td>
                    <td>
                      <div class="record-actions compact">
                        ${
                          canOpenOfferTool() && current.result_status === "POSITIVE"
                            ? `<a class="btn btn-primary table-action" href="/teklif/" target="_blank" rel="noreferrer">Teklif Oluştur</a>`
                            : ""
                        }
                        <button class="btn btn-soft table-action" type="button" data-save-record="${current.id}">Kaydet</button>
                      </div>
                    </td>
                  </tr>
                `;
              })
              .join("")
                : `<tr class="empty-record-row">
                    <td colspan="13">
                      <div class="table-empty-state">
                        <strong>${filtersActive ? "Filtreye uyan kayıt yok." : "Bu görünümde kayıt yok."}</strong>
                        <span>${
                          filtersActive
                            ? `Filtreleri temizlersen seçili listedeki ${listTotal} kaydı tekrar görürsün.`
                            : "Liste seçimi veya veri yükleme durumunu kontrol et."
                        }</span>
                        ${
                          filtersActive
                            ? `<button class="btn btn-soft mini-button" type="button" data-clear-record-filters>Filtreleri temizle</button>`
                            : ""
                        }
                      </div>
                    </td>
                  </tr>`
            }
          </tbody>
        </table>
      </div>
      <div class="table-pager">
        <div class="table-pager-status">
          ${state.pagination.total
            ? `${state.pagination.offset + 1}-${Math.min(state.pagination.offset + state.pagination.limit, state.pagination.total)} / ${state.pagination.total} kayıt`
            : "0 kayıt"}
          <span>Sayfa ${currentPage()} / ${totalPages()}</span>
        </div>
        <div class="table-pager-actions">
          <button class="btn btn-soft" type="button" id="page-prev" ${state.pagination.offset <= 0 ? "disabled" : ""}>Önceki Sayfa</button>
          <button class="btn btn-soft" type="button" id="page-next" ${currentPage() >= totalPages() ? "disabled" : ""}>Sonraki Sayfa</button>
        </div>
      </div>
    </section>
  `;
}

function activityPanelMarkup() {
  if (state.me?.role !== "admin") return "";
  return `
    <section class="panel stack compact-activity window-shell" data-window-title="İşlem Geçmişi">
      <div class="panel-head">
        <div>
          <p class="section-kicker">Son Hareketler</p>
          <h2>İşlem Geçmişi</h2>
          <p>Son 25 saha hareketi.</p>
        </div>
      </div>
      <div class="activity-list">
        ${state.activity.length
          ? state.activity
              .map(
                (item) => `
                  <article class="activity-item">
                    <div class="activity-head">
                      <strong>${escapeHtml(item.actor_user_name || item.actor_role)}</strong>
                      <span class="record-meta">${formatDate(item.created_at)}</span>
                    </div>
                    <div class="activity-body">
                      <div>${escapeHtml(item.company_name || "-")} / ${escapeHtml(item.call_list_name)}</div>
                      <div class="record-meta">
                        ${escapeHtml(item.action)} / ${escapeHtml(item.previous_call_status || "-")} -> ${escapeHtml(item.next_call_status || "-")} / ${escapeHtml(item.next_result_status || "-")}
                      </div>
                      ${item.note ? `<div class="record-meta">${escapeHtml(item.note)}</div>` : ""}
                    </div>
                  </article>
                `,
              )
              .join("")
          : `<p class="empty">Henüz hareket yok.</p>`}
      </div>
    </section>
  `;
}

function agentCardsMarkup() {
  return recordsTableMarkup();
}

function offerNotificationTitle(item) {
  const target = item.company_name || item.contact_name || item.offer_number || "Teklif";
  return item.status === "approved"
    ? `${target} teklifi onaylandÄ±`
    : `${target} teklifi reddedildi`;
}

function offerNotificationsMarkup() {
  if (!state.offerNotifications.length) return "";
  return `
    <section class="offer-notification-strip" aria-label="Teklif bildirimi">
      <div>
        <span>Teklif bildirimi</span>
        <strong>${state.offerNotifications.length} teklif sonucu var</strong>
        <small>DetayÄ± gÃ¶rmek iÃ§in ilgili bildirime tÄ±kla</small>
      </div>
      <div class="offer-notification-actions">
        ${state.offerNotifications
          .map(
            (item) => `
              <button class="btn ${item.status === "approved" ? "btn-primary" : "btn-soft"}" type="button" data-offer-notification-open="${escapeHtml(item.id)}">
                ${escapeHtml(item.status === "approved" ? "OnaylandÄ±" : "Reddedildi")} / ${escapeHtml(item.offer_number || item.company_name || "Teklif")}
              </button>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function offerNotificationModalMarkup() {
  const item = state.offerNotifications.find((candidate) => candidate.id === state.offerNotificationModalId);
  if (!item) return "";
  const isApproved = item.status === "approved";
  return `
    <div class="modal-backdrop" id="offer-notification-backdrop">
      <section class="modal-window" id="offer-notification-modal" role="dialog" aria-modal="true" aria-labelledby="offer-notification-title">
        <header class="modal-titlebar">
          <strong id="offer-notification-title">${escapeHtml(isApproved ? "Teklif onaylandÄ±" : "Teklif reddedildi")}</strong>
          <button class="window-close" type="button" id="close-offer-notification-modal" aria-label="Kapat">×</button>
        </header>
        <div class="modal-body single-column">
          <section class="panel stack modal-panel offer-notification-detail">
            <p class="section-kicker mb-1">Teklif bildirimi</p>
            <h2>${escapeHtml(offerNotificationTitle(item))}</h2>
            <dl class="notification-pairs">
              <div><dt>Teklif no</dt><dd>${escapeHtml(item.offer_number || "-")}</dd></div>
              <div><dt>Dosya</dt><dd>${escapeHtml(item.generated_name || "-")}</dd></div>
              <div><dt>Firma</dt><dd>${escapeHtml(item.company_name || item.contact_name || "-")}</dd></div>
            </dl>
            ${
              isApproved
                ? `<p class="helper">Admin tarafÄ±ndan onaylandÄ±. Teklifi buradan indirebilirsin.</p>
                   <a class="btn btn-primary" href="${escapeHtml(item.download_url)}">Teklifi indir</a>`
                : `<p class="helper">Admin tarafÄ±ndan reddedildi. Ä°ndirme kapatÄ±ldÄ±.</p>
                   <div class="reject-reason"><span>Red sebebi</span><strong>${escapeHtml(item.rejection_reason || "Sebep belirtilmedi.")}</strong></div>
                   <button class="btn btn-outline-primary" type="button" data-offer-notification-dismiss="${escapeHtml(item.id)}">Bildirimi kapat</button>`
            }
          </section>
        </div>
      </section>
    </div>
  `;
}

function appMarkup() {
  const currentList = selectedList();
  return `
    <div class="app-shell">
      <aside class="sidebar">
        ${sidebarNavMarkup(currentList)}
        ${sidebarFlyoutMarkup()}
      </aside>

      <main class="main">
        ${rainwaterBrandBannerMarkup()}
        ${sessionHeaderMarkup(currentList)}

        ${state.flash ? `<div class="flash ${state.flash.type}">${escapeHtml(state.flash.text)}</div>` : ""}
        ${offerNotificationsMarkup()}
        ${statsMarkup()}
        ${operationFocusRailMarkup(currentList)}
        ${managementDashboardMarkup()}
        ${agentTaskDeskMarkup()}
        ${filtersMarkup()}
        ${
          state.me?.role === "admin"
            ? `<div class="command-grid">${assignPanelMarkup()}${activityPanelMarkup()}</div>`
            : ""
        }
        ${recordsTableMarkup()}
      </main>
      ${teamModalMarkup()}
      ${listsModalMarkup()}
      ${contactPoolModalMarkup()}
      ${operatorControlModalMarkup()}
      ${offerNotificationModalMarkup()}
    </div>
  `;
}

function render() {
  document.body.classList.toggle(
    "modal-open",
    Boolean(state.teamModalOpen || state.listsModalOpen || state.contactPoolModalOpen || state.operatorControlModalOpen || state.offerNotificationModalId),
  );
  appNode.innerHTML = state.booting ? bootMarkup() : state.me ? appMarkup() : loginMarkup();
  bindEvents();
}

async function handleLogin(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const response = await api("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: formString(form, "email"),
        password: formString(form, "password"),
      }),
    });
    state.token = response.access_token;
    sessionStorage.setItem("callPortalToken", state.token);
    localStorage.removeItem("callPortalToken");
    await loadSession();
    render();
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  } catch (error) {
    setFlash("error", error.message);
  }
}

async function handleUserCreate(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const fullName = formString(form, "full_name");
  const email = formString(form, "email").toLowerCase();
  const password = formString(form, "password");
  const role = formString(form, "role") || "agent";
  const canAccessOfferTool = form.has("can_access_offer_tool");
  const dailyTarget = Math.max(0, Number(formString(form, "daily_target") || 0));

  if (fullName.length < 2) {
    setFlash("error", "Ad / takma ad en az 2 karakter olmalı.");
    return;
  }
  if (!email.includes("@")) {
    setFlash("error", "Geçerli bir email gir.");
    return;
  }
  const passwordError = passwordPolicyError(password);
  if (passwordError) {
    setFlash("error", passwordError);
    return;
  }

  try {
    await api("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_name: fullName,
        email,
        password,
        role,
        daily_target: dailyTarget,
        can_access_offer_tool: role === "admin" ? true : canAccessOfferTool,
      }),
    });
    event.currentTarget.reset();
    await loadUsersIfAdmin();
    render();
    syncAssignSummaryDisplay();
    setFlash("success", "Kullanıcı oluşturuldu.");
  } catch (error) {
    setFlash("error", error.message);
  }
}

function openTeamModal() {
  state.sidebarPanel = "";
  state.teamModalOpen = true;
  render();
}

function closeTeamModal() {
  state.teamModalOpen = false;
  render();
}

function openListsModal() {
  state.sidebarPanel = "";
  state.listsModalOpen = true;
  render();
}

function closeListsModal() {
  state.listsModalOpen = false;
  render();
}

async function openContactPoolModal() {
  state.sidebarPanel = "";
  state.contactPoolModalOpen = true;
  state.contactPoolPagination.offset = 0;
  try {
    await loadContactPool();
  } catch (error) {
    setFlash("error", error.message);
  }
  render();
}

function closeContactPoolModal() {
  state.contactPoolModalOpen = false;
  state.contactPoolDrafts = {};
  render();
}

async function openOperatorControlModal() {
  state.sidebarPanel = "";
  state.operatorControlModalOpen = true;
  if (!state.operatorDetailUserId && state.operatorStats.length) {
    state.operatorDetailUserId = state.operatorStats.find((item) => item.is_active)?.user_id || state.operatorStats[0].user_id;
    state.operatorDetailPagination.offset = 0;
  }
  try {
    await loadOperatorStats();
    if (!state.operatorDetailUserId && state.operatorStats.length) {
      state.operatorDetailUserId = state.operatorStats.find((item) => item.is_active)?.user_id || state.operatorStats[0].user_id;
      state.operatorDetailPagination.offset = 0;
    }
    if (state.operatorDetailUserId) {
      await loadOperatorDetailRecords();
    }
  } catch (error) {
    setFlash("error", error.message);
  }
  render();
}

function closeOperatorControlModal() {
  state.operatorControlModalOpen = false;
  render();
}

function openOfferNotification(notificationId) {
  state.offerNotificationModalId = notificationId || "";
  render();
}

function closeOfferNotificationModal() {
  state.offerNotificationModalId = "";
  render();
}

async function dismissOfferNotification(notificationId) {
  try {
    await api(`/api/offer-notifications/${encodeURIComponent(notificationId)}/dismiss`, { method: "POST" });
    state.offerNotificationModalId = "";
    await loadOfferNotifications();
    render();
  } catch (error) {
    setFlash("error", error.message);
  }
}

async function selectOperatorDetail(userId) {
  state.operatorDetailUserId = userId || "";
  state.operatorDetailFilter = "all";
  state.operatorDetailPagination.offset = 0;
  try {
    await loadOperatorDetailRecords();
    render();
  } catch (error) {
    setFlash("error", error.message);
  }
}

async function setOperatorDetailFilter(filter) {
  state.operatorDetailFilter = filter || "all";
  state.operatorDetailPagination.offset = 0;
  try {
    await loadOperatorDetailRecords();
    render();
  } catch (error) {
    setFlash("error", error.message);
  }
}

async function handleUserUpdate(userId) {
  const fullName = document.querySelector(`[data-user-name='${userId}']`)?.value?.trim() ?? "";
  const role = document.querySelector(`[data-user-role='${userId}']`)?.value ?? "agent";
  const canAccessOfferTool = Boolean(document.querySelector(`[data-user-offer-access='${userId}']`)?.checked);
  const password = document.querySelector(`[data-user-password='${userId}']`)?.value?.trim() ?? "";
  const isActive = Boolean(document.querySelector(`[data-user-active='${userId}']`)?.checked);
  const dailyTarget = Math.max(0, Number(document.querySelector(`[data-user-daily-target='${userId}']`)?.value || 0));

  if (!fullName) {
    setFlash("error", "Kullanıcı adı boş bırakılamaz.");
    return;
  }
  const passwordError = password ? passwordPolicyError(password) : "";
  if (passwordError) {
    setFlash("error", passwordError);
    return;
  }

  try {
    await api(`/api/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_name: fullName,
        role,
        daily_target: dailyTarget,
        can_access_offer_tool: role === "admin" ? true : canAccessOfferTool,
        is_active: isActive,
        ...(password ? { password } : {}),
      }),
    });
    await loadUsersIfAdmin();
    await refreshOperationalData("team-update");
    render();
    setFlash("success", "Kullanıcı güncellendi.");
  } catch (error) {
    setFlash("error", error.message);
  }
}

async function handleUserDelete(userId) {
  const label = document.querySelector(`[data-user-name='${userId}']`)?.value?.trim() || userId;
  if (!window.confirm(`${label} hesabı silinsin mi?`)) return;
  try {
    await api(`/api/users/${userId}`, {
      method: "DELETE",
    });
    await loadUsersIfAdmin();
    await refreshOperationalData("team-delete");
    render();
    setFlash("success", "Kullanıcı silindi.");
  } catch (error) {
    setFlash("error", error.message);
  }
}

async function handleUpload(event) {
  event.preventDefault();
  const file = state.uploadFile;
  if (!file) {
    setFlash("error", "Lütfen bir .xlsx dosyası seç.");
    return;
  }
  try {
    await api("/api/lists/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "X-File-Name": file.name,
        "X-List-Name": state.uploadListName.trim(),
      },
      body: await file.arrayBuffer(),
    });
    state.uploadFile = null;
    state.uploadListName = "";
    await refreshOperationalData("upload");
    render();
    setFlash("success", "Liste sisteme aktarıldı.");
  } catch (error) {
    setFlash("error", error.message);
  }
}

async function handleAssign(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    if (!state.selectedListId) {
      setFlash("error", "Dağıtım için önce bir liste seç.");
      return;
    }
    const mode = form.querySelector("[name='mode']").value;
    let response;
    if (state.assignStrategy === "custom") {
      const allocations = activeAgents()
        .map((user) => ({
          user_id: user.id,
          enabled: Boolean(form.querySelector(`[data-assign-user-enabled='${user.id}']`)?.checked),
          count: Number(form.querySelector(`[data-assign-user-count='${user.id}']`)?.value || 0),
        }))
        .filter((item) => item.enabled && item.count > 0)
        .map(({ user_id, count }) => ({ user_id, count }));

      if (!allocations.length) {
        setFlash("error", "Özel dağıtım için en az bir operatör ve adet gir.");
        return;
      }

      response = await api(`/api/lists/${state.selectedListId}/assign-custom`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allocations, mode }),
      });
    } else {
      const selectedIds = [...form.querySelectorAll("input[name='agent_ids']:checked")].map((item) => item.value);
      if (!selectedIds.length) {
        setFlash("error", "Dağıtım için en az bir operatör seç.");
        return;
      }

      response = await api(`/api/lists/${state.selectedListId}/assign-evenly`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_ids: selectedIds,
          mode,
        }),
      });
    }
    await refreshOperationalData(state.assignStrategy === "custom" ? "custom-assign" : "equal-assign");
    render();
    if (state.assignStrategy === "custom") {
      setFlash(
        "success",
        `${response.assigned_count} kayıt özel dağıtıldı.${response.remaining_count ? ` ${response.remaining_count} kayıt atanmamış bırakıldı.` : ""}`,
      );
    } else {
      setFlash("success", `${response.assigned_count} kayıt dağıtıldı.`);
    }
  } catch (error) {
    setFlash("error", error.message);
  }
}

async function handleSaveRecord(recordId) {
  const draft = state.recordDrafts[recordId] || {};
  const assigneeField = document.querySelector(`[data-record-assignee='${recordId}']`);
  const noteField = document.querySelector(`[data-record-note='${recordId}']`);
  const callbackField = document.querySelector(`[data-record-callback='${recordId}']`);
  const callStatusField = document.querySelector(`[data-record-call-status='${recordId}']`);
  const resultStatusField = document.querySelector(`[data-record-result-status='${recordId}']`);

  const payload = {
    call_status: draft.call_status ?? callStatusField?.value,
    result_status: draft.result_status ?? resultStatusField?.value,
    note: draft.note ?? noteField?.value ?? "",
    callback_at: draft.callback_at ?? callbackField?.value ?? "",
  };

  if (state.me?.role === "admin") {
    const assigned = draft.assigned_user_id ?? (assigneeField?.value || null);
    payload.assigned_user_id = assigned;
    payload.clear_assignment = !assigned;
  }

  try {
    await api(`/api/records/${recordId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    delete state.recordDrafts[recordId];
    await refreshOperationalData("record-save");
    render();
    setFlash("success", "Kayıt güncellendi.");
  } catch (error) {
    setFlash("error", error.message);
  }
}

async function handleToggleList(listId = state.selectedListId) {
  const list = state.lists.find((item) => item.id === listId);
  if (!list) return;
  try {
    await api(`/api/lists/${list.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !list.is_active }),
    });
    await refreshOperationalData("list-toggle");
    render();
    setFlash("success", `Liste ${list.is_active ? "pasife alındı" : "etkinleştirildi"}.`);
  } catch (error) {
    setFlash("error", error.message);
  }
}

async function handleExport() {
  const list = selectedList();
  if (!list) return;
  try {
    const blob = await api(`/api/lists/${list.id}/export.csv`);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${list.name}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    setFlash("error", error.message);
  }
}

function contactPoolQueryParams(includePaging = true) {
  const params = new URLSearchParams();
  if (state.contactPoolFilters.current_list_only && state.selectedListId) {
    params.set("call_list_id", state.selectedListId);
  }
  if (state.contactPoolFilters.q.trim()) params.set("q", state.contactPoolFilters.q.trim());
  if (state.contactPoolFilters.reach_status) params.set("reach_status", state.contactPoolFilters.reach_status);
  if (state.contactPoolFilters.result_status) params.set("result_status", state.contactPoolFilters.result_status);
  if (!state.contactPoolFilters.active_only) params.set("include_inactive", "true");
  if (includePaging) {
    params.set("offset", String(state.contactPoolPagination.offset));
    params.set("limit", String(state.contactPoolPagination.limit));
  }
  return params;
}

async function applyContactPoolFilters() {
  state.contactPoolFilters.q = document.querySelector("#contact-pool-q")?.value ?? "";
  state.contactPoolFilters.reach_status = document.querySelector("#contact-pool-reach")?.value ?? "";
  state.contactPoolFilters.result_status = document.querySelector("#contact-pool-result")?.value ?? "";
  state.contactPoolFilters.current_list_only = Boolean(document.querySelector("#contact-pool-current-list")?.checked);
  state.contactPoolFilters.active_only = Boolean(document.querySelector("#contact-pool-active-only")?.checked);
  state.contactPoolPagination.offset = 0;
  try {
    await loadContactPool();
    render();
    setFlash("success", `Havuz filtresi uygulandı: ${state.contactPoolPagination.total} kayıt.`);
  } catch (error) {
    setFlash("error", error.message);
  }
}

async function resetContactPoolFilters() {
  state.contactPoolFilters = { ...DEFAULT_CONTACT_POOL_FILTERS };
  state.contactPoolPagination.offset = 0;
  try {
    await loadContactPool();
    render();
    setFlash("success", "Havuz filtresi temizlendi.");
  } catch (error) {
    setFlash("error", error.message);
  }
}

async function handleContactPoolSave(entryId) {
  const draft = state.contactPoolDrafts[entryId] || {};
  const reachField = document.querySelector(`[data-pool-reach='${entryId}']`);
  const noteField = document.querySelector(`[data-pool-note='${entryId}']`);
  const activeField = document.querySelector(`[data-pool-active='${entryId}']`);
  try {
    await api(`/api/contact-pool/${entryId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reach_status: draft.reach_status ?? reachField?.value,
        admin_note: draft.admin_note ?? noteField?.value ?? "",
        is_active: draft.is_active ?? Boolean(activeField?.checked),
      }),
    });
    delete state.contactPoolDrafts[entryId];
    await loadContactPool();
    render();
    setFlash("success", "Havuz kaydı güncellendi.");
  } catch (error) {
    setFlash("error", error.message);
  }
}

async function handleContactPoolExport() {
  try {
    const blob = await api(`/api/contact-pool/export.csv?${contactPoolQueryParams(false).toString()}`);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "islem-havuzu.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    setFlash("error", error.message);
  }
}

async function applyFilters() {
  state.filters.q = document.querySelector("#filter-q")?.value ?? "";
  state.filters.call_status = document.querySelector("#filter-call-status")?.value ?? "";
  state.filters.result_status = document.querySelector("#filter-result-status")?.value ?? "";
  state.filters.assigned_user_id = document.querySelector("#filter-assigned-user")?.value ?? "";
  state.filters.unassigned = Boolean(document.querySelector("#filter-unassigned")?.checked);
  if (state.filters.assigned_user_id) {
    state.filters.unassigned = false;
  }
  state.filters.has_email = Boolean(document.querySelector("#filter-has-email")?.checked);
  state.filters.has_phone = Boolean(document.querySelector("#filter-has-phone")?.checked);
  state.filters.has_address = Boolean(document.querySelector("#filter-has-address")?.checked);
  state.filters.has_website = Boolean(document.querySelector("#filter-has-website")?.checked);
  state.filters.due_callbacks = Boolean(document.querySelector("#filter-due-callbacks")?.checked);
  state.pagination.offset = 0;
  try {
    await loadRecords();
    render();
    setFlash("success", `Filtre uygulandı: ${state.pagination.total} kayıt.`);
  } catch (error) {
    setFlash("error", error.message);
  }
}

async function handleFocusAction(action) {
  if (action === "dashboard") {
    document.querySelector(".session-overview")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (action === "records") {
    document.querySelector(".records-table")?.closest("section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (action === "team") {
    openTeamModal();
    return;
  }
  if (action === "assign") {
    document.querySelector("#assign-form")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (action === "export") {
    await handleExport();
    return;
  }
  if (action === "completed") {
    state.filters.call_status = "COMPLETED";
    state.filters.due_callbacks = false;
    state.pagination.offset = 0;
    try {
      await loadRecords();
      render();
      setFlash("success", `Tamamlanan kayıt filtresi açıldı: ${state.pagination.total} kayıt.`);
    } catch (error) {
      setFlash("error", error.message);
    }
    return;
  }
  if (action === "operators") {
    await openOperatorControlModal();
    return;
  }
  if (action === "due") {
    state.filters.due_callbacks = true;
    state.filters.call_status = "CALLBACK";
    state.pagination.offset = 0;
    try {
      await loadRecords();
      render();
      setFlash("success", `Takip filtresi açıldı: ${state.pagination.total} kayıt.`);
    } catch (error) {
      setFlash("error", error.message);
    }
  }
}

async function resetFilters() {
  state.filters = { ...DEFAULT_FILTERS };
  state.pagination.offset = 0;
  try {
    await loadRecords();
    render();
    setFlash("success", "Filtre temizlendi.");
  } catch (error) {
    setFlash("error", error.message);
  }
}

function updateDraft(recordId, patch) {
  state.recordDrafts[recordId] = {
    ...(state.recordDrafts[recordId] || {}),
    ...patch,
  };
}

function updateContactPoolDraft(entryId, patch) {
  state.contactPoolDrafts[entryId] = {
    ...(state.contactPoolDrafts[entryId] || {}),
    ...patch,
  };
}

function bindEvents() {
  document.querySelector("#login-form")?.addEventListener("submit", handleLogin);
  document.querySelector("#logout-button")?.addEventListener("click", logout);
  document.querySelector("#manual-refresh-button")?.addEventListener("click", handleManualRefresh);
  document.querySelector("#user-form")?.addEventListener("submit", handleUserCreate);
  document.querySelector("#open-team-modal")?.addEventListener("click", openTeamModal);
  document.querySelector("#close-team-modal")?.addEventListener("click", closeTeamModal);
  document.querySelector("#open-lists-modal")?.addEventListener("click", openListsModal);
  document.querySelector("#close-lists-modal")?.addEventListener("click", closeListsModal);
  document.querySelector("#open-contact-pool-modal")?.addEventListener("click", openContactPoolModal);
  document.querySelector("#close-contact-pool-modal")?.addEventListener("click", closeContactPoolModal);
  document.querySelector("#open-operator-control-modal")?.addEventListener("click", openOperatorControlModal);
  document.querySelector("#close-operator-control-modal")?.addEventListener("click", closeOperatorControlModal);
  document.querySelector("#close-offer-notification-modal")?.addEventListener("click", closeOfferNotificationModal);
  document.querySelectorAll("[data-offer-notification-open]").forEach((node) => {
    node.addEventListener("click", () => openOfferNotification(node.getAttribute("data-offer-notification-open")));
  });
  document.querySelectorAll("[data-offer-notification-dismiss]").forEach((node) => {
    node.addEventListener("click", () => dismissOfferNotification(node.getAttribute("data-offer-notification-dismiss")));
  });
  document.querySelector("#toggle-upload-flyout")?.addEventListener("click", () => {
    state.sidebarPanel = state.sidebarPanel === "upload" ? "" : "upload";
    render();
  });
  document.querySelector("#close-sidebar-panel")?.addEventListener("click", () => {
    state.sidebarPanel = "";
    render();
  });
  document.querySelector("#team-modal-backdrop")?.addEventListener("click", (event) => {
    if (event.target.id === "team-modal-backdrop") {
      closeTeamModal();
    }
  });
  document.querySelector("#lists-modal-backdrop")?.addEventListener("click", (event) => {
    if (event.target.id === "lists-modal-backdrop") {
      closeListsModal();
    }
  });
  document.querySelector("#contact-pool-modal-backdrop")?.addEventListener("click", (event) => {
    if (event.target.id === "contact-pool-modal-backdrop") {
      closeContactPoolModal();
    }
  });
  document.querySelector("#operator-control-modal-backdrop")?.addEventListener("click", (event) => {
    if (event.target.id === "operator-control-modal-backdrop") {
      closeOperatorControlModal();
    }
  });
  document.querySelector("#offer-notification-backdrop")?.addEventListener("click", (event) => {
    if (event.target.id === "offer-notification-backdrop") {
      closeOfferNotificationModal();
    }
  });
  document.querySelector("#upload-form")?.addEventListener("submit", handleUpload);
  document.querySelector("#open-file-picker")?.addEventListener("click", () => {
    document.querySelector("#upload-file-input")?.click();
  });
  document.querySelector("#upload-file-input")?.addEventListener("change", (event) => {
    state.uploadFile = event.currentTarget.files?.[0] || null;
    render();
  });
  document.querySelector("#upload-form [name='list_name']")?.addEventListener("input", (event) => {
    state.uploadListName = event.currentTarget.value;
  });
  document.querySelector("#assign-form")?.addEventListener("submit", handleAssign);
  document.querySelector("#assign-form [name='mode']")?.addEventListener("change", (event) => {
    state.assignMode = event.currentTarget.value;
    render();
  });
  document.querySelectorAll("#assign-form [name='distribution_strategy']").forEach((node) => {
    node.addEventListener("change", (event) => {
      state.assignStrategy = event.currentTarget.value;
      render();
    });
  });
  document.querySelectorAll("[data-assign-user-enabled]").forEach((node) => {
    node.addEventListener("change", (event) => {
      const userId = event.currentTarget.getAttribute("data-assign-user-enabled");
      state.assignDrafts[userId] = {
        ...assignDraftFor(userId),
        enabled: Boolean(event.currentTarget.checked),
      };
      render();
    });
  });
  document.querySelectorAll("[data-assign-user-count]").forEach((node) => {
    node.addEventListener("input", (event) => {
      const userId = event.currentTarget.getAttribute("data-assign-user-count");
      const nextValue = String(event.currentTarget.value || "").replace(/[^\d]/g, "");
      event.currentTarget.value = nextValue;
      state.assignDrafts[userId] = {
        ...assignDraftFor(userId),
        count: nextValue,
      };
      syncAssignSummaryDisplay();
    });
  });
  document.querySelector("#toggle-list-button")?.addEventListener("click", handleToggleList);
  document.querySelector("#export-button")?.addEventListener("click", handleExport);
  document.querySelector("#filters-apply")?.addEventListener("click", applyFilters);
  document.querySelector("#filters-reset")?.addEventListener("click", resetFilters);
  document.querySelectorAll("[data-clear-record-filters]").forEach((node) => {
    node.addEventListener("click", resetFilters);
  });
  document.querySelectorAll("[data-focus-action]").forEach((node) => {
    node.addEventListener("click", async () => {
      await handleFocusAction(node.getAttribute("data-focus-action"));
    });
  });
  document.querySelector("#contact-pool-apply")?.addEventListener("click", applyContactPoolFilters);
  document.querySelector("#contact-pool-reset")?.addEventListener("click", resetContactPoolFilters);
  document.querySelector("#contact-pool-export")?.addEventListener("click", handleContactPoolExport);
  document.querySelector("#contact-pool-q")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyContactPoolFilters();
    }
  });
  document.querySelector("#contact-pool-reach")?.addEventListener("change", applyContactPoolFilters);
  document.querySelector("#contact-pool-result")?.addEventListener("change", applyContactPoolFilters);
  document.querySelector("#contact-pool-current-list")?.addEventListener("change", applyContactPoolFilters);
  document.querySelector("#contact-pool-active-only")?.addEventListener("change", applyContactPoolFilters);
  document.querySelector("#contact-pool-page-size")?.addEventListener("change", async (event) => {
    state.contactPoolPagination.limit = Number(event.currentTarget.value) || 25;
    state.contactPoolPagination.offset = 0;
    await loadContactPool();
    render();
  });
  document.querySelector("#filter-call-status")?.addEventListener("change", applyFilters);
  document.querySelector("#filter-result-status")?.addEventListener("change", applyFilters);
  document.querySelector("#filter-assigned-user")?.addEventListener("change", applyFilters);
  document.querySelector("#filter-unassigned")?.addEventListener("change", applyFilters);
  document.querySelector("#filter-has-email")?.addEventListener("change", applyFilters);
  document.querySelector("#filter-has-phone")?.addEventListener("change", applyFilters);
  document.querySelector("#filter-has-address")?.addEventListener("change", applyFilters);
  document.querySelector("#filter-has-website")?.addEventListener("change", applyFilters);
  document.querySelector("#filter-due-callbacks")?.addEventListener("change", applyFilters);
  document.querySelector("#filter-q")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyFilters();
    }
  });
  document.querySelector("#page-prev")?.addEventListener("click", async () => {
    state.pagination.offset = Math.max(0, state.pagination.offset - state.pagination.limit);
    await loadRecords();
    render();
  });
  document.querySelector("#page-next")?.addEventListener("click", async () => {
    if (currentPage() >= totalPages()) return;
    state.pagination.offset += state.pagination.limit;
    await loadRecords();
    render();
  });
  document.querySelector("#contact-pool-page-prev")?.addEventListener("click", async () => {
    state.contactPoolPagination.offset = Math.max(0, state.contactPoolPagination.offset - state.contactPoolPagination.limit);
    await loadContactPool();
    render();
  });
  document.querySelector("#contact-pool-page-next")?.addEventListener("click", async () => {
    if (contactPoolCurrentPage() >= contactPoolTotalPages()) return;
    state.contactPoolPagination.offset += state.contactPoolPagination.limit;
    await loadContactPool();
    render();
  });
  document.querySelector("#operator-detail-page-prev")?.addEventListener("click", async () => {
    state.operatorDetailPagination.offset = Math.max(0, state.operatorDetailPagination.offset - state.operatorDetailPagination.limit);
    await loadOperatorDetailRecords();
    render();
  });
  document.querySelector("#operator-detail-page-next")?.addEventListener("click", async () => {
    if (operatorDetailCurrentPage() >= operatorDetailTotalPages()) return;
    state.operatorDetailPagination.offset += state.operatorDetailPagination.limit;
    await loadOperatorDetailRecords();
    render();
  });

  document.querySelectorAll("[data-list-id]").forEach((node) => {
    node.addEventListener("click", async () => {
      state.selectedListId = node.getAttribute("data-list-id");
      if (node.hasAttribute("data-close-lists-modal")) {
        state.listsModalOpen = false;
      }
      state.pagination.offset = 0;
      await refreshOperationalData("list-switch");
      render();
    });
  });

  document.querySelectorAll("[data-list-toggle]").forEach((node) => {
    node.addEventListener("click", async () => {
      await handleToggleList(node.getAttribute("data-list-toggle"));
    });
  });

  document.querySelectorAll("[data-operator-detail]").forEach((node) => {
    node.addEventListener("click", async () => {
      await selectOperatorDetail(node.getAttribute("data-operator-detail"));
    });
  });

  document.querySelector("[data-operator-detail-clear]")?.addEventListener("click", async () => {
    await selectOperatorDetail("");
  });

  document.querySelectorAll("[data-operator-detail-filter]").forEach((node) => {
    node.addEventListener("click", async () => {
      await setOperatorDetailFilter(node.getAttribute("data-operator-detail-filter"));
    });
  });

  document.querySelectorAll("[data-save-record]").forEach((node) => {
    node.addEventListener("click", () => handleSaveRecord(node.getAttribute("data-save-record")));
  });

  document.querySelectorAll("[data-filter-operator]").forEach((node) => {
    node.addEventListener("click", async () => {
      state.filters.assigned_user_id = node.getAttribute("data-filter-operator") || "";
      state.filters.unassigned = false;
      if (node.closest("#operator-control-modal")) {
        state.operatorControlModalOpen = false;
      }
      state.pagination.offset = 0;
      await loadRecords();
      render();
      setFlash("success", "Operatör filtresi uygulandı.");
    });
  });

  document.querySelectorAll("[data-pool-save]").forEach((node) => {
    node.addEventListener("click", () => handleContactPoolSave(node.getAttribute("data-pool-save")));
  });

  document.querySelectorAll("[data-user-save]").forEach((node) => {
    node.addEventListener("click", () => handleUserUpdate(node.getAttribute("data-user-save")));
  });

  document.querySelectorAll("[data-user-delete]").forEach((node) => {
    node.addEventListener("click", () => handleUserDelete(node.getAttribute("data-user-delete")));
  });

  document.querySelectorAll("[data-record-assignee]").forEach((node) => {
    node.addEventListener("change", (event) => {
      updateDraft(event.currentTarget.getAttribute("data-record-assignee"), {
        assigned_user_id: event.currentTarget.value || null,
      });
    });
  });

  document.querySelectorAll("[data-record-call-status]").forEach((node) => {
    node.addEventListener("change", (event) => {
      updateDraft(event.currentTarget.getAttribute("data-record-call-status"), {
        call_status: event.currentTarget.value,
      });
    });
  });

  document.querySelectorAll("[data-record-result-status]").forEach((node) => {
    node.addEventListener("change", (event) => {
      updateDraft(event.currentTarget.getAttribute("data-record-result-status"), {
        result_status: event.currentTarget.value,
      });
    });
  });

  document.querySelectorAll("[data-record-note]").forEach((node) => {
    node.addEventListener("input", (event) => {
      updateDraft(event.currentTarget.getAttribute("data-record-note"), {
        note: event.currentTarget.value,
      });
    });
  });

  document.querySelectorAll("[data-record-callback]").forEach((node) => {
    node.addEventListener("input", (event) => {
      updateDraft(event.currentTarget.getAttribute("data-record-callback"), {
        callback_at: event.currentTarget.value,
      });
    });
  });

  document.querySelectorAll("[data-pool-reach]").forEach((node) => {
    node.addEventListener("change", (event) => {
      updateContactPoolDraft(event.currentTarget.getAttribute("data-pool-reach"), {
        reach_status: event.currentTarget.value,
      });
    });
  });

  document.querySelectorAll("[data-pool-active]").forEach((node) => {
    node.addEventListener("change", (event) => {
      updateContactPoolDraft(event.currentTarget.getAttribute("data-pool-active"), {
        is_active: Boolean(event.currentTarget.checked),
      });
    });
  });

  document.querySelectorAll("[data-pool-note]").forEach((node) => {
    node.addEventListener("input", (event) => {
      updateContactPoolDraft(event.currentTarget.getAttribute("data-pool-note"), {
        admin_note: event.currentTarget.value,
      });
    });
  });

  syncAssignSummaryDisplay();
}

render();
bindGlobalActivityListeners();
noteUserInteraction();
loadSession().then(render);

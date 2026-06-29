(function popup() {
  "use strict";

  const DEFAULT_CONFIG = {
    enabled: true,
    interval: 5,
    mixSources: ["likes", "bookmarks"],
    pageSize: 100,
    maxPages: 100
  };

  const STALE_SYNC_MS = 5 * 60 * 1000;

  const nodes = {
    status: document.getElementById("status"),
    syncProgress: document.getElementById("syncProgress"),
    lastSync: document.getElementById("lastSync"),
    totalCount: document.getElementById("totalCount"),
    likesCount: document.getElementById("likesCount"),
    bookmarksCount: document.getElementById("bookmarksCount"),
    enabled: document.getElementById("enabled"),
    interval: document.getElementById("interval"),
    mixLikes: document.getElementById("mixLikes"),
    mixBookmarks: document.getElementById("mixBookmarks"),
    maxPages: document.getElementById("maxPages"),
    syncBoth: document.getElementById("syncBoth"),
    syncLikes: document.getElementById("syncLikes"),
    syncBookmarks: document.getElementById("syncBookmarks"),
    stopSync: document.getElementById("stopSync"),
    clearArchive: document.getElementById("clearArchive")
  };

  function message(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        if (response && response.ok === false) {
          reject(new Error(response.error || "Request failed"));
          return;
        }
        resolve(response || {});
      });
    });
  }

  function storageGet(keys) {
    return chrome.storage.local.get(keys);
  }

  function storageSet(value) {
    return chrome.storage.local.set(value);
  }

  function formatCount(value) {
    return Intl.NumberFormat().format(Number(value) || 0);
  }

  function relativeTime(ms) {
    const diff = Date.now() - Number(ms || 0);
    if (!ms || diff < 60000) return "just now";
    const min = Math.floor(diff / 60000);
    if (min < 60) return min === 1 ? "1 minute ago" : `${min} minutes ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr === 1 ? "1 hour ago" : `${hr} hours ago`;
    const day = Math.floor(hr / 24);
    if (day < 30) return day === 1 ? "yesterday" : `${day} days ago`;
    const mo = Math.floor(day / 30);
    if (mo < 12) return mo === 1 ? "1 month ago" : `${mo} months ago`;
    const yr = Math.floor(day / 365);
    return yr === 1 ? "1 year ago" : `${yr} years ago`;
  }

  function normalizeSources(sources) {
    const selected = Array.from(new Set(Array.isArray(sources) ? sources : []))
      .filter((source) => source === "likes" || source === "bookmarks");
    return selected.length ? selected : DEFAULT_CONFIG.mixSources.slice();
  }

  function syncIsStale(status) {
    return Boolean(status && status.syncing && status.updatedAt && Date.now() - status.updatedAt > STALE_SYNC_MS);
  }

  function syncIsActive(status) {
    return Boolean(status && status.syncing && !syncIsStale(status));
  }

  function sourceLabel(source) {
    return source === "likes" ? "Likes" : "Bookmarks";
  }

  function progressPageText(progress) {
    const pages = Math.max(0, Number(progress && progress.pages) || 0);
    return pages ? ` at page ${pages}` : "";
  }

  function sourceProgressText(source, progress) {
    const sourceProgress = progress && progress[source];
    if (!sourceProgress) return `${sourceLabel(source)}: not synced`;

    const pageText = progressPageText(sourceProgress);
    if (sourceProgress.running) return `${sourceLabel(source)}: syncing${pageText}`;
    if (sourceProgress.lastError) return `${sourceLabel(source)}: paused after error${pageText}`;
    if (sourceProgress.done) return `${sourceLabel(source)}: complete${pageText}`;
    if (sourceProgress.cursor) return `${sourceLabel(source)}: paused${pageText}`;
    return `${sourceLabel(source)}: ready`;
  }

  function renderSyncProgress(progress) {
    nodes.syncProgress.textContent = ["likes", "bookmarks"]
      .map((source) => sourceProgressText(source, progress || {}))
      .join(" | ");
  }

  function renderStatus(status, counts) {
    const nextCounts = counts || (status && status.counts) || {};
    nodes.totalCount.textContent = formatCount(nextCounts.total);
    nodes.likesCount.textContent = formatCount(nextCounts.likes);
    nodes.bookmarksCount.textContent = formatCount(nextCounts.bookmarks);
    nodes.status.textContent = (status && (status.lastError || status.message)) || "Idle";
    if (nodes.lastSync) {
      nodes.lastSync.textContent = status && status.lastSyncAt ? `Last synced ${relativeTime(status.lastSyncAt)}` : "Not synced yet";
    }

    const syncing = syncIsActive(status);
    nodes.syncBoth.disabled = syncing;
    nodes.syncLikes.disabled = syncing;
    nodes.syncBookmarks.disabled = syncing;
    nodes.clearArchive.disabled = syncing;
    nodes.stopSync.hidden = !syncing;
    if (!syncing) nodes.stopSync.disabled = false;
  }

  async function render() {
    const stored = await storageGet(["xhConfig", "xhStatus", "xhSyncProgress"]);
    const config = { ...DEFAULT_CONFIG, ...(stored.xhConfig || {}) };
    const mixSources = normalizeSources(config.mixSources);
    nodes.enabled.checked = Boolean(config.enabled);
    nodes.interval.value = config.interval;
    nodes.mixLikes.checked = mixSources.includes("likes");
    nodes.mixBookmarks.checked = mixSources.includes("bookmarks");
    nodes.maxPages.value = config.maxPages;

    let status = stored.xhStatus;
    if (syncIsStale(status)) {
      status = await message({
        type: "SET_STATUS",
        patch: { syncing: false, message: "Previous sync stopped", lastError: "" }
      })
        .then((response) => response.status)
        .catch(() => ({ ...status, syncing: false, message: "Previous sync stopped", lastError: "" }));
    }

    const counts = await message({ type: "GET_COUNTS" }).then((response) => response.counts).catch(() => null);
    renderStatus(status, counts);
    renderSyncProgress(stored.xhSyncProgress || {});
  }

  async function saveConfig() {
    const mixSources = normalizeSources([
      nodes.mixLikes.checked ? "likes" : "",
      nodes.mixBookmarks.checked ? "bookmarks" : ""
    ]);
    nodes.mixLikes.checked = mixSources.includes("likes");
    nodes.mixBookmarks.checked = mixSources.includes("bookmarks");

    const config = {
      enabled: nodes.enabled.checked,
      interval: Math.max(2, Math.min(50, Number(nodes.interval.value) || DEFAULT_CONFIG.interval)),
      mixSources,
      pageSize: DEFAULT_CONFIG.pageSize,
      maxPages: Math.max(1, Math.min(1000, Number(nodes.maxPages.value) || DEFAULT_CONFIG.maxPages))
    };
    await storageSet({ xhConfig: config });
  }

  async function startSync(sources) {
    await saveConfig();
    nodes.status.textContent = `Starting ${sources.join(" + ")}`;
    nodes.syncBoth.disabled = true;
    nodes.syncLikes.disabled = true;
    nodes.syncBookmarks.disabled = true;
    nodes.stopSync.hidden = false;
    nodes.stopSync.disabled = false;

    await message({
      type: "START_SYNC",
      sources,
      pageSize: DEFAULT_CONFIG.pageSize,
      maxPages: Math.max(1, Math.min(1000, Number(nodes.maxPages.value) || DEFAULT_CONFIG.maxPages))
    });
  }

  async function stopSync() {
    nodes.status.textContent = "Stopping sync";
    nodes.stopSync.disabled = true;
    await message({ type: "STOP_SYNC" });
    nodes.stopSync.disabled = false;
    await render();
  }

  nodes.enabled.addEventListener("change", saveConfig);
  nodes.interval.addEventListener("change", saveConfig);
  nodes.mixLikes.addEventListener("change", saveConfig);
  nodes.mixBookmarks.addEventListener("change", saveConfig);
  nodes.maxPages.addEventListener("change", saveConfig);
  nodes.syncBoth.addEventListener("click", () => startSync(["likes", "bookmarks"]).catch((error) => {
    nodes.status.textContent = error.message;
    render();
  }));
  nodes.syncLikes.addEventListener("click", () => startSync(["likes"]).catch((error) => {
    nodes.status.textContent = error.message;
    render();
  }));
  nodes.syncBookmarks.addEventListener("click", () => startSync(["bookmarks"]).catch((error) => {
    nodes.status.textContent = error.message;
    render();
  }));
  nodes.stopSync.addEventListener("click", () => stopSync().catch((error) => {
    nodes.stopSync.disabled = false;
    nodes.status.textContent = error.message;
    render();
  }));
  nodes.clearArchive.addEventListener("click", async () => {
    if (!confirm("Clear the local X History Mixer archive?")) return;
    await message({ type: "CLEAR_ARCHIVE" });
    await render();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.xhStatus) renderStatus(changes.xhStatus.newValue);
    if (changes.xhSyncProgress) renderSyncProgress(changes.xhSyncProgress.newValue || {});
  });

  render().catch((error) => {
    nodes.status.textContent = error.message;
    renderSyncProgress({});
  });
})();

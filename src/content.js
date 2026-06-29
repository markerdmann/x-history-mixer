(function xHistoryContent() {
  "use strict";

  const TO_PAGE = "XHISTORY_CONTENT_TO_PAGE";
  const FROM_PAGE = "XHISTORY_PAGE_TO_CONTENT";

  const DEFAULT_CONFIG = {
    enabled: true,
    interval: 5,
    mixSources: ["likes", "bookmarks"],
    pageSize: 100,
    maxPages: 100
  };
  const RECONCILE_DELAY_MS = 500;
  const SCROLL_IDLE_MS = 350;
  // How long we keep re-pinning the feed after returning to Home before giving up.
  const SCROLL_RESTORE_MS = 6000;
  const ANCHOR_TRACK_INTERVAL_MS = 150;

  const state = {
    config: { ...DEFAULT_CONFIG },
    syncActive: false,
    cancelRequested: false,
    pageRequests: new Map(),
    archivePool: [],
    slotAssignments: new Map(),
    nativeOrdinals: new Map(),
    usedIds: new Set(),
    nextNativeOrdinal: 1,
    reconcileTimer: 0,
    ignoreMutationsUntil: 0,
    lastScrollAt: 0,
    programmaticScrollUntil: 0,
    locationHref: location.href,
    // Scroll restoration across in-app navigation (click a post, then go back).
    homeAnchor: null,
    savedHomeAnchor: null,
    lastAnchorTrackAt: 0,
    restore: null,
    restoreTimer: 0
  };

  function chromeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        if (response && response.ok === false) {
          reject(new Error(response.error || "Extension request failed"));
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

  async function setStatus(patch) {
    await chromeMessage({ type: "SET_STATUS", patch });
  }

  function postToPage(payload) {
    window.postMessage({ channel: TO_PAGE, ...payload }, location.origin);
  }

  function normalizeSources(sources) {
    const selected = Array.from(new Set(Array.isArray(sources) ? sources : []))
      .filter((source) => source === "likes" || source === "bookmarks");
    return selected.length ? selected : DEFAULT_CONFIG.mixSources.slice();
  }

  function selectedMixSources() {
    return normalizeSources(state.config.mixSources);
  }

  function syncStoppedError() {
    const error = new Error("Sync stopped");
    error.cancelled = true;
    return error;
  }

  function throwIfCancelRequested() {
    if (state.cancelRequested) throw syncStoppedError();
  }

  function scriptUrls(doc) {
    return Array.from((doc || document).scripts)
      .map((script) => script.src)
      .filter((src) => src && /responsive-web\/client-web/.test(src));
  }

  async function discoverFromScripts(source, urls) {
    const response = await chromeMessage({
      type: "DISCOVER_X_METADATA",
      source,
      scriptUrls: urls
    });
    return {
      operation: response.operation || null,
      bearer: response.bearer || ""
    };
  }

  async function bookmarkRouteScriptUrls() {
    const iframe = document.createElement("iframe");
    iframe.hidden = true;
    iframe.tabIndex = -1;
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = "position:absolute;width:1px;height:1px;left:-9999px;top:-9999px;border:0;opacity:0;";

    const loaded = new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("Bookmarks route did not load in time")), 25000);
      iframe.onload = () => {
        window.clearTimeout(timer);
        resolve();
      };
    });

    iframe.src = "/i/bookmarks";
    document.documentElement.appendChild(iframe);

    try {
      await loaded;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const doc = iframe.contentDocument;
        const urls = doc ? scriptUrls(doc) : [];
        if (urls.some((url) => /Bookmark/i.test(url))) return urls;
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      return iframe.contentDocument ? scriptUrls(iframe.contentDocument) : [];
    } finally {
      iframe.remove();
    }
  }

  async function discoverMetadata(source) {
    const topUrls = scriptUrls(document);
    let metadata = await discoverFromScripts(source, topUrls);
    if (metadata.operation && metadata.bearer) return metadata;

    if (source === "bookmarks" && !metadata.operation) {
      try {
        const bookmarkUrls = await bookmarkRouteScriptUrls();
        const fromBookmarkRoute = await discoverFromScripts(source, [...topUrls, ...bookmarkUrls]);
        metadata = {
          operation: fromBookmarkRoute.operation || metadata.operation,
          bearer: fromBookmarkRoute.bearer || metadata.bearer
        };
      } catch {
        // Hidden-route discovery is best effort; page bridge can still use fallback metadata.
      }
    }

    return metadata;
  }

  async function loadConfig() {
    const stored = (await storageGet("xhConfig")).xhConfig || {};
    state.config = { ...DEFAULT_CONFIG, ...stored };
  }

  async function saveConfig(patch) {
    state.config = { ...state.config, ...patch };
    await storageSet({ xhConfig: state.config });
    scheduleReconcile(true);
  }

  async function loadArchivePool(force) {
    if (!force && state.archivePool.length > 30) return;

    try {
      const response = await chromeMessage({ type: "GET_RANDOM_POSTS", limit: 240, sources: selectedMixSources() });
      state.archivePool = response.posts || [];
      if (state.usedIds.size > 1000) state.usedIds.clear();
    } catch {
      state.archivePool = [];
    }
  }

  function takeRandomPost() {
    if (!state.archivePool.length) return null;

    let guard = state.archivePool.length;
    while (guard > 0) {
      guard -= 1;
      const post = state.archivePool.pop();
      if (!post || state.usedIds.has(post.id)) continue;
      state.usedIds.add(post.id);
      return post;
    }

    state.usedIds.clear();
    return state.archivePool.pop() || null;
  }

  async function getSyncProgress() {
    return (await storageGet("xhSyncProgress")).xhSyncProgress || {};
  }

  async function updateSyncProgress(source, patch) {
    if (source !== "likes" && source !== "bookmarks") return {};

    const progress = await getSyncProgress();
    const next = {
      ...progress,
      [source]: {
        ...(progress[source] || {}),
        ...patch,
        updatedAt: Date.now()
      }
    };
    await storageSet({ xhSyncProgress: next });
    return next[source];
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric"
    });
  }

  function postSources(post) {
    return post.sources || [post.source].filter(Boolean);
  }

  function sourceLabel(post) {
    const sources = postSources(post);
    if (sources.includes("likes") && sources.includes("bookmarks")) return "From your likes & bookmarks";
    if (sources.includes("bookmarks")) return "From your bookmarks";
    return "From your likes";
  }

  const HEART_PATH =
    "M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91z";
  const BOOKMARK_PATH = "M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5z";

  function sourceIcon(post) {
    const isLike = postSources(post).includes("likes");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", `xh-context-icon ${isLike ? "xh-icon-like" : "xh-icon-bookmark"}`);

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", isLike ? HEART_PATH : BOOKMARK_PATH);
    svg.appendChild(path);
    return svg;
  }

  function relativeTime(value) {
    if (!value) return "";
    const then = new Date(value).getTime();
    if (Number.isNaN(then)) return "";

    const diffMs = Date.now() - then;
    if (diffMs < 0) return "";

    const day = Math.floor(diffMs / 86400000);
    const year = Math.floor(day / 365);
    const month = Math.floor(day / 30);
    if (year >= 1) return year === 1 ? "1 year ago" : `${year} years ago`;
    if (month >= 1) return month === 1 ? "1 month ago" : `${month} months ago`;
    if (day >= 1) return day === 1 ? "yesterday" : `${day} days ago`;

    const hour = Math.floor(diffMs / 3600000);
    if (hour >= 1) return hour === 1 ? "1 hour ago" : `${hour} hours ago`;
    const min = Math.floor(diffMs / 60000);
    if (min >= 1) return min === 1 ? "1 minute ago" : `${min} minutes ago`;
    return "just now";
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  // Posts come from X's API, but some fields (e.g. expanded media urls) originate
  // from the post author, so never let anything but http(s) reach an href.
  function safeHttpUrl(value) {
    if (!value) return "";
    try {
      const url = new URL(value, location.origin);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
    } catch {
      return "";
    }
  }

  function verifiedBadge() {
    const badge = document.createElement("span");
    badge.className = "xh-verified";
    badge.setAttribute("aria-label", "Verified");

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M22.25 12l-2.36 2.69.33 3.56-3.49.79-1.83 3.08L12 20.66l-2.9 1.46-1.83-3.08-3.49-.79.33-3.56L1.75 12l2.36-2.69-.33-3.56 3.49-.79L9.1 1.88 12 3.34l2.9-1.46 1.83 3.08 3.49.79-.33 3.56L22.25 12zM10.7 15.3l5.35-5.36-1.41-1.41-3.94 3.94-1.64-1.64-1.41 1.41 3.05 3.06z"
    );
    svg.appendChild(path);
    badge.appendChild(svg);

    return badge;
  }

  function appendVerified(parent, isVerified) {
    if (isVerified) parent.appendChild(verifiedBadge());
  }

  function renderMedia(post) {
    const media = (post.media || []).filter((item) => item && item.previewUrl).slice(0, 4);
    if (!media.length) return null;

    const grid = element("div", `xh-media xh-media-${media.length}`);
    for (const item of media) {
      const link = element("a", "xh-media-item");
      link.href = safeHttpUrl(item.url) || safeHttpUrl(item.previewUrl) || "#";
      link.target = "_blank";
      link.rel = "noreferrer noopener";

      const img = document.createElement("img");
      img.src = item.previewUrl;
      img.alt = "";
      img.loading = "lazy";
      link.appendChild(img);

      if (item.type === "video" || item.type === "animated_gif") {
        link.appendChild(element("span", "xh-media-pill", item.type === "video" ? "Video" : "GIF"));
      }

      grid.appendChild(link);
    }

    return grid;
  }

  function renderCard(post) {
    const card = element("div", "xh-history-card");
    card.dataset.xhPostId = post.id;
    card.setAttribute("role", "article");

    const source = element("div", "xh-context");
    source.appendChild(sourceIcon(post));
    source.appendChild(element("span", "xh-context-label", sourceLabel(post)));
    const when = relativeTime(post.createdAt);
    if (when) source.appendChild(element("span", "xh-context-time", when));
    card.appendChild(source);

    const header = element("div", "xh-card-header");

    if (post.authorAvatarUrl) {
      const avatar = document.createElement("img");
      avatar.className = "xh-avatar";
      avatar.src = post.authorAvatarUrl;
      avatar.alt = "";
      avatar.loading = "lazy";
      header.appendChild(avatar);
    } else {
      header.appendChild(element("div", "xh-avatar xh-avatar-empty"));
    }

    const identity = element("div", "xh-identity");
    const authorLine = element("div", "xh-author-line");
    authorLine.appendChild(
      element("span", "xh-author", post.authorName || (post.authorHandle ? `@${post.authorHandle}` : "Original post"))
    );
    appendVerified(authorLine, post.isVerified);
    authorLine.appendChild(
      element(
        "span",
        "xh-meta",
        [post.authorHandle && post.authorName ? `@${post.authorHandle}` : "", formatDate(post.createdAt)]
          .filter(Boolean)
          .join(" / ")
      )
    );
    identity.appendChild(authorLine);
    header.appendChild(identity);
    card.appendChild(header);

    if (post.text) {
      card.appendChild(element("div", "xh-text", post.text));
    }

    const media = renderMedia(post);
    if (media) card.appendChild(media);

    if (post.quoted && post.quoted.text) {
      const quote = element("div", "xh-quote");
      const quoteHeader = element("div", "xh-quote-header");
      if (post.quoted.authorAvatarUrl) {
        const quoteAvatar = document.createElement("img");
        quoteAvatar.className = "xh-quote-avatar";
        quoteAvatar.src = post.quoted.authorAvatarUrl;
        quoteAvatar.alt = "";
        quoteAvatar.loading = "lazy";
        quoteHeader.appendChild(quoteAvatar);
      }

      const quoteIdentity = element("div", "xh-quote-identity");
      const quoteAuthorLine = element("div", "xh-quote-author-line");
      quoteAuthorLine.appendChild(
        element(
          "span",
          "xh-quote-author",
          post.quoted.authorName || (post.quoted.authorHandle ? `@${post.quoted.authorHandle}` : post.quoted.author || "Quoted post")
        )
      );
      appendVerified(quoteAuthorLine, post.quoted.isVerified);
      quoteAuthorLine.appendChild(
        element(
          "span",
          "xh-quote-meta",
          [post.quoted.authorHandle && post.quoted.authorName ? `@${post.quoted.authorHandle}` : "", formatDate(post.quoted.createdAt)]
            .filter(Boolean)
            .join(" / ")
        )
      );
      quoteIdentity.appendChild(quoteAuthorLine);
      quoteHeader.appendChild(quoteIdentity);
      quote.appendChild(quoteHeader);
      quote.appendChild(element("div", "xh-quote-text", post.quoted.text));
      card.appendChild(quote);
    }

    const footer = element("div", "xh-card-footer");
    const link = element("a", "xh-open-link", "Open original");
    link.href = safeHttpUrl(post.url) || `https://x.com/i/status/${encodeURIComponent(post.id)}`;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    footer.appendChild(link);
    card.appendChild(footer);

    return card;
  }

  function isHomeTimeline() {
    return /^\/home\/?$/.test(location.pathname);
  }

  function isHomeHref(href) {
    try {
      return /^\/home\/?$/.test(new URL(href, location.origin).pathname);
    } catch {
      return false;
    }
  }

  function isNativeTweetArticle(article) {
    if (!article || article.closest(".xh-history-card")) return false;
    if (article.dataset.xhIgnore === "true") return false;
    return Boolean(article.querySelector('a[href*="/status/"], a[href*="/statuses/"]'));
  }

  function tweetIdForArticle(article) {
    const link = article && article.querySelector('a[href*="/status/"], a[href*="/statuses/"]');
    const href = link && link.getAttribute("href");
    if (!href) return "";

    const match = href.match(/\/status(?:es)?\/(\d+)/);
    return match ? match[1] : "";
  }

  function ordinalForTweet(tweetId) {
    if (!tweetId) return 0;
    if (!state.nativeOrdinals.has(tweetId)) {
      state.nativeOrdinals.set(tweetId, state.nextNativeOrdinal);
      state.nextNativeOrdinal += 1;
    }
    return state.nativeOrdinals.get(tweetId);
  }

  function nativeArticles() {
    const main = document.querySelector("main");
    if (!main) return [];
    return Array.from(main.querySelectorAll('article[data-testid="tweet"], article')).filter(isNativeTweetArticle);
  }

  function captureScrollAnchor(articles) {
    if (window.scrollY <= 0) return null;

    const anchorY = Math.min(160, Math.max(40, window.innerHeight * 0.25));
    let fallback = null;

    for (const article of articles) {
      const rect = article.getBoundingClientRect();
      if (rect.bottom <= 0) continue;
      if (!fallback && rect.top >= 0) fallback = article;
      if (rect.top <= anchorY && rect.bottom >= anchorY) {
        return { node: article, top: rect.top };
      }
    }

    return fallback ? { node: fallback, top: fallback.getBoundingClientRect().top } : null;
  }

  function restoreScrollAnchor(anchor) {
    if (!anchor || !anchor.node || !anchor.node.isConnected) return;

    const nextTop = anchor.node.getBoundingClientRect().top;
    const delta = nextTop - anchor.top;
    if (Math.abs(delta) >= 1) {
      state.programmaticScrollUntil = Date.now() + 120;
      window.scrollBy(0, delta);
    }
  }

  // The native tweet currently nearest the top of the viewport, keyed by its id
  // so we can find the same post again after the timeline re-renders.
  function captureTweetAnchor() {
    const anchor = captureScrollAnchor(nativeArticles());
    if (!anchor || !anchor.node) return null;
    const tweetId = tweetIdForArticle(anchor.node);
    return tweetId ? { tweetId, top: anchor.top } : null;
  }

  function articleForTweetId(tweetId) {
    if (!tweetId) return null;
    for (const article of nativeArticles()) {
      if (tweetIdForArticle(article) === tweetId) return article;
    }
    return null;
  }

  function trackHomeAnchor() {
    const now = Date.now();
    if (now - state.lastAnchorTrackAt < ANCHOR_TRACK_INTERVAL_MS) return;
    state.lastAnchorTrackAt = now;
    if (!isHomeTimeline()) return;
    const anchor = captureTweetAnchor();
    if (anchor) state.homeAnchor = anchor;
  }

  // X saves/restores window.scrollY on back-navigation, but it has no idea our
  // injected cards add height, so it lands too far down the feed. We override it
  // by re-pinning the post the user was actually reading until the feed settles.
  function beginScrollRestore(anchor) {
    if (!anchor || !anchor.tweetId) return;
    state.restore = {
      tweetId: anchor.tweetId,
      top: anchor.top,
      deadline: Date.now() + SCROLL_RESTORE_MS,
      settled: 0
    };
    tickScrollRestore();
  }

  function cancelScrollRestore() {
    state.restore = null;
    if (state.restoreTimer) {
      window.clearTimeout(state.restoreTimer);
      state.restoreTimer = 0;
    }
  }

  function tickScrollRestore() {
    if (state.restoreTimer) {
      window.clearTimeout(state.restoreTimer);
      state.restoreTimer = 0;
    }

    const restore = state.restore;
    if (!restore) return;
    if (!isHomeTimeline() || Date.now() > restore.deadline) {
      state.restore = null;
      return;
    }

    const article = articleForTweetId(restore.tweetId);
    if (article) {
      const delta = article.getBoundingClientRect().top - restore.top;
      if (Math.abs(delta) >= 1) {
        state.programmaticScrollUntil = Date.now() + 200;
        window.scrollBy(0, delta);
        restore.settled = 0;
      } else if ((restore.settled += 1) >= 4) {
        state.restore = null;
        return;
      }
    }

    state.restoreTimer = window.setTimeout(tickScrollRestore, 64);
  }

  function scrollIdleDelay() {
    if (!state.lastScrollAt) return 0;
    const elapsed = Date.now() - state.lastScrollAt;
    return elapsed < SCROLL_IDLE_MS ? SCROLL_IDLE_MS - elapsed : 0;
  }

  function resetTimelineSession() {
    state.nativeOrdinals.clear();
    state.slotAssignments.clear();
    state.nextNativeOrdinal = 1;
  }

  function suppressOwnMutations() {
    state.ignoreMutationsUntil = Date.now() + 400;
  }

  function removeCards(predicate) {
    document.querySelectorAll(".xh-history-card").forEach((node) => {
      if (!predicate || predicate(node)) node.remove();
    });
  }

  async function assignedPostForSlot(slotKey) {
    if (state.slotAssignments.has(slotKey)) return state.slotAssignments.get(slotKey);

    await loadArchivePool(false);
    let post = takeRandomPost();
    if (!post) {
      await loadArchivePool(true);
      post = takeRandomPost();
    }

    if (!post) return null;
    state.slotAssignments.set(slotKey, post);
    return post;
  }

  async function reconcileTimeline() {
    state.reconcileTimer = 0;

    const idleDelay = scrollIdleDelay();
    if (idleDelay > 0) {
      state.reconcileTimer = window.setTimeout(reconcileTimeline, idleDelay + 50);
      return;
    }

    if (!isHomeTimeline()) return;

    if (!state.config.enabled) {
      const scrollAnchor = captureScrollAnchor(nativeArticles());
      suppressOwnMutations();
      removeCards();
      restoreScrollAnchor(scrollAnchor);
      return;
    }

    const interval = Math.max(2, Math.min(50, Number(state.config.interval) || DEFAULT_CONFIG.interval));
    const articles = nativeArticles();
    if (!articles.length) return;

    const targets = new Map();
    for (const article of articles) {
      const tweetId = tweetIdForArticle(article);
      if (!tweetId) continue;

      const ordinal = ordinalForTweet(tweetId);
      if (ordinal > 0 && ordinal % interval === 0) {
        targets.set(`after:${tweetId}`, article);
      }
    }

    const existingCards = new Map();
    const cardsToRemove = [];
    document.querySelectorAll(".xh-history-card").forEach((card) => {
      const slotKey = card.dataset.xhSlotKey || "";
      if (!slotKey || !targets.has(slotKey) || existingCards.has(slotKey)) {
        cardsToRemove.push(card);
        return;
      }
      existingCards.set(slotKey, card);
    });

    const placements = [];
    for (const [slotKey, anchor] of targets) {
      if (!anchor || !anchor.parentNode) continue;

      const existing = existingCards.get(slotKey);
      if (existing && existing.previousElementSibling === anchor) continue;

      const post = await assignedPostForSlot(slotKey);
      if (!post) {
        if (existing) cardsToRemove.push(existing);
        continue;
      }

      placements.push({ anchor, existing, post, slotKey });
    }

    if (cardsToRemove.length || placements.length) {
      // While a post-navigation restore is in flight, that controller owns the
      // scroll position; otherwise keep the viewport pinned to its top post.
      const restoring = Boolean(state.restore);
      const scrollAnchor = restoring ? null : captureScrollAnchor(nativeArticles());
      suppressOwnMutations();
      for (const card of cardsToRemove) card.remove();

      for (const placement of placements) {
        if (!placement.anchor || !placement.anchor.parentNode) continue;
        if (placement.existing) placement.existing.remove();

        const card = renderCard(placement.post);
        card.dataset.xhSlotKey = placement.slotKey;
        placement.anchor.insertAdjacentElement("afterend", card);
      }

      if (restoring) {
        tickScrollRestore();
      } else {
        restoreScrollAnchor(scrollAnchor);
        state.homeAnchor = captureTweetAnchor() || state.homeAnchor;
      }
    }

    if (state.archivePool.length < 20 && targets.size > existingCards.size) {
      loadArchivePool(true).catch(() => {});
    }
  }

  function scheduleReconcile(force) {
    if (force !== true && Date.now() < state.ignoreMutationsUntil) return;
    if (state.reconcileTimer) return;
    state.reconcileTimer = window.setTimeout(reconcileTimeline, Math.max(RECONCILE_DELAY_MS, scrollIdleDelay()));
  }

  async function storePagePosts(payload) {
    const response = await chromeMessage({
      type: "STORE_POSTS",
      source: payload.source,
      posts: payload.posts || []
    });
    await updateSyncProgress(payload.source, {
      cursor: payload.cursor || "",
      done: false,
      lastError: "",
      pages: Math.max(0, Number(payload.page) || 0),
      reason: "running",
      running: true
    });

    await setStatus({
      syncing: true,
      message: `${payload.source}: page ${payload.page}, archived ${response.counts.total} posts`,
      counts: response.counts,
      lastError: ""
    });

    state.archivePool = [];
    scheduleReconcile(true);
    return response;
  }

  async function finishSyncProgress(payload) {
    const hasCursor = Boolean(payload.cursor);
    const done = !hasCursor || payload.reason !== "max-pages";
    await updateSyncProgress(payload.source, {
      cursor: hasCursor ? payload.cursor : "",
      done,
      lastError: "",
      pages: Math.max(0, Number(payload.pages) || 0),
      reason: payload.reason || (done ? "end" : "paused"),
      running: false
    });
  }

  function handlePageMessage(event) {
    if (event.source !== window) return;
    if (event.origin !== location.origin) return;
    const data = event.data || {};
    if (data.channel !== FROM_PAGE) return;

    const request = state.pageRequests.get(data.requestId);
    if (!request) return;

    if (data.type === "sync-page") {
      const write = storePagePosts(data).catch((error) => {
        request.reject(error);
      });
      request.pendingWrites.push(write);
      return;
    }

    if (data.type === "sync-status") {
      setStatus({
        syncing: true,
        message: data.message || `${data.source}: syncing`,
        lastError: ""
      }).catch(() => {});
      return;
    }

    if (data.type === "sync-complete") {
      Promise.allSettled(request.pendingWrites).then(() => finishSyncProgress(data)).then(() => {
        state.pageRequests.delete(data.requestId);
        request.resolve(data);
      });
      return;
    }

    if (data.type === "sync-error") {
      state.pageRequests.delete(data.requestId);
      request.reject(new Error(data.message || "Sync failed"));
    }
  }

  function runPageSync(source, options) {
    const requestId =
      globalThis.crypto && globalThis.crypto.randomUUID
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const promise = new Promise((resolve, reject) => {
      state.pageRequests.set(requestId, {
        resolve,
        reject,
        pendingWrites: []
      });
    });

    postToPage({
      type: "sync-source",
      requestId,
      source,
      options
    });

    return promise;
  }

  async function stopSync() {
    state.syncActive = false;
    state.cancelRequested = true;

    for (const [requestId, request] of state.pageRequests) {
      request.reject(syncStoppedError());
      postToPage({ type: "cancel-sync", requestId });
    }
    state.pageRequests.clear();

    await setStatus({ syncing: false, message: "Sync stopped", lastError: "" });
  }

  async function startSync(message) {
    if (state.syncActive) {
      throw new Error("A sync is already running.");
    }

    state.syncActive = true;
    state.cancelRequested = false;
    const sources = (message.sources || []).filter((source) => source === "likes" || source === "bookmarks");
    if (!sources.length) {
      state.syncActive = false;
      throw new Error("Choose likes, bookmarks, or both.");
    }

    const options = {
      pageSize: Number(message.pageSize || state.config.pageSize || DEFAULT_CONFIG.pageSize),
      maxPages: Number(message.maxPages || state.config.maxPages || DEFAULT_CONFIG.maxPages)
    };

    await setStatus({
      syncing: true,
      message: `Starting ${sources.join(" + ")} sync`,
      lastError: ""
    });

    let currentSource = "";
    try {
      const progress = await getSyncProgress();
      const results = [];
      for (const source of sources) {
        currentSource = source;
        throwIfCancelRequested();
        const sourceProgress = progress[source] || {};
        const shouldResume = Boolean(sourceProgress.cursor && !sourceProgress.done);
        const pageOffset = shouldResume ? Math.max(0, Number(sourceProgress.pages) || 0) : 0;

        await setStatus({
          syncing: true,
          message: shouldResume ? `${source}: resuming from page ${pageOffset + 1}` : `${source}: finding archive`
        });
        await updateSyncProgress(source, {
          cursor: shouldResume ? sourceProgress.cursor : "",
          done: false,
          lastError: "",
          pages: pageOffset,
          reason: "running",
          running: true
        });
        const metadata = await discoverMetadata(source).catch(() => ({ operation: null, bearer: "" }));
        throwIfCancelRequested();
        const result = await runPageSync(source, {
          ...options,
          ...metadata,
          cursor: shouldResume ? sourceProgress.cursor : "",
          pageOffset
        });
        results.push(result);
      }

      const countsResponse = await chromeMessage({ type: "GET_COUNTS" });
      const paused = results.find((result) => result && result.reason === "max-pages");
      await setStatus({
        syncing: false,
        message: paused ? `${paused.source}: paused at page ${paused.pages}; sync again to resume` : "Sync complete",
        lastSyncAt: Date.now(),
        counts: countsResponse.counts,
        lastError: ""
      });
      await loadArchivePool(true);
      scheduleReconcile(true);
    } catch (error) {
      const messageText = error && error.message ? error.message : String(error);
      if (error && error.cancelled) {
        if (currentSource) await updateSyncProgress(currentSource, { lastError: "", running: false });
        await setStatus({ syncing: false, message: "Sync stopped", lastError: "" });
      } else {
        if (currentSource) await updateSyncProgress(currentSource, { lastError: messageText, running: false });
        await setStatus({ syncing: false, message: messageText, lastError: messageText });
      }
      throw error;
    } finally {
      state.syncActive = false;
      state.cancelRequested = false;
    }
  }

  function setupTimelineObserver() {
    const attach = () => {
      if (!document.body) {
        window.setTimeout(attach, 100);
        return;
      }

      const observer = new MutationObserver(scheduleReconcile);
      observer.observe(document.body, { childList: true, subtree: true });
      scheduleReconcile(true);
    };

    attach();

    window.addEventListener(
      "scroll",
      () => {
        if (Date.now() < state.programmaticScrollUntil) return;
        state.lastScrollAt = Date.now();
        // A genuine scroll means the user has taken over; stop fighting them.
        if (state.restore) cancelScrollRestore();
        trackHomeAnchor();
      },
      { passive: true }
    );

    // popstate fires the instant the back/forward button lands us back on Home,
    // letting us start restoring before X scrolls the feed away.
    window.addEventListener("popstate", () => window.setTimeout(handleLocationChange, 0));
    window.setInterval(handleLocationChange, 200);
  }

  function handleLocationChange() {
    const href = location.href;
    if (state.locationHref === href) return;

    const wasHome = isHomeHref(state.locationHref);
    state.locationHref = href;
    const nowHome = isHomeTimeline();

    if (wasHome && !nowHome) {
      // Leaving Home (e.g. opening a post): remember where we were reading.
      state.savedHomeAnchor = state.homeAnchor;
      cancelScrollRestore();
    } else if (!wasHome && nowHome) {
      // Returning to Home: reset slot bookkeeping and restore the read position.
      if (!document.querySelector(".xh-history-card")) resetTimelineSession();
      if (state.savedHomeAnchor) beginScrollRestore(state.savedHomeAnchor);
      state.savedHomeAnchor = null;
    }

    scheduleReconcile(true);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (!message) return { ok: false, error: "Unknown message" };
      if (message.type === "START_SYNC") {
        startSync(message).catch(() => {});
        return { ok: true, started: true };
      }
      if (message.type === "STOP_SYNC") {
        await stopSync();
        return { ok: true, stopped: true };
      }
      return { ok: false, error: "Unknown message" };
    })()
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.xhConfig) return;
    state.config = { ...DEFAULT_CONFIG, ...(changes.xhConfig.newValue || {}) };
    state.archivePool = [];
    state.usedIds.clear();
    resetTimelineSession();
    scheduleReconcile(true);
  });

  window.addEventListener("message", handlePageMessage);

  loadConfig()
    .then(() => loadArchivePool(true))
    .then(setupTimelineObserver)
    .catch(() => setupTimelineObserver());

  window.XHistoryMixer = {
    saveConfig,
    scheduleReconcile
  };
})();

(function attachXHistoryDb(global) {
  "use strict";

  const DB_NAME = "x-history-mixer";
  const DB_VERSION = 1;
  const POST_STORE = "posts";

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
      tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
    });
  }

  let dbPromise;

  function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(POST_STORE)) {
          const store = db.createObjectStore(POST_STORE, { keyPath: "id" });
          store.createIndex("sources", "sources", { multiEntry: true });
          store.createIndex("createdAtMs", "createdAtMs", { unique: false });
          store.createIndex("updatedAt", "updatedAt", { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Unable to open archive database"));
    });

    return dbPromise;
  }

  function cleanPost(post, source, now) {
    const sources = Array.from(new Set([...(post.sources || []), source].filter(Boolean)));
    return {
      id: String(post.id || ""),
      source,
      sources,
      authorName: post.authorName || "",
      authorHandle: post.authorHandle || "",
      authorAvatarUrl: post.authorAvatarUrl || "",
      isVerified: Boolean(post.isVerified),
      text: post.text || "",
      createdAt: post.createdAt || "",
      createdAtMs: Number(post.createdAtMs || 0),
      url: post.url || "",
      media: Array.isArray(post.media) ? post.media.slice(0, 4) : [],
      quoted: post.quoted || null,
      archivedAt: post.archivedAt || now,
      updatedAt: now
    };
  }

  function betterUrl(incomingUrl, existingUrl) {
    if (!incomingUrl) return existingUrl || "";
    if (existingUrl && incomingUrl.includes("/i/status/") && !existingUrl.includes("/i/status/")) {
      return existingUrl;
    }
    return incomingUrl;
  }

  async function upsertPosts(posts, source) {
    const usablePosts = (posts || []).filter((post) => post && post.id);
    if (!usablePosts.length) return { received: 0, changed: 0 };

    const db = await openDb();
    const tx = db.transaction(POST_STORE, "readwrite");
    const store = tx.objectStore(POST_STORE);
    const done = transactionDone(tx);
    const now = Date.now();
    let changed = 0;

    const writes = usablePosts.map((post) => new Promise((resolve, reject) => {
      const incoming = cleanPost(post, source, now);
      const request = store.get(incoming.id);

      request.onsuccess = () => {
        const existing = request.result;
        const merged = existing
          ? {
              ...existing,
              ...incoming,
              authorName: incoming.authorName || existing.authorName || "",
              authorHandle: incoming.authorHandle || existing.authorHandle || "",
              authorAvatarUrl: incoming.authorAvatarUrl || existing.authorAvatarUrl || "",
              isVerified: incoming.isVerified || existing.isVerified || false,
              text: incoming.text || existing.text || "",
              createdAt: incoming.createdAt || existing.createdAt || "",
              createdAtMs: incoming.createdAtMs || existing.createdAtMs || 0,
              url: betterUrl(incoming.url, existing.url),
              media: incoming.media && incoming.media.length ? incoming.media : existing.media || [],
              quoted: incoming.quoted || existing.quoted || null,
              sources: Array.from(new Set([...(existing.sources || []), ...incoming.sources])),
              archivedAt: existing.archivedAt || incoming.archivedAt,
              updatedAt: now
            }
          : incoming;

        store.put(merged);
        changed += 1;
        resolve();
      };

      request.onerror = () => reject(request.error || new Error("Unable to read archived post"));
    }));

    await Promise.all(writes);
    await done;
    return { received: usablePosts.length, changed };
  }

  async function getAllPosts() {
    const db = await openDb();
    const tx = db.transaction(POST_STORE, "readonly");
    const store = tx.objectStore(POST_STORE);
    const done = transactionDone(tx);
    const posts = await requestToPromise(store.getAll());
    await done;
    return posts || [];
  }

  function shuffle(items) {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function normalizeSources(sources) {
    const selected = Array.from(new Set(Array.isArray(sources) ? sources : []))
      .filter((source) => source === "likes" || source === "bookmarks");
    return selected.length ? selected : ["likes", "bookmarks"];
  }

  function hasSelectedSource(post, selectedSources) {
    const sources = post.sources && post.sources.length ? post.sources : [post.source].filter(Boolean);
    return sources.some((source) => selectedSources.includes(source));
  }

  async function getRandomPosts(limit, sources) {
    const posts = await getAllPosts();
    const selectedSources = normalizeSources(sources);
    return shuffle(posts)
      .filter((post) => post && post.id && hasSelectedSource(post, selectedSources) && (post.text || (post.media && post.media.length)))
      .slice(0, Math.max(0, Number(limit) || 0));
  }

  async function getCounts() {
    const posts = await getAllPosts();
    const counts = { total: posts.length, likes: 0, bookmarks: 0 };

    for (const post of posts) {
      const sources = post.sources || [];
      if (sources.includes("likes")) counts.likes += 1;
      if (sources.includes("bookmarks")) counts.bookmarks += 1;
    }

    return counts;
  }

  async function clearArchive() {
    const db = await openDb();
    const tx = db.transaction(POST_STORE, "readwrite");
    const done = transactionDone(tx);
    tx.objectStore(POST_STORE).clear();
    await done;
    return { ok: true };
  }

  global.XHistoryDB = {
    clearArchive,
    getCounts,
    getRandomPosts,
    upsertPosts
  };
})(globalThis);

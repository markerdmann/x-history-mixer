(function xHistoryPageBridge() {
  "use strict";

  if (window.__xHistoryBridgeInstalled) return;
  window.__xHistoryBridgeInstalled = true;

  const TO_PAGE = "XHISTORY_CONTENT_TO_PAGE";
  const FROM_PAGE = "XHISTORY_PAGE_TO_CONTENT";
  const OPERATION_NAMES = {
    bookmarks: "Bookmarks",
    likes: "Likes"
  };

  const BOOKMARKS_FALLBACK_FEATURE_SWITCHES = [
    "rweb_video_screen_enabled",
    "rweb_cashtags_enabled",
    "profile_label_improvements_pcf_label_in_post_enabled",
    "responsive_web_profile_redirect_enabled",
    "rweb_tipjar_consumption_enabled",
    "verified_phone_label_enabled",
    "creator_subscriptions_tweet_preview_api_enabled",
    "responsive_web_graphql_timeline_navigation_enabled",
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled",
    "premium_content_api_read_enabled",
    "communities_web_enable_tweet_community_results_fetch",
    "c9s_tweet_anatomy_moderator_badge_enabled",
    "responsive_web_grok_analyze_button_fetch_trends_enabled",
    "responsive_web_grok_analyze_post_followups_enabled",
    "rweb_cashtags_composer_attachment_enabled",
    "responsive_web_jetfuel_frame",
    "responsive_web_grok_share_attachment_enabled",
    "responsive_web_grok_annotations_enabled",
    "articles_preview_enabled",
    "responsive_web_edit_tweet_api_enabled",
    "rweb_conversational_replies_downvote_enabled",
    "graphql_is_translatable_rweb_tweet_is_translatable_enabled",
    "view_counts_everywhere_api_enabled",
    "longform_notetweets_consumption_enabled",
    "responsive_web_twitter_article_tweet_consumption_enabled",
    "content_disclosure_indicator_enabled",
    "content_disclosure_ai_generated_indicator_enabled",
    "responsive_web_grok_show_grok_translated_post",
    "responsive_web_grok_analysis_button_from_backend",
    "post_ctas_fetch_enabled",
    "freedom_of_speech_not_reach_fetch_enabled",
    "standardized_nudges_misinfo",
    "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled",
    "longform_notetweets_rich_text_read_enabled",
    "longform_notetweets_inline_media_enabled",
    "responsive_web_grok_image_annotation_enabled",
    "responsive_web_grok_imagine_annotation_enabled",
    "responsive_web_grok_community_note_auto_translation_is_enabled",
    "responsive_web_enhance_cards_enabled"
  ];

  const operationCache = new Map();
  const cancelledRequests = new Set();
  let bearerTokenPromise;

  function emit(type, payload) {
    window.postMessage({ channel: FROM_PAGE, type, ...payload }, location.origin);
  }

  function throwIfCancelled(requestId) {
    if (!cancelledRequests.has(requestId)) return;
    cancelledRequests.delete(requestId);
    throw new Error("Sync stopped");
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function isRetriableError(error) {
    const message = error && error.message ? error.message : String(error || "");
    return /X API returned (429|5\d\d)|Failed to fetch|NetworkError|Load failed/i.test(message);
  }

  function parseQuotedArray(text) {
    return Array.from((text || "").matchAll(/"([^"]+)"/g)).map((match) => match[1]);
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function parseOperation(text, operationName) {
    const escaped = escapeRegExp(operationName);
    const regex = new RegExp(
      `queryId:"([^"]+)",operationName:"${escaped}",operationType:"query",metadata:\\{featureSwitches:\\[([^\\]]*)\\],fieldToggles:\\[([^\\]]*)\\]\\}`,
      "g"
    );

    const match = regex.exec(text);
    if (!match) return null;

    return {
      queryId: match[1],
      operationName,
      featureSwitches: parseQuotedArray(match[2]),
      fieldToggles: parseQuotedArray(match[3])
    };
  }

  function fallbackOperation(source) {
    if (source !== "bookmarks") return null;

    return {
      queryId: "XD0ViOeSOW4YoeNTGjVaYw",
      operationName: OPERATION_NAMES.bookmarks,
      featureSwitches: BOOKMARKS_FALLBACK_FEATURE_SWITCHES,
      fieldToggles: []
    };
  }

  async function fetchText(url) {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) throw new Error(`Unable to load ${url}`);
    return response.text();
  }

  function currentScriptUrls(doc) {
    return Array.from((doc || document).scripts)
      .map((script) => script.src)
      .filter((src) => src && /responsive-web\/client-web/.test(src));
  }

  async function discoverFromScriptUrls(urls, operationName) {
    for (const url of Array.from(new Set(urls))) {
      try {
        const text = await fetchText(url);
        const operation = parseOperation(text, operationName);
        if (operation) {
          operationCache.set(operationName, operation);
          return operation;
        }
      } catch {
        // X can rotate or block individual chunks; keep scanning the rest.
      }
    }

    return null;
  }

  async function discoverViaHiddenRoute(path, operationName) {
    const iframe = document.createElement("iframe");
    iframe.hidden = true;
    iframe.tabIndex = -1;
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = "position:absolute;width:1px;height:1px;left:-9999px;top:-9999px;border:0;opacity:0;";

    const loaded = new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error(`${path} did not load in time`)), 25000);
      iframe.onload = () => {
        window.clearTimeout(timer);
        resolve();
      };
    });

    iframe.src = path;
    document.documentElement.appendChild(iframe);

    try {
      await loaded;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const doc = iframe.contentDocument;
        const urls = doc ? currentScriptUrls(doc) : [];
        const operation = await discoverFromScriptUrls(urls, operationName);
        if (operation) return operation;
        await sleep(500);
      }
    } finally {
      iframe.remove();
    }

    return null;
  }

  async function discoverOperation(source) {
    const operationName = OPERATION_NAMES[source];
    if (!operationName) throw new Error(`Unsupported source: ${source}`);
    if (operationCache.has(operationName)) return operationCache.get(operationName);

    const fromCurrentPage = await discoverFromScriptUrls(currentScriptUrls(document), operationName);
    if (fromCurrentPage) return fromCurrentPage;

    if (source === "bookmarks") {
      const fromBookmarksRoute = await discoverViaHiddenRoute("/i/bookmarks", operationName);
      if (fromBookmarksRoute) return fromBookmarksRoute;
    }

    const fallback = fallbackOperation(source);
    if (fallback) return fallback;

    throw new Error(`Could not find X ${operationName} operation metadata. Reload x.com and try again.`);
  }

  async function bearerToken() {
    if (bearerTokenPromise) return bearerTokenPromise;

    bearerTokenPromise = (async () => {
      const urls = currentScriptUrls(document);
      for (const url of urls) {
        try {
          const text = await fetchText(url);
          const match = text.match(/Bearer\s+([A-Za-z0-9%_\-.]+)/);
          if (match) return `Bearer ${match[1]}`;
        } catch {
          // Keep scanning.
        }
      }
      throw new Error("Could not find X web bearer token. Reload x.com and try again.");
    })();

    return bearerTokenPromise;
  }

  function cookieValue(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : "";
  }

  function viewerUserId() {
    const twid = cookieValue("twid");
    const match = twid.match(/u=(\d+)/);
    return match ? match[1] : "";
  }

  function featuresFor(operation) {
    return Object.fromEntries((operation.featureSwitches || []).map((feature) => [feature, true]));
  }

  function fieldTogglesFor(operation, source) {
    const fields = new Set(operation.fieldToggles || []);
    if (source === "likes" && fields.has("withArticlePlainText")) {
      return { withArticlePlainText: false };
    }
    return null;
  }

  function variablesFor(source, cursor, count) {
    const variables =
      source === "bookmarks"
        ? {
            count,
            cursor,
            includePromotedContent: true
          }
        : {
            userId: viewerUserId(),
            count,
            cursor,
            includePromotedContent: false,
            withClientEventToken: false,
            withBirdwatchNotes: false,
            withVoice: true
          };

    if (!variables.cursor) delete variables.cursor;

    if (source === "likes" && !variables.userId) {
      throw new Error("Could not read your X user id from the logged-in session.");
    }

    return variables;
  }

  async function graphQL(operation, variables, source, providedBearer) {
    const csrf = cookieValue("ct0");
    if (!csrf) throw new Error("Could not read X auth cookie. Make sure x.com is logged in.");

    const url = new URL(`/i/api/graphql/${operation.queryId}/${operation.operationName}`, location.origin);
    url.searchParams.set("variables", JSON.stringify(variables));
    url.searchParams.set("features", JSON.stringify(featuresFor(operation)));
    const fieldToggles = fieldTogglesFor(operation, source);
    if (fieldToggles) url.searchParams.set("fieldToggles", JSON.stringify(fieldToggles));

    const response = await fetch(url.toString(), {
      method: "GET",
      credentials: "include",
      headers: {
        authorization: providedBearer || (await bearerToken()),
        "x-csrf-token": csrf,
        "x-twitter-active-user": "yes",
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-client-language": (navigator.language || "en").split("-")[0],
        accept: "*/*"
      }
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`X API returned ${response.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
    }

    const json = await response.json();
    if (json.errors && json.errors.length) {
      throw new Error(json.errors.map((error) => error.message || error.code || "X API error").join("; "));
    }

    return json;
  }

  async function graphQLWithRetry(operation, variables, source, providedBearer) {
    let lastError;

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await graphQL(operation, variables, source, providedBearer);
      } catch (error) {
        lastError = error;
        if (!isRetriableError(error) || attempt >= 4) break;
        await sleep(1000 * attempt);
      }
    }

    throw lastError;
  }

  function timelineFromResponse(json, source) {
    if (source === "bookmarks") {
      return json && json.data && json.data.bookmark_timeline_v2 && json.data.bookmark_timeline_v2.timeline;
    }

    const result = json && json.data && json.data.user && json.data.user.result;
    return result && result.timeline && result.timeline.timeline;
  }

  function timelineEntries(timeline) {
    const entries = [];
    for (const instruction of (timeline && timeline.instructions) || []) {
      if (Array.isArray(instruction.entries)) entries.push(...instruction.entries);
      if (instruction.entry) entries.push(instruction.entry);
    }
    return entries;
  }

  function unwrapTweet(result) {
    if (!result) return null;
    if (result.__typename === "Tweet") return result;
    if (result.__typename === "TweetWithVisibilityResults") return unwrapTweet(result.tweet);
    if (result.tweet) return unwrapTweet(result.tweet);
    if (result.result) return unwrapTweet(result.result);
    return null;
  }

  function sliceCharacters(value, start, end) {
    return Array.from(value || "").slice(start, end).join("");
  }

  function displayText(text, legacy) {
    let next = text || "";
    const range = legacy && Array.isArray(legacy.display_text_range) ? legacy.display_text_range : null;
    if (!range || range.length < 2) return next;

    const start = Math.max(0, Number(range[0]) || 0);
    const end = Math.max(start, Number(range[1]) || 0);
    if (start === 0 && !end) return next;

    const legacyText = (legacy && (legacy.full_text || legacy.text)) || "";
    const replyPrefix = start > 0 ? sliceCharacters(legacyText, 0, start) : "";
    if (replyPrefix && next.startsWith(replyPrefix)) {
      return next.slice(replyPrefix.length).trimStart();
    }

    if (legacyText && next !== legacyText) return next;

    const chars = Array.from(next);
    if (end > start && end <= chars.length) return chars.slice(start, end).join("");
    return next;
  }

  function expandText(text, legacy) {
    let next = displayText(text || "", legacy);
    const urls = [
      ...((legacy && legacy.entities && legacy.entities.urls) || []),
      ...((legacy && legacy.entities && legacy.entities.media) || [])
    ];

    for (const url of urls) {
      if (!url || !url.url) continue;
      const replacement = url.expanded_url || url.display_url || "";
      next = next.replace(url.url, replacement);
    }

    return next.trim();
  }

  function bestVideoUrl(media) {
    const variants = (media.video_info && media.video_info.variants) || [];
    const mp4s = variants
      .filter((variant) => variant.content_type === "video/mp4" && variant.url)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    return (mp4s[0] && mp4s[0].url) || media.expanded_url || "";
  }

  function normalizeMedia(legacy) {
    const media = (legacy && legacy.extended_entities && legacy.extended_entities.media) || [];
    return media
      .map((item) => ({
        type: item.type || "photo",
        previewUrl: item.media_url_https || item.media_url || "",
        url: item.type === "video" || item.type === "animated_gif" ? bestVideoUrl(item) : item.expanded_url || item.media_url_https || "",
        width: item.original_info && item.original_info.width,
        height: item.original_info && item.original_info.height
      }))
      .filter((item) => item.previewUrl);
  }

  function normalizeUser(userResult) {
    const user = unwrapUser(userResult);
    const legacy = (user && user.legacy) || {};
    const core = (user && user.core) || {};
    const avatar = (user && user.avatar) || {};
    const name = legacy.name || core.name || (user && (user.name || user.display_name)) || "";
    const handle = legacy.screen_name || core.screen_name || (user && (user.screen_name || user.username)) || "";
    const avatarUrl =
      legacy.profile_image_url_https ||
      legacy.profile_image_url ||
      avatar.image_url ||
      (user && (user.profile_image_url_https || user.profile_image_url)) ||
      "";

    return {
      name,
      handle,
      avatarUrl,
      isVerified: Boolean((user && (user.is_blue_verified || user.verified)) || legacy.verified)
    };
  }

  function unwrapUser(result) {
    if (!result) return null;
    if (result.__typename === "User") return result;
    if (result.result) return unwrapUser(result.result);
    if (result.user_results) return unwrapUser(result.user_results.result);
    if (result.user_result) return unwrapUser(result.user_result.result || result.user_result);
    if (result.user) return unwrapUser(result.user);
    return result;
  }

  function normalizeQuoted(tweet) {
    const quoted = unwrapTweet(tweet && tweet.quoted_status_result && tweet.quoted_status_result.result);
    if (!quoted || !quoted.legacy) return null;

    const user = normalizeUser(quoted.core);
    const noteText =
      quoted.note_tweet &&
      quoted.note_tweet.note_tweet_results &&
      quoted.note_tweet.note_tweet_results.result &&
      quoted.note_tweet.note_tweet_results.result.text;
    const authorHandle = user.handle || "";

    return {
      author: `${user.name || ""}${user.handle ? ` @${user.handle}` : ""}`.trim(),
      authorName: user.name || "",
      authorHandle,
      authorAvatarUrl: user.avatarUrl || "",
      isVerified: user.isVerified,
      createdAt: quoted.legacy.created_at || "",
      text: expandText(noteText || quoted.legacy.full_text || quoted.legacy.text || "", quoted.legacy).slice(0, 280),
      url: authorHandle ? `https://x.com/${authorHandle}/status/${quoted.rest_id}` : `https://x.com/i/status/${quoted.rest_id}`
    };
  }

  function normalizeTweet(tweet, source) {
    if (!tweet || !tweet.rest_id || !tweet.legacy) return null;

    const user = normalizeUser(tweet.core);

    const noteText =
      tweet.note_tweet &&
      tweet.note_tweet.note_tweet_results &&
      tweet.note_tweet.note_tweet_results.result &&
      tweet.note_tweet.note_tweet_results.result.text;

    const text = expandText(noteText || tweet.legacy.full_text || tweet.legacy.text || "", tweet.legacy);
    const createdAt = tweet.legacy.created_at || "";
    const createdAtMs = createdAt ? Date.parse(createdAt) || 0 : 0;
    const authorHandle = user.handle || "";

    return {
      id: tweet.rest_id,
      source,
      sources: [source],
      authorName: user.name || "",
      authorHandle,
      authorAvatarUrl: user.avatarUrl || "",
      isVerified: user.isVerified,
      text,
      createdAt,
      createdAtMs,
      url: authorHandle ? `https://x.com/${authorHandle}/status/${tweet.rest_id}` : `https://x.com/i/status/${tweet.rest_id}`,
      media: normalizeMedia(tweet.legacy),
      quoted: normalizeQuoted(tweet),
      archivedAt: Date.now()
    };
  }

  function extractPosts(timeline, source) {
    const posts = [];
    for (const entry of timelineEntries(timeline)) {
      const content = entry && entry.content;
      if (!content) continue;

      const itemContents = [];
      if (content.itemContent) itemContents.push(content.itemContent);
      if (Array.isArray(content.items)) {
        for (const item of content.items) {
          if (item && item.item && item.item.itemContent) itemContents.push(item.item.itemContent);
        }
      }

      for (const itemContent of itemContents) {
        if (!itemContent || itemContent.itemType !== "TimelineTweet") continue;
        if (itemContent.promotedMetadata) continue;
        const tweet = unwrapTweet(itemContent.tweet_results && itemContent.tweet_results.result);
        const post = normalizeTweet(tweet, source);
        if (post) posts.push(post);
      }
    }

    const seen = new Set();
    return posts.filter((post) => {
      if (seen.has(post.id)) return false;
      seen.add(post.id);
      return true;
    });
  }

  function bottomCursor(timeline) {
    for (const entry of timelineEntries(timeline)) {
      const content = entry && entry.content;
      if (!content) continue;
      if (content.cursorType === "Bottom" && content.value) return content.value;
      if (/cursor-bottom/i.test(entry.entryId || "") && content.value) return content.value;
    }
    return "";
  }

  async function syncSource(requestId, source, options) {
    const operation = options.operation && options.operation.queryId ? options.operation : await discoverOperation(source);
    const providedBearer = options.bearer || "";
    const count = Math.max(20, Math.min(100, Number(options.pageSize) || 100));
    const maxPages = Math.max(1, Math.min(1000, Number(options.maxPages) || 100));
    const pageOffset = Math.max(0, Number(options.pageOffset) || 0);

    let cursor = options.cursor || "";
    let total = 0;
    let emptyPages = 0;

    for (let page = 1; page <= maxPages; page += 1) {
      const absolutePage = pageOffset + page;
      throwIfCancelled(requestId);
      emit("sync-status", {
        requestId,
        source,
        page: absolutePage,
        message: `${source}: fetching page ${absolutePage}`
      });

      const json = await graphQLWithRetry(operation, variablesFor(source, cursor, count), source, providedBearer);
      throwIfCancelled(requestId);
      const timeline = timelineFromResponse(json, source);
      if (!timeline) throw new Error(`${source}: X did not return a timeline`);

      const posts = extractPosts(timeline, source);
      const nextCursor = bottomCursor(timeline);
      total += posts.length;

      emit("sync-page", {
        requestId,
        source,
        page: absolutePage,
        posts,
        cursor: nextCursor
      });

      emptyPages = posts.length ? 0 : emptyPages + 1;
      if (!nextCursor || nextCursor === cursor || emptyPages >= 10) {
        emit("sync-complete", {
          requestId,
          source,
          cursor: nextCursor || "",
          pages: absolutePage,
          total,
          reason: !nextCursor ? "end" : "stalled"
        });
        return;
      }

      cursor = nextCursor;
      await sleep(800);
      throwIfCancelled(requestId);
    }

    emit("sync-complete", {
      requestId,
      source,
      cursor,
      pages: pageOffset + maxPages,
      total,
      reason: "max-pages"
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.origin !== location.origin) return;
    const data = event.data || {};
    if (data.channel !== TO_PAGE) return;

    if (data.type === "cancel-sync" && data.requestId) {
      cancelledRequests.add(data.requestId);
      return;
    }

    if (data.type !== "sync-source") return;

    syncSource(data.requestId, data.source, data.options || {}).catch((error) => {
      emit("sync-error", {
        requestId: data.requestId,
        source: data.source,
        message: error && error.message ? error.message : String(error)
      });
    });
  });
})();

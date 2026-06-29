importScripts("idb.js");

const DEFAULT_STATUS = {
  syncing: false,
  message: "Idle",
  lastError: "",
  updatedAt: 0,
  lastSyncAt: 0,
  counts: { total: 0, likes: 0, bookmarks: 0 }
};

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

const scriptTextCache = new Map();

function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

function storageSet(value) {
  return chrome.storage.local.set(value);
}

async function setStatus(patch) {
  const current = (await storageGet("xhStatus")).xhStatus || DEFAULT_STATUS;
  const next = {
    ...DEFAULT_STATUS,
    ...current,
    ...patch,
    counts: patch.counts || current.counts || DEFAULT_STATUS.counts,
    updatedAt: Date.now()
  };
  await storageSet({ xhStatus: next });
  return next;
}

async function activeXTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !tab.id) {
    throw new Error("Open x.com, then try again.");
  }

  const url = tab.url || "";
  if (!/^https:\/\/(x|twitter)\.com\//.test(url)) {
    throw new Error("Open x.com, then try again.");
  }

  return tab;
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

async function refreshCounts() {
  const counts = await XHistoryDB.getCounts();
  await setStatus({ counts });
  return counts;
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

async function fetchScriptText(url) {
  if (!/^https:\/\/(abs\.twimg\.com|x\.com|twitter\.com)\//.test(url)) {
    throw new Error("Unsupported script host");
  }

  if (scriptTextCache.has(url)) return scriptTextCache.get(url);

  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) throw new Error(`Unable to fetch ${url}`);
  const text = await response.text();
  scriptTextCache.set(url, text);

  if (scriptTextCache.size > 30) {
    const firstKey = scriptTextCache.keys().next().value;
    scriptTextCache.delete(firstKey);
  }

  return text;
}

async function discoverXMetadata(source, scriptUrls) {
  const operationName = OPERATION_NAMES[source];
  if (!operationName) throw new Error(`Unsupported source: ${source}`);

  let operation = null;
  let bearer = "";
  const urls = Array.from(new Set(scriptUrls || [])).filter((url) => /responsive-web\/client-web/.test(url));

  for (const url of urls) {
    try {
      const text = await fetchScriptText(url);
      if (!operation) operation = parseOperation(text, operationName);
      if (!bearer) {
        const match = text.match(/Bearer\s+([A-Za-z0-9%_\-.]+)/);
        if (match) bearer = `Bearer ${match[1]}`;
      }
      if (operation && bearer) break;
    } catch {
      // Ignore rotated or unavailable chunks and keep scanning.
    }
  }

  if (!operation) operation = fallbackOperation(source);

  return { operation, bearer };
}

chrome.runtime.onInstalled.addListener(() => {
  setStatus(DEFAULT_STATUS).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message && message.type) {
      case "START_SYNC": {
        const tab = await activeXTab();
        return sendToTab(tab.id, message);
      }

      case "STOP_SYNC": {
        const tab = await activeXTab().catch(() => null);
        if (tab && tab.id) {
          await sendToTab(tab.id, message).catch(() => {});
        }
        const status = await setStatus({ syncing: false, message: "Sync stopped", lastError: "" });
        return { ok: true, status };
      }

      case "STORE_POSTS": {
        const result = await XHistoryDB.upsertPosts(message.posts || [], message.source);
        const counts = await refreshCounts();
        return { ok: true, ...result, counts };
      }

      case "GET_RANDOM_POSTS": {
        const posts = await XHistoryDB.getRandomPosts(message.limit || 100, message.sources || []);
        return { ok: true, posts };
      }

      case "GET_COUNTS": {
        const counts = await refreshCounts();
        return { ok: true, counts };
      }

      case "DISCOVER_X_METADATA": {
        const metadata = await discoverXMetadata(message.source, message.scriptUrls || []);
        return { ok: true, ...metadata };
      }

      case "CLEAR_ARCHIVE": {
        await XHistoryDB.clearArchive();
        const counts = await refreshCounts();
        await storageSet({ xhSyncProgress: {} });
        await setStatus({ message: "Archive cleared", lastError: "", lastSyncAt: 0, counts });
        return { ok: true, counts };
      }

      case "SET_STATUS": {
        const status = await setStatus(message.patch || {});
        return { ok: true, status };
      }

      default:
        return { ok: false, error: "Unknown message" };
    }
  })()
    .then((response) => sendResponse(response))
    .catch(async (error) => {
      const messageText = error && error.message ? error.message : String(error);
      await setStatus({ syncing: false, lastError: messageText, message: messageText }).catch(() => {});
      sendResponse({ ok: false, error: messageText });
    });

  return true;
});

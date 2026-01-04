import {
  eventSource,
  event_types,
  characters,
  getCharacters,
  getRequestHeaders,
  name1,
  select_rm_info,
  selectCharacterById,
  this_chid,
} from "../../../../script.js";
import {
  importTags,
  tags,
  removeTagFromEntity,
  applyCharacterTagsToMessageDivs,
  tag_import_setting,
} from "../../../tags.js";
import { getCurrentUserHandle } from "../../../user.js";
import { power_user } from "../../../power-user.js";

import {
  initSettingsUI,
  loadSettings,
  getSettings,
  getLastImportedTagIdsForAvatar,
  setLastImportedTagIdsForAvatar,
  clearLastImportedTagIdsForAvatar,
  setUiConnectionStatus,
  setUiLastResult,
} from "./settings.js";

let es = null;
let reconnectTimer = null;
let reconnectBackoffMs = 1000;
let isManuallyDisconnected = false;

let refreshTimer = null;
let pendingRefresh = null;

/**
 * @type {(
 *  | { kind: "import", cardId: string, exportUrl: string, filename?: string, ts?: number }
 *  | { kind: "open", cardId: string, stProfileHandle: string, stAvatarFile: string, stAvatarBase: string, ts?: number }
 * )[]}
 */
const queue = [];
let processing = false;

/** @type {Map<string, number>} */
const inFlightByCardId = new Map();

function log(...args) {
  console.log("[SillyInnkeeper]", ...args);
}

function warn(...args) {
  console.warn("[SillyInnkeeper]", ...args);
}

function err(...args) {
  console.error("[SillyInnkeeper]", ...args);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function joinSiUrl(siBase, relativeOrAbsolute) {
  if (!relativeOrAbsolute) return siBase;

  // If absolute already
  try {
    const u = new URL(relativeOrAbsolute);
    return u.toString();
  } catch {
    // ok
  }

  const rel = String(relativeOrAbsolute);
  if (rel.startsWith("/")) return `${siBase}${rel}`;
  return `${siBase}/${rel}`;
}

function updateStatus(connected, text) {
  setUiConnectionStatus({ connected, text });
}

function updateLast(ok, text) {
  setUiLastResult({ ok, text });
}

function normalizeTagNameForCompare(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase();
}

function isExcludedCardTagName(name) {
  const n = String(name ?? "")
    .trim()
    .toUpperCase();
  return n === "ROOT" || n === "TAVERN";
}

function findCharacterIndexByAvatar({ avatarFile, avatarBase }) {
  const file = String(avatarFile ?? "").trim();
  const base = String(avatarBase ?? "").trim();
  const avatarPng = base ? `${base}.png` : "";

  if (!file && !base) return -1;

  const findIdx = () => {
    if (file) {
      const exact = characters.findIndex((c) => c?.avatar === file);
      if (exact >= 0) return exact;
    }
    if (avatarPng) {
      const exact = characters.findIndex((c) => c?.avatar === avatarPng);
      if (exact >= 0) return exact;
    }
    if (file) {
      const prefix = characters.findIndex((c) =>
        String(c?.avatar ?? "").startsWith(file)
      );
      if (prefix >= 0) return prefix;
    }
    if (base) {
      const prefix = characters.findIndex((c) =>
        String(c?.avatar ?? "").startsWith(base)
      );
      if (prefix >= 0) return prefix;
    }
    return -1;
  };

  return findIdx();
}

function getDesiredCardTagNamesFromCharacter(character) {
  const raw = Array.isArray(character?.tags) ? character.tags : [];
  return raw
    .map((t) => String(t ?? "").trim())
    .filter((t) => t && !isExcludedCardTagName(t));
}

function getTagById(tagId) {
  const id = String(tagId ?? "");
  if (!id) return null;
  return tags?.find?.((t) => String(t?.id ?? "") === id) ?? null;
}

function getTagByNameInsensitive(tagName) {
  const needle = normalizeTagNameForCompare(tagName);
  if (!needle) return null;
  return (
    tags?.find?.((t) => normalizeTagNameForCompare(t?.name) === needle) ?? null
  );
}

async function syncTagsAfterCardsChanged({ avatarFile, avatarBase, mode }) {
  // Respect ST global tag import setting; NONE means we do not touch tags at all.
  if (power_user?.tag_import_setting === tag_import_setting.NONE) return;

  const idx = findCharacterIndexByAvatar({ avatarFile, avatarBase });
  if (idx < 0) return;

  const character = characters[idx];
  const avatarKey = String(character?.avatar ?? "").trim();
  if (!avatarKey) return;

  if (String(mode ?? "") === "delete") {
    clearLastImportedTagIdsForAvatar(avatarKey);
    return;
  }

  // Add/create tags via ST's own flow (respects ASK/NONE/ALL/ONLY_EXISTING and shows UI if needed)
  try {
    await importTags(character);
  } catch (e) {
    warn("importTags failed after st:cards_changed", e);
  }

  // Compute desired tag IDs from PNG metadata (character.tags), then remove only previously-imported extras.
  const desiredNames = getDesiredCardTagNamesFromCharacter(character);
  const desiredIds = desiredNames
    .map((name) => getTagByNameInsensitive(name))
    .filter(Boolean)
    .map((t) => String(t.id))
    .filter(Boolean);

  const desiredIdSet = new Set(desiredIds);
  const prevImported = getLastImportedTagIdsForAvatar(avatarKey);
  const toRemove = prevImported.filter((id) => !desiredIdSet.has(String(id)));

  for (const id of toRemove) {
    const tagObj = getTagById(id);
    if (!tagObj) continue;
    try {
      removeTagFromEntity(tagObj, avatarKey);
    } catch (e) {
      warn("Failed to remove previously imported tag", id, avatarKey, e);
    }
  }

  setLastImportedTagIdsForAvatar(avatarKey, desiredIds);

  // Best-effort: update chat DOM tag attributes immediately.
  try {
    applyCharacterTagsToMessageDivs();
  } catch (e) {
    // ignore
  }
}

function scheduleReconnect(reason = "") {
  clearReconnectTimer();

  const { autoConnect } = getSettings();
  if (!autoConnect || isManuallyDisconnected) return;

  const delay = Math.min(reconnectBackoffMs, 30_000);
  reconnectBackoffMs = Math.min(reconnectBackoffMs * 2, 30_000);

  warn(`Reconnect scheduled in ${delay}ms`, reason);
  reconnectTimer = setTimeout(() => {
    connect().catch((e) => err("Reconnect failed", e));
  }, delay);
}

function closeEventSource() {
  if (es) {
    try {
      es.close();
    } catch {
      // ignore
    }
  }
  es = null;
}

async function reportResultToSi({
  cardId,
  ok,
  message,
  stCharacterId = undefined,
  action,
}) {
  const s = getSettings();
  if (!s.reportResult) return;

  const url = joinSiUrl(s.siBase, "/api/st/import-result");

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cardId,
        ok: !!ok,
        action: action ? String(action) : undefined,
        message: message ? String(message).slice(0, 500) : undefined,
        stCharacterId: stCharacterId ? String(stCharacterId) : undefined,
      }),
    });

    if (!res.ok) {
      // Do not break the main flow
      warn("Failed to report result to SI", res.status, res.statusText);
    }
  } catch (e) {
    warn("Failed to report result to SI", e);
  }
}

async function importPngIntoSt(file) {
  const formData = new FormData();
  formData.append("avatar", file);
  formData.append("file_type", "png");
  formData.append("user_name", name1);

  const res = await fetch("/api/characters/import", {
    method: "POST",
    body: formData,
    headers: getRequestHeaders({ omitContentType: true }),
    cache: "no-cache",
  });

  if (!res.ok) {
    throw new Error(`ST import failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  if (data?.error) {
    throw new Error("ST import returned error");
  }

  return data?.file_name;
}

async function downloadPngAsFile({ cardId, exportUrl, filename }) {
  const s = getSettings();
  const exportAbs = joinSiUrl(s.siBase, exportUrl);
  const res = await fetch(exportAbs);
  if (!res.ok) {
    throw new Error(`PNG download failed: ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get("Content-Type") ?? "";
  if (contentType && !contentType.toLowerCase().includes("image/png")) {
    warn("Unexpected Content-Type for export.png:", contentType);
  }

  const bytes = await res.arrayBuffer();
  const blob = new Blob([bytes], { type: "image/png" });
  const fileName = filename || `card-${cardId}.png`;
  return new File([blob], fileName, { type: "image/png" });
}

async function handleCardOpen(payload) {
  const startedAt = Date.now();
  updateLast(null, `Opening ${payload.cardId}...`);

  try {
    const currentHandle = getCurrentUserHandle?.() ?? "default-user";
    const wantHandle = String(payload.stProfileHandle ?? "").trim();

    if (!wantHandle) {
      throw new Error("Missing stProfileHandle in st:card_open payload");
    }

    if (String(currentHandle) !== wantHandle) {
      throw new Error(
        `Wrong ST profile: current='${currentHandle}', expected='${wantHandle}'. Switch user/profile in SillyTavern.`
      );
    }

    await getCharacters();

    const avatarFile = String(payload.stAvatarFile ?? "").trim();
    const avatarBase = String(payload.stAvatarBase ?? "").trim();
    const avatarPng = avatarBase ? `${avatarBase}.png` : "";

    if (!avatarFile && !avatarBase) {
      throw new Error(
        "Missing stAvatarFile/stAvatarBase in st:card_open payload"
      );
    }

    const findIdx = () => {
      if (avatarFile) {
        const exact = characters.findIndex((c) => c?.avatar === avatarFile);
        if (exact >= 0) return exact;
      }
      if (avatarPng) {
        const exact = characters.findIndex((c) => c?.avatar === avatarPng);
        if (exact >= 0) return exact;
      }
      if (avatarFile) {
        const prefix = characters.findIndex((c) =>
          String(c?.avatar ?? "").startsWith(avatarFile)
        );
        if (prefix >= 0) return prefix;
      }
      if (avatarBase) {
        const prefix = characters.findIndex((c) =>
          String(c?.avatar ?? "").startsWith(avatarBase)
        );
        if (prefix >= 0) return prefix;
      }
      return -1;
    };

    const idx = findIdx();
    if (idx < 0) {
      throw new Error(
        `Character not found in current profile by avatar '${
          avatarFile || avatarPng || avatarBase
        }'`
      );
    }

    // Open character (switches chat)
    await selectCharacterById(idx, { switchMenu: false });

    // Highlight in library (reuse ST import highlight behavior)
    // IMPORTANT: do NOT pass previousCharId here.
    // In SillyTavern, select_rm_info(..., previousCharId) calls setCharacterId(previousCharId),
    // which can desync selected character vs opened chat and trigger integrity/save loops.
    try {
      const flashKey = avatarBase || avatarFile;
      select_rm_info("char_import_no_toast", flashKey);
    } catch (e) {
      warn("Failed to highlight opened character", e);
    }

    const took = Date.now() - startedAt;
    updateLast(true, `OK(open): ${payload.cardId} (${took}ms)`);

    await reportResultToSi({
      cardId: payload.cardId,
      ok: true,
      action: "open",
      message: avatarFile ? `Opened: ${avatarFile}` : "Opened",
      stCharacterId: avatarFile || avatarPng || avatarBase,
    });
  } catch (e) {
    err("Open failed", payload, e);
    updateLast(
      false,
      `ERR(open): ${payload.cardId} (${String(e?.message ?? e)})`
    );

    await reportResultToSi({
      cardId: payload.cardId,
      ok: false,
      action: "open",
      message: String(e?.message ?? e),
    });
  }
}

async function handleCardPlay(payload) {
  const startedAt = Date.now();
  updateLast(null, `Importing ${payload.cardId}...`);

  try {
    const oldSelectedChar =
      this_chid !== undefined ? characters?.[this_chid]?.avatar : null;

    const file = await downloadPngAsFile(payload);
    const stFileName = await importPngIntoSt(file);

    // Refresh characters list (triggers /api/characters/all) and highlight imported card in library
    await getCharacters();

    const avatarFile = stFileName?.endsWith(".png")
      ? stFileName
      : `${stFileName}.png`;
    const idx = characters.findIndex((c) => c?.avatar === avatarFile);

    if (idx >= 0) {
      await importTags(characters[idx]);
    }
    try {
      select_rm_info("char_import_no_toast", stFileName, oldSelectedChar);
    } catch (e) {
      warn("Failed to highlight imported character", e);
    }

    // Optionally open imported character
    const s = getSettings();
    if (s.openImported) {
      const avatarFile = stFileName?.endsWith(".png")
        ? stFileName
        : `${stFileName}.png`;
      const idx = characters.findIndex((c) => c?.avatar === avatarFile);
      if (idx >= 0) {
        await selectCharacterById(idx, { switchMenu: false });
      } else {
        warn("Could not find imported character in list", avatarFile);
      }
    }

    const took = Date.now() - startedAt;
    updateLast(true, `OK: ${payload.cardId} (${took}ms)`);

    await reportResultToSi({
      cardId: payload.cardId,
      ok: true,
      action: "import",
      message: stFileName ? `Imported: ${stFileName}` : "Imported",
      stCharacterId: stFileName,
    });
  } catch (e) {
    err("Import failed", payload, e);
    updateLast(false, `ERR: ${payload.cardId} (${String(e?.message ?? e)})`);

    await reportResultToSi({
      cardId: payload.cardId,
      ok: false,
      action: "import",
      message: String(e?.message ?? e),
    });
  }
}

async function processQueue() {
  if (processing) return;
  processing = true;

  try {
    while (queue.length) {
      const item = queue.shift();
      if (!item) continue;

      if (item.kind === "open") {
        await handleCardOpen(item);
      } else {
        await handleCardPlay(item);
      }

      // small yield
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    processing = false;
  }
}

function enqueue(payload) {
  const s = getSettings();
  const now = Date.now();

  // Dedupe: ignore same cardId while in flight / within window
  const last = inFlightByCardId.get(payload.cardId);
  if (typeof last === "number" && now - last < s.dedupeWindowMs) {
    warn("Duplicate st:card_play ignored", payload.cardId);
    return;
  }

  // Enforce queue max
  if (queue.length >= s.queueMax) {
    warn("Queue overflow, dropping event", payload.cardId);
    updateLast(false, `Queue overflow: dropped ${payload.cardId}`);
    return;
  }

  inFlightByCardId.set(payload.cardId, now);
  setTimeout(() => {
    // keep map bounded
    const ts = inFlightByCardId.get(payload.cardId);
    if (typeof ts === "number" && Date.now() - ts >= s.dedupeWindowMs) {
      inFlightByCardId.delete(payload.cardId);
    }
  }, s.dedupeWindowMs + 100);

  queue.push(payload);
  processQueue().catch((e) => err("Queue processing error", e));
}

function onSseMessage(evt) {
  try {
    const payload = JSON.parse(evt.data);
    if (
      !payload ||
      (payload.type !== "st:card_play" &&
        payload.type !== "st:card_open" &&
        payload.type !== "st:cards_changed")
    )
      return;

    const { enabled } = getSettings();
    if (!enabled) {
      warn("Received ST event but extension disabled", payload?.type);
      return;
    }

    if (!payload.cardId) {
      warn("Invalid ST payload (no cardId)", payload);
      return;
    }

    if (payload.type === "st:cards_changed") {
      const stProfileHandle = String(payload.stProfileHandle ?? "").trim();
      const stAvatarFile = String(payload.stAvatarFile ?? "").trim();
      const stAvatarBase = String(payload.stAvatarBase ?? "").trim();
      const mode = String(payload.mode ?? "").trim();

      // Coalesce bursts into a single refresh (saves getCharacters spam).
      pendingRefresh = {
        cardId: String(payload.cardId),
        stProfileHandle,
        stAvatarFile,
        stAvatarBase,
        mode,
        ts: payload.ts,
      };

      if (!refreshTimer) {
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          const p = pendingRefresh;
          pendingRefresh = null;
          if (!p) return;
          refreshAfterCardsChanged(p).catch((e) =>
            err("Failed to refresh after st:cards_changed", e)
          );
        }, 300);
      }
      return;
    }

    if (payload.type === "st:card_open") {
      if (
        !payload.stProfileHandle ||
        (!payload.stAvatarFile && !payload.stAvatarBase)
      ) {
        warn("Invalid st:card_open payload", payload);
        return;
      }
      enqueue({
        kind: "open",
        cardId: String(payload.cardId),
        stProfileHandle: String(payload.stProfileHandle),
        stAvatarFile: payload.stAvatarFile ? String(payload.stAvatarFile) : "",
        stAvatarBase: payload.stAvatarBase ? String(payload.stAvatarBase) : "",
        ts: payload.ts,
      });
      return;
    }

    if (!payload.exportUrl) {
      warn("Invalid st:card_play payload", payload);
      return;
    }

    enqueue({
      kind: "import",
      cardId: String(payload.cardId),
      exportUrl: String(payload.exportUrl),
      filename: payload.filename ? String(payload.filename) : undefined,
      ts: payload.ts,
    });
  } catch (e) {
    warn("Failed to parse SSE event data", e);
  }
}

async function refreshAfterCardsChanged(payload) {
  const startedAt = Date.now();

  try {
    const currentHandle = getCurrentUserHandle?.() ?? "default-user";
    const wantHandle = String(payload.stProfileHandle ?? "").trim();
    if (wantHandle && String(currentHandle) !== wantHandle) {
      // Different ST profile; ignore.
      return;
    }

    const oldSelectedAvatar =
      this_chid !== undefined ? characters?.[this_chid]?.avatar : null;

    updateLast(null, "Refreshing characters...");
    await getCharacters();

    const avatarFile = String(payload.stAvatarFile ?? "").trim();
    const avatarBase =
      String(payload.stAvatarBase ?? "").trim() ||
      (avatarFile ? avatarFile.replace(/\.png$/i, "") : "");

    // Sync ST tags from updated PNG metadata (best-effort).
    try {
      await syncTagsAfterCardsChanged({
        avatarFile,
        avatarBase,
        mode: payload.mode,
      });
    } catch (e) {
      warn("Failed to sync tags after st:cards_changed", e);
    }

    // Try to highlight updated/new character in the UI (best-effort).
    if (avatarBase || avatarFile) {
      try {
        const flashKey = avatarBase || avatarFile;
        select_rm_info("char_import_no_toast", flashKey, oldSelectedAvatar);
      } catch (e) {
        warn("Failed to highlight refreshed character", e);
      }
    }

    // If the updated file is currently selected, re-select it to force reload.
    if (oldSelectedAvatar) {
      const targetAvatar =
        avatarFile && avatarFile.endsWith(".png")
          ? avatarFile
          : avatarFile
          ? `${avatarFile}.png`
          : oldSelectedAvatar;
      if (targetAvatar && oldSelectedAvatar === targetAvatar) {
        const idx = characters.findIndex((c) => c?.avatar === targetAvatar);
        if (idx >= 0) {
          await selectCharacterById(idx, { switchMenu: false });
        }
      }
    }

    const took = Date.now() - startedAt;
    updateLast(
      true,
      `OK(refresh): ${payload.cardId}${
        payload.mode ? ` (${payload.mode})` : ""
      } (${took}ms)`
    );
  } catch (e) {
    updateLast(
      false,
      `ERR(refresh): ${payload.cardId} (${String(e?.message ?? e)})`
    );
    throw e;
  }
}

export async function connect() {
  loadSettings();
  const s = getSettings();

  if (!s.enabled) {
    updateStatus(false, "Disabled");
    return;
  }

  clearReconnectTimer();
  isManuallyDisconnected = false;

  if (es) {
    // already connected/connecting
    return;
  }

  const sseUrl = joinSiUrl(s.siBase, "/api/events");
  updateStatus(false, "Connecting...");

  try {
    es = new EventSource(sseUrl);
    reconnectBackoffMs = 1000;

    es.onopen = () => {
      updateStatus(true, "Connected");
      log("SSE connected", sseUrl);
    };

    es.onerror = () => {
      updateStatus(false, "Disconnected");
      warn("SSE error");

      // EventSource may auto-reconnect, but we also schedule a reconnect
      // in case the browser stops retrying due to repeated errors.
      closeEventSource();
      scheduleReconnect("onerror");
    };

    es.addEventListener("hello", (evt) => {
      log("hello", evt.data);
    });

    es.addEventListener("ping", () => {
      // ignore
    });

    es.addEventListener("st:card_play", onSseMessage);
    es.addEventListener("st:card_open", onSseMessage);
    es.addEventListener("st:cards_changed", onSseMessage);
  } catch (e) {
    closeEventSource();
    updateStatus(false, "Disconnected");
    err("Failed to connect SSE", e);
    scheduleReconnect("connect exception");
  }
}

export async function disconnect() {
  isManuallyDisconnected = true;
  clearReconnectTimer();
  closeEventSource();
  updateStatus(false, "Disconnected");
}

export async function testConnection() {
  loadSettings();
  const s = getSettings();

  if (!s.enabled) {
    /** @type {any} */
    const toast = globalThis.toastr;
    toast?.info?.("SillyInnkeeper extension is disabled");
    return false;
  }

  const sseUrl = joinSiUrl(s.siBase, "/api/events");

  return await new Promise((resolve) => {
    let done = false;
    const finish = (ok, msg) => {
      if (done) return;
      done = true;
      try {
        esTest?.close();
      } catch {
        // ignore
      }
      if (ok) {
        /** @type {any} */
        const toast = globalThis.toastr;
        toast?.success?.(msg ?? "Connected");
      } else {
        /** @type {any} */
        const toast = globalThis.toastr;
        toast?.error?.(msg ?? "Failed to connect");
      }
      resolve(ok);
    };

    let esTest;
    try {
      esTest = new EventSource(sseUrl);
    } catch (e) {
      finish(false, String(e?.message ?? e));
      return;
    }

    const t = setTimeout(() => {
      finish(false, "Timeout");
    }, 2000);

    esTest.onopen = () => {
      clearTimeout(t);
      finish(true, "SSE connection OK");
    };

    esTest.onerror = () => {
      clearTimeout(t);
      finish(false, "SSE connection error");
    };
  });
}

function onSettingsChanged() {
  const s = getSettings();

  // If disabled, disconnect.
  if (!s.enabled) {
    disconnect();
    return;
  }

  // If enabled and autoconnect, reconnect.
  if (s.autoConnect) {
    disconnect();
    connect().catch((e) => err("Reconnect after settings change failed", e));
  }
}

function init() {
  log("Extension initialized");

  loadSettings();

  // expose API for settings UI
  /** @type {any} */ (window).__st_sillyInnkeeper = {
    connect,
    disconnect,
    testConnection,
    onSettingsChanged,
  };

  // Connect after app is ready (safer for toasts/settings)
  eventSource.on(event_types.APP_READY, () => {
    const s = getSettings();
    if (s.enabled && s.autoConnect) {
      connect().catch((e) => err("Auto-connect failed", e));
    } else {
      updateStatus(false, s.enabled ? "Disconnected" : "Disabled");
    }
  });
}

try {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    setTimeout(init, 50);
  }

  eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, () => {
    setTimeout(initSettingsUI, 200);
  });
} catch (e) {
  err("Initialization error", e);
}

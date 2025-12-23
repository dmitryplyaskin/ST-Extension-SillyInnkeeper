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
import { importTags } from "../../../tags.js";

import {
  initSettingsUI,
  loadSettings,
  getSettings,
  setUiConnectionStatus,
  setUiLastResult,
} from "./settings.js";

let es = null;
let reconnectTimer = null;
let reconnectBackoffMs = 1000;
let isManuallyDisconnected = false;

/** @type {{ cardId: string, exportUrl: string, filename?: string, ts?: number }[]} */
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

async function reportResultToSi({ cardId, ok, message, stCharacterId }) {
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
      message: stFileName ? `Imported: ${stFileName}` : "Imported",
      stCharacterId: stFileName,
    });
  } catch (e) {
    err("Import failed", payload, e);
    updateLast(false, `ERR: ${payload.cardId} (${String(e?.message ?? e)})`);

    await reportResultToSi({
      cardId: payload.cardId,
      ok: false,
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

      await handleCardPlay(item);

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
    if (!payload || payload.type !== "st:card_play") return;

    const { enabled } = getSettings();
    if (!enabled) {
      warn("Received st:card_play but extension disabled");
      return;
    }

    if (!payload.cardId || !payload.exportUrl) {
      warn("Invalid st:card_play payload", payload);
      return;
    }

    enqueue({
      cardId: String(payload.cardId),
      exportUrl: String(payload.exportUrl),
      filename: payload.filename ? String(payload.filename) : undefined,
      ts: payload.ts,
    });
  } catch (e) {
    warn("Failed to parse SSE event data", e);
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
    toastr?.info?.("SillyInnkeeper extension is disabled");
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
        toastr?.success?.(msg ?? "Connected");
      } else {
        toastr?.error?.(msg ?? "Failed to connect");
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
  window.__st_sillyInnkeeper = {
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

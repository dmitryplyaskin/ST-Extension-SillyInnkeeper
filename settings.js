import { saveSettingsDebounced } from "../../../../script.js";
import {
  extension_settings,
  renderExtensionTemplateAsync,
} from "../../../extensions.js";

const SETTINGS_KEY = "sillyInnkeeper";

const defaultSettings = {
  enabled: true,
  siBase: "http://127.0.0.1:48912",
  autoConnect: true,
  reportResult: true,
  openImported: false,
  dedupeWindowMs: 10_000,
  queueMax: 20,
};

let settingsUIInitialized = false;

function normalizeUrl(url) {
  const trimmed = String(url ?? "").trim();
  if (!trimmed) return defaultSettings.siBase;

  // remove trailing slash for consistent joining
  return trimmed.replace(/\/+$/, "");
}

function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function loadSettings() {
  if (!extension_settings[SETTINGS_KEY]) {
    extension_settings[SETTINGS_KEY] = { ...defaultSettings };
    saveSettingsDebounced();
  }

  let shouldSave = false;
  for (const key of Object.keys(defaultSettings)) {
    if (!(key in extension_settings[SETTINGS_KEY])) {
      extension_settings[SETTINGS_KEY][key] = defaultSettings[key];
      shouldSave = true;
    }
  }

  // Normalize URL on load
  const normalized = normalizeUrl(extension_settings[SETTINGS_KEY].siBase);
  if (extension_settings[SETTINGS_KEY].siBase !== normalized) {
    extension_settings[SETTINGS_KEY].siBase = normalized;
    shouldSave = true;
  }

  // Enforce scheme safety (fallback to default)
  if (!isHttpUrl(extension_settings[SETTINGS_KEY].siBase)) {
    extension_settings[SETTINGS_KEY].siBase = defaultSettings.siBase;
    shouldSave = true;
  }

  if (shouldSave) saveSettingsDebounced();

  // Reflect into UI if present
  $("#silly-innkeeper-enabled").prop(
    "checked",
    extension_settings[SETTINGS_KEY].enabled !== false
  );
  $("#silly-innkeeper-url").val(extension_settings[SETTINGS_KEY].siBase);
  $("#silly-innkeeper-autoconnect").prop(
    "checked",
    extension_settings[SETTINGS_KEY].autoConnect !== false
  );
  $("#silly-innkeeper-report-result").prop(
    "checked",
    extension_settings[SETTINGS_KEY].reportResult !== false
  );
  $("#silly-innkeeper-open-imported").prop(
    "checked",
    extension_settings[SETTINGS_KEY].openImported === true
  );
}

export function getSettings() {
  if (!extension_settings[SETTINGS_KEY]) loadSettings();

  const s = extension_settings[SETTINGS_KEY];
  return {
    enabled: s.enabled !== false,
    siBase: normalizeUrl(s.siBase),
    autoConnect: s.autoConnect !== false,
    reportResult: s.reportResult !== false,
    openImported: s.openImported === true,
    dedupeWindowMs: Number(s.dedupeWindowMs ?? defaultSettings.dedupeWindowMs),
    queueMax: Number(s.queueMax ?? defaultSettings.queueMax),
  };
}

export function setUiConnectionStatus({ connected, text } = {}) {
  const $el = $("#silly-innkeeper-connection-status");
  if (!$el.length) return;

  $el
    .removeClass("si-connected si-disconnected")
    .addClass(connected ? "si-connected" : "si-disconnected")
    .text(text ?? (connected ? "Connected" : "Disconnected"));
}

export function setUiLastResult({ ok, text } = {}) {
  const $el = $("#silly-innkeeper-last-result");
  if (!$el.length) return;

  const cls = ok === true ? "si-ok" : ok === false ? "si-err" : "";
  $el
    .removeClass("si-ok si-err")
    .addClass(cls)
    .text(text ?? "-");
}

export async function initSettingsUI() {
  if (settingsUIInitialized) return;
  if ($("#silly_innkeeper_settings").length) {
    settingsUIInitialized = true;
    loadSettings();
    return;
  }

  try {
    const settingsHtml = await renderExtensionTemplateAsync(
      "third-party/ST-Extension-SillyInnkeeper",
      "settings"
    );

    const $container = $(
      document.getElementById("extensions_settings") ??
        document.getElementById("extensions")
    );

    if (!$container.length) {
      console.warn("[SillyInnkeeper]: Settings container not found");
      return;
    }

    if ($("#silly_innkeeper_settings").length) {
      settingsUIInitialized = true;
      loadSettings();
      return;
    }

    $container.append(settingsHtml);
    settingsUIInitialized = true;

    loadSettings();

    // Settings bindings
    $(document)
      .off("change", "#silly-innkeeper-enabled")
      .on("change", "#silly-innkeeper-enabled", function () {
        extension_settings[SETTINGS_KEY].enabled = $(this).prop("checked");
        saveSettingsDebounced();
        window.__st_sillyInnkeeper?.onSettingsChanged?.();
      });

    $(document)
      .off("input", "#silly-innkeeper-url")
      .on("input", "#silly-innkeeper-url", function () {
        const value = normalizeUrl($(this).val());
        if (isHttpUrl(value)) {
          extension_settings[SETTINGS_KEY].siBase = value;
          saveSettingsDebounced();
          window.__st_sillyInnkeeper?.onSettingsChanged?.();
        }
      });

    $(document)
      .off("change", "#silly-innkeeper-autoconnect")
      .on("change", "#silly-innkeeper-autoconnect", function () {
        extension_settings[SETTINGS_KEY].autoConnect = $(this).prop("checked");
        saveSettingsDebounced();
        window.__st_sillyInnkeeper?.onSettingsChanged?.();
      });

    $(document)
      .off("change", "#silly-innkeeper-report-result")
      .on("change", "#silly-innkeeper-report-result", function () {
        extension_settings[SETTINGS_KEY].reportResult = $(this).prop("checked");
        saveSettingsDebounced();
      });

    $(document)
      .off("change", "#silly-innkeeper-open-imported")
      .on("change", "#silly-innkeeper-open-imported", function () {
        extension_settings[SETTINGS_KEY].openImported = $(this).prop("checked");
        saveSettingsDebounced();
      });

    // Controls
    $(document)
      .off("click", "#silly-innkeeper-connect")
      .on("click", "#silly-innkeeper-connect", async function () {
        await window.__st_sillyInnkeeper?.connect?.();
      });

    $(document)
      .off("click", "#silly-innkeeper-disconnect")
      .on("click", "#silly-innkeeper-disconnect", async function () {
        await window.__st_sillyInnkeeper?.disconnect?.();
      });

    $(document)
      .off("click", "#silly-innkeeper-test-connection")
      .on("click", "#silly-innkeeper-test-connection", async function () {
        await window.__st_sillyInnkeeper?.testConnection?.();
      });
  } catch (error) {
    console.error("[SillyInnkeeper]: Settings UI init error", error);
  }
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { identityUid } from "./identityUid";
import qrcode from "qrcode-generator";
import { useRegisterSW } from "virtual:pwa-register/react";
import "./App.css";
// After App.css: its :where() base variables have the same (zero) specificity.
import "./styles/ide.css";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Props for a modal dialog's backdrop. Dismisses on Escape or a genuine
 *  backdrop click (not a text-selection drag that starts inside the dialog
 *  and releases over the backdrop). Moves focus in on open unless an
 *  autoFocus field already took it, keeps Tab inside, and hands focus back to
 *  whatever had it before on close. */
function useBackdropDismiss(onDismiss: () => void) {
  const mouseDownOnBackdrop = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => previous?.focus?.();
  }, []);
  return {
    ref,
    role: "dialog",
    "aria-modal": true,
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onDismiss();
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => {
      mouseDownOnBackdrop.current = e.target === e.currentTarget;
    },
    onClick: (e: React.MouseEvent<HTMLDivElement>) => {
      if (mouseDownOnBackdrop.current && e.target === e.currentTarget) onDismiss();
    },
  };
}

/** Callback ref for a dropdown menu: focus its first item when it opens.
 *  Module-level so React calls it once per mount, not on every render. */
function focusFirstItem(el: HTMLElement | null) {
  el?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
}

/** onKeyDown for dropdown and context menus: Up/Down/Home/End move between
 *  items, and Escape puts focus back on the button that opened the menu
 *  before the window-level Escape listener closes it. */
function handleMenuKeyDown(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key === "Escape") {
    e.currentTarget.parentElement?.querySelector<HTMLElement>(":scope > button[aria-expanded]")?.focus();
    return;
  }
  // Arrows belong to sliders, text fields and selects (the volume slider).
  if ((e.target as HTMLElement).matches("input:not([type=checkbox]), select, textarea")) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === "ArrowDown" ? items[(i + 1) % items.length]
    : e.key === "ArrowUp" ? items[(i - 1 + items.length) % items.length]
    : e.key === "Home" ? items[0]
    : e.key === "End" ? items[items.length - 1]
    : undefined;
  if (!next) return;
  e.preventDefault();
  next.focus();
}

/** onKeyDown for the tree panel (server row + channel tree): Up/Down/Home/End
 *  walk the visible rows, Left goes to the parent row and Right into an open
 *  channel. A channel row handles Left/Right itself first when it can
 *  collapse or expand, and marks the event as handled. */
function handleTreeKeyDown(e: React.KeyboardEvent<HTMLElement>) {
  const row = e.target as HTMLElement;
  if (e.defaultPrevented || !row.classList.contains("ts-row")) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(".ts-row[tabindex]")];
  const i = rows.indexOf(row);
  const next =
    e.key === "ArrowDown" ? rows[i + 1]
    : e.key === "ArrowUp" ? rows[i - 1]
    : e.key === "Home" ? rows[0]
    : e.key === "End" ? rows[rows.length - 1]
    : e.key === "ArrowLeft" ? (row.closest("ul")?.closest("li")?.querySelector<HTMLElement>(":scope > .ts-row") ?? rows[0])
    : e.key === "ArrowRight" ? row.closest("li")?.querySelector<HTMLElement>(":scope > ul .ts-row")
    : undefined;
  if (next === undefined && !["ArrowDown", "ArrowUp", "ArrowRight"].includes(e.key)) return;
  e.preventDefault();
  next?.focus();
}
import {
  AudioPlayer,
  MicCapture,
  SAMPLE_RATE,
  encodeWavStereo,
  hasNativeOutputPicker,
  listAudioInputDevices,
  listAudioOutputDevices,
  pickAudioOutputDevice,
} from "./voice";
import { createAec3, type Aec3Instance } from "./aec3";
import { LanguageProvider, useLanguage, useT, type LangPref } from "./i18n";
import {
  StreamAccess,
  StreamMode,
  StreamPublisher,
  type PublishState,
  type StreamPublishOptions,
} from "./publish";
import { DEFAULT_ICE_SERVERS, StreamViewer, parseStreamInfo, type StreamEvent, type StreamInfo } from "./stream";
import { DEMO_HOST, DEMO_MODE, DemoSocket } from "./demoMode";
import {
  DEFAULT_SYNC_SERVER,
  SYNC_CATEGORIES,
  accountInfo,
  changeSyncPassword,
  createSyncAccount,
  deleteSyncAccount,
  formatAccountNumber,
  getSyncStatus,
  loadSyncAccount,
  loginSyncAccount,
  logoutSyncAccount,
  normalizeAccountNumber,
  normalizePassword,
  recoveryText,
  resolveConflict,
  setSyncCategories,
  subscribeSyncStatus,
  syncErrorKey,
  syncLink,
  syncNow,
  type SyncCategory,
} from "./sync";
import {
  SOUND_EVENTS,
  clearCustomSound,
  loadCustomSound,
  loadEventSoundEnabled,
  loadSoundsEnabled,
  loadSoundsVolume,
  playSound,
  setSoundStyle,
  saveCustomSound,
  saveEventSoundEnabled,
  saveSoundsEnabled,
  saveSoundsVolume,
  setSoundsOutputDevice,
  type SoundEventId,
} from "./sounds";
import { parseSoundpack } from "./soundpack";
import { checkMasterPassword, isVaultUnlocked, removeMasterPassword, setMasterPassword } from "./vault";
import {
  BUILTIN_PACK,
  NO_SOUNDS_PACK,
  NOTIFICATION_TREE,
  deleteSoundPack,
  getNotificationSettings,
  importSoundPack,
  isSpecialKey,
  loadSoundPacks,
  notificationTextPositions,
  notify,
  packScript,
  runSoundScript,
  saveNotificationSettings,
  setNotificationPlaybackMuted,
  setSessionSoundPack,
  textPositionChoices,
  type NotificationNode,
  type NotificationOverride,
  type NotificationSettings,
  type SoundPack,
} from "./notifications";
import {
  iconPackCss,
  loadIconPacks,
  loadSelectedIconPack,
  parseIconPack,
  saveIconPacks,
  saveSelectedIconPack,
  type IconPack,
} from "./iconpack";
import { StillImg, clearStillCache } from "./lib/still";
import {
  DEFAULT_DOWNLOAD_SETTINGS,
  canPickFolder,
  clearDownloadDir,
  loadDownloadDir,
  loadDownloadSettings,
  pickDownloadDir,
  resolveSaveTarget,
  saveDownloadSettings,
  writeToTarget,
  type DownloadSettings,
  type SaveTarget,
} from "./downloads";
import {
  DEFAULT_CHAT_SETTINGS,
  appendChatLog,
  capLines,
  loadChatSettings,
  readChatLog,
  saveChatSettings,
  type ChatSettings,
} from "./chatlog";
import {
  ConnectionTabs,
} from "./ConnectionTabs";
import { BARE_URL_REGEX, renderBbcode, wrapUrls } from "./lib/bbcode";
import { parseChannelName, spacerDisplayName } from "./lib/spacer";
import akimoPhoto from "./assets/akimo.jpg";
import {
  applyParkedGatewayEvent,
  emptyParkedState,
  sessionLabel,
  type ParkedSessionState,
  type SessionRecord,
  type SessionTabInfo,
} from "./connectionSessions";

// In dev, the gateway runs standalone on its own port. In production it's
// normally served from the same origin/port as the web app (single
// container behind a reverse proxy), so the WebSocket URL is derived from
// the current location by default. If the static frontend is hosted
// separately from the gateway (e.g. a static host for the landing/app
// bundle, with the gateway staying on your own server), set
// VITE_GATEWAY_URL at build time to the gateway's public wss:// address
// instead - the browser will still block a plain ws:// gateway from an
// https:// page (mixed content), so that address needs real TLS.
// Either way the gateway's WebSocketServer only listens on /ws (see
// gateway/src/index.ts), so that path always gets appended here - a
// VITE_GATEWAY_URL override only needs to name the host, not the path.
const GATEWAY_URL = import.meta.env.DEV
  ? "ws://localhost:8080/ws"
  : import.meta.env.VITE_GATEWAY_URL
    ? `${import.meta.env.VITE_GATEWAY_URL.replace(/\/$/, "")}/ws`
    : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;

// Same derivation as GATEWAY_URL above, but for a plain HTTP POST (the
// feedback form) instead of the WebSocket - see gateway/src/index.ts's
// /api/feedback handler. VITE_GATEWAY_URL names a WebSocket origin, so its
// scheme has to be mapped back to http(s) here: fetch() refuses anything
// else outright ("TypeError: unknown scheme"), so with VITE_GATEWAY_URL set
// the form could not submit at all.
const FEEDBACK_URL = import.meta.env.DEV
  ? "http://localhost:8080/api/feedback"
  : import.meta.env.VITE_GATEWAY_URL
    ? `${import.meta.env.VITE_GATEWAY_URL.replace(/\/$/, "").replace(/^ws(s?):\/\//, "http$1://")}/api/feedback`
    : `${window.location.protocol}//${window.location.host}/api/feedback`;

// News ticker: the instance's own gateway says whether it's on and adds its
// own messages (gateway/src/news.ts); the central feed is fetched directly,
// like the store. The demo has no gateway and only shows the central feed.
const NEWS_CONFIG_URL = DEMO_MODE ? null : FEEDBACK_URL.replace(/\/api\/feedback$/, "/api/news");
const NEWS_FEED_URL = import.meta.env.DEV
  ? "http://localhost:8080/api/store/news"
  : import.meta.env.VITE_NEWS_URL || "https://gateway.webspeak3.de/api/store/news";

// Unlike GATEWAY_URL/FEEDBACK_URL above, the design store is NOT per-instance:
// it's a single, centrally curated catalog run on the maintainer's own VPS
// (see gateway/src/store.ts), so every build - official and self-hosted
// Docker image alike - points at the same one by default, regardless of
// which TS3/TeaSpeak gateway that build otherwise talks to. A self-hoster who
// wants to run their own separate community store instead (their own
// gateway's STORE_ENABLED=1) can override with VITE_STORE_URL at build time.
// DEMO_MODE keeps the old same-origin derivation instead, which 404s on the
// static demo host - the public demo has no write access to the real store.
const STORE_URL = import.meta.env.DEV
  ? "http://localhost:8080/api/store/themes"
  : DEMO_MODE
    ? `${window.location.protocol}//${window.location.host}/api/store/themes`
    : import.meta.env.VITE_STORE_URL || "https://gateway.webspeak3.de/api/store/themes";

// Ko-fi page of the project (.github/FUNDING.yml). Unlike the feedback button
// below this is not limited to the maintainer's own instance: it ships in
// every build, the Docker image included. Self-hosters who would rather not
// carry someone else's donation link can build with VITE_DONATE_URL= (empty)
// to drop the button, or point it somewhere else.
const DONATE_URL = import.meta.env.VITE_DONATE_URL ?? "https://ko-fi.com/moepchi";

// This file's frontend is deployed as multiple Cloudflare Pages projects
// from the same repo/build (see mem:deployment) - only the maintainer's own
// production instance talks to a gateway they actually operate and read
// feedback from, so the "Feedback" menu entry only appears there. Every
// other deployment (self-hosted forks, and the public demo - which has no
// real gateway at all, see DEMO_MODE) simply never shows it. This is a UI
// nicety, not a security boundary: the gateway's own FEEDBACK_ENABLED
// opt-in (see gateway/src/index.ts) is what actually decides whether
// submissions are accepted at all.
const OWN_HOSTED_HOSTNAMES = new Set(["client.webspeak3.de"]);
const IS_OWN_HOSTED_INSTANCE = !DEMO_MODE && OWN_HOSTED_HOSTNAMES.has(window.location.hostname);

// Auto-connect from a share link (?connect=host[:port]&nickname=&channel=&token=,
// see GitHub issue #10). Parsed once at module load and immediately stripped
// from the URL via replaceState so a reload/refresh doesn't silently
// reconnect off a stale link sitting in the address bar or browser history.
const AUTO_CONNECT_FROM_URL = (() => {
  const params = new URLSearchParams(window.location.search);
  // The token may also sit in the fragment (#token=...), which - unlike the
  // query - never reaches server logs or Referer headers.
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const connectHost = params.get("connect");
  if (!connectHost) return null;
  const target = {
    host: connectHost,
    nickname: params.get("nickname") || undefined,
    defaultChannel: params.get("channel") || undefined,
    privilegeKey: hashParams.get("token") || params.get("token") || undefined,
  };
  for (const key of ["connect", "nickname", "channel", "token"]) params.delete(key);
  let hash = window.location.hash;
  if (hashParams.has("token")) {
    hashParams.delete("token");
    hash = hashParams.size ? `#${hashParams}` : "";
  }
  const rest = params.toString();
  window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : "") + hash);
  return target;
})();

// A self-hosted build can also bake in a default server so the page
// auto-connects with zero URL params at all - set via `docker compose build
// --build-arg DEFAULT_SERVER=...` (see Dockerfile/README) or plain
// VITE_DEFAULT_SERVER= at build time. The Docker image can set the same thing
// at runtime instead (DEFAULT_SERVER/DEFAULT_CHANNEL env vars, issue #12): the
// gateway passes them in as <meta> tags, which take precedence over the build
// values. AUTO_CONNECT_FROM_URL above always wins when a share link is present.
const runtimeConfig = (name: string) =>
  document.querySelector<HTMLMetaElement>(`meta[name="webspeak3-${name}"]`)?.content;
const DEFAULT_SERVER = runtimeConfig("default-server") || import.meta.env.VITE_DEFAULT_SERVER || null;
const DEFAULT_CHANNEL = runtimeConfig("default-channel") || import.meta.env.VITE_DEFAULT_CHANNEL || "";
// The gateway admin's ALLOWED_SERVERS (unless SERVER_PICKER=0): one server
// locks the address field to it, several turn it into a dropdown.
const SERVER_CHOICES = runtimeConfig("allowed-servers")?.split(",").filter(Boolean) ?? [];

// Terms of use, own-hosted instance only (see TODO.md #2/#7.1). Versioned so
// a rule change can re-surface the modal: bump TOS_VERSION and everyone who
// accepted an older version is asked again.
const TOS_VERSION = "v1";
const TOS_KEY = "webspeak3-tos-accepted";
function hasAcceptedToS(): boolean {
  return (localStorage.getItem(TOS_KEY) ?? "").startsWith(TOS_VERSION + ":");
}

// One-time migration from the pre-rename "ts-web-client:*" localStorage
// namespace so existing users don't lose their favorites/preferences.
(function migrateLegacyStorageKeys() {
  const oldPrefix = "ts-web-client:";
  const newPrefix = "webspeak3:";
  for (const oldKey of Object.keys(localStorage).filter((k) => k.startsWith(oldPrefix))) {
    const newKey = newPrefix + oldKey.slice(oldPrefix.length);
    if (localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, localStorage.getItem(oldKey)!);
    }
    localStorage.removeItem(oldKey);
  }
})();

const LAST_HOST_KEY = "webspeak3:last-host";
const LAST_NICKNAME_KEY = "webspeak3:last-nickname";
// Privilege keys are one-shot grants, so they're no longer remembered across
// reloads; drop what older versions stored in plain text.
localStorage.removeItem("webspeak3:last-privilege-key");
const LAST_SERVER_TYPE_KEY = "webspeak3:last-server-type";

type ServerType = "teamspeak" | "teaspeak" | "auto";

function loadServerType(): ServerType {
  const raw = localStorage.getItem(LAST_SERVER_TYPE_KEY);
  return raw === "teamspeak" || raw === "teaspeak" || raw === "auto" ? raw : "auto";
}

/** Everything needed to (re)open a gateway connection for one session, kept
 *  around per session id so a dropped socket — active tab or a parked
 *  background one — can be silently reconnected. */
type ConnectParams = {
  host: string;
  nickname: string;
  serverPassword: string;
  channelPassword: string;
  defaultChannel: string;
  privilegeKey: string;
  serverType: ServerType;
  identityId: string | null;
  favoriteId: string | null;
};
/** Identity persisted across sessions so the server sees the same client UID
 *  each time, instead of a fresh one being generated per connection. */
const IDENTITY_KEY = "webspeak3:identity";
const IDENTITIES_KEY = "webspeak3:identities";
const ACTIVE_IDENTITY_KEY = "webspeak3:active-identity";

interface Identity {
  id: string;
  name: string;
  /** Per-identity nickname/phonetic nickname, like the native client - selecting
   *  an identity in the connect dialog fills these in. Empty until first set. */
  nickname: string;
  phoneticName: string;
  /** Opaque tsclientlib identity blob - null until the first successful connect generates one. */
  blob: string | null;
}

// randomId() only exists in a secure context, so it is missing on a
// plain-http origin - which is exactly how a self-hosted instance is reached
// on a LAN before TLS is set up. It used to throw at module load and leave a
// blank page; these ids are local identifiers, not secrets, so fall back.
function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// One-time migration from the old single flat identity key to a list of named
// identities (so users can maintain more than one persona), and to seed a
// default entry for users who never had one either. Runs once at module load.
(function ensureIdentitiesSeeded() {
  if (localStorage.getItem(IDENTITIES_KEY) !== null) return;
  const legacyBlob = localStorage.getItem(IDENTITY_KEY);
  const legacyNickname = localStorage.getItem(LAST_NICKNAME_KEY) ?? "";
  const id = randomId();
  const identities: Identity[] = [
    { id, name: "Standard", nickname: legacyNickname, phoneticName: "", blob: legacyBlob },
  ];
  localStorage.setItem(IDENTITIES_KEY, JSON.stringify(identities));
  localStorage.setItem(ACTIVE_IDENTITY_KEY, id);
  localStorage.removeItem(IDENTITY_KEY);
})();

function loadIdentities(): Identity[] {
  try {
    const raw = localStorage.getItem(IDENTITIES_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Identity>[]) : [];
    if (parsed.length > 0) {
      // Backfill fields older saves (before per-identity nickname/phonetic
      // name existed) don't have.
      return parsed.map((i) => ({
        id: i.id ?? randomId(),
        name: i.name ?? "Standard",
        nickname: i.nickname ?? "",
        phoneticName: i.phoneticName ?? "",
        blob: i.blob ?? null,
      }));
    }
  } catch {
    // fall through
  }
  return [{ id: randomId(), name: "Standard", nickname: "", phoneticName: "", blob: null }];
}

const FAVORITES_KEY = "webspeak3:favorites";
const INPUT_DEVICE_KEY = "webspeak3:input-device";
const PLAYBACK_VOLUME_KEY = "webspeak3:playback-volume";
const NOISE_SUPPRESSION_KEY = "webspeak3:noise-suppression";
const ECHO_CANCELLATION_KEY = "webspeak3:echo-cancellation";
const AUTO_GAIN_CONTROL_KEY = "webspeak3:auto-gain-control";
const AUTO_VOLUME_KEY = "webspeak3:auto-volume";
const OWN_MIC_CLICKS_KEY = "webspeak3:own-mic-clicks";
const OTHER_MIC_CLICKS_KEY = "webspeak3:other-mic-clicks";
const AEC3_ENABLED_KEY = "webspeak3:aec3-enabled";
const VAD_HANGOVER_KEY = "webspeak3:vad-hangover";
const PUSH_TO_TALK_KEY = "webspeak3:push-to-talk";
const CONTINUOUS_KEY = "webspeak3:continuous-transmission";
const TYPING_ATTENUATION_KEY = "webspeak3:typing-attenuation";
const PTT_BINDING_KEY = "webspeak3:ptt-key";
const DESIGN_THEME_KEY = "webspeak3:design-theme";
// The user's actual pick - "standard" | "nova" | "pulse" | "ide" | "custom:<id>".
// DESIGN_THEME_KEY above keeps tracking just the resolved structural base, since a
// couple of early call sites (e.g. the host-field default below) need that cheaply,
// before customThemes is loaded.
const DESIGN_SELECTION_KEY = "webspeak3:design-selection";
const CUSTOM_THEMES_KEY = "webspeak3:custom-themes";

type DesignTheme = "standard" | "nova" | "pulse" | "ide";

/** A user-authored theme package: a name, which built-in layout it behaves like
 *  (Standard's plain chrome, Nova's collapsed menu/splash, Pulse's card/sidebar
 *  layout or IDE), and raw CSS that gets injected while it's
 *  active - free-form, so it can restyle or even reflow the existing markup
 *  (e.g. via flex `order`, `display:none`, overlays). */
type CustomTheme = {
  id: string;
  name: string;
  baseTheme: DesignTheme;
  css: string;
};

/** Metadata for one theme listed by GET /api/store/themes - deliberately
 *  without `css`, so browsing the store doesn't pull every submission's full
 *  stylesheet up front. The full package (matching CustomTheme's export
 *  shape) is fetched separately per-id on install, see STORE_URL above. */
type StoreThemeSummary = {
  id: string;
  name: string;
  baseTheme: DesignTheme;
  author: string;
  description: string;
  hasScreenshot: boolean;
  rating: { average: number; count: number };
  createdAt: string;
};

// The operator's own admin token for publishing under a reserved author name
// (see STORE_RESERVED_AUTHORS in gateway/src/index.ts) - kept in localStorage
// so it only has to be entered once per browser, same idea as the last-used
// connection fields above.
const STORE_ADMIN_TOKEN_KEY = "webspeak3:store-admin-token";

// Mirrors the gateway's STORE_SCREENSHOT_MAX_DATA_URL_LENGTH - checked client-side
// too so a rejected upload doesn't cost a round trip.
const STORE_SCREENSHOT_MAX_DATA_URL_LENGTH = 400_000;

function isDesignTheme(value: string): value is DesignTheme {
  return (
    value === "standard" || value === "nova" || value === "pulse" || value === "ide"
  );
}

function loadDesignTheme(): DesignTheme {
  const raw = localStorage.getItem(DESIGN_THEME_KEY);
  if (raw && isDesignTheme(raw)) return raw;
  return "standard";
}

function resolveDesignThemeBase(selection: string, customThemes: CustomTheme[]): DesignTheme {
  if (selection.startsWith("custom:")) {
    // A removed base (e.g. the old GreenTeaSpeak theme) falls back to Standard.
    const base = customThemes.find((th) => `custom:${th.id}` === selection)?.baseTheme;
    return base && isDesignTheme(base) ? base : "standard";
  }
  return isDesignTheme(selection) ? selection : "standard";
}

function designThemeClassName(theme: DesignTheme): string {
  if (theme === "nova") return " ts-design-nova";
  if (theme === "pulse") return " ts-design-pulse";
  if (theme === "ide") return " ts-design-ide";
  return "";
}

function designThemeLabel(theme: DesignTheme, t: (key: string) => string): string {
  if (theme === "nova") return t("design.theme.nova");
  if (theme === "pulse") return t("design.theme.pulse");
  if (theme === "ide") return t("design.theme.ide");
  return t("design.theme.standard");
}

function loadCustomThemes(): CustomTheme[] {
  try {
    const raw = localStorage.getItem(CUSTOM_THEMES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is CustomTheme =>
        v &&
        typeof v.id === "string" &&
        typeof v.name === "string" &&
        isDesignTheme(v.baseTheme) &&
        typeof v.css === "string"
    );
  } catch {
    return [];
  }
}

function saveCustomThemes(list: CustomTheme[]) {
  localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(list));
}

function loadDesignSelection(): string {
  const raw = localStorage.getItem(DESIGN_SELECTION_KEY);
  // A removed builtin (e.g. "greenteaspeak") falls back to Standard.
  return raw && (raw.startsWith("custom:") || isDesignTheme(raw)) ? raw : loadDesignTheme();
}

function loadBoolPref(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key);
  return raw === null ? fallback : raw === "1";
}

interface PttBinding {
  code: string;
  label: string;
}

function loadPttBinding(): PttBinding | null {
  try {
    const v = JSON.parse(localStorage.getItem(PTT_BINDING_KEY) ?? "null");
    return v && typeof v.code === "string" && typeof v.label === "string" ? v : null;
  } catch {
    return null;
  }
}

function keyBindingLabel(e: KeyboardEvent): string {
  return e.key.length === 1 && e.key !== " " ? e.key.toUpperCase() : e.code;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

function loadNumberPref(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

interface Favorite {
  id: string;
  bookmarkName: string;
  nickname: string;
  host: string;
  serverPassword: string;
  defaultChannel: string;
  defaultChannelPassword: string;
  /** When true, ServerQuery clients appear in the channel tree. Default: false. */
  showServerQueryClients: boolean;
  /** Overrides Options -> Meldungen's sound pack for this server; unset = that one. */
  soundPack?: string;
}

function normalizeFavorite(raw: Partial<Favorite> & Pick<Favorite, "id">): Favorite {
  return {
    id: raw.id,
    bookmarkName: typeof raw.bookmarkName === "string" ? raw.bookmarkName : "",
    nickname: typeof raw.nickname === "string" ? raw.nickname : "",
    host: typeof raw.host === "string" ? raw.host : "",
    serverPassword: typeof raw.serverPassword === "string" ? raw.serverPassword : "",
    defaultChannel: typeof raw.defaultChannel === "string" ? raw.defaultChannel : "",
    defaultChannelPassword:
      typeof raw.defaultChannelPassword === "string" ? raw.defaultChannelPassword : "",
    showServerQueryClients: raw.showServerQueryClients === true,
    ...(typeof raw.soundPack === "string" && raw.soundPack ? { soundPack: raw.soundPack } : {}),
  };
}

function loadFavorites(): Favorite[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is Partial<Favorite> & Pick<Favorite, "id"> => v && typeof v.id === "string")
      .map(normalizeFavorite);
  } catch {
    return [];
  }
}

// Only Chromium hands out tab/system audio via getDisplayMedia; Firefox and
// Safari return video only, so the button would just say "no audio" there.
// userAgentData itself only exists in Chromium-based browsers.
// Switched off for now (2026-10-03): clicks in the mix, and Edge delivers
// Windows system audio as silence. Code stays; flip back once that's solved.
const TAB_AUDIO_SUPPORTED =
  false &&
  typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
  !!(navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands.some(
    (b) => b.brand === "Chromium"
  );
const AWAY_PRESETS_KEY = "webspeak3:away-presets";
/** "off" hides the server banner: it loads from whatever host the server
 *  admin picked, which then sees the viewer's IP (review S12). */
const SERVER_BANNER_KEY = "webspeak3:server-banner";
const IDE_PIXEL_FONT_KEY = "webspeak3:ide-pixel-font";
// Off by default: an inline chat image loads from whatever host the sender picked.
const CHAT_IMAGES_KEY = "webspeak3:chat-images";
const WHISPER_SETTINGS_KEY = "webspeak3:whisper-settings";

/** Options -> Whispern (TS3's "Whispereinstellungen"). */
interface WhisperSettings {
  /** allow/block: what applies to contacts without their own whisper setting. */
  mode: "allow" | "block" | "blockAll";
  sound: boolean;
  openHistory: boolean;
  /** Incoming entries leave the whisper history after this many minutes; 0 = never. */
  clearAfterMin: number;
}

const DEFAULT_WHISPER_SETTINGS: WhisperSettings = { mode: "allow", sound: true, openHistory: true, clearAfterMin: 5 };

function loadWhisperSettings(): WhisperSettings {
  try {
    return { ...DEFAULT_WHISPER_SETTINGS, ...JSON.parse(localStorage.getItem(WHISPER_SETTINGS_KEY) ?? "{}") };
  } catch {
    return DEFAULT_WHISPER_SETTINGS;
  }
}

const APP_SETTINGS_KEY = "webspeak3:app-settings";

/** Options -> Anwendung. Read on use, so the socket handlers need no refs. */
interface AppSettings {
  micOnServerSwitch: boolean;
  reconnectAfterSleep: boolean;
  middleClickQuickAccess: boolean;
  updateFavoriteNickname: boolean;
  autoOpenChannelChat: boolean;
  mutedTalkingSound: boolean;
  neverShowPokeDialog: boolean;
}

const DEFAULT_APP_SETTINGS: AppSettings = {
  micOnServerSwitch: true,
  reconnectAfterSleep: true,
  middleClickQuickAccess: true,
  updateFavoriteNickname: false,
  autoOpenChannelChat: false,
  mutedTalkingSound: false,
  neverShowPokeDialog: false,
};

function loadAppSettings(): AppSettings {
  try {
    return { ...DEFAULT_APP_SETTINGS, ...JSON.parse(localStorage.getItem(APP_SETTINGS_KEY) ?? "{}") };
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

const SECURITY_SETTINGS_KEY = "webspeak3:security-settings";
const CHANNEL_PASSWORDS_KEY = "webspeak3:channel-passwords";

/** Options -> Sicherheit. */
interface SecuritySettings {
  saveChannelPasswords: boolean;
  clearCacheOnExit: boolean;
  clearUrlsOnExit: boolean;
}

const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  saveChannelPasswords: false,
  clearCacheOnExit: false,
  clearUrlsOnExit: false,
};

function loadSecuritySettings(): SecuritySettings {
  try {
    return { ...DEFAULT_SECURITY_SETTINGS, ...JSON.parse(localStorage.getItem(SECURITY_SETTINGS_KEY) ?? "{}") };
  } catch {
    return DEFAULT_SECURITY_SETTINGS;
  }
}

/** Saved channel passwords: server host -> channel id -> password. */
function loadChannelPasswords(): Record<string, Record<string, string>> {
  try {
    return JSON.parse(localStorage.getItem(CHANNEL_PASSWORDS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function storedChannelPassword(host: string, channelId: number): string | undefined {
  return loadChannelPasswords()[host.trim().toLowerCase()]?.[channelId];
}

/** null removes the entry. */
function storeChannelPassword(host: string, channelId: number, password: string | null): void {
  const all = loadChannelPasswords();
  const key = host.trim().toLowerCase();
  const server = { ...all[key] };
  if (password === null) delete server[channelId];
  else server[channelId] = password;
  all[key] = server;
  localStorage.setItem(CHANNEL_PASSWORDS_KEY, JSON.stringify(all));
}

/** The service worker's CacheStorage; the app shell comes from the network until the worker refills it. */
async function clearBrowserCaches(): Promise<void> {
  try {
    await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
  } catch {
    // No CacheStorage (insecure context): nothing to clear.
  }
}

const TREE_OPTIONS_KEY = "webspeak3:tree-options";

/** Design tab -> "Channel Baum" and "GIF Animation" (TS3's options). */
interface TreeOptions {
  expandMode: "all" | "own";
  /** Channel levels to expand with expandMode "all"; 0 = every level. */
  expandDepth: number;
  clientsBelow: boolean;
  flags: boolean;
  groupIconsInMenus: boolean;
  commanderLamp: boolean;
  awayMessage: boolean;
  tooltips: boolean;
  animateAvatars: boolean;
  animateImages: boolean;
}

const DEFAULT_TREE_OPTIONS: TreeOptions = {
  expandMode: "all",
  expandDepth: 0,
  clientsBelow: false,
  flags: true,
  groupIconsInMenus: true,
  commanderLamp: false,
  awayMessage: true,
  tooltips: true,
  animateAvatars: true,
  animateImages: true,
};

function loadTreeOptions(): TreeOptions {
  try {
    return { ...DEFAULT_TREE_OPTIONS, ...JSON.parse(localStorage.getItem(TREE_OPTIONS_KEY) ?? "{}") };
  } catch {
    return DEFAULT_TREE_OPTIONS;
  }
}

/** Display prefs read deep in the tree; a context spares threading them through every level. */
const DisplayPrefsContext = createContext<{
  tree: TreeOptions;
  setTree: (next: TreeOptions) => void;
  iconPacks: IconPack[];
  iconPackId: string;
  setIconPackId: (id: string) => void;
  saveIconPacks: (packs: IconPack[]) => void;
  whisper: WhisperSettings;
  setWhisper: (next: WhisperSettings) => void;
  downloads: DownloadSettings;
  setDownloads: (next: DownloadSettings) => void;
  downloadDir: FileSystemDirectoryHandle | null;
  setDownloadDir: (dir: FileSystemDirectoryHandle | null) => void;
  chat: ChatSettings;
  setChat: (next: ChatSettings) => void;
  security: SecuritySettings;
  setSecurity: (next: SecuritySettings) => void;
}>({
  tree: DEFAULT_TREE_OPTIONS,
  setTree: () => {},
  iconPacks: [],
  iconPackId: "",
  setIconPackId: () => {},
  saveIconPacks: () => {},
  whisper: DEFAULT_WHISPER_SETTINGS,
  setWhisper: () => {},
  downloads: DEFAULT_DOWNLOAD_SETTINGS,
  setDownloads: () => {},
  downloadDir: null,
  setDownloadDir: () => {},
  chat: DEFAULT_CHAT_SETTINGS,
  setChat: () => {},
  security: DEFAULT_SECURITY_SETTINGS,
  setSecurity: () => {},
});
const DISCONNECT_MESSAGE_KEY = "webspeak3:disconnect-message";
const COLLECTED_URLS_KEY = "webspeak3:collected-urls";

interface CollectedUrl {
  url: string;
  count: number;
  lastSeen: number;
  lastSender: string;
}

function loadCollectedUrls(): CollectedUrl[] {
  try {
    const raw = localStorage.getItem(COLLECTED_URLS_KEY);
    return raw ? (JSON.parse(raw) as CollectedUrl[]) : [];
  } catch {
    return [];
  }
}

type LogLevel = "critical" | "error" | "warning" | "info" | "debug";

interface ClientLogEntry {
  id: number;
  timestamp: number;
  category: string;
  level: LogLevel;
  message: string;
}

const LOG_LEVELS: LogLevel[] = ["critical", "error", "warning", "info", "debug"];
const MAX_LOG_ENTRIES = 500;

interface WhisperLogEntry {
  id: number;
  timestamp: number;
  description: string;
  /** Someone whispered to us (as opposed to our own whisper target changes). */
  incoming?: boolean;
}

interface BanListEntry {
  banId: number;
  ip: string;
  name: string;
  uid: string;
  lastNickname: string;
  created: string;
  durationSecs: number;
  invokerName: string;
  reason: string;
  enforcements: number;
}

interface ComplainListEntry {
  targetClientDbId: number;
  targetName: string;
  fromClientDbId: number;
  fromName: string;
  message: string;
  timestamp: string;
}

interface OfflineMessageListEntry {
  messageId: number;
  clientUid: string;
  subject: string;
  timestamp: string;
  isRead: boolean;
}

type ContactCategory = "acquaintance" | "blocked" | "friend";

interface Contact {
  uid: string;
  customName: string;
  category: ContactCategory;
  phoneticName: string;
  ignored: boolean;
  /** Incoming whispers from this contact; unset follows Options -> Whispern. */
  whisper?: "allow" | "block";
}

const CONTACTS_KEY = "webspeak3:contacts";
// Per-speaker playback volume by client UID (1 = unchanged), mixed in the
// connector. Keyed by UID so it follows a person across servers and reconnects.
const CLIENT_VOLUMES_KEY = "webspeak3:client-volumes";

function loadClientVolumes(): Record<string, number> {
  try {
    const raw = localStorage.getItem(CLIENT_VOLUMES_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function loadContacts(): Contact[] {
  try {
    const raw = localStorage.getItem(CONTACTS_KEY);
    return raw ? (JSON.parse(raw) as Contact[]) : [];
  } catch {
    return [];
  }
}

interface MessagePreset {
  name: string;
  message: string;
}

/** A saved whisper target selection. Channels/clients are matched by name when
 *  activated (rather than by id), since ids are only stable for the current
 *  connection - the same names are what a user would recognize across sessions. */
interface WhisperList {
  id: string;
  name: string;
  channelNames: string[];
  clientNames: string[];
}

const WHISPER_LISTS_KEY = "webspeak3:whisper-lists";

function loadWhisperLists(): WhisperList[] {
  try {
    const raw = localStorage.getItem(WHISPER_LISTS_KEY);
    return raw ? (JSON.parse(raw) as WhisperList[]) : [];
  } catch {
    return [];
  }
}

function loadAwayPresets(): MessagePreset[] {
  try {
    const raw = localStorage.getItem(AWAY_PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Older versions stored presets as plain strings (name == message) - migrate on read.
    return parsed.map((p) => (typeof p === "string" ? { name: p, message: p } : (p as MessagePreset)));
  } catch {
    return [];
  }
}

function saveAwayPresets(presets: MessagePreset[]): void {
  localStorage.setItem(AWAY_PRESETS_KEY, JSON.stringify(presets));
}

function loadDisconnectMessage(): string {
  return localStorage.getItem(DISCONNECT_MESSAGE_KEY) ?? "";
}

function saveDisconnectMessage(message: string): void {
  localStorage.setItem(DISCONNECT_MESSAGE_KEY, message);
}

type LogEntry = { text: string; kind: "info" | "error" };

interface ChannelInfo {
  id: number;
  parent: number;
  order: number;
  name: string;
  topic: string;
  codec: string;
  maxClients: number | null;
  hasPassword: boolean;
}

type SelectedItem =
  | { type: "server" }
  | { type: "channel"; id: number }
  | { type: "client"; id: number };

interface ClientInfo {
  id: number;
  channel: number;
  name: string;
  inputMuted: boolean;
  outputMuted: boolean;
  inputHardwareEnabled: boolean;
  away: boolean;
  awayMessage: string;
  isChannelCommander: boolean;
  country: string;
  uid: string;
  databaseId: number;
  channelGroup: number;
  serverGroups: number[];
  hasTalkPower: boolean;
  /** TS6 Stream/Call broadcast running; absent on servers that don't report it. */
  isStreaming?: boolean;
  /** ServerQuery client; filtered from the tree unless a favorite enables them. */
  isQuery?: boolean;
  /** MD5 of the avatar, empty without one; missing from gateways before v0.15. */
  avatarHash?: string;
}

interface GroupEntry {
  id: number;
  name: string;
  iconId: number;
}

interface PermissionOverviewEntry {
  name: string;
  description: string;
  value: number;
  negated: boolean;
  skip: boolean;
}

interface FileListEntry {
  path: string;
  name: string;
  size: number;
  isFile: boolean;
  timestamp: string;
}

interface PermissionCatalogEntry {
  id: number;
  name: string;
  description: string;
}

type PermScope = "server" | "channelgroup" | "channel" | "client" | "channelclient";

interface ClientConnectionInfoData {
  clientId: number;
  pingMs: number | null;
  connectedSecs: number | null;
  ip: string | null;
  packetsSent: number;
  bytesSent: number;
  packetsReceived: number;
  bytesReceived: number;
  packetLossPercent: number;
}

interface ServerConnectionInfoData {
  pingMs: number;
  connectedSecs: number;
  packetLossPercent: number;
  packetsSentTotal: number;
  bytesSentTotal: number;
  packetsReceivedTotal: number;
  bytesReceivedTotal: number;
  bandwidthSentLastSecond: number;
  bandwidthReceivedLastSecond: number;
  bandwidthSentLastMinute: number;
  bandwidthReceivedLastMinute: number;
  filetransferBandwidthSent: number;
  filetransferBandwidthReceived: number;
  filetransferBytesSent: number;
  filetransferBytesReceived: number;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/** Compact counts like GreenTeaSpeak (`772.92 k`) — avoids DE locale `772.920`. */
function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)} k`;
  return value.toFixed(value % 1 === 0 ? 0 : 2);
}

function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/** Turns a base64-encoded file (as delivered by the "fileDownloadData" event)
 *  into an actual browser download, without ever round-tripping through the
 *  gateway's HTTP surface - it's all-in-memory via a Blob + object URL. */
function triggerBrowserDownload(filename: string, base64Data: string): void {
  downloadBlob(base64Blob(base64Data), filename);
}

function base64Blob(base64Data: string): Blob {
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes]);
}

/** One entry of the file transfer window (Options -> Download queue/limits). */
interface Transfer {
  id: number;
  dir: "up" | "down";
  cid: number;
  path: string;
  name: string;
  size: number;
  done: number;
  status: "queued" | "running" | "done" | "error";
  /** Downloads: picked at click time. */
  target?: SaveTarget;
  /** Uploads. */
  file?: File;
}

function FileTransfersWindow({
  transfers,
  onClearFinished,
  onClose,
}: {
  transfers: Transfer[];
  onClearFinished: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div className="ts-dialog ts-transfers-window" role="dialog" aria-label={t("transfers.title")}>
      <div className="ts-dialog-titlebar">
        <span>{t("transfers.title")}</span>
        <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
          ✕
        </button>
      </div>
      <div className="ts-dialog-body">
        {transfers.length === 0 ? (
          <p className="ts-options-placeholder">{t("transfers.empty")}</p>
        ) : (
          <table className="ts-transfers-table">
            <tbody>
              {transfers.map((x) => (
                <tr key={x.id} className={`ts-transfer-${x.status}`}>
                  <td title={t(`transfers.${x.dir}`)}>{x.dir === "down" ? "⬇" : "⬆"}</td>
                  <td className="ts-transfers-name" title={x.path}>
                    {x.name}
                  </td>
                  <td>
                    <progress value={x.done} max={x.size || 1} />
                  </td>
                  <td>
                    {formatBytes(x.done)} / {formatBytes(x.size)}
                  </td>
                  <td>{t(`transfers.status.${x.status}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="ts-dialog-buttons">
        <div className="ts-dialog-buttons-right">
          <button onClick={onClearFinished}>{t("transfers.clearFinished")}</button>
        </div>
      </div>
    </div>
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking right after click() can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function formatDurationSecs(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Converts an ISO 3166-1 alpha-2 country code (e.g. "DE") to its flag emoji
 *  via Unicode regional indicator symbols. Returns null for codes the server
 *  doesn't report (empty string - common when geo-IP isn't configured). */
function countryFlag(code: string): string | null {
  if (!/^[A-Za-z]{2}$/.test(code)) return null;
  const codePoints = [...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65);
  return String.fromCodePoint(...codePoints);
}

function ChannelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" data-pack-icon="channel">
      <path
        d="M1.5 3.5c0-.55.45-1 1-1h3.4l1.2 1.4h6.4c.55 0 1 .45 1 1v7.1c0 .55-.45 1-1 1h-11c-.55 0-1-.45-1-1v-8.5Z"
        fill="#e8c46a"
        stroke="#b8923f"
        strokeWidth="0.6"
      />
    </svg>
  );
}

/** GTS2-style talk lamp: blue idle / green talking / muted mic. */
function TalkLamp({
  talking,
  inputMuted,
  inputHardwareEnabled,
  commander = false,
}: {
  talking: boolean;
  inputMuted: boolean;
  inputHardwareEnabled: boolean;
  /** Channel commander: drawn as its own lamp when the design option asks for it. */
  commander?: boolean;
}) {
  const t = useT();
  const { tree } = useContext(DisplayPrefsContext);
  const muted = inputMuted || !inputHardwareEnabled;
  const asCommander = commander && tree.commanderLamp;

  if (muted) {
    return (
      <span
        className="ts-talk-lamp ts-talk-lamp-muted"
        title={t("tree.micMuted")}
        aria-hidden="true"
        data-pack-icon={inputMuted ? "micMuted" : "hardwareMicMuted"}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" focusable="false">
          <path
            d="M7 1.4c-1.15 0-2.05.9-2.05 2.05v3.1c0 1.15.9 2.05 2.05 2.05s2.05-.9 2.05-2.05v-3.1C9.05 2.3 8.15 1.4 7 1.4Z"
            fill="#9aa3ad"
          />
          <path
            d="M3.2 6.4v.4c0 2 1.7 3.55 3.8 3.55s3.8-1.55 3.8-3.55v-.4"
            fill="none"
            stroke="#8a939c"
            strokeWidth="1.15"
            strokeLinecap="round"
          />
          <path d="M7 10.35v2" stroke="#8a939c" strokeWidth="1.15" strokeLinecap="round" />
          <path d="M5.2 12.35h3.6" stroke="#8a939c" strokeWidth="1.15" strokeLinecap="round" />
          <circle cx="10.35" cy="10.35" r="2.55" fill="#e53935" stroke="#1a1a1a" strokeWidth="0.55" />
          <path
            d="M9.35 9.35l2 2M11.35 9.35l-2 2"
            stroke="#fff"
            strokeWidth="1.1"
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  }

  if (talking) {
    return (
      <span
        className={`ts-talk-lamp ts-talk-lamp-talking${asCommander ? " ts-talk-lamp-commander" : ""}`}
        title={t("tree.talking")}
        aria-hidden="true"
        data-pack-icon={asCommander ? "commanderTalking" : "talking"}
      />
    );
  }

  return (
    <span
      className={`ts-talk-lamp ts-talk-lamp-idle${asCommander ? " ts-talk-lamp-commander" : ""}`}
      aria-hidden="true"
      data-pack-icon={asCommander ? "commanderIdle" : "talkIdle"}
    />
  );
}

function ClientStatusIcons({ client }: { client: ClientInfo }) {
  const t = useT();
  const { tree } = useContext(DisplayPrefsContext);
  // Mute is shown on the TalkLamp; keep secondary flags here.
  return (
    <span className="ts-status-icons">
      {client.isChannelCommander && !tree.commanderLamp && <span title={t("tree.channelCommander")}>⭐</span>}
      {client.away && <span title={t("tree.away")} data-pack-icon="away">💤</span>}
      {!client.inputMuted && client.inputHardwareEnabled && !client.hasTalkPower && (
        <span title={t("tree.noTalkPower")}>🔒</span>
      )}
      {client.outputMuted && <span title={t("tree.soundMuted")} data-pack-icon="soundMuted">🔕</span>}
      {client.isStreaming && <span title={t("tree.streaming")}>📺</span>}
    </span>
  );
}

function ServerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" data-pack-icon="server">
      <rect x="1.5" y="2" width="13" height="4.2" rx="0.6" fill="#7a8a99" stroke="#5c6b78" strokeWidth="0.5" />
      <rect x="1.5" y="7" width="13" height="4.2" rx="0.6" fill="#8a9aab" stroke="#5c6b78" strokeWidth="0.5" />
      <circle cx="3.5" cy="4.1" r="0.6" fill="#4caf50" />
      <circle cx="3.5" cy="9.1" r="0.6" fill="#4caf50" />
    </svg>
  );
}

/** A group's uploaded icon, or a colored letter badge for TS's built-in icons we don't have. */
function GroupIcon({ group, images }: { group: GroupEntry; images: Record<string, string> }) {
  const base64 = group.iconId >= CUSTOM_ICON_ID_THRESHOLD ? images[`/icon_${group.iconId}`] : undefined;
  if (base64) return <img className="ts-group-icon" src={iconDataUrl(base64)} alt="" title={group.name} />;
  return (
    <span className="ts-group-badge" style={{ background: groupBadgeColor(group.iconId) }} title={group.name}>
      {group.name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/** Survives ChannelTree remounts when Select's setState rebuilds the tree.
 *  Keyed per session (multi-join tab) so a click in one tab's tree can never
 *  be paired with a click in another tab's tree as a false double-click. */
const lastChannelClickBySession = new Map<string, { id: number; at: number }>();
let switchArmedUntil = 0;

const CLIENT_DRAG_MIME = "application/x-webspeak3-client";

type ClientDragPayload = { clientId: number; channelId: number };

function parseClientDragPayload(raw: string): ClientDragPayload | null {
  try {
    const data = JSON.parse(raw) as Partial<ClientDragPayload>;
    if (
      typeof data.clientId === "number" &&
      Number.isFinite(data.clientId) &&
      typeof data.channelId === "number" &&
      Number.isFinite(data.channelId)
    ) {
      return { clientId: data.clientId, channelId: data.channelId };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function ChannelTree({
  channels,
  clients,
  parent,
  ownClientId,
  talkers,
  serverGroups,
  groupIconImages,
  selected,
  sessionKey,
  expandAll,
  level = 1,
  onSelectItem,
  onSwitchChannel,
  onOpenPrivateChat,
  onMoveClient,
  onClientContextMenu,
  onChannelContextMenu,
}: {
  channels: ChannelInfo[];
  clients: ClientInfo[];
  parent: number;
  ownClientId: number | null;
  talkers: Set<number>;
  serverGroups: GroupEntry[] | null;
  groupIconImages: Record<string, string>;
  selected: SelectedItem | null;
  /** Identifies which multi-join tab this tree belongs to, so the manual
   *  double-click detection below can't pair clicks across two tabs. */
  sessionKey: string;
  /** While searching: show every match, ignoring channels the user collapsed. */
  expandAll?: boolean;
  /** aria-level of this list's channels; their clients sit one deeper. */
  level?: number;
  onSelectItem: (item: SelectedItem) => void;
  onSwitchChannel: (channelId: number) => void;
  onOpenPrivateChat: (clientId: number, clientName: string) => void;
  onMoveClient: (clientId: number, channelId: number) => void;
  onClientContextMenu: (e: React.MouseEvent, clientId: number, clientName: string, isSelf: boolean) => void;
  onChannelContextMenu: (e: React.MouseEvent, channelId: number, channelName: string) => void;
}) {
  const t = useT();
  const { tree } = useContext(DisplayPrefsContext);
  // Channels the user expanded/collapsed against the design tab's default.
  const [toggled, setToggled] = useState<Set<number>>(() => new Set());
  const [dragOverChannelId, setDragOverChannelId] = useState<number | null>(null);
  // Module-level click tracking (see lastChannelClick) — refs alone are not
  // enough when Select re-renders remount nested ChannelTree instances.
  const children = channels.filter((c) => c.parent === parent).sort((a, b) => a.order - b.order);
  if (children.length === 0) return null;

  const clientGroupBadges = (client: ClientInfo): GroupEntry[] =>
    serverGroups
      ? client.serverGroups
          .map((gid) => serverGroups.find((g) => g.id === gid))
          .filter((g): g is GroupEntry => !!g && g.iconId !== 0)
      : [];

  // "Own channel" mode keeps the own channel and the channels above it open.
  const ownPath = new Set<number>();
  if (tree.expandMode === "own") {
    let id = clients.find((c) => c.id === ownClientId)?.channel;
    while (id && !ownPath.has(id)) {
      ownPath.add(id);
      id = channels.find((c) => c.id === id)?.parent;
    }
  }
  const collapsedByDefault = (channelId: number) =>
    tree.expandMode === "own" ? !ownPath.has(channelId) : tree.expandDepth > 0 && level > tree.expandDepth;

  // "Tooltip Info bei Hover": a plain-text client info card in the native title tooltip.
  const clientTooltip = (c: ClientInfo) => {
    const groupNames = serverGroups
      ? c.serverGroups.map((gid) => serverGroups.find((g) => g.id === gid)?.name).filter(Boolean)
      : [];
    return [
      c.name,
      groupNames.length > 0 && `${t("info.serverGroups")} ${groupNames.join(", ")}`,
      c.country && `${t("info.country")} ${c.country}`,
      c.away && (c.awayMessage ? `${t("tree.away")}: ${c.awayMessage}` : t("tree.away")),
      (c.inputMuted || !c.inputHardwareEnabled) && t("tree.micMuted"),
      c.outputMuted && t("tree.soundMuted"),
      c.id !== ownClientId && `${t("tree.privateChatWith")} ${c.name}`,
    ]
      .filter(Boolean)
      .join("\n");
  };

  const toggleCollapsed = (channelId: number, event: React.SyntheticEvent) => {
    event.stopPropagation();
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  };

  return (
    <ul
      className={`ts-tree-list${parent === 0 ? " ts-tree-list-root" : ""}`}
      role={parent === 0 ? "tree" : "group"}
      aria-label={parent === 0 ? t("tree.label") : undefined}
    >
      {children.map((channel, index) => {
        const isRoot = parent === 0;
        const spacer = spacerDisplayName(channel.name, isRoot);
        const channelClients = clients.filter((c) => c.channel === channel.id);
        const hasSubChannels = channels.some((c) => c.parent === channel.id);
        const hasChildren = channelClients.length > 0 || hasSubChannels;
        const isCollapsed = !expandAll && collapsedByDefault(channel.id) !== toggled.has(channel.id);
        const isSelected = selected?.type === "channel" && selected.id === channel.id;
        // One Tab stop for the whole tree (arrow keys move inside it, see
        // handleTreeKeyDown): the selected row, or the first channel while
        // nothing in the tree is selected.
        const isTabStop = isSelected || (parent === 0 && index === 0 && selected?.type !== "channel" && selected?.type !== "client");
        const spacerClass = spacer.isSpacer
          ? ` ts-spacer ts-spacer-align-${spacer.alignment}${spacer.isLine ? " ts-spacer-line" : ""}${
              spacer.isBoxArt ? " ts-spacer-boxart" : ""
            }`
          : "";
        const subTree = !isCollapsed && (
          <ChannelTree
            channels={channels}
            clients={clients}
            parent={channel.id}
            ownClientId={ownClientId}
            talkers={talkers}
            serverGroups={serverGroups}
            groupIconImages={groupIconImages}
            selected={selected}
            sessionKey={sessionKey}
            expandAll={expandAll}
            level={level + 1}
            onSelectItem={onSelectItem}
            onSwitchChannel={onSwitchChannel}
            onOpenPrivateChat={onOpenPrivateChat}
            onMoveClient={onMoveClient}
            onClientContextMenu={onClientContextMenu}
            onChannelContextMenu={onChannelContextMenu}
          />
        );
        return (
        <li key={channel.id} role="none">
          <div
            className={`ts-row ts-channel-row${spacerClass}${
              isSelected ? " ts-row-selected" : ""
            }${dragOverChannelId === channel.id ? " ts-drop-target" : ""}`}
            role="treeitem"
            aria-level={level}
            aria-selected={isSelected}
            aria-expanded={hasChildren ? !isCollapsed : undefined}
            onClick={() => {
              onSelectItem({ type: "channel", id: channel.id });
              // Manual double-click: native dblclick is often lost when the first
              // click's Select setState remounts this row before the second click.
              // Spacers are joinable (TS/GTS): visual-only difference.
              const now = performance.now();
              const prev = lastChannelClickBySession.get(sessionKey) ?? null;
              if (prev && prev.id === channel.id && now - prev.at < 450) {
                lastChannelClickBySession.delete(sessionKey);
                switchArmedUntil = now + 50;
                onSwitchChannel(channel.id);
              } else {
                lastChannelClickBySession.set(sessionKey, { id: channel.id, at: now });
              }
            }}
            onDoubleClick={() => {
              if (performance.now() < switchArmedUntil) return;
              onSwitchChannel(channel.id);
            }}
            onContextMenu={(e) => onChannelContextMenu(e, channel.id, channel.name)}
            onAuxClick={(e) => {
              if (e.button === 1 && loadAppSettings().middleClickQuickAccess) onSwitchChannel(channel.id);
            }}
            tabIndex={isTabStop ? 0 : -1}
            onFocus={(e) => {
              if (e.target === e.currentTarget && !isSelected) onSelectItem({ type: "channel", id: channel.id });
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter") onSwitchChannel(channel.id);
              else if (e.key === " ") onSelectItem({ type: "channel", id: channel.id });
              else if (hasChildren && (e.key === "ArrowLeft" || e.key === "ArrowRight") && isCollapsed === (e.key === "ArrowRight"))
                toggleCollapsed(channel.id, e);
              else return;
              e.preventDefault();
            }}
            onDragOver={(e) => {
              if (![...e.dataTransfer.types].includes(CLIENT_DRAG_MIME)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dragOverChannelId !== channel.id) setDragOverChannelId(channel.id);
            }}
            onDragLeave={(e) => {
              const related = e.relatedTarget as Node | null;
              if (related && e.currentTarget.contains(related)) return;
              setDragOverChannelId((prev) => (prev === channel.id ? null : prev));
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverChannelId(null);
              const payload = parseClientDragPayload(e.dataTransfer.getData(CLIENT_DRAG_MIME));
              if (!payload || payload.channelId === channel.id) return;
              onMoveClient(payload.clientId, channel.id);
            }}
            title={tree.tooltips ? t("tree.clickToJoin") : undefined}
          >
            {!spacer.isSpacer && (
              <button
                type="button"
                className={`ts-tree-expander${hasChildren ? "" : " ts-tree-expander-empty"}${
                  isCollapsed ? " ts-tree-expander-collapsed" : ""
                }`}
                aria-hidden="true"
                tabIndex={-1}
                onMouseDown={(e) => {
                  // Keep focus on the row so a nearby double-click still joins.
                  e.preventDefault();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!hasChildren) return;
                  toggleCollapsed(channel.id, e);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <span />
              </button>
            )}
            {!spacer.isSpacer && <ChannelIcon />}
            {spacer.isSpacer ? (
              spacer.isLine ? (
                <span className="ts-spacer-label ts-spacer-line-rule" aria-hidden="true" />
              ) : (
                <span className="ts-spacer-label">{spacer.label}</span>
              )
            ) : (
              <span className="ts-tree-label">{channel.name}</span>
            )}
            {!spacer.isSpacer && channel.hasPassword && (
              <span title={t("tree.passwordProtected")}>🔒</span>
            )}
          </div>
          {tree.clientsBelow && subTree}
          {!isCollapsed && (
            <ul className="ts-tree-list" role="group">
              {channelClients.map((c) => {
                const clientSelected = selected?.type === "client" && selected.id === c.id;
                return (
                <li key={c.id} role="none">
                  <div
                    className={`ts-row ts-client-row${c.id === ownClientId ? " ts-self" : ""}${
                      talkers.has(c.id) &&
                      c.hasTalkPower &&
                      !c.inputMuted &&
                      c.inputHardwareEnabled
                        ? " ts-talking"
                        : ""
                    }${clientSelected ? " ts-row-selected" : ""}`}
                    role="treeitem"
                    aria-level={level + 1}
                    aria-selected={clientSelected}
                    draggable
                    onDragStart={(e) => {
                      const payload: ClientDragPayload = {
                        clientId: c.id,
                        channelId: c.channel,
                      };
                      const raw = JSON.stringify(payload);
                      e.dataTransfer.setData(CLIENT_DRAG_MIME, raw);
                      e.dataTransfer.setData("text/plain", raw);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => setDragOverChannelId(null)}
                    onClick={() => onSelectItem({ type: "client", id: c.id })}
                    onDoubleClick={
                      c.id === ownClientId ? undefined : () => onOpenPrivateChat(c.id, c.name)
                    }
                    onContextMenu={(e) => onClientContextMenu(e, c.id, c.name, c.id === ownClientId)}
                    onAuxClick={(e) => {
                      if (e.button === 1 && c.id !== ownClientId && loadAppSettings().middleClickQuickAccess)
                        onOpenPrivateChat(c.id, c.name);
                    }}
                    tabIndex={clientSelected ? 0 : -1}
                    onFocus={(e) => {
                      if (e.target === e.currentTarget && !clientSelected) onSelectItem({ type: "client", id: c.id });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && c.id !== ownClientId) onOpenPrivateChat(c.id, c.name);
                      else if (e.key === " ") onSelectItem({ type: "client", id: c.id });
                      else return;
                      e.preventDefault();
                    }}
                    title={tree.tooltips ? clientTooltip(c) : undefined}
                  >
                    <span className="ts-tree-expander ts-tree-expander-empty" aria-hidden="true">
                      <span />
                    </span>
                    <TalkLamp
                      talking={
                        talkers.has(c.id) &&
                        c.hasTalkPower &&
                        !c.inputMuted &&
                        c.inputHardwareEnabled
                      }
                      inputMuted={c.inputMuted}
                      inputHardwareEnabled={c.inputHardwareEnabled}
                      commander={c.isChannelCommander}
                    />
                    <span className="ts-client-status-leading">
                      <ClientStatusIcons client={c} />
                    </span>
                    <AvatarTile
                      client={c}
                      images={groupIconImages}
                      className="ts-client-avatar"
                      isSelf={c.id === ownClientId}
                    />
                    {tree.flags && countryFlag(c.country) && <span title={c.country}>{countryFlag(c.country)}</span>}
                    <span className="ts-tree-label">{c.name}</span>
                    {tree.awayMessage && c.away && c.awayMessage && (
                      <span className="ts-client-away-message">({c.awayMessage})</span>
                    )}
                    <span className="ts-client-icons">
                      {clientGroupBadges(c).map((g) => (
                        <GroupIcon key={g.id} group={g} images={groupIconImages} />
                      ))}
                    </span>
                  </div>
                </li>
                );
              })}
            </ul>
          )}
          {!tree.clientsBelow && subTree}
        </li>
        );
      })}
    </ul>
  );
}

/** Pulse-theme-only: a row of avatar tiles for everyone in the player's current
 *  channel, with a highlighted ring on whoever is currently talking - the
 *  "who's speaking" strip from the reference client's connected view. Purely
 *  derived from state ChannelTree already has (own channel + `talkers`), no
 *  new backend data needed. */
function SpeakingNowBar({
  clients,
  talkers,
  ownClientId,
  images,
  serverGroups,
  selectedClientId,
  onSelect,
  onOpenPrivateChat,
  onContextMenu,
}: {
  clients: ClientInfo[];
  talkers: Set<number>;
  ownClientId: number | null;
  images: Record<string, string>;
  /** IDE layout only: render group tags and a mic status next to the name. */
  serverGroups?: GroupEntry[] | null;
  selectedClientId: number | null;
  onSelect: (clientId: number) => void;
  onOpenPrivateChat: (clientId: number, clientName: string) => void;
  onContextMenu: (e: React.MouseEvent, clientId: number, clientName: string, isSelf: boolean) => void;
}) {
  const t = useT();
  const own = clients.find((c) => c.id === ownClientId);
  if (!own) return null;
  const channelClients = clients.filter((c) => c.channel === own.channel);
  if (channelClients.length === 0) return null;

  return (
    <div className="ts-speaking-now">
      {channelClients.map((c) => (
        <div
          key={c.id}
          className={`ts-speaking-now-tile${talkers.has(c.id) ? " ts-speaking-now-tile-active" : ""}${
            c.id === selectedClientId ? " ts-speaking-now-tile-selected" : ""
          }`}
          title={c.name}
          onClick={() => onSelect(c.id)}
          onDoubleClick={c.id === ownClientId ? undefined : () => onOpenPrivateChat(c.id, c.name)}
          onContextMenu={(e) => onContextMenu(e, c.id, c.name, c.id === ownClientId)}
        >
          <AvatarTile client={c} images={images} className="ts-speaking-now-avatar" isSelf={c.id === ownClientId} />
          {serverGroups === undefined ? (
            <span className="ts-speaking-now-name">{c.name}</span>
          ) : (
            <div className="ts-speaking-now-body">
              <div className="ts-speaking-now-head">
                <span className="ts-speaking-now-name">{c.name}</span>
                {talkers.has(c.id) ? (
                  <span className="ts-speaking-now-bars" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                ) : (
                  (c.inputMuted || !c.inputHardwareEnabled) && (
                    <TalkLamp talking={false} inputMuted={c.inputMuted} inputHardwareEnabled={c.inputHardwareEnabled} />
                  )
                )}
              </div>
              <div className="ts-speaking-now-groups">
                {c.serverGroups
                  .map((gid) => serverGroups?.find((g) => g.id === gid))
                  .filter((g): g is GroupEntry => !!g)
                  .map((g) => (
                    <span
                      key={g.id}
                      className="ts-speaking-now-group"
                      style={{ "--group-color": g.iconId ? groupBadgeColor(g.iconId) : "#71717a" } as React.CSSProperties}
                    >
                      {g.name}
                    </span>
                  ))}
              </div>
              {(c.away || c.outputMuted) && (
                <div className="ts-speaking-now-status">
                  {c.away ? `${t("tree.away")}${c.awayMessage ? `: ${c.awayMessage}` : ""}` : t("tree.soundMuted")}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function InfoPanel({
  selected,
  host,
  serverName,
  serverMaxClients,
  serverVersion,
  serverLicense,
  serverLicenseId,
  totalClientCount,
  totalChannelCount,
  channels,
  clients,
  serverGroups,
  images,
  onShowServerConnectionInfo,
  onEditServer,
}: {
  selected: SelectedItem | null;
  host: string;
  serverName: string;
  serverMaxClients: number;
  serverVersion: string;
  serverLicense: string;
  serverLicenseId: number;
  totalClientCount: number;
  totalChannelCount: number;
  channels: ChannelInfo[];
  clients: ClientInfo[];
  serverGroups: GroupEntry[] | null;
  images: Record<string, string>;
  onShowServerConnectionInfo: () => void;
  onEditServer: () => void;
}) {
  const t = useT();
  if (!selected || selected.type === "server") {
    return (
      <div className="ts-info-panel">
        <div className="ts-info-title">
          <ServerIcon />
          <span>{serverName || host}</span>
        </div>
        <div className="ts-info-row">
          <span>{t("info.address")}</span> <span>{host}</span>
        </div>
        {serverVersion && (
          <div className="ts-info-row">
            <span>{t("info.version")}</span> <span>{serverVersion}</span>
          </div>
        )}
        {serverLicense && (
          <div className="ts-info-row">
            <span>{t("info.license")}</span>{" "}
            <span className={`ts-license-label ts-license-${serverLicenseId}`}>{serverLicense}</span>
          </div>
        )}
        <div className="ts-info-row">
          <span>{t("info.currentClients")}</span>{" "}
          <span>
            {totalClientCount} / {serverMaxClients > 0 ? serverMaxClients : "∞"}
          </span>
        </div>
        <div className="ts-info-row">
          <span>{t("info.currentChannels")}</span> <span>{totalChannelCount}</span>
        </div>
        <button className="ts-info-connection-link" onClick={onShowServerConnectionInfo}>
          🔌 {t("connectionInfo.serverTitle")}
        </button>
        <button className="ts-info-connection-link" onClick={onEditServer}>
          ✏️ {t("serverEdit.title")}
        </button>
      </div>
    );
  }

  if (selected.type === "client") {
    const client = clients.find((c) => c.id === selected.id);
    if (!client) return <div className="ts-info-panel" />;
    const groups = serverGroups
      ? client.serverGroups
          .map((gid) => serverGroups.find((g) => g.id === gid)?.name)
          .filter((n): n is string => !!n)
      : [];
    return (
      <div className="ts-info-panel">
        <div className="ts-info-title">
          <TalkLamp
            talking={false}
            inputMuted={client.inputMuted}
            inputHardwareEnabled={client.inputHardwareEnabled}
          />
          <span>{client.name}</span>
        </div>
        {clientAvatarUrl(client, images) && (
          <img className="ts-info-avatar" src={clientAvatarUrl(client, images)!} alt="" />
        )}
        {client.country && (
          <div className="ts-info-row">
            <span>{t("info.country")}</span>{" "}
            <span>
              {countryFlag(client.country) ? `${countryFlag(client.country)} ` : ""}
              {client.country}
            </span>
          </div>
        )}
        <div className="ts-info-row">
          <span>{t("info.muted")}</span>{" "}
          <span>
            {client.inputMuted || !client.inputHardwareEnabled
              ? t("info.yes")
              : t("info.no")}
          </span>
        </div>
        <div className="ts-info-row">
          <span>{t("info.outputMuted")}</span>{" "}
          <span>{client.outputMuted ? t("info.yes") : t("info.no")}</span>
        </div>
        {groups.length > 0 && (
          <div className="ts-info-row">
            <span>{t("info.serverGroups")}</span> <span>{groups.join(", ")}</span>
          </div>
        )}
      </div>
    );
  }

  const channel = channels.find((c) => c.id === selected.id);
  if (!channel) return <div className="ts-info-panel" />;
  const clientCount = clients.filter((c) => c.channel === channel.id).length;
  const parsed = parseChannelName(channel.name, channel.parent === 0);
  const isSpacer = parsed.alignment !== null;

  return (
    <div className="ts-info-panel">
      <div className="ts-info-title">
        {!isSpacer && <ChannelIcon />}
        <span>{isSpacer ? parsed.name || channel.name : channel.name}</span>
      </div>
      {isSpacer && (
        <div className="ts-info-row">
          <span>{t("info.spacer")}</span> <span>{parsed.alignment}</span>
        </div>
      )}
      {isSpacer && (
        <div className="ts-info-row">
          <span>{t("info.rawName")}</span> <span>{channel.name}</span>
        </div>
      )}
      {channel.topic && (
        <div className="ts-info-row">
          <span>{t("info.topic")}</span> <span>{channel.topic}</span>
        </div>
      )}
      <div className="ts-info-row">
        <span>{t("info.audioCodec")}</span> <span>{channel.codec}</span>
      </div>
      <div className="ts-info-row">
        <span>{t("info.passwordProtected")}</span> <span>{channel.hasPassword ? t("info.yes") : t("info.no")}</span>
      </div>
      <div className="ts-info-row">
        <span>{t("info.clients")}</span> <span>{clientCount} / {channel.maxClients ?? "∞"}</span>
      </div>
    </div>
  );
}

/** Gateway serverLog kind -> Options -> Meldungen key. The server doesn't say who did it, so "by other". */
const SERVER_LOG_NOTIFICATIONS = {
  clientJoin: "CLIENT_CONNECTION_CONNECTED_SERVER",
  clientLeave: "CLIENT_CONNECTION_DISCONNECTED_SERVER",
  clientChannelSwitch: "CLIENT_SWITCHED_TO_OTHER_CHANNEL_STAYS",
  clientChannelGroupAssigned: "CLIENT_CHANNELGROUP_CHANGED_BY_USER",
  channelCreated: "CHANNEL_CREATED_BY_OTHER",
  channelDeleted: "CHANNEL_DELETED_BY_OTHER",
  channelEdited: "CHANNEL_EDITED_OTHER_BY_OTHER",
  serverEdited: "SERVER_EDITED_BY_OTHER",
  permissionError: "SERVER_INSUFFICIENT_PERMISSIONS",
} as const;

interface ChatEntry {
  from: string;
  message: string;
  /** Set for server-log notifications (join/leave/switch/etc.) so they render
   *  without a "from:" prefix, like the native client's server tab. */
  isLog?: boolean;
  /** Restored from the chat log (Options -> Chat), shown dimmed. */
  fromLog?: boolean;
}

interface PmMessage {
  fromSelf: boolean;
  message: string;
  fromLog?: boolean;
  /** Notification text (Options -> Meldungen -> Text Position "Client"). */
  isLog?: boolean;
}

interface PmThread {
  partnerId: number;
  partnerName: string;
  messages: PmMessage[];
  unread: boolean;
}

type ActiveTab = "channel" | "server" | number;

/** Private chat logs are keyed by the partner's identity, falling back to the nickname. */
function pmLogKind(uid: string | undefined, name: string): string {
  return `pm:${uid || name}`;
}

function loggedPmMessages(server: string, kind: string, lines: number): PmMessage[] {
  return readChatLog(server, kind, lines).map((l) => ({ fromSelf: !!l.self, message: l.message, fromLog: true }));
}

interface PokeNotice {
  id: number;
  from: string;
  message: string;
}

function ConnectDialog({
  host,
  nickname,
  serverPassword,
  channelPassword,
  defaultChannel,
  privilegeKey,
  serverType,
  expanded,
  connecting,
  identities,
  activeIdentityId,
  onHostChange,
  onNicknameChange,
  onServerPasswordChange,
  onChannelPasswordChange,
  onDefaultChannelChange,
  onPrivilegeKeyChange,
  onServerTypeChange,
  onActiveIdentityChange,
  onToggleExpanded,
  onConnect,
  onConnectNewTab,
  onCancel,
  nova,
  onOpenOptions,
  canOpenNewTab,
}: {
  host: string;
  nickname: string;
  serverPassword: string;
  channelPassword: string;
  defaultChannel: string;
  privilegeKey: string;
  serverType: ServerType;
  expanded: boolean;
  connecting: boolean;
  identities: Identity[];
  activeIdentityId: string | null;
  onHostChange: (v: string) => void;
  onNicknameChange: (v: string) => void;
  onServerPasswordChange: (v: string) => void;
  onChannelPasswordChange: (v: string) => void;
  onDefaultChannelChange: (v: string) => void;
  onPrivilegeKeyChange: (v: string) => void;
  onServerTypeChange: (v: ServerType) => void;
  onActiveIdentityChange: (id: string) => void;
  onToggleExpanded: () => void;
  /** Connect always opens a new session tab (GTS multi-join). */
  onConnect: () => void;
  onConnectNewTab: () => void;
  onCancel: () => void;
  /** Nova-theme-only: renders the TS6-redesign "connect hero" (logo, title,
   *  subtitle, settings shortcut) around the same form instead of the
   *  Standard theme's plain titled dialog box. */
  nova: boolean;
  onOpenOptions: () => void;
  canOpenNewTab: boolean;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onCancel);

  // Nova-theme-only: the "Erweiterte Optionen" toggle moves from the footer
  // (Standard) to right under the nickname field, with a rotating chevron -
  // matching the TS6 redesign's Connect screen instead of a plain button.
  const expandToggle = nova ? (
    <button className="ts-connect-nova-expand" onClick={onToggleExpanded}>
      <svg
        className={`ts-connect-nova-chevron${expanded ? " ts-connect-nova-chevron-open" : ""}`}
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 6l6 6-6 6" />
      </svg>
      {expanded ? t("connect.less") : t("connect.more")}
    </button>
  ) : (
    <button onClick={onToggleExpanded}>{expanded ? t("connect.less") : t("connect.more")}</button>
  );

  const dialogBody = (
    <div className="ts-dialog ts-connect-dialog" onClick={(e) => e.stopPropagation()}>
      {nova ? (
        <button className="ts-connect-nova-settings" onClick={onOpenOptions} title={t("menu.extras.options")}>
          ⚙️
        </button>
      ) : (
        <div className="ts-dialog-titlebar">
          <span>{t("connect.title")}</span>
          <button onClick={onCancel} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
      )}
      <div className="ts-dialog-body">
        <div className="ts-dialog-row">
          <label className="ts-dialog-field ts-dialog-field-grow">
            {t("connect.serverAddress")}
            {SERVER_CHOICES.length > 1 ? (
              <select autoFocus value={host} onChange={(e) => onHostChange(e.target.value)}>
                {SERVER_CHOICES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            ) : (
              <input
                autoFocus
                value={host}
                disabled={SERVER_CHOICES.length === 1}
                onChange={(e) => onHostChange(e.target.value)}
              />
            )}
          </label>
          <label className="ts-dialog-field">
            {t("connect.serverPassword")}
            <input
              type="password"
              value={serverPassword}
              onChange={(e) => onServerPasswordChange(e.target.value)}
            />
          </label>
        </div>
        <label className="ts-dialog-field">
          {t("connect.nickname")}
          <input value={nickname} onChange={(e) => onNicknameChange(e.target.value)} />
        </label>

        {nova && expandToggle}

        {expanded && (
            <div className="ts-dialog-grid">
              <label className="ts-dialog-field">
                {t("connect.phoneticNickname")}
                <input disabled title={t("clientContext.notSupported")} />
              </label>
              <label className="ts-dialog-field">
                {t("connect.identity")}
                <select value={activeIdentityId ?? ""} onChange={(e) => onActiveIdentityChange(e.target.value)}>
                  {identities.map((identity) => (
                    <option key={identity.id} value={identity.id}>
                      {identity.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ts-dialog-field">
                {t("connect.defaultChannel")}
                <input value={defaultChannel} onChange={(e) => onDefaultChannelChange(e.target.value)} />
              </label>
              <label className="ts-dialog-field">
                {t("connect.recordingProfile")}
                <select disabled defaultValue="Standard">
                  <option>Standard</option>
                </select>
              </label>
              <label className="ts-dialog-field">
                {t("connect.channelPassword")}
                <input
                  type="password"
                  value={channelPassword}
                  onChange={(e) => onChannelPasswordChange(e.target.value)}
                />
              </label>
              <label className="ts-dialog-field">
                {t("connect.playbackProfile")}
                <select disabled defaultValue="Standard">
                  <option>Standard</option>
                </select>
              </label>
              <label className="ts-dialog-field">
                {t("connect.onetimeGrant")}
                <input
                  type="password"
                  value={privilegeKey}
                  onChange={(e) => onPrivilegeKeyChange(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <label className="ts-dialog-field">
                {t("connect.serverType")}
                <select
                  value={serverType}
                  onChange={(e) => onServerTypeChange(e.target.value as ServerType)}
                >
                  <option value="auto">{t("connect.serverType.auto")}</option>
                  <option value="teamspeak">{t("connect.serverType.teamspeak")}</option>
                  <option value="teaspeak">{t("connect.serverType.teaspeak")}</option>
                </select>
              </label>
              <label className="ts-dialog-field">
                {t("connect.hotkeyProfile")}
                <select disabled defaultValue="Standard">
                  <option>Standard</option>
                </select>
              </label>
              <label className="ts-dialog-field">
                {t("connect.soundPack")}
                <select disabled defaultValue="Standard">
                  <option>Standard</option>
                </select>
              </label>
            </div>
          )}
        </div>
        <div className={nova ? "ts-connect-nova-buttons" : "ts-dialog-buttons"}>
          {!nova && expandToggle}
          <div className={nova ? undefined : "ts-dialog-buttons-right"}>
            {nova && (
              <button className="ts-connect-cancel" onClick={onCancel}>
                {t("connect.cancel")}
              </button>
            )}
            {!nova && (
              <button onClick={onConnect} disabled={connecting || !host || !nickname}>
                {connecting ? t("connect.connecting") : t("connect.connect")}
              </button>
            )}
            <button
              className={nova ? "ts-connect-cancel" : undefined}
              onClick={onConnectNewTab}
              disabled={connecting || !host || !nickname || !canOpenNewTab}
              title={canOpenNewTab ? undefined : t("connect.newTab")}
            >
              {t("connect.newTab")}
            </button>
            {nova ? (
              <button
                className="ts-connect-nova-primary"
                onClick={onConnect}
                disabled={connecting || !host || !nickname}
              >
                {connecting ? t("connect.connecting") : t("connect.connect")}
              </button>
            ) : (
              <button onClick={onCancel}>{t("connect.cancel")}</button>
            )}
          </div>
        </div>
      </div>
  );

  if (!nova)
    return (
      <div className="ts-dialog-backdrop" {...backdrop}>
        {dialogBody}
      </div>
    );

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-connect-nova-wrap">
        <div className="ts-connect-nova-hero">
          <span className="ts-connect-nova-logo">W</span>
          <div className="ts-connect-nova-heading">
            <div className="ts-connect-nova-title">{t("connect.title")}</div>
            <div className="ts-connect-nova-subtitle">{t("connect.novaSubtitle")}</div>
          </div>
        </div>
        {dialogBody}
      </div>
    </div>
  );
}

// Shown when the gateway broadcasts a "notice" event (currently: a SIGTERM
// restart warning). Deliberately no backdrop-click-to-close - the point is
// the user actually reads it before the connection drops, not that it's
// invisible-easy to swipe away like a cookie banner.
// In memory of Akimo, the project owner's dog (†21.10.2026). Permanent:
// never remove or hide this, no matter what else changes in the dialog.
function AboutDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <div className="ts-dialog-backdrop" onClick={onClose}>
      <div className="ts-dialog ts-about-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("menu.help.about")}</span>
        </div>
        <div className="ts-dialog-body">
          <p>{t("about.text")}</p>
          <p>
            <a href="https://webspeak3.de" target="_blank" rel="noreferrer">webspeak3.de</a>
            {" · "}
            <a href="https://github.com/WebSpeak3/webspeak3" target="_blank" rel="noreferrer">GitHub</a>
          </p>
          <figure className="ts-about-memorial">
            <img src={akimoPhoto} alt="Akimo" width={120} height={120} />
            <figcaption>
              <strong>{t("about.memorial.title")}</strong>
              <span>{t("about.memorial.text")}</span>
            </figcaption>
          </figure>
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button type="button" onClick={onClose}>
              {t("about.close")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RestartNoticeDialog({ message, onAck }: { message: string; onAck: () => void }) {
  const t = useT();
  return (
    <div className="ts-dialog-backdrop">
      <div className="ts-dialog ts-restart-notice-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("restartNotice.title")}</span>
        </div>
        <div className="ts-dialog-body">
          <p>{message}</p>
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button type="button" onClick={onAck}>
              {t("restartNotice.ack")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Mandatory (first visit, own-hosted instance): backdrop-click does nothing,
// only "Accept" closes it. Reopened from the menu afterwards: an ordinary
// dismissable dialog, since acceptance already happened.
function ToSDialog({ mandatory, onAccept, onClose }: { mandatory: boolean; onAccept: () => void; onClose: () => void }) {
  const t = useT();
  return (
    <div className="ts-dialog-backdrop" onClick={mandatory ? undefined : onClose}>
      <div className="ts-dialog ts-tos-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("tos.title")}</span>
        </div>
        <div className="ts-dialog-body">
          <ol className="ts-tos-rules">
            <li>{t("tos.rule1")}</li>
            <li>{t("tos.rule2")}</li>
            <li>{t("tos.rule3")}</li>
            <li>
              {t("tos.rule4Pre")}
              <a href="https://webspeak3.de/datenschutz.html" target="_blank" rel="noreferrer">
                {t("tos.privacyLinkText")}
              </a>
              {t("tos.rule4Post")}
            </li>
            <li>
              {t("tos.rule5Pre")}
              <a href="https://webspeak3.de/impressum.html" target="_blank" rel="noreferrer">
                {t("tos.legalLinkText")}
              </a>
              {t("tos.rule5Post")}
            </li>
            <li>{t("tos.rule6")}</li>
          </ol>
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            {mandatory ? (
              <button type="button" onClick={onAccept}>
                {t("tos.accept")}
              </button>
            ) : (
              <button type="button" onClick={onClose}>
                {t("tos.close")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ChannelPasswordDialog({
  channelName,
  wrongPassword,
  onSubmit,
  onCancel,
}: {
  channelName: string;
  wrongPassword: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [password, setPassword] = useState("");
  const backdrop = { onClick: onCancel };
  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-channel-password-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("channelPasswordDialog.title")}</span>
        </div>
        <div className="ts-dialog-body">
          <p>
            {wrongPassword ? t("channelPasswordDialog.wrongPassword") : t("channelPasswordDialog.prompt")}
            {channelName ? ` (${channelName})` : ""}
          </p>
          <label className="ts-dialog-field ts-dialog-field-grow">
            <input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSubmit(password);
                if (e.key === "Escape") onCancel();
              }}
            />
          </label>
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button type="button" onClick={onCancel}>
              {t("channelPasswordDialog.cancel")}
            </button>
            <button type="button" onClick={() => onSubmit(password)}>
              {t("channelPasswordDialog.submit")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Presets from TS6's own stream dialog. Each one fills in the advanced
 * fields; "source" keeps the capture's native resolution and "presentation"
 * trades frame rate for sharp text, which is what the encoder's content hint
 * is for.
 */
const STREAM_PRESETS: Record<
  string,
  { height: number; fps: number; videoBitrateKbps: number; contentHint: "motion" | "detail" }
> = {
  "360": { height: 360, fps: 30, videoBitrateKbps: 1000, contentHint: "motion" },
  "480": { height: 480, fps: 30, videoBitrateKbps: 1500, contentHint: "motion" },
  "720": { height: 720, fps: 30, videoBitrateKbps: 2500, contentHint: "motion" },
  "1080": { height: 1080, fps: 30, videoBitrateKbps: 4000, contentHint: "motion" },
  "1440": { height: 1440, fps: 30, videoBitrateKbps: 6000, contentHint: "motion" },
  source: { height: 0, fps: 60, videoBitrateKbps: 8000, contentHint: "motion" },
  presentation: { height: 0, fps: 5, videoBitrateKbps: 3000, contentHint: "detail" },
};

const RESOLUTION_CHOICES = [360, 480, 720, 1080, 1440, 0];
const FPS_CHOICES = [5, 30, 60];
const AUDIO_BITRATE_CHOICES = [64, 96, 128, 192, 256, 320];

// Streaming talks to TS6 over a protocol nobody published, so it is marked
// alpha everywhere the user can reach it: the settings dialog, both stream
// panels, and the toolbar button's tooltip.
function AlphaBadge() {
  const t = useT();
  return (
    <span className="ts-alpha-badge" title={t("publish.alphaTitle")}>
      {t("publish.alpha")}
    </span>
  );
}

function SegmentedChoice<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { value: T; label: string; title?: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="ts-segmented">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          className={option.value === value ? "ts-segmented-on" : ""}
          disabled={disabled || option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function StreamSettingsDialog({
  defaultName,
  onStart,
  onCancel,
}: {
  defaultName: string;
  onStart: (options: StreamPublishOptions) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onCancel);
  const [preset, setPreset] = useState<string | null>("720");
  const [audio, setAudio] = useState(true);
  const [accessibility, setAccessibility] = useState<number>(StreamAccess.PUBLIC);
  const [advanced, setAdvanced] = useState(false);
  const [height, setHeight] = useState(STREAM_PRESETS["720"]!.height);
  const [fps, setFps] = useState(STREAM_PRESETS["720"]!.fps);
  const [videoBitrateKbps, setVideoBitrateKbps] = useState(STREAM_PRESETS["720"]!.videoBitrateKbps);
  const [audioBitrateKbps, setAudioBitrateKbps] = useState(128);
  const [viewerLimit, setViewerLimit] = useState(0);
  const [mode, setMode] = useState<number>(StreamMode.P2P);
  const [contentHint, setContentHint] = useState<"motion" | "detail">("motion");

  const applyPreset = (key: string) => {
    const p = STREAM_PRESETS[key];
    if (!p) return;
    setPreset(key);
    setHeight(p.height);
    setFps(p.fps);
    setVideoBitrateKbps(p.videoBitrateKbps);
    setContentHint(p.contentHint);
  };

  // Any hand-tuned value means the result is no longer one of the presets, so
  // the highlight is dropped rather than left lying about what will be sent.
  const custom = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setPreset(null);
  };

  const resolutionLabel = (value: number) => (value === 0 ? t("publish.res.source") : String(value));

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-stream-settings" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>
            {t("publish.dialog.title")} <AlphaBadge />
          </span>
          <button onClick={onCancel} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <p className="ts-alpha-note">{t("publish.alphaNote")}</p>
          <h4 className="ts-stream-settings-section">{t("publish.dialog.basic")}</h4>

          <div className="ts-stream-settings-row">
            <span>{t("publish.preset")}</span>
            <SegmentedChoice
              value={preset ?? ""}
              onChange={applyPreset}
              options={[
                ...["360", "480", "720", "1080", "1440"].map((k) => ({ value: k, label: k })),
                { value: "source", label: t("publish.res.source") },
                { value: "presentation", label: t("publish.preset.presentation") },
              ]}
            />
          </div>

          <div className="ts-stream-settings-row">
            <span>{t("publish.audio")}</span>
            <label className="ts-stream-settings-toggle">
              <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
              <span />
            </label>
          </div>

          <div className="ts-stream-settings-row">
            <span>{t("publish.privacy")}</span>
            <SegmentedChoice
              value={accessibility}
              onChange={setAccessibility}
              options={[
                { value: StreamAccess.PUBLIC, label: `🌐 ${t("publish.privacy.public")}` },
                { value: StreamAccess.CONTACTS_ONLY, label: `👥 ${t("publish.privacy.contacts")}` },
                { value: StreamAccess.PRIVATE, label: `🔒 ${t("publish.privacy.private")}` },
              ]}
            />
          </div>

          <button
            type="button"
            className="ts-stream-settings-section ts-stream-settings-expand"
            onClick={() => setAdvanced((v) => !v)}
          >
            {t("publish.dialog.advanced")} <span>{advanced ? "⌄" : "›"}</span>
          </button>

          {advanced && (
            <>
              <div className="ts-stream-settings-row">
                <span>{t("publish.resolution")}</span>
                <SegmentedChoice
                  value={height}
                  onChange={custom(setHeight)}
                  options={RESOLUTION_CHOICES.map((v) => ({ value: v, label: resolutionLabel(v) }))}
                />
              </div>

              <div className="ts-stream-settings-row">
                <span>{t("publish.fps")}</span>
                <SegmentedChoice
                  value={fps}
                  onChange={custom(setFps)}
                  options={FPS_CHOICES.map((v) => ({ value: v, label: String(v) }))}
                />
              </div>

              <div className="ts-stream-settings-row">
                <span>{t("publish.bitrate")}</span>
                <div className="ts-stream-settings-stepper">
                  <button type="button" onClick={() => custom(setVideoBitrateKbps)(Math.max(200, videoBitrateKbps - 500))}>
                    −
                  </button>
                  <input
                    type="number"
                    min={200}
                    step={100}
                    value={videoBitrateKbps}
                    onChange={(e) => custom(setVideoBitrateKbps)(Math.max(200, Number(e.target.value) || 200))}
                  />
                  <span className="ts-stream-settings-unit">Kbps</span>
                  <button type="button" onClick={() => custom(setVideoBitrateKbps)(videoBitrateKbps + 500)}>
                    +
                  </button>
                </div>
              </div>

              <div className="ts-stream-settings-row">
                <span>{t("publish.audioBitrate")}</span>
                <SegmentedChoice
                  value={audioBitrateKbps}
                  onChange={custom(setAudioBitrateKbps)}
                  disabled={!audio}
                  options={AUDIO_BITRATE_CHOICES.map((v) => ({ value: v, label: String(v) }))}
                />
              </div>

              <div className="ts-stream-settings-row">
                <span>{t("publish.viewerLimit")}</span>
                <div className="ts-stream-settings-stepper">
                  <button type="button" onClick={() => setViewerLimit(Math.max(0, viewerLimit - 1))}>
                    −
                  </button>
                  <input
                    type="number"
                    min={0}
                    value={viewerLimit}
                    onChange={(e) => setViewerLimit(Math.max(0, Number(e.target.value) || 0))}
                  />
                  <button type="button" onClick={() => setViewerLimit(viewerLimit + 1)}>
                    +
                  </button>
                </div>
              </div>

              <div className="ts-stream-settings-row">
                <span>{t("publish.mode")}</span>
                <SegmentedChoice
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: StreamMode.P2P, label: `👥 ${t("publish.mode.p2p")}` },
                    {
                      value: StreamMode.SFU,
                      label: `🖧 ${t("publish.mode.server")}`,
                      // The SFU path is a different transport entirely
                      // (requestsfuaccessinfo + mediasoup) and is not built
                      // yet; offering it would announce a stream nobody can
                      // watch.
                      disabled: true,
                      title: t("publish.mode.serverUnavailable"),
                    },
                  ]}
                />
              </div>
            </>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button type="button" onClick={onCancel}>
              {t("publish.dialog.cancel")}
            </button>
            <button
              type="button"
              className="ts-stream-settings-go"
              onClick={() =>
                onStart({
                  name: defaultName,
                  audio,
                  accessibility,
                  mode,
                  viewerLimit,
                  height,
                  fps,
                  videoBitrateKbps,
                  audioBitrateKbps,
                  contentHint,
                })
              }
            >
              {t("publish.dialog.golive")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const SW_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const VERSION_CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** Floor between two version.json fetches, so tab-switching doesn't poll. */
const VERSION_CHECK_MIN_GAP_MS = 5 * 60 * 1000;
const UPDATE_TOAST_SNOOZE_MS = 30 * 60 * 1000;

/** What the server actually has right now. Deliberately routed around the
 *  service worker: version.json is not in Workbox's globPatterns, so it is
 *  never precached, and the cache-busting query plus `no-store` keeps any
 *  intermediate cache out of the answer too. */
async function fetchServerBuildId(): Promise<string | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const id = (data as { buildId?: unknown }).buildId;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/** Throw away the worker and everything it cached, then reload from the
 *  network. Only for a client that is provably stale but isn't being handed
 *  an update — see `stranded` below. */
async function resetServiceWorkerAndReload() {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    const cacheKeys = await caches.keys();
    await Promise.all(cacheKeys.map((key) => caches.delete(key)));
  } catch {
    // Reloading without the cleanup is still better than staying stale.
  }
  window.location.reload();
}

function UpdatePrompt() {
  const t = useT();
  const [visible, setVisible] = useState(false);
  /** An update is waiting to be applied, whether or not the toast is showing. */
  const pending = useRef(false);
  /** Set when the server is on a different build than we are *and* no new
   *  service worker turned up to deliver it. Then the worker is wedged and a
   *  plain reload would just serve the same cached shell again, so the button
   *  has to clear it out instead. */
  const stranded = useRef(false);
  const snoozeTimer = useRef<number | null>(null);
  const lastVersionCheck = useRef(0);

  const announce = (isStranded: boolean) => {
    if (isStranded) stranded.current = true;
    pending.current = true;
    // While snoozed the timer owns the toast; don't pop it back up early.
    if (snoozeTimer.current === null) setVisible(true);
  };

  const snooze = () => {
    setVisible(false);
    // Never a permanent dismissal: a client that misses the prompt for good is
    // exactly how clients ended up stranded on a bundle the server no longer
    // even serves.
    snoozeTimer.current = window.setTimeout(() => {
      snoozeTimer.current = null;
      if (pending.current) setVisible(true);
    }, UPDATE_TOAST_SNOOZE_MS);
  };

  useRegisterSW({
    onNeedReload() {
      // autoUpdate: the new worker has already taken over, we only choose the
      // moment to reload — mid-call is the user's decision, not ours.
      announce(false);
    },
    onRegisteredSW(_url, registration) {
      // Poll for a new service worker in the background — otherwise an app
      // left open for hours/days only checks for updates on next full load.
      if (!registration) return;
      window.setInterval(() => {
        registration.update().catch(() => {});
      }, SW_UPDATE_CHECK_INTERVAL_MS);
    },
  });

  useEffect(() => {
    const checkVersion = async () => {
      const now = Date.now();
      if (now - lastVersionCheck.current < VERSION_CHECK_MIN_GAP_MS) return;
      lastVersionCheck.current = now;

      const serverBuildId = await fetchServerBuildId();
      if (!serverBuildId || serverBuildId === __BUILD_ID__) return;

      // We are demonstrably behind. Give the service worker the first shot at
      // fixing it; only if it produces no new worker at all is it wedged.
      let registration: ServiceWorkerRegistration | undefined;
      try {
        registration = await navigator.serviceWorker?.getRegistration();
        await registration?.update();
      } catch {
        // An update check that throws is itself a sign of a wedged worker.
      }
      announce(!registration?.installing && !registration?.waiting);
    };

    void checkVersion();
    const interval = window.setInterval(() => void checkVersion(), VERSION_CHECK_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void checkVersion();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!visible) return null;

  return (
    <div className="ts-update-toast">
      <span>{t("pwa.updateAvailable")}</span>
      <button
        type="button"
        onClick={() => {
          if (stranded.current) void resetServiceWorkerAndReload();
          else window.location.reload();
        }}
      >
        {t("pwa.reload")}
      </button>
      <button type="button" className="ts-update-toast-dismiss" onClick={snooze}>
        ✕
      </button>
    </div>
  );
}

const FEEDBACK_BUBBLE_STORAGE_KEY = "webspeak3.feedbackBubble.lastShown";
const FEEDBACK_BUBBLE_MIN_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // don't nag more than every 3 days
const FEEDBACK_BUBBLE_INITIAL_DELAY_MS = 45_000;
const FEEDBACK_BUBBLE_AUTO_HIDE_MS = 14_000;

function FeedbackFab({ onOpen, stacked }: { onOpen: () => void; stacked: boolean }) {
  const t = useT();
  const [bubbleVisible, setBubbleVisible] = useState(false);

  useEffect(() => {
    let lastShown = 0;
    try {
      lastShown = Number(localStorage.getItem(FEEDBACK_BUBBLE_STORAGE_KEY) || 0);
    } catch {
      // localStorage unavailable - just skip the nudge
      return;
    }
    if (Date.now() - lastShown < FEEDBACK_BUBBLE_MIN_INTERVAL_MS) return;

    const showTimer = window.setTimeout(() => {
      setBubbleVisible(true);
      try {
        localStorage.setItem(FEEDBACK_BUBBLE_STORAGE_KEY, String(Date.now()));
      } catch {
        // ignore
      }
    }, FEEDBACK_BUBBLE_INITIAL_DELAY_MS);

    return () => window.clearTimeout(showTimer);
  }, []);

  useEffect(() => {
    if (!bubbleVisible) return;
    const hideTimer = window.setTimeout(() => setBubbleVisible(false), FEEDBACK_BUBBLE_AUTO_HIDE_MS);
    return () => window.clearTimeout(hideTimer);
  }, [bubbleVisible]);

  return (
    <div className={`ts-feedback-fab-wrap${stacked ? " ts-feedback-fab-wrap-stacked" : ""}`}>
      {bubbleVisible && (
        <div className="ts-feedback-bubble" onClick={onOpen}>
          <button
            type="button"
            className="ts-feedback-bubble-close"
            onClick={(e) => {
              e.stopPropagation();
              setBubbleVisible(false);
            }}
            title={t("feedback.dialog.cancel")}
          >
            ✕
          </button>
          {t("feedback.fab.nudge")}
        </div>
      )}
      <button
        type="button"
        className="ts-feedback-fab"
        onClick={() => {
          setBubbleVisible(false);
          onOpen();
        }}
        title={t("menu.extras.feedback")}
      >
        💬
      </button>
    </div>
  );
}

/** Small donation pill, pinned to the bottom right corner. */
type NewsItem =
  | { id: string; kind: "text"; text: string; url?: string }
  | { id: string; kind: "release"; version: string; url: string }
  | { id: string; kind: "theme"; name: string; author: string };

const NEWS_DISMISSED_STORAGE_KEY = "webspeak3.newsTicker.dismissed";

/** Hash links that open a dialog in this client (#about, #options/<section>). */
const isInAppHash = (hash: string) => hash === "#about" || OPTIONS_SECTIONS.some((s) => hash === `#options/${s.id}`);

// Like the scrolling news line at the bottom of the native TS3 client.
// Dismissing hides the current set of items until a new one shows up.
function NewsTicker() {
  const t = useT();
  const [items, setItems] = useState<NewsItem[]>([]);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(NEWS_DISMISSED_STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  });

  useEffect(() => {
    const getJson = async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    };
    const load = async () => {
      // A gateway older than the ticker answers 404: treat it as the default.
      const config = (NEWS_CONFIG_URL ? await getJson(NEWS_CONFIG_URL).catch(() => null) : null) ?? {
        enabled: true,
        central: true,
        items: [],
      };
      if (!config.enabled) return setItems([]);
      const central = config.central ? ((await getJson(NEWS_FEED_URL).catch(() => null))?.items ?? []) : [];
      setItems([...config.items, ...central]);
    };
    void load();
    const timer = window.setInterval(() => void load(), 15 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  const key = items.map((i) => i.id).join(",");
  if (!items.length || key === dismissed) return null;

  const label = (item: NewsItem) =>
    item.kind === "release"
      ? t("news.release", { version: item.version })
      : item.kind === "theme"
        ? t("news.theme", { name: item.name, author: item.author })
        : item.text;
  const entries = items.map((item) => {
    const url = item.kind === "theme" ? undefined : item.url;
    // https://…/#options/konto or #about: open the dialog here instead of a new tab.
    const inApp = url && isInAppHash(new URL(url).hash);
    return (
      <span key={item.id} className="ts-news-item">
        {inApp ? (
          <a href={new URL(url).hash}>{label(item)}</a>
        ) : url ? (
          <a href={url} target="_blank" rel="noopener noreferrer">
            {label(item)}
          </a>
        ) : (
          label(item)
        )}
      </span>
    );
  });

  return (
    <div className="ts-news-ticker">
      <span className="ts-news-label">{t("news.label")}</span>
      <div className="ts-news-track">
        {/* Duration from the distance travelled (track + text), so the speed is
            the same ~45 px/s on every screen width. */}
        <div
          className="ts-news-scroll"
          ref={(el) => {
            if (el) el.style.animationDuration = `${el.scrollWidth / 45}s`;
          }}
        >
          {entries}
        </div>
      </div>
      <button
        className="ts-news-close"
        title={t("dialog.close")}
        aria-label={t("dialog.close")}
        onClick={() => {
          setDismissed(key);
          try {
            localStorage.setItem(NEWS_DISMISSED_STORAGE_KEY, key);
          } catch {
            // ignore
          }
        }}
      >
        ✕
      </button>
    </div>
  );
}

function DonateFab() {
  const t = useT();
  if (!DONATE_URL) return null;
  return (
    <a
      className="ts-donate-fab"
      href={DONATE_URL}
      target="_blank"
      rel="noopener noreferrer"
      title={t("donate.title")}
    >
      <span className="ts-donate-fab-icon" aria-hidden="true">☕</span>
      {t("donate.label")}
    </a>
  );
}

type FeedbackCategory = "bug" | "idea" | "other" | "report";

/** Best-effort "Chrome 141 · Windows" from the UA, prefilled into bug reports
 *  so users don't have to know it themselves - they can still correct it. */
function detectBrowserAndOs(): string {
  const ua = navigator.userAgent;
  const pick = (re: RegExp, name: string) => {
    const m = re.exec(ua);
    return m ? `${name} ${m[1]}` : null;
  };
  const browser =
    pick(/Edg\/(\d+)/, "Edge") ??
    pick(/OPR\/(\d+)/, "Opera") ??
    pick(/Firefox\/(\d+)/, "Firefox") ??
    pick(/Chrome\/(\d+)/, "Chrome") ??
    pick(/Version\/([\d.]+).*Safari/, "Safari") ??
    "?";
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "?";
  return `${browser} · ${os}`;
}

function FeedbackDialog({ onClose, audioState }: { onClose: () => void; audioState: string }) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [message, setMessage] = useState("");
  // Bug-only extras, appended to the message so neither the gateway nor the
  // private storage needs a schema change.
  const [environment, setEnvironment] = useState(detectBrowserAndOs);
  const [bugServer, setBugServer] = useState("");
  const [steps, setSteps] = useState("");
  const diagnostics = [
    `Page: ${window.location.host}`,
    `User agent: ${navigator.userAgent}`,
    `Language: ${navigator.language}`,
    `Audio: ${audioState}`,
    `Output device switching: ${"setSinkId" in HTMLMediaElement.prototype ? "yes" : "no"}`,
  ].join("\n");
  const [email, setEmail] = useState("");
  // Bugs always get filed as a GitHub issue - the checkbox is forced on and
  // locked while "bug" is selected (see the select's onChange below), so the
  // initial value has to agree with the initial category.
  const [publishAsIssue, setPublishAsIssue] = useState(true);
  // Honeypot: real users never see or fill this (hidden via CSS, no label,
  // excluded from tab order); bots that blindly fill every field do. Kept
  // in sync with the gateway's "website" field name.
  const [website, setWebsite] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [issueUrl, setIssueUrl] = useState<string | undefined>(undefined);

  const handleSend = async () => {
    const trimmed = message.trim();
    if (!trimmed || status === "sending") return;
    setStatus("sending");
    try {
      const res = await fetch(FEEDBACK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          message:
            category === "bug"
              ? [
                  trimmed,
                  "",
                  "---",
                  `**Browser / OS:** ${environment.trim() || "?"}`,
                  ...(steps.trim() ? [`**Steps:** ${steps.trim()}`] : []),
                  "",
                  diagnostics,
                ].join("\n")
              : trimmed,
          email: email.trim() || undefined,
          server: category === "bug" ? bugServer.trim() || undefined : undefined,
          publishAsIssue,
          website,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as { ok?: boolean; githubIssueUrl?: string };
      setIssueUrl(json.githubIssueUrl);
      setStatus("sent");
      // Someone who just sent feedback doesn't need the nudge bubble asking
      // them to do exactly that again for a while - push its cooldown out
      // from this moment rather than leaving it on whatever schedule it was
      // already on.
      try {
        localStorage.setItem(FEEDBACK_BUBBLE_STORAGE_KEY, String(Date.now()));
      } catch {
        // ignore
      }
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-feedback-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("feedback.dialog.title")}</span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          {status === "sent" ? (
            <p className="ts-feedback-success">
              {issueUrl ? (
                <>
                  {t("feedback.dialog.successWithIssue")}{" "}
                  <a href={issueUrl} target="_blank" rel="noreferrer">
                    {issueUrl}
                  </a>
                </>
              ) : (
                t("feedback.dialog.success")
              )}
            </p>
          ) : (
            <>
              <p className="ts-feedback-intro">{t("feedback.dialog.intro")}</p>
              <input
                type="text"
                name="website"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                className="ts-feedback-honeypot"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
              />
              <label className="ts-dialog-field">
                {t("feedback.dialog.category")}
                <select
                  value={category}
                  onChange={(e) => {
                    const next = e.target.value as FeedbackCategory;
                    setCategory(next);
                    if (next === "bug") setPublishAsIssue(true);
                    // Reports (e.g. ToS violations) never become a public
                    // GitHub issue - they may name another user's server.
                    else if (next === "report") setPublishAsIssue(false);
                  }}
                >
                  <option value="bug">{t("feedback.dialog.category.bug")}</option>
                  <option value="idea">{t("feedback.dialog.category.idea")}</option>
                  <option value="report">{t("feedback.dialog.category.report")}</option>
                  <option value="other">{t("feedback.dialog.category.other")}</option>
                </select>
              </label>
              <label className="ts-dialog-field">
                {t("feedback.dialog.message")}
                <textarea
                  autoFocus
                  rows={5}
                  value={message}
                  placeholder={t("feedback.dialog.messagePlaceholder")}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </label>
              {category === "bug" && (
                <>
                  <label className="ts-dialog-field">
                    {t("feedback.dialog.bug.environment")}
                    <input type="text" value={environment} onChange={(e) => setEnvironment(e.target.value)} />
                  </label>
                  <label className="ts-dialog-field">
                    {t("feedback.dialog.bug.server")}
                    <input type="text" value={bugServer} onChange={(e) => setBugServer(e.target.value)} />
                  </label>
                  <label className="ts-dialog-field">
                    {t("feedback.dialog.bug.steps")}
                    <textarea
                      rows={3}
                      value={steps}
                      placeholder={t("feedback.dialog.bug.stepsPlaceholder")}
                      onChange={(e) => setSteps(e.target.value)}
                    />
                  </label>
                  <details className="ts-feedback-hint">
                    <summary>{t("feedback.dialog.bug.diagnostics")}</summary>
                    <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{diagnostics}</pre>
                  </details>
                </>
              )}
              <label className="ts-dialog-field">
                {t("feedback.dialog.email")}
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
              {category === "report" ? (
                <p className="ts-feedback-hint">{t("feedback.dialog.reportHint")}</p>
              ) : (
                <>
                  <label className="ts-feedback-checkbox-field">
                    <input
                      type="checkbox"
                      checked={publishAsIssue}
                      disabled={category === "bug"}
                      onChange={(e) => setPublishAsIssue(e.target.checked)}
                    />
                    {t("feedback.dialog.publishAsIssue")}
                  </label>
                  <p className="ts-feedback-hint">
                    {t(category === "bug" ? "feedback.dialog.publishAsIssueHintBug" : "feedback.dialog.publishAsIssueHint")}
                  </p>
                </>
              )}
              {status === "error" && <p className="ts-feedback-error">{t("feedback.dialog.error")}</p>}
            </>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            {status !== "sent" && (
              <button onClick={() => void handleSend()} disabled={!message.trim() || status === "sending"}>
                {status === "sending" ? t("feedback.dialog.sending") : t("feedback.dialog.send")}
              </button>
            )}
            <button onClick={onClose}>{status === "sent" ? t("dialog.close") : t("feedback.dialog.cancel")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FavoritesDialog({
  favorites,
  prefillNew,
  onSave,
  onClose,
}: {
  favorites: Favorite[];
  prefillNew?: Omit<Favorite, "id" | "bookmarkName">;
  onSave: (favorites: Favorite[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const pendingNewRef = useRef<Favorite | null>(
    prefillNew
      ? {
          id: randomId(),
          bookmarkName: prefillNew.host || t("favorites.newFavoriteName"),
          ...prefillNew,
          showServerQueryClients: prefillNew.showServerQueryClients === true,
        }
      : null
  );
  const [draft, setDraft] = useState<Favorite[]>(() =>
    pendingNewRef.current ? [...favorites, pendingNewRef.current] : favorites.map((f) => ({ ...f }))
  );
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    pendingNewRef.current ? pendingNewRef.current.id : (favorites[0]?.id ?? null)
  );

  const selected = draft.find((f) => f.id === selectedId) ?? null;

  const updateSelected = (patch: Partial<Favorite>) => {
    if (!selectedId) return;
    setDraft((prev) => prev.map((f) => (f.id === selectedId ? { ...f, ...patch } : f)));
  };

  const handleNewFavorite = () => {
    const nf: Favorite = {
      id: randomId(),
      bookmarkName: t("favorites.newFavoriteName"),
      nickname: "",
      host: "",
      serverPassword: "",
      defaultChannel: "",
      defaultChannelPassword: "",
      showServerQueryClients: false,
    };
    setDraft((prev) => [...prev, nf]);
    setSelectedId(nf.id);
  };

  const handleRemove = () => {
    if (!selectedId) return;
    setDraft((prev) => prev.filter((f) => f.id !== selectedId));
    setSelectedId(null);
  };

  const backdrop = useBackdropDismiss(onClose);
  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-favorites-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("favorites.title")}</span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-favorites-body">
          <div className="ts-favorites-list-col">
            <div className="ts-favorites-list-group-title">{t("favorites.synced")}</div>
            <div className="ts-favorites-list-empty">{t("favorites.notLoggedIn")}</div>
            <div className="ts-favorites-list-group-title">{t("favorites.local")}</div>
            <ul className="ts-favorites-list">
              {draft.map((f) => (
                <li
                  key={f.id}
                  className={`ts-favorites-list-item${f.id === selectedId ? " ts-favorites-list-item-selected" : ""}`}
                  onClick={() => setSelectedId(f.id)}
                >
                  <button type="button" className="ts-plain-button" aria-current={f.id === selectedId}>
                    {f.bookmarkName || t("favorites.unnamed")}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="ts-favorites-fields-col">
            <label className="ts-dialog-field">
              {t("favorites.bookmarkName")}
              <input
                disabled={!selected}
                value={selected?.bookmarkName ?? ""}
                onChange={(e) => updateSelected({ bookmarkName: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              {t("connect.nickname")}
              <input
                disabled={!selected}
                value={selected?.nickname ?? ""}
                onChange={(e) => updateSelected({ nickname: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              {t("connect.phoneticNickname")}
              <input disabled title={t("clientContext.notSupported")} />
            </label>
            <label className="ts-dialog-field">
              {t("connect.serverAddress")}
              <input
                disabled={!selected}
                value={selected?.host ?? ""}
                onChange={(e) => updateSelected({ host: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              {t("connect.serverPassword")}
              <input
                type="password"
                disabled={!selected}
                value={selected?.serverPassword ?? ""}
                onChange={(e) => updateSelected({ serverPassword: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              {t("connect.defaultChannel")}
              <input
                disabled={!selected}
                value={selected?.defaultChannel ?? ""}
                onChange={(e) => updateSelected({ defaultChannel: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              {t("connect.channelPassword")}
              <input
                type="password"
                disabled={!selected}
                value={selected?.defaultChannelPassword ?? ""}
                onChange={(e) => updateSelected({ defaultChannelPassword: e.target.value })}
              />
            </label>
          </div>

          <div className="ts-favorites-profile-col">
            <label className="ts-dialog-field">
              {t("connect.identity")}
              <select disabled defaultValue="Standard">
                <option>Standard</option>
              </select>
            </label>
            <label className="ts-dialog-field">
              {t("connect.recordingProfile")}
              <select disabled defaultValue="Standard">
                <option>Standard</option>
              </select>
            </label>
            <label className="ts-dialog-field">
              {t("connect.playbackProfile")}
              <select disabled defaultValue="Standard">
                <option>Standard</option>
              </select>
            </label>
            <label className="ts-dialog-field">
              {t("connect.hotkeyProfile")}
              <select disabled defaultValue="Standard">
                <option>Standard</option>
              </select>
            </label>
            <label className="ts-dialog-field">
              {t("connect.soundPack")}
              <select
                disabled={!selected}
                value={selected?.soundPack ?? ""}
                onChange={(e) => updateSelected({ soundPack: e.target.value || undefined })}
              >
                <option value="">Standard</option>
                <SoundPackOptions />
              </select>
            </label>
            <label className="ts-dialog-checkbox">
              <input
                type="checkbox"
                disabled={!selected}
                checked={selected?.showServerQueryClients ?? false}
                onChange={(e) => updateSelected({ showServerQueryClients: e.target.checked })}
              />
              {t("favorites.showServerQueryClients")}
            </label>
            <label className="ts-dialog-checkbox">
              <input type="checkbox" disabled title={t("clientContext.notSupported")} />
              {t("favorites.connectOnStartup")}
            </label>
          </div>
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={handleNewFavorite}>{t("favorites.new")}</button>
            <button disabled title="Not supported in the web client">
              {t("favorites.newFolder")}
            </button>
            <button onClick={handleRemove} disabled={!selected}>
              {t("favorites.remove")}
            </button>
          </div>
          <div className="ts-dialog-buttons-right">
            <button
              onClick={() => {
                onSave(draft);
                onClose();
              }}
            >
              {t("favorites.ok")}
            </button>
            <button onClick={onClose}>{t("favorites.cancel")}</button>
            <button onClick={() => onSave(draft)}>{t("favorites.apply")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CollectedUrlsDialog({
  urls,
  onClear,
  onClose,
}: {
  urls: CollectedUrl[];
  onClear: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const backdrop = useBackdropDismiss(onClose);

  const filtered = urls
    .filter((u) => u.url.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => b.lastSeen - a.lastSeen);

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-collected-urls-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("collectedUrls.title")}</span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <label className="ts-dialog-field">
            {t("collectedUrls.search")}
            <input value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <table className="ts-collected-urls-table">
            <thead>
              <tr>
                <th>{t("collectedUrls.url")}</th>
                <th>{t("collectedUrls.count")}</th>
                <th>{t("collectedUrls.lastSeen")}</th>
                <th>{t("collectedUrls.mentionedBy")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.url}>
                  <td>
                    <a href={u.url} target="_blank" rel="noreferrer noopener">
                      {u.url}
                    </a>
                  </td>
                  <td>{u.count}</td>
                  <td>{new Date(u.lastSeen).toLocaleString()}</td>
                  <td>{u.lastSender}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="ts-dialog-buttons">
          <button onClick={onClear}>{t("collectedUrls.clearList")}</button>
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function InviteFriendDialog({
  host,
  channelId,
  channelPath,
  onClose,
}: {
  host: string;
  channelId: number | null;
  /** "Parent/Child" names, what ?channel= of a WebSpeak3 link expects. */
  channelPath: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const [type, setType] = useState<"webspeak3" | "ts3server">("webspeak3");
  const [includeChannel, setIncludeChannel] = useState(false);
  const [copied, setCopied] = useState(false);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const backdrop = useBackdropDismiss(onClose);

  const withChannel = includeChannel && channelId !== null;
  // Opens this same WebSpeak3 instance and joins right away (see AUTO_CONNECT_FROM_URL).
  const webspeak3Link = () => {
    const params = new URLSearchParams({ connect: host });
    if (withChannel && channelPath) params.set("channel", channelPath);
    return `${window.location.origin}${window.location.pathname}?${params}`;
  };
  const link = type === "webspeak3" ? webspeak3Link() : `ts3server://${host}${withChannel ? `?channel=${channelId}` : ""}`;

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-invite-friend-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("inviteFriend.title")}</span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <div className="ts-dialog-row">
            <label className="ts-dialog-field ts-dialog-field-grow">
              {t("inviteFriend.type")}
              <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                <option value="webspeak3">{t("inviteFriend.webspeak3Link")}</option>
                <option value="ts3server">ts3server link</option>
              </select>
            </label>
            <label className="ts-dialog-checkbox">
              <input
                type="checkbox"
                checked={includeChannel}
                disabled={channelId === null}
                onChange={(e) => setIncludeChannel(e.target.checked)}
              />
              {t("inviteFriend.includeChannel")}
            </label>
          </div>
          <label className="ts-dialog-field">
            {t("inviteFriend.link")}
            <input ref={linkInputRef} readOnly value={link} onFocus={(e) => e.target.select()} />
          </label>
        </div>
        <div className="ts-dialog-buttons">
          <button disabled title={t("clientContext.notSupported")}>
            {t("inviteFriend.addPermissionKey")}
          </button>
          <div className="ts-dialog-buttons-right">
            <button
              onClick={() => {
                // No clipboard API on plain-http origins - select the link
                // instead so it can be copied by hand.
                (navigator.clipboard?.writeText(link) ?? Promise.reject()).then(
                  () => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  },
                  () => linkInputRef.current?.select()
                );
              }}
            >
              {copied ? t("inviteFriend.copied") : t("inviteFriend.copyToClipboard")}
            </button>
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ClientLogDialog({ entries, onClose }: { entries: ClientLogEntry[]; onClose: () => void }) {
  const t = useT();
  const [enabledLevels, setEnabledLevels] = useState<Set<LogLevel>>(new Set(LOG_LEVELS));
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const backdrop = useBackdropDismiss(onClose);
  const listRef = useRef<HTMLDivElement | null>(null);

  const toggleLevel = (level: LogLevel) => {
    setEnabledLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const matches = (message: string, needle: string) =>
    caseSensitive ? message.includes(needle) : message.toLowerCase().includes(needle.toLowerCase());

  const visible = entries
    .filter((e) => enabledLevels.has(e.level))
    .filter((e) => !filter || matches(e.message, filter));

  const handleMark = () => {
    if (!search) return;
    const idx = visible.findIndex((e) => matches(e.message, search));
    if (idx >= 0) {
      const row = listRef.current?.querySelector(`[data-log-id="${visible[idx].id}"]`);
      row?.scrollIntoView({ block: "center" });
    }
  };

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-client-log-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("clientLog.title")}</span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <div className="ts-dialog-row ts-log-level-row">
            {LOG_LEVELS.map((level) => (
              <label key={level} className="ts-dialog-checkbox">
                <input
                  type="checkbox"
                  checked={enabledLevels.has(level)}
                  onChange={() => toggleLevel(level)}
                />
                {t(`clientLog.level.${level}`)}
              </label>
            ))}
          </div>
          <div className="ts-log-list" ref={listRef}>
            {visible.map((e) => (
              <div key={e.id} data-log-id={e.id} className={`ts-log-row ts-log-row-${e.level}`}>
                <span className="ts-log-time">{new Date(e.timestamp).toLocaleString()}</span>
                <span className="ts-log-category">{e.category}</span>
                <span className="ts-log-level">{t(`clientLog.level.${e.level}`)}</span>
                <span className="ts-log-message">{e.message}</span>
              </div>
            ))}
          </div>
          <div className="ts-dialog-row">
            <label className="ts-dialog-field ts-dialog-field-grow">
              {t("clientLog.search")}
              <input value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <label className="ts-dialog-checkbox">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(e) => setCaseSensitive(e.target.checked)}
              />
              {t("clientLog.caseSensitive")}
            </label>
          </div>
          <div className="ts-dialog-row">
            <label className="ts-dialog-field ts-dialog-field-grow">
              {t("clientLog.filter")}
              <input value={filter} onChange={(e) => setFilter(e.target.value)} />
            </label>
            <button onClick={handleMark}>{t("clientLog.mark")}</button>
          </div>
        </div>
        <div className="ts-dialog-buttons">
          <div />
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BanListDialog({
  entries,
  onDelete,
  onDeleteAll,
  onClose,
}: {
  entries: BanListEntry[] | null;
  onDelete: (banId: number) => void;
  onDeleteAll: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  // Same silent-decline story as connection-info/server-log: a guest account
  // without b_virtualserver_client_dblist/banlist permission never gets a reply.
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (entries) return;
    const id = window.setTimeout(() => setTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [entries]);

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-ban-list-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("banList.title")}</span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          {!entries ? (
            <div className="ts-connection-info-loading">
              {timedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
            </div>
          ) : entries.length === 0 ? (
            <div className="ts-connection-info-loading">{t("banList.empty")}</div>
          ) : (
            <table className="ts-ban-list-table">
              <thead>
                <tr>
                  <th>{t("banList.name")}</th>
                  <th>{t("banList.ip")}</th>
                  <th>{t("banList.created")}</th>
                  <th>{t("banList.duration")}</th>
                  <th>{t("banList.invoker")}</th>
                  <th>{t("banList.reason")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.banId}>
                    <td>{e.name || e.lastNickname || "-"}</td>
                    <td>{e.ip || "-"}</td>
                    <td>{e.created}</td>
                    <td>{e.durationSecs === 0 ? t("banList.permanent") : `${e.durationSecs}s`}</td>
                    <td>{e.invokerName}</td>
                    <td>{e.reason}</td>
                    <td>
                      <button onClick={() => onDelete(e.banId)}>{t("banList.delete")}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-left">
            {entries && entries.length > 0 && (
              <button onClick={onDeleteAll}>{t("banList.deleteAll")}</button>
            )}
          </div>
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ComplainListDialog({
  entries,
  onDelete,
  onClose,
}: {
  entries: ComplainListEntry[] | null;
  onDelete: (targetClientDbId: number, fromClientDbId: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (entries) return;
    const id = window.setTimeout(() => setTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [entries]);

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-complain-list-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("complainList.title")}</span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          {!entries ? (
            <div className="ts-connection-info-loading">
              {timedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
            </div>
          ) : entries.length === 0 ? (
            <div className="ts-connection-info-loading">{t("complainList.empty")}</div>
          ) : (
            <table className="ts-ban-list-table">
              <thead>
                <tr>
                  <th>{t("complainList.target")}</th>
                  <th>{t("complainList.from")}</th>
                  <th>{t("complainList.message")}</th>
                  <th>{t("complainList.timestamp")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={i}>
                    <td>{e.targetName}</td>
                    <td>{e.fromName}</td>
                    <td>{e.message}</td>
                    <td>{e.timestamp}</td>
                    <td>
                      <button onClick={() => onDelete(e.targetClientDbId, e.fromClientDbId)}>
                        {t("banList.delete")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function OfflineMessagesDialog({
  entries,
  detail,
  onSelect,
  onDelete,
  onMarkRead,
  onSend,
  onClose,
}: {
  entries: OfflineMessageListEntry[] | null;
  detail: { messageId: number; clientUid: string; subject: string; message: string; timestamp: string } | null;
  onSelect: (messageId: number) => void;
  onDelete: (messageId: number) => void;
  onMarkRead: (messageId: number) => void;
  onSend: (clientUid: string, subject: string, message: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const [timedOut, setTimedOut] = useState(false);
  const [composing, setComposing] = useState(false);
  const [composeUid, setComposeUid] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeMessage, setComposeMessage] = useState("");

  useEffect(() => {
    setTimedOut(false);
    if (entries) return;
    const id = window.setTimeout(() => setTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [entries]);

  const handleSend = () => {
    if (!composeUid.trim() || !composeSubject.trim()) return;
    onSend(composeUid.trim(), composeSubject.trim(), composeMessage.trim());
    setComposing(false);
    setComposeUid("");
    setComposeSubject("");
    setComposeMessage("");
  };

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-offline-messages-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("offlineMessages.title")}</span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          {composing ? (
            <div className="ts-offline-message-compose">
              <label className="ts-dialog-field ts-dialog-field-grow">
                {t("offlineMessages.targetUid")}
                <input value={composeUid} onChange={(e) => setComposeUid(e.target.value)} />
              </label>
              <label className="ts-dialog-field ts-dialog-field-grow">
                {t("offlineMessages.subject")}
                <input value={composeSubject} onChange={(e) => setComposeSubject(e.target.value)} />
              </label>
              <label className="ts-dialog-field ts-dialog-field-grow">
                {t("offlineMessages.message")}
                <textarea value={composeMessage} onChange={(e) => setComposeMessage(e.target.value)} rows={5} />
              </label>
            </div>
          ) : detail ? (
            <div className="ts-offline-message-detail">
              <div className="ts-offline-message-detail-header">
                <strong>{detail.subject}</strong>
                <span>{detail.timestamp}</span>
              </div>
              <div className="ts-offline-message-detail-uid">{detail.clientUid}</div>
              <div className="ts-offline-message-detail-body">{detail.message}</div>
            </div>
          ) : !entries ? (
            <div className="ts-connection-info-loading">
              {timedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
            </div>
          ) : entries.length === 0 ? (
            <div className="ts-connection-info-loading">{t("offlineMessages.empty")}</div>
          ) : (
            <table className="ts-ban-list-table">
              <thead>
                <tr>
                  <th></th>
                  <th>{t("offlineMessages.subject")}</th>
                  <th>{t("offlineMessages.from")}</th>
                  <th>{t("offlineMessages.timestamp")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.messageId}>
                    <td>{e.isRead ? "" : "●"}</td>
                    <td>
                      <a href="#" onClick={(ev) => { ev.preventDefault(); onSelect(e.messageId); }}>
                        {e.subject}
                      </a>
                    </td>
                    <td>{e.clientUid}</td>
                    <td>{e.timestamp}</td>
                    <td>
                      <button onClick={() => onDelete(e.messageId)}>{t("banList.delete")}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-left">
            {composing ? (
              <>
                <button onClick={handleSend}>{t("offlineMessages.send")}</button>
                <button onClick={() => setComposing(false)}>{t("dialog.cancel")}</button>
              </>
            ) : detail ? (
              <>
                <button onClick={() => onMarkRead(detail.messageId)}>{t("offlineMessages.markRead")}</button>
                <button onClick={() => onSelect(-1)}>{t("offlineMessages.backToList")}</button>
              </>
            ) : (
              <button onClick={() => setComposing(true)}>{t("offlineMessages.new")}</button>
            )}
          </div>
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function GroupAssignDialog({
  kind,
  clientName,
  groups,
  currentGroupIds,
  iconImages,
  onSelect,
  onClose,
}: {
  kind: "channel" | "server";
  clientName: string;
  groups: GroupEntry[] | null;
  currentGroupIds: number[];
  iconImages: Record<string, string>;
  onSelect: (groupId: number, alreadyAssigned: boolean) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { tree } = useContext(DisplayPrefsContext);
  const backdrop = useBackdropDismiss(onClose);
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (groups) return;
    const id = window.setTimeout(() => setTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [groups]);

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-group-assign-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>
            {kind === "channel" ? t("groupAssign.channelTitle") : t("groupAssign.serverTitle")} - {clientName}
          </span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          {!groups ? (
            <div className="ts-connection-info-loading">
              {timedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
            </div>
          ) : groups.length === 0 ? (
            <div className="ts-connection-info-loading">{t("groupAssign.empty")}</div>
          ) : (
            <ul className="ts-group-assign-list">
              {groups.map((g) => {
                const assigned = currentGroupIds.includes(g.id);
                return (
                  <li key={g.id}>
                    <button
                      className={`ts-menu-item${assigned ? " ts-group-assign-current" : ""}`}
                      onClick={() => onSelect(g.id, assigned)}
                    >
                      <span className="ts-menu-item-icon">{assigned ? "✔️" : ""}</span>
                      {tree.groupIconsInMenus && g.iconId !== 0 && <GroupIcon group={g} images={iconImages} />}
                      <span className="ts-menu-item-label">{g.name}</span>
                      {kind === "server" && assigned && (
                        <span className="ts-group-assign-hint">{t("groupAssign.clickToRemove")}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div />
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MoveClientDialog({
  clientName,
  currentChannelId,
  channels,
  onSelect,
  onClose,
}: {
  clientName: string;
  currentChannelId: number;
  channels: ChannelInfo[];
  onSelect: (channelId: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const movable = [...channels].sort((a, b) => a.order - b.order);

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-group-assign-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>
            {t("moveClient.title")} - {clientName}
          </span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          {movable.length === 0 ? (
            <div className="ts-connection-info-loading">{t("moveClient.empty")}</div>
          ) : (
            <ul className="ts-group-assign-list">
              {movable.map((ch) => {
                const current = ch.id === currentChannelId;
                const spacer = spacerDisplayName(ch.name, ch.parent === 0);
                const label = spacer.isSpacer
                  ? spacer.label.trim() || ch.name
                  : ch.name;
                return (
                  <li key={ch.id}>
                    <button
                      className={`ts-menu-item${current ? " ts-group-assign-current" : ""}`}
                      disabled={current || spacer.isSpacer}
                      onClick={() => onSelect(ch.id)}
                    >
                      <span className="ts-menu-item-icon">
                        {current ? "✔️" : spacer.isSpacer ? "➖" : "📁"}
                      </span>
                      <span className="ts-menu-item-label">{label}</span>
                      {current && (
                        <span className="ts-group-assign-hint">{t("moveClient.current")}</span>
                      )}
                      {!current && spacer.isSpacer && (
                        <span className="ts-group-assign-hint">{t("moveClient.spacer")}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div />
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Builds the full channel-relative path TS3's ft* commands expect (e.g.
 *  "/foo/bar.txt") from a directory and a bare entry name. */
function ftJoinPath(dir: string, name: string): string {
  const base = dir === "/" || dir === "" ? "" : dir.replace(/\/+$/, "");
  return `${base}/${name}`;
}

function ftParentPath(dir: string): string {
  if (dir === "/" || dir === "") return "/";
  const trimmed = dir.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

function FileBrowserDialog({
  channelName,
  path,
  entries,
  onNavigate,
  onCreateDir,
  onDelete,
  onRename,
  onDownload,
  onUpload,
  onRefresh,
  onClose,
}: {
  channelName: string;
  path: string;
  entries: FileListEntry[] | null;
  onNavigate: (path: string) => void;
  onCreateDir: (name: string) => void;
  onDelete: (entry: FileListEntry) => void;
  onRename: (entry: FileListEntry, newName: string) => void;
  onDownload: (entry: FileListEntry) => void;
  onUpload: (file: File) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const [timedOut, setTimedOut] = useState(false);
  const [renaming, setRenaming] = useState<{ entry: FileListEntry; value: string } | null>(null);
  const [creatingDir, setCreatingDir] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimedOut(false);
    if (entries) return;
    const id = window.setTimeout(() => setTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [entries, path]);

  const sorted =
    entries
      ?.slice()
      .sort((a, b) => (a.isFile === b.isFile ? a.name.localeCompare(b.name) : a.isFile ? 1 : -1)) ?? null;

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-file-browser-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>
            {t("fileBrowser.title")} - {channelName}
          </span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <div className="ts-file-browser-toolbar">
            <button onClick={() => onNavigate(ftParentPath(path))} disabled={path === "/"} title={t("fileBrowser.up")}>
              ⬆ {t("fileBrowser.up")}
            </button>
            <span className="ts-file-browser-path">{path}</span>
            <button onClick={onRefresh} title={t("fileBrowser.refresh")}>
              🔄
            </button>
            <button onClick={() => setCreatingDir(true)} title={t("fileBrowser.newFolder")}>
              🗀 {t("fileBrowser.newFolder")}
            </button>
            <button onClick={() => fileInputRef.current?.click()} title={t("fileBrowser.upload")}>
              ⬆️ {t("fileBrowser.upload")}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onUpload(file);
                e.target.value = "";
              }}
            />
          </div>
          {creatingDir && (
            <form
              className="ts-dialog-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (newDirName.trim()) onCreateDir(newDirName.trim());
                setNewDirName("");
                setCreatingDir(false);
              }}
            >
              <input
                autoFocus
                value={newDirName}
                onChange={(e) => setNewDirName(e.target.value)}
                placeholder={t("fileBrowser.folderName")}
              />
              <button type="submit">{t("dialog.ok")}</button>
              <button type="button" onClick={() => setCreatingDir(false)}>
                {t("dialog.cancel")}
              </button>
            </form>
          )}
          {!sorted ? (
            <div className="ts-connection-info-loading">
              {timedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
            </div>
          ) : sorted.length === 0 ? (
            <div className="ts-connection-info-loading">{t("fileBrowser.empty")}</div>
          ) : (
            <div className="ts-permission-overview-scroll">
              <table className="ts-ban-list-table">
                <thead>
                  <tr>
                    <th>{t("fileBrowser.name")}</th>
                    <th>{t("fileBrowser.size")}</th>
                    <th>{t("fileBrowser.modified")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((entry) => (
                    <tr key={entry.name}>
                      <td>
                        {renaming?.entry.name === entry.name ? (
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (renaming.value.trim()) onRename(entry, renaming.value.trim());
                              setRenaming(null);
                            }}
                          >
                            <input
                              autoFocus
                              value={renaming.value}
                              onChange={(ev) => setRenaming({ entry, value: ev.target.value })}
                              onBlur={() => setRenaming(null)}
                            />
                          </form>
                        ) : entry.isFile ? (
                          <span>📄 {entry.name}</span>
                        ) : (
                          <button
                            className="ts-link-button"
                            onClick={() => onNavigate(ftJoinPath(path, entry.name))}
                          >
                            📁 {entry.name}
                          </button>
                        )}
                      </td>
                      <td>{entry.isFile ? formatBytes(entry.size) : ""}</td>
                      <td>{entry.timestamp}</td>
                      <td className="ts-file-browser-actions">
                        {entry.isFile && (
                          <button onClick={() => onDownload(entry)} title={t("fileBrowser.download")}>
                            ⬇
                          </button>
                        )}
                        <button
                          onClick={() => setRenaming({ entry, value: entry.name })}
                          title={t("fileBrowser.rename")}
                        >
                          ✏
                        </button>
                        <button onClick={() => onDelete(entry)} title={t("fileBrowser.delete")}>
                          🗑
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div />
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Sniffs an image MIME type from decoded bytes so uploaded icons (which can
 *  be PNG/GIF/JPEG/BMP) render correctly as data URIs regardless of format. */
function sniffImageMime(binary: string): string {
  if (binary.startsWith("\x89PNG")) return "image/png";
  if (binary.startsWith("GIF87a") || binary.startsWith("GIF89a")) return "image/gif";
  if (binary.charCodeAt(0) === 0xff && binary.charCodeAt(1) === 0xd8) return "image/jpeg";
  if (binary.startsWith("BM")) return "image/bmp";
  return "image/png";
}

function iconDataUrl(base64: string): string {
  return `data:${sniffImageMime(atob(base64))};base64,${base64}`;
}

// TeamSpeak keeps a client's avatar as /avatar_<uid> in channel 0's files,
// with the UID's decoded bytes spelled as one letter a-p per nibble.
function avatarPath(uid: string): string | null {
  try {
    const letters = [...atob(uid)].map((ch) => {
      const b = ch.charCodeAt(0);
      return String.fromCharCode(97 + (b >> 4), 97 + (b & 15));
    });
    return letters.length ? `/avatar_${letters.join("")}` : null;
  } catch {
    return null;
  }
}

/** Data URL of a client's downloaded avatar, or null to fall back to initials. */
function clientAvatarUrl(client: ClientInfo, images: Record<string, string>): string | null {
  const path = client.avatarHash ? avatarPath(client.uid) : null;
  const base64 = path ? images[path] : undefined;
  return base64 ? iconDataUrl(base64) : null;
}

/** The initials tile, or the real avatar once it has been downloaded. */
function AvatarTile({
  client,
  images,
  className,
  isSelf,
}: {
  client: ClientInfo;
  images: Record<string, string>;
  className: string;
  isSelf: boolean;
}) {
  const url = clientAvatarUrl(client, images);
  const { tree } = useContext(DisplayPrefsContext);
  return (
    <span
      className={className}
      style={{ background: url ? undefined : isSelf ? "var(--accent)" : clientAvatarColor(client.name) }}
    >
      {url ? <StillImg still={!tree.animateAvatars} className="ts-avatar-img" src={url} alt="" /> : client.name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

// IDs below this are TeamSpeak's built-in default group icons - they ship
// inside the official client and were never uploaded to the server's icon
// filebase, so downloadFile() for them just hangs forever (nothing to send
// back). We don't have those graphics to embed, so those get a generic
// colored-letter badge instead; only real custom uploads (id >= threshold)
// are fetched as actual images.
const CUSTOM_ICON_ID_THRESHOLD = 1000;
// Keep in sync with WS_MAX_PAYLOAD in gateway/src/index.ts (base64 adds ~4/3).
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string; // data:*/*;base64,AAAA...
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Deterministic color for a group's letter badge - same icon id always
 *  produces the same hue, so a group looks consistent across the tree
 *  without needing the real (unavailable) TeamSpeak icon graphics. */
function groupBadgeColor(iconId: number): string {
  const hue = (iconId * 47) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

/** Nova-theme-only: a stable per-name color for the client avatar chips,
 *  hashed from the name so the same person always gets the same color. */
function clientAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `oklch(0.6 0.13 ${hue})`;
}

/** The icon repository lives under TS3's special "channel 0" - not a real,
 *  selectable channel, just the server-wide filebase icons are stored in.
 *  Icon files are always named "icon_<id>", where <id> is what a server/
 *  channel/group's icon field references. Reuses the same ftlist/download/
 *  upload/delete plumbing as the per-channel file browser. */
function ServerIconsDialog({
  entries,
  images,
  onUpload,
  onDelete,
  onClose,
}: {
  entries: FileListEntry[] | null;
  images: Record<string, string>;
  onUpload: (iconId: number, file: File) => void;
  onDelete: (entry: FileListEntry) => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const [timedOut, setTimedOut] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [newIconId, setNewIconId] = useState("");

  useEffect(() => {
    setTimedOut(false);
    if (entries) return;
    const id = window.setTimeout(() => setTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [entries]);

  const nextFreeId = () => {
    const ids = (entries ?? [])
      .map((e) => parseInt(e.name.replace("icon_", ""), 10))
      .filter((n) => !Number.isNaN(n));
    return (ids.length ? Math.max(...ids) : 99) + 1;
  };

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-server-icons-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("serverIcons.title")}</span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <div className="ts-file-browser-toolbar">
            <button
              onClick={() => {
                setNewIconId(String(nextFreeId()));
                fileInputRef.current?.click();
              }}
              title={t("serverIcons.upload")}
            >
              ⬆️ {t("serverIcons.upload")}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) setPendingFile(file);
              }}
            />
          </div>
          {pendingFile && (
            <form
              className="ts-dialog-row"
              onSubmit={(e) => {
                e.preventDefault();
                const id = parseInt(newIconId, 10);
                if (!Number.isNaN(id) && pendingFile) onUpload(id, pendingFile);
                setPendingFile(null);
              }}
            >
              <label className="ts-dialog-field">
                {t("serverIcons.iconId")}
                <input
                  type="number"
                  autoFocus
                  value={newIconId}
                  onChange={(e) => setNewIconId(e.target.value)}
                />
              </label>
              <button type="submit">{t("dialog.ok")}</button>
              <button type="button" onClick={() => setPendingFile(null)}>
                {t("dialog.cancel")}
              </button>
            </form>
          )}
          {!entries ? (
            <div className="ts-connection-info-loading">
              {timedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
            </div>
          ) : entries.length === 0 ? (
            <div className="ts-connection-info-loading">{t("serverIcons.empty")}</div>
          ) : (
            <div className="ts-server-icons-grid">
              {entries.map((entry) => {
                const path = `/${entry.name}`;
                const base64 = images[path];
                return (
                  <div className="ts-server-icons-tile" key={entry.name}>
                    {base64 ? (
                      <img src={iconDataUrl(base64)} alt={entry.name} />
                    ) : (
                      <div className="ts-server-icons-tile-loading" />
                    )}
                    <span>{entry.name.replace("icon_", "#")}</span>
                    <button onClick={() => onDelete(entry)} title={t("fileBrowser.delete")}>
                      🗑
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div />
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The five permission-editor tabs from the real TS3 "Rechte" window - each
 *  is a different scope the ts3 protocol tracks assigned permissions under. */
const PERM_SCOPES: { scope: PermScope; labelKey: string }[] = [
  { scope: "server", labelKey: "permsEditor.tab.server" },
  { scope: "client", labelKey: "permsEditor.tab.client" },
  { scope: "channel", labelKey: "permsEditor.tab.channel" },
  { scope: "channelgroup", labelKey: "permsEditor.tab.channelgroup" },
  { scope: "channelclient", labelKey: "permsEditor.tab.channelclient" },
];

function PermissionsEditorDialog({
  initialScope,
  channelGroups,
  serverGroups,
  channels,
  clients,
  entries: loadedEntries,
  catalog,
  onSelectTarget,
  onLoadCatalog,
  onAdd,
  onRemove,
  onClose,
}: {
  initialScope: PermScope;
  channelGroups: GroupEntry[] | null;
  serverGroups: GroupEntry[] | null;
  channels: ChannelInfo[];
  clients: ClientInfo[];
  entries: PermissionOverviewEntry[] | null;
  catalog: PermissionCatalogEntry[] | null;
  onSelectTarget: (scope: PermScope, id1: number, id2?: number) => void;
  onLoadCatalog: () => void;
  onAdd: (scope: PermScope, ids: number[], permId: number, value: number, negated: boolean, skip: boolean) => void;
  onRemove: (scope: PermScope, ids: number[], permId: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const [scope, setScope] = useState<PermScope>(initialScope);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [channelId, setChannelId] = useState<number | null>(null);
  const [clientDbIdInput, setClientDbIdInput] = useState("");
  const [filter, setFilter] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [addPermSearch, setAddPermSearch] = useState("");
  const [addPermId, setAddPermId] = useState<number | null>(null);
  const [addValue, setAddValue] = useState("1");
  const [addNegated, setAddNegated] = useState(false);
  const [addSkip, setAddSkip] = useState(false);

  const isGroupScope = scope === "server" || scope === "channelgroup";
  const groupList = scope === "server" ? serverGroups : scope === "channelgroup" ? channelGroups : null;
  // The channelgrouplist/servergrouplist requests decline silently when the
  // account lacks the permission to see them (no reply at all, same as
  // banlist/complainlist elsewhere) - without this, a permission-limited
  // account just sees a permanently blank panel with no explanation.
  const [groupsTimedOut, setGroupsTimedOut] = useState(false);
  useEffect(() => {
    setGroupsTimedOut(false);
    if (groupList) return;
    const id = window.setTimeout(() => setGroupsTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [groupList]);

  // (ids, ready) for the currently selected target under the active tab -
  // ready is false while a required piece (channel/client) hasn't been picked yet.
  const target: { id1: number; id2?: number } | null = (() => {
    const clientDbId = parseInt(clientDbIdInput, 10);
    switch (scope) {
      case "server":
      case "channelgroup":
        return groupId !== null ? { id1: groupId } : null;
      case "channel":
        return channelId !== null ? { id1: channelId } : null;
      case "client":
        return !Number.isNaN(clientDbId) ? { id1: clientDbId } : null;
      case "channelclient":
        return channelId !== null && !Number.isNaN(clientDbId) ? { id1: channelId, id2: clientDbId } : null;
      default:
        return null;
    }
  })();

  // Entries only count while they belong to the target on screen - after a
  // tab switch they'd otherwise show (and let you delete/add against) the
  // previous tab's target, e.g. server group 6 edited as channel group 6.
  const targetKey = target ? `${scope}:${target.id1}:${target.id2 ?? ""}` : null;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const entries = loadedKey !== null && loadedKey === targetKey ? loadedEntries : null;
  const select = (s: PermScope, id1: number, id2?: number) => {
    setLoadedKey(`${s}:${id1}:${id2 ?? ""}`);
    onSelectTarget(s, id1, id2);
  };

  const load = (next: { scope: PermScope; groupId?: number | null; channelId?: number | null; clientDbId?: number }) => {
    // The catalog doubles as the name->id lookup the delete button needs, so
    // fetch it alongside the first load rather than only when "+ Hinzufügen"
    // is opened - onLoadCatalog is idempotent (a no-op once already cached).
    onLoadCatalog();
    const s = next.scope;
    const gid = next.groupId !== undefined ? next.groupId : groupId;
    const cid = next.channelId !== undefined ? next.channelId : channelId;
    const cldbid = next.clientDbId !== undefined ? next.clientDbId : parseInt(clientDbIdInput, 10);
    if ((s === "server" || s === "channelgroup") && gid !== null && gid !== undefined) {
      select(s, gid);
    } else if (s === "channel" && cid !== null && cid !== undefined) {
      select(s, cid);
    } else if (s === "client" && !Number.isNaN(cldbid)) {
      select(s, cldbid);
    } else if (s === "channelclient" && cid !== null && cid !== undefined && !Number.isNaN(cldbid)) {
      select(s, cid, cldbid);
    }
  };

  const filtered = entries?.filter((e) => e.name.toLowerCase().includes(filter.toLowerCase())) ?? null;
  const showNegated = scope === "server";
  const showSkip = scope === "server" || scope === "client";

  const catalogFiltered = (catalog ?? [])
    .filter((p) => p.name.toLowerCase().includes(addPermSearch.toLowerCase()))
    .slice(0, 200); // keep the <select> responsive against the ~500-entry catalog

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-perms-editor-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("permsEditor.title")}</span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-perms-editor-tabs">
          {PERM_SCOPES.map((tab) => (
            <button
              key={tab.scope}
              className={`ts-perms-editor-tab${scope === tab.scope ? " ts-perms-editor-tab-active" : ""}`}
              onClick={() => {
                // Server and channel group ids overlap, so a picked group
                // never carries over between those two tabs.
                const switchesGroupKind = isGroupScope && tab.scope !== scope;
                if (switchesGroupKind) setGroupId(null);
                setScope(tab.scope);
                setShowAddForm(false);
                load({ scope: tab.scope, groupId: switchesGroupKind ? null : undefined });
              }}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>
        <div className="ts-dialog-body ts-perms-editor-body">
          <div className="ts-perms-editor-picker">
            {isGroupScope &&
              (groupList ? (
                <ul className="ts-perms-editor-list">
                  {groupList.length === 0 && (
                    <li className="ts-perms-editor-list-empty">{t("groupAssign.empty")}</li>
                  )}
                  {groupList.map((g) => (
                    <li key={g.id}>
                      <button
                        className={`ts-link-button${groupId === g.id ? " ts-perms-editor-selected" : ""}`}
                        onClick={() => {
                          setGroupId(g.id);
                          load({ scope, groupId: g.id });
                        }}
                      >
                        {g.name}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="ts-connection-info-loading">
                  {groupsTimedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
                </div>
              ))}
            {(scope === "channel" || scope === "channelclient") && (
              <ul className="ts-perms-editor-list">
                {channels.map((c) => (
                  <li key={c.id}>
                    <button
                      className={`ts-link-button${channelId === c.id ? " ts-perms-editor-selected" : ""}`}
                      onClick={() => {
                        setChannelId(c.id);
                        load({ scope, channelId: c.id });
                      }}
                    >
                      {c.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {(scope === "client" || scope === "channelclient") && (
              <div className="ts-perms-editor-client-picker">
                <label className="ts-dialog-field">
                  {t("permsEditor.clientDbId")}
                  <input
                    value={clientDbIdInput}
                    onChange={(e) => setClientDbIdInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && load({ scope })}
                    placeholder="1"
                  />
                </label>
                <button onClick={() => load({ scope })}>{t("permsEditor.load")}</button>
                {clients.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => {
                      const id = parseInt(e.target.value, 10);
                      if (!Number.isNaN(id)) {
                        setClientDbIdInput(String(id));
                        load({ scope, clientDbId: id });
                      }
                    }}
                  >
                    <option value="" disabled>
                      {t("permsEditor.pickOnlineClient")}
                    </option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.databaseId}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </div>
          <div className="ts-perms-editor-main">
            {!target ? (
              <div className="ts-connection-info-loading">{t("permsEditor.pickTarget")}</div>
            ) : (
              <>
                <div className="ts-dialog-row">
                  <label className="ts-dialog-field ts-dialog-field-grow">
                    {t("clientLog.filter")}
                    <input value={filter} onChange={(e) => setFilter(e.target.value)} />
                  </label>
                  <button
                    onClick={() => {
                      setShowAddForm((v) => !v);
                      if (!catalog) onLoadCatalog();
                    }}
                  >
                    + {t("permsEditor.addPermission")}
                  </button>
                </div>
                {showAddForm && (
                  <form
                    className="ts-perms-editor-add-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (addPermId === null || !target) return;
                      const value = parseInt(addValue, 10);
                      if (Number.isNaN(value)) return;
                      const ids = target.id2 !== undefined ? [target.id1, target.id2] : [target.id1];
                      onAdd(scope, ids, addPermId, value, addNegated, addSkip);
                      setShowAddForm(false);
                      setAddPermSearch("");
                      setAddPermId(null);
                    }}
                  >
                    <input
                      placeholder={t("permsEditor.searchPermission")}
                      value={addPermSearch}
                      onChange={(e) => setAddPermSearch(e.target.value)}
                    />
                    <select value={addPermId ?? ""} onChange={(e) => setAddPermId(parseInt(e.target.value, 10))}>
                      <option value="" disabled>
                        {t("permsEditor.searchPermission")}
                      </option>
                      {catalogFiltered.map((p) => (
                        <option key={p.id} value={p.id} title={p.description}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      value={addValue}
                      onChange={(e) => setAddValue(e.target.value)}
                      style={{ width: "5em" }}
                    />
                    {showNegated && (
                      <label>
                        <input type="checkbox" checked={addNegated} onChange={(e) => setAddNegated(e.target.checked)} />
                        {t("permissionOverview.negated")}
                      </label>
                    )}
                    {showSkip && (
                      <label>
                        <input type="checkbox" checked={addSkip} onChange={(e) => setAddSkip(e.target.checked)} />
                        {t("permissionOverview.skip")}
                      </label>
                    )}
                    <button type="submit" disabled={addPermId === null}>
                      {t("dialog.ok")}
                    </button>
                  </form>
                )}
                {!entries ? (
                  <div className="ts-connection-info-loading">{t("connectionInfo.loading")}</div>
                ) : filtered && filtered.length === 0 ? (
                  <div className="ts-connection-info-loading">{t("permissionOverview.empty")}</div>
                ) : (
                  <div className="ts-permission-overview-scroll">
                    <table className="ts-ban-list-table">
                      <thead>
                        <tr>
                          <th>{t("permissionOverview.name")}</th>
                          <th>{t("permissionOverview.value")}</th>
                          {showNegated && <th>{t("permissionOverview.negated")}</th>}
                          {showSkip && <th>{t("permissionOverview.skip")}</th>}
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {filtered!.map((entry, i) => {
                          const catalogEntry = catalog?.find((p) => p.name === entry.name);
                          return (
                            <tr key={`${entry.name}-${i}`} title={entry.description || undefined}>
                              <td>{entry.name}</td>
                              <td>{entry.value}</td>
                              {showNegated && <td>{entry.negated ? "✔️" : ""}</td>}
                              {showSkip && <td>{entry.skip ? "✔️" : ""}</td>}
                              <td>
                                {catalogEntry && (
                                  <button
                                    onClick={() => {
                                      const ids = target.id2 !== undefined ? [target.id1, target.id2] : [target.id1];
                                      onRemove(scope, ids, catalogEntry.id);
                                    }}
                                    title={t("fileBrowser.delete")}
                                  >
                                    🗑
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        <div className="ts-dialog-buttons">
          <button onClick={() => target && load({ scope })} disabled={!target}>
            {t("fileBrowser.refresh")}
          </button>
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PermissionOverviewDialog({
  entries,
  onClose,
}: {
  entries: PermissionOverviewEntry[] | null;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const [search, setSearch] = useState("");
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (entries) return;
    const id = window.setTimeout(() => setTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [entries]);

  const filtered = entries?.filter((e) => e.name.toLowerCase().includes(search.toLowerCase())) ?? null;

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-permission-overview-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("permissionOverview.title")}</span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          {!entries ? (
            <div className="ts-connection-info-loading">
              {timedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
            </div>
          ) : entries.length === 0 ? (
            <div className="ts-connection-info-loading">{t("permissionOverview.empty")}</div>
          ) : (
            <>
              <div className="ts-dialog-row">
                <label className="ts-dialog-field ts-dialog-field-grow">
                  {t("clientLog.filter")}
                  <input value={search} onChange={(e) => setSearch(e.target.value)} />
                </label>
              </div>
              <div className="ts-permission-overview-scroll">
                <table className="ts-ban-list-table">
                  <thead>
                    <tr>
                      <th>{t("permissionOverview.name")}</th>
                      <th>{t("permissionOverview.value")}</th>
                      <th>{t("permissionOverview.negated")}</th>
                      <th>{t("permissionOverview.skip")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered!.map((e, i) => (
                      <tr key={`${e.name}-${i}`} title={e.description || undefined}>
                        <td>{e.name}</td>
                        <td>{e.value}</td>
                        <td>{e.negated ? "✔️" : ""}</td>
                        <td>{e.skip ? "✔️" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div />
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ServerProtocolLogDialog({
  lines,
  onClose,
}: {
  lines: string[] | null;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  // The server may silently decline (e.g. missing b_virtualserver_log_view
  // permission) without ever replying - fall back to an error instead of
  // spinning forever.
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (lines) return;
    const id = window.setTimeout(() => setTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [lines]);

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-server-protocol-log-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("serverProtocolLog.title")}</span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          {!lines ? (
            <div className="ts-connection-info-loading">
              {timedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
            </div>
          ) : lines.length === 0 ? (
            <div className="ts-connection-info-loading">{t("serverProtocolLog.empty")}</div>
          ) : (
            <div className="ts-log-list">
              {lines.map((line, i) => (
                <div key={i} className="ts-server-protocol-log-line">
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WhisperHistoryDialog({
  serverName,
  entries,
  onClear,
  onClose,
}: {
  serverName: string;
  entries: WhisperLogEntry[];
  onClear: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-whisper-history-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("whisperHistory.title", { server: serverName })}</span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <div className="ts-whisper-history-list">
            {entries.length === 0 && (
              <div className="ts-whisper-history-empty">{t("whisperHistory.empty")}</div>
            )}
            {entries.map((e) => (
              <div key={e.id} className="ts-whisper-history-row">
                <span className="ts-log-time">{new Date(e.timestamp).toLocaleString()}</span>
                <span>{e.description}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="ts-dialog-buttons">
          <button onClick={onClear}>{t("whisperHistory.clear")}</button>
          <div className="ts-dialog-buttons-right">
            <button disabled title={t("clientContext.notSupported")}>
              {t("whisperHistory.options")}
            </button>
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WhisperListsDialog({
  lists,
  hasCurrentSelection,
  onSave,
  onActivate,
  onDelete,
  onClose,
}: {
  lists: WhisperList[];
  hasCurrentSelection: boolean;
  onSave: (name: string) => void;
  onActivate: (list: WhisperList) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const [nameDraft, setNameDraft] = useState("");

  const handleSave = () => {
    const name = nameDraft.trim();
    if (!name || !hasCurrentSelection) return;
    onSave(name);
    setNameDraft("");
  };

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-whisper-lists-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("whisperLists.title")}</span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <div className="ts-dialog-row">
            <input
              placeholder={t("whisperLists.namePlaceholder")}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
            />
            <button disabled={!nameDraft.trim() || !hasCurrentSelection} onClick={handleSave}>
              {t("whisperLists.saveCurrent")}
            </button>
          </div>
          <ul className="ts-whisper-lists-list">
            {lists.map((list) => (
              <li key={list.id} className="ts-whisper-lists-item">
                <div className="ts-whisper-lists-item-info">
                  <span className="ts-whisper-lists-item-name">{list.name}</span>
                  <span className="ts-whisper-lists-item-detail">
                    {t("whisperLists.itemDetail", {
                      channels: String(list.channelNames.length),
                      clients: String(list.clientNames.length),
                    })}
                  </span>
                </div>
                <div className="ts-whisper-lists-item-actions">
                  <button onClick={() => onActivate(list)}>{t("whisperLists.activate")}</button>
                  <button onClick={() => onDelete(list.id)}>{t("whisperLists.delete")}</button>
                </div>
              </li>
            ))}
            {lists.length === 0 && <li className="ts-whisper-lists-empty">{t("whisperLists.empty")}</li>}
          </ul>
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ClientConnectionInfoDialog({
  clientName,
  info,
  onClose,
}: {
  clientName: string;
  info: ClientConnectionInfoData | null;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  // The server may silently decline (e.g. missing permission to view another
  // client's connection info) without ever replying - fall back to an error
  // instead of spinning forever.
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (info) return;
    const id = window.setTimeout(() => setTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [info, clientName]);

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-connection-info-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("connectionInfo.clientTitle", { name: clientName })}</span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          {!info ? (
            <div className="ts-connection-info-loading">
              {timedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
            </div>
          ) : (
            <div className="ts-connection-info-grid">
              <span>{t("connectionInfo.ping")}</span>
              <span>{info.pingMs != null ? `${info.pingMs.toFixed(1)} ms` : "-"}</span>
              <span>{t("connectionInfo.connectedSince")}</span>
              <span>{info.connectedSecs != null ? formatDurationSecs(info.connectedSecs) : "-"}</span>
              <span>{t("connectionInfo.ip")}</span>
              <span>{info.ip ?? "-"}</span>
              <span>{t("connectionInfo.packetLoss")}</span>
              <span>{info.packetLossPercent.toFixed(2)}%</span>
              <span>{t("connectionInfo.packetsSent")}</span>
              <span>{info.packetsSent.toLocaleString()}</span>
              <span>{t("connectionInfo.packetsReceived")}</span>
              <span>{info.packetsReceived.toLocaleString()}</span>
              <span>{t("connectionInfo.bytesSent")}</span>
              <span>{formatBytes(info.bytesSent)}</span>
              <span>{t("connectionInfo.bytesReceived")}</span>
              <span>{formatBytes(info.bytesReceived)}</span>
            </div>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ServerConnectionInfoDialog({
  info,
  serverName,
  host,
  serverVersion,
  serverLicense,
  onClose,
}: {
  info: ServerConnectionInfoData | null;
  serverName: string;
  host: string;
  serverVersion: string;
  serverLicense: string;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  // The server may silently decline (e.g. missing b_virtualserver_connectioninfo_view
  // permission) without ever replying - fall back to an error instead of spinning forever.
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (info) return;
    const id = window.setTimeout(() => setTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [info]);

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-connection-info-dialog ts-server-conn-info" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("connectionInfo.serverTitle")}</span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          {!info ? (
            <div className="ts-connection-info-loading">
              {timedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
            </div>
          ) : (
            <>
              <div className="ts-connection-info-grid">
                <span>{t("connectionInfo.name")}</span>
                <span>{serverName || host}</span>
                <span>{t("info.address")}</span>
                <span>{host}</span>
                {serverVersion ? (
                  <>
                    <span>{t("info.version")}</span>
                    <span>{serverVersion}</span>
                  </>
                ) : null}
                {serverLicense ? (
                  <>
                    <span>{t("info.license")}</span>
                    <span>{serverLicense}</span>
                  </>
                ) : null}
                <span>{t("connectionInfo.uptime")}</span>
                <span>{formatDurationSecs(info.connectedSecs)}</span>
                <span>{t("connectionInfo.avgPing")}</span>
                <span>{Math.round(info.pingMs)} ms</span>
                <span>{t("connectionInfo.avgPacketLoss")}</span>
                <span>{info.packetLossPercent.toFixed(2)} %</span>
              </div>
              <table className="ts-server-conn-table">
                <thead>
                  <tr>
                    <th />
                    <th>{t("connectionInfo.incoming")}</th>
                    <th>{t("connectionInfo.outgoing")}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{t("connectionInfo.packetsTransferred")}</td>
                    <td>{formatCount(info.packetsReceivedTotal)}</td>
                    <td>{formatCount(info.packetsSentTotal)}</td>
                  </tr>
                  <tr>
                    <td>{t("connectionInfo.bytesTransferred")}</td>
                    <td>{formatBytes(info.bytesReceivedTotal)}</td>
                    <td>{formatBytes(info.bytesSentTotal)}</td>
                  </tr>
                  <tr>
                    <td>{t("connectionInfo.bandwidthLastSecond")}</td>
                    <td>{formatRate(info.bandwidthReceivedLastSecond)}</td>
                    <td>{formatRate(info.bandwidthSentLastSecond)}</td>
                  </tr>
                  <tr>
                    <td>{t("connectionInfo.bandwidthLastMinute")}</td>
                    <td>{formatRate(info.bandwidthReceivedLastMinute)}</td>
                    <td>{formatRate(info.bandwidthSentLastMinute)}</td>
                  </tr>
                  <tr>
                    <td>{t("connectionInfo.ftBandwidth")}</td>
                    <td>{formatRate(info.filetransferBandwidthReceived)}</td>
                    <td>{formatRate(info.filetransferBandwidthSent)}</td>
                  </tr>
                  <tr>
                    <td>{t("connectionInfo.ftBytes")}</td>
                    <td>{formatBytes(info.filetransferBytesReceived)}</td>
                    <td>{formatBytes(info.filetransferBytesSent)}</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Mirrors the native client's "Identitäten" window: a list on the left plus
 *  a detail panel on the right (Name/Nickname/Phonetischer Nickname/
 *  Eindeutige ID), rather than the old flat list-with-inline-rename layout.
 *  The native window also has a myTeamSpeak-synced identity list and a
 *  "Sicherheitsstufe erhöhen" button - both deliberately out of scope here:
 *  the former needs a whole separate cloud-account system this self-hosted
 *  client doesn't have, and the latter (tsclientlib's proof-of-work identity
 *  level increase) already runs automatically during connect whenever a
 *  server demands a higher level, so there's nothing a manual button would
 *  add beyond letting you pre-compute it before connecting. */
function IdentitiesDialog({
  identities,
  activeId,
  ownUid,
  onActivate,
  onAdd,
  onRename,
  onNicknameChange,
  onPhoneticChange,
  onDelete,
  onExport,
  onImport,
  onClose,
}: {
  identities: Identity[];
  activeId: string | null;
  /** The connected own client's unique ID, if currently connected with the
   *  active identity - shown as that identity's "Eindeutige ID". */
  ownUid: string | null;
  onActivate: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onNicknameChange: (id: string, value: string) => void;
  onPhoneticChange: (id: string, value: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  onImport: (file: File) => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState(activeId ?? identities[0]?.id ?? null);
  const selected = identities.find((i) => i.id === selectedId) ?? identities[0] ?? null;
  const [computedUid, setComputedUid] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setComputedUid(null);
    if (selected?.blob) void identityUid(selected.blob).then((uid) => current && setComputedUid(uid));
    return () => {
      current = false;
    };
  }, [selected?.blob]);

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-identities-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("identities.title")}</span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body ts-identities-body">
          <div>
            <div className="ts-identities-list-label">{t("identities.listLabel")}</div>
            <ul className="ts-identities-list">
              {identities.map((identity) => (
                <li key={identity.id}>
                  <button
                    className={`ts-link-button ts-identities-list-item${
                      identity.id === selectedId ? " ts-perms-editor-selected" : ""
                    }${identity.id === activeId ? " ts-identities-list-item-default" : ""}`}
                    onClick={() => setSelectedId(identity.id)}
                    title={identity.id === activeId ? t("identities.isDefault") : undefined}
                  >
                    {identity.id === activeId ? "★ " : ""}
                    {identity.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="ts-identities-detail">
            {selected && (
              <>
                <label className="ts-dialog-field">
                  {t("identities.name")}
                  <input value={selected.name} onChange={(e) => onRename(selected.id, e.target.value)} />
                </label>
                <label className="ts-dialog-field">
                  {t("connect.nickname")}
                  <input
                    value={selected.nickname}
                    onChange={(e) => onNicknameChange(selected.id, e.target.value)}
                  />
                </label>
                <label className="ts-dialog-field">
                  {t("identities.phoneticNickname")}
                  <input
                    value={selected.phoneticName}
                    onChange={(e) => onPhoneticChange(selected.id, e.target.value)}
                  />
                </label>
                <label className="ts-dialog-field">
                  {t("identities.uniqueId")}
                  <input
                    readOnly
                    value={computedUid || (selected.id === activeId && ownUid) || t("identities.unknown")}
                    className="ts-identities-readonly ts-identities-uid"
                  />
                </label>
                <div className="ts-identities-status">
                  {selected.blob ? t("identities.generated") : t("identities.pending")}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="ts-dialog-buttons">
          <div>
            <button onClick={onAdd}>{t("identities.add")}</button>
            <button onClick={() => importInputRef.current?.click()}>{t("identities.import")}</button>
            <input
              ref={importInputRef}
              type="file"
              accept=".json,.ini,application/json,text/plain"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) onImport(file);
              }}
            />
            {selected && (
              <>
                <button disabled={!selected.blob} onClick={() => onExport(selected.id)}>
                  {t("identities.export")}
                </button>
                <button onClick={() => onActivate(selected.id)} disabled={selected.id === activeId}>
                  {t("identities.setDefault")}
                </button>
                <button
                  disabled={identities.length <= 1}
                  onClick={() => {
                    const wasActive = selected.id === activeId;
                    const idx = identities.findIndex((i) => i.id === selected.id);
                    onDelete(selected.id);
                    if (selected.id === selectedId) {
                      const remaining = identities.filter((i) => i.id !== selected.id);
                      setSelectedId((wasActive ? remaining[0] : remaining[Math.max(0, idx - 1)])?.id ?? null);
                    }
                  }}
                >
                  {t("identities.delete")}
                </button>
              </>
            )}
          </div>
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ContactsDialog({
  contacts,
  onlineClients,
  onSave,
  onWhisper,
  onShow,
  onClose,
}: {
  contacts: Contact[];
  onlineClients: ClientInfo[];
  onSave: (contacts: Contact[]) => void;
  onWhisper: (clientId: number) => void;
  onShow: (clientId: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const [draft, setDraft] = useState<Contact[]>(() => contacts.map((c) => ({ ...c })));
  const [selectedUid, setSelectedUid] = useState<string | null>(draft[0]?.uid ?? null);
  const [addClientId, setAddClientId] = useState("");

  const selected = draft.find((c) => c.uid === selectedUid) ?? null;
  const displayName = (c: Contact) => {
    const online = onlineClients.find((cl) => cl.uid === c.uid);
    return c.customName || online?.name || c.uid;
  };

  const updateSelected = (patch: Partial<Contact>) => {
    if (!selectedUid) return;
    setDraft((prev) => prev.map((c) => (c.uid === selectedUid ? { ...c, ...patch } : c)));
  };

  const save = (next: Contact[]) => {
    setDraft(next);
    onSave(next);
  };

  const handleAdd = () => {
    const client = onlineClients.find((c) => String(c.id) === addClientId);
    if (!client || !client.uid || draft.some((c) => c.uid === client.uid)) return;
    const contact: Contact = {
      uid: client.uid,
      customName: client.name,
      category: "acquaintance",
      phoneticName: "",
      ignored: false,
    };
    save([...draft, contact]);
    setSelectedUid(contact.uid);
    setAddClientId("");
  };

  const handleRemove = () => {
    if (!selectedUid) return;
    save(draft.filter((c) => c.uid !== selectedUid));
    setSelectedUid(null);
  };

  const addableClients = onlineClients.filter(
    (c) => c.uid && !draft.some((contact) => contact.uid === c.uid)
  );
  const selectedOnlineClient = selected ? onlineClients.find((c) => c.uid === selected.uid) : undefined;

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-contacts-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("contacts.title")}</span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-contacts-body">
          <div className="ts-contacts-list-col">
            <div className="ts-dialog-row">
              <select value={addClientId} onChange={(e) => setAddClientId(e.target.value)}>
                <option value="">{t("contacts.addOnlineClient")}</option>
                {addableClients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button disabled={!addClientId} onClick={handleAdd}>
                {t("contacts.add")}
              </button>
            </div>
            <ul className="ts-contacts-list">
              {draft.map((c) => (
                <li
                  key={c.uid}
                  className={`ts-contacts-list-item ts-contacts-category-${c.category}${c.uid === selectedUid ? " ts-contacts-list-item-selected" : ""}`}
                  onClick={() => setSelectedUid(c.uid)}
                >
                  <button type="button" className="ts-plain-button" aria-current={c.uid === selectedUid}>
                    {onlineClients.some((cl) => cl.uid === c.uid) && <span className="ts-contacts-online-dot" />}
                    {displayName(c)}
                    {c.ignored && " 🚫"}
                  </button>
                </li>
              ))}
              {draft.length === 0 && <li className="ts-contacts-list-empty">{t("contacts.empty")}</li>}
            </ul>
          </div>
          <div className="ts-contacts-fields-col">
            <label className="ts-dialog-field">
              {t("contacts.customName")}
              <input
                disabled={!selected}
                value={selected?.customName ?? ""}
                onChange={(e) => updateSelected({ customName: e.target.value })}
              />
            </label>
            <div className="ts-contacts-category-group">
              {(["acquaintance", "blocked", "friend"] as ContactCategory[]).map((cat) => (
                <label key={cat} className="ts-dialog-checkbox">
                  <input
                    type="radio"
                    name="contact-category"
                    disabled={!selected}
                    checked={selected?.category === cat}
                    onChange={() => updateSelected({ category: cat })}
                  />
                  {t(`contacts.category.${cat}`)}
                </label>
              ))}
            </div>
            <label className="ts-dialog-field">
              {t("contacts.phoneticName")}
              <input
                disabled={!selected}
                value={selected?.phoneticName ?? ""}
                onChange={(e) => updateSelected({ phoneticName: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              {t("contacts.whisperSetting")}
              <select
                disabled={!selected}
                value={selected?.whisper ?? ""}
                onChange={(e) => updateSelected({ whisper: (e.target.value || undefined) as Contact["whisper"] })}
              >
                <option value="">{t("contacts.whisperSetting.default")}</option>
                <option value="allow">{t("contacts.whisperSetting.allow")}</option>
                <option value="block">{t("contacts.whisperSetting.block")}</option>
              </select>
            </label>
            <div className="ts-contacts-actions">
              <button
                disabled={!selectedOnlineClient}
                onClick={() => selectedOnlineClient && onShow(selectedOnlineClient.id)}
              >
                {t("contacts.show")}
              </button>
              <button disabled={!selected} onClick={() => updateSelected({ ignored: !selected?.ignored })}>
                {selected?.ignored ? t("contacts.unignore") : t("contacts.ignore")}
              </button>
              <button
                disabled={!selectedOnlineClient}
                onClick={() => selectedOnlineClient && onWhisper(selectedOnlineClient.id)}
              >
                {t("contacts.whisper")}
              </button>
            </div>
          </div>
        </div>
        <div className="ts-dialog-buttons">
          <button onClick={handleRemove} disabled={!selected}>
            {t("contacts.remove")}
          </button>
          <div className="ts-dialog-buttons-right">
            <button disabled title={t("clientContext.notSupported")}>
              {t("contacts.preferences")}
            </button>
            <button
              onClick={() => {
                onSave(draft);
                onClose();
              }}
            >
              {t("dialog.close")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AwayDialog({
  message,
  presets,
  onMessageChange,
  onOk,
  onSaveTemplate,
  onCancel,
}: {
  message: string;
  presets: MessagePreset[];
  onMessageChange: (v: string) => void;
  onOk: () => void;
  onSaveTemplate: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onCancel);
  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-away-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("away.dialog.title")}</span>
          <button onClick={onCancel} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <div className="ts-dialog-row">
            <span className="ts-dialog-away-label">{t("away.dialog.message")}</span>
            <label className="ts-dialog-field">
              {t("away.dialog.template")}
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) onMessageChange(e.target.value);
                }}
              >
                <option value="">{t("away.dialog.none")}</option>
                {presets.map((p) => (
                  <option key={p.name} value={p.message}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <input
            autoFocus
            className="ts-away-message-input"
            value={message}
            onChange={(e) => onMessageChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onOk()}
          />
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={onOk}>{t("away.dialog.ok")}</button>
            <button onClick={onSaveTemplate} disabled={!message.trim()}>
              {t("away.dialog.save")}
            </button>
            <button onClick={onCancel}>{t("away.dialog.cancel")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const OPTIONS_SECTIONS = [
  { id: "anwendung", icon: "🎧" },
  { id: "konto", icon: "👤" },
  { id: "wiedergabe", icon: "🔊" },
  { id: "aufnahme", icon: "🎙️" },
  { id: "sounds", icon: "🔔" },
  { id: "design", icon: "🖌️" },
  { id: "erweiterungen", icon: "🧩" },
  { id: "hotkeys", icon: "⌨️" },
  { id: "whispern", icon: "🤫" },
  { id: "downloads", icon: "⬇️" },
  { id: "chat", icon: "💬" },
  { id: "sicherheit", icon: "🛡️" },
  { id: "nachrichten", icon: "🔤" },
  { id: "meldungen", icon: "ℹ️" },
] as const;

interface AudioSettings {
  outputDevices: MediaDeviceInfo[];
  outputDeviceId: string;
  onOutputDeviceChange: (id: string, label?: string) => void;
  onRefreshOutputDevices: () => void;
  playbackVolume: number;
  onPlaybackVolumeChange: (v: number) => void;
  autoVolume: boolean;
  onAutoVolumeChange: (v: boolean) => void;
  ownMicClicks: boolean;
  onOwnMicClicksChange: (v: boolean) => void;
  otherMicClicks: boolean;
  onOtherMicClicksChange: (v: boolean) => void;
  onPlayTestTone: () => void;
  inputDevices: MediaDeviceInfo[];
  inputDeviceId: string;
  onInputDeviceChange: (id: string) => void;
  onRefreshInputDevices: () => void;
  micOn: boolean;
  micLevelRef: React.MutableRefObject<number>;
  micTestOn: boolean;
  onToggleMicTest: () => void;
  vadThreshold: number;
  onVadThresholdChange: (v: number) => void;
  vadHangover: number;
  onVadHangoverChange: (v: number) => void;
  pushToTalk: boolean;
  onPushToTalkChange: (on: boolean) => void;
  continuous: boolean;
  onContinuousChange: (on: boolean) => void;
  typingAttenuation: boolean;
  onTypingAttenuationChange: (on: boolean) => void;
  pttBinding: PttBinding | null;
  onPttBindingChange: (binding: PttBinding) => void;
  noiseSuppressionEnabled: boolean;
  onToggleNoiseSuppression: () => void;
  echoCancellationEnabled: boolean;
  onToggleEchoCancellation: () => void;
  autoGainControlEnabled: boolean;
  onToggleAutoGainControl: () => void;
  aec3Enabled: boolean;
  aec3Loading: boolean;
  onToggleAec3: () => void;
}

function PttKeyButton({ binding, onChange }: { binding: PttBinding | null; onChange: (b: PttBinding) => void }) {
  const t = useT();
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    // Capture phase on window: the next key or mouse button wins wherever the
    // pointer is, and never reaches the dialog (Escape) or the live PTT listener.
    const take = (e: Event, next?: PttBinding) => {
      e.preventDefault();
      e.stopPropagation();
      setListening(false);
      if (next) onChange(next);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") return setListening(false);
      take(e, e.key === "Escape" ? undefined : { code: e.code, label: keyBindingLabel(e) });
    };
    const onMouse = (e: MouseEvent) => {
      // Left click is how you started (and how you click away), so it can't be PTT.
      if (e.button === 0) return setListening(false);
      take(e, { code: `Mouse${e.button}`, label: `Mouse ${e.button + 1}` });
      // The back/forward side buttons navigate on release; keep the page.
      window.addEventListener("mouseup", (up) => up.preventDefault(), { capture: true, once: true });
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onMouse, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onMouse, true);
    };
  }, [listening, onChange]);
  return (
    <button className={listening ? "ts-ptt-key-listening" : undefined} onClick={() => setListening(true)}>
      {listening ? t("recording.pttKeyPress") : (binding?.label ?? t("recording.pttKeyNone"))}
    </button>
  );
}

function HotkeysPanel({ audio }: { audio: AudioSettings }) {
  const t = useT();
  return (
    <>
      <h3>{t("options.section.hotkeys")}</h3>
      <p className="ts-options-subtitle">{t("hotkeys.subtitle")}</p>
      <fieldset className="ts-options-fieldset">
        <legend>{t("recording.pushToTalk")}</legend>
        <label className="ts-options-checkbox">
          <input type="checkbox" checked={audio.pushToTalk} onChange={(e) => audio.onPushToTalkChange(e.target.checked)} />
          {t("hotkeys.pttEnabled")}
        </label>
        <div className="ts-options-field-row">
          {t("recording.pttKey")}
          <PttKeyButton binding={audio.pttBinding} onChange={audio.onPttBindingChange} />
        </div>
        <p className="ts-options-hint">{t("recording.pttHint")}</p>
      </fieldset>
      <fieldset className="ts-options-fieldset">
        <legend>{t("hotkeys.shortcuts")}</legend>
        <table className="ts-hotkeys-table">
          <tbody>
            {(
              [
                ["Ctrl + S", "menu.connections.connect"],
                ["Ctrl + D", "menu.connections.disconnectCurrent"],
                ["Ctrl + B", "menu.favorites.add"],
              ] as const
            ).map(([keys, label]) => (
              <tr key={keys}>
                <td>
                  <kbd>{keys}</kbd>
                </td>
                <td>{t(label)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="ts-options-hint">{t("hotkeys.shortcutsHint")}</p>
      </fieldset>
    </>
  );
}

function MicLevelBar({ levelRef, active }: { levelRef: React.MutableRefObject<number>; active: boolean }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!active) {
      setLevel(0);
      return;
    }
    let raf = 0;
    const tick = () => {
      setLevel(levelRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, levelRef]);
  const pct = Math.min(100, Math.round((level / 0.2) * 100));
  return (
    <div className="ts-options-level-track">
      <div className="ts-options-level-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

function WiedergabePanel({ audio }: { audio: AudioSettings }) {
  const t = useT();
  const volumeDb = Math.round(20 * Math.log10(audio.playbackVolume || 0.001) * 10) / 10;
  return (
    <>
      <h3>{t("playback.title")}</h3>
      <p className="ts-options-subtitle">{t("playback.subtitle")}</p>
      <div className="ts-options-field-row">
        <label>{t("playback.profile")}</label>
      </div>
      <div className="ts-options-columns">
        <ul className="ts-options-profile-list">
          <li className="ts-options-profile-item-active">{t("playback.default")}</li>
        </ul>
        <div className="ts-options-fields">
          <label className="ts-options-field">
            {t("playback.device")}
            <select
              value={audio.outputDeviceId}
              onFocus={audio.onRefreshOutputDevices}
              onChange={(e) => audio.onOutputDeviceChange(e.target.value)}
            >
              <option value="">{t("playback.systemDefault")}</option>
              {audio.outputDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Output ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </label>
          <div className="ts-options-slider-row">
            <span>{t("playback.quiet")}</span>
            <span className="ts-options-slider-label">{t("playback.voiceVolume")}</span>
            <span>{t("playback.loud")}</span>
          </div>
          <div className="ts-options-slider-with-value">
            <input
              type="range"
              min={0}
              max={2}
              step={0.02}
              value={audio.playbackVolume}
              onChange={(e) => audio.onPlaybackVolumeChange(Number(e.target.value))}
            />
            <span className="ts-options-db-value">
              {volumeDb > 0 ? "+" : ""}
              {volumeDb} dB
            </span>
          </div>
          <button onClick={audio.onPlayTestTone}>{t("playback.playTestTone")}</button>
          <fieldset className="ts-options-fieldset">
            <legend>{t("playback.options")}</legend>
            <label className="ts-options-checkbox">
              <input type="checkbox" checked={audio.autoVolume} onChange={(e) => audio.onAutoVolumeChange(e.target.checked)} />
              {t("playback.autoVolume")}
            </label>
            <label className="ts-options-checkbox">
              <input type="checkbox" checked={audio.ownMicClicks} onChange={(e) => audio.onOwnMicClicksChange(e.target.checked)} />
              {t("playback.ownMicClicks")}
            </label>
            <label className="ts-options-checkbox">
              <input type="checkbox" checked={audio.otherMicClicks} onChange={(e) => audio.onOtherMicClicksChange(e.target.checked)} />
              {t("playback.otherMicClicks")}
            </label>
          </fieldset>
        </div>
      </div>
    </>
  );
}

function AufnahmePanel({ audio }: { audio: AudioSettings }) {
  const t = useT();
  return (
    <>
      <h3>{t("recording.title")}</h3>
      <p className="ts-options-subtitle">{t("recording.subtitle")}</p>
      <div className="ts-options-columns">
        <ul className="ts-options-profile-list">
          <li className="ts-options-profile-item-active">{t("playback.default")}</li>
        </ul>
        <div className="ts-options-fields">
          <label className="ts-options-field">
            {t("recording.device")}
            <select
              value={audio.inputDeviceId}
              onFocus={audio.onRefreshInputDevices}
              onChange={(e) => audio.onInputDeviceChange(e.target.value)}
            >
              <option value="">{t("playback.systemDefault")}</option>
              {audio.inputDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Input ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="ts-options-fieldset">
            <legend>{t("recording.activation")}</legend>
            <label className="ts-options-radio">
              <input
                type="radio"
                name="activation"
                checked={audio.pushToTalk}
                onChange={() => audio.onPushToTalkChange(true)}
              />
              {t("recording.pushToTalk")}
            </label>
            {audio.pushToTalk && (
              <>
                <div className="ts-options-field-row">
                  {t("recording.pttKey")}
                  <PttKeyButton binding={audio.pttBinding} onChange={audio.onPttBindingChange} />
                </div>
                <p className="ts-options-hint">{t("recording.pttHint")}</p>
              </>
            )}
            <label className="ts-options-radio">
              <input
                type="radio"
                name="activation"
                checked={!audio.pushToTalk && audio.continuous}
                onChange={() => {
                  audio.onPushToTalkChange(false);
                  audio.onContinuousChange(true);
                }}
              />
              {t("recording.continuous")}
            </label>
            <label className="ts-options-radio">
              <input
                type="radio"
                name="activation"
                checked={!audio.pushToTalk && !audio.continuous}
                onChange={() => {
                  audio.onPushToTalkChange(false);
                  audio.onContinuousChange(false);
                }}
              />
              {t("recording.voiceActivation")}
            </label>
            <div className="ts-options-level-wrap">
              <MicLevelBar levelRef={audio.micLevelRef} active={audio.micOn} />
              <input
                className="ts-options-level-threshold"
                type="range"
                min={0.002}
                max={0.15}
                step={0.002}
                value={audio.vadThreshold}
                onChange={(e) => audio.onVadThresholdChange(Number(e.target.value))}
              />
            </div>
            <div className="ts-options-field-row">
              <button onClick={audio.onToggleMicTest} disabled={!audio.micOn}>
                {audio.micTestOn ? t("recording.testStop") : t("recording.testStart")}
              </button>
              <span className={`ts-options-test-dot${audio.micTestOn ? " ts-options-test-dot-on" : ""}`} />
              <label className="ts-options-field-inline">
                {t("recording.hangoverDelay")}
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={audio.vadHangover}
                  onChange={(e) => audio.onVadHangoverChange(Number(e.target.value))}
                />
                {t("recording.secondsUnit")}
              </label>
            </div>
          </fieldset>
          <fieldset className="ts-options-fieldset">
            <legend>{t("recording.dsp")}</legend>
            <div className="ts-options-dsp-grid">
              <label className="ts-options-checkbox">
                <input
                  type="checkbox"
                  checked={audio.typingAttenuation}
                  onChange={(e) => audio.onTypingAttenuationChange(e.target.checked)}
                />
                {t("recording.typingAttenuation")}
              </label>
              <label className="ts-options-checkbox">
                <input
                  type="checkbox"
                  checked={audio.echoCancellationEnabled}
                  disabled={audio.aec3Enabled}
                  onChange={audio.onToggleEchoCancellation}
                />
                {t("recording.echoCancellation")}
              </label>
              <label className="ts-options-checkbox">
                <input
                  type="checkbox"
                  checked={audio.noiseSuppressionEnabled}
                  onChange={audio.onToggleNoiseSuppression}
                />
                {t("recording.noiseSuppression")}
              </label>
              <label className="ts-options-checkbox">
                <input
                  type="checkbox"
                  checked={audio.autoGainControlEnabled}
                  onChange={audio.onToggleAutoGainControl}
                />
                {t("recording.autoGainControl")}
              </label>
              <label className="ts-options-checkbox">
                <input
                  type="checkbox"
                  checked={audio.aec3Enabled}
                  disabled={audio.aec3Loading}
                  onChange={audio.onToggleAec3}
                />
                {t("recording.aec3")}
                {audio.aec3Loading ? "…" : ""}
              </label>
            </div>
          </fieldset>
        </div>
      </div>
    </>
  );
}

function AnwendungPanel({
  showServerBanner,
  onShowServerBannerChange,
  chatImages,
  onChatImagesChange,
}: {
  showServerBanner: boolean;
  onShowServerBannerChange: (on: boolean) => void;
  chatImages: boolean;
  onChatImagesChange: (on: boolean) => void;
}) {
  const t = useT();
  const { langPref, setLangPref } = useLanguage();
  const [settings, setSettings] = useState(loadAppSettings);
  const check = (key: keyof AppSettings) => (
    <label className="ts-options-checkbox">
      <input
        type="checkbox"
        checked={settings[key]}
        onChange={(e) => {
          const next = { ...settings, [key]: e.target.checked };
          setSettings(next);
          localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(next));
        }}
      />
      {t(`app.${key}`)}
    </label>
  );
  return (
    <>
      <h3>{t("app.title")}</h3>
      <p className="ts-options-subtitle">{t("app.subtitle")}</p>
      <div className="ts-options-columns">
        <div className="ts-options-fields">
          <fieldset className="ts-options-fieldset">
            <legend>{t("app.group.server")}</legend>
            {check("micOnServerSwitch")}
            {check("reconnectAfterSleep")}
            {check("middleClickQuickAccess")}
            {check("updateFavoriteNickname")}
          </fieldset>
          <fieldset className="ts-options-fieldset">
            <legend>{t("app.group.misc")}</legend>
            {check("autoOpenChannelChat")}
            {check("mutedTalkingSound")}
            {check("neverShowPokeDialog")}
          </fieldset>
          <fieldset className="ts-options-fieldset">
            <legend>{t("app.group.subscribe")}</legend>
            <label className="ts-options-radio">
              <input type="radio" name="ts-app-subscribe" checked readOnly />
              {t("app.subscribe.all")}
            </label>
            {/* The connector always subscribes everything; "current only" needs connector work. */}
            <label className="ts-options-radio ts-options-disabled" title={t("design.notAvailable")}>
              <input type="radio" name="ts-app-subscribe" disabled />
              {t("app.subscribe.current")}
            </label>
          </fieldset>
        </div>
        <div className="ts-options-fields">
          <label className="ts-options-field">
            {t("app.language")}
            <select value={langPref} onChange={(e) => setLangPref(e.target.value as LangPref)}>
              <option value="auto">{t("app.language.auto")}</option>
              <option value="de">{t("app.language.de")}</option>
              <option value="en">{t("app.language.en")}</option>
              <option value="zh-CN">{t("app.language.zh-CN")}</option>
              <option value="fa">{t("app.language.fa")}</option>
              <option value="cs-CZ">{t("app.language.cs-CZ")}</option>
              <option value="ru">{t("app.language.ru")}</option>
            </select>
          </label>
          <p className="ts-options-hint">
            <a href="https://hosted.weblate.org/projects/webspeak3/" target="_blank" rel="noreferrer">
              {t("app.language.helpTranslate")}
            </a>
          </p>
          <fieldset className="ts-options-fieldset">
            <legend>{t("app.group.privacy")}</legend>
            <label className="ts-options-checkbox">
              <input type="checkbox" checked={showServerBanner} onChange={(e) => onShowServerBannerChange(e.target.checked)} />
              {t("app.serverBanner")}
            </label>
            <p className="ts-options-hint">{t("app.serverBanner.hint")}</p>
            <label className="ts-options-checkbox">
              <input type="checkbox" checked={chatImages} onChange={(e) => onChatImagesChange(e.target.checked)} />
              {t("app.chatImages")}
            </label>
            <p className="ts-options-hint">{t("app.chatImages.hint")}</p>
          </fieldset>
        </div>
      </div>
    </>
  );
}

/** QR code as inline SVG (no data: URL, so no CSP img-src exception needed). */
function QrCode({ text }: { text: string }) {
  const { n, d } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return { n, d };
  }, [text]);
  return (
    <svg className="ts-sync-qr" viewBox={`-3 -3 ${n + 6} ${n + 6}`} width="220" height="220" role="img">
      <rect x={-3} y={-3} width={n + 6} height={n + 6} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

/** Options -> Konto: Mullvad-style sync account (see sync.ts). */
function KontoPanel() {
  const t = useT();
  const status = useSyncExternalStore(subscribeSyncStatus, getSyncStatus);
  const [account, setAccount] = useState(loadSyncAccount);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [withPassword, setWithPassword] = useState(true);
  // Empty = the default server, whose address isn't shown.
  const [serverInput, setServerInput] = useState("");
  const server = serverInput.trim() || DEFAULT_SYNC_SERVER;
  const [loginNumber, setLoginNumber] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  // Status changes (a push in the background) also move version/lastSync.
  useEffect(() => setAccount(loadSyncAccount()), [status]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await fn();
      setAccount(loadSyncAccount());
    } catch (err) {
      setError(t(syncErrorKey(err)));
    } finally {
      setBusy(null);
    }
  };
  const copy = (what: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(what);
    window.setTimeout(() => setCopied(null), 1500);
  };

  if (!account) {
    const number = normalizeAccountNumber(loginNumber);
    return (
      <>
        <h3>{t("options.section.konto")}</h3>
        <p className="ts-options-subtitle">{t("sync.subtitle")}</p>
        <p className="ts-options-hint">{t("sync.intro")}</p>
        <div className="ts-options-fields">
          <fieldset className="ts-options-fieldset">
            <legend>{t("sync.create.title")}</legend>
            <label className="ts-options-checkbox">
              <input type="checkbox" checked={withPassword} onChange={(e) => setWithPassword(e.target.checked)} />
              {t("sync.create.withPassword")}
            </label>
            <p className="ts-options-hint">{t("sync.create.withPasswordHint")}</p>
            <button
              disabled={busy !== null}
              onClick={() => void run("create", () => createSyncAccount(withPassword, server, SYNC_CATEGORIES))}
            >
              {busy === "create" ? t("sync.create.busy") : t("sync.create.button")}
            </button>
          </fieldset>
          <fieldset className="ts-options-fieldset">
            <legend>{t("sync.login.title")}</legend>
            <label className="ts-options-field">
              {t("sync.number")}
              <input
                value={loginNumber}
                inputMode="numeric"
                placeholder="0000 0000 0000 0000"
                onChange={(e) => setLoginNumber(e.target.value)}
              />
            </label>
            <label className="ts-options-field">
              {t("sync.passwordOptional")}
              <input value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} />
            </label>
            <p className="ts-options-hint">{t("sync.login.hint")}</p>
            <button
              disabled={busy !== null || !number}
              onClick={() =>
                void run("login", async () => {
                  const password = loginPassword.trim() ? normalizePassword(loginPassword) : undefined;
                  if (!password && (await accountInfo(number!, server)).hasPassword) throw new Error("password_required");
                  await loginSyncAccount(number!, password, server, SYNC_CATEGORIES);
                  window.location.reload();
                })
              }
            >
              {t("sync.login.button")}
            </button>
          </fieldset>
          <label className="ts-options-field">
            {t("sync.server")}
            <input
              value={serverInput}
              placeholder={t("sync.serverDefault")}
              onChange={(e) => setServerInput(e.target.value)}
            />
          </label>
          <p className="ts-options-hint">{t("sync.serverHint")}</p>
          {error && <p className="ts-vault-wrong">{error}</p>}
        </div>
      </>
    );
  }

  const toggleCategory = (c: SyncCategory, on: boolean) =>
    void run("categories", () =>
      setSyncCategories(on ? [...account.categories, c] : account.categories.filter((x) => x !== c))
    );
  return (
    <>
      <h3>{t("options.section.konto")}</h3>
      <p className="ts-options-subtitle">{t("sync.subtitle")}</p>
      <div className="ts-options-columns">
        <div className="ts-options-fields">
          <fieldset className="ts-options-fieldset">
            <legend>{t("sync.account.title")}</legend>
            <label className="ts-options-field">
              {t("sync.number")}
              <span className="ts-sync-secret">
                <code>{formatAccountNumber(account.number)}</code>
                <button onClick={() => copy("number", account.number)}>
                  {copied === "number" ? t("sync.copied") : t("sync.copy")}
                </button>
              </span>
            </label>
            <label className="ts-options-field">
              {t("sync.password")}
              {account.password ? (
                <span className="ts-sync-secret">
                  <code>{showPassword ? account.password : "•••••-•••••-•••••-•••••"}</code>
                  <button onClick={() => setShowPassword((v) => !v)}>
                    {showPassword ? t("sync.hide") : t("sync.show")}
                  </button>
                  <button onClick={() => copy("password", account.password!)}>
                    {copied === "password" ? t("sync.copied") : t("sync.copy")}
                  </button>
                </span>
              ) : (
                <span className="ts-sync-secret">{t("sync.noPassword")}</span>
              )}
            </label>
            <p className="ts-options-hint ts-sync-warning">{t("sync.keepSafe")}</p>
            <div className="ts-sync-buttons">
              <button
                onClick={() => {
                  const url = URL.createObjectURL(new Blob([recoveryText(account)], { type: "text/plain" }));
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "webspeak3-account.txt";
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                {t("sync.recoveryFile")}
              </button>
              <button onClick={() => setShowQr((v) => !v)}>{showQr ? t("sync.qr.hide") : t("sync.qr.show")}</button>
              <button
                disabled={busy !== null}
                onClick={() => {
                  if (window.confirm(t(account.password ? "sync.password.removeConfirm" : "sync.password.addConfirm")))
                    void run("password", () => changeSyncPassword(!account.password));
                }}
              >
                {account.password ? t("sync.password.remove") : t("sync.password.add")}
              </button>
            </div>
            {showQr && (
              <div className="ts-sync-qr-box">
                <QrCode text={syncLink(account)} />
                <p className="ts-options-hint">{t("sync.qr.hint")}</p>
              </div>
            )}
          </fieldset>
        </div>
        <div className="ts-options-fields">
          <fieldset className="ts-options-fieldset">
            <legend>{t("sync.categories")}</legend>
            {SYNC_CATEGORIES.map((c) => (
              <label key={c} className="ts-options-checkbox">
                <input
                  type="checkbox"
                  checked={account.categories.includes(c)}
                  disabled={busy !== null}
                  onChange={(e) => toggleCategory(c, e.target.checked)}
                />
                {t(`sync.category.${c}`)}
              </label>
            ))}
            <p className="ts-options-hint">{t("sync.categoriesHint")}</p>
          </fieldset>
          <fieldset className="ts-options-fieldset">
            <legend>{t("sync.status")}</legend>
            <p>
              {status.state === "syncing"
                ? t("sync.status.syncing")
                : status.state === "error"
                  ? t(syncErrorKey(status.error))
                  : status.state === "conflict"
                    ? t("sync.conflict.text")
                    : account.lastSync
                      ? t("sync.status.last", { time: new Date(account.lastSync).toLocaleString() })
                      : t("sync.status.never")}
            </p>
            {status.state === "conflict" ? (
              <div className="ts-sync-buttons">
                <button disabled={busy !== null} onClick={() => void run("resolve", () => resolveConflict("local"))}>
                  {t("sync.conflict.local")}
                </button>
                <button
                  disabled={busy !== null}
                  onClick={() =>
                    void run("resolve", async () => {
                      await resolveConflict("server");
                      window.location.reload();
                    })
                  }
                >
                  {t("sync.conflict.server")}
                </button>
              </div>
            ) : (
              <button disabled={busy !== null || status.state === "syncing"} onClick={() => void run("sync", syncNow)}>
                {t("sync.syncNow")}
              </button>
            )}
            <p className="ts-options-hint">{t("sync.serverInfo", {
                server: account.server === DEFAULT_SYNC_SERVER ? t("sync.serverDefault") : account.server,
              })}</p>
          </fieldset>
          <div className="ts-sync-buttons">
            <button
              onClick={() => {
                if (!window.confirm(t("sync.logoutConfirm"))) return;
                logoutSyncAccount();
                setAccount(null);
              }}
            >
              {t("sync.logout")}
            </button>
            <button
              disabled={busy !== null}
              onClick={() => {
                if (window.confirm(t("sync.deleteConfirm"))) void run("delete", deleteSyncAccount);
              }}
            >
              {t("sync.delete")}
            </button>
          </div>
          {error && <p className="ts-vault-wrong">{error}</p>}
        </div>
      </div>
    </>
  );
}

type CustomThemeDraft = { id: string | null; name: string; baseTheme: DesignTheme; css: string };

/** Shared stroke-icon wrapper for the custom-theme-card action row, so all
 *  four icons (edit/duplicate/export/delete) render at the same size and
 *  color - mixing text glyphs with an emoji (as before) made them look
 *  inconsistent across fonts/platforms. */
function ActionIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

function WhisperPanel({ onOpenWhisperLists }: { onOpenWhisperLists: () => void }) {
  const t = useT();
  const { whisper, setWhisper } = useContext(DisplayPrefsContext);
  const set = (patch: Partial<WhisperSettings>) => setWhisper({ ...whisper, ...patch });
  return (
    <>
      <h3>{t("options.section.whispern")}</h3>
      <p className="ts-options-subtitle">{t("whisperSettings.subtitle")}</p>
      <div className="ts-options-fields">
        <fieldset className="ts-options-fieldset">
          <legend>{t("whisperSettings.rights")}</legend>
          {(["allow", "block", "blockAll"] as const).map((mode) => (
            <label key={mode} className="ts-options-radio">
              <input type="radio" name="ts-whisper-mode" checked={whisper.mode === mode} onChange={() => set({ mode })} />
              {t(`whisperSettings.mode.${mode}`)}
            </label>
          ))}
        </fieldset>
        <fieldset className="ts-options-fieldset">
          <legend>{t("whisperSettings.incoming")}</legend>
          <label className="ts-options-checkbox">
            <input type="checkbox" checked={whisper.sound} onChange={(e) => set({ sound: e.target.checked })} />
            {t("whisperSettings.sound")}
          </label>
          <label className="ts-options-checkbox">
            <input
              type="checkbox"
              checked={whisper.openHistory}
              onChange={(e) => set({ openHistory: e.target.checked })}
            />
            {t("whisperSettings.openHistory")}
          </label>
          <label className="ts-options-field">
            {t("whisperSettings.clearAfter")}
            <span>
              <input
                type="number"
                min={1}
                max={999}
                className="ts-download-number"
                value={whisper.clearAfterMin}
                onChange={(e) => set({ clearAfterMin: Math.min(999, Math.max(1, Number(e.target.value) || 1)) })}
              />{" "}
              {t("whisperSettings.minutes")}
            </span>
          </label>
        </fieldset>
        <div>
          <button onClick={onOpenWhisperLists}>{t("menu.extras.whisperLists")}</button>
        </div>
      </div>
    </>
  );
}

function DownloadsPanel() {
  const t = useT();
  const { downloads, setDownloads, downloadDir, setDownloadDir } = useContext(DisplayPrefsContext);
  const set = (patch: Partial<DownloadSettings>) => setDownloads({ ...downloads, ...patch });
  const limitRow = (key: "uploadLimit" | "downloadLimit") => (
    <fieldset className="ts-options-fieldset">
      <legend>{t(`downloadSettings.${key}`)}</legend>
      <label className="ts-options-radio">
        <input type="radio" checked={downloads[key] === 0} onChange={() => set({ [key]: 0 })} />
        {t("downloadSettings.unlimited")}
      </label>
      <label className="ts-options-radio">
        <input type="radio" checked={downloads[key] > 0} onChange={() => set({ [key]: 5 })} />
        {t("downloadSettings.limitedTo")}
        <input
          type="number"
          min={1}
          className="ts-download-number"
          value={downloads[key] || 5}
          disabled={downloads[key] === 0}
          onChange={(e) => set({ [key]: Math.max(1, Number(e.target.value) || 1) })}
        />
        KiB/s
      </label>
    </fieldset>
  );
  const countRow = (key: "maxUploads" | "maxDownloads") => (
    <fieldset className="ts-options-fieldset">
      <legend>{t(`downloadSettings.${key}`)}</legend>
      <label className="ts-options-field">
        {t("downloadSettings.limitedTo")}
        <input
          type="number"
          min={1}
          className="ts-download-number"
          value={downloads[key]}
          onChange={(e) => set({ [key]: Math.max(1, Number(e.target.value) || 1) })}
        />
      </label>
    </fieldset>
  );
  return (
    <>
      <h3>{t("options.section.downloads")}</h3>
      <p className="ts-options-subtitle">{t("downloadSettings.subtitle")}</p>
      <div className="ts-options-fields">
        <fieldset className="ts-options-fieldset">
          <legend>{t("downloadSettings.directory")}</legend>
          <div className="ts-download-dir">
            {t("downloadSettings.directoryLabel")} <strong>{downloadDir?.name ?? t("downloadSettings.browserDefault")}</strong>
            <button
              disabled={!canPickFolder}
              onClick={() => void pickDownloadDir().then((dir) => dir && setDownloadDir(dir))}
            >
              {t("downloadSettings.change")}
            </button>
            {downloadDir && (
              <button onClick={() => void clearDownloadDir().then(() => setDownloadDir(null))}>
                {t("downloadSettings.reset")}
              </button>
            )}
          </div>
          <label className="ts-options-radio">
            <input type="radio" checked={downloads.saveMode === "dir"} onChange={() => set({ saveMode: "dir" })} />
            {t("downloadSettings.alwaysDir")}
          </label>
          <label className="ts-options-radio">
            <input
              type="radio"
              disabled={!canPickFolder}
              checked={downloads.saveMode === "ask"}
              onChange={() => set({ saveMode: "ask" })}
            />
            {t("downloadSettings.askEachTime")}
          </label>
          {!canPickFolder && <p className="ts-options-hint">{t("downloadSettings.unsupported")}</p>}
        </fieldset>
        <fieldset className="ts-options-fieldset">
          <legend>{t("downloadSettings.interface")}</legend>
          {(["showWindowOnStart", "closeWindowWhenDone", "popupWhenDone"] as const).map((key) => (
            <label key={key} className="ts-options-checkbox">
              <input type="checkbox" checked={downloads[key]} onChange={(e) => set({ [key]: e.target.checked })} />
              {t(`downloadSettings.${key}`)}
            </label>
          ))}
        </fieldset>
        <div className="ts-design-native">
          <div className="ts-design-col">
            {limitRow("uploadLimit")}
            {countRow("maxUploads")}
          </div>
          <div className="ts-design-col">
            {limitRow("downloadLimit")}
            {countRow("maxDownloads")}
          </div>
        </div>
      </div>
    </>
  );
}

const CHAT_FONTS = [
  "Arial",
  "Verdana",
  "Tahoma",
  "Segoe UI",
  "Trebuchet MS",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "Consolas",
  "sans-serif",
  "serif",
  "monospace",
];

function ChatPanel() {
  const t = useT();
  const { chat, setChat } = useContext(DisplayPrefsContext);
  const set = (patch: Partial<ChatSettings>) => setChat({ ...chat, ...patch });
  const restoreRow = (key: "restoreChannelLines" | "restorePrivateLines") => (
    <div className="ts-chat-restore-row">
      <label className="ts-options-checkbox">
        <input type="checkbox" checked={chat[key] > 0} onChange={(e) => set({ [key]: e.target.checked ? 100 : 0 })} />
        {t(`chatSettings.${key}`)}
      </label>
      <span>
        {t("chatSettings.last")}{" "}
        <input
          type="number"
          min={1}
          max={1000}
          className="ts-download-number"
          value={chat[key] || 100}
          disabled={chat[key] === 0}
          onChange={(e) => set({ [key]: Math.min(1000, Math.max(1, Number(e.target.value) || 1)) })}
        />{" "}
        {t("chatSettings.linesUnit")}
      </span>
    </div>
  );
  return (
    <>
      <h3>{t("options.section.chat")}</h3>
      <p className="ts-options-subtitle">{t("chatSettings.subtitle")}</p>
      <div className="ts-options-fields">
        <fieldset className="ts-options-fieldset">
          <legend>{t("chatSettings.window")}</legend>
          <label className="ts-options-field">
            {t("chatSettings.maxLines")}
            <span>
              <input
                type="number"
                min={10}
                className="ts-download-number"
                value={chat.maxLines}
                onChange={(e) => set({ maxLines: Math.max(10, Number(e.target.value) || 10) })}
              />{" "}
              {t("chatSettings.linesUnit")}
            </span>
          </label>
          <div className="ts-chat-font-row">
            {t("chatSettings.font")}
            <select value={chat.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })}>
              <option value="">{t("chatSettings.fontDefault")}</option>
              {CHAT_FONTS.map((f) => (
                <option key={f} value={f} style={{ fontFamily: f }}>
                  {f}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={8}
              max={32}
              className="ts-download-number"
              placeholder={t("chatSettings.fontDefault")}
              value={chat.fontSize || ""}
              onChange={(e) => set({ fontSize: Math.min(32, Math.max(0, Number(e.target.value) || 0)) })}
            />
            px
            <button
              title={t("chatSettings.fontReset")}
              aria-label={t("chatSettings.fontReset")}
              onClick={() => set({ fontFamily: "", fontSize: 0 })}
            >
              ↻
            </button>
          </div>
          <div
            className="ts-chat-font-preview"
            style={{ fontFamily: chat.fontFamily || undefined, fontSize: chat.fontSize ? `${chat.fontSize}px` : undefined }}
          >
            {t("chatSettings.fontPreview")}
          </div>
        </fieldset>
        <fieldset className="ts-options-fieldset">
          <legend>{t("chatSettings.autoLog")}</legend>
          {(["logChannel", "logPrivate", "logServer"] as const).map((key) => (
            <label key={key} className="ts-options-checkbox">
              <input type="checkbox" checked={chat[key]} onChange={(e) => set({ [key]: e.target.checked })} />
              {t(`chatSettings.${key}`)}
            </label>
          ))}
          <p className="ts-options-hint">{t("chatSettings.logHint")}</p>
        </fieldset>
        <fieldset className="ts-options-fieldset">
          <legend>{t("chatSettings.restore")}</legend>
          {restoreRow("restoreChannelLines")}
          {restoreRow("restorePrivateLines")}
        </fieldset>
        <fieldset className="ts-options-fieldset">
          <legend>{t("chatSettings.notify")}</legend>
          {(["notifyServer", "notifyChannel", "notifyPrivate"] as const).map((key) => (
            <label key={key} className="ts-options-checkbox">
              <input type="checkbox" checked={chat[key]} onChange={(e) => set({ [key]: e.target.checked })} />
              {t(`chatSettings.${key}`)}
            </label>
          ))}
        </fieldset>
      </div>
    </>
  );
}

/** Options -> Sicherheit -> "Master Passwort benutzen" / "ändern" (vault.ts). */
function MasterPasswordRow() {
  const t = useT();
  const [on, setOn] = useState(isVaultUnlocked);
  // What the inline form is doing: turning it on, changing it, or turning it off.
  const [mode, setMode] = useState<"enable" | "change" | "disable" | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const open = (m: typeof mode) => {
    setMode(m);
    setCurrent("");
    setNext("");
    setRepeat("");
    setError("");
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode !== "enable" && !(await checkMasterPassword(current))) return setError(t("vault.wrong"));
    if (mode !== "disable" && next !== repeat) return setError(t("securitySettings.masterMismatch"));
    setBusy(true);
    if (mode === "disable") await removeMasterPassword();
    else await setMasterPassword(next);
    setBusy(false);
    setOn(isVaultUnlocked());
    setMode(null);
  };
  return (
    <>
      <div className="ts-security-row">
        <label className="ts-options-checkbox" title={t("securitySettings.masterHint")}>
          <input type="checkbox" checked={on || mode === "enable"} onChange={(e) => open(e.target.checked ? "enable" : "disable")} />
          {t("securitySettings.masterPassword")}
        </label>
        <button disabled={!on} onClick={() => open("change")}>
          {t("securitySettings.changeMasterPassword")}
        </button>
      </div>
      {mode && (
        <form className="ts-master-form" onSubmit={submit}>
          {mode !== "enable" && (
            <label className="ts-dialog-field">
              {t("securitySettings.masterCurrent")}
              <input type="password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} />
            </label>
          )}
          {mode !== "disable" && (
            <>
              <label className="ts-dialog-field">
                {t("securitySettings.masterNew")}
                <input type="password" autoFocus={mode === "enable"} value={next} onChange={(e) => setNext(e.target.value)} />
              </label>
              <label className="ts-dialog-field">
                {t("securitySettings.masterRepeat")}
                <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
              </label>
            </>
          )}
          {mode === "enable" && <p className="ts-master-note">{t("securitySettings.masterNote")}</p>}
          {error && <p className="ts-vault-wrong">{error}</p>}
          <div className="ts-security-row">
            <button type="submit" disabled={busy || (mode === "disable" ? !current : !next)}>
              {t("options.ok")}
            </button>
            <button type="button" onClick={() => setMode(null)}>
              {t("options.cancel")}
            </button>
          </div>
        </form>
      )}
    </>
  );
}

function SecurityPanel({ onOpenIdentities, onClearCache }: { onOpenIdentities: () => void; onClearCache: () => void }) {
  const t = useT();
  const { security, setSecurity } = useContext(DisplayPrefsContext);
  const set = (patch: Partial<SecuritySettings>) => setSecurity({ ...security, ...patch });
  return (
    <>
      <h3>{t("options.section.sicherheit")}</h3>
      <p className="ts-options-subtitle">{t("securitySettings.subtitle")}</p>
      <div className="ts-options-fields">
        <fieldset className="ts-options-fieldset">
          <legend>{t("securitySettings.passwords")}</legend>
          <div className="ts-security-row">
            <label className="ts-options-checkbox">
              <input
                type="checkbox"
                checked={security.saveChannelPasswords}
                onChange={(e) => set({ saveChannelPasswords: e.target.checked })}
              />
              {t("securitySettings.saveChannelPasswords")}
            </label>
            <button
              onClick={() => {
                localStorage.removeItem(CHANNEL_PASSWORDS_KEY);
                window.alert(t("securitySettings.channelPasswordsCleared"));
              }}
            >
              {t("securitySettings.clearChannelPasswords")}
            </button>
          </div>
          <MasterPasswordRow />
        </fieldset>
        <fieldset className="ts-options-fieldset">
          <legend>{t("securitySettings.cleanup")}</legend>
          <label className="ts-options-checkbox">
            <input
              type="checkbox"
              checked={security.clearCacheOnExit}
              onChange={(e) => set({ clearCacheOnExit: e.target.checked })}
            />
            {t("securitySettings.clearCacheOnExit")}
          </label>
          <label className="ts-options-checkbox">
            <input
              type="checkbox"
              checked={security.clearUrlsOnExit}
              onChange={(e) => set({ clearUrlsOnExit: e.target.checked })}
            />
            {t("securitySettings.clearUrlsOnExit")}
          </label>
          <div>
            <button onClick={onClearCache}>{t("securitySettings.clearCache")}</button>
          </div>
        </fieldset>
        <fieldset className="ts-options-fieldset">
          <legend>{t("securitySettings.identities")}</legend>
          <div>
            <button onClick={onOpenIdentities}>{t("securitySettings.manageIdentities")}</button>
          </div>
        </fieldset>
      </div>
    </>
  );
}

function useSoundPacks(): [SoundPack[], () => void] {
  const [packs, setPacks] = useState<SoundPack[]>([]);
  const reload = useCallback(() => void loadSoundPacks().then(setPacks), []);
  useEffect(reload, [reload]);
  return [packs, reload];
}

/** WebSpeak3 Standard, Keine Sounds and the imported packs. */
function SoundPackOptions() {
  const t = useT();
  const [packs] = useSoundPacks();
  return (
    <>
      <option value={BUILTIN_PACK}>{t("notify.pack.builtin")}</option>
      <option value={NO_SOUNDS_PACK}>{t("notify.pack.none")}</option>
      {packs.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </>
  );
}

const notificationLeaves = (node: NotificationNode): string[] =>
  node.key ? [node.key] : (node.children ?? []).flatMap(notificationLeaves);

function MeldungenPanel({
  onOpenFavorites,
  onApplyPackToFavorites,
}: {
  onOpenFavorites: () => void;
  onApplyPackToFavorites: () => void;
}) {
  const t = useT();
  const [settings, setSettings] = useState<NotificationSettings>(getNotificationSettings);
  const [packs, reloadPacks] = useSoundPacks();
  const [open, setOpen] = useState<Set<string>>(() => new Set(["connection"]));
  const fileRef = useRef<HTMLInputElement>(null);
  const pack = packs.find((p) => p.id === settings.pack);
  const save = (next: NotificationSettings) => {
    saveNotificationSettings(next);
    setSettings(next);
  };
  const defaultScript = (key: string) => packScript(pack, settings.pack, key);
  const override = (keys: string[], patch: NotificationOverride) => {
    const overrides = { ...settings.overrides };
    for (const key of keys) {
      const merged = { ...overrides[key], ...patch };
      // Values equal to the default aren't overrides (that's what makes a row bold).
      if (!merged.off) delete merged.off;
      if (merged.script === defaultScript(key)) delete merged.script;
      if (merged.text?.join() === "server") delete merged.text;
      if (Object.keys(merged).length) overrides[key] = merged;
      else delete overrides[key];
    }
    save({ ...settings, overrides });
  };
  const handleImport = async (file: File) => {
    try {
      const imported = await importSoundPack(file);
      reloadPacks();
      save({ ...settings, pack: imported.id });
    } catch {
      window.alert(t("notify.importFailed"));
    }
  };

  const renderNode = (node: NotificationNode, path: string, depth: number): React.ReactNode => {
    const id = `${path}/${node.label}`;
    const special = node.key ? isSpecialKey(node.key) : id === "/special";
    const indent = { paddingLeft: 4 + depth * 16 };
    if (node.key) {
      const key = node.key;
      const o = settings.overrides[key];
      const script = o?.script ?? defaultScript(key);
      const text = Array.isArray(o?.text) ? o.text : ["server"];
      return (
        <tr key={id} className={o ? "ts-notify-custom" : undefined}>
          <td style={indent}>
            <label className="ts-notify-action">
              {!special && (
                <input type="checkbox" checked={!o?.off} onChange={(e) => override([key], { off: !e.target.checked })} />
              )}
              {t(`notify.${node.label}`)}
            </label>
          </td>
          <td>
            <span className="ts-notify-script">
              <input
                value={script}
                spellCheck={false}
                onChange={(e) => override([key], { script: e.target.value })}
              />
              {script && (
                <button title={t("sounds.test")} onClick={() => void runSoundScript(script, settings.pack)}>
                  ▶
                </button>
              )}
            </span>
          </td>
          <td>
            {!special && (
              <details className="ts-notify-text">
                <summary>{text.map((p) => t(`notify.text.${p}`)).join(", ") || "—"}</summary>
                <div className="ts-notify-text-menu">
                  {textPositionChoices(key).map((p) => (
                    <label key={p} className="ts-options-checkbox">
                      <input
                        type="checkbox"
                        checked={text.includes(p)}
                        onChange={(e) =>
                          override([key], {
                            text: textPositionChoices(key).filter((c) => (c === p ? e.target.checked : text.includes(c))),
                          })
                        }
                      />
                      {t(`notify.text.${p}`)}
                    </label>
                  ))}
                </div>
              </details>
            )}
          </td>
        </tr>
      );
    }
    const leaves = notificationLeaves(node);
    const on = leaves.filter((k) => !settings.overrides[k]?.off).length;
    const expanded = open.has(id);
    const toggle = () =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      });
    return [
      <tr key={id} className={leaves.some((k) => settings.overrides[k]) ? "ts-notify-custom" : undefined}>
        <td style={indent} colSpan={3}>
          <span className="ts-notify-action">
            <button className="ts-notify-twisty" onClick={toggle}>
              {expanded ? "▾" : "▸"}
            </button>
            {!special && (
              <input
                type="checkbox"
                checked={on === leaves.length}
                ref={(el) => {
                  if (el) el.indeterminate = on > 0 && on < leaves.length;
                }}
                onChange={(e) => override(leaves, { off: !e.target.checked })}
              />
            )}
            <span onClick={toggle}>{t(`notify.${node.label}`)}</span>
          </span>
        </td>
      </tr>,
      ...(expanded ? (node.children ?? []).map((c) => renderNode(c, id, depth + 1)) : []),
    ];
  };

  return (
    <>
      <h3>{t("options.section.meldungen")}</h3>
      <p className="ts-options-subtitle">{t("notify.subtitle")}</p>
      <div className="ts-options-fields">
        <div className="ts-notify-row">
          <label htmlFor="ts-notify-pack">{t("notify.soundPack")}</label>
          <select id="ts-notify-pack" value={settings.pack} onChange={(e) => save({ ...settings, pack: e.target.value })}>
            <SoundPackOptions key={packs.length} />
          </select>
          <button
            title={t("notify.applyToFavorites")}
            onClick={() => {
              if (window.confirm(t("notify.applyToFavoritesConfirm"))) onApplyPackToFavorites();
            }}
          >
            ✔
          </button>
          <button title={t("notify.importPack")} onClick={() => fileRef.current?.click()}>
            📂
          </button>
          {pack && (
            <button
              title={t("notify.deletePack")}
              onClick={() => {
                if (!window.confirm(t("notify.deletePackConfirm", { name: pack.name }))) return;
                void deleteSoundPack(pack.id).then(reloadPacks);
                save({ ...settings, pack: BUILTIN_PACK });
              }}
            >
              🗑
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".ts3_soundpack,.zip"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void handleImport(file);
            }}
          />
        </div>
        <div className="ts-notify-row">
          <label htmlFor="ts-notify-muted">{t("notify.whenMuted")}</label>
          <select
            id="ts-notify-muted"
            value={settings.whenMuted}
            onChange={(e) => save({ ...settings, whenMuted: e.target.value as NotificationSettings["whenMuted"] })}
          >
            <option value="all">{t("notify.whenMuted.all")}</option>
            <option value="important">{t("notify.whenMuted.important")}</option>
            <option value="none">{t("notify.whenMuted.none")}</option>
          </select>
        </div>
        <p className="ts-notify-hint">
          {t("notify.hintBefore")}
          <a href="#" onClick={(e) => (e.preventDefault(), onOpenFavorites())}>
            {t("notify.hintLink")}
          </a>
          {t("notify.hintAfter")}
        </p>
        <div className="ts-notify-tree">
          <table>
            <thead>
              <tr>
                <th>{t("notify.col.action")}</th>
                <th>{t("notify.col.script")}</th>
                <th>{t("notify.col.text")}</th>
              </tr>
            </thead>
            <tbody>{NOTIFICATION_TREE.map((n) => renderNode(n, "", 0))}</tbody>
          </table>
        </div>
        {Object.keys(settings.overrides).length > 0 && (
          <div>
            <button onClick={() => save({ ...settings, overrides: {} })}>{t("notify.resetAll")}</button>
          </div>
        )}
      </div>
    </>
  );
}

function DesignPanel({
  designSelection,
  onSelectionChange,
  customThemes,
  onSaveCustomTheme,
  onDeleteCustomTheme,
  idePixelFont,
  onIdePixelFontChange,
}: {
  designSelection: string;
  onSelectionChange: (next: string) => void;
  customThemes: CustomTheme[];
  onSaveCustomTheme: (theme: CustomTheme) => void;
  onDeleteCustomTheme: (id: string) => void;
  idePixelFont: boolean;
  onIdePixelFontChange: (on: boolean) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState<CustomThemeDraft | null>(null);
  const [storeOpen, setStoreOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const prefs = useContext(DisplayPrefsContext);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const iconPackInputRef = useRef<HTMLInputElement | null>(null);

  const builtins: { id: DesignTheme; name: string; desc: string }[] = [
    { id: "standard", name: t("design.theme.standard"), desc: t("design.theme.standard.desc") },
    { id: "nova", name: t("design.theme.nova"), desc: t("design.theme.nova.desc") },
    { id: "pulse", name: t("design.theme.pulse"), desc: t("design.theme.pulse.desc") },
    { id: "ide", name: t("design.theme.ide"), desc: t("design.theme.ide.desc") },
  ];

  const handleSaveEditing = () => {
    if (!editing || !editing.name.trim()) return;
    const id = editing.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    onSaveCustomTheme({ id, name: editing.name.trim(), baseTheme: editing.baseTheme, css: editing.css });
    onSelectionChange(`custom:${id}`);
    setEditing(null);
  };

  const handleExport = (theme: CustomTheme) => {
    const blob = new Blob(
      [JSON.stringify({ name: theme.name, baseTheme: theme.baseTheme, css: theme.css }, null, 2)],
      { type: "application/json" }
    );
    downloadBlob(blob, `${theme.name.replace(/[^a-z0-9-_]+/gi, "_") || "theme"}.webspeak3theme.json`);
  };

  const handleImportSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (
        !parsed ||
        typeof parsed.name !== "string" ||
        !isDesignTheme(parsed.baseTheme) ||
        typeof parsed.css !== "string"
      ) {
        window.alert(t("design.custom.importError"));
        return;
      }
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      onSaveCustomTheme({ id, name: parsed.name, baseTheme: parsed.baseTheme, css: parsed.css });
      onSelectionChange(`custom:${id}`);
    } catch {
      window.alert(t("design.custom.importError"));
    }
  };

  const handleIconPackSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const pack = await parseIconPack(file);
      if (!pack) {
        window.alert(t("design.iconPack.importError"));
        return;
      }
      prefs.saveIconPacks([...prefs.iconPacks, pack]);
      prefs.setIconPackId(pack.id);
    } catch {
      window.alert(t("design.iconPack.importError"));
    }
  };

  if (storeOpen) {
    return (
      <DesignStorePanel
        customThemes={customThemes}
        onInstall={(theme) => {
          const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          onSaveCustomTheme({ id, name: theme.name, baseTheme: theme.baseTheme, css: theme.css });
          onSelectionChange(`custom:${id}`);
        }}
        onClose={() => setStoreOpen(false)}
      />
    );
  }

  if (editing) {
    return (
      <>
        <h3>{editing.id ? t("design.custom.editTitle") : t("design.custom.newTitle")}</h3>
        <label className="ts-options-field">
          {t("design.custom.name")}
          <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus />
        </label>
        <label className="ts-options-field">
          {t("design.custom.base")}
          <select
            value={editing.baseTheme}
            onChange={(e) => setEditing({ ...editing, baseTheme: e.target.value as DesignTheme })}
          >
            <option value="standard">{t("design.theme.standard")}</option>
            <option value="nova">{t("design.theme.nova")}</option>
            <option value="pulse">{t("design.theme.pulse")}</option>
            <option value="ide">{t("design.theme.ide")}</option>
          </select>
        </label>
        <label className="ts-options-field">
          {t("design.custom.css")}
          <textarea
            className="ts-custom-theme-css"
            spellCheck={false}
            value={editing.css}
            onChange={(e) => setEditing({ ...editing, css: e.target.value })}
            placeholder={".ts-app {\n  --accent: #ff6b6b;\n}"}
          />
        </label>
        <p className="ts-options-subtitle">{t("design.custom.hint")}</p>
        <div className="ts-dialog-buttons-right">
          <button onClick={() => setEditing(null)}>{t("connect.cancel")}</button>
          <button onClick={handleSaveEditing} disabled={!editing.name.trim()}>
            {t("design.custom.save")}
          </button>
        </div>
      </>
    );
  }

  if (manageOpen) {
    return (
      <>
        <h3>{t("design.manage.title")}</h3>
        <button className="ts-design-back" onClick={() => setManageOpen(false)}>
          ← {t("design.store.back")}
        </button>
      <div className="ts-design-theme-grid">
        {builtins.map((th) => (
          <button
            key={th.id}
            className={`ts-design-theme-card${th.id === designSelection ? " ts-design-theme-card-active" : ""}`}
            onClick={() => onSelectionChange(th.id)}
          >
            <span className={`ts-design-theme-swatch ts-design-theme-swatch-${th.id}`} />
            <span className="ts-design-theme-card-name">{th.name}</span>
            <span className="ts-design-theme-card-desc">{th.desc}</span>
          </button>
        ))}
        {customThemes.map((theme) => (
          <div
            key={theme.id}
            className={`ts-design-theme-card ts-design-theme-card-custom${
              designSelection === `custom:${theme.id}` ? " ts-design-theme-card-active" : ""
            }`}
          >
            <button className="ts-design-theme-card-select" onClick={() => onSelectionChange(`custom:${theme.id}`)}>
              <span className="ts-design-theme-swatch ts-design-theme-swatch-custom" />
              <span className="ts-design-theme-card-name">{theme.name}</span>
              <span className="ts-design-theme-card-desc">
                {designThemeLabel(theme.baseTheme, t)}
              </span>
            </button>
            <div className="ts-design-theme-card-actions">
              <button
                onClick={() => setEditing({ id: theme.id, name: theme.name, baseTheme: theme.baseTheme, css: theme.css })}
                title={t("design.custom.edit")}
              >
                <ActionIcon>
                  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </ActionIcon>
              </button>
              <button
                onClick={() =>
                  setEditing({ id: null, name: t("design.custom.copyOf", { name: theme.name }), baseTheme: theme.baseTheme, css: theme.css })
                }
                title={t("design.custom.duplicate")}
              >
                <ActionIcon>
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </ActionIcon>
              </button>
              <button onClick={() => handleExport(theme)} title={t("design.custom.export")}>
                <ActionIcon>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </ActionIcon>
              </button>
              <button
                className="ts-design-theme-card-delete"
                onClick={() => {
                  if (window.confirm(t("design.custom.deleteConfirm"))) onDeleteCustomTheme(theme.id);
                }}
                title={t("design.custom.delete")}
              >
                <ActionIcon>
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  <line x1="10" y1="11" x2="10" y2="17" />
                  <line x1="14" y1="11" x2="14" y2="17" />
                </ActionIcon>
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="ts-design-custom-actions">
        <button onClick={() => setEditing({ id: null, name: "", baseTheme: "standard", css: "" })}>
          {t("design.custom.new")}
        </button>
        <button onClick={() => importInputRef.current?.click()}>{t("design.custom.import")}</button>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={handleImportSelected}
        />
        <button onClick={() => setStoreOpen(true)}>{t("design.store.open")}</button>
      </div>
        <h4 className="ts-design-manage-heading">{t("design.iconPack")}</h4>
        {prefs.iconPacks.length === 0 ? (
          <p className="ts-options-hint">{t("design.iconPack.none")}</p>
        ) : (
          <ul className="ts-design-iconpack-list">
            {prefs.iconPacks.map((pack) => (
              <li key={pack.id}>
                <span>
                  {pack.name} ({Object.keys(pack.icons).length})
                </span>
                <button
                  onClick={() => {
                    if (!window.confirm(t("design.iconPack.deleteConfirm"))) return;
                    prefs.saveIconPacks(prefs.iconPacks.filter((p) => p.id !== pack.id));
                    if (prefs.iconPackId === pack.id) prefs.setIconPackId("");
                  }}
                >
                  {t("design.custom.delete")}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="ts-design-custom-actions">
          <button onClick={() => iconPackInputRef.current?.click()}>{t("design.iconPack.import")}</button>
          <input
            ref={iconPackInputRef}
            type="file"
            accept=".ts3_iconpack,.zip"
            style={{ display: "none" }}
            onChange={handleIconPackSelected}
          />
        </div>
        <p className="ts-options-hint">{t("design.iconPack.hint")}</p>
      </>
    );
  }

  const tree = prefs.tree;
  const setTree = (patch: Partial<TreeOptions>) => prefs.setTree({ ...tree, ...patch });
  const base = resolveDesignThemeBase(designSelection, customThemes);
  const treeCheckbox = (key: keyof TreeOptions, label: string) => (
    <label className="ts-options-checkbox">
      <input type="checkbox" checked={tree[key] as boolean} onChange={(e) => setTree({ [key]: e.target.checked })} />
      {label}
    </label>
  );
  // ponytail: these need data the connector doesn't forward yet (client_badges, group types).
  const unavailableCheckbox = (label: string) => (
    <label className="ts-options-checkbox ts-options-disabled" title={t("design.notAvailable")}>
      <input type="checkbox" disabled />
      {label}
    </label>
  );

  return (
    <>
      <h3>{t("options.section.design")}</h3>
      <div className="ts-options-columns ts-design-native">
        <div className="ts-options-fields ts-design-col">
          <fieldset className="ts-options-fieldset">
            <legend>{t("options.section.design")}</legend>
            <label className="ts-options-field">
              {t("design.theme")}
              <select value={designSelection} onChange={(e) => onSelectionChange(e.target.value)}>
                {builtins.map((th) => (
                  <option key={th.id} value={th.id}>
                    {th.name}
                  </option>
                ))}
                {customThemes.length > 0 && (
                  <optgroup label={t("design.customThemes")}>
                    {customThemes.map((theme) => (
                      <option key={theme.id} value={`custom:${theme.id}`}>
                        {theme.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
            {base === "ide" && (
              <label className="ts-options-checkbox">
                <input type="checkbox" checked={idePixelFont} onChange={(e) => onIdePixelFontChange(e.target.checked)} />
                {t("design.idePixelFont")}
              </label>
            )}
            <label className="ts-options-field">
              {t("design.iconPack")}
              <select value={prefs.iconPackId} onChange={(e) => prefs.setIconPackId(e.target.value)}>
                <option value="">{t("design.theme.standard")}</option>
                {prefs.iconPacks.map((pack) => (
                  <option key={pack.id} value={pack.id}>
                    {pack.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="ts-design-custom-actions">
              <button onClick={() => setManageOpen(true)}>{t("design.manage")}</button>
              <button onClick={() => setStoreOpen(true)}>{t("design.store.open")}</button>
            </div>
          </fieldset>
          <fieldset className="ts-options-fieldset">
            <legend>{t("design.gif")}</legend>
            {treeCheckbox("animateAvatars", t("design.gif.avatars"))}
            {treeCheckbox("animateImages", t("design.gif.images"))}
          </fieldset>
        </div>
        <div className="ts-options-fields ts-design-col">
          <fieldset className="ts-options-fieldset">
            <legend>{t("design.tree")}</legend>
            <label className="ts-options-radio">
              <input
                type="radio"
                name="ts-tree-expand"
                checked={tree.expandMode === "all"}
                onChange={() => setTree({ expandMode: "all" })}
              />
              {t("design.tree.expandAll")}
            </label>
            <label className="ts-options-field ts-design-indent">
              {t("design.tree.expandDepth")}
              <input
                type="number"
                min={0}
                max={99}
                value={tree.expandDepth}
                disabled={tree.expandMode !== "all"}
                onChange={(e) => setTree({ expandDepth: Math.max(0, Math.floor(Number(e.target.value)) || 0) })}
              />
            </label>
            <label className="ts-options-radio">
              <input
                type="radio"
                name="ts-tree-expand"
                checked={tree.expandMode === "own"}
                onChange={() => setTree({ expandMode: "own" })}
              />
              {t("design.tree.expandOwn")}
            </label>
            {treeCheckbox("clientsBelow", t("design.tree.clientsBelow"))}
            {treeCheckbox("flags", t("design.tree.flags"))}
            {unavailableCheckbox(t("design.tree.overwolf"))}
            {unavailableCheckbox(t("design.tree.badges"))}
            {treeCheckbox("groupIconsInMenus", t("design.tree.groupIconsInMenus"))}
            {unavailableCheckbox(t("design.tree.hideInaccessibleGroups"))}
            {treeCheckbox("commanderLamp", t("design.tree.commanderLamp"))}
            {treeCheckbox("awayMessage", t("design.tree.awayMessage"))}
            {treeCheckbox("tooltips", t("design.tree.tooltips"))}
          </fieldset>
        </div>
      </div>
    </>
  );
}

/** Browse community-submitted designs (GET STORE_URL) and publish one of the
 *  viewer's own custom themes (POST STORE_URL) - see gateway/src/index.ts's
 *  /api/store/themes handler. Reports "unavailable" rather than erroring when
 *  the gateway has STORE_ENABLED off (the default), same as a 404. */
function DesignStorePanel({
  customThemes,
  onInstall,
  onClose,
}: {
  customThemes: CustomTheme[];
  onInstall: (theme: { name: string; baseTheme: DesignTheme; css: string }) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [themes, setThemes] = useState<StoreThemeSummary[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());
  const [publishTarget, setPublishTarget] = useState("");
  const [publishAuthor, setPublishAuthor] = useState("");
  const [publishDescription, setPublishDescription] = useState("");
  const [publishScreenshot, setPublishScreenshot] = useState<string | null>(null);
  const [publishAdminToken, setPublishAdminToken] = useState(
    () => localStorage.getItem(STORE_ADMIN_TOKEN_KEY) ?? ""
  );
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<"ok" | "pending" | "duplicate" | "error" | null>(null);
  const [ratedIds, setRatedIds] = useState<Set<string>>(new Set());

  const refreshThemes = () =>
    fetch(STORE_URL)
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<StoreThemeSummary[]>;
      })
      .then(setThemes)
      .catch(() => setUnavailable(true));

  useEffect(() => {
    refreshThemes();
    // Only ever needs to run once per panel open - refreshThemes is re-created
    // each render but doesn't depend on any prop/state that would need it here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleInstall = async (id: string) => {
    try {
      const res = await fetch(`${STORE_URL}/${id}`);
      if (!res.ok) throw new Error(String(res.status));
      const parsed = await res.json();
      if (
        !parsed ||
        typeof parsed.name !== "string" ||
        !isDesignTheme(parsed.baseTheme) ||
        typeof parsed.css !== "string"
      ) {
        throw new Error("invalid");
      }
      onInstall({ name: parsed.name, baseTheme: parsed.baseTheme, css: parsed.css });
      setInstalledIds((prev) => new Set(prev).add(id));
    } catch {
      window.alert(t("design.custom.importError"));
    }
  };

  const handleScreenshotChange = (file: File | undefined) => {
    if (!file) {
      setPublishScreenshot(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      if (dataUrl.length > STORE_SCREENSHOT_MAX_DATA_URL_LENGTH) {
        window.alert(t("design.store.publish.screenshotTooLarge"));
        return;
      }
      setPublishScreenshot(dataUrl);
    };
    reader.readAsDataURL(file);
  };

  const handlePublish = async () => {
    const theme = customThemes.find((c) => c.id === publishTarget);
    if (!theme) return;
    setPublishing(true);
    setPublishResult(null);
    try {
      const token = publishAdminToken.trim();
      if (token) localStorage.setItem(STORE_ADMIN_TOKEN_KEY, token);
      const res = await fetch(STORE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          name: theme.name,
          baseTheme: theme.baseTheme,
          css: theme.css,
          author: publishAuthor.trim() || undefined,
          description: publishDescription.trim() || undefined,
          screenshot: publishScreenshot ?? undefined,
        }),
      });
      if (res.status === 409) {
        setPublishResult("duplicate");
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json().catch(() => ({}))) as { status?: string };
      setPublishResult(body.status === "pending" ? "pending" : "ok");
      setPublishAuthor("");
      setPublishDescription("");
      setPublishScreenshot(null);
      await refreshThemes();
    } catch {
      setPublishResult("error");
    } finally {
      setPublishing(false);
    }
  };

  const handleRate = async (id: string, stars: number) => {
    setRatedIds((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`${STORE_URL}/${id}/rate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stars }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const parsed = await res.json();
      setThemes(
        (prev) => prev?.map((th) => (th.id === id ? { ...th, rating: parsed.rating } : th)) ?? prev
      );
    } catch {
      // Vote didn't count (already rated, offline, etc.) - the star stays marked
      // used locally so the person doesn't just click it again; no error UI needed
      // for what's a nice-to-have.
    }
  };

  return (
    <>
      <div className="ts-design-store-header">
        <button className="ts-design-store-back" onClick={onClose}>
          ← {t("design.store.back")}
        </button>
        <h3>{t("design.store.title")}</h3>
      </div>
      {unavailable ? (
        <p className="ts-options-subtitle">{t("design.store.unavailable")}</p>
      ) : themes === null ? (
        <p className="ts-options-subtitle">{t("design.store.loading")}</p>
      ) : (
        <>
          <div className="ts-design-theme-grid">
            {themes.length === 0 && <p className="ts-options-subtitle">{t("design.store.empty")}</p>}
            {themes.map((theme) => (
              <div key={theme.id} className="ts-design-theme-card ts-design-theme-card-custom">
                {theme.hasScreenshot && (
                  <img
                    className="ts-design-theme-card-screenshot"
                    src={`${STORE_URL}/${theme.id}/screenshot`}
                    alt={t("design.store.screenshotAlt", { name: theme.name })}
                  />
                )}
                <div className="ts-design-theme-card-select">
                  <span className="ts-design-theme-swatch ts-design-theme-swatch-custom" />
                  <span className="ts-design-theme-card-name">{theme.name}</span>
                  <span className="ts-design-theme-card-desc">{t("design.store.by", { author: theme.author })}</span>
                </div>
                {theme.description && <p className="ts-design-theme-card-desc">{theme.description}</p>}
                <div className="ts-design-theme-card-rating">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star}
                      className="ts-design-theme-card-star"
                      disabled={ratedIds.has(theme.id)}
                      onClick={() => handleRate(theme.id, star)}
                      title={t("design.store.rating.rate", { stars: String(star) })}
                    >
                      {star <= Math.round(theme.rating.average) ? "★" : "☆"}
                    </button>
                  ))}
                  <span className="ts-design-theme-card-rating-count">
                    {theme.rating.count > 0
                      ? t("design.store.rating.summary", {
                          average: theme.rating.average.toFixed(1),
                          count: String(theme.rating.count),
                        })
                      : t("design.store.rating.none")}
                  </span>
                </div>
                <div className="ts-design-store-card-actions">
                  <button onClick={() => handleInstall(theme.id)} disabled={installedIds.has(theme.id)}>
                    {installedIds.has(theme.id) ? t("design.store.installed") : t("design.store.install")}
                  </button>
                </div>
              </div>
            ))}
          </div>

          <h3>{t("design.store.publishTitle")}</h3>
          {customThemes.length === 0 ? (
            <p className="ts-options-subtitle">{t("design.store.publish.none")}</p>
          ) : (
            <>
              <label className="ts-options-field">
                {t("design.store.publish.select")}
                <select value={publishTarget} onChange={(e) => setPublishTarget(e.target.value)}>
                  <option value="" />
                  {customThemes.map((theme) => (
                    <option key={theme.id} value={theme.id}>
                      {theme.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ts-options-field">
                {t("design.store.publish.author")}
                <input
                  value={publishAuthor}
                  onChange={(e) => setPublishAuthor(e.target.value)}
                  placeholder={t("design.store.publish.authorPlaceholder")}
                />
              </label>
              <label className="ts-options-field">
                {t("design.store.publish.description")}
                <textarea
                  value={publishDescription}
                  onChange={(e) => setPublishDescription(e.target.value)}
                  placeholder={t("design.store.publish.descriptionPlaceholder")}
                  maxLength={300}
                  rows={3}
                />
              </label>
              <label className="ts-options-field">
                {t("design.store.publish.screenshot")}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => handleScreenshotChange(e.target.files?.[0])}
                />
              </label>
              <label className="ts-options-field">
                {t("design.store.publish.adminToken")}
                <input
                  type="password"
                  value={publishAdminToken}
                  onChange={(e) => setPublishAdminToken(e.target.value)}
                  placeholder={t("design.store.publish.adminTokenPlaceholder")}
                />
              </label>
              <button className="ts-design-store-publish-submit" onClick={handlePublish} disabled={!publishTarget || publishing}>
                {t("design.store.publish.submit")}
              </button>
              {publishResult === "ok" && <p className="ts-options-subtitle">{t("design.store.publish.success")}</p>}
              {publishResult === "pending" && <p className="ts-options-subtitle">{t("design.store.publish.pending")}</p>}
              {publishResult === "duplicate" && <p className="ts-options-subtitle">{t("design.store.publish.duplicate")}</p>}
              {publishResult === "error" && <p className="ts-options-subtitle">{t("design.store.publish.error")}</p>}
            </>
          )}
        </>
      )}
    </>
  );
}

function SoundsPanel() {
  const t = useT();
  const [enabled, setEnabled] = useState(() => loadSoundsEnabled());
  const [volume, setVolume] = useState(() => loadSoundsVolume());
  const [customNames, setCustomNames] = useState<Partial<Record<SoundEventId, string>>>({});
  const [eventEnabled, setEventEnabled] = useState<Record<SoundEventId, boolean>>(() =>
    Object.fromEntries(SOUND_EVENTS.map((id) => [id, loadEventSoundEnabled(id)])) as Record<SoundEventId, boolean>
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTargetRef = useRef<SoundEventId | null>(null);
  const soundpackInputRef = useRef<HTMLInputElement | null>(null);
  const [soundpackResult, setSoundpackResult] = useState<{
    matchedCount: number;
    unmatchedFiles: string[];
  } | null>(null);
  const [soundpackFailed, setSoundpackFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        SOUND_EVENTS.map(async (id) => [id, (await loadCustomSound(id))?.name] as const)
      );
      if (cancelled) return;
      const next: Partial<Record<SoundEventId, string>> = {};
      for (const [id, name] of entries) if (name) next[id] = name;
      setCustomNames(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggleEnabled = () => {
    const next = !enabled;
    setEnabled(next);
    saveSoundsEnabled(next);
  };

  const handleVolumeChange = (v: number) => {
    setVolume(v);
    saveSoundsVolume(v);
  };

  const handleToggleEventEnabled = (event: SoundEventId) => {
    const next = !eventEnabled[event];
    setEventEnabled((prev) => ({ ...prev, [event]: next }));
    saveEventSoundEnabled(event, next);
  };

  const handleUploadClick = (event: SoundEventId) => {
    uploadTargetRef.current = event;
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const event = uploadTargetRef.current;
    e.target.value = "";
    if (!file || !event) return;
    await saveCustomSound(event, file);
    setCustomNames((prev) => ({ ...prev, [event]: file.name }));
  };

  const handleReset = async (event: SoundEventId) => {
    await clearCustomSound(event);
    setCustomNames((prev) => {
      const next = { ...prev };
      delete next[event];
      return next;
    });
  };

  const handleImportSoundpackClick = () => soundpackInputRef.current?.click();

  const handleSoundpackSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setSoundpackResult(null);
    setSoundpackFailed(false);
    let parsed: Awaited<ReturnType<typeof parseSoundpack>>;
    try {
      parsed = await parseSoundpack(file);
    } catch {
      setSoundpackFailed(true);
      return;
    }
    const { matched, unmatchedFiles } = parsed;
    for (const [event, sound] of Object.entries(matched) as [SoundEventId, { name: string; blob: Blob }][]) {
      await saveCustomSound(event, new File([sound.blob], sound.name, { type: sound.blob.type }));
    }
    setCustomNames((prev) => {
      const next = { ...prev };
      for (const [event, sound] of Object.entries(matched) as [SoundEventId, { name: string; blob: Blob }][]) {
        next[event] = sound.name;
      }
      return next;
    });
    setSoundpackResult({ matchedCount: Object.keys(matched).length, unmatchedFiles });
  };

  return (
    <>
      <h3>{t("sounds.title")}</h3>
      <p className="ts-options-subtitle">{t("sounds.subtitle")}</p>
      <label className="ts-options-field-row">
        <input type="checkbox" checked={enabled} onChange={handleToggleEnabled} />
        {t("sounds.enable")}
      </label>
      <div className="ts-options-slider-with-value">
        <span className="ts-options-slider-label">{t("sounds.volume")}</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => handleVolumeChange(Number(e.target.value))}
        />
        <span>{Math.round(volume * 100)}%</span>
      </div>
      <div className="ts-options-field-row">
        <button onClick={handleImportSoundpackClick}>{t("sounds.importSoundpack")}</button>
      </div>
      {soundpackFailed && <p className="ts-options-subtitle">{t("sounds.importFailed")}</p>}
      {soundpackResult && (
        <p className="ts-options-subtitle">
          {t("sounds.importResult", {
            matched: String(soundpackResult.matchedCount),
            unmatched: String(soundpackResult.unmatchedFiles.length),
          })}
        </p>
      )}
      <table className="ts-options-sounds-table">
        <tbody>
          {SOUND_EVENTS.map((eventId) => (
            <tr key={eventId}>
              <td>
                <input
                  type="checkbox"
                  checked={eventEnabled[eventId]}
                  onChange={() => handleToggleEventEnabled(eventId)}
                  title={t("sounds.eventEnable")}
                />
              </td>
              <td>{t(`sounds.event.${eventId}`)}</td>
              <td className="ts-options-sounds-source">
                {customNames[eventId] ? t("sounds.custom", { name: customNames[eventId]! }) : t("sounds.default")}
              </td>
              <td>
                <button onClick={() => void playSound(eventId)}>{t("sounds.test")}</button>
              </td>
              <td>
                <button onClick={() => handleUploadClick(eventId)}>{t("sounds.upload")}</button>
              </td>
              <td>
                {customNames[eventId] && <button onClick={() => void handleReset(eventId)}>{t("sounds.reset")}</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        style={{ display: "none" }}
        onChange={(e) => void handleFileSelected(e)}
      />
      <input
        ref={soundpackInputRef}
        type="file"
        accept=".ts3soundpack,.zip"
        style={{ display: "none" }}
        onChange={(e) => void handleSoundpackSelected(e)}
      />
    </>
  );
}

function NachrichtenPanel() {
  const t = useT();
  const [presets, setPresets] = useState<MessagePreset[]>(() => loadAwayPresets());
  const [disconnectMessage, setDisconnectMessageState] = useState(() => loadDisconnectMessage());
  const [newName, setNewName] = useState("");
  const [newMessage, setNewMessage] = useState("");

  const handleDisconnectMessageChange = (v: string) => {
    setDisconnectMessageState(v);
    saveDisconnectMessage(v);
  };

  const handleAdd = () => {
    const name = newName.trim();
    const message = newMessage.trim();
    if (!name || !message) return;
    const next = [...presets, { name, message }];
    setPresets(next);
    saveAwayPresets(next);
    setNewName("");
    setNewMessage("");
  };

  const handleDelete = (index: number) => {
    const next = presets.filter((_, i) => i !== index);
    setPresets(next);
    saveAwayPresets(next);
  };

  return (
    <>
      <h3>{t("nachrichten.title")}</h3>
      <p className="ts-options-subtitle">{t("nachrichten.subtitle")}</p>
      <label className="ts-dialog-field">
        {t("nachrichten.disconnectMessage")}
        <input
          value={disconnectMessage}
          onChange={(e) => handleDisconnectMessageChange(e.target.value)}
          placeholder={t("nachrichten.disconnectMessagePlaceholder")}
        />
      </label>
      <h4>{t("nachrichten.presetsTitle")}</h4>
      <table className="ts-options-sounds-table">
        <thead>
          <tr>
            <th>{t("nachrichten.type")}</th>
            <th>{t("nachrichten.templateName")}</th>
            <th>{t("nachrichten.message")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {presets.map((preset, index) => (
            <tr key={`${preset.name}-${index}`}>
              <td>{t("nachrichten.type.away")}</td>
              <td>{preset.name}</td>
              <td>{preset.message}</td>
              <td>
                <button onClick={() => handleDelete(index)}>{t("nachrichten.delete")}</button>
              </td>
            </tr>
          ))}
          <tr>
            <td>{t("nachrichten.type.away")}</td>
            <td>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t("nachrichten.templateName")}
              />
            </td>
            <td>
              <input
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                placeholder={t("nachrichten.message")}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              />
            </td>
            <td>
              <button onClick={handleAdd} disabled={!newName.trim() || !newMessage.trim()}>
                {t("nachrichten.add")}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

function OptionsDialog({
  section,
  onSectionChange,
  onClose,
  audio,
  designSelection,
  onDesignSelectionChange,
  customThemes,
  onSaveCustomTheme,
  onDeleteCustomTheme,
  idePixelFont,
  onIdePixelFontChange,
  showServerBanner,
  onShowServerBannerChange,
  chatImages,
  onChatImagesChange,
  onOpenWhisperLists,
  onOpenIdentities,
  onClearCache,
  onOpenFavorites,
  onApplyPackToFavorites,
}: {
  section: string;
  onSectionChange: (id: string) => void;
  onClose: () => void;
  audio: AudioSettings;
  designSelection: string;
  onDesignSelectionChange: (next: string) => void;
  customThemes: CustomTheme[];
  onSaveCustomTheme: (theme: CustomTheme) => void;
  onDeleteCustomTheme: (id: string) => void;
  idePixelFont: boolean;
  onIdePixelFontChange: (on: boolean) => void;
  showServerBanner: boolean;
  onShowServerBannerChange: (on: boolean) => void;
  chatImages: boolean;
  onChatImagesChange: (on: boolean) => void;
  onOpenWhisperLists: () => void;
  onOpenIdentities: () => void;
  onClearCache: () => void;
  onOpenFavorites: () => void;
  onApplyPackToFavorites: () => void;
}) {
  const t = useT();
  const active = OPTIONS_SECTIONS.find((s) => s.id === section) ?? OPTIONS_SECTIONS[0];
  const backdrop = useBackdropDismiss(onClose);
  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-options-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("options.title")}</span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-options-body">
          <div className="ts-options-sidebar">
            {OPTIONS_SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`ts-options-sidebar-item${s.id === active.id ? " ts-options-sidebar-item-active" : ""}`}
                onClick={() => onSectionChange(s.id)}
              >
                <span className="ts-options-sidebar-icon">{s.icon}</span>
                <span>{t(`options.section.${s.id}`)}</span>
              </button>
            ))}
          </div>
          <div className="ts-options-content">
            {active.id === "anwendung" ? (
              <AnwendungPanel
                showServerBanner={showServerBanner}
                onShowServerBannerChange={onShowServerBannerChange}
                chatImages={chatImages}
                onChatImagesChange={onChatImagesChange}
              />
            ) : active.id === "wiedergabe" ? (
              <WiedergabePanel audio={audio} />
            ) : active.id === "aufnahme" ? (
              <AufnahmePanel audio={audio} />
            ) : active.id === "hotkeys" ? (
              <HotkeysPanel audio={audio} />
            ) : active.id === "sounds" ? (
              <SoundsPanel />
            ) : active.id === "design" ? (
              <DesignPanel
                designSelection={designSelection}
                onSelectionChange={onDesignSelectionChange}
                customThemes={customThemes}
                onSaveCustomTheme={onSaveCustomTheme}
                onDeleteCustomTheme={onDeleteCustomTheme}
                idePixelFont={idePixelFont}
                onIdePixelFontChange={onIdePixelFontChange}
              />
            ) : active.id === "nachrichten" ? (
              <NachrichtenPanel />
            ) : active.id === "whispern" ? (
              <WhisperPanel onOpenWhisperLists={onOpenWhisperLists} />
            ) : active.id === "downloads" ? (
              <DownloadsPanel />
            ) : active.id === "chat" ? (
              <ChatPanel />
            ) : active.id === "sicherheit" ? (
              <SecurityPanel onOpenIdentities={onOpenIdentities} onClearCache={onClearCache} />
            ) : active.id === "konto" ? (
              <KontoPanel />
            ) : active.id === "meldungen" ? (
              <MeldungenPanel onOpenFavorites={onOpenFavorites} onApplyPackToFavorites={onApplyPackToFavorites} />
            ) : (
              <>
                <h3>{t(`options.section.${active.id}`)}</h3>
                <p className="ts-options-placeholder">{t("options.notImplemented")}</p>
              </>
            )}
          </div>
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("options.ok")}</button>
            <button onClick={onClose}>{t("options.cancel")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const SERVER_EDIT_TABS = ["host", "misc", "transmission", "antiflood", "security", "log"] as const;

interface ServerEditPayload {
  name?: string;
  welcomeMessage?: string;
  password?: string;
  maxClients?: number;
  hostmessage?: string;
  hostmessageMode?: string;
  hostbannerUrl?: string;
  hostbannerGfxUrl?: string;
  hostbannerGfxIntervalSecs?: number;
  hostbannerMode?: string;
  hostbuttonTooltip?: string;
  hostbuttonUrl?: string;
  hostbuttonGfxUrl?: string;
  nickname?: string;
  phoneticName?: string;
  codecEncryptionMode?: string;
}

function ServerEditDialog({
  serverName,
  welcomeMessage,
  hostbannerGfxUrl,
  onSave,
  onClose,
}: {
  serverName: string;
  welcomeMessage: string;
  hostbannerGfxUrl: string;
  onSave: (payload: ServerEditPayload) => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const [tab, setTab] = useState<(typeof SERVER_EDIT_TABS)[number]>("host");

  const [name, setName] = useState(serverName);
  const [welcome, setWelcome] = useState(welcomeMessage);
  const [clearPassword, setClearPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [hostmessage, setHostmessage] = useState("");
  const [hostmessageMode, setHostmessageMode] = useState("");
  const [hostbannerUrl, setHostbannerUrl] = useState("");
  const [bannerGfxUrl, setBannerGfxUrl] = useState(hostbannerGfxUrl);
  const [hostbannerGfxInterval, setHostbannerGfxInterval] = useState("");
  const [hostbannerMode, setHostbannerMode] = useState("");
  const [hostbuttonTooltip, setHostbuttonTooltip] = useState("");
  const [hostbuttonUrl, setHostbuttonUrl] = useState("");
  const [hostbuttonGfxUrl, setHostbuttonGfxUrl] = useState("");
  const [maxClients, setMaxClients] = useState("");
  const [nickname, setNickname] = useState("");
  const [phoneticName, setPhoneticName] = useState("");
  const [codecEncryptionMode, setCodecEncryptionMode] = useState("");

  const handleSave = () => {
    const payload: ServerEditPayload = {};
    if (name.trim() && name !== serverName) payload.name = name.trim();
    if (welcome !== welcomeMessage) payload.welcomeMessage = welcome;
    if (clearPassword) payload.password = "";
    else if (password) payload.password = password;
    if (hostmessage) payload.hostmessage = hostmessage;
    if (hostmessageMode) payload.hostmessageMode = hostmessageMode;
    if (hostbannerUrl) payload.hostbannerUrl = hostbannerUrl;
    if (bannerGfxUrl !== hostbannerGfxUrl) payload.hostbannerGfxUrl = bannerGfxUrl;
    if (hostbannerGfxInterval) payload.hostbannerGfxIntervalSecs = Number(hostbannerGfxInterval) || 0;
    if (hostbannerMode) payload.hostbannerMode = hostbannerMode;
    if (hostbuttonTooltip) payload.hostbuttonTooltip = hostbuttonTooltip;
    if (hostbuttonUrl) payload.hostbuttonUrl = hostbuttonUrl;
    if (hostbuttonGfxUrl) payload.hostbuttonGfxUrl = hostbuttonGfxUrl;
    if (maxClients) payload.maxClients = Number(maxClients) || 0;
    if (nickname) payload.nickname = nickname;
    if (phoneticName) payload.phoneticName = phoneticName;
    if (codecEncryptionMode) payload.codecEncryptionMode = codecEncryptionMode;
    onSave(payload);
    onClose();
  };

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-options-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("serverEdit.title")}</span>
          <button onClick={onClose} title={t("dialog.close")} aria-label={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-options-body">
          <div className="ts-options-sidebar">
            {SERVER_EDIT_TABS.map((id) => (
              <button
                key={id}
                className={`ts-options-sidebar-item${id === tab ? " ts-options-sidebar-item-active" : ""}`}
                onClick={() => setTab(id)}
              >
                <span>{t(`serverEdit.tab.${id}`)}</span>
              </button>
            ))}
          </div>
          <div className="ts-options-content">
            {tab === "host" && (
              <>
                <label className="ts-dialog-field">
                  {t("serverEdit.name")}
                  <input value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.welcomeMessage")}
                  <textarea rows={3} value={welcome} onChange={(e) => setWelcome(e.target.value)} />
                </label>
                <label className="ts-dialog-field">
                  <span>
                    <input
                      type="checkbox"
                      checked={clearPassword}
                      onChange={(e) => setClearPassword(e.target.checked)}
                    />{" "}
                    {t("serverEdit.clearPassword")}
                  </span>
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.newPassword")}
                  <input
                    type="password"
                    disabled={clearPassword}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.hostmessage")}
                  <input value={hostmessage} onChange={(e) => setHostmessage(e.target.value)} />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.hostmessageMode")}
                  <select value={hostmessageMode} onChange={(e) => setHostmessageMode(e.target.value)}>
                    <option value="">{t("serverEdit.unchanged")}</option>
                    <option value="none">{t("serverEdit.hostmessageMode.none")}</option>
                    <option value="log">{t("serverEdit.hostmessageMode.log")}</option>
                    <option value="modal">{t("serverEdit.hostmessageMode.modal")}</option>
                    <option value="modalquit">{t("serverEdit.hostmessageMode.modalquit")}</option>
                  </select>
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.hostbannerUrl")}
                  <input value={hostbannerUrl} onChange={(e) => setHostbannerUrl(e.target.value)} />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.hostbannerGfxUrl")}
                  <input value={bannerGfxUrl} onChange={(e) => setBannerGfxUrl(e.target.value)} />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.hostbannerGfxInterval")}
                  <input
                    type="number"
                    min={0}
                    value={hostbannerGfxInterval}
                    onChange={(e) => setHostbannerGfxInterval(e.target.value)}
                  />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.hostbannerMode")}
                  <select value={hostbannerMode} onChange={(e) => setHostbannerMode(e.target.value)}>
                    <option value="">{t("serverEdit.unchanged")}</option>
                    <option value="noadjust">{t("serverEdit.hostbannerMode.noadjust")}</option>
                    <option value="adjustignoreaspect">{t("serverEdit.hostbannerMode.adjustignoreaspect")}</option>
                    <option value="adjustkeepaspect">{t("serverEdit.hostbannerMode.adjustkeepaspect")}</option>
                  </select>
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.hostbuttonTooltip")}
                  <input value={hostbuttonTooltip} onChange={(e) => setHostbuttonTooltip(e.target.value)} />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.hostbuttonUrl")}
                  <input value={hostbuttonUrl} onChange={(e) => setHostbuttonUrl(e.target.value)} />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.hostbuttonGfxUrl")}
                  <input value={hostbuttonGfxUrl} onChange={(e) => setHostbuttonGfxUrl(e.target.value)} />
                </label>
              </>
            )}
            {tab === "misc" && (
              <>
                <label className="ts-dialog-field">
                  {t("serverEdit.maxClients")}
                  <input
                    type="number"
                    min={0}
                    value={maxClients}
                    onChange={(e) => setMaxClients(e.target.value)}
                  />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.nickname")}
                  <input value={nickname} onChange={(e) => setNickname(e.target.value)} />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.phoneticName")}
                  <input value={phoneticName} onChange={(e) => setPhoneticName(e.target.value)} />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.codecEncryptionMode")}
                  <select
                    value={codecEncryptionMode}
                    onChange={(e) => setCodecEncryptionMode(e.target.value)}
                  >
                    <option value="">{t("serverEdit.unchanged")}</option>
                    <option value="perchannel">{t("serverEdit.codecEncryptionMode.perchannel")}</option>
                    <option value="forcedoff">{t("serverEdit.codecEncryptionMode.forcedoff")}</option>
                    <option value="forcedon">{t("serverEdit.codecEncryptionMode.forcedon")}</option>
                  </select>
                </label>
              </>
            )}
            {(tab === "transmission" || tab === "antiflood" || tab === "security" || tab === "log") && (
              <>
                <h3>{t(`serverEdit.tab.${tab}`)}</h3>
                <p className="ts-options-placeholder">{t("options.notImplemented")}</p>
              </>
            )}
          </div>
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={handleSave}>{t("serverEdit.save")}</button>
            <button onClick={onClose}>{t("serverEdit.cancel")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AppInner() {
  const t = useT();
  const [host, setHost] = useState(
    () =>
      localStorage.getItem(LAST_HOST_KEY) ??
      (DEMO_MODE ? DEMO_HOST : loadDesignTheme() === "nova" ? "" : "localhost")
  );
  const [nickname, setNickname] = useState(
    () => localStorage.getItem(LAST_NICKNAME_KEY) ?? (DEMO_MODE ? "Guest" : "")
  );
  const [serverPassword, setServerPassword] = useState("");
  const [channelPassword, setChannelPassword] = useState("");
  const [defaultChannel, setDefaultChannel] = useState("");
  const [privilegeKey, setPrivilegeKey] = useState("");
  const [serverType, setServerType] = useState<ServerType>(loadServerType);
  // Prompt shown when switching into a password-protected channel mid-session
  // (the initial-connect "default channel" password above is a separate field).
  const [channelPasswordPrompt, setChannelPasswordPrompt] = useState<{
    channelId: number;
    channelName: string;
    wrongPassword: boolean;
  } | null>(null);
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // Gateway-broadcast "notice" (currently: SIGTERM restart warning). Global,
  // not per-session - it should show no matter which tab is active.
  const [restartNotice, setRestartNotice] = useState<string | null>(null);
  // What the gateway announced in its "hello" (gateway/src/index.ts). Empty for
  // a gateway older than the handshake, so a feature newer than it stays hidden.
  const [gatewayFeatures, setGatewayFeatures] = useState<ReadonlySet<string>>(new Set());
  // TURN relay the gateway offers for screen streams (TURN_URLS), if any.
  const [turnServers, setTurnServers] = useState<RTCIceServer[]>([]);
  // Terms of use, own-hosted instance only (see IS_OWN_HOSTED_INSTANCE): shown
  // mandatorily on first visit, reopenable any time from the menu afterwards.
  const [tosOpen, setTosOpen] = useState(false);
  // client.webspeak3.de/#about opens the About dialog directly (shareable link).
  const [aboutOpen, setAboutOpen] = useState(() => window.location.hash === "#about");
  const [tosMandatory, setTosMandatory] = useState(false);
  useEffect(() => {
    if (IS_OWN_HOSTED_INSTANCE && !hasAcceptedToS()) {
      setTosMandatory(true);
      setTosOpen(true);
    }
  }, []);
  const [connectDialogExpanded, setConnectDialogExpanded] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [treeFilter, setTreeFilter] = useState("");
  const [clientVolumes, setClientVolumes] = useState<Record<string, number>>(loadClientVolumes);
  /** Stream metadata per publishing client id, keyed by clid. */
  const [streamInfos, setStreamInfos] = useState<Record<number, StreamInfo>>({});
  const [watchedStream, setWatchedStream] = useState<StreamInfo | null>(null);
  const [streamMedia, setStreamMedia] = useState<MediaStream | null>(null);
  const [streamState, setStreamState] = useState<RTCPeerConnectionState>("new");
  const [streamError, setStreamError] = useState<string | null>(null);
  const streamViewerRef = useRef<StreamViewer | null>(null);
  const [publishState, setPublishState] = useState<PublishState>("idle");
  const [publishViewers, setPublishViewers] = useState<number[]>([]);
  const [publishPending, setPublishPending] = useState<[number, string][]>([]);
  const [publishError, setPublishError] = useState<string | null>(null);
  const publisherRef = useRef<StreamPublisher | null>(null);
  const publishPreviewRef = useRef<HTMLVideoElement | null>(null);
  const [streamSettingsOpen, setStreamSettingsOpen] = useState(false);
  const streamVideoRef = useRef<HTMLVideoElement | null>(null);
  /** Clients we already pulled a `notifystreaminfo` for, so we ask only once. */
  const requestedStreamInfoRef = useRef<Set<number>>(new Set());
  /** Stable self id from the connector (`own_client_id`); nickname match is fallback only. */
  const [ownClientId, setOwnClientId] = useState<number | null>(null);
  const [serverName, setServerName] = useState("");
  const [serverMaxClients, setServerMaxClients] = useState(0);
  const [serverClientsOnline, setServerClientsOnline] = useState(0);
  const [serverChannelsOnline, setServerChannelsOnline] = useState(0);
  const [serverVersion, setServerVersion] = useState("");
  const [serverLicense, setServerLicense] = useState("");
  const [serverLicenseId, setServerLicenseId] = useState(0);
  const [serverBannerUrl, setServerBannerUrl] = useState("");
  const [showServerBanner, setShowServerBanner] = useState(() => localStorage.getItem(SERVER_BANNER_KEY) !== "off");
  const [idePixelFont, setIdePixelFont] = useState(() => localStorage.getItem(IDE_PIXEL_FONT_KEY) !== "off");
  const [chatImages, setChatImages] = useState(() => localStorage.getItem(CHAT_IMAGES_KEY) === "on");
  const [serverWelcomeMessage, setServerWelcomeMessage] = useState("");
  const [serverEditOpen, setServerEditOpen] = useState(false);
  const [serverProtocolLogOpen, setServerProtocolLogOpen] = useState(false);
  const [serverProtocolLog, setServerProtocolLog] = useState<string[] | null>(null);
  const [banListOpen, setBanListOpen] = useState(false);
  const [banList, setBanList] = useState<BanListEntry[] | null>(null);
  const [complainListOpen, setComplainListOpen] = useState(false);
  const [complainList, setComplainList] = useState<ComplainListEntry[] | null>(null);
  const [offlineMessagesOpen, setOfflineMessagesOpen] = useState(false);
  const [offlineMessageList, setOfflineMessageList] = useState<OfflineMessageListEntry[] | null>(null);
  const [offlineMessageDetail, setOfflineMessageDetail] = useState<
    { messageId: number; clientUid: string; subject: string; message: string; timestamp: string } | null
  >(null);
  const [channelGroups, setChannelGroups] = useState<GroupEntry[] | null>(null);
  const [serverGroups, setServerGroups] = useState<GroupEntry[] | null>(null);
  const [groupAssignTarget, setGroupAssignTarget] = useState<{
    kind: "channel" | "server";
    clientId: number;
    clientName: string;
  } | null>(null);
  const [moveClientTarget, setMoveClientTarget] = useState<{
    clientId: number;
    clientName: string;
    channelId: number;
  } | null>(null);
  const [permissionOverviewOpen, setPermissionOverviewOpen] = useState(false);
  const [permissionOverview, setPermissionOverview] = useState<PermissionOverviewEntry[] | null>(null);
  const [permissionsEditorOpen, setPermissionsEditorOpen] = useState(false);
  const [permissionsEditorScope, setPermissionsEditorScope] = useState<PermScope>("server");
  const [permissionsEditorEntries, setPermissionsEditorEntries] = useState<PermissionOverviewEntry[] | null>(null);
  const [permissionsEditorTarget, setPermissionsEditorTarget] = useState<
    { scope: PermScope; id1: number; id2?: number } | null
  >(null);
  const [permissionCatalog, setPermissionCatalog] = useState<PermissionCatalogEntry[] | null>(null);
  const permissionCatalogRequestedRef = useRef(false);
  const [fileBrowserTarget, setFileBrowserTarget] = useState<{ channelId: number; channelName: string } | null>(
    null
  );
  const [fileBrowserPath, setFileBrowserPath] = useState("/");
  const [fileBrowserEntries, setFileBrowserEntries] = useState<FileListEntry[] | null>(null);
  const [serverIconsOpen, setServerIconsOpen] = useState(false);
  const [serverIconEntries, setServerIconEntries] = useState<FileListEntry[] | null>(null);
  const [serverIconImages, setServerIconImages] = useState<Record<string, string>>({});
  const [treeWidth, setTreeWidth] = useState(260);
  const [upperHeight, setUpperHeight] = useState(340);
  const [selected, setSelected] = useState<SelectedItem | null>(null);
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [serverChat, setServerChat] = useState<ChatEntry[]>([]);
  const [chatInput, setChatInput] = useState("");
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const [pmThreads, setPmThreads] = useState<Record<number, PmThread>>({});
  const [pokes, setPokes] = useState<PokeNotice[]>([]);
  const [pokeTarget, setPokeTarget] = useState<{ id: number; name: string } | null>(null);
  const [pokeMessage, setPokeMessage] = useState("");
  const pokeBackdrop = useBackdropDismiss(() => setPokeTarget(null));
  const [kickTarget, setKickTarget] = useState<{ id: number; name: string; scope: "channel" | "server" } | null>(
    null
  );
  const [kickReason, setKickReason] = useState("");
  const kickBackdrop = useBackdropDismiss(() => setKickTarget(null));
  const [banTarget, setBanTarget] = useState<{ id: number; name: string } | null>(null);
  const [banReason, setBanReason] = useState("");
  const [banSeconds, setBanSeconds] = useState("0");
  const banBackdrop = useBackdropDismiss(() => setBanTarget(null));
  const [demoForceMobile, setDemoForceMobile] = useState(false);
  const [clientContextMenu, setClientContextMenu] = useState<{
    x: number;
    y: number;
    clientId: number;
    clientName: string;
    isSelf: boolean;
  } | null>(null);
  const clientContextMenuRef = useRef<HTMLDivElement>(null);
  const [serverContextMenu, setServerContextMenu] = useState<{ x: number; y: number } | null>(null);
  const serverContextMenuRef = useRef<HTMLDivElement>(null);
  const [channelContextMenu, setChannelContextMenu] = useState<{
    x: number;
    y: number;
    channelId: number;
    channelName: string;
  } | null>(null);
  const channelContextMenuRef = useRef<HTMLDivElement>(null);
  const [whisperChannelIds, setWhisperChannelIds] = useState<Set<number>>(new Set());
  const [whisperClientIds, setWhisperClientIds] = useState<Set<number>>(new Set());
  const [whisperMenuOpen, setWhisperMenuOpen] = useState(false);
  const whisperMenuRef = useRef<HTMLDivElement | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("channel");
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  );
  const [customThemes, setCustomThemes] = useState<CustomTheme[]>(() => loadCustomThemes());
  const [designSelection, setDesignSelection] = useState<string>(() => loadDesignSelection());
  const activeCustomTheme = designSelection.startsWith("custom:")
    ? customThemes.find((th) => `custom:${th.id}` === designSelection) ?? null
    : null;
  // Structural base - everywhere else in the app that branches on "nova" /
  // "pulse" behavior keeps working unchanged, whether that behavior
  // came from picking the builtin directly or from a custom theme on top of it.
  const designTheme: DesignTheme = resolveDesignThemeBase(designSelection, customThemes);
  useEffect(() => setSoundStyle(designTheme === "ide" ? "ide" : "classic"), [designTheme]);
  const handleDesignSelectionChange = (next: string) => {
    setDesignSelection(next);
    localStorage.setItem(DESIGN_SELECTION_KEY, next);
  };
  // Persisted from the resolved value, not in the handler: a theme selected
  // right after being created/installed isn't in the handler's customThemes yet.
  useEffect(() => {
    localStorage.setItem(DESIGN_THEME_KEY, designTheme);
  }, [designTheme]);
  const handleSaveCustomTheme = (nextTheme: CustomTheme) => {
    setCustomThemes((prev) => {
      const idx = prev.findIndex((th) => th.id === nextTheme.id);
      const next = idx === -1 ? [...prev, nextTheme] : prev.map((th, i) => (i === idx ? nextTheme : th));
      saveCustomThemes(next);
      return next;
    });
  };
  const handleDeleteCustomTheme = (id: string) => {
    setCustomThemes((prev) => {
      const next = prev.filter((th) => th.id !== id);
      saveCustomThemes(next);
      return next;
    });
    if (designSelection === `custom:${id}`) handleDesignSelectionChange("standard");
  };
  // Custom themes ship as free-form CSS - inject/replace it in a dedicated <style>
  // tag while active, and drop it the moment no custom theme is selected.
  useEffect(() => {
    const css = activeCustomTheme?.css ?? "";
    const existing = document.getElementById("ts-custom-theme-style") as HTMLStyleElement | null;
    if (!css) {
      existing?.remove();
      return;
    }
    const el = existing ?? document.createElement("style");
    el.id = "ts-custom-theme-style";
    el.textContent = css;
    if (!existing) document.head.appendChild(el);
  }, [activeCustomTheme?.id, activeCustomTheme?.css]);
  const [treeOptions, setTreeOptions] = useState(loadTreeOptions);
  const [iconPacks, setIconPacks] = useState(loadIconPacks);
  const [iconPackId, setIconPackId] = useState(loadSelectedIconPack);
  const [whisperSettings, setWhisperSettings] = useState(loadWhisperSettings);
  const [downloadSettings, setDownloadSettings] = useState(loadDownloadSettings);
  const downloadSettingsRef = useRef(downloadSettings);
  downloadSettingsRef.current = downloadSettings;
  const [downloadDir, setDownloadDir] = useState<FileSystemDirectoryHandle | null>(null);
  const [chatSettings, setChatSettings] = useState(loadChatSettings);
  const [securitySettings, setSecuritySettings] = useState(loadSecuritySettings);
  const securitySettingsRef = useRef(securitySettings);
  securitySettingsRef.current = securitySettings;
  // "... beim Beenden": pagehide is the last event a closing tab reliably gets.
  useEffect(() => {
    const onHide = () => {
      const settings = securitySettingsRef.current;
      if (settings.clearUrlsOnExit) localStorage.removeItem(COLLECTED_URLS_KEY);
      if (settings.clearCacheOnExit) void clearBrowserCaches();
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);
  const chatSettingsRef = useRef(chatSettings);
  chatSettingsRef.current = chatSettings;
  // "Hinweis für eingehende Nachrichten" for the two fixed tabs (private chats have their own flag).
  const [chatUnread, setChatUnread] = useState({ channel: false, server: false });
  useEffect(() => {
    void loadDownloadDir().then(setDownloadDir);
  }, []);
  const whisperSettingsRef = useRef(whisperSettings);
  whisperSettingsRef.current = whisperSettings;
  const displayPrefs = useMemo(
    () => ({
      tree: treeOptions,
      setTree: (next: TreeOptions) => {
        setTreeOptions(next);
        localStorage.setItem(TREE_OPTIONS_KEY, JSON.stringify(next));
      },
      iconPacks,
      iconPackId,
      setIconPackId: (id: string) => {
        setIconPackId(id);
        saveSelectedIconPack(id);
      },
      saveIconPacks: (packs: IconPack[]) => {
        saveIconPacks(packs); // throws when storage is full - before the state changes
        setIconPacks(packs);
      },
      whisper: whisperSettings,
      setWhisper: (next: WhisperSettings) => {
        setWhisperSettings(next);
        localStorage.setItem(WHISPER_SETTINGS_KEY, JSON.stringify(next));
      },
      downloads: downloadSettings,
      setDownloads: (next: DownloadSettings) => {
        setDownloadSettings(next);
        saveDownloadSettings(next);
      },
      downloadDir,
      setDownloadDir,
      chat: chatSettings,
      setChat: (next: ChatSettings) => {
        setChatSettings(next);
        saveChatSettings(next);
      },
      security: securitySettings,
      setSecurity: (next: SecuritySettings) => {
        setSecuritySettings(next);
        localStorage.setItem(SECURITY_SETTINGS_KEY, JSON.stringify(next));
      },
    }),
    [treeOptions, iconPacks, iconPackId, whisperSettings, downloadSettings, downloadDir, chatSettings, securitySettings]
  );
  const iconPackStyle = iconPackCss(iconPacks.find((p) => p.id === iconPackId));
  const [micOn, setMicOn] = useState(false);
  const [talkers, setTalkers] = useState<Set<number>>(new Set());
  const [selfActive, setSelfActive] = useState(false);
  const [vadThreshold, setVadThreshold] = useState(0.02);
  const [vadHangover, setVadHangover] = useState(() => loadNumberPref(VAD_HANGOVER_KEY, 0.3));
  const [pushToTalk, setPushToTalk] = useState(() => loadBoolPref(PUSH_TO_TALK_KEY, false));
  // Only matters while pushToTalk is off: send all the time instead of voice activation.
  const [continuous, setContinuous] = useState(() => loadBoolPref(CONTINUOUS_KEY, false));
  const continuousRef = useRef(continuous);
  const [typingAttenuation, setTypingAttenuation] = useState(() => loadBoolPref(TYPING_ATTENUATION_KEY, false));
  const typingAttenuationRef = useRef(typingAttenuation);
  const [pttBinding, setPttBinding] = useState<PttBinding | null>(loadPttBinding);
  const [pttPressed, setPttPressed] = useState(false);
  // Read when a new MicCapture is created, which happens outside render.
  const pushToTalkRef = useRef(pushToTalk);
  const pttPressedRef = useRef(false);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDeviceId, setOutputDeviceId] = useState("");
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [inputDeviceId, setInputDeviceId] = useState(() => localStorage.getItem(INPUT_DEVICE_KEY) ?? "");
  const [playbackVolume, setPlaybackVolume] = useState(() => loadNumberPref(PLAYBACK_VOLUME_KEY, 1));
  const [noiseSuppressionEnabled, setNoiseSuppressionEnabled] = useState(() =>
    loadBoolPref(NOISE_SUPPRESSION_KEY, true)
  );
  const [echoCancellationEnabled, setEchoCancellationEnabled] = useState(() =>
    loadBoolPref(ECHO_CANCELLATION_KEY, true)
  );
  const [autoGainControlEnabled, setAutoGainControlEnabled] = useState(() =>
    loadBoolPref(AUTO_GAIN_CONTROL_KEY, true)
  );
  // Off by default: a heavier, opt-in alternative/supplement to native AEC for
  // speaker+mic (no headset) setups (github.com/WebSpeak3/webspeak3 issue #2).
  const [aec3Enabled, setAec3Enabled] = useState(() => loadBoolPref(AEC3_ENABLED_KEY, false));
  // Playback options. The clicks themselves are sounds (micClickOn/Off).
  const [autoVolume, setAutoVolume] = useState(() => loadBoolPref(AUTO_VOLUME_KEY, true));
  const [ownMicClicks, setOwnMicClicks] = useState(() => loadBoolPref(OWN_MIC_CLICKS_KEY, false));
  const [otherMicClicks, setOtherMicClicks] = useState(() => loadBoolPref(OTHER_MIC_CLICKS_KEY, false));
  // Read from the socket handler, which only sees the first render's state.
  const otherMicClicksRef = useRef(otherMicClicks);
  const talkersRef = useRef<Set<number>>(new Set());
  const [aec3Loading, setAec3Loading] = useState(false);
  const aec3Ref = useRef<Aec3Instance | null>(null);
  // Mirrors aec3Enabled but updates immediately, for startMic() calls made in
  // the same tick as a toggle (restartMic right after setAec3Enabled).
  const aec3EnabledRef = useRef(aec3Enabled);
  const [micTestOn, setMicTestOn] = useState(false);
  const [connectionsMenuOpen, setConnectionsMenuOpen] = useState(false);
  // Nova-theme-only: collapses the classic menu items behind a hamburger button.
  const [novaMenuOpen, setNovaMenuOpen] = useState(false);
  const novaMenuRef = useRef<HTMLDivElement | null>(null);
  const [favorites, setFavorites] = useState<Favorite[]>(() => loadFavorites());
  /** Favorite that opened the active session tab; drives ServerQuery visibility. */
  const [activeFavoriteId, setActiveFavoriteId] = useState<string | null>(null);
  const [favoritesMenuOpen, setFavoritesMenuOpen] = useState(false);
  const [favoritesDialogMode, setFavoritesDialogMode] = useState<
    { kind: "add"; prefill: Omit<Favorite, "id" | "bookmarkName"> } | { kind: "manage" } | null
  >(null);
  const [awayMenuOpen, setAwayMenuOpen] = useState(false);
  const [awayDialogOpen, setAwayDialogOpen] = useState(false);
  const [awayDialogMessage, setAwayDialogMessage] = useState("");
  const [awayPresets, setAwayPresets] = useState<MessagePreset[]>(() => loadAwayPresets());
  const [extrasMenuOpen, setExtrasMenuOpen] = useState(false);
  const [helpMenuOpen, setHelpMenuOpen] = useState(false);
  const [collectedUrls, setCollectedUrls] = useState<CollectedUrl[]>(() => loadCollectedUrls());
  const [collectedUrlsOpen, setCollectedUrlsOpen] = useState(false);
  const [inviteFriendOpen, setInviteFriendOpen] = useState(false);
  const [logEntries, setLogEntries] = useState<ClientLogEntry[]>([]);
  const [clientLogOpen, setClientLogOpen] = useState(false);
  const logIdRef = useRef(0);
  const [whisperLog, setWhisperLog] = useState<WhisperLogEntry[]>([]);
  const [whisperHistoryOpen, setWhisperHistoryOpen] = useState(false);
  const [whisperLists, setWhisperLists] = useState<WhisperList[]>(() => loadWhisperLists());
  const [whisperListsOpen, setWhisperListsOpen] = useState(false);
  const [identities, setIdentities] = useState<Identity[]>(() => loadIdentities());
  const [activeIdentityId, setActiveIdentityId] = useState<string | null>(() =>
    localStorage.getItem(ACTIVE_IDENTITY_KEY)
  );
  const [identitiesOpen, setIdentitiesOpen] = useState(false);
  const [clientConnectionInfoTarget, setClientConnectionInfoTarget] = useState<{ id: number; name: string } | null>(
    null
  );
  const [clientConnectionInfo, setClientConnectionInfo] = useState<ClientConnectionInfoData | null>(null);
  const [serverConnectionInfoOpen, setServerConnectionInfoOpen] = useState(false);
  const [serverConnectionInfo, setServerConnectionInfo] = useState<ServerConnectionInfoData | null>(null);
  const [selfMenuOpen, setSelfMenuOpen] = useState(false);
  const selfMenuRef = useRef<HTMLDivElement | null>(null);
  const [rightsMenuOpen, setRightsMenuOpen] = useState(false);
  const rightsMenuRef = useRef<HTMLDivElement | null>(null);
  const [changeNicknameOpen, setChangeNicknameOpen] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState("");
  const nicknameBackdrop = useBackdropDismiss(() => setChangeNicknameOpen(false));
  const [serverQueryLoginOpen, setServerQueryLoginOpen] = useState(false);
  const [serverQueryUsername, setServerQueryUsername] = useState("");
  const [serverQueryPassword, setServerQueryPassword] = useState("");
  const serverQueryLoginBackdrop = useBackdropDismiss(() => setServerQueryLoginOpen(false));
  const [contacts, setContacts] = useState<Contact[]>(() => loadContacts());
  const [contactsOpen, setContactsOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const whisperLogIdRef = useRef(0);
  const prevWhisperTargetsRef = useRef<{ channels: Set<number>; clients: Set<number> } | null>(null);
  // Channel passwords entered this session, so re-entering a channel already
  // unlocked doesn't prompt again. In-memory only - cleared on disconnect.
  const channelPasswordCacheRef = useRef<Map<number, string>>(new Map());

  const logClient = (level: LogLevel, category: string, message: string) => {
    const entry: ClientLogEntry = { id: ++logIdRef.current, timestamp: Date.now(), category, level, message };
    setLogEntries((prev) => [...prev.slice(-(MAX_LOG_ENTRIES - 1)), entry]);
  };
  // client.webspeak3.de/#options/konto opens Options on that section (shareable link, e.g. for the ticker).
  const linkedOptionsSection = OPTIONS_SECTIONS.find((s) => window.location.hash === `#options/${s.id}`)?.id;
  const [optionsDialogOpen, setOptionsDialogOpen] = useState(!!linkedOptionsSection);
  const [optionsSection, setOptionsSection] = useState<string>(linkedOptionsSection ?? OPTIONS_SECTIONS[0].id);
  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash;
      if (hash === "#about") setAboutOpen(true);
      const section = OPTIONS_SECTIONS.find((s) => hash === `#options/${s.id}`)?.id;
      if (section) {
        setOptionsSection(section);
        setOptionsDialogOpen(true);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const socketRef = useRef<WebSocket | DemoSocket | null>(null);
  /** Multi-join: one gateway WebSocket (+ connector) per session tab. */
  const [sessionTabs, setSessionTabs] = useState<SessionTabInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const sessionsRef = useRef<Map<string, SessionRecord>>(new Map());
  const activeSessionIdRef = useRef<string | null>(null);
  /** Last-used connect params per session, kept around so a dropped session
   *  (active OR parked/background) can reconnect itself without the user
   *  re-entering host/password — see reconnectSession(). */
  const sessionParamsRef = useRef<Map<string, ConnectParams>>(new Map());
  const connectionsMenuRef = useRef<HTMLDivElement | null>(null);
  const favoritesMenuRef = useRef<HTMLDivElement | null>(null);
  const awayMenuRef = useRef<HTMLDivElement | null>(null);
  const extrasMenuRef = useRef<HTMLDivElement | null>(null);
  const helpMenuRef = useRef<HTMLDivElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioPlayerRef = useRef<AudioPlayer | null>(null);
  const micCaptureRef = useRef<MicCapture | null>(null);
  // A shared tab's or window's audio, mixed into the mic (MicCapture.setExtraAudio).
  const tabAudioRef = useRef<MediaStream | null>(null);
  const [tabAudioOn, setTabAudioOn] = useState(false);
  const recordProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const recordSilenceRef = useRef<GainNode | null>(null);
  const recordChunksRef = useRef<{ left: Float32Array[]; right: Float32Array[] }>({ left: [], right: [] });
  const activeTabRef = useRef<ActiveTab>("channel");
  const hasConnectedRef = useRef(false);
  // Sessions that reached "connected" at least once. hasConnectedRef (and
  // parked.hasConnected) reset for every reconnect attempt; this doesn't, so
  // a failed reconnect keeps retrying instead of closing the tab outright.
  const everConnectedRef = useRef(new Set<string>());
  // Set when a "disconnected" event is received, so the socket's onclose
  // handler (which fires shortly after, on its own close handshake) can tell
  // a clean disconnect apart from the socket dying before ever connecting.
  const cleanDisconnectRef = useRef(false);
  const previousClientsRef = useRef<ClientInfo[] | null>(null);
  const pokeIdRef = useRef(0);
  const inputMutedRef = useRef(false);
  const outputMutedRef = useRef(false);
  const micLevelRef = useRef(0);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [chat, serverChat, pmThreads, activeTab]);

  useEffect(() => {
    localStorage.setItem(COLLECTED_URLS_KEY, JSON.stringify(collectedUrls));
  }, [collectedUrls]);

  useEffect(() => {
    localStorage.setItem(CONTACTS_KEY, JSON.stringify(contacts));
  }, [contacts]);

  useEffect(() => {
    localStorage.setItem(CLIENT_VOLUMES_KEY, JSON.stringify(clientVolumes));
  }, [clientVolumes]);

  // Push each visible client's volume to its connector. Remembered per socket,
  // so a reconnect (fresh connector) resends everything, and a client id reused
  // by someone else gets reset to that person's volume.
  const sentClientVolumesRef = useRef(new WeakMap<object, Map<number, number>>());
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !connected || !gatewayFeatures.has("clientVolume")) return;
    let sent = sentClientVolumesRef.current.get(socket);
    if (!sent) sentClientVolumesRef.current.set(socket, (sent = new Map()));
    for (const c of clients) {
      const volume = clientVolumes[c.uid] ?? 1;
      if ((sent.get(c.id) ?? 1) === volume) continue;
      socket.send(JSON.stringify({ type: "setClientVolume", clientId: c.id, volume }));
      sent.set(c.id, volume);
    }
  }, [clients, clientVolumes, connected, gatewayFeatures]);

  useEffect(() => {
    localStorage.setItem(WHISPER_LISTS_KEY, JSON.stringify(whisperLists));
  }, [whisperLists]);

  useEffect(() => {
    localStorage.setItem(IDENTITIES_KEY, JSON.stringify(identities));
  }, [identities]);

  useEffect(() => {
    if (activeIdentityId) localStorage.setItem(ACTIVE_IDENTITY_KEY, activeIdentityId);
  }, [activeIdentityId]);

  const isSenderIgnored = (senderName: string) => {
    const senderClient = clients.find((c) => c.name === senderName);
    if (!senderClient?.uid) return false;
    return contacts.some((c) => c.uid === senderClient.uid && c.ignored);
  };

  const recordUrlsFromMessage = (message: string, sender: string) => {
    const found = message.match(BARE_URL_REGEX);
    if (!found) return;
    const now = Date.now();
    setCollectedUrls((prev) => {
      const next = [...prev];
      for (const url of found) {
        const idx = next.findIndex((u) => u.url === url);
        if (idx >= 0) {
          next[idx] = { ...next[idx], count: next[idx].count + 1, lastSeen: now, lastSender: sender };
        } else {
          next.push({ url, count: 1, lastSeen: now, lastSender: sender });
        }
      }
      return next;
    });
  };

  // Same lookup as `ownClient` below: by server-reported id first, since a
  // nickname match breaks as soon as we're renamed (by us or the server).
  const ownNameRef = useRef<string | null>(null);
  useEffect(() => {
    const own =
      (ownClientId != null ? clients.find((c) => c.id === ownClientId) : null) ??
      clients.find((c) => c.name === nickname) ??
      null;
    inputMutedRef.current = own?.inputMuted ?? false;
    outputMutedRef.current = own?.outputMuted ?? false;
    ownNameRef.current = own?.name ?? null;
  }, [clients, nickname, ownClientId]);

  useEffect(() => {
    if (micCaptureRef.current) micCaptureRef.current.threshold = vadThreshold;
  }, [vadThreshold]);

  useEffect(() => {
    if (micCaptureRef.current) micCaptureRef.current.hangoverSeconds = vadHangover;
    localStorage.setItem(VAD_HANGOVER_KEY, String(vadHangover));
  }, [vadHangover]);

  useEffect(() => {
    pushToTalkRef.current = pushToTalk;
    if (micCaptureRef.current) micCaptureRef.current.pushToTalk = pushToTalk;
    localStorage.setItem(PUSH_TO_TALK_KEY, pushToTalk ? "1" : "0");
  }, [pushToTalk]);

  useEffect(() => {
    continuousRef.current = continuous;
    if (micCaptureRef.current) micCaptureRef.current.continuous = continuous;
    localStorage.setItem(CONTINUOUS_KEY, continuous ? "1" : "0");
  }, [continuous]);

  useEffect(() => {
    typingAttenuationRef.current = typingAttenuation;
    if (micCaptureRef.current) micCaptureRef.current.typingAttenuation = typingAttenuation;
    localStorage.setItem(TYPING_ATTENUATION_KEY, typingAttenuation ? "1" : "0");
    if (!typingAttenuation) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // The push-to-talk key is not typing.
      if (e.code !== pttBinding?.code) micCaptureRef.current?.noteTyping();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [typingAttenuation, pttBinding]);

  useEffect(() => {
    pttPressedRef.current = pttPressed;
    if (micCaptureRef.current) micCaptureRef.current.pttPressed = pttPressed;
  }, [pttPressed]);

  useEffect(() => {
    if (pttBinding) localStorage.setItem(PTT_BINDING_KEY, JSON.stringify(pttBinding));
  }, [pttBinding]);

  // Browsers only deliver keys while this tab has focus - there's no global
  // hotkey for websites, so PTT can't work while another program is in front.
  useEffect(() => {
    if (!pushToTalk || !pttBinding) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== pttBinding.code || e.defaultPrevented) return;
      // A letter key still has to type in chat; F-keys or modifiers work anywhere.
      if (e.key.length === 1 && isTypingTarget(e.target)) return;
      if (!isTypingTarget(e.target)) e.preventDefault();
      setPttPressed(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === pttBinding.code) setPttPressed(false);
    };
    // preventDefault: no middle-click autoscroll, no back/forward navigation
    // from the side buttons (which fires on release).
    const onMouseDown = (e: MouseEvent) => {
      if (`Mouse${e.button}` !== pttBinding.code) return;
      e.preventDefault();
      setPttPressed(true);
    };
    const onMouseUp = (e: MouseEvent) => {
      if (`Mouse${e.button}` !== pttBinding.code) return;
      e.preventDefault();
      setPttPressed(false);
    };
    // The keyup goes to whatever has focus next; don't leave the mic open.
    const release = () => setPttPressed(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", release);
      release();
    };
  }, [pushToTalk, pttBinding]);

  useEffect(() => {
    audioPlayerRef.current?.setVolume(playbackVolume);
    localStorage.setItem(PLAYBACK_VOLUME_KEY, String(playbackVolume));
  }, [playbackVolume]);

  useEffect(() => {
    audioPlayerRef.current?.setAutoVolume(autoVolume);
    localStorage.setItem(AUTO_VOLUME_KEY, autoVolume ? "1" : "0");
  }, [autoVolume]);

  useEffect(() => {
    localStorage.setItem(OWN_MIC_CLICKS_KEY, ownMicClicks ? "1" : "0");
  }, [ownMicClicks]);

  useEffect(() => {
    otherMicClicksRef.current = otherMicClicks;
    localStorage.setItem(OTHER_MIC_CLICKS_KEY, otherMicClicks ? "1" : "0");
  }, [otherMicClicks]);

  useEffect(() => {
    localStorage.setItem(NOISE_SUPPRESSION_KEY, noiseSuppressionEnabled ? "1" : "0");
  }, [noiseSuppressionEnabled]);

  useEffect(() => {
    localStorage.setItem(ECHO_CANCELLATION_KEY, echoCancellationEnabled ? "1" : "0");
  }, [echoCancellationEnabled]);

  useEffect(() => {
    localStorage.setItem(AUTO_GAIN_CONTROL_KEY, autoGainControlEnabled ? "1" : "0");
  }, [autoGainControlEnabled]);

  useEffect(() => {
    localStorage.setItem(AEC3_ENABLED_KEY, aec3Enabled ? "1" : "0");
  }, [aec3Enabled]);

  useEffect(() => {
    if (inputDeviceId) localStorage.setItem(INPUT_DEVICE_KEY, inputDeviceId);
  }, [inputDeviceId]);

  useEffect(() => {
    activeTabRef.current = activeTab;
    if (activeTab === "channel" || activeTab === "server")
      setChatUnread((prev) => (prev[activeTab] ? { ...prev, [activeTab]: false } : prev));
    if (typeof activeTab === "number") {
      setPmThreads((prev) => {
        const thread = prev[activeTab];
        if (!thread || !thread.unread) return prev;
        return { ...prev, [activeTab]: { ...thread, unread: false } };
      });
    }
  }, [activeTab]);

  const refreshOutputDevices = async () => {
    try {
      const devices = await listAudioOutputDevices();
      setOutputDevices(devices);
    } catch {
      // Device labels/enumeration may be unavailable before mic permission is granted.
    }
  };

  const refreshInputDevices = async () => {
    try {
      const devices = await listAudioInputDevices();
      setInputDevices(devices);
    } catch {
      // Device labels/enumeration may be unavailable before mic permission is granted.
    }
  };

  useEffect(() => {
    const refreshBoth = () => {
      void refreshOutputDevices();
      void refreshInputDevices();
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshBoth);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshBoth);
  }, []);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    const sessions = sessionsRef.current;
    return () => {
      for (const rec of sessions.values()) {
        try {
          rec.socket?.close();
        } catch {
          /* ignore */
        }
      }
      sessions.clear();
    };
  }, []);

  const appendLog = (entry: LogEntry) => setLog((prev) => [...prev.slice(-(MAX_LOG_ENTRIES - 1)), entry]);

  const startTreeResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = treeWidth;
    const onMove = (ev: MouseEvent) => {
      setTreeWidth(Math.min(500, Math.max(150, startWidth + (ev.clientX - startX))));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startUpperResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = upperHeight;
    const onMove = (ev: MouseEvent) => {
      setUpperHeight(Math.min(700, Math.max(120, startHeight + (ev.clientY - startY))));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Bumped by every start/stop: a startMic() still awaiting getUserMedia
  // compares against it afterwards and discards its mic if it was superseded,
  // instead of installing it after a stopMic() that already "ran".
  const micGenerationRef = useRef(0);

  const stopMic = () => {
    micGenerationRef.current++;
    micCaptureRef.current?.stop();
    micCaptureRef.current = null;
    setMicOn(false);
    setSelfActive(false);
  };

  // Mic/output-device setup shouldn't require an active server connection (like
  // the real TS3 client, where you can test your devices before connecting) -
  // lazily create the audio context on first use instead of tying it to connect.
  const ensureAudioContext = (): AudioContext => {
    if (!audioContextRef.current) {
      const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioContextRef.current = audioContext;
      const player = new AudioPlayer(audioContext);
      audioPlayerRef.current = player;
      // The volume effect and the device picker only ever touch the player
      // that existed at the time - a fresh one (first use, or after
      // disposeAudioIfIdle) has to be brought up to the current settings.
      player.setVolume(playbackVolume);
      player.setAutoVolume(autoVolume);
      if (outputDeviceId) {
        player.setOutputDevice(outputDeviceId).catch((error: Error) =>
          appendLog({ text: `Output device error: ${error.message}`, kind: "error" }),
        );
      }
    }
    return audioContextRef.current;
  };

  // Browsers keep an AudioContext created without a user gesture (auto-mic
  // on page load, a reconnect) "suspended" - silent - until one happens. The
  // mic permission prompt used to be the only thing resuming it, so with the
  // mic denied or absent you'd never hear anyone. Any click/keypress does it,
  // and also starts the player's hidden <audio> element (see unlock()).
  useEffect(() => {
    const resume = () => {
      const ctx = audioContextRef.current;
      if (ctx?.state === "suspended") ctx.resume().catch(() => {});
      audioPlayerRef.current?.unlock();
    };
    // pointerup too: on touch screens pointerdown doesn't count as a user
    // gesture, so resume()/play() from it alone are refused on phones.
    window.addEventListener("pointerdown", resume, true);
    window.addEventListener("pointerup", resume, true);
    window.addEventListener("keydown", resume, true);
    return () => {
      window.removeEventListener("pointerdown", resume, true);
      window.removeEventListener("pointerup", resume, true);
      window.removeEventListener("keydown", resume, true);
    };
  }, []);

  const snapshotActiveToParked = (): ParkedSessionState =>
    emptyParkedState({
      host,
      nickname,
      connected,
      connecting,
      connectError,
      channels,
      clients,
      ownClientId,
      serverName,
      serverMaxClients,
      serverClientsOnline,
      serverChannelsOnline,
      serverVersion,
      serverLicense,
      serverLicenseId,
      serverBannerUrl,
      serverWelcomeMessage,
      selected,
      chat,
      serverChat,
      pmThreads,
      pokes,
      chatTab: activeTab,
      talkers: [...talkers],
      whisperChannelIds: [...whisperChannelIds],
      whisperClientIds: [...whisperClientIds],
      whisperLog,
      log,
      hasConnected: hasConnectedRef.current,
      previousClients: previousClientsRef.current,
      micWasOn: micOn,
      favoriteId: activeFavoriteId,
    });

  const applyParkedToUi = (parked: ParkedSessionState) => {
    setHost(parked.host);
    setNickname(parked.nickname);
    setConnected(parked.connected);
    setConnecting(parked.connecting);
    setConnectError(parked.connectError);
    setChannels(parked.channels);
    setClients(parked.clients);
    setOwnClientId(parked.ownClientId);
    setServerName(parked.serverName);
    setServerMaxClients(parked.serverMaxClients);
    setServerClientsOnline(parked.serverClientsOnline);
    setServerChannelsOnline(parked.serverChannelsOnline);
    setServerVersion(parked.serverVersion);
    setServerLicense(parked.serverLicense);
    setServerLicenseId(parked.serverLicenseId);
    setServerBannerUrl(parked.serverBannerUrl);
    setServerWelcomeMessage(parked.serverWelcomeMessage);
    setSelected(parked.selected);
    setChat(parked.chat);
    setServerChat(parked.serverChat);
    setPmThreads(parked.pmThreads);
    setPokes(parked.pokes);
    setActiveFavoriteId(parked.favoriteId);
    setActiveTab(parked.chatTab);
    talkersRef.current = new Set(parked.talkers);
    setTalkers(talkersRef.current);
    setWhisperChannelIds(new Set(parked.whisperChannelIds));
    setWhisperClientIds(new Set(parked.whisperClientIds));
    setWhisperLog(parked.whisperLog);
    setLog(parked.log);
    hasConnectedRef.current = parked.hasConnected;
    previousClientsRef.current = parked.previousClients;
    // Sync the "previous" whisper-target baseline to the tab we're restoring,
    // so the whisper-target effect (keyed on whisperChannelIds/whisperClientIds)
    // sees no change on this switch and doesn't replay a spurious started/stopped
    // log entry or resend setWhisperTargets for a target that didn't change.
    prevWhisperTargetsRef.current = {
      channels: new Set(parked.whisperChannelIds),
      clients: new Set(parked.whisperClientIds),
    };
    cleanDisconnectRef.current = false;
  };

  const clearActiveUi = () => {
    setConnected(false);
    setConnecting(false);
    setConnectError(null);
    setChannelPasswordPrompt(null);
    channelPasswordCacheRef.current.clear();
    setChannels([]);
    setClients([]);
    setOwnClientId(null);
    setServerName("");
    setServerMaxClients(0);
    setServerClientsOnline(0);
    setServerChannelsOnline(0);
    setServerVersion("");
    setServerLicense("");
    setServerLicenseId(0);
    setServerBannerUrl("");
    setServerWelcomeMessage("");
    setSelected(null);
    setChat([]);
    setServerChat([]);
    setPmThreads({});
    setChatUnread({ channel: false, server: false });
    setPokes([]);
    setActiveTab("channel");
    talkersRef.current = new Set();
    setTalkers(talkersRef.current);
    setWhisperChannelIds(new Set());
    setWhisperClientIds(new Set());
    setWhisperLog([]);
    prevWhisperTargetsRef.current = null;
    hasConnectedRef.current = false;
    previousClientsRef.current = null;
    cleanDisconnectRef.current = false;
    setActiveFavoriteId(null);
  };

  // serverGroups/channelGroups/permissionCatalog/banList/fileBrowser* are
  // per-server data cached at the page level rather than per-tab (they're not
  // part of ParkedSessionState). Without invalidating them on a multi-join tab
  // switch, the existing "if (!serverGroups) fetch" guards would keep serving
  // the previous session's server the newly active tab belongs to.
  const resetPerServerCaches = () => {
    setServerGroups(null);
    setChannelGroups(null);
    setPermissionCatalog(null);
    permissionCatalogRequestedRef.current = false;
    setBanList(null);
    setFileBrowserTarget(null);
    setFileBrowserPath("/");
    setFileBrowserEntries(null);
  };

  const updateTabMeta = (id: string, patch: Partial<SessionTabInfo>) => {
    setSessionTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  const disposeAudioIfIdle = () => {
    if (sessionsRef.current.size > 0) return;
    stopMic();
    stopRecording();
    // AEC3 is bound to this context's render tap - keep the preference, but
    // drop the instance so startMic() builds a fresh one on the next context.
    teardownAec3();
    audioPlayerRef.current?.dispose();
    audioPlayerRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
  };

  const parkActiveSession = () => {
    const id = activeSessionIdRef.current;
    if (!id) return;
    const rec = sessionsRef.current.get(id);
    if (!rec) return;
    rec.parked = snapshotActiveToParked();
    updateTabMeta(id, {
      label: sessionLabel(rec.parked),
      connected: rec.parked.connected,
      connecting: rec.parked.connecting,
    });
    stopMic();
    stopRecording();
    // Stream state is global, not per tab: left running, its signaling would
    // go out on the next tab's socket and its clids would name other people.
    handleStopWatchingStream();
    handleStopPublishing();
    setStreamInfos({});
    requestedStreamInfoRef.current.clear();
  };

  const switchToSession = (id: string) => {
    if (id === activeSessionIdRef.current) return;
    const target = sessionsRef.current.get(id);
    if (!target) return;
    parkActiveSession();
    const parked = target.parked ?? emptyParkedState({ host: target.id });
    target.parked = null;
    applyParkedToUi(parked);
    resetPerServerCaches();
    socketRef.current = target.socket as WebSocket | DemoSocket | null;
    activeSessionIdRef.current = id;
    setActiveSessionId(id);
    updateTabMeta(id, {
      label: sessionLabel(parked),
      connected: parked.connected,
      connecting: parked.connecting,
    });
    // parkActiveSession() above stopped the mic when leaving the previous tab -
    // restore it here if it was on for the tab we're switching back to, so
    // re-entering a tab doesn't silently leave the user unable to transmit.
    // "Mikrofon beim Wechseln des Servers automatisch aktivieren" turns it on either way.
    if (parked.micWasOn || (parked.connected && loadAppSettings().micOnServerSwitch)) void startMic();
  };

  const removeSession = (id: string, opts?: { skipSocketClose?: boolean }) => {
    everConnectedRef.current.delete(id);
    const rec = sessionsRef.current.get(id);
    if (rec && !opts?.skipSocketClose) {
      try {
        const sock = rec.socket;
        if (sock && sock.readyState === WebSocket.OPEN) {
          const message = loadDisconnectMessage();
          if (message) sock.send(JSON.stringify({ type: "disconnect", message }));
        }
        sock?.close();
      } catch {
        /* ignore */
      }
    }
    if (rec) {
      try {
        if (rec.socket) (rec.socket as WebSocket).onmessage = null;
      } catch {
        /* ignore */
      }
    }
    sessionsRef.current.delete(id);
    sessionParamsRef.current.delete(id);
    lastChannelClickBySession.delete(id);
    setSessionTabs((prev) => prev.filter((t) => t.id !== id));

    if (activeSessionIdRef.current !== id) {
      disposeAudioIfIdle();
      return;
    }

    const remaining = [...sessionsRef.current.keys()];
    if (remaining.length > 0) {
      const nextId = remaining[remaining.length - 1];
      const nextRec = sessionsRef.current.get(nextId)!;
      const parked = nextRec.parked ?? emptyParkedState();
      nextRec.parked = null;
      applyParkedToUi(parked);
      resetPerServerCaches();
      socketRef.current = nextRec.socket as WebSocket | DemoSocket | null;
      activeSessionIdRef.current = nextId;
      setActiveSessionId(nextId);
      if (parked.micWasOn) void startMic();
    } else {
      clearActiveUi();
      socketRef.current = null;
      activeSessionIdRef.current = null;
      setActiveSessionId(null);
      disposeAudioIfIdle();
    }
  };

  // Wires onopen/onmessage/onerror/onclose for one session's socket. Shared
  // by handleConnect (brand-new session) and reconnectSession (an existing
  // session — active or parked in the background — getting a fresh socket
  // after an unexpected drop), so a reconnect behaves identically to the
  // original connect from the gateway/UI's point of view.
  // Rebuilt every render and only ever called through socketHandlersRef, so
  // a long-lived socket always sees current state (clients, contacts, t,
  // mic settings, ...) instead of whatever existed when it connected.
  const socketHandlers = (sessionId: string, socket: WebSocket | DemoSocket, params: ConnectParams) => {
    const connectHost = params.host;
    const connectNickname = params.nickname;
    const connectServerPassword = params.serverPassword;
    const connectChannelPassword = params.channelPassword;
    const connectDefaultChannel = params.defaultChannel;
    const connectPrivilegeKey = params.privilegeKey;
    const connectServerType = params.serverType;
    const connectIdentityId = params.identityId;
    const connectFavoriteId = params.favoriteId;
    const connectIdentityBlob = identities.find((i) => i.id === connectIdentityId)?.blob ?? undefined;

    const onopen = () => {
      logClient("info", "Connection", `Connecting to ${connectHost}…`);
      socket.send(
        JSON.stringify({
          type: "connect",
          host: connectHost,
          nickname: connectNickname,
          serverPassword: connectServerPassword || undefined,
          channelPassword: connectChannelPassword || undefined,
          defaultChannel: connectDefaultChannel || undefined,
          identity: connectIdentityBlob || undefined,
          privilegeKey: connectPrivilegeKey.trim() || undefined,
          serverType: connectServerType || "auto",
        })
      );
    };

    // Downloads arrive in pieces (see the connector's TRANSFER_CHUNK_BYTES),
    // keyed by channel + path; every piece but the last is a whole number of
    // base64 groups, so the strings just concatenate.
    const downloadChunks = new Map<string, string[]>();

    const onmessage = (event: MessageEvent) => {
      let data = JSON.parse(event.data);
      if (data.type === "fileDownloadChunk") {
        const key = `${data.cid}\n${data.path}`;
        if (data.offset === 0) downloadChunks.set(key, []);
        const pieces = downloadChunks.get(key);
        if (!pieces) return;
        pieces.push(data.data);
        const transfer = findTransfer("down", data.cid, data.path);
        if (transfer) {
          transfer.done = data.offset + (data.data.length * 3) / 4;
          commitTransfers();
        }
        if (!data.done) return;
        downloadChunks.delete(key);
        data = { type: "fileDownloadData", cid: data.cid, path: data.path, data: pieces.join("") };
      }

      // Broadcast, not tied to any one session - show it regardless of which
      // tab is active, and regardless of which tab's socket it arrived on
      // (every open session gets its own copy of the same broadcast).
      if (data.type === "notice") {
        // messageKey lets the gateway send a fixed, translated notice (e.g.
        // the SIGTERM restart warning) without knowing the client's language;
        // message is a plain-text fallback for anything else.
        setRestartNotice(data.messageKey ? t(data.messageKey) : String(data.message || ""));
        return;
      }
      if (data.type === "hello") {
        setGatewayFeatures(new Set(Array.isArray(data.features) ? data.features : []));
        setTurnServers(Array.isArray(data.iceServers) ? data.iceServers : []);
        return;
      }

      // Inactive tab: update parked snapshot only (no audio playback).
      if (sessionId !== activeSessionIdRef.current) {
        const rec = sessionsRef.current.get(sessionId);
        if (!rec) return;
        if (!rec.parked) {
          rec.parked = emptyParkedState({
            host: connectHost,
            nickname: connectNickname,
            favoriteId: connectFavoriteId,
          });
        }
        if (data.type === "disconnected") {
          sessionsRef.current.delete(sessionId);
          sessionParamsRef.current.delete(sessionId);
          setSessionTabs((prev) => prev.filter((t) => t.id !== sessionId));
          void notify("CONNECTION_DISCONNECTED");
          return;
        }
        // Background tabs get logged too (Options -> Chat).
        const chatPrefs = chatSettingsRef.current;
        if (data.type === "chatMessage" && chatPrefs.logChannel)
          appendChatLog(connectHost, "channel", { from: data.from, message: data.message, self: data.from === connectNickname });
        else if (data.type === "serverMessage" && chatPrefs.logServer)
          appendChatLog(connectHost, "server", { from: data.from, message: data.message, self: data.from === connectNickname });
        else if (data.type === "privateMessage" && chatPrefs.logPrivate)
          appendChatLog(
            connectHost,
            pmLogKind(rec.parked.clients.find((c) => c.id === data.partnerId)?.uid, data.partnerName),
            { from: data.partnerName, message: data.message, self: data.fromSelf }
          );
        const result = applyParkedGatewayEvent(rec.parked, data, {
          connectNickname,
          chatTab: rec.parked.chatTab,
        });
        rec.parked = result.state;
        updateTabMeta(sessionId, {
          label: sessionLabel(rec.parked),
          connected: rec.parked.connected,
          connecting: rec.parked.connecting,
        });
        if (data.type === "connected") {
          connectedAtRef.current.set(sessionId, Date.now());
          void notify("CONNECTION_CONNECTED");
        }
        else if (data.type === "poke") void notify("OTHER_RECEIVED_POKE");
        return;
      }

      switch (data.type) {
        case "connected":
          logClient("info", "Connection", `Connected to ${data.serverName}`);
          connectedAtRef.current.set(sessionId, Date.now());
          autoConnectPendingRef.current = false;
          hasConnectedRef.current = true;
          everConnectedRef.current.add(sessionId);
          setConnecting(false);
          setConnectError(null);
          setConnected(true);
          setChat(
            readChatLog(connectHost, "channel", chatSettingsRef.current.restoreChannelLines).map((l) => ({
              from: l.from,
              message: l.message,
              fromLog: true,
            }))
          );
          updateTabMeta(sessionId, {
            label: String(data.serverName || connectHost),
            connected: true,
            connecting: false,
          });
          localStorage.setItem(LAST_HOST_KEY, connectHost);
          localStorage.setItem(LAST_NICKNAME_KEY, connectNickname);
          localStorage.setItem(LAST_SERVER_TYPE_KEY, connectServerType);
          if (connectIdentityId) {
            setIdentities((prev) =>
              prev.map((i) =>
                i.id === connectIdentityId
                  ? { ...i, blob: data.identity || i.blob, nickname: connectNickname }
                  : i
              )
            );
          }
          setServerName(data.serverName);
          setServerMaxClients(data.serverMaxClients);
          setServerClientsOnline(0);
          setServerChannelsOnline(0);
          setServerVersion(data.serverVersion);
          setServerLicense(data.serverLicense);
          setServerLicenseId(typeof data.serverLicenseId === "number" ? data.serverLicenseId : 0);
          setServerBannerUrl(data.serverBannerUrl);
          setServerWelcomeMessage(data.welcomeMessage);
          setSelected({ type: "server" });
          setServerChat((prev) => capLines([...prev, { from: "Server", message: data.welcomeMessage }], chatSettingsRef.current.maxLines));
          previousClientsRef.current = null;
          void notify("CONNECTION_CONNECTED");
          break;
        case "channels": {
          const newClients: ClientInfo[] = data.clients;
          const prevClients = previousClientsRef.current;
          if (prevClients) {
            const ownId = typeof data.ownClientId === "number" && data.ownClientId > 0 ? data.ownClientId : null;
            const isOwn = (c: ClientInfo) => (ownId != null ? c.id === ownId : c.name === connectNickname);
            const prevById = new Map(prevClients.map((c) => [c.id, c]));
            const newIds = new Set(newClients.map((c) => c.id));
            const oldOwn = prevClients.find(isOwn)?.channel;
            const newOwn = newClients.find(isOwn)?.channel;
            // One sound per kind per update; ServerQuery churn is noisy, never notify for those.
            const keys = new Set<string>();
            if (oldOwn != null && newOwn != null && oldOwn !== newOwn) {
              keys.add("YOU_SWITCHED_CHANNEL");
              if (loadAppSettings().autoOpenChannelChat) setActiveTab("channel");
            }
            for (const c of newClients) {
              if (isOwn(c) || c.isQuery) continue;
              const before = prevById.get(c.id);
              if (!before) keys.add(`CLIENT_CONNECTION_CONNECTED_${c.channel === newOwn ? "CURRENT_CHANNEL" : "SERVER"}`);
              else if (before.channel !== c.channel)
                keys.add(
                  c.channel === newOwn
                    ? "CLIENT_SWITCHED_TO_CURRENT_CHANNEL_STAYS"
                    : before.channel === oldOwn
                      ? "CLIENT_SWITCHED_FROM_CURRENT_CHANNEL_STAYS"
                      : "CLIENT_SWITCHED_TO_OTHER_CHANNEL_STAYS"
                );
            }
            for (const c of prevClients)
              if (!newIds.has(c.id) && !isOwn(c) && !c.isQuery)
                keys.add(`CLIENT_CONNECTION_DISCONNECTED_${c.channel === oldOwn ? "CURRENT_CHANNEL" : "SERVER"}`);
            for (const key of keys) void notify(key);
          }
          previousClientsRef.current = newClients;
          setChannels(data.channels);
          setClients(newClients);
          if (typeof data.ownClientId === "number" && data.ownClientId > 0) {
            setOwnClientId(data.ownClientId);
          }
          // Only apply positive max — gateway maps missing connector fields to 0.
          if (typeof data.serverMaxClients === "number" && data.serverMaxClients > 0) {
            setServerMaxClients(data.serverMaxClients);
          }
          if (typeof data.serverClientsOnline === "number" && data.serverClientsOnline >= 0) {
            setServerClientsOnline(data.serverClientsOnline);
          }
          if (typeof data.serverChannelsOnline === "number" && data.serverChannelsOnline >= 0) {
            setServerChannelsOnline(data.serverChannelsOnline);
          }
          break;
        }
        case "chatMessage":
        case "serverMessage": {
          if (isSenderIgnored(data.from)) break;
          const tab = data.type === "chatMessage" ? "channel" : "server";
          const settings = chatSettingsRef.current;
          const fromSelf = data.from === connectNickname || data.from === ownNameRef.current;
          const entry = { from: data.from, message: data.message };
          (tab === "channel" ? setChat : setServerChat)((prev) => capLines([...prev, entry], settings.maxLines));
          if (tab === "channel" ? settings.logChannel : settings.logServer)
            appendChatLog(connectHost, tab, { ...entry, self: fromSelf });
          if (!fromSelf && activeTabRef.current !== tab && (tab === "channel" ? settings.notifyChannel : settings.notifyServer))
            setChatUnread((prev) => ({ ...prev, [tab]: true }));
          recordUrlsFromMessage(data.message, data.from);
          void notify(fromSelf ? "CHAT_SENT_MESSAGE" : "CHAT_RECEIVED_MESSAGE");
          break;
        }
        case "privateMessage": {
          if (!data.fromSelf && isSenderIgnored(data.partnerName)) break;
          const settings = chatSettingsRef.current;
          const logKind = pmLogKind(
            previousClientsRef.current?.find((c) => c.id === data.partnerId)?.uid,
            data.partnerName
          );
          // Read before appending this message, so a new thread's history doesn't contain it twice.
          const history = loggedPmMessages(connectHost, logKind, settings.restorePrivateLines);
          setPmThreads((prev) => {
            const existing = prev[data.partnerId];
            const thread: PmThread = existing ?? {
              partnerId: data.partnerId,
              partnerName: data.partnerName,
              messages: history,
              unread: false,
            };
            return {
              ...prev,
              [data.partnerId]: {
                ...thread,
                partnerName: data.partnerName,
                messages: capLines(
                  [...thread.messages, { fromSelf: data.fromSelf, message: data.message }],
                  settings.maxLines
                ),
                unread:
                  thread.unread ||
                  (settings.notifyPrivate && !data.fromSelf && activeTabRef.current !== data.partnerId),
              },
            };
          });
          if (settings.logPrivate)
            appendChatLog(connectHost, logKind, { from: data.partnerName, message: data.message, self: data.fromSelf });
          recordUrlsFromMessage(data.message, data.fromSelf ? connectNickname : data.partnerName);
          void notify(data.fromSelf ? "CHAT_SENT_MESSAGE" : "CHAT_RECEIVED_MESSAGE");
          break;
        }
        case "audioOut":
          // Audio only for the active session tab.
          if (!outputMutedRef.current) audioPlayerRef.current?.playFrame(data.pcm);
          break;
        case "talkers": {
          const next = new Set<number>(data.clients);
          const prev = talkersRef.current;
          if (otherMicClicksRef.current && !outputMutedRef.current) {
            // One click per update, even if several people start at once.
            if ([...next].some((id) => !prev.has(id))) void notify("SPECIAL_MIC_CLICK_OTHER_ON");
            else if ([...prev].some((id) => !next.has(id))) void notify("SPECIAL_MIC_CLICK_OTHER_OFF");
          }
          talkersRef.current = next;
          setTalkers(next);
          break;
        }
        case "whisperReceived": {
          const name = previousClientsRef.current?.find((c) => c.id === data.clientId)?.name ?? `#${data.clientId}`;
          setWhisperLog((prevLog) => [
            ...prevLog,
            {
              id: ++whisperLogIdRef.current,
              timestamp: Date.now(),
              description: t("whisperHistory.received", { name }),
              incoming: true,
            },
          ]);
          if (whisperSettingsRef.current.sound && !outputMutedRef.current) void notify("SPECIAL_WHISPER_NOTIFY");
          if (whisperSettingsRef.current.openHistory) setWhisperHistoryOpen(true);
          break;
        }
        case "reconnecting":
          // The gateway lost the TS server and is reconnecting by itself.
          appendLog({ text: t("log.serverReconnecting"), kind: "error" });
          void notify("CONNECTION_LOST_CONNECTION");
          logClient("warning", "Connection", `Lost the server, reconnecting: ${data.reason}`);
          updateTabMeta(sessionId, { connecting: true });
          break;
        case "reconnected":
          appendLog({ text: t("log.serverReconnected"), kind: "info" });
          logClient("info", "Connection", "Reconnected to the server");
          updateTabMeta(sessionId, { connecting: false });
          break;
        case "streamEvent": {
          const streamEvent = data as StreamEvent;
          if (streamEvent.name === "notifystreaminfo" || streamEvent.name === "notifystreamstarted") {
            const info = parseStreamInfo(streamEvent.args);
            if (info) setStreamInfos((prev) => ({ ...prev, [info.clientId]: info }));
          }
          if (streamEvent.name === "notifystreamstopped") {
            const clid = Number(streamEvent.args.clid);
            if (Number.isFinite(clid)) {
              setStreamInfos((prev) => {
                if (!(clid in prev)) return prev;
                const next = { ...prev };
                delete next[clid];
                return next;
              });
            }
          }
          streamViewerRef.current?.handleEvent(streamEvent);
          publisherRef.current?.handleEvent(streamEvent);
          break;
        }
        case "poke": {
          if (!loadAppSettings().neverShowPokeDialog) {
            const id = ++pokeIdRef.current;
            setPokes((prev) => [...prev, { id, from: data.from, message: data.message }]);
            setTimeout(() => setPokes((prev) => prev.filter((p) => p.id !== id)), 10000);
          }
          void notify("OTHER_RECEIVED_POKE", { clientName: data.from });
          break;
        }
        case "serverLog": {
          let message: string;
          switch (data.kind) {
            case "clientJoin":
              message = t("serverLog.clientJoin", { client: data.client, channel: data.channel });
              break;
            case "clientLeave":
              message = t("serverLog.clientLeave", { client: data.client });
              break;
            case "clientChannelSwitch":
              message = t("serverLog.clientChannelSwitch", {
                client: data.client,
                fromChannel: data.fromChannel,
                toChannel: data.toChannel,
              });
              break;
            case "clientChannelGroupAssigned":
              message = t("serverLog.clientChannelGroupAssigned", { client: data.client, group: data.group });
              break;
            case "channelCreated":
              message = t("serverLog.channelCreated", { channel: data.channel });
              break;
            case "channelDeleted":
              message = t("serverLog.channelDeleted", { channel: data.channel });
              break;
            case "channelEdited":
              message = t("serverLog.channelEdited", { channel: data.channel });
              break;
            case "serverEdited":
              message = t("serverLog.serverEdited");
              break;
            case "permissionError":
              message = t("serverLog.permissionError", { action: data.action });
              break;
          }
          const key = SERVER_LOG_NOTIFICATIONS[data.kind as keyof typeof SERVER_LOG_NOTIFICATIONS];
          // Join/leave/switch sounds come from the channel diff above; these only place the text.
          if (!["clientJoin", "clientLeave", "clientChannelSwitch"].includes(data.kind)) void notify(key);
          const maxLines = chatSettingsRef.current.maxLines;
          for (const position of notificationTextPositions(key)) {
            if (position === "client") {
              // Into an open private chat with that client, if there is one.
              const client = "client" in data ? data.client : undefined;
              setPmThreads((prev) => {
                const thread = Object.values(prev).find((th) => th.partnerName === client);
                if (!thread) return prev;
                const messages = capLines([...thread.messages, { fromSelf: false, message, isLog: true }], maxLines);
                return { ...prev, [thread.partnerId]: { ...thread, messages } };
              });
            } else
              (position === "channel" ? setChat : setServerChat)((prev) =>
                capLines([...prev, { from: "", message, isLog: true }], maxLines)
              );
          }
          break;
        }
        case "disconnected": {
          const wasConnected = hasConnectedRef.current;
          cleanDisconnectRef.current = true;
          setChannelPasswordPrompt(null);
          channelPasswordCacheRef.current.clear();
          appendLog({ text: `Disconnected: ${data.reason}`, kind: "info" });
          logClient("info", "Connection", `Disconnected: ${data.reason}`);
          if (wasConnected) void notify("CONNECTION_DISCONNECTED");
          streamViewerRef.current?.close();
          streamViewerRef.current = null;
          setWatchedStream(null);
          setStreamMedia(null);
          setStreamInfos({});
          requestedStreamInfoRef.current.clear();
          publisherRef.current?.stop();
          publisherRef.current = null;
          setPublishState("idle");
          setPublishViewers([]);
          setPublishPending([]);
          removeSession(sessionId, { skipSocketClose: true });
          break;
        }
        case "channelPasswordRequired": {
          // A cached password just got rejected (channel password changed,
          // or was wrong) - drop it so the next auto-switch doesn't reuse it.
          channelPasswordCacheRef.current.delete(data.channelId);
          if (storedChannelPassword(connectHost, data.channelId) !== undefined)
            storeChannelPassword(connectHost, data.channelId, null);
          setChannelPasswordPrompt((prev) => ({
            channelId: data.channelId,
            channelName: channels.find((c) => c.id === data.channelId)?.name ?? "",
            wrongPassword: prev?.channelId === data.channelId,
          }));
          break;
        }
        case "error": {
          logClient("error", "Connection", data.message);
          // Transfer errors carry the transfer's channel + path.
          if (typeof data.path === "string") {
            const failed = transfersRef.current.find(
              (x) => x.status === "running" && x.cid === data.cid && x.path === data.path
            );
            if (failed) finishTransfer(failed, false);
          }
          if (hasConnectedRef.current) {
            appendLog({ text: data.message, kind: "error" });
          } else {
            setConnecting(false);
            setConnectError(data.code === "gateway_full" ? t("connectError.gatewayFull") : data.message);
            updateTabMeta(sessionId, { connecting: false, connected: false });
          }
          break;
        }
        case "clientConnectionInfo":
          setClientConnectionInfo({
            clientId: data.clientId,
            pingMs: data.pingMs,
            connectedSecs: data.connectedSecs,
            ip: data.ip,
            packetsSent: data.packetsSent,
            bytesSent: data.bytesSent,
            packetsReceived: data.packetsReceived,
            bytesReceived: data.bytesReceived,
            packetLossPercent: data.packetLossPercent,
          });
          break;
        case "serverConnectionInfo":
          setServerConnectionInfo({
            pingMs: data.pingMs,
            connectedSecs: data.connectedSecs,
            packetLossPercent: data.packetLossPercent,
            packetsSentTotal: data.packetsSentTotal,
            bytesSentTotal: data.bytesSentTotal,
            packetsReceivedTotal: data.packetsReceivedTotal,
            bytesReceivedTotal: data.bytesReceivedTotal,
            bandwidthSentLastSecond: data.bandwidthSentLastSecond,
            bandwidthReceivedLastSecond: data.bandwidthReceivedLastSecond,
            bandwidthSentLastMinute: data.bandwidthSentLastMinute ?? 0,
            bandwidthReceivedLastMinute: data.bandwidthReceivedLastMinute ?? 0,
            filetransferBandwidthSent: data.filetransferBandwidthSent ?? 0,
            filetransferBandwidthReceived: data.filetransferBandwidthReceived ?? 0,
            filetransferBytesSent: data.filetransferBytesSent ?? 0,
            filetransferBytesReceived: data.filetransferBytesReceived ?? 0,
          });
          break;
        case "serverProtocolLog":
          setServerProtocolLog(data.lines);
          break;
        case "banList":
          setBanList(data.entries);
          break;
        case "complainList":
          setComplainList(data.entries);
          break;
        case "offlineMessageList":
          setOfflineMessageList(data.entries);
          break;
        case "offlineMessage":
          setOfflineMessageDetail({
            messageId: data.messageId,
            clientUid: data.clientUid,
            subject: data.subject,
            message: data.message,
            timestamp: data.timestamp,
          });
          break;
        case "channelGroupList":
          setChannelGroups(data.entries);
          break;
        case "serverGroupList":
          setServerGroups(data.entries);
          break;
        case "permissionOverview":
          setPermissionOverview(data.entries);
          break;
        case "fileList":
          // Channel 0 isn't a real, selectable channel - it's TS3's special
          // server-wide icon repository, so a listing for it always means the
          // server icons window, never the per-channel file browser.
          if (data.cid === 0) {
            setServerIconEntries(
              data.entries.filter((e: FileListEntry) => e.isFile && /^icon_\d+$/.test(e.name))
            );
          } else {
            setFileBrowserEntries(data.entries);
          }
          break;
        case "fileDownloadData": {
          if (data.cid === 0) {
            // Icon preview fetch, not a user-initiated download - stash the
            // bytes for the server icons grid instead of saving a file.
            setServerIconImages((prev) => ({ ...prev, [data.path]: data.data }));
          } else {
            const filename = data.path.split("/").filter(Boolean).pop() ?? "download";
            const transfer = findTransfer("down", data.cid, data.path);
            if (!transfer) {
              triggerBrowserDownload(filename, data.data);
              break;
            }
            const blob = base64Blob(data.data);
            void writeToTarget(transfer.target ?? null, blob).then((saved) => {
              if (!saved) downloadBlob(blob, filename);
              finishTransfer(transfer, true);
            });
          }
          break;
        }
        case "fileUploadDone": {
          const transfer = findTransfer("up", data.cid, data.path);
          if (transfer) finishTransfer(transfer, true);
          if (data.cid === 0) handleServerIconsRefresh();
          else handleFileBrowserRefresh();
          break;
        }
        case "permList":
          setPermissionsEditorEntries(data.entries);
          break;
        case "permissionCatalog":
          setPermissionCatalog(data.entries);
          break;
      }
    };

    const onerror = () => {
      logClient("error", "WebSocket", "WebSocket error (is the gateway running?)");
      if (sessionId !== activeSessionIdRef.current) {
        const rec = sessionsRef.current.get(sessionId);
        if (rec?.parked && !rec.parked.hasConnected) {
          rec.parked = {
            ...rec.parked,
            connecting: false,
            connectError: "Could not reach the gateway - is it running?",
          };
          updateTabMeta(sessionId, { connecting: false, connected: false });
        }
        return;
      }
      if (!hasConnectedRef.current) {
        setConnecting(false);
        setConnectError("Could not reach the gateway - is it running?");
        updateTabMeta(sessionId, { connecting: false, connected: false });
      } else {
        appendLog({ text: "WebSocket error (is the gateway running?)", kind: "error" });
      }
    };
    const onclose = () => {
      if (sessionId !== activeSessionIdRef.current) {
        const rec = sessionsRef.current.get(sessionId);
        // Missing already means a deliberate disconnect (the "disconnected"
        // message handler above already removed it) — nothing to do.
        if (!rec) return;
        if (rec.parked?.hasConnected || everConnectedRef.current.has(sessionId)) {
          // Unexpected drop of a background tab (network blip, or the OS
          // suspended the backgrounded/screen-off page) — keep the tab
          // instead of dropping it, same as a real TS3 client keeps other
          // server connections open while you're looking at a different
          // one. It comes back on its own (immediately if we're still in
          // the foreground, otherwise the visibilitychange handler retries
          // it once the page is visible again), mic still off throughout.
          if (rec.parked) rec.parked = { ...rec.parked, connecting: false, connected: false };
          updateTabMeta(sessionId, { connecting: false, connected: false });
          if (document.visibilityState === "visible") scheduleReconnectRef.current(sessionId);
          return;
        }
        sessionsRef.current.delete(sessionId);
        sessionParamsRef.current.delete(sessionId);
        setSessionTabs((prev) => prev.filter((t) => t.id !== sessionId));
        return;
      }
      if (!hasConnectedRef.current && !cleanDisconnectRef.current && everConnectedRef.current.has(sessionId)) {
        // A reconnect attempt of a session that was connected before failed
        // - same as a drop: keep the tab and let the backoff try again.
        setConnecting(false);
        setConnected(false);
        updateTabMeta(sessionId, { connecting: false, connected: false });
        if (document.visibilityState === "visible") scheduleReconnectRef.current(sessionId);
        return;
      }
      if (!hasConnectedRef.current && !cleanDisconnectRef.current) {
        setConnecting(false);
        setConnectError((prev) => prev ?? "Connection closed before the server responded");
        cleanDisconnectRef.current = false;
        if (sessionsRef.current.has(sessionId)) {
          removeSession(sessionId, { skipSocketClose: true });
        }
        return;
      }
      const wasConnected = hasConnectedRef.current;
      cleanDisconnectRef.current = false;
      if (wasConnected && sessionsRef.current.has(sessionId)) {
        // Same as above, for the active tab: an unexpected drop after a
        // successful connect tries to come back rather than closing the tab.
        // A deliberate disconnect goes through the "disconnected" message
        // handler (or handleDisconnect()), both of which remove the session
        // before this fires, so we only land here for a real hiccup.
        setConnected(false);
        updateTabMeta(sessionId, { connecting: false, connected: false });
        if (document.visibilityState === "visible") scheduleReconnectRef.current(sessionId);
        return;
      }
      if (sessionsRef.current.has(sessionId)) {
        removeSession(sessionId, { skipSocketClose: true });
      }
    };
    return { onopen, onmessage, onerror, onclose };
  };
  const socketHandlersRef = useRef(socketHandlers);
  socketHandlersRef.current = socketHandlers;

  const wireSocket = (sessionId: string, socket: WebSocket | DemoSocket, params: ConnectParams) => {
    const current = () => socketHandlersRef.current(sessionId, socket, params);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    socket.onopen = () => current().onopen();
    socket.onmessage = (event) => {
      // Armed by the "hello" announcing "keepalive", or by the first keepalive.
      // The quoted word cannot come from user text, where JSON escapes quotes.
      if (watchdog !== undefined || String(event.data).includes('"keepalive"')) {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          // close() on a dead link may take a minute to fire onclose, so
          // detach and run the drop handling right away.
          socket.onmessage = socket.onerror = socket.onclose = null;
          socket.close();
          logClient("warning", "Connection", `No keepalive from the gateway for ${KEEPALIVE_TIMEOUT_MS / 1000} s`);
          current().onclose();
        }, KEEPALIVE_TIMEOUT_MS);
      }
      if (event.data !== KEEPALIVE_MESSAGE) current().onmessage(event);
    };
    socket.onerror = () => current().onerror();
    socket.onclose = (event) => {
      clearTimeout(watchdog);
      // 1000/1001 are clean closes; 1006 means the link died without a close frame.
      logClient("info", "Connection", `Gateway connection closed (code ${event.code ?? "?"})`);
      current().onclose();
    };
  };

  // A remembered or favorite host outside the admin's list isn't one of the
  // choices; fall back to the first.
  const dialogHost = SERVER_CHOICES.length && !SERVER_CHOICES.includes(host) ? SERVER_CHOICES[0] : host;

  const handleConnect = (overrides?: {
    host?: string;
    nickname?: string;
    serverPassword?: string;
    channelPassword?: string;
    defaultChannel?: string;
    privilegeKey?: string;
    serverType?: ServerType;
    favoriteId?: string | null;
  }) => {
    const params: ConnectParams = {
      host: overrides?.host ?? host,
      nickname: overrides?.nickname ?? nickname,
      serverPassword: overrides?.serverPassword ?? serverPassword,
      channelPassword: overrides?.channelPassword ?? channelPassword,
      defaultChannel: overrides?.defaultChannel ?? defaultChannel,
      privilegeKey: overrides?.privilegeKey ?? privilegeKey,
      serverType: overrides?.serverType ?? serverType,
      identityId: activeIdentityId,
      favoriteId: overrides?.favoriteId !== undefined ? overrides.favoriteId : null,
    };

    // Multi-join: keep existing sessions; park the active tab and open a new one.
    if (activeSessionIdRef.current && sessionsRef.current.has(activeSessionIdRef.current)) {
      parkActiveSession();
    }

    clearActiveUi();
    setActiveFavoriteId(params.favoriteId);
    hasConnectedRef.current = false;
    setConnecting(true);
    setConnectError(null);
    setConnectDialogOpen(false);
    setHost(params.host);
    setNickname(params.nickname);

    ensureAudioContext();

    const sessionId = randomId();
    sessionParamsRef.current.set(sessionId, params);

    const socket = DEMO_MODE ? new DemoSocket() : new WebSocket(GATEWAY_URL);
    sessionsRef.current.set(sessionId, { id: sessionId, socket, parked: null });
    socketRef.current = socket;
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    setSessionTabs((prev) => [
      ...prev,
      { id: sessionId, label: params.host || "…", connected: false, connecting: true },
    ]);

    wireSocket(sessionId, socket, params);
  };

  // Auto-connect from a ?connect=... share link or a build-time default
  // server (issue #10). Fires once, after the mandatory first-visit ToS gate
  // (if any) is out of the way, so it never races the gate or connects
  // before the user has had a chance to accept it.
  const autoConnectedRef = useRef(false);
  const autoConnectPendingRef = useRef(false);
  useEffect(() => {
    if (autoConnectedRef.current) return;
    if (tosMandatory && tosOpen) return;
    const target = AUTO_CONNECT_FROM_URL ??
      (DEFAULT_SERVER
        ? { host: DEFAULT_SERVER, nickname: undefined, defaultChannel: DEFAULT_CHANNEL, privilegeKey: undefined }
        : null);
    if (!target) return;
    autoConnectedRef.current = true;
    autoConnectPendingRef.current = true;
    handleConnect({
      host: target.host,
      nickname: target.nickname || nickname || `Guest-${Math.floor(1000 + Math.random() * 9000)}`,
      defaultChannel: target.defaultChannel,
      privilegeKey: target.privilegeKey,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tosMandatory, tosOpen]);

  // A manual connect attempt leaves its error as a dismissable banner with the
  // dialog already closed - fine, since the user just closed it themselves.
  // An auto-connect attempt has no dialog open at all, so on failure reopen it
  // prefilled with the attempted host, letting the user fix and retry by hand.
  useEffect(() => {
    if (!autoConnectPendingRef.current || !connectError) return;
    autoConnectPendingRef.current = false;
    setHost(AUTO_CONNECT_FROM_URL?.host ?? DEFAULT_SERVER ?? host);
    setConnectDialogOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectError]);

  // Opens a fresh socket for a session that already exists (active or
  // parked) and re-runs the same connect handshake, reusing the params
  // stored at connect time. Used to recover from an unexpected drop —
  // network blip, or the page coming back from being backgrounded/suspended
  // — without disturbing which tab is active or losing chat/scroll history.
  const reconnectSession = (sessionId: string) => {
    let params = sessionParamsRef.current.get(sessionId);
    const rec = sessionsRef.current.get(sessionId);
    if (!params || !rec) return;
    // Already open or mid-(re)connect — nothing to do.
    if (rec.socket && rec.socket.readyState !== WebSocket.CLOSED && rec.socket.readyState !== WebSocket.CLOSING) {
      return;
    }

    // Come back in the channel we were in, like the native client does. Kept
    // in the params so a failed attempt (empty client list) still aims there.
    const isActive = sessionId === activeSessionIdRef.current;
    const state = isActive ? { clients, ownClientId } : rec.parked;
    const lastChannel = state?.clients.find((c) => c.id === state.ownClientId)?.channel;
    if (lastChannel) {
      const cachedPassword = isActive
        ? (channelPasswordCacheRef.current.get(lastChannel) ?? savedChannelPassword(lastChannel))
        : undefined;
      params = { ...params, defaultChannel: `/${lastChannel}`, channelPassword: cachedPassword ?? params.channelPassword };
      sessionParamsRef.current.set(sessionId, params);
    }

    logClient("info", "Connection", `Reconnecting to ${params.host}…`);
    const socket = DEMO_MODE ? new DemoSocket() : new WebSocket(GATEWAY_URL);
    rec.socket = socket;
    if (sessionId === activeSessionIdRef.current) {
      socketRef.current = socket;
      hasConnectedRef.current = false;
      setConnecting(true);
      setConnectError(null);
    } else if (rec.parked) {
      rec.parked = { ...rec.parked, connecting: true, connected: false, connectError: null };
    }
    updateTabMeta(sessionId, { connecting: true, connected: false });
    wireSocket(sessionId, socket, params);
  };

  const reconnectSessionRef = useRef(reconnectSession);
  reconnectSessionRef.current = reconnectSession;

  // Per-session backoff so a persistently unreachable gateway doesn't get
  // hammered with back-to-back reconnect attempts (each one fails near-
  // instantly, which without a delay would tight-loop). Reset to 0 once a
  // session actually reaches "connected" again (see the two spots below).
  const reconnectAttemptsRef = useRef<Map<string, number>>(new Map());
  // The backoff only starts over once a connection held for a while: on a
  // flaky network a reconnect that drops again after a few seconds used to
  // reset it to 1 s every time, so each tab reconnected every few seconds.
  const connectedAtRef = useRef<Map<string, number>>(new Map());
  const STABLE_CONNECTION_MS = 30_000;
  // The gateway sends this every 20 s (heartbeat in gateway/src/index.ts). A
  // network that dies silently never closes the socket on this side, so a
  // socket that stays quiet this long counts as dropped.
  const KEEPALIVE_MESSAGE = '{"type":"keepalive"}';
  const KEEPALIVE_TIMEOUT_MS = 50_000;
  const reconnectTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const scheduleReconnect = (sessionId: string) => {
    if (reconnectTimersRef.current.has(sessionId)) return; // already scheduled
    const connectedAt = connectedAtRef.current.get(sessionId);
    connectedAtRef.current.delete(sessionId);
    if (connectedAt !== undefined && Date.now() - connectedAt >= STABLE_CONNECTION_MS) {
      reconnectAttemptsRef.current.delete(sessionId);
    }
    const attempt = reconnectAttemptsRef.current.get(sessionId) ?? 0;
    const delay = Math.min(1000 * 2 ** attempt, 30_000);
    reconnectAttemptsRef.current.set(sessionId, attempt + 1);
    const timer = setTimeout(() => {
      reconnectTimersRef.current.delete(sessionId);
      // A manual disconnect meanwhile drops the session's stored params, so
      // reconnectSession() below is a no-op in that case — no explicit
      // cancellation needed.
      reconnectSessionRef.current(sessionId);
    }, delay);
    reconnectTimersRef.current.set(sessionId, timer);
  };
  const scheduleReconnectRef = useRef(scheduleReconnect);
  scheduleReconnectRef.current = scheduleReconnect;

  // Android/mobile browsers aggressively suspend backgrounded or screen-off
  // tabs — timers stall and the OS/browser can silently drop a WebSocket
  // without ever firing onerror/onclose while hidden. There's no event for
  // that; the only reliable signal is coming back to a socket that isn't
  // OPEN anymore. Wake Lock keeps the screen (and the tab's throttling) at
  // bay while any session is live — active tab AND parked background ones,
  // same as a real TS3 client keeping every joined server connected, mic
  // only ever live for the foreground tab. The visibilitychange re-check
  // below catches whatever still slips through (screen-off ignores Wake
  // Lock on some devices, the lock request can be refused, full app
  // backgrounding on Android isn't preventable from a web page at all) by
  // reconnecting every dropped session with the params used last time.
  useEffect(() => {
    if (sessionTabs.length === 0) return;

    let wakeLock: { release: () => Promise<void> } | null = null;
    const releaseWakeLock = () => {
      wakeLock?.release().catch(() => {});
      wakeLock = null;
    };
    const requestWakeLock = () => {
      const wl = (navigator as { wakeLock?: { request: (type: "screen") => Promise<any> } }).wakeLock;
      if (!wl || document.visibilityState !== "visible") return;
      wl.request("screen")
        .then((lock) => {
          wakeLock = lock;
          lock.addEventListener("release", () => {
            if (wakeLock === lock) wakeLock = null;
          });
        })
        .catch(() => {
          /* refused (battery saver, unsupported, …) — non-fatal */
        });
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      requestWakeLock();
      if (!loadAppSettings().reconnectAfterSleep) return;
      for (const id of sessionsRef.current.keys()) {
        reconnectSessionRef.current(id);
      }
    };

    // Back online: retry now instead of waiting out a backoff of up to 30 s.
    const onOnline = () => {
      if (!loadAppSettings().reconnectAfterSleep) return;
      reconnectAttemptsRef.current.clear();
      for (const id of sessionsRef.current.keys()) reconnectSessionRef.current(id);
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onOnline);
    requestWakeLock();

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", onOnline);
      releaseWakeLock();
    };
  }, [sessionTabs.length]);

  const handleDisconnect = () => {
    const id = activeSessionIdRef.current;
    if (id) {
      removeSession(id);
      return;
    }
    const socket = socketRef.current;
    if (!socket) return;
    const message = loadDisconnectMessage();
    if (message && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "disconnect", message }));
    }
    socket.close();
  };

  const handleDisconnectAll = () => {
    const ids = [...sessionsRef.current.keys()];
    for (const id of ids) {
      const rec = sessionsRef.current.get(id);
      if (!rec) continue;
      try {
        const sock = rec.socket;
        if (sock && sock.readyState === WebSocket.OPEN) {
          const message = loadDisconnectMessage();
          if (message) sock.send(JSON.stringify({ type: "disconnect", message }));
        }
        sock?.close();
      } catch {
        /* ignore */
      }
    }
    sessionsRef.current.clear();
    setSessionTabs([]);
    clearActiveUi();
    socketRef.current = null;
    activeSessionIdRef.current = null;
    setActiveSessionId(null);
    disposeAudioIfIdle();
  };

  const closeSessionTab = (id: string) => {
    removeSession(id);
  };


  const connectToFavorite = (f: Favorite) => {
    setHost(f.host);
    setNickname(f.nickname);
    setServerPassword(f.serverPassword);
    setChannelPassword(f.defaultChannelPassword);
    setDefaultChannel(f.defaultChannel);
    handleConnect({
      host: f.host,
      nickname: f.nickname,
      serverPassword: f.serverPassword,
      channelPassword: f.defaultChannelPassword,
      defaultChannel: f.defaultChannel,
      favoriteId: f.id,
    });
  };

  const saveFavorites = (next: Favorite[]) => {
    const normalized = next.map((f) => normalizeFavorite(f));
    setFavorites(normalized);
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(normalized));
  };

  const openAddFavorite = () => {
    setFavoritesDialogMode({
      kind: "add",
      prefill: {
        host,
        nickname,
        serverPassword,
        defaultChannel,
        defaultChannelPassword: channelPassword,
        showServerQueryClients: false,
      },
    });
    setFavoritesMenuOpen(false);
  };

  const openManageFavorites = () => {
    setFavoritesDialogMode({ kind: "manage" });
    setFavoritesMenuOpen(false);
  };

  const sendAway = (away: boolean, message: string) => {
    socketRef.current?.send(JSON.stringify({ type: "setAway", away, message }));
    void notify(away ? "STATUS_SET_AWAY" : "STATUS_SET_PRESENT");
  };

  const handleSaveAwayTemplate = () => {
    const trimmed = awayDialogMessage.trim();
    if (!trimmed) return;
    setAwayPresets((prev) => {
      if (prev.some((p) => p.message === trimmed)) return prev;
      const next = [...prev, { name: trimmed, message: trimmed }];
      saveAwayPresets(next);
      return next;
    });
    setAwayDialogOpen(false);
  };

  const handleConfirmAway = () => {
    sendAway(true, awayDialogMessage);
    setAwayDialogOpen(false);
  };

  useEffect(() => {
    if (!novaMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!novaMenuRef.current?.contains(e.target as Node)) setNovaMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNovaMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [novaMenuOpen]);

  useEffect(() => {
    if (!connectionsMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!connectionsMenuRef.current?.contains(e.target as Node)) setConnectionsMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConnectionsMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [connectionsMenuOpen]);

  useEffect(() => {
    if (!favoritesMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!favoritesMenuRef.current?.contains(e.target as Node)) setFavoritesMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFavoritesMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [favoritesMenuOpen]);

  useEffect(() => {
    if (!awayMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!awayMenuRef.current?.contains(e.target as Node)) setAwayMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAwayMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [awayMenuOpen]);

  useEffect(() => {
    if (!clientContextMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!clientContextMenuRef.current?.contains(e.target as Node)) setClientContextMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setClientContextMenu(null);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    // Keyboard users (context-menu key / Shift+F10) land in the menu and get
    // focus back on the row once it closes.
    const previous = document.activeElement as HTMLElement | null;
    clientContextMenuRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      if (document.activeElement === document.body) previous?.focus();
    };
  }, [clientContextMenu]);

  useEffect(() => {
    if (!serverContextMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!serverContextMenuRef.current?.contains(e.target as Node)) setServerContextMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setServerContextMenu(null);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    // Keyboard users (context-menu key / Shift+F10) land in the menu and get
    // focus back on the row once it closes.
    const previous = document.activeElement as HTMLElement | null;
    serverContextMenuRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      if (document.activeElement === document.body) previous?.focus();
    };
  }, [serverContextMenu]);

  useEffect(() => {
    if (!channelContextMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!channelContextMenuRef.current?.contains(e.target as Node)) setChannelContextMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setChannelContextMenu(null);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    // Keyboard users (context-menu key / Shift+F10) land in the menu and get
    // focus back on the row once it closes.
    const previous = document.activeElement as HTMLElement | null;
    channelContextMenuRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      if (document.activeElement === document.body) previous?.focus();
    };
  }, [channelContextMenu]);

  // Icon files aren't previewable from the listing alone - fetch each one's
  // bytes individually once, then cache them in serverIconImages so re-runs
  // (triggered by that same state update) become no-ops for already-fetched icons.
  useEffect(() => {
    if (!serverIconsOpen || !serverIconEntries) return;
    for (const entry of serverIconEntries) {
      const path = `/${entry.name}`;
      if (!(path in serverIconImages)) {
        socketRef.current?.send(JSON.stringify({ type: "downloadFile", channelId: 0, path }));
      }
    }
  }, [serverIconsOpen, serverIconEntries, serverIconImages]);

  // Server group badges next to client names need the group list (for the
  // id->icon lookup) even if the user never opens a group-related dialog -
  // fetch it once per connection instead of only on demand.
  useEffect(() => {
    if (!connected || serverGroups) return;
    socketRef.current?.send(JSON.stringify({ type: "getServerGroupList" }));
  }, [connected, serverGroups]);

  // Same icon-file cache as the server icons dialog (fileDownloadData for
  // cid 0 always lands in serverIconImages, regardless of who asked) - fetch
  // any group icon referenced by a currently visible client that isn't
  // cached yet.
  const requestedIconPathsRef = useRef(new Set<string>());
  useEffect(() => {
    if (!connected) requestedIconPathsRef.current.clear();
  }, [connected]);

  useEffect(() => {
    if (!serverGroups) return;
    const iconById = new Map(serverGroups.map((g) => [g.id, g.iconId]));
    // Plus every group listed in an open group menu, so unassigned ones show their icon too.
    const menuGroups = !groupAssignTarget
      ? []
      : ((groupAssignTarget.kind === "channel" ? channelGroups : serverGroups) ?? []);
    const wantedIconIds = new Set(
      clients
        .flatMap((c) => c.serverGroups.map((gid) => iconById.get(gid) ?? 0))
        .concat(menuGroups.map((g) => g.iconId))
        .filter((id) => id >= CUSTOM_ICON_ID_THRESHOLD)
    );
    for (const iconId of wantedIconIds) {
      const path = `/icon_${iconId}`;
      // Once per path and connection: without this, every client-list update
      // re-requested icons still in flight (or ones that failed for good).
      if (!(path in serverIconImages) && !requestedIconPathsRef.current.has(path)) {
        requestedIconPathsRef.current.add(path);
        socketRef.current?.send(JSON.stringify({ type: "downloadFile", channelId: 0, path }));
      }
    }
  }, [clients, serverGroups, serverIconImages, groupAssignTarget, channelGroups]);

  // Avatars share that cid-0 cache, keyed by path; the hash makes a changed
  // avatar download again. ponytail: only the own channel and the selected
  // client - a big server's every avatar would be megabytes through the
  // gateway; widen this if the tree designs ever need all of them.
  const requestedAvatarHashesRef = useRef(new Map<string, string>());
  useEffect(() => {
    if (!connected) requestedAvatarHashesRef.current.clear();
  }, [connected]);

  useEffect(() => {
    const ownChannel = clients.find((c) => c.id === ownClientId)?.channel;
    for (const c of clients) {
      const wanted = c.channel === ownChannel || (selected?.type === "client" && selected.id === c.id);
      const path = wanted && c.avatarHash ? avatarPath(c.uid) : null;
      if (!path || requestedAvatarHashesRef.current.get(path) === c.avatarHash) continue;
      requestedAvatarHashesRef.current.set(path, c.avatarHash!);
      socketRef.current?.send(JSON.stringify({ type: "downloadFile", channelId: 0, path }));
    }
  }, [clients, ownClientId, selected]);

  useEffect(() => {
    if (!connected) {
      setWhisperChannelIds(new Set());
      setWhisperClientIds(new Set());
    }
  }, [connected]);

  useEffect(() => {
    if (!connected) return;
    const prev = prevWhisperTargetsRef.current;
    const setsEqual = (a: Set<number>, b: Set<number>) => a.size === b.size && [...a].every((x) => b.has(x));
    const unchanged =
      !!prev && setsEqual(prev.channels, whisperChannelIds) && setsEqual(prev.clients, whisperClientIds);
    prevWhisperTargetsRef.current = { channels: new Set(whisperChannelIds), clients: new Set(whisperClientIds) };
    // Nothing actually changed for the now-active session (e.g. this run was
    // triggered by restoring a parked multi-join tab, not by the user toggling
    // a whisper target) - skip both the gateway resend and the log entry below.
    if (unchanged) return;

    socketRef.current?.send(
      JSON.stringify({
        type: "setWhisperTargets",
        channelIds: [...whisperChannelIds],
        clientIds: [...whisperClientIds],
      })
    );

    const wasEmpty = !prev || (prev.channels.size === 0 && prev.clients.size === 0);
    const isEmpty = whisperChannelIds.size === 0 && whisperClientIds.size === 0;
    if (wasEmpty && isEmpty) return;

    const describe = () => {
      const channelNames = [...whisperChannelIds]
        .map((id) => channels.find((c) => c.id === id)?.name)
        .filter((n): n is string => Boolean(n));
      const clientNames = [...whisperClientIds]
        .map((id) => clients.find((c) => c.id === id)?.name)
        .filter((n): n is string => Boolean(n));
      return [...channelNames, ...clientNames].join(", ");
    };

    const description = isEmpty
      ? t("whisperHistory.stopped")
      : t("whisperHistory.started", { targets: describe() });
    setWhisperLog((prevLog) => [
      ...prevLog,
      { id: ++whisperLogIdRef.current, timestamp: Date.now(), description },
    ]);
    // Only a change of whisper targets should log; channels/clients/t are
    // read for the description but must not re-trigger it (renames, joins).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whisperChannelIds, whisperClientIds, connected]);

  // Tell the connector whose whispers to let through: the mode's default plus
  // the online clients whose contact entry says otherwise. Resent whenever
  // that changes or the socket is new (the connector forgets it on reconnect).
  const sentWhisperPolicyRef = useRef<{ socket: WebSocket | DemoSocket | null; payload: string }>({ socket: null, payload: "" });
  useEffect(() => {
    const socket = socketRef.current;
    // Older gateways answer unknown messages with an error line.
    if (!connected || !socket || !gatewayFeatures.has("whisperPolicy")) return;
    const block = whisperSettings.mode !== "allow";
    const exceptionMode = block ? "allow" : "block";
    const exceptions =
      whisperSettings.mode === "blockAll"
        ? []
        : clients
            .filter((c) => contacts.find((k) => k.uid === c.uid)?.whisper === exceptionMode)
            .map((c) => c.id)
            .sort((a, b) => a - b);
    const payload = JSON.stringify({ type: "setWhisperPolicy", block, exceptions });
    const sent = sentWhisperPolicyRef.current;
    if (sent.socket === socket && sent.payload === payload) return;
    socket.send(payload);
    sentWhisperPolicyRef.current = { socket, payload };
  }, [connected, clients, contacts, whisperSettings.mode, gatewayFeatures]);

  // "Clients in Whisper Verlauf löschen nach": drop old incoming entries.
  useEffect(() => {
    const minutes = whisperSettings.clearAfterMin;
    if (!minutes) return;
    const prune = () =>
      setWhisperLog((prev) => {
        const cutoff = Date.now() - minutes * 60_000;
        const next = prev.filter((e) => !e.incoming || e.timestamp >= cutoff);
        return next.length === prev.length ? prev : next;
      });
    prune();
    const timer = setInterval(prune, 15_000);
    return () => clearInterval(timer);
  }, [whisperSettings.clearAfterMin]);

  useEffect(() => {
    if (!whisperMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!whisperMenuRef.current?.contains(e.target as Node)) setWhisperMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWhisperMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [whisperMenuOpen]);

  useEffect(() => {
    if (!extrasMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!extrasMenuRef.current?.contains(e.target as Node)) setExtrasMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExtrasMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [extrasMenuOpen]);

  useEffect(() => {
    if (!helpMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!helpMenuRef.current?.contains(e.target as Node)) setHelpMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHelpMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [helpMenuOpen]);

  useEffect(() => {
    if (!selfMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!selfMenuRef.current?.contains(e.target as Node)) setSelfMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelfMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [selfMenuOpen]);

  useEffect(() => {
    if (!rightsMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rightsMenuRef.current?.contains(e.target as Node)) setRightsMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRightsMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [rightsMenuOpen]);

  // Rebuilt each render and read through the ref, so the listener below is
  // registered once yet always sees current state.
  const shortcutHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  shortcutHandlerRef.current = (e: KeyboardEvent) => {
    if (!e.ctrlKey) return;
    // Typing in a field (chat, dialogs) must never trigger e.g. Ctrl+D.
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    if (e.key.toLowerCase() === "s" && !connecting) {
      e.preventDefault();
      setConnectDialogOpen(true);
    } else if (e.key.toLowerCase() === "d" && (connected || sessionTabs.length > 0)) {
      e.preventDefault();
      handleDisconnect();
    } else if (e.key.toLowerCase() === "b") {
      e.preventDefault();
      openAddFavorite();
    }
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => shortcutHandlerRef.current(e);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Nova-theme-only: the connect dialog IS the app until a connection exists -
  // it's forced open on load and after every disconnect, and closes itself the
  // moment a connection succeeds (an auto-connect never went through the
  // dialog's own close, so this has to do it).
  useEffect(() => {
    if (designTheme === "nova") setConnectDialogOpen(!connected);
  }, [designTheme, connected]);

  // Overrides let a device/DSP-setting change take effect immediately, without
  // waiting for the next render's (possibly still-stale) state closure.
  const startMic = async (overrides?: {
    deviceId?: string;
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  }) => {
    const audioContext = ensureAudioContext();
    const generation = ++micGenerationRef.current;
    // AEC3 enabled (persisted pref, or left over from a disposed context) but
    // not instantiated for this context yet: build it now, before the mic
    // below decides whether to turn the native canceller off.
    if (aec3EnabledRef.current && !aec3Ref.current) {
      try {
        const aec3 = await createAec3(audioContext.sampleRate, 2, 1);
        if (aec3Ref.current || audioContextRef.current !== audioContext) {
          aec3.free();
        } else {
          aec3Ref.current = aec3;
          audioPlayerRef.current?.attachAecRenderTap(aec3);
        }
      } catch (error) {
        appendLog({ text: `Advanced echo cancellation failed to load: ${(error as Error).message}`, kind: "error" });
        aec3EnabledRef.current = false;
        setAec3Enabled(false);
      }
      if (generation !== micGenerationRef.current) return;
    }
    let mic: MicCapture | null = null;
    try {
      mic = new MicCapture(audioContext, {
        onFrame: (pcm) => {
          // A reconnecting socket is still CONNECTING, where send() throws.
          if (!inputMutedRef.current && socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({ type: "sendAudio", pcm }));
          }
        },
        onActivity: (active) => setSelfActive(active),
        onLevel: (rms) => {
          micLevelRef.current = rms;
        },
        threshold: vadThreshold,
        hangoverSeconds: vadHangover,
        deviceId: overrides?.deviceId ?? (inputDeviceId || undefined),
        // AEC3 replaces (not stacks with) the native canceller - running both
        // fights over the same signal.
        echoCancellation: aec3Ref.current ? false : (overrides?.echoCancellation ?? echoCancellationEnabled),
        noiseSuppression: overrides?.noiseSuppression ?? noiseSuppressionEnabled,
        autoGainControl: overrides?.autoGainControl ?? autoGainControlEnabled,
        aec3: aec3Ref.current ?? undefined,
      });
      await mic.start();
      if (generation !== micGenerationRef.current) {
        mic.stop();
        return;
      }
      micCaptureRef.current?.stop();
      micCaptureRef.current = mic;
      mic.pushToTalk = pushToTalkRef.current;
      mic.continuous = continuousRef.current;
      mic.typingAttenuation = typingAttenuationRef.current;
      mic.pttPressed = pttPressedRef.current;
      mic.setExtraAudio(tabAudioRef.current);
      setMicOn(true);
      refreshOutputDevices();
      refreshInputDevices();
      connectMicToRecorder();
    } catch (error) {
      mic?.stop();
      if (generation !== micGenerationRef.current) return;
      appendLog({ text: `Microphone error: ${(error as Error).message}`, kind: "error" });
    }
  };

  const restartMic = async (overrides?: {
    deviceId?: string;
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  }) => {
    micCaptureRef.current?.stop();
    micCaptureRef.current = null;
    await startMic(overrides);
  };

  const handleToggleMic = async () => {
    if (!micOn) {
      await startMic();
      return;
    }
    socketRef.current?.send(JSON.stringify({ type: "setInputMuted", muted: !inputMutedRef.current }));
    void notify(inputMutedRef.current ? "SOUND_CAPTURE_UNMUTED" : "SOUND_CAPTURE_MUTED");
  };

  // Enable the mic automatically on page load (voice activation still gates
  // what's actually sent) instead of requiring an explicit click every time.
  const autoMicAttemptedRef = useRef(false);
  useEffect(() => {
    if (autoMicAttemptedRef.current) return;
    autoMicAttemptedRef.current = true;
    void handleToggleMic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleInputDeviceChange = (deviceId: string) => {
    setInputDeviceId(deviceId);
    if (micCaptureRef.current) void restartMic({ deviceId });
  };

  const handleToggleNoiseSuppression = () => {
    const next = !noiseSuppressionEnabled;
    setNoiseSuppressionEnabled(next);
    if (micCaptureRef.current) void restartMic({ noiseSuppression: next });
  };

  const handleToggleEchoCancellation = () => {
    const next = !echoCancellationEnabled;
    setEchoCancellationEnabled(next);
    if (micCaptureRef.current) void restartMic({ echoCancellation: next });
  };

  const handleToggleAutoGainControl = () => {
    const next = !autoGainControlEnabled;
    setAutoGainControlEnabled(next);
    if (micCaptureRef.current) void restartMic({ autoGainControl: next });
  };

  const teardownAec3 = () => {
    audioPlayerRef.current?.detachAecRenderTap();
    aec3Ref.current?.free();
    aec3Ref.current = null;
  };

  const handleToggleAec3 = async () => {
    if (aec3Enabled) {
      aec3EnabledRef.current = false;
      setAec3Enabled(false);
      teardownAec3();
      if (micCaptureRef.current) void restartMic({});
      return;
    }
    setAec3Loading(true);
    try {
      const audioContext = ensureAudioContext();
      if (audioContext.state === "suspended") await audioContext.resume();
      // The context is *requested* at SAMPLE_RATE, but that constructor hint
      // isn't guaranteed - some audio backends (notably Linux/PulseAudio) run
      // it at their own native rate regardless. AEC3 must be told the rate
      // its ScriptProcessorNode buffers are actually sampled at, or its
      // internal frame timing drifts - audibly, as a progressively descending
      // pitch on repeated echo.
      const aec3 = await createAec3(audioContext.sampleRate, 2, 1);
      aec3Ref.current = aec3;
      audioPlayerRef.current?.attachAecRenderTap(aec3);
      aec3EnabledRef.current = true;
      setAec3Enabled(true);
      if (micCaptureRef.current) await restartMic({});
    } catch (error) {
      appendLog({ text: `Advanced echo cancellation failed to load: ${(error as Error).message}`, kind: "error" });
      teardownAec3();
      aec3EnabledRef.current = false;
      setAec3Enabled(false);
    } finally {
      setAec3Loading(false);
    }
  };

  const stopTabAudio = () => {
    tabAudioRef.current?.getTracks().forEach((track) => track.stop());
    tabAudioRef.current = null;
    micCaptureRef.current?.setExtraAudio(null);
    setTabAudioOn(false);
  };

  const handleToggleTabAudio = async () => {
    if (tabAudioRef.current) {
      stopTabAudio();
      return;
    }
    let stream: MediaStream;
    try {
      // Browsers only offer audio together with a video capture. The video
      // track stays alive (at 1 fps) until sharing stops: stopping it right
      // away may end or silence the capture session the audio belongs to.
      // Edge applies voice processing to the capture by default: echo
      // cancellation then subtracts exactly what the speakers play, so
      // Windows system audio arrives as pure silence (measured: peak 0).
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      return; // picker cancelled
    }
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach((track) => track.stop());
      appendLog({ text: t("tabAudio.noAudio"), kind: "error" });
      return;
    }
    // Also the browser's own "stop sharing" bar.
    track.addEventListener("ended", stopTabAudio);
    tabAudioRef.current = stream;
    micCaptureRef.current?.setExtraAudio(stream);
    setTabAudioOn(true);
    // Windows system audio can arrive as pure silence (seen in Edge, with or
    // without the mic open), with nothing else to tell why.
    setTimeout(() => {
      if (tabAudioRef.current !== stream || !micCaptureRef.current || micCaptureRef.current.extraPeak >= 1e-4) return;
      appendLog({ text: t("tabAudio.silent"), kind: "error" });
    }, 5000);
  };

  const handleToggleMicTest = () => {
    const next = !micTestOn;
    setMicTestOn(next);
    const inputNode = audioPlayerRef.current?.getInputNode();
    if (inputNode) micCaptureRef.current?.setMonitoring(next, inputNode);
  };

  const handleToggleOutputMuted = () => {
    socketRef.current?.send(JSON.stringify({ type: "setOutputMuted", muted: !outputMutedRef.current }));
    void notify(outputMutedRef.current ? "SOUND_PLAYBACK_UNMUTED" : "SOUND_PLAYBACK_MUTED");
  };

  // Connects the current mic (if any) into the active recording, so a device
  // switch or a mic (re)start mid-recording doesn't silently drop it from the mix.
  const connectMicToRecorder = () => {
    const processor = recordProcessorRef.current;
    const source = micCaptureRef.current?.getSourceNode();
    if (processor && source) source.connect(processor);
  };

  const startRecording = () => {
    if (recordProcessorRef.current) return;
    const audioContext = ensureAudioContext();
    // Captures raw PCM via a ScriptProcessorNode (rather than MediaRecorder) so the
    // download can be an uncompressed WAV instead of a browser-codec-dependent webm/ogg.
    const processor = audioContext.createScriptProcessor(4096, 2, 2);
    const silence = audioContext.createGain();
    silence.gain.value = 0;
    recordChunksRef.current = { left: [], right: [] };
    processor.onaudioprocess = (event) => {
      const left = event.inputBuffer.getChannelData(0);
      const right = event.inputBuffer.numberOfChannels > 1 ? event.inputBuffer.getChannelData(1) : left;
      recordChunksRef.current.left.push(left.slice());
      recordChunksRef.current.right.push(right.slice());
    };
    // A ScriptProcessorNode only fires while connected to a destination; route
    // through a muted gain node so the recording tap isn't also heard.
    processor.connect(silence);
    silence.connect(audioContext.destination);
    recordProcessorRef.current = processor;
    recordSilenceRef.current = silence;
    audioPlayerRef.current?.getInputNode().connect(processor);
    connectMicToRecorder();

    setRecording(true);
    logClient("info", "Recording", "Started local recording");
  };

  const stopRecording = () => {
    const processor = recordProcessorRef.current;
    if (!processor) return;
    processor.onaudioprocess = null;
    processor.disconnect();
    recordSilenceRef.current?.disconnect();
    recordProcessorRef.current = null;
    recordSilenceRef.current = null;
    setRecording(false);

    const { left, right } = recordChunksRef.current;
    recordChunksRef.current = { left: [], right: [] };
    const totalFrames = left.reduce((sum, chunk) => sum + chunk.length, 0);
    if (totalFrames === 0) return;

    const mergedLeft = new Float32Array(totalFrames);
    const mergedRight = new Float32Array(totalFrames);
    let offset = 0;
    for (let i = 0; i < left.length; i++) {
      mergedLeft.set(left[i], offset);
      mergedRight.set(right[i], offset);
      offset += left[i].length;
    }

    const blob = encodeWavStereo(mergedLeft, mergedRight, audioContextRef.current?.sampleRate ?? SAMPLE_RATE);
    const safeServerName = (serverName || "session").replace(/[\\/:*?"<>|]+/g, "_").trim() || "session";
    const filename = `webspeak3-${safeServerName}-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`;
    downloadBlob(blob, filename);
    logClient("info", "Recording", `Saved recording as ${filename}`);
  };

  const handleSetNickname = (newNickname: string) => {
    socketRef.current?.send(JSON.stringify({ type: "setNickname", nickname: newNickname }));
    if (loadAppSettings().updateFavoriteNickname && activeFavoriteId)
      saveFavorites(favorites.map((f) => (f.id === activeFavoriteId ? { ...f, nickname: newNickname } : f)));
  };

  const handleServerQueryLogin = () => {
    if (!serverQueryUsername.trim() || !serverQueryPassword) return;
    socketRef.current?.send(
      JSON.stringify({
        type: "serverQueryLogin",
        username: serverQueryUsername.trim(),
        password: serverQueryPassword,
      })
    );
    setServerQueryLoginOpen(false);
  };

  const handleOutputDeviceChange = async (deviceId: string) => {
    setOutputDeviceId(deviceId);
    await audioPlayerRef.current?.setOutputDevice(deviceId);
    setSoundsOutputDevice(deviceId);
  };

  const handlePickOutputDevice = async () => {
    try {
      const device = await pickAudioOutputDevice();
      if (device) await handleOutputDeviceChange(device.deviceId);
    } catch (error) {
      appendLog({ text: `Output device error: ${(error as Error).message}`, kind: "error" });
    }
  };

  const handlePlayTestTone = () => {
    const ctx = ensureAudioContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    audioPlayerRef.current?.unlock();
    audioPlayerRef.current?.playTestTone();
  };

  const handleSwitchChannel = (channelId: number, channelPassword?: string) => {
    const id = Number(channelId);
    if (!Number.isFinite(id)) return;
    // Prefer server-reported own client id - nickname match breaks when the
    // server renames us (Guest -> Guest1) or another client shares our nick.
    const me =
      ownClientId != null
        ? clients.find((c) => c.id === ownClientId)
        : clients.find((c) => c.name === nickname);
    if (me?.channel === id) return;
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      appendLog({ text: t("tree.joinNotConnected"), kind: "error" });
      return;
    }
    const password = channelPassword ?? channelPasswordCacheRef.current.get(id) ?? savedChannelPassword(id);
    socket.send(JSON.stringify({ type: "switchChannel", channelId: id, channelPassword: password }));
  };

  const savedChannelPassword = (channelId: number) =>
    securitySettings.saveChannelPasswords ? storedChannelPassword(host, channelId) : undefined;

  // Options -> Sicherheit -> "Cache löschen": icons/avatars download again right away.
  const handleClearCache = () => {
    void clearBrowserCaches();
    clearStillCache();
    setServerIconImages({});
    requestedIconPathsRef.current.clear();
    requestedAvatarHashesRef.current.clear();
    appendLog({ text: t("securitySettings.cacheCleared"), kind: "info" });
  };

  const handleChannelPasswordSubmit = (password: string) => {
    if (!channelPasswordPrompt) return;
    channelPasswordCacheRef.current.set(channelPasswordPrompt.channelId, password);
    if (securitySettings.saveChannelPasswords) storeChannelPassword(host, channelPasswordPrompt.channelId, password);
    handleSwitchChannel(channelPasswordPrompt.channelId, password);
    setChannelPasswordPrompt(null);
  };

  const handleChannelPasswordCancel = () => setChannelPasswordPrompt(null);

  const handleSelectItem = (item: SelectedItem) => setSelected(item);

  useEffect(() => {
    const el = chatInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [chatInput, designTheme, connected]);

  const handleSendChat = () => {
    const message = wrapUrls(chatInput.trim());
    if (!message) return;
    if (activeTab === "channel") {
      socketRef.current?.send(JSON.stringify({ type: "sendChatMessage", message }));
    } else if (activeTab === "server") {
      socketRef.current?.send(JSON.stringify({ type: "sendServerMessage", message }));
    } else {
      socketRef.current?.send(JSON.stringify({ type: "sendPrivateMessage", clientId: activeTab, message }));
    }
    setChatInput("");
  };

  const handleOpenPrivateChat = (clientId: number, clientName: string) => {
    const history = loggedPmMessages(
      host,
      pmLogKind(clients.find((c) => c.id === clientId)?.uid, clientName),
      chatSettings.restorePrivateLines
    );
    setPmThreads((prev) => ({
      ...prev,
      [clientId]: prev[clientId] ?? { partnerId: clientId, partnerName: clientName, messages: history, unread: false },
    }));
    setActiveTab(clientId);
  };

  const handlePokeClient = (clientId: number, clientName: string) => {
    setPokeTarget({ id: clientId, name: clientName });
    setPokeMessage("");
  };

  const toggleWhisperChannel = (channelId: number) => {
    setWhisperChannelIds((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  };

  const toggleWhisperClient = (clientId: number) => {
    setWhisperClientIds((prev) => {
      const next = new Set(prev);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  };

  const clearWhisperTargets = () => {
    setWhisperChannelIds(new Set());
    setWhisperClientIds(new Set());
  };

  const handleSaveWhisperList = (name: string) => {
    const channelNames = channels.filter((c) => whisperChannelIds.has(c.id)).map((c) => c.name);
    const clientNames = clients.filter((c) => whisperClientIds.has(c.id)).map((c) => c.name);
    if (channelNames.length === 0 && clientNames.length === 0) return;
    setWhisperLists((prev) => [...prev, { id: randomId(), name, channelNames, clientNames }]);
  };

  const handleActivateWhisperList = (list: WhisperList) => {
    const nextChannelIds = new Set(
      channels.filter((c) => list.channelNames.includes(c.name)).map((c) => c.id)
    );
    const nextClientIds = new Set(clients.filter((c) => list.clientNames.includes(c.name)).map((c) => c.id));
    setWhisperChannelIds(nextChannelIds);
    setWhisperClientIds(nextClientIds);
  };

  const handleDeleteWhisperList = (id: string) => {
    setWhisperLists((prev) => prev.filter((list) => list.id !== id));
  };

  /** Switching identities (in the connect dialog's picker) also switches the
   *  nickname field to that identity's own remembered nickname, like the
   *  native client - only when it actually has one saved, so a fresh
   *  identity doesn't blank out what the user already typed. */
  const handleActiveIdentityChange = (id: string) => {
    setActiveIdentityId(id);
    const identity = identities.find((i) => i.id === id);
    if (identity?.nickname) setNickname(identity.nickname);
  };

  const handleAddIdentity = () => {
    const identity: Identity = {
      id: randomId(),
      name: t("identities.newName"),
      nickname: "",
      phoneticName: "",
      blob: null,
    };
    setIdentities((prev) => [...prev, identity]);
  };

  const handleRenameIdentity = (id: string, name: string) => {
    setIdentities((prev) => prev.map((i) => (i.id === id ? { ...i, name } : i)));
  };

  const handleIdentityNicknameChange = (id: string, value: string) => {
    setIdentities((prev) => prev.map((i) => (i.id === id ? { ...i, nickname: value } : i)));
    if (id === activeIdentityId) setNickname(value);
  };

  const handleIdentityPhoneticChange = (id: string, value: string) => {
    setIdentities((prev) => prev.map((i) => (i.id === id ? { ...i, phoneticName: value } : i)));
  };

  const handleDeleteIdentity = (id: string) => {
    setIdentities((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((i) => i.id !== id);
      if (activeIdentityId === id) setActiveIdentityId(next[0]?.id ?? null);
      return next;
    });
  };

  /** Downloads one identity's opaque tsclientlib blob as a JSON file - the
   *  same file this dialog's "Importieren" button reads back in, so it
   *  doubles as a backup/transfer mechanism between browsers or devices. */
  const handleExportIdentity = (id: string) => {
    const identity = identities.find((i) => i.id === id);
    if (!identity?.blob) return;
    const blob = new Blob([identity.blob], { type: "application/json" });
    downloadBlob(blob, `${identity.name.replace(/[^a-z0-9_-]+/gi, "_") || "identity"}.ts3identity.json`);
  };

  /** Parses the native client's identity .ini format:
   *  [Identity]
   *  id=<name, with \xHH-escaped non-ASCII chars>
   *  identity="<counter>V<base64 key>"
   *  nickname=<...>
   *  phonetic_nickname=<...>
   *  Returns null if it doesn't look like one. */
  /** Undoes Qt's QSettings .ini string escaping: `\xH..HHHH` (1-4 hex
   *  digits) is one UTF-16 *code unit*, not one byte - astral characters
   *  (emoji etc.) come out as two consecutive escapes forming a surrogate
   *  pair, e.g. "\xd83d\xde43" for 🙃. Treating each \xHH as a standalone
   *  Latin-1 byte (the previous approach) mangles anything outside the
   *  Latin-1 range into mojibake, which is exactly what showed up in the
   *  nickname field for names with Greek/Turkish letters or emoji. */
  const unescapeQtIni = (value: string): string => {
    let result = "";
    for (let i = 0; i < value.length; i++) {
      if (value[i] === "\\") {
        const next = value[i + 1];
        if (next === "x") {
          let hex = "";
          let j = i + 2;
          while (j < value.length && hex.length < 4 && /[0-9a-fA-F]/.test(value[j])) {
            hex += value[j];
            j++;
          }
          if (hex.length > 0) {
            result += String.fromCharCode(parseInt(hex, 16));
            i = j - 1;
            continue;
          }
        } else if (next === "n") {
          result += "\n";
          i++;
          continue;
        } else if (next === "t") {
          result += "\t";
          i++;
          continue;
        } else if (next === "r") {
          result += "\r";
          i++;
          continue;
        } else if (next === "\\" || next === '"') {
          result += next;
          i++;
          continue;
        }
      }
      result += value[i];
    }
    return result;
  };

  const parseIniIdentity = (text: string): { name: string; nickname: string; phonetic: string; blob: string } | null => {
    if (!/^\s*\[Identity\]/im.test(text)) return null;
    const fields: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^(\w+)\s*=\s*(.*)$/);
      if (!m) continue;
      let value = m[2].trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      fields[m[1]] = unescapeQtIni(value);
    }
    if (!fields.identity) return null;
    return { name: fields.id ?? "", nickname: fields.nickname ?? "", phonetic: fields.phonetic_nickname ?? "", blob: fields.identity };
  };

  const handleImportIdentity = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = (reader.result as string).trim();
      const ini = parseIniIdentity(text);
      if (ini) {
        const identity: Identity = {
          id: randomId(),
          name: ini.name || file.name.replace(/\.ini$/i, "") || t("identities.newName"),
          nickname: ini.nickname,
          phoneticName: ini.phonetic,
          blob: ini.blob,
        };
        setIdentities((prev) => [...prev, identity]);
        return;
      }
      try {
        JSON.parse(text);
      } catch {
        logClient("error", "Identities", t("identity.importInvalid", { file: file.name }));
        return;
      }
      const name = file.name.replace(/\.(ts3identity\.)?json$/i, "") || t("identities.newName");
      const identity: Identity = { id: randomId(), name, nickname: "", phoneticName: "", blob: text };
      setIdentities((prev) => [...prev, identity]);
    };
    reader.readAsText(file);
  };

  // --- TS6 Stream/Call -----------------------------------------------------
  //
  // A client that was already streaming when we joined announces nothing: TS6
  // only sets the `client_is_streaming` property, and the stream id has to be
  // pulled with `requeststreaminfo` (ts6-re findings 6b). So whenever a
  // streaming client shows up in the tree, ask once.
  useEffect(() => {
    const streaming = new Set(clients.filter((c) => c.isStreaming).map((c) => c.id));
    for (const id of streaming) {
      if (requestedStreamInfoRef.current.has(id)) continue;
      requestedStreamInfoRef.current.add(id);
      socketRef.current?.send(JSON.stringify({ type: "requestStreamInfo", clientId: id }));
    }
    // Forget clients that stopped, so a later stream is looked up again.
    for (const id of requestedStreamInfoRef.current) {
      if (!streaming.has(id)) requestedStreamInfoRef.current.delete(id);
    }
    setStreamInfos((prev) => {
      const stale = Object.keys(prev).filter((id) => !streaming.has(Number(id)));
      if (stale.length === 0) return prev;
      const next = { ...prev };
      for (const id of stale) delete next[Number(id)];
      return next;
    });
  }, [clients]);

  useEffect(() => {
    const video = streamVideoRef.current;
    if (video && video.srcObject !== streamMedia) video.srcObject = streamMedia;
  }, [streamMedia, watchedStream]);

  useEffect(() => {
    // The publisher owns the capture; the preview only mirrors it, so it is
    // read off the peer connection's senders rather than kept in state.
    const video = publishPreviewRef.current;
    if (!video) return;
    const media = publisherRef.current?.previewStream ?? null;
    if (video.srcObject !== media) video.srcObject = media;
  }, [publishState, publishViewers]);

  const handleStopWatchingStream = () => {
    // close() sends leaveStream and fires onClosed, which clears the rest.
    streamViewerRef.current?.close();
    streamViewerRef.current = null;
    setWatchedStream(null);
    setStreamMedia(null);
    setStreamState("new");
  };

  const handleWatchStream = (clientId: number) => {
    const info = streamInfos[clientId];
    if (!info) return;
    handleStopWatchingStream();
    setStreamError(null);
    const viewer = new StreamViewer(info.id, info.clientId, {
      send: (message) => socketRef.current?.send(JSON.stringify(message)),
      onTrack: setStreamMedia,
      iceServers: [...DEFAULT_ICE_SERVERS, ...turnServers],
      onStateChange: setStreamState,
      onError: setStreamError,
      onClosed: () => {
        // Also reached when the publisher stops, not just via the close button.
        streamViewerRef.current = null;
        setWatchedStream(null);
        setStreamMedia(null);
      },
    });
    streamViewerRef.current = viewer;
    setWatchedStream(info);
    viewer.join();
  };

  const handleStopPublishing = () => {
    publisherRef.current?.stop();
    publisherRef.current = null;
    setPublishState("idle");
    setPublishViewers([]);
    setPublishPending([]);
  };

  const handleStreamButton = () => {
    if (publisherRef.current) {
      handleStopPublishing();
      return;
    }
    setStreamSettingsOpen(true);
  };

  const publishClientName = (clid: number) =>
    clients.find((c) => c.id === clid)?.name ?? `#${clid}`;

  const handleStartPublishing = (options: StreamPublishOptions) => {
    if (ownClientId === null) return;
    setStreamSettingsOpen(false);
    setPublishError(null);
    const publisher = new StreamPublisher({
      send: (message) => socketRef.current?.send(JSON.stringify(message)),
      ownClientId,
      onStateChange: (state) => {
        setPublishState(state);
        // "stopped" is also how the browser's own stop-sharing bar reports in,
        // so the ref has to be dropped here and not only in the click handler.
        if (state === "stopped" || state === "idle") {
          publisherRef.current = null;
          setPublishViewers([]);
          setPublishPending([]);
        }
      },
      onViewersChange: setPublishViewers,
      onPendingChange: setPublishPending,
      onError: setPublishError,
      iceServers: [...DEFAULT_ICE_SERVERS, ...turnServers],
    });
    publisherRef.current = publisher;
    void publisher.start(options);
  };

  const handleShowClientConnectionInfo = (clientId: number, clientName: string) => {
    setClientConnectionInfoTarget({ id: clientId, name: clientName });
    setClientConnectionInfo(null);
    socketRef.current?.send(JSON.stringify({ type: "getClientConnectionInfo", clientId }));
  };

  const handleShowServerConnectionInfo = () => {
    setServerConnectionInfoOpen(true);
    setServerConnectionInfo(null);
    socketRef.current?.send(JSON.stringify({ type: "getServerConnectionInfo" }));
  };

  const handleShowServerProtocolLog = () => {
    setServerProtocolLogOpen(true);
    setServerProtocolLog(null);
    socketRef.current?.send(JSON.stringify({ type: "getServerLog" }));
  };

  const handleShowBanList = () => {
    setBanListOpen(true);
    setBanList(null);
    socketRef.current?.send(JSON.stringify({ type: "getBanList" }));
  };

  const handleDeleteBan = (banId: number) => {
    socketRef.current?.send(JSON.stringify({ type: "deleteBan", banId }));
    setBanList((prev) => (prev ? prev.filter((e) => e.banId !== banId) : prev));
  };

  const handleDeleteAllBans = () => {
    socketRef.current?.send(JSON.stringify({ type: "deleteAllBans" }));
    setBanList([]);
  };

  const handleShowComplainList = () => {
    setComplainListOpen(true);
    setComplainList(null);
    socketRef.current?.send(JSON.stringify({ type: "getComplainList" }));
  };

  const handleDeleteComplaint = (targetClientDbId: number, fromClientDbId: number) => {
    socketRef.current?.send(
      JSON.stringify({ type: "deleteComplaint", targetClientDbId, fromClientDbId })
    );
    setComplainList((prev) =>
      prev
        ? prev.filter(
            (e) => !(e.targetClientDbId === targetClientDbId && e.fromClientDbId === fromClientDbId)
          )
        : prev
    );
  };

  const handleShowOfflineMessages = () => {
    setOfflineMessagesOpen(true);
    setOfflineMessageList(null);
    setOfflineMessageDetail(null);
    socketRef.current?.send(JSON.stringify({ type: "getOfflineMessageList" }));
  };

  const handleSelectOfflineMessage = (messageId: number) => {
    if (messageId === -1) {
      setOfflineMessageDetail(null);
      return;
    }
    socketRef.current?.send(JSON.stringify({ type: "getOfflineMessage", messageId }));
  };

  const handleDeleteOfflineMessage = (messageId: number) => {
    socketRef.current?.send(JSON.stringify({ type: "deleteOfflineMessage", messageId }));
    setOfflineMessageList((prev) => (prev ? prev.filter((e) => e.messageId !== messageId) : prev));
    setOfflineMessageDetail((prev) => (prev?.messageId === messageId ? null : prev));
  };

  const handleMarkOfflineMessageRead = (messageId: number) => {
    socketRef.current?.send(JSON.stringify({ type: "markOfflineMessageRead", messageId }));
    setOfflineMessageList((prev) =>
      prev ? prev.map((e) => (e.messageId === messageId ? { ...e, isRead: true } : e)) : prev
    );
  };

  const handleSendOfflineMessage = (clientUid: string, subject: string, message: string) => {
    socketRef.current?.send(JSON.stringify({ type: "sendOfflineMessage", clientUid, subject, message: wrapUrls(message) }));
  };

  const handleClientContextMenu = (
    e: React.MouseEvent,
    clientId: number,
    clientName: string,
    isSelf: boolean
  ) => {
    e.preventDefault();
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 300);
    setClientContextMenu({ x, y, clientId, clientName, isSelf });
  };

  const handleServerContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 300);
    setServerContextMenu({ x, y });
  };

  const handleShowChannelGroupAssign = (clientId: number, clientName: string) => {
    setGroupAssignTarget({ kind: "channel", clientId, clientName });
    setChannelGroups(null);
    socketRef.current?.send(JSON.stringify({ type: "getChannelGroupList" }));
  };

  const handleShowMoveClient = (clientId: number, clientName: string) => {
    const target = clients.find((c) => c.id === clientId);
    setMoveClientTarget({
      clientId,
      clientName,
      channelId: target?.channel ?? 0,
    });
  };

  const handleMoveClient = (clientId: number, channelId: number) => {
    const client = clients.find((c) => c.id === clientId);
    if (client && client.channel === channelId) return;
    // Moving yourself (e.g. dragging your own row) is a plain channel join,
    // not an admin action - route it through the normal switch flow so it
    // only needs join permission and still prompts for a channel password
    // when required. The `moveClient` command below is for moving OTHER
    // clients, which - like the native client - bypasses the target
    // channel's password for whoever holds the move permission.
    if (clientId === ownClientId) {
      handleSwitchChannel(channelId);
      return;
    }
    socketRef.current?.send(
      JSON.stringify({
        type: "moveClient",
        clientId,
        channelId,
      })
    );
  };

  const handleMoveClientToChannel = (channelId: number) => {
    if (!moveClientTarget) return;
    handleMoveClient(moveClientTarget.clientId, channelId);
    setMoveClientTarget(null);
  };

  const handleShowServerGroupAssign = (clientId: number, clientName: string) => {
    setGroupAssignTarget({ kind: "server", clientId, clientName });
    setServerGroups(null);
    socketRef.current?.send(JSON.stringify({ type: "getServerGroupList" }));
  };

  const handleSelectGroup = (groupId: number, alreadyAssigned: boolean) => {
    if (!groupAssignTarget) return;
    const target = clients.find((c) => c.id === groupAssignTarget.clientId);
    if (!target) {
      setGroupAssignTarget(null);
      return;
    }
    if (groupAssignTarget.kind === "channel") {
      socketRef.current?.send(
        JSON.stringify({
          type: "setChannelGroup",
          channelGroupId: groupId,
          channelId: target.channel,
          clientDbId: target.databaseId,
        })
      );
      setGroupAssignTarget(null);
    } else {
      socketRef.current?.send(
        JSON.stringify({
          type: alreadyAssigned ? "removeServerGroup" : "addServerGroup",
          serverGroupId: groupId,
          clientDbId: target.databaseId,
        })
      );
      // Server group membership is multi-select, so keep the dialog open for
      // further toggling instead of closing after a single action.
    }
  };

  const handleShowPermissionOverview = () => {
    setPermissionOverviewOpen(true);
    setPermissionOverview(null);
    socketRef.current?.send(JSON.stringify({ type: "getPermissionOverview" }));
  };

  const handleOpenPermissionsEditor = (scope: PermScope) => {
    setPermissionsEditorScope(scope);
    setPermissionsEditorEntries(null);
    setPermissionsEditorTarget(null);
    setPermissionsEditorOpen(true);
    // Fetch both lists regardless of the initial tab - the dialog lets the
    // user switch to any of the 5 tabs, including the group ones, later.
    if (!serverGroups) socketRef.current?.send(JSON.stringify({ type: "getServerGroupList" }));
    if (!channelGroups) socketRef.current?.send(JSON.stringify({ type: "getChannelGroupList" }));
  };

  const handlePermsLoadCatalog = () => {
    if (permissionCatalogRequestedRef.current) return;
    permissionCatalogRequestedRef.current = true;
    socketRef.current?.send(JSON.stringify({ type: "getPermissionCatalog" }));
  };

  const handlePermsSelectTarget = (scope: PermScope, id1: number, id2?: number) => {
    setPermissionsEditorEntries(null);
    setPermissionsEditorTarget({ scope, id1, id2 });
    socketRef.current?.send(JSON.stringify({ type: "getPermList", scope, id1, id2 }));
  };

  const handlePermsRefresh = () => {
    if (!permissionsEditorTarget) return;
    const { scope, id1, id2 } = permissionsEditorTarget;
    setPermissionsEditorEntries(null);
    socketRef.current?.send(JSON.stringify({ type: "getPermList", scope, id1, id2 }));
  };

  const handlePermsAdd = (
    scope: PermScope,
    ids: number[],
    permId: number,
    value: number,
    negated: boolean,
    skip: boolean
  ) => {
    socketRef.current?.send(JSON.stringify({ type: "addPermission", scope, ids, permId, value, negated, skip }));
    window.setTimeout(handlePermsRefresh, 300);
  };

  const handlePermsRemove = (scope: PermScope, ids: number[], permId: number) => {
    socketRef.current?.send(JSON.stringify({ type: "removePermission", scope, ids, permId }));
    window.setTimeout(handlePermsRefresh, 300);
  };

  const handleChannelContextMenu = (e: React.MouseEvent, channelId: number, channelName: string) => {
    e.preventDefault();
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 200);
    setChannelContextMenu({ x, y, channelId, channelName });
  };

  const handleShowFileBrowser = (channelId: number, channelName: string) => {
    setFileBrowserTarget({ channelId, channelName });
    setFileBrowserPath("/");
    setFileBrowserEntries(null);
    socketRef.current?.send(JSON.stringify({ type: "getFileList", channelId, path: "/" }));
  };

  const handleFileBrowserNavigate = (path: string) => {
    if (!fileBrowserTarget) return;
    setFileBrowserPath(path);
    setFileBrowserEntries(null);
    socketRef.current?.send(JSON.stringify({ type: "getFileList", channelId: fileBrowserTarget.channelId, path }));
  };

  const handleFileBrowserRefresh = () => {
    if (!fileBrowserTarget) return;
    setFileBrowserEntries(null);
    socketRef.current?.send(
      JSON.stringify({ type: "getFileList", channelId: fileBrowserTarget.channelId, path: fileBrowserPath })
    );
  };

  const handleFileBrowserCreateDir = (name: string) => {
    if (!fileBrowserTarget) return;
    socketRef.current?.send(
      JSON.stringify({
        type: "createDirectory",
        channelId: fileBrowserTarget.channelId,
        dirname: ftJoinPath(fileBrowserPath, name),
      })
    );
    // ftcreatedir gets no dedicated reply - the server processes commands from
    // one connection in order, so a refresh sent right after is guaranteed to
    // see the new directory.
    window.setTimeout(handleFileBrowserRefresh, 300);
  };

  const handleFileBrowserDelete = (entry: FileListEntry) => {
    if (!fileBrowserTarget) return;
    if (!window.confirm(t("fileBrowser.deleteConfirm"))) return;
    socketRef.current?.send(
      JSON.stringify({
        type: "deleteFile",
        channelId: fileBrowserTarget.channelId,
        name: ftJoinPath(fileBrowserPath, entry.name),
      })
    );
    window.setTimeout(handleFileBrowserRefresh, 300);
  };

  const handleFileBrowserRename = (entry: FileListEntry, newName: string) => {
    if (!fileBrowserTarget) return;
    socketRef.current?.send(
      JSON.stringify({
        type: "renameFile",
        channelId: fileBrowserTarget.channelId,
        oldName: ftJoinPath(fileBrowserPath, entry.name),
        newName: ftJoinPath(fileBrowserPath, newName),
      })
    );
    window.setTimeout(handleFileBrowserRefresh, 300);
  };

  // Options -> Download: queue, limits and the transfer window. transfersRef is
  // the source of truth because socket handlers keep old closures; the state
  // copy only drives re-renders.
  const transfersRef = useRef<Transfer[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [transfersOpen, setTransfersOpen] = useState(false);
  const [transferToast, setTransferToast] = useState<{ name: string } | null>(null);
  const nextTransferIdRef = useRef(1);
  const commitTransfers = () => setTransfers([...transfersRef.current]);

  const enqueueTransfer = (x: Omit<Transfer, "id" | "done" | "status">) => {
    transfersRef.current.push({ ...x, id: nextTransferIdRef.current++, done: 0, status: "queued" });
    if (downloadSettings.showWindowOnStart) setTransfersOpen(true);
    commitTransfers();
  };

  const findTransfer = (dir: Transfer["dir"], cid: number, path: string) =>
    transfersRef.current.find((x) => x.status === "running" && x.dir === dir && x.cid === cid && x.path === path);

  const finishTransfer = (x: Transfer, ok: boolean) => {
    x.status = ok ? "done" : "error";
    if (ok) x.done = x.size;
    const settings = downloadSettingsRef.current;
    if (ok && settings.popupWhenDone) setTransferToast({ name: x.name });
    void notify(ok ? "OTHER_FILETRANSFER_COMPLETE" : "OTHER_FILETRANSFER_FAILED");
    if (settings.closeWindowWhenDone && transfersRef.current.every((y) => y.status === "done")) setTransfersOpen(false);
    commitTransfers();
  };

  // Start queued transfers while under the "Gleichzeitige Uploads/Downloads" caps.
  useEffect(() => {
    let started = false;
    for (const dir of ["down", "up"] as const) {
      const max = dir === "down" ? downloadSettings.maxDownloads : downloadSettings.maxUploads;
      let running = transfersRef.current.filter((x) => x.dir === dir && x.status === "running").length;
      for (const x of transfersRef.current) {
        if (running >= max) break;
        if (x.dir !== dir || x.status !== "queued") continue;
        x.status = "running";
        running++;
        started = true;
        if (dir === "down")
          socketRef.current?.send(JSON.stringify({ type: "downloadFile", channelId: x.cid, path: x.path }));
        else void sendUpload(x.cid, x.path, x.file!, x);
      }
    }
    if (started) commitTransfers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transfers, downloadSettings.maxDownloads, downloadSettings.maxUploads]);

  useEffect(() => {
    if (!transferToast) return;
    const id = window.setTimeout(() => setTransferToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [transferToast]);

  // Bandwidth caps are enforced by the connector; resend for every new connection.
  const sentTransferLimitRef = useRef<{ socket: WebSocket | DemoSocket | null; payload: string }>({
    socket: null,
    payload: "",
  });
  useEffect(() => {
    const socket = socketRef.current;
    if (!connected || !socket || !gatewayFeatures.has("transferLimit")) return;
    const payload = JSON.stringify({
      type: "setTransferLimit",
      up: downloadSettings.uploadLimit * 1024,
      down: downloadSettings.downloadLimit * 1024,
    });
    const sent = sentTransferLimitRef.current;
    if (sent.socket === socket && sent.payload === payload) return;
    socket.send(payload);
    sentTransferLimitRef.current = { socket, payload };
  }, [connected, activeSessionId, gatewayFeatures, downloadSettings.uploadLimit, downloadSettings.downloadLimit]);

  const handleFileBrowserDownload = async (entry: FileListEntry) => {
    if (!fileBrowserTarget) return;
    const target = await resolveSaveTarget(downloadSettings, downloadDir, entry.name);
    if (target === "cancelled") return;
    enqueueTransfer({
      dir: "down",
      cid: fileBrowserTarget.channelId,
      path: ftJoinPath(fileBrowserPath, entry.name),
      name: entry.name,
      size: entry.size,
      target,
    });
  };

  // The connector refuses anything bigger. Gateways without "chunkedUpload"
  // also take the whole file as one WebSocket message, capped by maxPayload.
  const rejectOversizedUpload = (file: File): boolean => {
    if (file.size <= MAX_UPLOAD_BYTES) return false;
    appendLog({ text: t("fileBrowser.tooLarge", { mb: String(MAX_UPLOAD_BYTES >> 20) }), kind: "error" });
    return true;
  };

  const handleFileBrowserUpload = (file: File) => {
    if (!fileBrowserTarget) return;
    if (rejectOversizedUpload(file)) return;
    enqueueTransfer({
      dir: "up",
      cid: fileBrowserTarget.channelId,
      path: ftJoinPath(fileBrowserPath, file.name),
      name: file.name,
      size: file.size,
      file,
    });
  };

  // Small pieces keep the gateway from holding a whole file (several times
  // over) in memory. 192 KiB is a multiple of 3, so each piece base64-encodes
  // on its own without padding.
  const sendUpload = async (channelId: number, path: string, file: File, transfer?: Transfer) => {
    const socket = socketRef.current;
    if (!gatewayFeatures.has("chunkedUpload")) {
      socket?.send(JSON.stringify({ type: "uploadFile", channelId, path, dataBase64: await readBase64(file) }));
      return;
    }
    const chunkBytes = 192 * 1024;
    // offset === 0 still sends one (empty) piece for an empty file.
    for (let offset = 0; offset === 0 || offset < file.size; offset += chunkBytes) {
      const data = await readBase64(file.slice(offset, offset + chunkBytes));
      socket?.send(JSON.stringify({ type: "uploadFileChunk", channelId, path, offset, total: file.size, data }));
      if (transfer) {
        transfer.done = Math.min(file.size, offset + chunkBytes);
        commitTransfers();
      }
    }
  };

  const handleShowServerIcons = () => {
    setServerIconsOpen(true);
    setServerIconEntries(null);
    setServerIconImages({});
    requestedAvatarHashesRef.current.clear();
    socketRef.current?.send(JSON.stringify({ type: "getFileList", channelId: 0, path: "/" }));
  };

  const handleServerIconsRefresh = () => {
    setServerIconImages({});
    requestedAvatarHashesRef.current.clear();
    socketRef.current?.send(JSON.stringify({ type: "getFileList", channelId: 0, path: "/" }));
  };

  const handleServerIconUpload = (iconId: number, file: File) => {
    if (rejectOversizedUpload(file)) return;
    void sendUpload(0, `/icon_${iconId}`, file);
  };

  const handleServerIconDelete = (entry: FileListEntry) => {
    if (!window.confirm(t("fileBrowser.deleteConfirm"))) return;
    socketRef.current?.send(JSON.stringify({ type: "deleteFile", channelId: 0, name: `/${entry.name}` }));
    window.setTimeout(handleServerIconsRefresh, 300);
  };

  const handleSendPoke = () => {
    if (!pokeTarget) return;
    socketRef.current?.send(
      JSON.stringify({ type: "sendPoke", clientId: pokeTarget.id, message: pokeMessage })
    );
    setPokeTarget(null);
    setPokeMessage("");
  };

  const handleConfirmKick = () => {
    if (!kickTarget) return;
    socketRef.current?.send(
      JSON.stringify({
        type: kickTarget.scope === "channel" ? "kickFromChannel" : "kickFromServer",
        clientId: kickTarget.id,
        reason: kickReason,
      })
    );
    logClient("info", "Moderation", `Kicked ${kickTarget.name} from ${kickTarget.scope}`);
    setKickTarget(null);
    setKickReason("");
  };

  const handleConfirmBan = () => {
    if (!banTarget) return;
    socketRef.current?.send(
      JSON.stringify({
        type: "banClient",
        clientId: banTarget.id,
        seconds: Number(banSeconds) || 0,
        reason: banReason,
      })
    );
    logClient("info", "Moderation", `Banned ${banTarget.name}`);
    setBanTarget(null);
    setBanReason("");
    setBanSeconds("0");
  };

  const handleClosePrivateChat = (clientId: number) => {
    setPmThreads((prev) => {
      const next = { ...prev };
      delete next[clientId];
      return next;
    });
    setActiveTab((current) => (current === clientId ? "channel" : current));
  };

  const ownClient =
    (ownClientId != null ? clients.find((c) => c.id === ownClientId) : null) ??
    clients.find((c) => c.name === nickname) ??
    null;
  const isAway = ownClient?.away ?? false;
  const inputMuted = ownClient?.inputMuted ?? false;
  const outputMuted = ownClient?.outputMuted ?? false;
  const selfTalking = Boolean(selfActive && !inputMuted && ownClient?.hasTalkPower);
  const displayTalkers = selfTalking && ownClient ? new Set(talkers).add(ownClient.id) : talkers;
  useEffect(() => setNotificationPlaybackMuted(outputMuted), [outputMuted]);
  useEffect(
    () => setSessionSoundPack(favorites.find((f) => f.id === activeFavoriteId)?.soundPack),
    [favorites, activeFavoriteId]
  );
  // "Akustischen Hinweis abspielen, wenn das Mikrofon gemutet ist": once per talk start.
  const talkingWhileMuted = Boolean(selfActive && inputMuted);
  useEffect(() => {
    if (talkingWhileMuted && loadAppSettings().mutedTalkingSound) void notify("SPECIAL_TALKING_WHILE_MUTED");
  }, [talkingWhileMuted]);
  const selfTalkingSeenRef = useRef(false);
  useEffect(() => {
    // Skip the initial render so opening the client doesn't click.
    if (!selfTalkingSeenRef.current) {
      selfTalkingSeenRef.current = true;
      return;
    }
    if (ownMicClicks && !outputMuted) void notify(selfTalking ? "SPECIAL_MIC_CLICK_SELF_ON" : "SPECIAL_MIC_CLICK_SELF_OFF");
  }, [selfTalking]); // eslint-disable-line react-hooks/exhaustive-deps
  const showServerQueryClients =
    activeFavoriteId != null &&
    favorites.some((f) => f.id === activeFavoriteId && f.showServerQueryClients);
  // clients can be a large, frequently-unchanged list re-scanned on every
  // render - including on every "talkers" voice-activity update, which has
  // nothing to do with the client list itself - so memoize on the inputs
  // that actually affect the result instead of re-filtering/re-reducing it
  // every time.
  const treeClients = useMemo(
    () => (showServerQueryClients ? clients : clients.filter((c) => !c.isQuery)),
    [clients, showServerQueryClients]
  );
  // Tree search: a channel whose name matches keeps all its clients, a client
  // whose name matches keeps its channel; either way the parent chain stays so
  // the match is shown where it lives.
  const treeSearch = useMemo(() => {
    const query = treeFilter.trim().toLowerCase();
    if (!query) return null;
    const hit = (name: string) => name.toLowerCase().includes(query);
    const channelHits = new Set(channels.filter((c) => hit(c.name)).map((c) => c.id));
    const shownClients = treeClients.filter((c) => hit(c.name) || channelHits.has(c.channel));
    const parentOf = new Map(channels.map((c) => [c.id, c.parent]));
    const keep = new Set<number>();
    for (let id of [...channelHits, ...shownClients.map((c) => c.channel)]) {
      while (id && !keep.has(id)) {
        keep.add(id);
        id = parentOf.get(id) ?? 0;
      }
    }
    return { channels: channels.filter((c) => keep.has(c.id)), clients: shownClients };
  }, [treeFilter, channels, treeClients]);
  const queryClientCount = useMemo(
    () => clients.reduce((n, c) => n + (c.isQuery ? 1 : 0), 0),
    [clients]
  );
  const displayClientCount =
    serverClientsOnline > 0
      ? serverClientsOnline + (showServerQueryClients ? queryClientCount : 0)
      : treeClients.length;
  const novaSplash = designTheme === "nova" && !connected;
  // Nova and IDE collapse the menubar behind a hamburger button.
  const compactMenu = designTheme === "nova" || designTheme === "ide";
  const micLabel = !micOn ? t("toolbar.micEnable") : inputMuted ? t("toolbar.micUnmute") : t("toolbar.micMute");
  const streamLabel = DEMO_MODE
    ? t("publish.demoUnavailable")
    : `${publishState === "live" ? t("publish.stop") : t("publish.start")} (${t("publish.alpha")})`;

  return (
    <DisplayPrefsContext.Provider value={displayPrefs}>
    <div
      className={`ts-app ts-theme-${theme}${designThemeClassName(designTheme)}${
        activeCustomTheme ? " ts-design-custom" : ""
      }${demoForceMobile ? " ts-force-mobile" : ""}${novaSplash ? " ts-nova-splash" : ""}${
        designTheme === "ide" && !idePixelFont ? " ts-ide-plain-font" : ""
      }`}
      data-custom-theme={activeCustomTheme?.id}
      data-design-theme={designTheme}
    >
      {DEMO_MODE && (
        <div className="ts-demo-banner">
          Demo mode — simulated data only, no real TeamSpeak server involved.{" "}
          <a href="https://github.com/WebSpeak3/webspeak3" target="_blank" rel="noreferrer">
            Get WebSpeak3
          </a>
          <button className="ts-demo-mobile-toggle" onClick={() => setDemoForceMobile((v) => !v)}>
            {demoForceMobile ? "🖥 Desktop view" : "📱 Mobile view"}
          </button>
        </div>
      )}
      <div className="ts-menubar">
        <div className={compactMenu ? "ts-nova-menu-dropdown" : undefined} ref={novaMenuRef}>
        {compactMenu && (
          <button
            className="ts-icon-button ts-nova-menu-toggle"
            onClick={() => setNovaMenuOpen((v) => !v)}
            aria-label={t("menu.connections")}
            aria-expanded={novaMenuOpen}
          >
            ☰
          </button>
        )}
        <div
          className={`ts-menubar-items${compactMenu ? " ts-nova-menu-panel" : ""}${
            novaMenuOpen ? " ts-nova-menu-panel-open" : ""
          }`}
        >
        <div className="ts-menubar-dropdown" ref={connectionsMenuRef}>
          <button
            type="button"
            className="ts-menubar-item ts-menubar-item-active ts-plain-button"
            aria-expanded={connectionsMenuOpen}
            onClick={() => setConnectionsMenuOpen((v) => !v)}
          >
            {t("menu.connections")}
          </button>
          {connectionsMenuOpen && (
            <div className="ts-menu" ref={focusFirstItem} onKeyDown={handleMenuKeyDown}>
              <button
                className="ts-menu-item"
                disabled={connecting}
                onClick={() => {
                  setConnectDialogOpen(true);
                  setConnectionsMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🟢</span>
                <span className="ts-menu-item-label">{t("menu.connections.connect")}</span>
                <span className="ts-menu-item-shortcut">{t("shortcut.ctrl")}+S</span>
              </button>
              <button
                className="ts-menu-item"
                disabled={!connected && sessionTabs.length === 0}
                onClick={() => {
                  handleDisconnect();
                  setConnectionsMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🔴</span>
                <span className="ts-menu-item-label">{t("menu.connections.disconnectCurrent")}</span>
                <span className="ts-menu-item-shortcut">{t("shortcut.ctrl")}+D</span>
              </button>
              <button
                className="ts-menu-item"
                disabled={sessionTabs.length === 0}
                onClick={() => {
                  handleDisconnectAll();
                  setConnectionsMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">❌</span>
                <span className="ts-menu-item-label">{t("menu.connections.disconnectAll")}</span>
              </button>
            </div>
          )}
        </div>
        <div className="ts-menubar-dropdown" ref={favoritesMenuRef}>
          <button
            type="button"
            className="ts-menubar-item ts-menubar-item-active ts-plain-button"
            aria-expanded={favoritesMenuOpen}
            onClick={() => setFavoritesMenuOpen((v) => !v)}
          >
            {t("menu.favorites")}
          </button>
          {favoritesMenuOpen && (
            <div className="ts-menu" ref={focusFirstItem} onKeyDown={handleMenuKeyDown}>
              <button className="ts-menu-item" onClick={openAddFavorite}>
                <span className="ts-menu-item-icon">⭐</span>
                <span className="ts-menu-item-label">{t("menu.favorites.add")}</span>
                <span className="ts-menu-item-shortcut">{t("shortcut.ctrl")}+B</span>
              </button>
              <button className="ts-menu-item" onClick={openManageFavorites}>
                <span className="ts-menu-item-icon">🗂️</span>
                <span className="ts-menu-item-label">{t("menu.favorites.manage")}</span>
              </button>
              {favorites.length > 0 && <div className="ts-menu-separator" />}
              {favorites.map((f) => (
                <button
                  key={f.id}
                  className="ts-menu-item"
                  disabled={connecting}
                  onClick={() => {
                    connectToFavorite(f);
                    setFavoritesMenuOpen(false);
                  }}
                >
                  <span className="ts-menu-item-icon">🔖</span>
                  <span className="ts-menu-item-label">{f.bookmarkName}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="ts-menubar-dropdown" ref={selfMenuRef}>
          <button
            type="button"
            className="ts-menubar-item ts-menubar-item-active ts-plain-button"
            aria-expanded={selfMenuOpen}
            onClick={() => setSelfMenuOpen((v) => !v)}
          >
            {t("menu.self")}
          </button>
          {selfMenuOpen && (
            <div className="ts-menu" ref={focusFirstItem} onKeyDown={handleMenuKeyDown}>
              <button className="ts-menu-item" disabled title={t("clientContext.notSupported")}>
                <span className="ts-menu-item-icon">🎙️</span>
                <span className="ts-menu-item-label">{t("menu.self.recordingProfile")}</span>
              </button>
              <button className="ts-menu-item" disabled title={t("clientContext.notSupported")}>
                <span className="ts-menu-item-icon">🔊</span>
                <span className="ts-menu-item-label">{t("menu.self.playbackProfile")}</span>
              </button>
              <button className="ts-menu-item" disabled title={t("clientContext.notSupported")}>
                <span className="ts-menu-item-icon">⌨️</span>
                <span className="ts-menu-item-label">{t("menu.self.hotkeyProfile")}</span>
              </button>
              <button className="ts-menu-item" disabled title={t("clientContext.notSupported")}>
                <span className="ts-menu-item-icon">🔔</span>
                <span className="ts-menu-item-label">{t("menu.self.soundPack")}</span>
              </button>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                disabled={!connected}
                onClick={() => {
                  setAwayDialogMessage("");
                  setAwayDialogOpen(true);
                  setSelfMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">💤</span>
                <span className="ts-menu-item-label">{t("menu.self.setAway")}</span>
              </button>
              <button
                className="ts-menu-item"
                disabled={!connected}
                onClick={() => {
                  void handleToggleMic();
                  setSelfMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">{micOn ? "🔇" : "🎤"}</span>
                <span className="ts-menu-item-label">
                  {micOn ? t("menu.self.disableMic") : t("menu.self.enableMic")}
                </span>
              </button>
              <button
                className="ts-menu-item"
                disabled={!connected}
                onClick={() => {
                  handleToggleOutputMuted();
                  setSelfMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">{outputMuted ? "🔊" : "🔇"}</span>
                <span className="ts-menu-item-label">
                  {outputMuted ? t("menu.self.unmuteOutput") : t("menu.self.muteOutput")}
                </span>
              </button>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                disabled={!connected}
                onClick={() => {
                  setNicknameDraft(nickname);
                  setChangeNicknameOpen(true);
                  setSelfMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">✎</span>
                <span className="ts-menu-item-label">{t("menu.self.changeNickname")}</span>
              </button>
              <button className="ts-menu-item" disabled title={t("clientContext.notSupported")}>
                <span className="ts-menu-item-icon">🗣️</span>
                <span className="ts-menu-item-label">{t("menu.self.requestTalkPower")}</span>
              </button>
              <button className="ts-menu-item" disabled title={t("clientContext.notSupported")}>
                <span className="ts-menu-item-icon">🖼️</span>
                <span className="ts-menu-item-label">{t("menu.self.setAvatar")}</span>
              </button>
              <button className="ts-menu-item" disabled title={t("clientContext.notSupported")}>
                <span className="ts-menu-item-icon">🔤</span>
                <span className="ts-menu-item-label">{t("menu.self.setPhoneticNickname")}</span>
              </button>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                disabled={!ownClient}
                onClick={() => {
                  if (ownClient) handleShowClientConnectionInfo(ownClient.id, ownClient.name);
                  setSelfMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">ℹ️</span>
                <span className="ts-menu-item-label">{t("menu.self.connectionInfo")}</span>
              </button>
            </div>
          )}
        </div>
        <div className="ts-menubar-dropdown" ref={rightsMenuRef}>
          <button
            type="button"
            className="ts-menubar-item ts-menubar-item-active ts-plain-button"
            aria-expanded={rightsMenuOpen}
            onClick={() => setRightsMenuOpen((v) => !v)}
          >
            {t("menu.rights")}
          </button>
          {rightsMenuOpen && (
            <div className="ts-menu" ref={focusFirstItem} onKeyDown={handleMenuKeyDown}>
              <button
                className="ts-menu-item"
                onClick={() => {
                  handleOpenPermissionsEditor("server");
                  setRightsMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🏷️</span>
                <span className="ts-menu-item-label">{t("menu.rights.serverGroups")}</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  handleOpenPermissionsEditor("channelgroup");
                  setRightsMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🎖️</span>
                <span className="ts-menu-item-label">{t("menu.rights.channelGroups")}</span>
              </button>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                onClick={() => {
                  handleOpenPermissionsEditor("client");
                  setRightsMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🔐</span>
                <span className="ts-menu-item-label">{t("menu.rights.serverPermissions")}</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  handleOpenPermissionsEditor("channel");
                  setRightsMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🔑</span>
                <span className="ts-menu-item-label">{t("menu.rights.channelPermissions")}</span>
              </button>
              <button className="ts-menu-item" disabled title={t("clientContext.notSupported")}>
                <span className="ts-menu-item-icon">📖</span>
                <span className="ts-menu-item-label">{t("menu.rights.overview")}</span>
              </button>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                onClick={() => {
                  handleShowPermissionOverview();
                  setRightsMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🙋</span>
                <span className="ts-menu-item-label">{t("menu.rights.myRights")}</span>
              </button>
            </div>
          )}
        </div>
        <div className="ts-menubar-dropdown" ref={extrasMenuRef}>
          <button
            type="button"
            className="ts-menubar-item ts-menubar-item-active ts-plain-button"
            aria-expanded={extrasMenuOpen}
            onClick={() => setExtrasMenuOpen((v) => !v)}
          >
            {t("menu.extras")}
          </button>
          {extrasMenuOpen && (
            <div className="ts-menu" ref={focusFirstItem} onKeyDown={handleMenuKeyDown}>
              <button
                className="ts-menu-item"
                onClick={() => {
                  setIdentitiesOpen(true);
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🪪</span>
                <span className="ts-menu-item-label">{t("menu.extras.identities")}</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  setContactsOpen(true);
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">📇</span>
                <span className="ts-menu-item-label">{t("menu.extras.contacts")}</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  setCollectedUrlsOpen(true);
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🔗</span>
                <span className="ts-menu-item-label">{t("menu.extras.collectedUrls")}</span>
              </button>
              <button
                className="ts-menu-item"
                disabled={!connected}
                onClick={() => {
                  setInviteFriendOpen(true);
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🧑‍🤝‍🧑</span>
                <span className="ts-menu-item-label">{t("menu.extras.inviteFriend")}</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  setTransfersOpen(true);
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">⇅</span>
                <span className="ts-menu-item-label">{t("menu.extras.fileTransfers")}</span>
              </button>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                onClick={() => {
                  setWhisperListsOpen(true);
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🗒️</span>
                <span className="ts-menu-item-label">{t("menu.extras.whisperLists")}</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  setWhisperHistoryOpen(true);
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🕓</span>
                <span className="ts-menu-item-label">{t("menu.extras.whisperHistory")}</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  setClientLogOpen(true);
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">📜</span>
                <span className="ts-menu-item-label">{t("menu.extras.clientLog")}</span>
              </button>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                onClick={() => {
                  handleShowBanList();
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🚫</span>
                <span className="ts-menu-item-label">{t("menu.extras.banList")}</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  handleShowComplainList();
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">⚠️</span>
                <span className="ts-menu-item-label">{t("menu.extras.complaintList")}</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  handleShowOfflineMessages();
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">📧</span>
                <span className="ts-menu-item-label">{t("menu.extras.offlineMessages")}</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  setServerQueryUsername("");
                  setServerQueryPassword("");
                  setServerQueryLoginOpen(true);
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🔑</span>
                <span className="ts-menu-item-label">{t("menu.extras.serverQueryLogin")}</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  handleShowServerProtocolLog();
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">📄</span>
                <span className="ts-menu-item-label">{t("menu.extras.serverLog")}</span>
              </button>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                disabled={recording}
                onClick={() => {
                  startRecording();
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🔴</span>
                <span className="ts-menu-item-label">{t("menu.extras.startRecording")}</span>
              </button>
              <button className="ts-menu-item" disabled>
                <span className="ts-menu-item-icon">🔴</span>
                <span className="ts-menu-item-label">{t("menu.extras.startMultitrackRecording")}</span>
              </button>
              <button
                className="ts-menu-item"
                disabled={!recording}
                onClick={() => {
                  stopRecording();
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">⏹️</span>
                <span className="ts-menu-item-label">{t("menu.extras.stopRecording")}</span>
              </button>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                onClick={() => {
                  setOptionsDialogOpen(true);
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">⚙️</span>
                <span className="ts-menu-item-label">{t("menu.extras.options")}</span>
              </button>
            </div>
          )}
        </div>
        {IS_OWN_HOSTED_INSTANCE && (
          <button
            type="button"
            className="ts-menubar-item ts-plain-button"
            onClick={() => setFeedbackOpen(true)}
          >
            💬 {t("menu.extras.feedback")}
          </button>
        )}
        <div className="ts-menubar-dropdown" ref={helpMenuRef}>
          <button
            type="button"
            className="ts-menubar-item ts-menubar-item-active ts-plain-button"
            aria-expanded={helpMenuOpen}
            onClick={() => setHelpMenuOpen((v) => !v)}
          >
            {t("menu.help")}
          </button>
          {helpMenuOpen && (
            <div className="ts-menu" ref={focusFirstItem} onKeyDown={handleMenuKeyDown}>
              <button
                className="ts-menu-item"
                onClick={() => {
                  setAboutOpen(true);
                  setHelpMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">ℹ️</span>
                <span className="ts-menu-item-label">{t("menu.help.about")}</span>
              </button>
              <a
                className="ts-menu-item"
                href="https://github.com/WebSpeak3/webspeak3"
                target="_blank"
                rel="noreferrer"
                onClick={() => setHelpMenuOpen(false)}
              >
                <span className="ts-menu-item-icon">🐙</span>
                <span className="ts-menu-item-label">{t("menu.help.github")}</span>
              </a>
              <a
                className="ts-menu-item"
                href="https://github.com/WebSpeak3/webspeak3/releases"
                target="_blank"
                rel="noreferrer"
                onClick={() => setHelpMenuOpen(false)}
              >
                <span className="ts-menu-item-icon">📋</span>
                <span className="ts-menu-item-label">{t("menu.help.changelog")}</span>
              </a>
              <a
                className="ts-menu-item"
                href="https://hosted.weblate.org/projects/webspeak3/"
                target="_blank"
                rel="noreferrer"
                onClick={() => setHelpMenuOpen(false)}
              >
                <span className="ts-menu-item-icon">🌐</span>
                <span className="ts-menu-item-label">{t("menu.help.translate")}</span>
              </a>
              {IS_OWN_HOSTED_INSTANCE && (
                <button
                  className="ts-menu-item"
                  onClick={() => {
                    setTosMandatory(false);
                    setTosOpen(true);
                    setHelpMenuOpen(false);
                  }}
                >
                  <span className="ts-menu-item-icon">📜</span>
                  <span className="ts-menu-item-label">{t("menu.extras.tos")}</span>
                </button>
              )}
            </div>
          )}
        </div>
        </div>
        </div>
        {designTheme === "nova" && (
          <div className="ts-nova-topbar-server">
            <span className="ts-nova-topbar-logo">W</span>
            <span className="ts-nova-topbar-name">{connected ? serverName || host : "WebSpeak3"}</span>
            <span className={`ts-nova-topbar-status${connected ? " ts-nova-topbar-status-on" : ""}`}>
              <span className="ts-nova-topbar-dot" />
              {connected ? t("design.status.connected") : t("tree.notConnected")}
            </span>
          </div>
        )}
      </div>

      <div className="ts-toolbar">
        {designTheme === "nova" && connected && ownClient && (
          <div className="ts-nova-toolbar-self">
            <span className="ts-nova-toolbar-avatar">
              {ownClient.name.trim().charAt(0).toUpperCase() || "?"}
            </span>
            <span className="ts-nova-toolbar-self-info">
              <span className="ts-nova-toolbar-self-name">{ownClient.name}</span>
              <span className="ts-nova-toolbar-self-status">
                {isAway ? t("tree.away") : t("design.status.connected")}
              </span>
            </span>
          </div>
        )}
        <div className="ts-toolbar-icons">
          <div className="ts-toolbar-away" ref={awayMenuRef}>
            <button
              className={`ts-icon-button${isAway ? " ts-away-on" : ""}`}
              onClick={() => sendAway(!isAway, "")}
              disabled={!connected}
              title={isAway ? t("toolbar.backOnline") : t("toolbar.setAway")}
              aria-label={isAway ? t("toolbar.backOnline") : t("toolbar.setAway")}
            >
              💤
            </button>
            <button
              className="ts-icon-caret"
              onClick={() => {
                setAwayPresets(loadAwayPresets());
                setAwayMenuOpen((v) => !v);
              }}
              disabled={!connected}
              title={t("toolbar.awayOptions")}
              aria-label={t("toolbar.awayOptions")}
              aria-haspopup="menu"
              aria-expanded={awayMenuOpen}
            >
              ▾
            </button>
            {awayMenuOpen && (
              <div className="ts-menu ts-menu-away" ref={focusFirstItem} onKeyDown={handleMenuKeyDown}>
                <button
                  className="ts-menu-item"
                  onClick={() => {
                    sendAway(true, "");
                    setAwayMenuOpen(false);
                  }}
                >
                  <span className="ts-menu-item-icon">💤</span>
                  <span className="ts-menu-item-label">{t("away.setGlobal")}</span>
                </button>
                <button
                  className="ts-menu-item"
                  onClick={() => {
                    setAwayDialogMessage("");
                    setAwayDialogOpen(true);
                    setAwayMenuOpen(false);
                  }}
                >
                  <span className="ts-menu-item-icon">✎</span>
                  <span className="ts-menu-item-label">{t("away.setGlobalStatus")}</span>
                </button>
                {awayPresets.length > 0 && <div className="ts-menu-separator" />}
                {awayPresets.map((preset) => (
                  <button
                    key={preset.name}
                    className="ts-menu-item"
                    onClick={() => {
                      sendAway(true, preset.message);
                      setAwayMenuOpen(false);
                    }}
                  >
                    <span className="ts-menu-item-label">{preset.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="ts-toolbar-sep" />
          <div className="ts-toolbar-away" ref={whisperMenuRef}>
            <button
              className={`ts-icon-button${whisperChannelIds.size > 0 || whisperClientIds.size > 0 ? " ts-away-on" : ""}`}
              onClick={() => setWhisperMenuOpen((v) => !v)}
              disabled={!connected}
              title={t("toolbar.whisper")}
              aria-label={t("toolbar.whisper")}
              aria-haspopup="menu"
              aria-expanded={whisperMenuOpen}
            >
              🤫
            </button>
            {whisperMenuOpen && (
              <div className="ts-menu ts-menu-away" ref={focusFirstItem} onKeyDown={handleMenuKeyDown}>
                <div className="ts-context-menu-title">{t("whisper.channels")}</div>
                {channels.map((ch) => (
                  <label key={ch.id} className="ts-menu-item">
                    <input
                      type="checkbox"
                      checked={whisperChannelIds.has(ch.id)}
                      onChange={() => toggleWhisperChannel(ch.id)}
                    />
                    <span className="ts-menu-item-label">{ch.name}</span>
                  </label>
                ))}
                {whisperClientIds.size > 0 && (
                  <>
                    <div className="ts-menu-separator" />
                    <div className="ts-context-menu-title">{t("whisper.clients")}</div>
                    {[...whisperClientIds].map((id) => (
                      <button key={id} className="ts-menu-item" onClick={() => toggleWhisperClient(id)}>
                        <span className="ts-menu-item-icon">✕</span>
                        <span className="ts-menu-item-label">
                          {clients.find((c) => c.id === id)?.name ?? id}
                        </span>
                      </button>
                    ))}
                  </>
                )}
                {(whisperChannelIds.size > 0 || whisperClientIds.size > 0) && (
                  <>
                    <div className="ts-menu-separator" />
                    <button className="ts-menu-item" onClick={clearWhisperTargets}>
                      <span className="ts-menu-item-label">{t("whisper.clearAll")}</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          <span className="ts-toolbar-sep" />
          <button
            className={`ts-icon-button${micOn && !inputMuted ? " ts-mic-on" : ""}${micOn && inputMuted ? " ts-muted-on" : ""}`}
            onClick={handleToggleMic}
            title={micLabel}
            aria-label={micLabel}
          >
            {micOn && !inputMuted ? "🎤" : "🔇"}
          </button>
          {pushToTalk ? (
            <button
              className={`ts-icon-button ts-ptt-button${pttPressed ? " ts-mic-on" : ""}`}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                setPttPressed(true);
              }}
              onPointerUp={() => setPttPressed(false)}
              onPointerCancel={() => setPttPressed(false)}
              onKeyDown={(e) => {
                if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                  e.preventDefault();
                  setPttPressed(true);
                }
              }}
              onKeyUp={(e) => {
                if (e.key === " " || e.key === "Enter") setPttPressed(false);
              }}
              onContextMenu={(e) => e.preventDefault()}
              title={t("toolbar.pushToTalk")}
              aria-label={t("toolbar.pushToTalk")}
              aria-pressed={pttPressed}
            >
              🗣️
            </button>
          ) : continuous ? null : (
            <label className="ts-icon-slider" title={t("toolbar.vadSensitivity")}>
              🎚️
              <input
                type="range"
                min={0.002}
                max={0.15}
                step={0.002}
                value={vadThreshold}
                onChange={(e) => setVadThreshold(Number(e.target.value))}
                aria-label={t("toolbar.vadSensitivity")}
              />
            </label>
          )}
          <button
            className={`ts-icon-button${publishState === "live" ? " ts-mic-on" : ""}`}
            onClick={handleStreamButton}
            // DemoSocket has no answer for setupstream, so in demo mode the
            // panel would sit at "starting" forever - after the browser has
            // already asked the visitor to pick a screen. Don't offer it.
            disabled={!connected || ownClientId === null || DEMO_MODE}
            title={streamLabel}
            aria-label={streamLabel}
          >
            {publishState === "live" ? "🛑" : "🖥️"}
          </button>
          {TAB_AUDIO_SUPPORTED && (
            <button
              className={`ts-icon-button${tabAudioOn ? " ts-mic-on" : ""}`}
              onClick={handleToggleTabAudio}
              disabled={!micOn}
              title={tabAudioOn ? t("tabAudio.stop") : t("tabAudio.start")}
              aria-label={tabAudioOn ? t("tabAudio.stop") : t("tabAudio.start")}
            >
              🎵
            </button>
          )}
          <span className="ts-toolbar-sep" />
          <button
            className={`ts-icon-button${outputMuted ? " ts-muted-on" : ""}`}
            onClick={handleToggleOutputMuted}
            disabled={!connected}
            title={outputMuted ? t("toolbar.unmuteSound") : t("toolbar.muteSound")}
            aria-label={outputMuted ? t("toolbar.unmuteSound") : t("toolbar.muteSound")}
          >
            {outputMuted ? "🔇" : "🔊"}
          </button>
          {hasNativeOutputPicker() ? (
            <button className="ts-icon-button" onClick={handlePickOutputDevice} title={t("toolbar.chooseOutputDevice")} aria-label={t("toolbar.chooseOutputDevice")}>
              🎧
            </button>
          ) : (
            <label className="ts-icon-select">
              🎧
              <select
                value={outputDeviceId}
                onChange={(e) => handleOutputDeviceChange(e.target.value)}
                onFocus={refreshOutputDevices}
                aria-label={t("toolbar.chooseOutputDevice")}
              >
                <option value="">{t("playback.systemDefault")}</option>
                {outputDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Output ${d.deviceId.slice(0, 6)}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          {recording && (
            <button className="ts-icon-button ts-recording-on" onClick={stopRecording} title={t("menu.extras.stopRecording")} aria-label={t("menu.extras.stopRecording")}>
              🔴
            </button>
          )}
          <span className="ts-toolbar-sep" />
          <button
            className="ts-icon-button"
            onClick={() => setTheme((mode) => (mode === "dark" ? "light" : "dark"))}
            title={t("toolbar.toggleTheme")}
            aria-label={t("toolbar.toggleTheme")}
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" className="ts-app-logo" />
          <span className="ts-app-title" role="heading" aria-level={1}>WebSpeak3</span>
        </div>

      </div>

      {sessionTabs.length > 0 ? (
        <ConnectionTabs
          tabs={sessionTabs}
          activeTabId={activeSessionId}
          onSelectTab={switchToSession}
          onCloseTab={closeSessionTab}
        />
      ) : null}

      {connectDialogOpen && (
        <ConnectDialog
          host={dialogHost}
          nickname={nickname}
          serverPassword={serverPassword}
          channelPassword={channelPassword}
          defaultChannel={defaultChannel}
          privilegeKey={privilegeKey}
          serverType={serverType}
          expanded={connectDialogExpanded}
          connecting={connecting}
          identities={identities}
          activeIdentityId={activeIdentityId}
          onHostChange={setHost}
          onNicknameChange={setNickname}
          onServerPasswordChange={setServerPassword}
          onChannelPasswordChange={setChannelPassword}
          onDefaultChannelChange={setDefaultChannel}
          onPrivilegeKeyChange={setPrivilegeKey}
          onServerTypeChange={setServerType}
          onActiveIdentityChange={handleActiveIdentityChange}
          onToggleExpanded={() => setConnectDialogExpanded((v) => !v)}
          onConnect={() => handleConnect({ host: dialogHost })}
          onConnectNewTab={() => handleConnect({ host: dialogHost })}
          canOpenNewTab={sessionTabs.length > 0 || connected}
          onCancel={novaSplash ? () => {} : () => setConnectDialogOpen(false)}
          nova={designTheme === "nova"}
          onOpenOptions={() => setOptionsDialogOpen(true)}
        />
      )}

      <UpdatePrompt />

      {/* The feedback button sits above the donation pill where that one is
          shown, and takes its spot where it is not. */}
      {IS_OWN_HOSTED_INSTANCE && !feedbackOpen && (
        <FeedbackFab onOpen={() => setFeedbackOpen(true)} stacked={!!DONATE_URL} />
      )}

      <DonateFab />

      {feedbackOpen && <FeedbackDialog onClose={() => setFeedbackOpen(false)} audioState={audioContextRef.current?.state ?? "not started"} />}

      {favoritesDialogMode && (
        <FavoritesDialog
          favorites={favorites}
          prefillNew={favoritesDialogMode.kind === "add" ? favoritesDialogMode.prefill : undefined}
          onSave={saveFavorites}
          onClose={() => setFavoritesDialogMode(null)}
        />
      )}

      {collectedUrlsOpen && (
        <CollectedUrlsDialog
          urls={collectedUrls}
          onClear={() => setCollectedUrls([])}
          onClose={() => setCollectedUrlsOpen(false)}
        />
      )}

      {transfersOpen && (
        <FileTransfersWindow
          transfers={transfers}
          onClearFinished={() => {
            transfersRef.current = transfersRef.current.filter((x) => x.status === "queued" || x.status === "running");
            commitTransfers();
          }}
          onClose={() => setTransfersOpen(false)}
        />
      )}
      {transferToast && (
        <div className="ts-transfer-toast" role="status">
          {t("transfers.finished", { name: transferToast.name })}
        </div>
      )}
      {restartNotice && <RestartNoticeDialog message={restartNotice} onAck={() => setRestartNotice(null)} />}

      {aboutOpen && (
        <AboutDialog
          onClose={() => {
            setAboutOpen(false);
            if (window.location.hash === "#about") window.history.replaceState(null, "", window.location.pathname + window.location.search);
          }}
        />
      )}

      {tosOpen && (
        <ToSDialog
          mandatory={tosMandatory}
          onAccept={() => {
            localStorage.setItem(TOS_KEY, `${TOS_VERSION}:${new Date().toISOString().slice(0, 10)}`);
            setTosOpen(false);
            setTosMandatory(false);
          }}
          onClose={() => setTosOpen(false)}
        />
      )}

      {channelPasswordPrompt && (
        <ChannelPasswordDialog
          channelName={channelPasswordPrompt.channelName}
          wrongPassword={channelPasswordPrompt.wrongPassword}
          onSubmit={handleChannelPasswordSubmit}
          onCancel={handleChannelPasswordCancel}
        />
      )}

      {inviteFriendOpen && (
        <InviteFriendDialog
          host={host}
          channelId={selected?.type === "channel" ? selected.id : null}
          channelPath={(() => {
            if (selected?.type !== "channel") return null;
            const names: string[] = [];
            for (let ch = channels.find((c) => c.id === selected.id); ch && names.length < 50; ch = channels.find((c) => c.id === ch!.parent)) names.unshift(ch.name);
            return names.join("/");
          })()}
          onClose={() => setInviteFriendOpen(false)}
        />
      )}

      {clientLogOpen && (
        <ClientLogDialog entries={logEntries} onClose={() => setClientLogOpen(false)} />
      )}

      {whisperHistoryOpen && (
        <WhisperHistoryDialog
          serverName={serverName}
          entries={whisperLog}
          onClear={() => setWhisperLog([])}
          onClose={() => setWhisperHistoryOpen(false)}
        />
      )}

      {whisperListsOpen && (
        <WhisperListsDialog
          lists={whisperLists}
          hasCurrentSelection={whisperChannelIds.size > 0 || whisperClientIds.size > 0}
          onSave={handleSaveWhisperList}
          onActivate={handleActivateWhisperList}
          onDelete={handleDeleteWhisperList}
          onClose={() => setWhisperListsOpen(false)}
        />
      )}

      {identitiesOpen && (
        <IdentitiesDialog
          identities={identities}
          activeId={activeIdentityId}
          ownUid={connected ? ownClient?.uid ?? null : null}
          onActivate={setActiveIdentityId}
          onAdd={handleAddIdentity}
          onRename={handleRenameIdentity}
          onNicknameChange={handleIdentityNicknameChange}
          onPhoneticChange={handleIdentityPhoneticChange}
          onDelete={handleDeleteIdentity}
          onExport={handleExportIdentity}
          onImport={handleImportIdentity}
          onClose={() => setIdentitiesOpen(false)}
        />
      )}

      {clientConnectionInfoTarget && (
        <ClientConnectionInfoDialog
          clientName={clientConnectionInfoTarget.name}
          info={clientConnectionInfo?.clientId === clientConnectionInfoTarget.id ? clientConnectionInfo : null}
          onClose={() => setClientConnectionInfoTarget(null)}
        />
      )}

      {serverConnectionInfoOpen && (
        <ServerConnectionInfoDialog
          info={serverConnectionInfo}
          serverName={serverName}
          host={host}
          serverVersion={serverVersion}
          serverLicense={serverLicense}
          onClose={() => setServerConnectionInfoOpen(false)}
        />
      )}

      {serverEditOpen && (
        <ServerEditDialog
          serverName={serverName}
          welcomeMessage={serverWelcomeMessage}
          hostbannerGfxUrl={serverBannerUrl}
          onSave={(payload) => {
            socketRef.current?.send(JSON.stringify({ type: "editServer", payload }));
            logClient("info", "Moderation", "Edited server settings");
          }}
          onClose={() => setServerEditOpen(false)}
        />
      )}

      {serverProtocolLogOpen && (
        <ServerProtocolLogDialog
          lines={serverProtocolLog}
          onClose={() => setServerProtocolLogOpen(false)}
        />
      )}

      {banListOpen && (
        <BanListDialog
          entries={banList}
          onDelete={handleDeleteBan}
          onDeleteAll={handleDeleteAllBans}
          onClose={() => setBanListOpen(false)}
        />
      )}

      {complainListOpen && (
        <ComplainListDialog
          entries={complainList}
          onDelete={handleDeleteComplaint}
          onClose={() => setComplainListOpen(false)}
        />
      )}

      {offlineMessagesOpen && (
        <OfflineMessagesDialog
          entries={offlineMessageList}
          detail={offlineMessageDetail}
          onSelect={handleSelectOfflineMessage}
          onDelete={handleDeleteOfflineMessage}
          onMarkRead={handleMarkOfflineMessageRead}
          onSend={handleSendOfflineMessage}
          onClose={() => setOfflineMessagesOpen(false)}
        />
      )}

      {groupAssignTarget && (
        <GroupAssignDialog
          kind={groupAssignTarget.kind}
          clientName={groupAssignTarget.clientName}
          groups={groupAssignTarget.kind === "channel" ? channelGroups : serverGroups}
          currentGroupIds={(() => {
            const target = clients.find((c) => c.id === groupAssignTarget.clientId);
            if (!target) return [];
            return groupAssignTarget.kind === "channel" ? [target.channelGroup] : target.serverGroups;
          })()}
          iconImages={serverIconImages}
          onSelect={handleSelectGroup}
          onClose={() => setGroupAssignTarget(null)}
        />
      )}

      {moveClientTarget && (
        <MoveClientDialog
          clientName={moveClientTarget.clientName}
          currentChannelId={moveClientTarget.channelId}
          channels={channels}
          onSelect={handleMoveClientToChannel}
          onClose={() => setMoveClientTarget(null)}
        />
      )}

      {permissionOverviewOpen && (
        <PermissionOverviewDialog
          entries={permissionOverview}
          onClose={() => setPermissionOverviewOpen(false)}
        />
      )}

      {permissionsEditorOpen && (
        <PermissionsEditorDialog
          initialScope={permissionsEditorScope}
          channelGroups={channelGroups}
          serverGroups={serverGroups}
          channels={channels}
          clients={clients}
          entries={permissionsEditorEntries}
          catalog={permissionCatalog}
          onSelectTarget={handlePermsSelectTarget}
          onLoadCatalog={handlePermsLoadCatalog}
          onAdd={handlePermsAdd}
          onRemove={handlePermsRemove}
          onClose={() => setPermissionsEditorOpen(false)}
        />
      )}

      {fileBrowserTarget && (
        <FileBrowserDialog
          channelName={fileBrowserTarget.channelName}
          path={fileBrowserPath}
          entries={fileBrowserEntries}
          onNavigate={handleFileBrowserNavigate}
          onCreateDir={handleFileBrowserCreateDir}
          onDelete={handleFileBrowserDelete}
          onRename={handleFileBrowserRename}
          onDownload={handleFileBrowserDownload}
          onUpload={handleFileBrowserUpload}
          onRefresh={handleFileBrowserRefresh}
          onClose={() => setFileBrowserTarget(null)}
        />
      )}

      {serverIconsOpen && (
        <ServerIconsDialog
          entries={serverIconEntries}
          images={serverIconImages}
          onUpload={handleServerIconUpload}
          onDelete={handleServerIconDelete}
          onClose={() => setServerIconsOpen(false)}
        />
      )}

      {contactsOpen && (
        <ContactsDialog
          contacts={contacts}
          onlineClients={clients}
          onSave={setContacts}
          onWhisper={toggleWhisperClient}
          onShow={(clientId) => {
            const client = clients.find((c) => c.id === clientId);
            if (client) setSelected({ type: "channel", id: client.channel });
          }}
          onClose={() => setContactsOpen(false)}
        />
      )}

      {awayDialogOpen && (
        <AwayDialog
          message={awayDialogMessage}
          presets={awayPresets}
          onMessageChange={setAwayDialogMessage}
          onOk={handleConfirmAway}
          onSaveTemplate={handleSaveAwayTemplate}
          onCancel={() => setAwayDialogOpen(false)}
        />
      )}

      {optionsDialogOpen && (
        <OptionsDialog
          onOpenWhisperLists={() => setWhisperListsOpen(true)}
          onOpenIdentities={() => setIdentitiesOpen(true)}
          onOpenFavorites={openManageFavorites}
          // Native's ✔: the chosen pack becomes every favorite's pack (drop their overrides).
          onApplyPackToFavorites={() => saveFavorites(favorites.map(({ soundPack: _, ...f }) => f))}
          onClearCache={handleClearCache}
          section={optionsSection}
          onSectionChange={setOptionsSection}
          onClose={() => {
            setOptionsDialogOpen(false);
            if (window.location.hash.startsWith("#options/")) window.history.replaceState(null, "", window.location.pathname + window.location.search);
          }}
          designSelection={designSelection}
          onDesignSelectionChange={handleDesignSelectionChange}
          customThemes={customThemes}
          onSaveCustomTheme={handleSaveCustomTheme}
          onDeleteCustomTheme={handleDeleteCustomTheme}
          idePixelFont={idePixelFont}
          onIdePixelFontChange={(on) => {
            setIdePixelFont(on);
            try {
              localStorage.setItem(IDE_PIXEL_FONT_KEY, on ? "on" : "off");
            } catch {
              /* private mode: setting just doesn't persist */
            }
          }}
          showServerBanner={showServerBanner}
          onShowServerBannerChange={(on) => {
            setShowServerBanner(on);
            try {
              localStorage.setItem(SERVER_BANNER_KEY, on ? "on" : "off");
            } catch {
              /* private mode: setting just doesn't persist */
            }
          }}
          chatImages={chatImages}
          onChatImagesChange={(on) => {
            setChatImages(on);
            try {
              localStorage.setItem(CHAT_IMAGES_KEY, on ? "on" : "off");
            } catch {
              /* private mode: setting just doesn't persist */
            }
          }}
          audio={{
            outputDevices,
            outputDeviceId,
            onOutputDeviceChange: handleOutputDeviceChange,
            onRefreshOutputDevices: refreshOutputDevices,
            playbackVolume,
            onPlaybackVolumeChange: setPlaybackVolume,
            autoVolume,
            onAutoVolumeChange: setAutoVolume,
            ownMicClicks,
            onOwnMicClicksChange: setOwnMicClicks,
            otherMicClicks,
            onOtherMicClicksChange: setOtherMicClicks,
            onPlayTestTone: handlePlayTestTone,
            inputDevices,
            inputDeviceId,
            onInputDeviceChange: handleInputDeviceChange,
            onRefreshInputDevices: refreshInputDevices,
            micOn,
            micLevelRef,
            micTestOn,
            onToggleMicTest: handleToggleMicTest,
            vadThreshold,
            onVadThresholdChange: setVadThreshold,
            vadHangover,
            onVadHangoverChange: setVadHangover,
            pushToTalk,
            continuous,
            onContinuousChange: setContinuous,
            typingAttenuation,
            onTypingAttenuationChange: setTypingAttenuation,
            onPushToTalkChange: setPushToTalk,
            pttBinding,
            onPttBindingChange: setPttBinding,
            noiseSuppressionEnabled,
            onToggleNoiseSuppression: handleToggleNoiseSuppression,
            echoCancellationEnabled,
            onToggleEchoCancellation: handleToggleEchoCancellation,
            autoGainControlEnabled,
            onToggleAutoGainControl: handleToggleAutoGainControl,
            aec3Enabled,
            aec3Loading,
            onToggleAec3: handleToggleAec3,
          }}
        />
      )}

      {connectError && (
        <div className="ts-connect-error">
          <span>⚠️ {connectError}</span>
          <button onClick={() => setConnectError(null)} title={t("connectError.dismiss")}>
            ✕
          </button>
        </div>
      )}

      {changeNicknameOpen && (
        <div className="ts-poke-compose-backdrop" {...nicknameBackdrop}>
          <div className="ts-poke-compose" onClick={(e) => e.stopPropagation()}>
            <span>✎ {t("menu.self.changeNickname")}</span>
            <input
              autoFocus
              value={nicknameDraft}
              onChange={(e) => setNicknameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && nicknameDraft.trim()) {
                  handleSetNickname(nicknameDraft.trim());
                  setChangeNicknameOpen(false);
                }
                if (e.key === "Escape") setChangeNicknameOpen(false);
              }}
            />
            <button
              disabled={!nicknameDraft.trim()}
              onClick={() => {
                handleSetNickname(nicknameDraft.trim());
                setChangeNicknameOpen(false);
              }}
            >
              {t("favorites.ok")}
            </button>
            <button onClick={() => setChangeNicknameOpen(false)}>{t("favorites.cancel")}</button>
          </div>
        </div>
      )}

      {serverQueryLoginOpen && (
        <div className="ts-poke-compose-backdrop" {...serverQueryLoginBackdrop}>
          <div className="ts-poke-compose ts-serverquery-login-compose" onClick={(e) => e.stopPropagation()}>
            <span>🔑 {t("menu.extras.serverQueryLogin")}</span>
            <input
              autoFocus
              placeholder={t("serverQueryLogin.username")}
              value={serverQueryUsername}
              onChange={(e) => setServerQueryUsername(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setServerQueryLoginOpen(false);
              }}
            />
            <input
              type="password"
              placeholder={t("serverQueryLogin.password")}
              value={serverQueryPassword}
              onChange={(e) => setServerQueryPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleServerQueryLogin();
                if (e.key === "Escape") setServerQueryLoginOpen(false);
              }}
            />
            <button
              disabled={!serverQueryUsername.trim() || !serverQueryPassword}
              onClick={handleServerQueryLogin}
            >
              {t("serverQueryLogin.login")}
            </button>
            <button onClick={() => setServerQueryLoginOpen(false)}>{t("favorites.cancel")}</button>
          </div>
        </div>
      )}

      {pokeTarget && (
        <div className="ts-poke-compose-backdrop" {...pokeBackdrop}>
          <div className="ts-poke-compose" onClick={(e) => e.stopPropagation()}>
            <span>
              👉 {t("poke.title")} <strong>{pokeTarget.name}</strong>
            </span>
            <input
              autoFocus
              value={pokeMessage}
              onChange={(e) => setPokeMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSendPoke();
                if (e.key === "Escape") setPokeTarget(null);
              }}
              placeholder={t("poke.optionalMessage")}
            />
            <button onClick={handleSendPoke}>{t("poke.send")}</button>
            <button onClick={() => setPokeTarget(null)}>{t("poke.cancel")}</button>
          </div>
        </div>
      )}

      {kickTarget && (
        <div className="ts-poke-compose-backdrop" {...kickBackdrop}>
          <div className="ts-poke-compose" onClick={(e) => e.stopPropagation()}>
            <span>
              👢 {t("kick.title")} <strong>{kickTarget.name}</strong>
            </span>
            <input
              autoFocus
              value={kickReason}
              onChange={(e) => setKickReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleConfirmKick();
                if (e.key === "Escape") setKickTarget(null);
              }}
              placeholder={t("kick.reasonPlaceholder")}
            />
            <button onClick={handleConfirmKick}>{t("kick.confirm")}</button>
            <button onClick={() => setKickTarget(null)}>{t("kick.cancel")}</button>
          </div>
        </div>
      )}

      {banTarget && (
        <div className="ts-poke-compose-backdrop" {...banBackdrop}>
          <div className="ts-poke-compose ts-ban-compose" onClick={(e) => e.stopPropagation()}>
            <span>
              🚫 {t("ban.title")} <strong>{banTarget.name}</strong>
            </span>
            <label className="ts-ban-duration-field">
              {t("ban.duration")}
              <select value={banSeconds} onChange={(e) => setBanSeconds(e.target.value)}>
                <option value="0">{t("ban.durationPermanent")}</option>
                <option value="3600">{t("ban.duration1h")}</option>
                <option value="86400">{t("ban.duration1d")}</option>
                <option value="604800">{t("ban.duration1w")}</option>
              </select>
            </label>
            <input
              value={banReason}
              onChange={(e) => setBanReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleConfirmBan();
                if (e.key === "Escape") setBanTarget(null);
              }}
              placeholder={t("ban.reasonPlaceholder")}
            />
            <button onClick={handleConfirmBan}>{t("ban.confirm")}</button>
            <button onClick={() => setBanTarget(null)}>{t("ban.cancel")}</button>
          </div>
        </div>
      )}

      {pokes.map((poke) => (
        <div key={poke.id} className="ts-poke-notice">
          <span>
            👉 <strong>{poke.from}</strong> {t("poke.pokedYou")}{poke.message ? `: ${poke.message}` : ""}
          </span>
          <button onClick={() => setPokes((prev) => prev.filter((p) => p.id !== poke.id))} title={t("poke.dismiss")}>
            ✕
          </button>
        </div>
      ))}

      {streamSettingsOpen && (
        <StreamSettingsDialog
          defaultName={`${ownClient?.name ?? "WebSpeak3"} - ${t("publish.screen")}`}
          onStart={handleStartPublishing}
          onCancel={() => setStreamSettingsOpen(false)}
        />
      )}
      {(watchedStream || (publishState !== "idle" && publishState !== "stopped")) && (
      <div className="ts-stream-panels">
      {publishState !== "idle" && publishState !== "stopped" && (
        <div className="ts-stream-panel ts-stream-panel-publish">
          <div className="ts-stream-panel-header">
            <span className="ts-stream-panel-title">
              🖥️ {t("publish.title")} <AlphaBadge />
            </span>
            <span className="ts-stream-panel-state">
              {publishState === "live"
                ? t("publish.viewers", { count: String(publishViewers.length) })
                : t("publish.starting")}
            </span>
            <button
              className="ts-stream-panel-close"
              onClick={handleStopPublishing}
              title={t("publish.stop")}
            >
              ✕
            </button>
          </div>
          {/* muted: this is our own capture playing back locally */}
          <video ref={publishPreviewRef} autoPlay playsInline muted />
          {publishPending.map(([clid, message]) => (
            <div className="ts-stream-request" key={clid}>
              <span className="ts-stream-request-who">
                {publishClientName(clid)}
                {message && <em>{message}</em>}
              </span>
              <button
                className="ts-stream-request-allow"
                onClick={() => void publisherRef.current?.approve(clid)}
              >
                {t("publish.request.allow")}
              </button>
              <button onClick={() => publisherRef.current?.deny(clid)}>
                {t("publish.request.deny")}
              </button>
              <button
                className="ts-stream-request-block"
                onClick={() => publisherRef.current?.deny(clid, true)}
                title={t("publish.request.blockHint")}
              >
                {t("publish.request.block")}
              </button>
            </div>
          ))}
          {publishError && <div className="ts-stream-panel-error">{publishError}</div>}
        </div>
      )}
      {watchedStream && (
        <div className="ts-stream-panel">
          <div className="ts-stream-panel-header">
            <span className="ts-stream-panel-title">
              📺 {watchedStream.name || t("stream.untitled")} <AlphaBadge />
            </span>
            <span className="ts-stream-panel-state">
              {streamState === "connected" ? t("stream.live") : t(`stream.state.${streamState}`)}
            </span>
            <button
              className="ts-stream-panel-close"
              onClick={handleStopWatchingStream}
              title={t("stream.stop")}
            >
              ✕
            </button>
          </div>
          {/* muted so autoplay is never blocked; the user unmutes via the controls */}
          <video ref={streamVideoRef} autoPlay playsInline muted controls />
          {streamError && <div className="ts-stream-panel-error">{streamError}</div>}
        </div>
      )}
      </div>
      )}
      {clientContextMenu && (
        <div
          ref={clientContextMenuRef}
          className="ts-context-menu"
          onKeyDown={handleMenuKeyDown}
          style={{ top: clientContextMenu.y, left: clientContextMenu.x }}
        >
          <div className="ts-context-menu-title">{clientContextMenu.clientName}</div>
          <button
            className="ts-menu-item"
            disabled={clientContextMenu.isSelf}
            onClick={() => {
              handleOpenPrivateChat(clientContextMenu.clientId, clientContextMenu.clientName);
              setClientContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">💬</span>
            <span className="ts-menu-item-label">{t("clientContext.privateChat")}</span>
          </button>
          <button
            className="ts-menu-item"
            disabled={clientContextMenu.isSelf}
            onClick={() => {
              handlePokeClient(clientContextMenu.clientId, clientContextMenu.clientName);
              setClientContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">👉</span>
            <span className="ts-menu-item-label">{t("clientContext.poke")}</span>
          </button>
          {!clientContextMenu.isSelf &&
            gatewayFeatures.has("clientVolume") &&
            (() => {
              const uid = clients.find((c) => c.id === clientContextMenu.clientId)?.uid;
              if (!uid) return null;
              const percent = Math.round((clientVolumes[uid] ?? 1) * 100);
              return (
                <label className="ts-menu-item ts-menu-volume" title={t("clientContext.volumeHint")}>
                  <span className="ts-menu-item-icon">{percent === 0 ? "🔇" : "🔉"}</span>
                  <input
                    type="range"
                    min={0}
                    max={200}
                    step={5}
                    value={percent}
                    aria-label={t("clientContext.volume")}
                    onChange={(e) => {
                      const volume = Number(e.target.value) / 100;
                      setClientVolumes((prev) => {
                        const next = { ...prev };
                        if (volume === 1) delete next[uid];
                        else next[uid] = volume;
                        return next;
                      });
                    }}
                    onDoubleClick={() =>
                      setClientVolumes((prev) => {
                        const { [uid]: _, ...rest } = prev;
                        return rest;
                      })
                    }
                  />
                  <span className="ts-menu-volume-value">{percent}%</span>
                </label>
              );
            })()}
          {!clientContextMenu.isSelf && streamInfos[clientContextMenu.clientId] && (
            <button
              className="ts-menu-item"
              onClick={() => {
                handleWatchStream(clientContextMenu.clientId);
                setClientContextMenu(null);
              }}
            >
              <span className="ts-menu-item-icon">📺</span>
              <span className="ts-menu-item-label">{t("clientContext.watchStream")}</span>
            </button>
          )}
          {!clientContextMenu.isSelf && (
            <button
              className="ts-menu-item"
              onClick={() => {
                handleShowMoveClient(clientContextMenu.clientId, clientContextMenu.clientName);
                setClientContextMenu(null);
              }}
            >
              <span className="ts-menu-item-icon">🚚</span>
              <span className="ts-menu-item-label">{t("clientContext.moveTo")}</span>
            </button>
          )}
          <button
            className="ts-menu-item"
            onClick={() => {
              void navigator.clipboard?.writeText(clientContextMenu.clientName);
              setClientContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">📋</span>
            <span className="ts-menu-item-label">{t("clientContext.copyName")}</span>
          </button>
          <button
            className="ts-menu-item"
            onClick={() => {
              handleShowClientConnectionInfo(clientContextMenu.clientId, clientContextMenu.clientName);
              setClientContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">🔌</span>
            <span className="ts-menu-item-label">{t("clientContext.connectionInfo")}</span>
          </button>
          {!clientContextMenu.isSelf && (
            <button
              className="ts-menu-item"
              onClick={() => {
                toggleWhisperClient(clientContextMenu.clientId);
                setClientContextMenu(null);
              }}
            >
              <span className="ts-menu-item-icon">🤫</span>
              <span className="ts-menu-item-label">
                {whisperClientIds.has(clientContextMenu.clientId)
                  ? t("clientContext.removeWhisperTarget")
                  : t("clientContext.addWhisperTarget")}
              </span>
            </button>
          )}
          <div className="ts-menu-separator" />
          <button
            className="ts-menu-item"
            onClick={() => {
              handleShowChannelGroupAssign(clientContextMenu.clientId, clientContextMenu.clientName);
              setClientContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">🏷️</span>
            <span className="ts-menu-item-label">{t("clientContext.assignChannelGroup")}</span>
          </button>
          <button
            className="ts-menu-item"
            onClick={() => {
              handleShowServerGroupAssign(clientContextMenu.clientId, clientContextMenu.clientName);
              setClientContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">🎖️</span>
            <span className="ts-menu-item-label">{t("clientContext.assignServerGroup")}</span>
          </button>
          {!clientContextMenu.isSelf && (
            <>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                onClick={() => {
                  setKickTarget({
                    id: clientContextMenu.clientId,
                    name: clientContextMenu.clientName,
                    scope: "channel",
                  });
                  setKickReason("");
                  setClientContextMenu(null);
                }}
              >
                <span className="ts-menu-item-icon">🚪</span>
                <span className="ts-menu-item-label">{t("clientContext.kickChannel")}</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  setKickTarget({
                    id: clientContextMenu.clientId,
                    name: clientContextMenu.clientName,
                    scope: "server",
                  });
                  setKickReason("");
                  setClientContextMenu(null);
                }}
              >
                <span className="ts-menu-item-icon">👢</span>
                <span className="ts-menu-item-label">{t("clientContext.kick")}</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  setBanTarget({ id: clientContextMenu.clientId, name: clientContextMenu.clientName });
                  setBanReason("");
                  setBanSeconds("0");
                  setClientContextMenu(null);
                }}
              >
                <span className="ts-menu-item-icon">🚫</span>
                <span className="ts-menu-item-label">{t("clientContext.ban")}</span>
              </button>
            </>
          )}
        </div>
      )}

      {serverContextMenu && (
        <div
          ref={serverContextMenuRef}
          className="ts-context-menu"
          onKeyDown={handleMenuKeyDown}
          style={{ top: serverContextMenu.y, left: serverContextMenu.x }}
        >
          <div className="ts-context-menu-title">{serverName || host}</div>
          <button
            className="ts-menu-item"
            onClick={() => {
              handleShowServerConnectionInfo();
              setServerContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">🔌</span>
            <span className="ts-menu-item-label">{t("serverContext.connectionInfo")}</span>
          </button>
          <button
            className="ts-menu-item"
            onClick={() => {
              setServerEditOpen(true);
              setServerContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">✏️</span>
            <span className="ts-menu-item-label">{t("serverEdit.title")}</span>
          </button>
          <button
            className="ts-menu-item"
            onClick={() => {
              void navigator.clipboard?.writeText(host);
              setServerContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">📋</span>
            <span className="ts-menu-item-label">{t("serverContext.copyAddress")}</span>
          </button>
          <button
            className="ts-menu-item"
            onClick={() => {
              openAddFavorite();
              setServerContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">⭐</span>
            <span className="ts-menu-item-label">{t("serverContext.addFavorite")}</span>
          </button>
          <div className="ts-menu-separator" />
          <button
            className="ts-menu-item"
            onClick={() => {
              handleShowServerIcons();
              setServerContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">🖼️</span>
            <span className="ts-menu-item-label">{t("serverContext.icons")}</span>
          </button>
          <button
            className="ts-menu-item"
            onClick={() => {
              handleShowServerProtocolLog();
              setServerContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">📜</span>
            <span className="ts-menu-item-label">{t("menu.extras.serverLog")}</span>
          </button>
          <button
            className="ts-menu-item"
            onClick={() => {
              handleShowBanList();
              setServerContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">🚫</span>
            <span className="ts-menu-item-label">{t("menu.extras.banList")}</span>
          </button>
          <button
            className="ts-menu-item"
            onClick={() => {
              handleShowComplainList();
              setServerContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">⚠️</span>
            <span className="ts-menu-item-label">{t("menu.extras.complaintList")}</span>
          </button>
          <div className="ts-menu-separator" />
          <button
            className="ts-menu-item"
            onClick={() => {
              handleDisconnect();
              setServerContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">❌</span>
            <span className="ts-menu-item-label">{t("serverContext.disconnect")}</span>
          </button>
        </div>
      )}

      {channelContextMenu && (
        <div
          ref={channelContextMenuRef}
          className="ts-context-menu"
          onKeyDown={handleMenuKeyDown}
          style={{ top: channelContextMenu.y, left: channelContextMenu.x }}
        >
          <div className="ts-context-menu-title">{channelContextMenu.channelName}</div>
          {ownClient?.channel !== channelContextMenu.channelId && (
            <button
              className="ts-menu-item"
              onMouseDown={(e) => {
                // mousedown + stopPropagation beats the document dismiss listener
                // (which also listens on mousedown) so Join actually fires.
                e.preventDefault();
                e.stopPropagation();
                handleSwitchChannel(channelContextMenu.channelId);
                handleSelectItem({ type: "channel", id: channelContextMenu.channelId });
                setChannelContextMenu(null);
              }}
            >
              <span className="ts-menu-item-icon">➡️</span>
              <span className="ts-menu-item-label">{t("channelContext.join")}</span>
            </button>
          )}
          <button
            className="ts-menu-item"
            onClick={() => {
              handleShowFileBrowser(channelContextMenu.channelId, channelContextMenu.channelName);
              setChannelContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">📁</span>
            <span className="ts-menu-item-label">{t("channelContext.files")}</span>
          </button>
        </div>
      )}

      <main className="ts-body">
        <div className="ts-upper" style={{ height: upperHeight }}>
          <div className="ts-tree-panel" style={{ width: treeWidth }} onKeyDown={handleTreeKeyDown}>
            {connected ? (
              <>
                <div
                  className={`ts-row ts-server-row${selected?.type === "server" ? " ts-row-selected" : ""}`}
                  onClick={() => handleSelectItem({ type: "server" })}
                  onContextMenu={handleServerContextMenu}
                  tabIndex={0}
                  onFocus={(e) => {
                    if (e.target === e.currentTarget && selected?.type !== "server") handleSelectItem({ type: "server" });
                  }}
                >
                  <ServerIcon />
                  <span>{serverName || host}</span>
                </div>
                <input
                  type="search"
                  className="ts-tree-search"
                  value={treeFilter}
                  placeholder={t("tree.search")}
                  aria-label={t("tree.search")}
                  onChange={(e) => setTreeFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setTreeFilter("");
                  }}
                />
                {treeSearch && treeSearch.channels.length === 0 && (
                  <div className="ts-tree-empty">{t("tree.noMatches")}</div>
                )}
                <ChannelTree
                  channels={treeSearch?.channels ?? channels}
                  clients={treeSearch?.clients ?? treeClients}
                  expandAll={!!treeSearch}
                  parent={0}
                  ownClientId={ownClientId ?? ownClient?.id ?? null}
                  talkers={displayTalkers}
                  serverGroups={serverGroups}
                  groupIconImages={serverIconImages}
                  selected={selected}
                  sessionKey={activeSessionId ?? ""}
                  onSelectItem={handleSelectItem}
                  onSwitchChannel={handleSwitchChannel}
                  onOpenPrivateChat={handleOpenPrivateChat}
                  onMoveClient={handleMoveClient}
                  onClientContextMenu={handleClientContextMenu}
                  onChannelContextMenu={handleChannelContextMenu}
                />
              </>
            ) : (
              <div className="ts-tree-empty">{t("tree.notConnected")}</div>
            )}
          </div>

          <div className="ts-resize-handle-vertical" onMouseDown={startTreeResize} />

          <div className="ts-side-panel">
            {connected && serverBannerUrl && showServerBanner && (
              <div className="ts-banner-panel">
                <img className="ts-server-banner" src={serverBannerUrl} alt="" referrerPolicy="no-referrer" />
              </div>
            )}
            {connected && (
              <InfoPanel
                selected={selected}
                host={host}
                serverName={serverName}
                serverMaxClients={serverMaxClients}
                serverVersion={serverVersion}
                serverLicense={serverLicense}
                serverLicenseId={serverLicenseId}
                totalClientCount={displayClientCount}
                totalChannelCount={
                  serverChannelsOnline > 0 ? serverChannelsOnline : channels.length
                }
                channels={channels}
                clients={treeClients}
                serverGroups={serverGroups}
                images={serverIconImages}
                onShowServerConnectionInfo={handleShowServerConnectionInfo}
                onEditServer={() => setServerEditOpen(true)}
              />
            )}
          </div>
        </div>

        <div className="ts-resize-handle-horizontal" onMouseDown={startUpperResize} />

        <div className="ts-chat-panel">
          {connected && designTheme === "ide" && (
            <div className="ts-ide-breadcrumb">
              {serverName || host}
              {" / "}
              <span>{channels.find((c) => c.id === ownClient?.channel)?.name ?? ""}</span>
            </div>
          )}
          {connected && (designTheme === "pulse" || designTheme === "ide") && (
            <SpeakingNowBar
              clients={treeClients}
              talkers={displayTalkers}
              ownClientId={ownClient?.id ?? null}
              images={serverIconImages}
              serverGroups={designTheme === "ide" ? serverGroups : undefined}
              selectedClientId={selected?.type === "client" ? selected.id : null}
              onSelect={(id) => handleSelectItem({ type: "client", id })}
              onOpenPrivateChat={handleOpenPrivateChat}
              onContextMenu={handleClientContextMenu}
            />
          )}
          <div
            className="ts-chat-messages"
            style={{
              fontFamily: chatSettings.fontFamily || undefined,
              fontSize: chatSettings.fontSize ? `${chatSettings.fontSize}px` : undefined,
            }}
          >
            {activeTab === "channel"
              ? chat.map((entry, i) => entry.isLog ? (
                  <div key={i} className="ts-chat-line ts-chat-line-log">
                    <span>{entry.message}</span>
                  </div>
                ) : (
                  <div
                    key={i}
                    className={`ts-chat-line${entry.from === ownClient?.name ? " ts-chat-line-self" : ""}${
                      entry.fromLog ? " ts-chat-line-logged" : ""
                    }`}
                  >
                    <span className="ts-chat-from">{entry.from}:</span>{" "}
                    <span className="ts-chat-bubble">{renderBbcode(entry.message, { images: chatImages, stillImages: !treeOptions.animateImages })}</span>
                  </div>
                ))
              : activeTab === "server"
                ? serverChat.map((entry, i) =>
                    entry.isLog ? (
                      <div key={i} className="ts-chat-line ts-chat-line-log">
                        <span>{entry.message}</span>
                      </div>
                    ) : (
                      <div
                        key={i}
                        className={`ts-chat-line${entry.from === ownClient?.name ? " ts-chat-line-self" : ""}`}
                      >
                        <span className="ts-chat-from">{entry.from}:</span>{" "}
                        <span className="ts-chat-bubble">{renderBbcode(entry.message, { images: chatImages, stillImages: !treeOptions.animateImages })}</span>
                      </div>
                    )
                  )
                : pmThreads[activeTab]?.messages.map((entry, i) => entry.isLog ? (
                    <div key={i} className="ts-chat-line ts-chat-line-log">
                      <span>{entry.message}</span>
                    </div>
                  ) : (
                    <div
                      key={i}
                      className={`ts-chat-line${entry.fromSelf ? " ts-chat-line-self" : ""}${
                        entry.fromLog ? " ts-chat-line-logged" : ""
                      }`}
                    >
                      <span className="ts-chat-from">
                        {entry.fromSelf ? t("chat.you") : pmThreads[activeTab].partnerName}:
                      </span>{" "}
                      <span className="ts-chat-bubble">{renderBbcode(entry.message, { images: chatImages, stillImages: !treeOptions.animateImages })}</span>
                    </div>
                  ))}
            <div ref={chatEndRef} />
          </div>
          <div className="ts-chat-tabs">
            <button
              className={`ts-chat-tab${activeTab === "server" ? " ts-chat-tab-active" : ""}${
                chatUnread.server ? " ts-chat-tab-unread" : ""
              }`}
              onClick={() => setActiveTab("server")}
            >
              {t("chat.server")}
            </button>
            <button
              className={`ts-chat-tab${activeTab === "channel" ? " ts-chat-tab-active" : ""}${
                chatUnread.channel ? " ts-chat-tab-unread" : ""
              }`}
              onClick={() => setActiveTab("channel")}
            >
              {t("chat.channel")}
            </button>
            {Object.values(pmThreads).map((thread) => (
              <button
                key={thread.partnerId}
                className={`ts-chat-tab${activeTab === thread.partnerId ? " ts-chat-tab-active" : ""}${
                  thread.unread ? " ts-chat-tab-unread" : ""
                }`}
                onClick={() => setActiveTab(thread.partnerId)}
                aria-keyshortcuts="Delete"
                onKeyDown={(e) => {
                  // The × can't be its own button inside this one; Delete closes from the keyboard.
                  if (e.key === "Delete") handleClosePrivateChat(thread.partnerId);
                }}
              >
                {thread.partnerName}
                <span
                  aria-hidden="true"
                  className="ts-chat-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClosePrivateChat(thread.partnerId);
                  }}
                >
                  ×
                </span>
              </button>
            ))}
          </div>
          <div className="ts-chat-input-row">
            <textarea
              ref={chatInputRef}
              rows={1}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSendChat();
                }
              }}
              disabled={!connected}
              placeholder={
                !connected
                  ? t("chat.notConnected")
                  : activeTab === "channel"
                    ? t("chat.messageChannel")
                    : activeTab === "server"
                      ? t("chat.messageServer")
                      : t("chat.messagePartner", { name: pmThreads[activeTab]?.partnerName ?? "" })
              }
            />
            <button onClick={handleSendChat} disabled={!connected}>
              {t("chat.send")}
            </button>
          </div>
        </div>
      </main>

      <div className="ts-log">
        {log.slice(-50).map((entry, i) => {
          let text = entry.text;
          if (/os[- ]?error\s*10049/i.test(text) || /angeforderte Adresse ist in diesem Kontext ungültig/i.test(text)) {
            text = t("log.fileTransferInvalidAddress");
          } else {
            text = text.replace(/^(file transfer failed:\s*)+/i, `${t("log.fileTransferFailed")} `);
          }
          return (
            <div key={i} className={entry.kind === "error" ? "ts-log-error" : "ts-log-info"}>
              {text}
            </div>
          );
        })}
      </div>
      <NewsTicker />
      {iconPackStyle && <style>{iconPackStyle}</style>}
    </div>
    </DisplayPrefsContext.Provider>
  );
}

function App() {
  return (
    <LanguageProvider>
      <AppInner />
    </LanguageProvider>
  );
}

export default App;

import cors from "cors";
import express from "express";

const HOST = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
const PORT = clampInteger(process.env.PORT, 3000, 1, 65535);
const REQUEST_TIMEOUT_MS = clampInteger(process.env.REQUEST_TIMEOUT_MS, 10000, 2000, 30000);
const FALLOUT_SHELTER_STATUS_CACHE_TTL_MS = clampInteger(process.env.FALLOUT_SHELTER_STATUS_CACHE_TTL_MS, 60000, 1000, 300000);

const FALLOUT_SHELTER_STEAM_APP_ID = 588430;
const FALLOUT_SHELTER_STEAM_URL = "https://store.steampowered.com/app/588430/Fallout_Shelter/";
const FALLOUT_SHELTER_BETHESDA_URL = "https://fallout.bethesda.net/en/games/fallout-shelter";
const FALLOUT_SHELTER_GOOGLE_PLAY_URL = "https://play.google.com/store/apps/details?id=com.bethsoft.falloutshelter";
const FALLOUT_SHELTER_APP_STORE_URL = "https://apps.apple.com/us/app/fallout-shelter/id991153141";
const FALLOUT_SHELTER_GUIDES_URL = "https://steamcommunity.com/app/588430/guides/";
const FALLOUT_SHELTER_NEWS_URL = "https://store.steampowered.com/news/app/588430";
const FALLOUT_SHELTER_WIKI_URL = "https://en.wikipedia.org/wiki/Fallout_Shelter";

const app = express();
const responseCache = new Map();

app.disable("x-powered-by");
app.use(cors());
app.use(express.json());

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function normalizeOptionalInteger(value, min, max) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.min(max, Math.max(min, parsed));
}

function sanitizeDisplayText(value, maxLength = 240) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function getCachedPayload(key, ttlMs) {
  const cached = responseCache.get(key);

  if (!cached) {
    return null;
  }

  if (Date.now() - cached.createdAt > ttlMs) {
    responseCache.delete(key);
    return null;
  }

  return cached.payload;
}

function setCachedPayload(key, payload) {
  responseCache.set(key, {
    payload,
    createdAt: Date.now()
  });
}

async function fetchJson(url, sourceLabel) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "falloutfanatics-falloutshelter-api/1.0",
        Accept: "application/json"
      },
      redirect: "follow",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`${sourceLabel} returned HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${sourceLabel} request timed out`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchPageStatus(url, sourceLabel, method = "HEAD") {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "User-Agent": "falloutfanatics-falloutshelter-api/1.0",
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
      },
      redirect: "follow",
      signal: controller.signal
    });

    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${sourceLabel} request timed out`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchSteamCurrentPlayers(appId = FALLOUT_SHELTER_STEAM_APP_ID) {
  const payload = await fetchJson(
    `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appId}`,
    "Steam current players API"
  );

  return normalizeOptionalInteger(payload?.response?.player_count, 0, 50000000);
}

function getStateFromStatus(ok, hasValue = true) {
  if (ok === true && hasValue) {
    return "online";
  }

  if (ok === false) {
    return "offline";
  }

  return "unknown";
}

function toHttpValueLabel(statusCode) {
  return statusCode ? `HTTP ${statusCode}` : "—";
}

async function getFalloutShelterStatusPayload() {
  const cacheKey = "falloutshelter:status";
  const cached = getCachedPayload(cacheKey, FALLOUT_SHELTER_STATUS_CACHE_TTL_MS);

  if (cached?.items && Array.isArray(cached.items)) {
    return {
      ...cached,
      cached: true
    };
  }

  const [
    steamPlayersResult,
    bethesdaPageResult,
    googlePlayPageResult,
    appStorePageResult,
    guidesPageResult,
    newsPageResult,
    wikiPageResult
  ] = await Promise.allSettled([
    fetchSteamCurrentPlayers(),
    fetchPageStatus(FALLOUT_SHELTER_BETHESDA_URL, "Fallout Shelter Bethesda page", "GET"),
    fetchPageStatus(FALLOUT_SHELTER_GOOGLE_PLAY_URL, "Fallout Shelter Google Play page"),
    fetchPageStatus(FALLOUT_SHELTER_APP_STORE_URL, "Fallout Shelter App Store page", "GET"),
    fetchPageStatus(FALLOUT_SHELTER_GUIDES_URL, "Fallout Shelter guides page", "GET"),
    fetchPageStatus(FALLOUT_SHELTER_NEWS_URL, "Fallout Shelter news page"),
    fetchPageStatus(FALLOUT_SHELTER_WIKI_URL, "Fallout Shelter wiki page", "GET")
  ]);

  const steamPlayers = steamPlayersResult.status === "fulfilled" ? steamPlayersResult.value : null;
  const steamPlayersError = steamPlayersResult.status === "rejected"
    ? sanitizeDisplayText(steamPlayersResult.reason?.message || "Steam players request failed.", 180)
    : "";

  const bethesdaPage = bethesdaPageResult.status === "fulfilled" ? bethesdaPageResult.value : null;
  const bethesdaPageError = bethesdaPageResult.status === "rejected"
    ? sanitizeDisplayText(bethesdaPageResult.reason?.message || "Bethesda page request failed.", 180)
    : "";

  const googlePlayPage = googlePlayPageResult.status === "fulfilled" ? googlePlayPageResult.value : null;
  const googlePlayPageError = googlePlayPageResult.status === "rejected"
    ? sanitizeDisplayText(googlePlayPageResult.reason?.message || "Google Play request failed.", 180)
    : "";

  const appStorePage = appStorePageResult.status === "fulfilled" ? appStorePageResult.value : null;
  const appStorePageError = appStorePageResult.status === "rejected"
    ? sanitizeDisplayText(appStorePageResult.reason?.message || "App Store request failed.", 180)
    : "";

  const guidesPage = guidesPageResult.status === "fulfilled" ? guidesPageResult.value : null;
  const guidesPageError = guidesPageResult.status === "rejected"
    ? sanitizeDisplayText(guidesPageResult.reason?.message || "Guides request failed.", 180)
    : "";

  const newsPage = newsPageResult.status === "fulfilled" ? newsPageResult.value : null;
  const newsPageError = newsPageResult.status === "rejected"
    ? sanitizeDisplayText(newsPageResult.reason?.message || "News request failed.", 180)
    : "";

  const wikiPage = wikiPageResult.status === "fulfilled" ? wikiPageResult.value : null;
  const wikiPageError = wikiPageResult.status === "rejected"
    ? sanitizeDisplayText(wikiPageResult.reason?.message || "Wiki request failed.", 180)
    : "";

  const items = [
    {
      key: "steam-players",
      kind: "players",
      name: "Steam онлайн",
      sourceLabel: "Steam",
      status: getStateFromStatus(steamPlayers !== null, steamPlayers !== null),
      value: steamPlayers,
      valueLabel: steamPlayers !== null ? String(steamPlayers) : "—",
      httpStatus: null,
      url: FALLOUT_SHELTER_STEAM_URL,
      title: "Fallout Shelter on Steam",
      description: "Текущий онлайн Fallout Shelter в Steam. Это число игроков в PC Steam, а не общий онлайн на мобильных платформах.",
      note: steamPlayersError ? "Страница Steam временно не ответила." : "Онлайн взят из официальных данных Steam."
    },
    {
      key: "bethesda-page",
      kind: "official",
      name: "Официальная страница",
      sourceLabel: "Bethesda",
      status: getStateFromStatus(Boolean(bethesdaPage?.ok)),
      value: bethesdaPage?.status ?? null,
      valueLabel: toHttpValueLabel(bethesdaPage?.status ?? null),
      httpStatus: bethesdaPage?.status ?? null,
      url: bethesdaPage?.url || FALLOUT_SHELTER_BETHESDA_URL,
      title: "Fallout Shelter | Bethesda.net",
      description: "Официальная страница Fallout Shelter на сайте Bethesda.",
      note: bethesdaPageError ? "Страница Bethesda временно не ответила." : (bethesdaPage?.ok ? "Официальная страница доступна." : "Официальная страница не подтвердила корректный ответ.")
    },
    {
      key: "google-play",
      kind: "store",
      name: "Google Play",
      sourceLabel: "Google Play",
      status: getStateFromStatus(Boolean(googlePlayPage?.ok)),
      value: googlePlayPage?.status ?? null,
      valueLabel: toHttpValueLabel(googlePlayPage?.status ?? null),
      httpStatus: googlePlayPage?.status ?? null,
      url: googlePlayPage?.url || FALLOUT_SHELTER_GOOGLE_PLAY_URL,
      title: "Fallout Shelter - Apps on Google Play",
      description: "Мобильная страница Fallout Shelter в Google Play для Android.",
      note: googlePlayPageError ? "Google Play временно не ответил." : (googlePlayPage?.ok ? "Страница Google Play доступна." : "Страница Google Play не подтвердила корректный ответ.")
    },
    {
      key: "app-store",
      kind: "store",
      name: "App Store",
      sourceLabel: "App Store",
      status: appStorePage?.status === 429 ? "online" : getStateFromStatus(Boolean(appStorePage?.ok)),
      value: appStorePage?.status ?? null,
      valueLabel: toHttpValueLabel(appStorePage?.status ?? null),
      httpStatus: appStorePage?.status ?? null,
      url: appStorePage?.url || FALLOUT_SHELTER_APP_STORE_URL,
      title: "Fallout Shelter App - App Store",
      description: "Страница Fallout Shelter в Apple App Store для iPhone и iPad.",
      note: appStorePageError ? "App Store временно не ответил." : (appStorePage?.status === 429 ? "App Store ограничил частую проверку, но сама страница обычно открывается нормально." : (appStorePage?.ok ? "Страница App Store доступна." : "Страница App Store не подтвердила корректный ответ."))
    },
    {
      key: "guides-page",
      kind: "guide",
      name: "Гайды сообщества",
      sourceLabel: "Steam Guides",
      status: getStateFromStatus(Boolean(guidesPage?.ok)),
      value: guidesPage?.status ?? null,
      valueLabel: toHttpValueLabel(guidesPage?.status ?? null),
      httpStatus: guidesPage?.status ?? null,
      url: guidesPage?.url || FALLOUT_SHELTER_GUIDES_URL,
      title: "Steam Community :: Fallout Shelter",
      description: "Подборка пользовательских гайдов и советов по Fallout Shelter в Steam Community.",
      note: guidesPageError ? "Раздел гайдов временно не ответил." : (guidesPage?.ok ? "Раздел гайдов доступен." : "Раздел гайдов не подтвердил корректный ответ.")
    },
    {
      key: "news-page",
      kind: "news",
      name: "Новости игры",
      sourceLabel: "Steam News",
      status: getStateFromStatus(Boolean(newsPage?.ok)),
      value: newsPage?.status ?? null,
      valueLabel: toHttpValueLabel(newsPage?.status ?? null),
      httpStatus: newsPage?.status ?? null,
      url: newsPage?.url || FALLOUT_SHELTER_NEWS_URL,
      title: "Fallout Shelter - Steam News Hub",
      description: "Лента новостей и обновлений Fallout Shelter в Steam.",
      note: newsPageError ? "Раздел новостей временно не ответил." : (newsPage?.ok ? "Раздел новостей доступен." : "Раздел новостей не подтвердил корректный ответ.")
    },
    {
      key: "wiki-page",
      kind: "wiki",
      name: "Wiki",
      sourceLabel: "Wikipedia",
      status: getStateFromStatus(Boolean(wikiPage?.ok)),
      value: wikiPage?.status ?? null,
      valueLabel: toHttpValueLabel(wikiPage?.status ?? null),
      httpStatus: wikiPage?.status ?? null,
      url: wikiPage?.url || FALLOUT_SHELTER_WIKI_URL,
      title: "Fallout Shelter - Wikipedia",
      description: "Энциклопедическая страница Fallout Shelter с общей информацией об игре.",
      note: wikiPageError ? "Страница wiki временно не ответила." : (wikiPage?.ok ? "Страница wiki доступна." : "Страница wiki не подтвердила корректный ответ.")
    }
  ];

  const availableCount = items.filter((item) => item.status === "online").length;
  const offlineCount = items.filter((item) => item.status === "offline").length;
  const unknownCount = items.length - availableCount - offlineCount;
  const overallStatus = offlineCount > 0 ? "degraded" : availableCount > 0 ? "online" : "unknown";

  const payload = {
    service: "falloutfanatics-falloutshelter-api",
    source: "public-pages-and-steam",
    fetchedAt: new Date().toISOString(),
    cached: false,
    summary: {
      signalCount: items.length,
      availableCount,
      offlineCount,
      unknownCount,
      steamPlayers,
      overallStatus
    },
    disclaimer: "Fallout Shelter is primarily a single-player game. This page tracks real Steam player count and the availability of key public pages for the game.",
    items
  };

  setCachedPayload(cacheKey, payload);
  return payload;
}

app.get("/", (_req, res) => {
  res.type("text/plain").send("FalloutFanatics Fallout Shelter API is running.");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "falloutfanatics-falloutshelter-api",
    fetchedAt: new Date().toISOString()
  });
});

app.get("/api/fallout-shelter-status", async (_req, res) => {
  try {
    const payload = await getFalloutShelterStatusPayload();
    res.json(payload);
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: "FALLOUT_SHELTER_STATUS_FETCH_FAILED",
      message: error?.message || "Unable to build Fallout Shelter status payload.",
      fetchedAt: new Date().toISOString()
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: "NOT_FOUND"
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Fallout Shelter API listening on http://${HOST}:${PORT}`);
});

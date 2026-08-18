import { uniq } from "es-toolkit";
import { isEmpty } from "es-toolkit/compat";
import {
  getDefinedSiteMetadata,
  getFaviconMetadata,
  getLocalFavicon,
  getRemoteFavicon,
  FAVICON_CACHE_TTL_MS,
  getSite as createSiteInstance,
  NO_IMAGE,
  applySiteUserConfigDefaults,
  type IFaviconCacheEntry,
  type ISiteUserConfig,
  type TSiteID,
} from "@ptd/site";

import { onMessage, sendMessage } from "@/messages.ts";
import type { IMetadataPiniaStorageSchema } from "@/shared/types.ts";
import { ensureSiteMapMetadata } from "@/shared/utils/siteMap.ts";

import { logger } from "./logger.ts";
import { ptdIndexDb } from "../adapter/indexdb.ts";

export async function getSiteUserConfig(siteId: TSiteID, flush = false) {
  const metadataStore = (await sendMessage("getExtStorage", "metadata")) as IMetadataPiniaStorageSchema;
  const storedSiteUserConfig = metadataStore?.sites?.[siteId] ?? {};

  const siteMetaData = await getDefinedSiteMetadata(siteId);

  if (flush || isEmpty(storedSiteUserConfig)) {
    applySiteUserConfigDefaults(siteMetaData, storedSiteUserConfig);
  }

  logger({ msg: `getSiteUserConfig for ${siteId}`, data: storedSiteUserConfig });
  return storedSiteUserConfig;
}

onMessage("getSiteUserConfig", async ({ data: { siteId, flush } }) => await getSiteUserConfig(siteId, flush));

onMessage("ensureSiteMapCache", async ({ data }) => await ensureSiteMapMetadata(data));

export async function getSiteInstance<TYPE extends "private" | "public">(
  siteId: TSiteID,
  options: { mergeUserConfig?: boolean } = {},
) {
  const { mergeUserConfig = true } = options;
  let storedSiteUserConfig: ISiteUserConfig = {};
  if (mergeUserConfig) {
    storedSiteUserConfig = await getSiteUserConfig(siteId);
  }

  logger({ msg: `getSiteInstance for ${siteId}`, data: storedSiteUserConfig });
  return await createSiteInstance<TYPE>(siteId, storedSiteUserConfig);
}

export async function getSiteFavicon(site: TSiteID | getFaviconMetadata, flush: boolean = false): Promise<string> {
  const siteId = typeof site === "string" ? site : site.id;
  const cachedValue = await (await ptdIndexDb).get("favicon", siteId);
  const cached: IFaviconCacheEntry | undefined =
    typeof cachedValue === "string" ? { value: cachedValue, fetchedAt: 0 } : cachedValue;
  const cacheIsFresh = !!cached && !flush && Date.now() - cached.fetchedAt < FAVICON_CACHE_TTL_MS;

  if (cacheIsFresh && cached.value !== NO_IMAGE) {
    return cached.value;
  }

  const siteInstance = await getSiteInstance(siteId);
  const faviconMetadata = {
    id: siteId,
    urls: uniq([siteInstance.url, ...siteInstance.metadata.urls].filter(Boolean)),
    favicon: siteInstance.metadata.favicon,
  } satisfies getFaviconMetadata;

  if (cacheIsFresh && cached.value === NO_IMAGE) {
    return getLocalFavicon(faviconMetadata) ?? NO_IMAGE;
  }

  const remoteFavicon = await getRemoteFavicon(faviconMetadata, cached);
  if (remoteFavicon) {
    const refreshedCache: IFaviconCacheEntry = {
      value: remoteFavicon.value,
      fetchedAt: Date.now(),
      sourceUrl: remoteFavicon.sourceUrl,
      etag: remoteFavicon.etag,
      lastModified: remoteFavicon.lastModified,
    };
    await (await ptdIndexDb).put("favicon", refreshedCache, siteId);
    return remoteFavicon.value;
  }

  const localFavicon = getLocalFavicon(faviconMetadata);
  if (localFavicon) {
    if (!cached || cached.value === NO_IMAGE) {
      await (await ptdIndexDb).put("favicon", { value: NO_IMAGE, fetchedAt: Date.now() }, siteId);
    }
    return localFavicon;
  }

  if (cached?.value && cached.value !== NO_IMAGE) {
    logger({ msg: `getSiteFavicon for ${siteId} failed, use stale favicon.`, level: "warn" });
    return cached.value;
  }

  await (await ptdIndexDb).put("favicon", { value: NO_IMAGE, fetchedAt: Date.now() }, siteId);
  logger({ msg: `getSiteFavicon for ${siteId} failed, use default NO_IMAGE.`, level: "warn" });
  return NO_IMAGE;
}

onMessage("getSiteFavicon", async ({ data: { site, flush } }) => (await getSiteFavicon(site, flush))!);

export async function clearSiteFaviconCache() {
  logger({ msg: `clearSiteFaviconCache` });
  return await (await ptdIndexDb).clear("favicon");
}

onMessage("clearSiteFaviconCache", async () => await clearSiteFaviconCache());

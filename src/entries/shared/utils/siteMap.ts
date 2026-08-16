import {
  getDefinedSiteMetadata,
  getHostFromUrl,
  type ISiteMetadata,
  type ISiteUserConfig,
  type TSiteID,
} from "@ptd/site";

import type { IMetadataPiniaStorageSchema } from "@/shared/types/storages/metadata.ts";

const SITE_MAP_SCHEMA_VERSION = 1;

type TSiteMapSites = IMetadataPiniaStorageSchema["sites"];

export interface ISiteMaps {
  siteHostMap: Record<string, TSiteID>;
  siteNameMap: Record<TSiteID, string>;
}

export interface IEnsuredSiteMapMetadata {
  metadata: IMetadataPiniaStorageSchema;
  changed: boolean;
}

function getMergedValue<T extends keyof ISiteMetadata>(
  siteConfig: ISiteUserConfig,
  siteMetadata: ISiteMetadata | undefined,
  field: T,
  fallback: ISiteMetadata[T],
): ISiteMetadata[T] {
  const mergedValue = siteConfig.merge?.[field];
  if (mergedValue) {
    return mergedValue as ISiteMetadata[T];
  }
  return siteMetadata?.[field] ?? fallback;
}

function getSiteMapSourceVersion(sites: TSiteMapSites): string {
  const source = Object.entries(sites).map(([siteId, siteConfig]) => [
    siteId,
    siteConfig.url,
    siteConfig.merge?.name,
    siteConfig.merge?.urls,
    siteConfig.merge?.legacyUrls,
  ]);

  return `${SITE_MAP_SCHEMA_VERSION}:${__EXT_VERSION__}:${JSON.stringify(source)}`;
}

function hasSiteMapShape(metadata: Pick<IMetadataPiniaStorageSchema, "sites" | "siteHostMap" | "siteNameMap">) {
  if (!metadata.siteHostMap || !metadata.siteNameMap) {
    return false;
  }

  return Object.keys(metadata.sites).every((siteId) => Object.hasOwn(metadata.siteNameMap, siteId));
}

export async function buildSiteMaps(sites: TSiteMapSites): Promise<ISiteMaps> {
  const siteHostMap: Record<string, TSiteID> = {};
  const siteNameMap: Record<TSiteID, string> = {};

  for (const [siteId, siteConfig] of Object.entries(sites)) {
    let siteMetadata: ISiteMetadata | undefined;
    try {
      siteMetadata = await getDefinedSiteMetadata(siteId);
    } catch (error) {
      console.warn(`[PTD] Failed to load site metadata while rebuilding site maps: ${siteId}`, error);
    }

    const urls = getMergedValue(siteConfig, siteMetadata, "urls", []) ?? [];
    const legacyUrls = getMergedValue(siteConfig, siteMetadata, "legacyUrls", []) ?? [];
    const allUrls = [siteConfig.url, ...urls, ...legacyUrls].filter((url): url is NonNullable<typeof url> =>
      Boolean(url),
    );

    for (const url of allUrls) {
      const host = getHostFromUrl(url);
      const previousSiteId = siteHostMap[host];
      if (previousSiteId && previousSiteId !== siteId) {
        console.warn(`[PTD] Site host mapping conflict: ${host} (${previousSiteId} -> ${siteId})`);
      }
      siteHostMap[host] = siteId;
    }

    siteNameMap[siteId] = getMergedValue(siteConfig, siteMetadata, "name", siteId);
  }

  return { siteHostMap, siteNameMap };
}

export async function ensureSiteMapMetadata(metadata: IMetadataPiniaStorageSchema): Promise<IEnsuredSiteMapMetadata> {
  const siteMapVersion = getSiteMapSourceVersion(metadata.sites);
  if (metadata.siteMapVersion === siteMapVersion && hasSiteMapShape(metadata)) {
    return { metadata, changed: false };
  }

  const maps = await buildSiteMaps(metadata.sites);
  return {
    metadata: {
      ...metadata,
      ...maps,
      siteMapVersion,
    },
    changed: true,
  };
}

export function getSiteMapVersion(sites: TSiteMapSites): string {
  return getSiteMapSourceVersion(sites);
}

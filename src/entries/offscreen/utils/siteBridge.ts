import { getDefinedSiteMetadata } from "@ptd/site";

import { onMessage, sendMessage, type ISiteBridgeCatalogItem } from "@/messages.ts";
import type { IMetadataPiniaStorageSchema } from "@/shared/types/storages/metadata.ts";
import { getSiteAvailability } from "@/shared/siteAvailability.ts";

function getDisplayUserInfo(siteUserInfo: IMetadataPiniaStorageSchema["lastUserInfo"][string]) {
  if (!siteUserInfo) return undefined;

  return {
    status: siteUserInfo.status,
    updateAt: siteUserInfo.updateAt,
    id: siteUserInfo.id,
    name: siteUserInfo.name,
    levelName: siteUserInfo.levelName,
    joinTime: siteUserInfo.joinTime,
    lastAccessAt: siteUserInfo.lastAccessAt,
    invites: siteUserInfo.invites,
    uploaded: siteUserInfo.uploaded,
    downloaded: siteUserInfo.downloaded,
    trueUploaded: siteUserInfo.trueUploaded,
    trueDownloaded: siteUserInfo.trueDownloaded,
    ratio: siteUserInfo.ratio,
    trueRatio: siteUserInfo.trueRatio,
    uploads: siteUserInfo.uploads,
    leeching: siteUserInfo.leeching,
    snatches: siteUserInfo.snatches,
    seeding: siteUserInfo.seeding,
    seedingSize: siteUserInfo.seedingSize,
    hnrPreWarning: siteUserInfo.hnrPreWarning,
    hnrUnsatisfied: siteUserInfo.hnrUnsatisfied,
    bonus: siteUserInfo.bonus,
    seedingBonus: siteUserInfo.seedingBonus,
    bonusPerHour: siteUserInfo.bonusPerHour,
    seedingBonusPerHour: siteUserInfo.seedingBonusPerHour,
    seedingUrl: siteUserInfo.seedingUrl,
    snatchesUrl: siteUserInfo.snatchesUrl,
    messageCount: siteUserInfo.messageCount,
  } satisfies ISiteBridgeCatalogItem["userInfo"];
}

async function getSiteBridgeCatalogData(): Promise<ISiteBridgeCatalogItem[]> {
  const metadata = (await sendMessage("getExtStorage", "metadata")) as IMetadataPiniaStorageSchema | undefined;
  if (!metadata) return [];

  const catalog = await Promise.all(
    Object.keys(metadata.sites ?? {}).map(async (siteId): Promise<ISiteBridgeCatalogItem | undefined> => {
      try {
        const siteMetadata = await getDefinedSiteMetadata(siteId);
        const siteConfig = metadata.sites[siteId];
        const userInfo = metadata.lastUserInfo?.[siteId];
        const availability = getSiteAvailability(
          siteMetadata,
          siteConfig,
          userInfo ?? {},
          metadata.siteDiscovery?.available?.[siteId],
        );

        return {
          id: siteId,
          name: siteConfig?.merge?.name ?? siteMetadata.name ?? metadata.siteNameMap?.[siteId] ?? siteId,
          availability,
          groups: siteConfig?.groups ?? [],
          isOffline: siteConfig?.isOffline ?? false,
          userInfo: getDisplayUserInfo(userInfo),
        };
      } catch (error) {
        console.warn(`[PTD] Failed to build qB site bridge catalog item: ${siteId}`, error);
        return undefined;
      }
    }),
  );

  return catalog.filter((item): item is ISiteBridgeCatalogItem => item !== undefined);
}

onMessage("getSiteBridgeCatalogData", getSiteBridgeCatalogData);

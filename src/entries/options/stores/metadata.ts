import { nanoid } from "nanoid";
import { defineStore } from "pinia";
import { isEmpty, set } from "es-toolkit/compat";
import {
  definitionList,
  applySiteUserConfigDefaults,
  getDefinedSiteMetadata,
  getHostFromUrl,
  type ISearchCategories,
  type ISearchEntryRequestConfig,
  type ISiteMetadata,
  type ISiteUserConfig,
  type TSiteID,
} from "@ptd/site";

import {
  IBackupServerMetadata,
  IDownloaderMetadata,
  IMediaServerMetadata,
  IMetadataPiniaStorageSchema,
  ISiteDiscoveryMetadata,
  ISearchSolution,
  TDownloaderKey,
  TMediaServerKey,
  TSearchSnapshotKey,
  TSolutionKey,
  ISearchSolutionMetadata,
} from "@/shared/types.ts";
import { sendMessage } from "@/messages.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { buildSiteMaps, getSiteMapVersion } from "@/shared/utils/siteMap.ts";
import { getCachedSiteMetadata } from "@/options/utils/siteDefinitionCache.ts";

type TSimplePatchFieldKey = keyof Pick<
  IMetadataPiniaStorageSchema,
  "sites" | "solutions" | "snapshots" | "downloaders" | "mediaServers" | "backupServers"
>;

interface ISiteDiscoveryResult {
  added: number;
  failed: number;
  changed: boolean;
}

interface ISiteDiscoveryOptions {
  force?: boolean;
}

let siteDiscoveryPromise: Promise<ISiteDiscoveryResult> | undefined;

function getSiteDiscoveryVersion() {
  return `local-cookie-v3:${__EXT_VERSION__}:${definitionList.join(",")}`;
}

function hasSiteCookie(siteMetadata: ISiteMetadata, cookies: chrome.cookies.Cookie[]) {
  const siteHosts = (siteMetadata.urls ?? []).flatMap((url) => {
    try {
      return [new URL(url).hostname.toLowerCase()];
    } catch {
      return [getHostFromUrl(url).toLowerCase().replace(/:\d+$/, "")];
    }
  });

  return cookies.some((cookie) => {
    const cookieHost = cookie.domain.replace(/^\./, "").toLowerCase();
    return siteHosts.some(
      (siteHost) =>
        siteHost === cookieHost || siteHost.endsWith(`.${cookieHost}`) || cookieHost.endsWith(`.${siteHost}`),
    );
  });
}

export const useMetadataStore = defineStore("metadata", {
  persistWebExt: true,
  state: (): IMetadataPiniaStorageSchema => ({
    sites: {},
    siteDiscovery: {
      version: "",
      discovered: {},
      available: {},
      ignored: {},
    },
    solutions: {},
    snapshots: {},
    downloaders: {},
    mediaServers: {},
    backupServers: {},

    defaultSolutionId: "default",
    defaultDownloader: {},

    lastSearchFilter: "",
    lastUserInfo: {},
    lastDownloader: {},
    lastKeepUpload: {},
    lastUserInfoAutoFlushAt: 0,

    siteHostMap: {},
    siteNameMap: {},
    siteMapVersion: "",
  }),

  getters: {
    getAddedSiteIds(state) {
      return Object.keys(state.sites);
    },

    getAddedSites(state) {
      return Object.entries(state.sites).map(([siteId, metadata]) => {
        return { ...metadata, id: siteId };
      });
    },

    getSortedAddedSites(state): Array<ISiteUserConfig & { id: string }> {
      return this.getAddedSites.sort((a, b) => {
        return (b.sortIndex ?? 0) - (a.sortIndex ?? 0);
      });
    },

    getSitesGroupData(state) {
      const sitesGroupData: Record<string, TSiteID[]> = {};
      for (const siteId in state.sites) {
        const site = state.sites[siteId];
        if (site.groups) {
          for (const group of site.groups) {
            sitesGroupData[group] ??= [];
            sitesGroupData[group].push(siteId);
          }
        }
      }
      return sitesGroupData;
    },

    getSiteMetadata(state) {
      return async (siteId: TSiteID): Promise<ISiteMetadata> => {
        return await getDefinedSiteMetadata(siteId);
      };
    },

    getSiteUserConfig(state) {
      return async (siteId: TSiteID, flush: boolean = false): Promise<ISiteUserConfig> => {
        const siteUserConfig = state.sites[siteId] ?? {};
        if (flush || isEmpty(siteUserConfig)) {
          return await sendMessage("getSiteUserConfig", { siteId, flush });
        }
        return siteUserConfig;
      };
    },

    getSiteMergedMetadata(state) {
      return async <T extends keyof ISiteMetadata>(
        siteId: TSiteID,
        field: T,
        defaultValue?: ISiteMetadata[T],
      ): Promise<ISiteMetadata[T]> => {
        const siteConfig = await this.getSiteUserConfig(siteId);
        if (siteConfig.merge?.[field]) {
          return siteConfig.merge[field];
        }
        const siteMetadata = await this.getSiteMetadata(siteId);
        return siteMetadata[field] ?? (defaultValue as ISiteMetadata[T]);
      };
    },

    getSiteName(state) {
      return async (siteId: TSiteID): Promise<string> => {
        return await this.getSiteMergedMetadata(siteId, "name", siteId);
      };
    },

    getSiteUrl(state) {
      return async (siteId: TSiteID): Promise<string> => {
        const siteConfig = await this.getSiteUserConfig(siteId);
        if (siteConfig.url) {
          return siteConfig.url;
        }
        const siteMetadata = await this.getSiteMetadata(siteId);
        return siteMetadata.urls?.[0] ?? "#";
      };
    },

    getSiteCategory(state) {
      return async (siteId: TSiteID, categoryKey?: string): Promise<ISearchCategories | ISearchCategories[]> => {
        const siteMetadataCategory = await this.getSiteMergedMetadata(siteId, "category", []);
        if (categoryKey) {
          return siteMetadataCategory?.find((x) => x.key === categoryKey) as ISearchCategories;
        }
        return siteMetadataCategory as ISearchCategories[];
      };
    },

    getSiteCategoryName(state) {
      return async (siteId: TSiteID, categoryKey: string): Promise<string> => {
        const siteMetadataCategory = (await this.getSiteCategory(siteId, categoryKey)) as ISearchCategories;
        return siteMetadataCategory?.name ?? categoryKey;
      };
    },

    getSiteCategoryOptionName(state) {
      return async (
        siteId: TSiteID,
        categoryKey: string,
        optionKey: string | number | (string | number)[],
      ): Promise<string> => {
        const siteMetadataCategory = (await this.getSiteCategory(siteId, categoryKey)) as ISearchCategories;
        const options = siteMetadataCategory?.options ?? [];
        if (Array.isArray(optionKey)) {
          return optionKey.map((v) => options.find((o) => o.value === v)?.name ?? v).join(", ");
        } else {
          return options.find((o) => o.value === optionKey)?.name ?? (optionKey as string);
        }
      };
    },

    getSearchSolutionIds(state) {
      return Object.keys(state.solutions);
    },

    getSearchSolutions(state) {
      return Object.values(state.solutions);
    },

    getSiteDefaultSearchSolution(state) {
      // 如果站点 isDead 或者 isOffline 则不返回搜索方案（ undefined ），调用该方法的地方需要额外判断
      return async (siteId: TSiteID): Promise<Record<string, ISearchEntryRequestConfig> | undefined> => {
        const siteUserConfig = state.sites[siteId];
        const siteMetadata = await getDefinedSiteMetadata(siteId);

        if (siteUserConfig.isOffline || siteMetadata.isDead) {
          return;
        }

        let searchEntries = siteMetadata.searchEntry ?? { default: {} };
        for (const [key, value] of Object.entries(siteUserConfig?.merge?.searchEntry ?? {})) {
          if (searchEntries[key] && typeof value.enabled === "boolean") {
            /**
             * 由于我们需要通过 sendMessage 向 offscreen 发送搜索方案，然而 sendMessage 不支持 Function 等复杂类型，
             * 所以我们这里只传递 id, name, enabled，其他的搜索方案的内容在 站点实例里面组合
             */
            searchEntries[key] = { id: key, name: searchEntries[key].name, enabled: value.enabled };
          }
        }
        return searchEntries;
      };
    },

    getSearchSolution(state) {
      return async (
        solutionId: TSolutionKey | `site:${string}` | "default" | "all",
      ): Promise<ISearchSolutionMetadata> => {
        // 首先判断是否是约定的 "all"  "default"  "site:xxx,xxx" 站点搜索方案
        if (
          // 全部站点
          solutionId === "all" ||
          (solutionId === "default" && state.defaultSolutionId === "default") ||
          // 特定站点
          solutionId.startsWith("site:")
        ) {
          const solutions: ISearchSolution[] = [];

          let addedSiteIds = Object.keys(state.sites);
          if (solutionId.startsWith("site:")) {
            addedSiteIds = solutionId
              .slice(5) //  /^site:/
              .split(",")
              .map((id) => id.trim());
          }

          for (const siteId of addedSiteIds) {
            const searchEntries = await this.getSiteDefaultSearchSolution(siteId);
            if (searchEntries) {
              solutions.push({ id: "default", siteId, searchEntries });
            }
          }

          return {
            name: "all",
            id: solutionId.startsWith("site:") ? (solutionId as `site:${string}`) : "all",
            sort: 0,
            enabled: true,
            isDefault: true,
            createdAt: 0,
            solutions,
          };
        } else if (solutionId === "default") {
          // 如果 solutionId 是 "default"，则使用默认的搜索方案 ID
          solutionId = state.defaultSolutionId;
        }

        // 对于已经存在的搜索方案，其中如果有 id === "default" 的特殊情况，将其动态解开
        let solution = state.solutions[solutionId] as ISearchSolutionMetadata;
        let solutionItems = [];
        for (const solutionItem of solution.solutions) {
          if (solutionItem.id === "default") {
            const searchEntries = await this.getSiteDefaultSearchSolution(solutionItem.siteId);
            if (searchEntries) {
              solutionItem.searchEntries = searchEntries;
              solutionItems.push(solutionItem);
            }
          } else {
            solutionItems.push(solutionItem);
          }
        }

        solution.solutions = solutionItems;
        return solution;
      };
    },

    getSearchSolutionName(state) {
      return (solutionId: TSolutionKey): string => {
        if (solutionId === "all") {
          return "全站"; // FIXME i18n
        }

        return state.solutions[solutionId]?.name ?? solutionId;
      };
    },

    getSearchSnapshotList(state) {
      return Object.values(state.snapshots);
    },

    getSearchSnapshotData(state) {
      return async (id: TSearchSnapshotKey) => {
        const snapshotInfo = state.snapshots[id];
        if (snapshotInfo?.id) {
          return await sendMessage("getSearchResultSnapshotData", id);
        } else {
          const runtimeStorage = useRuntimeStore();
          runtimeStorage.showSnakebar("未找到该搜索快照...", { color: "error" });
          return;
        }
      };
    },

    getDownloaderIds(state) {
      return Object.keys(state.downloaders);
    },

    getDownloaders(state) {
      return Object.values(state.downloaders);
    },

    getEnabledDownloaders(state) {
      return Object.values(state.downloaders).filter((downloader) => downloader.enabled);
    },

    getSortedEnabledDownloaders(state): Array<IDownloaderMetadata> {
      return this.getEnabledDownloaders.sort((a, b) => {
        return (b.sortIndex ?? 0) - (a.sortIndex ?? 0);
      });
    },

    getEnabledDownloadersBySite(state) {
      return (siteId: string): IDownloaderMetadata[] => {
        const configStore = useConfigStore();
        if (!configStore.download.allowDownloaderFilterForSite) {
          return this.getEnabledDownloaders;
        }
        return this.getEnabledDownloaders.filter((d) => !d.excludedSites?.includes(siteId));
      };
    },

    getSortedEnabledDownloadersBySite(state) {
      return (siteId: string): IDownloaderMetadata[] => {
        return [...this.getEnabledDownloadersBySite(siteId)].sort((a, b) => {
          return (b.sortIndex ?? 0) - (a.sortIndex ?? 0);
        });
      };
    },

    getMediaServerIds(state) {
      return Object.keys(state.mediaServers);
    },

    getMediaServers(state) {
      return Object.values(state.mediaServers);
    },

    getEnabledMediaServers(state) {
      return Object.values(state.mediaServers).filter((mediaServer) => mediaServer.enabled);
    },

    getBackupServerIds(state) {
      return Object.keys(state.backupServers);
    },

    getBackupServers(state) {
      return Object.values(state.backupServers);
    },
  },
  actions: {
    async simplePatch<
      Field extends TSimplePatchFieldKey,
      Id extends keyof IMetadataPiniaStorageSchema[Field],
      Key extends keyof IMetadataPiniaStorageSchema[Field][Id],
      Value extends IMetadataPiniaStorageSchema[Field][Id][Key],
    >(schemaKey: Field, id: Id, key: Key | string, value: Value | any) {
      set(this[schemaKey][id], key, value);
      await this.$save();
    },

    async addSite(siteId: TSiteID, siteConfig: ISiteUserConfig, options?: { rebuildMaps?: boolean }) {
      const { rebuildMaps = true } = options ?? {};

      delete siteConfig.valid;
      this.sites[siteId] = siteConfig;
      if (this.siteDiscovery?.ignored) {
        delete this.siteDiscovery.ignored[siteId];
      }

      if (rebuildMaps) {
        await this.buildSiteMapCache(false);
      }

      await this.$save();
    },

    async addSites(siteConfigs: Record<TSiteID, ISiteUserConfig>, options?: { rebuildMaps?: boolean; save?: boolean }) {
      const { rebuildMaps = true, save = true } = options ?? {};

      for (const [siteId, siteConfig] of Object.entries(siteConfigs)) {
        delete siteConfig.valid;
        this.sites[siteId] = siteConfig;
      }

      if (rebuildMaps) {
        await this.buildSiteMapCache(false);
      }

      if (save) {
        await this.$save();
      }
    },

    async discoverSites(options: ISiteDiscoveryOptions = {}): Promise<ISiteDiscoveryResult> {
      if (siteDiscoveryPromise) {
        return await siteDiscoveryPromise;
      }

      const { force = false } = options;

      siteDiscoveryPromise = (async () => {
        const discoveryVersion = getSiteDiscoveryVersion();
        const discovery = this.siteDiscovery ?? ({} as ISiteDiscoveryMetadata);
        const ignored = discovery.ignored ?? {};
        const discovered = discovery.discovered ?? {};
        const available = discovery.available ?? {};

        if (!force && discovery.version === discoveryVersion) {
          return { added: 0, failed: 0, changed: false };
        }

        const siteIdsToScan = (definitionList as TSiteID[]).filter((siteId) => !ignored[siteId] || this.sites[siteId]);
        const discoveredSiteIds: TSiteID[] = [];
        let failed = 0;

        // 站点定义和默认配置均为本地数据，并行加载，避免首屏被数百个串行任务阻塞。
        const discoveryResults = await Promise.all(
          siteIdsToScan.map(async (siteId) => {
            try {
              const siteMetadata = await getCachedSiteMetadata(siteId);
              const requiresManualInput = (siteMetadata.userInputSettingMeta?.length ?? 0) > 0;

              if (siteMetadata.isDead || requiresManualInput) {
                return undefined;
              }

              return { siteId, siteMetadata };
            } catch (error) {
              failed++;
              console.warn(`[PT Depiler] Failed to discover local site definition: ${siteId}`, error);
              return undefined;
            }
          }),
        );
        const discoverableSites = discoveryResults.filter(
          (site): site is { siteId: TSiteID; siteMetadata: ISiteMetadata } => site !== undefined,
        );

        const privateSites = discoverableSites.filter(({ siteMetadata }) => siteMetadata.type === "private");
        let cookies: chrome.cookies.Cookie[] = [];
        if (privateSites.length > 0) {
          try {
            // 只读取浏览器本地 Cookie，不访问站点网络；Cookie 值不会写入日志或配置。
            cookies = await sendMessage("getAllCookies", {});
          } catch (error) {
            failed++;
            console.warn("[PT Depiler] Failed to read browser cookies for local site discovery", error);
          }
        }

        const siteConfigs: Record<TSiteID, ISiteUserConfig> = {};
        let changed = false;
        for (const { siteId, siteMetadata } of discoverableSites) {
          const hasAccess = siteMetadata.type === "public" || hasSiteCookie(siteMetadata, cookies);
          if (available[siteId] !== hasAccess) {
            changed = true;
          }
          available[siteId] = hasAccess;

          if (!hasAccess) {
            continue;
          }

          if (!this.sites[siteId] && !ignored[siteId]) {
            siteConfigs[siteId] = applySiteUserConfigDefaults(siteMetadata);
            discoveredSiteIds.push(siteId);
            changed = true;
          }
        }

        if (Object.keys(siteConfigs).length > 0) {
          await this.addSites(siteConfigs, { rebuildMaps: false, save: false });
          for (const siteId of discoveredSiteIds) {
            discovered[siteId] = true;
          }
          await this.buildSiteMapCache(false);
        }

        this.siteDiscovery = {
          version: failed === 0 ? discoveryVersion : "",
          discovered,
          available,
          ignored,
        };

        await this.$save();
        return { added: Object.keys(siteConfigs).length, failed, changed };
      })();

      try {
        return await siteDiscoveryPromise;
      } finally {
        siteDiscoveryPromise = undefined;
      }
    },

    async removeSite(siteId: TSiteID, options?: { rebuildMaps?: boolean }) {
      const { rebuildMaps = true } = options ?? {};

      delete this.sites[siteId];

      if (this.siteDiscovery?.discovered?.[siteId]) {
        this.siteDiscovery.ignored ??= {};
        this.siteDiscovery.ignored[siteId] = true;
      }

      if (rebuildMaps) {
        await this.buildSiteMapCache(false);
      }

      await this.$save();
    },

    async buildSiteMapCache(save: boolean = false) {
      const { siteHostMap, siteNameMap } = await buildSiteMaps(this.sites);
      this.siteHostMap = siteHostMap;
      this.siteNameMap = siteNameMap;
      this.siteMapVersion = getSiteMapVersion(this.sites);

      if (save) {
        await this.$save();
      }
    },

    async ensureSiteMapCache(save: boolean = true) {
      const siteMapVersion = getSiteMapVersion(this.sites);
      const hasSiteNames = Object.keys(this.sites).every((siteId) => Object.hasOwn(this.siteNameMap, siteId));
      if (this.siteMapVersion === siteMapVersion && hasSiteNames) {
        return false;
      }

      await this.buildSiteMapCache(save);
      return true;
    },

    async addSearchSolution(solution: ISearchSolutionMetadata) {
      this.solutions[solution.id] = solution;
      await this.$save();
    },

    async removeSearchSolution(solutionId: TSolutionKey) {
      delete this.solutions[solutionId];

      if (this.defaultSolutionId === solutionId) {
        this.defaultSolutionId = "default";
      }

      await this.$save();
    },

    async saveSearchSnapshotData(name: string) {
      const runtimeStorage = useRuntimeStore();
      const searchSnapshotData = runtimeStorage.search;

      if (searchSnapshotData.isSearching) {
        runtimeStorage.showSnakebar("你不能创建一个正在搜索中的快照...", { color: "error" });
        return;
      }

      const snapshotId = nanoid();
      this.snapshots[snapshotId] = {
        id: snapshotId,
        name,
        createdAt: Date.now(),
        recordCount: searchSnapshotData.searchResult.length,
      };

      // 保存搜索快照数据
      await sendMessage("saveSearchResultSnapshotData", { snapshotId, data: searchSnapshotData });

      await this.$save();
    },

    async editSearchSnapshotDataName(id: TSearchSnapshotKey, name: string) {
      this.snapshots[id].name = name;
      await this.$save();
    },

    async removeSearchSnapshotData(id: TSearchSnapshotKey) {
      delete this.snapshots[id]; // 删除搜索快照元数据
      await sendMessage("removeSearchResultSnapshotData", id); // 删除搜索快照数据
      await this.$save();
    },

    async addDownloader(downloaderConfig: IDownloaderMetadata) {
      delete downloaderConfig.valid;
      this.downloaders[downloaderConfig.id] = downloaderConfig;
      await this.$save();
    },

    async removeDownloader(downloaderId: TDownloaderKey) {
      delete this.downloaders[downloaderId];
      await this.$save();
    },

    async setLastSearchFilter(filter: string) {
      this.lastSearchFilter = (filter ?? "").replace(/\s*site:\S+/g, "").trim();
      await this.$save();
    },

    async setLastDownloader(downloader: IMetadataPiniaStorageSchema["lastDownloader"]) {
      this.lastDownloader = downloader;
      await this.$save();
    },

    async addMediaServer(mediaServerConfig: IMediaServerMetadata) {
      this.mediaServers[mediaServerConfig.id] = mediaServerConfig;
      await this.$save();
    },

    async removeMediaServer(mediaServerId: TMediaServerKey) {
      delete this.mediaServers[mediaServerId];
      await this.$save();
    },

    async addBackupServer(backupServerConfig: IBackupServerMetadata) {
      this.backupServers[backupServerConfig.id] = backupServerConfig;
      await this.$save();
    },

    async removeBackupServer(backupServerId: string) {
      delete this.backupServers[backupServerId];
      await this.$save();
    },
  },
});

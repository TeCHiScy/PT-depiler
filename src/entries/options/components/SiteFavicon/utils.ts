import { ref } from "vue";
import { FAVICON_CACHE_TTL_MS, type TSiteID } from "@ptd/site";
import { sendMessage } from "@/messages.ts";

/**
 * 构造一个前端的 favicon 缓存，以避免过多的调用 sendMessage("getSiteFavicon") 方法
 */
interface IFrontendFaviconCacheItem {
  value?: string;
  fetchedAt?: number;
  pending?: Promise<string>;
}

const siteFaviconCache = ref<Record<TSiteID, IFrontendFaviconCacheItem>>({});

export async function getSiteFavicon(siteId: TSiteID, flush: boolean = false) {
  const cached = siteFaviconCache.value[siteId];
  if (cached?.pending) return cached.pending;

  const shouldRefresh =
    flush || !cached?.value || !cached.fetchedAt || Date.now() - cached.fetchedAt >= FAVICON_CACHE_TTL_MS;
  if (!shouldRefresh) {
    return cached.value!;
  }

  const pending = sendMessage("getSiteFavicon", { site: siteId, flush: true }).then((value) => {
    siteFaviconCache.value[siteId] = { value, fetchedAt: Date.now() };
    return value;
  });
  siteFaviconCache.value[siteId] = { ...cached, pending };

  return pending;
}

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

const MAX_CONCURRENT_FAVICON_REQUESTS = 4;
let activeFaviconRequests = 0;
const faviconRequestQueue: Array<() => void> = [];

function pumpFaviconRequestQueue() {
  while (activeFaviconRequests < MAX_CONCURRENT_FAVICON_REQUESTS && faviconRequestQueue.length > 0) {
    const nextRequest = faviconRequestQueue.shift();
    nextRequest?.();
  }
}

function enqueueFaviconRequest(task: () => Promise<string>) {
  return new Promise<string>((resolve, reject) => {
    faviconRequestQueue.push(async () => {
      activeFaviconRequests++;
      try {
        resolve(await task());
      } catch (error) {
        reject(error);
      } finally {
        activeFaviconRequests--;
        pumpFaviconRequestQueue();
      }
    });
    pumpFaviconRequestQueue();
  });
}

export async function getSiteFavicon(siteId: TSiteID, flush: boolean = false) {
  const cached = siteFaviconCache.value[siteId];
  if (cached?.pending) return cached.pending;

  const shouldRefresh =
    flush || !cached?.value || !cached.fetchedAt || Date.now() - cached.fetchedAt >= FAVICON_CACHE_TTL_MS;
  if (!shouldRefresh) {
    return cached.value!;
  }

  let pending: Promise<string>;
  pending = enqueueFaviconRequest(() => sendMessage("getSiteFavicon", { site: siteId, flush: true }))
    .then((value) => {
      siteFaviconCache.value[siteId] = { value, fetchedAt: Date.now() };
      return value;
    })
    .finally(() => {
      const current = siteFaviconCache.value[siteId];
      if (current?.pending === pending) {
        siteFaviconCache.value[siteId] = {
          value: current.value,
          fetchedAt: current.fetchedAt,
        };
      }
    });
  siteFaviconCache.value[siteId] = { ...cached, pending };

  return pending;
}

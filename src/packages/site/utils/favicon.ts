/**
 * 获取站点图标的方法。
 *
 * 远程 favicon 由 offscreen 层负责缓存和重新验证；本文件只负责远程发现、下载和本地资源 fallback。
 */

import axios from "axios";
import type { IFaviconCacheEntry, ISiteMetadata } from "../types";

export const FAVICON_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// from: https://stackoverflow.com/a/9967193/8824471
// from: http://proger.i-forge.net/%D0%9A%D0%B0%D0%BA_%D0%BF%D0%BE%D0%BB%D1%83%D1%87%D0%B8%D1%82%D1%8C_favicon_%D1%81%D0%B0%D0%B9%D1%82%D0%B0/[20121112]%20The_smallest_transparent_pixel.html
export const NO_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=";

const FAVICON_FROM_LINK = [
  "link[rel='icon' i][href]",
  "link[rel='shortcut icon' i][href]",
  "link[rel='apple-touch-icon' i][href]",
  "link[rel='apple-touch-icon-precomposed' i][href]",
  "link[rel='apple-touch-startup-image' i][href]",
  "link[rel='fluid-icon' i][href]",
];

interface IFaviconBlobResult {
  blob?: Blob;
  sourceUrl: string;
  etag?: string;
  lastModified?: string;
  notModified?: boolean;
}

interface IParsedFavicon {
  href: string;
  sizes: string | `${string}x${string}`;
  source: "manifest" | "link" | "favicon";
  fetchResult?: IFaviconBlobResult;
}

export interface IFaviconFetchResult {
  value: string;
  sourceUrl?: string;
  etag?: string;
  lastModified?: string;
}

const remoteBetterFaviconOrder = [
  {
    key: "source",
    rank: (item: IParsedFavicon) => {
      const rule = ["favicon", "link", "manifest"].reverse();
      let rank = 0;
      for (const n in rule) {
        rank += rule[n] === item.source ? parseInt(n) : 0;
      }
      return rank;
    },
  },
  {
    key: "ext",
    rank: (item: IParsedFavicon) => {
      const rule = [/\.ico$/im, /\.png$/im, /\.jpg$/im, /\.svg$/im].reverse();
      let rank = 0;
      for (const n in rule) {
        rank += rule[n].test(item.href) ? parseInt(n) : 0;
      }
      return rank;
    },
  },
  {
    key: "sizes",
    rank: (item: IParsedFavicon) => {
      if (!item.sizes) return 0;
      const wh = item.sizes.split("x");
      const size = parseInt(wh[0]);
      if (wh[0] != wh[1]) return 0;
      if (size > 24 && size < 40) return 4;
      if (size > 36 && size < 90) return 3;
      if (size > 88 && size < 260) return 2;
      if (size > 15 && size < 26) return 1;
      return 0;
    },
  },
].reverse();

function transformBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("loadend", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Error when parse favicon Blob"));
      }
    });

    reader.readAsDataURL(blob);
  });
}

function getHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

async function fetchFaviconBlob(url: string, cache?: IFaviconCacheEntry): Promise<IFaviconBlobResult> {
  const headers: Record<string, string> = {};
  if (cache?.sourceUrl === url) {
    if (cache.etag) headers["If-None-Match"] = cache.etag;
    if (cache.lastModified) headers["If-Modified-Since"] = cache.lastModified;
  }

  const response = await axios.get<Blob>(url, {
    responseType: "blob",
    headers,
    validateStatus: (status) => status === 200 || status === 304,
  });

  return {
    blob: response.status === 304 ? undefined : response.data,
    sourceUrl: url,
    etag: getHeader(response.headers as Record<string, unknown>, "etag"),
    lastModified: getHeader(response.headers as Record<string, unknown>, "last-modified"),
    notModified: response.status === 304,
  };
}

async function getFaviconFromUrl(url: string): Promise<IFaviconBlobResult> {
  const baseUrl = new URL(url);
  const { data: doc } = await axios.get<Document>(url, { responseType: "document" });
  const favicons: IParsedFavicon[] = [];

  FAVICON_FROM_LINK.forEach((selector) => {
    const element = doc.querySelector(selector) as HTMLLinkElement;
    if (element) {
      favicons.push({
        href: element.href,
        sizes: element.sizes?.toString() || "",
        source: "link",
      });
    }
  });

  const manifestElement = doc.querySelector('head link[rel="manifest" i]') as HTMLLinkElement;
  if (manifestElement) {
    const { data: manifest } = await axios.get<{
      icons?: Record<"sizes" | "src" | "type", string>[];
    }>(manifestElement.href, { responseType: "json" });

    for (const { sizes, src } of manifest.icons ?? []) {
      favicons.push({
        href: new URL(src, manifestElement.href).href,
        sizes,
        source: "manifest",
      });
    }
  }

  try {
    const faviconUrl = new URL("/favicon.ico", baseUrl).href;
    const faviconIco = await fetchFaviconBlob(faviconUrl);
    if (faviconIco.blob && ["image/x-icon", "image/vnd.microsoft.icon"].includes(faviconIco.blob.type)) {
      favicons.push({ href: faviconUrl, sizes: "", source: "favicon", fetchResult: faviconIco });
    }
  } catch {}

  if (favicons.length === 0) {
    throw new Error("Can't find any favicons from this site");
  }

  const rankedFavicons = favicons
    .map((icon) => {
      let rank = 0;
      for (const x in remoteBetterFaviconOrder) {
        const order = remoteBetterFaviconOrder[x];
        rank += order.rank(icon) * Math.pow(10, parseInt(x));
      }
      return { ...icon, rank };
    })
    .sort((a, b) => (a.rank < b.rank ? 1 : -1));

  for (const usedFavicon of rankedFavicons) {
    try {
      if (usedFavicon.fetchResult) return usedFavicon.fetchResult;
      return await fetchFaviconBlob(new URL(usedFavicon.href, baseUrl).href);
    } catch {}
  }

  throw new Error("Can't fetch any favicons from this site");
}

export type getFaviconMetadata = Required<Pick<ISiteMetadata, "id" | "urls">> & Pick<ISiteMetadata, "favicon">;

/** 返回插件内置的站点图标，只作为远程 favicon 失败时的 fallback。 */
export function getLocalFavicon(site: Pick<ISiteMetadata, "id" | "favicon">): string | undefined {
  const { id: siteId, favicon: siteFavicon } = site;
  let checkLocalIconPaths = [`${siteId}.png`, `${siteId}.ico`, `${siteId}.svg`];

  if (siteFavicon?.startsWith("./")) {
    checkLocalIconPaths = [siteFavicon.replace(/^\.\//, ""), ...checkLocalIconPaths];
  }

  for (const checkLocalIconPath of checkLocalIconPaths) {
    if (__RESOURCE_SITE_ICONS__.includes(checkLocalIconPath)) {
      return `/icons/site/${checkLocalIconPath}`;
    }
  }

  return undefined;
}

/** 只从站点获取 favicon，不使用插件本地 icon fallback。 */
export async function getRemoteFavicon(
  site: getFaviconMetadata,
  cache?: IFaviconCacheEntry,
): Promise<IFaviconFetchResult | null> {
  const { urls: siteUrls, favicon: siteFavicon } = site;

  if (cache?.sourceUrl) {
    try {
      const cachedResult = await fetchFaviconBlob(cache.sourceUrl, cache);
      if (cachedResult.notModified && cache.value !== NO_IMAGE) {
        return {
          value: cache.value,
          sourceUrl: cache.sourceUrl,
          etag: cachedResult.etag ?? cache.etag,
          lastModified: cachedResult.lastModified ?? cache.lastModified,
        };
      }
      if (cachedResult.blob) {
        return {
          value: await transformBlob(cachedResult.blob),
          sourceUrl: cachedResult.sourceUrl,
          etag: cachedResult.etag,
          lastModified: cachedResult.lastModified,
        };
      }
    } catch {}
  }

  if (siteFavicon?.startsWith("data:image/")) {
    return { value: siteFavicon };
  }

  if (siteFavicon?.startsWith("http")) {
    try {
      const remoteResult = await fetchFaviconBlob(siteFavicon, cache);
      if (remoteResult.notModified && cache?.value !== NO_IMAGE) {
        return {
          value: cache!.value,
          sourceUrl: remoteResult.sourceUrl,
          etag: remoteResult.etag ?? cache?.etag,
          lastModified: remoteResult.lastModified ?? cache?.lastModified,
        };
      }
      if (remoteResult.blob) {
        return {
          value: await transformBlob(remoteResult.blob),
          sourceUrl: remoteResult.sourceUrl,
          etag: remoteResult.etag,
          lastModified: remoteResult.lastModified,
        };
      }
    } catch {}
  }

  for (const url of siteUrls) {
    try {
      const remoteResult = await getFaviconFromUrl(url);
      if (remoteResult.notModified && cache?.value !== NO_IMAGE) {
        return {
          value: cache!.value,
          sourceUrl: remoteResult.sourceUrl,
          etag: remoteResult.etag ?? cache?.etag,
          lastModified: remoteResult.lastModified ?? cache?.lastModified,
        };
      }
      if (remoteResult.blob) {
        return {
          value: await transformBlob(remoteResult.blob),
          sourceUrl: remoteResult.sourceUrl,
          etag: remoteResult.etag,
          lastModified: remoteResult.lastModified,
        };
      }
    } catch {}
  }

  return null;
}

/** 兼容其他调用方：远程 favicon 优先，本地 icon 和 NO_IMAGE 作为 fallback。 */
export async function getFavicon(site: getFaviconMetadata): Promise<string> {
  const remoteFavicon = await getRemoteFavicon(site);
  return remoteFavicon?.value ?? getLocalFavicon(site) ?? NO_IMAGE;
}

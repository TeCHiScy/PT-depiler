import { stringify } from "urlencode";
import { onMessage, sendMessage } from "@/messages.ts";
import { extStorage } from "@/storage.ts";
import type { IMetadataPiniaStorageSchema } from "@/shared/types.ts";
import type { ISiteBridgeCatalogItem } from "@/messages.ts";

import { setupOffscreenDocument } from "./offscreen.ts";

export function openOptionsPage(url?: string | { path: string; query?: Record<string, any> }) {
  if (url && typeof url !== "string") {
    url = url.path + (url.query ? "?" + stringify(url.query) : "");
  }
  url ??= "/";

  chrome.tabs.create({ url: "/src/entries/options/index.html#" + url }).catch();
}

onMessage("openOptionsPage", async ({ data: url }) => {
  openOptionsPage(url);
});

let ensuringSiteMapCache: Promise<IMetadataPiniaStorageSchema> | undefined;

async function ensureStoredSiteMapCache(metadata: IMetadataPiniaStorageSchema): Promise<IMetadataPiniaStorageSchema> {
  if (ensuringSiteMapCache) {
    await ensuringSiteMapCache;
    return (await extStorage.getItem("metadata")) ?? metadata;
  }

  const ensure = async () => {
    await setupOffscreenDocument();
    const result = await sendMessage("ensureSiteMapCache", metadata);
    if (result.changed) {
      await extStorage.setItem("metadata", result.metadata);
    }
    return result.metadata;
  };

  ensuringSiteMapCache = ensure();
  try {
    return await ensuringSiteMapCache;
  } finally {
    ensuringSiteMapCache = undefined;
  }
}

export async function getMetadataStore(): Promise<IMetadataPiniaStorageSchema | undefined> {
  const metadata = await extStorage.getItem("metadata");
  if (metadata) {
    return await ensureStoredSiteMapCache(metadata);
  }
  return metadata ?? undefined;
}

export async function setMetadataStore(metadata: IMetadataPiniaStorageSchema) {
  const ensuredMetadata = await ensureStoredSiteMapCache(metadata);
  await extStorage.setItem("metadata", ensuredMetadata);
}

onMessage("downloadFile", async ({ data: downloadOptions }) => {
  return await chrome.downloads.download(downloadOptions);
});

// @ts-ignore
onMessage("getExtStorage", async ({ data: key }) => {
  if (key === "metadata") {
    return await getMetadataStore();
  }
  return await extStorage.getItem(key);
});

onMessage("getSiteBridgeCatalog", async () => {
  await setupOffscreenDocument();
  return await sendMessage("getSiteBridgeCatalogData", undefined);
});

onMessage("setExtStorage", async ({ data: { key, value } }) => {
  if (key === "metadata") {
    await setMetadataStore(value as IMetadataPiniaStorageSchema);
  } else {
    await extStorage.setItem(key, value as never);
  }
});

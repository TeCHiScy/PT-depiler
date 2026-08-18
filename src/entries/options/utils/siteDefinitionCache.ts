import { getDefinedSiteMetadata, type ISiteMetadata, type TSiteID } from "@ptd/site";

// Site definitions are static extension data. Reuse the in-flight/result promise
// across discovery and the site catalog during the lifetime of the options page.
const siteDefinitionCache = new Map<TSiteID, Promise<ISiteMetadata>>();

export function getCachedSiteMetadata(siteId: TSiteID): Promise<ISiteMetadata> {
  const cached = siteDefinitionCache.get(siteId);
  if (cached) {
    return cached;
  }

  const pending = getDefinedSiteMetadata(siteId).catch((error) => {
    siteDefinitionCache.delete(siteId);
    throw error;
  });
  siteDefinitionCache.set(siteId, pending);
  return pending;
}

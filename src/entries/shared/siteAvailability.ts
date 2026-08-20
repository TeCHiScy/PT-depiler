import { EResultParseStatus } from "@ptd/site/types/base";
import type { ISiteMetadata, ISiteUserConfig } from "@ptd/site/types/site";
import type { IUserInfo } from "@ptd/site/types/userinfo";

export type TSiteAvailability = "ready" | "public" | "needLogin" | "needToken";

export function hasRequiredSiteInput(siteMetadata: ISiteMetadata, siteUserConfig: ISiteUserConfig) {
  const requiredInputs = (siteMetadata.userInputSettingMeta ?? []).filter((item) => item.required);
  return requiredInputs.every((item) => Boolean(siteUserConfig.inputSetting?.[item.name]?.trim()));
}

export function getSiteAvailability(
  siteMetadata: ISiteMetadata,
  siteUserConfig: ISiteUserConfig | undefined,
  userInfo: Partial<IUserInfo>,
  hasAccess: boolean | undefined,
): TSiteAvailability {
  const requiresManualInput = (siteMetadata.userInputSettingMeta?.length ?? 0) > 0;
  if (requiresManualInput && (!siteUserConfig || !hasRequiredSiteInput(siteMetadata, siteUserConfig))) {
    return "needToken";
  }

  if (siteMetadata.type === "public") {
    return "public";
  }

  if (!siteUserConfig) {
    return "needLogin";
  }

  if (siteMetadata.type === "private") {
    const hasConfiguredAccess = requiresManualInput
      ? hasRequiredSiteInput(siteMetadata, siteUserConfig)
      : hasAccess === true;
    const hasValidUserInfo =
      userInfo.status === EResultParseStatus.success &&
      typeof userInfo.name === "string" &&
      Boolean(userInfo.name.trim());

    return hasConfiguredAccess && hasValidUserInfo ? "ready" : "needLogin";
  }

  return "ready";
}

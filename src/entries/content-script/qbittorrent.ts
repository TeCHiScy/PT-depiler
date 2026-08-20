import {
  applySiteUserConfigDefaults,
  EResultParseStatus,
  getDefinedSiteMetadata,
  type ISiteMetadata,
  type ISiteUserConfig,
  type TSiteUrl,
  type TSiteID,
  type timezoneOffset,
} from "@ptd/site";

import { sendMessage, type ISiteBridgeCatalogItem } from "@/messages.ts";
import type { IMetadataPiniaStorageSchema } from "@/shared/types.ts";
import { formatDate, formatSize, formatTimeAgo, simplifyNumber } from "@/options/utils.ts";

const QB_SITE_TAB_ID = "ptdQbSiteTabLink";
const QB_SITE_PANEL_ID = "ptdQbSiteTabColumn";
const QB_SITE_TABLE_ID = "ptdQbSiteTable";
const QB_SITE_STYLE_ID = "ptdQbSiteStyle";
const QB_SITE_FILTER_ID = "ptdQbSiteFilter";
const QB_SITE_EDIT_DIALOG_ID = "ptdQbSiteEditDialog";
const QB_TORRENT_FILTER_TOOLBAR_ID = "torrentsFilterToolbar";
const QB_SITE_TAB_PREFERENCE_KEY = "ptd_selected_window_tab";

const HIDDEN_ATTR = "data-ptd-qb-hidden";
const PREVIOUS_DISPLAY_ATTR = "data-ptd-qb-previous-display";
const PREVIOUS_PRIORITY_ATTR = "data-ptd-qb-previous-display-priority";
const PREVIOUS_TOOLBAR_INVISIBLE_ATTR = "data-ptd-qb-previous-toolbar-invisible";

const SITE_COLUMNS = [
  { key: "site", label: "站点", width: "13%" },
  { key: "availability", label: "状态", width: "7%" },
  { key: "user", label: "用户", width: "10%" },
  { key: "groups", label: "分组", width: "7%" },
  { key: "offline", label: "离线", width: "5%" },
  { key: "level", label: "等级", width: "8%" },
  { key: "uploaded", label: "数据量", width: "10%" },
  { key: "trueUploaded", label: "真实数据量", width: "10%" },
  { key: "ratio", label: "分享率", width: "7%" },
  { key: "trueRatio", label: "真实分享率", width: "7%" },
  { key: "uploads", label: "发布", width: "5%" },
  { key: "leeching", label: "下载", width: "5%" },
  { key: "snatches", label: "完成", width: "5%" },
  { key: "seeding", label: "做种", width: "8%" },
  { key: "hnr", label: "H&R", width: "8%" },
  { key: "bonus", label: "积分", width: "8%" },
  { key: "bonusPerHour", label: "积分/小时", width: "8%" },
  { key: "invites", label: "邀请", width: "5%" },
  { key: "joinTime", label: "入站时间", width: "8%" },
  { key: "lastAccessAt", label: "最近访问", width: "8%" },
  { key: "updated", label: "更新时间", width: "8%" },
  { key: "action", label: "操作", width: "5%" },
] as const;

const SITE_STATUS_FILTER_OPTIONS = [
  { value: "ready", label: "已登录" },
  { value: "public", label: "公开" },
  { value: "needLogin", label: "需要登录" },
  { value: "needToken", label: "需要 Token" },
] as const;

type TSiteStatusFilterValue = (typeof SITE_STATUS_FILTER_OPTIONS)[number]["value"];

let observer: MutationObserver | undefined;
let currentTabList: HTMLElement | undefined;
let currentPageWrapper: HTMLElement | undefined;
let currentTab: HTMLLIElement | undefined;
let currentPanel: HTMLDivElement | undefined;
let currentTableBody: HTMLTableSectionElement | undefined;
let currentRefreshButton: HTMLButtonElement | undefined;
let currentSiteFilterContainer: HTMLDivElement | undefined;
let currentSiteEditDialog: HTMLDivElement | undefined;
let currentSites: ISiteBridgeCatalogItem[] = [];
let selectedSiteStatuses = new Set<TSiteStatusFilterValue>(["ready"]);
let siteSearchText = "";
let isRefreshing = false;
let rowColorPreferenceObserver: MutationObserver | undefined;
let rowColorSourceObserver: MutationObserver | undefined;
let observedRowColorSource: HTMLElement | undefined;
let isRestoringSiteTab = false;

const faviconQueue: Array<() => void> = [];
let activeFaviconRequests = 0;
const MAX_CONCURRENT_FAVICON_REQUESTS = 4;

function isQbittorrentWebUI(document: Document) {
  return Boolean(
    document.querySelector("#desktop") &&
    document.querySelector("#mainWindowTabsList") &&
    document.querySelector("#transfersTabLink") &&
    document.querySelector("#searchTabLink") &&
    document.querySelector("#pageWrapper"),
  );
}

function pumpFaviconQueue() {
  while (activeFaviconRequests < MAX_CONCURRENT_FAVICON_REQUESTS && faviconQueue.length > 0) {
    faviconQueue.shift()?.();
  }
}

function enqueueFaviconRequest(task: () => Promise<void>) {
  faviconQueue.push(async () => {
    activeFaviconRequests++;
    try {
      await task();
    } finally {
      activeFaviconRequests--;
      pumpFaviconQueue();
    }
  });
  pumpFaviconQueue();
}

function loadFavicon(siteId: TSiteID, image: HTMLImageElement) {
  const fallbackSource = chrome.runtime.getURL("icons/logo/16.png");
  image.addEventListener(
    "error",
    () => {
      image.src = fallbackSource;
    },
    { once: true },
  );

  enqueueFaviconRequest(async () => {
    try {
      const source = await sendMessage("getSiteFavicon", { site: siteId, flush: false });
      if (image.isConnected) {
        image.src = source.startsWith("/") ? chrome.runtime.getURL(source.slice(1)) : source;
      }
    } catch (error) {
      console.warn(`[PTD] Failed to load qB site favicon: ${siteId}`, error);
    }
  });
}

function rememberAndHide(element: HTMLElement) {
  if (!element.hasAttribute(HIDDEN_ATTR)) {
    element.setAttribute(HIDDEN_ATTR, "true");
    element.setAttribute(PREVIOUS_DISPLAY_ATTR, element.style.getPropertyValue("display"));
    element.setAttribute(PREVIOUS_PRIORITY_ATTR, element.style.getPropertyPriority("display"));
  }
  element.style.setProperty("display", "none", "important");
}

function restoreElement(element: HTMLElement) {
  if (!element.hasAttribute(HIDDEN_ATTR)) return;

  const previousDisplay = element.getAttribute(PREVIOUS_DISPLAY_ATTR) ?? "";
  const previousPriority = element.getAttribute(PREVIOUS_PRIORITY_ATTR) ?? "";
  if (previousDisplay) element.style.setProperty("display", previousDisplay, previousPriority);
  else element.style.removeProperty("display");

  element.removeAttribute(HIDDEN_ATTR);
  element.removeAttribute(PREVIOUS_DISPLAY_ATTR);
  element.removeAttribute(PREVIOUS_PRIORITY_ATTR);
}

function setNativePanelsVisible(visible: boolean) {
  if (!currentPageWrapper || !currentPanel) return;

  for (const child of Array.from(currentPageWrapper.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement,
  )) {
    if (child === currentPanel) continue;
    if (visible) restoreElement(child);
    else rememberAndHide(child);
  }
}

function setNativeToolbarVisible(visible: boolean) {
  const toolbar = document.getElementById(QB_TORRENT_FILTER_TOOLBAR_ID);
  if (!toolbar || !currentSiteFilterContainer) return;

  if (visible) {
    for (const child of Array.from(toolbar.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child !== currentSiteFilterContainer,
    )) {
      restoreElement(child);
    }
    currentSiteFilterContainer.style.display = "none";
    if (toolbar.getAttribute(PREVIOUS_TOOLBAR_INVISIBLE_ATTR) === "true") toolbar.classList.add("invisible");
    toolbar.removeAttribute(PREVIOUS_TOOLBAR_INVISIBLE_ATTR);
    return;
  }

  if (!toolbar.hasAttribute(PREVIOUS_TOOLBAR_INVISIBLE_ATTR)) {
    toolbar.setAttribute(PREVIOUS_TOOLBAR_INVISIBLE_ATTR, String(toolbar.classList.contains("invisible")));
  }
  toolbar.classList.remove("invisible");
  for (const child of Array.from(toolbar.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child !== currentSiteFilterContainer,
  )) {
    rememberAndHide(child);
  }
  currentSiteFilterContainer.style.display = "inline-flex";
}

function setPanelVisible(visible: boolean) {
  if (!currentPanel) return;
  currentPanel.style.setProperty("display", visible ? "flex" : "none", "important");
  currentPanel.setAttribute("aria-hidden", visible ? "false" : "true");
}

function activateSiteTab() {
  if (!currentTab || !currentPanel || !currentTabList) return;

  for (const item of Array.from(currentTabList.querySelectorAll("li"))) {
    item.classList.toggle("selected", item === currentTab);
  }
  currentTab.dataset.ptdQbActive = "true";
  currentTab.querySelector("a")?.setAttribute("aria-selected", "true");
  setNativePanelsVisible(false);
  setNativeToolbarVisible(false);
  setPanelVisible(true);
  localStorage.setItem(QB_SITE_TAB_PREFERENCE_KEY, "sites");
  renderSiteTable();
}

function deactivateSiteTab() {
  if (!currentPanel) return;
  setPanelVisible(false);
  setNativePanelsVisible(true);
  setNativeToolbarVisible(true);
  currentTab?.removeAttribute("data-ptd-qb-active");
  currentTab?.querySelector("a")?.setAttribute("aria-selected", "false");
  currentTab?.classList.remove("selected");
  if (!isRestoringSiteTab) localStorage.removeItem(QB_SITE_TAB_PREFERENCE_KEY);
}

function formatMetric(value: number | string | undefined) {
  return typeof value === "undefined" ? "-" : String(formatSize(value));
}

function formatCount(value: number | string | undefined) {
  return typeof value === "undefined" ? "-" : Intl.NumberFormat().format(Number(value));
}

function formatRatioValue(value: number | [number, number] | undefined) {
  return typeof value === "number" ? value.toFixed(2) : "-";
}

function formatBonusValue(value: number | undefined) {
  return typeof value === "undefined" ? "-" : simplifyNumber(value, " ");
}

function formatStatus(status: EResultParseStatus | undefined) {
  switch (status) {
    case EResultParseStatus.success:
      return "可用";
    case EResultParseStatus.needLogin:
      return "需要登录";
    case EResultParseStatus.parseError:
      return "解析错误";
    case EResultParseStatus.working:
      return "解析中";
    case EResultParseStatus.waiting:
      return "等待中";
    case EResultParseStatus.CFBlocked:
      return "被拦截";
    default:
      return "-";
  }
}

function formatAvailability(availability: ISiteBridgeCatalogItem["availability"]) {
  switch (availability) {
    case "ready":
      return "已登录";
    case "public":
      return "公开";
    case "needLogin":
      return "需要登录";
    case "needToken":
      return "需要 Token";
    default:
      return "-";
  }
}

function createCell(text: string, className?: string) {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

type TMetricDirection = "upload" | "download";

function createStackedCell(lines: Array<{ text: string; href?: string; direction?: TMetricDirection }>) {
  const cell = document.createElement("td");
  const content = document.createElement("div");
  content.className = "ptd-qb-stack";

  for (const line of lines) {
    const row = document.createElement("div");
    if (line.direction) {
      const marker = document.createElement("span");
      marker.className = `ptd-qb-metric-marker ptd-qb-metric-${line.direction}`;
      marker.textContent = line.direction === "upload" ? "↑" : "↓";
      marker.setAttribute("aria-hidden", "true");
      row.append(marker);
    }
    if (line.href) {
      const link = document.createElement("a");
      link.href = line.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = line.text;
      row.append(link);
    } else {
      row.append(document.createTextNode(line.text));
    }
    content.append(row);
  }

  cell.append(content);
  return cell;
}

function createSiteCell(site: ISiteBridgeCatalogItem) {
  const cell = document.createElement("td");
  const content = document.createElement("div");
  content.className = "ptd-qb-site-cell";

  const image = document.createElement("img");
  image.className = "ptd-qb-site-favicon";
  image.alt = site.name;
  image.width = 18;
  image.height = 18;
  image.src = chrome.runtime.getURL("icons/logo/16.png");
  loadFavicon(site.id, image);

  const name = document.createElement("span");
  name.textContent = site.name;
  name.title = site.name;
  content.append(image, name);

  if ((site.userInfo?.messageCount ?? 0) > 0) {
    const messageCount = document.createElement("small");
    messageCount.className = "ptd-qb-message-count";
    messageCount.textContent = `(${site.userInfo?.messageCount})`;
    content.append(messageCount);
  }

  cell.append(content);
  return cell;
}

function createUserCell(site: ISiteBridgeCatalogItem) {
  const cell = document.createElement("td");
  const content = document.createElement("div");
  content.className = "ptd-qb-user-cell";

  const name = document.createElement("span");
  name.textContent = site.userInfo?.name ?? "-";
  name.title = name.textContent;
  content.append(name);

  if (typeof site.userInfo?.id !== "undefined") {
    const id = document.createElement("small");
    id.textContent = `ID: ${site.userInfo.id}`;
    content.append(id);
  }
  cell.append(content);
  return cell;
}

function createSiteActionCell(site: ISiteBridgeCatalogItem) {
  const cell = document.createElement("td");
  const button = document.createElement("button");
  button.className = "ptd-qb-site-edit";
  button.type = "button";
  button.title = "编辑站点配置";
  button.setAttribute("aria-label", `编辑 ${site.name} 站点配置`);

  const icon = document.createElement("img");
  icon.src = "images/configure.svg";
  icon.alt = "";
  icon.width = 16;
  icon.height = 16;
  button.append(icon);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openSiteEditDialog(site.id);
  });

  cell.append(button);
  return cell;
}

function createSiteRow(site: ISiteBridgeCatalogItem, rowIndex: number) {
  const row = document.createElement("tr");
  row.dataset.siteId = site.id;
  if (rowIndex % 2 === 0) row.classList.add("ptd-qb-alt-row");
  row.append(
    createSiteCell(site),
    createCell(formatAvailability(site.availability)),
    createUserCell(site),
    createCell(site.groups?.join(", ") || "-"),
    createCell(site.isOffline ? "是" : "否"),
    createCell(site.userInfo?.levelName ?? "-"),
    createStackedCell([
      { text: formatMetric(site.userInfo?.uploaded), direction: "upload" },
      { text: formatMetric(site.userInfo?.downloaded), direction: "download" },
    ]),
    createStackedCell([
      { text: formatMetric(site.userInfo?.trueUploaded), direction: "upload" },
      { text: formatMetric(site.userInfo?.trueDownloaded), direction: "download" },
    ]),
    createCell(formatRatioValue(site.userInfo?.ratio)),
    createCell(formatRatioValue(site.userInfo?.trueRatio)),
    createCell(formatCount(site.userInfo?.uploads)),
    createCell(formatCount(site.userInfo?.leeching)),
    createStackedCell([{ text: formatCount(site.userInfo?.snatches), href: site.userInfo?.snatchesUrl }]),
    createStackedCell([
      { text: formatCount(site.userInfo?.seeding), href: site.userInfo?.seedingUrl },
      { text: formatMetric(site.userInfo?.seedingSize) },
    ]),
    createStackedCell([
      { text: `预警：${formatCount(site.userInfo?.hnrPreWarning)}` },
      { text: `未满足：${formatCount(site.userInfo?.hnrUnsatisfied)}` },
    ]),
    createStackedCell([
      { text: formatBonusValue(site.userInfo?.bonus) },
      { text: `做种：${formatBonusValue(site.userInfo?.seedingBonus)}` },
    ]),
    createStackedCell([
      { text: formatBonusValue(site.userInfo?.bonusPerHour) },
      { text: `做种：${formatBonusValue(site.userInfo?.seedingBonusPerHour)}` },
    ]),
    createCell(formatCount(site.userInfo?.invites)),
    createCell(site.userInfo?.joinTime ? formatTimeAgo(site.userInfo.joinTime) : "-"),
    createCell(site.userInfo?.lastAccessAt ? formatDate(site.userInfo.lastAccessAt) : "-"),
    createCell(
      site.userInfo?.status === EResultParseStatus.success && site.userInfo.updateAt
        ? formatTimeAgo(site.userInfo.updateAt)
        : formatStatus(site.userInfo?.status),
    ),
    createSiteActionCell(site),
  );
  return row;
}

function getVisibleSites() {
  const query = siteSearchText.trim().toLocaleLowerCase();
  const sites = query
    ? currentSites.filter((site) => {
        const searchableText = [
          site.id,
          site.name,
          site.availability,
          ...(site.groups ?? []),
          site.userInfo?.name,
          site.userInfo?.id,
        ]
          .filter((value) => typeof value !== "undefined")
          .join(" ")
          .toLocaleLowerCase();
        return searchableText.includes(query);
      })
    : currentSites;

  // 与扩展站点页保持一致：有搜索词时不受默认状态过滤限制。
  if (query || selectedSiteStatuses.size === 0) return sites;

  return sites.filter((site) => selectedSiteStatuses.has(site.availability));
}

function renderSiteTable() {
  if (!currentTableBody) return;
  currentTableBody.replaceChildren();

  if (isRefreshing) {
    currentTableBody.append(createEmptyRow("加载中…"));
    return;
  }

  const visibleSites = getVisibleSites();
  if (currentSites.length === 0) {
    currentTableBody.append(createEmptyRow("暂无已配置站点"));
    return;
  }

  if (visibleSites.length === 0) {
    currentTableBody.append(createEmptyRow("没有符合当前状态过滤条件的站点"));
    return;
  }

  visibleSites.forEach((site, index) => currentTableBody?.append(createSiteRow(site, index)));
}

function createEmptyRow(text: string) {
  const row = document.createElement("tr");
  row.append(createCell(text, "ptd-qb-site-empty"));
  row.firstElementChild?.setAttribute("colspan", String(SITE_COLUMNS.length));
  return row;
}

async function refreshSiteTable(options: { refreshUserInfo?: boolean; siteIds?: TSiteID[] } = {}) {
  const { refreshUserInfo = false, siteIds } = options;
  if (!currentTableBody || isRefreshing) return;
  isRefreshing = true;
  if (currentRefreshButton) {
    currentRefreshButton.disabled = true;
    currentRefreshButton.textContent = "刷新中…";
  }
  renderSiteTable();

  try {
    if (refreshUserInfo) {
      const sitesToRefresh = (siteIds ?? getVisibleSites().map((site) => site.id)).filter((siteId) => {
        return currentSites.find((site) => site.id === siteId)?.availability !== "public";
      });

      // 与扩展站点页的“刷新用户信息”一致：先重新解析当前显示的 private 站点，
      // 再读取目录快照。否则单纯读取 metadata 不会触发网络请求，按钮看起来就像没有反应。
      await sendMessage("ensureOffscreenDocument", undefined);
      await Promise.allSettled(sitesToRefresh.map((siteId) => sendMessage("getSiteUserInfoResult", siteId)));
    }
    currentSites = await sendMessage("getSiteBridgeCatalog", undefined);
  } catch (error) {
    console.warn("[PTD] Failed to load qB site bridge catalog", error);
    currentSites = [];
  } finally {
    isRefreshing = false;
    if (currentRefreshButton) {
      currentRefreshButton.disabled = false;
      currentRefreshButton.textContent = "刷新";
    }
    renderSiteTable();
  }
}

function closeSiteEditDialog() {
  currentSiteEditDialog?.remove();
  currentSiteEditDialog = undefined;
}

function createSiteEditSection(parent: HTMLElement, title: string) {
  const section = document.createElement("fieldset");
  section.className = "ptd-qb-site-edit-section";
  const legend = document.createElement("legend");
  legend.textContent = title;
  section.append(legend);
  parent.append(section);
  return section;
}

function appendSiteEditField(parent: HTMLElement, labelText: string, control: HTMLElement, hint?: string) {
  const row = document.createElement("div");
  row.className = "ptd-qb-site-edit-field";
  const label = document.createElement("label");
  label.textContent = labelText;
  row.append(label, control);
  if (hint) {
    const hintElement = document.createElement("small");
    hintElement.className = "ptd-qb-site-edit-hint";
    hintElement.textContent = hint;
    row.append(hintElement);
  }
  parent.append(row);
}

function appendSiteEditCheckbox(parent: HTMLElement, labelText: string, checked: boolean) {
  const row = document.createElement("label");
  row.className = "ptd-qb-site-edit-checkbox";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = checked;
  row.append(checkbox, document.createTextNode(labelText));
  parent.append(row);
  return checkbox;
}

function createSiteEditNumberInput(value: number | undefined, min: number, max: number, step: number) {
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value ?? 0);
  return input;
}

function createSiteEditTimezoneOptions(select: HTMLSelectElement, value: string) {
  for (let minutes = -720; minutes <= 720; minutes += 30) {
    const sign = minutes < 0 ? "-" : "+";
    const absoluteMinutes = Math.abs(minutes);
    const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, "0");
    const minutePart = String(absoluteMinutes % 60).padStart(2, "0");
    const offset = `${sign}${hours}${minutePart}`;
    const option = document.createElement("option");
    option.value = offset;
    option.textContent = `UTC ${sign}${hours}:${minutePart}`;
    option.selected = offset === value;
    select.append(option);
  }
}

function renderSiteEditForm(body: HTMLElement, siteMetadata: ISiteMetadata, siteConfig: ISiteUserConfig) {
  siteConfig.merge ??= {};
  siteConfig.inputSetting ??= {};

  const form = document.createElement("div");
  form.className = "ptd-qb-site-edit-form";

  const basicSection = createSiteEditSection(form, "基本信息");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = String(siteConfig.merge.name ?? siteMetadata.name ?? "");
  nameInput.addEventListener("input", () => {
    siteConfig.merge!.name = nameInput.value;
  });
  appendSiteEditField(basicSection, "站点名称", nameInput);

  const schemaInput = document.createElement("input");
  schemaInput.type = "text";
  schemaInput.value = siteMetadata.schema ?? "";
  schemaInput.disabled = true;
  appendSiteEditField(basicSection, "类型", schemaInput);

  const sortInput = createSiteEditNumberInput(siteConfig.sortIndex, 0, 999999, 1);
  sortInput.addEventListener("change", () => {
    siteConfig.sortIndex = Number(sortInput.value) || 0;
  });
  appendSiteEditField(basicSection, "排序索引", sortInput);

  const groupsInput = document.createElement("input");
  groupsInput.type = "text";
  groupsInput.value = (siteConfig.groups ?? []).join(", ");
  groupsInput.addEventListener("input", () => {
    siteConfig.groups = groupsInput.value
      .split(",")
      .map((group) => group.trim())
      .filter(Boolean);
  });
  appendSiteEditField(basicSection, "分组", groupsInput, "多个分组使用逗号分隔");

  const timezoneSelect = document.createElement("select");
  const timezone = siteConfig.merge.timezoneOffset ?? siteMetadata.timezoneOffset ?? "+0800";
  createSiteEditTimezoneOptions(timezoneSelect, timezone);
  timezoneSelect.addEventListener("change", () => {
    siteConfig.merge!.timezoneOffset = timezoneSelect.value as timezoneOffset;
  });
  appendSiteEditField(basicSection, "时区", timezoneSelect);

  const urlSection = createSiteEditSection(form, "站点地址");
  const urlSelect = document.createElement("select");
  const urls = siteMetadata.urls ?? [];
  const currentUrl = (siteConfig.url ?? urls[0] ?? "") as TSiteUrl;
  const isKnownUrl = urls.includes(currentUrl);
  for (const url of urls) {
    const option = document.createElement("option");
    option.value = url;
    option.textContent = url;
    option.selected = url === currentUrl;
    urlSelect.append(option);
  }
  const customUrlOption = document.createElement("option");
  customUrlOption.value = "__custom__";
  customUrlOption.textContent = "自定义地址";
  customUrlOption.selected = !isKnownUrl;
  urlSelect.append(customUrlOption);

  const customUrlInput = document.createElement("input");
  customUrlInput.type = "url";
  customUrlInput.value = isKnownUrl ? "" : String(currentUrl);
  customUrlInput.placeholder = "https://example.com/";
  const syncSiteUrl = () => {
    const custom = urlSelect.value === "__custom__";
    customUrlInput.disabled = !custom;
    siteConfig.url = (custom ? customUrlInput.value : urlSelect.value) as ISiteUserConfig["url"];
  };
  urlSelect.addEventListener("change", syncSiteUrl);
  customUrlInput.addEventListener("input", syncSiteUrl);
  syncSiteUrl();
  appendSiteEditField(urlSection, "使用地址", urlSelect);
  appendSiteEditField(urlSection, "自定义地址", customUrlInput);

  const inputSettings = siteMetadata.userInputSettingMeta ?? [];
  if (inputSettings.length > 0) {
    const settingSection = createSiteEditSection(form, "站点专属设置");
    for (const setting of inputSettings) {
      const input = document.createElement("input");
      input.type = /token|password|secret|key/i.test(setting.name) ? "password" : "text";
      input.value = siteConfig.inputSetting[setting.name] ?? "";
      input.placeholder = setting.required ? "必填" : "可选";
      input.addEventListener("input", () => {
        siteConfig.inputSetting![setting.name] = input.value;
      });
      appendSiteEditField(settingSection, setting.label || setting.name, input, setting.hint);
    }
  }

  const behaviorSection = createSiteEditSection(form, "行为设置");
  const offlineCheckbox = appendSiteEditCheckbox(behaviorSection, "离线模式", siteConfig.isOffline === true);
  const contentScriptCheckbox = appendSiteEditCheckbox(
    behaviorSection,
    "允许内容脚本",
    siteConfig.allowContentScript !== false,
  );
  const searchCheckbox = appendSiteEditCheckbox(behaviorSection, "允许搜索", siteConfig.allowSearch !== false);
  const userInfoCheckbox = appendSiteEditCheckbox(
    behaviorSection,
    "获取个人信息",
    siteConfig.allowQueryUserInfo !== false,
  );
  const updateBehaviorDisabledState = () => {
    siteConfig.isOffline = offlineCheckbox.checked;
    siteConfig.allowContentScript = contentScriptCheckbox.checked;
    siteConfig.allowSearch = searchCheckbox.checked;
    siteConfig.allowQueryUserInfo = userInfoCheckbox.checked;
    contentScriptCheckbox.disabled = siteMetadata.isDead === true || offlineCheckbox.checked;
    searchCheckbox.disabled =
      siteMetadata.isDead === true || offlineCheckbox.checked || !Object.hasOwn(siteMetadata, "search");
    userInfoCheckbox.disabled =
      siteMetadata.isDead === true || offlineCheckbox.checked || !Object.hasOwn(siteMetadata, "userInfo");
  };
  offlineCheckbox.addEventListener("change", updateBehaviorDisabledState);
  contentScriptCheckbox.addEventListener("change", updateBehaviorDisabledState);
  searchCheckbox.addEventListener("change", updateBehaviorDisabledState);
  userInfoCheckbox.addEventListener("change", updateBehaviorDisabledState);
  updateBehaviorDisabledState();

  const requestSection = createSiteEditSection(form, "请求设置");
  const timeoutInput = createSiteEditNumberInput(siteConfig.timeout, 0, 600000, 1000);
  timeoutInput.addEventListener("change", () => {
    siteConfig.timeout = Number(timeoutInput.value) || 0;
  });
  appendSiteEditField(requestSection, "请求超时（毫秒）", timeoutInput);

  const downloadIntervalInput = createSiteEditNumberInput(siteConfig.downloadInterval, 0, 1200, 1);
  downloadIntervalInput.addEventListener("change", () => {
    siteConfig.downloadInterval = Number(downloadIntervalInput.value) || 0;
  });
  appendSiteEditField(requestSection, "下载间隔（秒）", downloadIntervalInput);

  const uploadSpeedInput = createSiteEditNumberInput(siteConfig.uploadSpeedLimit, 0, 1024, 1);
  uploadSpeedInput.addEventListener("change", () => {
    siteConfig.uploadSpeedLimit = Number(uploadSpeedInput.value) || 0;
  });
  appendSiteEditField(requestSection, "上传速度限制（MiB/s）", uploadSpeedInput, "0 表示不限速");

  body.replaceChildren(form);
}

async function saveSiteEditConfig(siteId: TSiteID, siteConfig: ISiteUserConfig, saveButton: HTMLButtonElement) {
  saveButton.disabled = true;
  saveButton.textContent = "保存中…";
  try {
    const metadataStore = (await sendMessage("getExtStorage", "metadata")) as IMetadataPiniaStorageSchema;
    metadataStore.sites ??= {};
    delete (siteConfig as ISiteUserConfig & { valid?: boolean }).valid;
    metadataStore.sites[siteId] = siteConfig;
    if (metadataStore.siteDiscovery?.ignored) delete metadataStore.siteDiscovery.ignored[siteId];
    await sendMessage("setExtStorage", { key: "metadata", value: metadataStore });
    closeSiteEditDialog();
    await refreshSiteTable({ refreshUserInfo: true, siteIds: [siteId] });
  } catch (error) {
    console.warn(`[PTD] Failed to save qB site config: ${siteId}`, error);
    saveButton.disabled = false;
    saveButton.textContent = "保存";
  }
}

function openSiteEditDialog(siteId: TSiteID) {
  closeSiteEditDialog();

  const dialog = document.createElement("div");
  dialog.id = QB_SITE_EDIT_DIALOG_ID;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const windowElement = document.createElement("div");
  windowElement.className = "ptd-qb-site-edit-window";
  const header = document.createElement("div");
  header.className = "ptd-qb-site-edit-header";
  const title = document.createElement("strong");
  title.textContent = `编辑站点配置：${currentSites.find((site) => site.id === siteId)?.name ?? siteId}`;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "ptd-qb-site-edit-close";
  closeButton.textContent = "×";
  closeButton.title = "关闭";
  closeButton.addEventListener("click", closeSiteEditDialog);
  header.append(title, closeButton);

  const body = document.createElement("div");
  body.className = "ptd-qb-site-edit-body";
  body.textContent = "加载配置中…";

  const footer = document.createElement("div");
  footer.className = "ptd-qb-site-edit-footer";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "取消";
  cancelButton.addEventListener("click", closeSiteEditDialog);
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "primary";
  saveButton.textContent = "保存";
  saveButton.disabled = true;
  footer.append(cancelButton, saveButton);

  windowElement.append(header, body, footer);
  dialog.append(windowElement);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeSiteEditDialog();
  });
  document.body.append(dialog);
  currentSiteEditDialog = dialog;

  void (async () => {
    try {
      const metadataStore = (await sendMessage("getExtStorage", "metadata")) as IMetadataPiniaStorageSchema;
      const siteMetadata = await getDefinedSiteMetadata(siteId);
      const siteConfig = structuredClone(metadataStore.sites?.[siteId] ?? {}) as ISiteUserConfig;
      applySiteUserConfigDefaults(siteMetadata, siteConfig);
      renderSiteEditForm(body, siteMetadata, siteConfig);
      saveButton.disabled = false;
      saveButton.addEventListener("click", () => void saveSiteEditConfig(siteId, siteConfig, saveButton), {
        once: true,
      });
    } catch (error) {
      console.warn(`[PTD] Failed to load qB site config: ${siteId}`, error);
      body.textContent = "站点配置加载失败，请稍后重试。";
    }
  })();
}

function getNativeQbTable(document: Document) {
  return document.querySelector<HTMLElement>(
    "#torrentsTable, #torrentsTableFixedHeaderDiv table.dynamicTable, #transferList table.dynamicTable",
  );
}

function getNativeQbTableDiv(document: Document) {
  return document.querySelector<HTMLElement>("#torrentsTableDiv");
}

function getNativeQbRowColorSource(document: Document) {
  const nativeTableDiv = getNativeQbTableDiv(document);
  if (nativeTableDiv?.classList.contains("altRowColors")) return nativeTableDiv;

  const tableWithAltRows = Array.from(document.querySelectorAll<HTMLElement>(".dynamicTableDiv.altRowColors")).find(
    (element) => !element.closest(`#${QB_SITE_PANEL_ID}`),
  );
  if (tableWithAltRows) return tableWithAltRows;

  const nativeTable = getNativeQbTable(document);
  return (
    nativeTableDiv ??
    nativeTable?.closest<HTMLElement>(".dynamicTableDiv") ??
    document.querySelector<HTMLElement>("#transferList") ??
    document.querySelector<HTMLElement>(".altRowColors")
  );
}

function syncQbSiteTableRowColors(document: Document, tableDiv: HTMLElement) {
  const rowColorSource = getNativeQbRowColorSource(document);
  tableDiv.classList.toggle("altRowColors", rowColorSource?.classList.contains("altRowColors") === true);
}

function observeQbSiteTableRowColors(document: Document, tableDiv: HTMLElement) {
  rowColorPreferenceObserver?.disconnect();
  rowColorSourceObserver?.disconnect();
  observedRowColorSource = undefined;

  const syncAndObserveSource = () => {
    const rowColorSource = getNativeQbRowColorSource(document) ?? undefined;
    if (rowColorSource === observedRowColorSource) {
      syncQbSiteTableRowColors(document, tableDiv);
      return;
    }

    observedRowColorSource = rowColorSource;
    rowColorPreferenceObserver?.disconnect();
    rowColorPreferenceObserver = undefined;
    syncQbSiteTableRowColors(document, tableDiv);
    if (!rowColorSource) return;

    rowColorPreferenceObserver = new MutationObserver(() => {
      syncQbSiteTableRowColors(document, tableDiv);
    });
    rowColorPreferenceObserver.observe(rowColorSource, {
      attributes: true,
      attributeFilter: ["class"],
    });
  };

  syncAndObserveSource();

  // qB may create or replace the native table after the content script has
  // injected the site panel. Re-resolve the host so a late altRowColors class
  // cannot leave the injected table permanently stuck on its base background.
  const sourceDiscoveryRoot = document.querySelector<HTMLElement>("#pageWrapper") ?? document.documentElement;
  rowColorSourceObserver = new MutationObserver(syncAndObserveSource);
  rowColorSourceObserver.observe(sourceDiscoveryRoot, {
    childList: true,
    subtree: true,
  });
}

function ensureQbittorrentStyle(document: Document) {
  if (document.getElementById(QB_SITE_STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = QB_SITE_STYLE_ID;
  style.textContent = `
    #${QB_SITE_PANEL_ID} {
      box-sizing: border-box;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      padding: 0;
      background-color: var(--color-background-primary, transparent);
      color: var(--color-text-default, inherit);
      flex-direction: column;
    }
    #${QB_SITE_PANEL_ID} > .dynamicTableDiv {
      min-height: 0;
      width: 100%;
    }
    #${QB_SITE_PANEL_ID} > .dynamicTableDiv,
    #${QB_SITE_PANEL_ID} table.dynamicTable,
    #${QB_SITE_PANEL_ID} table.dynamicTable tbody {
      background-color: var(--color-background-primary, transparent);
      color: var(--color-text-default, inherit);
    }
    #${QB_SITE_PANEL_ID} > .dynamicTableDiv.altRowColors tbody tr:nth-child(odd of :not(.invisible)) {
      background-color: var(--color-background-default);
    }
    #${QB_SITE_PANEL_ID} > .dynamicTableDiv.altRowColors tbody tr.ptd-qb-alt-row:not(:hover, .selected) {
      background-color: var(--color-background-default);
    }
    #${QB_SITE_PANEL_ID} table.dynamicTable {
      min-width: 1800px;
      table-layout: fixed;
      width: 100%;
    }
    #${QB_SITE_PANEL_ID} .ptd-qb-stack {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    #${QB_SITE_PANEL_ID} .ptd-qb-stack > div {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #${QB_SITE_PANEL_ID} .ptd-qb-metric-marker {
      display: inline-block;
      font-weight: 700;
      margin-right: 4px;
      width: 1em;
    }
    #${QB_SITE_PANEL_ID} .ptd-qb-metric-upload {
      color: var(--color-text-green, #008c00);
    }
    #${QB_SITE_PANEL_ID} .ptd-qb-metric-download {
      color: var(--color-text-red, #d33);
    }
    #${QB_SITE_PANEL_ID} .ptd-qb-message-count {
      color: var(--color-text-red, inherit);
      flex: 0 0 auto;
    }
    #${QB_SITE_PANEL_ID} .ptd-qb-site-cell,
    #${QB_SITE_PANEL_ID} .ptd-qb-user-cell {
      align-items: center;
      display: flex;
      gap: 6px;
      min-width: 0;
      width: 100%;
    }
    #${QB_SITE_PANEL_ID} .ptd-qb-site-cell span,
    #${QB_SITE_PANEL_ID} .ptd-qb-user-cell span {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #${QB_SITE_PANEL_ID} .ptd-qb-site-favicon {
      flex: 0 0 auto;
      filter: none !important;
      height: 18px;
      object-fit: contain;
      width: 18px;
    }
    #${QB_SITE_PANEL_ID} table.dynamicTable tr:is(:hover, .selected) img.ptd-qb-site-favicon {
      filter: none !important;
    }
    #${QB_SITE_PANEL_ID} .ptd-qb-user-cell {
      align-items: flex-start;
      flex-direction: column;
      gap: 0;
    }
    #${QB_SITE_PANEL_ID} .ptd-qb-user-cell small {
      color: var(--color-text-disabled, inherit);
      font-size: .85em;
    }
    #${QB_SITE_PANEL_ID} table.dynamicTable tbody tr:is(:hover, .selected) .ptd-qb-user-cell small {
      color: inherit;
      opacity: .8;
    }
    #${QB_SITE_PANEL_ID} .ptd-qb-site-empty {
      color: var(--color-text-disabled, inherit);
      text-align: center;
    }
    #${QB_SITE_PANEL_ID} .ptd-qb-site-edit {
      align-items: center;
      background: transparent;
      border: 0;
      color: var(--color-text-default, inherit);
      cursor: pointer;
      display: inline-flex;
      justify-content: center;
      padding: 3px;
    }
    #${QB_SITE_PANEL_ID} .ptd-qb-site-edit img {
      filter: none !important;
      height: 16px;
      width: 16px;
    }
    #${QB_SITE_PANEL_ID} .ptd-qb-site-edit:hover {
      background: var(--color-background-hover);
    }
    #${QB_SITE_EDIT_DIALOG_ID} {
      align-items: center;
      background: rgb(0 0 0 / 45%);
      display: flex;
      inset: 0;
      justify-content: center;
      position: fixed;
      z-index: 10000;
    }
    #${QB_SITE_EDIT_DIALOG_ID} .ptd-qb-site-edit-window {
      background: var(--color-background-primary, #fff);
      border: 1px solid var(--color-border-default);
      box-shadow: 0 8px 28px rgb(0 0 0 / 45%);
      color: var(--color-text-default, #111);
      display: flex;
      flex-direction: column;
      max-height: calc(100vh - 32px);
      width: min(780px, calc(100vw - 32px));
    }
    #${QB_SITE_EDIT_DIALOG_ID} .ptd-qb-site-edit-header {
      align-items: center;
      background: var(--color-background-default, #eee);
      border-bottom: 1px solid var(--color-border-default);
      display: flex;
      flex: 0 0 auto;
      justify-content: space-between;
      min-height: 34px;
      padding: 4px 8px;
    }
    #${QB_SITE_EDIT_DIALOG_ID} .ptd-qb-site-edit-close {
      background: transparent;
      border: 0;
      color: inherit;
      cursor: pointer;
      font-size: 22px;
      line-height: 1;
      padding: 1px 5px;
    }
    #${QB_SITE_EDIT_DIALOG_ID} .ptd-qb-site-edit-body {
      overflow: auto;
      padding: 10px;
    }
    #${QB_SITE_EDIT_DIALOG_ID} .ptd-qb-site-edit-form {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    #${QB_SITE_EDIT_DIALOG_ID} .ptd-qb-site-edit-section {
      border: 1px solid var(--color-border-default);
      margin: 0;
      padding: 8px 10px 10px;
    }
    #${QB_SITE_EDIT_DIALOG_ID} .ptd-qb-site-edit-section legend {
      padding: 0 5px;
    }
    #${QB_SITE_EDIT_DIALOG_ID} .ptd-qb-site-edit-field {
      align-items: center;
      display: grid;
      gap: 8px;
      grid-template-columns: minmax(150px, 190px) minmax(0, 1fr);
      margin: 5px 0;
    }
    #${QB_SITE_EDIT_DIALOG_ID} .ptd-qb-site-edit-field > label {
      overflow-wrap: anywhere;
    }
    #${QB_SITE_EDIT_DIALOG_ID} .ptd-qb-site-edit-field > input,
    #${QB_SITE_EDIT_DIALOG_ID} .ptd-qb-site-edit-field > select {
      background: var(--color-background-default, #fff);
      box-sizing: border-box;
      color: var(--color-text-default, inherit);
      display: block;
      min-width: 0;
      padding: 3px 5px;
      position: static;
      width: 100%;
    }
    #${QB_SITE_EDIT_DIALOG_ID} .ptd-qb-site-edit-field > select {
      display: block;
    }
    #${QB_SITE_EDIT_DIALOG_ID} .ptd-qb-site-edit-hint {
      color: var(--color-text-disabled, inherit);
      grid-column: 2;
    }
    #${QB_SITE_EDIT_DIALOG_ID} .ptd-qb-site-edit-checkbox {
      align-items: center;
      display: flex;
      gap: 7px;
      margin: 6px 0;
    }
    #${QB_SITE_EDIT_DIALOG_ID} .ptd-qb-site-edit-checkbox input {
      margin: 0;
    }
    #${QB_SITE_EDIT_DIALOG_ID} .ptd-qb-site-edit-footer {
      border-top: 1px solid var(--color-border-default);
      display: flex;
      flex: 0 0 auto;
      gap: 8px;
      justify-content: flex-end;
      padding: 8px;
    }
    #${QB_SITE_EDIT_DIALOG_ID} .ptd-qb-site-edit-footer button {
      background: var(--color-background-default, #eee);
      border: 1px solid var(--color-border-default);
      color: var(--color-text-default, inherit);
      cursor: pointer;
      padding: 3px 10px;
    }
    #${QB_SITE_EDIT_DIALOG_ID} .ptd-qb-site-edit-footer button.primary {
      background: var(--color-accent-blue, #1976d2);
      color: var(--color-text-white, #fff);
    }
    #${QB_SITE_EDIT_DIALOG_ID} .ptd-qb-site-edit-footer button:disabled {
      cursor: wait;
      opacity: .6;
    }
    #${QB_TORRENT_FILTER_TOOLBAR_ID} .ptd-qb-site-filter-toolbar {
      align-items: center;
      display: inline-flex;
      gap: 4px;
      margin-left: 8px;
      vertical-align: top;
    }
    #${QB_TORRENT_FILTER_TOOLBAR_ID} .ptd-qb-site-filter-label {
      white-space: nowrap;
    }
    #${QB_TORRENT_FILTER_TOOLBAR_ID} .ptd-qb-site-text-filter {
      background-color: var(--color-background-default);
      background-image: url("images/edit-find.svg");
      background-position: 2px;
      background-repeat: no-repeat;
      background-size: 1.5em;
      border: 1px solid var(--color-border-default);
      border-radius: 3px;
      color: var(--color-text-default, inherit);
      font: inherit;
      min-width: 170px;
      padding: 2px 2px 2px 25px;
    }
    #${QB_TORRENT_FILTER_TOOLBAR_ID} .ptd-qb-site-status-filter {
      background: var(--color-background-default, transparent);
      border: 1px solid var(--color-border-default);
      border-radius: 3px;
      color: var(--color-text-default, inherit);
      font: inherit;
      height: 22px;
      min-width: 170px;
    }
    #${QB_TORRENT_FILTER_TOOLBAR_ID} .ptd-qb-site-refresh {
      background: transparent;
      border: 1px solid var(--color-border-default);
      border-radius: 3px;
      color: var(--color-text-default, inherit);
      cursor: pointer;
      font: inherit;
      height: 22px;
      padding: 1px 8px;
    }
    #${QB_TORRENT_FILTER_TOOLBAR_ID} .ptd-qb-site-refresh:disabled {
      cursor: wait;
      opacity: .6;
    }
  `;
  document.head.append(style);
}

function createSiteFilterToolbar(document: Document, toolbar: HTMLElement) {
  const container = document.createElement("div");
  container.id = QB_SITE_FILTER_ID;
  container.className = "ptd-qb-site-filter-toolbar";
  container.style.display = "none";

  const searchInput = document.createElement("input");
  searchInput.className = "ptd-qb-site-text-filter";
  searchInput.type = "search";
  searchInput.placeholder = "过滤站点列表…";
  searchInput.title = "按站点名称、站点 ID、分组或用户名过滤";
  searchInput.setAttribute("aria-label", "过滤站点列表");
  searchInput.value = siteSearchText;
  searchInput.addEventListener("input", () => {
    siteSearchText = searchInput.value;
    renderSiteTable();
  });

  const filterLabel = document.createElement("label");
  filterLabel.className = "ptd-qb-site-filter-label";
  filterLabel.textContent = "过滤依据：";

  const statusFilter = document.createElement("select");
  statusFilter.className = "ptd-qb-site-status-filter";
  statusFilter.multiple = true;
  statusFilter.size = 1;
  statusFilter.title = "可按住 Ctrl/⌘ 多选状态；取消所有选项显示全部站点";
  statusFilter.setAttribute("aria-label", "站点状态过滤");
  for (const optionConfig of SITE_STATUS_FILTER_OPTIONS) {
    const option = document.createElement("option");
    option.value = optionConfig.value;
    option.textContent = optionConfig.label;
    option.selected = selectedSiteStatuses.has(optionConfig.value);
    statusFilter.append(option);
  }
  filterLabel.htmlFor = statusFilter.id = `${QB_SITE_FILTER_ID}-status-filter`;
  statusFilter.addEventListener("change", () => {
    selectedSiteStatuses = new Set(
      Array.from(statusFilter.selectedOptions, (option) => option.value as TSiteStatusFilterValue),
    );
    renderSiteTable();
  });

  const refreshButton = document.createElement("button");
  refreshButton.className = "ptd-qb-site-refresh";
  refreshButton.type = "button";
  refreshButton.textContent = "刷新";
  refreshButton.addEventListener("click", () => void refreshSiteTable({ refreshUserInfo: true }));

  container.append(searchInput, filterLabel, statusFilter, refreshButton);
  toolbar.append(container);
  currentSiteFilterContainer = container;
  currentRefreshButton = refreshButton;
}

function createSitePanel(document: Document, pageWrapper: HTMLElement) {
  const panel = document.createElement("div");
  panel.id = QB_SITE_PANEL_ID;
  panel.setAttribute("aria-label", "PT Depiler 站点");
  panel.setAttribute("aria-hidden", "true");
  panel.style.display = "none";
  panel.style.height = "100%";
  panel.style.inset = "0";
  panel.style.position = "absolute";
  panel.style.width = "100%";
  panel.style.zIndex = "100";

  const tableDiv = document.createElement("div");
  tableDiv.className = "dynamicTableDiv";
  const table = document.createElement("table");
  table.id = QB_SITE_TABLE_ID;
  table.className = "dynamicTable unselectable";

  const colgroup = document.createElement("colgroup");
  for (const column of SITE_COLUMNS) {
    const col = document.createElement("col");
    col.style.width = column.width;
    colgroup.append(col);
  }
  table.append(colgroup);

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  headerRow.className = "dynamicTableHeader";
  for (const column of SITE_COLUMNS) {
    const header = document.createElement("th");
    header.textContent = column.label;
    header.scope = "col";
    header.title = column.label;
    headerRow.append(header);
  }
  thead.append(headerRow);
  table.append(thead);

  currentTableBody = document.createElement("tbody");
  table.append(currentTableBody);
  tableDiv.append(table);
  panel.append(tableDiv);
  pageWrapper.append(panel);

  currentPanel = panel;
  observeQbSiteTableRowColors(document, tableDiv);
  renderSiteTable();
  return panel;
}

function restoreExistingBridge(document: Document, pageWrapper: HTMLElement) {
  setNativeToolbarVisible(true);
  rowColorPreferenceObserver?.disconnect();
  rowColorPreferenceObserver = undefined;
  rowColorSourceObserver?.disconnect();
  rowColorSourceObserver = undefined;
  observedRowColorSource = undefined;
  for (const element of Array.from(pageWrapper.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`))) {
    restoreElement(element);
  }
  const toolbar = document.getElementById(QB_TORRENT_FILTER_TOOLBAR_ID);
  if (toolbar) restoreElement(toolbar);
  currentSiteFilterContainer?.remove();
  currentSiteFilterContainer = undefined;
  currentRefreshButton = undefined;
  document.getElementById(QB_SITE_TAB_ID)?.remove();
  document.getElementById(QB_SITE_PANEL_ID)?.remove();
}

function ensureQbittorrentBridge(document: Document) {
  if (!isQbittorrentWebUI(document)) return;

  const tabList = document.querySelector<HTMLElement>("#mainWindowTabsList");
  const pageWrapper = document.querySelector<HTMLElement>("#pageWrapper");
  if (!tabList || !pageWrapper) return;

  if (
    currentTab?.isConnected &&
    currentPanel?.isConnected &&
    currentTabList === tabList &&
    currentPageWrapper === pageWrapper
  ) {
    if (currentTab.dataset.ptdQbActive === "true") setNativePanelsVisible(false);
    return;
  }

  restoreExistingBridge(document, pageWrapper);
  ensureQbittorrentStyle(document);

  const toolbar = document.getElementById(QB_TORRENT_FILTER_TOOLBAR_ID);
  if (toolbar) createSiteFilterToolbar(document, toolbar);

  const tab = document.createElement("li");
  tab.id = QB_SITE_TAB_ID;
  tab.dataset.ptdQbSiteTab = "true";
  const tabAnchor = document.createElement("a");
  tabAnchor.href = "#";
  tabAnchor.setAttribute("role", "tab");
  tabAnchor.setAttribute("aria-selected", "false");
  tabAnchor.textContent = "站点";
  tab.append(tabAnchor);

  const panel = createSitePanel(document, pageWrapper);
  currentTabList = tabList;
  currentPageWrapper = pageWrapper;
  currentTab = tab;

  const handleSiteTabClick = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    activateSiteTab();
  };
  tab.addEventListener("click", handleSiteTabClick, true);
  tabAnchor.addEventListener("click", handleSiteTabClick, true);
  tabList.append(tab);

  tabList.addEventListener(
    "click",
    (event) => {
      const target = (event.target as Element | null)?.closest("li");
      if (target && target !== tab) deactivateSiteTab();
    },
    true,
  );

  if (panel !== currentPanel) currentPanel = panel;
  void refreshSiteTable();
}

function restoreSelectedSiteTab() {
  if (localStorage.getItem(QB_SITE_TAB_PREFERENCE_KEY) !== "sites" || !currentTab?.isConnected) return;

  isRestoringSiteTab = true;
  activateSiteTab();
  queueMicrotask(() => {
    isRestoringSiteTab = false;
  });
}

export function setupQbittorrentBridge(document: Document) {
  const ensure = () => ensureQbittorrentBridge(document);
  ensure();
  document.addEventListener("DOMContentLoaded", ensure, { once: true });

  if (document.readyState === "complete") {
    setTimeout(restoreSelectedSiteTab, 0);
  } else {
    window.addEventListener("load", restoreSelectedSiteTab, { once: true });
  }

  observer?.disconnect();
  observer = new MutationObserver(ensure);
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { watchDebounced } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { isUndefined } from "es-toolkit/compat";
import type { DataTableHeader } from "vuetify";
import {
  applySiteUserConfigDefaults,
  definitionList,
  EResultParseStatus,
  getDefinedSiteMetadata,
  type ISiteMetadata,
  type ISiteUserConfig,
  type IUserInfo,
  type TSiteID,
} from "@ptd/site";

import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useTableCustomFilter } from "@/options/directives/useAdvanceFilter.ts";
import { formatDate, formatSize, formatTimeAgo } from "@/options/utils.ts";

import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import ResultParseStatus from "@/options/components/ResultParseStatus.vue";
import EditDialog from "../../Settings/SetSite/EditDialog.vue";
import EditSearchEntryList from "../../Settings/SetSite/EditSearchEntryList.vue";
import UserLevelRequirementsTd from "./UserLevelRequirementsTd.vue";
import HistoryDataViewDialog from "./HistoryDataViewDialog.vue";
import BonusFormatSpan from "./BonusFormatSpan.vue";
import ExportUserInfoDialog from "./ExportUserInfoDialog.vue";

import { formatRatio } from "./utils/format.ts";
import {
  initTableData,
  cancelFlushSiteLastUserInfo,
  flushSiteLastUserInfo,
  perSiteLastUserData,
} from "./utils/lastUserData.ts";

const { t } = useI18n();
const router = useRouter();
const configStore = useConfigStore();
const runtimeStore = useRuntimeStore();
const metadataStore = useMetadataStore();

const currentDate = new Date();

type TExtendDataTableHeader = DataTableHeader & { props?: any };

type TSiteAvailability = "ready" | "needLogin" | "needToken" | "notDiscovered";

interface ISiteCatalogItem extends Partial<IUserInfo> {
  site: TSiteID;
  metadata: ISiteMetadata;
  siteName: string;
  siteUserConfig: ISiteUserConfig;
  availability: TSiteAvailability;
  isConfigured: boolean;
  selectable: boolean;
}

const fullTableHeader = reactive([
  {
    title: t("common.site"),
    key: "siteUserConfig.sortIndex",
    align: "center",
    props: { disabled: true },
  },
  { title: t("MyData.table.siteStatus"), key: "availability", align: "center", sortable: false },
  { title: t("common.username"), key: "name", align: "center" },
  { title: t("SetSite.common.groups"), key: "siteUserConfig.groups", align: "left", sortable: false },
  { title: t("SetSite.common.isOffline"), key: "siteUserConfig.isOffline", align: "center" },
  { title: t("SetSite.common.allowSearch"), key: "siteUserConfig.allowSearch", align: "center" },
  {
    title: t("SetSite.common.allowQueryUserInfo"),
    key: "siteUserConfig.allowQueryUserInfo",
    align: "center",
  },
  { title: t("MyData.table.levelName"), key: "levelName", align: "start", width: "15%" },
  // NOTE: 这里将key设为 uploaded, trueUploaded 而不是虚拟的 userData，可以让 v-data-table 使用 uploaded 的进行排序
  { title: t("MyData.table.userData"), key: "uploaded", align: "end" },
  { title: t("MyData.table.trueUserData"), key: "trueUploaded", align: "end" }, // 默认不显示
  { title: t("levelRequirement.ratio"), key: "ratio", align: "end" },
  { title: t("levelRequirement.trueRatio"), key: "trueRatio", align: "end" }, // 默认不显示
  { title: t("levelRequirement.uploads"), key: "uploads", align: "end" },
  { title: t("levelRequirement.seeding"), key: "seeding", align: "end" },
  { title: t("levelRequirement.seedingSize"), key: "seedingSize", align: "end" },
  { title: t("levelRequirement.bonus"), key: "bonus", align: "end" },
  { title: t("levelRequirement.bonusPerHour"), key: "bonusPerHour", align: "end" },
  { title: t("MyData.table.invites"), key: "invites", align: "end" }, // 默认不显示
  { title: t("MyData.table.joinTime"), key: "joinTime", align: "center" },
  { title: t("MyData.table.lastAccessAt"), key: "lastAccessAt", align: "center" }, // 默认不显示
  { title: t("MyData.table.updateAt"), key: "updateAt", align: "center" },
  { title: t("common.action"), key: "action", align: "center", sortable: false, props: { disabled: true } },
] as TExtendDataTableHeader[]);

const tableHeader = computed(() => {
  return fullTableHeader.filter(
    (item: TExtendDataTableHeader) =>
      item?.props?.disabled || configStore.tableBehavior.MyData.columns!.includes(item.key!),
  ) as DataTableHeader[];
});

const tableNonBooleanControlKey = [
  "joinTimeFormat",
  // Deprecated
  "joinTimeWeekOnly",
];
const tableControlHiddenKeys = ["showPublicSites"];

// 过滤出表格控制中非布尔类型的键
const filteredTableBooleanControlKeys = computed(() => {
  return Object.keys(configStore.myDataTableControl).filter(
    (key) => tableNonBooleanControlKey.indexOf(key) === -1 && !tableControlHiddenKeys.includes(key),
  ) as (keyof typeof configStore.myDataTableControl)[];
});

const siteCatalogData = ref<ISiteCatalogItem[]>([]);
const isSiteCatalogLoading = ref(false);

function hasRequiredSiteInput(siteMetadata: ISiteMetadata, siteUserConfig: ISiteUserConfig) {
  const requiredInputs = (siteMetadata.userInputSettingMeta ?? []).filter((item) => item.required);
  return requiredInputs.every((item) => Boolean(siteUserConfig.inputSetting?.[item.name]?.trim()));
}

function getSiteAvailability(
  siteMetadata: ISiteMetadata,
  siteUserConfig: ISiteUserConfig | undefined,
  userInfo: Partial<IUserInfo>,
  hasAccess: boolean | undefined,
): TSiteAvailability {
  const requiresManualInput = (siteMetadata.userInputSettingMeta?.length ?? 0) > 0;
  if (requiresManualInput && (!siteUserConfig || !hasRequiredSiteInput(siteMetadata, siteUserConfig))) {
    return "needToken";
  }

  if (!siteUserConfig) {
    return "notDiscovered";
  }

  if (userInfo.status === EResultParseStatus.needLogin) {
    return "needLogin";
  }

  if (siteMetadata.type === "private") {
    // Cookie 只能说明浏览器存在相关站点 Cookie，只有用户信息成功解析才代表站点当前可用。
    if (hasAccess !== true || userInfo.status !== EResultParseStatus.success) {
      return "notDiscovered";
    }
  }

  return "ready";
}

async function loadSiteCatalog() {
  isSiteCatalogLoading.value = true;
  try {
    const rows = await Promise.all(
      (definitionList as TSiteID[]).map(async (siteId) => {
        try {
          const metadata = await getDefinedSiteMetadata(siteId);
          const storedConfig = metadataStore.sites[siteId];
          const siteUserConfig = storedConfig ?? applySiteUserConfigDefaults(metadata);
          const userInfo = metadataStore.lastUserInfo[siteId] ?? {};
          const cachedUserData = perSiteLastUserData.value[siteId] ?? {};
          const availability = getSiteAvailability(
            metadata,
            storedConfig,
            userInfo,
            metadataStore.siteDiscovery?.available?.[siteId],
          );

          return {
            ...cachedUserData,
            ...userInfo,
            site: siteId,
            metadata,
            siteName: siteUserConfig.merge?.name ?? metadata.name,
            siteUserConfig,
            availability,
            isConfigured: Boolean(storedConfig),
            selectable: Boolean(storedConfig) && metadata.type === "private" && !siteUserConfig.isOffline,
          } as ISiteCatalogItem;
        } catch (error) {
          console.warn(`[PT Depiler] Failed to load site catalog entry: ${siteId}`, error);
          return undefined;
        }
      }),
    );

    siteCatalogData.value = rows.filter((item): item is ISiteCatalogItem => item !== undefined);
  } finally {
    isSiteCatalogLoading.value = false;
  }
}

const {
  tableWaitFilterRef,
  tableFilterRef,
  tableFilterFn,
  advanceFilterDictRef,
  updateTableFilterValueFn,
  buildFilterDictFn,
  toggleKeywordStateFn,
} = useTableCustomFilter<ISiteCatalogItem>({
  parseOptions: {
    keywords: ["site", "status", "availability", "siteUserConfig.groups"],
    ranges: ["updateAt", "messageCount"],
  },
  titleFields: ["site", "siteName", "metadata.name", "metadata.aka", "metadata.urls"],
  format: {
    status: "number",
  },
});

const tableSelected = ref<TSiteID[]>([]); // 选中的站点行

const visibleSiteCatalogData = computed(() => {
  // 空搜索时隐藏未发现/未登录/未配置 Token 的站点；有搜索词时展示所有匹配定义。
  if (tableFilterRef.value.trim()) {
    return siteCatalogData.value;
  }
  return siteCatalogData.value.filter(
    (item) =>
      item.availability === "ready" &&
      (configStore.myDataTableControl.showPublicSites || item.metadata.type !== "public"),
  );
});

// 站点目录和用户数据并行初始化；站点发现只在后台执行，不阻塞首屏。
onMounted(() => {
  void Promise.all([loadSiteCatalog(), initTableData()]);
  void metadataStore.discoverSites({ force: true }).then(async () => {
    await Promise.all([loadSiteCatalog(), initTableData()]);
  });
});

// 监听用户信息变化（ offscreen 直接定时刷新的情况 ）
watchDebounced(
  () => metadataStore.lastUserInfo,
  () => {
    // 此时前端并没有进行刷新，强制更新
    if (!Object.values(runtimeStore.userInfo.flushPlan).some((isFlushing) => isFlushing)) {
      initTableData();
      void loadSiteCatalog();
    }
  },
  { debounce: 5e3, deep: true },
);

const showHistoryDataViewDialog = ref<boolean>(false);
const historyDataViewDialogSiteId = ref<TSiteID | null>(null);
const showEditDialog = ref(false);
const toEditId = ref<TSiteID | null>(null);

function viewHistoryData(siteId: TSiteID) {
  showHistoryDataViewDialog.value = true;
  historyDataViewDialogSiteId.value = siteId;
}

function editSite(siteId: TSiteID) {
  toEditId.value = siteId;
  showEditDialog.value = true;
}

function getCatalogUserInfo(item: ISiteCatalogItem): IUserInfo | undefined {
  return typeof item.status === "undefined" ? undefined : (item as IUserInfo);
}

async function multiOpen() {
  for (const siteId of tableSelected.value) {
    const siteUrl = await metadataStore.getSiteUrl(siteId);
    if (siteUrl) {
      window.open(siteUrl, "_blank", "noopener noreferrer");
    }
  }
}

async function openSite(siteId: TSiteID) {
  const siteUrl = await metadataStore.getSiteUrl(siteId);
  if (siteUrl) {
    window.open(siteUrl, "_blank", "noopener noreferrer");
  }
}

async function multiFlush() {
  let flushSiteIds: TSiteID[] = tableSelected.value;
  if (flushSiteIds.length === 0) {
    flushSiteIds = siteCatalogData.value.filter((item) => item.selectable).map((item) => item.site);
    runtimeStore.showSnakebar(t("MyData.index.noSiteSelectedRefreshAll"), { color: "info" });
  }

  if (flushSiteIds.length > 0) {
    flushSiteLastUserInfo(flushSiteIds);
  } else {
    runtimeStore.showSnakebar(t("MyData.index.noSiteSelectedCancelRefresh"), { color: "warning" });
  }
}

function viewTimeline() {
  router.push({
    name: "UserDataTimeline",
    query: {
      sites: tableSelected.value,
    },
  });
}

function viewStatistic() {
  router.push({
    name: "UserDataStatistic",
    query: {
      sites: tableSelected.value,
    },
  });
}

const showExportDialog = ref(false);

watch(showEditDialog, (isOpen, wasOpen) => {
  if (wasOpen && !isOpen) {
    void Promise.all([loadSiteCatalog(), initTableData()]);
  }
});
</script>

<template>
  <v-card>
    <v-card-title>
      <v-row class="ma-0">
        <!-- 刷新，取消刷新 -->
        <v-btn
          v-if="runtimeStore.isUserInfoFlush"
          color="red"
          icon="mdi-cancel"
          :title="t('MyData.index.flushCancel')"
          variant="text"
          @click="cancelFlushSiteLastUserInfo"
        />

        <v-btn
          v-else
          color="green"
          icon="mdi-cached"
          :title="t('MyData.index.flushSelectSite')"
          variant="text"
          @click="multiFlush"
        />

        <v-btn
          :disabled="tableSelected.length === 0"
          color="indigo"
          icon="mdi-open-in-new"
          :title="t('MyData.index.multiOpen')"
          variant="text"
          @click="multiOpen"
        />

        <v-switch
          v-model="configStore.myDataTableControl.showPublicSites"
          :label="t('MyData.index.showPublicSites')"
          class="ml-2"
          color="success"
          density="compact"
          hide-details
          @update:model-value="() => configStore.$save()"
        />

        <v-divider class="mx-2" vertical />

        <v-btn
          color="green"
          icon="mdi-chart-timeline-variant"
          :title="t('MyData.index.viewTimeline')"
          variant="text"
          @click="viewTimeline"
        />
        <v-btn
          color="green"
          icon="mdi-equalizer"
          :title="t('MyData.index.viewStatistic')"
          variant="text"
          @click="viewStatistic"
        />

        <v-divider class="mx-2" vertical />

        <!-- 导出按钮 -->
        <v-btn
          color="orange-darken-3"
          icon="mdi-export"
          :title="t('MyData.index.exportData')"
          variant="text"
          @click="showExportDialog = true"
        />

        <v-divider class="mx-2" vertical />

        <v-menu :close-on-content-clicks="false">
          <template v-slot:activator="{ props }">
            <v-btn v-bind="props" color="blue" icon="mdi-cog" :title="t('MyData.index.setting')" variant="text" />
          </template>
          <v-list>
            <!-- 入站时间显示 -->
            <v-list-item>
              <template v-slot:prepend>
                <v-list-item-action start class="ml-2">
                  <v-icon icon="mdi-calendar-account" class="mr-2" />
                  <span class="text-subtitle-2">{{ t("MyData.index.joinTimeFormat") }}</span>
                </v-list-item-action>
              </template>

              <v-btn-toggle
                v-model="configStore.myDataTableControl.joinTimeFormat"
                density="compact"
                hide-details
                class="ml-2"
                @click.stop
                @update:model-value="() => configStore.$save()"
              >
                <v-btn
                  v-for="type in ['alive', 'aliveWeek', 'added']"
                  :key="type"
                  :value="type"
                  :title="t(`MyData.index.joinTimeFormatOptions.${type}`)"
                  density="compact"
                  hide-details
                >
                  {{ t(`MyData.index.joinTimeFormatOptions.${type}`) }}
                </v-btn>
              </v-btn-toggle>
            </v-list-item>

            <v-divider />

            <!-- 其他开关控制 -->
            <v-list-item v-for="index in filteredTableBooleanControlKeys" :key="index" :value="index">
              <template v-slot:prepend>
                <v-list-item-action start class="ml-2">
                  <v-switch
                    v-model="configStore.myDataTableControl[index]"
                    :label="`&nbsp;${t('MyData.index.' + index)}`"
                    color="success"
                    density="compact"
                    hide-details
                    @click.stop
                    @update:model-value="() => configStore.$save()"
                  />
                </v-list-item-action>
              </template>
            </v-list-item>
          </v-list>
        </v-menu>

        <v-combobox
          v-model="configStore.tableBehavior.MyData.columns"
          :items="fullTableHeader"
          :return-object="false"
          chips
          class="table-header-filter-clear"
          density="compact"
          hide-details
          item-value="key"
          max-width="200"
          multiple
          prepend-inner-icon="mdi-filter-cog"
          @update:model-value="(v) => configStore.updateTableBehavior('MyData', 'columns', v)"
        >
          <template #chip="{ item, index }">
            <v-chip v-if="index === 0">
              <span>{{ item.title }}</span>
            </v-chip>
            <span v-if="index === 1" class="text-grey caption">
              (+{{ configStore.tableBehavior.MyData.columns!.length - 1 }})
            </span>
          </template>
        </v-combobox>

        <v-spacer />

        <v-text-field
          v-model="tableWaitFilterRef"
          append-icon="mdi-magnify"
          clearable
          density="compact"
          hide-details
          :label="t('common.search')"
          max-width="500"
          single-line
          @click:clear="buildFilterDictFn('')"
        >
          <template #prepend-inner>
            <v-menu min-width="100">
              <template v-slot:activator="{ props }">
                <v-icon v-bind="props" icon="mdi-filter" variant="plain" />
              </template>
              <v-list class="pa-0">
                <v-list-item-subtitle class="ma-2">
                  {{ t("MyData.index.siteStatus") }}
                </v-list-item-subtitle>

                <v-list-item
                  :title="t('MyData.index.filter.todayNotUpdated')"
                  @click.stop="
                    () => {
                      advanceFilterDictRef.updateAt = ['', formatDate(currentDate, 'yyyyMMdd')];
                      updateTableFilterValueFn();
                    }
                  "
                />

                <v-list-item
                  :title="t('MyData.index.filter.lastUpdateError')"
                  @click.stop="
                    () => {
                      advanceFilterDictRef.status.required = [
                        EResultParseStatus.parseError,
                        EResultParseStatus.unknownError,
                        EResultParseStatus.needLogin,
                      ].map((item) => item.toString());
                      updateTableFilterValueFn();
                    }
                  "
                />

                <v-list-item
                  :title="t('MyData.index.filter.unreadMessage')"
                  @click.stop="
                    () => {
                      advanceFilterDictRef.messageCount = [1, ' '];
                      updateTableFilterValueFn();
                    }
                  "
                />

                <v-list-item-subtitle class="ma-2">
                  {{ t("MyData.index.siteCategory") }}
                </v-list-item-subtitle>

                <v-list-item
                  v-for="(item, index) in metadataStore.getSitesGroupData"
                  :key="index"
                  :value="index"
                  class="pr-6"
                >
                  <v-checkbox
                    v-model="advanceFilterDictRef[`siteUserConfig.groups`].required"
                    :label="`${index} (${item.length})`"
                    :value="index"
                    density="compact"
                    hide-details
                    indeterminate
                    @click.stop="(v: any) => toggleKeywordStateFn(`siteUserConfig.groups`, index)"
                    @update:model-value="() => updateTableFilterValueFn()"
                  />
                </v-list-item>
              </v-list>
            </v-menu>
          </template>
        </v-text-field>
      </v-row>
    </v-card-title>
    <v-data-table
      v-model="tableSelected"
      :custom-filter="tableFilterFn"
      :filter-keys="['site'] /* 对每个item值只检索一次 */"
      :headers="tableHeader"
      :items="visibleSiteCatalogData"
      :items-per-page="-1"
      :loading="isSiteCatalogLoading"
      :multi-sort="configStore.enableTableMultiSort"
      :search="tableFilterRef"
      :sort-by="configStore.tableBehavior.MyData.sortBy"
      class="table-stripe table-header-no-wrap table-no-ext-padding"
      hide-default-footer
      hover
      item-selectable="selectable"
      item-value="site"
      show-select
      @update:sortBy="(v) => configStore.updateTableBehavior('MyData', 'sortBy', v)"
    >
      <!-- 站点信息 -->
      <template #item.siteUserConfig.sortIndex="{ item }">
        <div class="d-flex flex-column align-center">
          <v-badge
            :model-value="configStore.myDataTableControl.showUnreadMessage && (item.messageCount ?? 0) > 0"
            :content="(item.messageCount ?? 0) > 10 ? undefined : item.messageCount"
            color="error"
          >
            <div class="favicon-hover-wrapper favicon-hover-bg">
              <SiteFavicon
                :site-id="item.site"
                :size="configStore.myDataTableControl.showSiteName ? 18 : 24"
                :title="t('SetSite.common.open')"
                @click="() => openSite(item.site)"
              />
            </div>
          </v-badge>

          <span v-if="configStore.myDataTableControl.showSiteName" class="text-no-wrap">{{ item.siteName }}</span>
        </div>
      </template>

      <template #item.availability="{ item }">
        <v-chip :color="item.availability === 'ready' ? 'success' : 'warning'" label size="small">
          {{ t(`MyData.index.siteAvailability.${item.availability}`) }}
        </v-chip>
      </template>

      <!-- 用户名，用户ID -->
      <template #item.name="{ item }">
        <span :title="item.id as string" class="text-no-wrap">
          {{ configStore.myDataTableControl.showUserName ? (item.name ?? "-") : "******" }}
        </span>
      </template>

      <template #item.siteUserConfig.groups="{ item }">
        <span class="text-no-wrap">{{ (item.siteUserConfig.groups ?? []).join(", ") || "-" }}</span>
      </template>

      <template #item.siteUserConfig.isOffline="{ item }">
        <v-switch
          v-model="item.siteUserConfig.isOffline"
          :disabled="!item.isConfigured || item.metadata.isDead"
          class="table-switch-btn"
          color="success"
          hide-details
          @update:model-value="(v) => metadataStore.simplePatch('sites', item.site, 'isOffline', v as boolean)"
        />
      </template>

      <template #item.siteUserConfig.allowSearch="{ item }">
        <v-switch
          v-model="item.siteUserConfig.allowSearch"
          :disabled="
            !item.isConfigured ||
            item.metadata.isDead ||
            item.siteUserConfig.isOffline ||
            !Object.hasOwn(item.metadata, 'search')
          "
          class="table-switch-btn"
          color="success"
          hide-details
          @update:model-value="(v) => metadataStore.simplePatch('sites', item.site, 'allowSearch', v as boolean)"
        />
      </template>

      <template #item.siteUserConfig.allowQueryUserInfo="{ item }">
        <v-switch
          v-model="item.siteUserConfig.allowQueryUserInfo"
          :disabled="
            !item.isConfigured ||
            item.metadata.isDead ||
            item.siteUserConfig.isOffline ||
            !Object.hasOwn(item.metadata, 'userInfo')
          "
          class="table-switch-btn"
          color="success"
          hide-details
          @update:model-value="(v) => metadataStore.simplePatch('sites', item.site, 'allowQueryUserInfo', v as boolean)"
        />
      </template>

      <!-- 等级信息，升级信息 -->
      <template #item.levelName="{ item }">
        <UserLevelRequirementsTd v-if="getCatalogUserInfo(item)" :user-info="getCatalogUserInfo(item)!" />
        <span v-else>-</span>
      </template>

      <!-- 上传、下载 -->
      <template #item.uploaded="{ item }">
        <v-container>
          <v-row class="flex-nowrap" justify="end">
            <span class="text-no-wrap">
              {{ typeof item.uploaded !== "undefined" ? formatSize(item.uploaded) : "-" }}
            </span>
            <v-icon color="green-darken-4" icon="mdi-chevron-up" size="small"></v-icon>
          </v-row>
          <v-row class="flex-nowrap" justify="end">
            <span class="text-no-wrap">
              {{ typeof item.downloaded !== "undefined" ? formatSize(item.downloaded) : "-" }}
            </span>
            <v-icon color="red-darken-4" icon="mdi-chevron-down" size="small"></v-icon>
          </v-row>
        </v-container>
      </template>

      <!-- 真实上传、下载 -->
      <template #item.trueUploaded="{ item }">
        <v-container>
          <v-row class="flex-nowrap" justify="end">
            <span class="text-no-wrap">
              {{ typeof item.trueUploaded !== "undefined" ? formatSize(item.trueUploaded) : "-" }}
            </span>
            <v-icon color="green-darken-4" icon="mdi-chevron-up" size="small"></v-icon>
          </v-row>
          <v-row class="flex-nowrap" justify="end">
            <span class="text-no-wrap">
              {{ typeof item.trueDownloaded !== "undefined" ? formatSize(item.trueDownloaded) : "-" }}
            </span>
            <v-icon color="red-darken-4" icon="mdi-chevron-down" size="small"></v-icon>
          </v-row>
        </v-container>
      </template>

      <!-- 分享率 -->
      <template #item.ratio="{ item }">
        <span class="text-no-wrap">{{ formatRatio(item) }}</span>
      </template>

      <!-- 真实分享率 -->
      <template #item.trueRatio="{ item }">
        <span class="text-no-wrap">{{ formatRatio(item, "trueRatio") }}</span>
      </template>

      <!-- 发布数 -->
      <template #item.uploads="{ item }">
        <span class="text-no-wrap">{{ item.uploads ?? "-" }}</span>
      </template>

      <!-- 做种数， H&R 情况  -->
      <template #item.seeding="{ item }">
        <v-container class="py-0">
          <v-row align="center" class="flex-nowrap my-0" justify="end">
            <span class="text-no-wrap">{{ item.seeding ?? "-" }}</span>
          </v-row>
          <v-row v-if="configStore.myDataTableControl.showHnR" align="center" class="flex-nowrap my-0" justify="end">
            <span
              v-if="typeof item.hnrPreWarning !== 'undefined' && item.hnrPreWarning > 0"
              class="d-inline-flex align-center ml-2"
            >
              <v-icon
                :title="t('levelRequirement.hnrPreWarning')"
                color="yellow-darken-4"
                icon="mdi-alert"
                size="small"
              />
              <span class="text-no-wrap">
                {{ item.hnrPreWarning }}
              </span>
            </span>
            <span
              v-if="typeof item.hnrUnsatisfied !== 'undefined' && item.hnrUnsatisfied > 0"
              class="d-inline-flex align-center ml-1"
            >
              <v-icon
                :title="t('levelRequirement.hnrUnsatisfied')"
                color="red-darken-4"
                icon="mdi-alert-circle"
                size="small"
              />
              <span class="text-no-wrap">
                {{ item.hnrUnsatisfied }}
              </span>
            </span>
          </v-row>
        </v-container>
      </template>

      <!-- 做种量 -->
      <template #item.seedingSize="{ item }">
        <span class="text-no-wrap">
          {{ typeof item.seedingSize !== "undefined" ? formatSize(item.seedingSize) : "-" }}
        </span>
      </template>

      <!-- 魔力/积分 -->
      <template #item.bonus="{ item }">
        <v-container>
          <v-row align="center" class="flex-nowrap" justify="end">
            <v-icon :title="t('levelRequirement.bonus')" color="green-darken-4" icon="mdi-currency-usd" size="small" />
            <BonusFormatSpan :num="item.bonus" />
          </v-row>
          <v-row
            v-if="
              configStore.myDataTableControl.showSeedingBonus &&
              item.seedingBonus !== '' &&
              !isUndefined(item.seedingBonus)
            "
            align="center"
            class="flex-nowrap"
            justify="end"
          >
            <v-icon
              :title="t('levelRequirement.seedingBonus')"
              color="green-darken-4"
              icon="mdi-lightning-bolt-circle"
              size="small"
            />
            <BonusFormatSpan :num="item.seedingBonus" />
          </v-row>
        </v-container>
      </template>

      <template #item.bonusPerHour="{ item }">
        <BonusFormatSpan :num="item.bonusPerHour" />
      </template>

      <template #item.invites="{ item }">
        <span class="text-no-wrap">{{ typeof item.invites !== "undefined" ? item.invites : "-" }}</span>
      </template>

      <!-- 入站时间 -->
      <template #item.joinTime="{ item }">
        <span class="text-no-wrap" :title="item.joinTime ? (formatDate(item.joinTime) as string) : '-'">
          {{
            typeof item.joinTime !== "undefined"
              ? configStore.myDataTableControl.joinTimeFormat === "aliveWeek"
                ? formatTimeAgo(item.joinTime, { weekOnly: true })
                : configStore.myDataTableControl.joinTimeFormat === "alive"
                  ? formatTimeAgo(item.joinTime)
                  : formatDate(item.joinTime, "yyyy-MM-dd")
              : "-"
          }}
        </span>
      </template>

      <!-- 最近访问时间 -->
      <template #item.lastAccessAt="{ item }">
        <span class="text-no-wrap" :title="item.lastAccessAt ? (formatDate(item.lastAccessAt) as string) : '-'">
          <template v-if="typeof item.lastAccessAt !== 'undefined'">
            {{ formatDate(item.lastAccessAt) }}
            <v-icon
              v-if="item.lastAccessDuration >= 5"
              icon="mdi-alert"
              :color="item.lastAccessDuration >= 15 ? 'red' : 'amber'"
              :title="t('MyData.table.lastAccessDurationNote', [item.lastAccessDuration])"
            />
          </template>
          <template v-else>-</template>
        </span>
      </template>

      <!-- 更新时间 -->
      <template #item.updateAt="{ item }">
        <template v-if="typeof item.status === 'undefined'">-</template>
        <template v-else-if="item.status === EResultParseStatus.success">
          <span class="text-wrap" :title="item.updateAt ? (formatDate(item.updateAt) as string) : '-'">
            {{
              item.updateAt
                ? configStore.myDataTableControl.updateAtFormatAsAlive
                  ? formatTimeAgo(item.updateAt)
                  : formatDate(item.updateAt)
                : "-"
            }}
          </span>
        </template>
        <template v-else>
          <v-chip label>
            <ResultParseStatus :status="item.status" />
          </v-chip>
        </template>
      </template>

      <!-- 操作 -->
      <template #item.action="{ item }">
        <v-btn-group class="table-action" density="compact" variant="plain">
          <v-btn
            :title="t('common.edit')"
            color="info"
            icon="mdi-pencil"
            size="small"
            @click="() => editSite(item.site)"
          />
          <v-btn
            :title="t('SetSite.index.table.searchEntries')"
            :disabled="!item.isConfigured || !item.metadata.searchEntry"
            size="small"
          >
            <v-icon icon="mdi-magnify" />
            <v-menu :close-on-content-click="false" activator="parent">
              <EditSearchEntryList
                :item="{ id: item.site, metadata: item.metadata, userConfig: item.siteUserConfig }"
              />
            </v-menu>
          </v-btn>
          <v-btn
            :disabled="!item.isConfigured"
            :title="t('MyData.table.action.viewHistoryData')"
            color="blue"
            icon="mdi-view-list"
            size="small"
            @click="() => viewHistoryData(item.site)"
          >
          </v-btn>
          <v-btn
            :disabled="!item.selectable || runtimeStore.userInfo.flushPlan[item.site]"
            :loading="runtimeStore.userInfo.flushPlan[item.site]"
            :title="t('MyData.table.action.flushData')"
            color="green"
            icon="mdi-cached"
            size="small"
            @click="() => flushSiteLastUserInfo([item.site])"
          ></v-btn>
        </v-btn-group>
      </template>
    </v-data-table>
  </v-card>

  <HistoryDataViewDialog v-model="showHistoryDataViewDialog" :site-id="historyDataViewDialogSiteId!" />
  <ExportUserInfoDialog v-model="showExportDialog" :selected-site-ids="tableSelected" />
  <EditDialog v-model="showEditDialog" :site-id="toEditId!" />
</template>

<style scoped lang="scss">
.favicon-hover-wrapper {
  cursor: pointer;
}

.favicon-hover-bg {
  border-radius: 50%;
  transition: background 0.2s;
  display: inline-flex;
  padding: 4px;
}

.favicon-hover-bg:hover {
  background: rgba(0, 0, 0, 0.3);
}
</style>

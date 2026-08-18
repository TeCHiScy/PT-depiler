<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { useDisplay, type DataTableHeader } from "vuetify";
import { EResultParseStatus, ETorrentStatus } from "@ptd/site";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { formatDate, formatSize, formatTimeAgo } from "@/options/utils.ts";
import type { ISearchResultTorrent } from "@/shared/types.ts";

import SiteName from "@/options/components/SiteName.vue";
import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";
import TorrentTitleTd from "@/options/components/TorrentTitleTd.vue";

import ActionTd from "./ActionTd.vue";
import TorrentProcessTd from "./TorrentProcessTd.vue";
import QuickFilterNotice from "./QuickFilterNotice.vue";
import SearchStatusDialog from "./SearchStatusDialog.vue";
import SaveSnapshotDialog from "./SaveSnapshotDialog.vue";
import AdvanceFilterGenerateDialog from "./AdvanceFilterGenerateDialog.vue";

// 主要助手方法
import { tableCustomFilter } from "./utils/filter";
import { doSearch, retrySearch, searchPlanStatus, searchQueue } from "./utils/search";

const { t } = useI18n();
const route = useRoute();
const configStore = useConfigStore();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();
const display = useDisplay();

const showAdvanceFilterGenerateDialog = ref<boolean>(false);
const showSearchStatusDialog = ref<boolean>(false);
const showSaveSnapshotDialog = ref<boolean>(false);

const fullTableHeader = computed(
  () =>
    [
      { title: t("common.site"), key: "site", align: "center", props: { disabled: true } },
      {
        title: t("SearchEntity.index.table.title"),
        key: "title",
        align: "start",
        minWidth: "30rem",
        ...(configStore.searchEntifyControl.limitTorrentTitleTdWidth || display.smAndDown.value
          ? { maxWidth: "32vw" }
          : {}),
        props: { disabled: true },
      },
      { title: t("SearchEntity.index.table.category"), key: "category", align: "center" },
      { title: t("SearchEntity.index.table.size"), key: "size", align: "end" },
      { title: t("SearchEntity.index.table.seeders"), key: "seeders", align: "end" },
      { title: t("SearchEntity.index.table.leechers"), key: "leechers", align: "end" },
      { title: t("SearchEntity.index.table.completed"), key: "completed", align: "end" },
      { title: t("SearchEntity.index.table.comments"), key: "comments", align: "end" },
      { title: t("SearchEntity.index.table.time"), key: "time", align: "center" },
      {
        title: t("common.action"),
        key: "action",
        align: "center",
        sortable: false,
        props: { disabled: true },
      },
    ] as (DataTableHeader & { props?: any })[],
);

const tableHeader = computed(() => {
  return fullTableHeader.value.filter(
    (item) => item?.props?.disabled || configStore.tableBehavior.SearchEntity.columns!.includes(item.key!),
  ) as DataTableHeader[];
});

const { tableFilterRef, tableWaitFilterRef, tableFilterFn, buildAdvanceItemPropsFn, buildFilterDictFn } =
  tableCustomFilter;

// 使用 shallowRef 优化：种子对象数组不需要深度响应式，提升性能
const tableSelectedRaw = shallowRef<ISearchResultTorrent[]>([]);

watch(
  () => route.query,
  (newParams, oldParams) => {
    if (newParams.snapshot) {
      metadataStore.getSearchSnapshotData(newParams.snapshot as string).then((data) => {
        data && (runtimeStore.search = { ...data, snapshot: newParams.snapshot as string });
        // 如果启用了快速站点筛选，则重置一下筛选器，以防止快速站点筛选中无站点数据
        if (configStore.searchEntity.quickSiteFilter) {
          buildAdvanceItemPropsFn();
        }
      });
    } else {
      if (
        newParams.flush ||
        (newParams.search && newParams.search != oldParams?.search) ||
        (newParams.plan && newParams.plan != oldParams?.plan)
      ) {
        // 清理已选择项 （ #622 ）
        tableSelectedRaw.value = [];
        // doSearch 会自动处理过滤器重置
        doSearch((newParams.search as string) ?? "", (newParams.plan as string) ?? "default", true);
      }
    }
  },
  { immediate: true, deep: true },
);

const isSearchingParsed = ref<boolean>(searchQueue.isPaused);

function pauseSearchQueue() {
  console.log("pauseSearchQueue", searchQueue);
  searchQueue.pause();
  isSearchingParsed.value = true;
}

function startSearchQueue() {
  console.log("startSearchQueue", searchQueue);
  searchQueue.start();
  isSearchingParsed.value = false;
}

function cancelSearchQueue() {
  console.log("cancelSearchQueue", searchQueue);
  searchQueue.clear(); // 清空搜索队列
  // 将搜索队列中状态设置为跳过
  for (const key of Object.keys(runtimeStore.search.searchPlan)) {
    // @ts-ignore
    if (runtimeStore.search.searchPlan[key]!.status === EResultParseStatus.waiting) {
      // @ts-ignore
      runtimeStore.search.searchPlan[key]!.status = EResultParseStatus.passParse;
      // @ts-ignore
      runtimeStore.search.searchPlan[key]!.statusMsg = "i18n.userCancel";
    }
  }

  runtimeStore.search.isSearching = false;
}

const tableNonBooleanControlKey = ["maxTagCountBeforeGroup", "hiddenTagNames"];

// 过滤出表格控制中非布尔类型的键
const filteredTableBooleanControlKeys = computed(() => {
  return Object.keys(configStore.searchEntifyControl).filter(
    (key) => tableNonBooleanControlKey.indexOf(key) === -1,
  ) as (keyof typeof configStore.searchEntifyControl)[];
});

const hiddenTagNamesText = computed({
  get: () => configStore.searchEntifyControl.hiddenTagNames.join("\n"),
  set: (val: string) => {
    configStore.searchEntifyControl.hiddenTagNames = val
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  },
});
</script>

<template>
  <v-card>
    <v-card-title class="search-toolbar-title">
      <div class="search-toolbar">
        <div class="search-toolbar__actions">
          <!-- 搜索状态 -->
          <div class="search-toolbar__button-group">
            <v-btn
              :title="t('SearchEntity.index.alert.searchStatus')"
              color="primary"
              icon="mdi-list-status"
              @click="showSearchStatusDialog = true"
            />
          </div>

          <v-divider vertical class="mx-2" />

          <!-- 搜索队列控制 -->
          <div class="search-toolbar__button-group">
            <v-btn
              v-show="isSearchingParsed"
              :title="t('SearchEntity.index.action.start')"
              color="success"
              icon="mdi-play"
              @click="() => startSearchQueue()"
            />
            <v-btn
              v-show="!isSearchingParsed"
              :title="t('SearchEntity.index.action.pause')"
              color="success"
              icon="mdi-pause"
              @click="() => pauseSearchQueue()"
            />

            <v-btn
              v-show="runtimeStore.search.isSearching"
              :title="t('SearchEntity.index.action.cancel')"
              color="red"
              icon="mdi-cancel"
              @click="cancelSearchQueue"
            />
            <v-btn
              v-show="!runtimeStore.search.isSearching"
              :disabled="isSearchingParsed"
              :title="t('SearchEntity.index.action.retry')"
              color="red"
              icon="mdi-sync"
              @click="() => doSearch(null as unknown as string, null as unknown as string, true)"
            />

            <v-btn
              :disabled="searchPlanStatus.error === 0"
              :title="t('SearchEntity.index.action.retryFailed')"
              color="amber"
              icon="mdi-sync-alert"
              @click="() => retrySearch()"
            />
          </div>

          <v-divider vertical class="mx-2" />

          <!-- 创建搜索快照 -->
          <div class="search-toolbar__button-group">
            <v-btn
              :disabled="runtimeStore.search.isSearching || runtimeStore.search.searchResult.length === 0"
              :title="t('SearchEntity.index.action.saveSnapshot')"
              color="cyan"
              icon="mdi-camera-plus"
              @click="showSaveSnapshotDialog = true"
            />
          </div>

          <v-divider vertical class="mx-2" />

          <ActionTd :torrent-items="tableSelectedRaw" density="default" />

          <v-divider vertical class="mx-2" />

          <div class="search-toolbar__button-group">
            <v-menu :close-on-content-click="false">
              <template v-slot:activator="{ props }">
                <v-btn
                  :title="t('SearchEntity.index.action.displayPreferences')"
                  color="blue"
                  icon="mdi-cog"
                  v-bind="props"
                />
              </template>
              <v-list>
                <v-list-item v-for="item in filteredTableBooleanControlKeys" :key="item" :value="item">
                  <template v-slot:prepend>
                    <v-list-item-action start class="ml-2">
                      <v-switch
                        v-model="configStore.searchEntifyControl[item]"
                        :label="`&nbsp;${t('SearchEntity.index.' + item)}`"
                        color="success"
                        density="compact"
                        hide-details
                        @click.stop
                        @update:model-value="() => configStore.$save()"
                      />
                    </v-list-item-action>
                  </template>
                </v-list-item>
                <v-list-item v-if="configStore.searchEntifyControl.showTorrentTag" class="mt-2">
                  <v-textarea
                    v-model="hiddenTagNamesText"
                    :label="t('SetBase.searchEntity.hiddenTagNames')"
                    hide-details
                    clearable
                    rows="5"
                  />
                </v-list-item>
              </v-list>
            </v-menu>
          </div>
        </div>

        <div class="search-toolbar__filters">
          <v-combobox
            v-model="configStore.tableBehavior.SearchEntity.columns"
            :items="fullTableHeader"
            :return-object="false"
            chips
            class="table-header-filter-clear search-toolbar__column-filter"
            density="compact"
            hide-details
            item-value="key"
            max-width="180"
            multiple
            prepend-inner-icon="mdi-filter-cog"
            @update:model-value="(v) => configStore.updateTableBehavior('SearchEntity', 'columns', v)"
          >
            <template #chip="{ item, index }">
              <v-chip v-if="index === 0">
                <span>{{ item.title }}</span>
              </v-chip>
              <span v-if="index === 1" class="grey--text caption">
                (+{{ configStore.tableBehavior.SearchEntity.columns!.length - 1 }})
              </span>
            </template>
          </v-combobox>

          <v-text-field
            v-model="tableWaitFilterRef"
            append-icon="mdi-magnify"
            clearable
            class="search-toolbar__text-filter"
            density="compact"
            hide-details
            :label="t('SearchEntity.index.filterLabel')"
            max-width="500"
            prepend-inner-icon="mdi-filter"
            single-line
            @click:prepend-inner="showAdvanceFilterGenerateDialog = true"
            @update:model-value="(val) => buildFilterDictFn(val)"
          />
        </div>
      </div>
    </v-card-title>

    <v-card-text class="pt-2 pb-0">
      <!-- 站点筛选器、已选种子等提示信息 -->
      <QuickFilterNotice :selected-torrents="tableSelectedRaw" />

      <v-data-table
        id="ptd-search-entity-table"
        v-model="tableSelectedRaw"
        :custom-filter="tableFilterFn"
        :filter-keys="['uniqueId'] /* 对每个item值只检索一次 */"
        :headers="tableHeader"
        :items="runtimeStore.search.searchResult"
        :items-per-page="configStore.tableBehavior.SearchEntity.itemsPerPage"
        :search="tableFilterRef"
        :sort-by="configStore.tableBehavior.SearchEntity.sortBy"
        class="search-entity-table table-stripe table-header-no-wrap"
        hover
        item-value="uniqueId"
        :multi-sort="configStore.enableTableMultiSort"
        show-select
        return-object
        @update:itemsPerPage="(v) => configStore.updateTableBehavior('SearchEntity', 'itemsPerPage', v)"
        @update:sortBy="(v) => configStore.updateTableBehavior('SearchEntity', 'sortBy', v)"
      >
        <!-- 站点图标 -->
        <template #item.site="{ item }">
          <div class="d-flex flex-column align-center">
            <SiteFavicon :site-id="item.site" :size="configStore.searchEntifyControl.showSiteName ? 18 : 24" />
            <SiteName v-if="configStore.searchEntifyControl.showSiteName" :site-id="item.site" />
          </div>
        </template>

        <!-- 主标题，副标题，优惠及标签 -->
        <template #item.title="{ item }">
          <TorrentTitleTd :item="item" />
        </template>

        <!-- 种子大小，下载情况 -->
        <template #item.size="{ item }">
          <v-container no-gutters>
            <v-row>
              <v-col class="pa-0">
                <span class="t_size text-no-wrap">{{ formatSize(item.size ?? 0) }}</span>
              </v-col>
            </v-row>
            <v-row v-if="item.status && (item.status as ETorrentStatus) !== ETorrentStatus.unknown">
              <v-col class="pa-0">
                <TorrentProcessTd :torrent="item"></TorrentProcessTd>
              </v-col>
            </v-row>
          </v-container>
        </template>

        <!-- 上传人数 -->
        <template #item.seeders="{ item }">
          <span class="t_seeders text-no-wrap">{{ item.seeders }}</span>
        </template>

        <!-- 下载人数 -->
        <template #item.leechers="{ item }">
          <span class="t_leechers text-no-wrap">{{ item.leechers }}</span>
        </template>

        <!-- 完成人数 -->
        <template #item.completed="{ item }">
          <span class="t_completed text-no-wrap">{{ item.completed }}</span>
        </template>

        <!-- 评论人数 -->
        <template #item.comments="{ item }">
          <span class="t_comments text-no-wrap">{{ item.comments }}</span>
        </template>

        <!-- 发布日期 -->
        <template #item.time="{ item }">
          <span class="t_time text-no-wrap" :title="item.time ? (formatDate(item.time) as string) : '-'">
            {{
              item.time
                ? configStore.searchEntifyControl.uploadAtFormatAsAlive
                  ? formatTimeAgo(item.time)
                  : formatDate(item.time)
                : "-"
            }}
          </span>
        </template>

        <!-- 其他操作 -->
        <template #item.action="{ item }">
          <ActionTd :torrent-items="[item]" density="compact" :show-keep-upload-btn="false" />
        </template>
      </v-data-table>
    </v-card-text>
  </v-card>

  <AdvanceFilterGenerateDialog v-model="showAdvanceFilterGenerateDialog" />
  <SearchStatusDialog v-model="showSearchStatusDialog" />
  <SaveSnapshotDialog v-model="showSaveSnapshotDialog" />
</template>

<style scoped lang="scss">
.search-toolbar-title {
  min-width: 0;
}

.search-toolbar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  width: 100%;
}

.search-toolbar__actions {
  align-items: center;
  display: flex;
  flex-wrap: nowrap;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: thin;
  white-space: nowrap;

  :deep(.v-divider) {
    flex-shrink: 0;
  }

  :deep(.table-action) {
    flex-shrink: 0;
  }
}

.search-toolbar__button-group {
  align-items: center;
  display: flex;
  flex-shrink: 0;
  gap: 4px;
}

.search-toolbar__filters {
  align-items: center;
  display: flex;
  gap: 8px;
  min-width: 0;
  width: 100%;
}

.search-toolbar__column-filter {
  flex: 0 1 180px;
  min-width: 0;
}

.search-toolbar__text-filter {
  flex: 1 1 240px;
  margin-left: auto;
  min-width: 0;
}

#ptd-search-entity-table {
  :deep(td.v-data-table__td) {
    padding: 0 8px;
  }
}
</style>

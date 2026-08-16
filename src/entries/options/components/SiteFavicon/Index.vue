<script setup lang="ts">
import { onMounted, shallowRef } from "vue";
import { NO_IMAGE, type TSiteID } from "@ptd/site";

import { getSiteFavicon } from "./utils.ts";

const { siteId, size = 32 } = defineProps<{
  siteId: TSiteID;
  size?: number;
}>();

const siteFavicon = shallowRef<string>(NO_IMAGE);

onMounted(async () => {
  siteFavicon.value = await getSiteFavicon(siteId);
});
</script>

<template>
  <v-img :height="size" :src="siteFavicon" :width="size" aspect-ratio="1/1" />
</template>

<style scoped lang="scss"></style>

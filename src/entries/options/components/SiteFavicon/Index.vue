<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { NO_IMAGE, type TSiteID } from "@ptd/site";

import { getSiteFavicon } from "./utils.ts";

const props = withDefaults(
  defineProps<{
    siteId: TSiteID;
    size?: number;
    lazy?: boolean;
  }>(),
  {
    size: 32,
    lazy: true,
  },
);

const siteFavicon = shallowRef<string>(NO_IMAGE);
const containerRef = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | undefined;
let hasStartedLoading = false;

async function loadFavicon() {
  if (hasStartedLoading) {
    return;
  }

  hasStartedLoading = true;
  siteFavicon.value = await getSiteFavicon(props.siteId);
}

onMounted(() => {
  if (!props.lazy || typeof IntersectionObserver === "undefined") {
    void loadFavicon();
    return;
  }

  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer?.disconnect();
        observer = undefined;
        void loadFavicon();
      }
    },
    { rootMargin: "200px" },
  );
  if (containerRef.value) {
    observer.observe(containerRef.value);
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
});
</script>

<template>
  <div ref="containerRef" :style="{ height: `${props.size}px`, width: `${props.size}px` }">
    <v-img :height="props.size" :src="siteFavicon" :width="props.size" aspect-ratio="1/1" />
  </div>
</template>

<style scoped lang="scss"></style>

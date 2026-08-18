<script setup lang="ts">
import { computed } from "vue";
import { formatNumber, simplifyNumber } from "@/options/utils.ts";

const { num } = defineProps<{
  num: number | string | undefined;
}>();

const normalizedValue = computed<{ type: "number"; value: number } | { type: "text"; value: string }>(() => {
  if (typeof num === "number" && Number.isFinite(num)) {
    return { type: "number", value: num };
  }

  return {
    type: "text",
    value: typeof num === "string" ? num : typeof num === "undefined" ? "-" : "N/A",
  };
});

const titleText = computed(() =>
  normalizedValue.value.type === "number" ? formatNumber(normalizedValue.value.value) : normalizedValue.value.value,
);

const displayText = computed(() =>
  normalizedValue.value.type === "number" ? simplifyNumber(normalizedValue.value.value) : normalizedValue.value.value,
);
</script>

<template>
  <span class="text-no-wrap" :title="titleText" :style="{ userSelect: 'none' }">
    {{ displayText }}
  </span>
</template>

<style scoped lang="scss"></style>

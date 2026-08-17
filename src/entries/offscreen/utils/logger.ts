/**
 * 关于 logger 方法记录
 * 在 background 等其他页面中， 请使用 sendMessage("logger", {}).catch();
 * 在 offscreen 中， 请使用 logger({}) 直接调用
 */
import { onMessage } from "@/messages.ts";
import type { ILoggerItem } from "@/shared/types.ts";

export function logger(data: ILoggerItem) {
  const message = data.msg?.trim() ?? "";
  if (typeof data.data === "undefined") {
    console.log(`[PT Depiler] ${message}`);
  } else {
    console.log(`[PT Depiler] ${message}`, data.data);
  }
}

onMessage("logger", ({ data }) => logger(data));

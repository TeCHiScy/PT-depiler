import { sendMessage } from "@/messages.ts";

let creating: Promise<void> | null; // A global promise to avoid concurrency issues

const offscreenPath = "src/entries/offscreen/offscreen.html";
const offscreenReadyTimeout = 5000;
const offscreenReadyRetryDelay = 100;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForOffscreenReady() {
  const deadline = Date.now() + offscreenReadyTimeout;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      if (await sendMessage("offscreenReady", undefined)) return;
    } catch (error) {
      lastError = error;
    }

    await sleep(offscreenReadyRetryDelay);
  }

  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for offscreen document readiness");
}

export async function setupOffscreenDocument() {
  // Firefox 环境下不构建 offscreen
  if (__BROWSER__ == "firefox") {
    return;
  }

  // Check all windows controlled by the service worker to see if one
  // of them is the offscreen document with the given path
  const offscreenUrl = chrome.runtime.getURL(offscreenPath);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [offscreenUrl],
  });

  if (existingContexts.length > 0) {
    return;
  }

  // create offscreen document for DOM_PARSER and other reason ( f**k google )
  if (creating) {
    await creating;
  } else {
    creating = chrome.offscreen.createDocument({
      url: offscreenPath,
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: "Allow DOM_PARSER, CLIPBOARD, BLOBS in background.",
    });
    try {
      await creating;
    } finally {
      creating = null;
    }
  }

  // createDocument resolves before the offscreen module necessarily registers
  // its message handlers. Wait for an explicit response before serving work.
  await waitForOffscreenReady();
}

// noinspection JSIgnoredPromiseFromCall
setupOffscreenDocument();

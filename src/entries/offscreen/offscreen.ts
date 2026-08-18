import { onMessage } from "@/messages.ts";

import "./adapter/indexdb.ts";

import "./utils/logger.ts";
import "./utils/site.ts";
import "./utils/search.ts";
import "./utils/download.ts";
import "./utils/userInfo.ts";
import "./utils/backup.ts";
import "./utils/socialInformation.ts";
import "./utils/socialRecommendations.ts";
import "./utils/keepUploadTask.ts";

// The background service worker uses this handshake to distinguish a created
// document from one whose message handlers are ready to receive requests.
onMessage("offscreenReady", async () => true);

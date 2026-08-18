import { SchemaMetadata } from "../schemas/NexusPHP";

export const userInfoWithInvitesInUserDetailsPage = {
  ...SchemaMetadata.userInfo!,
  selectors: {
    ...SchemaMetadata.userInfo!.selectors!,
    invites: {
      selector: [
        "td.rowhead:contains('邀请') + td",
        "td.rowhead:contains('Invites') + td",
        "td.rowhead:contains('Available') + td",
        "td:contains('邀请')",
        "td:contains('邀請')",
        "td:contains('Invites')",
        "td:contains('Available')",
      ],
      filters: [
        (query: string) => {
          if (!query?.trim()) return 0;
          try {
            // 匹配 "Available: 5" 格式
            const availableMatch = query.match(/Available:\s*(\d+)/i);
            if (availableMatch) return parseInt(availableMatch[1], 10) || 0;

            // 匹配纯数字
            const num = parseInt(query.match(/\d+/)?.[0] || "0", 10);
            return isNaN(num) ? 0 : num;
          } catch {
            return 0;
          }
        },
      ],
    },
  },
  process: [
    ...SchemaMetadata.userInfo!.process!.map((item) => {
      // 在用户详情页面添加 invites 字段
      if (item.requestConfig.url === "/userdetails.php") {
        return {
          ...item,
          fields: [...(item.fields || []), "invites"],
        };
      }
      return item;
    }),
  ],
};

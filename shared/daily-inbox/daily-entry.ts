const tabs = {
  notifications: ["all", "unread", "course", "project", "system"],
  actions: ["pending", "completed", "rejected", "all"],
  activity: ["all", "github", "evidence", "discussion"],
} as const;

export function dailyEntryTab(area: keyof typeof tabs, value: string | null): string {
  return tabs[area].find((tab) => tab === value) ?? tabs[area][0];
}

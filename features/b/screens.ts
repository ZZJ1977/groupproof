/**
 * Screens owned by B (plan §1.2): project overview/setup/requirements/planning,
 * the three task views, milestones, the course/group pages and teacher page 48.
 * In `bworkspace=real` mode these mount B's real pages and never the demo views.
 */
export const bScreens = [7, 8, 9, 10, 11, 12, 13, 18, 19, 31, 32, 33, 34, 35, 36, 37, 48] as const;

export function isBScreen(screen: number): boolean {
  return (bScreens as readonly number[]).includes(screen);
}

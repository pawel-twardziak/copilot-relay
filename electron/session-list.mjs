// Copilot's session/list is paged. Pure loop (no Electron imports), so its completeness rule is testable.

export const MAX_PAGES = 50;

/**
 * Every page of session/list through `request(method, params)`, at most MAX_PAGES. `onPage(sessions)` sees each
 * page. complete is false when it stopped with a cursor left: such a list must not be used to prune anything.
 */
export async function listAllPages(request, { onPage } = {}) {
  const sessions = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await request("session/list", cursor ? { cursor } : {});
    const list = res?.sessions ?? [];
    sessions.push(...list);
    onPage?.(list);
    cursor = res?.nextCursor;
    if (!cursor) break;
  }
  return { sessions, complete: !cursor };
}

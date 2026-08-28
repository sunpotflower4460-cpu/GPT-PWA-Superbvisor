// Shared by chatCommandQueue.ts and projectCoordinator.ts — kept in its own
// module (not defined in either) to avoid a circular import:
// chatCommandQueue.ts already imports atomic-coordinator types from
// projectCoordinator.ts, so projectCoordinator.ts cannot import chatUrl
// normalization back FROM chatCommandQueue.ts.
export function normalizeChatUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:') return null;
    if (host !== 'chatgpt.com' && !host.endsWith('.chatgpt.com') && host !== 'chat.openai.com') return null;
    // A fragment is never sent to the server and can't identify a
    // different conversation resource; a trailing slash is likewise
    // insignificant here. Both are discarded so two spellings of the SAME
    // conversation (e.g. copied from different UI surfaces, or with/without
    // a "#section" ChatGPT sometimes appends) compare equal — this value is
    // used as an exact-match identity key for Multi Chat / Specialist Chat
    // claim scoping (see claimNextChatCommand), and a meaningless spelling
    // difference there means a correctly-connected Bridge polls forever
    // while its own commands sit queued, unmatched.
    url.hash = '';
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.origin}${path}${url.search}`;
  } catch {
    return null;
  }
}

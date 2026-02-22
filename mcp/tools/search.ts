/** Lightweight Serper API wrapper with graceful fallback. */

import type { SearchSource } from "../types.js";

const SERPER_ENDPOINT = "https://google.serper.dev/search";

/** Type alias — same shape as `SearchSource` in types.ts. */
export type SearchResult = SearchSource;

/** Returns true only when a Serper API key is present in the environment. */
export function isSearchAvailable(): boolean {
  return !!process.env.SERPER_API_KEY;
}

/**
 * Search the web via Serper's `/search` endpoint.
 * Returns an empty array on any error so callers can degrade gracefully.
 *
 * @param query - The search query string.
 * @param n     - Max number of results to request (default 5).
 */
export async function searchWeb(query: string, n = 5): Promise<SearchResult[]> {
  const key = process.env.SERPER_API_KEY;
  if (!key) return [];

  try {
    const res = await fetch(SERPER_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": key,
      },
      body: JSON.stringify({ q: query, num: n }),
    });

    if (!res.ok) return [];

    const json = (await res.json()) as {
      organic?: Array<{ title?: string; link?: string; snippet?: string; date?: string }>;
    };

    return (json.organic ?? []).slice(0, n).map(r => ({
      title:   r.title   ?? "",
      url:     r.link    ?? "",
      snippet: r.snippet ?? "",
      date:    r.date,
    }));
  } catch {
    return [];
  }
}

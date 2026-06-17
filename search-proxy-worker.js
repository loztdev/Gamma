/*
 * Gamma search proxy — deploy this as a Cloudflare Worker (free tier).
 *
 * Why this exists: every fully-free web search route turned out to be a
 * dead end for a client-side app. Z.ai's hosted search 401s regardless of
 * billing balance. Google Custom Search gates "search the entire web"
 * behind an enterprise sales form for new search engines. Public SearXNG
 * instances called directly from the browser get blocked by their own CORS
 * policy. And scraping DuckDuckGo/SearXNG server-side from this very worker
 * got IP-blocked outright (DuckDuckGo served a bot-check page, SearXNG
 * returned 403) — both DuckDuckGo and SearXNG operators actively block
 * traffic from cloud/datacenter IP ranges like Cloudflare's, since so much
 * scraping traffic comes from exactly those ranges.
 *
 * So this worker calls the Brave Search API instead — a real, paid (but
 * very cheap, ~$3-5 per 1,000 queries) API that won't get IP-blocked
 * because it's legitimate authenticated traffic, not scraping. The key
 * lives in the worker's environment, never in the browser. DuckDuckGo/
 * SearXNG scraping are kept as best-effort free fallbacks in case Brave
 * ever fails (budget exhausted, outage, etc.) — they just won't be the
 * primary path anymore.
 *
 * Deploy (no local tooling required):
 *   1. Get a Brave Search API key: https://brave.com/search/api/
 *      (sign up, add a payment method, create a key under "Subscriptions")
 *   2. https://dash.cloudflare.com -> Workers & Pages -> Create -> Create Worker
 *   3. Open the "Quick edit" code editor, delete the placeholder, paste this file.
 *   4. Go to Settings -> Variables and Secrets -> Add variable.
 *      Name it BRAVE_API_KEY, type "Secret", paste your key, save.
 *   5. Deploy. Copy the worker's URL (https://<name>.<subdomain>.workers.dev).
 *   6. Paste that URL into Gamma's sidebar "Search proxy URL" field.
 */
export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const reqUrl = new URL(request.url);
    const q = reqUrl.searchParams.get("q");
    if (!q) {
      return new Response(JSON.stringify({ error: "Missing q parameter" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (!env.BRAVE_API_KEY) {
      return new Response(JSON.stringify({
        error: "Worker is missing BRAVE_API_KEY. Add it under Settings > Variables and Secrets in the Cloudflare dashboard.",
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    try {
      let results = [];
      try {
        results = await fetchBrave(q, env.BRAVE_API_KEY);
      } catch (err) {
        // Brave failed (budget exhausted, outage, bad key) — fall back to
        // free scraping rather than returning nothing outright.
        results = await fetchDuckDuckGo(q);
        if (!results.length) results = await fetchSearxng(q);
      }

      return new Response(JSON.stringify({ results: results.slice(0, 10) }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err && err.message || err) }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  },
};

async function fetchBrave(q, key) {
  const res = await fetch("https://api.search.brave.com/res/v1/web/search?count=10&q=" + encodeURIComponent(q), {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
  });
  if (!res.ok) throw new Error(`Brave Search error ${res.status}: ${res.statusText}`);
  const data = await res.json();
  const items = (data.web && data.web.results) || [];
  return items.map(r => ({
    title: stripTags(r.title || "Untitled"),
    url: r.url || "",
    content: stripTags(r.description || ""),
  }));
}

// Best-effort free fallback if Brave fails for any reason. Not the primary
// path — see the top-of-file comment for why scraping alone isn't reliable.
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://duckduckgo.com/",
};

async function fetchDuckDuckGo(q) {
  try {
    const res = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), {
      headers: BROWSER_HEADERS,
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseDuckDuckGoHtml(html);
  } catch {
    return [];
  }
}

async function fetchSearxng(q) {
  try {
    const res = await fetch("https://searx.be/search?format=json&q=" + encodeURIComponent(q), {
      headers: { Accept: "application/json", ...BROWSER_HEADERS },
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    if (!data) return [];
    return (data.results || []).map(r => ({
      title: (r.title || "Untitled").trim(),
      url: r.url || "",
      content: (r.content || "").trim(),
    }));
  } catch {
    return [];
  }
}

function parseDuckDuckGoHtml(html) {
  const results = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    results.push({
      title: stripTags(m[2]),
      url: resolveDuckDuckGoLink(m[1]),
      content: stripTags(m[3]),
    });
  }
  return results;
}

function resolveDuckDuckGoLink(href) {
  try {
    const u = new URL(href.startsWith("//") ? "https:" + href : href);
    const real = u.searchParams.get("uddg");
    return real ? decodeURIComponent(real) : u.toString();
  } catch {
    return href;
  }
}

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

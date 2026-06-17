/*
 * Gamma search proxy — deploy this as a Cloudflare Worker (free tier).
 *
 * Why this exists: free web search backends (Z.ai's hosted search, Google
 * Custom Search, public SearXNG instances called directly from the browser)
 * all turned out to be unusable from a pure client-side app — either gated
 * behind paid/enterprise tiers, or blocked by the search provider's own
 * CORS policy. A server you control doesn't have that problem: this worker
 * scrapes DuckDuckGo's HTML results server-side (falling back to a public
 * SearXNG instance's JSON API if DDG comes back empty) and hands parsed
 * results back to the browser with CORS headers attached.
 *
 * Deploy (no local tooling required):
 *   1. https://dash.cloudflare.com -> Workers & Pages -> Create -> Create Worker
 *   2. Open the "Quick edit" code editor, delete the placeholder, paste this file.
 *   3. Deploy. Copy the worker's URL (https://<name>.<subdomain>.workers.dev).
 *   4. Paste that URL into Gamma's sidebar "Search proxy URL" field.
 *
 * Free tier: 100,000 requests/day, no credit card required.
 */
export default {
  async fetch(request) {
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

    try {
      const ddg = await fetchDuckDuckGo(q);
      let results = ddg.results;
      let searx = null;
      if (!results.length) {
        searx = await fetchSearxng(q);
        results = searx.results;
      }

      // `debug` shows what each provider actually did — remove once this is
      // working reliably, it's only here to diagnose why both came back empty.
      return new Response(JSON.stringify({
        results: results.slice(0, 8),
        debug: { ddg: ddg.debug, searx: searx && searx.debug },
      }), {
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

// Real browser UA + headers — DuckDuckGo serves a stripped, resultless page
// to traffic that looks automated (e.g. UAs with a "compatible; X/1.0" crawler
// signature), and it does this inconsistently per-query, not on every request.
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
    if (!res.ok) return { results: [], debug: { status: res.status, statusText: res.statusText } };
    const html = await res.text();
    const results = parseDuckDuckGoHtml(html);
    return { results, debug: { status: res.status, htmlLength: html.length, parsedCount: results.length } };
  } catch (err) {
    return { results: [], debug: { error: String(err && err.message || err) } };
  }
}

// Fallback when DuckDuckGo comes back empty. The CORS issue that ruled out
// public SearXNG instances for the browser doesn't apply here — this fetch
// happens server-to-server, so any instance with JSON enabled works
// regardless of its CORS config.
async function fetchSearxng(q) {
  try {
    const res = await fetch("https://searx.be/search?format=json&q=" + encodeURIComponent(q), {
      headers: { Accept: "application/json", ...BROWSER_HEADERS },
    });
    if (!res.ok) return { results: [], debug: { status: res.status, statusText: res.statusText } };
    const data = await res.json().catch(() => null);
    if (!data) return { results: [], debug: { status: res.status, error: "non-JSON response" } };
    const results = (data.results || []).map(r => ({
      title: (r.title || "Untitled").trim(),
      url: r.url || "",
      content: (r.content || "").trim(),
    }));
    return { results, debug: { status: res.status, rawCount: (data.results || []).length } };
  } catch (err) {
    return { results: [], debug: { error: String(err && err.message || err) } };
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

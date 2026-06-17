/*
 * Gamma search proxy — deploy this as a Cloudflare Worker (free tier).
 *
 * Why this exists: free web search backends (Z.ai's hosted search, Google
 * Custom Search, public SearXNG instances) all turned out to be unusable
 * from a pure client-side app — either gated behind paid/enterprise tiers,
 * or blocked by the search provider's own CORS policy (browsers refuse the
 * response even though the request itself succeeds). A server you control
 * doesn't have that problem: server-to-server requests aren't subject to
 * CORS, so this worker fetches DuckDuckGo's HTML results page itself and
 * hands the parsed results back to the browser with CORS headers attached.
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
      const ddgUrl = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q);
      const res = await fetch(ddgUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; GammaSearchProxy/1.0)" },
      });
      const html = await res.text();
      const results = parseDuckDuckGoHtml(html).slice(0, 8);

      return new Response(JSON.stringify({ results }), {
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

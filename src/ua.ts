/*
  User-Agent to families. No versions beyond the major, no full parse: the analytics needs
  "Chrome on Android, mobile", not a fingerprint. Client Hints win when the browser sends them.
*/
export type Device = { device: string; browser: string; browser_major: number | null; os: string; os_major: number | null };

const CRAWLER = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|fetch|monitor|uptime|curl\/|wget\/|python|httpx|axios|node-fetch|go-http|java\/|okhttp|scrapy|phantom|puppeteer|playwright|selenium|chrome-lighthouse|facebookexternalhit|embedly|quora link|vercel|datadog|pingdom|statuscake|gptbot|chatgpt|claude|anthropic|perplexity|bytespider|ccbot|amazonbot|applebot|bingpreview|yandex|baidu|duckduckbot|semrush|ahrefs|mj12|dotbot/i;

export function isCrawlerUA(ua: string): boolean {
  return !ua || ua.length < 20 || CRAWLER.test(ua);
}

const num = (s: string | undefined) => {
  const n = s ? parseInt(s, 10) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function parseUA(ua: string, hints: { mobile?: string | null; platform?: string | null } = {}): Device {
  let browser = "Other", bmaj: number | null = null, os = "Other", omaj: number | null = null;
  let m: RegExpMatchArray | null;
  if ((m = ua.match(/Edg(?:e|A|iOS)?\/(\d+)/))) { browser = "Edge"; bmaj = num(m[1]); }
  else if ((m = ua.match(/OPR\/(\d+)/)) || (m = ua.match(/Opera\/(\d+)/))) { browser = "Opera"; bmaj = num(m[1]); }
  else if ((m = ua.match(/SamsungBrowser\/(\d+)/))) { browser = "Samsung Internet"; bmaj = num(m[1]); }
  else if ((m = ua.match(/YaBrowser\/(\d+)/))) { browser = "Yandex"; bmaj = num(m[1]); }
  else if ((m = ua.match(/(?:Firefox|FxiOS)\/(\d+)/))) { browser = "Firefox"; bmaj = num(m[1]); }
  else if ((m = ua.match(/(?:Chrome|CriOS)\/(\d+)/))) { browser = "Chrome"; bmaj = num(m[1]); }
  else if (/Safari\//.test(ua) && (m = ua.match(/Version\/(\d+)/))) { browser = "Safari"; bmaj = num(m[1]); }
  else if (/AppleWebKit/.test(ua) && /Mobile\//.test(ua)) { browser = "Safari (in-app)"; }

  if ((m = ua.match(/Windows NT (\d+)/))) { os = "Windows"; omaj = num(m[1]); }
  else if ((m = ua.match(/(?:iPhone|iPad|iPod).*? OS (\d+)/))) { os = "iOS"; omaj = num(m[1]); }
  else if ((m = ua.match(/Android (\d+)/))) { os = "Android"; omaj = num(m[1]); }
  else if (/CrOS/.test(ua)) os = "ChromeOS";
  else if ((m = ua.match(/Mac OS X (\d+)/))) { os = "macOS"; omaj = num(m[1]); }
  else if (/Linux/.test(ua)) os = "Linux";

  const platform = hints.platform?.replace(/"/g, "");
  if (platform === "Windows" || platform === "macOS" || platform === "Android" || platform === "Linux" || platform === "Chrome OS") os = platform === "Chrome OS" ? "ChromeOS" : platform;

  let device = "desktop";
  if (/iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) device = "tablet";
  else if (hints.mobile === "?1" || /Mobi|iPhone|iPod|Android.*Mobile/.test(ua)) device = "mobile";
  return { device, browser, browser_major: bmaj, os, os_major: omaj };
}

/* Hosting and cloud networks: a "visitor" from here is usually a script, sometimes a VPN. Flagged, not dropped. */
const DATACENTER_ASN = new Set([
  16509, 14618, 8987, // AWS
  15169, 396982, 19527, // Google Cloud
  8075, 8068, // Microsoft Azure
  14061, // DigitalOcean
  24940, 213230, // Hetzner
  16276, // OVH
  63949, // Linode / Akamai
  20473, // Vultr
  31898, // Oracle
  45102, 37963, // Alibaba
  132203, 45090, // Tencent
  12876, // Scaleway
  51167, // Contabo
  9009, // M247
  60068, // Datacamp / CDN77
  212238, // Datacamp
  47583, // Hostinger
  36352, // ColoCrossing
]);
export const isDatacenterASN = (asn: number | null | undefined) => (asn ? DATACENTER_ASN.has(asn) : false);

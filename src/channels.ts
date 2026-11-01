/*
  Where a visit comes from: referrer + UTM -> channel and, for AI assistants, which one.

  Order follows PostHog's channel definitions (first match wins): Paid, then AI by utm_source,
  then AI by referring domain, then the organic families, Referral, Direct.
  The AI count is a floor: assistant apps often strip the referrer (those visits land in Direct),
  and Google AI Overviews / AI Mode cannot be told apart from Google Search.
  Review the lists every quarter (SCHEMA.md).
*/
export type Touch = {
  referrer_host: string;
  channel: string;
  ai_source: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  click_id_kind: string;
};

/** host suffix -> assistant */
export const AI_HOSTS: [string, string][] = [
  ["chatgpt.com", "ChatGPT"], ["chat.openai.com", "ChatGPT"], ["openai.com", "ChatGPT"],
  ["perplexity.ai", "Perplexity"],
  ["claude.ai", "Claude"],
  ["gemini.google.com", "Gemini"], ["bard.google.com", "Gemini"], ["aistudio.google.com", "Gemini"], ["notebooklm.google.com", "NotebookLM"],
  ["copilot.microsoft.com", "Copilot"], ["copilot.cloud.microsoft", "Copilot"], ["m365.cloud.microsoft", "Copilot"],
  ["grok.com", "Grok"],
  ["chat.deepseek.com", "DeepSeek"],
  ["chat.mistral.ai", "Le Chat"],
  ["meta.ai", "Meta AI"],
  ["you.com", "You.com"],
  ["phind.com", "Phind"],
  ["poe.com", "Poe"],
  ["chat.qwen.ai", "Qwen"], ["kimi.com", "Kimi"], ["kimi.moonshot.cn", "Kimi"],
  ["huggingface.co/chat", "HuggingChat"],
  ["felo.ai", "Felo"], ["andisearch.com", "Andi"], ["komo.ai", "Komo"],
];
/** utm_source value (lowercased) -> assistant */
export const AI_UTM: [RegExp, string][] = [
  [/^(chatgpt(\.com)?|openai)$/, "ChatGPT"],
  [/^perplexity(\.ai)?$/, "Perplexity"],
  [/^claude(\.ai)?$/, "Claude"],
  [/^gemini$/, "Gemini"],
  [/^copilot$/, "Copilot"],
  [/^grok$/, "Grok"],
  [/^deepseek$/, "DeepSeek"],
  [/^(mistral|lechat)$/, "Le Chat"],
  [/^meta\.?ai$/, "Meta AI"],
  [/^you(\.com)?$/, "You.com"],
  [/^phind$/, "Phind"],
];

const SEARCH = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|yahoo\.co\.jp|yandex\.[a-z]+|baidu\.com|ecosia\.org|qwant\.com|search\.brave\.com|startpage\.com|kagi\.com|naver\.com|seznam\.cz|sogou\.com|so\.com|lilo\.org|metager\.de)$/;
const SOCIAL = /(^|\.)(facebook\.com|fb\.com|m\.facebook\.com|l\.facebook\.com|lm\.facebook\.com|instagram\.com|l\.instagram\.com|t\.co|x\.com|twitter\.com|linkedin\.com|lnkd\.in|reddit\.com|old\.reddit\.com|news\.ycombinator\.com|threads\.net|bsky\.app|mastodon\.social|pinterest\.[a-z.]+|tiktok\.com|snapchat\.com|tumblr\.com|quora\.com|discord\.com|telegram\.org|t\.me|whatsapp\.com|wa\.me|producthunt\.com|indiehackers\.com|substack\.com|medium\.com|dev\.to)$/;
const VIDEO = /(^|\.)(youtube\.com|youtu\.be|m\.youtube\.com|vimeo\.com|twitch\.tv|dailymotion\.com)$/;
const EMAIL = /(^|\.)(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|mail\.yahoo\.com|webmail\.|mail\.proton\.me|app\.fastmail\.com|gmx\.[a-z]+|web\.de)$/;

const PAID_MEDIUM = /^(cpc|cpm|cpv|cpa|ppc|retargeting|paid.*|display|banner|ads?)$/;

export function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}
export function pathOf(url: string): string {
  try { return new URL(url).pathname.slice(0, 300); } catch { return ""; }
}

function aiFromHost(host: string, refUrl: string): string {
  for (const [suffix, name] of AI_HOSTS) {
    if (suffix.includes("/")) { if (refUrl.includes(suffix)) return name; continue; }
    if (host === suffix || host.endsWith(`.${suffix}`)) return name;
  }
  return "";
}

/**
 * @param pageUrl the page being viewed (UTMs, click ids)
 * @param referrer document.referrer, possibly ""
 * @param ownDomain the product's registrable domain: a referrer from it is internal navigation
 */
export function classify(pageUrl: string, referrer: string, ownDomain: string): Touch & { internal: boolean } {
  let q: URLSearchParams;
  try { q = new URL(pageUrl).searchParams; } catch { q = new URLSearchParams(); }
  const get = (k: string) => (q.get(k) ?? "").trim().toLowerCase().slice(0, 100);
  const utm_source = get("utm_source") || get("ref") || get("source");
  const utm_medium = get("utm_medium");
  const utm_campaign = get("utm_campaign");
  const utm_content = get("utm_content");
  const utm_term = get("utm_term");
  const click_id_kind = q.has("gclid") || q.has("gad_source") || q.has("gbraid") || q.has("wbraid") ? "google"
    : q.has("msclkid") ? "microsoft" : q.has("fbclid") ? "meta" : q.has("li_fat_id") ? "linkedin" : q.has("ttclid") ? "tiktok" : q.has("twclid") ? "x" : "";

  const rhost = hostOf(referrer);
  const internal = Boolean(rhost) && (rhost === ownDomain || rhost.endsWith(`.${ownDomain}`));
  const referrer_host = internal ? "" : rhost;

  let channel = "Direct", ai_source = "";
  const paid = PAID_MEDIUM.test(utm_medium) || (click_id_kind !== "" && click_id_kind !== "meta" && click_id_kind !== "linkedin") ;
  const utmAi = AI_UTM.find(([re]) => re.test(utm_source))?.[1] ?? "";
  const hostAi = referrer_host ? aiFromHost(referrer_host, referrer) : "";

  if (paid) channel = SEARCH.test(referrer_host) || click_id_kind === "google" || click_id_kind === "microsoft" ? "Paid Search" : SOCIAL.test(referrer_host) ? "Paid Social" : "Paid Other";
  else if (utmAi || hostAi) { channel = "AI"; ai_source = utmAi || hostAi; }
  else if (utm_medium === "email" || utm_medium === "newsletter" || EMAIL.test(referrer_host) || utm_source === "newsletter") channel = "Email";
  else if (referrer_host && VIDEO.test(referrer_host)) channel = "Organic Video";
  else if ((referrer_host && SOCIAL.test(referrer_host)) || utm_medium === "social" || click_id_kind === "meta" || click_id_kind === "linkedin") channel = "Organic Social";
  else if (referrer_host && SEARCH.test(referrer_host)) channel = "Organic Search";
  else if (referrer_host) channel = "Referral";
  else if (utm_source || utm_medium || utm_campaign) channel = utm_medium === "affiliate" ? "Affiliate" : "Campaign";
  if (internal && !utm_source && !click_id_kind) channel = "Internal";

  return { referrer_host, channel, ai_source, utm_source, utm_medium, utm_campaign, utm_content, utm_term, click_id_kind, internal };
}

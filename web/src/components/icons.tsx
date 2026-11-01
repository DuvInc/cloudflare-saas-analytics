/* Product logos (their own favicons, shipped in public/products) and the small icon before each
   source, place or device in a breakdown. Third-party icons: Google's favicon service for sites,
   flagcdn for flags; a missing image falls back to a neutral glyph. */
import { Bot, Globe, Link2, Mail, Megaphone, Monitor, MousePointerClick, Search, Server, Share2, Smartphone, Tablet, Video } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export function ProductIcon({ id, name, className }: { id: string; name: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={cn("flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-background", className)}>
      {failed ? <span className="text-xs font-semibold">{name.slice(0, 1)}</span>
        : <img src={`/products/${id}.svg`} alt="" className="size-[70%] object-contain" onError={() => setFailed(true)} />}
    </span>
  );
}

const favicon = (domain: string) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
const AI_DOMAINS: Record<string, string> = {
  ChatGPT: "chatgpt.com", Perplexity: "perplexity.ai", Claude: "claude.ai", Gemini: "gemini.google.com", Copilot: "copilot.microsoft.com",
  Grok: "grok.com", DeepSeek: "deepseek.com", "Le Chat": "chat.mistral.ai", "Meta AI": "meta.ai", "You.com": "you.com", Phind: "phind.com",
};
const BROWSERS: Record<string, string> = { Chrome: "google.com/chrome", Safari: "apple.com/safari", Firefox: "firefox.com", Edge: "microsoft.com/edge", Opera: "opera.com", "Samsung Internet": "samsung.com", Brave: "brave.com", Arc: "arc.net" };
const OS: Record<string, string> = { macOS: "apple.com", iOS: "apple.com", Windows: "microsoft.com", Android: "android.com", Linux: "kernel.org", ChromeOS: "google.com/chromebook" };
const CHANNELS: Record<string, React.ComponentType<{ className?: string }>> = {
  "Organic Search": Search, "Paid Search": Search, Direct: Link2, Referral: Globe, AI: Bot, Email: Mail, "Organic Social": Share2, "Paid Social": Share2,
  "Organic Video": Video, "Campaign / Affiliate": Megaphone, "Paid Other": MousePointerClick, Internal: Link2, Serveur: Server,
};

function Img({ src, fallback }: { src: string; fallback: React.ReactNode }) {
  const [failed, setFailed] = useState(false);
  return failed ? <>{fallback}</> : <img src={src} alt="" loading="lazy" className="size-4 shrink-0 rounded-[3px] object-contain" onError={() => setFailed(true)} />;
}

const DOT = <span className="size-4 shrink-0 rounded-full bg-muted" />;

/* Who operates a bot, for its icon. */
const BOT_OWNERS: [RegExp, string][] = [
  [/^(GPTBot|OAI-SearchBot|ChatGPT-User|Operator)/i, "openai.com"], [/^(Claude|anthropic)/i, "anthropic.com"], [/^Perplexity/i, "perplexity.ai"],
  [/^(Google|Gemini)/i, "google.com"], [/^(bingbot|BingPreview)/i, "bing.com"], [/^(meta-|facebook|FacebookBot)/i, "meta.com"],
  [/^Amazon|^Amzn/i, "amazon.com"], [/^Applebot/i, "apple.com"], [/^Bytespider/i, "bytedance.com"], [/^CCBot/i, "commoncrawl.org"],
  [/^(DuckDuck|DuckAssist)/i, "duckduckgo.com"], [/^MistralAI/i, "mistral.ai"], [/^AhrefsBot/i, "ahrefs.com"], [/^SemrushBot/i, "semrush.com"],
  [/^YandexBot/i, "yandex.com"], [/^LinkedInBot/i, "linkedin.com"], [/^Slackbot/i, "slack.com"], [/^Discordbot/i, "discord.com"],
  [/^TwitterBot/i, "x.com"], [/^TelegramBot/i, "telegram.org"], [/^WhatsApp/i, "whatsapp.com"], [/^PetalBot/i, "petalsearch.com"],
  [/^DataForSeo/i, "dataforseo.com"], [/^cohere/i, "cohere.com"], [/^YouBot/i, "you.com"], [/^Baiduspider/i, "baidu.com"],
];

/** The icon of a breakdown value, by dimension. */
export function ValueIcon({ dim, k }: { dim: string; k: string }) {
  switch (dim) {
    case "channel": { const I = CHANNELS[k] ?? Globe; return <I className={cn("size-4 shrink-0", k === "AI" ? "text-viz-ai" : "text-muted-foreground")} />; }
    case "referrer": return <Img src={favicon(k)} fallback={<Globe className="size-4 shrink-0 text-muted-foreground" />} />;
    case "ai": return AI_DOMAINS[k] ? <Img src={favicon(AI_DOMAINS[k]!)} fallback={<Bot className="size-4 text-viz-ai" />} /> : <Bot className="size-4 shrink-0 text-viz-ai" />;
    case "country": return k.length === 2 && k !== "??" ? <Img src={`https://flagcdn.com/${k.toLowerCase()}.svg`} fallback={DOT} /> : <Globe className="size-4 shrink-0 text-muted-foreground" />;
    case "city": { const cc = k.split(", ").pop() ?? ""; return cc.length === 2 ? <Img src={`https://flagcdn.com/${cc.toLowerCase()}.svg`} fallback={DOT} /> : DOT; }
    case "device": { const I = k === "mobile" ? Smartphone : k === "tablet" ? Tablet : Monitor; return <I className="size-4 shrink-0 text-muted-foreground" />; }
    case "browser": return BROWSERS[k] ? <Img src={favicon(BROWSERS[k]!)} fallback={DOT} /> : DOT;
    case "os": return OS[k] ? <Img src={favicon(OS[k]!)} fallback={DOT} /> : DOT;
    case "bot": { const d = BOT_OWNERS.find(([re]) => re.test(k))?.[1]; return d ? <Img src={favicon(d)} fallback={<Bot className="size-4 shrink-0 text-muted-foreground" />} /> : <Bot className="size-4 shrink-0 text-muted-foreground" />; }
    default: return null;
  }
}

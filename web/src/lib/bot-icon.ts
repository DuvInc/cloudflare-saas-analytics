import { BOT_LOGOS } from "./bot-logos";

const BOT_OWNERS: [RegExp, string][] = [
  [/^(GPTBot|OAI-SearchBot|ChatGPT-User|Operator)/i, "openai.com"], [/^(Claude|anthropic)/i, "anthropic.com"], [/^Perplexity/i, "perplexity.ai"],
  [/^(Google|Gemini)/i, "google.com"], [/^(bingbot|BingPreview)/i, "bing.com"], [/^meta-/i, "meta.com"], [/^facebook/i, "facebook.com"],
  [/^(Amazon|Amzn)/i, "amazon.com"], [/^Applebot/i, "apple.com"], [/^CCBot/i, "commoncrawl.org"], [/^Bytespider/i, "tiktok.com"],
  [/^(DuckDuck|DuckAssist)/i, "duckduckgo.com"], [/^MistralAI/i, "mistral.ai"], [/^AhrefsBot/i, "ahrefs.com"], [/^SemrushBot/i, "semrush.com"],
  [/^YandexBot/i, "yandex.com"], [/^LinkedInBot/i, "linkedin.com"], [/^Slackbot/i, "slack.com"], [/^Discordbot/i, "discord.com"],
  [/^TwitterBot/i, "x.com"], [/^TelegramBot/i, "telegram.org"], [/^WhatsApp/i, "whatsapp.com"],
  [/^DataForSeo/i, "dataforseo.com"], [/^cohere/i, "cohere.com"], [/^YouBot/i, "you.com"], [/^Baiduspider/i, "baidu.com"],
  [/^LookioBot/i, "lookio.app"], [/^LinkupBot/i, "linkup.so"], [/^PetalBot/i, "huawei.com"], [/^Yeti/i, "naver.com"], [/^Pinterest/i, "pinterest.com"], [/^redditbot/i, "reddit.com"],
];

export function botLogo(name: string): string | undefined {
  const domain = BOT_OWNERS.find(([pattern]) => pattern.test(name))?.[1];
  return domain ? BOT_LOGOS[domain] : undefined;
}

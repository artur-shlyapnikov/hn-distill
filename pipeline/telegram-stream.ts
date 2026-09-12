import { env } from "@config/env";
import { PATHS, pathFor } from "@config/paths";
import { PostSummarySchema, type NormalizedStory } from "@config/schemas";
import { log } from "@utils/log";
import { readJsonSafeOrStore, type ObjectStore } from "@utils/object-store";
import {
  Telegram,
  buildTelegramMessage,
  parseTelegramError,
  readTelegramLedger,
  writeTelegramLedger,
  type TelegramDigestItem,
  type TelegramLedger,
} from "@utils/telegram";

import type { Services } from "./summarize";

let telegramStreamConfigWarned = false;
let telegramLedgerCache: TelegramLedger | undefined;
let telegramStreamDisabledReason: string | undefined;

function getTelegramStreamConfig(): { chatId: string; botToken: string } | undefined {
  if (!env.TELEGRAM_ENABLE || !env.TELEGRAM_STREAM) {
    return undefined;
  }
  if (telegramStreamDisabledReason) {
    return undefined;
  }
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!chatId || !botToken) {
    if (!telegramStreamConfigWarned) {
      telegramStreamConfigWarned = true;
      log.warn("telegram", "Telegram stream enabled but missing config", {
        hasBotToken: !!botToken,
        hasChatId: !!chatId,
      });
    }
    return undefined;
  }
  return { chatId, botToken };
}

async function getTelegramLedgerCached(): Promise<TelegramLedger> {
  if (!telegramLedgerCache) {
    telegramLedgerCache = await readTelegramLedger(PATHS.telegramSent);
  }
  return telegramLedgerCache;
}

async function persistTelegramLedgerCached(next: TelegramLedger): Promise<void> {
  telegramLedgerCache = next;
  await writeTelegramLedger(PATHS.telegramSent, next);
}

function buildTelegramItemFromStory(story: NormalizedStory, summary: string): TelegramDigestItem {
  return {
    id: story.id,
    title: story.title,
    url: story.url,
    hnUrl: `https://news.ycombinator.com/item?id=${story.id}`,
    postSummary: summary,
    commentsSummary: undefined,
    timeISO: story.timeISO,
  };
}

function extractTelegramErrorCode(message: string): number | undefined {
  const match = /"error_code"\s*:\s*(\d+)/u.exec(message);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function shouldDisableTelegramStream(errorMessage: string): boolean {
  const lowered = errorMessage.toLowerCase();
  if (lowered.includes("chat not found")) {
    return true;
  }
  if (lowered.includes("not enough rights") || lowered.includes("bot was blocked")) {
    return true;
  }
  if (lowered.includes("forbidden")) {
    return true;
  }
  const code = extractTelegramErrorCode(errorMessage);
  return code === 400 || code === 403;
}

async function sendTelegramWithRetries(
  telegram: Telegram,
  message: string,
  storyId: number,
  chatId: string
): Promise<number | undefined> {
  const maxRetries = env.TELEGRAM_MAX_RATE_LIMIT_RETRIES;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      const messageId = await telegram.sendMessage({
        chatId,
        text: message,
        parseMode: "HTML",
        disableWebPagePreview: true,
        disableNotification: env.TELEGRAM_DISABLE_NOTIFICATIONS,
        ...(env.TELEGRAM_MESSAGE_THREAD_ID && { messageThreadId: env.TELEGRAM_MESSAGE_THREAD_ID }),
      });
      return messageId;
    } catch (error) {
      if (error instanceof Error && (error.message.includes("429") || error.message.includes("Too Many Requests"))) {
        const { retryAfter, description } = parseTelegramError(error.message);
        const waitSeconds = retryAfter ?? 30;
        const backoffMultiplier = Math.pow(1.5, retryCount);
        const totalWait = Math.ceil(waitSeconds * backoffMultiplier);

        log.warn("telegram", "Rate limit hit, waiting before retry", {
          storyId,
          retryAfter: waitSeconds,
          retryCount: retryCount + 1,
          maxRetries,
          description,
        });

        await new Promise((resolve) => setTimeout(resolve, (totalWait + 1) * 1000));
        retryCount++;
        continue;
      }

      if (error instanceof Error && shouldDisableTelegramStream(error.message)) {
        telegramStreamDisabledReason = "chat not found or bot has no rights";
        log.error("telegram", "Disabling telegram stream for this run", {
          storyId,
          reason: telegramStreamDisabledReason,
          error: error.message,
        });
        return undefined;
      }

      log.error("telegram", "Failed to send Telegram message", {
        storyId,
        error: String(error),
      });
      return undefined;
    }
  }

  log.error("telegram", "Failed to send Telegram message after retries", {
    storyId,
    maxRetries,
  });
  return undefined;
}

export async function publishTelegramAfterSummary(
  services: Services,
  story: NormalizedStory,
  store: ObjectStore
): Promise<void> {
  const cfg = getTelegramStreamConfig();
  if (!cfg) {
    return;
  }

  const post = await readJsonSafeOrStore(store, pathFor.postSummary(story.id), PostSummarySchema);
  const summary = post?.summary?.trim();
  if (!summary) {
    return;
  }

  const ledger = await getTelegramLedgerCached();
  if (ledger.sentIds.includes(story.id)) {
    log.debug("telegram", "Story already sent, skipping", { id: story.id });
    return;
  }

  const item = buildTelegramItemFromStory(story, summary);
  let message = buildTelegramMessage(item, env.SITE);
  const TELEGRAM_LIMIT = 4096;
  if (message.length > TELEGRAM_LIMIT) {
    log.warn("telegram", "Message exceeds Telegram limit, truncating", {
      id: story.id,
      originalLength: message.length,
      limit: TELEGRAM_LIMIT,
    });
    message = `${message.slice(0, TELEGRAM_LIMIT - 3)}...`;
  }

  const telegram = new Telegram(services.http, cfg.botToken);
  const messageId = await sendTelegramWithRetries(telegram, message, story.id, cfg.chatId);
  if (!messageId) {
    return;
  }

  const nextIds = [...new Set([...(ledger.sentIds ?? []), story.id])];
  await persistTelegramLedgerCached({
    sentIds: nextIds,
    lastUpdatedISO: new Date().toISOString(),
  });

  log.info("telegram", "Streamed story to Telegram", {
    id: story.id,
    messageId,
  });

  if (env.TELEGRAM_MESSAGE_DELAY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, env.TELEGRAM_MESSAGE_DELAY_MS));
  }
}

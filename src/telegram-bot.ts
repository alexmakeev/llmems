// src/telegram-bot.ts
// Telegram bot entry point — webhook mode using grammY + built-in node:http.

import { Bot, InlineKeyboard, InputFile, webhookCallback } from 'grammy';
import type { Context } from 'grammy';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ChatManager } from './services/chat-manager.ts';
import { ALTME_TOOLS } from './tools/altme-tools.ts';
import { sanitizeTelegramHtml } from './utils/telegram-html.ts';
import { checkUserAuthorized } from './utils/telegram-auth.ts';
import { DEFAULT_SYSTEM_PROMPT } from './prompts/altme.ts';
import { transcribeAudio } from './services/transcription.ts';
import { searchQuick, webResearch } from './services/web-search.ts';
import { sanitizeHtmlContent } from './utils/sanitize-html.ts';
import { fileLog } from './utils/file-logger.ts';
import { BillingService, ACTION_COSTS, TARIFF_PACKAGES } from './services/billing-service.ts';

// ── Version info ─────────────────────────────────────────────────────────────

const startTime = Date.now();

// ── Cached HTML template (read once at startup) ─────────────────────────────
const DOCUMENT_TEMPLATE = readFileSync(
  path.join(import.meta.dirname!, 'templates', 'document.html'),
  'utf-8',
);

// ── Environment variables ──────────────────────────────────────────────────────

const TELEGRAM_BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN'];
if (!TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

const POSTGRES_URL = process.env['POSTGRES_URL'];
if (!POSTGRES_URL) {
  console.error('POSTGRES_URL is required');
  process.exit(1);
}

const OPENROUTER_API_KEY = process.env['OPENROUTER_API_KEY'];
if (!OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is required');
  process.exit(1);
}

const WEBHOOK_DOMAIN = process.env['WEBHOOK_DOMAIN'] ?? 'openrouterchat.am32.oneln.ru';
const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const MODEL_NAME = process.env['MODEL_NAME'] ?? 'google/gemini-2.5-flash';
const SYSTEM_PROMPT = process.env['SYSTEM_PROMPT'] ?? DEFAULT_SYSTEM_PROMPT;

// ── User whitelist ───────────────────────────────────────────────────────────

const ALLOWED_USERS_RAW = process.env['ALLOWED_USERS'] || '';
const ALLOWED_USER_IDS = new Set<number>();
const ALLOWED_USERNAMES = new Set<string>();

for (const entry of ALLOWED_USERS_RAW.split(',').map(s => s.trim()).filter(Boolean)) {
  if (entry.startsWith('@')) {
    ALLOWED_USERNAMES.add(entry.slice(1).toLowerCase());
  } else {
    const id = parseInt(entry, 10);
    if (!isNaN(id)) ALLOWED_USER_IDS.add(id);
  }
}

function isUserAllowed(userId: number, username?: string): boolean {
  // If no whitelist configured, allow everyone
  if (ALLOWED_USER_IDS.size === 0 && ALLOWED_USERNAMES.size === 0) return true;
  if (ALLOWED_USER_IDS.has(userId)) return true;
  if (username && ALLOWED_USERNAMES.has(username.toLowerCase())) return true;
  return false;
}

// ── Bot setup ──────────────────────────────────────────────────────────────────

const bot = new Bot(TELEGRAM_BOT_TOKEN);

const chatManager = new ChatManager({
  postgresUrl: POSTGRES_URL,
  openRouterApiKey: OPENROUTER_API_KEY,
  systemPrompt: SYSTEM_PROMPT,
  model: MODEL_NAME,
});

const billingService = new BillingService(POSTGRES_URL);

// ── Small-group detection (user + bot only → treat as private chat) ──────────

// Cache: chatId → { count, cachedAt }
const memberCountCache = new Map<number, { count: number; cachedAt: number }>();
const activatePromptCache = new Map<number, number>(); // groupId → last prompt timestamp
const awaitingCouponCode = new Set<number>(); // user IDs waiting for coupon code input
const MEMBER_COUNT_CACHE_TTL = 60 * 60 * 1000; // 1 hour

export async function isSmallGroup(ctx: Context): Promise<boolean> {
  if (!ctx.chat || ctx.chat.type === 'private') return false;

  const chatId = ctx.chat.id;
  const now = Date.now();
  const cached = memberCountCache.get(chatId);

  if (cached && (now - cached.cachedAt) < MEMBER_COUNT_CACHE_TTL) {
    return cached.count <= 2;
  }

  try {
    const count = await ctx.api.getChatMemberCount(chatId);
    memberCountCache.set(chatId, { count, cachedAt: now });
    return count <= 2;
  } catch {
    return false; // on error, assume it's a large group
  }
}

// ── Helper functions ─────────────────────────────────────────────────────────

/**
 * Compute contextId from grammY Context using ChatManager's static method.
 */
function getContextId(ctx: Context): string {
  const chatId = ctx.chat!.id;
  const chatType = ctx.chat!.type;
  const threadId = ctx.message?.message_thread_id;
  return ChatManager.getContextId(chatId, chatType, threadId);
}

/**
 * Format a user message for the LLM. In group chats, prefix with sender name
 * so the model knows who is speaking.
 */
function formatMessageForGroup(ctx: Context): string {
  const senderName = ctx.from?.first_name || ctx.from?.username || 'Unknown';
  const text = ctx.message?.text || '';
  const chatType = ctx.chat?.type;
  if (chatType === 'private') return text;
  return `${senderName}: ${text}`;
}

/**
 * Strip sender name prefix from LLM response.
 * In group chats, the LLM sometimes echoes back the "Name: " format it sees in input.
 * This removes that prefix so the bot's reply doesn't redundantly start with the sender's name.
 */
function stripSenderNamePrefix(text: string, ctx: Context): string {
  if (ctx.chat?.type === 'private') return text;
  const senderName = ctx.from?.first_name || '';
  if (!senderName) return text;
  if (text.startsWith(senderName + ':')) {
    return text.substring(senderName.length + 1).trimStart();
  }
  return text;
}

/**
 * Build reply options, including message_thread_id for topic threads.
 */
function buildReplyOptions(ctx: Context, parseMode?: 'HTML'): Record<string, unknown> {
  const opts: Record<string, unknown> = {};
  if (parseMode) opts['parse_mode'] = parseMode;
  const threadId = ctx.message?.message_thread_id;
  if (threadId !== undefined) opts['message_thread_id'] = threadId;
  return opts;
}

// ── Tool selection logic ─────────────────────────────────────────────────────

/**
 * Select which tools to send to the LLM based on chat type and sender role.
 * No keyword heuristics — the model receives all relevant tools and decides itself.
 */
export function selectTools(chatType: string, isAdmin: boolean, isVoiceMessage: boolean = false): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // stay_silent — only in group chats, never for voice messages
  if (chatType !== 'private' && !isVoiceMessage) {
    const staySilent = ALTME_TOOLS.find(t => t.function.name === 'stay_silent');
    if (staySilent) tools.push(staySilent);
  }

  // set_behavior_instructions — always available for admins
  // In private chats, user is always "admin" (checkUserAuthorized returns true)
  // In groups, only actual admins can change behavior
  if (isAdmin) {
    const setBehavior = ALTME_TOOLS.find(t => t.function.name === 'set_behavior_instructions');
    if (setBehavior) tools.push(setBehavior);
  }

  // search_quick — always available
  const searchQuickTool = ALTME_TOOLS.find(t => t.function.name === 'search_quick');
  if (searchQuickTool) tools.push(searchQuickTool);

  // web_research — always available
  const webResearchTool = ALTME_TOOLS.find(t => t.function.name === 'web_research');
  if (webResearchTool) tools.push(webResearchTool);

  // send_html_document — always available
  const sendHtml = ALTME_TOOLS.find(t => t.function.name === 'send_html_document');
  if (sendHtml) tools.push(sendHtml);

  return tools;
}

// ── Pending behavior instructions (in-memory) ───────────────────────────────

const pendingInstructions = new Map<string, {
  instructions: string;
  requestedBy: number;
}>();

/**
 * Send an inline keyboard confirmation for a behavior instruction change.
 */
async function handleBehaviorInstructionsRequest(
  ctx: Context,
  contextId: string,
  instructions: string,
  requestedBy: number,
): Promise<void> {
  pendingInstructions.set(contextId, { instructions, requestedBy });

  const keyboard = new InlineKeyboard()
    .text('\u2705 Применить', `bi_approve:${contextId}`)
    .text('\u274c Отменить', `bi_cancel:${contextId}`);

  const replyOpts = buildReplyOptions(ctx);
  replyOpts['reply_markup'] = keyboard;

  await ctx.reply(
    `\ud83d\udccb Новая инструкция поведения:\n\n${instructions}\n\nПрименить?`,
    replyOpts,
  );
}

// ── Handlers ───────────────────────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  await ctx.reply(
    "Hi! I'm AltMe, your personal companion bot. \ud83d\udc4b\n\n" +
    "I'm here to listen, support, and help you reflect on life. " +
    "Share what's on your mind \u2014 I'm all ears!",
  );
});

/**
 * Process a user message through the LLM and reply.
 * Shared by both text and voice message handlers.
 */
async function processMessageAndReply(ctx: Context, userMessage: string, options?: { isVoiceMessage?: boolean }): Promise<void> {
  const contextId = getContextId(ctx);
  let billingAction: string | null = options?.isVoiceMessage ? 'voice_message' : 'text_message';

  console.log('[process] start, contextId:', contextId, 'chatType:', ctx.chat?.type, 'isVoice:', options?.isVoiceMessage ?? false, 'msgPreview:', userMessage.substring(0, 80));
  void fileLog.info('process_start', { contextId, chatType: ctx.chat?.type, isVoice: options?.isVoiceMessage ?? false, msgPreview: userMessage.substring(0, 120), userId: ctx.from?.id });

  // --- Billing: resolve payer and check balance ---
  const chatType = ctx.chat?.type ?? 'private';
  const chatId = ctx.chat?.id ?? 0;
  const senderId = ctx.from?.id ?? 0;

  const payer = await billingService.resolvePayer(chatId, chatType, senderId);

  if (!payer.found) {
    // Group without owner — send activation prompt (rate-limited)
    const now = Date.now();
    const lastPrompt = activatePromptCache.get(chatId);
    if (!lastPrompt || now - lastPrompt > 5 * 60 * 1000) {
      activatePromptCache.set(chatId, now);
      await ctx.reply(
        '\u0414\u043B\u044F \u0440\u0430\u0431\u043E\u0442\u044B \u0431\u043E\u0442\u0430 \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440 \u0433\u0440\u0443\u043F\u043F\u044B \u0434\u043E\u043B\u0436\u0435\u043D \u0435\u0433\u043E \u0430\u043A\u0442\u0438\u0432\u0438\u0440\u043E\u0432\u0430\u0442\u044C.',
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '\u{1F511} \u0410\u043A\u0442\u0438\u0432\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0431\u043E\u0442\u0430', callback_data: 'activate_group' },
            ]],
          },
        }
      );
    }
    return;
  }

  const payerBalance = await billingService.getBalance(payer.payerId);
  if (payerBalance <= 0) {
    await ctx.reply(
      '\u26A0\uFE0F \u0411\u0430\u043B\u0430\u043D\u0441 \u0438\u0441\u0447\u0435\u0440\u043F\u0430\u043D. \u041F\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u0435 \u0431\u0430\u043B\u0430\u043D\u0441 \u0434\u043B\u044F \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0435\u043D\u0438\u044F \u0440\u0430\u0431\u043E\u0442\u044B.\n' +
      '\u0418\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 /topup \u0434\u043B\u044F \u043F\u043E\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u044F.'
    );
    return;
  }

  await ctx.replyWithChatAction('typing');

  const chat = await chatManager.getChat(contextId);
  console.log('[process] chat obtained for contextId:', contextId);

  // Small groups (user + bot only) behave like private chats — no stay_silent
  const smallGroup = await isSmallGroup(ctx);
  const effectiveChatType = smallGroup ? 'private' : ctx.chat!.type;
  console.log('[process] smallGroup:', smallGroup, 'effectiveChatType:', effectiveChatType);

  // Check if sender is admin (for tool selection)
  const isAdmin = await checkUserAuthorized(ctx, ctx.from!.id);
  console.log('[process] isAdmin:', isAdmin);

  const tools = selectTools(effectiveChatType, isAdmin, options?.isVoiceMessage ?? false);
  const toolNames = tools.map(t => t.function.name);
  console.log('[process] tools:', toolNames.join(', '));
  void fileLog.info('tools_selected', { contextId, tools: toolNames, effectiveChatType, isAdmin, isVoice: options?.isVoiceMessage ?? false });

  // If no tools selected, use regular prompt() — faster, no tool confusion
  if (tools.length === 0) {
    console.log('[process] no tools, using prompt()');
    const result = await chat.prompt(userMessage);
    console.log('[process] prompt() returned, ok:', result.ok);
    if (!result.ok) {
      await ctx.reply(
        `Sorry, I encountered an error: ${result.error.message}`,
        buildReplyOptions(ctx),
      );
      return;
    }
    const { text: sanitized, hasHtml } = sanitizeTelegramHtml(result.value.text);
    const cleaned = stripSenderNamePrefix(sanitized, ctx);
    await ctx.reply(cleaned, buildReplyOptions(ctx, hasHtml ? 'HTML' : undefined));
    // --- Billing: deduct tokens ---
    if (billingAction) {
      const cost = ACTION_COSTS[billingAction] ?? 1;
      await billingService.deductTokens(payer.payerId, cost, billingAction, contextId);
    }
    return;
  }

  // Tools are relevant — use promptWithTools()
  console.log('[process] calling promptWithTools()');
  const result = await chat.promptWithTools(userMessage, tools);
  console.log('[process] promptWithTools() returned, ok:', result.ok);

  if (!result.ok) {
    await ctx.reply(
      `Sorry, I encountered an error: ${result.error.message}`,
      buildReplyOptions(ctx),
    );
    return;
  }

  const { text, toolCalls } = result.value;

  void fileLog.info('llm_response', {
    contextId,
    hasText: !!text,
    textPreview: text?.substring(0, 120),
    toolCalls: toolCalls.map(tc => ({ name: tc.function.name, args: tc.function.arguments.substring(0, 200) })),
  });

  // Handle tool calls
  for (const toolCall of toolCalls) {
    switch (toolCall.function.name) {
      case 'stay_silent':
        billingAction = null;
        return; // Don't reply at all

      case 'set_behavior_instructions': {
        let args: { new_instructions?: string };
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          console.warn('Failed to parse tool call arguments:', toolCall.function.arguments);
          break;
        }
        if (typeof args.new_instructions !== 'string' || !args.new_instructions.trim()) {
          console.warn('Invalid set_behavior_instructions arguments:', args);
          break;
        }
        await handleBehaviorInstructionsRequest(
          ctx,
          contextId,
          args.new_instructions,
          ctx.from!.id,
        );
        // If there's also text, send it alongside
        if (text) {
          const { text: sanitized, hasHtml } = sanitizeTelegramHtml(text);
          const cleaned = stripSenderNamePrefix(sanitized, ctx);
          await ctx.reply(cleaned, buildReplyOptions(ctx, hasHtml ? 'HTML' : undefined));
        }
        billingAction = null; // no charge for behavior instructions
        return;
      }

      case 'search_quick': {
        let args: { query?: string };
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          console.warn('Failed to parse search_quick arguments:', toolCall.function.arguments);
          break;
        }
        if (typeof args.query !== 'string' || !args.query.trim()) {
          console.warn('Invalid search_quick arguments:', args);
          break;
        }

        await ctx.replyWithChatAction('typing');

        let result: string;
        try {
          result = await searchQuick(args.query, OPENROUTER_API_KEY);
        } catch (searchErr) {
          console.error('Quick search error:', searchErr);
          await ctx.reply(
            'Sorry, the web search failed. Please try again later.',
            buildReplyOptions(ctx),
          );
          return;
        }

        if (!result.trim()) {
          await ctx.reply(
            'The search returned no results.',
            buildReplyOptions(ctx),
          );
          return;
        }

        await ctx.reply(result, buildReplyOptions(ctx));
        await chat.storeAssistantMessage(`[\u{1F50D} Quick: ${args.query}]\n${result}`);
        // --- Billing: deduct tokens ---
        await billingService.deductTokens(payer.payerId, ACTION_COSTS['search_quick'] ?? 3, 'search_quick', contextId);
        return;
      }

      case 'web_research': {
        let args: { query?: string; caption?: string; filename?: string };
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          console.warn('Failed to parse web_research arguments:', toolCall.function.arguments);
          break;
        }
        if (typeof args.query !== 'string' || !args.query.trim()) {
          console.warn('Invalid web_research arguments:', args);
          break;
        }

        await ctx.replyWithChatAction('upload_document');

        let researchResult: { text: string; html: string };
        try {
          researchResult = await webResearch(args.query, OPENROUTER_API_KEY);
        } catch (researchErr) {
          console.error('Web research error:', researchErr);
          await ctx.reply(
            'Sorry, the web research failed. Please try again later.',
            buildReplyOptions(ctx),
          );
          return;
        }

        // Sanitize and wrap in cached template
        const fullHtml = DOCUMENT_TEMPLATE.replace('{{CONTENT}}', sanitizeHtmlContent(researchResult.html));

        // Save and send — use semantic filename from args
        const researchSuffix = Array.from({ length: 2 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
        const researchFilename = args.filename ? `${args.filename}-${researchSuffix}.html` : `research-${researchSuffix}.html`;
        const tmpPath = path.join(os.tmpdir(), `altme_research_${Date.now()}.html`);
        await writeFile(tmpPath, fullHtml, 'utf-8');
        await ctx.replyWithDocument(new InputFile(tmpPath, researchFilename), {
          caption: args.caption || `\u{1F50D} ${args.query}`,
          ...buildReplyOptions(ctx),
        });
        await unlink(tmpPath).catch(() => {});

        // Store in memory: raw search result (for fact recall)
        await chat.storeAssistantMessage(`[\u{1F4C4} \u0418\u0441\u0441\u043B\u0435\u0434\u043E\u0432\u0430\u043D\u0438\u0435: ${args.caption || args.query}]\n${researchResult.text}`);
        // --- Billing: deduct tokens ---
        await billingService.deductTokens(payer.payerId, ACTION_COSTS['web_research'] ?? 25, 'web_research', contextId);
        return;
      }

      case 'send_html_document': {
        let args: { html_content?: string; caption?: string; summary?: string; filename?: string };
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          console.warn('Failed to parse send_html_document arguments:', toolCall.function.arguments);
          break;
        }
        if (typeof args.html_content !== 'string' || typeof args.caption !== 'string' || typeof args.summary !== 'string') {
          console.warn('Invalid send_html_document arguments:', args);
          break;
        }

        // Sanitize and inject into cached template
        const fullHtml = DOCUMENT_TEMPLATE.replace('{{CONTENT}}', sanitizeHtmlContent(args.html_content));

        // 3. Save to temp file
        const tmpPath = path.join(os.tmpdir(), `altme_doc_${Date.now()}.html`);
        await writeFile(tmpPath, fullHtml, 'utf-8');

        // 4. Send file — use semantic filename from args
        const docSuffix = Array.from({ length: 2 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
        const docFilename = args.filename ? `${args.filename}-${docSuffix}.html` : `document-${docSuffix}.html`;
        await ctx.replyWithDocument(new InputFile(tmpPath, docFilename), {
          caption: args.caption,
          ...buildReplyOptions(ctx),
        });

        // 5. Clean up temp file
        await unlink(tmpPath).catch(() => {});

        // 6. Store summary in memory (not the full HTML)
        const memoryText = `[\u{1F4C4} \u0414\u043E\u043A\u0443\u043C\u0435\u043D\u0442: ${args.caption}]\n${args.summary}`;
        try {
          await chat.storeAssistantMessage(memoryText);
        } catch (memErr) {
          console.warn('Failed to store document summary in memory:', memErr);
        }
        // --- Billing: deduct tokens ---
        await billingService.deductTokens(payer.payerId, ACTION_COSTS['send_html_document'] ?? 5, 'send_html_document', contextId);
        return;
      }
    }
  }

  // Normal text response (no tool calls or unrecognized tools)
  if (text) {
    const { text: sanitized, hasHtml } = sanitizeTelegramHtml(text);
    const cleaned = stripSenderNamePrefix(sanitized, ctx);
    await ctx.reply(cleaned, buildReplyOptions(ctx, hasHtml ? 'HTML' : undefined));
  }

  // --- Billing: deduct tokens ---
  if (billingAction) {
    const cost = ACTION_COSTS[billingAction] ?? 1;
    await billingService.deductTokens(payer.payerId, cost, billingAction, contextId);
  }
}

bot.on('my_chat_member', async (ctx) => {
  const update = ctx.myChatMember;
  if (!update) return;

  const newStatus = update.new_chat_member.status;
  const oldStatus = update.old_chat_member.status;

  // Bot was added to group (status changed to member/administrator from left/kicked)
  if ((newStatus === 'member' || newStatus === 'administrator') &&
      (oldStatus === 'left' || oldStatus === 'kicked')) {
    const groupId = update.chat.id;
    const ownerId = update.from.id;
    await billingService.setGroupOwner(groupId, ownerId, 'my_chat_member');
    console.log(`[billing] Group owner set: group=${groupId}, owner=${ownerId} via my_chat_member`);
  }
});

bot.command('balance', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const balance = await billingService.getBalance(userId);
  await ctx.reply(
    `\u{1F4B0} \u0412\u0430\u0448 \u0431\u0430\u043B\u0430\u043D\u0441: ${balance} \u0442\u043E\u043A\u0435\u043D\u043E\u0432\n\n` +
    `\u0421\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0439:\n` +
    `\u2022 \u0422\u0435\u043A\u0441\u0442\u043E\u0432\u043E\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u2014 1 \u0442\u043E\u043A\u0435\u043D\n` +
    `\u2022 \u0413\u043E\u043B\u043E\u0441\u043E\u0432\u043E\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u2014 2 \u0442\u043E\u043A\u0435\u043D\u0430\n` +
    `\u2022 \u0411\u044B\u0441\u0442\u0440\u044B\u0439 \u043F\u043E\u0438\u0441\u043A \u2014 3 \u0442\u043E\u043A\u0435\u043D\u0430\n` +
    `\u2022 HTML-\u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442 \u2014 5 \u0442\u043E\u043A\u0435\u043D\u043E\u0432\n` +
    `\u2022 \u0413\u043B\u0443\u0431\u043E\u043A\u043E\u0435 \u0438\u0441\u0441\u043B\u0435\u0434\u043E\u0432\u0430\u043D\u0438\u0435 \u2014 25 \u0442\u043E\u043A\u0435\u043D\u043E\u0432\n\n` +
    `\u041F\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u044C \u0431\u0430\u043B\u0430\u043D\u0441: /topup`
  );
});

bot.command('topup', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const balance = await billingService.getBalance(userId);

  const keyboard = {
    inline_keyboard: [
      ...TARIFF_PACKAGES.map(t => ([{
        text: `\u2B50 ${t.label} \u2014 ${t.stars} Stars (${t.tokens.toLocaleString()} \u0442\u043E\u043A\u0435\u043D\u043E\u0432)`,
        callback_data: `topup_${t.id}`,
      }])),
      [{ text: '\u{1F39F}\uFE0F \u0412\u0432\u0435\u0441\u0442\u0438 \u043A\u0443\u043F\u043E\u043D', callback_data: 'enter_coupon' }],
    ],
  };

  await ctx.reply(
    `\u{1F4B0} \u0411\u0430\u043B\u0430\u043D\u0441: ${balance} \u0442\u043E\u043A\u0435\u043D\u043E\u0432\n\n\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043F\u0430\u043A\u0435\u0442 \u0434\u043B\u044F \u043F\u043E\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u044F:`,
    { reply_markup: keyboard }
  );
});

bot.on('pre_checkout_query', async (ctx) => {
  // Always approve — Telegram Stars payments are instant
  await ctx.answerPreCheckoutQuery(true);
});

bot.on('message:successful_payment', async (ctx) => {
  const payment = ctx.message.successful_payment;
  if (!payment) return;

  const userId = ctx.from?.id;
  if (!userId) return;

  const stars = payment.total_amount; // For XTR, amount = stars count
  const tariff = billingService.findTariffByStars(stars);
  const tokens = tariff?.tokens ?? stars * 10; // fallback: 1 star = 10 tokens

  try {
    await billingService.creditTokens(userId, tokens, 'stars_purchase', {
      stars,
      telegramPaymentChargeId: payment.telegram_payment_charge_id,
    });

    const balance = await billingService.getBalance(userId);
    await ctx.reply(
      `\u2705 \u041E\u043F\u043B\u0430\u0442\u0430 \u043F\u0440\u043E\u0448\u043B\u0430! \u041D\u0430\u0447\u0438\u0441\u043B\u0435\u043D\u043E ${tokens.toLocaleString()} \u0442\u043E\u043A\u0435\u043D\u043E\u0432.\n` +
      `\u{1F4B0} \u0411\u0430\u043B\u0430\u043D\u0441: ${balance.toLocaleString()} \u0442\u043E\u043A\u0435\u043D\u043E\u0432`
    );
  } catch (error) {
    console.error('[billing] CRITICAL: Failed to credit tokens after payment!', {
      userId,
      stars,
      tokens,
      chargeId: payment.telegram_payment_charge_id,
      error,
    });
    await ctx.reply(
      '\u26A0\uFE0F \u041E\u043F\u043B\u0430\u0442\u0430 \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u0430, \u043D\u043E \u043F\u0440\u043E\u0438\u0437\u043E\u0448\u043B\u0430 \u043E\u0448\u0438\u0431\u043A\u0430 \u043F\u0440\u0438 \u043D\u0430\u0447\u0438\u0441\u043B\u0435\u043D\u0438\u0438 \u0442\u043E\u043A\u0435\u043D\u043E\u0432. ' +
      '\u041E\u0431\u0440\u0430\u0442\u0438\u0442\u0435\u0441\u044C \u0432 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u043A\u0443 \u2014 \u043C\u044B \u043D\u0430\u0447\u0438\u0441\u043B\u0438\u043C \u0442\u043E\u043A\u0435\u043D\u044B \u0432\u0440\u0443\u0447\u043D\u0443\u044E.'
    );
  }
});

bot.on('message:voice', async (ctx) => {
  if (!ctx.chat || !ctx.from) return;
  if (!isUserAllowed(ctx.from.id, ctx.from.username)) {
    await ctx.reply('Извините, бот недоступен. Обратитесь к разработчику.');
    return;
  }

  console.log('[voice] received, chat:', ctx.chat.id, 'type:', ctx.chat.type, 'thread:', ctx.message?.message_thread_id, 'from:', ctx.from.id);

  try {
    await ctx.replyWithChatAction('typing');

    // Download voice file from Telegram
    const file = await ctx.getFile();
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(fileUrl);
    const audioBuffer = Buffer.from(await response.arrayBuffer());

    console.log('[voice] downloaded, size:', audioBuffer.length, 'bytes');

    // Transcribe audio to text
    const transcription = await transcribeAudio(audioBuffer, 'audio/ogg', OPENROUTER_API_KEY);

    console.log('[voice] transcribed, length:', transcription.length, 'preview:', transcription.substring(0, 80));
    void fileLog.info('voice_transcribed', { chatId: ctx.chat.id, userId: ctx.from.id, length: transcription.length, preview: transcription.substring(0, 120) });

    if (!transcription.trim()) {
      console.log('[voice] empty transcription, replying with error');
      await ctx.reply(
        'Could not recognize speech in the voice message.',
        buildReplyOptions(ctx),
      );
      return;
    }

    // Format transcription the same way as text messages
    // In groups, add voice message marker to signal intentional communication
    const senderName = ctx.from.first_name || ctx.from.username || 'Unknown';
    const chatType = ctx.chat.type;
    const userMessage = chatType === 'private' ? transcription : `${senderName}: [\ud83c\udfa4 \u0433\u043e\u043b\u043e\u0441\u043e\u0432\u043e\u0435] ${transcription}`;

    console.log('[voice] calling processMessageAndReply, contextId:', getContextId(ctx));
    await processMessageAndReply(ctx, userMessage, { isVoiceMessage: true });
    console.log('[voice] processMessageAndReply completed');
  } catch (error) {
    console.error('[voice] error:', error);
    void fileLog.error('voice_error', { chatId: ctx.chat?.id, userId: ctx.from?.id, error: String(error) });
    await ctx.reply(
      'Sorry, something went wrong while processing the voice message.',
      buildReplyOptions(ctx),
    );
  }
});

bot.on('message:text', async (ctx) => {
  if (!ctx.from) return;

  // Coupon code entry — check before other processing
  const couponUserId = ctx.from?.id;
  if (couponUserId && awaitingCouponCode.has(couponUserId)) {
    awaitingCouponCode.delete(couponUserId);
    const code = ctx.message.text.trim();
    const result = await billingService.redeemCoupon(couponUserId, code);
    if (result.ok) {
      await ctx.reply(`\u2705 \u041A\u0443\u043F\u043E\u043D \u0430\u043A\u0442\u0438\u0432\u0438\u0440\u043E\u0432\u0430\u043D! \u041D\u0430\u0447\u0438\u0441\u043B\u0435\u043D\u043E ${result.tokens} \u0442\u043E\u043A\u0435\u043D\u043E\u0432.`);
    } else {
      const reasons: Record<string, string> = {
        not_found: '\u274C \u041A\u0443\u043F\u043E\u043D \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.',
        exhausted: '\u274C \u041A\u0443\u043F\u043E\u043D \u0443\u0436\u0435 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D \u043C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u043E\u0435 \u043A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E \u0440\u0430\u0437.',
        already_redeemed: '\u274C \u0412\u044B \u0443\u0436\u0435 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043B\u0438 \u044D\u0442\u043E\u0442 \u043A\u0443\u043F\u043E\u043D.',
      };
      await ctx.reply(reasons[result.reason] ?? '\u274C \u041E\u0448\u0438\u0431\u043A\u0430 \u0430\u043A\u0442\u0438\u0432\u0430\u0446\u0438\u0438 \u043A\u0443\u043F\u043E\u043D\u0430.');
    }
    return;
  }

  if (!isUserAllowed(ctx.from.id, ctx.from.username)) {
    await ctx.reply('Извините, бот недоступен. Обратитесь к разработчику.');
    return;
  }

  console.log('[text] received, chat:', ctx.chat?.id, 'type:', ctx.chat?.type, 'thread:', ctx.message?.message_thread_id, 'from:', ctx.from?.id, 'hasVoice:', !!ctx.message?.voice);
  const userMessage = formatMessageForGroup(ctx);

  try {
    await processMessageAndReply(ctx, userMessage);
  } catch (error) {
    console.error('[text] error:', error);
    await ctx.reply(
      'Sorry, something went wrong. Please try again later.',
      buildReplyOptions(ctx),
    );
  }
});

// ── Callback query handler (inline keyboard buttons) ─────────────────────────

bot.on('callback_query:data', async (ctx) => {
  if (!isUserAllowed(ctx.from.id, ctx.from.username)) {
    await ctx.answerCallbackQuery({ text: 'Бот недоступен' });
    return;
  }

  // ── Billing: activate_group ──
  if (ctx.callbackQuery.data === 'activate_group') {
    const chatId = ctx.callbackQuery.message?.chat.id;
    const userId = ctx.callbackQuery.from.id;

    if (!chatId) {
      await ctx.answerCallbackQuery({ text: '\u041E\u0448\u0438\u0431\u043A\u0430: \u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0438\u0442\u044C \u0447\u0430\u0442.' });
      return;
    }

    try {
      const member = await ctx.api.getChatMember(chatId, userId);
      if (member.status === 'administrator' || member.status === 'creator') {
        await billingService.setGroupOwner(chatId, userId, 'activate_button');
        const username = ctx.callbackQuery.from.username
          ? `@${ctx.callbackQuery.from.username}`
          : ctx.callbackQuery.from.first_name;
        await ctx.answerCallbackQuery({ text: '\u0411\u043E\u0442 \u0430\u043A\u0442\u0438\u0432\u0438\u0440\u043E\u0432\u0430\u043D!' });
        await ctx.reply(`\u2705 \u0411\u043E\u0442 \u0430\u043A\u0442\u0438\u0432\u0438\u0440\u043E\u0432\u0430\u043D! \u0412\u043B\u0430\u0434\u0435\u043B\u0435\u0446: ${username}`);
      } else {
        await ctx.answerCallbackQuery({ text: '\u0422\u043E\u043B\u044C\u043A\u043E \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440 \u0433\u0440\u0443\u043F\u043F\u044B \u043C\u043E\u0436\u0435\u0442 \u0430\u043A\u0442\u0438\u0432\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0431\u043E\u0442\u0430.', show_alert: true });
      }
    } catch (error) {
      console.error('[billing] activate_group error:', error);
      await ctx.answerCallbackQuery({ text: '\u041F\u0440\u043E\u0438\u0437\u043E\u0448\u043B\u0430 \u043E\u0448\u0438\u0431\u043A\u0430. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u043F\u043E\u0437\u0436\u0435.' });
    }
    return;
  }

  // ── Billing: enter_coupon ──
  if (ctx.callbackQuery.data === 'enter_coupon') {
    const userId = ctx.callbackQuery.from.id;
    awaitingCouponCode.add(userId);
    await ctx.answerCallbackQuery();
    await ctx.reply('\u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u043A\u043E\u0434 \u043A\u0443\u043F\u043E\u043D\u0430:');
    return;
  }

  // ── Billing: topup_* ──
  if (ctx.callbackQuery.data?.startsWith('topup_')) {
    const tariffId = ctx.callbackQuery.data.slice(6); // remove 'topup_'
    const tariff = TARIFF_PACKAGES.find(t => t.id === tariffId);

    if (!tariff) {
      await ctx.answerCallbackQuery({ text: '\u0422\u0430\u0440\u0438\u0444 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.' });
      return;
    }

    await ctx.answerCallbackQuery();

    // Send invoice for Telegram Stars payment
    await ctx.api.sendInvoice(
      ctx.callbackQuery.from.id,
      `${tariff.label} \u2014 ${tariff.tokens.toLocaleString()} \u0442\u043E\u043A\u0435\u043D\u043E\u0432`,
      `\u041F\u043E\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435 \u0431\u0430\u043B\u0430\u043D\u0441\u0430 AltMe \u043D\u0430 ${tariff.tokens.toLocaleString()} \u0442\u043E\u043A\u0435\u043D\u043E\u0432`,
      `${tariff.id}_${Date.now()}`, // payload
      'XTR', // currency: Telegram Stars
      [{ label: tariff.label, amount: tariff.stars }],
    );
    return;
  }

  const data = ctx.callbackQuery.data;
  const userId = ctx.from.id;

  if (!data.startsWith('bi_approve:') && !data.startsWith('bi_cancel:')) {
    await ctx.answerCallbackQuery();
    return;
  }

  const action = data.startsWith('bi_approve:') ? 'approve' : 'cancel';
  const contextId = data.substring(data.indexOf(':') + 1);

  const pending = pendingInstructions.get(contextId);
  if (!pending) {
    await ctx.answerCallbackQuery({ text: 'Запрос устарел' });
    return;
  }

  const authorized = await checkUserAuthorized(ctx, userId);
  if (!authorized) {
    await ctx.answerCallbackQuery({ text: 'Только администраторы могут изменять инструкции' });
    return;
  }

  if (action === 'approve') {
    await chatManager.setBehaviorInstructions(pending.instructions, contextId);
    pendingInstructions.delete(contextId);
    await ctx.editMessageText('\u2705 Инструкция поведения обновлена');
    await ctx.answerCallbackQuery();
    void fileLog.info('behavior_approved', { contextId, userId, instructions: pending.instructions.substring(0, 200) });
  } else {
    pendingInstructions.delete(contextId);
    await ctx.editMessageText('\u274c Изменение отменено');
    await ctx.answerCallbackQuery();
    void fileLog.info('behavior_cancelled', { contextId, userId });
  }
});

// ── Error boundary ──────────────────────────────────────────────────────────

bot.catch((err) => {
  console.error('Unhandled bot error:', err);
});

// ── Webhook setup and HTTP server ──────────────────────────────────────────────

const webhookHandler = webhookCallback(bot, 'http', {
  timeoutMilliseconds: 300_000, // LLM calls can take several minutes
});

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  if (req.method === 'GET' && req.url === '/version') {
    const pkg = JSON.parse(await readFile(path.join(import.meta.dirname!, '..', 'package.json'), 'utf-8'));
    const gitCommit = await readFile(path.join(import.meta.dirname!, '..', '.git-commit'), 'utf-8')
      .then(s => s.trim())
      .catch(() => process.env['GIT_COMMIT'] ?? 'unknown');
    const info = {
      version: pkg.version,
      commit: gitCommit,
      startedAt: new Date(startTime).toISOString(),
      uptime: Math.floor((Date.now() - startTime) / 1000) + 's',
      node: process.version,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(info, null, 2));
    return;
  }

  if (req.method === 'POST' && req.url === '/webhook') {
    try {
      await webhookHandler(req, res);
    } catch (err) {
      console.error('Webhook handler error:', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    }
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  console.log('Shutting down...');
  server.close();
  await chatManager.shutdown();
  await billingService.close();
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

// ── Start ──────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  try {
    await bot.init();
    console.log(`Bot initialized: @${bot.botInfo.username}`);
  } catch (err) {
    console.error('Bot init failed:', err);
    process.exit(1);
  }

  const webhookUrl = `https://${WEBHOOK_DOMAIN}/webhook`;

  await bot.api.setWebhook(webhookUrl, {
    allowed_updates: ['message', 'callback_query', 'my_chat_member', 'pre_checkout_query'],
  });
  console.log(`Webhook set to: ${webhookUrl} (allowed_updates: message, callback_query, my_chat_member, pre_checkout_query)`);

  const gitCommit = await readFile(path.join(import.meta.dirname!, '..', '.git-commit'), 'utf-8')
    .then(s => s.trim())
    .catch(() => process.env['GIT_COMMIT'] ?? 'unknown');
  const pkg = JSON.parse(await readFile(path.join(import.meta.dirname!, '..', 'package.json'), 'utf-8'));

  server.listen(PORT, () => {
    console.log(`AltMe bot v${pkg.version} (${gitCommit}) listening on port ${PORT}`);
    void fileLog.info('bot_started', { version: pkg.version, commit: gitCommit, port: PORT, model: MODEL_NAME });
  });
}

void start();

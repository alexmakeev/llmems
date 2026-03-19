// src/tools/altme-tools.ts
// Tool definitions available to the AltMe bot.

import type { ToolDefinition } from '../openrouter-chat.ts';

export type { ToolDefinition };

export const ALTME_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'stay_silent',
      description: 'Do not send any reply. ONLY use in group chats when the message is clearly not directed at you. Never use in private chats.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_behavior_instructions',
      description: 'Update the behavior instructions for this conversation. ONLY use when a user EXPLICITLY asks to change bot behavior using phrases like "change behavior", "set instructions", "измени поведение", "установи инструкцию". Do NOT use for regular questions, conversation, or information requests.',
      parameters: {
        type: 'object',
        properties: {
          new_instructions: {
            type: 'string',
            description: 'The complete new behavior instructions to set for this conversation.',
          },
        },
        required: ['new_instructions'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_quick',
      description: 'Quick web search for simple factual questions: weather, prices, exchange rates, scores, short facts. Returns a brief text answer (1-3 sentences). Use for questions that need a short, current answer. Call IMMEDIATELY when user asks about current facts — do not respond with text first.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query optimized for getting a brief factual answer',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_research',
      description: 'Deep web research on a topic. Searches multiple sources, enriches with additional details and URLs, formats as a beautiful HTML document. Use when user asks for: research, report, analytics, detailed information, guide, comparison, recommendations, how-to guides, detailed reviews. Call IMMEDIATELY — do not respond with text promising to do it later. Takes 15-20 seconds.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Research query — describe what information is needed in detail',
          },
          caption: {
            type: 'string',
            description: 'Short message to accompany the document (1-2 sentences)',
          },
          filename: {
            type: 'string',
            description: 'Semantic filename for the document (2-4 words describing content, e.g. "mexico-travel-guide"). Will be used as the downloaded file name. Use lowercase, hyphens between words, no extension.',
          },
        },
        required: ['query', 'caption', 'filename'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_html_document',
      description: 'Send a detailed response as an HTML document file. Use when the answer requires detailed formatting, long lists, tables, or structured content that would be too long for a chat message (more than 2-3 paragraphs). The HTML is wrapped in a beautiful responsive template.',
      parameters: {
        type: 'object',
        properties: {
          html_content: {
            type: 'string',
            description: 'The HTML content body. Use standard tags: h1-h3, p, ul/ol/li, table, blockquote, code/pre, strong, em, a, hr. Components: <div class="accordion"><div class="accordion-item"><div class="accordion-header">Title</div><div class="accordion-body">Content</div></div></div> | <div class="tabs"><div class="tab-header"><button class="tab-btn active" data-tab="id">Tab</button></div><div class="tab-content active" id="id">Content</div></div> | <div class="callout info|warning|tip">Text</div> | <div class="card"><div class="card-title">Title</div><div class="card-body">Content</div></div>',
          },
          caption: {
            type: 'string',
            description: 'Short message to send alongside the file (1-2 sentences)',
          },
          summary: {
            type: 'string',
            description: 'Brief summary of the document content for memory storage (2-3 sentences)',
          },
          filename: {
            type: 'string',
            description: 'Semantic filename for the document (2-4 words describing content, e.g. "mexico-travel-guide"). Will be used as the downloaded file name. Use lowercase, hyphens between words, no extension.',
          },
        },
        required: ['html_content', 'caption', 'summary', 'filename'],
      },
    },
  },
];

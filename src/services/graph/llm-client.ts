// src/services/graph/llm-client.ts
// Shared factory for creating the Gemini-compatible OpenAI client.

import OpenAI from 'openai';
import type { GraphConfig } from './types.js';

/**
 * Create an OpenAI-compatible client pointing at Gemini directly
 * (when geminiApiKey is set) or at OpenRouter (fallback).
 *
 * Note: openaiBaseUrl is NOT passed here — Gemini/Google endpoints are fixed.
 * Only GraphEmbeddingService supports custom baseUrl (for OpenRouter routing).
 */
export function createGeminiClient(
  config: Pick<GraphConfig, 'geminiApiKey' | 'openaiApiKey'>,
): OpenAI {
  const useOpenRouter = config.geminiApiKey === undefined || config.geminiApiKey === '';
  return new OpenAI({
    apiKey: useOpenRouter ? config.openaiApiKey : config.geminiApiKey,
    baseURL: useOpenRouter
      ? 'https://openrouter.ai/api/v1'
      : 'https://generativelanguage.googleapis.com/v1beta/openai',
  });
}

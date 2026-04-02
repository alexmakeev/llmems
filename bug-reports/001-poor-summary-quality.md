# Bug Report: Poor Summary Quality

**Date:** 2026-03-21
**Severity:** High

---

## Issue 1: Summaries are too short and lose critical facts

### Actual behavior

When a conversation contains rich, factual content, the stored summary collapses it into a near-empty headline.

Example: user asks "How is Maslenitsa celebrated in different countries?" — the bot discusses traditions across Italy, France, Germany, Brazil, the UK, Scandinavia, Poland, and the Czech Republic with specific details for each country. The summary stored is:

> "Alexander asks about Масленица"

Everything is lost: the countries mentioned, the traditions specific to each country, the food, the rituals, the cultural context. The summary is indistinguishable from a conversation where the user just asked "what is Maslenitsa?" with no answer given.

### Expected behavior

A summary must preserve key facts, details, and specifics of what was discussed. It is not a title or a headline — it is a compressed but informative record. Concretely:

- The user's exact request should be preserved in enough detail to understand what was asked
- The key facts from the answer must be retained (countries, traditions, names, numbers, conclusions)
- The summary must allow the bot to reconstruct meaningful context when the original messages are no longer in the active window

An acceptable summary for the Maslenitsa conversation would describe the countries covered and at least one or two key details per country, or a synthesis of what differentiates each tradition.

### Impact

When a user returns to a conversation after a pause (original messages archived), the bot operates only on summaries. If summaries are one-line titles, the bot:

- Cannot continue the conversation with any real context
- Cannot fulfill "do that again" requests
- Cannot recall any specific fact from the prior session

Memory becomes decorative rather than functional. The feature exists but provides no value.

---

## Issue 2: Summary language does not match the user's language

### Actual behavior

User writes in Russian. The summary is stored in English:

> "Alexander asks about Масленица"

The word "Масленица" appears in Cyrillic mid-sentence, but the surrounding text is English. This suggests the LLM generating the summary defaulted to English regardless of the conversation language.

Note: this was reportedly partially addressed in v0.2.3, but the problem persists — at minimum for Russian-language conversations.

### Expected behavior

The summary language must match the language of the conversation. If the user writes in Russian, the summary is in Russian. If the user writes in English, the summary is in English.

This is not a localization nicety — it is a correctness requirement. A summary in a different language from the conversation it describes is harder to read, harder to search, and signals that the summarization pipeline is not treating the source language as a first-class input.

### Impact

For users who communicate in non-English languages, every archived conversation produces summaries in the wrong language. This compounds Issue 1: not only are summaries too thin, they are also in a foreign language to the user.

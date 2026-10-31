/**
 * Path: server/src/prompts/index.ts
 * Used by: server/src/tools/registry.ts.
 * Purpose: The system prompt and built-in tool descriptions, kept as Markdown so they can be read and iterated on directly.
 */

import system from './system.md';
import bash from './tools/bash.md';
import edit from './tools/edit.md';
import read from './tools/read.md';
import write from './tools/write.md';

export const toolDescriptions = {
  bash: bash.trim(),
  edit: edit.trim(),
  read: read.trim(),
  write: write.trim(),
};

export const systemPrompt = (sessionShortId: string) =>
  system.trim().replaceAll('{{SESSION_SHORT_ID}}', sessionShortId);

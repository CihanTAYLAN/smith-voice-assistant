#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const paths = process.argv.slice(2);
if (paths.length === 0)
  throw new Error('kullanim: node scripts/live-probe-count.mjs <setup.json> [...]');
const key = process.env.SMITH_GEMINI_KEY;
if (!key) throw new Error('SMITH_GEMINI_KEY ortam degiskeni yok');

async function count(text) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:countTokens?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
    },
  );
  if (!response.ok) throw new Error(`countTokens HTTP ${response.status}`);
  const result = await response.json();
  return result.totalTokens;
}

for (const path of paths) {
  const setup = JSON.parse(await readFile(path, 'utf8')).setup;
  const system = setup.systemInstruction.parts.map((part) => part.text ?? '').join('\n');
  const tools = setup.tools.flatMap((group) => group.functionDeclarations ?? []);
  const toolRows = [];
  for (const tool of tools) {
    toolRows.push({ ad: tool.name, token: await count(JSON.stringify(tool)) });
  }
  toolRows.sort((a, b) => b.token - a.token);
  const toolText = tools.map((tool) => JSON.stringify(tool)).join('\n');
  const [systemTokens, toolsTokens, combinedTokens] = await Promise.all([
    count(system),
    count(toolText),
    count(`${system}\n${toolText}`),
  ]);
  console.log(
    JSON.stringify({
      setup: path,
      system_tokens: systemTokens,
      tools_tokens: toolsTokens,
      combined_tokens: combinedTokens,
      dynamic_tokens: 0,
      tool_tokens: toolRows,
    }),
  );
}

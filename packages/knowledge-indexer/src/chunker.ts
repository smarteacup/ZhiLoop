import { createHash } from "node:crypto";

import type { KnowledgeAsset } from "@zhiloop/domain";

import type { KnowledgeChunk } from "./types.js";

const DEFAULT_MAX_CHARS = 1_500;
const MIN_MAX_CHARS = 200;
const MAX_MAX_CHARS = 20_000;

function hash(value: string): string {
  return `sha256_${createHash("sha256").update(value).digest("hex")}`;
}

interface Section {
  readonly heading: string;
  readonly occurrence: number;
  readonly content: string;
}

function sections(asset: KnowledgeAsset): readonly Section[] {
  const lines = asset.body.replaceAll("\r\n", "\n").split("\n");
  const headings: string[] = [];
  const counts = new Map<string, number>();
  const output: Section[] = [];
  let currentHeading = asset.title;
  let buffer: string[] = [];

  const push = (): void => {
    const content = buffer.join("\n").trim();
    if (content.length > 0) {
      const occurrence = counts.get(currentHeading) ?? 0;
      counts.set(currentHeading, occurrence + 1);
      output.push({ heading: currentHeading, occurrence, content });
    }
    buffer = [];
  };

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (!match || match[1] === undefined || match[2] === undefined) {
      buffer.push(line);
      continue;
    }
    push();
    const level = match[1].length;
    headings.splice(level - 1);
    headings[level - 1] = match[2];
    currentHeading = headings.filter((item) => item !== undefined).join(" > ");
  }
  push();
  if (output.length === 0) output.push({ heading: asset.title, occurrence: 0, content: asset.summary });
  return output;
}

function boundedParts(content: string, maxChars: number): readonly string[] {
  const paragraphs = content.split(/\n{2,}/u).map((item) => item.trim()).filter(Boolean);
  const parts: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.length > 0) parts.push(current);
    current = "";
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flush();
      for (let offset = 0; offset < paragraph.length; offset += maxChars) {
        parts.push(paragraph.slice(offset, offset + maxChars));
      }
      continue;
    }
    const next = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
    if (next.length > maxChars) flush();
    current = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
  }
  flush();
  return parts;
}

export function chunkKnowledgeAsset(asset: KnowledgeAsset, maxChars = DEFAULT_MAX_CHARS): readonly KnowledgeChunk[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < MIN_MAX_CHARS || maxChars > MAX_MAX_CHARS) {
    throw new Error(`maxChars must be between ${MIN_MAX_CHARS} and ${MAX_MAX_CHARS}`);
  }
  const chunks: KnowledgeChunk[] = [];
  for (const section of sections(asset)) {
    boundedParts(section.content, maxChars).forEach((content, part) => {
      const contentHash = hash(content);
      const chunkId = hash([
        "knowledge-chunk-v1", asset.id, section.heading, String(section.occurrence), String(part), contentHash,
      ].join("\0"));
      chunks.push(Object.freeze({
        chunkId,
        assetId: asset.id,
        assetVersion: asset.version,
        assetContentHash: asset.contentHash,
        ordinal: chunks.length,
        heading: section.heading,
        content,
        contentHash,
      }));
    });
  }
  return Object.freeze(chunks);
}

import type { ChunkOptions, Chunk } from "./types";

export function chunkText(text: string, options: ChunkOptions): Chunk[] {
  const { strategy, chunkSize, overlap } = options;

  if (strategy === "char") {
    return chunkByChar(text, chunkSize, overlap);
  } else if (strategy === "sentence") {
    return chunkBySentence(text, chunkSize, overlap);
  } else {
    return chunkByToken(text, chunkSize, overlap);
  }
}

function chunkByChar(text: string, chunkSize: number, overlap: number): Chunk[] {
  const chunks: Chunk[] = [];
  const step = chunkSize - overlap;
  if (step <= 0) {
    throw new Error("overlap must be less than chunkSize");
  }

  let index = 0;
  let startChar = 0;

  while (startChar < text.length) {
    const endChar = Math.min(startChar + chunkSize, text.length);
    chunks.push({
      text: text.slice(startChar, endChar),
      index,
      startChar,
      endChar,
    });
    index++;
    startChar += step;
  }

  return chunks;
}

function splitIntoSentences(text: string): Array<{ sentence: string; start: number; end: number }> {
  const results: Array<{ sentence: string; start: number; end: number }> = [];
  // Match sentence-ending punctuation followed by a space (or end of string)
  const re = /[^.!?]*(?:[.!?](?:\s|$)|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const sentence = match[0];
    if (sentence.trim().length === 0) continue;
    results.push({
      sentence,
      start: match.index,
      end: match.index + sentence.length,
    });
  }
  return results;
}

function chunkBySentence(text: string, chunkSize: number, overlap: number): Chunk[] {
  const sentences = splitIntoSentences(text);
  const chunks: Chunk[] = [];
  const step = chunkSize - overlap;
  if (step <= 0) {
    throw new Error("overlap must be less than chunkSize");
  }

  let index = 0;
  let sentenceStart = 0;

  while (sentenceStart < sentences.length) {
    const sentenceEnd = Math.min(sentenceStart + chunkSize, sentences.length);
    const group = sentences.slice(sentenceStart, sentenceEnd);
    const chunkText = group.map((s) => s.sentence).join("");
    const startChar = group[0].start;
    const endChar = group[group.length - 1].end;

    chunks.push({
      text: chunkText,
      index,
      startChar,
      endChar,
    });

    index++;
    sentenceStart += step;
  }

  return chunks;
}

function chunkByToken(text: string, chunkSize: number, overlap: number): Chunk[] {
  // Estimate: 1 token ≈ 4 chars
  const charsPerChunk = chunkSize * 4;
  const overlapChars = overlap * 4;
  const step = charsPerChunk - overlapChars;

  if (step <= 0) {
    throw new Error("overlap must be less than chunkSize");
  }

  const chunks: Chunk[] = [];
  let index = 0;
  let startChar = 0;

  while (startChar < text.length) {
    // Find end at word boundary
    let endChar = Math.min(startChar + charsPerChunk, text.length);

    // If not at end of text, walk back to word boundary
    if (endChar < text.length) {
      let boundary = endChar;
      while (boundary > startChar && text[boundary] !== " " && text[boundary] !== "\n") {
        boundary--;
      }
      // Only use the word boundary if we found one
      if (boundary > startChar) {
        endChar = boundary;
      }
    }

    chunks.push({
      text: text.slice(startChar, endChar),
      index,
      startChar,
      endChar,
    });

    index++;

    // Advance by step chars, but find word boundary for next start
    let nextStart = startChar + step;
    if (nextStart < text.length && text[nextStart] !== " " && text[nextStart] !== "\n") {
      // Walk forward to next word boundary
      let boundary = nextStart;
      while (boundary < text.length && text[boundary] !== " " && text[boundary] !== "\n") {
        boundary++;
      }
      // Skip the space itself
      if (boundary < text.length) {
        nextStart = boundary + 1;
      } else {
        nextStart = boundary;
      }
    }

    if (nextStart <= startChar) {
      // Prevent infinite loop
      nextStart = startChar + 1;
    }

    startChar = nextStart;
  }

  return chunks;
}

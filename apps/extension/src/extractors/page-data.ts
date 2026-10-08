export type PageRecord = Record<string, unknown>;

export function asRecord(value: unknown): PageRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as PageRecord)
    : undefined;
}

export function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  return (
    String(value)
      .replace(/[\s\u00a0]+/g, ' ')
      .trim() || undefined
  );
}

export function httpUrl(value: unknown, base: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value.replace(/&amp;/g, '&'), base);
    return /^https?:$/.test(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Parse only JSON-compatible literals; never execute page JavaScript. */
class LiteralParser {
  private position = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const result = this.value(0);
    this.space();
    if (this.position !== this.source.length) throw new Error('Unexpected literal suffix');
    return result;
  }

  private space(): void {
    while (/\s/.test(this.source[this.position] ?? '') && this.position < this.source.length) {
      this.position += 1;
    }
  }

  private string(): string {
    const quote = this.source[this.position++];
    let result = '';
    while (this.position < this.source.length) {
      const character = this.source[this.position++];
      if (character === quote) return result;
      if (character !== '\\') {
        result += character;
        continue;
      }
      const escaped = this.source[this.position++];
      const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
      if (escaped === 'u' || escaped === 'x') {
        const length = escaped === 'u' ? 4 : 2;
        const hex = this.source.slice(this.position, this.position + length);
        if (!new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(hex)) throw new Error('Invalid escape');
        result += String.fromCharCode(Number.parseInt(hex, 16));
        this.position += length;
      } else {
        result += escapes[escaped] ?? escaped;
      }
    }
    throw new Error('Unterminated string');
  }

  private value(depth: number): unknown {
    if (depth > 32) throw new Error('Literal nesting limit');
    this.space();
    const character = this.source[this.position];
    if (character === '"' || character === "'") return this.string();
    // Amazon serializes its initial gallery with this JSON decoder. Read its
    // string argument as data; never invoke the page's function or accept code.
    const jsonDecoder = this.source
      .slice(this.position)
      .match(/^(?:A\.\$\.parseJSON|JSON\.parse)\s*\(/)?.[0];
    if (jsonDecoder) {
      this.position += jsonDecoder.length;
      this.space();
      if (this.source[this.position] !== '"' && this.source[this.position] !== "'")
        throw new Error('JSON decoder requires a string literal');
      const json = this.string();
      this.space();
      if (this.source[this.position++] !== ')') throw new Error('Invalid JSON decoder argument');
      return JSON.parse(json) as unknown;
    }
    if (character === '{' || character === '[') {
      this.position += 1;
      const isArray = character === '[';
      const end = isArray ? ']' : '}';
      const array: unknown[] = [];
      const object: PageRecord = Object.create(null) as PageRecord;
      this.space();
      while (this.source[this.position] !== end) {
        if (this.position >= this.source.length) throw new Error('Unterminated literal');
        if (isArray) {
          array.push(this.value(depth + 1));
        } else {
          const key =
            this.source[this.position] === '"' || this.source[this.position] === "'"
              ? this.string()
              : this.identifier();
          this.space();
          if (this.source[this.position++] !== ':') throw new Error('Expected colon');
          object[key] = this.value(depth + 1);
        }
        this.space();
        if (this.source[this.position] === end) break;
        if (this.source[this.position++] !== ',') throw new Error('Expected comma');
        this.space();
      }
      this.position += 1;
      return isArray ? array : object;
    }
    const token = this.source
      .slice(this.position)
      .match(/^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|undefined)/)?.[0];
    if (!token) throw new Error('Unsupported JavaScript expression');
    this.position += token.length;
    if (token === 'undefined' || token === 'null') return null;
    if (token === 'true' || token === 'false') return token === 'true';
    return Number(token);
  }

  private identifier(): string {
    this.space();
    const key = this.source.slice(this.position).match(/^[\w$-]+/)?.[0];
    if (!key) throw new Error('Invalid object key');
    this.position += key.length;
    return key;
  }
}

export function parseLiteral(source: string): unknown {
  if (source.length > 2_000_000) throw new Error('Page data size limit');
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return new LiteralParser(source).parse();
  }
}

function balancedLiteral(source: string, start: number): string | undefined {
  let quote: string | undefined;
  let escape = false;
  const stack: string[] = [];
  for (let index = start; index < Math.min(source.length, start + 2_000_000); index += 1) {
    const character = source[index];
    if (quote) {
      if (escape) escape = false;
      else if (character === '\\') escape = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '{') stack.push('}');
    else if (character === '[') stack.push(']');
    else if (character === '}' || character === ']') {
      if (stack.pop() !== character) return undefined;
      if (stack.length === 0) return source.slice(start, index + 1);
    }
  }
  return undefined;
}

/** Read named object/array literals from already present inline scripts. */
export function scriptValues(document: Document, keys: readonly string[]): unknown[] {
  const values: unknown[] = [];
  const matcher = new RegExp(`(?:["']?(?:${keys.join('|')})["']?)\\s*[:=]\\s*([\\[{])`, 'g');
  for (const script of document.querySelectorAll('script:not([src])')) {
    const text = script.textContent ?? '';
    matcher.lastIndex = 0;
    for (const match of text.matchAll(matcher)) {
      const start = (match.index ?? 0) + match[0].length - 1;
      const literal = balancedLiteral(text, start);
      if (!literal) continue;
      try {
        values.push(parseLiteral(literal));
      } catch {
        // Other fields remain available even when one page data block changes.
      }
    }
  }
  return values;
}

export function flattenRecords(value: unknown, depth = 0): PageRecord[] {
  if (depth > 20) return [];
  if (Array.isArray(value)) return value.flatMap((item) => flattenRecords(item, depth + 1));
  const record = asRecord(value);
  if (!record) return [];
  return [record, ...Object.values(record).flatMap((item) => flattenRecords(item, depth + 1))];
}

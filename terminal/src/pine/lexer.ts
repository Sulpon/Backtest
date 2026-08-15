/**
 * Tokenizer for a practical subset of Pine Script v5. Indentation-sensitive
 * like Python: NEWLINE/INDENT/DEDENT tokens are synthesized from leading
 * whitespace, with tabs expanded to a 4-column tab stop so a tab-indented
 * line and a 4-space-indented sibling compare as the same depth (real Pine
 * source mixes both within one file - see smc.pine). Newlines inside
 * unbalanced ( ) or [ ] are suppressed (a wrapped function call is one
 * logical line), matching how Pine itself allows multi-line calls.
 */

export type TokenType =
  | "NUMBER"
  | "STRING"
  | "COLOR"
  | "IDENT"
  | "KEYWORD"
  | "OP"
  | "NEWLINE"
  | "INDENT"
  | "DEDENT"
  | "EOF";

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  col: number;
}

const KEYWORDS = new Set([
  "var", "varip", "if", "else", "for", "while", "to", "by", "true", "false", "na",
  "and", "or", "not", "import", "as", "type", "switch", "break", "continue", "export", "method",
]);

// Longest-match-first so e.g. ":=" isn't lexed as ":" then "=".
const OPERATORS = [
  "=>", ":=", "==", "!=", "<=", ">=", "?:", "+=", "-=", "*=", "/=", "%=",
  "+", "-", "*", "/", "%", "=", "<", ">", "?", ":", ",", ".", "(", ")", "[", "]",
];

function isIdentStart(c: string) {
  return /[A-Za-z_]/.test(c);
}
function isIdentPart(c: string) {
  return /[A-Za-z0-9_]/.test(c);
}
function isDigit(c: string) {
  return c >= "0" && c <= "9";
}

export function tokenize(source: string): Token[] {
  // Normalize line endings and strip a trailing BOM.
  const text = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^﻿/, "");
  const lines = text.split("\n");
  const tokens: Token[] = [];
  const indentStack = [0];
  let parenDepth = 0;
  let atLineStart = true;
  let pendingBlankLine = false;

  function tabExpandedWidth(prefix: string): number {
    let col = 0;
    for (const ch of prefix) {
      if (ch === "\t") col += 4 - (col % 4);
      else col += 1;
    }
    return col;
  }

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const rawLine = lines[lineNo];
    // Strip line comments (// ... ) but not inside strings - handled by a
    // small scan rather than regex, since strings may contain "//".
    let line = rawLine;
    {
      let inStr: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inStr) {
          if (c === "\\") i++;
          else if (c === inStr) inStr = null;
        } else if (c === '"' || c === "'") {
          inStr = c;
        } else if (c === "/" && line[i + 1] === "/") {
          line = line.slice(0, i);
          break;
        }
      }
    }

    const trimmed = line.replace(/\s+$/, "");
    if (trimmed.trim().length === 0) {
      // Blank (or comment-only) line - never affects indentation; if we're
      // mid-expression (paren depth > 0) it's simply invisible.
      pendingBlankLine = true;
      continue;
    }

    const leading = trimmed.match(/^[ \t]*/)![0];
    let col = leading.length;

    if (parenDepth === 0) {
      const depth = tabExpandedWidth(leading);
      if (!atLineStart) {
        // shouldn't happen - atLineStart is reset at the end of each line
      }
      if (!tokens.length) {
        // first real line of the file - establish base indent implicitly
        indentStack[0] = depth;
        tokens.push({ type: "NEWLINE", value: "\n", line: lineNo, col: 0 });
      } else if (pendingBlankLine || true) {
        if (depth > indentStack[indentStack.length - 1]) {
          indentStack.push(depth);
          tokens.push({ type: "INDENT", value: "", line: lineNo, col: 0 });
        } else {
          while (depth < indentStack[indentStack.length - 1]) {
            indentStack.pop();
            tokens.push({ type: "DEDENT", value: "", line: lineNo, col: 0 });
          }
          tokens.push({ type: "NEWLINE", value: "\n", line: lineNo, col: 0 });
        }
      }
    }
    pendingBlankLine = false;
    atLineStart = false;

    while (col < trimmed.length) {
      const c = trimmed[col];
      if (c === " " || c === "\t") {
        col++;
        continue;
      }

      // Hex color literal: #RRGGBB or #RRGGBBAA
      if (c === "#" && /^[0-9a-fA-F]{6,8}/.test(trimmed.slice(col + 1, col + 9))) {
        const m = trimmed.slice(col).match(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?/)!;
        tokens.push({ type: "COLOR", value: m[0], line: lineNo, col });
        col += m[0].length;
        continue;
      }

      // Numbers: 123, 123.45, .45, 1e10, 1.5e-3
      if (isDigit(c) || (c === "." && isDigit(trimmed[col + 1] ?? ""))) {
        const m = trimmed.slice(col).match(/^(\d+\.\d+|\.\d+|\d+\.(?!\.)|\d+)([eE][+-]?\d+)?/)!;
        tokens.push({ type: "NUMBER", value: m[0], line: lineNo, col });
        col += m[0].length;
        continue;
      }

      // Strings
      if (c === '"' || c === "'") {
        const quote = c;
        let j = col + 1;
        let value = "";
        while (j < trimmed.length && trimmed[j] !== quote) {
          if (trimmed[j] === "\\" && j + 1 < trimmed.length) {
            value += trimmed[j + 1];
            j += 2;
          } else {
            value += trimmed[j];
            j++;
          }
        }
        tokens.push({ type: "STRING", value, line: lineNo, col });
        col = j + 1;
        continue;
      }

      // Identifiers / keywords
      if (isIdentStart(c)) {
        let j = col + 1;
        while (j < trimmed.length && isIdentPart(trimmed[j])) j++;
        const word = trimmed.slice(col, j);
        tokens.push({ type: KEYWORDS.has(word) ? "KEYWORD" : "IDENT", value: word, line: lineNo, col });
        col = j;
        continue;
      }

      // Operators / punctuation
      const rest = trimmed.slice(col);
      const op = OPERATORS.find((o) => rest.startsWith(o));
      if (op) {
        if (op === "(" || op === "[") parenDepth++;
        if (op === ")" || op === "]") parenDepth = Math.max(0, parenDepth - 1);
        tokens.push({ type: "OP", value: op, line: lineNo, col });
        col += op.length;
        continue;
      }

      throw new Error(`Pine lexer: unexpected character '${c}' at line ${lineNo + 1}, col ${col + 1}`);
    }

    if (parenDepth === 0) {
      tokens.push({ type: "NEWLINE", value: "\n", line: lineNo, col: trimmed.length });
    }
  }

  while (indentStack.length > 1) {
    indentStack.pop();
    tokens.push({ type: "DEDENT", value: "", line: lines.length, col: 0 });
  }
  tokens.push({ type: "EOF", value: "", line: lines.length, col: 0 });

  // Collapse duplicate/consecutive NEWLINE tokens - blank lines and the
  // per-line emission above can otherwise produce redundant empties that
  // just make the parser's job noisier for no benefit.
  const collapsed: Token[] = [];
  for (const t of tokens) {
    const prev = collapsed[collapsed.length - 1];
    if (t.type === "NEWLINE" && prev && prev.type === "NEWLINE") continue;
    if (t.type === "NEWLINE" && (!prev || prev.type === "INDENT" || prev.type === "DEDENT")) continue;
    collapsed.push(t);
  }
  return collapsed;
}

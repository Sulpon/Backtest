import type { Token } from "./lexer";
import type { Expr, Stmt, Arg } from "./ast";

const TYPE_NAMES = new Set(["int", "float", "bool", "string", "color", "line", "box", "label", "table", "array", "linefill", "polyline", "matrix", "map"]);

export class ParseError extends Error {}

export function parse(tokens: Token[]): Stmt[] {
  let pos = 0;

  function peek(offset = 0): Token {
    return tokens[Math.min(pos + offset, tokens.length - 1)];
  }
  function at(type: string, value?: string): boolean {
    const t = peek();
    return t.type === type && (value === undefined || t.value === value);
  }
  function advance(): Token {
    return tokens[pos++];
  }
  function expect(type: string, value?: string): Token {
    if (!at(type, value)) {
      const t = peek();
      throw new ParseError(
        `Pine parser: expected ${type}${value ? ` '${value}'` : ""} but got ${t.type} '${t.value}' at line ${t.line + 1}`
      );
    }
    return advance();
  }
  function skipNewlines() {
    while (at("NEWLINE")) advance();
  }

  // ---- top level ----
  function parseProgram(): Stmt[] {
    const stmts: Stmt[] = [];
    skipNewlines();
    while (!at("EOF")) {
      stmts.push(parseStatement());
      skipNewlines();
    }
    return stmts;
  }

  function parseBlock(): Stmt[] {
    skipNewlines();
    expect("INDENT");
    const stmts: Stmt[] = [];
    skipNewlines();
    while (!at("DEDENT") && !at("EOF")) {
      stmts.push(parseStatement());
      skipNewlines();
    }
    if (at("DEDENT")) advance();
    return stmts;
  }

  // Consumes a type annotation token sequence - IDENT, optionally followed
  // by a generic `<IDENT>` (array<float>) or an array suffix `[]`
  // (float[]) - Pine allows both spellings for "array of" - and returns it
  // as a flat string. Caller has already checked it looks like one.
  function parseTypeName(): string {
    let name = expect("IDENT").value;
    if (at("OP", "<")) {
      advance();
      name += "<" + expect("IDENT").value;
      if (at("OP", ",")) {
        advance();
        name += "," + expect("IDENT").value;
      }
      expect("OP", ">");
      name += ">";
    } else if (at("OP", "[") && peek(1).type === "OP" && peek(1).value === "]") {
      advance();
      advance();
      name += "[]";
    }
    return name;
  }

  function isTypeAnnotationStart(): boolean {
    if (!at("IDENT")) return false;
    const word = peek().value;
    if (!TYPE_NAMES.has(word)) return false;
    // "int(" etc. are cast function calls, not declarations - only a
    // declaration if followed by another identifier (the variable name),
    // possibly through a <...> generic or a []  array suffix first.
    let ahead = 1;
    if (peek(ahead).type === "OP" && peek(ahead).value === "<") {
      ahead++;
      while (!(peek(ahead).type === "OP" && peek(ahead).value === ">") && !at("EOF", undefined)) {
        ahead++;
        if (ahead > 20) break;
      }
      ahead++; // consume '>'
    } else if (peek(ahead).type === "OP" && peek(ahead).value === "[" && peek(ahead + 1).type === "OP" && peek(ahead + 1).value === "]") {
      ahead += 2;
    }
    return peek(ahead).type === "IDENT";
  }

  function parseStatement(): Stmt {
    const line = peek().line;

    // `import path/to/lib/1 as alias` - the path is a slash/dot-separated
    // sequence that isn't a real expression, and nothing here needs the
    // import machinery (any namespace it introduces, e.g. `d.delete_line`,
    // is provided directly as a builtin - see stdlib.ts) - so this is
    // parsed and thrown away rather than evaluated.
    if (at("KEYWORD", "import")) {
      while (!at("NEWLINE") && !at("EOF")) advance();
      return { kind: "ExprStmt", expr: { kind: "Na" }, line };
    }

    if (at("KEYWORD", "break")) {
      advance();
      return { kind: "Break", line };
    }
    if (at("KEYWORD", "continue")) {
      advance();
      return { kind: "Continue", line };
    }

    if (at("KEYWORD", "for")) return parseFor();

    // `if` as a statement (side-effecting) vs as an expression (RHS of `=`)
    // are syntactically identical here - parseExpression handles IfExpr,
    // so a bare `if` at statement position just becomes an ExprStmt whose
    // value is discarded.
    if (at("KEYWORD", "if")) {
      const expr = parseExpression();
      return { kind: "ExprStmt", expr, line };
    }

    let declKind: "var" | "varip" | null = null;
    if (at("KEYWORD", "var")) {
      declKind = "var";
      advance();
    } else if (at("KEYWORD", "varip")) {
      declKind = "varip";
      advance();
    }

    let typeName: string | null = null;
    if (isTypeAnnotationStart()) {
      typeName = parseTypeName();
    }

    if (at("IDENT") && (peek(1).type === "OP" && peek(1).value === "=") && !(peek(2).type === "OP" && peek(2).value === "=")) {
      const name = expect("IDENT").value;
      expect("OP", "=");
      const expr = parseExpression();
      return { kind: "VarDecl", declKind, typeName, name, expr, line };
    }

    if (declKind || typeName) {
      // `var`/typed prefix consumed but next token wasn't `name =` - only
      // other legal continuation is a plain `name` declaration with an
      // implicit na/default, which none of the target scripts use; fail
      // loudly rather than silently mis-parsing.
      throw new ParseError(`Pine parser: expected 'name = expr' after declaration prefix at line ${line + 1}`);
    }

    if (at("IDENT") && peek(1).type === "OP" && peek(1).value === ":=") {
      const name = expect("IDENT").value;
      advance();
      const expr = parseExpression();
      return { kind: "Reassign", name, expr, line };
    }

    const COMPOUND_OPS: Record<string, string> = { "+=": "+", "-=": "-", "*=": "*", "/=": "/", "%=": "%" };
    if (at("IDENT") && peek(1).type === "OP" && COMPOUND_OPS[peek(1).value]) {
      const name = expect("IDENT").value;
      const op = COMPOUND_OPS[advance().value];
      const rhs = parseExpression();
      const expr: Expr = { kind: "Binary", op, left: { kind: "Ident", name }, right: rhs };
      return { kind: "Reassign", name, expr, line };
    }

    // Function declaration: IDENT ( params ) => . Params must be bare
    // identifiers, unlike a call's arguments (which may be literals, named
    // args, etc.) - so this is tried speculatively and rolled back on ANY
    // parse failure, not just a structural mismatch at the end, since a
    // plain function CALL statement like `indicator("x", overlay=true)`
    // starts identically and would otherwise throw mid-attempt instead of
    // falling through to being parsed as a call expression.
    if (at("IDENT") && peek(1).type === "OP" && peek(1).value === "(") {
      const save = pos;
      try {
        const name = advance().value;
        advance(); // (
        const params: string[] = [];
        if (!at("OP", ")")) {
          params.push(expect("IDENT").value);
          while (at("OP", ",")) {
            advance();
            params.push(expect("IDENT").value);
          }
        }
        if (at("OP", ")") && peek(1).type === "OP" && peek(1).value === "=>") {
          advance(); // )
          advance(); // =>
          const body = parseFunctionBody();
          return { kind: "FunctionDecl", name, params, body, line };
        }
      } catch {
        // fall through below
      }
      pos = save; // not actually a function decl - fall through to expr stmt (e.g. a bare call)
    }

    const expr = parseExpression();
    return { kind: "ExprStmt", expr, line };
  }

  function parseFunctionBody(): Stmt[] {
    if (at("NEWLINE")) {
      return parseBlock();
    }
    // Single-line function: the rest of the line is one expression, whose
    // value is the function's return value.
    const line = peek().line;
    const expr = parseExpression();
    return [{ kind: "ExprStmt", expr, line }];
  }

  function parseFor(): Stmt {
    const line = peek().line;
    expect("KEYWORD", "for");
    return parseForImpl(line);
  }

  function parseForImpl(line: number): Stmt {
    if (at("OP", "[")) {
      advance();
      const indexName = expect("IDENT").value;
      expect("OP", ",");
      const valueName = expect("IDENT").value;
      expect("OP", "]");
      // Pine syntax is `for [i, v] in arr`; "in" isn't reserved elsewhere
      // in this grammar, so it lexes as a plain IDENT.
      expect("IDENT", "in");
      const iterable = parseExpression();
      const body = parseLoopBody();
      return { kind: "ForIn", indexName, valueName, iterable, body, line };
    }
    const varName = expect("IDENT").value;
    expect("OP", "=");
    const from = parseExpression();
    expect("KEYWORD", "to");
    const to = parseExpression();
    let step: Expr | null = null;
    if (at("KEYWORD", "by")) {
      advance();
      step = parseExpression();
    }
    const body = parseLoopBody();
    return { kind: "ForNumeric", varName, from, to, step, body, line };
  }

  function parseLoopBody(): Stmt[] {
    if (at("NEWLINE")) return parseBlock();
    const line = peek().line;
    const expr = parseExpression();
    return [{ kind: "ExprStmt", expr, line }];
  }

  // ---- expressions (precedence climbing) ----
  function parseExpression(): Expr {
    return parseTernary();
  }

  function parseTernary(): Expr {
    const cond = parseOr();
    if (at("OP", "?")) {
      advance();
      const then = parseTernary();
      expect("OP", ":");
      const elseExpr = parseTernary();
      return { kind: "Ternary", cond, then, else: elseExpr };
    }
    return cond;
  }

  function parseOr(): Expr {
    let left = parseAnd();
    while (at("KEYWORD", "or")) {
      advance();
      const right = parseAnd();
      left = { kind: "Binary", op: "or", left, right };
    }
    return left;
  }

  function parseAnd(): Expr {
    let left = parseComparison();
    while (at("KEYWORD", "and")) {
      advance();
      const right = parseComparison();
      left = { kind: "Binary", op: "and", left, right };
    }
    return left;
  }

  const COMPARISON_OPS = new Set(["==", "!=", "<=", ">=", "<", ">"]);
  function parseComparison(): Expr {
    let left = parseAdditive();
    while (at("OP") && COMPARISON_OPS.has(peek().value)) {
      const op = advance().value;
      const right = parseAdditive();
      left = { kind: "Binary", op, left, right };
    }
    return left;
  }

  function parseAdditive(): Expr {
    let left = parseMultiplicative();
    while (at("OP", "+") || at("OP", "-")) {
      const op = advance().value;
      const right = parseMultiplicative();
      left = { kind: "Binary", op, left, right };
    }
    return left;
  }

  function parseMultiplicative(): Expr {
    let left = parseUnary();
    while (at("OP", "*") || at("OP", "/") || at("OP", "%")) {
      const op = advance().value;
      const right = parseUnary();
      left = { kind: "Binary", op, left, right };
    }
    return left;
  }

  function parseUnary(): Expr {
    if (at("KEYWORD", "not")) {
      advance();
      return { kind: "Unary", op: "not", expr: parseUnary() };
    }
    if (at("OP", "-") || at("OP", "+")) {
      const op = advance().value;
      return { kind: "Unary", op, expr: parseUnary() };
    }
    return parsePostfix();
  }

  function parsePostfix(): Expr {
    let expr = parsePrimary();
    for (;;) {
      if (at("OP", ".")) {
        advance();
        const prop = expect("IDENT").value;
        expr = { kind: "Member", object: expr, property: prop };
      } else if (at("OP", "(")) {
        advance();
        const args = parseArgs();
        expect("OP", ")");
        expr = { kind: "Call", callee: expr, args };
      } else if (at("OP", "[")) {
        advance();
        const index = parseExpression();
        expect("OP", "]");
        expr = { kind: "Index", object: expr, index };
      } else {
        break;
      }
    }
    return expr;
  }

  function parseArgs(): Arg[] {
    const args: Arg[] = [];
    if (at("OP", ")")) return args;
    args.push(parseArg());
    while (at("OP", ",")) {
      advance();
      if (at("OP", ")")) break; // trailing comma
      args.push(parseArg());
    }
    return args;
  }

  function parseArg(): Arg {
    if (at("IDENT") && peek(1).type === "OP" && peek(1).value === "=") {
      const name = advance().value;
      advance();
      return { name, value: parseExpression() };
    }
    return { name: null, value: parseExpression() };
  }

  function parsePrimary(): Expr {
    const t = peek();
    if (t.type === "NUMBER") {
      advance();
      return { kind: "Number", value: parseFloat(t.value) };
    }
    if (t.type === "STRING") {
      advance();
      return { kind: "String", value: t.value };
    }
    if (t.type === "COLOR") {
      advance();
      return { kind: "Color", value: t.value };
    }
    if (t.type === "KEYWORD" && t.value === "true") {
      advance();
      return { kind: "Bool", value: true };
    }
    if (t.type === "KEYWORD" && t.value === "false") {
      advance();
      return { kind: "Bool", value: false };
    }
    if (t.type === "KEYWORD" && t.value === "na") {
      advance();
      // `na` is usually the literal, but `na(x)` is a distinct builtin
      // function (checks whether x is na) - only the bare keyword is the
      // literal.
      if (at("OP", "(")) return { kind: "Ident", name: "na" };
      return { kind: "Na" };
    }
    if (t.type === "KEYWORD" && t.value === "if") {
      return parseIfExpr();
    }
    if (t.type === "OP" && t.value === "(") {
      advance();
      const e = parseExpression();
      expect("OP", ")");
      return e;
    }
    // Array literal - only meaningful as an `input.string` `options=[...]`
    // argument in these scripts, but parsed generally.
    if (t.type === "OP" && t.value === "[") {
      advance();
      const items: Expr[] = [];
      if (!at("OP", "]")) {
        items.push(parseExpression());
        while (at("OP", ",")) {
          advance();
          if (at("OP", "]")) break;
          items.push(parseExpression());
        }
      }
      expect("OP", "]");
      return { kind: "ArrayLit", items };
    }
    if (t.type === "IDENT" || (t.type === "KEYWORD" && (t.value === "import" || t.value === "as"))) {
      advance();
      return { kind: "Ident", name: t.value };
    }
    throw new ParseError(`Pine parser: unexpected token ${t.type} '${t.value}' at line ${t.line + 1}`);
  }

  function parseIfExpr(): Expr {
    expect("KEYWORD", "if");
    const branches: { cond: Expr; body: Stmt[] }[] = [];
    let cond = parseExpression();
    let body = parseBlock();
    branches.push({ cond, body });
    let elseBody: Stmt[] | null = null;
    for (;;) {
      // `else if` / `else` sit at the SAME statement level as the `if`,
      // i.e. after the block's DEDENT, not inside it - parseBlock already
      // consumed the DEDENT, so we just peek for `else` right here.
      if (at("KEYWORD", "else")) {
        advance();
        if (at("KEYWORD", "if")) {
          advance();
          cond = parseExpression();
          body = parseBlock();
          branches.push({ cond, body });
          continue;
        }
        elseBody = parseBlock();
        break;
      }
      break;
    }
    return { kind: "IfExpr", branches, elseBody };
  }

  return parseProgram();
}

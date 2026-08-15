/** AST node types for the supported Pine Script v5 subset. */

export type Expr =
  | { kind: "Number"; value: number }
  | { kind: "String"; value: string }
  | { kind: "Color"; value: string }
  | { kind: "Bool"; value: boolean }
  | { kind: "Na" }
  | { kind: "Ident"; name: string }
  | { kind: "Member"; object: Expr; property: string }
  | { kind: "Index"; object: Expr; index: Expr } // history-reference: expr[n]
  | { kind: "Call"; callee: Expr; args: Arg[] }
  | { kind: "Unary"; op: string; expr: Expr }
  | { kind: "Binary"; op: string; left: Expr; right: Expr }
  | { kind: "Ternary"; cond: Expr; then: Expr; else: Expr }
  | { kind: "IfExpr"; branches: { cond: Expr; body: Stmt[] }[]; elseBody: Stmt[] | null }
  | { kind: "FunctionLit"; params: string[]; body: Stmt[] }
  | { kind: "ArrayLit"; items: Expr[] };

export interface Arg {
  name: string | null; // null = positional
  value: Expr;
}

export type Stmt =
  | { kind: "VarDecl"; declKind: "var" | "varip" | null; typeName: string | null; name: string; expr: Expr; line: number }
  | { kind: "Reassign"; name: string; expr: Expr; line: number }
  | { kind: "FunctionDecl"; name: string; params: string[]; body: Stmt[]; line: number }
  | { kind: "ExprStmt"; expr: Expr; line: number }
  | { kind: "ForNumeric"; varName: string; from: Expr; to: Expr; step: Expr | null; body: Stmt[]; line: number }
  | { kind: "ForIn"; indexName: string; valueName: string; iterable: Expr; body: Stmt[]; line: number }
  | { kind: "Break"; line: number }
  | { kind: "Continue"; line: number };

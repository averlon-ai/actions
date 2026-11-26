/**
 * What Codex's code mode gives an `exec` body, as the scan's scripts use it: every tool is a
 * function on `tools`, `text()` returns output to the model, and `store()`/`load()` keep values
 * between `exec` calls (and across a context checkpoint). The scripts are `exec` bodies, not
 * modules: the prompt prints them for the lead to run as they are.
 */
export {};

/** A shell command's result. */
interface ExecResult {
  output: string;
}

/** An MCP tool's result: upstream's codex-security tools answer in `structuredContent`. */
interface McpResult {
  // The tools' schemas are upstream's; the scripts read what they need and check it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  structuredContent?: any;
  [field: string]: unknown;
}

declare global {
  var tools: {
    exec_command(args: {
      cmd: string;
      yield_time_ms?: number;
      max_output_tokens?: number;
    }): Promise<ExecResult>;
  } & { [tool: `mcp__codex_security__${string}`]: (args: object) => Promise<McpResult> };
  function text(value: string): void;
  function store(key: string, value: unknown): void;
  // A stored value is whatever an earlier script stored.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function load(key: string): any;
}

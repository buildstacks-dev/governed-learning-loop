// Line sink so tests can drive the CLI programmatically without a child
// process; src/cli.ts binds it to process.stdout.
export interface CliOutput {
  write(line: string): void;
}

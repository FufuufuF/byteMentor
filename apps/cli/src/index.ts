#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { CliConfigError, loadCliConfig } from "./config.js";
import type { CliConfig, LoadCliConfigInput } from "./config.js";
import { runChat } from "./run-chat.js";
import type { RunChatIO } from "./run-chat.js";

export interface CliMainProcess {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd(): string;
  stdout: RunChatIO["stdout"];
  stderr: RunChatIO["stderr"];
  exitCode?: NodeJS.Process["exitCode"];
}

export interface CliMainDeps {
  loadConfig?: (input: LoadCliConfigInput) => CliConfig;
  runChat?: (config: CliConfig, io: RunChatIO) => Promise<number>;
}

export async function main(processLike: CliMainProcess, deps: CliMainDeps = {}): Promise<void> {
  const loadConfig = deps.loadConfig ?? loadCliConfig;
  const runChatCommand = deps.runChat ?? runChat;

  try {
    const config = loadConfig({
      argv: processLike.argv.slice(2),
      env: processLike.env,
      cwd: processLike.cwd(),
    });
    processLike.exitCode = await runChatCommand(config, {
      stdout: processLike.stdout,
      stderr: processLike.stderr,
    });
  } catch (error) {
    processLike.stderr.write(`${errorMessage(error)}\n`);
    processLike.exitCode = 1;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof CliConfigError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process);
}

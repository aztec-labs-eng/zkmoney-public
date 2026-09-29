#!/usr/bin/env node
import { createCliProgram } from '../cli/command.js';
import { runRelayer } from '../main.js';

createCliProgram(runRelayer)
  .parseAsync()
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });

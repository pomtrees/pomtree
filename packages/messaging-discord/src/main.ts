#!/usr/bin/env node
import { loadConfig } from "./config.ts";
import { run } from "./run.ts";

run(loadConfig(process.env));

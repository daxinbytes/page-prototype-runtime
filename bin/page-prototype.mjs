#!/usr/bin/env node
import { resolve } from 'node:path';
import { installationHome } from '../lib/installation-home.mjs';
process.env.BRIDGE_RUNTIME_DIR ||= resolve(await installationHome(), 'runtime');
await import('../cli.mjs');

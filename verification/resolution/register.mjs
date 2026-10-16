/**
 * Register the verification module-resolution hook.
 *
 *   node --import ./verification/resolution/register.mjs verification/e2e.mjs
 *
 * See loader.mjs: only `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery`
 * are rewritten, onto the real modules inside the dsh installation.
 */

import { register } from 'node:module';

register('./loader.mjs', import.meta.url);

/**
 * @deprecated
 * This file is kept for backwards compatibility only.
 * All webhook logic has been split into focused modules under `./webhook/`:
 *   - extractors.ts  – pure payload-extraction helpers
 *   - monitor.ts     – deployment polling / monitoring loop
 *   - handler.ts     – Express request handlers
 *
 * Import directly from `./webhook/handler.ts` or `./webhook/index.ts` instead.
 */
export { handleVercelWebhook } from "./webhook/handler.ts";
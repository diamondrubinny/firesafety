import { config } from 'zod';

/**
 * Must be the first import of the entry point (ESM evaluates imports in order).
 * Zod's JIT probes `new Function("")` when object schemas are created; under our strict CSP
 * (no 'unsafe-eval') that probe is blocked and reported as a securitypolicyviolation.
 * Jitless mode skips the probe, keeping CSP reports meaningful. Server-side JIT is unaffected.
 */
config({ jitless: true });

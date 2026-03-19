/**
 * Pino-based Logger
 * Creates component-scoped loggers with AsyncLocalStorage context injection.
 */

import pino from 'pino';
import { logStore } from './context.js';
import type { ILogger } from './types.js';

/** Pino log level, configurable via LOG_LEVEL env var */
const LOG_LEVEL = process.env['LOG_LEVEL'] ?? 'info';

/** The base Pino instance (JSON output by default) */
let basePino = pino({
  level: LOG_LEVEL,
  // Pino outputs JSON by default
  // In development, pipe through `pino-pretty` CLI if desired:
  //   node app.js | npx pino-pretty
});

/**
 * Override the base logger (for testing).
 * Allows injecting a custom Pino logger to capture output.
 */
export function setBasePino(logger: pino.Logger): void {
  basePino = logger;
}

/**
 * Get the base Pino instance (for advanced usage / testing).
 */
export function getBasePino(): pino.Logger {
  return basePino;
}

/**
 * Create a component-scoped logger.
 * Automatically injects AsyncLocalStorage context into every log call.
 *
 * @param component - Component name (e.g., "CEO", "MessageBus", "WorkerPool")
 * @returns A Pino logger with automatic context injection
 *
 * @example
 * const log = createLogger('CEO');
 * log.info('Task received');
 * // Output: { component: "CEO", msg: "Task received", ... }
 *
 * withSection('processTask', () => {
 *   log.info('processing');
 *   // Output: { component: "CEO", sectionPath: "processTask", msg: "processing", ... }
 * });
 */
export function createLogger(component: string): ILogger {
  // Create a child logger with the component name baked in
  const child = basePino.child({ component });

  // Return a Proxy that merges AsyncLocalStorage context into every log call
  return new Proxy(child, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      // Intercept log methods to inject async context
      if (typeof value === 'function' && isLogMethod(prop as string)) {
        return (...args: unknown[]) => {
          const context = logStore.getStore();
          if (context) {
            // Extract logging-relevant fields from context
            const { sectionPath, depth, contextId, component: _comp, ...extra } = context;
            const contextFields: Record<string, unknown> = {};
            if (sectionPath) contextFields['sectionPath'] = sectionPath;
            if (depth !== undefined) contextFields['depth'] = depth;
            if (contextId) contextFields['contextId'] = contextId;
            Object.assign(contextFields, extra);

            // Pino convention: first arg can be an object (merged fields) or a string (message)
            if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
              // log.info({ key: val }, 'message') -> merge context into first arg
              args[0] = { ...contextFields, ...args[0] };
            } else {
              // log.info('message') -> inject context as first arg
              args.unshift(contextFields);
            }
          }

          return value.apply(target, args);
        };
      }

      return value;
    },
  }) as ILogger;
}

/**
 * Check if a property name is a Pino log method.
 */
function isLogMethod(name: string): boolean {
  return ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(name);
}

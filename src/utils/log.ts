/**
 * Simple logging utility for transformers
 * Uses console.log for now, can be extended to use a proper logger
 */
export function log(...args: any[]): void {
  // Only log if LOG environment variable is set or in development
  if (process.env.LOG === 'true' || process.env.NODE_ENV === 'development') {
    console.log(...args);
  }
}
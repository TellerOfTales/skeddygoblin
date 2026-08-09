/**
 * Imports every component handler module for its registration side effect.
 *
 * Handlers call registerComponentHandler() at module scope, so they must be
 * imported somewhere. Doing it here rather than from index.ts avoids an import
 * cycle (handler -> index -> handler) and keeps the list of live namespaces in
 * one obvious place as build-order steps land.
 */

import './availabilityFlow.js';

/** Called at boot purely to guarantee this module is evaluated. */
export function registerAllComponentHandlers(): void {
  // The imports above did the work; this function exists so the call site reads
  // as an intentional step rather than a bare side-effecting import.
}

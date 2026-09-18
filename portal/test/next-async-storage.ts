import { AsyncLocalStorage } from "node:async_hooks";

// Install the runtime primitive before importing routes that initialize Next stores.
(globalThis as typeof globalThis & { AsyncLocalStorage: typeof AsyncLocalStorage }).AsyncLocalStorage = AsyncLocalStorage;

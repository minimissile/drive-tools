import { createContext, type Context } from "react";

// The helper's module owns the cache. Owner modules can have different Vite
// timestamp URLs during invalidation, so their individual hot.data is unstable.
const contexts: Map<string, Context<unknown>> | undefined = import.meta.hot
  ? (import.meta.hot.data.contexts ??= new Map())
  : undefined;

/** Keep providers and lazy consumers connected while Vite replaces a module. */
export function stableContext<T>(name: string, initial: T): Context<T> {
  if (contexts?.has(name)) return contexts.get(name) as Context<T>;
  const context = createContext(initial);
  context.displayName = name;
  contexts?.set(name, context as Context<unknown>);
  return context;
}

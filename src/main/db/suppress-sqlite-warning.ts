// node:sqlite emits an ExperimentalWarning when first loaded. Drop only that one;
// every other warning keeps flowing. Must be imported before 'node:sqlite'.
const original = process.emitWarning.bind(process)

process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const message = typeof warning === 'string' ? warning : warning.message
  const type =
    typeof warning === 'string'
      ? typeof args[0] === 'string'
        ? args[0]
        : (args[0] as { type?: string } | undefined)?.type
      : warning.name
  if (type === 'ExperimentalWarning' && /sqlite/i.test(message)) return
  return (original as (...a: unknown[]) => void)(warning, ...args)
}) as typeof process.emitWarning

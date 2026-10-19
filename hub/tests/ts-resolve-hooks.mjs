// Lets a worker thread import the Hub's TypeScript sources, which import each other without extensions.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && /^\.{1,2}\//.test(specifier)) {
      for (const suffix of ['.ts', '/index.ts']) {
        try {
          return await next(specifier + suffix, context)
        } catch {
          // try the next suffix
        }
      }
    }
    throw err
  }
}

export * from "./client.js"
export * from "./server.js"

import { createYukiOshiClient } from "./client.js"
import { createYukiOshiServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createYukiOshi(options?: ServerOptions) {
  const server = await createYukiOshiServer({
    ...options,
  })

  const client = createYukiOshiClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}

export const createOpencode = createYukiOshi

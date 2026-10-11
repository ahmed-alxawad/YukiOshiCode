import { defineConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import { iconsSpritesheet } from "vite-plugin-icons-spritesheet"
import fs from "fs"

export default defineConfig({
  plugins: [
    solidPlugin(),
    providerIconsPlugin(),
    iconsSpritesheet([
      {
        withTypes: true,
        inputDir: "src/assets/icons/file-types",
        outputDir: "src/components/file-icons",
        formatter: "prettier",
      },
      {
        withTypes: true,
        inputDir: "src/assets/icons/provider",
        outputDir: "src/components/provider-icons",
        formatter: "prettier",
        iconNameTransformer: (iconName) => iconName,
      },
    ]),
  ],
  server: { port: 3001 },
  build: {
    target: "esnext",
  },
  worker: {
    format: "es",
  },
})

function providerIconsPlugin() {
  return {
    name: "provider-icons-plugin",
    configureServer() {
      void fetchProviderIcons()
    },
    buildStart() {
      void fetchProviderIcons()
    },
  }
}

const modelsDevOrigin = "https://models.dev"
const modelsCatalogPath = "/api.json"

export function modelsCatalogOrigin(url?: string) {
  const source = (url || modelsDevOrigin).replace(/\/+$/, "")
  return source.endsWith(modelsCatalogPath) ? source.slice(0, -modelsCatalogPath.length) : source
}

export function modelsCatalogUrl(url?: string) {
  return `${modelsCatalogOrigin(url)}${modelsCatalogPath}`
}

async function fetchProviderIcons() {
  const source = process.env.YUKIOSHI_MODELS_URL
  const url = modelsCatalogOrigin(source)
  const providers = await fetch(modelsCatalogUrl(source))
    .then((res) => res.json())
    .then((json) => Object.keys(json))
  await Promise.all(
    providers.map((provider) =>
      fetch(`${url}/logos/${provider}.svg`)
        .then((res) => res.text())
        .then((svg) => fs.writeFileSync(`./src/assets/icons/provider/${provider}.svg`, svg)),
    ),
  )
}

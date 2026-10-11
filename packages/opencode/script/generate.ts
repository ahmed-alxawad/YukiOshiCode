import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const modelsUrl = process.env.YUKIOSHI_MODELS_URL || "https://models.dev/api.json"
const modelsApiUrl = modelsUrl.endsWith("/api.json") ? modelsUrl : `${modelsUrl}/api.json`
export const modelsData = process.env.MODELS_DEV_API_JSON
  ? await Bun.file(process.env.MODELS_DEV_API_JSON).text()
  : await fetch(modelsApiUrl).then((x) => x.text())
console.log("Loaded models.dev snapshot")

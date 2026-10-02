import path from "path"

process.env.YUKIOSHI_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
process.env.YUKIOSHI_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.YUKIOSHI_DISABLE_MODELS_FETCH = "true"

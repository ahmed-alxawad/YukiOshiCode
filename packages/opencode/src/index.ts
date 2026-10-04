// Entry point. `--version` needs nothing but the version string, so it is answered here, before the
// whole CLI (every command, provider, and service) is loaded; that load takes about half a second.
const args = process.argv.slice(2)
if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
  const { InstallationVersion } = await import("@yukioshi/core/installation/version")
  process.stdout.write(InstallationVersion + "\n")
  process.exit(0)
}

await import("./main")

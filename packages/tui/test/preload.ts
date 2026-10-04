// Ensure local addresses bypass any proxy set in the environment (e.g. http_proxy on
// corporate networks), so requests to test-local servers (127.0.0.1, or 0.0.0.0 when a test server
// listens on all interfaces) never go to a proxy.
const LOCAL_BYPASS = "127.0.0.1,localhost,::1,0.0.0.0"
for (const key of ["NO_PROXY", "no_proxy"]) {
  process.env[key] = process.env[key] ? `${process.env[key]},${LOCAL_BYPASS}` : LOCAL_BYPASS
}

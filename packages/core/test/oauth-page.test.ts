import { describe, expect, test } from "bun:test"
import { OauthCallbackPage } from "../src/oauth/page"

describe("OauthCallbackPage", () => {
  test("uses YukiOshi branding in static and dynamic callback states", () => {
    const success = OauthCallbackPage.success({ provider: "xAI", autoClose: false })
    const error = OauthCallbackPage.error("denied", { provider: "xAI" })
    const bootstrap = OauthCallbackPage.bootstrap({ provider: "xAI", tokenPath: "/token" })

    expect(success).toContain("Authorization successful · YukiOshi")
    expect(success).toContain("YukiOshi is now connected to xAI.")
    expect(error).toContain("YukiOshi couldn't finish connecting to xAI.")
    expect(error).toContain("try again from YukiOshi.")
    expect(bootstrap).toContain('"YukiOshi is now connected to "+PROVIDER')
    expect(bootstrap).toContain('"YukiOshi couldn\'t finish connecting to "+PROVIDER')
    expect(`${success}${error}${bootstrap}`).not.toContain("OpenCode")
  })

  test("escapes bootstrap options embedded in the inline script", () => {
    const html = OauthCallbackPage.bootstrap({
      provider: `xAI</script><script>alert("provider")</script>`,
      tokenPath: `/token</script><script>alert("path")</script>`,
    })

    expect(html.match(/<\/script>/g)).toHaveLength(1)
    expect(html).toContain(`xAI\\u003c/script>\\u003cscript>alert(\\\"provider\\\")\\u003c/script>`)
    expect(html).toContain(`/token\\u003c/script>\\u003cscript>alert(\\\"path\\\")\\u003c/script>`)
  })
})

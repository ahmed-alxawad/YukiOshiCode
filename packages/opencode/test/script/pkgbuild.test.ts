import { describe, expect, test } from "bun:test"
import { aurBinaryPkgbuild } from "../../script/pkgbuild"

const pkgbuild = () =>
  aurBinaryPkgbuild({
    pkgver: "1.18.32",
    subver: "",
    githubUrl: "https://github.com/ahmed-alxawad/YukiOshiCode",
    arm64Sha: "a".repeat(64),
    x64Sha: "b".repeat(64),
  })

describe("script.pkgbuild AUR metadata", () => {
  test("names the repository owner as the single maintainer", () => {
    const lines = pkgbuild().split("\n")
    const maintainers = lines.filter((line) => line.startsWith("# Maintainer:"))
    expect(maintainers).toEqual(["# Maintainer: Ahmed Alxawad <ahmed-alxawad@users.noreply.github.com>"])
  })

  test("ships the proprietary licence, not MIT", () => {
    const lines = pkgbuild().split("\n")
    expect(lines).toContain("license=('LicenseRef-YukiOshi')")
    expect(lines.some((line) => line.includes("MIT"))).toBe(false)
  })

  test("installs the licence file under /usr/share/licenses", () => {
    expect(pkgbuild()).toContain('install -Dm644 ./LICENSE "${pkgdir}/usr/share/licenses/${pkgname}/LICENSE"')
  })

  test("keeps the binary install and the source checksums", () => {
    const text = pkgbuild()
    expect(text).toContain('install -Dm755 ./yukioshi "${pkgdir}/usr/bin/yukioshi"')
    expect(text).toContain(`sha256sums_aarch64=('${"a".repeat(64)}')`)
    expect(text).toContain(`sha256sums_x86_64=('${"b".repeat(64)}')`)
    expect(text).toContain("pkgname='yukioshi-bin'")
    expect(text).toContain("pkgver=1.18.32")
  })

  test("points the sources at the release archives with shell variables intact", () => {
    const text = pkgbuild()
    expect(text).toContain(
      'source_aarch64=("${pkgname}_${pkgver}_aarch64.tar.gz::https://github.com/ahmed-alxawad/YukiOshiCode/releases/download/v${pkgver}${_subver}/yukioshi-linux-arm64.tar.gz")',
    )
    expect(text).toContain(
      'source_x86_64=("${pkgname}_${pkgver}_x86_64.tar.gz::https://github.com/ahmed-alxawad/YukiOshiCode/releases/download/v${pkgver}${_subver}/yukioshi-linux-x64.tar.gz")',
    )
  })
})

export * as Pkgbuild from "./pkgbuild"

/**
 * Renders the PKGBUILD for the `yukioshi-bin` AUR package. Pure so it can be
 * unit-tested without the release pipeline around it (publish.ts calls this
 * with the sha256 sums of the archives it just built).
 *
 * YukiOshi Code is proprietary (see the LICENSE shipped inside every release
 * archive), so the package cannot claim an SPDX licence such as MIT: Arch
 * packaging rules for software like this want a `LicenseRef-...` name and the
 * licence file installed under /usr/share/licenses/<pkgname>/.
 */
export function aurBinaryPkgbuild(input: {
  pkgver: string
  subver: string
  githubUrl: string
  arm64Sha: string
  x64Sha: string
}): string {
  return [
    "# Maintainer: Ahmed Alxawad <ahmed-alxawad@users.noreply.github.com>",
    "",
    "pkgname='yukioshi-bin'",
    `pkgver=${input.pkgver}`,
    `_subver=${input.subver}`,
    "options=('!debug' '!strip')",
    "pkgrel=1",
    "pkgdesc='The AI coding agent built for the terminal.'",
    `url='${input.githubUrl}'`,
    "arch=('aarch64' 'x86_64')",
    "license=('LicenseRef-YukiOshi')",
    "provides=('yukioshi')",
    "conflicts=('yukioshi')",
    "depends=('ripgrep')",
    "",
    `source_aarch64=("\${pkgname}_\${pkgver}_aarch64.tar.gz::${input.githubUrl}/releases/download/v\${pkgver}\${_subver}/yukioshi-linux-arm64.tar.gz")`,
    `sha256sums_aarch64=('${input.arm64Sha}')`,
    "",
    `source_x86_64=("\${pkgname}_\${pkgver}_x86_64.tar.gz::${input.githubUrl}/releases/download/v\${pkgver}\${_subver}/yukioshi-linux-x64.tar.gz")`,
    `sha256sums_x86_64=('${input.x64Sha}')`,
    "",
    "package() {",
    '  install -Dm755 ./yukioshi "${pkgdir}/usr/bin/yukioshi"',
    '  install -Dm644 ./LICENSE "${pkgdir}/usr/share/licenses/${pkgname}/LICENSE"',
    "}",
    "",
  ].join("\n")
}

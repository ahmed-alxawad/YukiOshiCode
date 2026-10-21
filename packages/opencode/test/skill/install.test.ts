import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { SkillInstall } from "../../src/skill/install"
import { tmpdir } from "../fixture/fixture"

type ZipEntry = { name: string; data: Uint8Array<ArrayBuffer>; declaredSize?: number }

// Builds a deflate zip in memory so the test needs no zip tool. `declaredSize` lets an entry lie about
// its uncompressed size in both headers, as a crafted archive can.
function buildZip(entries: ZipEntry[]) {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const compressed = Buffer.from(Bun.deflateSync(entry.data))
    const crc = Bun.hash.crc32(entry.data)
    const size = entry.declaredSize ?? entry.data.byteLength
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.byteLength, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.byteLength, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.byteLength, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, compressed)
    centrals.push(central, name)
    offset += local.byteLength + name.byteLength + compressed.byteLength
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.byteLength, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const skillMd = new TextEncoder().encode("---\nname: demo\ndescription: demo skill\n---\n")
const sixtyMegabytesOfZeros = new Uint8Array(60 * 1024 * 1024)

async function install(dir: string, zip: Buffer) {
  const archive = path.join(dir, "demo.zip")
  await fs.writeFile(archive, zip)
  const root = path.join(dir, "skills")
  const [outcome] = await SkillInstall.addMany({ sources: [archive], root })
  const leftovers = (await fs.readdir(dir)).filter((name) => name.startsWith(".skill-install-"))
  return { outcome, leftovers, root }
}

describe("listedSize", () => {
  test("reads the size column of zipinfo output", () => {
    expect(SkillInstall.listedSize("-rw-r--r--  3.0 unx 200000000 bx defN 26-Oct-21 12:43 demo/big.bin", true)).toBe(200000000)
    expect(SkillInstall.listedSize("?rw-------  2.0 fat 80000000 b- defN 80-Jan-01 00:00 s/big.bin", true)).toBe(80000000)
  })

  test("reads the size before the date in GNU tar and bsdtar output", () => {
    expect(SkillInstall.listedSize("-rw-r--r-- user/group 1234 2026-10-21 12:43 demo/SKILL.md", false)).toBe(1234)
    expect(SkillInstall.listedSize("-rw-r--r--  0 0      0   5678 Oct 21 12:43 demo/SKILL.md", false)).toBe(5678)
  })
})

describe.skipIf(process.platform === "win32")("skill install from a zip", () => {
  test("installs a small zip", async () => {
    await using tmp = await tmpdir()
    const { outcome, root } = await install(tmp.path, buildZip([{ name: "demo/SKILL.md", data: skillMd }]))
    expect(outcome.status).toBe("installed")
    expect(await fs.readFile(path.join(root, "demo", "demo", "SKILL.md"), "utf8")).toContain("name: demo")
  })

  test("refuses a zip whose listed size is over the cap before extracting it", async () => {
    await using tmp = await tmpdir()
    const zip = buildZip([
      { name: "demo/SKILL.md", data: skillMd },
      { name: "demo/big.bin", data: sixtyMegabytesOfZeros },
    ])
    const { outcome, leftovers } = await install(tmp.path, zip)
    expect(outcome.status).toBe("failed")
    expect(outcome.reason).toBe("Archive is too large (max 50 MB)")
    expect(leftovers).toEqual([])
  })

  test("refuses a zip that understates its size, without writing the real contents", async () => {
    await using tmp = await tmpdir()
    const zip = buildZip([
      { name: "demo/SKILL.md", data: skillMd },
      { name: "demo/big.bin", data: sixtyMegabytesOfZeros, declaredSize: 10 },
    ])
    const { outcome, leftovers } = await install(tmp.path, zip)
    expect(outcome.status).toBe("failed")
    expect(outcome.reason).toBe("Archive is too large (max 50 MB)")
    expect(leftovers).toEqual([])
  })
})

import { describe, expect, test } from "bun:test"
import { isPrivateAddress, privateAddressReason } from "@yukioshi/core/permission/private-address"

const refused = [
  "0.0.0.0", "0.1.2.3", "0.255.255.255", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254",
  "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.0.255", "192.168.1.1", "198.18.0.1", "198.19.255.255",
  "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
  "::", "::1", "::8.8.8.8", "::0.0.0.2", "fc00::1", "fd00::1", "fe80::1", "fec0::1", "ff00::1", "ff02::1",
  "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:0.0.0.1", "::ffff:8.8.8.8", "::ffff:224.0.0.1", "::ffff:198.18.0.1",
  "not-an-ip",
  "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::a00:1", "2002:7f00:1::", "2002:a9fe:a9fe::", "2002:c0a8:101::1",
]
const allowed = [
  "8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.0.1.1",
  "192.0.2.1", "198.17.255.255", "198.20.0.1", "223.255.255.255", "1.0.0.0", "2606:4700:4700::1111",
  "fe00::1", "64:ff9b::808:808", "2002:808:808::", "64:ff9b:1::1",
]

describe("private address classifier", () => {
  test.each(refused)("refuses %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true)
    expect(privateAddressReason(address)).toBeString()
  })
  test.each(allowed)("allows %s", (address) => {
    expect(isPrivateAddress(address)).toBe(false)
    expect(privateAddressReason(address)).toBeUndefined()
  })
  test("names the range", () => {
    expect(privateAddressReason("0.1.2.3")).toBe("this-network IPv4 address")
    expect(privateAddressReason("224.0.0.1")).toBe("IPv4 multicast address")
    expect(privateAddressReason("240.0.0.1")).toBe("reserved IPv4 address")
    expect(privateAddressReason("198.18.0.1")).toBe("benchmarking IPv4 address")
    expect(privateAddressReason("192.0.0.1")).toBe("IETF protocol assignment IPv4 address")
    expect(privateAddressReason("ff02::1")).toBe("IPv6 multicast address")
    expect(privateAddressReason("::8.8.8.8")).toBe("IPv4-compatible IPv6 address")
    expect(privateAddressReason("::ffff:10.0.0.1")).toContain("IPv4-mapped IPv6 address")
  })
})

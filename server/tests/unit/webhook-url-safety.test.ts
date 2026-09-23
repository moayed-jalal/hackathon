import { describe, expect, it } from "vitest";
import { assertPublicWebhookUrl, UnsafeWebhookUrlError } from "../../src/lib/webhookUrlSafety.js";

describe("assertPublicWebhookUrl", () => {
  it("accepts a public https URL (IP literal, no DNS dependency)", async () => {
    const result = await assertPublicWebhookUrl("https://93.184.216.34/webhooks", { allowLocalhostHttp: false });
    expect(result.validatedIp).toBe("93.184.216.34");
  });

  it("rejects a malformed URL", async () => {
    await expect(assertPublicWebhookUrl("not a url", { allowLocalhostHttp: false })).rejects.toThrow(
      UnsafeWebhookUrlError,
    );
  });

  it("rejects plain http in production (allowLocalhostHttp: false)", async () => {
    await expect(
      assertPublicWebhookUrl("http://93.184.216.34/webhooks", { allowLocalhostHttp: false }),
    ).rejects.toThrow(UnsafeWebhookUrlError);
  });

  it("rejects http even for localhost when allowLocalhostHttp is false (production)", async () => {
    await expect(
      assertPublicWebhookUrl("http://localhost:3000/webhooks", { allowLocalhostHttp: false }),
    ).rejects.toThrow(UnsafeWebhookUrlError);
  });

  it("allows http localhost only when allowLocalhostHttp is true (dev/demo)", async () => {
    const result = await assertPublicWebhookUrl("http://localhost:3000/webhooks", { allowLocalhostHttp: true });
    expect(["127.0.0.1", "::1"]).toContain(result.validatedIp);
  });

  it("allows http 127.0.0.1 only when allowLocalhostHttp is true", async () => {
    const result = await assertPublicWebhookUrl("http://127.0.0.1:3000/webhooks", { allowLocalhostHttp: true });
    expect(result.validatedIp).toBe("127.0.0.1");
  });

  it("still rejects a non-localhost private IPv4 address even with allowLocalhostHttp true", async () => {
    await expect(
      assertPublicWebhookUrl("https://10.0.0.5/webhooks", { allowLocalhostHttp: true }),
    ).rejects.toThrow(UnsafeWebhookUrlError);
  });

  it.each([
    ["10.0.0.5", "private 10.0.0.0/8"],
    ["172.16.5.1", "private 172.16.0.0/12"],
    ["192.168.1.1", "private 192.168.0.0/16"],
    ["169.254.169.254", "link-local / cloud metadata"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["0.0.0.0", "unspecified"],
    ["224.0.0.1", "multicast"],
  ])("rejects a webhook URL resolving to %s (%s)", async (ip) => {
    await expect(assertPublicWebhookUrl(`https://${ip}/webhooks`, { allowLocalhostHttp: false })).rejects.toThrow(
      UnsafeWebhookUrlError,
    );
  });

  it("rejects IPv6 loopback (::1) as a bare IP literal", async () => {
    await expect(assertPublicWebhookUrl("https://[::1]/webhooks", { allowLocalhostHttp: false })).rejects.toThrow(
      UnsafeWebhookUrlError,
    );
  });

  it("rejects IPv6 unique-local (fc00::/7)", async () => {
    await expect(assertPublicWebhookUrl("https://[fd12:3456:789a::1]/webhooks", { allowLocalhostHttp: false })).rejects.toThrow(
      UnsafeWebhookUrlError,
    );
  });

  it("rejects IPv6 link-local (fe80::/10)", async () => {
    await expect(assertPublicWebhookUrl("https://[fe80::1]/webhooks", { allowLocalhostHttp: false })).rejects.toThrow(
      UnsafeWebhookUrlError,
    );
  });

  it("rejects an IPv4-mapped IPv6 address pointing at a private range", async () => {
    await expect(
      assertPublicWebhookUrl("https://[::ffff:10.0.0.5]/webhooks", { allowLocalhostHttp: false }),
    ).rejects.toThrow(UnsafeWebhookUrlError);
  });

  it("rejects a hostname that fails to resolve", async () => {
    await expect(
      assertPublicWebhookUrl("https://this-host-should-not-resolve.invalid/webhooks", { allowLocalhostHttp: false }),
    ).rejects.toThrow(UnsafeWebhookUrlError);
  });
});

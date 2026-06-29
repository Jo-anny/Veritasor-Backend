import { describe, it, expect } from "vitest";
import { signAndPrepareDelivery, WebhookSubscription } from "../../src/services/webhooks/dispatcher";

describe("Business Fan-out Webhooks Dispatch Verification Matrix", () => {
  const mockSubscription: WebhookSubscription = {
    id: "sub-123",
    businessId: "biz-456",
    url: "https://client.site/webhook",
    secret: "super-secret-crypto-signing-key-string-padding-32b",
  };

  const mockEvent = { event: "attestation.created", root: "0xhash" };

  it("constructs a signature receipt conforming to structured parameters", () => {
    const { headers, receipt } = signAndPrepareDelivery(mockEvent, mockSubscription, 1);

    expect(headers["X-Veritasor-Signature"]).toBeDefined();
    expect(receipt).toMatchObject({
      delivery_id: expect.any(String),
      attempt: 1,
      signature: headers["X-Veritasor-Signature"],
      timestamp: expect.any(String),
    });
  });
});
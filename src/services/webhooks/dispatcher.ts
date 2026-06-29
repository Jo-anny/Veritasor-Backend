import crypto from "crypto";

export interface WebhookSubscription {
  id: string;
  businessId: string;
  url: string;
  secret: string;
}

export interface WebhookDeliveryReceipt {
  delivery_id: string;
  attempt: number;
  signature: string;
  timestamp: string;
}

/**
 * Signs the outbound payload and constructs a verifiable delivery receipt
 */
export function signAndPrepareDelivery(
  payload: object,
  subscription: WebhookSubscription,
  attempt: number = 1
): { headers: Record<string, string>; receipt: WebhookDeliveryReceipt } {
  const deliveryId = crypto.randomUUID();
  const serializedPayload = JSON.stringify(payload);
  
  // Compute standard HMAC-SHA256 signature over the payload with the business subscription secret
  const signature = crypto
    .createHmac("sha256", subscription.secret)
    .update(`${deliveryId}.${attempt}.${serializedPayload}`)
    .digest("hex");

  const headers = {
    "Content-Type": "application/json",
    "X-Veritasor-Delivery-Id": deliveryId,
    "X-Veritasor-Attempt": attempt.toString(),
    "X-Veritasor-Signature": signature,
  };

  const receipt: WebhookDeliveryReceipt = {
    delivery_id: deliveryId,
    attempt,
    signature,
    timestamp: new Date().toISOString(),
  };

  return { headers, receipt };
}
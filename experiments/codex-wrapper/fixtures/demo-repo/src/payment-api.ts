export const DEFAULT_PAYMENT_TIMEOUT_MS = 8000

export function effectivePaymentTimeoutMs(envValue: number | undefined): number {
  return envValue ?? DEFAULT_PAYMENT_TIMEOUT_MS
}

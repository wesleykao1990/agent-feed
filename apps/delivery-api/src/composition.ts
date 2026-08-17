import { DeliveryApiHandlers } from "./handlers.ts";
import type { DeliveryApiDependencies } from "./types.ts";

/**
 * Production composition seam. The process/bootstrap layer supplies concrete
 * credential, repository, cursor, and hashing adapters; this package owns no
 * database or transport construction.
 */
export function createDeliveryApiHandlers(
  dependencies: DeliveryApiDependencies,
): DeliveryApiHandlers {
  return new DeliveryApiHandlers(dependencies);
}

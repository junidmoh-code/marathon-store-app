// Product-type boundary shared by every inventory surface. A missing type is a
// legacy physical product and deliberately remains inventory-managed.
export const COURIER_SERVICE = "courier_service";

export function isCourierService(product) {
  return product?.productType === COURIER_SERVICE;
}

export function isInventoryProduct(product) {
  return !isCourierService(product);
}

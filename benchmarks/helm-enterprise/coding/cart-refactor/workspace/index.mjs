export function solve({cart,operations}){for(const x of operations)cart.push({sku:x.sku,quantity:x.delta});return cart}

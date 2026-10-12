// Looking up a bank's products by account type and tier. Products are always listed in
// account type order, then tier order from lowest to highest.

import type { AccountType, BankConfig, Product, ProductId, Tier } from "./schema.ts";

// How customers and documents say an account type: "business_checking" -> "business checking".
export function accountTypeName(accountType: AccountType): string {
  return accountType.replaceAll("_", " ");
}

// For product names: "business_checking" -> "Business Checking".
export function accountTypeTitle(accountType: AccountType): string {
  return accountTypeName(accountType).replace(/\b\w/g, (c) => c.toUpperCase());
}

export function productId(accountType: AccountType, tier: Tier): ProductId {
  return `${accountType}_${tier}`;
}

// One account type's products, lowest tier first.
export function productsOf(config: BankConfig, accountType: AccountType): Product[] {
  return config.tiers.map((tier) => config.products[productId(accountType, tier)]!);
}

export function allProducts(config: BankConfig): Product[] {
  return config.accountTypes.flatMap((t) => productsOf(config, t));
}

export function productIds(config: BankConfig): ProductId[] {
  return config.accountTypes.flatMap((t) => config.tiers.map((tier) => productId(t, tier)));
}

// 0 for the lowest tier, 1 for the highest; 0 when there is only one tier.
export function tierRank(config: BankConfig, tier: Tier): number {
  const n = config.tiers.length;
  return n > 1 ? config.tiers.indexOf(tier) / (n - 1) : 0;
}

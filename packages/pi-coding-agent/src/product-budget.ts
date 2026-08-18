export interface ProductBudgetResult {
	maxCostUsd?: number;
	status: string;
}

/** Product-neutral session budget supplied by the terminal host. */
export interface ProductBudget {
	get(): ProductBudgetResult | Promise<ProductBudgetResult>;
	set(maxCostUsd: number | undefined): ProductBudgetResult | Promise<ProductBudgetResult>;
}

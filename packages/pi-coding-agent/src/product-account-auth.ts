export type ProductAccountAction = "login" | "logout" | "activate";

export type ProductAccountLoginEvent =
	| {
			type: "verification";
			verificationUrl: string;
			userCode?: string;
			instructions?: string;
	  }
	| { type: "status"; message: string };

export interface ProductAccountOperationOptions {
	signal: AbortSignal;
}

export interface ProductAccountLoginOptions extends ProductAccountOperationOptions {
	notify: (event: ProductAccountLoginEvent) => void;
}

export interface ProductAccountSummary {
	email?: string;
	accessTier?: string;
	enabled?: boolean;
}

/** Display-safe result. Never include bearer tokens, session data, or credentials. */
export interface ProductAccountResult {
	status: string;
	account?: ProductAccountSummary;
}

export interface ProductAccountReloadOptions extends ProductAccountOperationOptions {
	action: ProductAccountAction;
}

/** Product-neutral account/auth port supplied by the terminal host. */
export interface ProductAccountAuth {
	login(options: ProductAccountLoginOptions): Promise<ProductAccountResult>;
	logout(options: ProductAccountOperationOptions): Promise<ProductAccountResult>;
	account(options: ProductAccountOperationOptions): Promise<ProductAccountResult>;
	activate(code: string, options: ProductAccountOperationOptions): Promise<ProductAccountResult>;
	reload?(options: ProductAccountReloadOptions): Promise<ProductAccountResult | undefined>;
}

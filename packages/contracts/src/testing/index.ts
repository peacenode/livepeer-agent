import type { CallOptions, CredentialStore, ToolDescriptor, ToolResult, ToolTransport } from "../index.js";

export class FakeCredentialStore implements CredentialStore {
  constructor(private token?: string) {}
  get(): Promise<string | undefined> { return Promise.resolve(this.token); }
  set(token: string): Promise<void> { this.token = token; return Promise.resolve(); }
  delete(): Promise<void> { this.token = undefined; return Promise.resolve(); }
}

export const fakeTools: ToolDescriptor[] = [{ name: "capabilities_list", description: "List available Livepeer media capabilities.", inputSchema: { type: "object", properties: {} } }];

export class FakeToolTransport implements ToolTransport {
  readonly calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  closed = false;
  constructor(private readonly tools: ToolDescriptor[] = fakeTools, private readonly results: Readonly<Record<string, ToolResult>> = {}) {}
  listTools(options?: CallOptions): Promise<ToolDescriptor[]> { options?.signal?.throwIfAborted(); return Promise.resolve(structuredClone(this.tools)); }
  callTool(name: string, input: Record<string, unknown>, options?: CallOptions): Promise<ToolResult> {
    options?.signal?.throwIfAborted();
    this.calls.push({ name, input: structuredClone(input) });
    return Promise.resolve(structuredClone(this.results[name] ?? { content: [{ type: "text", text: `fake result for ${name}` }] }));
  }
  close(): Promise<void> { this.closed = true; return Promise.resolve(); }
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] };
}

export declare const hostedTools: readonly McpTool[];
export declare function callHostedTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
export declare function createHostedMcpHandler(options?: { version?: string }): (request: Request) => Promise<Response>;
export declare const HOSTED_PROJECT_ID: RegExp;

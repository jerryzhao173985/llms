import { UnifiedChatRequest } from "../types/llm";
import { Transformer, TransformerOptions } from "../types/transformer";

export class MaxTokenTransformer implements Transformer {
  static TransformerName = "maxtoken";
  max_tokens: number;

  constructor(private readonly options?: TransformerOptions) {
    // Support both max_tokens and maxTokens in options
    this.max_tokens = this.options?.max_tokens || this.options?.maxTokens;
  }

  async transformRequestIn(request: UnifiedChatRequest): Promise<UnifiedChatRequest> {
    if (this.max_tokens) {
      console.log(`MaxTokenTransformer: Limiting tokens to ${this.max_tokens} (was ${request.max_tokens})`);
      // Always enforce the limit
      if (request.max_tokens) {
        request.max_tokens = Math.min(request.max_tokens, this.max_tokens);
      }
      if (request.max_completion_tokens) {
        request.max_completion_tokens = Math.min(request.max_completion_tokens, this.max_tokens);
      }
    }
    return request;
  }
}

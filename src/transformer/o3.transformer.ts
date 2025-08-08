import { UnifiedChatRequest } from "../types/llm";
import { Transformer } from "../types/transformer";
import { log } from "../utils/log";

// o3 models that require special handling
const O3_MODELS = [
  "o3",
  "o3-pro",
  "o4-mini",
  "o3-mini",
  "o3-mini-2025-01-31"
];

/**
 * Transformer for OpenAI o3 models
 * 
 * Key differences from standard OpenAI models:
 * 1. Uses max_completion_tokens instead of max_tokens
 * 2. Supports response_format (json_object and json_schema)
 * 3. Does NOT support the prediction parameter
 */
export class O3Transformer implements Transformer {
  name = "o3";

  async transformRequestIn(request: UnifiedChatRequest): Promise<any> {
    // Check if this is an o3 model
    const isO3Model = O3_MODELS.some(model => request.model.includes(model));
    
    if (!isO3Model) {
      // Pass through for non-o3 models
      return request;
    }

    log(`O3 Transformer: Processing request for model ${request.model}`);
    
    // Create a modified request for o3 models
    const o3Request: any = {
      ...request
    };

    // Convert max_tokens to max_completion_tokens for o3
    if (o3Request.max_tokens) {
      o3Request.max_completion_tokens = o3Request.max_tokens;
      delete o3Request.max_tokens;
      log(`O3 Transformer: Converted max_tokens (${request.max_tokens}) to max_completion_tokens`);
    }

    // Remove prediction parameter if present (o3 doesn't support it)
    if (o3Request.prediction) {
      log(`O3 Transformer: Removing unsupported prediction parameter for o3 model`);
      delete o3Request.prediction;
    }

    // o3 supports response_format, so we keep it
    if (o3Request.response_format) {
      log(`O3 Transformer: Keeping response_format (${o3Request.response_format.type}) for o3 model`);
      
      // Ensure JSON keyword is in messages for json modes
      if (o3Request.response_format.type === "json_object" || 
          o3Request.response_format.type === "json_schema") {
        this.ensureJsonKeyword(o3Request);
      }
    }

    // Remove unsupported parameters for o3
    const unsupportedParams = [
      'presence_penalty',
      'frequency_penalty',
      'logit_bias',
      'logprobs',
      'top_logprobs',
      'n'
    ];

    for (const param of unsupportedParams) {
      if (o3Request[param] !== undefined) {
        log(`O3 Transformer: Removing unsupported parameter '${param}' for o3 model`);
        delete o3Request[param];
      }
    }

    return o3Request;
  }

  async transformResponseOut(response: Response): Promise<Response> {
    // o3 responses are in standard OpenAI format, no transformation needed
    return response;
  }

  private ensureJsonKeyword(request: any): void {
    // Check if "JSON" appears in any message
    const hasJsonKeyword = request.messages.some((msg: any) => {
      const content = typeof msg.content === 'string' 
        ? msg.content 
        : msg.content?.map((c: any) => c.text || '').join(' ') || '';
      return /\bjson\b/i.test(content);
    });

    if (!hasJsonKeyword) {
      // Add JSON keyword to the last user message
      const lastUserMsgIndex = request.messages.findLastIndex((msg: any) => msg.role === 'user');
      
      if (lastUserMsgIndex >= 0) {
        const msg = request.messages[lastUserMsgIndex];
        if (typeof msg.content === 'string') {
          msg.content += '\n\nPlease respond in JSON format.';
        } else if (Array.isArray(msg.content)) {
          const lastText = msg.content.findLast((c: any) => c.type === 'text');
          if (lastText) {
            lastText.text += '\n\nPlease respond in JSON format.';
          }
        }
        log('O3 Transformer: Added JSON keyword to ensure proper response format');
      }
    }
  }

  /**
   * Check if a model is an o3 model
   */
  static isO3Model(model: string): boolean {
    return O3_MODELS.some(o3Model => model.includes(o3Model));
  }

  /**
   * Get the appropriate transformer for a model
   */
  static getTransformerForModel(model: string): string {
    if (this.isO3Model(model)) {
      return 'o3';
    }
    return 'openai';
  }
}
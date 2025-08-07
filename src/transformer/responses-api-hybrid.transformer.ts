import { UnifiedChatRequest } from "../types/llm";
import { Transformer, TransformerOptions } from "../types/transformer";
import { log } from "../utils/log";

/**
 * Hybrid Responses API Transformer
 * 
 * Intelligently routes between Responses API and Chat Completions based on conversation state:
 * - Single messages → Responses API (stateless)
 * - Conversation history → Chat Completions API (until stateful mode is implemented)
 * 
 * This solves the "input_text" error by avoiding sending conversation history to Responses API
 */

const RESPONSES_API_MODELS = [
  "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini",
  "o3", "o3-mini", "o4-mini"
];

export class ResponsesApiHybridTransformer implements Transformer {
  name = "responses-api-hybrid";
  private responseIdCache = new Map<string, string>(); // Store response IDs for conversations
  
  constructor(private options?: TransformerOptions) {}

  async transformRequestIn(request: UnifiedChatRequest): Promise<any> {
    const modelLower = request.model.toLowerCase();
    const isResponsesApiModel = RESPONSES_API_MODELS.some(m => modelLower.includes(m.toLowerCase()));
    
    if (!isResponsesApiModel) {
      log(`Hybrid: Model ${request.model} not supported, passing through`);
      return request;
    }

    // Check if we have conversation history (more than 1 message or system + 1 message)
    const messageCount = request.messages.length;
    const hasSystemMessage = request.system || request.messages.some(m => m.role === 'system');
    const hasConversationHistory = messageCount > 1 || (hasSystemMessage && messageCount > 0);
    
    // Check for assistant messages in history (this causes the error)
    const hasAssistantInHistory = request.messages.some(msg => msg.role === 'assistant');
    
    if (hasAssistantInHistory) {
      log(`Hybrid: Conversation history detected with assistant messages - falling back to Chat Completions`);
      return this.fallbackToChatCompletions(request);
    }

    log(`Hybrid: Processing as Responses API request for ${request.model}`);
    
    // For single-turn requests, use simplified Responses API format
    if (messageCount === 1 && request.messages[0].role === 'user') {
      return this.transformToSimpleResponsesApi(request);
    }
    
    // For requests with system message but no conversation history
    if (hasSystemMessage && !hasAssistantInHistory) {
      return this.transformToResponsesApiWithSystem(request);
    }
    
    // Default: fallback to Chat Completions
    return this.fallbackToChatCompletions(request);
  }

  /**
   * Transform to simple Responses API format (single user message)
   */
  private transformToSimpleResponsesApi(request: UnifiedChatRequest): any {
    const userMessage = request.messages[0];
    const isO3Model = request.model.toLowerCase().includes('o3') || request.model.toLowerCase().includes('o4');
    
    const transformed: any = {
      model: request.model,
      input: typeof userMessage.content === 'string' 
        ? userMessage.content 
        : this.extractTextContent(userMessage.content),
      max_output_tokens: this.calculateMaxTokens(request)
    };

    // Add reasoning for o3/o4 models
    if (isO3Model) {
      transformed.reasoning = { effort: 'high' };
      log(`Hybrid: Added high reasoning effort for ${request.model}`);
    }

    // Handle response format
    if (request.response_format) {
      transformed.text = { format: request.response_format };
    }

    // Set streaming
    transformed.stream = request.stream !== false;

    log(`Hybrid: Transformed to simple Responses API format`);
    return transformed;
  }

  /**
   * Transform to Responses API with system message
   */
  private transformToResponsesApiWithSystem(request: UnifiedChatRequest): any {
    const userMessages = request.messages.filter(m => m.role === 'user');
    const systemMessages = request.messages.filter(m => m.role === 'system');
    
    // Combine system messages
    let systemContent = '';
    if (request.system) {
      systemContent = typeof request.system === 'string' 
        ? request.system 
        : this.extractTextContent(request.system);
    }
    systemMessages.forEach(msg => {
      const content = typeof msg.content === 'string' 
        ? msg.content 
        : this.extractTextContent(msg.content);
      systemContent = systemContent ? `${systemContent}\n\n${content}` : content;
    });

    const isO3Model = request.model.toLowerCase().includes('o3') || request.model.toLowerCase().includes('o4');
    
    const transformed: any = {
      model: request.model,
      input: userMessages.map(msg => ({
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: typeof msg.content === 'string' ? msg.content : this.extractTextContent(msg.content)
        }]
      })),
      max_output_tokens: this.calculateMaxTokens(request)
    };

    // Add system as a separate field
    if (systemContent) {
      transformed.system = [{
        type: "input_text",
        text: systemContent
      }];
    }

    // Add reasoning for o3/o4 models
    if (isO3Model) {
      transformed.reasoning = { effort: 'high' };
    }

    transformed.stream = request.stream !== false;

    log(`Hybrid: Transformed to Responses API with system message`);
    return transformed;
  }

  /**
   * Fallback to Chat Completions API format
   */
  private fallbackToChatCompletions(request: UnifiedChatRequest): any {
    log(`Hybrid: Using Chat Completions format for conversation with history`);
    
    // Simply return the request as-is for Chat Completions
    // The provider config should handle the routing
    return request;
  }

  /**
   * Calculate appropriate max tokens for the model
   */
  private calculateMaxTokens(request: UnifiedChatRequest): number {
    const modelLower = request.model.toLowerCase();
    const requestedTokens = request.max_tokens || request.max_completion_tokens;
    
    if (requestedTokens) {
      return requestedTokens;
    }

    // Default tokens based on model
    if (modelLower.includes('o4-mini')) return 16000;
    if (modelLower.includes('o3')) return 8000;
    if (modelLower.includes('o3-mini')) return 4000;
    if (modelLower.includes('gpt-4.1')) return 4000;
    return 2000;
  }

  /**
   * Extract text content from complex content structures
   */
  private extractTextContent(content: any): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(c => c.type === 'text')
        .map(c => c.text || '')
        .join('\n');
    }
    return '';
  }

  async transformResponseOut(response: Response): Promise<Response> {
    // Pass through - response format is similar enough
    return response;
  }
}
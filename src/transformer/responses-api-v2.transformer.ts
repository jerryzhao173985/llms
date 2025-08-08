/**
 * OpenAI Responses API V2 Transformer
 * Complete implementation with full tool support, streaming, and error recovery
 */

import { UnifiedChatRequest } from "../types/llm";
import { Transformer, TransformerOptions } from "../types/transformer";
import { log } from "../utils/log";
import {
  ResponsesApiRequest,
  ResponsesApiResponse,
  ResponsesApiMessage,
  ResponsesApiTool,
  ResponsesApiContent,
  ResponsesApiOutput,
  FunctionCallOutput,
  MessageOutput,
  StreamState,
  ConversationState,
  ToolCallHistory,
  ResponsesApiV2Options,
  TokenCalculation,
  ResponsesApiStreamEvent
} from "../types/responses-api.types";

/**
 * Models that support the Responses API
 */
const RESPONSES_API_MODELS = [
  "gpt-5",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "o1",
  "o1-mini",
  "o3",
  "o3-pro",
  "o3-mini",
  "o3-mini-2025-01-31",
  "o4-mini"
];

/**
 * Model-specific token limits
 */
const MODEL_TOKEN_LIMITS: Record<string, number> = {
  "gpt-5": 400000,
  "o3": 128000,
  "o3-pro": 128000,
  "o3-mini": 16384,
  "o4-mini": 32768,
  "gpt-4.1": 128000,
  "gpt-4o": 32767,
  "default": 16384
};

export class ResponsesApiV2Transformer implements Transformer {
  static TransformerName = "responses-api-v2";
  name = "responses-api-v2";
  
  private options: ResponsesApiV2Options;
  private conversationStates: Map<string, ConversationState> = new Map();
  private toolCallMap: Map<string, ToolCallHistory> = new Map();
  private currentModel: string = "";
  
  constructor(options?: TransformerOptions) {
    this.options = {
      enableStateful: true,
      preserveReasoning: true,
      tokenMultiplier: 2.0,
      minTokensForTools: 15000,
      maxTokensLimit: 100000,
      streamBufferSize: 4096,
      streamTimeout: 300000,
      maxRetries: 3,
      retryDelay: 1000,
      exponentialBackoff: true,
      backgroundTimeout: 600000,
      pollInterval: 5000,
      verboseLogging: true,
      logLevel: 'info',
      fallbackEnabled: false,
      fallbackThreshold: 3,
      continuousExecution: true,  // Default: aggressive continuation
      alwaysContinueWithTools: true,  // Default: never stop on tool calls
      ...(options as ResponsesApiV2Options)
    };
  }

  // ============================================
  // Main Transformation Methods
  // ============================================

  async transformRequestIn(request: UnifiedChatRequest): Promise<UnifiedChatRequest> {
    this.logInfo(`[ResponsesApiV2] Processing request for model ${request.model}`);
    
    // Store current model for streaming
    this.currentModel = request.model;
    
    // Check if model supports Responses API
    if (!this.isResponsesApiModel(request.model)) {
      this.logInfo(`[ResponsesApiV2] Model ${request.model} not supported, passing through`);
      return request;
    }
    
    this.logInfo(`[ResponsesApiV2] Transforming request for Responses API - Model: ${request.model}`);
    
    try {
      // Build Responses API request
      const transformedRequest = await this.buildResponsesApiRequest(request);
      
      this.logInfo(`[ResponsesApiV2] Transformed request - model: ${transformedRequest.model}, max_output_tokens: ${(transformedRequest as any).max_output_tokens}, input messages: ${request.messages.length}`);
      this.logDebug(`[ResponsesApiV2] Full transformed request: ${JSON.stringify(transformedRequest).substring(0, 500)}...`);
      
      return transformedRequest as UnifiedChatRequest;
    } catch (error) {
      this.logError(`[ResponsesApiV2] Error transforming request: ${error}`);
      this.logError(`[ResponsesApiV2] Stack: ${(error as any).stack}`);
      
      // Fallback to original request if transformation fails
      if (this.options.fallbackEnabled) {
        this.logWarn('[ResponsesApiV2] Falling back to original request format');
        return request;
      }
      
      throw error;
    }
  }

  async transformResponseOut(response: Response): Promise<Response> {
    const contentType = response.headers.get("Content-Type");
    
    if (contentType?.includes("stream")) {
      this.logDebug('Processing streaming response');
      return this.handleStreamingResponse(response);
    } else {
      this.logDebug('Processing non-streaming response');
      return this.handleNonStreamingResponse(response);
    }
  }

  // ============================================
  // Request Building
  // ============================================

  private async buildResponsesApiRequest(request: UnifiedChatRequest): Promise<ResponsesApiRequest> {
    const transformedRequest: any = {
      model: request.model,
      input: this.transformMessages(request.messages),
    };
    
    // Add system message if present
    if (request.system) {
      transformedRequest.system = this.transformSystemContent(request.system);
    }
    
    // Transform tools
    if (request.tools && request.tools.length > 0) {
      transformedRequest.tools = this.transformTools(request.tools);
      transformedRequest.tool_choice = request.tool_choice || "auto";
      transformedRequest.parallel_tool_calls = true;
      this.logInfo(`Added ${request.tools.length} tools to request`);
    }
    
    // Calculate optimal tokens
    const tokenCalc = this.calculateOptimalTokens(request);
    transformedRequest.max_output_tokens = tokenCalc.total;
    this.logDebug(`Token calculation: ${JSON.stringify(tokenCalc)}`);
    
    // Handle reasoning models
    if (this.isReasoningModel(request.model)) {
      transformedRequest.reasoning = {
        effort: (request as any).reasoning_effort || 'high',
      };
      this.logDebug(`Set reasoning effort to ${transformedRequest.reasoning.effort}`);
      
      // Remove unsupported parameters for reasoning models
      delete transformedRequest.temperature;
      delete transformedRequest.top_p;
      delete transformedRequest.presence_penalty;
      delete transformedRequest.frequency_penalty;
    } else {
      // Keep standard parameters
      if (request.temperature !== undefined) transformedRequest.temperature = request.temperature;
      if (request.top_p !== undefined) transformedRequest.top_p = request.top_p;
    }
    
    // Handle response format
    if (request.response_format) {
      transformedRequest.text = this.transformResponseFormat(request.response_format);
    }
    
    // Handle streaming - keep original setting
    if (request.stream !== undefined) {
      transformedRequest.stream = request.stream;
    }
    
    // Stateful conversation support
    if (this.options.enableStateful && (request as any).conversation_id) {
      const state = this.getConversationState((request as any).conversation_id);
      if (state?.response_id) {
        transformedRequest.previous_response_id = state.response_id;
        this.logDebug(`Using previous_response_id: ${state.response_id}`);
      }
    }
    
    // Clean up request
    delete (transformedRequest as any).messages;
    delete (transformedRequest as any).max_tokens;
    delete (transformedRequest as any).max_completion_tokens;
    
    return transformedRequest;
  }

  // ============================================
  // Message Transformation
  // ============================================

  private transformMessages(messages: any[]): ResponsesApiMessage[] {
    const transformed: ResponsesApiMessage[] = [];
    
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      
      // Handle tool result messages specially
      if (msg.role === 'tool') {
        // Tool results must be in user messages for Responses API
        const lastMsg = transformed[transformed.length - 1];
        if (lastMsg && lastMsg.role === 'user') {
          // Add to existing user message
          lastMsg.content.push(this.createToolResult(msg));
        } else {
          // Create new user message for tool result
          transformed.push({
            role: 'user',
            content: [this.createToolResult(msg)]
          });
        }
        continue;
      }
      
      // Handle assistant messages with tool calls
      if (msg.role === 'assistant' && msg.tool_calls) {
        // For Responses API, we need to preserve both content and tool information
        // If the assistant has content, it's likely explaining its plan (important for continuation)
        const content = [];
        
        // Preserve the actual content if present - this is crucial for understanding continuation
        // Handle different content types properly
        let textContent = '';
        if (typeof msg.content === 'string') {
          textContent = msg.content;
        } else if (Array.isArray(msg.content)) {
          // Extract text from array content
          const textItems = msg.content.filter((item: any) => 
            typeof item === 'string' || (item && item.type === 'text' && item.text)
          );
          textContent = textItems.map((item: any) => 
            typeof item === 'string' ? item : item.text
          ).join(' ');
        }
        
        if (textContent && textContent.trim().length > 0) {
          content.push({
            type: 'output_text',
            text: textContent
          });
        }
        
        // Add tool call information with better semantics
        const toolNames = msg.tool_calls.map((tc: any) => 
          tc.function?.name || tc.name || 'unknown'
        );
        const toolCallsText = `[Executing ${toolNames.length} tool${toolNames.length > 1 ? 's' : ''}: ${toolNames.join(', ')}]`;
        
        if (content.length > 0) {
          // If we have content, append tool info on new line
          content[0].text += `\n${toolCallsText}`;
        } else {
          // No content - this is pure tool execution
          // Add semantic meaning instead of just empty content
          content.push({
            type: 'output_text',
            text: toolCallsText
          });
        }
        
        // CRITICAL FIX: Always ensure content exists and is not empty
        if (!content || content.length === 0) {
          content.push({
            type: 'output_text',
            text: toolCallsText || '[Tool execution]'
          });
        }
        
        // CRITICAL FIX: Ensure every content item has valid text
        content.forEach((item, idx) => {
          if (!item || typeof item !== 'object') {
            content[idx] = { type: 'output_text', text: '[Invalid content item]' };
          } else if (!item.text || typeof item.text !== 'string') {
            item.text = item.text?.toString() || '[Empty content]';
          }
        });
        
        transformed.push({
          role: 'assistant',
          content: content
        });
        continue;
      }
      
      const transformedMsg: ResponsesApiMessage = {
        role: msg.role,
        content: []
      };
      
      // Transform content based on role
      const contentType = this.getContentType(msg.role);
      
      if (typeof msg.content === 'string') {
        transformedMsg.content = [{
          type: contentType as any,
          text: msg.content
        }];
      } else if (Array.isArray(msg.content)) {
        transformedMsg.content = this.transformContentArray(msg.content, msg.role);
      } else if (msg.content === null || msg.content === undefined) {
        // Empty/null/undefined content - preserve semantic meaning
        // For user messages, this often means approval/continuation
        // For assistant messages without tools, this shouldn't happen
        if (msg.role === 'user') {
          // User approval or continuation signal
          transformedMsg.content = [{
            type: contentType as any,
            text: ''  // Empty is valid for user continuation
          }];
        } else {
          // Assistant without content or tools - add placeholder
          transformedMsg.content = [{
            type: contentType as any,
            text: '[Continuing...]'
          }];
        }
      } else {
        // Fallback - ensure content is never null/undefined
        this.logWarn(`Unexpected content type for ${msg.role}: ${typeof msg.content}, value: ${JSON.stringify(msg.content)}`);
        transformedMsg.content = [{
          type: contentType as any,
          text: msg.content?.toString() || '[Invalid content]'
        }];
      }
      
      // Only add if we have content
      if (transformedMsg.content && transformedMsg.content.length > 0) {
        transformed.push(transformedMsg);
      }
    }
    
    // COMPREHENSIVE SAFEGUARD: ensure no message has null/invalid content
    const sanitized = transformed.map((msg, idx) => {
      // Check if content is null, undefined, or empty
      if (!msg.content || msg.content === null || msg.content === undefined) {
        this.logError(`CRITICAL: Message at index ${idx} has null/undefined content after transformation!`);
        const contentType = msg.role === 'assistant' ? 'output_text' : 'input_text';
        return {
          ...msg,
          content: [{ type: contentType, text: '[Fixed null content]' }]
        };
      }
      
      // Check if content is an empty array
      if (Array.isArray(msg.content) && msg.content.length === 0) {
        this.logError(`CRITICAL: Message at index ${idx} has empty content array after transformation!`);
        const contentType = msg.role === 'assistant' ? 'output_text' : 'input_text';
        return {
          ...msg,
          content: [{ type: contentType, text: '[Fixed empty content]' }]
        };
      }
      
      // Check each content item in the array
      if (Array.isArray(msg.content)) {
        const sanitizedContent = msg.content.map((item, itemIdx) => {
          if (!item || item === null || item === undefined) {
            this.logError(`CRITICAL: Content item at index ${itemIdx} in message ${idx} is null/undefined!`);
            const contentType = msg.role === 'assistant' ? 'output_text' : 'input_text';
            return { type: contentType, text: '[Fixed null content item]' };
          }
          
          // Ensure text property exists and is valid
          if (item.text === null || item.text === undefined) {
            this.logError(`CRITICAL: Content item at index ${itemIdx} in message ${idx} has null text!`);
            return { ...item, text: '[Fixed null text]' };
          }
          
          // Ensure text is a string
          if (typeof item.text !== 'string') {
            this.logError(`CRITICAL: Content item at index ${itemIdx} in message ${idx} has non-string text: ${typeof item.text}`);
            return { ...item, text: item.text?.toString() || '[Fixed invalid text]' };
          }
          
          return item;
        });
        
        return { ...msg, content: sanitizedContent };
      }
      
      return msg;
    });
    
    return sanitized;
  }

  private transformContentArray(content: any[], role: string): ResponsesApiContent[] {
    const result: ResponsesApiContent[] = [];
    const contentType = this.getContentType(role);
    
    // Handle null/undefined/empty content array
    if (!content || !Array.isArray(content)) {
      this.logWarn(`Invalid content array for ${role} message - using empty placeholder`);
      return [{
        type: contentType as any,
        text: '[Fixed invalid content array]'
      }];
    }
    
    for (let i = 0; i < content.length; i++) {
      const item = content[i];
      
      // Skip null/undefined items but log them
      if (item === null || item === undefined) {
        this.logWarn(`Skipping null/undefined content item at index ${i} for ${role} message`);
        continue;
      }
      
      try {
        if (typeof item === 'string') {
          // Handle string items - ensure they're valid
          const text = item || '';  // Convert falsy strings to empty string
          result.push({
            type: contentType as any,
            text: String(text)  // Ensure it's always a string
          });
        } else if (item && typeof item === 'object' && item.type === 'text') {
          // Ensure text is not null/undefined - use comprehensive checks
          let text = '';
          if (item.text !== null && item.text !== undefined) {
            text = String(item.text);  // Convert to string safely
          } else {
            this.logWarn(`Text content item has null/undefined text property for ${role} message`);
            text = '[Fixed null text property]';
          }
          
          result.push({
            type: contentType as any,
            text: text
          });
        } else if (item && typeof item === 'object' && item.type === 'image_url') {
          // Handle image content with null checks
          const imageType = role === 'assistant' ? 'output_image' : 'input_image';
          const imageUrl = item.image_url?.url || '[Invalid image URL]';
          result.push({
            type: imageType as any,
            image_url: imageUrl
          });
        } else if (item && typeof item === 'object' && item.type === 'tool_use') {
          // Tool use in assistant messages must be converted to output_text for Responses API
          const toolName = item.name || 'unknown';
          const toolId = item.id || 'unknown';
          const toolInput = item.input ? JSON.stringify(item.input, null, 2) : 'null';
          const toolUseText = `[Tool call: ${toolName} (${toolId})]\nInput: ${toolInput}`;
          result.push({
            type: role === 'assistant' ? 'output_text' : 'input_text',
            text: toolUseText
          } as any);
        } else if (item && typeof item === 'object' && item.type === 'tool_result') {
          // Handle tool results as input_text for Responses API (only in user messages)
          let contentText = '';
          if (item.content !== null && item.content !== undefined) {
            contentText = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
          } else {
            contentText = '[No result content]';
          }
          
          const toolId = item.tool_use_id || item.tool_call_id || 'unknown';
          const toolResultText = `[Tool Result for ${toolId}]\n${contentText}`;
          
          result.push({
            type: 'input_text',  // Tool results are always input_text
            text: toolResultText
          } as any);
        } else {
          // Handle unknown/invalid content types
          this.logWarn(`Unknown content item type for ${role} message: ${item?.type || typeof item}`);
          const fallbackText = item?.text?.toString() || item?.toString() || '[Unknown content type]';
          result.push({
            type: contentType as any,
            text: fallbackText
          });
        }
      } catch (error) {
        this.logError(`Error processing content item at index ${i} for ${role} message: ${error}`);
        result.push({
          type: contentType as any,
          text: '[Error processing content item]'
        });
      }
    }
    
    // CRITICAL FIX: Ensure we always return at least one item to avoid null content
    if (result.length === 0) {
      this.logWarn(`Empty content array after processing for ${role} message - adding placeholder`);
      result.push({
        type: contentType as any,
        text: '[Fixed empty content array]'
      });
    }
    
    // Final validation: ensure all items have valid text
    const validatedResult = result.map((item, idx) => {
      if (!item || typeof item !== 'object') {
        this.logError(`Invalid content item at index ${idx} after processing for ${role} message`);
        return {
          type: contentType as any,
          text: '[Fixed invalid content item]'
        };
      }
      
      if (item.type === 'input_text' || item.type === 'output_text') {
        if (item.text === null || item.text === undefined) {
          this.logError(`Null text in content item at index ${idx} after processing for ${role} message`);
          return {
            ...item,
            text: '[Fixed null text in processed item]'
          };
        }
        
        if (typeof item.text !== 'string') {
          this.logError(`Non-string text in content item at index ${idx} after processing for ${role} message`);
          return {
            ...item,
            text: item.text?.toString() || '[Fixed non-string text]'
          };
        }
      }
      
      return item;
    });
    
    return validatedResult;
  }

  private createToolResult(msg: any): ResponsesApiContent {
    // OpenAI Responses API doesn't support tool_result type
    // Format tool results as input_text with structured content
    
    // CRITICAL FIX: Comprehensive null checks for tool result content
    let content = '';
    if (msg.content !== null && msg.content !== undefined) {
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (typeof msg.content === 'object') {
        try {
          content = JSON.stringify(msg.content, null, 2);
        } catch (error) {
          this.logError(`Error stringifying tool result content: ${error}`);
          content = '[Error serializing tool result]';
        }
      } else {
        content = String(msg.content);
      }
    } else {
      content = '[No output]';  // Clear indication of null/undefined result
    }
    
    // Ensure tool_call_id is valid
    const toolId = msg.tool_call_id || msg.tool_use_id || 'unknown';
    
    const toolResultText = `[Tool Result ${toolId}]\n${content}`;
    
    // CRITICAL FIX: Ensure the returned object is never null and has valid text
    const result = {
      type: 'input_text',
      text: toolResultText || '[Empty tool result]'
    } as any;
    
    // Final validation
    if (!result.text || typeof result.text !== 'string') {
      this.logError(`Invalid tool result text after processing: ${typeof result.text}`);
      result.text = '[Fixed invalid tool result text]';
    }
    
    return result;
  }

  private transformSystemContent(system: any): ResponsesApiContent[] {
    // CRITICAL FIX: Comprehensive null checks for system content
    if (system === null || system === undefined) {
      this.logWarn('System content is null/undefined - using empty placeholder');
      return [{ type: 'input_text', text: '[Empty system message]' }];
    }
    
    if (typeof system === 'string') {
      const text = system || '[Empty system string]';
      return [{ type: 'input_text', text: String(text) }];
    } else if (Array.isArray(system)) {
      const result = system.map((item, idx) => {
        if (item === null || item === undefined) {
          this.logWarn(`System content item at index ${idx} is null/undefined`);
          return { type: 'input_text', text: '[Fixed null system item]' };
        }
        
        if (typeof item === 'string') {
          const text = item || '[Empty system item]';
          return { type: 'input_text', text: String(text) };
        } else if (item && typeof item === 'object' && item.type === 'text') {
          const text = item.text !== null && item.text !== undefined ? String(item.text) : '[Empty system text]';
          return { type: 'input_text', text: text };
        } else {
          this.logWarn(`Unknown system content item type at index ${idx}: ${typeof item}`);
          const fallbackText = item?.text?.toString() || item?.toString() || '[Unknown system item]';
          return { type: 'input_text', text: fallbackText };
        }
      });
      
      // Ensure we have at least one valid system content item
      const validResult = result.filter(item => item && item.text);
      if (validResult.length === 0) {
        this.logWarn('No valid system content items after processing - adding placeholder');
        return [{ type: 'input_text', text: '[Fixed empty system content]' }];
      }
      
      return validResult;
    } else if (system && typeof system === 'object') {
      // Handle object system content
      if (system.text !== null && system.text !== undefined) {
        return [{ type: 'input_text', text: String(system.text) }];
      } else {
        this.logWarn('System object has no valid text property');
        return [{ type: 'input_text', text: '[Fixed invalid system object]' }];
      }
    } else {
      this.logWarn(`Invalid system content type: ${typeof system}`);
      const fallbackText = system?.toString() || '[Invalid system content]';
      return [{ type: 'input_text', text: fallbackText }];
    }
  }

  private getContentType(role: string): string {
    switch(role) {
      case 'assistant':
        return 'output_text';
      case 'user':
      case 'system':
      default:
        return 'input_text';
    }
  }

  // ============================================
  // Tool Transformation
  // ============================================

  private transformTools(tools: any[]): ResponsesApiTool[] {
    const transformed: ResponsesApiTool[] = [];
    
    for (const tool of tools) {
      if (tool.type === 'function' && tool.function) {
        // OpenAI format
        transformed.push({
          type: 'function',
          name: tool.function.name,
          description: tool.function.description || '',
          parameters: {
            ...tool.function.parameters,
            additionalProperties: false,
            strict: true
          }
        });
        this.logDebug(`Transformed tool: ${tool.function.name}`);
      } else if (tool.name) {
        // Anthropic format
        transformed.push({
          type: tool.type || 'function',
          name: tool.name,
          description: tool.description || '',
          parameters: tool.input_schema || tool.parameters || {}
        });
        this.logDebug(`Transformed tool: ${tool.name}`);
      } else {
        this.logWarn(`Tool missing name: ${JSON.stringify(tool).substring(0, 100)}`);
      }
    }
    
    return transformed;
  }

  private transformResponseFormat(format: any): any {
    const result: any = {};
    
    if (format.type === "json_schema" && format.json_schema) {
      result.format = {
        type: "json_schema",
        name: format.json_schema.name,
        strict: format.json_schema.strict !== false,
        schema: format.json_schema.schema,
        description: format.json_schema.description
      };
    } else {
      result.format = format;
    }
    
    return result;
  }

  // ============================================
  // Token Calculation
  // ============================================

  private calculateOptimalTokens(request: UnifiedChatRequest): TokenCalculation {
    const baseTokens = request.max_tokens || request.max_completion_tokens || 4000;
    const hasTools = request.tools && request.tools.length > 0;
    const model = request.model.toLowerCase();
    
    const calc: TokenCalculation = {
      base: baseTokens,
      toolOverhead: 0,
      reasoningOverhead: 0,
      historyOverhead: 0,
      total: baseTokens
    };
    
    // Tool overhead
    if (hasTools) {
      calc.toolOverhead = request.tools!.length * 2000 + 5000;
      this.logDebug(`Tool overhead: ${calc.toolOverhead} for ${request.tools!.length} tools`);
    }
    
    // Reasoning overhead for o-series models
    if (this.isReasoningModel(model)) {
      calc.reasoningOverhead = model.includes('o4') ? 10000 : 5000;
      this.logDebug(`Reasoning overhead: ${calc.reasoningOverhead}`);
    }
    
    // History overhead
    const messageCount = request.messages.length;
    if (messageCount > 5) {
      calc.historyOverhead = messageCount * 200;
    }
    
    // Calculate total
    calc.total = calc.base + calc.toolOverhead + calc.reasoningOverhead + calc.historyOverhead;
    
    // Apply minimums
    if (hasTools) {
      calc.total = Math.max(calc.total, this.options.minTokensForTools!);
    }
    
    // Model-specific minimums
    if (model.includes('o4-mini')) {
      calc.total = Math.max(calc.total, 25000);
    } else if (model.includes('o3')) {
      calc.total = Math.max(calc.total, 15000);
    }
    
    // Cap at model maximum
    const modelMax = MODEL_TOKEN_LIMITS[model] || MODEL_TOKEN_LIMITS.default;
    if (calc.total > modelMax) {
      calc.cappedAt = modelMax;
      calc.total = modelMax;
    }
    
    return calc;
  }

  // ============================================
  // Continuation Detection
  // ============================================

  private shouldContinue(response: ResponsesApiResponse, hasContent: boolean): boolean {
    // ALWAYS continue if there are signs of ongoing work
    
    // 1. If response is incomplete, it definitely needs to continue
    if (response.status === 'incomplete') {
      return true;
    }
    
    // 2. Check for function calls - if model called tools, it likely has more work
    const functionCalls = response.output?.filter(o => o.type === 'function_call');
    if (functionCalls && functionCalls.length > 0) {
      this.logDebug('Model has function calls - likely continuing');
      return true;  // Almost always continue after tool calls
    }
    
    // 3. Check content for continuation markers
    const messageOutput = response.output?.find(o => o.type === 'message') as MessageOutput;
    const textContent = messageOutput?.content?.find(c => c.type === 'output_text');
    const content = (textContent && 'text' in textContent) ? textContent.text.toLowerCase() : '';
    
    if (content) {
      // Expanded continuation phrases
      const continuationPhrases = [
        "i'll", "i will", "let me", "next", "continuing", "moving",
        "proceed", "going to", "working on", "starting", "now",
        "step", "task", "todo", "plan", "then", "after",
        "once", "when", "should", "need to", "have to", "must"
      ];
      
      const hasContinuationPhrase = continuationPhrases.some(phrase => content.includes(phrase));
      
      // Check for numbered items or lists
      const hasNumberedItems = /\d+[.)]/g.test(content) || /^[-*]/gm.test(content);
      
      // Check for incomplete sentences (only if content is a string)
      const endsWithComma = typeof content === 'string' && content.trim().endsWith(',');
      const hasEllipsis = typeof content === 'string' && content.includes('...');
      
      // Check if this is a reasoning model (they often continue)
      const isReasoningModel = this.isReasoningModel(response.model || this.currentModel);
      
      // More aggressive continuation detection
      return hasContinuationPhrase || hasNumberedItems || endsWithComma || 
             hasEllipsis || isReasoningModel || (typeof content === 'string' && content.length > 100);
    }
    
    // Default to continuing if uncertain - better to continue than stop prematurely
    return true;
  }

  // ============================================
  // Response Handling
  // ============================================

  private async handleNonStreamingResponse(response: Response): Promise<Response> {
    try {
      const jsonResponse = await response.json() as ResponsesApiResponse;
      
      this.logDebug(`Response status: ${jsonResponse.status}, output items: ${jsonResponse.output?.length}`);
      
      // Store conversation state if stateful
      if (this.options.enableStateful && jsonResponse.id) {
        this.updateConversationState(jsonResponse);
      }
      
      // Transform to Chat Completions format
      const transformed = this.transformResponseToOpenAI(jsonResponse);
      
      return new Response(JSON.stringify(transformed), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      this.logError(`Error processing response: ${error}`);
      return response;
    }
  }

  private transformResponseToOpenAI(response: ResponsesApiResponse): any {
    const result: any = {
      id: response.id,
      object: 'chat.completion',
      created: response.created_at || Math.floor(Date.now() / 1000),
      model: response.model || this.currentModel,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: undefined
        },
        finish_reason: 'stop'
      }],
      usage: response.usage
    };
    
    // Process output items
    const messageOutput = response.output?.find(o => o.type === 'message') as MessageOutput;
    const functionCalls = response.output?.filter(o => o.type === 'function_call') as FunctionCallOutput[];
    
    // Handle message content with null checks
    if (messageOutput) {
      const textContent = messageOutput.content?.find(c => c && c.type === 'output_text');
      if (textContent && 'text' in textContent) {
        // CRITICAL FIX: Ensure text is never null
        const text = textContent.text;
        if (text !== null && text !== undefined) {
          result.choices[0].message.content = String(text);
        } else {
          this.logWarn('Message output has null text content');
          result.choices[0].message.content = '[Fixed null message content]';
        }
      } else if (!result.choices[0].message.content) {
        // No text content found - check if this is expected
        this.logDebug('No text content in message output');
        result.choices[0].message.content = null;  // This is valid for tool-only responses
      }
      
      // Handle inline tool calls with null checks
      const toolUses = messageOutput.content?.filter(c => c && c.type === 'tool_use');
      if (toolUses && toolUses.length > 0) {
        result.choices[0].message.tool_calls = toolUses.map((tc: any, idx: number) => {
          // CRITICAL FIX: Ensure all tool call properties are valid
          const toolId = tc.id || `tool_${Date.now()}_${idx}`;
          const toolName = tc.name || 'unknown_tool';
          let toolArgs = '{}';
          
          try {
            if (tc.input !== null && tc.input !== undefined) {
              toolArgs = JSON.stringify(tc.input);
            }
          } catch (error) {
            this.logError(`Error stringifying tool arguments for ${toolName}: ${error}`);
            toolArgs = '{"error": "Failed to serialize arguments"}';
          }
          
          return {
            id: toolId,
            type: 'function',
            function: {
              name: toolName,
              arguments: toolArgs
            }
          };
        });
      }
    }
    
    // Handle separate function calls with comprehensive null checks
    if (functionCalls && functionCalls.length > 0) {
      const toolCalls = functionCalls.map((fc, idx) => {
        // CRITICAL FIX: Ensure all function call properties are valid
        const callId = fc.call_id || `func_${Date.now()}_${idx}`;
        const funcName = fc.name || 'unknown_function';
        let funcArgs = '{}';
        
        if (fc.arguments !== null && fc.arguments !== undefined) {
          if (typeof fc.arguments === 'string') {
            // Validate JSON string
            try {
              JSON.parse(fc.arguments);
              funcArgs = fc.arguments;
            } catch (error) {
              this.logError(`Invalid JSON in function arguments for ${funcName}: ${error}`);
              funcArgs = '{"error": "Invalid JSON arguments"}';
            }
          } else {
            // Convert object to JSON string
            try {
              funcArgs = JSON.stringify(fc.arguments);
            } catch (error) {
              this.logError(`Error stringifying function arguments for ${funcName}: ${error}`);
              funcArgs = '{"error": "Failed to serialize arguments"}';
            }
          }
        } else {
          this.logWarn(`Function call ${funcName} has null/undefined arguments`);
        }
        
        return {
          id: callId,
          type: 'function' as const,
          function: {
            name: funcName,
            arguments: funcArgs
          }
        };
      });
      
      if (result.choices[0].message.tool_calls) {
        result.choices[0].message.tool_calls.push(...toolCalls);
      } else {
        result.choices[0].message.tool_calls = toolCalls;
      }
      
      // CRITICAL: Proper finish_reason for continuous execution
      // The key insight: 'tool_calls' means "stop and wait for tool results"
      // We want 'stop' which means "continue the conversation"
      
      const hasContent = result.choices[0].message.content && 
                        typeof result.choices[0].message.content === 'string' &&
                        result.choices[0].message.content.trim().length > 0;
      const isIncomplete = response.status === 'incomplete';
      const shouldContinue = this.shouldContinue(response, hasContent);
      
      // Decision tree for finish_reason
      let finishReason: string;
      
      if (isIncomplete) {
        // Response was cut off due to token limit
        finishReason = 'length';
        this.logDebug('Response incomplete - token limit reached');
      } else if (functionCalls.length > 0) {
        // CRITICAL FIX: ALWAYS use 'stop' for tool calls to ensure continuous execution
        // The Responses API requires 'stop' for continuation, NOT 'tool_calls'
        // 'tool_calls' would break the multi-turn flow
        finishReason = 'stop';
        
        if (hasContent) {
          this.logInfo(`Continuous execution: ${functionCalls.length} tool calls with content - continuing...`);
        } else {
          this.logInfo(`Continuous execution: ${functionCalls.length} tool calls without content - continuing...`);
        }
        
        // Log detailed reasoning for debugging
        this.logDebug(`Tool execution will continue (finish_reason='stop') - hasContent: ${hasContent}, toolCount: ${functionCalls.length}`);
      } else {
        // No tools, just content or nothing
        finishReason = 'stop';
      }
      
      result.choices[0].finish_reason = finishReason;
      
      // Track tool calls
      for (const fc of functionCalls) {
        this.toolCallMap.set(fc.call_id, {
          call_id: fc.call_id,
          tool_name: fc.name,
          arguments: fc.arguments,
          timestamp: Date.now(),
          status: fc.status === 'completed' ? 'completed' : 'failed'
        });
      }
    }
    
    // Handle incomplete responses with null safety
    if (response.status === 'incomplete') {
      result.choices[0].finish_reason = 'length';
      if (!result.choices[0].message.content || result.choices[0].message.content === null) {
        result.choices[0].message.content = '[Response incomplete - token limit reached]';
      }
    }
    
    // FINAL VALIDATION: Ensure message content is never unexpectedly null
    if (result.choices[0].message.content === undefined) {
      // Only set to null if we don't have tool calls, otherwise it should have some content
      if (!result.choices[0].message.tool_calls || result.choices[0].message.tool_calls.length === 0) {
        result.choices[0].message.content = '[No content generated]';
        this.logWarn('Message has no content and no tool calls - adding placeholder');
      } else {
        result.choices[0].message.content = null;  // Valid for tool-only responses
      }
    }
    
    // Clean up
    if (!result.choices[0].message.tool_calls || result.choices[0].message.tool_calls.length === 0) {
      delete result.choices[0].message.tool_calls;
    }
    
    // Add reasoning info if available
    if (response.reasoning?.summary) {
      (result as any).reasoning_summary = response.reasoning.summary;
    }
    
    this.logDebug(`Transformed response with ${result.choices[0].message.tool_calls?.length || 0} tool calls`);
    
    return result;
  }

  // ============================================
  // Streaming Response Handling
  // ============================================

  private async handleStreamingResponse(response: Response): Promise<Response> {
    if (!response.body) return response;

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    
    const streamState: StreamState = {
      buffer: "",
      pendingText: [],
      sequenceNumber: 0,
      hasContent: false
    };

    const stream = new ReadableStream({
      async start(controller) {
        const reader = response.body!.getReader();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            streamState.buffer += chunk;

            const lines = streamState.buffer.split("\n");
            streamState.buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.trim() || line === "data: [DONE]") {
                if (line === "data: [DONE]") {
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                }
                continue;
              }

              if (line.startsWith("data: ")) {
                try {
                  const data = JSON.parse(line.slice(6)) as ResponsesApiStreamEvent;
                  const transformed = this.processStreamEvent(data, streamState);
                  
                  if (transformed) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(transformed)}\n\n`));
                  }
                } catch (e) {
                  this.logDebug(`Could not parse stream line: ${line}`);
                }
              }
            }
          }
        } catch (error) {
          this.logError(`Stream error: ${error}`);
          controller.error(error);
        } finally {
          try {
            reader.releaseLock();
          } catch (e) {
            this.logDebug(`Error releasing lock: ${e}`);
          }
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  private processStreamEvent(event: ResponsesApiStreamEvent, state: StreamState): any {
    // Handle different event types
    switch(event.type) {
      case 'response.created':
        state.responseId = event.response_id;
        return null; // Don't forward this event
        
      case 'response.output_item.added':
        if (event.item?.type === 'message') {
          return {
            id: state.responseId || 'stream',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: this.currentModel,
            choices: [{
              index: 0,
              delta: { role: 'assistant' },
              finish_reason: null
            }]
          };
        } else if (event.item?.type === 'function_call') {
          state.hadToolCalls = true;  // Track that we have tool calls
          // CRITICAL FIX: Ensure tool call properties are valid
          const callId = event.item.call_id || `stream_tool_${Date.now()}`;
          const toolName = event.item.name || 'unknown_stream_tool';
          
          state.currentToolCall = {
            id: callId,
            name: toolName,
            arguments: ''
          };
          return {
            id: state.responseId || 'stream',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: this.currentModel,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: callId,
                  type: 'function',
                  function: {
                    name: toolName,
                    arguments: ''
                  }
                }]
              },
              finish_reason: null
            }]
          };
        }
        return null;
        
      case 'response.output_text.delta':
      case 'response.text.delta':
        // CRITICAL FIX: Ensure delta is never null and is a string
        if (event.delta !== null && event.delta !== undefined) {
          const deltaText = String(event.delta);  // Ensure it's a string
          state.hasContent = true;
          state.pendingText = state.pendingText || [];  // Ensure array exists
          state.pendingText.push(deltaText);
          state.contentLength = (state.contentLength || 0) + deltaText.length;
          return {
            id: state.responseId || 'stream',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: this.currentModel,
            choices: [{
              index: 0,
              delta: { content: deltaText },
              finish_reason: null
            }]
          };
        } else {
          this.logWarn('Received null/undefined delta in text stream event');
        }
        return null;
        
      case 'response.function_call.delta':
        // CRITICAL FIX: Ensure delta and arguments are valid
        if (state.currentToolCall && event.delta) {
          const deltaArgs = event.delta.arguments || '';
          if (typeof deltaArgs === 'string') {
            state.currentToolCall.arguments = (state.currentToolCall.arguments || '') + deltaArgs;
            return {
              id: state.responseId || 'stream',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: this.currentModel,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    function: {
                      arguments: deltaArgs
                    }
                  }]
                },
                finish_reason: null
              }]
            };
          } else {
            this.logWarn(`Invalid delta arguments type: ${typeof deltaArgs}`);
          }
        }
        return null;
        
      case 'response.function_call.done':
        if (state.currentToolCall) {
          const toolCall = state.currentToolCall;
          state.currentToolCall = undefined;
          
          // Don't set finish_reason here - wait for response.completed
          // This allows the model to continue if it wants to
          return {
            id: state.responseId || 'stream',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: this.currentModel,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: null  // Don't finalize yet
            }]
          };
        }
        return null;
        
      case 'response.output_item.done':
        // Don't set finish_reason here either - wait for response.completed
        return {
          id: state.responseId || 'stream',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: this.currentModel,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: null  // Don't finalize yet
          }]
        };
        
      case 'response.completed':
      case 'response.incomplete':
        // Final decision on finish_reason based on complete context
        const finalFinishReason = (() => {
          if (event.type === 'response.incomplete') {
            return 'length';  // Response was cut off
          }
          
          const hasTools = state.hadToolCalls;
          const hasContent = state.hasContent;
          const contentLength = state.pendingText?.join('').length || 0;
          
          // Check if content suggests continuation
          const contentText = state.pendingText?.join('').toLowerCase() || '';
          const contentSuggestsContinuation = contentLength > 50 && 
            (contentText.includes('now') ||
             contentText.includes('next') ||
             contentText.includes('step') ||
             contentText.includes('task'));
          
          // CRITICAL FIX: Apply same logic as non-streaming - ALWAYS 'stop' for tools
          if (hasTools) {
            // ANY tool calls require 'stop' for continuous execution
            this.logInfo(`Stream: ${hasContent ? 'Tools with content' : 'Tools only'} - continuous execution`);
            return 'stop';  // ALWAYS 'stop' to continue conversation
          } else {
            // No tools - normal completion
            return 'stop';
          }
        })();
        
        this.logDebug(`Stream completed - hasTools: ${state.hadToolCalls}, hasContent: ${state.hasContent}, finish_reason: ${finalFinishReason}`);
        
        return {
          id: state.responseId || 'stream',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: this.currentModel,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: finalFinishReason
          }]
        };
        
      default:
        this.logDebug(`Unhandled stream event type: ${event.type}`);
        return null;
    }
  }

  // ============================================
  // State Management
  // ============================================

  private getConversationState(conversationId: string): ConversationState | undefined {
    return this.conversationStates.get(conversationId);
  }

  private updateConversationState(response: ResponsesApiResponse): void {
    if (!response.id) return;
    
    const conversationId = (response as any).conversation_id || 'default';
    
    const state: ConversationState = {
      response_id: response.id,
      previous_response_id: response.previous_response_id,
      reasoning_context: response.reasoning?.encrypted_content,
      tool_history: Array.from(this.toolCallMap.values()),
      cache_keys: [],
      created_at: response.created_at || Date.now(),
      updated_at: Date.now()
    };
    
    this.conversationStates.set(conversationId, state);
    this.logDebug(`Updated conversation state for ${conversationId}`);
  }

  // ============================================
  // Helper Methods
  // ============================================

  private isResponsesApiModel(model: string): boolean {
    const modelLower = model.toLowerCase();
    return RESPONSES_API_MODELS.some(m => modelLower.includes(m.toLowerCase()));
  }

  private isReasoningModel(model: string): boolean {
    const modelLower = model.toLowerCase();
    return modelLower.includes('o1') || 
           modelLower.includes('o3') || 
           modelLower.includes('o4');
  }

  // ============================================
  // Logging
  // ============================================

  private logDebug(message: string): void {
    if (this.options.verboseLogging || ['debug'].includes(this.options.logLevel!)) {
      log(`[ResponsesApiV2] DEBUG: ${message}`);
    }
  }

  private logInfo(message: string): void {
    // Always log info for debugging
    log(`[ResponsesApiV2] INFO: ${message}`);
  }

  private logWarn(message: string): void {
    // Always log warnings
    log(`[ResponsesApiV2] WARN: ${message}`);
  }

  private logError(message: string): void {
    log(`[ResponsesApiV2] ERROR: ${message}`);
  }
}
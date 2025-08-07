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
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "o1",
  "o1-mini",
  "o3",
  "o3-mini",
  "o3-mini-2025-01-31",
  "o4-mini"
];

/**
 * Model-specific token limits
 */
const MODEL_TOKEN_LIMITS: Record<string, number> = {
  "o3": 100000,
  "o3-mini": 16384,
  "o4-mini": 32768,
  "gpt-4.1": 32767,
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
        if (msg.content && msg.content.trim().length > 0) {
          content.push({
            type: 'output_text',
            text: msg.content
          });
        }
        
        // Add tool call information
        const toolCallsText = msg.tool_calls.map((tc: any) => 
          `[Tool: ${tc.function?.name || tc.name} (${tc.id})]`
        ).join(' ');
        
        if (toolCallsText) {
          // If we have content, append tool info; otherwise use it as main content
          if (content.length > 0) {
            content[0].text += `\n${toolCallsText}`;
          } else {
            content.push({
              type: 'output_text',
              text: toolCallsText
            });
          }
        }
        
        if (content.length > 0) {
          transformed.push({
            role: 'assistant',
            content: content
          });
        }
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
      } else if (msg.content === null) {
        // Empty content - skip
        continue;
      }
      
      // Only add if we have content
      if (transformedMsg.content.length > 0) {
        transformed.push(transformedMsg);
      }
    }
    
    return transformed;
  }

  private transformContentArray(content: any[], role: string): ResponsesApiContent[] {
    const result: ResponsesApiContent[] = [];
    const contentType = this.getContentType(role);
    
    for (const item of content) {
      if (typeof item === 'string') {
        result.push({
          type: contentType as any,
          text: item
        });
      } else if (item.type === 'text') {
        result.push({
          type: contentType as any,
          text: item.text
        });
      } else if (item.type === 'image_url') {
        const imageType = role === 'assistant' ? 'output_image' : 'input_image';
        result.push({
          type: imageType as any,
          image_url: item.image_url.url
        });
      } else if (item.type === 'tool_use') {
        // Tool use in assistant messages must be converted to output_text for Responses API
        const toolUseText = `[Tool call: ${item.name} (${item.id})]\nInput: ${JSON.stringify(item.input, null, 2)}`;
        result.push({
          type: role === 'assistant' ? 'output_text' : 'input_text',
          text: toolUseText
        } as any);
      } else if (item.type === 'tool_result') {
        // Handle tool results as input_text for Responses API (only in user messages)
        const content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
        const toolId = item.tool_use_id || item.tool_call_id;
        const toolResultText = `[Tool Result for ${toolId}]\n${content}`;
        
        result.push({
          type: 'input_text',  // Tool results are always input_text
          text: toolResultText
        } as any);
      }
    }
    
    return result;
  }

  private createToolResult(msg: any): ResponsesApiContent {
    // OpenAI Responses API doesn't support tool_result type
    // Format tool results as input_text with structured content
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    const toolResultText = `[Tool Result ${msg.tool_call_id}]\n${content}`;
    
    return {
      type: 'input_text',
      text: toolResultText
    } as any;
  }

  private transformSystemContent(system: any): ResponsesApiContent[] {
    if (typeof system === 'string') {
      return [{ type: 'input_text', text: system }];
    } else if (Array.isArray(system)) {
      return system.map(item => {
        if (typeof item === 'string') {
          return { type: 'input_text', text: item };
        } else if (item.type === 'text') {
          return { type: 'input_text', text: item.text };
        }
        return item;
      });
    }
    return system;
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
      
      // Check for incomplete sentences
      const endsWithComma = content.trim().endsWith(',');
      const hasEllipsis = content.includes('...');
      
      // Check if this is a reasoning model (they often continue)
      const isReasoningModel = this.isReasoningModel(response.model || this.currentModel);
      
      // More aggressive continuation detection
      return hasContinuationPhrase || hasNumberedItems || endsWithComma || 
             hasEllipsis || isReasoningModel || content.length > 100;
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
    
    // Handle message content
    if (messageOutput) {
      const textContent = messageOutput.content?.find(c => c.type === 'output_text');
      if (textContent && 'text' in textContent) {
        result.choices[0].message.content = textContent.text;
      }
      
      // Handle inline tool calls
      const toolUses = messageOutput.content?.filter(c => c.type === 'tool_use');
      if (toolUses && toolUses.length > 0) {
        result.choices[0].message.tool_calls = toolUses.map((tc: any) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input)
          }
        }));
      }
    }
    
    // Handle separate function calls
    if (functionCalls && functionCalls.length > 0) {
      const toolCalls = functionCalls.map(fc => ({
        id: fc.call_id,
        type: 'function' as const,
        function: {
          name: fc.name,
          arguments: fc.arguments
        }
      }));
      
      if (result.choices[0].message.tool_calls) {
        result.choices[0].message.tool_calls.push(...toolCalls);
      } else {
        result.choices[0].message.tool_calls = toolCalls;
      }
      
      // CRITICAL: Proper finish_reason for continuous execution
      // The key insight: 'tool_calls' means "stop and wait for tool results"
      // We want 'stop' which means "continue the conversation"
      
      const hasContent = result.choices[0].message.content && 
                        result.choices[0].message.content.trim().length > 0;
      const isIncomplete = response.status === 'incomplete';
      const shouldContinue = this.shouldContinue(response, hasContent);
      
      // Decision tree for finish_reason
      let finishReason: string;
      
      if (isIncomplete) {
        // Response was cut off due to token limit
        finishReason = 'length';
        this.logDebug('Response incomplete - token limit reached');
      } else if (this.options.alwaysContinueWithTools && functionCalls.length > 0) {
        // Continuous execution mode - NEVER stop on tool calls
        finishReason = 'stop';  // 'stop' actually means "continue conversation"
        this.logInfo(`Continuous execution: ${functionCalls.length} tool calls, continuing...`);
      } else if (hasContent && functionCalls.length > 0) {
        // Model has both content and tools - it's explaining its plan
        finishReason = 'stop';  // Let it continue
        this.logInfo('Model explaining with tools - continuous flow');
      } else if (functionCalls.length > 0 && !hasContent) {
        // Only tools, no explanation
        if (this.options.continuousExecution || shouldContinue) {
          finishReason = 'stop';  // Force continuation
          this.logInfo('Tools without content - forcing continuation');
        } else {
          finishReason = 'tool_calls';  // Traditional: wait for results
          this.logDebug('Tools only - waiting for results (legacy mode)');
        }
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
    
    // Handle incomplete responses
    if (response.status === 'incomplete') {
      result.choices[0].finish_reason = 'length';
      if (!result.choices[0].message.content) {
        result.choices[0].message.content = '[Response incomplete - token limit reached]';
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
          state.currentToolCall = {
            id: event.item.call_id,
            name: event.item.name,
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
                  id: event.item.call_id,
                  type: 'function',
                  function: {
                    name: event.item.name,
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
        if (event.delta) {
          state.hasContent = true;
          state.pendingText.push(event.delta);
          state.contentLength = (state.contentLength || 0) + event.delta.length;
          return {
            id: state.responseId || 'stream',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: this.currentModel,
            choices: [{
              index: 0,
              delta: { content: event.delta },
              finish_reason: null
            }]
          };
        }
        return null;
        
      case 'response.function_call.delta':
        if (state.currentToolCall && event.delta) {
          state.currentToolCall.arguments += event.delta.arguments || '';
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
                    arguments: event.delta.arguments
                  }
                }]
              },
              finish_reason: null
            }]
          };
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
          
          // Apply same logic as non-streaming for consistency
          if (hasTools && hasContent) {
            // Has both tools and content - ALWAYS continue
            this.logInfo('Stream: Tools+content - continuous execution');
            return 'stop';  // 'stop' means continue conversation
          } else if (hasTools && !hasContent) {
            // Only tools, no content
            if (this.options.alwaysContinueWithTools || this.options.continuousExecution) {
              // Continuous execution enabled - force continuation
              this.logInfo('Stream: Tools detected - forcing continuation');
              return 'stop';  // Continue even without content
            } else if (this.isReasoningModel(this.currentModel)) {
              // Reasoning models typically continue
              this.logInfo('Stream: Reasoning model with tools - continuing');
              return 'stop';
            } else {
              // Legacy mode: wait for tool results
              this.logDebug('Stream: Tools only - legacy wait mode');
              return 'tool_calls';
            }
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
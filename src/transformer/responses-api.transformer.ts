import { UnifiedChatRequest } from "../types/llm";
import { Transformer, TransformerOptions } from "../types/transformer";
import { log } from "../utils/log";

/**
 * OpenAI Responses API Transformer
 * Handles the new stateful Responses API endpoint for o3 and gpt-4o models
 * 
 * Key differences from chat/completions:
 * 1. Uses /v1/responses endpoint (or /openai/responses for Azure)
 * 2. Supports stateful conversations with response IDs
 * 3. Enhanced reasoning capabilities with preserved context
 * 4. Tool integration within chain-of-thought
 * 5. Reasoning summaries and encrypted reasoning
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

export class ResponsesApiTransformer implements Transformer {
  static TransformerName = "responses-api";
  name = "responses-api";
  
  constructor(private options?: TransformerOptions) {}

  /**
   * Transform messages to Responses API format
   * Based on actual API testing, the format is:
   * - Don't wrap with type: "message" (API accepts both but doesn't require it)
   * - Use role and content structure
   * - Assistant messages use 'output_text', user/system use 'input_text'
   */
  private transformMessages(messages: any[]): any[] {
    return messages.map(msg => {
      const transformed: any = {
        role: msg.role
      };
      
      // Use different content type based on role
      // Assistant messages use 'output_text', user/system use 'input_text'
      const contentType = msg.role === 'assistant' ? 'output_text' : 'input_text';
      
      // Handle content transformation
      if (typeof msg.content === 'string') {
        transformed.content = [{ type: contentType, text: msg.content }];
      } else if (Array.isArray(msg.content)) {
        transformed.content = msg.content.map((item: any) => {
          if (typeof item === 'string') {
            return { type: contentType, text: item };
          } else if (item.type === 'text') {
            // Don't include cache_control - not supported by Responses API
            return { type: contentType, text: item.text };
          } else if (item.type === 'image') {
            const imageType = msg.role === 'assistant' ? 'output_image' : 'input_image';
            return { type: imageType, ...item };
          } else if (item.type === 'tool_use') {
            // Handle tool use in conversation history
            return item;
          } else if (item.type === 'tool_result') {
            // Handle tool results in conversation history
            return item;
          }
          return item;
        });
      } else {
        transformed.content = msg.content;
      }
      
      return transformed;
    });
  }
  
  /**
   * Transform system content to Responses API format
   */
  private transformSystemContent(system: any): any {
    if (typeof system === 'string') {
      return [{ type: 'input_text', text: system }];
    } else if (Array.isArray(system)) {
      return system.map((item: any) => {
        if (typeof item === 'string') {
          return { type: 'input_text', text: item };
        } else if (item.type === 'text') {
          // Don't include cache_control - not supported by Responses API
          return { type: 'input_text', text: item.text };
        }
        return item;
      });
    }
    return system;
  }

  async transformRequestIn(request: UnifiedChatRequest): Promise<UnifiedChatRequest> {
    log(`Responses API: transformRequestIn called for model ${request.model}`);
    log(`Responses API: Request has messages:`, !!request.messages);
    
    // Store model for use in streaming
    (this as any).currentModel = request.model;
    
    const modelLower = request.model.toLowerCase();
    const isResponsesApiModel = RESPONSES_API_MODELS.some(m => modelLower.includes(m.toLowerCase()));
    
    if (!isResponsesApiModel) {
      log(`Responses API: Model ${request.model} not supported, falling back to chat/completions`);
      return request;
    }

    log(`Responses API: Processing request for model ${request.model}`);

    // Transform for Responses API format - new API structure
    const transformedRequest: any = {
      model: request.model,
      input: this.transformMessages(request.messages),  // messages -> input with correct content types
    };
    
    // Also transform system messages if present
    if (request.system) {
      transformedRequest.system = this.transformSystemContent(request.system);
    }

    // Handle o3 models specifically
    const isO3Model = modelLower.includes('o3') || modelLower.includes('o4');
    
    // All models use max_output_tokens in Responses API
    // Different models have different token requirements and limits
    if (request.max_tokens || request.max_completion_tokens) {
      const requestedTokens = request.max_tokens || request.max_completion_tokens;
      
      // Set minimum and maximum tokens based on model
      // IMPORTANT: Reasoning models need high minimums to avoid incomplete responses
      let minTokens = 1000;  // Higher default minimum
      let maxTokens = 32767; // gpt-4.1 max
      
      if (modelLower === 'o3') {
        minTokens = 5000;  // o3 needs substantial minimum
        maxTokens = 100000; // o3 can handle more
      } else if (modelLower.includes('o3-mini') || modelLower === 'o3-mini-2025-01-31') {
        minTokens = 2000;  // Higher minimum for reasoning
        maxTokens = 16384;  // o3-mini limit
      } else if (modelLower.includes('o4-mini')) {
        minTokens = 5000;  // o4-mini needs high minimum for reasoning
        maxTokens = 32768;  // o4-mini has higher limit than o3-mini
      } else if (modelLower.includes('gpt-4.1')) {
        minTokens = 1000;
        maxTokens = 32767; // gpt-4.1 limit
      } else if (modelLower.includes('gpt-4o')) {
        minTokens = 500;
        maxTokens = 32767;
      }
      
      transformedRequest.max_output_tokens = Math.min(maxTokens, Math.max(minTokens, requestedTokens));
      
      if (requestedTokens < minTokens) {
        log(`Responses API: Adjusting max_output_tokens from ${requestedTokens} to minimum ${minTokens} for ${request.model}`);
      } else if (requestedTokens > maxTokens) {
        log(`Responses API: Capping max_output_tokens from ${requestedTokens} to maximum ${maxTokens} for ${request.model}`);
      } else {
        log(`Responses API: Using max_output_tokens: ${transformedRequest.max_output_tokens}`);
      }
    } else {
      // Default tokens based on model - o3/o4 models need MUCH more for reasoning
      // The reasoning process consumes many tokens before generating the actual response
      if (modelLower === 'o3') {
        transformedRequest.max_output_tokens = 30000; // o3 needs substantial tokens
      } else if (modelLower.includes('o3-mini')) {
        transformedRequest.max_output_tokens = 16000; // o3-mini max is 16384
      } else if (modelLower.includes('o4-mini')) {
        transformedRequest.max_output_tokens = 30000; // o4-mini needs LOTS of tokens for reasoning
      } else if (modelLower.includes('gpt-4.1')) {
        transformedRequest.max_output_tokens = 8000;
      } else {
        transformedRequest.max_output_tokens = 4000;
      }
      log(`Responses API: Using default max_output_tokens: ${transformedRequest.max_output_tokens} for ${request.model}`);
    }
    
    if (isO3Model) {
      // Add reasoning.effort for o3/o4 models (nested structure)
      // ALL reasoning models should use high effort by default for best performance
      const defaultEffort = 'high'; // Always use high effort for all o-series models
      transformedRequest.reasoning = {
        effort: request.reasoning_effort || defaultEffort
        // summary requires org verification - removed for now
      };
      log(`Responses API: Set reasoning.effort to ${transformedRequest.reasoning.effort} for ${request.model}`);
      
      // Remove unsupported parameters for o3
      delete transformedRequest.temperature;
      delete transformedRequest.top_p;
      delete transformedRequest.presence_penalty;
      delete transformedRequest.frequency_penalty;
    } else {
      // Keep standard parameters for gpt-4o
      if (request.temperature !== undefined) transformedRequest.temperature = request.temperature;
      if (request.top_p !== undefined) transformedRequest.top_p = request.top_p;
    }

    // Handle response_format -> text.format conversion for Responses API
    if (request.response_format) {
      transformedRequest.text = transformedRequest.text || {};
      
      if (request.response_format.type === "json_schema" && request.response_format.json_schema) {
        // For json_schema, flatten the structure - name/strict/schema at format level
        transformedRequest.text.format = {
          type: "json_schema",
          name: request.response_format.json_schema.name,
          strict: request.response_format.json_schema.strict !== false, // default true
          schema: request.response_format.json_schema.schema,
          description: request.response_format.json_schema.description
        };
        log(`Responses API: Using json_schema format with name=${transformedRequest.text.format.name}`);
      } else {
        // For json_object or text, use as-is
        transformedRequest.text.format = request.response_format;
        log(`Responses API: Using text.format type=${request.response_format.type}`);
      }
    }

    // Handle tools/functions - transform to Responses API format
    if (request.tools && request.tools.length > 0) {
      log(`Responses API: Processing ${request.tools.length} tools`);
      log(`Responses API: First tool structure:`, JSON.stringify(request.tools[0], null, 2).substring(0, 300));
      
      // Transform tools to ensure they have the correct structure
      transformedRequest.tools = request.tools.map((tool: any, index: number) => {
        // Handle both Anthropic and OpenAI tool formats
        if (tool.type === 'function' && tool.function) {
          // OpenAI format - extract function details
          const transformed = {
            type: 'function',
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters
          };
          log(`Responses API: Transformed tool[${index}] from OpenAI format:`, transformed.name);
          return transformed;
        } else if (tool.name) {
          // Already has name - likely Anthropic format
          const transformed = {
            type: tool.type || 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema || tool.parameters
          };
          log(`Responses API: Transformed tool[${index}] from Anthropic format:`, transformed.name);
          return transformed;
        } else {
          // Fallback - log error but try to continue
          log(`Responses API: ERROR - tool[${index}] missing name field:`, JSON.stringify(tool).substring(0, 300));
          // Try to extract name from nested structure
          if (tool.function?.name) {
            return {
              type: 'function',
              name: tool.function.name,
              description: tool.function.description || '',
              parameters: tool.function.parameters || {}
            };
          }
          return tool;
        }
      });
      transformedRequest.tool_choice = request.tool_choice || "auto";
      log(`Responses API: Including ${transformedRequest.tools.length} tools, first tool name: ${transformedRequest.tools[0]?.name}`);
    }

    // Add Responses API specific features
    if (this.options?.response_id) {
      transformedRequest.response_id = this.options.response_id;
      log(`Responses API: Using response_id for stateful conversation`);
    }

    if (this.options?.reasoning_summary) {
      transformedRequest.reasoning_summary = true;
      log(`Responses API: Requesting reasoning summary`);
    }

    if (this.options?.background_mode) {
      transformedRequest.background_mode = true;
      log(`Responses API: Using background mode for long-running task`);
    }

    // Don't stream by default for o3 models (requires org verification)
    // Keep existing stream setting for other models
    if (request.stream !== undefined) {
      transformedRequest.stream = request.stream;
    } else if (isO3Model) {
      transformedRequest.stream = false;
      log(`Responses API: Disabled streaming for o3 model (requires org verification)`);
    } else {
      transformedRequest.stream = true;
    }

    log(`Responses API: Transformed request has 'input':`, !!transformedRequest.input);
    log(`Responses API: Transformed request has 'messages':`, !!transformedRequest.messages);
    
    // Log the structure of the first message to debug
    if (transformedRequest.input && transformedRequest.input.length > 0) {
      const firstMsg = transformedRequest.input[0];
      log(`Responses API: First message structure:`, JSON.stringify(firstMsg, null, 2).substring(0, 300));
      
      // Log if we have assistant messages in the history
      const hasAssistantMsg = transformedRequest.input.some((msg: any) => msg.role === 'assistant');
      if (hasAssistantMsg) {
        log(`Responses API: Request contains assistant messages in history`);
        const assistantMsg = transformedRequest.input.find((msg: any) => msg.role === 'assistant');
        log(`Responses API: Assistant message content types:`, assistantMsg?.content?.map((c: any) => c.type));
      }
    }
    
    // Remove any original max_tokens field that might still be present
    delete (transformedRequest as any).max_tokens;
    delete (transformedRequest as any).max_completion_tokens;
    delete (transformedRequest as any).messages;  // Remove messages since we use input
    
    log(`Responses API: Returning transformed request with keys:`, Object.keys(transformedRequest));
    log(`Responses API: Final request body (first 800 chars):`, JSON.stringify(transformedRequest).substring(0, 800));
    
    return transformedRequest as UnifiedChatRequest;
  }

  async transformResponseOut(response: Response): Promise<Response> {
    const contentType = response.headers.get("Content-Type");
    
    if (contentType?.includes("stream")) {
      return this.handleStreamingResponse(response);
    } else {
      return this.handleNonStreamingResponse(response);
    }
  }

  private async handleNonStreamingResponse(response: Response): Promise<Response> {
    try {
      const jsonResponse = await response.json();
      
      log(`Responses API: Raw response structure:`, JSON.stringify({
        id: jsonResponse.id,
        response_id: jsonResponse.response_id,
        model: jsonResponse.model,
        output_length: jsonResponse.output?.length,
        output_types: jsonResponse.output?.map((o: any) => o.type)
      }));
      
      // Log Responses API specific fields
      if (jsonResponse.response_id) {
        log(`Responses API: response_id=${jsonResponse.response_id}`);
      }
      
      if (jsonResponse.reasoning_summary) {
        log(`Responses API: Reasoning summary available: ${jsonResponse.reasoning_summary.substring(0, 100)}...`);
      }
      
      if (jsonResponse.usage?.reasoning_tokens) {
        log(`Responses API: Reasoning tokens used: ${jsonResponse.usage.reasoning_tokens}`);
      }
      
      // Handle tool calls within reasoning
      if (jsonResponse.tool_calls_in_reasoning) {
        log(`Responses API: Tool calls executed within reasoning: ${jsonResponse.tool_calls_in_reasoning.length}`);
      }
      
      // Transform Responses API format to OpenAI chat completion format
      const transformedResponse = this.transformToOpenAIFormat(jsonResponse);
      log(`Responses API: Transformed response has choices:`, transformedResponse.choices?.length);
      
      return new Response(JSON.stringify(transformedResponse), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      log(`Responses API: Error processing response: ${error}`);
      return response;
    }
  }
  
  private transformToOpenAIFormat(responsesApiResponse: any): any {
    log(`Responses API: Transforming response with status=${responsesApiResponse.status}, output items=${responsesApiResponse.output?.length}`);
    
    // Log output types for debugging
    if (responsesApiResponse.output) {
      const outputTypes = responsesApiResponse.output.map((item: any) => item.type);
      log(`Responses API: Output types: ${outputTypes.join(', ')}`);
    }
    
    // Extract message and function_call items from output
    const messageOutput = responsesApiResponse.output?.find((item: any) => item.type === 'message');
    const functionCallOutputs = responsesApiResponse.output?.filter((item: any) => item.type === 'function_call') || [];
    
    // Check if we have tool calls but no message
    if (!messageOutput && functionCallOutputs.length > 0) {
      log(`Responses API: Found ${functionCallOutputs.length} function calls without message`);
      
      // Build response with tool calls only
      return {
        id: responsesApiResponse.id,
        object: 'chat.completion',
        created: responsesApiResponse.created_at || Math.floor(Date.now() / 1000),
        model: responsesApiResponse.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: functionCallOutputs.map((fc: any, index: number) => ({
              id: fc.call_id || `call_${index}`,
              type: 'function',
              function: {
                name: fc.name,
                arguments: fc.arguments || JSON.stringify({})
              }
            }))
          },
          finish_reason: 'tool_calls'
        }],
        usage: responsesApiResponse.usage
      };
    }
    
    if (!messageOutput && functionCallOutputs.length === 0) {
      log('Responses API: No message or function calls found in response');
      
      // Check if this is an incomplete response with only reasoning
      const hasReasoningOnly = responsesApiResponse.output?.some((item: any) => item.type === 'reasoning');
      if (hasReasoningOnly && responsesApiResponse.status === 'incomplete') {
        log('Responses API: Response incomplete with reasoning only - likely hit token limit');
      }
      
      // Handle incomplete responses
      return {
        id: responsesApiResponse.id,
        object: 'chat.completion',
        created: responsesApiResponse.created_at || Math.floor(Date.now() / 1000),
        model: responsesApiResponse.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: responsesApiResponse.status === 'incomplete' ? 
              '[Response incomplete - token limit reached during reasoning]' : 
              '[No response generated]'
          },
          finish_reason: responsesApiResponse.status === 'incomplete' ? 'length' : 'stop'
        }],
        usage: responsesApiResponse.usage
      };
    }
    
    // Build OpenAI-style response
    const openAIResponse: any = {
      id: responsesApiResponse.id || responsesApiResponse.response_id,
      object: 'chat.completion',
      created: responsesApiResponse.created_at || Math.floor(Date.now() / 1000),
      model: responsesApiResponse.model,
      choices: [{
        index: 0,
        message: {
          role: messageOutput.role || 'assistant',
          content: null,
          tool_calls: null
        },
        finish_reason: messageOutput.status === 'completed' ? 'stop' : 'length'
      }],
      usage: responsesApiResponse.usage
    };
    
    // Extract content from the message
    if (messageOutput.content && messageOutput.content.length > 0) {
      // Look for text content
      const textContent = messageOutput.content.find((c: any) => c.type === 'output_text');
      if (textContent) {
        openAIResponse.choices[0].message.content = textContent.text;
        log(`Responses API: Extracted text content (${textContent.text?.length || 0} chars)`);
      }
      
      // Look for tool calls in message content
      const toolCalls = messageOutput.content.filter((c: any) => c.type === 'tool_use');
      if (toolCalls.length > 0) {
        openAIResponse.choices[0].message.tool_calls = toolCalls.map((tc: any, index: number) => ({
          id: tc.id || `call_${index}`,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input || {})
          }
        }));
        log(`Responses API: Found ${toolCalls.length} tool calls in message`);
      }
    }
    
    // Also check for function_call items at the output level (separate from message)
    if (functionCallOutputs.length > 0) {
      // Merge with any existing tool calls
      const additionalToolCalls = functionCallOutputs.map((fc: any, index: number) => ({
        id: fc.call_id || `call_fc_${index}`,
        type: 'function',
        function: {
          name: fc.name,
          arguments: fc.arguments || JSON.stringify({})
        }
      }));
      
      if (openAIResponse.choices[0].message.tool_calls) {
        openAIResponse.choices[0].message.tool_calls.push(...additionalToolCalls);
      } else {
        openAIResponse.choices[0].message.tool_calls = additionalToolCalls;
      }
      
      // Update finish reason if we have tool calls
      if (openAIResponse.choices[0].message.tool_calls?.length > 0) {
        openAIResponse.choices[0].finish_reason = 'tool_calls';
      }
      
      log(`Responses API: Added ${functionCallOutputs.length} function calls from output`);
    }
    
    // Include reasoning summary if available
    if (responsesApiResponse.reasoning?.summary) {
      openAIResponse.reasoning_summary = responsesApiResponse.reasoning.summary;
    }
    
    // Add reasoning token info if available
    if (responsesApiResponse.usage?.output_tokens_details?.reasoning_tokens) {
      log(`Responses API: Reasoning tokens used: ${responsesApiResponse.usage.output_tokens_details.reasoning_tokens}`);
    }
    
    log(`Responses API: Transformed to OpenAI format successfully`);
    
    return openAIResponse;
  }

  private async handleStreamingResponse(response: Response): Promise<Response> {
    if (!response.body) return response;

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let responseId = null;
    let hasContent = false;

    const stream = new ReadableStream({
      async start(controller) {
        const reader = response.body!.getReader();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              if (buffer.trim()) {
                controller.enqueue(encoder.encode(buffer));
              }
              if (responseId) {
                log(`Responses API (streaming): Completed response_id=${responseId}`);
              }
              break;
            }

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;

            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.trim()) continue;
              
              if (line.startsWith("data: ") && line.trim() !== "data: [DONE]") {
                try {
                  const data = JSON.parse(line.slice(6));
                  
                  // Handle different event types from Responses API
                  if (data.type === 'response.output_item.added' && data.item?.type === 'message') {
                    hasContent = true;
                    // Convert to OpenAI format
                    const openAIChunk = {
                      id: data.item.id,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: (this as any).currentModel || 'o3-mini',
                      choices: [{
                        index: 0,
                        delta: { role: data.item.role || 'assistant' },
                        finish_reason: null
                      }]
                    };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
                  } else if ((data.type === 'response.text.delta' || data.type === 'response.output_text.delta') && data.delta) {
                    hasContent = true;
                    // Convert text delta to OpenAI format
                    const openAIChunk = {
                      id: responseId || 'chunk',
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: (this as any).currentModel || 'o3-mini',
                      choices: [{
                        index: 0,
                        delta: { content: data.delta },
                        finish_reason: null
                      }]
                    };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
                  } else if (data.type === 'response.output_item.done' && data.item?.type === 'message') {
                    // Send finish reason when message is done
                    const openAIChunk = {
                      id: responseId || 'chunk',
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: (this as any).currentModel || 'o3-mini',
                      choices: [{
                        index: 0,
                        delta: {},
                        finish_reason: 'stop'
                      }]
                    };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
                  } else if (data.type === 'response.incomplete' || data.type === 'response.completed') {
                    // Handle final response
                    const finalResponse = data.response;
                    if (finalResponse?.status === 'incomplete' && !hasContent) {
                      // Send a message about incomplete response
                      const openAIChunk = {
                        id: finalResponse.id,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: finalResponse.model,
                        choices: [{
                          index: 0,
                          delta: { content: '[Response incomplete - token limit reached]' },
                          finish_reason: 'length'
                        }]
                      };
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
                    }
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  } else if (data.response_id && !responseId) {
                    responseId = data.response_id;
                    log(`Responses API (streaming): response_id=${responseId}`);
                  }
                } catch (e) {
                  // Pass through original line if we can't parse it
                  log(`Responses API (streaming): Could not parse line: ${line}`);
                }
              } else if (line === "data: [DONE]") {
                controller.enqueue(encoder.encode(line + "\n\n"));
              }
            }
          }
        } catch (error) {
          log(`Responses API: Stream error: ${error}`);
          controller.error(error);
        } finally {
          try {
            reader.releaseLock();
          } catch (e) {
            log(`Responses API: Error releasing lock: ${e}`);
          }
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "Content-Type": response.headers.get("Content-Type") || "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }
}
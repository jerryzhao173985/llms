import { UnifiedChatRequest } from "../types/llm";
import { Transformer } from "../types/transformer";
import { log } from "../utils/log";

/**
 * Unified OpenAI Transformer
 * Handles all OpenAI models including standard GPT, o1, and o3 models
 * 
 * Based on official OpenAI documentation and cookbook examples
 */

// Model categories with their specific requirements
const MODEL_CATEGORIES = {
  o3: {
    models: ['o3', 'o3-mini', 'o3-mini-2025-01-31'],
    features: {
      useMaxCompletionTokens: true,
      supportsResponseFormat: true,
      supportsPrediction: false,
      supportsTools: false,
      unsupportedParams: ['presence_penalty', 'frequency_penalty', 'logit_bias', 'logprobs', 'top_logprobs', 'n']
    }
  },
  o1: {
    models: ['o1', 'o1-mini', 'o1-preview', 'o1-2024-12-17'],
    features: {
      useMaxCompletionTokens: true,
      supportsResponseFormat: false, // o1 doesn't natively support structured outputs
      supportsPrediction: false,
      supportsTools: false,
      supportsReasoningEffort: true,
      unsupportedParams: ['presence_penalty', 'frequency_penalty', 'logit_bias', 'logprobs', 'top_logprobs', 'n', 'temperature', 'top_p']
    }
  },
  gpt4o: {
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20'],
    features: {
      useMaxCompletionTokens: false,
      supportsResponseFormat: true,
      supportsPrediction: true,
      supportsTools: true,
      unsupportedParams: []
    }
  },
  gpt35: {
    models: ['gpt-3.5-turbo', 'gpt-3.5-turbo-0125', 'gpt-3.5-turbo-1106'],
    features: {
      useMaxCompletionTokens: false,
      supportsResponseFormat: true, // Only json_object, not json_schema
      supportsPrediction: false,
      supportsTools: true,
      unsupportedParams: []
    }
  }
};

export class OpenAIUnifiedTransformer implements Transformer {
  name = "openai-unified";
  // endPoint = "/v1/chat/completions"; // Disabled to avoid route conflict

  /**
   * Determine which category a model belongs to
   */
  private getModelCategory(model: string): any {
    for (const [category, config] of Object.entries(MODEL_CATEGORIES)) {
      if (config.models.some(m => model.includes(m))) {
        return { name: category, ...config };
      }
    }
    // Default to gpt4o behavior for unknown models
    return { name: 'unknown', ...MODEL_CATEGORIES.gpt4o };
  }

  async transformRequestIn(request: UnifiedChatRequest): Promise<any> {
    const category = this.getModelCategory(request.model);
    log(`OpenAI Unified Transformer: Processing ${request.model} as ${category.name} model`);

    let transformedRequest: any = { ...request };

    // Handle max_tokens vs max_completion_tokens
    if (category.features.useMaxCompletionTokens) {
      if (transformedRequest.max_tokens) {
        transformedRequest.max_completion_tokens = transformedRequest.max_tokens;
        delete transformedRequest.max_tokens;
        log(`Converted max_tokens to max_completion_tokens for ${category.name} model`);
      }
    } else {
      // For standard models, ensure we don't have max_completion_tokens
      if (transformedRequest.max_completion_tokens && !transformedRequest.max_tokens) {
        transformedRequest.max_tokens = transformedRequest.max_completion_tokens;
        delete transformedRequest.max_completion_tokens;
        log(`Converted max_completion_tokens to max_tokens for standard model`);
      }
    }

    // Handle response_format
    if (transformedRequest.response_format) {
      if (!category.features.supportsResponseFormat) {
        log(`Warning: ${category.name} models don't support response_format natively. Consider using chained approach.`);
        // For o1 models, we might want to add instructions to the prompt instead
        if (category.name === 'o1') {
          this.addJsonInstructionsToPrompt(transformedRequest);
        }
        delete transformedRequest.response_format;
      } else {
        // Validate response_format compatibility
        this.validateResponseFormat(transformedRequest, category);
      }
    }

    // Handle prediction parameter
    if (transformedRequest.prediction) {
      if (!category.features.supportsPrediction) {
        log(`Removing unsupported prediction parameter for ${category.name} model`);
        delete transformedRequest.prediction;
      }
    }

    // Handle tools
    if (transformedRequest.tools && !category.features.supportsTools) {
      log(`Warning: ${category.name} models don't support tools. Removing tools parameter.`);
      delete transformedRequest.tools;
      delete transformedRequest.tool_choice;
    }

    // Handle reasoning effort for o1 models
    if (category.features.supportsReasoningEffort && transformedRequest.reasoning?.effort) {
      transformedRequest.reasoning_effort = transformedRequest.reasoning.effort;
      delete transformedRequest.reasoning;
      log(`Added reasoning_effort parameter for ${category.name} model`);
    }

    // Remove unsupported parameters
    for (const param of category.features.unsupportedParams) {
      if (transformedRequest[param] !== undefined) {
        log(`Removing unsupported parameter '${param}' for ${category.name} model`);
        delete transformedRequest[param];
      }
    }

    return transformedRequest;
  }

  /**
   * Validate and adjust response_format based on model capabilities
   */
  private validateResponseFormat(request: any, category: any): void {
    const { response_format } = request;
    
    if (!response_format) return;

    // Ensure JSON keyword is present in messages
    if (response_format.type === 'json_object' || response_format.type === 'json_schema') {
      this.ensureJsonKeyword(request);
    }

    // GPT-3.5 only supports json_object, not json_schema
    if (category.name === 'gpt35' && response_format.type === 'json_schema') {
      log(`Warning: GPT-3.5 doesn't support json_schema. Converting to json_object.`);
      request.response_format = { type: 'json_object' };
      // Add schema instructions to the prompt
      this.addSchemaInstructionsToPrompt(request, response_format.json_schema);
    }

    // Ensure strict mode for json_schema
    if (response_format.type === 'json_schema' && response_format.json_schema) {
      if (response_format.json_schema.strict === undefined) {
        response_format.json_schema.strict = true;
        log('Added strict: true to json_schema for guaranteed compliance');
      }
    }
  }

  /**
   * Ensure JSON keyword appears in messages
   */
  private ensureJsonKeyword(request: any): void {
    const hasJsonKeyword = request.messages.some((msg: any) => {
      const content = this.getMessageContent(msg);
      return /\bjson\b/i.test(content);
    });

    if (!hasJsonKeyword) {
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
        log('Added JSON keyword to ensure proper response format');
      }
    }
  }

  /**
   * Add JSON instructions for models that don't support response_format
   */
  private addJsonInstructionsToPrompt(request: any): void {
    const instruction = '\n\nIMPORTANT: Your response must be valid JSON only, with no additional text or explanation.';
    
    const lastUserMsgIndex = request.messages.findLastIndex((msg: any) => msg.role === 'user');
    if (lastUserMsgIndex >= 0) {
      const msg = request.messages[lastUserMsgIndex];
      if (typeof msg.content === 'string') {
        msg.content += instruction;
      }
    }
    log('Added JSON instructions to prompt for o1 model');
  }

  /**
   * Add schema instructions when converting json_schema to json_object
   */
  private addSchemaInstructionsToPrompt(request: any, schema: any): void {
    if (!schema) return;
    
    const instruction = `\n\nYour response must follow this JSON schema:\n${JSON.stringify(schema.schema, null, 2)}`;
    
    const lastUserMsgIndex = request.messages.findLastIndex((msg: any) => msg.role === 'user');
    if (lastUserMsgIndex >= 0) {
      const msg = request.messages[lastUserMsgIndex];
      if (typeof msg.content === 'string') {
        msg.content += instruction;
      }
    }
    log('Added schema instructions to prompt for model without json_schema support');
  }

  /**
   * Extract text content from a message
   */
  private getMessageContent(msg: any): string {
    if (typeof msg.content === 'string') {
      return msg.content;
    }
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text || '')
        .join(' ');
    }
    return '';
  }

  async transformResponseOut(response: Response): Promise<Response> {
    // Check if this is a streaming response
    const contentType = response.headers.get('Content-Type');
    
    if (contentType?.includes('stream')) {
      return this.handleStreamingResponse(response);
    }
    
    return this.handleNonStreamingResponse(response);
  }

  private async handleNonStreamingResponse(response: Response): Promise<Response> {
    try {
      const jsonResponse = await response.json();
      
      // Check for refusal in structured output response
      if (jsonResponse.choices?.[0]?.message?.refusal) {
        const refusalMessage = jsonResponse.choices[0].message.refusal;
        jsonResponse.choices[0].message.content = `[REFUSAL] ${refusalMessage}`;
        log('Handled refusal response from OpenAI');
      }

      // Handle parsed field for structured outputs
      if (jsonResponse.choices?.[0]?.message?.parsed) {
        const parsed = jsonResponse.choices[0].message.parsed;
        // If no content, use parsed as content
        if (!jsonResponse.choices[0].message.content) {
          jsonResponse.choices[0].message.content = JSON.stringify(parsed, null, 2);
        }
        log('Processed parsed structured output');
      }

      return new Response(JSON.stringify(jsonResponse), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      log(`Error processing response: ${error}`);
      return response;
    }
  }

  private async handleStreamingResponse(response: Response): Promise<Response> {
    if (!response.body) {
      return response;
    }

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const reader = response.body!.getReader();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              if (buffer.trim()) {
                controller.enqueue(encoder.encode(buffer));
              }
              break;
            }

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.trim() || line === 'data: [DONE]') {
                controller.enqueue(encoder.encode(line + '\n'));
                continue;
              }

              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  
                  // Process refusal in streaming
                  if (data.choices?.[0]?.delta?.refusal) {
                    data.choices[0].delta.content = `[REFUSAL] ${data.choices[0].delta.refusal}`;
                    delete data.choices[0].delta.refusal;
                  }

                  // Process parsed in streaming
                  if (data.choices?.[0]?.delta?.parsed) {
                    if (!data.choices[0].delta.content) {
                      data.choices[0].delta.content = JSON.stringify(data.choices[0].delta.parsed);
                    }
                  }

                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n`));
                } catch (e) {
                  controller.enqueue(encoder.encode(line + '\n'));
                }
              } else {
                controller.enqueue(encoder.encode(line + '\n'));
              }
            }
          }
        } catch (error) {
          controller.error(error);
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}
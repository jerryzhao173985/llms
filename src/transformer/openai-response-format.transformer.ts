import { UnifiedChatRequest } from "../types/llm";
import { Transformer, TransformerOptions } from "../types/transformer";

// Models that support structured outputs with json_schema
const STRUCTURED_OUTPUT_MODELS = [
  "gpt-4o-mini",
  "gpt-4o-mini-2024-07-18",
  "gpt-4o-2024-08-06",
  "gpt-4o-2024-11-20",
  "o1",
  "o1-mini",
  "o1-preview"
];

// Models that support basic json_object mode
const JSON_MODE_MODELS = [
  ...STRUCTURED_OUTPUT_MODELS,
  "gpt-3.5-turbo",
  "gpt-3.5-turbo-0125",
  "gpt-3.5-turbo-1106",
  "gpt-4-turbo",
  "gpt-4-turbo-preview",
  "gpt-4-turbo-2024-04-09",
  "gpt-4-0125-preview",
  "gpt-4-1106-preview"
];

export class OpenAIResponseFormatTransformer implements Transformer {
  name = "openai-response-format";
  
  constructor(private options?: TransformerOptions) {}

  async transformRequestIn(request: UnifiedChatRequest): Promise<UnifiedChatRequest> {
    // If no response_format is specified, pass through unchanged
    if (!request.response_format) {
      return request;
    }

    const { type, json_schema } = request.response_format;

    // Check model compatibility
    if (type === "json_schema") {
      const isCompatible = STRUCTURED_OUTPUT_MODELS.some(model => 
        request.model.includes(model)
      );
      
      if (!isCompatible) {
        throw new Error(
          `Model ${request.model} does not support response_format type 'json_schema'. ` +
          `Supported models: ${STRUCTURED_OUTPUT_MODELS.join(", ")}`
        );
      }

      // Ensure strict mode is set for json_schema
      if (json_schema && json_schema.strict === undefined) {
        request.response_format.json_schema!.strict = true;
      }
    } else if (type === "json_object") {
      const isCompatible = JSON_MODE_MODELS.some(model => 
        request.model.includes(model)
      );
      
      if (!isCompatible) {
        throw new Error(
          `Model ${request.model} does not support response_format type 'json_object'. ` +
          `Supported models: ${JSON_MODE_MODELS.join(", ")}`
        );
      }
    }

    // Ensure the word "JSON" appears in messages when using json_object or json_schema
    if (type === "json_object" || type === "json_schema") {
      const hasJsonKeyword = this.checkForJsonKeyword(request.messages);
      
      if (!hasJsonKeyword) {
        // Add JSON keyword to the last user message or create a system message
        const lastUserMsgIndex = request.messages.findLastIndex(msg => msg.role === "user");
        
        if (lastUserMsgIndex >= 0) {
          const lastUserMsg = request.messages[lastUserMsgIndex];
          if (typeof lastUserMsg.content === "string") {
            lastUserMsg.content += "\n\nPlease respond in JSON format.";
          } else if (Array.isArray(lastUserMsg.content)) {
            // Find the last text content
            const lastTextContent = lastUserMsg.content.findLast(c => c.type === "text");
            if (lastTextContent && lastTextContent.type === "text") {
              lastTextContent.text += "\n\nPlease respond in JSON format.";
            }
          }
        } else {
          // Add a system message with JSON keyword
          request.messages.unshift({
            role: "system",
            content: "You are a helpful assistant that responds in JSON format."
          });
        }
      }
    }

    return request;
  }

  async transformResponseOut(response: Response): Promise<Response> {
    // Check if response is streaming
    const contentType = response.headers.get("Content-Type");
    
    if (contentType?.includes("stream")) {
      return this.handleStreamingResponse(response);
    } else {
      return this.handleNonStreamingResponse(response);
    }
  }

  private checkForJsonKeyword(messages: any[]): boolean {
    const jsonRegex = /\bjson\b/i;
    
    for (const message of messages) {
      if (typeof message.content === "string") {
        if (jsonRegex.test(message.content)) {
          return true;
        }
      } else if (Array.isArray(message.content)) {
        for (const content of message.content) {
          if (content.type === "text" && jsonRegex.test(content.text)) {
            return true;
          }
        }
      }
    }
    
    return false;
  }

  private async handleNonStreamingResponse(response: Response): Promise<Response> {
    try {
      const jsonResponse = await response.json();
      
      // Check for refusal in structured output response
      if (jsonResponse.choices?.[0]?.message?.refusal) {
        // Handle refusal response
        const refusalMessage = jsonResponse.choices[0].message.refusal;
        jsonResponse.choices[0].message.content = `[REFUSAL] ${refusalMessage}`;
        
        // Log refusal for debugging
        console.warn("OpenAI structured output refusal:", refusalMessage);
      }

      // Check if the response contains parsed structured output
      if (jsonResponse.choices?.[0]?.message?.parsed) {
        // The parsed field contains the validated structured output
        const parsed = jsonResponse.choices[0].message.parsed;
        
        // Optionally merge parsed content into the content field
        if (!jsonResponse.choices[0].message.content) {
          jsonResponse.choices[0].message.content = JSON.stringify(parsed, null, 2);
        }
      }

      return new Response(JSON.stringify(jsonResponse), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      console.error("Error processing non-streaming response:", error);
      return response;
    }
  }

  private async handleStreamingResponse(response: Response): Promise<Response> {
    if (!response.body) {
      return response;
    }

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let hasRefusal = false;

    const stream = new ReadableStream({
      async start(controller) {
        const reader = response.body!.getReader();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              // Process any remaining buffer
              if (buffer.trim()) {
                controller.enqueue(encoder.encode(buffer));
              }
              break;
            }

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;

            // Process complete lines
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.trim()) continue;
              
              if (line.startsWith("data: ") && line.trim() !== "data: [DONE]") {
                try {
                  const data = JSON.parse(line.slice(6));

                  // Check for refusal in streaming response
                  if (data.choices?.[0]?.delta?.refusal) {
                    hasRefusal = true;
                    const refusalMessage = data.choices[0].delta.refusal;
                    
                    // Convert refusal to content
                    data.choices[0].delta.content = `[REFUSAL] ${refusalMessage}`;
                    delete data.choices[0].delta.refusal;
                    
                    console.warn("OpenAI structured output streaming refusal:", refusalMessage);
                  }

                  // Handle parsed structured output in streaming
                  if (data.choices?.[0]?.delta?.parsed) {
                    const parsed = data.choices[0].delta.parsed;
                    
                    // Convert parsed to content if no content exists
                    if (!data.choices[0].delta.content) {
                      data.choices[0].delta.content = JSON.stringify(parsed);
                    }
                  }

                  const modifiedLine = `data: ${JSON.stringify(data)}\n`;
                  controller.enqueue(encoder.encode(modifiedLine));
                } catch (e) {
                  // Pass through lines that can't be parsed
                  controller.enqueue(encoder.encode(line + "\n"));
                }
              } else {
                // Pass through non-data lines
                controller.enqueue(encoder.encode(line + "\n"));
              }
            }
          }
        } catch (error) {
          console.error("Stream processing error:", error);
          controller.error(error);
        } finally {
          try {
            reader.releaseLock();
          } catch (e) {
            console.error("Error releasing reader lock:", e);
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